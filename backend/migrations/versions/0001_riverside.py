"""Create the project-scoped SiteMate database."""

from alembic import op

revision = "0001_riverside"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""
        CREATE TABLE sitemate.projects (
            id text PRIMARY KEY, name text NOT NULL, timezone text NOT NULL,
            threshold numeric NOT NULL, high_threshold numeric NOT NULL,
            CHECK (threshold BETWEEN 0 AND high_threshold AND high_threshold <= 100)
        )
    """)
    op.execute("""
        CREATE TABLE sitemate.project_members (
            project_id text REFERENCES sitemate.projects, member_id text,
            token_hash text NOT NULL, PRIMARY KEY (project_id, member_id),
            UNIQUE (project_id, token_hash)
        )
    """)
    op.execute("""
        CREATE TABLE sitemate.sources (
            project_id text REFERENCES sitemate.projects, id text, kind text NOT NULL,
            path text NOT NULL, available_at timestamptz NOT NULL,
            PRIMARY KEY (project_id, id)
        )
    """)
    op.execute("""
        CREATE TABLE sitemate.source_passages (
            project_id text, source_id text, locator text, page integer, excerpt text NOT NULL,
            PRIMARY KEY (project_id, source_id, locator),
            FOREIGN KEY (project_id, source_id) REFERENCES sitemate.sources
        )
    """)
    op.execute("""
        CREATE TABLE sitemate.contractors (
            project_id text REFERENCES sitemate.projects, id text, name text NOT NULL,
            trade text NOT NULL, contact_role text NOT NULL, PRIMARY KEY (project_id, id)
        )
    """)
    op.execute("""
        CREATE TABLE sitemate.activities (
            project_id text REFERENCES sitemate.projects, code text, name text NOT NULL,
            unit text NOT NULL, zone text NOT NULL, contractor_id text,
            PRIMARY KEY (project_id, code),
            FOREIGN KEY (project_id, contractor_id) REFERENCES sitemate.contractors
        )
    """)
    op.execute("""
        CREATE TABLE sitemate.activity_dependencies (
            project_id text, predecessor text, successor text,
            PRIMARY KEY (project_id, predecessor, successor),
            FOREIGN KEY (project_id, predecessor) REFERENCES sitemate.activities,
            FOREIGN KEY (project_id, successor) REFERENCES sitemate.activities,
            CHECK (predecessor <> successor)
        )
    """)
    op.execute("""
        CREATE TABLE sitemate.equipment (
            project_id text, id text, description text NOT NULL, owner_id text NOT NULL,
            PRIMARY KEY (project_id, id),
            FOREIGN KEY (project_id, owner_id) REFERENCES sitemate.contractors
        )
    """)
    op.execute("""
        CREATE TABLE sitemate.equipment_assignments (
            project_id text, equipment_id text, work_date date, activity_code text NOT NULL,
            PRIMARY KEY (project_id, equipment_id, work_date),
            FOREIGN KEY (project_id, equipment_id) REFERENCES sitemate.equipment,
            FOREIGN KEY (project_id, activity_code) REFERENCES sitemate.activities
        )
    """)
    op.execute("""
        CREATE TABLE sitemate.plan_targets (
            project_id text, activity_code text, work_date date, quantity numeric NOT NULL CHECK (quantity >= 0),
            source_id text NOT NULL, locator text NOT NULL, PRIMARY KEY (project_id, activity_code, work_date),
            FOREIGN KEY (project_id, activity_code) REFERENCES sitemate.activities,
            FOREIGN KEY (project_id, source_id, locator) REFERENCES sitemate.source_passages
        )
    """)
    op.execute("""
        CREATE TABLE sitemate.observations (
            project_id text, activity_code text, work_date date, source_id text, locator text,
            quantity numeric NOT NULL CHECK (quantity >= 0),
            basis text NOT NULL CHECK (basis IN ('estimated','signed')),
            PRIMARY KEY (project_id, activity_code, work_date, source_id, locator),
            FOREIGN KEY (project_id, source_id, locator) REFERENCES sitemate.source_passages,
            FOREIGN KEY (project_id, activity_code) REFERENCES sitemate.activities
        )
    """)


def downgrade():
    for table in ("observations", "plan_targets", "equipment_assignments", "equipment",
                  "activity_dependencies", "activities", "contractors", "source_passages",
                  "sources", "project_members", "projects"):
        op.drop_table(table, schema="sitemate")
