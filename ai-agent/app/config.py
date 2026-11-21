"""Settings come from the environment; backend/.env is loaded if present."""

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[2] / "backend" / ".env")


def llm_settings():
    return {
        "provider": os.environ.get("LLM_PROVIDER", "claude").strip().lower(),
        "model": os.environ.get("LLM_MODEL", "claude-opus-5-5").strip(),
        # Optional: low | medium | high | xhigh | max. Empty uses the model's default.
        "effort": os.environ.get("LLM_EFFORT", "").strip().lower() or None,
    }
