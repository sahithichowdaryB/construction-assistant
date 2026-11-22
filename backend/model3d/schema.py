"""Idempotent DDL for the 3D progress model (used by migration 0010_model3d).

Every statement can run twice, so the schema can be applied directly with `python -m model3d.schema`
and the Alembic migration then only records the version. `--downgrade` removes it again.

Tables (all in the private `sitemate` schema):
    building_models   one row per uploaded drawing set revision (draft -> active -> superseded), with the deadline
    model_pours       the pours of the active revision (activity, order, planned date, m3, grid range)
    model_elements    the generated 3D elements (box in metres) and the pour each one belongs to
    element_progress  status and % per pour for a date, read from observations/events; versioned, never overwritten
"""

UPGRADE = [
    """CREATE TABLE IF NOT EXISTS sitemate.building_models (
         project_id text NOT NULL REFERENCES sitemate.projects,
         id uuid NOT NULL DEFAULT gen_random_uuid(),
         revision integer NOT NULL CHECK (revision > 0),
         status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','superseded')),
         extraction_status text NOT NULL DEFAULT 'done'
             CHECK (extraction_status IN ('queued','running','done','needs_review','failed')),
         title text,
         source_ids text[] NOT NULL DEFAULT '{}',
         spec jsonb NOT NULL DEFAULT '{}',
         review_reasons jsonb NOT NULL DEFAULT '[]',
         deadline date,
         model text, error text,
         created_by text, created_at timestamptz NOT NULL DEFAULT now(),
         as_of timestamptz NOT NULL DEFAULT now(),
         activated_by text, activated_at timestamptz,
         PRIMARY KEY (project_id, id), UNIQUE (project_id, revision),
         CHECK (status = 'draft' OR (activated_at IS NOT NULL AND deadline IS NOT NULL)))""",
    """CREATE UNIQUE INDEX IF NOT EXISTS building_models_one_active
         ON sitemate.building_models (project_id) WHERE status = 'active'""",
    """CREATE TABLE IF NOT EXISTS sitemate.model_pours (
         project_id text NOT NULL, model_id uuid NOT NULL, pour_id text NOT NULL,
         activity_code text NOT NULL, seq integer NOT NULL, kind text NOT NULL,
         planned_date date, m3 numeric NOT NULL CHECK (m3 >= 0),
         x_from numeric, x_to numeric, refs jsonb NOT NULL DEFAULT '[]',
         PRIMARY KEY (project_id, model_id, pour_id),
         FOREIGN KEY (project_id, model_id) REFERENCES sitemate.building_models)""",
    """CREATE TABLE IF NOT EXISTS sitemate.model_elements (
         project_id text NOT NULL, model_id uuid NOT NULL, element_id text NOT NULL,
         kind text NOT NULL, level text NOT NULL, activity_code text NOT NULL, pour_id text NOT NULL,
         mark text, box jsonb NOT NULL, volume_m3 numeric NOT NULL,
         PRIMARY KEY (project_id, model_id, element_id),
         FOREIGN KEY (project_id, model_id, pour_id) REFERENCES sitemate.model_pours)""",
    """CREATE TABLE IF NOT EXISTS sitemate.element_progress (
         project_id text NOT NULL, model_id uuid NOT NULL, work_date date NOT NULL,
         version integer NOT NULL CHECK (version > 0), pour_id text NOT NULL,
         status text NOT NULL CHECK (status IN ('built','in_progress','not_started')),
         pct numeric NOT NULL CHECK (pct BETWEEN 0 AND 100), done_m3 numeric NOT NULL DEFAULT 0,
         basis text CHECK (basis IN ('signed','estimated','event')),
         refs jsonb NOT NULL DEFAULT '[]', as_of timestamptz NOT NULL, input_digest text NOT NULL,
         created_at timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY (project_id, model_id, work_date, version, pour_id),
         FOREIGN KEY (project_id, model_id, pour_id) REFERENCES sitemate.model_pours)""",
    """CREATE INDEX IF NOT EXISTS element_progress_latest
         ON sitemate.element_progress (project_id, model_id, work_date, version DESC)""",
    # Progress results are versioned: a recompute adds a version, never changes one (same trigger as performance).
    """DO $$ BEGIN
         IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'keep_revision')
            AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'keep_revision'
                            AND tgrelid = 'sitemate.element_progress'::regclass) THEN
           CREATE TRIGGER keep_revision BEFORE UPDATE OR DELETE ON sitemate.element_progress
             FOR EACH ROW EXECUTE FUNCTION sitemate.keep_revision();
         END IF;
       END $$""",
    """DO $$ BEGIN
         IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sitemate_reader') THEN
           GRANT SELECT ON sitemate.building_models, sitemate.model_pours, sitemate.model_elements,
                           sitemate.element_progress TO sitemate_reader;
         END IF;
       END $$""",
]

DOWNGRADE = [
    "DROP TABLE IF EXISTS sitemate.element_progress",
    "DROP TABLE IF EXISTS sitemate.model_elements",
    "DROP TABLE IF EXISTS sitemate.model_pours",
    "DROP TABLE IF EXISTS sitemate.building_models",
]

TABLES = ("building_models", "model_pours", "model_elements", "element_progress")


def main():
    import sys

    from database import engine_for

    statements = DOWNGRADE if "--downgrade" in sys.argv else UPGRADE
    with engine_for("MIGRATION_DATABASE_URL").begin() as conn:
        for statement in statements:
            conn.exec_driver_sql(statement)
    print(f"Applied {len(statements)} 3D model schema statements.")


if __name__ == "__main__":
    main()
