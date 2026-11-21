"""Event categories and types. Rows in sitemate.event_categories / event_types (a project row overrides the global one
with the same key); the JSON seed is the fallback before migration 0005."""

import json
import time
from pathlib import Path

from sqlalchemy import text

SEED_FILE = Path(__file__).resolve().parents[3] / "backend" / "rules" / "event_taxonomy.json"
SEVERITIES = ["low", "medium", "high", "critical"]
_TTL = 60.0
_cache: dict[str, tuple[float, "Taxonomy"]] = {}


def severity_rank(level):
    return SEVERITIES.index(level) if level in SEVERITIES else -1


class Taxonomy:
    def __init__(self, categories: list[dict], types: list[dict]):
        self._cats = {c["key"]: c for c in categories if c.get("active", True)}
        self.categories = sorted(self._cats.values(), key=lambda c: c.get("sort_order", 100))
        self.types = [{**t, "category": t.get("category") or t.get("category_key")}
                      for t in types if t.get("active", True)]
        self._types = {t["key"]: t for t in self.types}

    def category(self, key):
        return self._cats.get(key)

    def type(self, key):
        return self._types.get(key)

    def types_of(self, category_key):
        return [t for t in self.types if t["category"] == category_key]

    def creates_incident(self, category_key) -> bool:
        return bool((self._cats.get(category_key) or {}).get("creates_incident"))

    def normalise(self, category_key, type_key) -> tuple[str, str]:
        """A valid (category, type) pair: unknown category -> the type's own category or 'general';
        a type outside the category -> that category's first type."""
        category = category_key if category_key in self._cats else (self._types.get(type_key) or {}).get("category", "general")
        in_category = self.types_of(category)
        if any(t["key"] == type_key for t in in_category):
            return category, type_key
        return category, (in_category[0]["key"] if in_category else "other")


def seed_taxonomy() -> Taxonomy:
    data = json.loads(SEED_FILE.read_text(encoding="utf8"))
    return Taxonomy(data["categories"], data["types"])


def _merge(rows):
    merged = {}
    for row in sorted(rows, key=lambda r: 1 if r.get("project_id") else 0):  # project rows win
        merged[row["key"]] = row
    return list(merged.values())


def load_taxonomy(conn, project_id: str) -> Taxonomy:
    hit = _cache.get(project_id)
    if hit and time.monotonic() - hit[0] < _TTL:
        return hit[1]
    if conn.scalar(text("SELECT to_regclass('sitemate.event_categories')")) is None:
        value = seed_taxonomy()
    else:
        p = {"p": project_id}
        cats = _merge([dict(r) for r in conn.execute(text(
            "SELECT * FROM sitemate.event_categories WHERE project_id IS NULL OR project_id=:p"), p).mappings()])
        types = _merge([dict(r) for r in conn.execute(text(
            "SELECT * FROM sitemate.event_types WHERE project_id IS NULL OR project_id=:p"), p).mappings()])
        value = Taxonomy(cats, types)
    _cache[project_id] = (time.monotonic(), value)
    return value
