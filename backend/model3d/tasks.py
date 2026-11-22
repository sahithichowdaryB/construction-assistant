"""Structure activities driven by performance tasks (the daily plan's activities), instead of reported m3.

A spec activity may list the tasks that build it: {"code": "A420", ..., "tasks": ["L2-COL", "L2-FORM", ...]}. Then:

    actual   the activity's completion is the average completion of its tasks, each task min(signed / planned, 1)
             from the same plan_targets and observations the Performance and Shortfalls pages use (the latest report
             per task, day and basis). It is turned into equivalent m3 of the activity's pours, one record per
             underlying report line, so the pour engine (progress.py) fills the pours unchanged and every state
             keeps citing the real daily reports.
    planned  each pour of the activity is planned for the day the tasks' average planned completion reaches the
             end of that pour (pours filled in schedule order), and the activity's window is the tasks' window.
    forecast the performance forward pass of the tasks (routes._shared_forecast): earliest start, latest finish.

Tasks without planned quantities are ignored (with a note in `summary`). Pure functions plus one loader.
"""

from __future__ import annotations

import copy
from datetime import date, datetime

from sqlalchemy import text

from .spec import parse_day


def drivers(spec: dict) -> dict[str, list[str]]:
    """{activity code: [task codes]} for the activities driven by tasks."""
    return {a["code"]: [str(t) for t in a["tasks"]] for a in spec.get("activities") or [] if a.get("tasks")}


def load(conn, project_id: str, tasks: list[str], day: date, as_of: datetime | None) -> dict:
    """Planned quantities and the latest signed/estimated report per task, day and basis known at the cutoff."""
    params = {"p": project_id, "t": list(tasks), "d": day, "cutoff": as_of}
    targets: dict[str, dict[str, float]] = {}
    for code, d, q in conn.execute(text("""
            SELECT t.activity_code, t.work_date, t.quantity FROM sitemate.plan_targets t
            JOIN sitemate.sources s ON (s.project_id, s.id) = (t.project_id, t.source_id)
            WHERE t.project_id = :p AND t.activity_code = ANY(:t)
              AND s.available_at <= coalesce(CAST(:cutoff AS timestamptz), 'infinity')"""), params):
        targets.setdefault(code, {})[d.isoformat()] = float(q)
    obs = [{"task": r["activity_code"], "date": r["work_date"].isoformat(), "qty": float(r["quantity"]),
            "basis": r["basis"], "ref": f"{r['source_id']}:{r['locator']}"}
           for r in conn.execute(text("""
            SELECT * FROM (
                SELECT DISTINCT ON (o.activity_code, o.work_date, o.basis)
                       o.activity_code, o.work_date, o.quantity, o.basis, o.source_id, o.locator
                FROM sitemate.observations o
                JOIN sitemate.sources s ON (s.project_id, s.id) = (o.project_id, o.source_id)
                WHERE o.project_id = :p AND o.activity_code = ANY(:t) AND o.work_date <= :d
                  AND s.available_at <= coalesce(CAST(:cutoff AS timestamptz), 'infinity')
                ORDER BY o.activity_code, o.work_date, o.basis, s.available_at DESC, o.source_id, o.locator
            ) latest ORDER BY work_date, activity_code, source_id, locator"""), params).mappings()]
    names = dict(conn.execute(text("SELECT code, name FROM sitemate.activities WHERE project_id=:p AND code = ANY(:t)"),
                              params).all())
    return {"targets": targets, "observations": obs, "names": names}


def _totals(ti: dict, tasks: list[str]) -> dict[str, float]:
    return {t: sum(ti["targets"].get(t, {}).values()) for t in tasks if sum(ti["targets"].get(t, {}).values()) > 0}


def observations(spec: dict, pours: list[dict], ti: dict) -> list[dict]:
    """Equivalent m3 records for every task-driven activity (see module docstring)."""
    out = []
    for act, tasks in drivers(spec).items():
        totals = _totals(ti, tasks)
        m3 = sum(float(p["m3"] or 0) for p in pours if p["activity"] == act)
        if not totals or not m3:
            continue
        for basis in ("signed", "estimated"):
            cum = {t: 0.0 for t in totals}
            for o in ti["observations"]:
                if o["task"] not in totals or o["basis"] != basis or o["qty"] <= 0:
                    continue
                t, total = o["task"], totals[o["task"]]
                before = min(cum[t] / total, 1.0)
                cum[t] += o["qty"]
                gain = min(cum[t] / total, 1.0) - before
                if gain > 0:
                    out.append({"activity": act, "date": o["date"], "qty": round(m3 * gain / len(totals), 6),
                                "basis": basis, "ref": o["ref"], "task": t})
    return out


def _planned_pct(ti: dict, totals: dict[str, float], d: date) -> float:
    return sum(min(sum(q for day, q in ti["targets"][t].items() if parse_day(day) <= d) / total, 1.0)
               for t, total in totals.items()) / len(totals)


def plan(spec: dict, pours: list[dict], ti: dict) -> tuple[dict, list[dict]]:
    """Copies of the spec and pours with task-driven activities dated from the tasks' plan."""
    spec, pours = copy.deepcopy(spec), copy.deepcopy(pours)
    acts = {a["code"]: a for a in spec.get("activities") or []}
    for act, tasks in drivers(spec).items():
        totals = _totals(ti, tasks)
        days = sorted({parse_day(d) for t in totals for d, q in ti["targets"][t].items() if q > 0})
        if not days:
            continue
        acts[act]["start"], acts[act]["finish"] = days[0].isoformat(), days[-1].isoformat()
        mine = sorted((p for p in pours if p["activity"] == act), key=lambda p: p["seq"])
        total_m3 = sum(float(p["m3"] or 0) for p in mine) or 1.0
        reached, run = [(d, _planned_pct(ti, totals, d)) for d in days], 0.0
        for p in mine:
            run += float(p["m3"] or 0)
            share = run / total_m3 - 1e-9
            p["planned"] = next((d for d, pct in reached if pct >= share), days[-1]).isoformat()
    return spec, pours


def summary(spec: dict, ti: dict, day: date) -> dict[str, list[dict]]:
    """Per driven activity, each task's planned and actual completion on `day` (for the page)."""
    out = {}
    for act, tasks in drivers(spec).items():
        totals = _totals(ti, tasks)
        rows = []
        for t in tasks:
            total = totals.get(t)
            done = sum(o["qty"] for o in ti["observations"] if o["task"] == t and o["basis"] == "signed"
                       and parse_day(o["date"]) <= day)
            rows.append({"code": t, "name": ti["names"].get(t), "planned_total": total,
                         "done": round(done, 2), "pct_done": round(100 * min(done / total, 1), 1) if total else None,
                         "pct_planned": round(100 * _planned_pct(ti, {t: total}, day), 1) if total else None,
                         "note": None if total else "no planned quantity: not counted"})
        out[act] = rows
    return out
