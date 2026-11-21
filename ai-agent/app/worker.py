"""Asynchronous agent work: claim a job from sitemate.agent_jobs and run reasoning or action planning.

Runs as the `sitemate_ops` role. Jobs are claimed with FOR UPDATE SKIP LOCKED so several workers can share the
queue. Failures retry with backoff, then stay visible as status='failed' with last_error."""

from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime, timezone

from sqlalchemy import text

from . import persist
from .actions import SqlActionStore, plan_actions, save_actions
from .llm import LLMClient
from .orchestrator import IncidentNotFound, analyze_incident
from .tools import SqlEvidenceStore

log = logging.getLogger("sitemate.worker")
MAX_ATTEMPTS = 3
BACKOFF_SECONDS = (30, 120)
SEVERITIES = ["low", "medium", "high", "critical"]


def _now() -> datetime:
    return datetime.now(timezone.utc)


def claim_job(conn) -> dict | None:
    """Atomically take the oldest ready job (or None). The transaction commits, so the claim survives a crash as 'running'."""
    row = conn.execute(text("""
        UPDATE sitemate.agent_jobs j SET status='running', attempts=j.attempts+1, updated_at=now()
        WHERE (j.project_id, j.id) = (
            SELECT project_id, id FROM sitemate.agent_jobs
            WHERE status='queued' AND run_after <= now() ORDER BY run_after, created_at
            FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING j.project_id, j.id::text AS id, j.kind, j.incident_id::text AS incident_id, j.attempts, j.payload
    """)).mappings().one_or_none()
    conn.commit()
    return dict(row) if row else None


def enqueue(conn, project_id: str, kind: str, incident_id: str, delay_seconds: int = 0) -> None:
    conn.execute(text("""
        INSERT INTO sitemate.agent_jobs (project_id, kind, incident_id, run_after)
        VALUES (:p, :k, CAST(:i AS uuid), now() + make_interval(secs => :d))
        ON CONFLICT (project_id, kind, incident_id) WHERE status='queued'
        DO UPDATE SET run_after = LEAST(sitemate.agent_jobs.run_after, EXCLUDED.run_after), updated_at = now()
    """), {"p": project_id, "k": kind, "i": incident_id, "d": delay_seconds})


DAILY_DEBOUNCE_SECONDS = 120  # a burst of events for one project and day causes one evaluation


def enqueue_daily_eval(conn, project_id: str, work_date, *, trigger: str, as_of=None,
                       delay_seconds: int = DAILY_DEBOUNCE_SECONDS, force: bool = False, kind: str = "daily_eval") -> None:
    """Queue a daily (or overall) evaluation for (project, date). While a job is queued, a new trigger pushes its
    run_after out (debounce). `force` (manual recompute) also replaces the payload; it needs UPDATE on payload."""
    payload = json.dumps({"work_date": str(work_date), "trigger": trigger,
                          "as_of": as_of.isoformat() if as_of else None, "force": force})
    replace = ", payload = EXCLUDED.payload" if force else ""
    conn.execute(text(f"""
        INSERT INTO sitemate.agent_jobs (project_id, kind, payload, run_after)
        VALUES (:p, :k, CAST(:payload AS jsonb), now() + make_interval(secs => :d))
        ON CONFLICT (project_id, kind, (payload->>'work_date')) WHERE status = 'queued' AND incident_id IS NULL
        DO UPDATE SET run_after = EXCLUDED.run_after, updated_at = now(){replace}"""),
                 {"p": project_id, "k": kind, "payload": payload, "d": delay_seconds})


def _performance():
    """The evaluation code lives in backend/performance; the worker process runs from backend/ (worker.py)."""
    import sys
    from pathlib import Path
    backend = str(Path(__file__).resolve().parents[2] / "backend")
    if backend not in sys.path:
        sys.path.insert(0, backend)
    from performance import daily, overall
    return daily, overall


def run_daily_eval(conn, llm: LLMClient, job: dict) -> dict:
    """Evaluate one work day (payload: work_date, as_of, trigger, force). The LLM steps use the existing clients."""
    from datetime import date as _date
    daily, _ = _performance()
    payload = job.get("payload") or {}
    as_of = datetime.fromisoformat(payload["as_of"]) if payload.get("as_of") else None
    started = time.monotonic()
    result = daily.evaluate_day(conn, job["project_id"], _date.fromisoformat(payload["work_date"]), as_of,
                                trigger=payload.get("trigger") or "job", force=bool(payload.get("force")))
    conn.commit()
    _log_run(conn, job["project_id"], "daily_eval", None, None, None, result, "ok", started)
    return result


def run_overall_eval(conn, llm: LLMClient, job: dict) -> dict:
    from datetime import date as _date
    _, overall = _performance()
    payload = job.get("payload") or {}
    as_of = datetime.fromisoformat(payload["as_of"]) if payload.get("as_of") else None
    started = time.monotonic()
    result = overall.snapshot(conn, job["project_id"], _date.fromisoformat(payload["work_date"]), as_of,
                              force=bool(payload.get("force")))
    conn.commit()
    _log_run(conn, job["project_id"], "overall_eval", None, None, None, {"version": result.get("version")}, "ok", started)
    return result


def sweep_daily(conn) -> int:
    """End-of-day sweep: at the project's sweep time (default 18:00 local) queue today's evaluation once, so an
    unreported planned activity is flagged as a missing report."""
    if conn.scalar(text("SELECT to_regclass('sitemate.daily_evaluations')")) is None:
        return 0
    due = conn.execute(text("""
        SELECT p.id, (now() AT TIME ZONE p.timezone)::date AS today
        FROM sitemate.projects p
        JOIN sitemate.plan_baselines b ON b.project_id = p.id AND b.status = 'active'
        LEFT JOIN sitemate.performance_settings s ON (s.project_id, s.baseline_id) = (b.project_id, b.id)
        WHERE (now() AT TIME ZONE p.timezone)::time >= CAST(coalesce(s.settings #>> '{calendar,sweep_time}', '18:00') AS time)
          AND NOT EXISTS (SELECT 1 FROM sitemate.daily_evaluations d WHERE d.project_id = p.id
                          AND d.work_date = (now() AT TIME ZONE p.timezone)::date AND d.trigger = 'sweep')
          AND NOT EXISTS (SELECT 1 FROM sitemate.agent_jobs j WHERE j.project_id = p.id AND j.kind = 'daily_eval'
                          AND j.payload->>'work_date' = ((now() AT TIME ZONE p.timezone)::date)::text
                          AND j.payload->>'trigger' = 'sweep')""")).mappings().all()
    for row in due:
        enqueue_daily_eval(conn, row["id"], row["today"], trigger="sweep", delay_seconds=0)
    conn.commit()
    return len(due)


def _log_run(conn, project_id, agent, incident_id, model, digest, output, status, started):
    conn.execute(text("""
        INSERT INTO sitemate.agent_runs (project_id, agent, incident_id, model, input_digest, output, status, latency_ms)
        VALUES (:p, :a, CAST(:i AS uuid), :m, :d, CAST(:o AS jsonb), :s, :l)"""),
                 {"p": project_id, "a": agent, "i": incident_id, "m": model, "d": digest,
                  "o": json.dumps(output, default=str), "s": status, "l": int((time.monotonic() - started) * 1000)})
    conn.commit()


def _note_analysis_on_alert(conn, project_id: str, incident_id: str, analysis_id: str) -> None:
    """Immutable alert revisions: record 'likely cause analysed' as a new revision that points at the analysis."""
    alert = conn.execute(text("""
        SELECT id::text AS id FROM sitemate.alerts
        WHERE project_id=:p AND incident_id=CAST(:i AS uuid) AND kind='incident'"""),
                         {"p": project_id, "i": incident_id}).mappings().one_or_none()
    if alert is None:
        return
    last = conn.execute(text("""
        SELECT version, severity, calculation, evidence_refs, analysis_id::text AS analysis_id
        FROM sitemate.alert_revisions WHERE project_id=:p AND alert_id=CAST(:a AS uuid)
        ORDER BY version DESC LIMIT 1"""), {"p": project_id, "a": alert["id"]}).mappings().one_or_none()
    if last is None or last["analysis_id"] == analysis_id:
        return
    conn.execute(text("""
        INSERT INTO sitemate.alert_revisions
          (project_id, alert_id, version, as_of, severity, calculation, evidence_refs, reason, analysis_id)
        VALUES (:p, CAST(:a AS uuid), :v, now(), :sev, CAST(:calc AS jsonb), CAST(:refs AS jsonb),
                'Likely cause analysed', CAST(:an AS uuid))"""),
                 {"p": project_id, "a": alert["id"], "v": last["version"] + 1, "sev": last["severity"],
                  "calc": json.dumps(last["calculation"]), "refs": json.dumps(last["evidence_refs"]), "an": analysis_id})


def run_reasoning(conn, llm: LLMClient, job: dict) -> dict:
    project_id, incident_id, when = job["project_id"], job["incident_id"], _now()
    started = time.monotonic()
    store = SqlEvidenceStore(conn, project_id, when)
    result = analyze_incident(store, llm, incident_id, when)
    saved = persist.save_analysis(conn, project_id, result)
    _note_analysis_on_alert(conn, project_id, incident_id, saved["id"])
    enqueue(conn, project_id, "plan_actions", incident_id)
    conn.commit()
    _log_run(conn, project_id, "root_cause", incident_id, llm.model, result.input_digest,
             {"status": result.status, "confidence": result.confidence, "version": saved["version"]}, "ok", started)
    return saved


def run_plan_actions(conn, llm: LLMClient, job: dict) -> dict:
    project_id, incident_id, when = job["project_id"], job["incident_id"], _now()
    started = time.monotonic()
    analysis = persist.load_analysis(conn, project_id, incident_id)
    ctx = SqlActionStore(conn, project_id).context(incident_id, analysis)
    if ctx is None:
        raise IncidentNotFound(incident_id)
    plan = plan_actions(ctx, llm, when)
    saved = save_actions(conn, project_id, plan)
    _log_run(conn, project_id, "action_planner", incident_id, llm.model, plan.analysis_id,
             {"actions": [a.title for a in plan.actions], "dropped": plan.dropped, **saved}, "ok", started)
    return saved


HANDLERS = {"reasoning": run_reasoning, "plan_actions": run_plan_actions, "daily_eval": run_daily_eval,
            "overall_eval": run_overall_eval}


def finish(conn, job: dict, error: Exception | None) -> None:
    if error is None:
        status, run_after, message = "done", None, None
    elif job["attempts"] >= MAX_ATTEMPTS:
        status, run_after, message = "failed", None, str(error)[:500]
    else:
        status, run_after, message = "queued", BACKOFF_SECONDS[min(job["attempts"] - 1, len(BACKOFF_SECONDS) - 1)], str(error)[:500]
    conn.execute(text("""
        UPDATE sitemate.agent_jobs SET status=:s, last_error=:e, updated_at=now(),
            run_after=CASE WHEN CAST(:d AS int) IS NULL THEN run_after ELSE now() + make_interval(secs => CAST(:d AS int)) END
        WHERE project_id=:p AND id=CAST(:id AS uuid)"""),
                 {"s": status, "e": message, "d": run_after, "p": job["project_id"], "id": job["id"]})
    conn.commit()


def process_one(engine, llm_factory) -> bool:
    """Claim and run one job. Returns False when the queue is empty."""
    with engine.connect() as conn:
        job = claim_job(conn)
        if job is None:
            return False
        handler = HANDLERS.get(job["kind"])
        try:
            if handler is None:
                raise ValueError(f"no handler for job kind {job['kind']!r}")
            handler(conn, llm_factory(), job)
            finish(conn, job, None)
        except Exception as exc:  # noqa: BLE001 - every failure must land in the job row, not kill the worker
            conn.rollback()
            log.warning("job %s (%s) failed: %s", job["id"], job["kind"], exc)
            finish(conn, job, exc)  # retried with backoff up to MAX_ATTEMPTS; the row keeps last_error
        return True


# --- periodic sweeps (no job rows: they are cheap queries) ------------------------------------------------------

def escalate_long_open(conn, hours: int = 24) -> int:
    """Open incidents older than `hours` gain one severity level (cap: high). One escalation per incident."""
    rows = conn.execute(text("""
        SELECT i.project_id, i.id::text AS id, i.severity, i.severity_version
        FROM sitemate.incidents i
        WHERE i.status='open' AND i.merged_into_id IS NULL AND i.severity IN ('low','medium')
          AND coalesce(i.first_reported_at, i.occurred_at) < now() - make_interval(hours => :h)
          AND NOT EXISTS (SELECT 1 FROM sitemate.incident_severity_history h
                          WHERE (h.project_id,h.incident_id)=(i.project_id,i.id)
                            AND h.rule_basis->'escalators' ? :marker)
        FOR UPDATE OF i SKIP LOCKED"""), {"h": hours, "marker": f"open longer than {hours}h"}).mappings().all()
    for r in rows:
        new = SEVERITIES[min(SEVERITIES.index(r["severity"]) + 1, SEVERITIES.index("high"))]
        conn.execute(text("""
            INSERT INTO sitemate.incident_severity_history (project_id,incident_id,version,severity,rule_basis,reason)
            VALUES (:p, CAST(:i AS uuid), :v, :s, CAST(:b AS jsonb), :reason)"""),
                     {"p": r["project_id"], "i": r["id"], "v": r["severity_version"] + 1, "s": new,
                      "b": json.dumps({"escalators": [f"open longer than {hours}h"], "hard": []}),
                      "reason": f"Still open after {hours}h"})
        conn.execute(text("""UPDATE sitemate.incidents SET severity=:s, severity_version=:v
                             WHERE project_id=:p AND id=CAST(:i AS uuid)"""),
                     {"s": new, "v": r["severity_version"] + 1, "p": r["project_id"], "i": r["id"]})
        _alert_attention(conn, r["project_id"], r["id"], new, f"Severity {r['severity']} -> {new}: open longer than {hours}h",
                         "escalated")
    conn.commit()
    return len(rows)


def auto_resolve_quiet(conn, hours: int = 12) -> int:
    """Incidents in 'monitoring' with no new report for `hours` resolve themselves (a manager can reopen)."""
    rows = conn.execute(text("""
        UPDATE sitemate.incidents SET status='resolved', resolved_at=GREATEST(now(), occurred_at)
        WHERE status='monitoring' AND merged_into_id IS NULL AND last_reported_at < now() - make_interval(hours => :h)
        RETURNING project_id, id::text AS id"""), {"h": hours}).mappings().all()
    for r in rows:
        alert = conn.execute(text("""
            UPDATE sitemate.alerts SET status='resolved', resolved_by='system', resolved_at=now()
            WHERE project_id=:p AND incident_id=CAST(:i AS uuid) AND kind='incident' AND status NOT IN ('resolved','dismissed')
            RETURNING id::text AS id, status"""), {"p": r["project_id"], "i": r["id"]}).mappings().one_or_none()
        if alert:
            conn.execute(text("""
                INSERT INTO sitemate.alert_activity (project_id, alert_id, actor, action, to_status, note)
                VALUES (:p, CAST(:a AS uuid), 'system', 'resolve', 'resolved', :n)"""),
                         {"p": r["project_id"], "a": alert["id"], "n": f"Auto-resolved: no new reports for {hours}h"})
    conn.commit()
    return len(rows)


def _alert_attention(conn, project_id, incident_id, severity, reason, action) -> None:
    alert = conn.execute(text("""
        SELECT id::text AS id, status FROM sitemate.alerts
        WHERE project_id=:p AND incident_id=CAST(:i AS uuid) AND kind='incident'"""),
                         {"p": project_id, "i": incident_id}).mappings().one_or_none()
    if alert is None:
        return
    last = conn.execute(text("""
        SELECT version, calculation, evidence_refs FROM sitemate.alert_revisions
        WHERE project_id=:p AND alert_id=CAST(:a AS uuid) ORDER BY version DESC LIMIT 1"""),
                        {"p": project_id, "a": alert["id"]}).mappings().one_or_none()
    conn.execute(text("""
        INSERT INTO sitemate.alert_revisions (project_id, alert_id, version, as_of, severity, calculation, evidence_refs, reason)
        VALUES (:p, CAST(:a AS uuid), :v, now(), :s, CAST(:c AS jsonb), CAST(:r AS jsonb), :reason)"""),
                 {"p": project_id, "a": alert["id"], "v": (last["version"] if last else 0) + 1, "s": severity,
                  "c": json.dumps(last["calculation"] if last else {"kind": "incident"}),
                  "r": json.dumps(last["evidence_refs"] if last else []), "reason": reason})
    if alert["status"] in ("acknowledged", "in_progress", "resolved", "dismissed"):
        conn.execute(text("UPDATE sitemate.alerts SET status='open' WHERE project_id=:p AND id=CAST(:a AS uuid)"),
                     {"p": project_id, "a": alert["id"]})
        conn.execute(text("""
            INSERT INTO sitemate.alert_activity (project_id, alert_id, actor, action, from_status, to_status, note)
            VALUES (:p, CAST(:a AS uuid), 'system', :act, :f, 'open', :n)"""),
                     {"p": project_id, "a": alert["id"], "act": action, "f": alert["status"], "n": reason})


def run_forever(engine, llm_factory, poll_seconds: float = 3.0, sweep_seconds: float = 300.0) -> None:
    escalate_hours = int(os.environ.get("AGENT_ESCALATE_AFTER_HOURS", "24"))
    resolve_hours = int(os.environ.get("AGENT_AUTO_RESOLVE_HOURS", "12"))
    last_sweep = 0.0
    while True:
        try:
            if time.monotonic() - last_sweep > sweep_seconds:
                with engine.connect() as conn:
                    log.info("sweep: escalated=%s auto_resolved=%s daily=%s", escalate_long_open(conn, escalate_hours),
                             auto_resolve_quiet(conn, resolve_hours), sweep_daily(conn))
                last_sweep = time.monotonic()
            if not process_one(engine, llm_factory):
                time.sleep(poll_seconds)
        except Exception:  # noqa: BLE001
            log.exception("worker loop error")
            time.sleep(poll_seconds)
