"""HTTP routes for the 3D progress model (plan section 10). All under /projects/{project_id}, bearer token.

The 3D model is a site-manager tool: upload, edits and reads all need the manager role. Progress is read from the database on every
call (observations, events, sources, passages) and the pour states are stored as a new version in
element_progress when the records changed. No model call happens on a GET.
"""

from __future__ import annotations

import hashlib
import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import text

from database import writer_engine
from deps import check_cutoff, connection, require_roles

from . import generator, progress, store
from .spec import blocking, parse_day, validate

router = APIRouter(prefix="/projects/{project_id}", tags=["3d-model"])
MAX_UPLOAD = 25 * 1024 * 1024
DRAWING_SUFFIXES = {".pdf"}
ARCH_NOTE_SUBJECTS = ("source", "levels", "walls", "pours", "programme", "drawings")
NOT_INSTALLED ="The 3D model tables are not installed (run `python -m model3d.schema` or alembic upgrade head)"


def _installed(conn):
    if not store.tables_installed(conn):
        raise HTTPException(503, NOT_INSTALLED)


def _uuid(value: str) -> str:
    import re
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", value or ""):
        raise HTTPException(404, "Model not found")
    return value


def _date(value: str | None, field: str = "date") -> date | None:
    if value in (None, ""):
        return None
    d = parse_day(value)
    if d is None:
        raise HTTPException(422, f"{field} must be YYYY-MM-DD")
    return d


def _today(conn, project_id: str, as_of: datetime | None) -> date:
    tz = conn.scalar(text("SELECT timezone FROM sitemate.projects WHERE id=:p"), {"p": project_id})
    if tz is None:
        raise HTTPException(404, "Unknown project")
    return (as_of or datetime.now(timezone.utc)).astimezone(ZoneInfo(tz)).date()


def _summary(row: dict) -> dict:
    spec = row["spec"] or {}
    reasons = row["review_reasons"] or []
    return {k: row[k] for k in ("id", "revision", "status", "extraction_status", "title", "source_ids", "model", "error",
                                "created_by", "created_at", "as_of", "activated_by", "activated_at")} | {
        "deadline": row["deadline"].isoformat() if row["deadline"] else None,
        "review_reasons": reasons, "blocking": len(blocking(reasons)),
        "counts": {k: len(spec.get(k) or []) for k in ("levels", "columns", "walls", "pours", "activities")},
        "deadline_hint": spec.get("deadline_hint") or None,
    }


def _passages(conn, project_id: str, source_ids: list[str]) -> dict[str, str]:
    return dict(conn.execute(text("""SELECT source_id || ':' || locator, excerpt FROM sitemate.source_passages
        WHERE project_id=:p AND source_id = ANY(:ids)"""), {"p": project_id, "ids": list(source_ids)}).all())


# ------------------------------------------------------------------ upload and extraction

def run_extraction(project_id: str, model_id: str):
    """Background: parse the drawings (documents.ingest), run P5, validate, store the draft spec."""
    from documents import storage
    from documents.ingest import ingest_source
    from performance.baseline import load_passages

    from .arch import build_spec as build_arch
    from .prompts import extract_arch, extract_spec, is_structural_failure
    from .vector import apply_vector_walls

    engine = writer_engine()
    with engine.begin() as conn:
        row = store.get_model(conn, project_id, model_id)
        store.update_draft(conn, project_id, model_id, extraction_status="running")
    try:
        for source_id in row["source_ids"]:
            outcome = ingest_source(project_id, source_id, summarize=False)
            if outcome["status"] == "failed":
                raise RuntimeError(f"{source_id}: {outcome.get('error')}")
        with engine.connect() as conn:
            passages = load_passages(conn, project_id, row["source_ids"])
            pdfs = []
            for source_id in row["source_ids"]:
                path = storage.resolve(project_id, conn.scalar(text(
                    "SELECT path FROM sitemate.sources WHERE project_id=:p AND id=:s"), {"p": project_id, "s": source_id}))
                if path and path.suffix.lower() == ".pdf":
                    pdfs.append((source_id, path.read_bytes()))
        by_ref = {f"{p['source_id']}:{p['locator']}": p["excerpt"] for p in passages}
        spec, model = extract_spec(passages, pdfs)
        spec, reasons = validate(spec, by_ref)
        if is_structural_failure(reasons):
            # no grid or levels: architectural floor plans. Build from the footprint and walls with stated assumptions.
            raw, model = extract_arch(passages, pdfs)
            exact = apply_vector_walls(raw, pdfs)   # walls from the PDF's drawn lines when it is a vector drawing
            with engine.connect() as conn:
                today = _today(conn, project_id, None)
            due = row["deadline"] or today + timedelta(days=90)
            arch_spec, notes = build_arch(raw, prefix=f"B{row['revision']}", start=today, deadline=max(due, today + timedelta(days=7)),
                                          exact_walls=bool(exact))
            spec, reasons = validate(arch_spec, by_ref) if not blocking(notes) else (arch_spec, [])
            reasons = notes + reasons
        else:
            for note in spec.get("missing") or []:
                reasons.append({"severity": "warning", "subject": "missing", "message": str(note)[:300], "refs": []})
        hint = parse_day((spec.get("deadline_hint") or {}).get("date"))
        with engine.begin() as conn:
            store.update_draft(conn, project_id, model_id, spec=spec, reasons=reasons, model=model,
                               extraction_status="needs_review" if blocking(reasons) else "done",
                               deadline=None if row["deadline"] else hint)
    except Exception as exc:  # noqa: BLE001 - recorded on the model so the manager can retry
        with engine.begin() as conn:
            store.update_draft(conn, project_id, model_id, extraction_status="failed",
                               error=f"{type(exc).__name__}: {exc}"[:1000])


@router.post("/models", status_code=202)
def upload_model(project_id: str, background: BackgroundTasks, files: list[UploadFile] = File(...),
                 deadline: str = Form(...), title: str | None = Form(None, max_length=200),
                 member=Depends(require_roles("manager"))):
    """Upload the 2D structural drawings (PDF) and the deadline. P5 reads them in the background; nothing is
    activated until the manager reviews and activates."""
    from documents import storage
    due = _date(deadline, "deadline")
    if not files or len(files) > 10:
        raise HTTPException(422, "Upload 1 to 10 drawing files")
    stored = []
    for f in files:
        suffix = Path(f.filename or "").suffix.lower()
        if suffix not in DRAWING_SUFFIXES:
            raise HTTPException(422, f"{f.filename}: drawings must be PDF")
        data = f.file.read(MAX_UPLOAD + 1)
        if not data or len(data) > MAX_UPLOAD:
            raise HTTPException(413, f"{f.filename}: empty or larger than 25 MB")
        stored.append((f.filename, suffix, data))
    now = datetime.now(timezone.utc).replace(microsecond=0)
    with writer_engine().begin() as conn:
        _installed(conn)
        if conn.scalar(text("SELECT 1 FROM sitemate.projects WHERE id=:p"), {"p": project_id}) is None:
            raise HTTPException(404, "Unknown project")
        source_ids = []
        for name, suffix, data in stored:
            digest = hashlib.sha256(data).hexdigest()
            source_id = f"DRW-{digest[:8].upper()}"
            if conn.scalar(text("SELECT 1 FROM sitemate.sources WHERE project_id=:p AND id=:s"),
                           {"p": project_id, "s": source_id}) is None:
                path, _ = storage.save_upload(project_id, data, suffix)
                conn.execute(text("""INSERT INTO sitemate.sources (project_id, id, kind, path, available_at, sha256, title, meta,
                                                                  author, author_role)
                    VALUES (:p, :s, 'plan', :path, :at, :sha, :title, CAST(:meta AS jsonb), :author, 'site_supervisor')"""),
                             {"p": project_id, "s": source_id, "path": path, "at": now, "sha": digest, "title": name,
                              "meta": json.dumps({"filename": name, "uploaded_by": member["member_id"], "kind": "drawings"}),
                              "author": member["display_name"]})
            source_ids.append(source_id)
        model_id = store.create_model(conn, project_id, source_ids=source_ids, title=title or stored[0][0], deadline=due,
                                      member_id=member["member_id"], as_of=now)
        row = store.get_model(conn, project_id, model_id)
    background.add_task(run_extraction, project_id, model_id)
    return _summary(row)


@router.post("/models/{model_id}/extract", status_code=202)
def retry_extraction(project_id: str, model_id: str, background: BackgroundTasks,
                     member=Depends(require_roles("manager"))):
    with writer_engine().begin() as conn:
        _installed(conn)
        row = store.get_model(conn, project_id, _uuid(model_id))
        if row is None or row["status"] != "draft":
            raise HTTPException(409, "Only a draft model can be read again")
        store.update_draft(conn, project_id, model_id, extraction_status="queued")
    background.add_task(run_extraction, project_id, model_id)
    return {"id": model_id, "extraction_status": "queued"}


# ------------------------------------------------------------------ reads

@router.get("/models", dependencies=[Depends(require_roles("manager"))])
def list_models(project_id: str, as_of: datetime | None = None, conn=Depends(connection)):
    check_cutoff(as_of)
    _installed(conn)
    active = store.active_model(conn, project_id)
    return {"active_id": active["id"] if active else None,
            "models": [_summary(r) for r in store.list_models(conn, project_id, as_of)]}


def _model_view(row: dict, geo: dict) -> dict:
    spec = row["spec"] or {}
    levels = [{"name": lv["name"], "tos": lv["tos"], "thickness": lv["thickness"], "activity": lv["activity"]}
              for lv in spec.get("levels") or []]
    return _summary(row) | {
        "levels": levels, "activities": spec.get("activities") or [], "grid": spec.get("grid") or {},
        "pours": geo["pours"], "elements": geo["elements"],
        "bounds": [min((e["box"][i] for e in geo["elements"]), default=0) for i in range(3)] +
                  [max((e["box"][i] for e in geo["elements"]), default=0) for i in range(3, 6)],
    }


@router.get("/models/active", dependencies=[Depends(require_roles("manager"))])
def get_active(project_id: str, conn=Depends(connection)):
    """The active model with its elements (geometry, metres) and pours. Geometry is static: cache it."""
    _installed(conn)
    row = store.active_model(conn, project_id)
    if row is None:
        raise HTTPException(404, "No active 3D model; upload the drawings first")
    return _model_view(row, store.geometry(conn, project_id, row["id"]))


def _progress_inputs(conn, project_id, as_of, date_):
    check_cutoff(as_of)
    _installed(conn)
    row = store.active_model(conn, project_id)
    if row is None:
        raise HTTPException(404, "No active 3D model; upload the drawings first")
    geo = store.geometry(conn, project_id, row["id"])
    day = _date(date_) or _today(conn, project_id, as_of)
    codes = list(dict.fromkeys(p["activity"] for p in geo["pours"]))
    inputs = progress.load_inputs(conn, project_id, codes, day, as_of)
    return row, geo, day, inputs


@router.get("/models/active/progress", dependencies=[Depends(require_roles("manager"))])
def get_progress(project_id: str, date_: str | None = Query(None, alias="date"), as_of: datetime | None = None,
                 conn=Depends(connection)):
    """Pour states on the date (default: today at the As of clock), read from the database: actual, planned and
    at the deadline; the deadline check; the reasons. Stored as a new element_progress version when changed."""
    row, geo, day, inputs = _progress_inputs(conn, project_id, as_of, date_)
    result = progress.compute(row["spec"] or {}, geo["pours"], inputs, day, row["deadline"], row["review_reasons"])
    digest = progress.input_digest(inputs, day)
    try:
        with writer_engine().begin() as w:
            result["version"] = store.save_progress(w, project_id, row["id"], day,
                                                    as_of or datetime.now(timezone.utc).replace(microsecond=0),
                                                    digest, result["actual"])
    except Exception:  # noqa: BLE001 - reading must not fail because the history could not be written
        result["version"] = None
    result["model_id"] = row["id"]
    return result


@router.get("/models/active/timeline", dependencies=[Depends(require_roles("manager"))])
def get_timeline(project_id: str, date_: str | None = Query(None, alias="date"), as_of: datetime | None = None,
                 conn=Depends(connection)):
    """Per-day planned/actual/forecast m3, the pour states at each date the records changed, and the planned and
    forecast window of every pour: everything the slider needs in one call."""
    row, geo, day, inputs = _progress_inputs(conn, project_id, as_of, date_)
    return progress.timeline(row["spec"] or {}, geo["pours"], inputs, day, row["deadline"]) | {"model_id": row["id"]}


@router.get("/models/{model_id}", dependencies=[Depends(require_roles("manager"))])
def get_model(project_id: str, model_id: str, conn=Depends(connection)):
    """A model revision with its spec and, while it is a draft, a preview of the generated elements."""
    _installed(conn)
    row = store.get_model(conn, project_id, _uuid(model_id))
    if row is None:
        raise HTTPException(404, "Model not found")
    spec = row["spec"] or {}
    if row["status"] == "draft":
        geo = {"pours": [], "elements": []}
        if spec.get("levels") and not blocking(row["review_reasons"] or []):
            try:
                built = generator.generate(spec)
                geo = {"pours": built["pours"], "elements": built["elements"]}
            except Exception as exc:  # noqa: BLE001 - shown as a review note, the spec stays editable
                row["review_reasons"] = (row["review_reasons"] or []) + [
                    {"severity": "blocking", "subject": "model", "message": f"could not build the 3D model: {exc}", "refs": []}]
    else:
        geo = store.geometry(conn, project_id, row["id"])
    view = _model_view(row, geo)
    view["spec"] = spec
    view["sources"] = [dict(r) for r in conn.execute(text("""
        SELECT id, title, available_at, meta->>'filename' AS filename FROM sitemate.sources
        WHERE project_id=:p AND id = ANY(:ids) ORDER BY id"""), {"p": project_id, "ids": list(row["source_ids"] or [])}).mappings()]
    return view


# ------------------------------------------------------------------ edits and activation

class ModelPatch(BaseModel):
    spec: dict | None = None
    deadline: str | None = None
    title: str | None = Field(None, max_length=200)


@router.patch("/models/{model_id}")
def edit_model(project_id: str, model_id: str, body: ModelPatch, member=Depends(require_roles("manager"))):
    """Manager edits of a draft: the whole spec (validated again) and/or the deadline."""
    with writer_engine().begin() as conn:
        _installed(conn)
        row = store.get_model(conn, project_id, _uuid(model_id))
        if row is None:
            raise HTTPException(404, "Model not found")
        if row["status"] != "draft":
            raise HTTPException(409, "Only a draft can be edited; upload a new revision instead")
        spec, reasons = None, None
        if body.spec is not None:
            spec, reasons = validate(body.spec, _passages(conn, project_id, row["source_ids"] or []) if row["source_ids"] else None)
            if (row["spec"] or {}).get("source_type") == "architectural_plan":
                # the assumptions behind a model from floor plans stay visible after edits
                kept = [r for r in row["review_reasons"] or [] if r.get("subject") in ARCH_NOTE_SUBJECTS
                        and r.get("severity") == "warning"]
                spec["source_type"] = "architectural_plan"
                reasons = kept + reasons
        store.update_draft(conn, project_id, model_id, spec=spec, reasons=reasons, deadline=_date(body.deadline, "deadline"),
                           title=body.title, extraction_status=None if reasons is None else
                           ("needs_review" if blocking(reasons) else "done"))
        return _summary(store.get_model(conn, project_id, model_id))


@router.post("/models/{model_id}/activate")
def activate_model(project_id: str, model_id: str, member=Depends(require_roles("manager"))):
    with writer_engine().begin() as conn:
        _installed(conn)
        try:
            return store.activate(conn, project_id, _uuid(model_id), member_id=member["member_id"],
                                  as_of=datetime.now(timezone.utc).replace(microsecond=0))
        except LookupError:
            raise HTTPException(404, "Model not found") from None
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from None
