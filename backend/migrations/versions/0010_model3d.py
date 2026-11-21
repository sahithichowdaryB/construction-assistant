"""3D progress model: building models from 2D drawings, pours, elements and versioned element progress.

The statements live in model3d/schema.py and are idempotent, like performance/schema.py, so the schema can be
applied directly with `python -m model3d.schema` and this migration then only records the version.
"""

from alembic import op

from model3d.schema import DOWNGRADE, UPGRADE

revision = "0010_model3d"
down_revision = "0009_performance"
branch_labels = None
depends_on = None


def upgrade():
    for statement in UPGRADE:
        op.execute(statement)


def downgrade():
    for statement in DOWNGRADE:
        op.execute(statement)
