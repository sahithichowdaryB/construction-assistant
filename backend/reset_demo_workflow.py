"""Clear the three-screen demo so it can run again: field notes (FN-...), delay notices and reviews.

    python reset_demo_workflow.py

Only rows the demo screens create are removed. Seeded Riverside data and accounts stay.
"""

from sqlalchemy import text

from database import engine_for

PROJECT = "RIV"
STEPS = [
    ("reviews", "DELETE FROM sitemate.reviews WHERE project_id = :p"),
    ("draft versions", "DELETE FROM sitemate.draft_versions WHERE project_id = :p"),
    ("drafts", "DELETE FROM sitemate.drafts WHERE project_id = :p"),
    ("fact evidence", "DELETE FROM sitemate.fact_evidence WHERE project_id = :p AND fact_id IN "
                      "(SELECT id FROM sitemate.capture_facts WHERE project_id = :p AND source_id LIKE 'FN-%')"),
    ("capture facts", "DELETE FROM sitemate.capture_facts WHERE project_id = :p AND source_id LIKE 'FN-%'"),
    ("note passages", "DELETE FROM sitemate.source_passages WHERE project_id = :p AND source_id LIKE 'FN-%'"),
    ("note sources", "DELETE FROM sitemate.sources WHERE project_id = :p AND id LIKE 'FN-%'"),
]


def main():
    with engine_for("MIGRATION_DATABASE_URL").begin() as conn:
        for label, sql in STEPS:
            print(f"removed {conn.execute(text(sql), {'p': PROJECT}).rowcount:3} {label}")


if __name__ == "__main__":
    main()
