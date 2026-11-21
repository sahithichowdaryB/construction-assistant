"""Manager actions over incidents, alerts and recommended actions (runs as sitemate_ops; the reader stays read-only).

Every alert transition writes sitemate.alert_activity, so the Alerts page can show who did what and why."""

import json
import os
import uuid
from datetime import datetime
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import text

from auth import check_member, connection, current_manager, current_member, ops_connection

router = APIRouter()
IMAGE_ROOT = Path(os.environ.get("AGENT_IMAGE_DIR", "storage/images"))
if not IMAGE_ROOT.is_absolute():
    IMAGE_ROOT = Path(__file__).resolve().parent / IMAGE_ROOT
SEVERITIES = ["low", "medium", "high", "critical"]
PRIORITIES = ("low", "medium", "high", "urgent")


def _uuid(value: str, what: str):
    try:
        uuid.UUID(value)
    except ValueError:
        raise HTTPException(404, f"{what} not found") from None


def _alert(conn, project_id, alert_id, lock=True):
    _uuid(alert_id, "Alert")
    row = conn.execute(text(f"""
        SELECT id::text AS id, status, kind, incident_id::text AS incident_id, assigned_to, title, activity_code
        FROM sitemate.alerts WHERE project_id=:p AND id=CAST(:a AS uuid) {'FOR UPDATE' if lock else ''}
    """), {"p": project_id, "a": alert_id}).mappings().one_or_none()
    if row is None:
        raise HTTPException(404, "Alert not found")
    return dict(row)


def _log(conn, project_id, alert_id, actor, action, from_status=None, to_status=None, note=None):
    conn.execute(text("""
        INSERT INTO sitemate.alert_activity (project_id, alert_id, actor, action, from_status, to_status, note)
        VALUES (:p, CAST(:a AS uuid), :actor, :action, :f, :t, :n)"""),
                 {"p": project_id, "a": alert_id, "actor": actor, "action": action, "f": from_status, "t": to_status, "n": note})


# ---------------------------------------------------------------- alerts ---------------------------------------

class AlertBody(BaseModel):
    note: str | None = Field(None, max_length=1000)
    assignee: str | None = Field(None, max_length=100)
    resolve_incident: bool = False


TRANSITIONS = {  # action -> (allowed from, to)
    "ack": ({"open"}, "acknowledged"),
    "assign": ({"open", "acknowledged", "in_progress"}, "in_progress"),
    "dismiss": ({"open", "acknowledged", "in_progress"}, "dismissed"),
    "resolve": ({"open", "acknowledged", "in_progress"}, "resolved"),
    "reopen": ({"resolved", "dismissed"}, "open"),
}


@router.post("/projects/{project_id}/alerts/{alert_id}/{action}")
def alert_transition(project_id: str, alert_id: str, action: Literal["ack", "assign", "dismiss", "resolve", "reopen"],
                     body: AlertBody | None = None, member=Depends(current_manager), conn=Depends(ops_connection)):
    body = body or AlertBody()
    alert = _alert(conn, project_id, alert_id)
    allowed, to = TRANSITIONS[action]
    if alert["status"] not in allowed:
        raise HTTPException(409, f"Cannot {action} an alert that is {alert['status']}")
    if action == "dismiss" and not (body.note or "").strip():
        raise HTTPException(422, "A reason is required to dismiss an alert")
    if action == "assign" and not (body.assignee or "").strip():
        raise HTTPException(422, "Choose who to assign the alert to")
    me = member["member_id"]
    params = {"p": project_id, "a": alert_id, "me": me}
    if action == "ack":
        conn.execute(text("""UPDATE sitemate.alerts SET status='acknowledged', acknowledged_by=:me, acknowledged_at=now()
                             WHERE project_id=:p AND id=CAST(:a AS uuid)"""), params)
    elif action == "assign":
        conn.execute(text("""UPDATE sitemate.alerts SET status='in_progress', assigned_to=:who
                             WHERE project_id=:p AND id=CAST(:a AS uuid)"""), {**params, "who": body.assignee.strip()})
    elif action == "resolve":
        conn.execute(text("""UPDATE sitemate.alerts SET status='resolved', resolved_by=:me, resolved_at=now()
                             WHERE project_id=:p AND id=CAST(:a AS uuid)"""), params)
        if body.resolve_incident and alert["incident_id"]:
            _set_incident_status(conn, project_id, alert["incident_id"], "resolved", me, sync_alert=False)
    else:  # dismiss | reopen
        conn.execute(text("UPDATE sitemate.alerts SET status=:s WHERE project_id=:p AND id=CAST(:a AS uuid)"),
                     {**params, "s": to})
        if action == "reopen" and alert["incident_id"]:
            _set_incident_status(conn, project_id, alert["incident_id"], "open", me, sync_alert=False)
    note = body.note or (f"Assigned to {body.assignee}" if action == "assign" else None)
    _log(conn, project_id, alert_id, me, action, alert["status"], to, note)
    conn.commit()
    return {"id": alert_id, "status": to}


@router.get("/projects/{project_id}/alerts/{alert_id}", dependencies=[Depends(check_member)])
def alert_detail(project_id: str, alert_id: str, conn=Depends(connection)):
    alert = _alert(conn, project_id, alert_id, lock=False)
    p = {"p": project_id, "a": alert_id}
    revisions = [dict(r) for r in conn.execute(text("""
        SELECT version, as_of, severity, calculation, evidence_refs, reason, analysis_id::text AS analysis_id
        FROM sitemate.alert_revisions WHERE project_id=:p AND alert_id=CAST(:a AS uuid) ORDER BY version DESC"""), p).mappings()]
    activity = [dict(r) for r in conn.execute(text("""
        SELECT id::text AS id, actor, action, from_status, to_status, note, at
        FROM sitemate.alert_activity WHERE project_id=:p AND alert_id=CAST(:a AS uuid) ORDER BY at DESC"""), p).mappings()]
    incident = analysis = None
    if alert["incident_id"]:
        incident = conn.execute(text("""
            SELECT id::text AS id, category, event_type, summary, zone, asset_key, status, severity, report_count,
                   reporter_count, first_reported_at, last_reported_at
            FROM sitemate.incidents WHERE project_id=:p AND id=CAST(:i AS uuid)"""),
                                {"p": project_id, "i": alert["incident_id"]}).mappings().one_or_none()
        incident = dict(incident) if incident else None
        row = conn.execute(text("""
            SELECT id::text AS id, version, as_of, status, confidence, headline_cause, reasoning, gaps
            FROM sitemate.incident_analyses WHERE project_id=:p AND incident_id=CAST(:i AS uuid)
            ORDER BY version DESC LIMIT 1"""), {"p": project_id, "i": alert["incident_id"]}).mappings().one_or_none()
        if row:
            analysis = {**row, "confidence": float(row["confidence"])}
    return {**alert, "incident": incident, "analysis": analysis, "revisions": revisions, "activity": activity,
            "actions": _actions(conn, project_id, alert_id)}


# --------------------------------------------------------------- actions ---------------------------------------

def _actions(conn, project_id, alert_id):
    return [dict(r) for r in conn.execute(text("""
        SELECT id::text AS id, action_type, title, rationale, owner_role, contractor_id, priority, due_at, status,
               proposed_by, decided_by, decided_at, executed_at, result, evidence_refs, analysis_id::text AS analysis_id,
               incident_id::text AS incident_id, created_at
        FROM sitemate.action_items
        WHERE project_id=:p AND alert_id=CAST(:a AS uuid) AND status <> 'superseded'
        ORDER BY CASE status WHEN 'proposed' THEN 0 WHEN 'approved' THEN 1 WHEN 'in_progress' THEN 1 ELSE 2 END,
                 created_at, id"""), {"p": project_id, "a": alert_id}).mappings()]


@router.get("/projects/{project_id}/alerts/{alert_id}/actions", dependencies=[Depends(check_member)])
def list_actions(project_id: str, alert_id: str, conn=Depends(connection)):
    _alert(conn, project_id, alert_id, lock=False)
    return _actions(conn, project_id, alert_id)


def _action(conn, project_id, alert_id, action_id):
    _uuid(action_id, "Action")
    row = conn.execute(text("""
        SELECT id::text AS id, action_type, title, status, owner_role, contractor_id, incident_id::text AS incident_id
        FROM sitemate.action_items WHERE project_id=:p AND id=CAST(:x AS uuid) AND alert_id=CAST(:a AS uuid)
        FOR UPDATE"""), {"p": project_id, "x": action_id, "a": alert_id}).mappings().one_or_none()
    if row is None:
        raise HTTPException(404, "Action not found")
    return dict(row)


class ApproveBody(BaseModel):
    assignee: str | None = Field(None, max_length=100)


@router.post("/projects/{project_id}/alerts/{alert_id}/actions/{action_id}/{decision}")
def decide_action(project_id: str, alert_id: str, action_id: str, decision: Literal["approve", "reject", "complete"],
                  body: ApproveBody | None = None, member=Depends(current_manager), conn=Depends(ops_connection)):
    alert = _alert(conn, project_id, alert_id)
    action = _action(conn, project_id, alert_id, action_id)
    me, p = member["member_id"], {"p": project_id, "x": action_id}
    if decision == "reject":
        if action["status"] not in ("proposed", "approved", "in_progress"):
            raise HTTPException(409, f"Cannot reject an action that is {action['status']}")
        conn.execute(text("""UPDATE sitemate.action_items SET status='rejected', decided_by=:me, decided_at=now()
                             WHERE project_id=:p AND id=CAST(:x AS uuid)"""), {**p, "me": me})
        _log(conn, project_id, alert_id, me, "action_rejected", note=action["title"])
        result_status = "rejected"
    elif decision == "complete":
        if action["status"] not in ("approved", "in_progress"):
            raise HTTPException(409, "Only an approved action can be marked done")
        conn.execute(text("""UPDATE sitemate.action_items SET status='done', executed_at=now()
                             WHERE project_id=:p AND id=CAST(:x AS uuid)"""), p)
        _log(conn, project_id, alert_id, me, "action_done", note=action["title"])
        result_status = "done"
    else:
        if action["status"] != "proposed":
            raise HTTPException(409, f"Cannot approve an action that is {action['status']}")
        result_status, result = _execute(conn, project_id, alert, action, me, body or ApproveBody())
        conn.execute(text("""UPDATE sitemate.action_items SET status=:s, decided_by=:me, decided_at=now(),
                                 executed_at=CASE WHEN :s='done' THEN now() END, result=CAST(:r AS jsonb)
                             WHERE project_id=:p AND id=CAST(:x AS uuid)"""),
                     {**p, "me": me, "s": result_status, "r": json.dumps(result)})
        _log(conn, project_id, alert_id, me, "action_approved", note=action["title"])
    conn.commit()
    return {"id": action_id, "status": result_status, **({"result": result} if decision == "approve" else {})}


def _execute(conn, project_id, alert, action, actor, body):
    """Side effects of approving an action. Only these types do anything beyond being recorded and tracked."""
    kind = action["action_type"]
    if kind == "assign_owner":
        who = (body.assignee or action["owner_role"] or "").strip()
        if not who:
            raise HTTPException(422, "Choose who to assign the alert to")
        conn.execute(text("""UPDATE sitemate.alerts SET assigned_to=:w,
                                 status=CASE WHEN status IN ('open','acknowledged') THEN 'in_progress' ELSE status END
                             WHERE project_id=:p AND id=CAST(:a AS uuid)"""), {"p": project_id, "a": alert["id"], "w": who})
        return "done", {"assigned_to": who}
    if kind == "resolve_incident":
        if action["incident_id"]:
            _set_incident_status(conn, project_id, action["incident_id"], "resolved", actor, sync_alert=True)
        return "done", {"incident_status": "resolved"}
    if kind == "draft_notice":  # the web app opens the drafts flow pre-filled with these ids
        return "approved", {"next": "draft", "incident_id": action["incident_id"], "alert_id": alert["id"]}
    if kind == "request_evidence":  # shows on the Capture page for the owner role until someone marks it done
        return "in_progress", {"capture_prompt": True, "for_role": action["owner_role"]}
    if kind == "notify_contractor":
        name = conn.scalar(text("SELECT name FROM sitemate.contractors WHERE project_id=:p AND id=:c"),
                           {"p": project_id, "c": action["contractor_id"]}) if action["contractor_id"] else None
        return "approved", {"notified": name, "sent": False, "note": "Recorded only; sending messages is not automated."}
    return "approved", {"logged": True}


class ActionPatch(BaseModel):
    title: str | None = Field(None, min_length=3, max_length=200)
    rationale: str | None = Field(None, max_length=2000)
    owner_role: str | None = Field(None, max_length=60)
    contractor_id: str | None = Field(None, max_length=60)
    priority: Literal["low", "medium", "high", "urgent"] | None = None
    due_at: datetime | None = None


@router.patch("/projects/{project_id}/alerts/{alert_id}/actions/{action_id}")
def edit_action(project_id: str, alert_id: str, action_id: str, body: ActionPatch,
                member=Depends(current_manager), conn=Depends(ops_connection)):
    _alert(conn, project_id, alert_id)
    action = _action(conn, project_id, alert_id, action_id)
    if action["status"] not in ("proposed", "approved"):
        raise HTTPException(409, f"Cannot edit an action that is {action['status']}")
    changes = body.model_dump(exclude_unset=True)
    if changes.get("contractor_id") and not conn.scalar(
            text("SELECT 1 FROM sitemate.contractors WHERE project_id=:p AND id=:c"),
            {"p": project_id, "c": changes["contractor_id"]}):
        raise HTTPException(422, "Unknown contractor")
    if not changes:
        return {"id": action_id}
    sets = ", ".join(f"{k}=:{k}" for k in changes)
    conn.execute(text(f"UPDATE sitemate.action_items SET {sets} WHERE project_id=:p AND id=CAST(:x AS uuid)"),
                 {**changes, "p": project_id, "x": action_id})  # keys come from the pydantic model, never from the client
    _log(conn, project_id, alert_id, member["member_id"], "action_edited", note=", ".join(changes))
    conn.commit()
    return {"id": action_id, **changes}


@router.get("/projects/{project_id}/capture-prompts")
def capture_prompts(project_id: str, member=Depends(current_member), conn=Depends(connection)):
    """Evidence requests approved for the caller's role; the Capture page shows them as 'please record…' prompts."""
    roles = {"contributor": ("foreman",), "manager": ("site_manager", "foreman"), "approver": ("approver", "site_manager")}
    rows = conn.execute(text("""
        SELECT a.id::text AS id, a.title, a.rationale, a.owner_role, a.incident_id::text AS incident_id,
               i.summary AS incident_title, a.decided_at
        FROM sitemate.action_items a LEFT JOIN sitemate.incidents i ON (i.project_id,i.id)=(a.project_id,a.incident_id)
        WHERE a.project_id=:p AND a.action_type='request_evidence' AND a.status IN ('approved','in_progress')
          AND (a.owner_role IS NULL OR a.owner_role = ANY(:roles))
        ORDER BY a.decided_at DESC"""), {"p": project_id, "roles": list(roles.get(member["role"], ()))}).mappings()
    return [dict(r) for r in rows]


# -------------------------------------------------------------- incidents ---------------------------------------

def _set_incident_status(conn, project_id, incident_id, status, actor, sync_alert=True):
    _uuid(incident_id, "Incident")
    row = conn.execute(text("""
        UPDATE sitemate.incidents SET status=:s,
            resolved_at=CASE WHEN :s IN ('resolved','closed') THEN GREATEST(now(), occurred_at) ELSE NULL END
        WHERE project_id=:p AND id=CAST(:i AS uuid) AND merged_into_id IS NULL RETURNING id"""),
                       {"p": project_id, "i": incident_id, "s": status}).one_or_none()
    if row is None:
        raise HTTPException(404, "Incident not found")
    if not sync_alert:
        return
    alert = conn.execute(text("""
        SELECT id::text AS id, status FROM sitemate.alerts
        WHERE project_id=:p AND incident_id=CAST(:i AS uuid) AND kind='incident' FOR UPDATE"""),
                         {"p": project_id, "i": incident_id}).mappings().one_or_none()
    if not alert:
        return
    if status in ("resolved", "closed"):
        target = "resolved" if alert["status"] not in ("resolved", "dismissed") else None
    elif status == "open":
        target = "open" if alert["status"] in ("resolved", "dismissed") else None
    else:
        target = None
    if target:
        conn.execute(text("""UPDATE sitemate.alerts SET status=:t,
                                 resolved_by=CASE WHEN :t='resolved' THEN :me END, resolved_at=CASE WHEN :t='resolved' THEN now() END
                             WHERE project_id=:p AND id=CAST(:a AS uuid)"""),
                     {"p": project_id, "a": alert["id"], "t": target, "me": actor})
        _log(conn, project_id, alert["id"], actor, "resolve" if target == "resolved" else "reopen", alert["status"], target,
             f"Incident marked {status}")


class IncidentPatch(BaseModel):
    status: Literal["open", "monitoring", "resolved", "closed"]


@router.patch("/projects/{project_id}/incidents/{incident_id}")
def patch_incident(project_id: str, incident_id: str, body: IncidentPatch, member=Depends(current_manager),
                   conn=Depends(ops_connection)):
    _set_incident_status(conn, project_id, incident_id, body.status, member["member_id"])
    conn.commit()
    return {"id": incident_id, "status": body.status}


@router.get("/projects/{project_id}/incidents/{incident_id}/events", dependencies=[Depends(check_member)])
def incident_events(project_id: str, incident_id: str, conn=Depends(connection)):
    """The sources of an incident: each linked event with who reported it, when, how it was linked, and any photos."""
    _uuid(incident_id, "Incident")
    rows = conn.execute(text("""
        SELECT e.id::text AS id, e.summary, e.category, e.event_type, e.zone, e.recorded_by, e.occurred_at, e.recorded_at,
               e.source_id, e.locator, e.suggested_category, e.suggestion_confidence, e.suggestion_rationale,
               ie.link_type, ie.match_score, ie.match_reason, ie.linked_by, ie.linked_at, ie.unlinked_at,
               c.channel, c.id::text AS capture_id
        FROM sitemate.incident_events ie
        JOIN sitemate.events e ON (e.project_id,e.id)=(ie.project_id,ie.event_id)
        JOIN sitemate.captures c ON (c.project_id,c.id)=(e.project_id,e.capture_id)
        WHERE ie.project_id=:p AND ie.incident_id=CAST(:i AS uuid) ORDER BY e.recorded_at, (ie.link_type <> 'origin'), e.id"""),
                        {"p": project_id, "i": incident_id}).mappings().all()
    attachments = conn.execute(text("""
        SELECT id::text AS id, capture_id::text AS capture_id, kind, mime, passage_locator
        FROM sitemate.capture_attachments WHERE project_id=:p AND capture_id = ANY(CAST(:caps AS uuid[]))"""),
                               {"p": project_id, "caps": list({r["capture_id"] for r in rows})}).mappings().all()
    return [{**dict(r), "suggestion_confidence": float(r["suggestion_confidence"]) if r["suggestion_confidence"] is not None else None,
             "match_score": float(r["match_score"]) if r["match_score"] is not None else None,
             "attachments": [{"id": a["id"], "kind": a["kind"], "mime": a["mime"],
                              "url": f"/projects/{project_id}/attachments/{a['id']}"}
                             for a in attachments if a["capture_id"] == r["capture_id"] and a["kind"] == "image"]}
            for r in rows]


@router.get("/projects/{project_id}/attachments/{attachment_id}", dependencies=[Depends(check_member)])
def attachment(project_id: str, attachment_id: str, conn=Depends(connection)):
    _uuid(attachment_id, "Attachment")
    row = conn.execute(text("""
        SELECT storage_key, mime, kind FROM sitemate.capture_attachments
        WHERE project_id=:p AND id=CAST(:a AS uuid)"""), {"p": project_id, "a": attachment_id}).mappings().one_or_none()
    if row is None or row["kind"] != "image":
        raise HTTPException(404, "Attachment not found")
    path = (IMAGE_ROOT / row["storage_key"]).resolve()
    if not path.is_relative_to(IMAGE_ROOT.resolve()) or not path.is_file():
        raise HTTPException(404, "Attachment file unavailable")
    return FileResponse(path, media_type=row["mime"])


def _refresh_counts(conn, project_id, incident_id):
    conn.execute(text("""
        UPDATE sitemate.incidents i SET
            report_count = GREATEST(s.reports, 1), reporter_count = GREATEST(s.reporters, 1)
        FROM (SELECT count(*) FILTER (WHERE ie.link_type IN ('origin','corroborating'))::int AS reports,
                     count(DISTINCT e.recorded_by) FILTER (WHERE ie.link_type IN ('origin','corroborating'))::int AS reporters
              FROM sitemate.incident_events ie JOIN sitemate.events e ON (e.project_id,e.id)=(ie.project_id,ie.event_id)
              WHERE ie.project_id=:p AND ie.incident_id=CAST(:i AS uuid) AND ie.unlinked_at IS NULL) s
        WHERE i.project_id=:p AND i.id=CAST(:i AS uuid)"""), {"p": project_id, "i": incident_id})


def _revision(conn, project_id, incident_id, reason):
    """New alert revision (same severity) after a manual correction, so the history shows why counts changed."""
    alert = conn.execute(text("""SELECT id::text AS id FROM sitemate.alerts
                                 WHERE project_id=:p AND incident_id=CAST(:i AS uuid) AND kind='incident'"""),
                         {"p": project_id, "i": incident_id}).mappings().one_or_none()
    if alert is None:
        return
    conn.execute(text("""
        INSERT INTO sitemate.alert_revisions (project_id, alert_id, version, as_of, severity, calculation, evidence_refs, reason)
        SELECT :p, CAST(:a AS uuid), r.version + 1, now(), r.severity, r.calculation,
               coalesce((SELECT jsonb_agg(DISTINCT jsonb_build_object('source_id', e.source_id, 'locator', e.locator,
                         'passage_id', e.source_id || ':' || e.locator))
                         FROM sitemate.incident_events ie JOIN sitemate.events e ON (e.project_id,e.id)=(ie.project_id,ie.event_id)
                         WHERE ie.project_id=:p AND ie.incident_id=CAST(:i AS uuid) AND ie.unlinked_at IS NULL), '[]'::jsonb),
               :reason
        FROM sitemate.alert_revisions r WHERE r.project_id=:p AND r.alert_id=CAST(:a AS uuid)
        ORDER BY r.version DESC LIMIT 1"""), {"p": project_id, "a": alert["id"], "i": incident_id, "reason": reason})


def _requeue(conn, project_id, incident_id):
    conn.execute(text("""
        INSERT INTO sitemate.agent_jobs (project_id, kind, incident_id, run_after)
        VALUES (:p, 'reasoning', CAST(:i AS uuid), now() + interval '60 seconds')
        ON CONFLICT (project_id, kind, incident_id) WHERE status='queued' DO UPDATE SET run_after = EXCLUDED.run_after"""),
                 {"p": project_id, "i": incident_id})


class UnlinkBody(BaseModel):
    make_new_incident: bool = False
    note: str | None = Field(None, max_length=500)


@router.post("/projects/{project_id}/incidents/{incident_id}/events/{event_id}/unlink")
def unlink_event(project_id: str, incident_id: str, event_id: str, body: UnlinkBody | None = None,
                 member=Depends(current_manager), conn=Depends(ops_connection)):
    """Detach a wrongly grouped report. The unlinked event is remembered so the correlation agent won't re-link it."""
    body = body or UnlinkBody()
    _uuid(incident_id, "Incident")
    _uuid(event_id, "Event")
    updated = conn.execute(text("""
        UPDATE sitemate.incident_events SET unlinked_at=now(), linked_by=:me
        WHERE project_id=:p AND incident_id=CAST(:i AS uuid) AND event_id=CAST(:e AS uuid) AND unlinked_at IS NULL
          AND link_type <> 'origin' RETURNING link_type"""),
                           {"p": project_id, "i": incident_id, "e": event_id, "me": member["member_id"]}).one_or_none()
    if updated is None:
        raise HTTPException(409, "That event is not linked here, or it is the origin report (merge or close the incident instead)")
    conn.execute(text("UPDATE sitemate.events SET incident_id=NULL WHERE project_id=:p AND id=CAST(:e AS uuid)"),
                 {"p": project_id, "e": event_id})
    _refresh_counts(conn, project_id, incident_id)
    _revision(conn, project_id, incident_id, f"Report unlinked by {member['member_id']}")
    new_id = None
    if body.make_new_incident:
        new_id = str(uuid.uuid4())
        conn.execute(text("""
            INSERT INTO sitemate.incidents (project_id,id,activity_code,kind,title,occurred_at,category,event_type,summary,zone,
                asset_key,status,severity,severity_version,first_reported_at,last_reported_at,report_count,reporter_count,cluster_key)
            SELECT e.project_id, CAST(:n AS uuid), e.activity_code, e.event_type, e.summary, e.occurred_at, e.category, e.event_type,
                   e.summary, e.zone, e.asset_key, 'open', old.severity, 0, e.recorded_at, e.recorded_at, 1, 1, :key
            FROM sitemate.events e JOIN sitemate.incidents old ON (old.project_id,old.id)=(e.project_id,CAST(:i AS uuid))
            WHERE e.project_id=:p AND e.id=CAST(:e AS uuid)"""),
                     {"p": project_id, "n": new_id, "e": event_id, "i": incident_id, "key": f"manual:{new_id}"})
        conn.execute(text("""
            INSERT INTO sitemate.incident_events (project_id, incident_id, event_id, link_type, match_reason, linked_by)
            VALUES (:p, CAST(:n AS uuid), CAST(:e AS uuid), 'origin', 'split from another incident', :me)"""),
                     {"p": project_id, "n": new_id, "e": event_id, "me": member["member_id"]})
        conn.execute(text("UPDATE sitemate.events SET incident_id=CAST(:n AS uuid) WHERE project_id=:p AND id=CAST(:e AS uuid)"),
                     {"p": project_id, "n": new_id, "e": event_id})
        conn.execute(text("""
            INSERT INTO sitemate.alerts (project_id, activity_code, checkpoint_at, kind, status, incident_id, title)
            SELECT project_id, activity_code, first_reported_at, 'incident', 'open', id, summary
            FROM sitemate.incidents WHERE project_id=:p AND id=CAST(:n AS uuid)"""), {"p": project_id, "n": new_id})
        conn.execute(text("""
            INSERT INTO sitemate.alert_revisions (project_id, alert_id, version, as_of, severity, calculation, evidence_refs, reason)
            SELECT a.project_id, a.id, 1, now(), coalesce(i.severity,'medium'), '{"kind":"incident"}'::jsonb,
                   jsonb_build_array(jsonb_build_object('source_id', e.source_id, 'locator', e.locator,
                                                        'passage_id', e.source_id || ':' || e.locator)),
                   'Split from another incident'
            FROM sitemate.alerts a JOIN sitemate.incidents i ON (i.project_id,i.id)=(a.project_id,a.incident_id)
            JOIN sitemate.events e ON (e.project_id,e.id)=(i.project_id,CAST(:e AS uuid))
            WHERE a.project_id=:p AND a.incident_id=CAST(:n AS uuid)"""), {"p": project_id, "n": new_id, "e": event_id})
        _requeue(conn, project_id, new_id)
    _requeue(conn, project_id, incident_id)
    conn.commit()
    return {"unlinked": event_id, "new_incident_id": new_id}


class MergeBody(BaseModel):
    into_id: str


@router.post("/projects/{project_id}/incidents/{incident_id}/merge")
def merge_incident(project_id: str, incident_id: str, body: MergeBody, member=Depends(current_manager),
                   conn=Depends(ops_connection)):
    """Merge incident B (this one) into A (`into_id`): move B's sources to A and retire B and its alert."""
    _uuid(incident_id, "Incident")
    _uuid(body.into_id, "Incident")
    if incident_id == body.into_id:
        raise HTTPException(422, "Cannot merge an incident into itself")
    rows = {r["id"]: r for r in conn.execute(text("""
        SELECT id::text AS id, severity, merged_into_id FROM sitemate.incidents
        WHERE project_id=:p AND id IN (CAST(:a AS uuid), CAST(:b AS uuid)) ORDER BY id FOR UPDATE"""),
                                             {"p": project_id, "a": incident_id, "b": body.into_id}).mappings()}
    if len(rows) != 2:
        raise HTTPException(404, "Incident not found")
    if rows[incident_id]["merged_into_id"] or rows[body.into_id]["merged_into_id"]:
        raise HTTPException(409, "One of these incidents was already merged")
    p = {"p": project_id, "b": incident_id, "a": body.into_id, "me": member["member_id"]}
    conn.execute(text("""
        INSERT INTO sitemate.incident_events (project_id, incident_id, event_id, link_type, match_reason, linked_by)
        SELECT project_id, CAST(:a AS uuid), event_id, CASE WHEN link_type='origin' THEN 'corroborating' ELSE link_type END,
               'merged from another incident', :me
        FROM sitemate.incident_events WHERE project_id=:p AND incident_id=CAST(:b AS uuid) AND unlinked_at IS NULL
        ON CONFLICT DO NOTHING"""), p)
    conn.execute(text("""UPDATE sitemate.incident_events SET unlinked_at=now(), linked_by=:me
                         WHERE project_id=:p AND incident_id=CAST(:b AS uuid) AND unlinked_at IS NULL"""), p)
    conn.execute(text("""UPDATE sitemate.events SET incident_id=CAST(:a AS uuid)
                         WHERE project_id=:p AND incident_id=CAST(:b AS uuid)"""), p)
    conn.execute(text("""UPDATE sitemate.incidents SET status='closed', merged_into_id=CAST(:a AS uuid),
                             resolved_at=GREATEST(now(), occurred_at) WHERE project_id=:p AND id=CAST(:b AS uuid)"""), p)
    _refresh_counts(conn, project_id, body.into_id)
    higher = max((rows[incident_id]["severity"], rows[body.into_id]["severity"]),
                 key=lambda s: SEVERITIES.index(s) if s in SEVERITIES else -1)
    if higher and higher != rows[body.into_id]["severity"]:
        conn.execute(text("""
            INSERT INTO sitemate.incident_severity_history (project_id, incident_id, version, severity, reason)
            SELECT project_id, id, severity_version + 1, :s, 'Raised by merge' FROM sitemate.incidents
            WHERE project_id=:p AND id=CAST(:a AS uuid)"""), {**p, "s": higher})
        conn.execute(text("""UPDATE sitemate.incidents SET severity=:s, severity_version=severity_version+1
                             WHERE project_id=:p AND id=CAST(:a AS uuid)"""), {**p, "s": higher})
    retired = conn.execute(text("""
        UPDATE sitemate.alerts SET status='dismissed' WHERE project_id=:p AND incident_id=CAST(:b AS uuid) AND kind='incident'
        RETURNING id::text AS id, status"""), p).mappings().one_or_none()
    if retired:
        _log(conn, project_id, retired["id"], member["member_id"], "dismiss", None, "dismissed", "Merged into another incident")
    _revision(conn, project_id, body.into_id, f"Merged another incident, by {member['member_id']}")
    _requeue(conn, project_id, body.into_id)
    conn.commit()
    return {"merged": incident_id, "into": body.into_id}
