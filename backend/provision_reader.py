"""Provision the database identity used by the read-only FastAPI service."""

import os

from psycopg import sql
from sqlalchemy.engine import make_url

from database import engine_for


def main():
    reader = make_url(os.environ["DATABASE_URL"])
    role = "sitemate_reader"
    if reader.username.split(".")[0] != role or not reader.password:
        raise ValueError("DATABASE_URL must specify sitemate_reader and its own password")
    with engine_for("MIGRATION_DATABASE_URL").begin() as conn:
        with conn.connection.driver_connection.cursor() as cur:
            cur.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (role,))
            if cur.fetchone() is None:
                cur.execute(sql.SQL("CREATE ROLE {} LOGIN PASSWORD {}").format(
                    sql.Identifier(role), sql.Literal(reader.password)))
            cur.execute("GRANT USAGE ON SCHEMA sitemate TO sitemate_reader")
            cur.execute("""GRANT SELECT ON sitemate.project_members, sitemate.projects,
                           sitemate.activities, sitemate.sources, sitemate.source_passages,
                           sitemate.plan_targets, sitemate.observations,
                           sitemate.alerts, sitemate.alert_revisions,
                           sitemate.incidents, sitemate.capture_facts, sitemate.fact_evidence,
                           sitemate.diary_entries, sitemate.contractors, sitemate.equipment,
                           sitemate.equipment_assignments, sitemate.business_rules,
                           sitemate.incident_analyses, sitemate.analysis_hypotheses,
                           sitemate.analysis_evidence, sitemate.activity_dependencies,
                           sitemate.ingestion_jobs, sitemate.document_summaries,
                           sitemate.action_items,
                           sitemate.captures, sitemate.capture_attachments, sitemate.events,
                           sitemate.incident_events, sitemate.incident_severity_history,
                           sitemate.alert_activity,
                           sitemate.event_categories, sitemate.event_types,
                           sitemate.agent_jobs, sitemate.agent_runs TO sitemate_reader""")
            # The analyze route saves immutable analysis versions; nothing else is writable.
            cur.execute("""GRANT INSERT ON sitemate.incident_analyses, sitemate.analysis_hypotheses,
                           sitemate.analysis_evidence TO sitemate_reader""")
            # Document search calls pg_trgm functions that live in Supabase's `extensions` schema.
            cur.execute("GRANT USAGE ON SCHEMA extensions TO sitemate_reader")
    print("Database reader provisioned.")


if __name__ == "__main__":
    main()
