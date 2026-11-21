"""Group confirmed events into incidents: "5 people say the lift is broken" becomes ONE incident with five sources.

Pure scoring/decision functions are separate from the SQL so they can be unit-tested. The SQL part runs inside the
caller's transaction, after taking advisory locks, so simultaneous reports about the same asset are serialised."""

from __future__ import annotations

import json
import os
import random
import string
from datetime import datetime, timezone

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from .assets import cluster_key, norm_zone, text_similarity
from .severity import apply_llm_adjustment, rule_severity
from .taxonomy import severity_rank

# Weights sum to 1. autoLink: link without asking the LLM. adjudicate: ask it. Below that: a new incident.
CONFIG = {
    "weights": {"asset": 0.45, "type": 0.15, "zone": 0.15, "activity": 0.10, "time": 0.10, "text": 0.05},
    "auto_link": 0.80, "adjudicate": 0.45, "text_min": 0.3, "max_candidates": 5, "recurrence_hours": 72,
    "reasoning_delay_seconds": int(os.environ.get("AGENT_REASONING_DELAY_SECONDS", "60")),
    "escalate_after_hours": int(os.environ.get("AGENT_ESCALATE_AFTER_HOURS", "24")),
}
# Categories whose incidents may describe the same real-world problem ("lift down" can be utilities or equipment).
COMPATIBLE = {"utilities": ["equipment"], "equipment": ["utilities"]}
RESOLVING = {"repair_release", "issue_resolved"}
OPEN = "i.status IN ('open','monitoring') AND i.merged_into_id IS NULL"


def link_type_for(event_type: str) -> str:
    return "resolution" if event_type in RESOLVING else "update"


def is_status_update(category: str) -> bool:
    return category == "status_update"


def _dt(value):
    return value if isinstance(value, datetime) else datetime.fromisoformat(str(value))


def _hours_between(a, b) -> float:
    return abs((_dt(a) - _dt(b)).total_seconds()) / 3600


def score_candidate(event: dict, incident: dict, window_hours: float, cfg=CONFIG) -> dict:
    """Weighted similarity between a new event and an open incident (all signals 0..1)."""
    def same(a, b):
        return 1 if a and b and a == b else 0

    signals = {
        "asset": same(event.get("asset_key"), incident.get("asset_key")),
        "type": same(event.get("event_type"), incident.get("event_type")),
        "zone": same(norm_zone(event.get("zone")), norm_zone(incident.get("zone"))),
        "activity": same(event.get("activity_code"), incident.get("activity_code")),
        "time": max(0.0, 1 - _hours_between(event["occurred_at"], incident["last_reported_at"]) / window_hours) if window_hours > 0 else 0,
        "text": text_similarity(event.get("summary"), incident.get("summary")),
    }
    score = sum(w * signals[k] for k, w in cfg["weights"].items())
    return {"score": round(score, 3), "signals": signals}


def rank_candidates(event: dict, incidents: list[dict], window_hours: float, cfg=CONFIG) -> list[dict]:
    """Candidates must share an asset, zone or activity, or read alike; best five by score."""
    ranked = []
    for incident in incidents:
        s = score_candidate(event, incident, window_hours, cfg)
        cluster_match = bool(event.get("cluster_key") and (incident.get("cluster_key") or "").split("#")[0] == event["cluster_key"])
        ranked.append({"incident": incident, **s, "cluster_match": cluster_match})
    sig = lambda c: c["signals"]  # noqa: E731
    ranked = [c for c in ranked if sig(c)["asset"] or sig(c)["zone"] or sig(c)["activity"] or sig(c)["text"] >= cfg["text_min"]]
    return sorted(ranked, key=lambda c: -c["score"])[: cfg["max_candidates"]]


def decide(ranked: list[dict], cfg=CONFIG) -> dict:
    """auto-link when clearly the same problem, adjudicate when plausible, otherwise a new incident."""
    if not ranked:
        return {"action": "new"}
    top = ranked[0]
    if top["score"] >= cfg["auto_link"] and (top["signals"]["asset"] or top["cluster_match"]):
        return {"action": "link", "candidate": top, "reason": f"auto-linked (score {top['score']})"}
    viable = [c for c in ranked if c["score"] >= cfg["adjudicate"]]
    return {"action": "adjudicate", "candidates": viable} if viable else {"action": "new"}


def lock_key_for(event: dict) -> str:
    """Which advisory-lock key serialises concurrent reports about this event."""
    return event.get("asset_key") or event.get("cluster_key") or norm_zone(event.get("zone")) or "site"


# ------------------------------------------------------------------------ SQL ------------------------------------

def _rows(conn, sql, params):
    return [dict(r) for r in conn.execute(text(sql), params).mappings()]


def _fetch_candidates(conn, project_id, event, categories, window_hours):
    return _rows(conn, f"""
        SELECT i.id::text AS id, i.category, i.event_type, i.summary, i.zone, i.asset_key, i.activity_code, i.cluster_key,
               i.status, i.severity, i.last_reported_at, i.report_count
        FROM sitemate.incidents i
        WHERE i.project_id=:p AND {OPEN} AND (CAST(:cats AS text[]) IS NULL OR i.category = ANY(CAST(:cats AS text[])))
          AND i.last_reported_at >= CAST(:at AS timestamptz) - make_interval(hours => CAST(:h AS int))
        ORDER BY i.last_reported_at DESC LIMIT 50""",
                 {"p": project_id, "cats": categories, "at": _dt(event["occurred_at"]), "h": int(window_hours)})


def _recent_events(conn, project_id, incident_ids):
    out: dict[str, dict] = {}
    for r in _rows(conn, """
            SELECT ie.incident_id::text AS incident_id, ie.link_type, ie.unlinked_at, e.summary, e.recorded_at
            FROM sitemate.incident_events ie JOIN sitemate.events e ON (e.project_id, e.id) = (ie.project_id, ie.event_id)
            WHERE ie.project_id=:p AND ie.incident_id = ANY(CAST(:ids AS uuid[])) ORDER BY e.recorded_at DESC""",
                   {"p": project_id, "ids": incident_ids}):
        entry = out.setdefault(r["incident_id"], {"linked": [], "unlinked": []})
        entry["unlinked" if r["unlinked_at"] else "linked"].append(
            {"summary": r["summary"], "link_type": r["link_type"], "at": r["recorded_at"]})
    return out


def _linked_stats(conn, project_id, incident_id):
    return _rows(conn, """
        SELECT count(*) FILTER (WHERE ie.link_type IN ('origin','corroborating'))::int AS reports,
               count(DISTINCT e.recorded_by) FILTER (WHERE ie.link_type IN ('origin','corroborating'))::int AS reporters,
               max(e.injured_count) AS injured, max(e.workers_affected) AS workers,
               coalesce(array_agg(DISTINCT f) FILTER (WHERE f IS NOT NULL), '{}') AS flags
        FROM sitemate.incident_events ie
        JOIN sitemate.events e ON (e.project_id, e.id) = (ie.project_id, ie.event_id)
        LEFT JOIN LATERAL jsonb_array_elements_text(e.attributes->'severity_flags') f ON true
        WHERE ie.project_id=:p AND ie.incident_id=CAST(:i AS uuid) AND ie.unlinked_at IS NULL""",
                 {"p": project_id, "i": incident_id})[0]


def recompute_severity(conn, project_id, incident_id, taxonomy, *, trigger_event_id=None, adjuster=None,
                       escalate_after_hours=CONFIG["escalate_after_hours"]) -> dict:
    """Recompute severity; writes incident_severity_history (and updates the incident) when the level changes."""
    incident = _rows(conn, "SELECT * FROM sitemate.incidents WHERE project_id=:p AND id=CAST(:i AS uuid)",
                     {"p": project_id, "i": incident_id})[0]
    incident["id"] = str(incident["id"])
    stats = _linked_stats(conn, project_id, incident_id)
    successors = conn.scalar(text("""
        SELECT count(*)::int FROM sitemate.activity_dependencies d
        JOIN sitemate.plan_targets t ON (t.project_id, t.activity_code) = (d.project_id, d.successor)
        WHERE d.project_id=:p AND d.predecessor=:a AND t.work_date BETWEEN current_date AND current_date + 2"""),
                              {"p": project_id, "a": incident["activity_code"]})
    type_hint = (taxonomy.type(incident["event_type"]) or {}).get("severity_hint")
    base = type_hint or (taxonomy.category(incident["category"]) or {}).get("default_severity")
    opened = incident["first_reported_at"] or incident["occurred_at"]
    rule = rule_severity(
        base=base, category=incident["category"], injured_count=int(stats["injured"] or 0), flags=stats["flags"],
        reporter_count=stats["reporters"], successors_at_risk=successors, workers_affected=int(stats["workers"] or 0),
        open_hours=_hours_between(datetime.now(timezone.utc), opened), escalate_after_hours=escalate_after_hours)
    verdict = {"adjustment": 0, "reason": None}
    if adjuster is not None:
        try:
            verdict = adjuster(incident, rule, {k: (list(v) if k == "flags" else v) for k, v in stats.items()}) or verdict
        except Exception:  # noqa: BLE001 - the rules stand on their own
            pass
    final = apply_llm_adjustment(rule, verdict["adjustment"])
    changed = final["level"] != incident["severity"]
    version = incident["severity_version"] + 1
    if changed or incident["severity_version"] == 0:
        reason = verdict["reason"] or "; ".join(rule["hard"] + rule["escalators"]) or None
        conn.execute(text("""
            INSERT INTO sitemate.incident_severity_history
              (project_id, incident_id, version, severity, rule_basis, llm_adjustment, reason, trigger_event_id)
            VALUES (:p, CAST(:i AS uuid), :v, :s, CAST(:b AS jsonb), :adj, :r, CAST(:t AS uuid))"""),
                     {"p": project_id, "i": incident_id, "v": version, "s": final["level"], "b": json.dumps(rule),
                      "adj": final["adjustment"], "r": reason, "t": trigger_event_id})
        conn.execute(text("UPDATE sitemate.incidents SET severity=:s, severity_version=:v WHERE project_id=:p AND id=CAST(:i AS uuid)"),
                     {"p": project_id, "i": incident_id, "s": final["level"], "v": version})
    return {"severity": final["level"], "previous": incident["severity"], "changed": changed, "rule": rule}


def sync_alert(conn, project_id, incident_id, severity, previous_severity, reason, new_report) -> dict:
    """One alert per incident; every source or severity change adds a revision. Escalation re-opens attention."""
    incident = _rows(conn, "SELECT * FROM sitemate.incidents WHERE project_id=:p AND id=CAST(:i AS uuid)",
                     {"p": project_id, "i": incident_id})[0]
    alert = conn.execute(text("""SELECT id::text AS id, status FROM sitemate.alerts
                                 WHERE project_id=:p AND incident_id=CAST(:i AS uuid) AND kind='incident'"""),
                         {"p": project_id, "i": incident_id}).mappings().one_or_none()
    if alert is None:
        alert = conn.execute(text("""
            INSERT INTO sitemate.alerts (project_id, activity_code, checkpoint_at, kind, status, incident_id, title)
            VALUES (:p, :a, :c, 'incident', 'open', CAST(:i AS uuid), :t) RETURNING id::text AS id, status"""),
                             {"p": project_id, "a": incident["activity_code"], "i": incident_id,
                              "c": incident["first_reported_at"] or incident["occurred_at"],
                              "t": incident["summary"] or incident["title"]}).mappings().one()
    refs = _rows(conn, """
        SELECT DISTINCT e.source_id, e.locator FROM sitemate.incident_events ie
        JOIN sitemate.events e ON (e.project_id, e.id) = (ie.project_id, ie.event_id)
        WHERE ie.project_id=:p AND ie.incident_id=CAST(:i AS uuid) AND ie.unlinked_at IS NULL""", {"p": project_id, "i": incident_id})
    version = conn.scalar(text("SELECT coalesce(max(version),0)+1 FROM sitemate.alert_revisions WHERE project_id=:p AND alert_id=CAST(:a AS uuid)"),
                          {"p": project_id, "a": alert["id"]})
    conn.execute(text("""
        INSERT INTO sitemate.alert_revisions (project_id, alert_id, version, as_of, severity, calculation, evidence_refs, reason)
        VALUES (:p, CAST(:a AS uuid), :v, now(), :s, CAST(:c AS jsonb), CAST(:r AS jsonb), :reason)"""),
                 {"p": project_id, "a": alert["id"], "v": version, "s": severity, "reason": reason,
                  "c": json.dumps({"kind": "incident", "report_count": incident["report_count"],
                                   "reporter_count": incident["reporter_count"], "category": incident["category"],
                                   "status": incident["status"]}),
                  "r": json.dumps([{"source_id": r["source_id"], "locator": r["locator"],
                                    "passage_id": f"{r['source_id']}:{r['locator']}"} for r in refs])})
    escalated = bool(previous_severity) and severity_rank(severity) > severity_rank(previous_severity)
    reopen = (escalated and alert["status"] in ("acknowledged", "in_progress")) or (
        new_report and alert["status"] in ("resolved", "dismissed") and incident["status"] in ("open", "monitoring"))
    if reopen:
        conn.execute(text("UPDATE sitemate.alerts SET status='open' WHERE project_id=:p AND id=CAST(:a AS uuid)"),
                     {"p": project_id, "a": alert["id"]})
        conn.execute(text("""
            INSERT INTO sitemate.alert_activity (project_id, alert_id, actor, action, from_status, to_status, note)
            VALUES (:p, CAST(:a AS uuid), 'agent', :act, :f, 'open', :n)"""),
                     {"p": project_id, "a": alert["id"], "act": "escalated" if escalated else "reopen", "f": alert["status"],
                      "n": f"Severity {previous_severity} -> {severity}" if escalated else "New report on an open incident"})
    return {"alert_id": alert["id"], "revision": version}


def enqueue_job(conn, project_id, kind, incident_id, delay_seconds=CONFIG["reasoning_delay_seconds"]) -> None:
    """Debounced: one queued job per incident; a newer source pushes run_after out."""
    conn.execute(text("""
        INSERT INTO sitemate.agent_jobs (project_id, kind, incident_id, run_after)
        VALUES (:p, :k, CAST(:i AS uuid), now() + make_interval(secs => CAST(:d AS int)))
        ON CONFLICT (project_id, kind, incident_id) WHERE status='queued'
        DO UPDATE SET run_after = EXCLUDED.run_after, updated_at = now()"""),
                 {"p": project_id, "k": kind, "i": incident_id, "d": delay_seconds})


def _refresh_counts(conn, project_id, incident_id, recorded_at, status):
    stats = _linked_stats(conn, project_id, incident_id)
    conn.execute(text("""
        UPDATE sitemate.incidents SET report_count=GREATEST(:rc,1), reporter_count=GREATEST(:pc,1),
            last_reported_at=GREATEST(last_reported_at, CAST(:at AS timestamptz)), status=coalesce(CAST(:st AS text), status),
            resolved_at=CASE WHEN coalesce(CAST(:st AS text), status) IN ('open','monitoring') THEN NULL ELSE resolved_at END
        WHERE project_id=:p AND id=CAST(:i AS uuid)"""),
                 {"p": project_id, "i": incident_id, "rc": stats["reports"], "pc": stats["reporters"],
                  "at": _dt(recorded_at), "st": status})
    return stats


def _attach(conn, project_id, event, incident_id, link_type, score, reason):
    conn.execute(text("""
        INSERT INTO sitemate.incident_events (project_id, incident_id, event_id, link_type, match_score, match_reason, linked_by)
        VALUES (:p, CAST(:i AS uuid), CAST(:e AS uuid), :lt, :s, :r, 'agent') ON CONFLICT DO NOTHING"""),
                 {"p": project_id, "i": incident_id, "e": event["id"], "lt": link_type, "s": score, "r": reason})
    conn.execute(text("UPDATE sitemate.events SET incident_id=CAST(:i AS uuid) WHERE project_id=:p AND id=CAST(:e AS uuid)"),
                 {"p": project_id, "i": incident_id, "e": event["id"]})


def _link_existing(conn, ctx, event, candidate, link_type, score, reason):
    project_id, incident = ctx["project_id"], candidate["incident"]
    _attach(conn, project_id, event, incident["id"], link_type, score, reason)
    status = "monitoring" if link_type == "resolution" else (
        "open" if link_type == "corroborating" and incident["status"] == "monitoring" else None)
    stats = _refresh_counts(conn, project_id, incident["id"], event["recorded_at"], status)
    sev = recompute_severity(conn, project_id, incident["id"], ctx["taxonomy"], trigger_event_id=event["id"],
                             adjuster=ctx.get("adjust_severity"))
    alert = sync_alert(conn, project_id, incident["id"], sev["severity"], sev["previous"],
                       f"{link_type}: {event['summary']}", link_type == "corroborating")
    if link_type != "resolution":
        enqueue_job(conn, project_id, "reasoning", incident["id"])
    return {"incident_id": incident["id"], "link_type": link_type, "created": False, "severity": sev["severity"],
            "severity_changed": sev["changed"], "report_count": stats["reports"], "reporter_count": stats["reporters"],
            "title": incident["summary"], "alert_id": alert["alert_id"]}


def _create_incident(conn, ctx, event, key):
    project_id = ctx["project_id"]
    taken = conn.scalar(text(f"SELECT 1 FROM sitemate.incidents i WHERE i.project_id=:p AND i.cluster_key=:k AND {OPEN}"),
                        {"p": project_id, "k": key})
    recurrence = conn.scalar(text("""
        SELECT id::text FROM sitemate.incidents WHERE project_id=:p AND starts_with(cluster_key, :k)
          AND status IN ('resolved','closed') AND resolved_at >= CAST(:at AS timestamptz) - make_interval(hours => CAST(:h AS int))
        ORDER BY resolved_at DESC LIMIT 1"""),
                             {"p": project_id, "k": key, "at": _dt(event["occurred_at"]), "h": CONFIG["recurrence_hours"]})
    stored_key = f"{key}#{''.join(random.choices(string.ascii_lowercase + string.digits, k=8))}" if taken else key
    try:
        with conn.begin_nested():  # savepoint: a lost race on the unique index must not abort the whole capture
            return conn.scalar(text("""
                INSERT INTO sitemate.incidents
                  (project_id, activity_code, kind, title, occurred_at, category, event_type, summary, zone, asset_key, status,
                   first_reported_at, last_reported_at, report_count, reporter_count, cluster_key, recurrence_of_id)
                VALUES (:p, :ac, :et, :t, :oa, :cat, :et, :t, :z, :ak, 'open', :ra, :ra, 1, 1, :ck, CAST(:rec AS uuid))
                RETURNING id::text"""),
                               {"p": project_id, "ac": event.get("activity_code"), "et": event["event_type"], "t": event["summary"],
                                "oa": _dt(event["occurred_at"]), "cat": event["category"], "z": event.get("zone"),
                                "ak": event.get("asset_key"), "ra": _dt(event["recorded_at"]), "ck": stored_key, "rec": recurrence})
    except IntegrityError as exc:
        if getattr(exc.orig, "sqlstate", None) != "23505":
            raise
        return None  # another transaction created the same open cluster; the caller re-reads and links


def _new_incident(conn, ctx, event, key):
    project_id = ctx["project_id"]
    incident_id = _create_incident(conn, ctx, event, key)
    if incident_id is None:
        existing = _rows(conn, f"SELECT i.*, i.id::text AS sid FROM sitemate.incidents i WHERE i.project_id=:p AND i.cluster_key=:k AND {OPEN}",
                         {"p": project_id, "k": key})[0]
        existing["id"] = existing.pop("sid")
        return _link_existing(conn, ctx, event, {"incident": existing}, "corroborating", None, "unique-cluster backstop")
    _attach(conn, project_id, event, incident_id, "origin", None, "origin event")
    sev = recompute_severity(conn, project_id, incident_id, ctx["taxonomy"], trigger_event_id=event["id"], adjuster=ctx.get("adjust_severity"))
    alert = sync_alert(conn, project_id, incident_id, sev["severity"], None, f"Opened: {event['summary']}", False)
    enqueue_job(conn, project_id, "reasoning", incident_id)
    return {"incident_id": incident_id, "link_type": "origin", "created": True, "severity": sev["severity"],
            "severity_changed": True, "report_count": 1, "reporter_count": 1, "title": event["summary"], "alert_id": alert["alert_id"]}


def correlate_events(conn, ctx: dict, events: list[dict]) -> list[dict]:
    """Group confirmed events into incidents inside the caller's transaction.
    ctx: {project_id, taxonomy, adjudicate(event, candidates)->Adjudication|None, adjust_severity(incident, rule, stats)}.
    events carry {id, event_index, category, event_type, summary, zone, activity_code, asset_key, occurred_at, recorded_at}."""
    taxonomy, project_id = ctx["taxonomy"], ctx["project_id"]
    eligible = [e for e in events if taxonomy.creates_incident(e["category"]) or is_status_update(e["category"])]
    for e in eligible:
        e["cluster_key"] = cluster_key(e["category"], e, (taxonomy.category(e["category"]) or {}).get("grouping_fields"))
    # Lock in a stable order so two captures touching the same assets can't deadlock.
    for key in sorted({lock_key_for(e) for e in eligible}):
        conn.execute(text("SELECT pg_advisory_xact_lock(hashtext(:k))"), {"k": f"{project_id}|{key}"})

    results = []
    for event in eligible:
        category = taxonomy.category(event["category"]) or {}
        status = is_status_update(event["category"])
        window = category.get("group_window_hours") or 72
        cats = None if status else [event["category"], *COMPATIBLE.get(event["category"], [])]
        ranked = rank_candidates(event, _fetch_candidates(conn, project_id, event, cats, window), window)
        decision = decide(ranked)
        link_type = link_type_for(event["event_type"]) if status else "corroborating"
        reason = decision.get("reason")

        if decision["action"] == "adjudicate":
            history = _recent_events(conn, project_id, [c["incident"]["id"] for c in decision["candidates"]])
            verdict = None
            try:
                if ctx.get("adjudicate"):
                    verdict = ctx["adjudicate"](event, [{**c, "history": history.get(c["incident"]["id"], {"linked": [], "unlinked": []})}
                                                        for c in decision["candidates"]])
            except Exception:  # noqa: BLE001 - an unavailable adjudicator must not lose the report
                verdict = None
            chosen = next((c for c in decision["candidates"] if verdict and verdict.decision == "link"
                           and c["incident"]["id"] == verdict.incident_id), None)
            if chosen:
                decision, reason = {"action": "link", "candidate": chosen}, f"LLM: {verdict.reason}"
                if verdict.link_type and not status:
                    link_type = verdict.link_type
            elif verdict:
                decision = {"action": "new"}
            else:  # no verdict: link only when the top candidate is strong
                top = decision["candidates"][0]
                decision = {"action": "link", "candidate": top} if top["score"] >= 0.6 else {"action": "new"}
                reason = "fallback (adjudicator unavailable)"

        if decision["action"] == "link":
            c = decision["candidate"]
            results.append({"event_id": event["id"], "event_index": event["event_index"],
                            **_link_existing(conn, ctx, event, c, link_type, c["score"], reason)})
        elif not status:
            results.append({"event_id": event["id"], "event_index": event["event_index"],
                            **_new_incident(conn, ctx, event, event["cluster_key"])})
        # A status update with no open incident to attach to stays a plain event.
    return results
