"""Keep a paused capture's working state in the database so it survives restarts (replaces the Node checkpointer)."""

from alembic import op

revision = "0006_capture_state"
down_revision = "0005_event_pipeline"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("SET LOCAL search_path TO sitemate, pg_catalog")
    op.execute("ALTER TABLE captures ADD COLUMN state jsonb")


def downgrade():
    op.execute("SET LOCAL search_path TO sitemate, pg_catalog")
    op.execute("ALTER TABLE captures DROP COLUMN state")
