"""Idempotent DDL for reviewing parsed report quantities (migration 0010_reading_review).

A parsed table row of a signed daily report is only a proposal (ingestion_jobs.result). A manager accepts, corrects or
rejects it; each decision is an immutable reading_reviews row, and an accepted or corrected value becomes the
observation that progress, alerts and evaluations read. Seeded observations keep review_id NULL.

Run directly with `python -m documents.readings_schema` (or `--downgrade`).
"""

from schema_util import add_constraint, grant, keep_revision, main

UPGRADE = [
    """CREATE TABLE IF NOT EXISTS sitemate.reading_reviews (
         project_id text NOT NULL REFERENCES sitemate.projects,
         id uuid NOT NULL DEFAULT gen_random_uuid(),
         source_id text NOT NULL, locator text NOT NULL, job_id uuid,
         activity_code text NOT NULL, work_date date NOT NULL, unit text NOT NULL,
         proposed_quantity numeric CHECK (proposed_quantity >= 0),
         basis text NOT NULL CHECK (basis IN ('signed','estimated')),
         decision text NOT NULL CHECK (decision IN ('accepted','corrected','rejected')),
         quantity numeric CHECK (quantity >= 0),
         reason text, reviewer_id text NOT NULL, decided_at timestamptz NOT NULL,
         supersedes_id uuid,
         created_at timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY (project_id, id),
         CHECK ((decision = 'rejected') = (quantity IS NULL)),
         CHECK (decision = 'accepted' OR nullif(trim(reason), '') IS NOT NULL),
         CHECK (id IS DISTINCT FROM supersedes_id),
         FOREIGN KEY (project_id, source_id, locator) REFERENCES sitemate.source_passages,
         FOREIGN KEY (project_id, activity_code) REFERENCES sitemate.activities,
         FOREIGN KEY (project_id, reviewer_id) REFERENCES sitemate.project_members,
         FOREIGN KEY (project_id, job_id) REFERENCES sitemate.ingestion_jobs,
         FOREIGN KEY (project_id, supersedes_id) REFERENCES sitemate.reading_reviews)""",
    """CREATE UNIQUE INDEX IF NOT EXISTS reading_reviews_supersedes
         ON sitemate.reading_reviews (project_id, supersedes_id) WHERE supersedes_id IS NOT NULL""",
    "CREATE INDEX IF NOT EXISTS reading_reviews_row ON sitemate.reading_reviews (project_id, source_id, locator)",
    keep_revision("reading_reviews"),
    """ALTER TABLE sitemate.observations ADD COLUMN IF NOT EXISTS accepted_by text,
         ADD COLUMN IF NOT EXISTS accepted_at timestamptz, ADD COLUMN IF NOT EXISTS review_id uuid""",
    add_constraint("observations", "observations_review_fkey",
                   "FOREIGN KEY (project_id, review_id) REFERENCES sitemate.reading_reviews"),
    grant("sitemate_reader", "SELECT", ("reading_reviews",)),
    grant("sitemate_ops", "SELECT", ("reading_reviews",)),
]

DOWNGRADE = [
    "ALTER TABLE sitemate.observations DROP CONSTRAINT IF EXISTS observations_review_fkey",
    """ALTER TABLE sitemate.observations DROP COLUMN IF EXISTS review_id, DROP COLUMN IF EXISTS accepted_at,
         DROP COLUMN IF EXISTS accepted_by""",
    "DROP TABLE IF EXISTS sitemate.reading_reviews",
]

if __name__ == "__main__":
    main(UPGRADE, DOWNGRADE, "reading review")
