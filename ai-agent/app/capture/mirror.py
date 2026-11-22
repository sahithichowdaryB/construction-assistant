"""Shared copy of stored files in a private Supabase Storage bucket.

Local disk stays the working copy (callers need real paths for FileResponse, PyMuPDF, hashing). Every write is
also uploaded to the bucket, and a file missing from this machine's disk is downloaded from the bucket on first
use. That way a recording made on one laptop plays on every machine that shares the database.

Enabled when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set; otherwise every function is a no-op.
Object names: voice/<project>/<file>, images/<project>/<file>, uploads/<project>/<file>.
"""

import json
import logging
import os
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

log = logging.getLogger(__name__)

TIMEOUT = 30
MISS_TTL = 300  # seconds to remember "not in the bucket either", so list views don't re-ask on every request
_misses: dict[str, float] = {}


def _config() -> tuple[str, str, str] | None:
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not key:
        return None
    return url, key, os.environ.get("SUPABASE_STORAGE_BUCKET") or "sitemate-files"


def enabled() -> bool:
    return _config() is not None


def _request(method: str, path: str, body: bytes | None = None, headers: dict | None = None):
    url, key, _ = _config()
    all_headers = {"apikey": key, **(headers or {})}
    if key.startswith("eyJ"):  # legacy JWT service_role key; new sb_secret_ keys go in apikey only
        all_headers["Authorization"] = f"Bearer {key}"
    req = urllib.request.Request(f"{url}/storage/v1/{path}", data=body, method=method, headers=all_headers)
    return urllib.request.urlopen(req, timeout=TIMEOUT)


def _object_path(name: str) -> str:
    _, _, bucket = _config()
    return f"object/{bucket}/{urllib.parse.quote(name)}"


def upload(name: str, data: bytes, content_type: str = "application/octet-stream") -> bool:
    """Upload (or overwrite) one object. Logs and returns False on failure; the local copy is kept either way."""
    if not enabled():
        return False
    try:
        with _request("POST", _object_path(name), data, {"Content-Type": content_type, "x-upsert": "true"}):
            pass
        _misses.pop(name, None)
        return True
    except (urllib.error.URLError, OSError) as exc:
        log.warning("Could not upload %s to shared storage: %s", name, _describe(exc))
        return False


def fetch_to(name: str, target: Path) -> bool:
    """Download an object to `target` if it exists in the bucket. True when `target` now exists."""
    if target.is_file():
        return True
    if not enabled() or time.monotonic() - _misses.get(name, -MISS_TTL) < MISS_TTL:
        return False
    try:
        with _request("GET", _object_path(name)) as res:
            target.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as tmp:
                while chunk := res.read(1 << 20):
                    tmp.write(chunk)
            os.replace(tmp.name, target)  # atomic: concurrent readers never see a half-written file
        return True
    except urllib.error.HTTPError as exc:
        if exc.code not in (400, 404):  # Supabase answers 400 "Object not found" for missing objects
            log.warning("Could not download %s from shared storage: %s", name, _describe(exc))
        _misses[name] = time.monotonic()
        return False
    except (urllib.error.URLError, OSError) as exc:
        log.warning("Could not download %s from shared storage: %s", name, _describe(exc))
        _misses[name] = time.monotonic()
        return False


def delete(name: str) -> None:
    if not enabled():
        return
    _, _, bucket = _config()
    try:
        with _request("DELETE", f"object/{bucket}", json.dumps({"prefixes": [name]}).encode(),
                      {"Content-Type": "application/json"}):
            pass
    except (urllib.error.URLError, OSError) as exc:
        log.warning("Could not delete %s from shared storage: %s", name, _describe(exc))


def ensure_bucket() -> None:
    """Create the private bucket if it does not exist yet (used by the sync script)."""
    _, _, bucket = _config()
    try:
        with _request("POST", "bucket", json.dumps({"id": bucket, "name": bucket, "public": False}).encode(),
                      {"Content-Type": "application/json"}):
            pass
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace")
        if exc.code not in (400, 409) or "exist" not in body.lower():
            raise RuntimeError(f"Could not create bucket {bucket!r}: HTTP {exc.code} {body}") from exc


def _describe(exc: Exception) -> str:
    if isinstance(exc, urllib.error.HTTPError):
        try:
            return f"HTTP {exc.code} {exc.read().decode(errors='replace')[:200]}"
        except OSError:
            return f"HTTP {exc.code}"
    return str(exc)
