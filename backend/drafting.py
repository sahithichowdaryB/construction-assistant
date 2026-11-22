"""Draft lifecycle actions shared by every notice type (delay, additional cost, defect, concern, incident, email,
daily report). Routes under /projects/{project_id}:

    POST /drafts/{id}/versions/{v}/gaps     fill a [MISSING: ...] field, or omit it with a reason where the template
                                            permits; creates version v+1 and an immutable draft_gap_resolutions row
    POST /drafts/{id}/submit                send a private draft (Write with SiteMate, auto-drafted, daily report)
                                            to the approver's queue
    POST /drafts/{id}/versions/{v}/exports  render the approved version once (PDF, Word or .eml), store the file and
                                            record it in exports; repeating returns the same file and SHA-256

Rendering for export uses notice_templates.render_final: the approved wording without the draft marker and without
internal notes. Nothing is ever sent by SiteMate.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import text

import workflow as wf
from database import writer_engine
from documents import storage
from documents.notice_export import pdf_letter, word_letter
from deps import require_roles
from notice_templates import fill_gap, missing_fields, omit_gap, render_final

router = APIRouter(prefix="/projects/{project_id}", tags=["drafting"])
MIME = {"pdf": "application/pdf", "eml": "message/rfc822",
        "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}


# ------------------------------------------------------------------ gaps

class GapIn(BaseModel):
    field: str = Field(min_length=1, max_length=200)
    resolution: Literal["filled", "omitted"]
    value: str | None = Field(None, max_length=2000)
    reason: str | None = Field(None, max_length=1000)


def resolve_gap(conn, project_id, draft_id, version, body: GapIn, member, when) -> dict:
    wf._lock_notice(conn, draft_id)
    view = wf._draft_view(conn, project_id, wf._uuid(draft_id), None)
    if view is None:
        raise HTTPException(404, "Draft not found")
    latest = view["latest"]
    if version != latest["version"]:
        raise HTTPException(409, f"Version {version} is not the latest (v{latest['version']}). Reload the draft.")
    field = body.field.strip()
    if field not in latest["missing_fields"]:
        raise HTTPException(422, f"“{field}” is not missing in this version")
    if body.resolution == "filled":
        value = (body.value or "").strip()
        if not value:
            raise HTTPException(422, "Give the value to fill in")
        new_body, reason = fill_gap(latest["body"], field, value), None
    else:
        if field not in view["omittable_fields"]:
            raise HTTPException(422, f"“{field}” cannot be left out of a {view['kind_label'].lower()}; fill it in instead")
        reason = (body.reason or "").strip()
        if not reason:
            raise HTTPException(422, "Say why this field is left out")
        new_body, value = omit_gap(latest["body"], field), None
    nxt = latest["version"] + 1
    conn.execute(text("""
        INSERT INTO sitemate.draft_versions (project_id, draft_id, version, as_of, body, evidence_refs, missing_fields,
                                             alert_id, alert_version)
        SELECT project_id, draft_id, :v, greatest(:at, as_of), :b, evidence_refs, CAST(:m AS jsonb), alert_id, alert_version
        FROM sitemate.draft_versions WHERE project_id = :p AND draft_id = CAST(:d AS uuid) AND version = :prev
    """), {"p": project_id, "d": draft_id, "v": nxt, "prev": latest["version"], "at": when, "b": new_body,
           "m": json.dumps(missing_fields(new_body))})
    conn.execute(text("""
        INSERT INTO sitemate.draft_gap_resolutions (project_id, draft_id, version, field, resolution, value, reason,
                                                    decided_by, decided_at)
        SELECT :p, CAST(:d AS uuid), :v, :f, :r, :val, :why, :m, as_of FROM sitemate.draft_versions
        WHERE project_id = :p AND draft_id = CAST(:d AS uuid) AND version = :v
    """), {"p": project_id, "d": draft_id, "v": nxt, "f": field, "r": body.resolution, "val": value, "why": reason,
           "m": member["member_id"]})
    return wf._draft_view(conn, project_id, draft_id, None)


@router.post("/drafts/{draft_id}/versions/{version}/gaps", status_code=201)
def gap(project_id: str, draft_id: str, version: int, body: GapIn, as_of: datetime | None = None,
        member=Depends(require_roles("manager"))):
    when = wf.stamp(as_of)
    with writer_engine().begin() as conn:
        return resolve_gap(conn, project_id, draft_id, version, body, member, when)


# ------------------------------------------------------------------ submit

class SubmitIn(BaseModel):
    expected_version: int | None = Field(None, ge=1)


@router.post("/drafts/{draft_id}/submit")
def submit(project_id: str, draft_id: str, body: SubmitIn | None = None, as_of: datetime | None = None,
           member=Depends(require_roles("manager"))):
    """Send a private draft to the approver's queue. Until then only managers see it."""
    when = wf.stamp(as_of)
    with writer_engine().begin() as conn:
        wf._lock_notice(conn, draft_id)
        view = wf._draft_view(conn, project_id, wf._uuid(draft_id), None)
        if view is None:
            raise HTTPException(404, "Draft not found")
        if body and body.expected_version and body.expected_version != view["latest"]["version"]:
            raise HTTPException(409, "A newer version is available. Review it before sending it for approval.")
        if view["submitted_at"] is not None or view["status"] != "draft":
            raise HTTPException(409, "This draft was already sent for approval")
        conn.execute(text("UPDATE sitemate.drafts SET submitted_at = greatest(:at, :floor) "
                          "WHERE project_id = :p AND id = CAST(:d AS uuid)"),
                     {"at": when, "floor": view["latest"]["as_of"], "p": project_id, "d": draft_id})
        return wf._draft_view(conn, project_id, draft_id, None)


# ------------------------------------------------------------------ exports

def _render(fmt: str, body: str, sender: str | None, decided_at) -> bytes:
    final = render_final(body)
    if fmt == "pdf":
        return pdf_letter(final)
    if fmt == "docx":
        return word_letter(final)
    from correspondence import email_file
    return email_file(final, sender, decided_at)


def export_version(conn, project_id: str, draft_id: str, version: int, fmt: str, member: dict | None) -> dict:
    """The stored export of an approved version, created on the first request. Returns
    {format, sha256, bytes, filename, data, created}."""
    wf._uuid(draft_id)
    wf._lock_notice(conn, f"export:{draft_id}:{version}:{fmt}")
    row = conn.execute(text("""
        SELECT v.body, r.decision, r.decided_at, d.notice_type, p.sender FROM sitemate.draft_versions v
        JOIN sitemate.drafts d ON (d.project_id, d.id) = (v.project_id, v.draft_id)
        JOIN sitemate.projects p ON p.id = v.project_id
        LEFT JOIN sitemate.reviews r ON (r.project_id, r.draft_id, r.version) = (v.project_id, v.draft_id, v.version)
        WHERE v.project_id=:p AND v.draft_id=CAST(:d AS uuid) AND v.version=:v
    """), {"p": project_id, "d": draft_id, "v": version}).mappings().one_or_none()
    if row is None:
        raise HTTPException(404, "Notice version not found")
    if row["decision"] != "approved":
        raise HTTPException(409, "Approve this version before exporting it")
    name = "daily-report" if row["notice_type"] == "daily_report" else "email" if row["notice_type"] == "email" else "notice"
    filename = f"{name}-{draft_id}-v{version}.{fmt}"
    stored = conn.execute(text("""SELECT storage_key, sha256, bytes, filename FROM sitemate.exports
        WHERE project_id=:p AND draft_id=CAST(:d AS uuid) AND version=:v AND format=:f"""),
                          {"p": project_id, "d": draft_id, "v": version, "f": fmt}).mappings().one_or_none()
    if stored:
        path = storage.resolve(project_id, stored["storage_key"])
        if path is not None:
            data = path.read_bytes()
            if hashlib.sha256(data).hexdigest() == stored["sha256"]:
                return {"format": fmt, "sha256": stored["sha256"], "bytes": len(data),
                        "filename": stored["filename"] or filename, "data": data, "created": False}
        raise HTTPException(500, "The stored export is missing or changed on disk; it was not served")
    data = _render(fmt, row["body"], row["sender"], row["decided_at"])
    key, digest = storage.save_upload(project_id, data, f".{fmt}")
    conn.execute(text("""
        INSERT INTO sitemate.exports (project_id, draft_id, version, format, storage_key, sha256, created_by, bytes, filename)
        VALUES (:p, CAST(:d AS uuid), :v, :f, :k, :h, :m, :n, :fn)"""),
                 {"p": project_id, "d": draft_id, "v": version, "f": fmt, "k": key, "h": digest,
                  "m": (member or {}).get("member_id"), "n": len(data), "fn": filename})
    return {"format": fmt, "sha256": digest, "bytes": len(data), "filename": filename, "data": data, "created": True}


class ExportIn(BaseModel):
    format: Literal["pdf", "docx", "eml"]


@router.post("/drafts/{draft_id}/versions/{version}/exports", status_code=201)
def create_export(project_id: str, draft_id: str, version: int, body: ExportIn,
                  member=Depends(require_roles("manager", "approver"))):
    with writer_engine().begin() as conn:
        out = export_version(conn, project_id, draft_id, version, body.format, member)
    return {k: v for k, v in out.items() if k != "data"} | {
        "download_url": f"/projects/{project_id}/drafts/{draft_id}/versions/{version}/export?format={body.format}"}


def download(project_id: str, draft_id: str, version: int, fmt: str, member: dict) -> Response:
    """GET .../export: the stored file (created on first download), with its SHA-256 in a header."""
    with writer_engine().begin() as conn:
        out = export_version(conn, project_id, draft_id, version, fmt, member)
    return Response(out["data"], media_type=MIME[fmt], headers={
        "Content-Disposition": f'attachment; filename="{out["filename"]}"', "Cache-Control": "private, no-store",
        "X-Content-SHA256": out["sha256"]})
