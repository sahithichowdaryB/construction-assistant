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
                           sitemate.plan_targets, sitemate.observations TO sitemate_reader""")
    print("Database reader provisioned.")


if __name__ == "__main__":
    main()
