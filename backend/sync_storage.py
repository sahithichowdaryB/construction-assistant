"""Copy this machine's stored files (voice notes, photos, uploads) to the shared Supabase bucket.

Run once on every machine that already has files in backend/storage, after setting SUPABASE_URL and
SUPABASE_SERVICE_ROLE_KEY in backend/.env:

    python sync_storage.py

Safe to re-run: objects are overwritten with identical bytes. New files are uploaded automatically when saved.
"""

import mimetypes
import sys
from pathlib import Path

import database  # noqa: F401  (loads backend/.env)
from documents import storage
from app.capture import mirror
from app.capture.storage import audio_storage, image_storage


def files_under(root: Path, skip: set[Path] = frozenset()):
    if not root.is_dir():
        return
    for path in sorted(root.rglob("*")):
        if path.is_file() and not path.name.startswith(".") and not any(path.is_relative_to(s) for s in skip):
            yield path


def main() -> int:
    if not mirror.enabled():
        print("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in backend/.env first.")
        return 1
    mirror.ensure_bucket()

    audio, images = audio_storage(), image_storage()
    jobs = [(f"{store.remote}/{p.relative_to(store.root).as_posix()}", p)
            for store in (audio, images) for p in files_under(store.root)]
    # Document uploads live at STORAGE_ROOT/<project>/<sha256><ext>, next to the voice/ and images/ folders.
    for p in files_under(storage.STORAGE_ROOT, skip={audio.root, images.root}):
        rel = p.relative_to(storage.STORAGE_ROOT)
        if len(rel.parts) == 2:
            jobs.append((f"uploads/{rel.parts[0]}/{rel.parts[1]}", p))

    failed = 0
    for name, path in jobs:
        ok = mirror.upload(name, path.read_bytes(), mimetypes.guess_type(path.name)[0] or "application/octet-stream")
        failed += not ok
        print(f"{'ok  ' if ok else 'FAIL'} {name}")
    print(f"\n{len(jobs) - failed}/{len(jobs)} files in bucket.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
