"""drafts.origin, projects.settings, one additional-cost notice name, alert kind instruction_concern.

The statements live in drafting_schema.py and are idempotent, so the schema can also be applied directly
(`python -m drafting_schema`) and this migration then only records the version.
"""

from alembic import op

from drafting_schema import DOWNGRADE, UPGRADE

revision = "0013_auto_correspondence"
down_revision = "0012_job_queue_hardening"
branch_labels = None
depends_on = None


def upgrade():
    for statement in UPGRADE:
        op.execute(statement)


def downgrade():
    for statement in DOWNGRADE:
        op.execute(statement)
