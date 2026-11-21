"""Sign-in: link project members to Supabase Auth accounts, add sessions and a password check.

The statements live in auth_schema.py and are idempotent, so the shared database can be updated
with `python auth_schema.py` before the migration chain reaches this file. Depends on the
teammates' 0006_capture_state (branch `blat`); only `down_revision` changes if the chain differs.
"""

from alembic import op

from auth_schema import DOWNGRADE, UPGRADE

revision = "0007_auth_sessions"
down_revision = "0006_capture_state"
branch_labels = None
depends_on = None


def upgrade():
    for statement in UPGRADE:
        op.execute(statement)


def downgrade():
    for statement in DOWNGRADE:
        op.execute(statement)
