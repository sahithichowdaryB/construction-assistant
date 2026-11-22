"""Run the asynchronous agent worker:  python worker.py

Uses OPS_DATABASE_URL (the sitemate_ops login); without it, the writer login, with a warning."""

import logging
import sys
from pathlib import Path

from database import ops_engine

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "ai-agent"))
from app.llm import get_llm  # noqa: E402
from app.worker import run_forever  # noqa: E402

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    run_forever(ops_engine(), get_llm)
