"""Idempotent DDL for gap resolutions and the export audit (migration 0011_review_export_audit).

- draft_gap_resolutions: a manager fills a [MISSING: ...] field or omits it with a reason (template-permitted fields
  only). Each resolution creates a new draft version; this table is the immutable audit of who decided what.
- exports: an approved version is rendered once and stored; the row records the stored file, its SHA-256, size and
  who exported it, so every later download returns the identical bytes. .eml joins pdf and docx.

Run directly with `python review_schema.py` (or `--downgrade`).
"""

from schema_util import grant, keep_revision, main, replace_check

UPGRADE = [
    """CREATE TABLE IF NOT EXISTS sitemate.draft_gap_resolutions (
         project_id text NOT NULL, draft_id uuid NOT NULL, version integer NOT NULL,
         field text NOT NULL,
         resolution text NOT NULL CHECK (resolution IN ('filled','omitted')),
         value text, reason text,
         decided_by text NOT NULL, decided_at timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY (project_id, draft_id, version, field),
         CHECK (resolution <> 'filled' OR nullif(trim(value), '') IS NOT NULL),
         CHECK (resolution <> 'omitted' OR nullif(trim(reason), '') IS NOT NULL),
         FOREIGN KEY (project_id, draft_id, version) REFERENCES sitemate.draft_versions,
         FOREIGN KEY (project_id, decided_by) REFERENCES sitemate.project_members)""",
    keep_revision("draft_gap_resolutions"),
    *replace_check("exports", "exports_format_check", ("pdf", "docx", "eml"), "format", valid=True),
    """ALTER TABLE sitemate.exports ADD COLUMN IF NOT EXISTS created_by text,
         ADD COLUMN IF NOT EXISTS bytes integer CHECK (bytes > 0), ADD COLUMN IF NOT EXISTS filename text""",
    grant("sitemate_reader", "SELECT", ("draft_gap_resolutions", "exports")),
    grant("sitemate_ops", "SELECT", ("draft_gap_resolutions", "exports")),
]

DOWNGRADE = [
    "DELETE FROM sitemate.exports WHERE format = 'eml'",
    "ALTER TABLE sitemate.exports DROP COLUMN IF EXISTS filename, DROP COLUMN IF EXISTS bytes, DROP COLUMN IF EXISTS created_by",
    *replace_check("exports", "exports_format_check", ("pdf", "docx"), "format", valid=True),
    "DROP TABLE IF EXISTS sitemate.draft_gap_resolutions",
]

if __name__ == "__main__":
    main(UPGRADE, DOWNGRADE, "review and export")
