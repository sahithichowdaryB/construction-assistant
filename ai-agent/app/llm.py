"""One narrow LLM interface. Add a provider by adding an adapter and a branch in get_llm()."""

import json
import re
import time
from typing import Protocol

from .config import llm_settings


class LLMError(RuntimeError):
    pass


RETRY_PAUSES = [2, 5, 10]  # seconds; only for "busy" errors (503/429)


class LLMClient(Protocol):
    model: str

    def generate_json(self, system: str, user: str) -> dict: ...


def parse_json(raw: str) -> dict:
    raw = raw.strip()
    fenced = re.match(r"^```(?:json)?\s*(.*?)\s*```$", raw, re.S)
    try:
        value = json.loads(fenced.group(1) if fenced else raw)
    except json.JSONDecodeError as exc:
        raise LLMError(f"Model did not return valid JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise LLMError("Model JSON must be an object")
    return value


class GeminiClient:
    def __init__(self, api_key: str, model: str):
        if not api_key:
            raise LLMError("GEMINI_API_KEY is empty; set it in backend/.env")
        from google import genai  # imported lazily so tests need no SDK or key

        self._genai = genai
        self._client = genai.Client(api_key=api_key)
        self.model = model

    def generate_json(self, system: str, user: str) -> dict:
        from google.genai import types

        config = types.GenerateContentConfig(
            system_instruction=system, response_mime_type="application/json", temperature=0.0)
        for attempt, pause in enumerate(RETRY_PAUSES + [None]):
            try:
                response = self._client.models.generate_content(model=self.model, contents=user, config=config)
                break
            except Exception as exc:  # SDK raises several error types; surface one
                busy = any(code in str(exc) for code in ("503", "429", "UNAVAILABLE", "RESOURCE_EXHAUSTED"))
                if pause is None or not busy:
                    raise LLMError(f"Gemini request failed: {exc}") from exc
                time.sleep(pause)
        if not response.text:
            raise LLMError("Gemini returned an empty response")
        return parse_json(response.text)


def get_llm() -> LLMClient:
    settings = llm_settings()
    if settings["provider"] == "gemini":
        return GeminiClient(settings["gemini_api_key"], settings["model"])
    raise LLMError(f"Unsupported LLM_PROVIDER {settings['provider']!r}")


class FakeLLM:
    """Scripted responses for tests: one dict (or callable) per call, in order."""

    model = "fake"

    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def generate_json(self, system: str, user: str) -> dict:
        self.calls.append((system, user))
        if not self.responses:
            raise LLMError("FakeLLM has no more scripted responses")
        item = self.responses.pop(0)
        return item(system, user) if callable(item) else item
