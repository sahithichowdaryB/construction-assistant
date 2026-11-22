"""HTTP routes for appointments and daily report drafts (all under /projects/{project_id}).

    GET  /appointments?date=&as_of=                 member        the day's appointments
    POST /appointments                              contributor+  add one (manual, or a confirmed extraction proposal)
    POST /appointments/{id}/supersede               contributor+  edit, move or cancel (a new row; history kept)
    POST /appointments/extract                      manager       proposals from minutes, emails and action items
    GET  /daily-reports?from=&to=                   manager/appr  daily report drafts
    POST /daily-reports                             manager       draft (or redraft) a day's report now

A daily report is a draft like a notice: private to managers until submitted (POST /drafts/{id}/submit), approved
through POST /drafts/{id}/versions/{v}/review and exported with the stored-export routes.
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import text

import workflow as wf
from database import writer_engine
from deps import check_cutoff, check_member, connection, require_roles

from . import appointments as appt
from .draft import draft_daily_report

router = APIRouter(prefix="/projects/{project_id}", tags=["daily reports"])
KINDS = Literal["meeting", "inspection", "hold_point", "delivery", "visit", "deadline", "other"]


def _tz(conn, project_id):
    tz = conn.scalar(text("SELECT timezone FROM sitemate.projects WHERE id=:p"), {"p": project_id})
    if tz is None:
        raise HTTPException(404, "Unknown project")
    return ZoneInfo(tz)


def _day(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise HTTPException(422, "Dates are YYYY-MM-DD") from None


class AppointmentIn(BaseModel):
    kind: KINDS
    title: str = Field(min_length=1, max_length=300)
    starts_at: datetime
    ends_at: datetime | None = None
    location: str | None = Field(None, max_length=200)
    activity_code: str | None = Field(None, max_length=40)
    attendees: list[str] = Field(default_factory=list, max_length=30)
    status: Literal["planned", "held", "cancelled", "moved"] = "planned"
    source_id: str | None = Field(None, max_length=80)
    locator: str | None = Field(None, max_length=200)


def _check(conn, project_id, body: AppointmentIn, when):
    if body.starts_at.tzinfo is None or (body.ends_at and body.ends_at.tzinfo is None):
        raise HTTPException(422, "Times need a timezone (for example 2026-11-10T10:00:00+01:00)")
    if body.ends_at and body.ends_at < body.starts_at:
        raise HTTPException(422, "The end is before the start")
    if body.activity_code and not conn.scalar(text(
            "SELECT 1 FROM sitemate.activities WHERE project_id=:p AND code=:c"), {"p": project_id, "c": body.activity_code}):
        raise HTTPException(422, f"Unknown activity {body.activity_code}")
    if bool(body.source_id) != bool(body.locator):
        raise HTTPException(422, "A source needs both source_id and locator")
    if body.source_id:
        ok = conn.scalar(text("""SELECT 1 FROM sitemate.source_passages sp JOIN sitemate.sources s
            ON (s.project_id, s.id) = (sp.project_id, sp.source_id)
            WHERE sp.project_id=:p AND sp.source_id=:s AND sp.locator=:l AND s.available_at <= :at"""),
                         {"p": project_id, "s": body.source_id, "l": body.locator, "at": when})
        if not ok:
            raise HTTPException(422, "The cited passage is not available at this time")
    return {**body.model_dump(), "origin": "extracted" if body.source_id else "manual"}


def _view(a, tz):
    return {**a, "local_time": a["starts_at"].astimezone(tz).strftime("%H:%M")}


@router.get("/appointments", dependencies=[Depends(check_member)])
def list_appointments(project_id: str, date: str, as_of: datetime | None = None, conn=Depends(connection)):
    check_cutoff(as_of)
    tz = _tz(conn, project_id)
    return [_view(a, tz) for a in appt.current(conn, project_id, _day(date), tz, as_of)]


@router.post("/appointments", status_code=201)
def add_appointment(project_id: str, body: AppointmentIn, as_of: datetime | None = None,
                    member=Depends(require_roles("contributor", "manager"))):
    when = wf.stamp(as_of)
    with writer_engine().begin() as conn:
        item = _check(conn, project_id, body, when)
        new_id = appt.create(conn, project_id, item, member["member_id"], when)
        tz = _tz(conn, project_id)
        return next(_view(a, tz) for a in appt.current(conn, project_id, body.starts_at.astimezone(tz).date(), tz, when)
                    if a["id"] == new_id)


@router.post("/appointments/{appointment_id}/supersede", status_code=201)
def supersede_appointment(project_id: str, appointment_id: str, body: AppointmentIn, as_of: datetime | None = None,
                          member=Depends(require_roles("contributor", "manager"))):
    when = wf.stamp(as_of)
    with writer_engine().begin() as conn:
        item = _check(conn, project_id, body, when)
        try:
            new_id = appt.create(conn, project_id, item, member["member_id"], when, supersedes=wf._uuid(appointment_id))
        except LookupError as exc:
            raise HTTPException(409, str(exc)) from None
        return {"id": new_id, "supersedes": appointment_id}


class ExtractIn(BaseModel):
    date: str


@router.post("/appointments/extract")
def extract(project_id: str, body: ExtractIn, as_of: datetime | None = None, member=Depends(require_roles("manager")),
            conn=Depends(connection)):
    """Proposals only (nothing is saved): confirm one by POSTing it to /appointments."""
    check_cutoff(as_of)
    tz = _tz(conn, project_id)
    when = as_of or datetime.now(timezone.utc)
    return {"date": body.date, "proposals": appt.extract_proposals(conn, project_id, _day(body.date), tz, when)}


class DailyReportIn(BaseModel):
    work_date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")


@router.post("/daily-reports", status_code=201)
def draft_report(project_id: str, body: DailyReportIn, as_of: datetime | None = None,
                 member=Depends(require_roles("manager"))):
    """Draft the day's report now (P5 for the remarks; figures from code). Redrafting adds a version only when the
    content changed. Returns the draft view plus what the drafter did."""
    when = wf.stamp(as_of)
    day = _day(body.work_date)
    with writer_engine().begin() as conn:
        tz = _tz(conn, project_id)
        if day > when.astimezone(tz).date():
            raise HTTPException(422, "A report cannot be drafted for a day that has not started")
        result = draft_daily_report(conn, project_id, day, when, member_id=member["member_id"])
        view = wf._draft_view(conn, project_id, result["draft_id"], None)
        return {"draft": view, "changed": result["changed"], "remarks_source": result["remarks_source"],
                "dropped": result["dropped"], "missing": result["missing"]}


@router.get("/daily-reports", dependencies=[Depends(require_roles("manager", "approver"))])
def list_reports(project_id: str, from_: str | None = Query(None, alias="from"), to: str | None = None,
                 as_of: datetime | None = None,
                 conn=Depends(connection)):
    check_cutoff(as_of)
    ids = conn.execute(text("""SELECT id::text FROM sitemate.drafts WHERE project_id=:p AND notice_type='daily_report'
        AND (CAST(:a AS date) IS NULL OR work_date >= CAST(:a AS date))
        AND (CAST(:b AS date) IS NULL OR work_date <= CAST(:b AS date)) ORDER BY work_date DESC"""),
                       {"p": project_id, "a": from_, "b": to}).scalars().all()
    return [v for v in (wf._draft_view(conn, project_id, i, as_of) for i in ids) if v]
