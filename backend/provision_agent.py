"""Provision the database identity used by the Node.js capture agent (reads + inserts project memory)."""

import os

from psycopg import sql
from sqlalchemy.engine import make_url

from database import engine_for

READ = ("projects", "project_members", "activities", "activity_dependencies", "contractors", "equipment",
        "equipment_assignments", "plan_targets", "observations", "sources", "source_passages", "alerts",
        "alert_revisions", "incidents", "capture_facts", "fact_evidence", "business_rules",
        "captures", "capture_attachments", "events", "incident_events", "incident_severity_history",
        "event_categories", "event_types", "agent_jobs", "agent_runs", "action_items", "alert_activity")
WRITE = ("sources", "source_passages", "incidents", "capture_facts", "fact_evidence",
         "captures", "capture_attachments", "events", "incident_events", "incident_severity_history",
         "alerts", "alert_revisions", "alert_activity", "agent_jobs", "agent_runs")


def main():
    agent = make_url(os.environ["AGENT_DATABASE_URL"])
    role = "sitemate_agent"
    if agent.username.split(".")[0] != role or not agent.password:
        raise ValueError("AGENT_DATABASE_URL must specify sitemate_agent and its own password")
    with engine_for("MIGRATION_DATABASE_URL").begin() as conn:
        with conn.connection.driver_connection.cursor() as cur:
            cur.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (role,))
            if cur.fetchone() is None:
                cur.execute(sql.SQL("CREATE ROLE {} LOGIN PASSWORD {}").format(
                    sql.Identifier(role), sql.Literal(agent.password)))
            cur.execute("GRANT USAGE ON SCHEMA sitemate TO sitemate_agent")
            cur.execute(sql.SQL("GRANT SELECT ON {} TO sitemate_agent").format(
                sql.SQL(", ").join(sql.Identifier("sitemate", t) for t in READ)))
            cur.execute(sql.SQL("GRANT INSERT ON {} TO sitemate_agent").format(
                sql.SQL(", ").join(sql.Identifier("sitemate", t) for t in WRITE)))
            # A repair release closes the open breakdown incident; nothing else may be updated.
            cur.execute("GRANT UPDATE (resolved_at, status, severity, severity_version, summary, report_count, "
                        "reporter_count, last_reported_at, recurrence_of_id) ON sitemate.incidents TO sitemate_agent")
            cur.execute("GRANT UPDATE (status, state) ON sitemate.captures TO sitemate_agent")
            cur.execute("GRANT UPDATE (incident_id, status) ON sitemate.events TO sitemate_agent")
            cur.execute("GRANT UPDATE (unlinked_at) ON sitemate.incident_events TO sitemate_agent")
            cur.execute("GRANT UPDATE (status, checkpoint_at) ON sitemate.alerts TO sitemate_agent")
            cur.execute("GRANT UPDATE (status, run_after, updated_at, attempts) ON sitemate.agent_jobs TO sitemate_agent")
    print("Database agent role provisioned.")


if __name__ == "__main__":
    main()
