"""The three-screen demo workflow: foreman note -> site manager notice -> approver decision.

Foreman (contributor):  POST /field-notes stores the note as a source with one passage and
                        proposed capture_facts; POST /field-notes/{id}/confirm confirms them.
Site manager (manager): POST /drafts writes a delay notice (drafts + draft_versions v1) from a
                        shortfall alert, the schedule and confirmed field-note facts. Missing
                        contract details stay visible as [MISSING: ...]. POST /drafts/{id}/versions
                        fills them in as a new version.
Approver (approver):    POST /drafts/{id}/versions/{v}/review records approved or
                        changes_requested in reviews. Approval is refused while fields are missing.

Every read is filtered by as_of (the replay clock); writes are stamped with it.
"""

import hashlib
import json
import re
from datetime import date as calendar_date, datetime, time, timedelta, timezone
from typing import Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import text

import mailer
from database import writer_engine
from documents.notice_export import pdf_letter, word_letter
from deps import check_cutoff, check_member, connection, require_roles

router = APIRouter(prefix="/projects/{project_id}", tags=["workflow"])
CUTOFF = "coalesce(CAST(:cutoff AS timestamptz), 'infinity')"
NOTICE = "delay_notice"
NOTICE_LABEL = {"delay_notice": "Delay notice", "incident_notice": "Site incident notice", "email": "Email",
                "additional_cost": "Additional cost notice", "notice_of_concern": "Notice of concern",
                "defect_notice": "Defect notice"}
MISSING = re.compile(r"\[MISSING: ([^\]]+)\]")
NUMBER_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8,
                "nine": 9, "ten": 10, "eleven": 11, "twelve": 12}
FACT_LABEL = {"event_type": "What happened", "occurred_at": "When", "workers_affected": "Workers stopped",
              "equipment_id": "Equipment", "activity_code": "Activity", "zone": "Zone", "cause": "Cause",
              "summary": "Summary"}
EVENT_LABEL = {"equipment_breakdown": "Equipment breakdown", "injury": "Injury", "delay": "Delay",
               "material_shortage": "Material shortage", "weather": "Weather", "other": "Other event"}


def ref(source_id, locator):
    return {"source_id": source_id, "locator": locator, "passage_id": f"{source_id}:{locator}"}


def stamp(as_of):
    """Writes are stamped with the replay clock, or the real time when none is given."""
    check_cutoff(as_of)
    return as_of or datetime.now(timezone.utc).replace(microsecond=0)


# ------------------------------------------------------------------ foreman: field notes

class NoteIn(BaseModel):
    text: str = Field(min_length=3, max_length=2000)
    # The activity the foreman picked on the screen; when absent it is inferred from the machine named.
    activity_code: str | None = Field(None, max_length=40)


def _project(conn, project_id):
    row = conn.execute(text("SELECT * FROM sitemate.projects WHERE id=:p"), {"p": project_id}).mappings().one_or_none()
    if row is None:
        raise HTTPException(404, "Unknown project")
    return row


def _number(word):
    return int(word) if word.isdigit() else NUMBER_WORDS.get(word.lower())


def _rule_based(note):
    """Deterministic reading of a short field note, used alone or to check the model."""
    lower = note.lower()
    event = ("equipment_breakdown" if re.search(r"\bbr(oke|eak)s?\s*down|breakdown|burst|failed|failure|stopped working", lower)
             else "injury" if re.search(r"injur|hurt|accident", lower) else "other")
    when = re.search(r"\bat\s+(\d{1,2}|" + "|".join(NUMBER_WORDS) + r")(?:[:.](\d{2}))?\s*(am|pm|o'clock)?", lower)
    time = None
    if when:
        hour = _number(when[1])
        if hour is not None:
            hour += 12 if when[3] == "pm" and hour < 12 else 0
            time = f"{hour:02d}:{int(when[2] or 0):02d}" if hour < 24 else None
    workers = re.search(r"\b(\d+|" + "|".join(NUMBER_WORDS) + r")\s+(?:workers|people|operatives|men|crew members?)", lower)
    return {"event_type": event, "occurred_local_time": time,
            "workers_affected": _number(workers[1]) if workers else None,
            "equipment_id": (m[0].upper() if (m := re.search(r"\b[a-z]{2}-\d{2}\b", lower)) else None),
            "cause": None, "summary": note.strip()}


FACT_SCHEMA = {
    "type": "object",
    "properties": {
        "event_type": {"type": "string", "enum": list(EVENT_LABEL)},
        "summary": {"type": "string"},
        "occurred_local_time": {"type": ["string", "null"], "description": "24h HH:MM, only if the note states a time"},
        "workers_affected": {"type": ["integer", "null"], "description": "only if the note states a number"},
        "equipment_id": {"type": ["string", "null"], "description": "only an ID written in the note, e.g. EX-02"},
        "cause": {"type": ["string", "null"], "description": "only if the note states the cause"},
    },
    "required": ["event_type", "summary", "occurred_local_time", "workers_affected", "equipment_id", "cause"],
    "additionalProperties": False,
}
FACT_PROMPT = ("You read a construction foreman's short field note and return its facts as JSON. Use only what "
               "the note states. Never guess a time, number, equipment ID or cause: use null when it is not "
               "written. Times are local 24-hour HH:MM (\"at 10\" is 10:00). The summary is one plain sentence.")


def _extract(note):
    """Claude reads the note; every value it returns must be backed by the note's own words."""
    rules = _rule_based(note)
    try:
        from documents import llm
        data, _ = llm.complete_json(FACT_PROMPT, [{"type": "text", "text": note}], schema=FACT_SCHEMA,
                                    max_tokens=2000, effort="low")
    except Exception:  # model unavailable: the deterministic reading is still correct for short notes
        return rules
    lower = note.lower()
    if data.get("workers_affected") is not None and data["workers_affected"] != rules["workers_affected"]:
        n = data["workers_affected"]
        words = [w for w, v in NUMBER_WORDS.items() if v == n]
        if str(n) not in lower and not any(w in lower for w in words):
            data["workers_affected"] = rules["workers_affected"]
    if data.get("occurred_local_time") and not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", data["occurred_local_time"]):
        data["occurred_local_time"] = rules["occurred_local_time"]
    if data.get("occurred_local_time") and rules["occurred_local_time"] is None:
        hour = int(data["occurred_local_time"][:2])
        spoken = [w for w, v in NUMBER_WORDS.items() if v in (hour, hour - 12)]
        if not re.search(rf"\b0?{hour % 12 or 12}\b|\b{hour}\b", lower) and not any(w in lower for w in spoken):
            data["occurred_local_time"] = None
    if data.get("equipment_id") and data["equipment_id"].lower() not in lower:
        data["equipment_id"] = None
    if data.get("cause") and not any(w in lower for w in data["cause"].lower().split() if len(w) > 3):
        data["cause"] = None
    return data


def _assignments(conn, project_id, work_date, activity_code=None):
    """Equipment assigned on the latest register date on or before work_date (optionally one activity)."""
    return conn.execute(text("""
        SELECT e.id, e.description, a.activity_code, act.zone
        FROM sitemate.equipment e
        JOIN sitemate.equipment_assignments a ON (a.project_id, a.equipment_id) = (e.project_id, e.id)
        LEFT JOIN sitemate.activities act ON (act.project_id, act.code) = (a.project_id, a.activity_code)
        WHERE e.project_id = :p AND (CAST(:c AS text) IS NULL OR a.activity_code = :c) AND a.work_date = (
            SELECT max(work_date) FROM sitemate.equipment_assignments WHERE project_id = :p AND work_date <= :d)
        ORDER BY e.id
    """), {"p": project_id, "d": work_date, "c": activity_code}).mappings().all()


def _infer_equipment(conn, project_id, note, work_date, activity_code=None):
    """Match the machine named in the note ("excavator") to the equipment register for that day."""
    rows = _assignments(conn, project_id, work_date, activity_code)
    lower = note.lower()
    hits = [r for r in rows if r["description"].lower().split()[-1] in lower or r["id"].lower() in lower]
    return hits[0] if len(hits) == 1 else None


def _note_view(conn, project_id, source):
    facts = conn.execute(text("""
        SELECT id, field_name, value, basis, review_status, reviewed_by, reviewed_at
        FROM sitemate.capture_facts WHERE project_id = :p AND source_id = :s ORDER BY field_name
    """), {"p": project_id, "s": source["id"]}).mappings().all()
    meta = source["meta"] or {}
    tz = ZoneInfo(meta.get("timezone") or "Europe/Berlin")
    out = []
    for f in facts:
        value = f["value"]
        if f["field_name"] == "occurred_at":
            shown = datetime.fromisoformat(value).astimezone(tz).strftime("%H:%M, %d %b %Y")
        elif f["field_name"] == "event_type":
            shown = EVENT_LABEL.get(value, value)
        elif f["field_name"] == "equipment_id":
            shown = f"{value} · {meta.get('equipment_description', '')}".rstrip(" ·")
        else:
            shown = str(value)
        refs = [ref(source["id"], "transcript")]
        if f["field_name"] in ("equipment_id", "activity_code", "zone") and f["basis"] == "inferred":
            refs.append(ref("EQ", meta.get("equipment_id", value)))
        out.append({"id": str(f["id"]), "field": f["field_name"], "label": FACT_LABEL.get(f["field_name"], f["field_name"]),
                    "value": value, "display": shown, "basis": f["basis"], "review_status": f["review_status"],
                    "refs": refs})
    order = list(FACT_LABEL)
    out.sort(key=lambda f: order.index(f["field"]) if f["field"] in order else 99)
    statuses = {f["review_status"] for f in out}
    confirmed = [f for f in facts if f["review_status"] == "confirmed"]
    return {"source_id": source["id"], "text": source["excerpt"], "recorded_at": source["available_at"],
            "author": source["author"], "status": "confirmed" if statuses == {"confirmed"} else "proposed",
            "confirmed_by": confirmed[0]["reviewed_by"] if confirmed else None,
            "confirmed_at": confirmed[0]["reviewed_at"] if confirmed else None, "facts": out}


NOTE_SELECT = """
    SELECT s.id, s.available_at, s.author, s.meta, sp.excerpt
    FROM sitemate.sources s
    JOIN sitemate.source_passages sp ON (sp.project_id, sp.source_id, sp.locator) = (s.project_id, s.id, 'transcript')
    WHERE s.project_id = :p AND s.id LIKE 'FN-%'
"""


@router.post("/field-notes", status_code=201)
def record_note(project_id: str, body: NoteIn, as_of: datetime | None = None,
                member=Depends(require_roles("contributor"))):
    """Store the note as a source and propose its facts for the foreman to confirm."""
    note = re.sub(r"\s+", " ", body.text).strip()
    recorded = stamp(as_of)
    with writer_engine().begin() as conn:
        project = _project(conn, project_id)
        tz = ZoneInfo(project["timezone"])
        local = recorded.astimezone(tz)
        digest = hashlib.sha256(f"{member['member_id']}|{recorded.isoformat()}|{note}".encode()).hexdigest()
        source_id = f"FN-{digest[:8].upper()}"
        existing = conn.execute(text(NOTE_SELECT + " AND s.id = :s"), {"p": project_id, "s": source_id}).mappings().one_or_none()
        if existing:
            return _note_view(conn, project_id, existing)

        picked = None
        if body.activity_code:
            picked = conn.execute(text("SELECT code, name, zone FROM sitemate.activities WHERE project_id=:p AND code=:c"),
                                  {"p": project_id, "c": body.activity_code}).mappings().one_or_none()
            if picked is None:
                raise HTTPException(422, f"Unknown activity {body.activity_code}")
        data = _extract(note)
        equipment = _infer_equipment(conn, project_id, note, local.date(), picked["code"] if picked else None)
        meta = {"timezone": project["timezone"], "recorded_by": member["member_id"], "channel": "typed note"}
        facts = [("event_type", data["event_type"], "reported"), ("summary", data["summary"], "reported")]
        if data.get("occurred_local_time"):
            hour, minute = map(int, data["occurred_local_time"].split(":"))
            facts.append(("occurred_at", local.replace(hour=hour, minute=minute, second=0, microsecond=0).isoformat(), "reported"))
        if data.get("workers_affected") is not None:
            facts.append(("workers_affected", data["workers_affected"], "reported"))
        if data.get("cause"):
            facts.append(("cause", data["cause"], "reported"))
        if data.get("equipment_id"):
            facts.append(("equipment_id", data["equipment_id"], "reported"))
        elif equipment:
            # Inferred: the note names the machine type; the register says which one worked there that day.
            facts.append(("equipment_id", equipment["id"], "inferred"))
            meta.update(equipment_id=equipment["id"], equipment_description=equipment["description"])
        if picked:
            # Chosen by the foreman on the screen: reported, not inferred.
            facts += [("activity_code", picked["code"], "reported"), ("zone", picked["zone"], "reported")]
            meta["activity_name"] = picked["name"]
        elif equipment:
            facts += [("activity_code", equipment["activity_code"], "inferred"), ("zone", equipment["zone"], "inferred")]
        if equipment:
            meta.setdefault("equipment_id", equipment["id"])
            meta.setdefault("equipment_description", equipment["description"])

        conn.execute(text("""
            INSERT INTO sitemate.sources (project_id, id, kind, path, available_at, sha256, title, meta,
                                          ingested_at, author, author_role)
            VALUES (:p, :s, 'voice', 'inline:field-note', :at, :sha, :title, CAST(:meta AS jsonb), now(), :author, :arole)
        """), {"p": project_id, "s": source_id, "at": recorded, "sha": hashlib.sha256(note.encode()).hexdigest(),
               "title": f"Field note {local:%d %b %H:%M}, {member['display_name']}", "meta": json.dumps(meta),
               "author": member["display_name"], "arole": "foreman" if member["role"] == "contributor" else "site_supervisor"})
        conn.execute(text("""
            INSERT INTO sitemate.source_passages (project_id, source_id, locator, page, excerpt, ordinal, kind, section)
            VALUES (:p, :s, 'transcript', NULL, :t, 1, 'transcript', 'Field note')
        """), {"p": project_id, "s": source_id, "t": note})
        for field, value, basis in facts:
            fact_id = conn.scalar(text("""
                INSERT INTO sitemate.capture_facts (project_id, source_id, locator, field_name, value, basis, effective_at)
                VALUES (:p, :s, 'transcript', :f, CAST(:v AS jsonb), :b, :at) RETURNING id
            """), {"p": project_id, "s": source_id, "f": field, "v": json.dumps(value), "b": basis, "at": recorded})
            conn.execute(text("INSERT INTO sitemate.fact_evidence (project_id, fact_id, source_id, locator) "
                              "VALUES (:p, :f, :s, 'transcript')"), {"p": project_id, "f": fact_id, "s": source_id})
            if basis == "inferred" and equipment:
                conn.execute(text("INSERT INTO sitemate.fact_evidence (project_id, fact_id, source_id, locator) "
                                  "SELECT :p, :f, 'EQ', :l WHERE EXISTS (SELECT 1 FROM sitemate.source_passages "
                                  "WHERE project_id=:p AND source_id='EQ' AND locator=:l)"),
                             {"p": project_id, "f": fact_id, "l": equipment["id"]})
        row = conn.execute(text(NOTE_SELECT + " AND s.id = :s"), {"p": project_id, "s": source_id}).mappings().one()
        return _note_view(conn, project_id, row)


@router.get("/field-notes")
def list_notes(project_id: str, as_of: datetime | None = None, mine: bool = False,
               member=Depends(check_member), conn=Depends(connection)):
    check_cutoff(as_of)
    owner_filter = " AND s.meta->>'recorded_by' = :member" if mine or member["role"] == "contributor" else ""
    rows = conn.execute(text(NOTE_SELECT + owner_filter + f" AND s.available_at <= {CUTOFF} ORDER BY s.available_at DESC LIMIT 50"),
                        {"p": project_id, "cutoff": as_of, "member": member["member_id"]}).mappings().all()
    return [_note_view(conn, project_id, r) for r in rows]


@router.post("/field-notes/{source_id}/confirm")
def confirm_note(project_id: str, source_id: str, as_of: datetime | None = None,
                 member=Depends(require_roles("contributor"))):
    when = stamp(as_of)
    with writer_engine().begin() as conn:
        row = conn.execute(text(NOTE_SELECT + " AND s.id = :s"), {"p": project_id, "s": source_id}).mappings().one_or_none()
        if row is None:
            raise HTTPException(404, "Field note not found")
        conn.execute(text("""
            UPDATE sitemate.capture_facts SET review_status = 'confirmed', reviewed_by = :m,
                   reviewed_at = greatest(:at, effective_at)
            WHERE project_id = :p AND source_id = :s AND review_status = 'proposed'
        """), {"p": project_id, "s": source_id, "m": member["member_id"], "at": when})
        return _note_view(conn, project_id, row)


# ------------------------------------------------------------------ the day on site (both screens)

def _severity(pct, project):
    if pct is None or pct <= float(project["threshold"]):
        return "none"
    return "high" if pct > float(project["high_threshold"]) else "medium"


def _latest_reading(conn, project_id, code, day, as_of, signed):
    return conn.execute(text(f"""
        SELECT o.quantity, o.basis, o.source_id, o.locator, s.available_at
        FROM sitemate.observations o JOIN sitemate.sources s ON (s.project_id, s.id) = (o.project_id, o.source_id)
        WHERE o.project_id = :p AND o.activity_code = :c AND o.work_date = :d
          AND (o.basis = 'signed') = :signed AND s.available_at <= {CUTOFF}
        ORDER BY s.available_at DESC LIMIT 1
    """), {"p": project_id, "c": code, "d": day, "cutoff": as_of, "signed": signed}).mappings().one_or_none()


@router.get("/site-day", dependencies=[Depends(check_member)])
def site_day(project_id: str, date: str | None = None, as_of: datetime | None = None, conn=Depends(connection)):
    """Every activity planned for a day: plan, signed and estimated quantities known at as_of, shortfall,
    equipment, foreman notes and notice status. Computed from plan_targets and observations."""
    check_cutoff(as_of)
    project = _project(conn, project_id)
    tz = ZoneInfo(project["timezone"])
    day = datetime.fromisoformat(date).date() if date else (as_of or datetime.now(timezone.utc)).astimezone(tz).date()
    span = conn.execute(text("SELECT min(work_date), max(work_date) FROM sitemate.plan_targets "
                             "WHERE project_id = :p AND quantity > 0"), {"p": project_id}).one()
    targets = conn.execute(text("""
        SELECT t.activity_code, t.quantity, t.source_id, t.locator, a.name, a.unit, a.zone, c.name AS contractor
        FROM sitemate.plan_targets t
        JOIN sitemate.activities a ON (a.project_id, a.code) = (t.project_id, t.activity_code)
        LEFT JOIN sitemate.contractors c ON (c.project_id, c.id) = (a.project_id, a.contractor_id)
        WHERE t.project_id = :p AND t.work_date = :d AND t.quantity > 0 ORDER BY t.activity_code
    """), {"p": project_id, "d": day}).mappings().all()
    equipment = {}
    for e in _assignments(conn, project_id, day):
        equipment.setdefault(e["activity_code"], []).append({"id": e["id"], "description": e["description"]})
    notes = conn.execute(text(f"""
        SELECT cf.value #>> '{{}}' AS code, count(DISTINCT cf.source_id) AS total,
               count(DISTINCT cf.source_id) FILTER (WHERE cf.review_status = 'confirmed') AS confirmed
        FROM sitemate.capture_facts cf JOIN sitemate.sources s ON (s.project_id, s.id) = (cf.project_id, cf.source_id)
        WHERE cf.project_id = :p AND cf.source_id LIKE 'FN-%' AND cf.field_name = 'activity_code'
          AND s.available_at <= {CUTOFF} AND (s.available_at AT TIME ZONE :tz)::date = :d
        GROUP BY 1
    """), {"p": project_id, "cutoff": as_of, "tz": project["timezone"], "d": day}).mappings().all()
    note_counts = {n["code"]: {"total": n["total"], "confirmed": n["confirmed"]} for n in notes}
    notices = conn.execute(text(f"""
        SELECT a.activity_code, a.id AS alert_id, d.id AS draft_id
        FROM sitemate.alerts a
        LEFT JOIN sitemate.drafts d ON (d.project_id, d.alert_id) = (a.project_id, a.id) AND d.notice_type = :t
        WHERE a.project_id = :p AND a.kind = 'shortfall' AND (a.checkpoint_at AT TIME ZONE :tz)::date = :d
          AND EXISTS (SELECT 1 FROM sitemate.alert_revisions r WHERE (r.project_id, r.alert_id) = (a.project_id, a.id)
                      AND r.as_of <= {CUTOFF})
    """), {"p": project_id, "t": NOTICE, "tz": project["timezone"], "d": day, "cutoff": as_of}).mappings().all()
    by_code = {n["activity_code"]: n for n in notices}

    rows = []
    for t in targets:
        code, planned = t["activity_code"], float(t["quantity"])
        signed = _latest_reading(conn, project_id, code, day, as_of, True)
        estimate = _latest_reading(conn, project_id, code, day, as_of, False)
        actual = float(signed["quantity"]) if signed else None
        pct = round(100 * max(planned - actual, 0) / planned, 2) if actual is not None else None
        severity = _severity(pct, project) if signed else None
        notice = by_code.get(code)
        status = None
        if notice and notice["draft_id"]:
            status = (_draft_view(conn, project_id, str(notice["draft_id"]), as_of) or {}).get("status")
        rows.append({
            "code": code, "name": t["name"], "unit": t["unit"], "zone": t["zone"], "contractor": t["contractor"],
            "planned": planned, "plan_ref": ref(t["source_id"], t["locator"]),
            "actual": actual, "actual_ref": ref(signed["source_id"], signed["locator"]) if signed else None,
            "reported_at": signed["available_at"] if signed else None,
            "estimate": ({"value": float(estimate["quantity"]), "basis": estimate["basis"],
                          "ref": ref(estimate["source_id"], estimate["locator"])} if estimate else None),
            "shortfall_pct": pct, "severity": severity,
            "status": "not_reported" if not signed else ("behind" if severity in ("medium", "high") else "on_track"),
            "equipment": equipment.get(code, []), "notes": note_counts.get(code, {"total": 0, "confirmed": 0}),
            "alert_id": str(notice["alert_id"]) if notice else None,
            "notice": {"id": str(notice["draft_id"]), "status": status} if notice and notice["draft_id"] and status else None,
        })
    rank = {"behind": 0, "not_reported": 1, "on_track": 2}
    rows.sort(key=lambda r: (rank[r["status"]], -(r["shortfall_pct"] or 0), r["code"]))
    evaluation = None  # additive (performance evaluation, migration 0009): the latest daily evaluation known at as_of
    if conn.scalar(text("SELECT to_regclass('sitemate.daily_evaluations')")) is not None:
        found = conn.execute(text(f"""
            SELECT version, day_status, day_severity, day_score, status, provisional, as_of,
                   summary->'headline'->>'text' AS headline
            FROM sitemate.daily_evaluations WHERE project_id = :p AND work_date = :d AND as_of <= {CUTOFF}
            ORDER BY version DESC LIMIT 1"""), {"p": project_id, "d": day, "cutoff": as_of}).mappings().one_or_none()
        if found:
            evaluation = {**dict(found), "day_score": float(found["day_score"])}
    return {"date": day.isoformat(), "as_of": as_of, "timezone": project["timezone"],
            "threshold": float(project["threshold"]), "high_threshold": float(project["high_threshold"]),
            "first_day": span[0].isoformat() if span[0] else None, "last_day": span[1].isoformat() if span[1] else None,
            "activities": rows, "daily_evaluation": evaluation}


@router.get("/related", dependencies=[Depends(check_member)])
def related_records(project_id: str, activity_code: str, date: str, as_of: datetime | None = None,
                    conn=Depends(connection)):
    """Other records about this activity and day, found with the documents search (no model call)."""
    check_cutoff(as_of)
    from documents import search as search_module

    project = _project(conn, project_id)
    activity = conn.execute(text("SELECT name FROM sitemate.activities WHERE project_id=:p AND code=:c"),
                            {"p": project_id, "c": activity_code}).mappings().one_or_none()
    if activity is None:
        raise HTTPException(404, "Unknown activity")
    day = datetime.fromisoformat(date).date()
    words = [activity["name"], activity_code] + [e["id"] for e in _assignments(conn, project_id, day, activity_code)]
    words += conn.execute(text(f"""
        SELECT sp.excerpt FROM sitemate.capture_facts cf
        JOIN sitemate.sources s ON (s.project_id, s.id) = (cf.project_id, cf.source_id)
        JOIN sitemate.source_passages sp ON (sp.project_id, sp.source_id, sp.locator) = (s.project_id, s.id, 'transcript')
        WHERE cf.project_id = :p AND cf.source_id LIKE 'FN-%' AND cf.field_name = 'activity_code'
          AND cf.value = to_jsonb(CAST(:c AS text)) AND s.available_at <= {CUTOFF}
          AND (s.available_at AT TIME ZONE :tz)::date = :d
    """), {"p": project_id, "c": activity_code, "cutoff": as_of, "tz": project["timezone"], "d": day}).scalars().all()
    found = search_module.search(conn, project_id, " ".join(words), as_of=as_of, limit=20, use_rerank=False)
    skip_kinds = {"schedule", "project", "register"}
    out, seen = [], set()
    for r in found["results"]:
        if r["source_kind"] in skip_kinds or r["source_id"].startswith("FN-") or r["kind"] == "metadata":
            continue
        # The same text can be stored under two locators (another importer); show it once.
        key = (r["source_id"], re.sub(r"\W+", " ", r["excerpt"]).strip().lower()[:80])
        if key in seen:
            continue
        seen.add(key)
        out.append({"source_id": r["source_id"], "locator": r["locator"], "excerpt": r["excerpt"],
                    "source_kind": r["source_kind"], "source_title": r["source_title"],
                    "available_at": r["available_at"], "untrusted": r["untrusted"],
                    "ref": ref(r["source_id"], r["locator"])})
        if len(out) == 6:
            break
    return {"query": found["query"], "results": out}


# ------------------------------------------------------------------ site manager: delay notice

class DraftIn(BaseModel):
    incident_id: str | None = None
    # Either an existing alert, or an activity and day whose shortfall is checked (and recorded as an alert).
    alert_id: str | None = None
    activity_code: str | None = Field(None, max_length=40)
    work_date: str | None = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    # Performance suggestions (plan section 6.7): the alert's suggested notice type. Default: the delay notice.
    notice_type: str = Field(NOTICE, pattern="^(delay_notice|additional_cost_notice|defect_notice|notice_of_concern)$")


def _ensure_alert(conn, project_id, code, day, as_of):
    """Record the shortfall for an activity and day as an alert (revision) if the signed figures show one."""
    project = _project(conn, project_id)
    tz = ZoneInfo(project["timezone"])
    target = conn.execute(text("""SELECT t.quantity, t.source_id, t.locator, a.unit FROM sitemate.plan_targets t
        JOIN sitemate.activities a ON (a.project_id, a.code) = (t.project_id, t.activity_code)
        WHERE t.project_id = :p AND t.activity_code = :c AND t.work_date = :d AND t.quantity > 0"""),
                          {"p": project_id, "c": code, "d": day}).mappings().one_or_none()
    if target is None:
        raise HTTPException(404, f"{code} has no planned quantity on {day}")
    signed = _latest_reading(conn, project_id, code, day, as_of, True)
    if signed is None:
        raise HTTPException(409, "No signed quantity yet for this day. A notice needs the signed report.")
    planned, actual = float(target["quantity"]), float(signed["quantity"])
    pct = round(100 * max(planned - actual, 0) / planned, 2)
    severity = _severity(pct, project)
    if severity == "none":
        raise HTTPException(409, f"Only {pct:g}% behind plan, within the {float(project['threshold']):g}% threshold")
    checkpoint = datetime.combine(day, datetime.min.time(), tz).replace(hour=17, minute=30)
    conn.execute(text("""INSERT INTO sitemate.alerts (project_id, activity_code, checkpoint_at, kind)
                         VALUES (:p, :c, :cp, 'shortfall') ON CONFLICT DO NOTHING"""),
                 {"p": project_id, "c": code, "cp": checkpoint})
    alert_id = conn.scalar(text("SELECT id FROM sitemate.alerts WHERE project_id=:p AND activity_code=:c "
                                "AND checkpoint_at=:cp AND kind='shortfall'"), {"p": project_id, "c": code, "cp": checkpoint})
    calc = {"planned": planned, "actual": actual, "shortfall_pct": pct, "unit": target["unit"]}
    refs = [{"source_id": target["source_id"], "locator": target["locator"]},
            {"source_id": signed["source_id"], "locator": signed["locator"]}]
    current = conn.execute(text("SELECT calculation FROM sitemate.alert_revisions WHERE project_id=:p AND alert_id=:a "
                                "AND as_of <= :at ORDER BY as_of DESC, version DESC LIMIT 1"),
                           {"p": project_id, "a": alert_id, "at": as_of}).scalar()
    # Daily evaluations add fields to the calculation; only the fields written here decide a new revision.
    if {k: (current or {}).get(k) for k in calc} != calc:
        conn.execute(text("""
            INSERT INTO sitemate.alert_revisions (project_id, alert_id, version, as_of, severity, calculation, evidence_refs, reason)
            SELECT :p, :a, coalesce(max(version), 0) + 1, :at, :sev, CAST(:calc AS jsonb), CAST(:refs AS jsonb), :why
            FROM sitemate.alert_revisions WHERE project_id = :p AND alert_id = :a
        """), {"p": project_id, "a": alert_id, "at": signed["available_at"], "sev": severity, "calc": json.dumps(calc),
               "refs": json.dumps(refs), "why": "Recorded when the site manager drafted a notice"})
    return str(alert_id)


def _lock_notice(conn, notice_key):
    """Serialize decisions and edits without granting UPDATE on immutable records."""
    conn.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"), {"key": str(notice_key)})


class RevisionIn(BaseModel):
    expected_version: int | None = Field(None, ge=1)
    contract_reference: str | None = Field(None, max_length=200)
    contract_clause: str | None = Field(None, max_length=200)
    body: str | None = Field(None, max_length=20000)


def _alert(conn, project_id, alert_id, as_of):
    row = conn.execute(text(f"""
        SELECT a.id, a.activity_code, a.checkpoint_at, a.kind, a.title, r.version, r.as_of, r.calculation,
               r.evidence_refs, r.severity, to_jsonb(r) -> 'suggested_notice' AS suggested_notice
        FROM sitemate.alerts a
        JOIN LATERAL (SELECT * FROM sitemate.alert_revisions r WHERE r.project_id = a.project_id AND r.alert_id = a.id
                      AND r.as_of <= {CUTOFF} ORDER BY r.as_of DESC, r.version DESC LIMIT 1) r ON true
        WHERE a.project_id = :p AND a.id = CAST(:a AS uuid)
    """), {"p": project_id, "a": alert_id, "cutoff": as_of}).mappings().one_or_none()
    if row is None:
        raise HTTPException(404, "Alert not available at this time")
    return row


def _tag(refs):
    return "[" + "; ".join(f"{r['source_id']} · {r['locator']}" for r in refs) + "]"


def compose_notice(conn, project_id, alert, as_of, notice_type=NOTICE):
    """Write the notice from stored records only; every factual sentence carries its citation.

    The shortfall delay notice is unchanged. Other notice types, and delay notices for late starts, are composed by
    performance/notices.py from the alert's calculation and suggested notice."""
    if notice_type != NOTICE or alert.get("kind", "shortfall") != "shortfall":
        from performance.notices import compose_performance_notice
        return compose_performance_notice(conn, project_id, alert, as_of, notice_type)
    project = _project(conn, project_id)
    tz = ZoneInfo(project["timezone"])
    calc = alert["calculation"]
    code = alert["activity_code"]
    day = alert["checkpoint_at"].astimezone(tz).date()
    activity = conn.execute(text("SELECT name, unit, zone FROM sitemate.activities WHERE project_id=:p AND code=:c"),
                            {"p": project_id, "c": code}).mappings().one()
    successors = conn.execute(text("""
        SELECT d.successor, a.name, (SELECT min(work_date) FROM sitemate.plan_targets t
                                      WHERE t.project_id = d.project_id AND t.activity_code = d.successor AND t.quantity > 0) AS starts
        FROM sitemate.activity_dependencies d JOIN sitemate.activities a ON (a.project_id, a.code) = (d.project_id, d.successor)
        WHERE d.project_id = :p AND d.predecessor = :c ORDER BY d.successor
    """), {"p": project_id, "c": code}).mappings().all()
    # Confirmed field-note facts for this activity on that day, recorded by as_of.
    facts = conn.execute(text(f"""
        SELECT cf.source_id, cf.field_name, cf.value, s.meta, s.author, sp.excerpt
        FROM sitemate.capture_facts cf JOIN sitemate.sources s ON (s.project_id, s.id) = (cf.project_id, cf.source_id)
        JOIN sitemate.source_passages sp ON (sp.project_id, sp.source_id, sp.locator) = (s.project_id, s.id, 'transcript')
        WHERE cf.project_id = :p AND cf.source_id LIKE 'FN-%' AND cf.review_status = 'confirmed'
          AND s.available_at <= {CUTOFF} AND (s.available_at AT TIME ZONE :tz)::date = :day
          AND cf.source_id IN (SELECT source_id FROM sitemate.capture_facts
                               WHERE project_id = :p AND field_name = 'activity_code' AND value = to_jsonb(CAST(:c AS text)))
        ORDER BY s.available_at
    """), {"p": project_id, "c": code, "cutoff": as_of, "tz": project["timezone"], "day": day}).mappings().all()
    note = {}
    for f in facts:
        note.setdefault(f["source_id"], {"meta": f["meta"] or {}, "author": f["author"], "text": f["excerpt"]})[
            f["field_name"]] = f["value"]

    refs = [dict(r) for r in alert["evidence_refs"]]
    unit = calc.get("unit", activity["unit"])
    planned, actual = calc["planned"], calc["actual"]
    sender = project["sender"] or "[MISSING: sender]"
    paragraphs = []
    # Each confirmed field note is quoted in the reporter's own words, with the register for the machine.
    for source_id, n in note.items():
        when = datetime.fromisoformat(n["occurred_at"]).astimezone(tz).strftime("%H:%M") if n.get("occurred_at") else None
        who = n["author"] or "The site team"
        text_ = (f"At {when} on {day:%d %B %Y}" if when else f"On {day:%d %B %Y}") + f", {who} reported: “{n['text']}”"
        note_refs = [ref(source_id, "transcript")]
        if n.get("equipment_id"):
            text_ += (f" The equipment register assigns {n['equipment_id']}"
                      f" ({n['meta'].get('equipment_description', 'equipment').lower()}) to {activity['name']} that day.")
            note_refs.append(ref("EQ", n["equipment_id"]))
        if n.get("cause"):
            text_ += f" The reported cause is {n['cause']}."
        paragraphs.append(f"{text_} {_tag(note_refs)}")
        refs += [{"source_id": r["source_id"], "locator": r["locator"]} for r in note_refs]
    shortfall = planned - actual
    paragraphs.append(
        f"The signed daily report records {actual:g} {unit} of {activity['name']} ({code}) against "
        f"{planned:g} {unit} scheduled for {day:%d %B %Y}. This leaves a shortfall of {shortfall:g} {unit}, "
        f"or {calc.get('shortfall_pct', round(100 * shortfall / planned, 1)):g}%. {_tag(alert['evidence_refs'])}")
    for s in successors:
        start = f" is due to start on {s['starts']:%d %B}" if s["starts"] else " follows this work"
        paragraphs.append(f"{s['name']} ({s['successor']}){start} after the {activity['name']} handover. "
                          f"That start is at risk. {_tag([ref('SCH', s['successor'])])}")
        refs.append({"source_id": "SCH", "locator": s["successor"]})
    breakdown = any(n.get("event_type") == "equipment_breakdown" for n in note.values())
    resume = "the equipment is back in service" if breakdown else f"{activity['name']} is back to the planned rate"
    paragraphs.append(f"We will update you once {resume} and the effect on the programme can be assessed. "
                      "Please confirm receipt of this notice.")

    header = [
        "DELAY NOTICE (DRAFT FOR REVIEW)",
        f"{day:%d %B %Y} | {project['name']}",
        f"From: {sender}",
        f"To: {project['recipient'] or '[MISSING: recipient]'}",
        f"Contract reference: {project['contract_reference'] or '[MISSING: contract reference]'}",
        f"Applicable clause: {project['contract_clause'] or '[MISSING: contract clause]'}",
        "",
        f"Subject: Delay to {activity['name']} ({code})",
        "",
        f"Dear {(project['recipient'] or 'Sir or Madam').split(',')[0]},",
    ]
    body = "\n".join(header) + "\n\n" + "\n\n".join(paragraphs) + f"\n\n{sender.split(',')[0]}"
    unique = []
    for r in refs:
        key = (r["source_id"], r["locator"])
        if key not in {(u["source_id"], u["locator"]) for u in unique}:
            unique.append({"source_id": r["source_id"], "locator": r["locator"]})
    return body, unique


def _missing(body):
    return sorted(set(MISSING.findall(body)))


@router.get("/day-records", dependencies=[Depends(require_roles("manager"))])
def day_records(project_id: str, date: calendar_date, as_of: datetime | None = None,
                period: Literal["day", "week"] = "day", conn=Depends(connection)):
    check_cutoff(as_of)
    tz = ZoneInfo(_project(conn, project_id)["timezone"])
    first_day = date - timedelta(days=date.weekday()) if period == "week" else date
    start = datetime.combine(first_day, time.min, tz)
    end = start + timedelta(days=7 if period == "week" else 1)
    return conn.execute(text(f"""
        SELECT e.id::text AS id, e.summary AS title, e.event_type AS kind,
               CASE WHEN e.occurred_at >= :start AND e.occurred_at < :end AND e.occurred_at <= {CUTOFF} THEN e.occurred_at
                    ELSE e.recorded_at END AS at, e.source_id, ie.incident_id::text AS incident_id,
               NULL::text AS draft_id, NULL::integer AS version, false AS correspondence
        FROM sitemate.events e
        JOIN sitemate.captures c ON (c.project_id,c.id)=(e.project_id,e.capture_id) AND c.status='saved'
        LEFT JOIN sitemate.incident_events ie ON (ie.project_id,ie.event_id)=(e.project_id,e.id)
            AND ie.linked_at <= {CUTOFF} AND (ie.unlinked_at IS NULL OR ie.unlinked_at > {CUTOFF})
        WHERE e.project_id=:p AND e.recorded_at <= {CUTOFF} AND (
            (e.occurred_at >= :start AND e.occurred_at < :end AND e.occurred_at <= {CUTOFF})
            OR (e.recorded_at >= :start AND e.recorded_at < :end))
        UNION ALL
        SELECT s.id, coalesce(sp.excerpt,s.title,s.id), s.kind, s.available_at, s.id, NULL, NULL, NULL, false
        FROM sitemate.sources s
        LEFT JOIN sitemate.source_passages sp ON (sp.project_id,sp.source_id,sp.locator)=(s.project_id,s.id,'transcript')
        WHERE s.project_id=:p AND s.available_at >= :start AND s.available_at < :end AND s.available_at <= {CUTOFF}
          AND NOT EXISTS (SELECT 1 FROM sitemate.captures c WHERE (c.project_id,c.source_id)=(s.project_id,s.id))
        UNION ALL
        SELECT concat('draft:', d.id, ':', v.version),
               coalesce(substring(v.body from '(?n)^Subject: ([^\r\n]+)'), d.keywords, replace(d.notice_type, '_', ' ')),
               d.notice_type, v.as_of, NULL, NULL, d.id::text, v.version, d.request IS NOT NULL
        FROM sitemate.draft_versions v
        JOIN sitemate.drafts d ON (d.project_id,d.id)=(v.project_id,v.draft_id)
        WHERE v.project_id=:p AND v.as_of >= :start AND v.as_of < :end AND v.as_of <= {CUTOFF}
        ORDER BY at DESC, id"""), {"p": project_id, "start": start, "end": end,
                                   "cutoff": as_of or datetime.now(timezone.utc)}).mappings().all()


@router.get("/incidents/{incident_id}/notice-preview", dependencies=[Depends(require_roles("manager"))])
def incident_notice_preview(project_id: str, incident_id: str, as_of: datetime | None = None, conn=Depends(connection)):
    when = stamp(as_of)
    params = {"p": project_id, "i": _uuid(incident_id), "at": when}
    incident = conn.execute(text("""
        SELECT i.title, i.occurred_at, p.name AS project, p.timezone,
               (SELECT d.id::text FROM sitemate.drafts d WHERE d.project_id=i.project_id AND d.incident_id=i.id
                AND d.notice_type='incident_notice' LIMIT 1) AS existing_id
        FROM sitemate.incidents i JOIN sitemate.projects p ON p.id=i.project_id
        WHERE i.project_id=:p AND i.id=CAST(:i AS uuid) AND i.occurred_at <= :at"""), params).mappings().one_or_none()
    if not incident:
        raise HTTPException(404, "This incident is unavailable at the selected time.")
    events = conn.execute(text("""
        SELECT e.summary, e.source_id, e.locator, e.occurred_at,
               ARRAY(SELECT sp.locator FROM sitemate.source_passages sp
                     WHERE (sp.project_id,sp.source_id)=(e.project_id,e.source_id)
                       AND sp.locator LIKE 'image:%' ORDER BY sp.locator) AS photo_locators
        FROM sitemate.incident_events ie JOIN sitemate.events e ON (e.project_id,e.id)=(ie.project_id,ie.event_id)
        WHERE ie.project_id=:p AND ie.incident_id=CAST(:i AS uuid) AND ie.linked_at <= :at
          AND (ie.unlinked_at IS NULL OR ie.unlinked_at > :at) AND e.recorded_at <= :at
        ORDER BY e.recorded_at, e.event_index"""), params).mappings().all()
    facts = conn.execute(text("""
        SELECT cf.field_name, cf.value, fe.source_id, fe.locator
        FROM sitemate.capture_facts cf JOIN sitemate.fact_evidence fe ON (fe.project_id,fe.fact_id)=(cf.project_id,cf.id)
        JOIN sitemate.sources s ON (s.project_id,s.id)=(fe.project_id,fe.source_id)
        WHERE cf.project_id=:p AND cf.incident_id=CAST(:i AS uuid) AND cf.review_status='confirmed'
          AND cf.effective_at<=:at AND s.available_at<=:at
          AND NOT EXISTS (SELECT 1 FROM sitemate.capture_facts newer WHERE newer.project_id=cf.project_id
                          AND newer.supersedes_id=cf.id AND newer.effective_at<=:at)
        ORDER BY cf.field_name, fe.source_id, fe.locator"""), params).mappings().all()
    if not events and not facts:
        raise HTTPException(422, "No supporting report is available for this incident at the selected time.")
    tz = ZoneInfo(incident["timezone"])
    lines = [f"Site incident notice · {incident['project']}", f"Subject: {incident['title']}",
             f"Recorded incident time: {incident['occurred_at'].astimezone(tz):%d %b %Y, %H:%M %Z}"]
    sources = []
    for event in events:
        # Older multi-photo reports assigned image:1 to every event. Cite the report's photo set together.
        locators = event["photo_locators"] if event["locator"].startswith("image:") else []
        citations = [ref(event["source_id"], loc) for loc in (locators or [event["locator"]])]
        sources.extend(citations)
        lines.append(f"Site report: {event['summary']} {_tag(citations)}")
    for fact in facts:
        sources.append(fact)
        lines.append(f"{fact['field_name'].replace('_', ' ').capitalize()}: {fact['value']} {_tag([fact])}")
    lines.extend(["Contract reference: [MISSING: contract reference]", "Contract clause: [MISSING: contract clause]"])
    refs = [ref(s, loc) for s, loc in dict.fromkeys((r["source_id"], r["locator"]) for r in sources)]
    return {"body": "\n\n".join(lines), "evidence_refs": refs, "existing_id": incident["existing_id"], "as_of": when}


def _draft_view(conn, project_id, draft_id, as_of):
    draft = conn.execute(text("""
        SELECT d.id, d.notice_type, d.alert_id, d.incident_id, coalesce(a.activity_code,i.activity_code) AS activity_code,
               coalesce(i.title,act.name) AS activity_name,
               d.request IS NOT NULL AS written_with_agent, d.submitted_at, d.analysis->>'subject' AS subject
        FROM sitemate.drafts d LEFT JOIN sitemate.alerts a ON (a.project_id, a.id) = (d.project_id, d.alert_id)
        LEFT JOIN sitemate.incidents i ON (i.project_id,i.id)=(d.project_id,d.incident_id)
        LEFT JOIN sitemate.activities act ON (act.project_id, act.code) = (a.project_id, a.activity_code)
        WHERE d.project_id = :p AND d.id = CAST(:d AS uuid)
    """), {"p": project_id, "d": draft_id}).mappings().one_or_none()
    if draft is None:
        return None
    versions = conn.execute(text(f"""
        SELECT v.version, v.as_of, v.body, v.evidence_refs, v.missing_fields, v.alert_version,
               r.decision, r.reason, r.reviewer_id, r.decided_at,
               coalesce(m.display_name, r.reviewer_id) AS reviewer_name
        FROM sitemate.draft_versions v
        LEFT JOIN sitemate.reviews r ON (r.project_id, r.draft_id, r.version) = (v.project_id, v.draft_id, v.version)
                                    AND r.decided_at <= {CUTOFF}
        LEFT JOIN sitemate.project_members m ON (m.project_id, m.member_id) = (r.project_id, r.reviewer_id)
        WHERE v.project_id = :p AND v.draft_id = CAST(:d AS uuid) AND v.as_of <= {CUTOFF}
        ORDER BY v.version
    """), {"p": project_id, "d": draft_id, "cutoff": as_of}).mappings().all()
    if not versions:
        return None
    items = []
    for v in versions:
        review = ({"decision": v["decision"], "reason": v["reason"], "reviewer": v["reviewer_name"],
                   "decided_at": v["decided_at"]} if v["decision"] else None)
        items.append({"version": v["version"], "as_of": v["as_of"], "body": v["body"],
                      "evidence_refs": [ref(r["source_id"], r["locator"]) for r in v["evidence_refs"]],
                      "missing_fields": v["missing_fields"], "review": review})
    latest = items[-1]
    status = latest["review"]["decision"] if latest["review"] else "awaiting_review"
    # Drafts written with SiteMate stay with the manager until they are sent for approval.
    if draft["written_with_agent"] and draft["submitted_at"] is None:
        status = "draft"
    return {"id": str(draft["id"]), "notice_type": draft["notice_type"], "alert_id": str(draft["alert_id"]) if draft["alert_id"] else None,
            "incident_id": str(draft["incident_id"]) if draft["incident_id"] else None,
            "activity_code": draft["activity_code"], "activity_name": draft["activity_name"],
            "kind_label": NOTICE_LABEL.get(draft["notice_type"], draft["notice_type"].replace("_", " ").capitalize()),
            "title": draft["subject"] or draft["activity_name"] or draft["activity_code"],
            "written_with_agent": draft["written_with_agent"],
            "status": status, "latest": latest, "versions": items}


@router.post("/drafts", status_code=201)
def create_draft(project_id: str, body: DraftIn, as_of: datetime | None = None,
                 member=Depends(require_roles("manager"))):
    """Draft a notice for an alert (delay notice by default; additional cost, defect or concern notices for the
    performance suggestions). One notice per alert and type: a second call returns it. Nothing is sent."""
    when = stamp(as_of)
    with writer_engine().begin() as conn:
        if body.incident_id:
            incident_id = _uuid(body.incident_id)
            _lock_notice(conn, incident_id)
            preview = incident_notice_preview(project_id, incident_id, when, conn)
            if preview["existing_id"]:
                return _draft_view(conn, project_id, preview["existing_id"], None)
            draft_id = conn.scalar(text("""INSERT INTO sitemate.drafts(project_id,notice_type,incident_id)
                VALUES (:p,'incident_notice',CAST(:i AS uuid)) RETURNING id"""), {"p": project_id, "i": incident_id})
            conn.execute(text("""INSERT INTO sitemate.draft_versions(project_id,draft_id,version,as_of,body,evidence_refs,missing_fields)
                VALUES (:p,:d,1,:at,:b,CAST(:refs AS jsonb),CAST(:missing AS jsonb))"""),
                         {"p": project_id, "d": draft_id, "at": when, "b": preview["body"],
                          "refs": json.dumps(preview["evidence_refs"]), "missing": json.dumps(_missing(preview["body"]))})
            return _draft_view(conn, project_id, str(draft_id), None)
        alert_id = body.alert_id
        if not alert_id:
            if not (body.activity_code and body.work_date):
                raise HTTPException(422, "Give an alert_id, or an activity_code and work_date")
            alert_id = _ensure_alert(conn, project_id, body.activity_code,
                                     datetime.fromisoformat(body.work_date).date(), when)
        alert = _alert(conn, project_id, alert_id, when)
        _lock_notice(conn, alert["id"])
        notice_type = body.notice_type
        existing = conn.scalar(text("SELECT id FROM sitemate.drafts WHERE project_id=:p AND alert_id=:a AND notice_type=:t"),
                               {"p": project_id, "a": alert["id"], "t": notice_type})
        if existing:
            return _draft_view(conn, project_id, str(existing), None)
        text_, refs = compose_notice(conn, project_id, alert, when, notice_type)
        draft_id = conn.scalar(text("INSERT INTO sitemate.drafts (project_id, notice_type, alert_id) "
                                    "VALUES (:p, :t, :a) RETURNING id"), {"p": project_id, "t": notice_type, "a": alert["id"]})
        conn.execute(text("""
            INSERT INTO sitemate.draft_versions (project_id, draft_id, version, as_of, body, evidence_refs,
                                                 missing_fields, alert_id, alert_version)
            VALUES (:p, :d, 1, greatest(:at, :alert_at), :b, CAST(:r AS jsonb), CAST(:m AS jsonb), :a, :av)
        """), {"p": project_id, "d": draft_id, "at": when, "alert_at": alert["as_of"], "b": text_,
               "r": json.dumps(refs), "m": json.dumps(_missing(text_)), "a": alert["id"], "av": alert["version"]})
        return _draft_view(conn, project_id, str(draft_id), None)


@router.get("/drafts")
def list_drafts(project_id: str, as_of: datetime | None = None, member=Depends(require_roles("manager", "approver")),
                conn=Depends(connection)):
    check_cutoff(as_of)
    ids = conn.execute(text("SELECT id FROM sitemate.drafts WHERE project_id = :p"), {"p": project_id}).scalars().all()
    views = [v for v in (_draft_view(conn, project_id, str(i), as_of) for i in ids) if v]
    if member["role"] == "approver":  # drafts the manager has not sent yet are not in the review queue
        views = [v for v in views if v["status"] != "draft"]
    order = {"draft": 0, "awaiting_review": 1, "changes_requested": 2, "approved": 3}
    return sorted(views, key=lambda v: (order[v["status"]], -v["latest"]["as_of"].timestamp()))


@router.get("/drafts/{draft_id}", dependencies=[Depends(require_roles("manager", "approver"))])
def get_draft(project_id: str, draft_id: str, as_of: datetime | None = None, conn=Depends(connection)):
    check_cutoff(as_of)
    view = _draft_view(conn, project_id, _uuid(draft_id), as_of)
    if view is None:
        raise HTTPException(404, "Notice not available at this time")
    return view


def _uuid(value):
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", value):
        raise HTTPException(404, "Notice not found")
    return value


@router.get("/drafts/{draft_id}/versions/{version}/export", dependencies=[Depends(require_roles("manager", "approver"))])
def download_notice(project_id: str, draft_id: str, version: int, format: Literal["pdf", "docx", "eml"],
                    conn=Depends(connection)):
    row = conn.execute(text("""
        SELECT v.body, r.decision, r.decided_at, d.notice_type, p.sender FROM sitemate.draft_versions v
        JOIN sitemate.drafts d ON (d.project_id, d.id) = (v.project_id, v.draft_id)
        JOIN sitemate.projects p ON p.id = v.project_id
        LEFT JOIN sitemate.reviews r ON (r.project_id, r.draft_id, r.version) = (v.project_id, v.draft_id, v.version)
        WHERE v.project_id=:p AND v.draft_id=CAST(:d AS uuid) AND v.version=:v
    """), {"p": project_id, "d": _uuid(draft_id), "v": version}).mappings().one_or_none()
    if row is None:
        raise HTTPException(404, "Notice version not found")
    if row["decision"] != "approved":
        raise HTTPException(409, "Approve this version before downloading it")
    if format == "eml":
        from correspondence import email_file

        data = email_file(row["body"], row["sender"], row["decided_at"])
        return Response(data, media_type="message/rfc822", headers={
            "Content-Disposition": f'attachment; filename="email-{draft_id}-v{version}.eml"',
            "Cache-Control": "private, no-store",
        })
    if format == "pdf":
        data, mime = pdf_letter(row["body"]), "application/pdf"
    else:
        data, mime = word_letter(row["body"]), "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    return Response(data, media_type=mime, headers={
        "Content-Disposition": f'attachment; filename="notice-{draft_id}-v{version}.{format}"',
        "Cache-Control": "private, no-store",
    })


@router.get("/mail/status", dependencies=[Depends(check_member)])
def mail_status(project_id: str):
    return mailer.status()


class SendIn(BaseModel):
    to: list[str] = Field(min_length=1, max_length=mailer.MAX_RECIPIENTS)
    cc: list[str] = Field(default_factory=list, max_length=mailer.MAX_RECIPIENTS)


@router.post("/drafts/{draft_id}/versions/{version}/send")
def send_notice(project_id: str, draft_id: str, version: int, body: SendIn,
                member=Depends(require_roles("manager", "approver")), conn=Depends(connection)):
    """Email an approved email draft through the server's SMTP account."""
    row = conn.execute(text("""
        SELECT v.body, r.decision, d.notice_type FROM sitemate.draft_versions v
        JOIN sitemate.drafts d ON (d.project_id, d.id) = (v.project_id, v.draft_id)
        LEFT JOIN sitemate.reviews r ON (r.project_id, r.draft_id, r.version) = (v.project_id, v.draft_id, v.version)
        WHERE v.project_id=:p AND v.draft_id=CAST(:d AS uuid) AND v.version=:v
    """), {"p": project_id, "d": _uuid(draft_id), "v": version}).mappings().one_or_none()
    if row is None:
        raise HTTPException(404, "Notice version not found")
    if row["notice_type"] != "email":
        raise HTTPException(409, "Only email drafts can be sent by email")
    if row["decision"] != "approved":
        raise HTTPException(409, "Approve this version before sending it")
    if MISSING.search(row["body"]):
        raise HTTPException(409, "Fill in the missing fields before sending")
    try:
        to, cc = mailer.clean_addresses(body.to), mailer.clean_addresses(body.cc)
        subject, text_body = mailer.split_draft(row["body"])
        mailer.send(to, cc, subject, text_body, member["display_name"])
    except mailer.MailError as exc:
        raise HTTPException(exc.status, str(exc)) from exc
    mailer.log.info("Sent draft %s v%s from project %s by %s to %d recipient(s)",
                    draft_id, version, project_id, member["member_id"], len(to) + len(cc))
    return {"sent": True, "to": to, "cc": cc, "subject": subject}


@router.post("/drafts/{draft_id}/versions", status_code=201)
def revise_draft(project_id: str, draft_id: str, body: RevisionIn, as_of: datetime | None = None,
                 member=Depends(require_roles("manager"))):
    """New version with the contract details filled in (or an edited text)."""
    when = stamp(as_of)
    with writer_engine().begin() as conn:
        _lock_notice(conn, draft_id)
        view = _draft_view(conn, project_id, _uuid(draft_id), None)
        if view is None:
            raise HTTPException(404, "Notice not found")
        if view["status"] == "approved":
            raise HTTPException(409, "This notice is already approved")
        latest = view["latest"]
        if body.expected_version is not None and body.expected_version != latest["version"]:
            raise HTTPException(409, "A newer version is available. Review it before revising.")
        new_body = body.body if body.body else latest["body"]
        for label, value in (("contract reference", body.contract_reference), ("contract clause", body.contract_clause)):
            if value and value.strip():
                new_body = new_body.replace(f"[MISSING: {label}]", value.strip())
        if new_body == latest["body"]:
            raise HTTPException(422, "Nothing changed. Fill in a missing field or edit the text.")
        version = latest["version"] + 1
        conn.execute(text("""
            INSERT INTO sitemate.draft_versions (project_id, draft_id, version, as_of, body, evidence_refs,
                                                 missing_fields, alert_id, alert_version)
            SELECT project_id, draft_id, :v, greatest(:at, as_of), :b, evidence_refs, CAST(:m AS jsonb), alert_id, alert_version
            FROM sitemate.draft_versions WHERE project_id = :p AND draft_id = CAST(:d AS uuid) AND version = :prev
        """), {"p": project_id, "d": draft_id, "v": version, "prev": latest["version"], "at": when,
               "b": new_body, "m": json.dumps(_missing(new_body))})
        return _draft_view(conn, project_id, draft_id, None)


# ------------------------------------------------------------------ approver: decision

class ReviewIn(BaseModel):
    decision: str = Field(pattern="^(approved|changes_requested)$")
    reason: str | None = Field(None, max_length=2000)


@router.post("/drafts/{draft_id}/versions/{version}/review", status_code=201)
def review_draft(project_id: str, draft_id: str, version: int, body: ReviewIn, as_of: datetime | None = None,
                 member=Depends(require_roles("approver"))):
    when = stamp(as_of)
    with writer_engine().begin() as conn:
        _lock_notice(conn, draft_id)
        view = _draft_view(conn, project_id, _uuid(draft_id), None)
        if view is None:
            raise HTTPException(404, "Notice not found")
        latest = view["latest"]
        if view["status"] == "draft":
            raise HTTPException(409, "The site manager has not sent this draft for approval yet")
        if version != latest["version"]:
            raise HTTPException(409, f"Version {version} is not the latest (v{latest['version']}). Reload the notice.")
        if latest["review"]:
            raise HTTPException(409, "This version already has a decision")
        if body.decision == "approved" and latest["missing_fields"]:
            raise HTTPException(409, "Cannot approve while required fields are missing: "
                                     + ", ".join(latest["missing_fields"]))
        reason = (body.reason or "").strip() or None
        if body.decision == "changes_requested" and not reason:
            raise HTTPException(422, "Say what needs to change")
        conn.execute(text("""
            INSERT INTO sitemate.reviews (project_id, draft_id, version, reviewer_id, decision, reason, decided_at)
            VALUES (:p, CAST(:d AS uuid), :v, :m, :dec, :r, greatest(:at, :vat))
        """), {"p": project_id, "d": draft_id, "v": version, "m": member["member_id"], "dec": body.decision,
               "r": reason, "at": when, "vat": latest["as_of"]})
        return _draft_view(conn, project_id, draft_id, None)
