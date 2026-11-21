"""End-to-end capture pipeline against a migrated scratch database, with a scripted fake LLM.

  TEST_DATABASE_URL=postgresql+psycopg://postgres@127.0.0.1:54329/sm            (admin: seeds and cleans up)
  TEST_AGENT_URL=postgresql+psycopg://sitemate_agent:...@127.0.0.1:54329/sm      (optional: run as the real agent role)
Never point these at a shared database."""

import json
import os
import re
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.capture.pipeline import CaptureError, CaptureService  # noqa: E402
from app.capture.storage import DiskStorage  # noqa: E402
from app.llm import LLMError  # noqa: E402

ADMIN = os.environ.get("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not ADMIN, reason="set TEST_DATABASE_URL to run pipeline tests")
PID = "CTEST"
MEMBERS = {"m1": "contributor", "m2": "contributor", "m3": "contributor", "m4": "contributor", "m5": "contributor", "boss": "manager"}


class FakeLLM:
    """Answers each pipeline step by recognising its system prompt."""
    model = "fake"

    def __init__(self):
        self.calls = []
        self.fail = None

    def generate_json(self, system, user, images=None):
        self.calls.append(system[:40])
        if self.fail:
            raise LLMError(self.fail)
        if "describe construction site photos" in system:
            return {"description": "A burst hose on the ground", "hazards": ["wet floor"]}
        if "SUGGEST a category" in system:
            return {"events": [self.extract(re.search(r"<report>\n(.*?)\n</report>", user, re.S).group(1))]}
        if "validate a construction site capture" in system:
            return {"validated_facts": [], "missing": [], "questions": []}
        if "another report of an EXISTING open incident" in system:
            payload = json.loads(user)
            hit = next((c for c in payload["candidates"] if c["asset_key"] == payload["event"]["asset_key"]), None)
            return {"decision": "link", "incident_id": hit["incident_id"], "link_type": "corroborating", "confidence": 0.9, "reason": "same asset"} \
                if hit else {"decision": "new", "incident_id": None, "link_type": None, "confidence": 0.8, "reason": "different asset"}
        if "review a rule-based severity" in system:
            return {"adjustment": 0, "reason": None}
        raise AssertionError(f"unexpected prompt: {system[:80]}")

    @staticmethod
    def extract(text_):
        lift, crane = bool(re.search(r"lift|hoist", text_, re.I)), "crane" in text_.lower()
        fixed, spill = bool(re.search(r"working again|fixed", text_, re.I)), bool(re.search(r"oil|spill", text_, re.I))
        near_miss = "plank" in text_.lower()
        category, etype = (("status_update", "repair_release") if fixed else ("environmental", "spill") if spill
                           else ("safety", "near_miss") if near_miss else ("equipment", "equipment_failure"))
        return {"suggested_category": category, "suggested_event_type": etype, "confidence": 0.82, "rationale": "test",
                "alternatives": [], "summary": text_[:80], "evidence_quote": text_, "zone": "B" if near_miss else "A",
                "asset_key": "LIFT-2" if lift else "crane:tower" if crane else None,
                "severity_flags": ["spill_to_drain"] if spill else []}


@pytest.fixture(scope="module")
def admin():
    eng = create_engine(ADMIN)
    _clean(eng)
    with eng.begin() as c:
        c.execute(text("INSERT INTO sitemate.projects (id,name,timezone,threshold,high_threshold) VALUES (:p,'pipeline test','UTC',10,30)"), {"p": PID})
        for m, role in MEMBERS.items():
            c.execute(text("INSERT INTO sitemate.project_members (project_id,member_id,token_hash,role) VALUES (:p,:m,:h,:r)"),
                      {"p": PID, "m": m, "h": f"hash-{m}", "r": role})
        c.execute(text("INSERT INTO sitemate.contractors (project_id,id,name,trade,contact_role) VALUES (:p,'C1','Lift Co','lifts','owner')"), {"p": PID})
        c.execute(text("INSERT INTO sitemate.equipment (project_id,id,description,owner_id) VALUES (:p,'LIFT-2','Goods hoist','C1')"), {"p": PID})
    yield eng
    _clean(eng)


def _clean(eng):
    with eng.begin() as c:
        for t in ("alert_revisions", "incident_severity_history"):
            c.execute(text(f"ALTER TABLE sitemate.{t} DISABLE TRIGGER keep_revision"))
            c.execute(text(f"DELETE FROM sitemate.{t} WHERE project_id=:p"), {"p": PID})
            c.execute(text(f"ALTER TABLE sitemate.{t} ENABLE TRIGGER keep_revision"))
        for t in ("agent_runs", "agent_jobs", "action_items", "alert_activity", "incident_events", "alerts", "fact_evidence",
                  "capture_facts", "events", "capture_attachments", "captures", "incidents", "source_passages", "sources",
                  "equipment", "contractors", "project_members"):
            c.execute(text(f"DELETE FROM sitemate.{t} WHERE project_id=:p"), {"p": PID})
        c.execute(text("DELETE FROM sitemate.projects WHERE id=:p"), {"p": PID})


@pytest.fixture()
def svc(admin, tmp_path):
    llm = FakeLLM()
    engine = create_engine(os.environ.get("TEST_AGENT_URL", ADMIN), pool_size=10)
    yield CaptureService(engine, llm, images=DiskStorage(tmp_path / "img"), audio=DiskStorage(tmp_path / "aud"),
                         transcribe=lambda *a: "spoken words", transcription_on=lambda: True), llm, admin
    engine.dispose()


def member(m):
    return {"member_id": m, "role": MEMBERS[m]}


def start(service, m, words, **kw):
    return service.start(PID, member(m), text_=words, audio=kw.get("audio"), images=kw.get("images", []), recorded_at=None)


def resume(service, thread_id, body):
    """Confirm categories, then answer any business-rule questions with "unknown", as a user who has nothing to add."""
    code, out = service.confirm_categories(PID, thread_id, body)
    while code == 202 and out["status"] == "needs_input":
        code, out = service.answer(PID, thread_id, [{"id": x["id"], "answer": "unknown"} for x in out["questions"]])
    return code, out


def accept(service, m, words):
    status, body = start(service, m, words)
    assert status == 202 and body["status"] == "needs_category"
    return resume(service, body["thread_id"], {"events": []})


def q(admin, sql, **p):
    with admin.connect() as c:
        return c.execute(text(sql), {"p": PID, **p}).mappings().all()


def test_the_users_confirmed_category_is_final_and_the_suggestion_is_audited(svc):
    service, _, admin = svc
    status, body = start(service, "m1", "Crane fault at the tower")
    assert body["events"][0]["suggested_category"] == "equipment" and body["events"][0]["confidence"] == 0.82
    code, out = resume(service, body["thread_id"], {"events": [{"index": 0, "category": "weather", "event_type": "weather_stop"}]})
    assert code == 201 and out["incident_links"][0]["created"] is True
    e = q(admin, "SELECT * FROM sitemate.events WHERE project_id=:p AND capture_id=CAST(:c AS uuid)", c=body["capture_id"])[0]
    assert (e["category"], e["suggested_category"], e["confirmed_by"], e["status"]) == ("weather", "equipment", "m1", "confirmed")
    assert q(admin, "SELECT status, state FROM sitemate.captures WHERE id=CAST(:c AS uuid)", c=body["capture_id"])[0]["status"] == "saved"
    assert {r["agent"] for r in q(admin, "SELECT agent FROM sitemate.agent_runs WHERE project_id=:p AND capture_id=CAST(:c AS uuid)", c=body["capture_id"])} >= {"classification", "validation"}


def test_not_an_event_persists_nothing(svc):
    service, _, admin = svc
    status, body = start(service, "m1", "Crane fault at the tower")
    code, out = service.confirm_categories(PID, body["thread_id"], {"events": [{"index": 0, "keep": False}]})
    assert code == 200 and out["status"] == "no_events"
    assert q(admin, "SELECT count(*) AS n FROM sitemate.events WHERE capture_id=CAST(:c AS uuid)", c=body["capture_id"])[0]["n"] == 0
    assert q(admin, "SELECT status FROM sitemate.captures WHERE id=CAST(:c AS uuid)", c=body["capture_id"])[0]["status"] == "no_events"


def test_a_capture_can_only_be_resumed_once_and_survives_a_restart(svc, admin):
    service, llm, _ = svc
    status, body = start(service, "m1", "Crane fault at the tower")
    restarted = CaptureService(create_engine(os.environ.get("TEST_AGENT_URL", ADMIN)), FakeLLM(), images=service.images, audio=service.audio)
    code, paused = restarted.confirm_categories(PID, body["thread_id"], {"events": []})  # a brand new service, same database
    assert (code, paused["status"]) == (202, "needs_input")  # equipment_failure.required asks for details
    with pytest.raises(CaptureError) as err:  # the category step is already used up
        service.confirm_categories(PID, body["thread_id"], {"events": []})
    assert err.value.status == 404
    answers = [{"id": x["id"], "answer": "unknown"} for x in paused["questions"]]
    assert FakeLLM and CaptureService(create_engine(os.environ.get("TEST_AGENT_URL", ADMIN)), FakeLLM(), images=service.images,
                                      audio=service.audio).answer(PID, body["thread_id"], answers)[0] == 201  # a second restart
    with pytest.raises(CaptureError):
        service.answer(PID, body["thread_id"], answers)


def test_five_parallel_reports_of_the_same_lift_become_one_incident(svc):
    service, _, admin = svc
    with ThreadPoolExecutor(5) as pool:
        results = list(pool.map(lambda a: accept(service, a[0], f"The lift is not working (report {a[1]})"),
                                [("m1", 0), ("m2", 1), ("m3", 2), ("m4", 3), ("m5", 4)]))
    assert all(code == 201 and len(out["incident_links"]) == 1 for code, out in results)
    incidents = q(admin, "SELECT * FROM sitemate.incidents WHERE project_id=:p AND asset_key='eq:LIFT-2'")
    assert len(incidents) == 1
    inc = incidents[0]
    assert (inc["report_count"], inc["reporter_count"], inc["severity"]) == (5, 5, "high")
    links = {r["link_type"]: r["n"] for r in q(admin, "SELECT link_type, count(*)::int AS n FROM sitemate.incident_events WHERE incident_id=:i GROUP BY 1", i=inc["id"])}
    assert links == {"origin": 1, "corroborating": 4}
    alerts = q(admin, "SELECT id FROM sitemate.alerts WHERE project_id=:p AND incident_id=:i", i=inc["id"])
    assert len(alerts) == 1
    assert q(admin, "SELECT count(*)::int AS n FROM sitemate.alert_revisions WHERE alert_id=:a", a=alerts[0]["id"])[0]["n"] >= 5
    assert q(admin, "SELECT count(*)::int AS n FROM sitemate.agent_jobs WHERE incident_id=:i AND kind='reasoning'", i=inc["id"])[0]["n"] == 1  # debounced
    assert q(admin, "SELECT severity FROM sitemate.incident_severity_history WHERE incident_id=:i ORDER BY version DESC LIMIT 1", i=inc["id"])[0]["severity"] == "high"


def test_other_asset_repair_reopen_and_spill(svc):
    service, _, admin = svc
    accept(service, "m1", "The lift is not working")
    accept(service, "m2", "The goods hoist is broken")
    accept(service, "m3", "The lift is broken once more")
    accept(service, "m1", "The tower crane is down")
    assert [r["asset_key"] for r in q(admin, "SELECT asset_key FROM sitemate.incidents WHERE project_id=:p AND category='equipment' ORDER BY asset_key")][-2:] == ["crane:tower", "eq:LIFT-2"]
    code, out = accept(service, "boss", "The lift is working again, fixed")
    assert out["incident_links"][0]["link_type"] == "resolution"
    lift = lambda: q(admin, "SELECT status, report_count FROM sitemate.incidents WHERE project_id=:p AND asset_key='eq:LIFT-2'")[0]  # noqa: E731
    before = lift()
    assert before["status"] == "monitoring"  # an update is not another report of the fault
    accept(service, "m2", "The lift is broken again")
    after = lift()
    assert after["status"] == "open" and after["report_count"] == before["report_count"] + 1
    code, spill = accept(service, "m3", "Oil spill by the tank, running to the drain")
    assert spill["incident_links"][0]["severity"] == "high"
    assert q(admin, "SELECT category FROM sitemate.incidents WHERE id=CAST(:i AS uuid)", i=spill["incident_links"][0]["incident_id"])[0]["category"] == "environmental"


def test_photos_become_citable_passages_and_attachments(svc):
    service, llm, admin = svc
    status, body = start(service, "m1", "Hose burst", images=[(b"\xff\xd8fake", "a.jpg", "image/jpeg")])
    assert status == 202 and body["photo_descriptions"][0]["n"] == 1
    resume(service, body["thread_id"], {"events": []})
    src = q(admin, "SELECT source_id FROM sitemate.captures WHERE id=CAST(:c AS uuid)", c=body["capture_id"])[0]["source_id"]
    locators = [r["locator"] for r in q(admin, "SELECT locator FROM sitemate.source_passages WHERE project_id=:p AND source_id=:s ORDER BY locator", s=src)]
    assert [l for l in locators if not l.startswith("answer:")] == ["image:1", "transcript"]
    att = q(admin, "SELECT kind, passage_locator, mime FROM sitemate.capture_attachments WHERE project_id=:p AND source_id=:s", s=src)
    assert [(a["kind"], a["passage_locator"], a["mime"]) for a in att] == [("image", "image:1", "image/jpeg")]
    assert q(admin, "SELECT kind, author_role FROM sitemate.sources WHERE project_id=:p AND id=:s", s=src)[0]["author_role"] == "foreman"


def test_photo_only_and_voice_capture(svc):
    service, _, admin = svc
    status, body = service.start(PID, member("m1"), text_=None, images=[(b"x", "a.png", "image/png")], audio=None, recorded_at=None)
    assert status == 202
    status, body = service.start(PID, member("m1"), text_=None, images=[], audio=(b"RIFF", "n.webm", "audio/webm"), recorded_at=None)
    assert status == 202
    src = q(admin, "SELECT source_id, channel FROM sitemate.captures WHERE id=CAST(:c AS uuid)", c=body["capture_id"])[0]
    assert src["channel"] == "voice" and q(admin, "SELECT kind FROM sitemate.sources WHERE id=:s", s=src["source_id"])[0]["kind"] == "voice"


def test_required_field_questions_pause_and_resume(svc):
    service, _, admin = svc
    status, body = start(service, "m1", "A plank fell from the scaffold in zone B")
    code, paused = service.confirm_categories(PID, body["thread_id"], {"events": []})
    assert code == 202 and paused["status"] == "needs_input" and paused["questions"][0]["field_name"] == "injured_count"
    assert q(admin, "SELECT status FROM sitemate.captures WHERE id=CAST(:c AS uuid)", c=body["capture_id"])[0]["status"] == "needs_input"
    code, done = service.answer(PID, body["thread_id"], [{"id": paused["questions"][0]["id"], "answer": "0"}])
    assert code == 201 and done["incident_links"][0]["created"] is True
    assert any(p["locator"].startswith("answer:") for p in q(admin, "SELECT locator FROM sitemate.source_passages WHERE project_id=:p AND source_id=:s", s=done["source_id"]))


def test_validation_and_failures_are_reported_and_leave_a_retryable_state(svc):
    service, llm, admin = svc
    for kwargs, status in ((dict(text_=None, images=[], audio=None), 422),
                           (dict(text_="x", images=[(b"x", "a.txt", "text/plain")], audio=None), 422),
                           (dict(text_="x", images=[(b"x" * (5 * 1024 * 1024 + 1), "a.png", "image/png")], audio=None), 422),
                           (dict(text_="x", images=[(b"x", "a.png", "image/png")] * 6, audio=None), 422)):
        with pytest.raises(CaptureError) as err:
            service.start(PID, member("m1"), recorded_at=None, **kwargs)
        assert err.value.status == status
    with pytest.raises(CaptureError):
        service.start(PID, member("m1"), text_="x", images=[], audio=None, recorded_at="2026-01-01T00:00:00")  # no time zone
    service.transcription_on = lambda: False
    with pytest.raises(CaptureError, match="not configured"):
        service.start(PID, member("m1"), text_=None, images=[], audio=(b"x", "n.webm", "audio/webm"), recorded_at=None)
    # LLM down on upload: the capture is recorded as failed
    llm.fail = "model down"
    with pytest.raises(LLMError):
        start(service, "m1", "Crane fault")
    assert q(admin, "SELECT status FROM sitemate.captures WHERE project_id=:p AND raw_text='Crane fault' ORDER BY created_at DESC LIMIT 1")[0]["status"] == "failed"
    # LLM down while resuming: nothing is saved and the person can try again
    llm.fail = None
    status, body = start(service, "m1", "Crane fault again")
    llm.fail = "model down"
    with pytest.raises(LLMError):
        service.confirm_categories(PID, body["thread_id"], {"events": []})
    assert q(admin, "SELECT status FROM sitemate.captures WHERE id=CAST(:c AS uuid)", c=body["capture_id"])[0]["status"] == "needs_category"
    llm.fail = None
    assert resume(service, body["thread_id"], {"events": []})[0] == 201
