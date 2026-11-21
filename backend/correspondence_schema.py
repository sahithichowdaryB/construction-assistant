"""Idempotent DDL for "Write with SiteMate" (used by migration 0009_correspondence).

- drafts gains the manager's request, the chosen recipient, the agent's analysis and the time the
  manager sent it for approval (agent drafts stay private until then).
- cost_settings / cost_rates hold the rates the manager enters in Settings. Cost lines are only
  calculated from these; a missing rate is shown as missing, never estimated.

Run directly with `python correspondence_schema.py` (or `--downgrade`).
"""

UPGRADE = [
    """ALTER TABLE sitemate.drafts
         ADD COLUMN IF NOT EXISTS request jsonb,
         ADD COLUMN IF NOT EXISTS recipient jsonb,
         ADD COLUMN IF NOT EXISTS analysis jsonb,
         ADD COLUMN IF NOT EXISTS created_by text,
         ADD COLUMN IF NOT EXISTS submitted_at timestamptz""",
    """CREATE TABLE IF NOT EXISTS sitemate.cost_settings (
         project_id text PRIMARY KEY REFERENCES sitemate.projects(id),
         currency text NOT NULL DEFAULT 'EUR' CHECK (currency ~ '^[A-Z]{3}$'),
         shift_start time NOT NULL DEFAULT '07:00',
         shift_end time NOT NULL DEFAULT '17:30',
         updated_by text,
         updated_at timestamptz NOT NULL DEFAULT now(),
         CHECK (shift_end > shift_start))""",
    """CREATE TABLE IF NOT EXISTS sitemate.cost_rates (
         project_id text NOT NULL REFERENCES sitemate.projects(id),
         key text NOT NULL CHECK (key ~ '^(labour|overhead|equipment:[A-Za-z0-9-]+)$'),
         label text NOT NULL,
         unit text NOT NULL CHECK (unit IN ('worker-hour', 'hour', 'day')),
         amount numeric(12, 2) CHECK (amount >= 0),
         is_example boolean NOT NULL DEFAULT false,
         updated_by text,
         updated_at timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY (project_id, key))""",
    """DO $$ BEGIN
         IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sitemate_reader') THEN
           GRANT SELECT ON sitemate.cost_settings, sitemate.cost_rates TO sitemate_reader;
         END IF;
       END $$""",
]

DOWNGRADE = [
    "DROP TABLE IF EXISTS sitemate.cost_rates",
    "DROP TABLE IF EXISTS sitemate.cost_settings",
    """ALTER TABLE sitemate.drafts DROP COLUMN IF EXISTS submitted_at, DROP COLUMN IF EXISTS created_by,
         DROP COLUMN IF EXISTS analysis, DROP COLUMN IF EXISTS recipient, DROP COLUMN IF EXISTS request""",
]


def main():
    import sys

    from database import engine_for

    statements = DOWNGRADE if "--downgrade" in sys.argv else UPGRADE
    with engine_for("MIGRATION_DATABASE_URL").begin() as conn:
        for statement in statements:
            conn.exec_driver_sql(statement)
    print(f"Applied {len(statements)} correspondence schema statements.")


if __name__ == "__main__":
    main()
