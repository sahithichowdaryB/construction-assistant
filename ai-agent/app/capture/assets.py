"""Normalising "the hoist", "lift 2", "goods lift" so reports about the same asset share one key."""

import re

_KINDS = {"lift": "lift", "hoist": "lift", "elevator": "lift", "crane": "crane", "excavator": "excavator",
          "digger": "excavator", "generator": "generator", "pump": "pump", "compressor": "compressor",
          "mixer": "mixer", "loader": "loader", "dumper": "dumper", "forklift": "forklift",
          "telehandler": "telehandler", "scaffold": "scaffold", "boiler": "boiler"}
_FILLER = {"the", "a", "an", "no", "not", "working", "broken", "down", "site", "main"}
_STOP = {"the", "and", "for", "that", "this", "with", "are", "was", "but", "can", "still", "just", "from", "have",
         "has", "our", "not", "out", "all", "any", "some", "there", "they", "its", "been", "again"}


def normalize_asset_key(asset_key=None, equipment_id_spoken=None, register=()):
    """Equipment-register id when known ("eq:EX-02"), else a slug "kind:qualifier" ("lift:goods").
    Register matching is the reliable path; the slug is a best-effort fallback for unregistered assets."""
    ids = {e["id"].lower(): e["id"] for e in register}
    stripped = re.sub(r"^eq:", "", asset_key or "", flags=re.I)
    for candidate in (equipment_id_spoken, stripped):
        hit = candidate and ids.get(candidate.strip().lower())
        if hit:
            return f"eq:{hit}"
    raw = stripped.strip()
    if not raw:
        return None
    tokens = [re.sub(r"^l(\d+)$", r"\1", t) for t in re.sub(r"[^a-z0-9]+", " ", raw.lower()).split()
              if t and t not in _FILLER]
    kind = next((t for t in tokens if t in _KINDS), None)
    if kind is None:
        return "-".join(tokens) or None
    qualifiers = sorted(t for t in tokens if t != kind and t not in _KINDS)
    return f"{_KINDS[kind]}:{'-'.join(qualifiers)}" if qualifiers else _KINDS[kind]


def norm_zone(zone):
    return re.sub(r"^zones?\s+", "", zone or "", flags=re.I).strip().lower() or None


def cluster_key(category, event: dict, grouping_fields=()):
    """"category:part:part" from the category's grouping_fields. Missing parts fall back to zone + event type,
    then to the event type alone, so every event gets a stable key."""
    def value(field):
        if field == "site":
            return "site"
        if field == "zone":
            return norm_zone(event.get("zone"))
        if field == "material":
            m = event.get("material")
            return re.sub(r"\s+", "-", m.strip().lower()) if m else None
        return event.get(field) or None

    parts = [value(f) for f in grouping_fields]
    if not grouping_fields or any(not p for p in parts):
        parts = [p for p in (norm_zone(event.get("zone")), event.get("event_type")) if p]
    if not parts:
        parts = [event.get("event_type") or "unknown"]
    return f"{category}:{':'.join(parts)}"


def _words(text):
    return {w for w in re.findall(r"[a-z0-9]{3,}", (text or "").lower()) if w not in _STOP}


def text_similarity(a, b) -> float:
    """Jaccard similarity of content words; stands in for pg_trgm so no extension is required."""
    x, y = _words(a), _words(b)
    if not x or not y:
        return 0.0
    return len(x & y) / len(x | y)
