"""Idempotent DDL for automatic correspondence and project settings (migration 0013_auto_correspondence).

- drafts.origin: how a draft started. manual (a manager clicked Draft), keywords (Write with SiteMate), alert_auto
  (created by the worker for a qualifying deviation; private until the manager submits it), suggestion, daily_report.
- projects.settings: project-level options that do not depend on a baseline: auto_draft, approval_roles,
  notice_templates (per-type template overrides) and daily_report.auto_at.
- Notice types: the additional-cost notice has one name, additional_cost_notice (Write with SiteMate used
  additional_cost). The CHECK is validated after the rename.
- Alert kind instruction_concern: a concern about an instruction or design problem found in the day summary, so a
  notice of concern can be drafted from an alert like every other suggestion.

Run directly with `python drafting_schema.py` (or `--downgrade`).
"""

from schema_util import main, replace_check

ORIGINS = ("manual", "keywords", "alert_auto", "suggestion", "daily_report")
NOTICE_TYPES = ("delay_notice", "incident_notice", "additional_cost_notice", "defect_notice", "notice_of_concern",
                "email")
NOTICE_TYPES_0009 = NOTICE_TYPES + ("additional_cost",)
ALERT_KINDS_0009 = ("shortfall", "incident", "late_start", "equipment_idle", "missing_report", "quality_hold")
ALERT_KINDS = ALERT_KINDS_0009 + ("instruction_concern",)
_types = ",".join(f"'{t}'" for t in NOTICE_TYPES)

UPGRADE = [
    "ALTER TABLE sitemate.drafts ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'manual'",
    "UPDATE sitemate.drafts SET origin = 'keywords' WHERE request IS NOT NULL AND origin = 'manual'",
    *replace_check("drafts", "drafts_origin_check", ORIGINS, "origin", valid=True),
    "ALTER TABLE sitemate.projects ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'",
    # The rename cannot collide with UNIQUE (project_id, alert_id, notice_type): Write with SiteMate drafts have no
    # alert. Stop loudly if that ever stops being true instead of failing on the unique index halfway.
    """DO $$ BEGIN
         IF EXISTS (SELECT 1 FROM sitemate.drafts WHERE notice_type = 'additional_cost' AND alert_id IS NOT NULL) THEN
           RAISE EXCEPTION 'additional_cost drafts with an alert exist; resolve them before migrating';
         END IF;
       END $$""",
    "UPDATE sitemate.drafts SET notice_type = 'additional_cost_notice' WHERE notice_type = 'additional_cost'",
    f"""DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM sitemate.drafts WHERE notice_type NOT IN ({_types})) THEN
            RAISE EXCEPTION 'drafts with an unknown notice_type exist; fix them before migrating';
          END IF;
        END $$""",
    *replace_check("drafts", "drafts_notice_type_check", NOTICE_TYPES, "notice_type", valid=True),
    *replace_check("alerts", "alerts_kind_check", ALERT_KINDS, "kind"),
]

DOWNGRADE = [
    *replace_check("drafts", "drafts_notice_type_check", NOTICE_TYPES_0009, "notice_type"),
    "UPDATE sitemate.drafts SET notice_type = 'additional_cost' WHERE notice_type = 'additional_cost_notice' AND request IS NOT NULL",
    *replace_check("alerts", "alerts_kind_check", ALERT_KINDS_0009, "kind"),
    "ALTER TABLE sitemate.projects DROP COLUMN IF EXISTS settings",
    "ALTER TABLE sitemate.drafts DROP CONSTRAINT IF EXISTS drafts_origin_check",
    "ALTER TABLE sitemate.drafts DROP COLUMN IF EXISTS origin",
]

if __name__ == "__main__":
    main(UPGRADE, DOWNGRADE, "auto correspondence")
