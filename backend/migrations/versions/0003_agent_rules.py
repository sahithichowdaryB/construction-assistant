"""Placeholder for the teammate's `0003_agent_rules` revision (adds sitemate.business_rules).

The shared database is already at this revision, but the original file is not in this repo.
This no-op stub only keeps the alembic chain intact so 0004 can apply. Replace it with the
teammate's real file when available (same revision id).
"""

from alembic import op

revision = "0003_agent_rules"
down_revision = "0002_workflows"
branch_labels = None
depends_on = None


def upgrade():
    # No-op on the shared DB (table exists). IF NOT EXISTS lets a fresh database chain through.
    op.execute("""
        CREATE TABLE IF NOT EXISTS sitemate.business_rules (
            rule_key text PRIMARY KEY, event_type text NOT NULL, required_fields text[] NOT NULL DEFAULT '{}',
            ask_if_missing boolean NOT NULL DEFAULT false, description text NOT NULL,
            active boolean NOT NULL DEFAULT true)
    """)


def downgrade():
    pass
