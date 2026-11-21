"""Add project-scoped capture, reporting, alert and notice workflows."""

from alembic import op

revision = "0002_workflows"
down_revision = "0001_riverside"
branch_labels = None
depends_on = None


def upgrade():
    # Scope all DDL and FK targets to the application's private schema.
    op.execute("SET LOCAL search_path TO sitemate, pg_catalog")
    op.execute("""ALTER TABLE projects ADD COLUMN sender text, ADD COLUMN sender_address text,
                  ADD COLUMN recipient text, ADD COLUMN recipient_address text,
                  ADD COLUMN contract_reference text, ADD COLUMN contract_clause text""")
    op.execute("""
        ALTER TABLE project_members ADD COLUMN role text NOT NULL DEFAULT 'viewer'
            CHECK (role IN ('viewer','contributor','manager','approver'))
    """)
    op.execute("""
        CREATE TABLE ingestion_jobs (
            project_id text, id uuid DEFAULT gen_random_uuid(), source_id text NOT NULL,
            stage text NOT NULL, status text NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','running','done','failed')),
            attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0), error text,
            created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (project_id,id), UNIQUE (project_id,source_id,stage),
            FOREIGN KEY (project_id,source_id) REFERENCES sources)
    """)
    op.execute("""
        CREATE TABLE incidents (
            project_id text REFERENCES projects, id uuid DEFAULT gen_random_uuid(),
            activity_code text, kind text NOT NULL, title text NOT NULL,
            occurred_at timestamptz NOT NULL, resolved_at timestamptz,
            CHECK (resolved_at IS NULL OR resolved_at >= occurred_at),
            PRIMARY KEY (project_id,id), FOREIGN KEY (project_id,activity_code) REFERENCES activities)
    """)
    op.execute("""
        CREATE TABLE capture_facts (
            project_id text, id uuid DEFAULT gen_random_uuid(), incident_id uuid,
            source_id text NOT NULL, locator text NOT NULL, field_name text NOT NULL, value jsonb NOT NULL,
            basis text NOT NULL CHECK (basis IN ('reported','inferred','estimated','forecast','signed')),
            review_status text NOT NULL DEFAULT 'proposed' CHECK (review_status IN ('proposed','confirmed','rejected')),
            effective_at timestamptz, supersedes_id uuid, reviewed_by text, reviewed_at timestamptz,
            CHECK (id IS DISTINCT FROM supersedes_id),
            CHECK ((review_status='proposed' AND reviewed_at IS NULL AND reviewed_by IS NULL)
                OR (review_status<>'proposed' AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL)),
            PRIMARY KEY (project_id,id), FOREIGN KEY (project_id,incident_id) REFERENCES incidents,
            FOREIGN KEY (project_id,source_id,locator) REFERENCES source_passages,
            FOREIGN KEY (project_id,supersedes_id) REFERENCES capture_facts,
            FOREIGN KEY (project_id,reviewed_by) REFERENCES project_members)
    """)
    op.execute("""
        CREATE TABLE fact_evidence (
            project_id text, fact_id uuid, source_id text, locator text,
            PRIMARY KEY (project_id,fact_id,source_id,locator),
            FOREIGN KEY (project_id,fact_id) REFERENCES capture_facts,
            FOREIGN KEY (project_id,source_id,locator) REFERENCES source_passages)
    """)
    op.execute("""
        ALTER TABLE observations ADD COLUMN incident_id uuid,
            ADD FOREIGN KEY (project_id,incident_id) REFERENCES incidents
    """)
    op.execute("""
        CREATE TABLE diary_entries (
            project_id text, id uuid DEFAULT gen_random_uuid(), incident_id uuid, work_date date NOT NULL,
            body text NOT NULL, source_id text NOT NULL, locator text NOT NULL, recorded_at timestamptz NOT NULL,
            PRIMARY KEY (project_id,id), FOREIGN KEY (project_id,incident_id) REFERENCES incidents,
            FOREIGN KEY (project_id,source_id,locator) REFERENCES source_passages)
    """)
    op.execute("""
        CREATE TABLE document_summaries (
            project_id text, source_id text, version integer CHECK (version > 0), as_of timestamptz NOT NULL,
            summary jsonb NOT NULL, PRIMARY KEY (project_id,source_id,version),
            FOREIGN KEY (project_id,source_id) REFERENCES sources)
    """)
    op.execute("""
        CREATE TABLE action_items (
            project_id text, id uuid DEFAULT gen_random_uuid(), description text NOT NULL,
            owner_name text, due_at timestamptz, completed_at timestamptz,
            source_id text NOT NULL, locator text NOT NULL, PRIMARY KEY (project_id,id),
            FOREIGN KEY (project_id,source_id,locator) REFERENCES source_passages)
    """)
    op.execute("""
        CREATE TABLE alerts (
            project_id text, id uuid DEFAULT gen_random_uuid(), activity_code text NOT NULL,
            checkpoint_at timestamptz NOT NULL, kind text NOT NULL,
            status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','dismissed','resolved')),
            PRIMARY KEY (project_id,id), UNIQUE (project_id,activity_code,checkpoint_at,kind),
            FOREIGN KEY (project_id,activity_code) REFERENCES activities)
    """)
    op.execute("""
        CREATE TABLE alert_revisions (
            project_id text, alert_id uuid, version integer CHECK (version > 0), as_of timestamptz NOT NULL,
            severity text NOT NULL CHECK (severity IN ('none','medium','high')),
            calculation jsonb NOT NULL, evidence_refs jsonb NOT NULL,
            PRIMARY KEY (project_id,alert_id,version), FOREIGN KEY (project_id,alert_id) REFERENCES alerts)
    """)
    op.execute("""
        CREATE TABLE drafts (
            project_id text REFERENCES projects, id uuid DEFAULT gen_random_uuid(), notice_type text NOT NULL,
            incident_id uuid, alert_id uuid, keywords text,
            CHECK (incident_id IS NOT NULL OR alert_id IS NOT NULL OR nullif(trim(keywords),'') IS NOT NULL),
            PRIMARY KEY (project_id,id), UNIQUE (project_id,id,alert_id),
            UNIQUE (project_id,alert_id,notice_type),
            FOREIGN KEY (project_id,incident_id) REFERENCES incidents,
            FOREIGN KEY (project_id,alert_id) REFERENCES alerts)
    """)
    op.execute("""
        CREATE TABLE draft_versions (
            project_id text, draft_id uuid, version integer CHECK (version > 0), as_of timestamptz NOT NULL,
            body text NOT NULL, evidence_refs jsonb NOT NULL, missing_fields jsonb NOT NULL DEFAULT '[]',
            alert_id uuid, alert_version integer, CHECK ((alert_id IS NULL) = (alert_version IS NULL)),
            PRIMARY KEY (project_id,draft_id,version), FOREIGN KEY (project_id,draft_id) REFERENCES drafts,
            FOREIGN KEY (project_id,draft_id,alert_id) REFERENCES drafts(project_id,id,alert_id),
            FOREIGN KEY (project_id,alert_id,alert_version) REFERENCES alert_revisions)
    """)
    op.execute("""
        CREATE TABLE reviews (
            project_id text, draft_id uuid, version integer, reviewer_id text NOT NULL,
            decision text NOT NULL CHECK (decision IN ('approved','changes_requested')),
            reason text, decided_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (project_id,draft_id,version), UNIQUE (project_id,draft_id,version,decision),
            FOREIGN KEY (project_id,draft_id,version) REFERENCES draft_versions,
            FOREIGN KEY (project_id,reviewer_id) REFERENCES project_members)
    """)
    op.execute("""
        CREATE TABLE exports (
            project_id text, draft_id uuid, version integer, format text CHECK (format IN ('pdf','docx')),
            decision text NOT NULL DEFAULT 'approved' CHECK (decision='approved'),
            storage_key text NOT NULL, sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
            created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (project_id,draft_id,version,format),
            FOREIGN KEY (project_id,draft_id,version,decision) REFERENCES reviews(project_id,draft_id,version,decision))
    """)
    op.execute("""
        CREATE FUNCTION sitemate.validate_reviewer() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM sitemate.project_members WHERE project_id=NEW.project_id
                AND member_id=NEW.reviewer_id AND role IN ('manager','approver')) THEN
                RAISE EXCEPTION 'Reviewer requires project approval privileges' USING ERRCODE='23514';
            END IF;
            RETURN NEW;
        END $$
    """)
    op.execute("""CREATE TRIGGER check_reviewer BEFORE INSERT ON reviews
                  FOR EACH ROW EXECUTE FUNCTION sitemate.validate_reviewer()""")
    op.execute("""
        CREATE FUNCTION sitemate.keep_revision() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'Create a new revision to change workflow history' USING ERRCODE='23514';
        END $$
    """)
    for table in ("draft_versions", "reviews", "alert_revisions"):
        op.execute(f"CREATE TRIGGER keep_revision BEFORE UPDATE OR DELETE ON {table} "
                   "FOR EACH ROW EXECUTE FUNCTION sitemate.keep_revision()")


def downgrade():
    op.execute("SET LOCAL search_path TO sitemate, pg_catalog")
    for table in ("exports", "reviews", "draft_versions", "drafts", "alert_revisions", "alerts",
                  "action_items", "document_summaries", "diary_entries", "fact_evidence", "capture_facts"):
        op.drop_table(table, schema="sitemate")
    op.execute("ALTER TABLE observations DROP COLUMN incident_id")
    op.drop_table("incidents", schema="sitemate")
    op.drop_table("ingestion_jobs", schema="sitemate")
    op.execute("ALTER TABLE project_members DROP COLUMN role")
    op.execute("""ALTER TABLE projects DROP COLUMN sender, DROP COLUMN sender_address,
                  DROP COLUMN recipient, DROP COLUMN recipient_address,
                  DROP COLUMN contract_reference, DROP COLUMN contract_clause""")
    op.execute("DROP FUNCTION sitemate.validate_reviewer()")
    op.execute("DROP FUNCTION sitemate.keep_revision()")
