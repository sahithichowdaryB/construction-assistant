"""Daily deviation and overall performance evaluation: baselines, settings, evaluations, ledger, snapshots.

The statements live in performance/schema.py and are idempotent, like documents/schema.py, so the schema can
be applied directly with `python -m performance.schema` and this migration then only records the version.
"""

from alembic import op

from performance.schema import DOWNGRADE, UPGRADE

revision = "0009_performance"
down_revision = "0009_correspondence"
branch_labels = None
depends_on = None


def upgrade():
    for statement in UPGRADE:
        op.execute(statement)


def downgrade():
    for statement in DOWNGRADE:
        op.execute(statement)
