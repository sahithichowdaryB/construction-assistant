"""The model used by the capture pipeline. CAPTURE_LLM_MODEL wins, then CLAUDE_MODEL (what the old Node agent used),
then the project-wide LLM_MODEL, so existing .env files keep working."""

import os

from ..config import llm_settings
from ..llm import ClaudeClient


def get_capture_llm() -> ClaudeClient:
    base = llm_settings()
    model = os.environ.get("CAPTURE_LLM_MODEL") or os.environ.get("CLAUDE_MODEL") or base["model"]
    effort = (os.environ.get("CAPTURE_LLM_EFFORT") or os.environ.get("CLAUDE_EFFORT") or base["effort"] or "").strip().lower() or None
    return ClaudeClient(model.strip(), effort)
