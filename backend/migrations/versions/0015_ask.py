"""Ask SiteMate threads and immutable messages.

The statements live in ask/schema.py and are idempotent, so the schema can also be applied directly
(`python -m ask.schema`) and this migration then only records the version.
"""

from alembic import op

from ask.schema import DOWNGRADE, UPGRADE

revision = "0015_ask"
down_revision = "0014_daily_reports"
branch_labels = None
depends_on = None


def upgrade():
    for statement in UPGRADE:
        op.execute(statement)


def downgrade():
    for statement in DOWNGRADE:
        op.execute(statement)
