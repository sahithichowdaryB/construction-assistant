import hashlib
from datetime import date as WorkDate, datetime
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from database import engine_for

app = FastAPI(title="SiteMate API")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
                   allow_methods=["GET"], allow_headers=["Authorization"])
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
