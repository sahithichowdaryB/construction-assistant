"""Write with SiteMate: request, recipient and analysis on drafts; project cost rates.

The statements live in correspondence_schema.py and are idempotent; the shared database already has
them (applied with `python correspondence_schema.py`).
"""

from alembic import op

from correspondence_schema import DOWNGRADE, UPGRADE

revision = "0009_correspondence"
down_revision = "0008_auth_sessions"
branch_labels = None
depends_on = None


def upgrade():
    for statement in UPGRADE:
        op.execute(statement)


def downgrade():
    for statement in DOWNGRADE:
        op.execute(statement)
