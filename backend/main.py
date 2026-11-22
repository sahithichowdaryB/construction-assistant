import os
import sys
from datetime import date as WorkDate, datetime, timezone
from pathlib import Path
from uuid import UUID

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from auth_routes import router as auth_router
from database import engine_for, writer_engine
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
                   allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE"], allow_headers=["Authorization", "Content-Type"])
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


@app.get("/health/capabilities")
def capabilities():
    """What this deployment can do (booleans only, no configuration values): database, model, speech-to-text and
    whether a worker polled in the last 10 minutes. The web app uses it to enable the mic and warn when background
    processing is offline."""
    from app.capture.transcription import transcription_enabled
    worker_seen = None
    try:
        with engine_for().connect() as conn:
            db = conn.scalar(text("SELECT 1")) == 1
            if conn.scalar(text("SELECT to_regclass('sitemate.worker_heartbeats')")) is not None:
                worker_seen = conn.scalar(text("SELECT max(seen_at) FROM sitemate.worker_heartbeats"))
    except Exception:  # noqa: BLE001 - a health probe reports, it never raises
        db = False
    fresh = bool(worker_seen and (datetime.now(timezone.utc) - worker_seen).total_seconds() < 600)
    return {"db": db, "llm": bool(os.environ.get("ANTHROPIC_API_KEY")), "stt": transcription_enabled(),
            "worker": fresh, "worker_seen_at": worker_seen}


def check_incident_id(incident_id: str):
    try:
        UUID(incident_id)
    except ValueError:
        raise HTTPException(404, "Incident not found") from None


@app.get("/projects/{project_id}/alerts", dependencies=[Depends(check_member)])
def alerts(project_id: str, as_of: datetime | None = None, status: str | None = None, kind: str | None = None,
           conn=Depends(connection)):
    """Shortfall alerts and incident alerts. `kind=incident` / `kind=shortfall`, and `status`, narrow the list.

    Performance alerts (late_start, equipment_idle, missing_report, quality_hold) are listed with `kind=performance`,
    their own kind, or `kind=all`; the default list keeps its previous content."""
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
          AND (((CAST(:kind AS text) IS NULL OR CAST(:kind AS text) = 'shortfall') AND a.kind = 'shortfall')
               OR ((CAST(:kind AS text) IS NULL OR CAST(:kind AS text) = 'incident') AND a.kind = 'incident')
               OR (CAST(:kind AS text) = 'performance' AND a.kind NOT IN ('shortfall', 'incident'))
               OR CAST(:kind AS text) = 'all'
               OR (CAST(:kind AS text) NOT IN ('shortfall', 'incident', 'performance', 'all') AND a.kind = CAST(:kind AS text)))
        ORDER BY a.checkpoint_at DESC, a.activity_code, a.id
    """), {"project": project_id, "cutoff": as_of, "status": status, "kind": kind})
    return [dict(row) for row in rows.mappings()]


@app.get("/projects/{project_id}", dependencies=[Depends(check_member)])
def project_info(project_id: str, conn=Depends(connection)):
    """Project settings for the web app (Settings, headers). Contract details the record lacks stay null."""
    row = conn.execute(text("SELECT * FROM sitemate.projects WHERE id=:p"), {"p": project_id}).mappings().one_or_none()
    if row is None:
        raise HTTPException(404, "Unknown project")
    note = conn.scalar(text("""SELECT excerpt FROM sitemate.source_passages WHERE project_id=:p AND source_id='PRJ'
                              AND locator='calendar'"""), {"p": project_id})
    rates = conn.execute(text("""SELECT count(*) AS total, count(amount) AS set FROM sitemate.cost_rates
                                 WHERE project_id=:p"""), {"p": project_id}).mappings().one()
    return {"id": row["id"], "name": row["name"], "timezone": row["timezone"],
            "thresholds": {"deviation_pct": float(row["threshold"]), "high_above_pct": float(row["high_threshold"])},
            "sender": {"name": row["sender"], "address": row["sender_address"]},
            "recipient": {"name": row["recipient"], "address": row["recipient_address"]},
            "contract_reference": row["contract_reference"], "contract_clause": row["contract_clause"],
            "rate_table": f"{rates['set']} of {rates['total']} rates set" if rates["total"] else None,
            "calendar_note": note, "locale": row.get("locale") or "en-GB", "settings": row.get("settings") or {}}


@app.get("/projects/{project_id}/activities", dependencies=[Depends(check_member)])
def activity_list(project_id: str, as_of: datetime | None = None, conn=Depends(connection)):
    """The activity register with its planned dates and quantities: from the active baseline when there is one,
    otherwise from the dated plan targets (as of `as_of`)."""
    check_cutoff(as_of)
    rows = conn.execute(text("""
        WITH active AS (SELECT id FROM sitemate.plan_baselines WHERE project_id = :p AND status = 'active'
                        AND coalesce(activated_at, as_of) <= coalesce(CAST(:cutoff AS timestamptz), 'infinity'))
        SELECT a.code, a.name, a.zone, a.unit, a.contractor_id,
               coalesce(ap.planned_start, t.first_day) AS planned_start,
               coalesce(ap.planned_finish, t.last_day) AS planned_end,
               coalesce(ap.target_per_day, t.per_day) AS planned_qty_per_day,
               coalesce(ap.planned_total, t.total) AS planned_total_qty,
               ap.is_critical, ap.weight,
               ARRAY(SELECT d.predecessor FROM sitemate.activity_dependencies d
                     WHERE d.project_id = a.project_id AND d.successor = a.code ORDER BY 1) AS predecessors,
               ARRAY(SELECT DISTINCT e.equipment_id FROM sitemate.equipment_assignments e
                     WHERE e.project_id = a.project_id AND e.activity_code = a.code ORDER BY 1) AS equipment_ids
        FROM sitemate.activities a
        LEFT JOIN sitemate.activity_plan ap ON ap.project_id = a.project_id AND ap.activity_code = a.code
             AND ap.baseline_id = (SELECT id FROM active)
        LEFT JOIN LATERAL (SELECT min(work_date) AS first_day, max(work_date) AS last_day, max(quantity) AS per_day,
                                  sum(quantity) AS total
                           FROM sitemate.plan_targets pt JOIN sitemate.sources s
                             ON (s.project_id, s.id) = (pt.project_id, pt.source_id)
                           WHERE pt.project_id = a.project_id AND pt.activity_code = a.code AND pt.quantity > 0
                             AND s.available_at <= coalesce(CAST(:cutoff AS timestamptz), 'infinity')) t ON true
        WHERE a.project_id = :p
        ORDER BY coalesce(ap.planned_start, t.first_day) NULLS LAST, a.code
    """), {"p": project_id, "cutoff": as_of}).mappings().all()
    num = lambda v: float(v) if v is not None else None  # noqa: E731
    return [{**dict(r), "planned_qty_per_day": num(r["planned_qty_per_day"]), "planned_total_qty": num(r["planned_total_qty"]),
             "weight": num(r["weight"]), "crew_size": None} for r in rows if r["planned_start"]]


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
          AND (o.accepted_at IS NULL OR o.accepted_at <= coalesce(CAST(:cutoff AS timestamptz),'infinity'))
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
    # Like the worker's reasoning job: the recommended actions follow the new analysis (proposed, for a manager).
    try:
        from app import worker
        with writer_engine().begin() as w:
            worker.enqueue(w, project_id, "plan_actions", incident_id)
    except Exception:  # noqa: BLE001 - the analysis is saved; planning can be re-run from the worker
        pass
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
from performance.routes import router as performance_router  # noqa: E402  (baselines, daily and overall evaluation)
from drafting import router as drafting_router  # noqa: E402  (gaps, submit, stored exports for every draft type)
from ask.routes import router as ask_router  # noqa: E402  (Ask SiteMate: cited, read-only answers)
from daily_report.routes import router as daily_report_router  # noqa: E402  (appointments, daily report drafts)

app.include_router(ops_router)
app.include_router(capture_router)
app.include_router(performance_router)
app.include_router(drafting_router)
app.include_router(ask_router)
app.include_router(daily_report_router)
