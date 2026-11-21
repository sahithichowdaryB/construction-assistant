"""Sign-in: link project members to Supabase Auth accounts, add sessions and a password check.

The statements live in auth_schema.py and are idempotent: the shared database already has them
(applied with `python auth_schema.py`), so `alembic upgrade head` records this version without changes.
"""

from alembic import op

from auth_schema import DOWNGRADE, UPGRADE

revision = "0008_auth_sessions"
down_revision = "0007_capture_review"
branch_labels = None
depends_on = None


def upgrade():
    for statement in UPGRADE:
        op.execute(statement)


def downgrade():
    for statement in DOWNGRADE:
        op.execute(statement)
