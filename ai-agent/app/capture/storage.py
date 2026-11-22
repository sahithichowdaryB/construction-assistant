"""Uploaded audio and photos on local disk behind one small interface.
Defaults match the previous layout (backend/storage/voice and backend/storage/images). With a `remote` prefix the
files are also kept in the shared Supabase bucket (see mirror.py), so every machine on the same database sees them."""

import hashlib
import mimetypes
import os
from pathlib import Path

from . import mirror

BACKEND_ROOT = Path(__file__).resolve().parents[3] / "backend"


def _root(env: str, default: str) -> Path:
    path = Path(os.environ.get(env, default))
    return path if path.is_absolute() else BACKEND_ROOT / path


class DiskStorage:
    def __init__(self, root: Path, remote: str | None = None):
        self.root = root.resolve()
        self.remote = remote

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
        if self.remote:
            mirror.upload(f"{self.remote}/{key}", data, mimetypes.guess_type(name)[0] or "application/octet-stream")
        return {"key": key, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}

    def get(self, key: str) -> bytes:
        return self.path(key).read_bytes()

    def path(self, key: str) -> Path:
        """Local path for `key`, downloading it from the shared bucket first if this machine lacks it."""
        path = self._resolve(key)
        if self.remote and not path.is_file():
            mirror.fetch_to(f"{self.remote}/{key}", path)
        return path

    def delete(self, key: str) -> None:
        self._resolve(key).unlink(missing_ok=True)
        if self.remote:
            mirror.delete(f"{self.remote}/{key}")


def audio_storage() -> DiskStorage:
    return DiskStorage(_root("AGENT_UPLOAD_DIR", "storage/voice"), remote="voice")


def image_storage() -> DiskStorage:
    return DiskStorage(_root("AGENT_IMAGE_DIR", "storage/images"), remote="images")
