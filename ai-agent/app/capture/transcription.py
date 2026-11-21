"""Speech to text with Whisper: the OpenAI API, or any OpenAI-compatible Whisper server via WHISPER_BASE_URL.
Plain HTTP (no extra dependency)."""

import json
import os
import urllib.error
import urllib.request
import uuid

from ..llm import LLMError


def transcription_enabled() -> bool:
    return bool(os.environ.get("OPENAI_API_KEY") or os.environ.get("WHISPER_BASE_URL"))


def transcribe(data: bytes, filename: str, mime: str) -> str:
    base = (os.environ.get("WHISPER_BASE_URL") or "https://api.openai.com/v1").rstrip("/")
    fields = {"model": os.environ.get("WHISPER_MODEL", "whisper-1")}
    if os.environ.get("WHISPER_LANGUAGE"):
        fields["language"] = os.environ["WHISPER_LANGUAGE"]
    boundary = uuid.uuid4().hex
    body = b"".join(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode() for k, v in fields.items())
    safe_name = "".join(c for c in filename if c.isalnum() or c in "._-") or "audio.webm"
    body += (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{safe_name}"\r\n'
             f"Content-Type: {mime or 'application/octet-stream'}\r\n\r\n").encode() + data + f"\r\n--{boundary}--\r\n".encode()
    request = urllib.request.Request(
        f"{base}/audio/transcriptions", data=body, method="POST",
        headers={"Authorization": f"Bearer {os.environ.get('OPENAI_API_KEY', 'unused')}",
                 "Content-Type": f"multipart/form-data; boundary={boundary}"})
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.load(response)["text"].strip()
    except urllib.error.HTTPError as exc:
        raise LLMError(f"Transcription failed ({exc.code}): {exc.read().decode(errors='replace')[:200]}") from exc
    except (urllib.error.URLError, KeyError, ValueError) as exc:
        raise LLMError(f"Transcription failed: {exc}") from exc
