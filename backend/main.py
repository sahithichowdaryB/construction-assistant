import hashlib
import sys
from datetime import date as WorkDate, datetime
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from database import engine_for

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "ai-agent"))
from app import persist as analysis_store  # noqa: E402  (ai-agent/app: the incident evidence agent)
from app.llm import LLMError, get_llm  # noqa: E402
from app.orchestrator import IncidentNotFound, analyze_incident  # noqa: E402
from app.tools import SqlEvidenceStore, default_as_of  # noqa: E402

app = FastAPI(title="SiteMate API")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
                   allow_methods=["GET", "POST"], allow_headers=["Authorization"])
bearer = HTTPBearer()
PACKS = {"RIV": Path(__file__).resolve().parents[1] / "data/riverside-demo"}


def connection():
    with engine_for().connect() as conn:
        yield conn


def check_member(project_id: str, credentials: HTTPAuthorizationCredentials = Depends(bearer),
                 conn=Depends(connection)):
    digest = hashlib.sha256(credentials.credentials.encode()).hexdigest()
    member = conn.scalar(text("""
        SELECT member_id FROM sitemate.project_members
        WHERE project_id=:project AND token_hash=:digest
    """), {"project": project_id, "digest": digest})
    if member is None:
        raise HTTPException(403, "Project access denied")


def check_manager(project_id: str, credentials: HTTPAuthorizationCredentials = Depends(bearer),
                  conn=Depends(connection)):
    digest = hashlib.sha256(credentials.credentials.encode()).hexdigest()
    role = conn.scalar(text("""
        SELECT role FROM sitemate.project_members WHERE project_id=:project AND token_hash=:digest
    """), {"project": project_id, "digest": digest})
    if role is None:
        raise HTTPException(403, "Project access denied")
    if role not in ("manager", "approver"):
        raise HTTPException(403, "A manager or approver role is required")


@app.get("/health/db")
def health():
    try:
        with engine_for().connect() as conn:
            conn.execute(text("SELECT 1"))
    except SQLAlchemyError:
        raise HTTPException(503, "Database unavailable") from None
    return {"database": "connected"}


def check_cutoff(as_of):
    if as_of is not None and as_of.utcoffset() is None:
        raise HTTPException(422, "as_of must include a time zone")


@app.get("/projects/{project_id}/alerts", dependencies=[Depends(check_member)])
def alerts(project_id: str, as_of: datetime | None = None, conn=Depends(connection)):
    check_cutoff(as_of)
    rows = conn.execute(text("""
        SELECT a.id, a.activity_code, a.kind, a.checkpoint_at, r.version, r.as_of,
               r.severity, r.calculation, r.evidence_refs
        FROM sitemate.alerts a
        JOIN LATERAL (
            SELECT version, as_of, severity, calculation, evidence_refs
            FROM sitemate.alert_revisions r
            WHERE r.project_id=a.project_id AND r.alert_id=a.id
              AND r.as_of <= coalesce(CAST(:cutoff AS timestamptz), 'infinity')
            ORDER BY r.as_of DESC, version DESC LIMIT 1
        ) r ON true
        WHERE a.project_id=:project
        ORDER BY a.checkpoint_at DESC, a.activity_code, a.id
    """), {"project": project_id, "cutoff": as_of})
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
def original(project_id: str, source_id: str, as_of: datetime | None = None, conn=Depends(connection)):
    check_cutoff(as_of)
    stored_path = conn.scalar(text("""
        SELECT path FROM sitemate.sources WHERE project_id=:p AND id=:s
        AND available_at <= coalesce(CAST(:cutoff AS timestamptz),'infinity')
    """), {"p": project_id, "s": source_id, "cutoff": as_of})
    if not stored_path or project_id not in PACKS:
        raise HTTPException(404, "Source unavailable")
    root = PACKS[project_id]
    path = (root / stored_path).resolve()
    if not path.is_relative_to((root / "uploads").resolve()) or not path.is_file():
        raise HTTPException(404, "Source file unavailable")
    return FileResponse(path)


@app.post("/projects/{project_id}/incidents/{incident_id}/analyze", dependencies=[Depends(check_manager)])
def analyze(project_id: str, incident_id: str, as_of: datetime | None = None, conn=Depends(connection)):
    """Find and cite what the records say caused an incident, with a confidence score (new immutable version)."""
    check_cutoff(as_of)
    when = as_of or default_as_of()
    try:
        llm = get_llm()
        result = analyze_incident(SqlEvidenceStore(conn, project_id, when), llm, incident_id, when)
    except IncidentNotFound:
        raise HTTPException(404, "Incident not found at this time") from None
    except LLMError as exc:
        raise HTTPException(502, f"Analysis model unavailable: {exc}") from None
    saved = analysis_store.save_analysis(conn, project_id, result)
    return {**saved, **result.model_dump(mode="json")}


@app.get("/projects/{project_id}/incidents/{incident_id}/analysis", dependencies=[Depends(check_member)])
def latest_analysis(project_id: str, incident_id: str, as_of: datetime | None = None, conn=Depends(connection)):
    check_cutoff(as_of)
    found = analysis_store.load_analysis(conn, project_id, incident_id, as_of)
    if found is None:
        raise HTTPException(404, "No analysis for this incident yet")
    return found


def incident_rows(conn, project_id: str, as_of, incident_id: str | None = None):
    """Incidents in the shape the web app expects, derived from incidents + capture_facts + evidence links."""
    params = {"p": project_id, "cutoff": as_of, "i": incident_id}
    rows = conn.execute(text("""
        SELECT i.id::text AS id, i.activity_code, i.kind, i.title, i.occurred_at, i.resolved_at,
               (i.occurred_at AT TIME ZONE p.timezone)::date AS local_day
        FROM sitemate.incidents i JOIN sitemate.projects p ON p.id=i.project_id
        WHERE i.project_id=:p AND (CAST(:i AS uuid) IS NULL OR i.id=CAST(:i AS uuid))
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
    out = []
    for r in rows:
        mine = [f for f in facts if f["incident_id"] == r["id"]]
        refs, seen = [], set()
        for f in mine:
            if (f["source_id"], f["locator"]) not in seen:
                seen.add((f["source_id"], f["locator"]))
                refs.append({"source_id": f["source_id"], "locator": f["locator"],
                             "passage_id": f"{f['source_id']}:{f['locator']}"})
        workers = [int(f["value"]["count"]) for f in mine if f["field_name"] == "workers_affected"]
        reported = mine[0]["available_at"] if mine else r["occurred_at"]
        equipment = conn.execute(text("""
            SELECT equipment_id FROM sitemate.equipment_assignments
            WHERE project_id=:p AND activity_code=:a AND work_date=:d
        """), {"p": project_id, "a": r["activity_code"], "d": r["local_day"]}).scalars().all()
        resolved = r["resolved_at"] if r["resolved_at"] and (as_of is None or r["resolved_at"] <= as_of) else None
        timeline = [{"kind": "reported" if n == 0 else "evidence", "at": f["available_at"],
                     "label": f"{f['source_id']} {f['locator']}", "refs": [
                         {"source_id": f["source_id"], "locator": f["locator"],
                          "passage_id": f"{f['source_id']}:{f['locator']}"}]}
                    for n, f in enumerate(mine)]
        out.append({"id": r["id"], "activity_code": r["activity_code"],
                    "type": "equipment_breakdown" if r["kind"] == "equipment_failure" else "other",
                    "title": r["title"], "occurred_at": r["occurred_at"], "reported_at": reported,
                    "resolved_at": resolved, "status": "resolved" if resolved else "open",
                    "affected_workers": max(workers) if workers else None,
                    "equipment_id": equipment[0] if len(equipment) == 1 else None,
                    "refs": refs, "timeline": timeline})
    return out


@app.get("/projects/{project_id}/incidents", dependencies=[Depends(check_member)])
def incidents(project_id: str, as_of: datetime | None = None, conn=Depends(connection)):
    check_cutoff(as_of)
    return incident_rows(conn, project_id, as_of)


@app.get("/projects/{project_id}/incidents/{incident_id}", dependencies=[Depends(check_member)])
def incident(project_id: str, incident_id: str, as_of: datetime | None = None, conn=Depends(connection)):
    check_cutoff(as_of)
    try:
        found = incident_rows(conn, project_id, as_of, incident_id)
    except SQLAlchemyError:
        raise HTTPException(404, "Incident not found at this time") from None
    if not found:
        raise HTTPException(404, "Incident not found at this time")
    return found[0]
