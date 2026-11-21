"""Capture endpoints: voice / photos / text -> events with suggested categories -> person confirms -> incidents.

Runs the pipeline in ai-agent/app/capture as the `sitemate_agent` database role (AGENT_DATABASE_URL), which has the
insert rights the read-only API role deliberately lacks."""

from functools import lru_cache

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import text

from database import engine_for
from deps import check_member, connection, require_writer

from app.capture.llm_factory import get_capture_llm  # noqa: E402  (ai-agent is on sys.path, see main.py)
from app.capture.pipeline import CaptureError, CaptureService  # noqa: E402
from app.capture.taxonomy import load_taxonomy  # noqa: E402
from app.llm import LLMError  # noqa: E402

router = APIRouter()


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
def create_capture(project_id: str, member=Depends(require_writer), service: CaptureService = Depends(get_capture_service),
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
def confirm_categories(project_id: str, thread_id: str, body: CategoriesBody, member=Depends(require_writer),
                       service: CaptureService = Depends(get_capture_service)):
    """The person's final categories. Events not mentioned keep the AI suggestion; keep=false means "not an event"."""
    return _respond(lambda: service.confirm_categories(project_id, thread_id, body.model_dump()))


class Answer(BaseModel):
    id: str
    answer: str | None = ""


class AnswersBody(BaseModel):
    answers: list[Answer] = Field(default_factory=list)


@router.post("/projects/{project_id}/captures/{thread_id}/answers")
def answer_questions(project_id: str, thread_id: str, body: AnswersBody, member=Depends(require_writer),
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
