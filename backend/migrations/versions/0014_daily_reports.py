"""Appointments and one daily report draft per project and day.

The statements live in daily_report/schema.py and are idempotent, so the schema can also be applied directly
(`python -m daily_report.schema`) and this migration then only records the version.
"""

from alembic import op

from daily_report.schema import DOWNGRADE, UPGRADE

revision = "0014_daily_reports"
down_revision = "0013_auto_correspondence"
branch_labels = None
depends_on = None


def upgrade():
    for statement in UPGRADE:
        op.execute(statement)


def downgrade():
    for statement in DOWNGRADE:
        op.execute(statement)
