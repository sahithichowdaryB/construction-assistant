"""Progress of the 3D model, read from the database (plan section 7). Numbers are computed here, never by a model.

Sources (all filtered by `sources.available_at <= as_of`, so the date slider and the demo clock replay history):
    sitemate.observations  signed (and estimated) quantity per activity per day, from daily reports  -> main source
    sitemate.events        confirmed `production` events (voice notes, text captures)                -> early signal
                           other confirmed events (equipment, weather, delivery, quality...)          -> "why" reasons
    sitemate.source_passages  report remarks that mention delays                                       -> "why" reasons

Rules:
    * An activity's cumulative signed m3 fills its pours in schedule order: a fully covered pour is `built`, the
      next one `in_progress` with pct = leftover / pour m3, the rest `not_started`.
    * A confirmed production event naming a pour id (e.g. "A410-SA") marks that pour built with basis `event`
      (shown as unsigned) until the signed report covers it. Estimated quantities and event quantities only
      ever show as unsigned progress, never as built-and-signed.
    * Planned state: each pour is built linearly between the previous pour's planned date and its own.
    * Forecast: each remaining pour keeps its planned date shifted by the current slip (working days between the
      planned and the actual date of the latest completed pour), never earlier than tomorrow. The slip carries
      through the chain, so a late raft pour moves every later level.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import text

from .spec import Calendar, parse_day

DONE = 0.995          # a pour counts as complete at 99.5% of its volume (rounding in reports)
POUR_ID = re.compile(r"\b([A-Z]\d{2,4}-[A-Z0-9]{1,3})\b")
DELAY_WORDS = re.compile(r"\b(delay\w*|breakdown|broke down|rain\w*|late|waiting|stopp\w*|fail\w*|postpon\w*|"
                         r"shortage|not delivered|standby|idle)\b", re.I)
PROGRESS_TYPES = {"production", "quantity_estimate", "material_delivery", "repair_release", "issue_resolved",
                  "inspection_passed", "labour_count", "visitor", "handover"}


def r1(v):
    return None if v is None else round(float(v), 1)


# ------------------------------------------------------------------ database inputs

def load_inputs(conn, project_id: str, activity_codes: list[str], day: date, as_of: datetime | None) -> dict:
    """Everything the progress engine reads, as plain data (also hashed into input_digest)."""
    params = {"p": project_id, "codes": list(activity_codes), "d": day, "cutoff": as_of}
    tz = conn.scalar(text("SELECT timezone FROM sitemate.projects WHERE id=:p"), {"p": project_id}) or "UTC"
    obs = conn.execute(text("""
        SELECT o.activity_code, o.work_date, o.quantity, o.basis, o.source_id, o.locator, s.available_at
        FROM sitemate.observations o
        JOIN sitemate.sources s ON (s.project_id, s.id) = (o.project_id, o.source_id)
        WHERE o.project_id = :p AND o.activity_code = ANY(:codes) AND o.work_date <= :d
          AND s.available_at <= coalesce(CAST(:cutoff AS timestamptz), 'infinity')
        ORDER BY o.work_date, o.activity_code, o.source_id, o.locator
    """), params).mappings().all()
    events = conn.execute(text("""
        SELECT e.id::text AS id, e.activity_code, (e.occurred_at AT TIME ZONE p.timezone)::date AS day,
               e.event_type, e.category, e.summary, e.attributes, e.source_id, e.locator, e.zone, e.equipment_id
        FROM sitemate.events e
        JOIN sitemate.projects p ON p.id = e.project_id
        JOIN sitemate.sources s ON (s.project_id, s.id) = (e.project_id, e.source_id)
        WHERE e.project_id = :p AND e.status = 'confirmed'
          AND (e.occurred_at AT TIME ZONE p.timezone)::date <= :d
          AND s.available_at <= coalesce(CAST(:cutoff AS timestamptz), 'infinity')
        ORDER BY e.occurred_at, e.id
    """), params).mappings().all()
    source_ids = sorted({o["source_id"] for o in obs})
    remarks = []
    if source_ids:
        remarks = conn.execute(text("""
            SELECT sp.source_id, sp.locator, sp.excerpt, s.available_at
            FROM sitemate.source_passages sp JOIN sitemate.sources s ON (s.project_id, s.id) = (sp.project_id, sp.source_id)
            WHERE sp.project_id = :p AND sp.source_id = ANY(:ids)
              AND sp.excerpt ~* '(delay|breakdown|broke down|rain|late|waiting|stopp|fail|postpon|shortage|standby|idle)'
            ORDER BY s.available_at, sp.source_id, sp.locator
        """), {"p": project_id, "ids": source_ids}).mappings().all()
    return {
        "timezone": tz,
        "observations": [{"activity": o["activity_code"], "date": o["work_date"].isoformat(), "qty": float(o["quantity"]),
                          "basis": o["basis"], "ref": f"{o['source_id']}:{o['locator']}"} for o in obs],
        "events": [{"id": e["id"], "activity": e["activity_code"], "date": e["day"].isoformat(), "type": e["event_type"],
                    "category": e["category"], "summary": e["summary"], "attributes": e["attributes"] or {},
                    "ref": f"{e['source_id']}:{e['locator']}", "equipment": e["equipment_id"], "zone": e["zone"]}
                   for e in events],
        "remarks": [{"ref": f"{r['source_id']}:{r['locator']}", "text": r["excerpt"][:400],
                     "date": r["available_at"].astimezone(ZoneInfo(tz)).date().isoformat()} for r in remarks],
    }


def input_digest(inputs: dict, day: date) -> str:
    return hashlib.sha256(json.dumps({"d": day.isoformat(), "o": inputs["observations"],
                                      "e": [(e["id"], e["type"], e["date"]) for e in inputs["events"]]},
                                     sort_keys=True, default=str).encode()).hexdigest()


# ------------------------------------------------------------------ actual pour states

def _daily(observations: list[dict], basis: str, upto: date) -> dict[str, list[tuple[date, float, list[str]]]]:
    out: dict[str, dict[date, list]] = {}
    for o in observations:
        d = parse_day(o["date"])
        if o["basis"] != basis or d > upto:
            continue
        slot = out.setdefault(o["activity"], {}).setdefault(d, [0.0, []])
        slot[0] += o["qty"]
        slot[1].append(o["ref"])
    return {a: [(d, q, refs) for d, (q, refs) in sorted(days.items())] for a, days in out.items()}


def _event_signals(events: list[dict], pour_ids: set[str], activity_codes: set[str], upto: date):
    """Production events: pours named as done, and quantities reported per activity (unsigned)."""
    built: dict[str, dict] = {}
    qty: dict[str, list[tuple[date, float, str]]] = {}
    for e in events:
        if e["type"] != "production" or parse_day(e["date"]) > upto:
            continue
        attrs = e["attributes"] if isinstance(e["attributes"], dict) else {}
        named = {str(attrs.get("pour_id") or "").upper()} | set(POUR_ID.findall((e["summary"] or "").upper()))
        for pid in named & pour_ids:
            built.setdefault(pid, {"date": e["date"], "ref": e["ref"]})
        q = attrs.get("quantity") if isinstance(attrs.get("quantity"), (int, float)) else None
        if q and e["activity"] in activity_codes:
            qty.setdefault(e["activity"], []).append((parse_day(e["date"]), float(q), e["ref"]))
    return built, qty


def pour_states(pours: list[dict], inputs: dict, upto: date) -> dict[str, dict]:
    """Status of every pour on `upto` from signed/estimated observations and production events."""
    signed = _daily(inputs["observations"], "signed", upto)
    estimated = _daily(inputs["observations"], "estimated", upto)
    codes = {p["activity"] for p in pours}
    event_built, event_qty = _event_signals(inputs["events"], {p["id"] for p in pours}, codes, upto)
    out = {}
    by_act: dict[str, list[dict]] = {}
    for p in sorted(pours, key=lambda p: p["seq"]):
        by_act.setdefault(p["activity"], []).append(p)
    for act, plist in by_act.items():
        days = signed.get(act, [])
        s_total = sum(q for _, q, _ in days)
        unsigned = sum(q for _, q, _ in estimated.get(act, [])) + sum(q for _, q, _ in event_qty.get(act, []))
        r_total = s_total + unsigned
        before = 0.0
        # date at which the cumulative signed quantity reaches a level, and the refs that got it there
        cum, timeline = 0.0, []
        for d, q, refs in days:
            cum += q
            timeline.append((cum, d, refs))
        for p in plist:
            m = float(p["m3"] or 0)
            end = before + m
            s_part = max(0.0, min(s_total - before, m))
            r_part = max(0.0, min(r_total - before, m))
            # refs of the days whose output landed in this pour
            refs, prev = [], 0.0
            for c, _, rs in timeline:
                if c > before and prev < end:
                    refs += rs
                prev = c
            refs = sorted(set(refs))[:6]
            finished = next((d for c, d, _ in timeline if c >= before + m * DONE), None) if m else None
            if m and s_part >= m * DONE:
                state = {"status": "built", "pct": 100.0, "basis": "signed", "done_m3": r1(m), "finished": finished.isoformat()}
            elif p["id"] in event_built:
                ev = event_built[p["id"]]
                state = {"status": "built", "pct": 100.0, "basis": "event", "done_m3": r1(max(s_part, m)),
                         "finished": ev["date"]}
                refs = sorted(set(refs + [ev["ref"]]))
            elif s_part > 0:
                state = {"status": "in_progress", "pct": round(100 * s_part / m, 1), "basis": "signed",
                         "done_m3": r1(s_part), "finished": None}
                if r_part > s_part:
                    state["reported_pct"] = round(100 * r_part / m, 1)
            elif r_part > 0:
                state = {"status": "in_progress", "pct": round(100 * r_part / m, 1),
                         "basis": "estimated" if estimated.get(act) else "event", "done_m3": r1(r_part), "finished": None}
            else:
                state = {"status": "not_started", "pct": 0.0, "basis": None, "done_m3": 0.0, "finished": None}
            state["refs"] = refs if state["status"] != "not_started" else []
            out[p["id"]] = state
            before = end
    return out


# ------------------------------------------------------------------ planned and forecast windows

def _activity_window(spec: dict, code: str):
    a = next((a for a in spec.get("activities") or [] if a["code"] == code), {}) or {}
    return parse_day(a.get("start")), parse_day(a.get("finish"))


def planned_windows(spec: dict, pours: list[dict]) -> dict[str, tuple[date, date]]:
    """Each pour is planned from the previous pour's date (or its activity start) to its own planned date."""
    out = {}
    by_act: dict[str, list[dict]] = {}
    for p in sorted(pours, key=lambda p: p["seq"]):
        by_act.setdefault(p["activity"], []).append(p)
    for act, plist in by_act.items():
        start, finish = _activity_window(spec, act)
        dated = [parse_day(p.get("planned")) for p in plist]
        first = start or next((d for d in dated if d), None) or finish
        last = finish or max((d for d in dated if d), default=None) or first
        if first is None:
            continue
        n = len(plist)
        cursor = first
        for i, (p, d) in enumerate(zip(plist, dated)):
            if d is None:   # spread undated pours evenly over the activity window
                d = first + timedelta(days=round((last - first).days * (i + 1) / n))
            out[p["id"]] = (min(cursor, d), d)
            cursor = d + timedelta(days=1)
    return out


def window_pct(window: tuple[date, date] | None, d: date) -> float:
    if window is None:
        return 0.0
    a, b = window
    if d >= b:
        return 100.0
    if d < a:
        return 0.0
    return round(100 * ((d - a).days + 1) / ((b - a).days + 1), 1)


def _shift(cal: Calendar, d: date, n: int) -> date:
    if n >= 0:
        return cal.add_working_days(d, n) if n else d
    while n < 0:
        d -= timedelta(days=1)
        if cal.is_working(d):
            n += 1
    return d


def forecast(spec: dict, pours: list[dict], actual: dict[str, dict], today: date, cal: Calendar) -> dict:
    """Forecast date of every pour (see module docstring) and the slip that produced it."""
    plan = planned_windows(spec, pours)
    tomorrow = cal.next_working(today + timedelta(days=1))
    slip, out = 0, {}
    for p in sorted(pours, key=lambda p: p["seq"]):
        planned = plan.get(p["id"], (None, None))[1]
        st = actual.get(p["id"], {})
        if st.get("status") == "built" and st.get("finished"):
            done = parse_day(st["finished"])
            if planned:
                slip = cal.between(planned, done)
            out[p["id"]] = {"date": done.isoformat(), "slip_wd": slip, "done": True}
            continue
        if planned is None:
            out[p["id"]] = {"date": None, "slip_wd": slip, "done": False}
            continue
        d = _shift(cal, cal.next_working(planned), slip)
        if d < tomorrow:
            d = tomorrow
            slip = cal.between(planned, d)
        out[p["id"]] = {"date": d.isoformat(), "slip_wd": slip, "done": False}
    return out


def forecast_windows(pours: list[dict], plan: dict, fc: dict, actual: dict[str, dict], today: date) -> dict:
    """Per pour (start, end) of the forecast; started pours run from today."""
    out = {}
    for p in sorted(pours, key=lambda p: p["seq"]):
        f = fc.get(p["id"]) or {}
        end = parse_day(f.get("date"))
        if end is None:
            continue
        a, b = plan.get(p["id"], (end, end))
        length = (b - a).days
        start = max(end - timedelta(days=length), today + timedelta(days=1)) if not f.get("done") else end
        if actual.get(p["id"], {}).get("status") == "in_progress":
            start = today + timedelta(days=1)
        out[p["id"]] = (min(start, end), end)
    return out


# ------------------------------------------------------------------ the full result for one date

def _label(code: str, spec: dict) -> str:
    a = next((a for a in spec.get("activities") or [] if a["code"] == code), None)
    return f"{code} {a['name']}" if a and a.get("name") else code


def why(spec: dict, pours: list[dict], actual: dict, plan: dict, fc: dict, inputs: dict, today: date,
        cal: Calendar, review_reasons: list[dict]) -> list[dict]:
    """Reasons the model is behind or late, from the database records. Each has kind, text, date, refs."""
    items: list[dict] = []
    codes = []
    for p in sorted(pours, key=lambda p: p["seq"]):
        if p["activity"] not in codes:
            codes.append(p["activity"])
    # 1. quantity behind plan, per activity
    for code in codes:
        ps = [p for p in pours if p["activity"] == code]
        planned = sum(p["m3"] * window_pct(plan.get(p["id"]), today) / 100 for p in ps)
        done = sum(min(actual[p["id"]]["done_m3"], p["m3"]) if actual[p["id"]]["basis"] == "signed" or
                   actual[p["id"]]["status"] == "built" else 0 for p in ps)
        if planned - done > max(1.0, 0.01 * planned):
            total = sum(p["m3"] for p in ps)
            items.append({"kind": "behind", "activity": code, "date": today.isoformat(),
                          "text": f"{_label(code, spec)}: {done:.0f} m³ built of {planned:.0f} m³ planned by "
                                  f"{today:%d %b %Y} ({planned - done:.0f} m³ behind, {total:.0f} m³ in total).",
                          "refs": sorted({r for p in ps for r in actual[p['id']]['refs']})[:6]})
        start = _activity_window(spec, code)[0]
        if start and start <= today and done <= 0 and not any(actual[p["id"]]["status"] != "not_started" for p in ps):
            items.append({"kind": "late_start", "activity": code, "date": today.isoformat(),
                          "text": f"{_label(code, spec)} has not started; it was planned to start {start:%d %b %Y} "
                                  f"({cal.between(start, today)} working days ago).", "refs": []})
    # 2. pours completed after their planned date
    for p in sorted(pours, key=lambda p: p["seq"]):
        st, planned = actual[p["id"]], plan.get(p["id"], (None, None))[1]
        if st["status"] == "built" and st.get("finished") and planned:
            late = cal.between(planned, parse_day(st["finished"]))
            if late > 0:
                items.append({"kind": "late_pour", "activity": p["activity"], "date": st["finished"],
                              "text": f"Pour {p['id']} was completed {parse_day(st['finished']):%d %b}, {late} working "
                                      f"day{'s' if late != 1 else ''} after its planned date {planned:%d %b}.",
                              "refs": st["refs"][-3:]})
    # 3. recorded disruptions (confirmed events) in the last 30 days
    since = today - timedelta(days=30)
    model_codes = set(codes)
    # events on the structure's activities, or site-wide (no activity); events on other activities are not reasons
    disruptions = [e for e in inputs["events"] if e["type"] not in PROGRESS_TYPES
                   and since <= parse_day(e["date"]) <= today and (e["activity"] is None or e["activity"] in model_codes)]
    disruptions.sort(key=lambda e: (e["activity"] not in model_codes, e["date"]), reverse=False)
    for e in disruptions[:6]:
        kind = (e["type"] or "event").replace("_", " ")
        where = f" ({_label(e['activity'], spec)})" if e["activity"] in model_codes else ""
        items.append({"kind": "disruption", "activity": e["activity"], "date": e["date"],
                      "text": f"{parse_day(e['date']):%d %b}: {kind}{where} — {e['summary']}", "refs": [e["ref"]]})
    # 4. report remarks that mention delays
    for r in inputs["remarks"][-6:]:
        if DELAY_WORDS.search(r["text"]):
            items.append({"kind": "report_remark", "activity": None, "date": r["date"],
                          "text": f"{parse_day(r['date']):%d %b} report: {r['text']}", "refs": [r["ref"]]})
    # 5. planning conflicts found in the drawings
    for rr in review_reasons or []:
        if "not a working day" in rr.get("message", ""):
            items.append({"kind": "plan_conflict", "activity": None, "date": None,
                          "text": f"{rr['subject']}: {rr['message']}.", "refs": rr.get("refs") or []})
    return items


def compute(spec: dict, pours: list[dict], inputs: dict, today: date, deadline: date | None,
            review_reasons: list[dict] | None = None) -> dict:
    """Actual, planned and forecast state on `today`, the deadline check and the reasons."""
    cal = Calendar.from_spec(spec)
    actual = pour_states(pours, inputs, today)
    plan = planned_windows(spec, pours)
    fc = forecast(spec, pours, actual, today, cal)
    fwin = forecast_windows(pours, plan, fc, actual, today)
    planned_state = {p["id"]: _window_state(plan.get(p["id"]), today) for p in pours}
    completion = max((parse_day(f["date"]) for f in fc.values() if f.get("date")), default=None)
    at_deadline = {}
    if deadline:
        for p in pours:
            if actual[p["id"]]["status"] == "built":
                at_deadline[p["id"]] = {"status": "built", "pct": 100.0}
            else:
                pct = max(window_pct(fwin.get(p["id"]), deadline), actual[p["id"]]["pct"])
                at_deadline[p["id"]] = {"status": "built" if pct >= 100 else "in_progress" if pct > 0 else "not_started",
                                        "pct": pct}
    total = sum(p["m3"] for p in pours)
    built_m3 = sum(min(actual[p["id"]]["done_m3"], p["m3"]) for p in pours if actual[p["id"]]["basis"] == "signed"
                   or actual[p["id"]]["status"] == "built")
    planned_m3 = sum(p["m3"] * window_pct(plan.get(p["id"]), today) / 100 for p in pours)
    late_wd = cal.between(deadline, completion) if deadline and completion else None
    activities = []
    for code in dict.fromkeys(p["activity"] for p in sorted(pours, key=lambda p: p["seq"])):
        ps = [p for p in pours if p["activity"] == code]
        start, finish = _activity_window(spec, code)
        f_finish = max((parse_day(fc[p["id"]]["date"]) for p in ps if fc[p["id"]].get("date")), default=None)
        planned_finish = finish or max((plan[p["id"]][1] for p in ps if p["id"] in plan), default=None)
        done = sum(min(actual[p["id"]]["done_m3"], p["m3"]) for p in ps)
        states = {actual[p["id"]]["status"] for p in ps}
        activities.append({
            "code": code, "name": next((a.get("name") for a in spec.get("activities") or [] if a["code"] == code), None),
            "planned_start": start.isoformat() if start else None,
            "planned_finish": planned_finish.isoformat() if planned_finish else None,
            "forecast_finish": f_finish.isoformat() if f_finish else None,
            "variance_wd": cal.between(planned_finish, f_finish) if planned_finish and f_finish else None,
            "done_m3": r1(done), "total_m3": r1(sum(p["m3"] for p in ps)),
            "planned_m3": r1(sum(p["m3"] * window_pct(plan.get(p["id"]), today) / 100 for p in ps)),
            "status": "built" if states == {"built"} else "not_started" if states == {"not_started"} else "in_progress",
        })
    reasons = why(spec, pours, actual, plan, fc, inputs, today, cal, review_reasons or [])
    last = max(inputs["observations"] + [e for e in inputs["events"] if e["type"] == "production"],
               key=lambda x: x["date"], default=None)
    return {
        "date": today.isoformat(),
        "deadline": deadline.isoformat() if deadline else None,
        "actual": actual,
        "planned": planned_state,
        "at_deadline": at_deadline,
        "forecast": fc,
        "summary": {
            "total_m3": r1(total), "built_m3": r1(built_m3), "planned_m3": r1(planned_m3),
            "pct_built": round(100 * built_m3 / total, 1) if total else 0.0,
            "pct_planned": round(100 * planned_m3 / total, 1) if total else 0.0,
            "counts": {s: sum(1 for v in actual.values() if v["status"] == s) for s in ("built", "in_progress", "not_started")},
            "forecast_completion": completion.isoformat() if completion else None,
            "late_working_days": late_wd,
            "late_calendar_days": (completion - deadline).days if deadline and completion else None,
            "status": None if late_wd is None else "late" if late_wd > 0 else "on_time",
            "behind_m3": r1(max(planned_m3 - built_m3, 0)),
            "last_update": {"date": last["date"], "ref": last["ref"]} if last else None,
        },
        "activities": activities,
        "why": reasons,
    }


def _window_state(window, d):
    pct = window_pct(window, d)
    return {"status": "built" if pct >= 100 else "in_progress" if pct > 0 else "not_started", "pct": pct}


def timeline(spec: dict, pours: list[dict], inputs: dict, today: date, deadline: date | None) -> dict:
    """Series for the slider and the chart: planned/actual/forecast cumulative m3 per day, the actual pour states at
    every date the records changed, and the planned and forecast window of every pour."""
    cal = Calendar.from_spec(spec)
    actual_today = pour_states(pours, inputs, today)
    plan = planned_windows(spec, pours)
    fc = forecast(spec, pours, actual_today, today, cal)
    fwin = forecast_windows(pours, plan, fc, actual_today, today)
    starts = [w[0] for w in plan.values()]
    if not starts:
        return {"points": [], "steps": [], "planned_windows": {}, "forecast_windows": {}, "start": None, "end": None}
    start = min(starts + [parse_day(o["date"]) for o in inputs["observations"]])
    completion = max((parse_day(f["date"]) for f in fc.values() if f.get("date")), default=today)
    end = max([completion, today] + ([deadline] if deadline else []))
    # signed m3 per activity per day; an activity's actual is capped at the volume of its pours (reports include waste)
    signed_by_day: dict[date, dict[str, float]] = {}
    for o in inputs["observations"]:
        if o["basis"] == "signed":
            slot = signed_by_day.setdefault(parse_day(o["date"]), {})
            slot[o["activity"]] = slot.get(o["activity"], 0) + o["qty"]
    cap: dict[str, float] = {}
    for p in pours:
        cap[p["activity"]] = cap.get(p["activity"], 0) + p["m3"]
    total = sum(p["m3"] for p in pours)
    points, cum, d = [], {}, start
    built_today = sum(min(actual_today[p["id"]]["done_m3"], p["m3"]) for p in pours)
    while d <= end:
        for act, q in signed_by_day.get(d, {}).items():
            cum[act] = cum.get(act, 0) + q
        planned = sum(p["m3"] * window_pct(plan.get(p["id"]), d) / 100 for p in pours)
        point = {"date": d.isoformat(), "planned": r1(planned)}
        if d <= today:
            point["actual"] = r1(sum(min(q, cap.get(a, 0)) for a, q in cum.items()))
        if d >= today:
            point["forecast"] = r1(built_today if d == today else sum(
                p["m3"] if actual_today[p["id"]]["status"] == "built" else
                max(p["m3"] * window_pct(fwin.get(p["id"]), d) / 100, min(actual_today[p["id"]]["done_m3"], p["m3"]))
                for p in pours))
        points.append(point)
        d += timedelta(days=1)
    change_days = sorted({parse_day(o["date"]) for o in inputs["observations"]} |
                         {parse_day(e["date"]) for e in inputs["events"] if e["type"] == "production"})
    steps = []
    for day in [x for x in change_days if x <= today]:
        states = pour_states(pours, inputs, day)
        steps.append({"date": day.isoformat(), "pours": {pid: [s["status"], s["pct"], s["basis"]]
                                                         for pid, s in states.items() if s["status"] != "not_started"}})
    return {
        "start": start.isoformat(), "end": end.isoformat(), "today": today.isoformat(),
        "deadline": deadline.isoformat() if deadline else None, "forecast_completion": completion.isoformat(),
        "total_m3": r1(total), "points": points, "steps": steps,
        "planned_windows": {pid: [a.isoformat(), b.isoformat()] for pid, (a, b) in plan.items()},
        "forecast_windows": {pid: [a.isoformat(), b.isoformat()] for pid, (a, b) in fwin.items()},
    }
