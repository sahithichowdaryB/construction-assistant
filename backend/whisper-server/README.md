# Local Whisper server

OpenAI-compatible speech-to-text (`POST /v1/audio/transcriptions`) so voice notes never leave your machine.

```bash
cd backend/whisper-server
uv venv --python 3.12 .venv            # faster-whisper does not support Python 3.14/3.15 yet
uv pip install --python .venv/bin/python -r requirements.txt
.venv/bin/python server.py             # http://127.0.0.1:8001 (first run downloads the model)
```

Then set `WHISPER_BASE_URL=http://127.0.0.1:8001/v1` in `backend/.env` and
`NEXT_PUBLIC_VOICE_TRANSCRIPTION=true` in `frontend/.env.local`.

`WHISPER_LOCAL_MODEL` picks the model (default `base.en`; `small.en` is more accurate and slower).

On Windows, once the environment and model are installed, start the service from
the repository root with PowerShell:

```powershell
& .\backend\whisper-server\.venv\Scripts\python.exe .\backend\whisper-server\server.py
```

The default model recognizes English. For German and English, set
`$env:WHISPER_LOCAL_MODEL = "base"` before starting the service. The first
start with a different model downloads its weights.
