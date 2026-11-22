"""Job locks for stuck-job recovery, new job kinds and debounce, capture state needs_transcript.

The statements live in jobs_schema.py and are idempotent, so the schema can also be applied directly
(`python -m jobs_schema`) and this migration then only records the version.
"""

from alembic import op

from jobs_schema import DOWNGRADE, UPGRADE

revision = "0012_job_queue_hardening"
down_revision = "0011_review_export_audit"
branch_labels = None
depends_on = None


def upgrade():
    for statement in UPGRADE:
        op.execute(statement)


def downgrade():
    for statement in DOWNGRADE:
        op.execute(statement)
