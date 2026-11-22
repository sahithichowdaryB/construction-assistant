"""Review parsed report quantities: reading_reviews and the observation it accepts.

The statements live in documents/readings_schema.py and are idempotent, so the schema can also be applied directly
(`python -m documents.readings_schema`) and this migration then only records the version.
"""

from alembic import op

from documents.readings_schema import DOWNGRADE, UPGRADE

revision = "0010_reading_review"
down_revision = "0010_model3d"
branch_labels = None
depends_on = None


def upgrade():
    for statement in UPGRADE:
        op.execute(statement)


def downgrade():
    for statement in DOWNGRADE:
        op.execute(statement)
