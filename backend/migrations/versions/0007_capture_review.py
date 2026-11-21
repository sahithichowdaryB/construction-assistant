"""Captures can now wait for the speaker's review of the extracted facts before anything is saved."""

from alembic import op

revision = "0007_capture_review"
down_revision = "0006_capture_state"
branch_labels = None
depends_on = None

OLD = "('processing','needs_category','needs_input','saved','no_events','failed')"
NEW = "('processing','needs_category','needs_input','needs_review','saved','no_events','failed')"


def upgrade():
    op.execute("SET LOCAL search_path TO sitemate, pg_catalog")
    op.execute("ALTER TABLE captures DROP CONSTRAINT IF EXISTS captures_status_check")
    op.execute(f"ALTER TABLE captures ADD CONSTRAINT captures_status_check CHECK (status IN {NEW})")


def downgrade():
    op.execute("SET LOCAL search_path TO sitemate, pg_catalog")
    op.execute("UPDATE captures SET status='failed' WHERE status='needs_review'")
    op.execute("ALTER TABLE captures DROP CONSTRAINT IF EXISTS captures_status_check")
    op.execute(f"ALTER TABLE captures ADD CONSTRAINT captures_status_check CHECK (status IN {OLD})")
