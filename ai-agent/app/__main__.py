"""CLI: python -m app <project_id> <incident_id> [--as-of ISO] [--save]  (run from ai-agent/)."""

import argparse
import os
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
from database import engine_for  # noqa: E402

from .llm import get_llm  # noqa: E402
from .orchestrator import analyze_incident  # noqa: E402
from .persist import save_analysis  # noqa: E402
from .tools import SqlEvidenceStore, default_as_of  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("project_id")
parser.add_argument("incident_id")
parser.add_argument("--as-of", type=datetime.fromisoformat)
parser.add_argument("--save", action="store_true", help="persist the analysis (needs write grants)")
args = parser.parse_args()
as_of = args.as_of or default_as_of()
with engine_for("MIGRATION_DATABASE_URL" if args.save else "DATABASE_URL").connect() as conn:
    result = analyze_incident(SqlEvidenceStore(conn, args.project_id, as_of), get_llm(), args.incident_id, as_of)
    print(result.model_dump_json(indent=2))
    if args.save:
        print(save_analysis(conn, args.project_id, result))
