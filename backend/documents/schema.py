"""Idempotent DDL for the documents module (used by migration 0005_documents).

Every statement can run twice, so the schema can be applied directly with
`python -m documents.schema` before the migration chain is complete, and the Alembic
migration later becomes a no-op that only records the version.
"""

UPGRADE = [
    "CREATE SCHEMA IF NOT EXISTS extensions",
    "CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions",
    # Content hash, display title and parser metadata (email headers, OCR details, review reasons).
    """ALTER TABLE sitemate.sources
         ADD COLUMN IF NOT EXISTS sha256 text CHECK (sha256 ~ '^[a-f0-9]{64}$'),
         ADD COLUMN IF NOT EXISTS title text,
         ADD COLUMN IF NOT EXISTS meta jsonb NOT NULL DEFAULT '{}',
         ADD COLUMN IF NOT EXISTS ingested_at timestamptz""",
    # Passage structure. `untrusted` marks external text a model must treat as quoted data.
    """ALTER TABLE sitemate.source_passages
         ADD COLUMN IF NOT EXISTS ordinal integer,
         ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'paragraph' CHECK (kind IN
             ('paragraph','heading','header','table_row','transcript','caption','record','metadata','ocr')),
         ADD COLUMN IF NOT EXISTS section text,
         ADD COLUMN IF NOT EXISTS untrusted boolean NOT NULL DEFAULT false,
         ADD COLUMN IF NOT EXISTS meta jsonb NOT NULL DEFAULT '{}',
         ADD COLUMN IF NOT EXISTS search tsvector GENERATED ALWAYS AS (
             setweight(to_tsvector('english', coalesce(section, '')), 'B') ||
             setweight(to_tsvector('english', excerpt), 'A')) STORED""",
    "CREATE INDEX IF NOT EXISTS source_passages_search ON sitemate.source_passages USING gin (search)",
    # Ambiguous OCR waits for a person; the job result keeps proposals, diffs and errors.
    "ALTER TABLE sitemate.ingestion_jobs DROP CONSTRAINT IF EXISTS ingestion_jobs_status_check",
    """ALTER TABLE sitemate.ingestion_jobs ADD CONSTRAINT ingestion_jobs_status_check
         CHECK (status IN ('queued','running','done','failed','needs_review'))""",
    "ALTER TABLE sitemate.ingestion_jobs ADD COLUMN IF NOT EXISTS result jsonb NOT NULL DEFAULT '{}'",
    """ALTER TABLE sitemate.action_items
         ADD COLUMN IF NOT EXISTS summary_version integer,
         ADD COLUMN IF NOT EXISTS quote text""",
    """DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'action_items_summary_fkey') THEN
           ALTER TABLE sitemate.action_items ADD CONSTRAINT action_items_summary_fkey
             FOREIGN KEY (project_id, source_id, summary_version) REFERENCES sitemate.document_summaries;
         END IF;
       END $$""",
]

DOWNGRADE = [
    "ALTER TABLE sitemate.action_items DROP CONSTRAINT IF EXISTS action_items_summary_fkey",
    "ALTER TABLE sitemate.action_items DROP COLUMN IF EXISTS summary_version, DROP COLUMN IF EXISTS quote",
    "UPDATE sitemate.ingestion_jobs SET status='failed' WHERE status='needs_review'",
    "ALTER TABLE sitemate.ingestion_jobs DROP CONSTRAINT IF EXISTS ingestion_jobs_status_check",
    "ALTER TABLE sitemate.ingestion_jobs DROP COLUMN IF EXISTS result",
    """ALTER TABLE sitemate.ingestion_jobs ADD CONSTRAINT ingestion_jobs_status_check
         CHECK (status IN ('queued','running','done','failed'))""",
    "DROP INDEX IF EXISTS sitemate.source_passages_search",
    """ALTER TABLE sitemate.source_passages DROP COLUMN IF EXISTS search, DROP COLUMN IF EXISTS meta,
         DROP COLUMN IF EXISTS untrusted, DROP COLUMN IF EXISTS section, DROP COLUMN IF EXISTS kind,
         DROP COLUMN IF EXISTS ordinal""",
    """ALTER TABLE sitemate.sources DROP COLUMN IF EXISTS sha256, DROP COLUMN IF EXISTS title,
         DROP COLUMN IF EXISTS meta, DROP COLUMN IF EXISTS ingested_at""",
]


def main():
    import sys

    from database import engine_for

    statements = DOWNGRADE if "--downgrade" in sys.argv else UPGRADE
    with engine_for("MIGRATION_DATABASE_URL").begin() as conn:
        for statement in statements:
            conn.exec_driver_sql(statement)
    print(f"Applied {len(statements)} documents schema statements.")


if __name__ == "__main__":
    main()
