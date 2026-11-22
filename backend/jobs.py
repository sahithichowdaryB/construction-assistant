"""Durable background work from API requests.

`durable(background, project_id, kind, payload, match)` records the work as an agent_jobs row first, then runs that
same row right away in this API process (FastAPI BackgroundTasks), so the caller sees the result as quickly as before.
If the process stops mid-way, the row stays 'running' and the worker's stuck-job sweep queues it again; if a worker
claims it first, the API simply does nothing. Retries, backoff and the error log are the worker's (ai-agent/app/worker.py).
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path

from database import ops_engine, writer_engine

log = logging.getLogger("sitemate.jobs")


def _worker():
    agent = str(Path(__file__).resolve().parents[1] / "ai-agent")
    if agent not in sys.path:
        sys.path.insert(0, agent)
    from app import worker
    return worker


def enqueue(project_id: str, kind: str, payload: dict) -> None:
    worker = _worker()
    with writer_engine().begin() as conn:
        if kind in ("daily_eval", "overall_eval"):
            worker.enqueue_daily_eval(conn, project_id, payload["work_date"], trigger=payload.get("trigger") or "manual",
                                      as_of=payload.get("as_of"), delay_seconds=0, force=bool(payload.get("force")),
                                      kind=kind)
        else:
            worker.enqueue_job(conn, project_id, kind, payload)


def run_now(project_id: str, kind: str, match: dict) -> None:
    """Claim and run the queued job matching `match` (no-op when the worker already has it)."""
    worker = _worker()
    from app.llm import get_llm
    with ops_engine().connect() as conn:
        job = worker.claim_matching(conn, project_id, kind, match)
        if job is None:
            return
        error = worker.run_claimed(conn, job, get_llm)
        if error:
            log.warning("%s for %s failed in the API process; the worker retries it: %s", kind, project_id, error)


def durable(background, project_id: str, kind: str, payload: dict, match: dict) -> None:
    enqueue(project_id, kind, payload)
    background.add_task(run_now, project_id, kind, match)
