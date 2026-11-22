"""Overall evaluation (plan section 7): cumulative progress, S-curve, SPI, forecasts, critical path, milestone
forecast, merit/demerit roll-up, score and the cited narrative (P4), as of date D and instant `as_of`.

All numbers are computed here and in metrics.py. P4 only explains them; its items must cite the ledger, day
summaries, plan or suggestion passages it was given, and may only repeat supplied numbers. Snapshots are versioned in
performance_snapshots: an unchanged input digest reuses the latest version.
"""

from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import text

from . import metrics as m
from .baseline import active_baseline, load_settings
from .daily import _plans, evaluate_day, load_series
from .prompts import P4_LISTS, P4_SCHEMA, P4_SYSTEM, ModelError, Models, number_tokens, validate_items

MAX_BACKFILL_DAYS = 150
DELAY_KEYS = ("day.shortfall_amber", "day.shortfall_red", "activity.late_start")


def _j(value):
    return json.dumps(value, default=lambda o: o.isoformat() if isinstance(o, (date, datetime)) else str(o))


def _now():
    return datetime.now(timezone.utc).replace(microsecond=0)


def ledger_rows(conn, project_id, to: date, when, *, start: date | None = None, kind=None, status=None) -> list[dict]:
    """Ledger entries live at `when` (rows superseded later count as live before that)."""
    from .daily import LEDGER_AT
    rows = conn.execute(text(f"""
        SELECT l.id::text AS id, l.work_date, l.activity_code, l.subject, l.rule_key, l.kind, l.points, l.quantity,
               l.cause_category, l.responsible_party, l.excusable, l.refs, l.detail, l.daily_version, l.as_of,
               CASE WHEN l.status = 'superseded' THEN coalesce(l.detail->>'review_status', 'proposed') ELSE l.status END
                   AS status,
               CASE WHEN l.reviewed_at <= :at THEN l.reviewer_id END AS reviewer_id,
               CASE WHEN l.reviewed_at <= :at THEN l.note END AS note, l.reviewed_at,
               coalesce(pm.display_name, l.reviewer_id) AS reviewer_name
        FROM ({LEDGER_AT}) l
        LEFT JOIN sitemate.project_members pm ON (pm.project_id, pm.member_id) = (l.project_id, l.reviewer_id)
        WHERE l.work_date <= :to AND (CAST(:from AS date) IS NULL OR l.work_date >= CAST(:from AS date))
          AND (CAST(:kind AS text) IS NULL OR l.kind = CAST(:kind AS text))
        ORDER BY l.work_date, l.kind, l.points, l.subject"""),
                        {"p": project_id, "to": to, "from": start, "at": when, "kind": kind}).mappings().all()
    out = []
    for r in rows:
        e = dict(r) | {"points": float(r["points"]), "quantity": float(r["quantity"]) if r["quantity"] is not None else None,
                       "work_date": r["work_date"].isoformat()}
        # A review decided after `when` is not known yet in a replay.
        if r["reviewed_at"] and r["reviewed_at"] > when:
            e["status"] = "proposed"
        if status is None or e["status"] == status:
            out.append(e)
    return out


def ensure_days(conn, project_id, to: date, when, cal, plans) -> int:
    """Code-only evaluations for planned working days up to `to` that have none yet at `when`."""
    starts = [p.planned_start for p in plans if p.planned_start]
    if not starts:
        return 0
    # Days before the first signed report are outside tracking (metrics.carry_in), so they are not evaluated.
    tracking = conn.scalar(text("""SELECT min(o.work_date) FROM sitemate.observations o
        JOIN sitemate.sources s ON (s.project_id, s.id) = (o.project_id, o.source_id)
        WHERE o.project_id = :p AND o.basis = 'signed' AND s.available_at <= :at"""), {"p": project_id, "at": when})
    first = max(min(starts), tracking or min(starts), to - timedelta(days=MAX_BACKFILL_DAYS))
    have = set(conn.execute(text("""SELECT DISTINCT work_date FROM sitemate.daily_evaluations
        WHERE project_id=:p AND work_date BETWEEN :a AND :b AND as_of <= :at"""),
                            {"p": project_id, "a": first, "b": to, "at": when}).scalars().all())
    done = 0
    for d in cal.working_days(first, to):
        if d not in have:
            evaluate_day(conn, project_id, d, when, use_llm=False, trigger="overall_backfill")
            done += 1
    return done


def forecast_core(conn, project_id, to: date, when) -> dict:
    """The forecast steps of compute(): plan, signed actuals, cumulative progress and the forward pass as of `to`
    and instant `when`. Shared with the 3D progress model so both show the same forecast."""
    project = dict(conn.execute(text("SELECT * FROM sitemate.projects WHERE id=:p"), {"p": project_id}).mappings().one())
    baseline = active_baseline(conn, project_id, when)
    baseline_id = baseline["id"] if baseline else None
    settings = load_settings(conn, project_id, baseline_id)
    cal = m.Calendar.from_settings(settings)
    targets, plan_refs, signed, _ = load_series(conn, project_id, when)
    plans = _plans(conn, project_id, baseline_id, targets)
    actuals, tracking_start, assumed = m.carry_in(
        targets, {c: {d: v["quantity"] for d, v in s.items()} for c, s in signed.items()})
    window = int(settings.get("recent_rate_window") or 5)
    # Measure to the end of `to` once its report is in (or its sweep has passed); before that, to the previous
    # working day, so a morning view does not count today's plan as already missed.
    from zoneinfo import ZoneInfo
    sweep = settings["calendar"].get("sweep_time") or "18:00"
    sweep_at = datetime.combine(to, datetime.strptime(sweep, "%H:%M").time(), ZoneInfo(project["timezone"]))
    reported = any(to in series for series in signed.values())
    measured_to = to if (reported or when >= sweep_at or not cal.is_working(to)) else cal.previous_working(to)
    cum = {p.code: m.cumulative(p, targets.get(p.code, {}), actuals.get(p.code, {}), measured_to, cal, window)
           for p in plans}
    fp = m.forward_pass(plans, cum, measured_to, cal)
    return {"project": project, "baseline": baseline, "baseline_id": baseline_id, "settings": settings, "cal": cal,
            "targets": targets, "plan_refs": plan_refs, "signed": signed, "plans": plans, "actuals": actuals,
            "tracking_start": tracking_start, "assumed": assumed, "measured_to": measured_to, "cum": cum, "fp": fp}


def compute(conn, project_id, to: date, when) -> dict:
    core = forecast_core(conn, project_id, to, when)
    project, baseline, baseline_id, settings, cal = (core[k] for k in ("project", "baseline", "baseline_id", "settings", "cal"))
    targets, plan_refs, plans, actuals = core["targets"], core["plan_refs"], core["plans"], core["actuals"]
    tracking_start, assumed, measured_to, cum, fp = (core[k] for k in ("tracking_start", "assumed", "measured_to", "cum", "fp"))
    names = {r["code"]: dict(r) for r in conn.execute(text("SELECT code, name, unit FROM sitemate.activities WHERE project_id=:p"),
                                                      {"p": project_id}).mappings()}
    planned_float = m.planned_critical(plans, cal)
    planned_pct, actual_pct = m.weighted_progress(plans, targets, actuals, measured_to)
    spi = m.spi(planned_pct, actual_pct)
    th = settings["thresholds"]
    spi_band = m.band(spi, float(th["spi"]["green"]), float(th["spi"]["amber"]))
    points_behind = m.r2((planned_pct or 0) - (actual_pct or 0))
    cum_band = ("red" if points_behind > float(th["cumulative_points"]["red"]) else
                "amber" if points_behind > float(th["cumulative_points"]["amber"]) else "green")
    planned_completion = max((p.planned_finish for p in plans if p.planned_finish), default=None)
    completion = fp["completion"]
    completion_variance = cal.between(planned_completion, completion) if planned_completion and completion else None
    weights, weight_basis = m.normalized_weights(plans) if plans else ({}, None)

    milestones = []
    if baseline_id:
        milestones = [dict(r) | {"refs": [f"{r['source_id']}:{r['locator']}"] if r["source_id"] else []}
                      for r in conn.execute(text("""SELECT code, name, planned_date, contractual, achieved_date,
            activity_codes, source_id, locator FROM sitemate.milestones WHERE project_id=:p AND baseline_id=CAST(:b AS uuid)
            ORDER BY planned_date NULLS LAST, code"""), {"p": project_id, "b": baseline_id}).mappings()]
    ms = m.milestone_forecast(milestones, fp["finish"], cal, to)
    contractual = (settings.get("contract_completion") or {}).get("date") or max(
        (x["planned_date"] for x in ms if x["contractual"] and x["planned_date"]), default=None)
    ld = None
    if contractual and completion:
        days_late = (completion - date.fromisoformat(contractual)).days
        ld = m.ld_exposure(days_late, (settings.get("rates") or {}).get("liquidated_damages"))

    entries = ledger_rows(conn, project_id, to, when)
    best, worst = m.best_worst_days(entries)
    demerits_by_code = defaultdict(list)
    for e in entries:
        if e["rule_key"] in DELAY_KEYS and e["activity_code"]:
            demerits_by_code[e["activity_code"]].append(e)
    acts = []
    for p in plans:
        c = cum[p.code]
        split = m.attribution_split(c["days_behind"], demerits_by_code.get(p.code, []))
        acts.append({**c, "name": (names.get(p.code) or {}).get("name") or p.name, "unit": (names.get(p.code) or {}).get("unit"),
                     "planned_start": p.planned_start.isoformat() if p.planned_start else None,
                     "planned_finish": p.planned_finish.isoformat() if p.planned_finish else None,
                     "weight": m.r2(weights.get(p.code)), "is_critical": bool(p.is_critical),
                     "forecast_start": fp["start"].get(p.code).isoformat() if fp["start"].get(p.code) else None,
                     "forecast_finish_cpm": fp["finish"].get(p.code).isoformat() if fp["finish"].get(p.code) else None,
                     "planned_float": planned_float.get(p.code), "forecast_float": fp["float"].get(p.code),
                     "float_consumed": (planned_float.get(p.code) - fp["float"].get(p.code))
                     if planned_float.get(p.code) is not None and fp["float"].get(p.code) is not None else None,
                     "forecast_critical": fp["float"].get(p.code) is not None and fp["float"][p.code] <= 0,
                     "cpm_flags": fp["flags"].get(p.code, []), "attribution_split": split,
                     "assumed_days_before_tracking": assumed.get(p.code, 0),
                     "plan_ref": plan_refs.get(p.code)})
    acts.sort(key=lambda a: (-(a["days_behind"] or 0), a["code"]))
    excusable_days = m.r2(sum(a["attribution_split"]["excusable_days"] for a in acts))
    non_excusable_days = m.r2(sum(a["attribution_split"]["non_excusable_days"] for a in acts))
    rec_start = cal.add_working_days(to, 0)
    for _ in range(int(settings.get("recovery_window") or 5)):
        rec_start = cal.previous_working(rec_start)
    series = {}
    for p in plans:
        t, a = targets.get(p.code, {}), actuals.get(p.code, {})
        days = sorted(d for d in t if d <= to)
        run_p = run_a = 0.0
        pts = []
        for d in days:
            run_p += t.get(d, 0)
            run_a += a.get(d, 0) or 0
            pts.append((d, run_p - run_a))
        series[p.code] = pts
    recovery = m.recovery(series, {p.code: p.target_per_day for p in plans}, rec_start)
    claim_exposure = [e for e in entries if e["excusable"] and e["kind"] == "demerit"]
    critical_path = [a["code"] for a in sorted(acts, key=lambda a: a["forecast_start"] or "") if a["forecast_critical"]]
    status = m.overall_status(spi_band, completion_variance, settings)
    dates = []
    first = min((p.planned_start for p in plans if p.planned_start), default=None)
    last = max([d for d in (planned_completion, completion) if d], default=None)
    if first and last:
        step = 1 if (last - first).days <= 400 else 7
        d = first
        while d <= last:
            dates.append(d)
            d += timedelta(days=step)
        if to not in dates and first <= to <= last:
            dates.append(to)
        dates.sort()
    curve = m.s_curve(plans, targets, actuals, dates, measured_to)
    metrics = {
        "as_of_date": to.isoformat(), "baseline_id": baseline_id, "baseline_revision": baseline["revision"] if baseline else None,
        "tracking_start": tracking_start.isoformat() if tracking_start else None,
        "measured_to": measured_to.isoformat(),
        "assumed_before_tracking": assumed,
        "weighted_planned_pct": planned_pct, "weighted_actual_pct": actual_pct, "weight_basis": weight_basis,
        "points_behind": points_behind, "cumulative_band": cum_band, "spi": spi, "spi_band": spi_band,
        "planned_completion": planned_completion.isoformat() if planned_completion else None,
        "forecast_completion": completion.isoformat() if completion else None,
        "completion_variance_days": completion_variance, "overall_status": status,
        "critical_path": critical_path, "milestones": ms, "ld_exposure": ld,
        "contract_completion": contractual, "activities": acts, "recovery": recovery,
        "attribution": {"excusable_days": excusable_days, "non_excusable_days": non_excusable_days,
                        "label": "for review, not legal advice"},
        "score": m.score(entries), "weekly": m.weekly(entries), "best_days": best, "worst_days": worst,
        "ledger_counts": {k: sum(1 for e in entries if e["status"] == k) for k in ("proposed", "accepted", "disputed")},
        "claim_exposure": [{k: e[k] for k in ("id", "work_date", "activity_code", "rule_key", "points", "cause_category",
                                              "refs")} for e in claim_exposure],
        "zero_rate_activities": [a["code"] for a in acts if "zero_rate" in a["flags"] and not a["complete"]
                                 and a["planned_start"] and a["planned_start"] <= to.isoformat()],
    }
    return {"project": project, "settings": settings, "metrics": metrics, "s_curve": curve, "entries": entries,
            "baseline_id": baseline_id, "cal": cal, "plans": plans}


def open_suggestions(conn, project_id, to: date, when) -> list[dict]:
    rows = conn.execute(text("""
        SELECT DISTINCT ON (work_date) work_date, suggestions FROM sitemate.daily_evaluations
        WHERE project_id=:p AND work_date <= :to AND as_of <= :at ORDER BY work_date, version DESC"""),
                        {"p": project_id, "to": to, "at": when}).mappings().all()
    drafted = {(str(r["alert_id"]), r["notice_type"]) for r in conn.execute(text(
        "SELECT alert_id, notice_type FROM sitemate.drafts WHERE project_id=:p AND alert_id IS NOT NULL"),
        {"p": project_id}).mappings()}
    out = []
    for r in rows:
        for s in r["suggestions"] or []:
            if s.get("deadline") and s["deadline"] >= to.isoformat() and (str(s.get("alert_id")), s["type"]) not in drafted:
                out.append({**s, "work_date": r["work_date"].isoformat()})
    return out


def _day_summaries(conn, project_id, days, when):
    out = []
    for d in days:
        row = conn.execute(text("""SELECT work_date, summary FROM sitemate.daily_evaluations WHERE project_id=:p
            AND work_date=:d AND as_of <= :at ORDER BY version DESC LIMIT 1"""),
                           {"p": project_id, "d": d["work_date"], "at": when}).mappings().one_or_none()
        if row:
            s = row["summary"] or {}
            out.append({"work_date": d["work_date"], "points": d["points"], "headline": s.get("headline"),
                        "disruptions": (s.get("disruptions") or [])[:4], "work_done": (s.get("work_done") or [])[:4]})
    return out


def code_narrative(metrics, entries, suggestions) -> dict:
    """Deterministic narrative used when the model is unavailable (every line cites the ledger)."""
    merits = sorted((e for e in entries if e["kind"] == "merit" and e["status"] != "disputed"),
                    key=lambda e: -e["points"])[:5]
    demerits = sorted((e for e in entries if e["kind"] == "demerit" and e["status"] != "disputed"),
                      key=lambda e: e["points"])[:5]

    def line(e):
        return {"text": f"{e['work_date']}: {e['subject']} {e['rule_key']} ({e['points']:+g})", "refs": e["refs"][:3]}
    return {"status_explanation": {"text": f"SPI {metrics['spi']} ({metrics['spi_band']}); forecast completion "
                                           f"{metrics['forecast_completion']} ({metrics['completion_variance_days']:+d} working days)."
                                   if metrics["spi"] is not None and metrics["completion_variance_days"] is not None
                                   else "Not enough signed data to compute SPI yet.", "refs": []},
            "trend": None, "merits": [line(e) for e in merits], "demerits": [line(e) for e in demerits], "risks": [],
            "recommended_actions": [],
            "correspondence_to_consider": [{"text": f"{s['type'].replace('_', ' ')} for {s.get('activity_code') or s.get('equipment_id')} "
                                                    f"by {s['deadline']}: {s['reason']}", "refs": s.get("refs", [])[:3],
                                            "suggestion": i} for i, s in enumerate(suggestions)],
            "source": "code"}


def narrate(conn, project_id, computed, suggestions, when, models: Models) -> tuple[dict, str | None, list[str]]:
    metrics, entries = computed["metrics"], computed["entries"]
    days = _day_summaries(conn, project_id, metrics["best_days"] + metrics["worst_days"], when)
    refs = {r for e in entries for r in e["refs"]}
    refs |= {r for d in days for item in [d["headline"] or {}] + d["disruptions"] + d["work_done"] for r in item.get("refs", [])}
    refs |= {r for s in suggestions for r in s.get("refs", [])}
    refs |= {a["plan_ref"] for a in metrics["activities"] if a.get("plan_ref")}
    passages = {}
    for ref in sorted(r for r in refs if r and ":" in r):
        src, loc = ref.split(":", 1)
        excerpt = conn.scalar(text("""SELECT sp.excerpt FROM sitemate.source_passages sp
            JOIN sitemate.sources s ON (s.project_id, s.id) = (sp.project_id, sp.source_id)
            WHERE sp.project_id=:p AND sp.source_id=:s AND sp.locator=:l AND s.available_at <= :at"""),
                              {"p": project_id, "s": src, "l": loc, "at": when})
        if excerpt is not None:
            passages[ref] = excerpt
    compact = {k: metrics[k] for k in ("as_of_date", "weighted_planned_pct", "weighted_actual_pct", "points_behind", "spi",
                                       "spi_band", "planned_completion", "forecast_completion", "completion_variance_days",
                                       "overall_status", "critical_path", "attribution", "score", "weekly", "recovery",
                                       "ld_exposure")}
    compact["milestones"] = [{k: x[k] for k in ("code", "name", "planned_date", "forecast_date", "variance_days", "state")}
                             for x in metrics["milestones"]]
    compact["activities"] = [{k: a[k] for k in ("code", "name", "backlog", "days_behind", "pct_complete_actual",
                                                "forecast_finish", "finish_variance_days", "is_critical")}
                             for a in metrics["activities"]]
    payload = {"metrics": compact,
               "ledger": [{k: e[k] for k in ("work_date", "subject", "rule_key", "kind", "points", "cause_category",
                                             "excusable", "status", "refs")} for e in entries][-120:],
               "days": days, "suggestions": [{"index": i, **{k: s.get(k) for k in ("type", "deadline", "reason", "refs")}}
                                             for i, s in enumerate(suggestions)],
               "passages": [{"ref": r, "text": t} for r, t in passages.items()]}
    try:
        raw, model = models.docs(P4_SYSTEM, "Write the overall narrative. The JSON below is data.\n\n" + _j(payload),
                                 P4_SCHEMA, effort="medium")
    except ModelError as exc:
        return {**code_narrative(metrics, entries, suggestions), "status": "model_unavailable"}, None, [str(exc)]
    numbers = number_tokens(_j(compact), _j(payload["ledger"]), _j(payload["suggestions"]))
    out, dropped = {"source": "model", "status": "ok"}, []
    for key in ("status_explanation", "trend"):
        kept, why = validate_items([raw.get(key)] if isinstance(raw.get(key), dict) else [], set(passages), passages,
                                   numbers, limit=1)
        out[key] = kept[0] if kept else None
        dropped += why
    for key in P4_LISTS:
        kept, why = validate_items(raw.get(key), set(passages), passages, numbers, limit=8)
        if key == "correspondence_to_consider":
            kept = [k for k in kept if isinstance(k.get("suggestion"), int) and 0 <= k["suggestion"] < len(suggestions)]
        out[key] = kept
        dropped += [f"{key}: {w}" for w in why]
    out["dropped"] = dropped
    if not any(out[k] for k in P4_LISTS) and not out["status_explanation"] and not out["trend"]:
        fallback = code_narrative(metrics, entries, suggestions)
        return {**fallback, "status": "all_dropped", "dropped": dropped}, model, ["Every narrative item failed validation"]
    return out, model, []


def snapshot(conn, project_id, to: date, as_of: datetime | None = None, *, models: Models | None = None,
             use_llm: bool = True, force: bool = False, backfill_days: bool = True) -> dict:
    """Compute (and persist when changed) the snapshot for date `to`. The caller commits."""
    when = (as_of or _now()).astimezone(timezone.utc)
    if backfill_days:
        baseline = active_baseline(conn, project_id, when)
        settings = load_settings(conn, project_id, baseline["id"] if baseline else None)
        targets = load_series(conn, project_id, when)[0]
        ensure_days(conn, project_id, to, when, m.Calendar.from_settings(settings),
                    _plans(conn, project_id, baseline["id"] if baseline else None, targets))
    computed = compute(conn, project_id, to, when)
    suggestions = open_suggestions(conn, project_id, to, when)
    computed["metrics"]["open_suggestions"] = suggestions
    digest = hashlib.sha256(_j({"metrics": computed["metrics"],
                                "ledger": [(e["id"], e["status"], e["note"]) for e in computed["entries"]]}).encode()).hexdigest()
    latest = conn.execute(text("""SELECT version, input_digest, narrative->>'status' AS narrative_status
        FROM sitemate.performance_snapshots
        WHERE project_id=:p AND as_of_date=:d AND as_of <= :at ORDER BY as_of DESC, version DESC LIMIT 1"""),
                          {"p": project_id, "d": to, "at": when}).mappings().one_or_none()
    top = conn.scalar(text("SELECT coalesce(max(version), 0) FROM sitemate.performance_snapshots WHERE project_id=:p "
                           "AND as_of_date=:d"), {"p": project_id, "d": to})
    # Same numbers: keep the latest version, unless a model narrative is asked for and the latest has none.
    if latest and latest["input_digest"] == digest and not force and \
            not (use_llm and latest["narrative_status"] == "not_requested"):
        return {"reused": True, "version": latest["version"]}
    models = models or Models()
    if use_llm:
        narrative, model, notes = narrate(conn, project_id, computed, suggestions, when, models)
    else:
        narrative, model, notes = ({**code_narrative(computed["metrics"], computed["entries"], suggestions),
                                    "status": "not_requested"}, None, [])
    narrative.update(overall_status=computed["metrics"]["overall_status"], disclaimer=m.DISCLAIMER, notes=notes)
    status = "needs_review" if narrative.get("status") in ("all_dropped", "model_unavailable") and use_llm else "ok"
    version = top + 1
    conn.execute(text("""
        INSERT INTO sitemate.performance_snapshots (project_id, as_of_date, version, as_of, baseline_id, input_digest,
            metrics, s_curve, narrative, score, model, status)
        VALUES (:p, :d, :v, :at, CAST(:b AS uuid), :dg, CAST(:m AS jsonb), CAST(:s AS jsonb), CAST(:n AS jsonb), :score,
                :model, :status)"""),
                 {"p": project_id, "d": to, "v": version, "at": when, "b": computed["baseline_id"], "dg": digest,
                  "m": _j(computed["metrics"]), "s": _j(computed["s_curve"]), "n": _j(narrative),
                  "score": computed["metrics"]["score"], "model": model, "status": status})
    return {"reused": False, "version": version}


def snapshot_view(conn, project_id, to: date, as_of: datetime | None = None, version: int | None = None) -> dict | None:
    row = conn.execute(text("""SELECT * FROM sitemate.performance_snapshots WHERE project_id=:p AND as_of_date=:d
        AND (CAST(:v AS int) IS NULL OR version = CAST(:v AS int))
        AND as_of <= coalesce(CAST(:cutoff AS timestamptz), 'infinity') ORDER BY as_of DESC, version DESC LIMIT 1"""),
                       {"p": project_id, "d": to, "v": version, "cutoff": as_of}).mappings().one_or_none()
    if row is None:
        return None
    return {"as_of_date": to.isoformat(), "version": row["version"], "as_of": row["as_of"],
            "baseline_id": str(row["baseline_id"]) if row["baseline_id"] else None, "status": row["status"],
            "model": row["model"], "score": float(row["score"]), "metrics": row["metrics"], "s_curve": row["s_curve"],
            "narrative": row["narrative"], "disclaimer": m.DISCLAIMER}
