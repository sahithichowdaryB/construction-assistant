"""Project facts the model may reference by ID, and the business rules that decide what must be asked."""

import json
import re
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from sqlalchemy import text

RULES_FILE = Path(__file__).resolve().parents[3] / "backend" / "rules" / "business_rules.json"


def load_project_context(conn, project_id: str) -> dict:
    project = conn.execute(text(
        "SELECT id, name, timezone, threshold, high_threshold FROM sitemate.projects WHERE id=:p"),
        {"p": project_id}).mappings().one_or_none()
    if project is None:
        raise LookupError(f"Unknown project {project_id}")
    rows = lambda sql: [dict(r) for r in conn.execute(text(sql), {"p": project_id}).mappings()]  # noqa: E731
    return {
        "project": {**project, "threshold": float(project["threshold"]), "high_threshold": float(project["high_threshold"])},
        "activities": rows("SELECT code, name, zone, unit, contractor_id FROM sitemate.activities WHERE project_id=:p ORDER BY code"),
        "equipment": rows("SELECT id, description, owner_id FROM sitemate.equipment WHERE project_id=:p ORDER BY id"),
    }


def load_business_rules(conn, event_types: list[str]) -> list[dict]:
    """Rows of sitemate.business_rules; the JSON seed is the fallback before migration 0003. Duplicate-detection
    rules are dropped: correlation, not the validator, decides what is a duplicate."""
    if conn.scalar(text("SELECT to_regclass('sitemate.business_rules')")) is None:
        rules = [r for r in json.loads(RULES_FILE.read_text(encoding="utf8"))
                 if r["event_type"] == "*" or r["event_type"] in event_types]
    else:
        rules = [dict(r) for r in conn.execute(text("""
            SELECT rule_key, event_type, required_fields, ask_if_missing, description FROM sitemate.business_rules
            WHERE active AND (event_type = ANY(CAST(:t AS text[])) OR event_type='*') ORDER BY rule_key"""),
                                               {"t": event_types}).mappings()]
    return [r for r in rules if not r["rule_key"].endswith(".duplicate")]


def category_rules(events: list[dict], rules: list[dict], taxonomy) -> list[dict]:
    """Synthetic per-category rules for event types that have no business_rules row of their own."""
    covered = {r["event_type"] for r in rules if r.get("required_fields")}
    out, seen = [], set()
    for e in events:
        cat = taxonomy.category(e["category"])
        if not cat or not cat.get("required_fields") or e["event_type"] in covered or e["event_type"] in seen:
            continue
        seen.add(e["event_type"])
        out.append({"rule_key": f"category.{cat['key']}.required", "event_type": e["event_type"],
                    "required_fields": list(cat["required_fields"]), "ask_if_missing": True,
                    "description": f"A {cat['label'].lower()} report should record: {', '.join(cat['required_fields'])}."})
    return out


# ------------------------------------------------------------------ record search --------------------------------

_STOP = {"the", "and", "for", "that", "this", "with", "are", "was", "but", "can", "still", "just", "from", "have", "has",
         "our", "his", "her", "its", "not", "out", "all", "any", "some", "there", "they"}


def local_date(iso: str, tz: str):
    return datetime.fromisoformat(iso).astimezone(ZoneInfo(tz)).date()


def _ts_query(text_: str):
    """OR-query of the note's content words; parameter-safe because words are reduced to [a-z0-9]."""
    words = list(dict.fromkeys(w for w in re.findall(r"[a-z0-9]{3,}", (text_ or "").lower()) if w not in _STOP))
    return " | ".join(words[:12]) or None


def _norm_zone(zone):
    return re.sub(r"^zones?\s+", "", zone or "", flags=re.I).strip() or None


def _search_event(conn, project_id, event, timezone, recorded_at):
    at = event.get("occurred_at") or recorded_at
    work_date = local_date(at, timezone)
    zone = _norm_zone(event.get("zone"))
    p = {"p": project_id, "day": work_date, "zone": zone, "cutoff": datetime.fromisoformat(recorded_at)}
    wanted = [c for c in (event.get("activity_code"), event.get("successor_activity_code")) if c]

    activities = [dict(r) for r in conn.execute(text("""
        SELECT a.code, a.name, a.zone, a.unit, a.contractor_id, t.quantity AS planned_qty_on_date
        FROM sitemate.activities a
        LEFT JOIN sitemate.plan_targets t ON (t.project_id, t.activity_code, t.work_date) = (a.project_id, a.code, CAST(:day AS date))
        WHERE a.project_id=:p AND (a.code = ANY(CAST(:wanted AS text[]))
              OR (CAST(:zone AS text) IS NOT NULL AND (upper(a.zone)=upper(CAST(:zone AS text)) OR a.zone ILIKE '%' || CAST(:zone AS text) || '%')))
        ORDER BY (t.quantity > 0) DESC NULLS LAST, a.code"""), {**p, "wanted": wanted}).mappings()]
    for a in activities:
        a["planned_qty_on_date"] = float(a["planned_qty_on_date"]) if a["planned_qty_on_date"] is not None else None
    codes = [a["code"] for a in activities]

    equipment = [dict(r) for r in conn.execute(text("""
        SELECT e.id, e.description, e.owner_id, ea.activity_code AS assigned_to, ea.work_date
        FROM sitemate.equipment e
        LEFT JOIN sitemate.equipment_assignments ea ON (ea.project_id, ea.equipment_id, ea.work_date) = (e.project_id, e.id, CAST(:day AS date))
        WHERE e.project_id=:p AND (e.id = CAST(:eq AS text) OR ea.activity_code = ANY(CAST(:codes AS text[])))
        ORDER BY e.id"""), {**p, "eq": event.get("equipment_id_spoken"), "codes": codes}).mappings()]

    progress = [dict(r) for r in conn.execute(text("""
        SELECT o.activity_code, o.quantity, o.basis, o.source_id, o.locator
        FROM sitemate.observations o JOIN sitemate.sources s ON (s.project_id, s.id) = (o.project_id, o.source_id)
        WHERE o.project_id=:p AND o.activity_code = ANY(CAST(:codes AS text[])) AND o.work_date=CAST(:day AS date)
          AND s.available_at <= :cutoff ORDER BY (o.basis='signed') DESC, s.available_at DESC"""),
                                      {**p, "codes": codes}).mappings()] if codes else []
    for r in progress:
        r["quantity"] = float(r["quantity"])

    incidents = [dict(r) for r in conn.execute(text("""
        SELECT i.id::text AS id, i.activity_code, i.kind, i.title, i.occurred_at, i.resolved_at,
               coalesce(json_agg(json_build_object('field', f.field_name, 'value', f.value, 'basis', f.basis))
                        FILTER (WHERE f.id IS NOT NULL), '[]') AS facts
        FROM sitemate.incidents i
        LEFT JOIN sitemate.capture_facts f ON (f.project_id, f.incident_id) = (i.project_id, i.id) AND f.review_status <> 'rejected'
        WHERE i.project_id=:p AND (i.activity_code = ANY(CAST(:codes AS text[])) OR cardinality(CAST(:codes AS text[])) = 0)
          AND i.occurred_at <= :cutoff AND (i.resolved_at IS NULL OR i.occurred_at > :cutoff - interval '24 hours')
        GROUP BY i.project_id, i.id ORDER BY i.occurred_at DESC LIMIT 10"""), {**p, "codes": codes}).mappings()]

    # Keyword search over evidence available at recording time (swap for a pgvector query once passages are embedded).
    q = _ts_query(f"{event.get('evidence_quote') or ''} {event.get('summary') or ''}")
    passages = [dict(r) for r in conn.execute(text("""
        SELECT sp.source_id, sp.locator, sp.page, left(sp.excerpt, 500) AS excerpt, s.kind, s.available_at
        FROM sitemate.source_passages sp JOIN sitemate.sources s ON (s.project_id, s.id) = (sp.project_id, sp.source_id)
        WHERE sp.project_id=:p AND s.available_at <= :cutoff
          AND (sp.locator = ANY(CAST(:codes AS text[]))
               OR (CAST(:q AS text) IS NOT NULL AND to_tsvector('english', sp.excerpt) @@ to_tsquery('english', CAST(:q AS text))))
        ORDER BY (sp.locator = ANY(CAST(:codes AS text[]))) DESC,
                 ts_rank(to_tsvector('english', sp.excerpt), to_tsquery('english', coalesce(CAST(:q AS text), ''))) DESC
        LIMIT 8"""), {**p, "codes": codes, "q": q}).mappings()]

    return {"work_date": str(work_date), "activities": activities, "equipment": equipment, "progress": progress,
            "incidents": incidents, "passages": passages}


def search_database(conn, project_id, events, timezone, recorded_at) -> list[dict]:
    """Matching records for each extracted event, as of the recording time."""
    return [{"event_index": i, **_search_event(conn, project_id, e, timezone, recorded_at)} for i, e in enumerate(events)]


def _relationships(conn, project_id, codes, equipment_ids, work_date):
    if not codes and not equipment_ids:
        return None
    p = {"p": project_id, "codes": codes, "eq": equipment_ids, "day": work_date}
    deps = [dict(r) for r in conn.execute(text("""
        SELECT d.predecessor, d.successor, s.name AS successor_name, pr.name AS predecessor_name
        FROM sitemate.activity_dependencies d
        JOIN sitemate.activities s ON (s.project_id, s.code) = (d.project_id, d.successor)
        JOIN sitemate.activities pr ON (pr.project_id, pr.code) = (d.project_id, d.predecessor)
        WHERE d.project_id=:p AND (d.predecessor = ANY(CAST(:codes AS text[])) OR d.successor = ANY(CAST(:codes AS text[])))"""), p).mappings()]
    contractors = [dict(r) for r in conn.execute(text("""
        SELECT c.id, c.name, c.trade, c.contact_role,
               array_remove(array_agg(DISTINCT a.code), NULL) AS for_activities,
               array_remove(array_agg(DISTINCT e.id), NULL) AS owns_equipment
        FROM sitemate.contractors c
        LEFT JOIN sitemate.activities a ON (a.project_id, a.contractor_id) = (c.project_id, c.id) AND a.code = ANY(CAST(:codes AS text[]))
        LEFT JOIN sitemate.equipment e ON (e.project_id, e.owner_id) = (c.project_id, c.id) AND e.id = ANY(CAST(:eq AS text[]))
        WHERE c.project_id=:p AND (a.code IS NOT NULL OR e.id IS NOT NULL)
        GROUP BY c.id, c.name, c.trade, c.contact_role"""), p).mappings()]
    shared = [dict(r) for r in conn.execute(text("""
        SELECT equipment_id, activity_code FROM sitemate.equipment_assignments
        WHERE project_id=:p AND work_date=CAST(:day AS date) AND equipment_id = ANY(CAST(:eq AS text[]))
          AND NOT activity_code = ANY(CAST(:codes AS text[]))"""), p).mappings()]
    open_alerts = [dict(r) for r in conn.execute(text("""
        SELECT a.id::text AS id, a.activity_code, a.kind, a.checkpoint_at, r.severity
        FROM sitemate.alerts a
        JOIN LATERAL (SELECT severity FROM sitemate.alert_revisions r
                      WHERE (r.project_id, r.alert_id) = (a.project_id, a.id) ORDER BY version DESC LIMIT 1) r ON true
        WHERE a.project_id=:p AND a.status='open' AND a.activity_code = ANY(CAST(:codes AS text[]))"""), p).mappings()]
    return {"dependencies": deps, "contractors": contractors, "shared_equipment": shared, "open_alerts": open_alerts}


def match_relationships(conn, project_id, matches) -> list[dict]:
    """Schedule predecessors/successors, responsible contractors, shared equipment and open alerts per event."""
    out = []
    for m in matches:
        rel = _relationships(conn, project_id, [a["code"] for a in m["activities"]], [e["id"] for e in m["equipment"]], m["work_date"])
        out.append({"event_index": m["event_index"], **(rel or {})})
    return out
