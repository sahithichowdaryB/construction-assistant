"""Daily evaluation (plan section 6): one work date of one project as of `as_of`.

    1 gather the day bundle            code   (every read filtered by available_at <= as_of)
    2 activity metrics + status        code   metrics.daily_activity
    3 day summary                      LLM P2 (cited; refs and numbers validated on the server)
    4 deviation attribution            LLM P3 (cited; an existing incident analysis takes precedence)
    5 ledger entries + alerts          code   metrics.ledger_for_day
    6 correspondence suggestions       code   metrics.suggest_notices (nothing is drafted or sent)

A run with the same input digest as the latest version writes nothing new. Otherwise it adds a version of
daily_evaluations / daily_activity_results, supersedes ledger rows whose content changed, and adds alert revisions
when an alert's calculation, severity or suggestion changed.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import text

from . import metrics as m
from .baseline import active_baseline, load_plans, load_settings
from .prompts import (P2_LISTS, P2_SCHEMA, P2_SYSTEM, P3_SCHEMA, P3_SYSTEM, ModelError, Models, number_tokens,
                      unsupported_numbers, valid_refs, validate_items)

EVIDENCE_KINDS = ("daily_report", "diary", "voice", "voice_note", "text", "email", "minutes", "photo")
MAX_PASSAGES = 150
EQUIPMENT_ID = re.compile(r"\b[A-Z]{2}-\d{2}\b")
FAILED = re.compile(r"\b(fail(?:ed|s)?|reject(?:ed)?|not pass(?:ed)?|on hold|hold point (?:not|failed)|expired)\b", re.I)
PASSED = re.compile(r"\b(passed|approved|accepted|released for pour|signed off)\b", re.I)
DEFECT = re.compile(r"\b(crack|defect|damage[d]?|honeycomb|leak(?:ing)?|out of tolerance)\b", re.I)


def _ref(source_id, locator):
    return f"{source_id}:{locator}"


def _now():
    return datetime.now(timezone.utc).replace(microsecond=0)


def _num(v):
    return None if v is None else float(v)


# ------------------------------------------------------------------ step 1: gather

def _project(conn, project_id):
    row = conn.execute(text("SELECT * FROM sitemate.projects WHERE id=:p"), {"p": project_id}).mappings().one_or_none()
    if row is None:
        raise LookupError("Unknown project")
    return dict(row)


def _plans(conn, project_id, baseline_id, targets):
    if baseline_id:
        plans = load_plans(conn, project_id, baseline_id)
        if plans:
            return plans
    # No baseline yet: derive the plan from plan_targets (the pre-0009 data model).
    out = []
    names = {r["code"]: r for r in conn.execute(text("SELECT code, name, unit FROM sitemate.activities WHERE project_id=:p"),
                                                {"p": project_id}).mappings()}
    preds = defaultdict(list)
    for a, b in conn.execute(text("SELECT predecessor, successor FROM sitemate.activity_dependencies WHERE project_id=:p"),
                             {"p": project_id}).all():
        preds[b].append(a)
    for code, series in targets.items():
        days = sorted(d for d, q in series.items() if q > 0)
        if not days:
            continue
        out.append(m.ActivityPlan(code, days[0], days[-1], sum(series.values()), max(series.values()), None, len(days),
                                  None, preds.get(code, []), (names.get(code) or {}).get("name"),
                                  (names.get(code) or {}).get("unit")))
    return out


def load_series(conn, project_id, when):
    """Plan targets and the latest signed / estimated reading per activity and date, as known at `when`."""
    params = {"p": project_id, "cutoff": when}
    targets, plan_refs = defaultdict(dict), {}
    for r in conn.execute(text("""
        SELECT t.activity_code, t.work_date, t.quantity, t.source_id, t.locator FROM sitemate.plan_targets t
        JOIN sitemate.sources s ON (s.project_id, s.id) = (t.project_id, t.source_id)
        WHERE t.project_id = :p AND s.available_at <= :cutoff"""), params).mappings():
        targets[r["activity_code"]][r["work_date"]] = float(r["quantity"])
        plan_refs.setdefault(r["activity_code"], _ref(r["source_id"], r["locator"]))
    signed, estimates = defaultdict(dict), defaultdict(dict)
    for r in conn.execute(text("""
        SELECT DISTINCT ON (o.activity_code, o.work_date, o.basis) o.activity_code, o.work_date, o.quantity, o.basis,
               o.source_id, o.locator, s.available_at
        FROM sitemate.observations o JOIN sitemate.sources s ON (s.project_id, s.id) = (o.project_id, o.source_id)
        WHERE o.project_id = :p AND s.available_at <= :cutoff
          AND (o.accepted_at IS NULL OR o.accepted_at <= :cutoff)
        ORDER BY o.activity_code, o.work_date, o.basis, s.available_at DESC, o.source_id, o.locator"""), params).mappings():
        item = {"quantity": float(r["quantity"]), "ref": _ref(r["source_id"], r["locator"]),
                "available_at": r["available_at"], "source_id": r["source_id"]}
        (signed if r["basis"] == "signed" else estimates)[r["activity_code"]][r["work_date"]] = item
    return targets, plan_refs, signed, estimates


def gather(conn, project_id, work_date: date, when: datetime) -> dict:
    project = _project(conn, project_id)
    tz = ZoneInfo(project["timezone"])
    baseline = active_baseline(conn, project_id, when)
    baseline_id = baseline["id"] if baseline else None
    settings = load_settings(conn, project_id, baseline_id)
    cal = m.Calendar.from_settings(settings)
    params = {"p": project_id, "cutoff": when}

    targets, plan_refs, signed, estimates = load_series(conn, project_id, when)
    plans = _plans(conn, project_id, baseline_id, targets)
    activities = {r["code"]: dict(r) for r in conn.execute(text("""
        SELECT a.code, a.name, a.unit, a.zone, a.contractor_id, c.name AS contractor FROM sitemate.activities a
        LEFT JOIN sitemate.contractors c ON (c.project_id, c.id) = (a.project_id, a.contractor_id)
        WHERE a.project_id = :p"""), params).mappings()}
    activity_plan_refs = {}
    if baseline_id:
        activity_plan_refs = {r["activity_code"]: _ref(r["source_id"], r["locator"]) for r in conn.execute(text("""
            SELECT activity_code, source_id, locator FROM sitemate.activity_plan
            WHERE project_id = :p AND baseline_id = CAST(:b AS uuid) AND source_id IS NOT NULL"""),
            {"p": project_id, "b": baseline_id}).mappings()}

    start = datetime.combine(work_date, time.min, tz)
    end = start + timedelta(days=1)
    day = {"p": project_id, "cutoff": when, "start": start, "end": end}
    events = [dict(r) for r in conn.execute(text("""
        SELECT e.id::text AS id, e.event_type, e.category, e.summary, e.occurred_at, e.recorded_at, e.activity_code,
               e.equipment_id, e.asset_key, e.attributes, e.source_id, e.locator, e.incident_id::text AS incident_id
        FROM sitemate.events e
        JOIN sitemate.captures c ON (c.project_id, c.id) = (e.project_id, e.capture_id) AND c.status = 'saved'
        WHERE e.project_id = :p AND e.status = 'confirmed' AND e.recorded_at <= :cutoff
          AND e.occurred_at < :end AND e.occurred_at >= :start - interval '14 days'
        ORDER BY e.occurred_at, e.id"""), day).mappings()]
    incidents = [dict(r) for r in conn.execute(text("""
        SELECT i.id::text AS id, i.activity_code, i.kind, coalesce(i.event_type, i.kind) AS event_type, i.title,
               i.occurred_at, CASE WHEN i.resolved_at <= :cutoff THEN i.resolved_at END AS resolved_at, i.asset_key
        FROM sitemate.incidents i
        WHERE i.project_id = :p AND i.merged_into_id IS NULL AND i.occurred_at <= :cutoff AND i.occurred_at < :end
          AND (i.resolved_at IS NULL OR i.resolved_at > :cutoff OR i.resolved_at >= :start)
        ORDER BY i.occurred_at, i.id"""), day).mappings()]
    for inc in incidents:
        inc["refs"] = [_ref(s, loc) for s, loc in conn.execute(text("""
            SELECT DISTINCT fe.source_id, fe.locator FROM sitemate.capture_facts cf
            JOIN sitemate.fact_evidence fe ON (fe.project_id, fe.fact_id) = (cf.project_id, cf.id)
            JOIN sitemate.sources s ON (s.project_id, s.id) = (fe.project_id, fe.source_id)
            WHERE cf.project_id = :p AND cf.incident_id = CAST(:i AS uuid) AND cf.review_status <> 'rejected'
              AND s.available_at <= :cutoff
            UNION
            SELECT DISTINCT e.source_id, e.locator FROM sitemate.incident_events ie
            JOIN sitemate.events e ON (e.project_id, e.id) = (ie.project_id, ie.event_id)
            WHERE ie.project_id = :p AND ie.incident_id = CAST(:i AS uuid) AND ie.unlinked_at IS NULL
              AND e.recorded_at <= :cutoff
            ORDER BY 1, 2"""), {**params, "i": inc["id"]}).all()]
        inc["analysis"] = _analysis(conn, project_id, inc["id"], when)
    equipment = {r["id"]: dict(r) for r in conn.execute(text("""
        SELECT e.id, e.description, e.owner_id, c.name AS owner FROM sitemate.equipment e
        LEFT JOIN sitemate.contractors c ON (c.project_id, c.id) = (e.project_id, e.owner_id)
        WHERE e.project_id = :p"""), params).mappings()}
    assignments = {r["equipment_id"]: r["activity_code"] for r in conn.execute(text("""
        SELECT equipment_id, activity_code FROM sitemate.equipment_assignments
        WHERE project_id = :p AND work_date = (SELECT max(work_date) FROM sitemate.equipment_assignments
                                               WHERE project_id = :p AND work_date <= :d)"""),
        {"p": project_id, "d": work_date}).mappings()}
    milestones = []
    if baseline_id:
        milestones = [dict(r) | {"refs": [_ref(r["source_id"], r["locator"])] if r["source_id"] else []}
                      for r in conn.execute(text("""
            SELECT code, name, planned_date, contractual, achieved_date, activity_codes, source_id, locator
            FROM sitemate.milestones WHERE project_id = :p AND baseline_id = CAST(:b AS uuid) ORDER BY planned_date, code"""),
            {"p": project_id, "b": baseline_id}).mappings()]
    # Passages recorded for the day: reports and diaries about it (a report may arrive the next morning),
    # everything received that day, and the sources of the day's events.
    obs_sources = {v["source_id"] for series in (signed, estimates) for code in series
                   for d, v in series[code].items() if d == work_date}
    event_sources = {e["source_id"] for e in events if e["occurred_at"] >= start}
    rows = conn.execute(text("""
        SELECT sp.source_id, sp.locator, sp.page, sp.excerpt, sp.untrusted, s.kind, s.title, s.author, s.author_role,
               s.available_at
        FROM sitemate.source_passages sp JOIN sitemate.sources s ON (s.project_id, s.id) = (sp.project_id, sp.source_id)
        WHERE sp.project_id = :p AND s.available_at <= :cutoff AND s.kind = ANY(:kinds)
          AND coalesce(sp.kind, 'paragraph') <> 'metadata'
          AND (s.id = ANY(:ids) OR (s.available_at >= :start AND s.available_at < :end))
        ORDER BY s.available_at, sp.source_id, sp.ordinal NULLS LAST, sp.locator
        LIMIT :limit"""), {**day, "kinds": list(EVIDENCE_KINDS), "ids": sorted(obs_sources | event_sources),
                           "limit": MAX_PASSAGES}).mappings().all()
    passages = [{"ref": _ref(r["source_id"], r["locator"]), "source_id": r["source_id"], "locator": r["locator"],
                 "page": r["page"], "text": r["excerpt"], "untrusted": r["untrusted"], "source_kind": r["kind"],
                 "title": r["title"], "author": r["author"], "author_role": r["author_role"],
                 "available_at": r["available_at"]} for r in rows]
    weather_days = conn.scalar(text("""
        SELECT count(DISTINCT work_date) FROM sitemate.performance_ledger
        WHERE project_id = :p AND work_date < :d AND status <> 'superseded' AND kind = 'demerit'
          AND cause_category = 'weather' AND as_of <= :cutoff"""), {**params, "d": work_date}) or 0
    return {"project": project, "tz": tz, "baseline": baseline, "baseline_id": baseline_id, "settings": settings,
            "cal": cal, "plans": plans, "targets": targets, "plan_refs": {**plan_refs, **activity_plan_refs},
            "signed": signed, "estimates": estimates, "activities": activities, "events": events,
            "incidents": incidents, "equipment": equipment, "assignments": assignments, "milestones": milestones,
            "passages": passages, "weather_days_used": int(weather_days),
            "tracking_start": min((d for series in signed.values() for d in series), default=None), "work_date": work_date, "when": when,
            "start": start, "end": end}


def _analysis(conn, project_id, incident_id, when):
    row = conn.execute(text("""
        SELECT id::text AS id, version, status, confidence, headline_cause, reasoning
        FROM sitemate.incident_analyses WHERE project_id = :p AND incident_id = CAST(:i AS uuid) AND as_of <= :cutoff
        ORDER BY as_of DESC, version DESC LIMIT 1"""), {"p": project_id, "i": incident_id, "cutoff": when}).mappings().one_or_none()
    if row is None:
        return None
    out = dict(row) | {"confidence": float(row["confidence"])}
    out["refs"] = [_ref(s, loc) for s, loc in conn.execute(text("""
        SELECT DISTINCT source_id, locator FROM sitemate.analysis_evidence
        WHERE project_id = :p AND analysis_id = CAST(:a AS uuid) ORDER BY 1, 2"""),
        {"p": project_id, "a": row["id"]}).all()]
    return out


# ------------------------------------------------------------------ step 2: metrics

def _after_sweep(bundle) -> bool:
    sweep = bundle["settings"]["calendar"].get("sweep_time") or "18:00"
    h, mi = map(int, sweep.split(":"))
    return bundle["when"] >= datetime.combine(bundle["work_date"], time(h, mi), bundle["tz"])


def _output_severity_on(bundle, code, d):
    planned = bundle["targets"].get(code, {}).get(d, 0)
    obs = bundle["signed"].get(code, {}).get(d)
    if not planned or obs is None:
        return None
    short = 100 * max(planned - obs["quantity"], 0) / planned
    return m.output_severity(short, bundle["settings"]["thresholds"]["daily_output"])


def actual_before(bundle, code, wd) -> float:
    """Signed cumulative before `wd`, with planned quantities before the first signed report assumed done
    (metrics.carry_in), so missing history is not booked as backlog."""
    signed, series = bundle["signed"].get(code, {}), bundle["targets"].get(code, {})
    tracking = bundle.get("tracking_start")
    assumed = sum(q for d, q in series.items() if tracking and d < tracking and d < wd and d not in signed)
    return sum(v["quantity"] for d, v in signed.items() if d < wd) + assumed


def activity_rows(bundle) -> list[dict]:
    wd, cal, s = bundle["work_date"], bundle["cal"], bundle["settings"]
    after = _after_sweep(bundle)
    horizon = cal.add_working_days(wd, 5)
    out = []
    for p in bundle["plans"]:
        code = p.code
        series, signed = bundle["targets"].get(code, {}), bundle["signed"].get(code, {})
        planned = series.get(wd, 0.0)
        obs = signed.get(wd)
        actual = obs["quantity"] if obs else None
        first_output = min((d for d, v in signed.items() if v["quantity"] > 0 and (not p.planned_start or d >= p.planned_start)
                            and d <= wd), default=None)
        total = float(p.planned_total or 0) or sum(series.values())
        cum_before = actual_before(bundle, code, wd)
        complete_before = bool(total) and cum_before >= total - 1e-9
        coverage = bool(p.planned_start) and all(d in signed for d in cal.working_days(p.planned_start, wd - timedelta(days=1)))
        run, d = 0, wd
        for _ in range(30):
            d = cal.previous_working(d)
            if _output_severity_on(bundle, code, d) != "amber":
                break
            run += 1
        due = p.planned_start is not None and wd >= p.planned_start
        upcoming = p.planned_start is not None and wd < p.planned_start <= horizon
        late_candidate = due and first_output is None and not complete_before and coverage and wd > p.planned_start
        if not (planned > 0 or (actual or 0) > 0 or late_candidate or upcoming):
            continue
        x = m.DayInput(code, planned, actual, p.planned_start, p.planned_finish, wd, first_output, complete_before,
                       None, run, bool(p.is_critical), after, coverage)
        row = m.daily_activity(x, s, cal)
        a = bundle["activities"].get(code, {})
        est = bundle["estimates"].get(code, {}).get(wd)
        refs = [r for r in (bundle["plan_refs"].get(code), obs["ref"] if obs else None) if r]
        row.update(name=a.get("name") or p.name, unit=a.get("unit") or p.unit, zone=a.get("zone"),
                   contractor=a.get("contractor"), is_critical=bool(p.is_critical), basis="signed" if obs else None,
                   estimate={"value": est["quantity"], "ref": est["ref"], "basis": "estimated"} if est else None,
                   plan_ref=bundle["plan_refs"].get(code), actual_ref=obs["ref"] if obs else None, refs=refs,
                   cum_before=m.r2(cum_before), planned_total=m.r2(total), target_per_day=p.target_per_day,
                   planned_finish=p.planned_finish.isoformat() if p.planned_finish else None,
                   planned_start=p.planned_start.isoformat() if p.planned_start else None)
        out.append(row)
    rank = {"red": 0, "amber": 1, "none": 2}
    out.sort(key=lambda r: (rank[r["severity"]], -(r.get("shortfall_pct") or 0), r["code"]))
    return out


def _local_minutes(ts: datetime, tz) -> int:
    local = ts.astimezone(tz)
    return local.hour * 60 + local.minute


def equipment_idle(bundle) -> list[dict]:
    """Idle time per machine on the work date, from failure/release event pairs and equipment incidents.

    A breakdown with no recorded release is counted on its own day up to the end of the shift; on later days the end
    is unknown, so no hours are counted (flagged) rather than assuming a full idle day."""
    wd, tz, s = bundle["work_date"], bundle["tz"], bundle["settings"]
    known = set(bundle["equipment"])
    failures = defaultdict(list)
    for e in bundle["events"]:
        eq = e["equipment_id"] or ((e["asset_key"] or "")[3:] if (e["asset_key"] or "").startswith("eq:") else None)
        if eq and e["event_type"] in ("equipment_failure", "equipment_breakdown"):
            failures[eq].append({"start": e["occurred_at"], "end": None, "refs": [_ref(e["source_id"], e["locator"])],
                                 "activity_code": e["activity_code"], "incident_id": e["incident_id"]})
    for e in bundle["events"]:
        eq = e["equipment_id"] or ((e["asset_key"] or "")[3:] if (e["asset_key"] or "").startswith("eq:") else None)
        if eq and e["event_type"] == "repair_release":
            open_ = [f for f in failures.get(eq, []) if f["end"] is None and f["start"] <= e["occurred_at"]]
            if open_:
                open_[-1]["end"] = e["occurred_at"]
                open_[-1]["refs"].append(_ref(e["source_id"], e["locator"]))
    for inc in bundle["incidents"]:
        if inc["event_type"] not in ("equipment_failure", "equipment_breakdown"):
            continue
        eq = (inc["asset_key"] or "")[3:] if (inc["asset_key"] or "").startswith("eq:") else None
        eq = eq or next((x for x in EQUIPMENT_ID.findall(inc["title"] or "") if x in known), None)
        if not eq or any(abs((f["start"] - inc["occurred_at"]).total_seconds()) < 3600 for f in failures.get(eq, [])):
            continue
        failures[eq].append({"start": inc["occurred_at"], "end": inc["resolved_at"], "refs": inc["refs"],
                             "activity_code": inc["activity_code"], "incident_id": inc["id"]})
    out = []
    for eq, items in sorted(failures.items()):
        intervals, refs, unknown_end, incident_ids, code = [], [], False, [], None
        for f in items:
            start_day = f["start"].astimezone(tz).date()
            end_day = f["end"].astimezone(tz).date() if f["end"] else None
            if start_day > wd or (end_day and end_day < wd):
                continue
            a = _local_minutes(f["start"], tz) if start_day == wd else None
            if end_day == wd:
                b = _local_minutes(f["end"], tz)
            elif end_day and end_day > wd:
                b = None
            elif start_day == wd:
                # Still open: idle up to as_of while the day is running, else to the end of the shift.
                now_local = bundle["when"].astimezone(tz)
                b = _local_minutes(bundle["when"], tz) if now_local.date() == wd else None
            elif bundle["cal"].add_working_days(start_day, 1) == wd:
                unknown_end = True  # the day after an unreleased breakdown: shown, but no hours are assumed
                refs += f["refs"]
                continue
            else:
                continue
            intervals.append((a, b))
            refs += f["refs"]
            incident_ids += [f["incident_id"]] if f["incident_id"] else []
            code = code or f["activity_code"]
        if not intervals and not unknown_end:
            continue
        hours = m.idle_hours(intervals, s) if intervals else None
        meta = bundle["equipment"].get(eq, {})
        out.append({"equipment_id": eq, "description": meta.get("description"), "owner_id": meta.get("owner_id"),
                    "activity_code": code or bundle["assignments"].get(eq), "hours": hours,
                    "severity": m.idle_severity(hours, s), "end_known": not unknown_end,
                    "note": "Release time not recorded for this day; idle hours not counted" if unknown_end and not intervals else None,
                    "refs": list(dict.fromkeys(refs)), "incident_ids": sorted(set(incident_ids)),
                    "rate": m.equipment_rate(s, eq, meta.get("description"))})
    return out


def quality_holds(bundle) -> list[dict]:
    wd, tz = bundle["work_date"], bundle["tz"]
    out = []
    items = [(e["event_type"], e["summary"], e["activity_code"], [_ref(e["source_id"], e["locator"])], e["occurred_at"], e["id"],
              json.dumps(e["attributes"] or {})) for e in bundle["events"]]
    items += [(i["event_type"], i["title"], i["activity_code"], i["refs"], i["occurred_at"], i["id"], "")
              for i in bundle["incidents"]]
    for kind, summary, code, refs, at, ident, attrs in items:
        if at.astimezone(tz).date() != wd or kind not in ("quality_observation", "inspection_hold", "inspection",
                                                          "inspection_failed", "hold_point"):
            continue
        blob = f"{summary} {attrs}"
        failed = kind in ("inspection_hold", "inspection_failed") or bool(FAILED.search(blob))
        out.append({"subject": f"{code or 'site'}:{ident[:8]}", "activity_code": code, "kind": kind, "text": summary,
                    "failed": failed, "passed": not failed and bool(PASSED.search(blob)),
                    "defect": bool(DEFECT.search(blob)), "refs": refs})
    return out


def milestone_events(bundle) -> list[dict]:
    wd, cal = bundle["work_date"], bundle["cal"]
    out = []
    for ms in bundle["milestones"]:
        planned = ms["planned_date"]
        achieved = ms["achieved_date"]
        if achieved is None and ms["activity_codes"]:
            finishes = []
            for code in ms["activity_codes"]:
                p = next((x for x in bundle["plans"] if x.code == code), None)
                signed = bundle["signed"].get(code, {})
                total = float(p.planned_total or 0) if p else 0
                running, done = 0.0, None
                for d in sorted(signed):
                    running += signed[d]["quantity"]
                    if total and running >= total - 1e-9:
                        done = d
                        break
                finishes.append(done)
            achieved = max(finishes) if finishes and all(finishes) else None
        event = None
        if achieved == wd and planned and achieved <= planned:
            event = "met"
        elif planned and (achieved is None or achieved > planned) and cal.is_working(wd) and \
                wd == cal.add_working_days(planned, 1):
            event = "missed"
        if event:
            out.append({"code": ms["code"], "name": ms["name"], "event": event, "planned_date": planned.isoformat(),
                        "achieved_date": achieved.isoformat() if achieved else None, "refs": ms["refs"]})
    return out


def indicators(bundle, rows) -> dict:
    after = _after_sweep(bundle)
    missing = [r["code"] for r in rows if r["status"] == "not_reported"]
    return {"equipment_idle": equipment_idle(bundle), "quality_holds": quality_holds(bundle),
            "milestones": milestone_events(bundle),
            "missing_report": {"activities": missing, "after_sweep": after,
                               "refs": [r["plan_ref"] for r in rows if r["status"] == "not_reported" and r.get("plan_ref")]}
            if missing else None,
            "labour": None}


# ------------------------------------------------------------------ step 3: day summary (P2)

def code_headline(rows) -> str:
    planned = [r for r in rows if r["planned"]]
    counts = defaultdict(int)
    for r in planned:
        counts[r["status"]] += 1
    worst = next((r for r in rows if r["severity"] != "none" and r["status"] == "behind"), None)
    bits = [f"{len(planned)} planned activities"]
    bits += [f"{n} {label}" for key, label in (("behind", "behind plan"), ("late_start", "late to start"),
                                                ("not_reported", "not reported"), ("on_track", "on plan"),
                                                ("exceeded", "ahead of plan")) if (n := counts.get(key))]
    line = ", ".join(bits)
    if worst:
        line += (f". Largest shortfall: {worst['code']} {worst['actual']:g} of {worst['planned']:g} "
                 f"{worst.get('unit') or ''} ({worst['variance_pct']:g}%)")
    unplanned = [r for r in rows if r["status"] == "unplanned_work"]
    if unplanned:
        line += ". Off-plan output: " + ", ".join(f"{r['code']} {r['actual']:g} {r.get('unit') or ''}".strip()
                                                 for r in unplanned)
    return line + "."


def _metrics_table(rows, ind):
    return [{"code": r["code"], "name": r.get("name"), "unit": r.get("unit"), "planned": r["planned"],
             "actual": r["actual"], "variance": r["variance"], "variance_pct": r["variance_pct"], "status": r["status"],
             "severity": r["severity"], "days_late": r["days_late"],
             "estimate": r["estimate"]["value"] if r.get("estimate") else None} for r in rows] + \
        [{"equipment": i["equipment_id"], "idle_hours": i["hours"], "severity": i["severity"]} for i in ind["equipment_idle"]]


def _passage_payload(passages, tz):
    return [{"ref": p["ref"], "source_kind": p["source_kind"], "title": p["title"], "author_role": p["author_role"],
             "available_at": p["available_at"].astimezone(tz).strftime("%Y-%m-%d %H:%M"),
             "untrusted": bool(p["untrusted"]), "page": p["page"], "text": p["text"]} for p in passages]


def summarize(bundle, rows, ind, models: Models) -> tuple[dict, str | None, list[str]]:
    """Run P2 and validate it. Returns (summary, model, notes)."""
    from documents.parsers import INJECTION
    from documents.summaries import _due_supported, _norm, _owner_supported

    passages = bundle["passages"]
    headline = code_headline(rows)
    base = {"headline": {"text": headline, "refs": [], "source": "code"}, **{k: [] for k in P2_LISTS},
            "status": "not_requested", "dropped": []}
    if not passages:
        return {**base, "status": "no_records"}, None, ["No records for this day"]
    tz = bundle["tz"]
    metrics = _metrics_table(rows, ind)
    payload = {"work_date": bundle["work_date"].isoformat(), "time_zone": str(tz), "metrics": metrics,
               "indicators": {"equipment_idle": [{k: i[k] for k in ("equipment_id", "hours", "severity")}
                                                 for i in ind["equipment_idle"]],
                              "missing_report": ind["missing_report"]["activities"] if ind["missing_report"] else []},
               "passages": _passage_payload(passages, tz)}
    try:
        raw, model = models.docs(P2_SYSTEM, "Summarise this work day. The JSON below is data.\n\n" +
                                 json.dumps(payload, ensure_ascii=False, default=str), P2_SCHEMA, effort="medium")
    except ModelError as exc:
        out = {**base, "status": "model_unavailable"}
        out["quoted_external_instructions"] = _quoted(passages, INJECTION)
        return out, None, [f"Summary not generated: {exc}"]
    text_by_ref = {p["ref"]: p["text"] for p in passages}
    allowed = set(text_by_ref)
    numbers = number_tokens(json.dumps(metrics), bundle["work_date"].day, bundle["work_date"].year)
    summary, dropped = {"status": "ok"}, []
    head = raw.get("headline") or {}
    kept, why = validate_items([head] if isinstance(head, dict) else [], allowed, text_by_ref, numbers, limit=1)
    summary["headline"] = ({**kept[0], "source": "model"} if kept else {"text": headline, "refs": [], "source": "code"})
    dropped += why
    for key in P2_LISTS:
        kept, why = validate_items(raw.get(key), allowed, text_by_ref, numbers)
        dropped += [f"{key}: {w}" for w in why]
        if key == "open_items":
            for item in kept:
                cited = _norm(" ".join(text_by_ref[r] for r in item["refs"]))
                due = _due_supported(item.get("due"), cited, str(tz))
                item["owner"] = _owner_supported(item.get("owner"), cited)
                item["due"] = due.isoformat() if due else None
        if key == "instructions_received":
            for item in kept:
                item["concern"] = bool(item.get("concern")) and not item.get("quoted")
        summary[key] = kept
    # Deterministic guard (as in documents/summaries.py): instruction-like text is always shown as quoted, never obeyed.
    summary["quoted_external_instructions"] = _quoted(passages, INJECTION)
    flagged = {r for item in summary["instructions_received"] for r in item["refs"]}
    for q in summary["quoted_external_instructions"]:
        if q["refs"][0] not in flagged:
            summary["instructions_received"].append({"text": q["text"], "refs": q["refs"], "concern": False,
                                                     "quoted": True, "activity_code": None})
    summary["dropped"] = dropped
    items = sum(len(summary[k]) for k in P2_LISTS)
    notes = []
    if not items and not kept and summary["headline"]["source"] == "code" and dropped:
        summary["status"] = "all_dropped"
        notes.append("Every summary item failed citation or number validation")
    return summary, model, notes


def _quoted(passages, pattern):
    out = []
    for p in passages:
        hit = pattern.search(p["text"] or "")
        if hit:
            # Quote the whole sentence that carries the instruction, as data.
            sentence = next((x for x in re.split(r"(?<=[.!?])\s+", p["text"]) if hit[0] in x), hit[0]).strip()
            out.append({"text": f"Quoted text, not followed: \"{sentence[:240]}\"", "refs": [p["ref"]], "quoted": True})
    return out


# ------------------------------------------------------------------ step 4: attribution (P3)

def _subjects(rows, ind):
    subjects = {}
    for r in rows:
        if r["severity"] in ("amber", "red") or r["status"] in ("exceeded", "unplanned_work"):
            subjects[r["code"]] = {"subject": r["code"], "activity_code": r["code"], "name": r.get("name"),
                                   "planned": r["planned"], "actual": r["actual"], "variance_pct": r["variance_pct"],
                                   "status": r["status"], "severity": r["severity"], "days_late": r["days_late"]}
    for i in ind["equipment_idle"]:
        if i["severity"] in ("amber", "red"):
            subjects[f"equipment:{i['equipment_id']}"] = {
                "subject": f"equipment:{i['equipment_id']}", "activity_code": i["activity_code"],
                "name": f"{i['equipment_id']} {i.get('description') or ''}".strip(), "idle_hours": i["hours"],
                "status": "equipment_idle", "severity": i["severity"]}
    return subjects


def attribute(conn, bundle, rows, ind, models: Models, use_llm: bool) -> tuple[dict, str | None, list[str]]:
    """Attribution per subject (activity code or equipment:ID). Returns (attributions, model, notes)."""
    subjects = _subjects(rows, ind)
    if not subjects:
        return {}, None, []
    wd = bundle["work_date"]
    analyses = {}
    for key, s in subjects.items():
        eq = key.split(":", 1)[1] if key.startswith("equipment:") else None
        idle = next((i for i in ind["equipment_idle"] if i["equipment_id"] == eq), None) if eq else None
        for inc in bundle["incidents"]:
            linked = (inc["id"] in (idle or {}).get("incident_ids", [])) or (
                inc["activity_code"] == s["activity_code"] and inc["occurred_at"].astimezone(bundle["tz"]).date() <= wd)
            if linked and inc["analysis"]:
                analyses[key] = {"incident_id": inc["id"], "incident": inc["title"], **{
                    k: inc["analysis"][k] for k in ("status", "confidence", "headline_cause", "reasoning", "refs")}}
                break
    base = {}
    for key, s in subjects.items():
        a = analyses.get(key)
        base[key] = {"subject": key, "explanation": (a["headline_cause"] if a and a.get("headline_cause") else
                                                     "No record states a cause yet."),
                     "cause_category": "unknown", "responsible_party_ref": None,
                     "confidence": min(a["confidence"], 0.2) if a else 0.0, "refs": (a or {}).get("refs", [])[:4],
                     "analysis": {k: a[k] for k in ("incident_id", "status", "confidence", "headline_cause")} if a else None,
                     "status": "not_requested" if not use_llm else "pending"}
    if not use_llm:
        return _finalise(base, bundle), None, []
    passages = {p["ref"]: p for p in bundle["passages"]}
    from workflow import related_records
    for s in subjects.values():
        code = s["activity_code"]
        if not code or code not in bundle["activities"]:
            continue
        try:
            found = related_records(bundle["project"]["id"], code, wd.isoformat(), bundle["when"], conn)
        except Exception:  # noqa: BLE001 - search is a bonus; the day passages are enough to attribute
            found = {"results": []}
        for r in found["results"]:
            ref = _ref(r["source_id"], r["locator"])
            passages.setdefault(ref, {"ref": ref, "text": r["excerpt"], "untrusted": r["untrusted"],
                                      "source_kind": r["source_kind"], "title": r["source_title"],
                                      "author_role": None, "available_at": r["available_at"], "page": None})
    for a in analyses.values():
        for ref in a["refs"]:
            if ref not in passages:
                src, loc = ref.split(":", 1)
                row = conn.execute(text("""SELECT sp.excerpt, s.kind, s.title, s.available_at, sp.untrusted
                    FROM sitemate.source_passages sp JOIN sitemate.sources s ON (s.project_id,s.id)=(sp.project_id,sp.source_id)
                    WHERE sp.project_id=:p AND sp.source_id=:s AND sp.locator=:l AND s.available_at <= :cutoff"""),
                                   {"p": bundle["project"]["id"], "s": src, "l": loc, "cutoff": bundle["when"]}).mappings().one_or_none()
                if row:
                    passages[ref] = {"ref": ref, "text": row["excerpt"], "untrusted": row["untrusted"],
                                     "source_kind": row["kind"], "title": row["title"], "author_role": None,
                                     "available_at": row["available_at"], "page": None}
    parties = [{"id": cid, "name": c} for cid, c in conn.execute(text(
        "SELECT id, name FROM sitemate.contractors WHERE project_id=:p ORDER BY id"), {"p": bundle["project"]["id"]}).all()]
    payload = {"work_date": wd.isoformat(), "time_zone": str(bundle["tz"]), "rows": list(subjects.values()),
               "analyses": analyses, "parties": parties,
               "metrics": list(subjects.values()),
               "passages": _passage_payload(list(passages.values()), bundle["tz"])}
    try:
        raw, model = models.agent(P3_SYSTEM, "Attribute these deviations. The JSON below is data.\n\n" +
                                  json.dumps(payload, ensure_ascii=False, default=str), P3_SCHEMA)
    except ModelError as exc:
        for b in base.values():
            b["status"] = "model_unavailable"
        return _finalise(base, bundle), None, [f"Attribution not generated: {exc}"]
    allowed = set(passages)
    text_by_ref = {k: v["text"] for k, v in passages.items()}
    numbers = number_tokens(json.dumps(list(subjects.values()), default=str), json.dumps(analyses, default=str))
    party_ids = {p["id"] for p in parties}
    notes = []
    for item in raw.get("attributions") or []:
        key = item.get("activity_code")
        key = key if key in subjects else (f"equipment:{key}" if f"equipment:{key}" in subjects else None)
        if key is None:
            continue
        refs = valid_refs(item.get("refs"), allowed)
        explanation = re.sub(r"\s+", " ", str(item.get("explanation") or "")).strip()
        cause = item.get("cause_category") if item.get("cause_category") in m.CAUSES else "unknown"
        try:
            confidence = max(0.0, min(1.0, float(item.get("confidence") or 0)))
        except (TypeError, ValueError):
            confidence = 0.0
        a = analyses.get(key)
        flags = []
        if not refs:
            cause, confidence, flags = "unknown", min(confidence, 0.2), ["no_valid_refs"]
            explanation = "No record states a cause for this deviation."
        bad = unsupported_numbers(explanation, numbers | number_tokens(" ".join(text_by_ref.get(r, "") for r in refs)))
        if bad:
            flags.append(f"unsupported_numbers: {', '.join(bad)}")
            explanation = base[key]["explanation"]
        if a:
            if a["status"] in ("undetermined", "needs_review"):
                cause, confidence = "unknown", min(confidence, 0.2)
                flags.append("analysis_undetermined")
            elif abs(confidence - a["confidence"]) > 0.2:
                flags.append(f"confidence aligned to the incident analysis ({a['confidence']})")
                confidence = a["confidence"]
            refs = list(dict.fromkeys(refs + [r for r in a["refs"] if r in allowed]))
        party = item.get("responsible_party_ref") if item.get("responsible_party_ref") in party_ids else None
        base[key].update(explanation=explanation, cause_category=cause, responsible_party_ref=party,
                         confidence=round(confidence, 3), refs=refs, status="ok", flags=flags)
    for b in base.values():
        if b["status"] == "pending":
            b["status"] = "not_returned"
            notes.append(f"{b['subject']}: no attribution returned; cause left unknown")
    return _finalise(base, bundle), model, notes


def _finalise(attributions, bundle):
    for a in attributions.values():
        a["excusable"] = m.is_excusable(a["cause_category"], bundle["settings"], bundle["weather_days_used"])
        a["is_excusable_candidate"] = a["excusable"]
        a["label"] = "advisory, not a statement of liability"
    return attributions


# ------------------------------------------------------------------ steps 5-6: ledger context, suggestions

def ledger_context(bundle, rows, attributions):
    wd, cal, s = bundle["work_date"], bundle["cal"], bundle["settings"]
    out = {}
    for r in rows:
        code = r["code"]
        series, signed = bundle["targets"].get(code, {}), bundle["signed"].get(code, {})
        planned_before = sum(q for d, q in series.items() if d < wd)
        done_before = actual_before(bundle, code, wd)
        prev_late = (m.late_start_severity(r["days_late"] - 1, r["is_critical"], s["thresholds"]["start_finish"])
                     if r["status"] == "late_start" and r["days_late"] else None)
        out[code] = {"backlog_before": planned_before - done_before, "target_per_day": r.get("target_per_day"),
                     "planned_total": r.get("planned_total"), "actual_cum_before": done_before,
                     "planned_finish": r.get("planned_finish"), "attribution": attributions.get(code),
                     "refs": r["refs"], "prev_late_severity": prev_late}
    return out


def evaluate_day(conn, project_id, work_date: date, as_of: datetime | None = None, *, models: Models | None = None,
                 use_llm: bool = True, trigger: str = "manual", force: bool = False) -> dict:
    """Evaluate one day and persist a new version when the inputs changed. The caller commits."""
    when = (as_of or _now()).astimezone(timezone.utc)
    bundle = gather(conn, project_id, work_date, when)
    rows = activity_rows(bundle)
    ind = indicators(bundle, rows)
    digest = input_digest(bundle, use_llm)
    latest = conn.execute(text("""SELECT version, input_digest, summary->>'status' AS summary_status
        FROM sitemate.daily_evaluations
        WHERE project_id=:p AND work_date=:d AND as_of <= :at ORDER BY as_of DESC, version DESC LIMIT 1"""),
                          {"p": project_id, "d": work_date, "at": when}).mappings().one_or_none()
    top = conn.scalar(text("SELECT coalesce(max(version), 0) FROM sitemate.daily_evaluations WHERE project_id=:p "
                           "AND work_date=:d"), {"p": project_id, "d": work_date})
    if latest and latest["input_digest"] == digest and not force and \
            not (use_llm and latest["summary_status"] == "not_requested"):
        return {"reused": True, "version": latest["version"], "work_date": work_date.isoformat()}
    models = models or Models()
    summary, s_model, notes = (summarize(bundle, rows, ind, models) if use_llm else
                               ({"headline": {"text": code_headline(rows), "refs": [], "source": "code"},
                                 **{k: [] for k in P2_LISTS}, "status": "not_requested", "dropped": []}, None, []))
    attributions, a_model, a_notes = attribute(conn, bundle, rows, ind, models, use_llm)
    notes += a_notes
    for r in rows:
        r["attribution"] = attributions.get(r["code"])
    for i in ind["equipment_idle"]:
        i["attribution"] = attributions.get(f"equipment:{i['equipment_id']}")
    for q in ind["quality_holds"]:
        q["attribution"] = attributions.get(q["activity_code"]) if q.get("activity_code") else None
    entries = m.ledger_for_day(work_date, rows, ledger_context(bundle, rows, attributions), ind, bundle["settings"])
    instructions = [i for i in summary.get("instructions_received") or [] if i.get("concern")]
    suggestions = m.suggest_notices(work_date, rows, ind, instructions, bundle["settings"], bundle["cal"])
    day_status, day_severity = m.day_rollup(rows, ind)
    status = "needs_review" if (use_llm and summary.get("status") in ("all_dropped", "model_unavailable")) else "ok"
    provisional = any(r["status"] == "not_reported" for r in rows) and not _after_sweep(bundle)
    version = top + 1
    write_alerts(conn, bundle, rows, ind, suggestions, version, when)  # first: suggestions learn their alert_id
    score = m.r2(sum(e["points"] for e in entries if not e["excusable"]))
    model = ", ".join(x for x in dict.fromkeys([s_model, a_model]) if x) or None
    conn.execute(text("""
        INSERT INTO sitemate.daily_evaluations (project_id, work_date, version, as_of, baseline_id, input_digest,
            day_status, day_severity, day_score, provisional, summary, indicators, suggestions, trigger, model, status, notes)
        VALUES (:p, :d, :v, :at, CAST(:b AS uuid), :dg, :ds, :sev, :score, :prov, CAST(:sum AS jsonb), CAST(:ind AS jsonb),
                CAST(:sug AS jsonb), :trig, :model, :status, CAST(:notes AS jsonb))"""),
                 {"p": project_id, "d": work_date, "v": version, "at": when, "b": bundle["baseline_id"], "dg": digest,
                  "ds": day_status, "sev": day_severity, "score": score, "prov": provisional, "sum": _j(summary),
                  "ind": _j(ind), "sug": _j(suggestions), "trig": trigger, "model": model, "status": status,
                  "notes": _j(notes)})
    for r in rows:
        conn.execute(text("""
            INSERT INTO sitemate.daily_activity_results (project_id, work_date, version, activity_code, planned, actual,
                basis, variance, variance_pct, status, severity, escalated, days_late, estimate, attribution, refs)
            VALUES (:p, :d, :v, :c, :pl, :ac, :basis, :var, :pct, :st, :sev, :esc, :late, CAST(:est AS jsonb),
                    CAST(:attr AS jsonb), CAST(:refs AS jsonb))"""),
                     {"p": project_id, "d": work_date, "v": version, "c": r["code"], "pl": r["planned"], "ac": r["actual"],
                      "basis": r["basis"], "var": r["variance"], "pct": r["variance_pct"], "st": r["status"],
                      "sev": r["severity"], "esc": r["escalated"], "late": r["days_late"], "est": _j(r["estimate"]),
                      "attr": _j(r["attribution"]), "refs": _j(r["refs"])})
    write_ledger(conn, project_id, work_date, version, entries, when)
    queued = queue_auto_drafts(conn, {**bundle, "when": when}, suggestions)
    return {"reused": False, "version": version, "work_date": work_date.isoformat(), "status": status,
            "auto_drafts_queued": queued}


def _j(value):
    return json.dumps(value, default=lambda o: o.isoformat() if isinstance(o, (date, datetime)) else str(o))


def input_digest(bundle, use_llm=None) -> str:
    wd = bundle["work_date"]
    parts = {
        "baseline": bundle["baseline_id"], "settings": bundle["settings"],
        "after_sweep": _after_sweep(bundle),
        "targets": {c: {str(d): q for d, q in s.items() if abs((d - wd).days) <= 60} for c, s in bundle["targets"].items()},
        "signed": {c: {str(d): v["ref"] + f"={v['quantity']}" for d, v in s.items()} for c, s in bundle["signed"].items()},
        "estimates": {c: {str(d): v["ref"] for d, v in s.items() if d == wd} for c, s in bundle["estimates"].items()},
        "events": [(e["id"], str(e["occurred_at"]), e["event_type"]) for e in bundle["events"]],
        "incidents": [(i["id"], str(i["resolved_at"]), (i["analysis"] or {}).get("id")) for i in bundle["incidents"]],
        "passages": [(p["ref"], hashlib.sha256((p["text"] or "").encode()).hexdigest()) for p in bundle["passages"]],
        "milestones": [(x["code"], str(x["achieved_date"])) for x in bundle["milestones"]],
        "weather_days": bundle["weather_days_used"],
    }
    return hashlib.sha256(_j(parts).encode()).hexdigest()


def _content(e):
    return (e["subject"], e["rule_key"], float(e["points"]), bool(e["excusable"]), e.get("cause_category"))


LEDGER_AT = """
    WITH v AS (SELECT DISTINCT ON (work_date) work_date, version FROM sitemate.daily_evaluations
               WHERE project_id = :p AND as_of <= :at ORDER BY work_date, as_of DESC, version DESC)
    SELECT l.* FROM sitemate.performance_ledger l JOIN v ON v.work_date = l.work_date
    WHERE l.project_id = :p AND l.daily_version <= v.version
      AND (l.superseded_version IS NULL OR l.superseded_version > v.version)
"""


def write_ledger(conn, project_id, work_date, version, entries, when):
    """Version-interval ledger: a row is valid from `daily_version` until `superseded_version`. Rows whose content
    is unchanged stay (with their review); others are superseded by this version and new rows are proposed. A new
    row identical to an earlier reviewed one carries that review over."""
    live = conn.execute(text("""SELECT id::text AS id, subject, rule_key, points, excusable, cause_category
        FROM sitemate.performance_ledger WHERE project_id=:p AND work_date=:d AND status <> 'superseded'"""),
                        {"p": project_id, "d": work_date}).mappings().all()
    wanted = {_content(e): e for e in entries}
    keep = set()
    for row in live:
        key = (row["subject"], row["rule_key"], float(row["points"]), bool(row["excusable"]), row["cause_category"])
        if key in wanted and key not in keep:
            keep.add(key)
            continue
        conn.execute(text("""UPDATE sitemate.performance_ledger SET status='superseded', superseded_at=:at,
                                    superseded_version=:v
                             WHERE project_id=:p AND id=CAST(:i AS uuid)"""),
                     {"p": project_id, "i": row["id"], "at": when, "v": version})
    for key, e in wanted.items():
        if key in keep:
            continue
        prior = conn.execute(text("""SELECT reviewer_id, note, reviewed_at, detail->>'review_status' AS review_status
            FROM sitemate.performance_ledger WHERE project_id=:p AND work_date=:d AND subject=:s AND rule_key=:r
              AND points=:pts AND excusable=:exc AND cause_category IS NOT DISTINCT FROM CAST(:cause AS text)
              AND reviewed_at IS NOT NULL ORDER BY reviewed_at DESC LIMIT 1"""),
                             {"p": project_id, "d": work_date, "s": e["subject"], "r": e["rule_key"], "pts": e["points"],
                              "exc": e["excusable"], "cause": e["cause_category"]}).mappings().one_or_none()
        status = (prior["review_status"] if prior and prior["review_status"] in ("accepted", "disputed") else "proposed")
        detail = {**e["detail"], **({"review_status": status, "review_carried_over": True} if status != "proposed" else {})}
        conn.execute(text("""
            INSERT INTO sitemate.performance_ledger (project_id, work_date, activity_code, subject, rule_key, kind, points,
                quantity, cause_category, responsible_party, excusable, refs, detail, daily_version, status, as_of,
                reviewer_id, note, reviewed_at)
            VALUES (:p, :d, :c, :s, :r, :k, :pts, :q, :cause, :party, :exc, CAST(:refs AS jsonb), CAST(:det AS jsonb),
                    :v, :status, :at, :rev, :note, :rat)"""),
                     {"p": project_id, "d": work_date, "c": e["activity_code"], "s": e["subject"], "r": e["rule_key"],
                      "k": e["kind"], "pts": e["points"], "q": e["quantity"], "cause": e["cause_category"],
                      "party": e["responsible_party"], "exc": e["excusable"], "refs": _j(e["refs"]),
                      "det": _j(detail), "v": version, "at": when, "status": status,
                      "rev": prior["reviewer_id"] if status != "proposed" else None,
                      "note": prior["note"] if status != "proposed" else None,
                      "rat": prior["reviewed_at"] if status != "proposed" else None})


ALERT_KIND = {"behind": "shortfall", "late_start": "late_start"}


def _upsert_alert(conn, project_id, code, checkpoint, kind, title=None):
    row = conn.execute(text("""SELECT id::text AS id FROM sitemate.alerts WHERE project_id=:p AND kind=:k
        AND checkpoint_at=:cp AND activity_code IS NOT DISTINCT FROM CAST(:c AS text)"""),
                       {"p": project_id, "k": kind, "cp": checkpoint, "c": code}).mappings().one_or_none()
    if row:
        return row["id"]
    return conn.scalar(text("""INSERT INTO sitemate.alerts (project_id, activity_code, checkpoint_at, kind, title)
        VALUES (:p, :c, :cp, :k, :t) RETURNING id::text"""), {"p": project_id, "c": code, "cp": checkpoint, "k": kind, "t": title})


def _revise(conn, project_id, alert_id, when, severity, calc, refs, suggestion, reason):
    last = conn.execute(text("""SELECT version, severity, calculation, suggested_notice FROM sitemate.alert_revisions
        WHERE project_id=:p AND alert_id=CAST(:a AS uuid) AND as_of <= :at ORDER BY as_of DESC, version DESC LIMIT 1"""),
                        {"p": project_id, "a": alert_id, "at": when}).mappings().one_or_none()
    top = conn.scalar(text("SELECT coalesce(max(version), 0) FROM sitemate.alert_revisions WHERE project_id=:p "
                           "AND alert_id=CAST(:a AS uuid)"), {"p": project_id, "a": alert_id})
    calc = json.loads(_j(calc))
    suggestion = json.loads(_j(suggestion)) if suggestion else None
    if last and last["severity"] == severity and last["calculation"] == calc and last["suggested_notice"] == suggestion:
        return
    conn.execute(text("""
        INSERT INTO sitemate.alert_revisions (project_id, alert_id, version, as_of, severity, calculation, evidence_refs,
                                              reason, suggested_notice)
        VALUES (:p, CAST(:a AS uuid), :v, :at, :sev, CAST(:calc AS jsonb), CAST(:refs AS jsonb), :why, CAST(:sug AS jsonb))"""),
                 {"p": project_id, "a": alert_id, "v": top + 1, "at": when,
                  "sev": severity, "calc": _j(calc), "refs": _j(refs), "why": reason, "sug": _j(suggestion) if suggestion else None})


def _ref_objects(refs):
    out = []
    for r in refs:
        if r and ":" in r:
            s, loc = r.split(":", 1)
            out.append({"source_id": s, "locator": loc})
    return out


def write_alerts(conn, bundle, rows, ind, suggestions, version, when):
    pid, tz, wd = bundle["project"]["id"], bundle["tz"], bundle["work_date"]
    checkpoint = datetime.combine(wd, time(17, 30), tz)
    reason = f"Daily evaluation v{version}"
    by_code = defaultdict(list)
    for s in suggestions:
        by_code[(s["type"], s.get("activity_code"), s.get("equipment_id"))].append(s)
    for r in rows:
        kind = ALERT_KIND.get(r["status"])
        if not kind or r["severity"] not in ("amber", "red"):
            continue
        alert_id = _upsert_alert(conn, pid, r["code"], checkpoint, kind)
        calc = {"planned": r["planned"], "actual": r["actual"], "shortfall_pct": r["shortfall_pct"], "unit": r.get("unit"),
                "variance": r["variance"], "variance_pct": r["variance_pct"], "status": r["status"],
                "band": r["severity"], "escalated": r["escalated"], "days_late": r["days_late"],
                "work_date": wd.isoformat(), "daily_version": version}
        suggestion = next(iter(by_code.get(("delay_notice", r["code"], None), [])), None)
        if suggestion:
            suggestion["alert_id"] = alert_id  # the same dict is stored in daily_evaluations.suggestions
        _revise(conn, pid, alert_id, when, m.ALERT_SEVERITY[r["severity"]], calc, _ref_objects(r["refs"]), suggestion, reason)
    for i in ind["equipment_idle"]:
        if i["severity"] not in ("amber", "red"):
            continue
        alert_id = _upsert_alert(conn, pid, i["activity_code"], checkpoint, "equipment_idle",
                                 f"{i['equipment_id']} idle {i['hours']} h")
        suggestion = next(iter(by_code.get(("additional_cost_notice", i["activity_code"], i["equipment_id"]), [])), None)
        if suggestion:
            suggestion["alert_id"] = alert_id
        _revise(conn, pid, alert_id, when, m.ALERT_SEVERITY[i["severity"]],
                {"equipment_id": i["equipment_id"], "hours": i["hours"], "band": i["severity"], "work_date": wd.isoformat(),
                 "daily_version": version, "rate": i.get("rate")}, _ref_objects(i["refs"]), suggestion, reason)
    missing = ind.get("missing_report")
    if missing and missing["after_sweep"]:
        alert_id = _upsert_alert(conn, pid, None, checkpoint, "missing_report", f"No signed report for {wd:%d %b}")
        _revise(conn, pid, alert_id, when, "high", {"activities": missing["activities"], "work_date": wd.isoformat(),
                                                    "daily_version": version}, _ref_objects(missing["refs"]), None, reason)
    produced = set()
    for r in rows:
        if ALERT_KIND.get(r["status"]) and r["severity"] in ("amber", "red"):
            produced.add((ALERT_KIND[r["status"]], r["code"]))
    produced |= {("equipment_idle", i["activity_code"]) for i in ind["equipment_idle"] if i["severity"] in ("amber", "red")}
    if missing and missing["after_sweep"]:
        produced.add(("missing_report", None))
    produced |= {("quality_hold", q["activity_code"]) for q in ind["quality_holds"] if q["failed"]}
    produced |= {("instruction_concern", s.get("activity_code")) for s in suggestions if s["type"] == "notice_of_concern"}
    for a in conn.execute(text("""SELECT a.id::text AS id, a.kind, a.activity_code FROM sitemate.alerts a
        WHERE a.project_id=:p AND a.checkpoint_at=:cp AND a.kind = ANY(:kinds)"""),
                          {"p": pid, "cp": checkpoint, "kinds": ["shortfall", "late_start", "equipment_idle",
                                                                 "missing_report", "quality_hold",
                                                                 "instruction_concern"]}).mappings().all():
        if (a["kind"], a["activity_code"]) in produced:
            continue
        current = conn.execute(text("""SELECT severity, calculation, evidence_refs FROM sitemate.alert_revisions
            WHERE project_id=:p AND alert_id=CAST(:a AS uuid) AND as_of <= :at ORDER BY as_of DESC, version DESC LIMIT 1"""),
                               {"p": pid, "a": a["id"], "at": when}).mappings().one_or_none()
        if current and current["severity"] != "none":
            _revise(conn, pid, a["id"], when, "none", {**current["calculation"], "cleared": True, "daily_version": version},
                    current["evidence_refs"], None, f"Cleared by daily evaluation v{version}")
    for q in ind["quality_holds"]:
        if q["failed"]:
            alert_id = _upsert_alert(conn, pid, q["activity_code"], checkpoint, "quality_hold", (q["text"] or "")[:120])
            suggestion = next(iter(by_code.get(("defect_notice", q["activity_code"], None), [])), None)
            if suggestion:
                suggestion["alert_id"] = alert_id
            _revise(conn, pid, alert_id, when, "high", {"text": q["text"], "work_date": wd.isoformat(),
                                                        "daily_version": version}, _ref_objects(q["refs"]), suggestion, reason)
    # An instruction or design concern from the day summary (P2) gets its own alert, so a notice of concern can be
    # drafted (and auto-drafted) from an alert like every other suggestion (migration 0013, alert kind instruction_concern).
    for s in suggestions:
        if s["type"] != "notice_of_concern":
            continue
        text_ = s["reason"].removeprefix("Instruction or design concern: ")
        alert_id = _upsert_alert(conn, pid, s.get("activity_code"), checkpoint, "instruction_concern", text_[:120])
        s["alert_id"] = alert_id
        _revise(conn, pid, alert_id, when, "medium", {"text": text_, "work_date": wd.isoformat(), "daily_version": version},
                _ref_objects(s.get("refs") or []), s, reason)


AUTO_DRAFT_TYPES = ("delay_notice", "additional_cost_notice", "defect_notice", "notice_of_concern")


def queue_auto_drafts(conn, bundle, suggestions) -> int:
    """Automatic correspondence (G9): every suggestion that has an alert gets a private draft, written by the worker
    (job auto_draft, one per alert and notice type). Projects can switch it off with settings.auto_draft = false.
    Nothing is sent; the manager edits, then submits the draft for approval."""
    settings = bundle["project"].get("settings") or {}
    if settings.get("auto_draft") is False:
        return 0
    worker, queued = _worker(), 0
    for s in suggestions:
        if s["type"] in AUTO_DRAFT_TYPES and s.get("alert_id"):
            with conn.begin_nested():
                worker.enqueue_job(conn, bundle["project"]["id"], "auto_draft",
                                   {"alert_id": s["alert_id"], "notice_type": s["type"],
                                    "work_date": None, "as_of": bundle["when"].isoformat() if bundle.get("when") else None})
            queued += 1
    return queued


# ------------------------------------------------------------------ jobs

def _worker():
    import sys
    from pathlib import Path
    agent = str(Path(__file__).resolve().parents[2] / "ai-agent")
    if agent not in sys.path:
        sys.path.insert(0, agent)
    from app import worker
    return worker


def queue_day(conn, project_id, work_date, trigger, *, as_of=None, delay_seconds=None, force=False) -> bool:
    """Queue a daily_eval job (debounced). Never raises: a trigger must not fail the write that caused it."""
    try:
        if conn.scalar(text("SELECT to_regclass('sitemate.daily_evaluations')")) is None:
            return False
        worker = _worker()
        with conn.begin_nested():
            worker.enqueue_daily_eval(conn, project_id, work_date, trigger=trigger, as_of=as_of, force=force,
                                      delay_seconds=worker.DAILY_DEBOUNCE_SECONDS if delay_seconds is None else delay_seconds)
        return True
    except Exception:  # noqa: BLE001
        return False


def run_queued_day(engine, project_id, work_date) -> dict | None:
    """Claim the queued job for (project, date) and run it now, in this process (manual recompute)."""
    worker = _worker()
    with engine.connect() as conn:
        job = conn.execute(text("""
            UPDATE sitemate.agent_jobs j SET status='running', attempts=j.attempts+1, updated_at=now()
            WHERE (j.project_id, j.id) = (
                SELECT project_id, id FROM sitemate.agent_jobs WHERE project_id=:p AND kind='daily_eval'
                  AND status='queued' AND payload->>'work_date' = :d FOR UPDATE SKIP LOCKED LIMIT 1)
            RETURNING j.project_id, j.id::text AS id, j.kind, j.incident_id::text AS incident_id, j.attempts, j.payload
        """), {"p": project_id, "d": str(work_date)}).mappings().one_or_none()
        conn.commit()
        if job is None:
            return None
        job = dict(job)
        try:
            result = worker.run_daily_eval(conn, None, job)
            worker.finish(conn, job, None)
            return result
        except Exception as exc:  # noqa: BLE001 - recorded on the job row like the worker does
            conn.rollback()
            worker.finish(conn, job, exc)
            return {"error": str(exc)}


# ------------------------------------------------------------------ views

def daily_view(conn, project_id, work_date: date, *, version: int | None = None, as_of: datetime | None = None) -> dict | None:
    row = conn.execute(text("""
        SELECT * FROM sitemate.daily_evaluations WHERE project_id=:p AND work_date=:d
          AND (CAST(:v AS int) IS NULL OR version = CAST(:v AS int))
          AND as_of <= coalesce(CAST(:cutoff AS timestamptz), 'infinity')
        ORDER BY as_of DESC, version DESC LIMIT 1"""), {"p": project_id, "d": work_date, "v": version, "cutoff": as_of}).mappings().one_or_none()
    if row is None:
        return None
    acts = conn.execute(text("""SELECT * FROM sitemate.daily_activity_results WHERE project_id=:p AND work_date=:d
        AND version=:v"""), {"p": project_id, "d": work_date, "v": row["version"]}).mappings().all()
    names = {r["code"]: r for r in conn.execute(text("SELECT code, name, unit FROM sitemate.activities WHERE project_id=:p"),
                                                {"p": project_id}).mappings()}
    ledger = conn.execute(text("""SELECT id::text AS id, work_date, activity_code, subject, rule_key, kind, points, cause_category,
        excusable, refs, detail, CASE WHEN status = 'superseded' THEN 'proposed' ELSE status END AS status, note
        FROM sitemate.performance_ledger WHERE project_id=:p AND work_date=:d
        AND daily_version <= :v AND (superseded_version IS NULL OR superseded_version > :v)
        ORDER BY kind, points"""), {"p": project_id, "d": work_date, "v": row["version"]}).mappings().all()
    rank = {"red": 0, "amber": 1, "none": 2}
    activities = sorted(({
        "code": a["activity_code"], "name": (names.get(a["activity_code"]) or {}).get("name"),
        "unit": (names.get(a["activity_code"]) or {}).get("unit"), "planned": _num(a["planned"]), "actual": _num(a["actual"]),
        "basis": a["basis"], "variance": _num(a["variance"]), "variance_pct": _num(a["variance_pct"]), "status": a["status"],
        "severity": a["severity"], "escalated": a["escalated"], "days_late": a["days_late"], "estimate": a["estimate"],
        "attribution": a["attribution"], "refs": a["refs"]} for a in acts),
        key=lambda a: (rank[a["severity"]], a["variance_pct"] if a["variance_pct"] is not None else 0, a["code"]))
    suggestions = list(row["suggestions"] or [])
    alerts = {(r["kind"], r["activity_code"]): r["id"] for r in conn.execute(text("""
        SELECT a.id::text AS id, a.kind, a.activity_code FROM sitemate.alerts a
        WHERE a.project_id=:p AND (a.checkpoint_at AT TIME ZONE (SELECT timezone FROM sitemate.projects WHERE id=:p))::date = :d"""),
        {"p": project_id, "d": work_date}).mappings()}
    for s in suggestions:
        kind = {"delay_notice": "shortfall", "additional_cost_notice": "equipment_idle", "defect_notice": "quality_hold",
                "notice_of_concern": "instruction_concern"}.get(s["type"])
        s["alert_id"] = s.get("alert_id") or alerts.get((kind, s.get("activity_code"))) or \
            (alerts.get(("late_start", s.get("activity_code"))) if s["type"] == "delay_notice" else None)
    return {"work_date": work_date.isoformat(), "version": row["version"], "as_of": row["as_of"],
            "baseline_id": str(row["baseline_id"]) if row["baseline_id"] else None, "day_status": row["day_status"],
            "day_severity": row["day_severity"], "day_score": _num(row["day_score"]), "provisional": row["provisional"],
            "status": row["status"], "model": row["model"], "trigger": row["trigger"], "notes": row["notes"],
            "summary": row["summary"], "activities": activities, "indicators": row["indicators"],
            "suggestions": suggestions, "ledger": [dict(e) | {"points": _num(e["points"])} for e in ledger],
            "disclaimer": m.DISCLAIMER}
