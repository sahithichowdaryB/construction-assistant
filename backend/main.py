import sys
from datetime import date as WorkDate, datetime
from pathlib import Path
from uuid import UUID

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from auth_routes import router as auth_router
from database import engine_for
from workflow import router as workflow_router
from correspondence import router as correspondence_router
from recaps import router as recaps_router
from deps import check_cutoff, check_member, connection, current_member
from documents import storage
from documents.routes import mime_for, router as documents_router

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "ai-agent"))
from app import persist as analysis_store  # noqa: E402  (ai-agent/app: the incident evidence agent)
from app.llm import LLMError, get_llm  # noqa: E402
from app.orchestrator import IncidentNotFound, analyze_incident, input_digest  # noqa: E402
from app.tools import SqlEvidenceStore, default_as_of  # noqa: E402

app = FastAPI(title="SiteMate API")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
                   allow_methods=["GET", "POST", "PATCH"], allow_headers=["Authorization", "Content-Type"])
app.include_router(documents_router)
app.include_router(auth_router)
app.include_router(workflow_router)
app.include_router(correspondence_router)
app.include_router(recaps_router)


def check_manager(member=Depends(current_member)):
    if member["role"] not in ("manager", "approver"):
        raise HTTPException(403, "A manager or approver role is required")
    return member


@app.get("/health/db")
def health():
    try:
        with engine_for().connect() as conn:
            conn.execute(text("SELECT 1"))
    except SQLAlchemyError:
        raise HTTPException(503, "Database unavailable") from None
    return {"database": "connected"}


def check_incident_id(incident_id: str):
    try:
        UUID(incident_id)
    except ValueError:
        raise HTTPException(404, "Incident not found") from None


@app.get("/projects/{project_id}/alerts", dependencies=[Depends(check_member)])
def alerts(project_id: str, as_of: datetime | None = None, status: str | None = None, kind: str | None = None,
           conn=Depends(connection)):
    """Shortfall alerts and incident alerts. `kind=incident` / `kind=shortfall`, and `status`, narrow the list."""
    check_cutoff(as_of)
    rows = conn.execute(text("""
        SELECT a.id, a.activity_code, a.kind, a.checkpoint_at, a.status, a.title, a.assigned_to,
               a.incident_id::text AS incident_id, a.acknowledged_by, a.acknowledged_at, a.resolved_by, a.resolved_at,
               r.version, r.as_of, r.severity, r.calculation, r.evidence_refs, r.reason, r.analysis_id::text AS analysis_id,
               i.category, i.report_count, i.reporter_count, i.status AS incident_status, i.zone, i.asset_key
        FROM sitemate.alerts a
        JOIN LATERAL (
            SELECT version, as_of, severity, calculation, evidence_refs, reason, analysis_id
            FROM sitemate.alert_revisions r
            WHERE r.project_id=a.project_id AND r.alert_id=a.id
              AND r.as_of <= coalesce(CAST(:cutoff AS timestamptz), 'infinity')
            ORDER BY r.as_of DESC, version DESC LIMIT 1
        ) r ON true
        LEFT JOIN sitemate.incidents i ON (i.project_id, i.id) = (a.project_id, a.incident_id)
        WHERE a.project_id=:project
          AND (CAST(:status AS text) IS NULL OR a.status = CAST(:status AS text))
          AND (CAST(:kind AS text) IS NULL
               OR (CAST(:kind AS text) = 'incident' AND a.kind = 'incident')
               OR (CAST(:kind AS text) = 'shortfall' AND a.kind <> 'incident'))
        ORDER BY a.checkpoint_at DESC, a.activity_code, a.id
    """), {"project": project_id, "cutoff": as_of, "status": status, "kind": kind})
    return [dict(row) for row in rows.mappings()]


@app.get("/projects/{project_id}/activities/{code}/progress", dependencies=[Depends(check_member)])
def progress(project_id: str, code: str, date: WorkDate, as_of: datetime | None = Query(None),
             conn=Depends(connection)):
    check_cutoff(as_of)
    params = {"p": project_id, "c": code, "day": date, "cutoff": as_of}
    target = conn.execute(text("""
        SELECT t.quantity, a.unit, t.source_id, t.locator, p.threshold, p.high_threshold
        FROM sitemate.plan_targets t
        JOIN sitemate.activities a ON (a.project_id, a.code) = (t.project_id, t.activity_code)
        JOIN sitemate.projects p ON p.id=t.project_id
        JOIN sitemate.sources s ON (s.project_id, s.id)=(t.project_id,t.source_id)
        WHERE t.project_id=:p AND t.activity_code=:c AND t.work_date=:day
          AND s.available_at <= coalesce(CAST(:cutoff AS timestamptz),'infinity')
    """), params).mappings().one_or_none()
    if target is None:
        raise HTTPException(404, "No baseline for this activity and date")
    records = conn.execute(text("""
        SELECT o.quantity, o.basis, o.source_id, o.locator, sp.page, sp.excerpt, s.available_at
        FROM sitemate.observations o
        JOIN sitemate.source_passages sp USING (project_id,source_id,locator)
        JOIN sitemate.sources s ON (s.project_id,s.id)=(o.project_id,o.source_id)
        WHERE o.project_id=:p AND o.activity_code=:c AND o.work_date=:day
          AND s.available_at <= coalesce(CAST(:cutoff AS timestamptz),'infinity')
        ORDER BY (o.basis='signed') DESC, s.available_at DESC, o.source_id, o.locator
    """), params).mappings().all()
    reading = records[0] if records else None
    actual = reading["quantity"] if reading else None
    plan = target["quantity"]
    pct = None
    severity = "none" if reading and reading["basis"] == "signed" else None
    if actual is not None and plan > 0:
        pct = 100 * max(plan - actual, 0) / plan
        if reading["basis"] == "signed":
            if pct > target["high_threshold"]:
                severity = "high"
            elif pct > target["threshold"]:
                severity = "medium"
    return {
        "activity_code": code, "work_date": date, "unit": target["unit"], "planned": plan,
        "actual": actual, "basis": reading["basis"] if reading else None,
        "shortfall_pct": round(pct, 2) if pct is not None else None, "severity": severity,
        "plan_evidence": {"source_id": target["source_id"], "locator": target["locator"]},
        "evidence": {k: reading[k] for k in ("source_id", "page", "locator")} if reading else None,
        "observations": [dict(row) for row in records],
    }


@app.get("/projects/{project_id}/sources/{source_id}/file", dependencies=[Depends(check_member)])
def original(project_id: str, source_id: str, as_of: datetime | None = None, download: bool = False,
             conn=Depends(connection)):
    check_cutoff(as_of)
    row = conn.execute(text("""
        SELECT path, meta->>'filename' AS filename FROM sitemate.sources WHERE project_id=:p AND id=:s
        AND available_at <= coalesce(CAST(:cutoff AS timestamptz),'infinity')
    """), {"p": project_id, "s": source_id, "cutoff": as_of}).one_or_none()
    if row is None:
        raise HTTPException(404, "Source unavailable")
    path = storage.resolve(project_id, row.path)
    if path is None:
        raise HTTPException(404, "Source file unavailable")
    media = mime_for(path.name)
    # Viewed inline, CSV is sent as plain text: browsers download text/csv instead of showing it.
    if not download and media == "text/csv":
        media = "text/plain"
    if media.startswith("text/") or media == "application/json":
        media += "; charset=utf-8"
    name = Path(row.filename or path.name).name
    return FileResponse(path, media_type=media, filename=name,
                        content_disposition_type="attachment" if download else "inline")


@app.post("/projects/{project_id}/incidents/{incident_id}/reasoning", dependencies=[Depends(check_manager)])
def run_reasoning(project_id: str, incident_id: str, as_of: datetime | None = None, conn=Depends(connection)):
    """Find and cite what the records say caused an incident, with a confidence score (new immutable version)."""
    check_cutoff(as_of)
    check_incident_id(incident_id)
    when = as_of or default_as_of()
    try:
        llm = get_llm()
        result = analyze_incident(SqlEvidenceStore(conn, project_id, when), llm, incident_id, when)
    except IncidentNotFound:
        raise HTTPException(404, "Incident not found at this time") from None
    except LLMError as exc:
        raise HTTPException(502, f"Reasoning model unavailable: {exc}") from None
    saved = analysis_store.save_analysis(conn, project_id, result)
    return {**saved, **result.model_dump(mode="json")}


@app.get("/projects/{project_id}/incidents/{incident_id}/reasoning", dependencies=[Depends(check_member)])
def latest_reasoning(project_id: str, incident_id: str, as_of: datetime | None = None, conn=Depends(connection)):
    check_cutoff(as_of)
    check_incident_id(incident_id)
    found = analysis_store.load_analysis(conn, project_id, incident_id, as_of)
    if found is None:
        raise HTTPException(404, "No reasoning for this incident yet")
    # stale = the records available at this time differ from what the saved reasoning was based on
    store = SqlEvidenceStore(conn, project_id, as_of or default_as_of())
    incident = store.get_incident(incident_id)
    saved_digest = found.pop("input_digest")
    found["stale"] = bool(incident) and input_digest(incident_id, store.candidate_passages(incident)) != saved_digest
    return found


def incident_rows(conn, project_id: str, as_of, incident_id: str | None = None):
    """Incidents in the shape the web app expects, derived from incidents + events + capture_facts + evidence links."""
    params = {"p": project_id, "cutoff": as_of, "i": incident_id}
    rows = conn.execute(text("""
        SELECT i.id::text AS id, i.activity_code, i.kind, i.title, i.occurred_at, i.resolved_at,
               (i.occurred_at AT TIME ZONE p.timezone)::date AS local_day,
               i.category, i.event_type, i.summary, i.zone, i.asset_key, i.status, i.severity,
               i.report_count, i.reporter_count, i.first_reported_at, i.last_reported_at,
               i.merged_into_id::text AS merged_into_id, i.recurrence_of_id::text AS recurrence_of_id
        FROM sitemate.incidents i JOIN sitemate.projects p ON p.id=i.project_id
        WHERE i.project_id=:p AND (CAST(:i AS uuid) IS NULL OR i.id=CAST(:i AS uuid))
          AND (CAST(:i AS uuid) IS NOT NULL OR i.merged_into_id IS NULL)
          AND i.occurred_at <= coalesce(CAST(:cutoff AS timestamptz),'infinity')
        ORDER BY i.occurred_at DESC, i.id
    """), params).mappings().all()
    if not rows:
        return []
    facts = conn.execute(text("""
        SELECT cf.incident_id::text AS incident_id, cf.field_name, cf.value, fe.source_id, fe.locator, s.available_at
        FROM sitemate.capture_facts cf
        JOIN sitemate.fact_evidence fe ON (fe.project_id,fe.fact_id)=(cf.project_id,cf.id)
        JOIN sitemate.sources s ON (s.project_id,s.id)=(fe.project_id,fe.source_id)
        WHERE cf.project_id=:p AND cf.incident_id IS NOT NULL AND cf.review_status<>'rejected'
          AND s.available_at <= coalesce(CAST(:cutoff AS timestamptz),'infinity')
        ORDER BY s.available_at, fe.source_id, fe.locator
    """), params).mappings().all()
    linked = conn.execute(text("""
        SELECT ie.incident_id::text AS incident_id, ie.link_type, e.source_id, e.locator, e.summary, s.available_at
        FROM sitemate.incident_events ie
        JOIN sitemate.events e ON (e.project_id,e.id)=(ie.project_id,ie.event_id)
        JOIN sitemate.sources s ON (s.project_id,s.id)=(e.project_id,e.source_id)
        WHERE ie.project_id=:p AND ie.unlinked_at IS NULL
          AND s.available_at <= coalesce(CAST(:cutoff AS timestamptz),'infinity')
        ORDER BY s.available_at, e.source_id
    """), params).mappings().all()
    out = []
    for r in rows:
        mine = [f for f in facts if f["incident_id"] == r["id"]]
        events = [e for e in linked if e["incident_id"] == r["id"]]
        refs, seen = [], set()
        for src, loc in [(f["source_id"], f["locator"]) for f in mine] + [(e["source_id"], e["locator"]) for e in events]:
            if (src, loc) not in seen:
                seen.add((src, loc))
                refs.append({"source_id": src, "locator": loc, "passage_id": f"{src}:{loc}"})
        workers = [int(f["value"]["count"] if isinstance(f["value"], dict) else f["value"]) for f in mine
                   if f["field_name"] == "workers_affected"
                   and (isinstance(f["value"], (int, float)) or (isinstance(f["value"], dict) and "count" in f["value"]))]
        times = [f["available_at"] for f in mine] + [e["available_at"] for e in events]
        reported = min(times) if times else r["occurred_at"]
        equipment = conn.execute(text("""
            SELECT equipment_id FROM sitemate.equipment_assignments
            WHERE project_id=:p AND activity_code=:a AND work_date=:d
        """), {"p": project_id, "a": r["activity_code"], "d": r["local_day"]}).scalars().all()
        asset_equipment = r["asset_key"][3:] if r["asset_key"] and r["asset_key"].startswith("eq:") else None
        resolved = r["resolved_at"] if r["resolved_at"] and (as_of is None or r["resolved_at"] <= as_of) else None
        status = "open" if (r["status"] in ("resolved", "closed") and not resolved) else r["status"]
        timeline = [{"kind": "reported" if e["link_type"] == "origin" else "evidence", "at": e["available_at"],
                     "label": e["summary"], "refs": [{"source_id": e["source_id"], "locator": e["locator"],
                                                      "passage_id": f"{e['source_id']}:{e['locator']}"}]}
                    for e in events]
        timeline += [{"kind": "evidence", "at": f["available_at"], "label": f"{f['source_id']} {f['locator']}",
                      "refs": [{"source_id": f["source_id"], "locator": f["locator"],
                                "passage_id": f"{f['source_id']}:{f['locator']}"}]} for f in mine]
        if resolved:
            timeline.append({"kind": "resolved", "at": resolved, "label": "Resolved", "refs": []})
        timeline.sort(key=lambda t: t["at"])
        if timeline and timeline[0]["kind"] != "reported":
            timeline[0] = {**timeline[0], "kind": "reported"}
        out.append({"id": r["id"], "activity_code": r["activity_code"],
                    "type": {"equipment_failure": "equipment_breakdown", "delivery_delay": "delivery",
                             "quality_observation": "defect"}.get(r["kind"], "other"),
                    "category": r["category"] or "general", "event_type": r["event_type"] or r["kind"],
                    "title": r["title"], "summary": r["summary"] or r["title"], "zone": r["zone"],
                    "asset_key": r["asset_key"], "severity": r["severity"],
                    "report_count": r["report_count"], "reporter_count": r["reporter_count"],
                    "first_reported_at": r["first_reported_at"], "last_reported_at": r["last_reported_at"],
                    "merged_into_id": r["merged_into_id"], "recurrence_of_id": r["recurrence_of_id"],
                    "occurred_at": r["occurred_at"], "reported_at": reported,
                    "resolved_at": resolved, "status": status,
                    "affected_workers": max(workers) if workers else None,
                    "equipment_id": asset_equipment or (equipment[0] if len(equipment) == 1 else None),
                    "refs": refs, "timeline": timeline})
    return out


@app.get("/projects/{project_id}/incidents", dependencies=[Depends(check_member)])
def incidents(project_id: str, as_of: datetime | None = None, conn=Depends(connection)):
    check_cutoff(as_of)
    return incident_rows(conn, project_id, as_of)


@app.get("/projects/{project_id}/incidents/{incident_id}", dependencies=[Depends(check_member)])
def incident(project_id: str, incident_id: str, as_of: datetime | None = None, conn=Depends(connection)):
    check_cutoff(as_of)
    check_incident_id(incident_id)
    found = incident_rows(conn, project_id, as_of, incident_id)
    if not found:
        raise HTTPException(404, "Incident not found at this time")
    return found[0]


from capture import router as capture_router  # noqa: E402
from ops import router as ops_router  # noqa: E402  (manager actions: alerts, actions, incident corrections)

app.include_router(ops_router)
app.include_router(capture_router)
