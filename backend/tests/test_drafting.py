"""Draft lifecycle: templates (pure), then gaps, submit, approval and stored exports through the API.

    TEST_DATABASE_URL=postgresql+psycopg://postgres@127.0.0.1:54329/sm  pytest backend/tests/test_drafting.py
"""

import email
import hashlib
import os
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "ai-agent"))

from notice_templates import DRAFT_MARKER, fill_gap, missing_fields, omit_gap, omittable, render_final, template  # noqa: E402

BODY = ("DELAY NOTICE (DRAFT FOR REVIEW)\n10 November 2026 | Riverside\nFrom: Sam\nTo: Client\n"
        "Contract reference: [MISSING: contract reference]\nApplicable clause: [MISSING: contract clause]\n\n"
        "Subject: Delay\n\nDear Client,\n\nExpected effect on the programme: [MISSING: expected impact]. We will update you."
        "\n\nInternal note, remove before sending: check this\n\nYours faithfully,\nSam")


# ------------------------------------------------------------------ pure

def test_fill_and_omit():
    assert missing_fields(BODY) == ["contract clause", "contract reference", "expected impact"]
    filled = fill_gap(BODY, "contract reference", "RIV-2026-01")
    assert "Contract reference: RIV-2026-01" in filled
    omitted = omit_gap(filled, "contract clause")
    assert "Applicable clause" not in omitted  # a header line that only states the field is removed
    inline = omit_gap(omitted, "expected impact")
    assert "Expected effect on the programme: not stated. We will update you." in inline  # the sentence stays
    assert missing_fields(inline) == []


def test_render_final_drops_marker_and_internal_notes_only():
    final = render_final(BODY)
    assert DRAFT_MARKER not in final and "Internal note" not in final
    assert final.startswith("DELAY NOTICE\n") and "Yours faithfully,\nSam" in final and "Dear Client," in final


def test_templates_and_project_overrides():
    assert "contract clause" in omittable("delay_notice") and "sender" not in omittable("delay_notice")
    custom = template("delay_notice", {"notice_templates": {"delay_notice": {"title": "BEHINDERUNGSANZEIGE",
                                                                             "omittable": ["expected impact"],
                                                                             "formal": "not a bool"}}})
    assert custom["title"] == "BEHINDERUNGSANZEIGE" and custom["omittable"] == ["expected impact"]
    assert custom["formal"] is True  # a wrongly typed override is ignored


# ------------------------------------------------------------------ API

URL = os.environ.get("TEST_DATABASE_URL")
PID = "DRTEST"
TOKENS = {"mgr": "tok-dr-manager", "apr": "tok-dr-approver"}
MGR = {"Authorization": f"Bearer {TOKENS['mgr']}"}
APR = {"Authorization": f"Bearer {TOKENS['apr']}"}
PROTECTED = ("draft_versions", "reviews", "alert_revisions", "draft_gap_resolutions")


def _clean(c):
    for t in PROTECTED:
        c.execute(text(f"ALTER TABLE sitemate.{t} DISABLE TRIGGER keep_revision"))
    for t in ("exports", "draft_gap_resolutions", "reviews", "draft_versions", "drafts", "alert_revisions", "alerts",
              "observations", "plan_targets", "source_passages", "sources", "activities", "project_members"):
        c.execute(text(f"DELETE FROM sitemate.{t} WHERE project_id=:p"), {"p": PID})
    for t in PROTECTED:
        c.execute(text(f"ALTER TABLE sitemate.{t} ENABLE TRIGGER keep_revision"))
    c.execute(text("DELETE FROM sitemate.projects WHERE id=:p"), {"p": PID})


@pytest.fixture()
def api(tmp_path, monkeypatch):
    if not URL:
        pytest.skip("set TEST_DATABASE_URL to run API tests")
    os.environ["DATABASE_URL"] = os.environ.get("TEST_READER_URL", URL)
    os.environ["MIGRATION_DATABASE_URL"] = URL
    os.environ.pop("WRITER_DATABASE_URL", None)
    from database import engine_for
    engine_for.cache_clear()
    from documents import storage
    monkeypatch.setattr(storage, "STORAGE_ROOT", tmp_path)
    from fastapi.testclient import TestClient
    from main import app
    eng = create_engine(URL)
    with eng.begin() as c:
        _clean(c)
        c.execute(text("""INSERT INTO sitemate.projects (id, name, timezone, threshold, high_threshold, sender, recipient)
                          VALUES (:p, 'Drafting', 'Europe/Berlin', 15, 25, 'Sam Reed, Site Manager, JV', 'Client PM')"""),
                  {"p": PID})
        for member, role in (("mgr", "manager"), ("apr", "approver")):
            c.execute(text("INSERT INTO sitemate.project_members (project_id, member_id, token_hash, role, display_name) "
                           "VALUES (:p, :m, :h, :r, :n)"),
                      {"p": PID, "m": member, "h": hashlib.sha256(TOKENS[member].encode()).hexdigest(), "r": role,
                       "n": member.upper()})
        c.execute(text("INSERT INTO sitemate.activities (project_id, code, name, unit, zone) "
                       "VALUES (:p, 'EXC-B', 'Excavation Zone B', 'm3', 'B')"), {"p": PID})
        for sid, kind, at in (("SCH", "schedule", "2026-11-06T08:00:00+01:00"),
                              ("R10", "daily_report", "2026-11-10T17:30:00+01:00")):
            c.execute(text("INSERT INTO sitemate.sources (project_id, id, kind, path, available_at) "
                           "VALUES (:p, :s, :k, 'inline:test', :at)"), {"p": PID, "s": sid, "k": kind, "at": at})
        c.execute(text("""INSERT INTO sitemate.source_passages (project_id, source_id, locator, excerpt) VALUES
                          (:p, 'SCH', 'EXC-B', 'EXC-B 100 m3 per day'), (:p, 'R10', 'EXC-B', 'EXC-B: actual 65 m3')"""),
                  {"p": PID})
        c.execute(text("""INSERT INTO sitemate.plan_targets VALUES (:p, 'EXC-B', '2026-11-10', 100, 'SCH', 'EXC-B')"""),
                  {"p": PID})
        c.execute(text("""INSERT INTO sitemate.observations (project_id, activity_code, work_date, source_id, locator,
                          quantity, basis) VALUES (:p, 'EXC-B', '2026-11-10', 'R10', 'EXC-B', 65, 'signed')"""), {"p": PID})
    yield TestClient(app), eng
    with eng.begin() as c:
        _clean(c)


AT = "?as_of=2026-11-10T18:00:00%2B01:00"


def test_gaps_approval_and_stored_exports(api):
    client, eng = api
    d = client.post(f"/projects/{PID}/drafts{AT}", headers=MGR, json={"activity_code": "EXC-B", "work_date": "2026-11-10"})
    assert d.status_code == 201, d.text
    d = d.json()
    did, v1 = d["id"], d["latest"]
    assert d["disclaimer"].startswith("Drafting support only") and "contract clause" in d["omittable_fields"]
    assert set(v1["missing_fields"]) == {"contract reference", "contract clause"}
    assert "Yours faithfully," in v1["body"]

    # Approval is refused while anything is missing (T5).
    r = client.post(f"/projects/{PID}/drafts/{did}/versions/1/review", headers=APR, json={"decision": "approved"})
    assert r.status_code == 409 and "missing" in r.json()["detail"]
    gaps = f"/projects/{PID}/drafts/{did}/versions"
    assert client.post(f"{gaps}/1/gaps", headers=MGR, json={"field": "contract clause", "resolution": "omitted"}
                       ).status_code == 422  # a reason is required
    assert client.post(f"{gaps}/1/gaps", headers=APR, json={"field": "contract clause", "resolution": "omitted",
                                                            "reason": "x"}).status_code == 403
    v2 = client.post(f"{gaps}/1/gaps", headers=MGR, json={"field": "contract reference", "resolution": "filled",
                                                          "value": "RIV-2026-01"})
    assert v2.status_code == 201 and v2.json()["latest"]["version"] == 2
    assert client.post(f"{gaps}/1/gaps", headers=MGR, json={"field": "contract clause", "resolution": "omitted",
                                                            "reason": "x"}).status_code == 409  # not the latest
    v3 = client.post(f"{gaps}/2/gaps", headers=MGR, json={"field": "contract clause", "resolution": "omitted",
                                                          "reason": "No clause agreed for this event yet"}).json()
    latest = v3["latest"]
    assert latest["version"] == 3 and latest["missing_fields"] == []
    assert "Applicable clause" not in latest["body"] and "Contract reference: RIV-2026-01" in latest["body"]
    assert [g["resolution"] for g in latest["gap_resolutions"]] == ["omitted"]

    # Approve v3; export twice: the same stored bytes, recorded once.
    assert client.post(f"{gaps}/3/review", headers=MGR, json={"decision": "approved"}).status_code == 403
    ok = client.post(f"{gaps}/3/review", headers=APR, json={"decision": "approved"})
    assert ok.status_code == 201 and ok.json()["status"] == "approved"
    first = client.post(f"{gaps}/3/exports", headers=APR, json={"format": "pdf"}).json()
    second = client.get(f"{gaps}/3/export?format=pdf", headers=MGR)
    assert second.headers["x-content-sha256"] == first["sha256"] and second.content.startswith(b"%PDF")
    assert hashlib.sha256(second.content).hexdigest() == first["sha256"]
    word = client.get(f"{gaps}/3/export?format=docx", headers=MGR)
    from docx import Document
    import io
    text_ = "\n".join(p.text for p in Document(io.BytesIO(word.content)).paragraphs)
    assert "DRAFT FOR REVIEW" not in text_ and "Contract reference: RIV-2026-01" in text_
    eml = email.message_from_bytes(client.get(f"{gaps}/3/export?format=eml", headers=MGR).content)
    assert eml["Subject"].startswith("Delay to Excavation Zone B")
    with eng.connect() as c:
        rows = c.execute(text("SELECT format, created_by FROM sitemate.exports WHERE project_id=:p ORDER BY format"),
                         {"p": PID}).all()
    assert [(r.format, r.created_by) for r in rows] == [("docx", "mgr"), ("eml", "mgr"), ("pdf", "apr")]
    assert client.get(f"{gaps}/2/export?format=pdf", headers=MGR).status_code == 409  # v2 was never approved

    # Editing after approval: a new version that needs its own review; v3 stays approved and exportable.
    edit = client.post(f"/projects/{PID}/drafts/{did}/versions", headers=MGR,
                       json={"body": latest["body"].replace("Please confirm receipt", "Kindly confirm receipt")})
    assert edit.status_code == 201 and edit.json()["status"] == "awaiting_review"
    assert edit.json()["versions"][2]["review"]["decision"] == "approved"
    assert client.get(f"{gaps}/3/export?format=pdf", headers=MGR).headers["x-content-sha256"] == first["sha256"]


def test_approval_roles_setting_lets_a_manager_approve(api):
    client, eng = api
    with eng.begin() as c:
        c.execute(text("""UPDATE sitemate.projects SET settings = '{"approval_roles": ["manager", "approver"]}'
                          WHERE id = :p"""), {"p": PID})
    d = client.post(f"/projects/{PID}/drafts{AT}", headers=MGR, json={"activity_code": "EXC-B", "work_date": "2026-11-10"}).json()
    url = f"/projects/{PID}/drafts/{d['id']}/versions"
    for field in ("contract reference", "contract clause"):
        v = d["latest"]["version"]
        d = client.post(f"{url}/{v}/gaps", headers=MGR, json={"field": field, "resolution": "omitted",
                                                              "reason": "Not in the project record"}).json()
    r = client.post(f"{url}/{d['latest']['version']}/review", headers=MGR, json={"decision": "approved"})
    assert r.status_code == 201, r.text
    assert d["approval_roles"] == ["manager", "approver"]


def test_private_drafts_need_submit_before_review(api):
    client, eng = api
    from app import worker
    alert_id = client.post(f"/projects/{PID}/drafts{AT}", headers=MGR,
                           json={"activity_code": "EXC-B", "work_date": "2026-11-10"}).json()["alert_id"]
    with eng.connect() as c:  # the worker drafts a defect notice for the same alert automatically
        worker.enqueue_job(c, PID, "auto_draft", {"alert_id": alert_id, "notice_type": "defect_notice",
                                                  "as_of": "2026-11-10T18:05:00+01:00"})
        c.commit()
    assert worker.process_one(eng, lambda: None)
    drafts = {d["notice_type"]: d for d in client.get(f"/projects/{PID}/drafts", headers=MGR).json()}
    auto = drafts["defect_notice"]
    assert auto["origin"] == "alert_auto" and auto["status"] == "draft"
    assert "defect_notice" not in {d["notice_type"] for d in client.get(f"/projects/{PID}/drafts", headers=APR).json()}
    url = f"/projects/{PID}/drafts/{auto['id']}"
    assert client.post(f"{url}/versions/1/review", headers=APR, json={"decision": "changes_requested",
                                                                      "reason": "x"}).status_code == 409
    sent = client.post(f"{url}/submit", headers=MGR, json={"expected_version": 1})
    assert sent.status_code == 200 and sent.json()["status"] == "awaiting_review"
    assert client.post(f"{url}/submit", headers=MGR).status_code == 409
    with eng.connect() as c:  # repeating the job changes nothing (one draft per alert and type)
        worker.enqueue_job(c, PID, "auto_draft", {"alert_id": alert_id, "notice_type": "defect_notice"})
        c.commit()
    assert worker.process_one(eng, lambda: None)
    with eng.connect() as c:
        assert c.scalar(text("SELECT count(*) FROM sitemate.draft_versions v JOIN sitemate.drafts d "
                             "ON (d.project_id, d.id) = (v.project_id, v.draft_id) WHERE d.project_id=:p "
                             "AND d.notice_type='defect_notice'"), {"p": PID}) == 1
