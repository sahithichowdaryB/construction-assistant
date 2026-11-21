"""Write a confirmed capture into project memory in ONE transaction:
passages -> events -> incidents/alerts (grouping under advisory locks) -> proposed capture_facts -> evidence.
The source and capture rows already exist (created when the upload arrived). Facts stay review_status='proposed'."""

import json
import re

from sqlalchemy import text

from .assets import normalize_asset_key
from .correlation import correlate_events
from .taxonomy import Taxonomy

# Extra event fields kept on events.attributes (the typed columns hold the rest).
ATTRIBUTE_FIELDS = ("severity_flags", "material", "quantity", "unit", "quantity_basis", "outstanding_quantity",
                    "delay_minutes", "expected_restart_at", "impact", "description", "location", "evidence_quote",
                    "equipment_description", "successor_activity_code")


def parse_value(v):
    """Numbers are stored as JSON numbers, everything else as text."""
    if v is None:
        return None
    if isinstance(v, str) and re.fullmatch(r"-?\d+(\.\d+)?", v.strip()):
        n = float(v)
        return int(n) if n.is_integer() and "." not in v else n
    return v


def source_kind(*, audio: bool, images: bool, text: bool) -> str:
    return "voice" if audio else "photo" if images and not text else "text"


def _int_or_none(v):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def persist_capture(engine, state: dict, taxonomy: Taxonomy, correlation_ctx: dict) -> dict:
    p, capture_id, source_id = state["project_id"], state["capture_id"], state["source_id"]
    transcript, perception, answers = state.get("transcript"), state.get("perception") or [], state.get("answers") or []
    events, validation, matches, context = state["events"], state["validation"], state["matches"], state["context"]
    recorded_at = state["recorded_at"]

    with engine.begin() as conn:
        def passage(locator, excerpt):
            conn.execute(text("""
                INSERT INTO sitemate.source_passages (project_id, source_id, locator, page, excerpt)
                VALUES (:p, :s, :l, NULL, :e) ON CONFLICT DO NOTHING"""), {"p": p, "s": source_id, "l": locator, "e": excerpt})

        if transcript:
            passage("transcript", transcript)
        for ph in perception:
            passage(f"image:{ph['n']}", ph["passage"])
        for a in answers:
            passage(f"answer:{a['id']}", f"Q: {a['question']}\nA: {a['answer']}")
        own_refs = ([f"{source_id}|transcript"] if transcript else []) + [f"{source_id}|image:{x['n']}" for x in perception] \
            + [f"{source_id}|answer:{a['id']}" for a in answers]

        known_refs = {f"{x['source_id']}|{x['locator']}" for m in matches for x in m["passages"]} | set(own_refs)
        known_activities = {a["code"] for a in context["activities"]} | {a["code"] for m in matches for a in m["activities"]}
        register_ids = {e["id"] for e in context["equipment"]}
        facts_by = lambda i, field: next((f["value"] for f in validation["validated_facts"]  # noqa: E731
                                          if f["event_index"] == i and f["field_name"] == field), None)

        # 1. events (the user-confirmed category is final; the AI suggestion is kept for auditing)
        rows = []
        for i, ev in enumerate(events):
            activity = facts_by(i, "activity_code") or ev.get("activity_code")
            spoken = facts_by(i, "equipment_id") or ev.get("equipment_id_spoken")
            equipment_id = spoken if spoken in register_ids else None
            asset_key = normalize_asset_key(ev.get("asset_key"), equipment_id or spoken, context["equipment"])
            occurred_at = facts_by(i, "occurred_at") or ev.get("occurred_at") or recorded_at
            attributes = {k: ev[k] for k in ATTRIBUTE_FIELDS if ev.get(k) not in (None, [], "")}
            locator = "transcript" if transcript else (f"image:{perception[0]['n']}" if perception else "transcript")
            activity_ok = activity if activity in known_activities else None
            confidence = ev.get("confidence")
            event_id = conn.scalar(text("""
                INSERT INTO sitemate.events
                  (project_id, capture_id, source_id, locator, event_index, recorded_by, occurred_at, recorded_at,
                   suggested_category, suggested_event_type, suggestion_confidence, suggestion_rationale, suggestion_alternatives,
                   category, event_type, confirmed_by, confirmed_at, summary, zone, activity_code, equipment_id, asset_key,
                   workers_affected, injured_count, attributes, status)
                VALUES (:p, CAST(:cap AS uuid), :src, :loc, :idx, :by, CAST(:oa AS timestamptz), CAST(:ra AS timestamptz),
                        :sc, :se, :conf, :rat, CAST(:alts AS jsonb), :cat, :et, :by, now(), :sum, :zone, :act, :eq, :ak,
                        :workers, :injured, CAST(:attrs AS jsonb), 'confirmed')
                RETURNING id::text"""),
                                   {"p": p, "cap": capture_id, "src": source_id, "loc": locator, "idx": i, "by": state["captured_by"],
                                    "oa": occurred_at, "ra": recorded_at, "sc": ev.get("suggested_category"),
                                    "se": ev.get("suggested_event_type"),
                                    "conf": None if confidence is None else min(1.0, max(0.0, float(confidence))),
                                    "rat": ev.get("rationale"), "alts": json.dumps(ev.get("alternatives") or []),
                                    "cat": ev["category"], "et": ev["event_type"], "sum": ev["summary"], "zone": ev.get("zone"),
                                    "act": activity_ok, "eq": equipment_id, "ak": asset_key,
                                    "workers": _int_or_none(facts_by(i, "workers_affected") or ev.get("workers_affected")),
                                    "injured": _int_or_none(ev.get("injured_count")), "attrs": json.dumps(attributes)})
            rows.append({"id": event_id, "event_index": i, "category": ev["category"], "event_type": ev["event_type"],
                         "summary": ev["summary"], "zone": ev.get("zone"), "activity_code": activity_ok, "asset_key": asset_key,
                         "occurred_at": occurred_at, "recorded_at": recorded_at, "material": ev.get("material")})

        # 2. group into incidents / attach updates
        links = correlate_events(conn, {**correlation_ctx, "project_id": p, "taxonomy": taxonomy}, rows)
        incident_ids = {l["event_index"]: l["incident_id"] for l in links}

        # 3. facts + evidence
        saved = []
        for f in validation["validated_facts"]:
            image_locator = f"image:{perception[0]['n'] if perception else 1}"
            locator = f["source"] if f["source"].startswith("answer:") and any(f"answer:{a['id']}" == f["source"] for a in answers) \
                else ("transcript" if transcript else image_locator)
            effective = facts_by(f["event_index"], "occurred_at") or (events[f["event_index"]].get("occurred_at") if f["event_index"] < len(events) else None) or recorded_at
            fact_id = conn.scalar(text("""
                INSERT INTO sitemate.capture_facts (project_id, incident_id, source_id, locator, field_name, value, basis, effective_at)
                VALUES (:p, CAST(:inc AS uuid), :src, :loc, :field, CAST(:val AS jsonb), :basis, CAST(:eff AS timestamptz))
                RETURNING id::text"""),
                                  {"p": p, "inc": incident_ids.get(f["event_index"]), "src": source_id, "loc": locator,
                                   "field": f["field_name"], "val": json.dumps(parse_value(f["value"])), "basis": f["basis"],
                                   "eff": effective})
            for ref in f["evidence_refs"]:
                if f"{ref.get('source_id')}|{ref.get('locator')}" in known_refs:
                    conn.execute(text("""
                        INSERT INTO sitemate.fact_evidence (project_id, fact_id, source_id, locator)
                        VALUES (:p, CAST(:f AS uuid), :s, :l) ON CONFLICT DO NOTHING"""),
                                 {"p": p, "f": fact_id, "s": ref["source_id"], "l": ref["locator"]})
            saved.append({"id": fact_id, **f})
        conn.execute(text("UPDATE sitemate.captures SET status='saved', state=NULL WHERE project_id=:p AND id=CAST(:c AS uuid)"),
                     {"p": p, "c": capture_id})

    return {
        "source_id": source_id, "capture_id": capture_id, "incident_ids": {str(k): v for k, v in incident_ids.items()},
        "facts": saved, "gaps": validation["missing"],
        "incident_links": [{k: l[k] for k in ("event_index", "incident_id", "link_type", "created", "severity", "report_count",
                                              "reporter_count", "title", "alert_id")} for l in links],
        "saved_events": [{"index": r["event_index"], "id": r["id"], "category": r["category"], "event_type": r["event_type"]} for r in rows],
    }
