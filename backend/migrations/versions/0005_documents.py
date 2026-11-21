"""Add document ingestion metadata, passage structure and project-scoped search.

The statements live in documents/schema.py and are idempotent: the shared database already has
them (applied with `python -m documents.schema`) while teammates' 0003_agent_rules and
0004_incident_analysis were not yet in the repo. Once those files are committed, `alembic upgrade
head` runs this as a no-op and records the version. If the chain differs, only `down_revision` changes.
"""

from alembic import op

from documents.schema import DOWNGRADE, UPGRADE

revision = "0005_documents"
down_revision = "0004_incident_analysis"
branch_labels = None
depends_on = None


def upgrade():
    for statement in UPGRADE:
        op.execute(statement)


def downgrade():
    for statement in DOWNGRADE:
        op.execute(statement)
