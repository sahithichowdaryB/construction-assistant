"""Source authorship/trust plus immutable incident-cause analyses (evidence + confidence)."""

from alembic import op

revision = "0004_incident_analysis"
down_revision = "0003_agent_rules"
branch_labels = None
depends_on = None

ROLES = ("site_supervisor", "foreman", "signed_report", "contractor_internal",
         "external", "client", "system", "unknown")


def upgrade():
    op.execute("SET LOCAL search_path TO sitemate, pg_catalog")
    roles = ",".join(f"'{r}'" for r in ROLES)
    op.execute(f"""ALTER TABLE sources ADD COLUMN author text,
                   ADD COLUMN author_role text NOT NULL DEFAULT 'unknown'
                       CHECK (author_role IN ({roles}))""")
    op.execute("ALTER TABLE projects ADD COLUMN trust_config jsonb")
    op.execute("""
        CREATE TABLE incident_analyses (
            project_id text, id uuid DEFAULT gen_random_uuid(), incident_id uuid NOT NULL,
            version integer NOT NULL CHECK (version >= 1), as_of timestamptz NOT NULL,
            status text NOT NULL CHECK (status IN
                ('established','probable','unconfirmed','undetermined','needs_review')),
            confidence numeric(4,3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
            headline_cause text, reasoning text NOT NULL,
            score_cards jsonb NOT NULL DEFAULT '[]', guardrail_flags jsonb NOT NULL DEFAULT '[]',
            gaps jsonb NOT NULL DEFAULT '[]', external_claims jsonb NOT NULL DEFAULT '[]',
            input_digest text NOT NULL, model text NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (project_id,id), UNIQUE (project_id,incident_id,version),
            FOREIGN KEY (project_id,incident_id) REFERENCES incidents)
    """)
    op.execute("""
        CREATE TABLE analysis_hypotheses (
            project_id text, analysis_id uuid, id text, statement text NOT NULL,
            level text NOT NULL CHECK (level IN ('proximate','root')),
            score numeric(4,3) NOT NULL CHECK (score BETWEEN 0 AND 1),
            llm_selected boolean NOT NULL DEFAULT false,
            PRIMARY KEY (project_id,analysis_id,id),
            FOREIGN KEY (project_id,analysis_id) REFERENCES incident_analyses)
    """)
    op.execute("""
        CREATE TABLE analysis_evidence (
            project_id text, analysis_id uuid, hypothesis_id text, source_id text, locator text,
            quote text NOT NULL, stance text NOT NULL, author_role text NOT NULL,
            weight numeric(4,3) NOT NULL, stated_at timestamptz,
            PRIMARY KEY (project_id,analysis_id,hypothesis_id,source_id,locator,quote),
            FOREIGN KEY (project_id,analysis_id,hypothesis_id) REFERENCES analysis_hypotheses,
            FOREIGN KEY (project_id,source_id,locator) REFERENCES source_passages)
    """)
    for table in ("incident_analyses", "analysis_hypotheses", "analysis_evidence"):
        op.execute(f"CREATE TRIGGER keep_revision BEFORE UPDATE OR DELETE ON {table} "
                   "FOR EACH ROW EXECUTE FUNCTION sitemate.keep_revision()")


def downgrade():
    op.execute("SET LOCAL search_path TO sitemate, pg_catalog")
    for table in ("analysis_evidence", "analysis_hypotheses", "incident_analyses"):
        op.execute(f"DROP TRIGGER IF EXISTS keep_revision ON {table}")
        op.drop_table(table, schema="sitemate")
    op.execute("ALTER TABLE projects DROP COLUMN trust_config")
    op.execute("ALTER TABLE sources DROP COLUMN author_role, DROP COLUMN author")
