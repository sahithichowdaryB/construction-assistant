"""Private file locations. Demo packs are read-only; uploads go to STORAGE_ROOT."""

import hashlib
import os
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
PACKS = {"RIV": BACKEND.parent / "data/riverside-demo"}
STORAGE_ROOT = Path(os.environ.get("SITEMATE_STORAGE") or BACKEND / "storage").resolve()
UPLOAD_PREFIX = "storage/"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def resolve(project_id: str, stored_path: str) -> Path | None:
    """Map a sources.path value to a file inside the project's private area, or None."""
    if not stored_path:
        return None
    if stored_path.startswith(UPLOAD_PREFIX):
        root = (STORAGE_ROOT / project_id).resolve()
        path = (root / stored_path[len(UPLOAD_PREFIX):]).resolve()
        if path.is_relative_to(root) and path.is_file():
            return path
    elif project_id in PACKS:
        root = (PACKS[project_id] / "uploads").resolve()
        path = (PACKS[project_id] / stored_path).resolve()
        if path.is_relative_to(root) and path.is_file():
            return path
    return _captured_media(project_id, stored_path)


def _captured_media(project_id: str, key: str) -> Path | None:
    """Voice notes and photos captured in the app keep sources.path = '<project>/<file>', a key in the capture stores."""
    if not key.startswith(f"{project_id}/"):
        return None
    for store in _capture_stores():
        try:
            path = store.path(key)
        except ValueError:
            continue
        if path.is_file():
            return path
    return None


def _capture_stores():
    agent_dir = str(BACKEND.parent / "ai-agent")
    if agent_dir not in sys.path:  # main.py adds it; standalone scripts may not
        sys.path.insert(0, agent_dir)
    from app.capture.storage import audio_storage, image_storage

    return audio_storage(), image_storage()


def transcript_for(project_id: str, source_id: str) -> Path | None:
    """Supplied transcripts stand in for speech-to-text in the demo packs."""
    pack = PACKS.get(project_id)
    path = pack / "transcripts" / f"{source_id}.txt" if pack else None
    return path if path and path.is_file() else None


def save_upload(project_id: str, data: bytes, suffix: str) -> tuple[str, str]:
    """Store bytes content-addressed. Returns (sources.path value, sha256)."""
    digest = hashlib.sha256(data).hexdigest()
    suffix = "".join(ch for ch in suffix.lower() if ch.isalnum() or ch == ".")[:10]
    folder = STORAGE_ROOT / project_id
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"{digest}{suffix}"
    if not target.exists():
        target.write_bytes(data)
    return f"{UPLOAD_PREFIX}{target.name}", digest
