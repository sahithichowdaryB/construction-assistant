"""API tests for incidents/alerts/actions. Needs a migrated scratch DB:
   TEST_DATABASE_URL=postgresql+psycopg://postgres@127.0.0.1:54329/sm  pytest backend/tests"""

import hashlib
import os
import sys
import uuid
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text

URL = os.environ.get("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not URL, reason="set TEST_DATABASE_URL to run API tests")
PID = "ATEST"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def sha(token):
    return hashlib.sha256(token.encode()).hexdigest()


@pytest.fixture()
def api():
    os.environ["DATABASE_URL"] = os.environ.get("TEST_READER_URL", URL)  # sitemate_reader when set
    os.environ["OPS_DATABASE_URL"] = os.environ.get("TEST_OPS_URL", URL)  # sitemate_ops when set
    from database import engine_for
    engine_for.cache_clear()
    from fastapi.testclient import TestClient
    from main import app
    eng = create_engine(URL)
    with eng.begin() as c:
        _clean(c)
        c.execute(text("INSERT INTO sitemate.projects (id,name,timezone,threshold,high_threshold) VALUES (:p,'a','UTC',10,30)"), {"p": PID})
        for m, role in (("mgr", "manager"), ("worker", "contributor"), ("other", "contributor")):
            c.execute(text("INSERT INTO sitemate.project_members (project_id,member_id,token_hash,role) VALUES (:p,:m,:h,:r)"),
                      {"p": PID, "m": m, "h": sha(f"tok-{m}"), "r": role})
        c.execute(text("INSERT INTO sitemate.contractors (project_id,id,name,trade,contact_role) VALUES (:p,'C1','Lift Co','lifts','plant_contractor')"), {"p": PID})
    yield TestClient(app), eng
    with eng.begin() as c:
        _clean(c)


def _clean(c):
    for t in ("alert_revisions", "incident_severity_history"):
        c.execute(text(f"ALTER TABLE sitemate.{t} DISABLE TRIGGER keep_revision"))
        c.execute(text(f"DELETE FROM sitemate.{t} WHERE project_id=:p"), {"p": PID})
        c.execute(text(f"ALTER TABLE sitemate.{t} ENABLE TRIGGER keep_revision"))
    for t in ("action_items", "agent_jobs", "alert_activity", "alerts", "incident_events", "events", "capture_attachments",
              "captures", "incidents", "source_passages", "sources", "contractors", "project_members"):
        c.execute(text(f"DELETE FROM sitemate.{t} WHERE project_id=:p"), {"p": PID})
    c.execute(text("DELETE FROM sitemate.projects WHERE id=:p"), {"p": PID})


MGR = {"Authorization": "Bearer tok-mgr"}
WORKER = {"Authorization": "Bearer tok-worker"}


def make_incident(eng, summary="Lift down", asset="eq:LIFT-2", reporters=("worker", "other"), severity="medium"):
    """An incident with an origin report and corroborating reports, an alert and one revision."""
    iid = str(uuid.uuid4())
    with eng.begin() as c:
        c.execute(text("""INSERT INTO sitemate.incidents (project_id,id,kind,title,occurred_at,category,event_type,summary,zone,asset_key,
                              status,severity,severity_version,first_reported_at,last_reported_at,report_count,reporter_count,cluster_key)
                          VALUES (:p,CAST(:i AS uuid),'equipment_failure',:s,now(),'equipment','equipment_failure',:s,'A',:a,'open',:sev,1,now(),now(),:n,:n,:k)"""),
                  {"p": PID, "i": iid, "s": summary, "a": asset, "sev": severity, "n": len(reporters), "k": f"k:{iid}"})
        c.execute(text("""INSERT INTO sitemate.alerts (project_id,kind,status,incident_id,title,checkpoint_at) VALUES (:p,'incident','open',CAST(:i AS uuid),:s,now())"""), {"p": PID, "i": iid, "s": summary})
        c.execute(text("""INSERT INTO sitemate.alert_revisions (project_id,alert_id,version,as_of,severity,calculation,evidence_refs)
                          SELECT :p,id,1,now(),:sev,'{"kind":"incident"}','[]' FROM sitemate.alerts WHERE incident_id=CAST(:i AS uuid)"""), {"p": PID, "i": iid, "sev": severity})
        for n, who in enumerate(reporters):
            sid = f"S-{uuid.uuid4().hex[:8]}"
            c.execute(text("INSERT INTO sitemate.sources (project_id,id,kind,path,available_at) VALUES (:p,:s,'text','inline',now())"), {"p": PID, "s": sid})
            c.execute(text("INSERT INTO sitemate.source_passages (project_id,source_id,locator,excerpt) VALUES (:p,:s,'transcript',:t)"), {"p": PID, "s": sid, "t": f"{summary} #{n}"})
            cap = c.execute(text("""INSERT INTO sitemate.captures (project_id,source_id,thread_id,captured_by,channel,recorded_at) VALUES (:p,:s,:t,:w,'text',now()) RETURNING id::text"""),
                            {"p": PID, "s": sid, "t": str(uuid.uuid4()), "w": who}).scalar()
            ev = c.execute(text("""INSERT INTO sitemate.events (project_id,capture_id,source_id,locator,event_index,recorded_by,occurred_at,recorded_at,category,event_type,summary,zone,asset_key,incident_id)
                                   VALUES (:p,CAST(:c AS uuid),:s,'transcript',0,:w,now(),now(),'equipment','equipment_failure',:sm,'A',:a,CAST(:i AS uuid)) RETURNING id::text"""),
                           {"p": PID, "c": cap, "s": sid, "w": who, "sm": f"{summary} #{n}", "a": asset, "i": iid}).scalar()
            c.execute(text("""INSERT INTO sitemate.incident_events (project_id,incident_id,event_id,link_type) VALUES (:p,CAST(:i AS uuid),CAST(:e AS uuid),:l)"""),
                      {"p": PID, "i": iid, "e": ev, "l": "origin" if n == 0 else "corroborating"})
    return iid


def alert_of(eng, iid):
    with eng.connect() as c:
        return c.scalar(text("SELECT id::text FROM sitemate.alerts WHERE incident_id=CAST(:i AS uuid)"), {"i": iid})


def test_incident_list_has_counts_severity_and_linked_sources(api):
    client, eng = api
    iid = make_incident(eng)
    rows = client.get(f"/projects/{PID}/incidents", headers=WORKER).json()
    inc = next(r for r in rows if r["id"] == iid)
    assert (inc["report_count"], inc["reporter_count"], inc["severity"], inc["category"], inc["status"]) == (2, 2, "medium", "equipment", "open")
    assert len(inc["refs"]) == 2 and inc["timeline"][0]["kind"] == "reported"
    events = client.get(f"/projects/{PID}/incidents/{iid}/events", headers=WORKER).json()
    assert [e["link_type"] for e in events] == ["origin", "corroborating"]
    assert {e["recorded_by"] for e in events} == {"worker", "other"}


def test_alert_lifecycle_writes_an_activity_log_and_enforces_rules(api):
    client, eng = api
    aid = alert_of(eng, make_incident(eng))
    base = f"/projects/{PID}/alerts/{aid}"
    assert client.post(f"{base}/ack", headers=WORKER).status_code == 403  # contributors cannot act on alerts
    assert client.post(f"{base}/dismiss", headers=MGR, json={}).status_code == 422  # reason required
    assert client.post(f"{base}/ack", headers=MGR).json()["status"] == "acknowledged"
    assert client.post(f"{base}/ack", headers=MGR).status_code == 409
    assert client.post(f"{base}/assign", headers=MGR, json={"assignee": "worker"}).json()["status"] == "in_progress"
    assert client.post(f"{base}/resolve", headers=MGR, json={}).json()["status"] == "resolved"
    assert client.post(f"{base}/reopen", headers=MGR).json()["status"] == "open"
    detail = client.get(base, headers=WORKER).json()
    assert [a["action"] for a in reversed(detail["activity"])] == ["ack", "assign", "resolve", "reopen"]
    assert detail["assigned_to"] == "worker" and detail["incident"]["report_count"] == 2
    listed = client.get(f"/projects/{PID}/alerts", headers=WORKER, params={"kind": "incident"}).json()
    assert [a["status"] for a in listed] == ["open"] and listed[0]["category"] == "equipment"


def test_resolving_the_alert_can_resolve_the_incident_and_back(api):
    client, eng = api
    iid = make_incident(eng)
    aid = alert_of(eng, iid)
    client.post(f"/projects/{PID}/alerts/{aid}/resolve", headers=MGR, json={"resolve_incident": True})
    assert client.get(f"/projects/{PID}/incidents/{iid}", headers=WORKER).json()["status"] == "resolved"
    client.patch(f"/projects/{PID}/incidents/{iid}", headers=MGR, json={"status": "open"})
    assert client.get(f"/projects/{PID}/incidents/{iid}", headers=WORKER).json()["status"] == "open"
    assert client.get(f"/projects/{PID}/alerts/{aid}", headers=WORKER).json()["status"] == "open"
    assert client.patch(f"/projects/{PID}/incidents/{iid}", headers=WORKER, json={"status": "closed"}).status_code == 403


def add_action(eng, iid, aid, action_type, title, **kw):
    with eng.begin() as c:
        return c.execute(text("""INSERT INTO sitemate.action_items (project_id,description,alert_id,incident_id,action_type,title,rationale,owner_role,priority,status,proposed_by)
                                 VALUES (:p,:t,CAST(:a AS uuid),CAST(:i AS uuid),:ty,:t,'because',:r,'high','proposed','agent') RETURNING id::text"""),
                         {"p": PID, "t": title, "a": aid, "i": iid, "ty": action_type, "r": kw.get("role", "site_manager")}).scalar()


def test_approving_actions_runs_their_side_effects(api):
    client, eng = api
    iid = make_incident(eng)
    aid = alert_of(eng, iid)
    owner = add_action(eng, iid, aid, "assign_owner", "Assign an owner", role="site_manager")
    evidence = add_action(eng, iid, aid, "request_evidence", "Record what happened", role="foreman")
    notice = add_action(eng, iid, aid, "draft_notice", "Draft delay notice")
    resolve = add_action(eng, iid, aid, "resolve_incident", "Close it")
    base = f"/projects/{PID}/alerts/{aid}/actions"
    assert len(client.get(base, headers=WORKER).json()) == 4
    assert client.post(f"{base}/{owner}/approve", headers=WORKER).status_code == 403
    r = client.post(f"{base}/{owner}/approve", headers=MGR).json()
    assert r["status"] == "done" and r["result"]["assigned_to"] == "site_manager"
    assert client.get(f"/projects/{PID}/alerts/{aid}", headers=MGR).json()["assigned_to"] == "site_manager"
    assert client.post(f"{base}/{owner}/approve", headers=MGR).status_code == 409  # already decided
    r = client.post(f"{base}/{notice}/approve", headers=MGR).json()
    assert r["status"] == "approved" and r["result"]["next"] == "draft" and r["result"]["incident_id"] == iid
    assert client.post(f"{base}/{notice}/complete", headers=MGR).json()["status"] == "done"
    assert client.post(f"{base}/{evidence}/approve", headers=MGR).json()["status"] == "in_progress"
    prompts = client.get(f"/projects/{PID}/capture-prompts", headers=WORKER).json()  # foreman-role prompt reaches a contributor
    assert [p["title"] for p in prompts] == ["Record what happened"]
    client.post(f"{base}/{resolve}/approve", headers=MGR)
    assert client.get(f"/projects/{PID}/incidents/{iid}", headers=WORKER).json()["status"] == "resolved"
    assert client.post(f"{base}/{evidence}/reject", headers=MGR).json()["status"] == "rejected"


def test_editing_an_action_validates_contractor_and_priority(api):
    client, eng = api
    iid = make_incident(eng)
    aid = alert_of(eng, iid)
    act = add_action(eng, iid, aid, "notify_contractor", "Call the lift contractor")
    url = f"/projects/{PID}/alerts/{aid}/actions/{act}"
    assert client.patch(url, headers=MGR, json={"contractor_id": "NOPE"}).status_code == 422
    assert client.patch(url, headers=MGR, json={"priority": "whenever"}).status_code == 422
    assert client.patch(url, headers=MGR, json={"contractor_id": "C1", "priority": "urgent"}).status_code == 200
    r = client.post(f"{url}/approve", headers=MGR).json()
    assert r["result"]["notified"] == "Lift Co" and r["result"]["sent"] is False


def test_merge_moves_sources_retires_the_duplicate_and_keeps_the_higher_severity(api):
    client, eng = api
    a = make_incident(eng, "Lift stuck", severity="medium")
    b = make_incident(eng, "Lift door fault", asset="eq:LIFT-3", reporters=("worker",), severity="high")
    assert client.post(f"/projects/{PID}/incidents/{b}/merge", headers=WORKER, json={"into_id": a}).status_code == 403
    assert client.post(f"/projects/{PID}/incidents/{b}/merge", headers=MGR, json={"into_id": b}).status_code == 422
    assert client.post(f"/projects/{PID}/incidents/{b}/merge", headers=MGR, json={"into_id": a}).status_code == 200
    merged = client.get(f"/projects/{PID}/incidents/{a}", headers=WORKER).json()
    assert merged["report_count"] == 3 and merged["severity"] == "high"
    listing = [i["id"] for i in client.get(f"/projects/{PID}/incidents", headers=WORKER).json()]
    assert a in listing and b not in listing
    assert client.get(f"/projects/{PID}/alerts/{alert_of(eng, b)}", headers=WORKER).json()["status"] == "dismissed"
    assert client.post(f"/projects/{PID}/incidents/{b}/merge", headers=MGR, json={"into_id": a}).status_code == 409


def test_unlink_a_wrong_report_and_make_it_its_own_incident(api):
    client, eng = api
    iid = make_incident(eng, reporters=("worker", "other", "worker"))
    events = client.get(f"/projects/{PID}/incidents/{iid}/events", headers=WORKER).json()
    origin = next(e["id"] for e in events if e["link_type"] == "origin")
    wrong = next(e["id"] for e in events if e["summary"].endswith("#2"))
    url = f"/projects/{PID}/incidents/{iid}/events"
    assert client.post(f"{url}/{origin}/unlink", headers=MGR).status_code == 409  # origin cannot be unlinked
    r = client.post(f"{url}/{wrong}/unlink", headers=MGR, json={"make_new_incident": True}).json()
    assert r["new_incident_id"]
    before = client.get(f"/projects/{PID}/incidents/{iid}", headers=WORKER).json()
    assert before["report_count"] == 2 and before["reporter_count"] == 2
    new = client.get(f"/projects/{PID}/incidents/{r['new_incident_id']}", headers=WORKER).json()
    assert new["report_count"] == 1 and new["status"] == "open" and new["severity"] == "medium"
    assert client.get(f"/projects/{PID}/alerts/{alert_of(eng, r['new_incident_id'])}", headers=WORKER).json()["status"] == "open"
