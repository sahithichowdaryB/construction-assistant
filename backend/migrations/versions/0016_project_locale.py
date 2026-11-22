"""projects.locale (en-GB / de-DE).

The statements live in locale_schema.py and are idempotent, so the schema can also be applied directly
(`python -m locale_schema`) and this migration then only records the version.
"""

from alembic import op

from locale_schema import DOWNGRADE, UPGRADE

revision = "0016_project_locale"
down_revision = "0015_ask"
branch_labels = None
depends_on = None


def upgrade():
    for statement in UPGRADE:
        op.execute(statement)


def downgrade():
    for statement in DOWNGRADE:
        op.execute(statement)
