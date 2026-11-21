"""Capture -> event -> incident -> alert/action pipeline (categories, events, grouping, severity, jobs)."""

import json
from pathlib import Path

import sqlalchemy as sa
from alembic import op

revision = "0005_event_pipeline"
down_revision = "0005_documents"
branch_labels = None
depends_on = None

TAXONOMY = Path(__file__).resolve().parents[2] / "rules/event_taxonomy.json"
SEVERITIES = "'low','medium','high','critical'"


def upgrade():
    op.execute("SET LOCAL search_path TO sitemate, pg_catalog")

    # ---- reference tables ------------------------------------------------------------------------------
    op.execute(f"""
        CREATE TABLE event_categories (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            project_id text REFERENCES projects,           -- NULL = global default
            key text NOT NULL, label text NOT NULL, description text NOT NULL DEFAULT '', icon text,
            creates_incident boolean NOT NULL, default_severity text CHECK (default_severity IN ({SEVERITIES})),
            group_window_hours integer NOT NULL DEFAULT 24,
            grouping_fields text[] NOT NULL DEFAULT '{{}}', required_fields text[] NOT NULL DEFAULT '{{}}',
            playbook jsonb NOT NULL DEFAULT '{{}}', active boolean NOT NULL DEFAULT true,
            sort_order integer NOT NULL DEFAULT 100)
    """)
    op.execute("CREATE UNIQUE INDEX event_categories_key ON event_categories (coalesce(project_id,''), key)")
    op.execute(f"""
        CREATE TABLE event_types (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            project_id text REFERENCES projects,
            key text NOT NULL, category_key text NOT NULL, label text NOT NULL,
            severity_hint text CHECK (severity_hint IN ({SEVERITIES})), active boolean NOT NULL DEFAULT true)
    """)
    op.execute("CREATE UNIQUE INDEX event_types_key ON event_types (coalesce(project_id,''), key)")

    # ---- captures --------------------------------------------------------------------------------------
    op.execute("""
        CREATE TABLE captures (
            project_id text, id uuid DEFAULT gen_random_uuid(), source_id text NOT NULL, thread_id text NOT NULL,
            captured_by text NOT NULL, channel text NOT NULL CHECK (channel IN ('voice','photo','text','mixed')),
            raw_text text, transcript text, recorded_at timestamptz NOT NULL, zone_hint text,
            status text NOT NULL DEFAULT 'processing' CHECK (status IN
                ('processing','needs_category','needs_input','saved','no_events','failed')),
            created_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (project_id,id), UNIQUE (project_id,source_id), UNIQUE (project_id,thread_id),
            FOREIGN KEY (project_id,source_id) REFERENCES sources,
            FOREIGN KEY (project_id,captured_by) REFERENCES project_members)
    """)
    op.execute("""
        CREATE TABLE capture_attachments (
            project_id text, id uuid DEFAULT gen_random_uuid(), capture_id uuid NOT NULL, source_id text NOT NULL,
            kind text NOT NULL CHECK (kind IN ('audio','image','file')), storage_key text NOT NULL,
            mime text, bytes integer, sha256 text, passage_locator text,
            created_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (project_id,id), FOREIGN KEY (project_id,capture_id) REFERENCES captures,
            FOREIGN KEY (project_id,source_id) REFERENCES sources)
    """)

    # ---- incidents: new columns ------------------------------------------------------------------------
    op.execute(f"""
        ALTER TABLE incidents
            ADD COLUMN category text, ADD COLUMN event_type text, ADD COLUMN summary text, ADD COLUMN zone text,
            ADD COLUMN asset_key text,
            ADD COLUMN status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','monitoring','resolved','closed')),
            ADD COLUMN severity text CHECK (severity IN ({SEVERITIES})),
            ADD COLUMN severity_version integer NOT NULL DEFAULT 0,
            ADD COLUMN first_reported_at timestamptz, ADD COLUMN last_reported_at timestamptz,
            ADD COLUMN report_count integer NOT NULL DEFAULT 1, ADD COLUMN reporter_count integer NOT NULL DEFAULT 1,
            ADD COLUMN cluster_key text, ADD COLUMN merged_into_id uuid, ADD COLUMN recurrence_of_id uuid,
            ADD FOREIGN KEY (project_id,merged_into_id) REFERENCES incidents,
            ADD FOREIGN KEY (project_id,recurrence_of_id) REFERENCES incidents
    """)
    op.execute("""
        UPDATE incidents SET status = CASE WHEN resolved_at IS NOT NULL THEN 'resolved' ELSE 'open' END,
            category = CASE kind WHEN 'equipment_failure' THEN 'equipment' WHEN 'delivery_delay' THEN 'delivery'
                                 WHEN 'quality_observation' THEN 'quality' WHEN 'safety_incident' THEN 'safety'
                                 ELSE 'general' END,
            event_type = kind, summary = title, first_reported_at = occurred_at, last_reported_at = occurred_at
    """)
    op.execute("""
        CREATE UNIQUE INDEX incidents_open_cluster ON incidents (project_id, cluster_key)
        WHERE status IN ('open','monitoring') AND merged_into_id IS NULL AND cluster_key IS NOT NULL
    """)
    op.execute("CREATE INDEX incidents_group ON incidents (project_id, category, asset_key, last_reported_at)")

    # ---- events ----------------------------------------------------------------------------------------
    op.execute(f"""
        CREATE TABLE events (
            project_id text, id uuid DEFAULT gen_random_uuid(), capture_id uuid NOT NULL, source_id text NOT NULL,
            locator text NOT NULL, event_index integer NOT NULL, recorded_by text NOT NULL,
            occurred_at timestamptz NOT NULL, recorded_at timestamptz NOT NULL,
            suggested_category text, suggested_event_type text,
            suggestion_confidence numeric(4,3) CHECK (suggestion_confidence BETWEEN 0 AND 1),
            suggestion_rationale text, suggestion_alternatives jsonb NOT NULL DEFAULT '[]',
            category text, event_type text, confirmed_by text, confirmed_at timestamptz,
            summary text NOT NULL, zone text, activity_code text, equipment_id text, asset_key text,
            workers_affected integer, injured_count integer, attributes jsonb NOT NULL DEFAULT '{{}}',
            status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('suggested','confirmed','rejected')),
            incident_id uuid,
            PRIMARY KEY (project_id,id), UNIQUE (project_id,capture_id,event_index),
            FOREIGN KEY (project_id,capture_id) REFERENCES captures,
            FOREIGN KEY (project_id,source_id) REFERENCES sources,
            FOREIGN KEY (project_id,recorded_by) REFERENCES project_members,
            FOREIGN KEY (project_id,incident_id) REFERENCES incidents)
    """)
    op.execute("CREATE INDEX events_group ON events (project_id, category, asset_key, occurred_at)")
    op.execute("CREATE INDEX events_incident ON events (project_id, incident_id)")

    op.execute("""
        CREATE TABLE incident_events (
            project_id text, incident_id uuid, event_id uuid,
            link_type text NOT NULL CHECK (link_type IN ('origin','corroborating','update','resolution','contradicting')),
            match_score numeric(4,3), match_reason text, linked_by text NOT NULL DEFAULT 'agent',
            linked_at timestamptz NOT NULL DEFAULT now(), unlinked_at timestamptz,
            PRIMARY KEY (project_id,incident_id,event_id),
            FOREIGN KEY (project_id,incident_id) REFERENCES incidents,
            FOREIGN KEY (project_id,event_id) REFERENCES events)
    """)
    op.execute("CREATE INDEX incident_events_event ON incident_events (project_id, event_id)")

    op.execute(f"""
        CREATE TABLE incident_severity_history (
            project_id text, incident_id uuid, version integer CHECK (version > 0),
            severity text NOT NULL CHECK (severity IN ({SEVERITIES})), rule_basis jsonb NOT NULL DEFAULT '{{}}',
            llm_adjustment integer NOT NULL DEFAULT 0 CHECK (llm_adjustment BETWEEN -1 AND 1), reason text,
            trigger_event_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (project_id,incident_id,version), FOREIGN KEY (project_id,incident_id) REFERENCES incidents)
    """)
    op.execute("CREATE TRIGGER keep_revision BEFORE UPDATE OR DELETE ON incident_severity_history "
               "FOR EACH ROW EXECUTE FUNCTION sitemate.keep_revision()")

    # ---- alerts ----------------------------------------------------------------------------------------
    op.execute("ALTER TABLE alerts ALTER COLUMN activity_code DROP NOT NULL")
    op.execute("ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_status_check")
    op.execute("""
        ALTER TABLE alerts ADD COLUMN incident_id uuid, ADD COLUMN title text, ADD COLUMN assigned_to text,
            ADD COLUMN acknowledged_by text, ADD COLUMN acknowledged_at timestamptz,
            ADD COLUMN resolved_by text, ADD COLUMN resolved_at timestamptz,
            ADD CONSTRAINT alerts_status_check CHECK (status IN
                ('open','acknowledged','in_progress','resolved','dismissed')),
            ADD FOREIGN KEY (project_id,incident_id) REFERENCES incidents
    """)
    op.execute("CREATE UNIQUE INDEX alerts_one_per_incident ON alerts (project_id, incident_id) WHERE kind='incident'")
    op.execute("ALTER TABLE alert_revisions DROP CONSTRAINT IF EXISTS alert_revisions_severity_check")
    op.execute("""
        ALTER TABLE alert_revisions
            ADD CONSTRAINT alert_revisions_severity_check CHECK (severity IN ('none','low','medium','high','critical')),
            ADD COLUMN reason text, ADD COLUMN analysis_id uuid
    """)
    op.execute("""
        CREATE TABLE alert_activity (
            project_id text, id uuid DEFAULT gen_random_uuid(), alert_id uuid NOT NULL, actor text NOT NULL,
            action text NOT NULL, from_status text, to_status text, note text,
            at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (project_id,id), FOREIGN KEY (project_id,alert_id) REFERENCES alerts)
    """)

    # ---- action items (reused) -------------------------------------------------------------------------
    op.execute("ALTER TABLE action_items ALTER COLUMN source_id DROP NOT NULL, ALTER COLUMN locator DROP NOT NULL")
    op.execute("""
        ALTER TABLE action_items
            ADD COLUMN alert_id uuid, ADD COLUMN incident_id uuid, ADD COLUMN analysis_id uuid,
            ADD COLUMN action_type text, ADD COLUMN title text, ADD COLUMN rationale text,
            ADD COLUMN owner_role text, ADD COLUMN contractor_id text,
            ADD COLUMN priority text CHECK (priority IN ('low','medium','high','urgent')),
            ADD COLUMN evidence_refs jsonb NOT NULL DEFAULT '[]',
            ADD COLUMN status text NOT NULL DEFAULT 'proposed' CHECK (status IN
                ('proposed','approved','in_progress','done','rejected','superseded')),
            ADD COLUMN proposed_by text NOT NULL DEFAULT 'member', ADD COLUMN decided_by text,
            ADD COLUMN decided_at timestamptz, ADD COLUMN executed_at timestamptz, ADD COLUMN result jsonb,
            ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
            ADD FOREIGN KEY (project_id,alert_id) REFERENCES alerts,
            ADD FOREIGN KEY (project_id,incident_id) REFERENCES incidents,
            ADD FOREIGN KEY (project_id,analysis_id) REFERENCES incident_analyses
    """)
    op.execute("CREATE INDEX action_items_alert ON action_items (project_id, alert_id, status)")

    # ---- async work ------------------------------------------------------------------------------------
    op.execute("""
        CREATE TABLE agent_jobs (
            project_id text, id uuid DEFAULT gen_random_uuid(), kind text NOT NULL CHECK (kind IN
                ('reasoning','plan_actions','escalation_check','auto_resolve')),
            incident_id uuid, payload jsonb NOT NULL DEFAULT '{}',
            status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
            attempts integer NOT NULL DEFAULT 0, run_after timestamptz NOT NULL DEFAULT now(), last_error text,
            created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (project_id,id), FOREIGN KEY (project_id,incident_id) REFERENCES incidents)
    """)
    op.execute("CREATE UNIQUE INDEX agent_jobs_debounce ON agent_jobs (project_id, kind, incident_id) "
               "WHERE status='queued'")
    op.execute("CREATE INDEX agent_jobs_ready ON agent_jobs (status, run_after)")
    op.execute("""
        CREATE TABLE agent_runs (
            project_id text, id uuid DEFAULT gen_random_uuid(), agent text NOT NULL, capture_id uuid,
            incident_id uuid, model text, input_digest text, output jsonb, status text NOT NULL DEFAULT 'ok',
            latency_ms integer, created_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (project_id,id))
    """)

    # ---- seed taxonomy ---------------------------------------------------------------------------------
    taxonomy = json.loads(TAXONOMY.read_text(encoding="utf8"))
    conn = op.get_bind()
    for c in taxonomy["categories"]:
        conn.execute(sa.text("""
            INSERT INTO sitemate.event_categories (key,label,description,icon,creates_incident,default_severity,
                group_window_hours,grouping_fields,required_fields,playbook,sort_order)
            VALUES (:key,:label,:description,:icon,:creates_incident,:default_severity,:group_window_hours,
                    :grouping_fields,:required_fields,CAST(:playbook AS jsonb),:sort_order)
        """), {**c, "playbook": json.dumps(c["playbook"])})
    for t in taxonomy["types"]:
        conn.execute(sa.text("""
            INSERT INTO sitemate.event_types (key,category_key,label,severity_hint)
            VALUES (:key,:category,:label,:severity_hint)
        """), t)


def downgrade():
    op.execute("SET LOCAL search_path TO sitemate, pg_catalog")
    for table in ("agent_runs", "agent_jobs"):
        op.drop_table(table, schema="sitemate")
    op.execute("""
        ALTER TABLE action_items DROP COLUMN alert_id, DROP COLUMN incident_id, DROP COLUMN analysis_id,
            DROP COLUMN action_type, DROP COLUMN title, DROP COLUMN rationale, DROP COLUMN owner_role,
            DROP COLUMN contractor_id, DROP COLUMN priority, DROP COLUMN evidence_refs, DROP COLUMN status,
            DROP COLUMN proposed_by, DROP COLUMN decided_by, DROP COLUMN decided_at, DROP COLUMN executed_at,
            DROP COLUMN result, DROP COLUMN created_at
    """)
    op.drop_table("alert_activity", schema="sitemate")
    op.execute("ALTER TABLE alert_revisions DROP COLUMN reason, DROP COLUMN analysis_id")
    op.execute("ALTER TABLE alert_revisions DROP CONSTRAINT IF EXISTS alert_revisions_severity_check")
    op.execute("ALTER TABLE alert_revisions ADD CONSTRAINT alert_revisions_severity_check "
               "CHECK (severity IN ('none','medium','high'))")
    op.execute("DROP INDEX IF EXISTS alerts_one_per_incident")
    op.execute("DELETE FROM alerts WHERE kind='incident'")
    op.execute("""
        ALTER TABLE alerts DROP COLUMN incident_id, DROP COLUMN title, DROP COLUMN assigned_to,
            DROP COLUMN acknowledged_by, DROP COLUMN acknowledged_at, DROP COLUMN resolved_by,
            DROP COLUMN resolved_at, DROP CONSTRAINT IF EXISTS alerts_status_check
    """)
    op.execute("ALTER TABLE alerts ADD CONSTRAINT alerts_status_check CHECK (status IN ('open','dismissed','resolved'))")
    op.execute("DROP TRIGGER IF EXISTS keep_revision ON incident_severity_history")
    for table in ("incident_severity_history", "incident_events", "events"):
        op.drop_table(table, schema="sitemate")
    op.execute("DROP INDEX IF EXISTS incidents_open_cluster")
    op.execute("DROP INDEX IF EXISTS incidents_group")
    op.execute("""
        ALTER TABLE incidents DROP COLUMN category, DROP COLUMN event_type, DROP COLUMN summary, DROP COLUMN zone,
            DROP COLUMN asset_key, DROP COLUMN status, DROP COLUMN severity, DROP COLUMN severity_version,
            DROP COLUMN first_reported_at, DROP COLUMN last_reported_at, DROP COLUMN report_count,
            DROP COLUMN reporter_count, DROP COLUMN cluster_key, DROP COLUMN merged_into_id,
            DROP COLUMN recurrence_of_id
    """)
    for table in ("capture_attachments", "captures", "event_types", "event_categories"):
        op.drop_table(table, schema="sitemate")
