"""Reviewing parsed report quantities: pure planning rules, then the route against a scratch DB.

    TEST_DATABASE_URL=postgresql+psycopg://postgres@127.0.0.1:54329/sm  pytest backend/tests/test_readings.py
"""

import hashlib
import os
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "ai-agent"))

from documents.readings import Decision, ReadingError, plan  # noqa: E402

P = {"EXC-B": {"activity_code": "EXC-B", "work_date": "2026-11-10", "value": 65, "unit": "m3", "basis": "signed",
               "locator": "EXC-B"},
     "zero-SET": {"activity_code": "SET", "work_date": "2026-11-10", "value": 0, "unit": "sections", "basis": "signed",
                  "locator": "zero-SET"}}


# ------------------------------------------------------------------ pure

def test_accept_all_signed_rows():
    items = plan([], P, {}, {}, all_signed=True)
    assert [(i["locator"], i["decision"], i["quantity"]) for i in items] == [("EXC-B", "accepted", 65.0),
                                                                             ("zero-SET", "accepted", 0.0)]


def test_repeating_a_decision_is_a_noop():
    current = {"EXC-B": {"id": "r1", "decision": "accepted", "quantity": 65}}
    items = plan([Decision("EXC-B", "accepted")], P, current, {"EXC-B": 65}, all_signed=False)
    assert items[0]["action"] == "noop"


def test_a_stored_different_value_is_a_conflict_unless_corrected():
    with pytest.raises(ReadingError) as err:
        plan([Decision("EXC-B", "accepted")], P, {}, {"EXC-B": 70}, all_signed=False)
    assert err.value.status == 409 and err.value.detail == [{"locator": "EXC-B", "stored": 70.0, "parsed": 65.0}]
    items = plan([Decision("EXC-B", "corrected", 75, "Recount at 12:08")], P, {}, {"EXC-B": 70}, all_signed=False)
    assert items[0]["quantity"] == 75 and items[0]["decision"] == "corrected"


def test_corrections_and_rejections_need_a_reason_and_rows_must_exist():
    for decision in (Decision("EXC-B", "corrected", 70), Decision("EXC-B", "rejected")):
        with pytest.raises(ReadingError) as err:
            plan([decision], P, {}, {}, all_signed=False)
        assert err.value.status == 422
    with pytest.raises(ReadingError) as err:
        plan([Decision("EXC-B", "corrected", None, "why")], P, {}, {}, all_signed=False)
    assert err.value.status == 422
    with pytest.raises(ReadingError) as err:
        plan([Decision("NOPE", "accepted")], P, {}, {}, all_signed=False)
    assert err.value.status == 404
    with pytest.raises(ReadingError):
        plan([], P, {"EXC-B": {"id": "a", "decision": "accepted", "quantity": 65},
                     "zero-SET": {"id": "b", "decision": "accepted", "quantity": 0}}, {}, all_signed=True)


# ------------------------------------------------------------------ API

URL = os.environ.get("TEST_DATABASE_URL")
PID, TOKEN = "RDTEST", "tok-rd-manager"
H = {"Authorization": f"Bearer {TOKEN}"}
AT_REPORT = "2026-11-10T17:30:00+01:00"


def _clean(c):
    c.execute(text("ALTER TABLE sitemate.reading_reviews DISABLE TRIGGER keep_revision"))
    for t in ("observations", "reading_reviews", "agent_jobs", "ingestion_jobs", "plan_targets", "source_passages",
              "sources", "activities", "project_members"):
        c.execute(text(f"DELETE FROM sitemate.{t} WHERE project_id=:p"), {"p": PID})
    c.execute(text("ALTER TABLE sitemate.reading_reviews ENABLE TRIGGER keep_revision"))
    c.execute(text("DELETE FROM sitemate.projects WHERE id=:p"), {"p": PID})


@pytest.fixture()
def api():
    if not URL:
        pytest.skip("set TEST_DATABASE_URL to run API tests")
    os.environ["DATABASE_URL"] = os.environ.get("TEST_READER_URL", URL)
    os.environ["MIGRATION_DATABASE_URL"] = URL
    os.environ.pop("WRITER_DATABASE_URL", None)
    from database import engine_for
    engine_for.cache_clear()
    from fastapi.testclient import TestClient
    from main import app
    eng = create_engine(URL)
    with eng.begin() as c:
        _clean(c)
        c.execute(text("""INSERT INTO sitemate.projects (id, name, timezone, threshold, high_threshold)
                          VALUES (:p, 'Readings', 'Europe/Berlin', 15, 25)"""), {"p": PID})
        c.execute(text("INSERT INTO sitemate.project_members (project_id, member_id, token_hash, role) "
                       "VALUES (:p, 'mgr', :h, 'manager'), (:p, 'fm', :f, 'contributor')"),
                  {"p": PID, "h": hashlib.sha256(TOKEN.encode()).hexdigest(),
                   "f": hashlib.sha256(b"tok-rd-foreman").hexdigest()})
        c.execute(text("""INSERT INTO sitemate.activities (project_id, code, name, unit, zone) VALUES
                          (:p, 'EXC-B', 'Excavation Zone B', 'm3', 'B'), (:p, 'SET', 'Setting out', 'sections', 'B')"""),
                  {"p": PID})
        c.execute(text("""INSERT INTO sitemate.sources (project_id, id, kind, path, available_at)
                          VALUES (:p, 'R10', 'daily_report', 'inline:test', :at)"""), {"p": PID, "at": AT_REPORT})
        c.execute(text("""INSERT INTO sitemate.source_passages (project_id, source_id, locator, page, excerpt) VALUES
                          (:p, 'R10', 'EXC-B', 2, 'EXC-B: actual 65 m3'), (:p, 'R10', 'zero-SET', 2, 'zero rule')"""),
                  {"p": PID})
        c.execute(text("""INSERT INTO sitemate.ingestion_jobs (project_id, source_id, stage, status, result)
                          VALUES (:p, 'R10', 'parse', 'done', CAST(:r AS jsonb))"""),
                  {"p": PID, "r": __import__("json").dumps({"proposals": [dict(v, source_id="R10", page=2)
                                                                           for v in P.values()]})})
    yield TestClient(app), eng
    with eng.begin() as c:
        _clean(c)


def _obs(eng):
    with eng.connect() as c:
        return {r.locator: (float(r.quantity), r.accepted_by) for r in c.execute(text(
            "SELECT locator, quantity, accepted_by FROM sitemate.observations WHERE project_id=:p"), {"p": PID})}


def test_confirm_writes_observations_queues_the_day_and_is_idempotent(api):
    client, eng = api
    url = f"/projects/{PID}/sources/R10/readings"
    before = client.get(url, headers=H).json()
    assert before["pending"] == 2 and {r["review_status"] for r in before["readings"]} == {"proposed"}

    r = client.post(f"{url}/confirm?as_of=2026-11-10T17:45:00%2B01:00", headers=H, json={"all_signed": True})
    assert r.status_code == 200, r.text
    assert r.json()["queued_days"] == ["2026-11-10"] and len(r.json()["reviews"]) == 2
    assert _obs(eng) == {"EXC-B": (65.0, "mgr"), "zero-SET": (0.0, "mgr")}
    with eng.connect() as c:
        assert c.scalar(text("SELECT count(*) FROM sitemate.agent_jobs WHERE project_id=:p AND kind='daily_eval'"),
                        {"p": PID}) == 1

    again = client.post(f"{url}/confirm?as_of=2026-11-10T17:50:00%2B01:00", headers=H,
                        json={"decisions": [{"locator": "EXC-B", "decision": "accepted"}]})
    assert again.status_code == 200 and again.json()["unchanged"] == ["EXC-B"] and again.json()["reviews"] == []

    # Replay before the confirmation: not accepted yet; after it: accepted, with the reviewer.
    early = client.get(f"{url}?as_of=2026-11-10T17:40:00%2B01:00", headers=H).json()
    assert {r["review_status"] for r in early["readings"]} == {"proposed"}
    late = {r["locator"]: r for r in client.get(url, headers=H).json()["readings"]}
    assert late["EXC-B"]["review_status"] == "accepted" and late["EXC-B"]["review"]["decision"] == "accepted"

    # Progress reads the confirmed value from the confirmation time onward.
    with eng.begin() as c:
        c.execute(text("""INSERT INTO sitemate.plan_targets (project_id, activity_code, work_date, quantity, source_id,
                          locator) VALUES (:p, 'EXC-B', '2026-11-10', 100, 'R10', 'EXC-B')"""), {"p": PID})
    prog = f"/projects/{PID}/activities/EXC-B/progress?date=2026-11-10"
    assert client.get(prog + "&as_of=2026-11-10T17:40:00%2B01:00", headers=H).json()["actual"] is None
    assert client.get(prog, headers=H).json()["actual"] == 65


def test_corrections_reject_conflicts_and_roles(api):
    client, eng = api
    url = f"/projects/{PID}/sources/R10/readings/confirm"
    foreman = {"Authorization": "Bearer tok-rd-foreman"}
    assert client.post(url, headers=foreman, json={"all_signed": True}).status_code == 403
    assert client.post(url + "?as_of=2026-11-10T17:00:00%2B01:00", headers=H,
                       json={"all_signed": True}).status_code == 404  # the report is not in yet
    with eng.begin() as c:  # an earlier stored value for the same row
        c.execute(text("""INSERT INTO sitemate.observations (project_id, activity_code, work_date, source_id, locator,
                          quantity, basis) VALUES (:p, 'EXC-B', '2026-11-10', 'R10', 'EXC-B', 70, 'signed')"""), {"p": PID})
    conflict = client.post(url, headers=H, json={"decisions": [{"locator": "EXC-B", "decision": "accepted"}]})
    assert conflict.status_code == 409 and conflict.json()["detail"]["conflicts"][0]["stored"] == 70
    assert _obs(eng)["EXC-B"] == (70.0, None)  # nothing written

    fixed = client.post(url, headers=H, json={"decisions": [
        {"locator": "EXC-B", "decision": "corrected", "quantity": 75, "reason": "Recount at 12:08"},
        {"locator": "zero-SET", "decision": "rejected", "reason": "Setting out was not on the report"}]})
    assert fixed.status_code == 200, fixed.text
    assert _obs(eng) == {"EXC-B": (75.0, "mgr")}
    rows = {r["locator"]: r for r in client.get(f"/projects/{PID}/sources/R10/readings", headers=H).json()["readings"]}
    assert rows["EXC-B"]["review_status"] == "corrected" and rows["EXC-B"]["review"]["reason"] == "Recount at 12:08"
    assert rows["zero-SET"]["review_status"] == "rejected"
    with eng.connect() as c:  # history: two decisions on EXC-B? no, one; the rejection is its own row
        assert c.scalar(text("SELECT count(*) FROM sitemate.reading_reviews WHERE project_id=:p"), {"p": PID}) == 2
