"""The project's reference plans (the PDFs in mock_data) and an agent-written summary of each.

Summaries are produced on demand by Claude reading the PDF itself, then cached on disk keyed by the file's SHA-256,
so a plan is read once and re-reading is instant.
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


def list_plans() -> list[dict]:
    out = []
    for path in _files():
        out.append({"id": _plan_id(path), "title": _title(path), "filename": path.name,
                    "size_kb": round(path.stat().st_size / 1024), "summarised": _cached(path) is not None})
    return out


def find_plan(plan_id: str) -> Path | None:
    return next((p for p in _files() if _plan_id(p) == plan_id), None)


def _files() -> list[Path]:
    """The reference plans in mock_data, then any plans uploaded since."""
    return sorted(PLAN_DIR.glob("*.pdf")) + sorted(UPLOAD_DIR.glob("*.pdf"))


def save_upload(filename: str, data: bytes) -> Path:
    stem = re.sub(r"[^A-Za-z0-9]+", "_", Path(filename).stem).strip("_")[:60] or "Plan"
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    path = UPLOAD_DIR / f"{stem}.pdf"
    n = 2
    while path.exists() or any(_plan_id(p) == _plan_id(path) for p in PLAN_DIR.glob("*.pdf")):
        path = UPLOAD_DIR / f"{stem}_{n}.pdf"
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


def _cached(path: Path) -> dict | None:
    f = CACHE_DIR / f"{_plan_id(path)}.json"
    try:
        data = json.loads(f.read_text())
    except (OSError, ValueError):
        return None
    return data if data.get("sha256") == _digest(path) and "key_pages" in data else None


def summarise(path: Path, *, refresh: bool = False) -> dict:
    """Return the plan's summary, reading the PDF with Claude when no current cached copy exists."""
    if not refresh and (hit := _cached(path)):
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
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    (CACHE_DIR / f"{_plan_id(path)}.json").write_text(json.dumps(result, indent=2))
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


def summarise_all(*, refresh: bool = False) -> dict:
    """One briefing over every plan. Builds on the per-plan summaries (reading any plan that has none yet)."""
    from concurrent.futures import ThreadPoolExecutor

    from documents.llm import complete_json

    files = _files()
    with ThreadPoolExecutor(max_workers=4) as pool:
        parts = list(pool.map(lambda p: summarise(p), files))
    key = hashlib.sha256("".join(p["sha256"] for p in parts).encode()).hexdigest()
    cache = CACHE_DIR / "all.json"
    try:
        hit = json.loads(cache.read_text())
        if not refresh and hit.get("key") == key:
            return hit
    except (OSError, ValueError):
        pass
    material = "\n\n".join(
        f"PLAN id={p['id']} title={p['title']}\nOverview: {p['overview']}\nKey points: {'; '.join(p['key_points'])}\n"
        f"Key dates: {'; '.join(p['key_dates'])}\nWatch points: {'; '.join(p['watch_points'])}" for p in parts)
    summary, model = complete_json(ALL_SYSTEM, material, schema=ALL_SCHEMA, max_tokens=4000, effort="low")
    titles = {p["id"]: p["title"] for p in parts}
    summary["plans"] = [{"id": x["id"], "title": titles[x["id"]], "role": x["role"]} for x in summary["plans"] if x["id"] in titles]
    result = {"id": "all", "title": "All plans", "filename": "", "key": key, "model": model, "key_pages": [], **summary}
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(result, indent=2))
    return result
