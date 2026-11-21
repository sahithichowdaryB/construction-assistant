"""Private file locations. Demo packs are read-only; uploads go to STORAGE_ROOT."""

import hashlib
import os
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
    elif project_id in PACKS:
        root = (PACKS[project_id] / "uploads").resolve()
        path = (PACKS[project_id] / stored_path).resolve()
    else:
        return None
    return path if path.is_relative_to(root) and path.is_file() else None


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
