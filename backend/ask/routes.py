"""HTTP routes for Ask SiteMate (all under /projects/{project_id}, any project member).

    POST /ask                    {question, thread_id?}  ?as_of=   -> cited answer (or no_evidence), saved to the thread
    GET  /ask/threads                                              -> the caller's threads
    GET  /ask/threads/{id}                                ?as_of=  -> its messages (only those up to the clock)

The tools read with the read-only login; only the thread and its messages are written (writer login). When the model
is unavailable the route answers 503 with the top search results, so the manager can still read the records.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import text

from database import writer_engine
from deps import check_cutoff, connection, current_member
from notice_templates import DISCLAIMER

from . import agent
from .tools import ToolContext, search_records

router = APIRouter(prefix="/projects/{project_id}", tags=["ask"])
HISTORY_TURNS = 6


class AskIn(BaseModel):
    question: str = Field(min_length=2, max_length=2000)
    thread_id: str | None = Field(None, pattern=r"^[0-9a-fA-F-]{36}$")


def get_client():
    """Overridable in tests (app.dependency_overrides)."""
    return agent.ClaudeAsk()


def _render(a: agent.Answer) -> str:
    parts = [p["text"] for p in a.answer] or a.unknowns
    return "\n\n".join(parts)


def _history(conn, project_id, thread_id):
    rows = conn.execute(text("""SELECT role, content FROM sitemate.ask_messages WHERE project_id=:p
        AND thread_id=CAST(:t AS uuid) ORDER BY seq DESC LIMIT :n"""),
                        {"p": project_id, "t": thread_id, "n": HISTORY_TURNS}).mappings().all()
    return [{"role": r["role"], "content": r["content"]} for r in reversed(rows)]


def _own_thread(conn, project_id, thread_id, member_id):
    owner = conn.scalar(text("SELECT member_id FROM sitemate.ask_threads WHERE project_id=:p AND id=CAST(:t AS uuid)"),
                        {"p": project_id, "t": thread_id})
    if owner is None or owner != member_id:
        raise HTTPException(404, "Conversation not found")


@router.post("/ask")
def ask(project_id: str, body: AskIn, as_of: datetime | None = None, member=Depends(current_member),
        conn=Depends(connection)):
    check_cutoff(as_of)
    when = as_of or datetime.now(timezone.utc).replace(microsecond=0)
    if body.thread_id:
        _own_thread(conn, project_id, body.thread_id, member["member_id"])
        history = _history(conn, project_id, body.thread_id)
    else:
        history = []
    ctx = ToolContext(conn, project_id, when, member["role"])
    try:
        client = get_client()
        result, latency = agent.timed(lambda: agent.answer(ctx, body.question.strip(), history, client))
    except agent.AskUnavailable as exc:
        fallback = search_records(ToolContext(conn, project_id, when, member["role"]), body.question, 5)["results"]
        raise HTTPException(503, {"message": f"Ask SiteMate is unavailable right now ({exc}). These records match "
                                             "your question:", "fallback": fallback}) from None
    with writer_engine().begin() as w:
        thread_id = body.thread_id or str(w.scalar(text("""
            INSERT INTO sitemate.ask_threads (project_id, member_id, title) VALUES (:p, :m, :t) RETURNING id"""),
            {"p": project_id, "m": member["member_id"], "t": body.question.strip()[:120]}))
        w.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))"), {"k": f"ask:{thread_id}"})
        seq = w.scalar(text("SELECT coalesce(max(seq), 0) FROM sitemate.ask_messages WHERE project_id=:p "
                            "AND thread_id=CAST(:t AS uuid)"), {"p": project_id, "t": thread_id})
        w.execute(text("""INSERT INTO sitemate.ask_messages (project_id, thread_id, seq, role, content, as_of)
                          VALUES (:p, CAST(:t AS uuid), :s, 'user', :c, :at)"""),
                  {"p": project_id, "t": thread_id, "s": seq + 1, "c": body.question.strip(), "at": when})
        w.execute(text("""
            INSERT INTO sitemate.ask_messages (project_id, thread_id, seq, role, content, answer, citations, tool_calls,
                                               as_of, status, model, latency_ms)
            VALUES (:p, CAST(:t AS uuid), :s, 'assistant', :c, CAST(:a AS jsonb), CAST(:ci AS jsonb), CAST(:tc AS jsonb),
                    :at, :st, :m, :l)"""),
                  {"p": project_id, "t": thread_id, "s": seq + 2, "c": _render(result),
                   "a": json.dumps({"answer": result.answer, "unknowns": result.unknowns,
                                    "suggested_actions": result.suggested_actions, "dropped": result.dropped}),
                   "ci": json.dumps(result.citations), "tc": json.dumps(ctx.calls, default=str), "at": when,
                   "st": result.status, "m": result.model, "l": latency})
    return {"thread_id": thread_id, "seq": seq + 2, "status": result.status, "answer": result.answer,
            "unknowns": result.unknowns, "suggested_actions": result.suggested_actions, "citations": result.citations,
            "tools_used": [c["name"] for c in ctx.calls], "as_of": when, "disclaimer": DISCLAIMER}


@router.get("/ask/threads")
def threads(project_id: str, member=Depends(current_member), conn=Depends(connection)):
    rows = conn.execute(text("""SELECT id::text AS id, title, created_at FROM sitemate.ask_threads
        WHERE project_id=:p AND member_id=:m ORDER BY created_at DESC LIMIT 50"""),
                        {"p": project_id, "m": member["member_id"]}).mappings().all()
    return [dict(r) for r in rows]


@router.get("/ask/threads/{thread_id}")
def thread(project_id: str, thread_id: str, as_of: datetime | None = None, member=Depends(current_member),
           conn=Depends(connection)):
    check_cutoff(as_of)
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", thread_id):
        raise HTTPException(404, "Conversation not found")
    _own_thread(conn, project_id, thread_id, member["member_id"])
    rows = conn.execute(text("""SELECT seq, role, content, answer, citations, as_of, status FROM sitemate.ask_messages
        WHERE project_id=:p AND thread_id=CAST(:t AS uuid) AND as_of <= coalesce(CAST(:c AS timestamptz), 'infinity')
        ORDER BY seq"""), {"p": project_id, "t": thread_id, "c": as_of}).mappings().all()
    return {"thread_id": thread_id, "messages": [dict(r) for r in rows], "disclaimer": DISCLAIMER}
