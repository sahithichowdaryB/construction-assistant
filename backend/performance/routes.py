"""HTTP routes for baselines, daily evaluations and overall performance (plan section 10).

All under /projects/{project_id}, bearer token, `as_of` supported (timezone-aware). Reads use the read-only login;
writes (and on-demand computations, which persist a version) use the writer login. Model calls only happen in
background work (upload extraction, recompute) or on explicit POSTs, never implicitly on a GET.
"""

from __future__ import annotations

import hashlib
import json
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import text

from database import writer_engine
from deps import check_cutoff, check_member, connection, require_roles

from . import baseline as bl
from . import daily, overall, plans
from .metrics import DISCLAIMER

router = APIRouter(prefix="/projects/{project_id}", tags=["performance"])
MAX_UPLOAD = 25 * 1024 * 1024
PLAN_SUFFIXES = {".pdf", ".csv", ".docx", ".txt", ".md"}


def _stamp(as_of):
    check_cutoff(as_of)
    return as_of or datetime.now(timezone.utc).replace(microsecond=0)


def _day(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise HTTPException(422, "Dates are YYYY-MM-DD") from None


def _uuid(value: str) -> str:
    import re
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", value or ""):
        raise HTTPException(404, "Not found")
    return value


# ------------------------------------------------------------------ reference plans (mock_data PDFs)

@router.get("/plans", dependencies=[Depends(check_member)])
def list_plan_files(project_id: str):
    return {"plans": plans.list_plans()}


@router.post("/plans", status_code=201)
def upload_plan(project_id: str, file: UploadFile = File(...), member=Depends(require_roles("manager"))):
    """Add a PDF plan to the list. It is summarised the first time it is opened."""
    if Path(file.filename or "").suffix.lower() != ".pdf":
        raise HTTPException(422, "Plans must be PDF files")
    data = file.file.read(MAX_UPLOAD + 1)
    if not data.startswith(b"%PDF") or len(data) > MAX_UPLOAD:
        raise HTTPException(422, "Not a PDF, or larger than 25 MB")
    path = plans.save_upload(file.filename, data)
    return next(p for p in plans.list_plans() if p["filename"] == path.name)


@router.get("/plans/{plan_id}/page/{page}.png", dependencies=[Depends(check_member)])
def plan_page(project_id: str, plan_id: str, page: int):
    path = plans.find_plan(plan_id)
    png = plans.render_page(path, page) if path else None
    if png is None:
        raise HTTPException(404, "Page not found")
    return Response(png, media_type="image/png", headers={"Cache-Control": "private, max-age=86400"})


@router.get("/plans/{plan_id}/file", dependencies=[Depends(check_member)])
def plan_file(project_id: str, plan_id: str):
    path = plans.find_plan(plan_id)
    if path is None:
        raise HTTPException(404, "Plan not found")
    return Response(path.read_bytes(), media_type="application/pdf",
                    headers={"Content-Disposition": f'inline; filename="{path.name}"'})


@router.get("/plans/{plan_id}/summary", dependencies=[Depends(check_member)])
def plan_summary(project_id: str, plan_id: str, refresh: bool = False):
    """Agent summary of one plan. Reads the PDF with the model the first time, then serves the cached copy."""
    from documents.llm import ModelUnavailable
    path = plans.find_plan(plan_id) if plan_id != "all" else None
    if path is None and plan_id != "all":
        raise HTTPException(404, "Plan not found")
    try:
        return plans.summarise_all(refresh=refresh) if plan_id == "all" else plans.summarise(path, refresh=refresh)
    except (ModelUnavailable, ValueError) as exc:
        raise HTTPException(503, f"The summary could not be written right now: {exc}") from None


# ------------------------------------------------------------------ baselines

def _baseline_view(conn, row, *, full=True):
    x = row["extracted"] or {}
    view = {k: row[k] for k in ("id", "revision", "status", "extraction_status", "title", "source_ids", "model", "error",
                                "created_by", "created_at", "as_of", "activated_by", "activated_at")}
    reasons = row["review_reasons"] or []
    view.update(review_reasons=reasons, blocking=len(bl.blocking(reasons)),
                counts={"activities": len(x.get("activities") or []), "milestones": len(x.get("milestones") or []),
                        "thresholds": len(x.get("thresholds") or []), "notice_rules": len(x.get("notice_rules") or []),
                        "rates": len(x.get("rates") or [])},
                weights_total=round(sum(a.get("weight_pct") or 0 for a in x.get("activities") or []), 2))
    if full:
        view["extracted"] = x
        view["settings_preview"] = bl.settings_from_extracted(x)
        view["sources"] = [dict(r) for r in conn.execute(text("""
            SELECT id, title, kind, available_at, meta->>'filename' AS filename, meta->>'pages' AS pages
            FROM sitemate.sources WHERE project_id=:p AND id = ANY(:ids) ORDER BY id"""),
            {"p": row["project_id"], "ids": list(row["source_ids"] or [])}).mappings()]
    return view


def run_extraction(project_id: str, baseline_id: str):
    """Background: parse every plan file (documents.ingest), then extract (CSV mapping or P1) and validate."""
    from documents import storage
    from documents.ingest import ingest_source

    engine = writer_engine()
    with engine.begin() as conn:
        b = bl.get_baseline(conn, project_id, baseline_id)
        conn.execute(text("UPDATE sitemate.plan_baselines SET extraction_status='running' WHERE project_id=:p "
                          "AND id=CAST(:b AS uuid)"), {"p": project_id, "b": baseline_id})
    try:
        for source_id in b["source_ids"]:
            outcome = ingest_source(project_id, source_id, summarize=False)
            if outcome["status"] == "failed":
                raise RuntimeError(f"{source_id}: {outcome.get('error')}")
        with engine.connect() as conn:
            passages = bl.load_passages(conn, project_id, b["source_ids"])
            pdfs, csv_parts = [], []
            for source_id in b["source_ids"]:
                path = storage.resolve(project_id, conn.scalar(text(
                    "SELECT path FROM sitemate.sources WHERE project_id=:p AND id=:s"), {"p": project_id, "s": source_id}))
                if path and path.suffix.lower() == ".pdf":
                    pdfs.append((source_id, path.read_bytes()))
                elif path and path.suffix.lower() == ".csv":
                    mapped = bl.map_csv(bl.csv_rows_for_source(conn, project_id, source_id), source_id)
                    if mapped:
                        csv_parts.append((source_id, mapped))
        by_ref = {f"{p['source_id']}:{p['locator']}": p["excerpt"] for p in passages}
        reasons, model = [], None
        csv_ids = {s for s, _ in csv_parts}
        if csv_parts and csv_ids == set(b["source_ids"]):
            merged, conflicts = bl.merge_extractions([x for _, x in csv_parts])
            merged.update(method="csv", merge_conflicts=conflicts)
            extracted, reasons = bl.validate(merged, by_ref, grounded=False)
        else:
            raw = bl.extract_plan([p for p in passages if p["source_id"] not in csv_ids], pdfs)
            model = raw.get("model")
            parts = [raw] + [x for _, x in csv_parts]
            merged, conflicts = bl.merge_extractions(parts)
            merged.update(method="llm", merge_conflicts=raw.get("merge_conflicts", []) + conflicts, model=model)
            extracted, reasons = bl.validate(merged, by_ref, grounded=True)
        status = "needs_review" if reasons or not extracted.get("activities") else "done"
        with engine.begin() as conn:
            bl.update_draft(conn, project_id, baseline_id, extracted, reasons, extraction_status=status, model=model)
    except Exception as exc:  # noqa: BLE001 - recorded on the baseline so the manager can retry
        with engine.begin() as conn:
            conn.execute(text("""UPDATE sitemate.plan_baselines SET extraction_status='failed', error=:e
                                 WHERE project_id=:p AND id=CAST(:b AS uuid)"""),
                         {"p": project_id, "b": baseline_id, "e": f"{type(exc).__name__}: {exc}"[:1000]})


@router.post("/baselines", status_code=202)
def upload_baseline(project_id: str, background: BackgroundTasks, files: list[UploadFile] = File(...),
                    title: str | None = Form(None, max_length=200), available_at: str | None = Form(None),
                    member=Depends(require_roles("manager"))):
    """Upload one or more plan files (PDF programme, resource/cost/contract plan, CSV schedule, Word, text).
    They become one draft baseline. Extraction runs in the background; nothing is activated."""
    from documents import storage
    if not files or len(files) > 10:
        raise HTTPException(422, "Upload 1 to 10 plan files")
    try:
        when = datetime.fromisoformat(available_at) if available_at else datetime.now(timezone.utc).replace(microsecond=0)
    except ValueError:
        raise HTTPException(422, "available_at must be ISO 8601") from None
    if when.utcoffset() is None:
        raise HTTPException(422, "available_at must include a time zone")
    stored = []
    for f in files:
        suffix = Path(f.filename or "").suffix.lower()
        if suffix not in PLAN_SUFFIXES:
            raise HTTPException(422, f"{f.filename}: plans must be one of {sorted(PLAN_SUFFIXES)}")
        data = f.file.read(MAX_UPLOAD + 1)
        if not data or len(data) > MAX_UPLOAD:
            raise HTTPException(413, f"{f.filename}: empty or larger than 25 MB")
        stored.append((f.filename, suffix, data))
    source_ids = []
    with writer_engine().begin() as conn:
        if conn.scalar(text("SELECT 1 FROM sitemate.projects WHERE id=:p"), {"p": project_id}) is None:
            raise HTTPException(404, "Unknown project")
        for name, suffix, data in stored:
            digest = hashlib.sha256(data).hexdigest()
            source_id = f"PLN-{digest[:8].upper()}"
            exists = conn.scalar(text("SELECT sha256 FROM sitemate.sources WHERE project_id=:p AND id=:s"),
                                 {"p": project_id, "s": source_id})
            if exists is None:
                path, _ = storage.save_upload(project_id, data, suffix)
                conn.execute(text("""INSERT INTO sitemate.sources (project_id, id, kind, path, available_at, sha256, title, meta,
                                                                  author, author_role)
                    VALUES (:p, :s, 'plan', :path, :at, :sha, :title, CAST(:meta AS jsonb), :author, 'site_supervisor')"""),
                             {"p": project_id, "s": source_id, "path": path, "at": when, "sha": digest, "title": name,
                              "meta": json.dumps({"filename": name, "uploaded_by": member["member_id"]}),
                              "author": member["display_name"]})
            source_ids.append(source_id)
        created = bl.create_baseline(conn, project_id, {"activities": [], "milestones": []}, [], source_ids, as_of=when,
                                     member_id=member["member_id"], title=title, extraction_status="queued")
        row = bl.get_baseline(conn, project_id, created["id"])
    background.add_task(run_extraction, project_id, created["id"])
    return _baseline_view(conn, row, full=False)


@router.get("/baselines", dependencies=[Depends(check_member)])
def list_baselines(project_id: str, as_of: datetime | None = None, conn=Depends(connection)):
    check_cutoff(as_of)
    rows = conn.execute(text("""SELECT *, id::text AS id FROM sitemate.plan_baselines WHERE project_id=:p
        AND as_of <= coalesce(CAST(:cutoff AS timestamptz), 'infinity') ORDER BY revision DESC"""),
                        {"p": project_id, "cutoff": as_of}).mappings().all()
    active = bl.active_baseline(conn, project_id, as_of)
    return {"active_id": active["id"] if active else None, "baselines": [_baseline_view(conn, r, full=False) for r in rows]}


@router.get("/baselines/{baseline_id}", dependencies=[Depends(check_member)])
def baseline_detail(project_id: str, baseline_id: str, conn=Depends(connection)):
    row = bl.get_baseline(conn, project_id, _uuid(baseline_id))
    if row is None:
        raise HTTPException(404, "Baseline not found")
    return _baseline_view(conn, row)


class BaselinePatch(BaseModel):
    activities: list[dict] | None = None       # rows by code: given fields replace extracted ones; {"code","delete":true}
    milestones: list[dict] | None = None
    calendar: dict | None = None
    settings_overrides: dict | None = None     # thresholds, notice_rules, rates, ledger_rules ... (see metrics)
    normalize_weights: bool = False
    expected_as_of: datetime | None = None


EDITABLE = ("name", "trade", "contractor", "zone", "unit", "planned_start", "planned_finish", "duration_wd",
            "planned_total", "target_per_day", "weight_pct", "predecessors", "is_critical")


@router.patch("/baselines/{baseline_id}")
def edit_baseline(project_id: str, baseline_id: str, body: BaselinePatch, member=Depends(require_roles("manager"))):
    """Manager edits of a draft. Edited values are the manager's (basis 'manager'); validation runs again."""
    with writer_engine().begin() as conn:
        row = bl.get_baseline(conn, project_id, _uuid(baseline_id))
        if row is None:
            raise HTTPException(404, "Baseline not found")
        if row["status"] != "draft":
            raise HTTPException(409, "Only a draft baseline can be edited; upload a new revision instead")
        x = dict(row["extracted"] or {})
        acts = {a["code"]: dict(a) for a in x.get("activities") or []}
        for edit in body.activities or []:
            code = str(edit.get("code") or "").strip()
            if not code:
                raise HTTPException(422, "Each activity edit needs a code")
            if edit.get("delete"):
                acts.pop(code, None)
                continue
            a = acts.setdefault(code, {"code": code, "refs": [], "missing": [], "derived": [], "predecessors": []})
            for field in EDITABLE:
                if field in edit:
                    a[field] = edit[field]
                    a.setdefault("manager_fields", [])
                    if field not in a["manager_fields"]:
                        a["manager_fields"].append(field)
                    a["missing"] = [f for f in a.get("missing") or [] if f != field]
                    a["derived"] = [f for f in a.get("derived") or [] if f != field]
        if body.normalize_weights:
            total = sum(a.get("weight_pct") or 0 for a in acts.values())
            if total:
                for a in acts.values():
                    if a.get("weight_pct") is not None:
                        a["weight_pct"] = round(a["weight_pct"] * 100 / total, 4)
        x["activities"] = list(acts.values())
        if body.milestones is not None:
            x["milestones"] = body.milestones
        if body.calendar is not None:
            x["calendar"] = {**(x.get("calendar") or {}), **body.calendar, "manager_edited": True}
        if body.settings_overrides is not None:
            x["settings_overrides"] = body.settings_overrides
        passages = dict(conn.execute(text("""SELECT source_id || ':' || locator, excerpt FROM sitemate.source_passages
            WHERE project_id=:p AND source_id = ANY(:ids)"""), {"p": project_id, "ids": list(row["source_ids"])}).all())
        # Structural checks again; earlier grounding warnings stay for rows the manager did not touch.
        extracted, reasons = bl.validate(x, passages, grounded=False)
        touched = {str(e.get("code")) for e in body.activities or []}
        keep = [r for r in row["review_reasons"] or [] if r.get("severity") == "warning" and "cited text" in r.get("message", "")
                and r.get("subject") not in touched]
        bl.update_draft(conn, project_id, baseline_id, extracted, keep + reasons,
                        extraction_status="needs_review" if keep + reasons else "done")
        return _baseline_view(conn, bl.get_baseline(conn, project_id, baseline_id))


class ActivateIn(BaseModel):
    normalize_weights: bool = False


@router.post("/baselines/{baseline_id}/activate")
def activate_baseline(project_id: str, baseline_id: str, body: ActivateIn | None = None, as_of: datetime | None = None,
                      member=Depends(require_roles("manager"))):
    when = _stamp(as_of)
    with writer_engine().begin() as conn:
        try:
            result = bl.activate(conn, project_id, _uuid(baseline_id), member_id=member["member_id"], as_of=when,
                                 normalize_weights=bool(body and body.normalize_weights))
        except LookupError:
            raise HTTPException(404, "Baseline not found") from None
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from None
    return result


@router.post("/baselines/{baseline_id}/extract", status_code=202)
def retry_extraction(project_id: str, baseline_id: str, background: BackgroundTasks,
                     member=Depends(require_roles("manager"))):
    with writer_engine().begin() as conn:
        row = bl.get_baseline(conn, project_id, _uuid(baseline_id))
        if row is None or row["status"] != "draft":
            raise HTTPException(409, "Only a draft baseline can be re-extracted")
        conn.execute(text("UPDATE sitemate.plan_baselines SET extraction_status='queued', error=NULL "
                          "WHERE project_id=:p AND id=CAST(:b AS uuid)"), {"p": project_id, "b": baseline_id})
    background.add_task(run_extraction, project_id, baseline_id)
    return {"id": baseline_id, "extraction_status": "queued"}


# ------------------------------------------------------------------ daily evaluations

@router.get("/daily-evaluations", dependencies=[Depends(check_member)])
def list_days(project_id: str, start: str = Query(..., alias="from"), end: str = Query(..., alias="to"),
              as_of: datetime | None = None, conn=Depends(connection)):
    check_cutoff(as_of)
    rows = conn.execute(text("""SELECT DISTINCT ON (work_date) work_date, version, day_status, day_severity, day_score,
        status, provisional, summary->'headline'->>'text' AS headline, as_of
        FROM sitemate.daily_evaluations WHERE project_id=:p AND work_date BETWEEN :a AND :b
          AND as_of <= coalesce(CAST(:cutoff AS timestamptz), 'infinity')
        ORDER BY work_date, as_of DESC, version DESC"""),
                        {"p": project_id, "a": _day(start), "b": _day(end), "cutoff": as_of}).mappings().all()
    return [dict(r) | {"day_score": float(r["day_score"])} for r in rows]


@router.get("/daily-evaluations/{work_date}", dependencies=[Depends(check_member)])
def get_day(project_id: str, work_date: str, as_of: datetime | None = None, version: int | None = None,
            conn=Depends(connection)):
    """Latest version known at as_of (or ?version=). When none exists, or the records changed since it was computed
    (input digest), a new version is computed from code only (no model call); POST .../recompute adds the summary."""
    check_cutoff(as_of)
    day = _day(work_date)
    view = _current_day(project_id, day, as_of) if version is None else \
        daily.daily_view(conn, project_id, day, version=version, as_of=as_of)
    if view is None:
        raise HTTPException(404, "No evaluation for this day at this time")
    return view


def _current_day(project_id, day, as_of):
    """The day's evaluation as known at as_of, computed from code first when it is missing or out of date."""
    with writer_engine().begin() as w:
        try:
            daily.evaluate_day(w, project_id, day, as_of, use_llm=False, trigger="on_demand")
        except LookupError:
            raise HTTPException(404, "Unknown project") from None
    with writer_engine().connect() as w:
        return daily.daily_view(w, project_id, day, as_of=as_of)


@router.get("/daily-reports/{work_date}/report.{fmt}")
def daily_report(project_id: str, work_date: str, fmt: Literal["pdf", "docx"], as_of: datetime | None = None,
                 member=Depends(check_member), conn=Depends(connection)):
    """The generated daily site report for one work date: figures, cited summary, incidents and records received.
    No model call; the written sections are those of the day's evaluation (POST .../recompute adds them)."""
    from . import daily_report as dr
    check_cutoff(as_of)
    day = _day(work_date)
    view = _current_day(project_id, day, as_of)
    if view is None:
        raise HTTPException(404, "No evaluation for this day at this time")
    project = dict(conn.execute(text("SELECT name, timezone FROM sitemate.projects WHERE id=:p"),
                                {"p": project_id}).mappings().one())
    records = dr.day_records(conn, project_id, day, as_of, project["timezone"])
    delayed = {a["code"] for a in view["activities"] if a["status"] in ("behind", "late_start")} | \
        {i["activity_code"] for i in records["incidents"] if i.get("activity_code")} | \
        {i["activity_code"] for i in (view.get("indicators") or {}).get("equipment_idle") or [] if i.get("activity_code")}
    impact = dr.project_impact(conn, project_id, day, _stamp(as_of), delayed)
    data, mime = dr.render(fmt, project, view, records, member, datetime.now(timezone.utc), impact)
    return Response(data, media_type=mime, headers={
        "Content-Disposition": f'attachment; filename="daily-report-{project_id}-{day}.{fmt}"',
        "Cache-Control": "private, no-store"})


@router.post("/daily-evaluations/{work_date}/recompute", status_code=202)
def recompute_day(project_id: str, work_date: str, background: BackgroundTasks, as_of: datetime | None = None,
                  force: bool = True, member=Depends(require_roles("manager"))):
    """Queue a run (agent_jobs kind daily_eval) and start it in the background. The worker can pick it up too."""
    check_cutoff(as_of)
    day = _day(work_date)
    with writer_engine().begin() as conn:
        if not daily.queue_day(conn, project_id, day, "manual", as_of=as_of, delay_seconds=0, force=force):
            raise HTTPException(503, "Performance tables are not installed")
    background.add_task(daily.run_queued_day, writer_engine(), project_id, day)
    return {"work_date": day.isoformat(), "queued": True}


# ------------------------------------------------------------------ overall performance

def _snapshot(project_id, day, as_of, *, use_llm=False, force=False):
    with writer_engine().begin() as w:
        overall.snapshot(w, project_id, day, as_of, use_llm=use_llm, force=force)
    with writer_engine().connect() as w:
        return overall.snapshot_view(w, project_id, day, as_of)


@router.get("/performance", dependencies=[Depends(check_member)])
def performance(project_id: str, date_: str | None = Query(None, alias="date"), as_of: datetime | None = None,
                conn=Depends(connection)):
    """Latest snapshot to the date; computed on demand (code only, no model call) when missing or stale."""
    when = _stamp(as_of)
    tz = conn.scalar(text("SELECT timezone FROM sitemate.projects WHERE id=:p"), {"p": project_id})
    if tz is None:
        raise HTTPException(404, "Unknown project")
    from zoneinfo import ZoneInfo
    day = _day(date_) if date_ else when.astimezone(ZoneInfo(tz)).date()
    return _snapshot(project_id, day, as_of)


@router.post("/performance/narrative", status_code=202)
def regenerate_narrative(project_id: str, background: BackgroundTasks, date_: str = Query(..., alias="date"),
                         as_of: datetime | None = None, member=Depends(require_roles("manager"))):
    """Write the cited narrative (P4) for the snapshot of this date (new version)."""
    check_cutoff(as_of)
    background.add_task(_snapshot, project_id, _day(date_), as_of, use_llm=True, force=True)
    return {"date": date_, "queued": True}


@router.get("/performance/s-curve", dependencies=[Depends(check_member)])
def s_curve(project_id: str, start: str | None = Query(None, alias="from"), end: str | None = Query(None, alias="to"),
            as_of: datetime | None = None, conn=Depends(connection)):
    when = _stamp(as_of)
    tz = conn.scalar(text("SELECT timezone FROM sitemate.projects WHERE id=:p"), {"p": project_id})
    from zoneinfo import ZoneInfo
    to = _day(end) if end else when.astimezone(ZoneInfo(tz or "UTC")).date()
    computed = overall.compute(conn, project_id, to, when)
    points = [p for p in computed["s_curve"] if not start or p["date"] >= start]
    m = computed["metrics"]
    return {"points": points, "spi": m["spi"], "spi_band": m["spi_band"], "as_of_date": to.isoformat(),
            "weight_basis": m["weight_basis"]}


@router.get("/performance/ledger", dependencies=[Depends(check_member)])
def ledger(project_id: str, start: str | None = Query(None, alias="from"), end: str | None = Query(None, alias="to"),
           kind: Literal["merit", "demerit"] | None = None,
           status: Literal["proposed", "accepted", "disputed"] | None = None,
           as_of: datetime | None = None, conn=Depends(connection)):
    when = _stamp(as_of)
    rows = overall.ledger_rows(conn, project_id, _day(end) if end else date(9999, 12, 31), when,
                               start=_day(start) if start else None, kind=kind, status=status)
    from .metrics import score
    return {"entries": rows, "score": score(rows), "disclaimer": DISCLAIMER}


class LedgerReview(BaseModel):
    status: Literal["accepted", "disputed", "proposed"]
    note: str | None = Field(None, max_length=2000)


@router.patch("/performance/ledger/{entry_id}")
def review_entry(project_id: str, entry_id: str, body: LedgerReview, as_of: datetime | None = None,
                 member=Depends(require_roles("manager"))):
    """Accept or dispute a ledger entry. A disputed entry is left out of the score until resolved."""
    when = _stamp(as_of)
    note = (body.note or "").strip() or None
    if body.status == "disputed" and not note:
        raise HTTPException(422, "Say why the entry is disputed")
    with writer_engine().begin() as conn:
        row = conn.execute(text("""UPDATE sitemate.performance_ledger SET status=:s, reviewer_id=:m, note=:n, reviewed_at=:at,
                detail = detail || jsonb_build_object('review_status', CAST(:s AS text))
            WHERE project_id=:p AND id=CAST(:i AS uuid) AND status <> 'superseded'
            RETURNING id::text AS id, status, note, reviewer_id, reviewed_at"""),
                           {"p": project_id, "i": _uuid(entry_id), "s": body.status, "m": member["member_id"], "n": note,
                            "at": when}).mappings().one_or_none()
        if row is None:
            raise HTTPException(404, "Entry not found or superseded by a newer evaluation")
        return dict(row)


@router.get("/performance/report.{fmt}", dependencies=[Depends(check_member)])
def report(project_id: str, fmt: Literal["pdf", "docx"], date_: str = Query(..., alias="date"),
           as_of: datetime | None = None, member=Depends(check_member), conn=Depends(connection)):
    from .export import render
    day = _day(date_)
    view = overall.snapshot_view(conn, project_id, day, as_of) or _snapshot(project_id, day, as_of)
    if view is None:
        raise HTTPException(404, "No snapshot for this date")
    project = conn.execute(text("SELECT name, timezone FROM sitemate.projects WHERE id=:p"), {"p": project_id}).mappings().one()
    entries = overall.ledger_rows(conn, project_id, day, _stamp(as_of))
    data, mime = render(fmt, dict(project), view, entries, member)
    return Response(data, media_type=mime, headers={
        "Content-Disposition": f'attachment; filename="performance-{project_id}-{day}.{fmt}"',
        "Cache-Control": "private, no-store"})
