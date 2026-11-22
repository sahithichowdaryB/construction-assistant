"""Idempotent DDL for appointments and daily report drafts (migration 0014_daily_reports).

- appointments: meetings, inspections, hold points, deliveries, visits and deadlines for a day. Rows are immutable;
  an edit, a move or a cancellation is a new row that supersedes the old one. An appointment extracted from the
  records cites its passage. available_at keeps the replay clock honest.
- drafts.work_date and notice_type 'daily_report': one daily report draft per project and day (it goes through the
  same version, review and export flow as notices). The drafts CHECK (incident, alert or keywords) is unchanged:
  daily reports carry keywords 'daily report <date>'.

Run directly with `python -m daily_report.schema` (or `--downgrade`).
"""

from schema_util import grant, keep_revision, main, replace_check

KINDS = ("meeting", "inspection", "hold_point", "delivery", "visit", "deadline", "other")
ORIGINS = ("manual", "extracted", "ics", "seed")
NOTICE_TYPES_0013 = ("delay_notice", "incident_notice", "additional_cost_notice", "defect_notice", "notice_of_concern",
                     "email")
NOTICE_TYPES = NOTICE_TYPES_0013 + ("daily_report",)
_kinds = ",".join(f"'{k}'" for k in KINDS)
_origins = ",".join(f"'{o}'" for o in ORIGINS)

UPGRADE = [
    f"""CREATE TABLE IF NOT EXISTS sitemate.appointments (
          project_id text NOT NULL REFERENCES sitemate.projects,
          id uuid NOT NULL DEFAULT gen_random_uuid(),
          kind text NOT NULL CHECK (kind IN ({_kinds})),
          title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
          starts_at timestamptz NOT NULL, ends_at timestamptz,
          location text, activity_code text,
          attendees jsonb NOT NULL DEFAULT '[]',
          status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','held','cancelled','moved')),
          origin text NOT NULL CHECK (origin IN ({_origins})),
          source_id text, locator text,
          supersedes_id uuid,
          created_by text NOT NULL,
          available_at timestamptz NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (project_id, id),
          CHECK (ends_at IS NULL OR ends_at >= starts_at),
          CHECK (origin <> 'extracted' OR (source_id IS NOT NULL AND locator IS NOT NULL)),
          CHECK (id IS DISTINCT FROM supersedes_id),
          FOREIGN KEY (project_id, activity_code) REFERENCES sitemate.activities,
          FOREIGN KEY (project_id, source_id, locator) REFERENCES sitemate.source_passages,
          FOREIGN KEY (project_id, supersedes_id) REFERENCES sitemate.appointments)""",
    """CREATE UNIQUE INDEX IF NOT EXISTS appointments_supersedes
         ON sitemate.appointments (project_id, supersedes_id) WHERE supersedes_id IS NOT NULL""",
    "CREATE INDEX IF NOT EXISTS appointments_day ON sitemate.appointments (project_id, starts_at)",
    keep_revision("appointments"),
    "ALTER TABLE sitemate.drafts ADD COLUMN IF NOT EXISTS work_date date",
    """CREATE UNIQUE INDEX IF NOT EXISTS drafts_daily_report
         ON sitemate.drafts (project_id, work_date) WHERE notice_type = 'daily_report'""",
    *replace_check("drafts", "drafts_notice_type_check", NOTICE_TYPES, "notice_type", valid=True),
    grant("sitemate_reader", "SELECT", ("appointments",)),
    grant("sitemate_ops", "SELECT, INSERT", ("appointments",)),
]

DOWNGRADE = [
    # Daily report drafts and their history are removed (history rows are protected, so the trigger is lifted).
    """DO $$ BEGIN
         ALTER TABLE sitemate.draft_versions DISABLE TRIGGER keep_revision;
         ALTER TABLE sitemate.reviews DISABLE TRIGGER keep_revision;
         DELETE FROM sitemate.exports e USING sitemate.drafts d
           WHERE (e.project_id, e.draft_id) = (d.project_id, d.id) AND d.notice_type = 'daily_report';
         IF to_regclass('sitemate.draft_gap_resolutions') IS NOT NULL THEN
           ALTER TABLE sitemate.draft_gap_resolutions DISABLE TRIGGER keep_revision;
           DELETE FROM sitemate.draft_gap_resolutions g USING sitemate.drafts d
             WHERE (g.project_id, g.draft_id) = (d.project_id, d.id) AND d.notice_type = 'daily_report';
           ALTER TABLE sitemate.draft_gap_resolutions ENABLE TRIGGER keep_revision;
         END IF;
         DELETE FROM sitemate.reviews r USING sitemate.drafts d
           WHERE (r.project_id, r.draft_id) = (d.project_id, d.id) AND d.notice_type = 'daily_report';
         DELETE FROM sitemate.draft_versions v USING sitemate.drafts d
           WHERE (v.project_id, v.draft_id) = (d.project_id, d.id) AND d.notice_type = 'daily_report';
         DELETE FROM sitemate.drafts WHERE notice_type = 'daily_report';
         ALTER TABLE sitemate.draft_versions ENABLE TRIGGER keep_revision;
         ALTER TABLE sitemate.reviews ENABLE TRIGGER keep_revision;
       END $$""",
    *replace_check("drafts", "drafts_notice_type_check", NOTICE_TYPES_0013, "notice_type", valid=True),
    "DROP INDEX IF EXISTS sitemate.drafts_daily_report",
    "ALTER TABLE sitemate.drafts DROP COLUMN IF EXISTS work_date",
    "DROP TABLE IF EXISTS sitemate.appointments",
]

if __name__ == "__main__":
    main(UPGRADE, DOWNGRADE, "daily report")
