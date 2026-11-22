"""Idempotent DDL for the project language (migration 0016_project_locale).

projects.locale chooses the language of drafts, templates and prompts: en-GB (default) or de-DE (the Munich field
pack, VOB/B notices).

Run directly with `python locale_schema.py` (or `--downgrade`).
"""

from schema_util import add_constraint, main

LOCALES = ("en-GB", "de-DE")

UPGRADE = [
    "ALTER TABLE sitemate.projects ADD COLUMN IF NOT EXISTS locale text NOT NULL DEFAULT 'en-GB'",
    add_constraint("projects", "projects_locale_check",
                   "CHECK (locale IN (" + ",".join(f"'{x}'" for x in LOCALES) + "))"),
]

DOWNGRADE = [
    "ALTER TABLE sitemate.projects DROP CONSTRAINT IF EXISTS projects_locale_check",
    "ALTER TABLE sitemate.projects DROP COLUMN IF EXISTS locale",
]

if __name__ == "__main__":
    main(UPGRADE, DOWNGRADE, "locale")
