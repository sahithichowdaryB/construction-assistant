"""Local speech-to-text server with an OpenAI-compatible endpoint (POST /v1/audio/transcriptions).

The capture agent talks to it through WHISPER_BASE_URL, so audio never leaves this machine.
Run:  .venv/bin/python server.py      (listens on 127.0.0.1:8001)
"""

import os

import uvicorn
from fastapi import FastAPI, File, Form, UploadFile
from faster_whisper import WhisperModel

MODEL = os.environ.get("WHISPER_LOCAL_MODEL", "base.en")  # e.g. tiny.en, base.en, small.en, medium.en
PORT = int(os.environ.get("WHISPER_LOCAL_PORT", "8001"))

app = FastAPI(title="Local Whisper")
model = WhisperModel(MODEL, device="cpu", compute_type="int8")


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL}


@app.post("/v1/audio/transcriptions")
def transcribe(file: UploadFile = File(...), model_name: str | None = Form(None, alias="model"), language: str | None = Form(None)):
    segments, _info = model.transcribe(file.file, language=language or ("en" if MODEL.endswith(".en") else None), vad_filter=True)
    text = " ".join(segment.text.strip() for segment in segments).strip()
    return {"text": text}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=PORT)
