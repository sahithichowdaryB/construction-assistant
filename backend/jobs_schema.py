"""Idempotent DDL for the hardened job queue and the voice fallback state (migration 0012_job_queue_hardening).

- agent_jobs.locked_at / locked_by: set when a worker claims a job, so a job left 'running' by a crashed worker is
  found and queued again.
- New job kinds: ingest and summarize (document work that used to run in FastAPI BackgroundTasks), auto_draft (a
  private notice draft for a qualifying deviation) and daily_report_draft. One queued job per source / per alert and
  notice type (debounce); daily_report_draft and overall_eval reuse the per-work_date debounce index of 0009.
- captures.status 'needs_transcript': audio arrived but speech-to-text is unavailable; the speaker types the note.
- worker_heartbeats: each worker process records when it last polled, so the app can show that background
  processing is offline.

Run directly with `python jobs_schema.py` (or `--downgrade`).
"""

from schema_util import main, replace_check

JOB_KINDS_0009 = ("reasoning", "plan_actions", "escalation_check", "auto_resolve", "daily_eval", "overall_eval",
                  "plan_extract")
JOB_KINDS = JOB_KINDS_0009 + ("ingest", "summarize", "auto_draft", "daily_report_draft")
CAPTURE_0007 = ("processing", "needs_category", "needs_input", "needs_review", "saved", "no_events", "failed")
CAPTURE = CAPTURE_0007 + ("needs_transcript",)
NEW_KINDS = ",".join(f"'{k}'" for k in JOB_KINDS if k not in JOB_KINDS_0009)

UPGRADE = [
    "ALTER TABLE sitemate.agent_jobs ADD COLUMN IF NOT EXISTS locked_at timestamptz, ADD COLUMN IF NOT EXISTS locked_by text",
    "UPDATE sitemate.agent_jobs SET locked_at = updated_at WHERE status = 'running' AND locked_at IS NULL",
    *replace_check("agent_jobs", "agent_jobs_kind_check", JOB_KINDS, "kind", valid=True),
    """CREATE UNIQUE INDEX IF NOT EXISTS agent_jobs_source_debounce
         ON sitemate.agent_jobs (project_id, kind, (payload->>'source_id'))
         WHERE status = 'queued' AND kind IN ('ingest','summarize')""",
    """CREATE UNIQUE INDEX IF NOT EXISTS agent_jobs_draft_debounce
         ON sitemate.agent_jobs (project_id, (payload->>'alert_id'), (payload->>'notice_type'))
         WHERE status = 'queued' AND kind = 'auto_draft'""",
    "CREATE INDEX IF NOT EXISTS agent_jobs_locked ON sitemate.agent_jobs (status, locked_at)",
    *replace_check("captures", "captures_status_check", CAPTURE, "status", valid=True),
    """CREATE TABLE IF NOT EXISTS sitemate.worker_heartbeats (
         worker_id text PRIMARY KEY, seen_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz NOT NULL DEFAULT now())""",
    """DO $$ BEGIN
         IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sitemate_ops') THEN
           GRANT SELECT, INSERT, UPDATE, DELETE ON sitemate.worker_heartbeats TO sitemate_ops;
         END IF;
         IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sitemate_reader') THEN
           GRANT SELECT ON sitemate.worker_heartbeats TO sitemate_reader;
         END IF;
       END $$""",
    """DO $$ BEGIN
         IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sitemate_ops') THEN
           GRANT UPDATE (locked_at, locked_by) ON sitemate.agent_jobs TO sitemate_ops;
         END IF;
       END $$""",
]

DOWNGRADE = [
    "DROP TABLE IF EXISTS sitemate.worker_heartbeats",
    "UPDATE sitemate.captures SET status = 'failed' WHERE status = 'needs_transcript'",
    *replace_check("captures", "captures_status_check", CAPTURE_0007, "status", valid=True),
    "DROP INDEX IF EXISTS sitemate.agent_jobs_locked",
    "DROP INDEX IF EXISTS sitemate.agent_jobs_draft_debounce",
    "DROP INDEX IF EXISTS sitemate.agent_jobs_source_debounce",
    f"DELETE FROM sitemate.agent_jobs WHERE kind IN ({NEW_KINDS})",
    *replace_check("agent_jobs", "agent_jobs_kind_check", JOB_KINDS_0009, "kind", valid=True),
    "ALTER TABLE sitemate.agent_jobs DROP COLUMN IF EXISTS locked_by, DROP COLUMN IF EXISTS locked_at",
]

if __name__ == "__main__":
    main(UPGRADE, DOWNGRADE, "job queue")
