"""Add business rules used by the capture agent and seed them from rules/business_rules.json."""

import json
from pathlib import Path

import sqlalchemy as sa
from alembic import op

revision = "0003_agent_rules"
down_revision = "0002_workflows"
branch_labels = None
depends_on = None

RULES = Path(__file__).resolve().parents[2] / "rules/business_rules.json"


def upgrade():
    op.execute("SET LOCAL search_path TO sitemate, pg_catalog")
    op.execute("""
        CREATE TABLE business_rules (
            rule_key text PRIMARY KEY, event_type text NOT NULL,
            required_fields text[] NOT NULL DEFAULT '{}', ask_if_missing boolean NOT NULL DEFAULT true,
            description text NOT NULL, active boolean NOT NULL DEFAULT true)
    """)
    insert = sa.text("""
        INSERT INTO sitemate.business_rules (rule_key, event_type, required_fields, ask_if_missing, description)
        VALUES (:rule_key, :event_type, :required_fields, :ask_if_missing, :description)
    """)
    for rule in json.loads(RULES.read_text(encoding="utf8")):
        op.get_bind().execute(insert, rule)


def downgrade():
    op.drop_table("business_rules", schema="sitemate")
