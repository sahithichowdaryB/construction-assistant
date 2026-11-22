"""Provision the `sitemate_ops` identity: manager actions in FastAPI plus the Python worker.

Reads everything the reader can, and may only change alert state/assignment, action items, incident status and
manual merges/unlinks, and write its own audit rows. Configure OPS_DATABASE_URL with this role's password."""

import os

from psycopg import sql
from sqlalchemy.engine import make_url

from database import engine_for

ROLE = "sitemate_ops"
READ_ALL = ("project_members", "projects", "activities", "activity_dependencies", "contractors", "equipment",
            "equipment_assignments", "sources", "source_passages", "plan_targets", "observations", "alerts",
            "alert_revisions", "incidents", "capture_facts", "fact_evidence", "diary_entries", "business_rules",
            "incident_analyses", "analysis_hypotheses", "analysis_evidence", "captures", "capture_attachments",
            "events", "incident_events", "incident_severity_history", "alert_activity", "action_items",
            "event_categories", "event_types", "agent_jobs", "agent_runs", "drafts", "draft_versions")
INSERT = ("alert_activity", "action_items", "agent_runs", "agent_jobs", "incident_events", "alert_revisions",
          "incident_severity_history", "incident_analyses", "analysis_hypotheses", "analysis_evidence", "drafts",
          "incidents", "alerts")
PERFORMANCE_READ = ("plan_baselines", "activity_plan", "milestones", "performance_settings", "daily_evaluations",
                    "daily_activity_results", "performance_ledger", "performance_snapshots", "document_summaries",
                    "reviews")
PERFORMANCE_INSERT = ("daily_evaluations", "daily_activity_results", "performance_ledger", "performance_snapshots")


def main():
    ops = make_url(os.environ["OPS_DATABASE_URL"])
    if ops.username.split(".")[0] != ROLE or not ops.password:
        raise ValueError("OPS_DATABASE_URL must specify sitemate_ops and its own password")
    ident = lambda tables: sql.SQL(", ").join(sql.Identifier("sitemate", t) for t in tables)  # noqa: E731
    with engine_for("MIGRATION_DATABASE_URL").begin() as conn:
        with conn.connection.driver_connection.cursor() as cur:
            cur.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (ROLE,))
            if cur.fetchone() is None:
                cur.execute(sql.SQL("CREATE ROLE {} LOGIN PASSWORD {}").format(
                    sql.Identifier(ROLE), sql.Literal(ops.password)))
            cur.execute(sql.SQL("GRANT USAGE ON SCHEMA sitemate TO {}").format(sql.Identifier(ROLE)))
            cur.execute(sql.SQL("GRANT SELECT ON {} TO {}").format(ident(READ_ALL), sql.Identifier(ROLE)))
            cur.execute(sql.SQL("GRANT INSERT ON {} TO {}").format(ident(INSERT), sql.Identifier(ROLE)))
            r = sql.Identifier(ROLE)
            cur.execute(sql.SQL("""GRANT UPDATE (status, assigned_to, acknowledged_by, acknowledged_at, resolved_by,
                                   resolved_at) ON sitemate.alerts TO {}""").format(r))
            cur.execute(sql.SQL("""GRANT UPDATE (status, decided_by, decided_at, executed_at, result, owner_role,
                                   contractor_id, priority, title, rationale, due_at) ON sitemate.action_items TO {}""").format(r))
            cur.execute(sql.SQL("""GRANT UPDATE (status, resolved_at, merged_into_id, severity, severity_version,
                                   report_count, reporter_count, last_reported_at, summary)
                                   ON sitemate.incidents TO {}""").format(r))
            cur.execute(sql.SQL("GRANT UPDATE (unlinked_at, link_type, linked_by) ON sitemate.incident_events TO {}").format(r))
            cur.execute(sql.SQL("GRANT UPDATE (incident_id) ON sitemate.events TO {}").format(r))
            cur.execute(sql.SQL("GRANT UPDATE (status, run_after, attempts, last_error, updated_at, payload) "
                                "ON sitemate.agent_jobs TO {}").format(r))
            # The worker runs daily evaluations and snapshots (migration 0009_performance): it adds versions and
            # ledger rows, supersedes ledger rows, and may only change a ledger row's review fields otherwise.
            cur.execute(sql.SQL("GRANT SELECT ON {} TO {}").format(ident(PERFORMANCE_READ), r))
            cur.execute(sql.SQL("GRANT INSERT ON {} TO {}").format(ident(PERFORMANCE_INSERT), r))
            cur.execute(sql.SQL("""GRANT UPDATE (status, reviewer_id, note, reviewed_at, superseded_at, superseded_version)
                                   ON sitemate.performance_ledger TO {}""").format(r))
            # Migrations 0010-0015: the worker reads reading reviews, appointments and gap resolutions, records its
            # heartbeat and claims jobs with a lock. Draft writes from worker jobs use the writer login.
            for table, privileges in (("reading_reviews", "SELECT"), ("appointments", "SELECT"),
                                      ("draft_gap_resolutions", "SELECT"), ("exports", "SELECT"),
                                      ("worker_heartbeats", "SELECT, INSERT, UPDATE, DELETE")):
                cur.execute(sql.SQL("""DO $$ BEGIN
                                         IF to_regclass({}) IS NOT NULL THEN
                                           EXECUTE 'GRANT {} ON ' || {} || ' TO sitemate_ops';
                                         END IF;
                                       END $$""").format(sql.Literal(f"sitemate.{table}"), sql.SQL(privileges),
                                                         sql.Literal(f"sitemate.{table}")))
            cur.execute("""DO $$ BEGIN
                             IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'sitemate'
                                        AND table_name = 'agent_jobs' AND column_name = 'locked_at') THEN
                               GRANT UPDATE (locked_at, locked_by) ON sitemate.agent_jobs TO sitemate_ops;
                             END IF;
                           END $$""")
            cur.execute("GRANT USAGE ON SCHEMA extensions TO sitemate_ops")
    print("Database ops role provisioned.")


if __name__ == "__main__":
    main()
