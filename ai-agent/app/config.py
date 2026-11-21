"""Settings come from the environment; backend/.env is loaded if present."""

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[2] / "backend" / ".env")


def llm_settings():
    return {
        "provider": os.environ.get("LLM_PROVIDER", "gemini").strip().lower(),
        "model": os.environ.get("LLM_MODEL", "gemini-2.5-flash").strip(),
        "gemini_api_key": os.environ.get("GEMINI_API_KEY", "").strip(),
    }
