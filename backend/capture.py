"""Capture endpoints: voice / photos / text -> events with suggested categories -> person confirms -> incidents.

Runs the pipeline in ai-agent/app/capture as the `sitemate_agent` database role (AGENT_DATABASE_URL), which has the
insert rights the read-only API role deliberately lacks."""

from functools import lru_cache

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import text

from database import engine_for
from deps import check_member, connection, current_member, require_roles

from app.capture.llm_factory import get_capture_llm  # noqa: E402  (ai-agent is on sys.path, see main.py)
from app.capture.pipeline import CaptureError, CaptureService  # noqa: E402
from app.capture.storage import audio_storage  # noqa: E402
from app.capture.taxonomy import load_taxonomy  # noqa: E402
from app.llm import LLMError  # noqa: E402

router = APIRouter()
# Who may record notes: foremen (contributor) and site managers, who record their own statements.
CAPTURE_ROLES = ("contributor", "manager")


@lru_cache
def _service() -> CaptureService:
    return CaptureService(engine_for("AGENT_DATABASE_URL"), get_capture_llm())


def get_capture_service() -> CaptureService:
    """Overridable in tests with app.dependency_overrides."""
    try:
        return _service()
    except KeyError:
        raise HTTPException(503, "Capture is not configured: set AGENT_DATABASE_URL (run provision_agent.py)") from None
    except LLMError as exc:
        raise HTTPException(503, str(exc)) from None


def _respond(call):
    try:
        status, body = call()
    except CaptureError as exc:
        raise HTTPException(exc.status, exc.detail) from None
    except LLMError as exc:
        raise HTTPException(502, f"The AI model is unavailable: {exc}") from None
    return JSONResponse(body, status_code=status)


@router.post("/projects/{project_id}/captures")
def create_capture(project_id: str, member=Depends(require_roles(*CAPTURE_ROLES)), service: CaptureService = Depends(get_capture_service),
                   audio: UploadFile | None = File(None), images: list[UploadFile] = File(default_factory=list),
                   transcript: str | None = Form(None), recorded_at: str | None = Form(None), zone_hint: str | None = Form(None)):
    """multipart: `audio` (one file), `images` (up to 5), `transcript`, optional `recorded_at`.
    Replies 202 `needs_category` with one suggestion per event; the person confirms via /categories."""
    return _respond(lambda: service.start(
        project_id, member, text_=transcript,
        audio=(audio.file.read(), audio.filename or "audio.webm", audio.content_type or "") if audio and audio.filename else None,
        images=[(i.file.read(), i.filename or "photo", i.content_type or "") for i in images if i.filename],
        recorded_at=recorded_at, zone_hint=zone_hint))


class CategoryDecision(BaseModel):
    index: int
    category: str | None = None
    event_type: str | None = None
    keep: bool = True


class AddedEvent(BaseModel):
    summary: str = Field(max_length=1000)
    category: str | None = None
    event_type: str | None = None


class CategoriesBody(BaseModel):
    events: list[CategoryDecision] = Field(default_factory=list)
    added: list[AddedEvent] = Field(default_factory=list)


@router.post("/projects/{project_id}/captures/{thread_id}/categories")
def confirm_categories(project_id: str, thread_id: str, body: CategoriesBody, member=Depends(require_roles(*CAPTURE_ROLES)),
                       service: CaptureService = Depends(get_capture_service)):
    """The person's final categories. Events not mentioned keep the AI suggestion; keep=false means "not an event"."""
    return _respond(lambda: service.confirm_categories(project_id, thread_id, body.model_dump()))


class Answer(BaseModel):
    id: str
    answer: str | None = ""


class AnswersBody(BaseModel):
    answers: list[Answer] = Field(default_factory=list)


@router.post("/projects/{project_id}/captures/{thread_id}/answers")
def answer_questions(project_id: str, thread_id: str, body: AnswersBody, member=Depends(require_roles(*CAPTURE_ROLES)),
                     service: CaptureService = Depends(get_capture_service)):
    """Answers to the follow-up questions; `unknown` records a field as a gap."""
    return _respond(lambda: service.answer(project_id, thread_id, [a.model_dump() for a in body.answers]))


@router.get("/projects/{project_id}/event-categories", dependencies=[Depends(check_member)])
def event_categories(project_id: str, conn=Depends(connection)):
    """Categories with their event types, for the category picker."""
    taxonomy = load_taxonomy(conn, project_id)
    return [{"key": c["key"], "label": c["label"], "description": c.get("description", ""), "icon": c.get("icon"),
             "creates_incident": c["creates_incident"], "default_severity": c.get("default_severity"),
             "sort_order": c.get("sort_order", 100),
             "types": [{"key": t["key"], "label": t["label"], "severity_hint": t.get("severity_hint")} for t in taxonomy.types_of(c["key"])]}
            for c in taxonomy.categories]


class ReviewEdit(BaseModel):
    index: int
    value: str


class ReviewAddition(BaseModel):
    event_index: int
    field_name: str
    value: str


class ReviewBody(BaseModel):
    edits: list[ReviewEdit] = Field(default_factory=list)
    removed: list[int] = Field(default_factory=list)
    additions: list[ReviewAddition] = Field(default_factory=list)
    discard: bool = False


@router.post("/projects/{project_id}/captures/{thread_id}/review")
def review_capture(project_id: str, thread_id: str, body: ReviewBody, member=Depends(require_roles(*CAPTURE_ROLES)),
                   service: CaptureService = Depends(get_capture_service)):
    """The speaker's last look before anything is saved: corrected values, removed facts, values for gaps the rules
    reported, or `discard` to save nothing. Only the person who recorded the note may review it."""
    return _respond(lambda: service.review(project_id, member, thread_id, body.model_dump()))


# ------------------------------------------------------------------------ the member's saved notes ---------------

AUDIO_TYPES = {".webm": "audio/webm", ".m4a": "audio/mp4", ".mp4": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav",
               ".aiff": "audio/aiff", ".ogg": "audio/ogg"}
# A member sees their own saved notes. Older voice notes saved before authorship was recorded (author is null) stay visible.
VISIBLE = """((c.id IS NOT NULL AND c.status = 'saved' AND s.author = :me)
              OR (c.id IS NULL AND s.kind = 'voice_note' AND (s.author = :me OR s.author IS NULL)))"""
AUDIO_JOIN = """LEFT JOIN LATERAL (
    SELECT storage_key, mime FROM sitemate.capture_attachments
    WHERE project_id = s.project_id AND source_id = s.id AND kind = 'audio'
    ORDER BY storage_key LIMIT 1
) audio ON TRUE"""
AUDIO_KEY = """COALESCE(audio.storage_key, CASE WHEN c.id IS NULL AND s.kind = 'voice_note'
               THEN NULLIF(s.path, 'inline:transcript') END)"""


def recording_file(storage, key):
    if not key:
        return None
    try:
        file = storage.path(key)
        return file if file.is_file() else None
    except (ValueError, OSError):
        return None


@router.get("/projects/{project_id}/captures")
def list_recordings(project_id: str, member=Depends(current_member), conn=Depends(connection)):
    """This member's saved notes, newest first: transcript, answers, facts and the incidents they raised."""
    rows = [dict(r) for r in conn.execute(text(f"""
        SELECT s.id, s.available_at, s.author, s.author_role, {AUDIO_KEY} AS audio_key
        FROM sitemate.sources s LEFT JOIN sitemate.captures c ON (c.project_id, c.source_id) = (s.project_id, s.id)
        {AUDIO_JOIN}
        WHERE s.project_id = :p AND {VISIBLE} ORDER BY s.available_at DESC LIMIT 50"""),
                            {"p": project_id, "me": member["member_id"]}).mappings()]
    if not rows:
        return {"recordings": []}
    ids = [r["id"] for r in rows]
    photos = conn.execute(text("""
        SELECT a.source_id, a.id::text AS id, sp.excerpt AS description
        FROM sitemate.capture_attachments a
        LEFT JOIN sitemate.source_passages sp ON (sp.project_id, sp.source_id, sp.locator) =
            (a.project_id, a.source_id, a.passage_locator)
        WHERE a.project_id = :p AND a.source_id = ANY(CAST(:ids AS text[])) AND a.kind = 'image'
        ORDER BY a.source_id, a.passage_locator, a.id"""), {"p": project_id, "ids": ids}).mappings().all()
    passages = [dict(r) for r in conn.execute(text("""
        SELECT source_id, locator, excerpt FROM sitemate.source_passages
        WHERE project_id = :p AND source_id = ANY(CAST(:ids AS text[]))
          AND (locator = 'transcript' OR locator LIKE 'answer:%' OR locator LIKE 'review:%') ORDER BY source_id, locator"""),
                                 {"p": project_id, "ids": ids}).mappings()]
    all_facts = [dict(r) for r in conn.execute(text("""
        SELECT id::text AS id, supersedes_id::text AS supersedes_id, source_id, incident_id::text AS incident_id, field_name, value,
               basis, review_status, reviewed_by, effective_at
        FROM sitemate.capture_facts WHERE project_id = :p AND source_id = ANY(CAST(:ids AS text[]))
        ORDER BY effective_at, field_name, id"""), {"p": project_id, "ids": ids}).mappings()]
    superseded = {f["supersedes_id"] for f in all_facts if f["supersedes_id"]}  # a fact a later row supersedes is history
    facts = [f for f in all_facts if f["id"] not in superseded]
    # incidents a note raised or joined: through its facts, and through the events grouped into incidents
    event_links = [dict(r) for r in conn.execute(text("""
        SELECT source_id, incident_id::text AS incident_id FROM sitemate.events
        WHERE project_id = :p AND source_id = ANY(CAST(:ids AS text[])) AND incident_id IS NOT NULL ORDER BY event_index"""),
                                                 {"p": project_id, "ids": ids}).mappings()]
    incident_ids = sorted({f["incident_id"] for f in facts if f["incident_id"]} | {e["incident_id"] for e in event_links})
    incidents = {i["id"]: i for i in (dict(r) for r in conn.execute(text("""
        SELECT id::text AS id, kind, title, activity_code, occurred_at, resolved_at, category, status, severity
        FROM sitemate.incidents WHERE project_id = :p AND id = ANY(CAST(:ids AS uuid[]))"""),
                                                {"p": project_id, "ids": incident_ids}).mappings())} if incident_ids else {}
    out = []
    storage = audio_storage()
    for r in rows:
        own = [x for x in passages if x["source_id"] == r["id"]]
        mine = [f for f in facts if f["source_id"] == r["id"]]
        out.append({
            "id": r["id"], "recorded_at": r["available_at"], "has_audio": recording_file(storage, r["audio_key"]) is not None,
            "author": r["author"],
            "author_role": r["author_role"],
            "photos": [{"id": p["id"], "description": p["description"]} for p in photos if p["source_id"] == r["id"]],
            "transcript": next((x["excerpt"] for x in own if x["locator"] == "transcript"), None),
            "answers": [x["excerpt"] for x in own if x["locator"].startswith("answer:")],
            "facts": [{"field_name": f["field_name"], "value": f["value"], "basis": f["basis"], "review_status": f["review_status"],
                       "reviewed_by": f["reviewed_by"], "incident_id": f["incident_id"]} for f in mine],
            "incidents": [incidents[i] for i in dict.fromkeys(
                [e["incident_id"] for e in event_links if e["source_id"] == r["id"]] + [f["incident_id"] for f in mine if f["incident_id"]])
                          if i in incidents],
        })
    return {"recordings": out}


@router.get("/projects/{project_id}/captures/{source_id}/audio")
def recording_audio(project_id: str, source_id: str, member=Depends(current_member), conn=Depends(connection)):
    """The stored recording of one of this member's notes. FileResponse serves Range requests, so seeking works."""
    row = conn.execute(text(f"""
        SELECT {AUDIO_KEY} AS key, audio.mime
        FROM sitemate.sources s LEFT JOIN sitemate.captures c ON (c.project_id, c.source_id) = (s.project_id, s.id)
        {AUDIO_JOIN}
        WHERE s.project_id = :p AND s.id = :s AND {VISIBLE}"""),
                       {"p": project_id, "s": source_id, "me": member["member_id"]}).mappings().one_or_none()
    file = recording_file(audio_storage(), row["key"] if row else None)
    if file is None:
        raise HTTPException(404, "No recording for this note")
    return FileResponse(file, media_type=(row["mime"] or AUDIO_TYPES.get(file.suffix.lower()) or "application/octet-stream"),
                        headers={"Cache-Control": "private, max-age=300"})
