"""Uploaded audio and photos on local disk behind one small interface, so object storage can replace it later.
Defaults match the previous layout (backend/storage/voice and backend/storage/images)."""

import hashlib
import os
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[3] / "backend"


def _root(env: str, default: str) -> Path:
    path = Path(os.environ.get(env, default))
    return path if path.is_absolute() else BACKEND_ROOT / path


class DiskStorage:
    def __init__(self, root: Path):
        self.root = root.resolve()

    def _resolve(self, key: str) -> Path:
        full = (self.root / key).resolve()
        if not full.is_relative_to(self.root):
            raise ValueError("Invalid storage key")
        return full

    def put(self, project_id: str, name: str, data: bytes) -> dict:
        key = f"{project_id}/{name}"
        path = self._resolve(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return {"key": key, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}

    def get(self, key: str) -> bytes:
        return self._resolve(key).read_bytes()


def audio_storage() -> DiskStorage:
    return DiskStorage(_root("AGENT_UPLOAD_DIR", "storage/voice"))


def image_storage() -> DiskStorage:
    return DiskStorage(_root("AGENT_IMAGE_DIR", "storage/images"))
