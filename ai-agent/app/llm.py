"""One narrow LLM interface. Add a provider by adding an adapter and a branch in get_llm()."""

import base64
import json
import re
from typing import Protocol

from .config import llm_settings


class LLMError(RuntimeError):
    pass


class InvalidModelOutput(LLMError):
    """The provider replied, but its payload cannot be validated as an object."""

class LLMClient(Protocol):
    model: str

    def generate_json(self, system: str, user: str, images: list[dict] | None = None, *, schema: dict | None = None) -> dict: ...


def parse_json(raw: str) -> dict:
    raw = raw.strip()
    fenced = re.match(r"^```(?:json)?\s*(.*?)\s*```$", raw, re.S)
    try:
        value = json.loads(fenced.group(1) if fenced else raw)
    except json.JSONDecodeError as exc:
        raise InvalidModelOutput(f"Model did not return valid JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise InvalidModelOutput("Model JSON must be an object")
    return value


class ClaudeClient:
    """Claude via the official Anthropic SDK (Messages API).

    Credentials come from the environment (ANTHROPIC_API_KEY, loaded from backend/.env). The model is chosen by
    LLM_MODEL. Claude Opus 5.5 always thinks, so `thinking` and `temperature` are not sent (both are rejected);
    reasoning depth is set with the optional LLM_EFFORT (low | medium | high | xhigh | max).
    """

    def __init__(self, model: str, effort: str | None = None, max_tokens: int = 16000):
        import anthropic  # imported lazily so tests need neither the SDK nor a key

        self._anthropic = anthropic
        self._client = anthropic.Anthropic(max_retries=4)  # the SDK retries 408/409/429/5xx with backoff
        self.model, self.effort, self.max_tokens = model, effort, max_tokens

    def generate_json(self, system: str, user: str, images: list[dict] | None = None, *, schema: dict | None = None) -> dict:
        """`images` (optional): [{"mime": "image/jpeg", "data": bytes}], sent before the text for vision."""
        anthropic = self._anthropic
        content = user
        if images:
            content = [*({"type": "image", "source": {"type": "base64", "media_type": i["mime"],
                                                       "data": base64.b64encode(i["data"]).decode()}} for i in images),
                       {"type": "text", "text": user}]
        request = dict(
            model=self.model, max_tokens=self.max_tokens, system=system,
            messages=[{"role": "user", "content": content}],
            # If a safety classifier declines the request, let the API re-run it on a fallback model.
            betas=["server-side-fallback-2026-07-01"], fallbacks="default",
        )
        if self.effort:
            request["output_config"] = {"effort": self.effort}
        if schema is not None:
            request.setdefault("output_config", {})["format"] = {
                "type": "json_schema", "schema": anthropic.transform_schema(schema),
            }
        try:
            response = self._client.beta.messages.create(**request)
        except anthropic.AuthenticationError as exc:
            raise LLMError("Claude rejected the API key; check ANTHROPIC_API_KEY in backend/.env") from exc
        except anthropic.RateLimitError as exc:
            raise LLMError("Claude is rate limiting requests; try again shortly") from exc
        except anthropic.APIConnectionError as exc:
            raise LLMError(f"Could not reach the Claude API: {exc}") from exc
        except anthropic.APIStatusError as exc:
            raise LLMError(f"Claude request failed ({exc.status_code}): {exc.message}") from exc
        if response.stop_reason == "refusal":
            raise LLMError("Claude declined this request (safety refusal)")
        if response.stop_reason == "max_tokens":
            raise LLMError("Claude's answer was cut off (max_tokens); raise it or lower LLM_EFFORT")
        text = "".join(block.text for block in response.content if block.type == "text")
        if not text.strip():
            raise LLMError("Claude returned no text")
        return parse_json(text)


def get_llm() -> LLMClient:
    settings = llm_settings()
    if settings["provider"] in ("claude", "anthropic"):
        return ClaudeClient(settings["model"], settings["effort"])
    raise LLMError(f"Unsupported LLM_PROVIDER {settings['provider']!r} (supported: claude)")


class FakeLLM:
    """Scripted responses for tests: one dict (or callable) per call, in order."""

    model = "fake"

    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def generate_json(self, system: str, user: str, images: list[dict] | None = None, *, schema: dict | None = None) -> dict:
        self.calls.append((system, user))
        if not self.responses:
            raise LLMError("FakeLLM has no more scripted responses")
        item = self.responses.pop(0)
        return item(system, user) if callable(item) else item
