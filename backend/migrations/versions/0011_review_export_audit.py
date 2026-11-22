"""Gap fill/omit audit (draft_gap_resolutions) and store-once exports (eml, created_by, bytes).

The statements live in review_schema.py and are idempotent, so the schema can also be applied directly
(`python -m review_schema`) and this migration then only records the version.
"""

from alembic import op

from review_schema import DOWNGRADE, UPGRADE

revision = "0011_review_export_audit"
down_revision = "0010_reading_review"
branch_labels = None
depends_on = None


def upgrade():
    for statement in UPGRADE:
        op.execute(statement)


def downgrade():
    for statement in DOWNGRADE:
        op.execute(statement)
