"""Clear the demo so it can run again: field notes (FN-...), notices, emails and letters written with SiteMate, daily
report drafts, their reviews and exports, confirmed report readings, appointments and Ask threads. Cost rates, accounts
and the seeded Riverside data stay.

    python reset_demo_workflow.py            # project RIV
    python reset_demo_workflow.py --project TST

History tables are protected by the keep_revision trigger (updates and deletes raise). This script is the one place
that removes such rows: it disables the trigger on those tables inside its own transaction, deletes only rows the demo
screens create, and enables the trigger again before committing. Tables that do not exist yet are skipped.
"""

import argparse

from sqlalchemy import text

from database import engine_for

PROTECTED = ("draft_versions", "reviews", "draft_gap_resolutions", "reading_reviews", "ask_messages", "appointments")

# (label, table, statement). Order matters: children before parents.
STEPS = [
    ("exports", "exports", "DELETE FROM sitemate.exports WHERE project_id = :p"),
    ("gap resolutions", "draft_gap_resolutions", "DELETE FROM sitemate.draft_gap_resolutions WHERE project_id = :p"),
    ("reviews", "reviews", "DELETE FROM sitemate.reviews WHERE project_id = :p"),
    ("draft versions", "draft_versions", "DELETE FROM sitemate.draft_versions WHERE project_id = :p"),
    ("drafts", "drafts", "DELETE FROM sitemate.drafts WHERE project_id = :p"),
    ("confirmed readings", "observations",
     "DELETE FROM sitemate.observations WHERE project_id = :p AND review_id IS NOT NULL"),
    ("reading reviews", "reading_reviews", "DELETE FROM sitemate.reading_reviews WHERE project_id = :p"),
    ("appointments", "appointments", "DELETE FROM sitemate.appointments WHERE project_id = :p AND origin <> 'seed'"),
    ("ask messages", "ask_messages", "DELETE FROM sitemate.ask_messages WHERE project_id = :p"),
    ("ask threads", "ask_threads", "DELETE FROM sitemate.ask_threads WHERE project_id = :p"),
    ("fact evidence", "fact_evidence",
     "DELETE FROM sitemate.fact_evidence WHERE project_id = :p AND fact_id IN "
     "(SELECT id FROM sitemate.capture_facts WHERE project_id = :p AND source_id LIKE 'FN-%')"),
    ("capture facts", "capture_facts",
     "DELETE FROM sitemate.capture_facts WHERE project_id = :p AND source_id LIKE 'FN-%'"),
    ("note passages", "source_passages",
     "DELETE FROM sitemate.source_passages WHERE project_id = :p AND source_id LIKE 'FN-%'"),
    ("note sources", "sources", "DELETE FROM sitemate.sources WHERE project_id = :p AND id LIKE 'FN-%'"),
]


def _exists(conn, table):
    return conn.execute(text("SELECT to_regclass(:t)"), {"t": f"sitemate.{table}"}).scalar() is not None


def _has_column(conn, table, column):
    return conn.execute(text("""SELECT 1 FROM information_schema.columns
                                WHERE table_schema='sitemate' AND table_name=:t AND column_name=:c"""),
                        {"t": table, "c": column}).scalar() is not None


def _trigger(conn, table, on):
    if _exists(conn, table) and conn.execute(text("""SELECT 1 FROM pg_trigger WHERE tgname='keep_revision'
                                                     AND tgrelid = CAST(:t AS regclass)"""),
                                             {"t": f"sitemate.{table}"}).scalar():
        conn.execute(text(f"ALTER TABLE sitemate.{table} {'ENABLE' if on else 'DISABLE'} TRIGGER keep_revision"))


def reset(conn, project):
    removed = {}
    for table in PROTECTED:
        _trigger(conn, table, on=False)
    try:
        for label, table, sql in STEPS:
            if not _exists(conn, table):
                continue
            if table == "observations" and not _has_column(conn, "observations", "review_id"):
                continue
            if table == "appointments" and not _has_column(conn, "appointments", "origin"):
                continue
            removed[label] = conn.execute(text(sql), {"p": project}).rowcount
    finally:
        for table in PROTECTED:
            _trigger(conn, table, on=True)
    return removed


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--project", default="RIV")
    args = parser.parse_args()
    with engine_for("MIGRATION_DATABASE_URL").begin() as conn:
        for label, count in reset(conn, args.project).items():
            print(f"removed {count:3} {label}")


if __name__ == "__main__":
    main()
