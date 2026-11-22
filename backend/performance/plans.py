"""Each project's reference plans and an agent-written summary of each.

Plans are scoped to one project:
- the PDFs in mock_data belong to the project named by PLAN_FILES_PROJECT (default RIV), together with any file in
  the legacy flat storage/uploaded_plans folder (uploads made before plans were scoped);
- uploads go to storage/uploaded_plans/<project_id>/.

Summaries are written on an explicit request (POST) by Claude reading the PDF itself, then cached on disk per project,
keyed by the file's SHA-256, so a plan is read once and re-reading is instant.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
from pathlib import Path

PLAN_DIR = Path(os.environ.get("PLAN_FILES_DIR") or Path(__file__).resolve().parents[2] / "mock_data")
STORAGE = Path(__file__).resolve().parents[1] / "storage"
CACHE_DIR = STORAGE / "plan_summaries"
UPLOAD_DIR = STORAGE / "uploaded_plans"
PAGE_DIR = STORAGE / "plan_pages"
PDF_LIMIT = 32 * 1024 * 1024
REFERENCE_PROJECT = os.environ.get("PLAN_FILES_PROJECT", "RIV")

SYSTEM = (
    "You summarise construction project plan documents for a busy site manager. Use plain, short sentences. "
    "Only state what the document shows; never invent figures, dates or names. If something is not legible or not "
    "stated, leave it out."
)
SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["overview", "key_points", "key_dates", "watch_points", "key_pages"],
    "properties": {
        "overview": {"type": "string", "description": "Two to three sentences: what this document is and what it is for."},
        "key_points": {"type": "array", "items": {"type": "string"}, "description": "At most 6 short bullets of the most important content."},
        "key_dates": {"type": "array", "items": {"type": "string"}, "description": "At most 6 important dates or milestones, each as 'date: what'. Empty if none."},
        "key_pages": {"type": "array", "description": "Up to 4 pages with the most important picture, drawing, chart or table, as page numbers counted from 1.",
                      "items": {"type": "object", "additionalProperties": False, "required": ["page", "caption"],
                                "properties": {"page": {"type": "integer"}, "caption": {"type": "string", "description": "Under 12 words: what the page shows."}}}},
        "watch_points": {"type": "array", "items": {"type": "string"}, "description": "At most 4 things the site team should keep in mind. Empty if none."},
    },
}


def _plan_id(path: Path) -> str:
    return re.sub(r"[^a-z0-9]+", "-", path.stem.lower()).strip("-")


def _title(path: Path) -> str:
    return re.sub(r"^Plan_(\d+)_", r"Plan \1: ", path.stem).replace("_", " ")


def _safe(project_id: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", project_id or ""):
        raise ValueError("Invalid project id")
    return project_id


def _upload_dir(project_id: str) -> Path:
    return UPLOAD_DIR / _safe(project_id)


def _cache_dir(project_id: str) -> Path:
    return CACHE_DIR / _safe(project_id)


def list_plans(project_id: str) -> list[dict]:
    out = []
    for path in _files(project_id):
        out.append({"id": _plan_id(path), "title": _title(path), "filename": path.name,
                    "size_kb": round(path.stat().st_size / 1024),
                    "summarised": _cached(project_id, path) is not None})
    return out


def find_plan(project_id: str, plan_id: str) -> Path | None:
    return next((p for p in _files(project_id) if _plan_id(p) == plan_id), None)


def _files(project_id: str) -> list[Path]:
    """This project's plans: the reference plans (reference project only), then its uploads."""
    _safe(project_id)
    reference = []
    if project_id == REFERENCE_PROJECT:
        reference = sorted(PLAN_DIR.glob("*.pdf")) + sorted(UPLOAD_DIR.glob("*.pdf"))
    return reference + sorted(_upload_dir(project_id).glob("*.pdf"))


def save_upload(project_id: str, filename: str, data: bytes) -> Path:
    stem = re.sub(r"[^A-Za-z0-9]+", "_", Path(filename).stem).strip("_")[:60] or "Plan"
    folder = _upload_dir(project_id)
    folder.mkdir(parents=True, exist_ok=True)
    taken = {_plan_id(p) for p in _files(project_id)}
    path = folder / f"{stem}.pdf"
    n = 2
    while path.exists() or _plan_id(path) in taken:
        path = folder / f"{stem}_{n}.pdf"
        n += 1
    path.write_bytes(data)
    return path


def render_page(path: Path, page: int) -> bytes | None:
    """PNG of one page (1-based), cached on disk."""
    import pymupdf

    out = PAGE_DIR / f"{_plan_id(path)}-{_digest(path)[:8]}-{page}.png"
    if out.exists():
        return out.read_bytes()
    with pymupdf.open(path) as doc:
        if not 1 <= page <= doc.page_count:
            return None
        png = doc[page - 1].get_pixmap(dpi=110).tobytes("png")
    PAGE_DIR.mkdir(parents=True, exist_ok=True)
    out.write_bytes(png)
    return png


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _read_cache(project_id: str, name: str) -> dict | None:
    """A cached JSON file for this project. The reference project also reads the legacy flat cache folder."""
    places = [_cache_dir(project_id) / name]
    if project_id == REFERENCE_PROJECT:
        places.append(CACHE_DIR / name)
    for f in places:
        try:
            return json.loads(f.read_text())
        except (OSError, ValueError):
            continue
    return None


def _cached(project_id: str, path: Path) -> dict | None:
    data = _read_cache(project_id, f"{_plan_id(path)}.json")
    if data is None:
        return None
    return data if data.get("sha256") == _digest(path) and "key_pages" in data else None


def cached_summary(project_id: str, plan_id: str) -> dict | None:
    """The stored summary (one plan, or 'all'), or None when it has not been written yet or is out of date."""
    if plan_id == "all":
        hit = _read_cache(project_id, "all.json")
        if hit is None:
            return None
        parts = [_cached(project_id, p) for p in _files(project_id)]
        if any(p is None for p in parts):
            return None
        key = hashlib.sha256("".join(p["sha256"] for p in parts).encode()).hexdigest()
        return hit if hit.get("key") == key else None
    path = find_plan(project_id, plan_id)
    return _cached(project_id, path) if path else None


def summarise(project_id: str, path: Path, *, refresh: bool = False) -> dict:
    """Return the plan's summary, reading the PDF with Claude when no current cached copy exists."""
    if not refresh and (hit := _cached(project_id, path)):
        return hit
    from documents.llm import complete_json

    data = path.read_bytes()
    if len(data) > PDF_LIMIT:
        raise ValueError("Plan is too large to read")
    content = [
        {"type": "document", "source": {"type": "base64", "media_type": "application/pdf",
                                        "data": base64.standard_b64encode(data).decode()}},
        {"type": "text", "text": "Summarise this plan."},
    ]
    summary, model = complete_json(SYSTEM, content, schema=SCHEMA, max_tokens=4000, effort="low")
    import pymupdf
    with pymupdf.open(path) as doc:
        count = doc.page_count
    summary["key_pages"] = [k for k in summary.get("key_pages", []) if 1 <= k.get("page", 0) <= count][:4]
    result = {"id": _plan_id(path), "title": _title(path), "filename": path.name, "sha256": _digest(path),
              "model": model, **summary}
    _cache_dir(project_id).mkdir(parents=True, exist_ok=True)
    (_cache_dir(project_id) / f"{_plan_id(path)}.json").write_text(json.dumps(result, indent=2))
    return result


ALL_SYSTEM = (
    "You write the overall briefing for a construction project from the summaries of its plan documents, for a busy "
    "site manager. Plain, short sentences. Only use what the summaries say; never invent figures, dates or names. "
    "Say how the documents fit together (programme, resources and cost, drawings, models)."
)
ALL_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["overview", "key_points", "key_dates", "watch_points", "plans"],
    "properties": {
        "overview": {"type": "string", "description": "Three to four sentences on what the plans cover together."},
        "key_points": {"type": "array", "items": {"type": "string"}, "description": "At most 6 bullets across all plans."},
        "key_dates": {"type": "array", "items": {"type": "string"}, "description": "At most 8 'date: what' items across all plans."},
        "watch_points": {"type": "array", "items": {"type": "string"}, "description": "At most 5 things to keep in mind."},
        "plans": {"type": "array", "description": "One entry per plan.",
                  "items": {"type": "object", "additionalProperties": False, "required": ["id", "role"],
                            "properties": {"id": {"type": "string"}, "role": {"type": "string", "description": "Under 20 words: what this plan is for."}}}},
    },
}


def summarise_all(project_id: str, *, refresh: bool = False) -> dict:
    """One briefing over every plan. Builds on the per-plan summaries (reading any plan that has none yet)."""
    from concurrent.futures import ThreadPoolExecutor

    from documents.llm import complete_json

    files = _files(project_id)
    if not files:
        raise ValueError("This project has no plans yet")
    with ThreadPoolExecutor(max_workers=4) as pool:
        parts = list(pool.map(lambda p: summarise(project_id, p), files))
    key = hashlib.sha256("".join(p["sha256"] for p in parts).encode()).hexdigest()
    cache = _cache_dir(project_id) / "all.json"
    hit = _read_cache(project_id, "all.json")
    if not refresh and hit and hit.get("key") == key:
        return hit
    material = "\n\n".join(
        f"PLAN id={p['id']} title={p['title']}\nOverview: {p['overview']}\nKey points: {'; '.join(p['key_points'])}\n"
        f"Key dates: {'; '.join(p['key_dates'])}\nWatch points: {'; '.join(p['watch_points'])}" for p in parts)
    summary, model = complete_json(ALL_SYSTEM, material, schema=ALL_SCHEMA, max_tokens=4000, effort="low")
    titles = {p["id"]: p["title"] for p in parts}
    summary["plans"] = [{"id": x["id"], "title": titles[x["id"]], "role": x["role"]} for x in summary["plans"] if x["id"] in titles]
    result = {"id": "all", "title": "All plans", "filename": "", "key": key, "model": model, "key_pages": [], **summary}
    _cache_dir(project_id).mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(result, indent=2))
    return result
