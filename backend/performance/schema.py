"""Idempotent DDL for the performance module (used by migration 0009_performance).

Every statement can run twice, so the schema can be applied directly with
`python -m performance.schema` and the Alembic migration then only records the version.
Run `python -m performance.schema --downgrade` to remove it again.

Tables (all in the private `sitemate` schema):
    plan_baselines         one row per uploaded plan revision (draft -> active -> superseded)
    activity_plan          per-baseline activity dates, quantities, weights and critical flags
    milestones             per-baseline milestones
    performance_settings   per-baseline thresholds, calendar, notice rules, rates and ledger rules
    daily_evaluations      versioned day results (immutable)
    daily_activity_results versioned per-activity rows of a day result (immutable)
    performance_ledger     merit/demerit entries; only the review fields change in place
    performance_snapshots  versioned overall evaluations (immutable)
"""

# Alert kinds and notice types the existing code and this module write. The CHECKs are NOT VALID so
# rows written before this migration are never rejected; new rows are checked.
ALERT_KINDS = ("shortfall", "incident", "late_start", "equipment_idle", "missing_report", "quality_hold")
NOTICE_TYPES = ("delay_notice", "incident_notice", "additional_cost_notice", "defect_notice", "notice_of_concern",
                # written by correspondence.py ("Write with SiteMate")
                "email", "additional_cost")
JOB_KINDS_OLD = ("reasoning", "plan_actions", "escalation_check", "auto_resolve")
JOB_KINDS = JOB_KINDS_OLD + ("daily_eval", "overall_eval", "plan_extract")
IMMUTABLE = ("daily_evaluations", "daily_activity_results", "performance_snapshots")


def _in(values):
    return ",".join(f"'{v}'" for v in values)


UPGRADE = [
    """CREATE TABLE IF NOT EXISTS sitemate.plan_baselines (
         project_id text NOT NULL REFERENCES sitemate.projects,
         id uuid NOT NULL DEFAULT gen_random_uuid(),
         revision integer NOT NULL CHECK (revision > 0),
         status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','superseded')),
         extraction_status text NOT NULL DEFAULT 'done'
             CHECK (extraction_status IN ('queued','running','done','needs_review','failed')),
         title text,
         source_ids text[] NOT NULL DEFAULT '{}',
         extracted jsonb NOT NULL DEFAULT '{}',
         review_reasons jsonb NOT NULL DEFAULT '[]',
         model text, error text,
         created_by text, created_at timestamptz NOT NULL DEFAULT now(),
         as_of timestamptz NOT NULL DEFAULT now(),
         activated_by text, activated_at timestamptz,
         PRIMARY KEY (project_id, id), UNIQUE (project_id, revision),
         CHECK (status = 'draft' OR activated_at IS NOT NULL))""",
    """CREATE UNIQUE INDEX IF NOT EXISTS plan_baselines_one_active
         ON sitemate.plan_baselines (project_id) WHERE status = 'active'""",
    """CREATE TABLE IF NOT EXISTS sitemate.activity_plan (
         project_id text NOT NULL, baseline_id uuid NOT NULL, activity_code text NOT NULL,
         name text, unit text, trade text,
         planned_start date, planned_finish date, duration_wd integer CHECK (duration_wd >= 0),
         planned_total numeric CHECK (planned_total >= 0), target_per_day numeric CHECK (target_per_day >= 0),
         weight numeric CHECK (weight >= 0), is_critical boolean, critical_basis text,
         predecessors text[] NOT NULL DEFAULT '{}',
         source_id text, locator text,
         PRIMARY KEY (project_id, baseline_id, activity_code),
         FOREIGN KEY (project_id, baseline_id) REFERENCES sitemate.plan_baselines,
         FOREIGN KEY (project_id, source_id, locator) REFERENCES sitemate.source_passages,
         CHECK (planned_finish IS NULL OR planned_start IS NULL OR planned_finish >= planned_start))""",
    """CREATE TABLE IF NOT EXISTS sitemate.milestones (
         project_id text NOT NULL, baseline_id uuid NOT NULL, code text NOT NULL, name text NOT NULL,
         planned_date date, contractual boolean NOT NULL DEFAULT false, achieved_date date,
         activity_codes text[] NOT NULL DEFAULT '{}',
         source_id text, locator text,
         PRIMARY KEY (project_id, baseline_id, code),
         FOREIGN KEY (project_id, baseline_id) REFERENCES sitemate.plan_baselines,
         FOREIGN KEY (project_id, source_id, locator) REFERENCES sitemate.source_passages)""",
    """CREATE TABLE IF NOT EXISTS sitemate.performance_settings (
         project_id text NOT NULL, baseline_id uuid NOT NULL, settings jsonb NOT NULL DEFAULT '{}',
         PRIMARY KEY (project_id, baseline_id),
         FOREIGN KEY (project_id, baseline_id) REFERENCES sitemate.plan_baselines)""",
    """CREATE TABLE IF NOT EXISTS sitemate.daily_evaluations (
         project_id text NOT NULL REFERENCES sitemate.projects, work_date date NOT NULL,
         version integer NOT NULL CHECK (version > 0), as_of timestamptz NOT NULL,
         baseline_id uuid, input_digest text NOT NULL,
         day_status text NOT NULL, day_severity text NOT NULL DEFAULT 'none'
             CHECK (day_severity IN ('none','amber','red')),
         day_score numeric NOT NULL DEFAULT 0, provisional boolean NOT NULL DEFAULT false,
         summary jsonb NOT NULL DEFAULT '{}', indicators jsonb NOT NULL DEFAULT '{}',
         suggestions jsonb NOT NULL DEFAULT '[]', trigger text, model text,
         status text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','needs_review','failed')),
         notes jsonb NOT NULL DEFAULT '[]',
         created_at timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY (project_id, work_date, version),
         FOREIGN KEY (project_id, baseline_id) REFERENCES sitemate.plan_baselines)""",
    """CREATE TABLE IF NOT EXISTS sitemate.daily_activity_results (
         project_id text NOT NULL, work_date date NOT NULL, version integer NOT NULL, activity_code text NOT NULL,
         planned numeric NOT NULL, actual numeric, basis text, variance numeric, variance_pct numeric,
         status text NOT NULL CHECK (status IN ('exceeded','on_track','behind','not_reported','unplanned_work',
                                                'late_start','not_started_ok')),
         severity text NOT NULL CHECK (severity IN ('none','amber','red')),
         escalated boolean NOT NULL DEFAULT false, days_late integer,
         estimate jsonb, attribution jsonb, refs jsonb NOT NULL DEFAULT '[]',
         PRIMARY KEY (project_id, work_date, version, activity_code),
         FOREIGN KEY (project_id, work_date, version) REFERENCES sitemate.daily_evaluations)""",
    """CREATE TABLE IF NOT EXISTS sitemate.performance_ledger (
         project_id text NOT NULL REFERENCES sitemate.projects, id uuid NOT NULL DEFAULT gen_random_uuid(),
         work_date date NOT NULL, activity_code text, subject text NOT NULL,
         rule_key text NOT NULL, kind text NOT NULL CHECK (kind IN ('merit','demerit')),
         points numeric NOT NULL, quantity numeric,
         cause_category text, responsible_party text, excusable boolean NOT NULL DEFAULT false,
         refs jsonb NOT NULL DEFAULT '[]', detail jsonb NOT NULL DEFAULT '{}', daily_version integer,
         status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','accepted','disputed','superseded')),
         reviewer_id text, note text, as_of timestamptz NOT NULL,
         created_at timestamptz NOT NULL DEFAULT now(), reviewed_at timestamptz, superseded_at timestamptz,
         superseded_version integer,
         PRIMARY KEY (project_id, id),
         FOREIGN KEY (project_id, work_date, daily_version) REFERENCES sitemate.daily_evaluations,
         FOREIGN KEY (project_id, reviewer_id) REFERENCES sitemate.project_members)""",
    # The plan's UNIQUE (project, date, activity, rule) holds for live rows; superseded rows are history.
    """CREATE UNIQUE INDEX IF NOT EXISTS performance_ledger_live
         ON sitemate.performance_ledger (project_id, work_date, subject, rule_key) WHERE status <> 'superseded'""",
    "CREATE INDEX IF NOT EXISTS performance_ledger_date ON sitemate.performance_ledger (project_id, work_date)",
    """CREATE TABLE IF NOT EXISTS sitemate.performance_snapshots (
         project_id text NOT NULL REFERENCES sitemate.projects, as_of_date date NOT NULL,
         version integer NOT NULL CHECK (version > 0), as_of timestamptz NOT NULL,
         baseline_id uuid, input_digest text NOT NULL,
         metrics jsonb NOT NULL DEFAULT '{}', s_curve jsonb NOT NULL DEFAULT '[]', narrative jsonb NOT NULL DEFAULT '{}',
         score numeric NOT NULL DEFAULT 0, model text,
         status text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','needs_review','failed')),
         created_at timestamptz NOT NULL DEFAULT now(),
         PRIMARY KEY (project_id, as_of_date, version),
         FOREIGN KEY (project_id, baseline_id) REFERENCES sitemate.plan_baselines)""",
    # Results are versioned: a recompute adds a version, never changes one.
    *[f"""DO $$ BEGIN
           IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'keep_revision'
                          AND tgrelid = 'sitemate.{t}'::regclass) THEN
             CREATE TRIGGER keep_revision BEFORE UPDATE OR DELETE ON sitemate.{t}
               FOR EACH ROW EXECUTE FUNCTION sitemate.keep_revision();
           END IF;
         END $$""" for t in IMMUTABLE],
    # Suggested correspondence travels on the alert revision (section 6.7).
    "ALTER TABLE sitemate.alert_revisions ADD COLUMN IF NOT EXISTS suggested_notice jsonb",
    "ALTER TABLE sitemate.alerts DROP CONSTRAINT IF EXISTS alerts_kind_check",
    f"ALTER TABLE sitemate.alerts ADD CONSTRAINT alerts_kind_check CHECK (kind IN ({_in(ALERT_KINDS)})) NOT VALID",
    "ALTER TABLE sitemate.drafts DROP CONSTRAINT IF EXISTS drafts_notice_type_check",
    f"""ALTER TABLE sitemate.drafts ADD CONSTRAINT drafts_notice_type_check
          CHECK (notice_type IN ({_in(NOTICE_TYPES)})) NOT VALID""",
    # Daily evaluation jobs, debounced per (project, work date) while queued.
    "ALTER TABLE sitemate.agent_jobs DROP CONSTRAINT IF EXISTS agent_jobs_kind_check",
    f"ALTER TABLE sitemate.agent_jobs ADD CONSTRAINT agent_jobs_kind_check CHECK (kind IN ({_in(JOB_KINDS)}))",
    """CREATE UNIQUE INDEX IF NOT EXISTS agent_jobs_day_debounce
         ON sitemate.agent_jobs (project_id, kind, (payload->>'work_date'))
         WHERE status = 'queued' AND incident_id IS NULL""",
]

DOWNGRADE = [
    "DROP INDEX IF EXISTS sitemate.agent_jobs_day_debounce",
    f"DELETE FROM sitemate.agent_jobs WHERE kind NOT IN ({_in(JOB_KINDS_OLD)})",
    "ALTER TABLE sitemate.agent_jobs DROP CONSTRAINT IF EXISTS agent_jobs_kind_check",
    f"ALTER TABLE sitemate.agent_jobs ADD CONSTRAINT agent_jobs_kind_check CHECK (kind IN ({_in(JOB_KINDS_OLD)}))",
    "ALTER TABLE sitemate.drafts DROP CONSTRAINT IF EXISTS drafts_notice_type_check",
    "ALTER TABLE sitemate.alerts DROP CONSTRAINT IF EXISTS alerts_kind_check",
    "ALTER TABLE sitemate.alert_revisions DROP COLUMN IF EXISTS suggested_notice",
    "DROP TABLE IF EXISTS sitemate.performance_snapshots",
    "DROP TABLE IF EXISTS sitemate.performance_ledger",
    "DROP TABLE IF EXISTS sitemate.daily_activity_results",
    "DROP TABLE IF EXISTS sitemate.daily_evaluations",
    "DROP TABLE IF EXISTS sitemate.performance_settings",
    "DROP TABLE IF EXISTS sitemate.milestones",
    "DROP TABLE IF EXISTS sitemate.activity_plan",
    "DROP TABLE IF EXISTS sitemate.plan_baselines",
]

TABLES = ("plan_baselines", "activity_plan", "milestones", "performance_settings", "daily_evaluations",
          "daily_activity_results", "performance_ledger", "performance_snapshots")


def main():
    import sys

    from database import engine_for

    statements = DOWNGRADE if "--downgrade" in sys.argv else UPGRADE
    with engine_for("MIGRATION_DATABASE_URL").begin() as conn:
        for statement in statements:
            conn.exec_driver_sql(statement)
    print(f"Applied {len(statements)} performance schema statements.")


if __name__ == "__main__":
    main()
