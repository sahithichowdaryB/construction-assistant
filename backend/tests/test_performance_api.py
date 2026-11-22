"""Performance evaluation through the API and the worker. Needs a migrated scratch DB (never a shared one):
   TEST_DATABASE_URL=postgresql+psycopg://postgres@127.0.0.1:54329/sm  pytest backend/tests

A fake model stands in for Claude, so no API key is needed."""

import hashlib
import json
import os
import sys
from datetime import date, datetime
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text

URL = os.environ.get("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not URL, reason="set TEST_DATABASE_URL to run API tests")
PID = "PFTEST"
TOKEN = "tok-pf-manager"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "ai-agent"))

CSV = ("activity_id,activity,zone,unit,planned_start,planned_end,planned_qty_per_day,planned_total_qty,contractor_id,"
       "predecessors\nA1,Dig pit,Z1,m3,2026-11-02,2026-11-04,10,30,,\nA2,Pour base,Z1,m3,2026-11-05,2026-11-06,5,10,,A1\n"
       "B1,Paint fence,Z2,m2,2026-11-02,2026-11-03,20,40,,\n")
IMMUTABLE = ("daily_activity_results", "daily_evaluations", "performance_snapshots", "alert_revisions", "draft_versions")


def _clean(c):
    for t in IMMUTABLE:
        c.execute(text(f"ALTER TABLE sitemate.{t} DISABLE TRIGGER keep_revision"))
    for t in ("performance_ledger", "daily_activity_results", "daily_evaluations", "performance_snapshots",
              "draft_versions", "drafts", "alert_revisions", "alerts", "agent_jobs", "agent_runs", "milestones",
              "activity_plan", "performance_settings", "plan_baselines", "observations", "plan_targets",
              "activity_dependencies", "activities", "ingestion_jobs", "source_passages", "sources", "project_members"):
        c.execute(text(f"DELETE FROM sitemate.{t} WHERE project_id=:p"), {"p": PID})
    for t in IMMUTABLE:
        c.execute(text(f"ALTER TABLE sitemate.{t} ENABLE TRIGGER keep_revision"))
    c.execute(text("DELETE FROM sitemate.projects WHERE id=:p"), {"p": PID})


@pytest.fixture()
def api(tmp_path, monkeypatch):
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
        c.execute(text("""INSERT INTO sitemate.projects (id, name, timezone, threshold, high_threshold, recipient)
                          VALUES (:p, 'Perf test', 'Europe/Berlin', 10, 20, 'Client PM')"""), {"p": PID})
        c.execute(text("INSERT INTO sitemate.project_members (project_id, member_id, token_hash, role) "
                       "VALUES (:p, 'mgr', :h, 'manager')"), {"p": PID, "h": hashlib.sha256(TOKEN.encode()).hexdigest()})
    yield TestClient(app), eng
    with eng.begin() as c:
        _clean(c)


H = {"Authorization": f"Bearer {TOKEN}"}


def _record(c, source_id, kind, at, passages, observations=()):
    c.execute(text("""INSERT INTO sitemate.sources (project_id, id, kind, path, available_at, author_role)
                      VALUES (:p, :s, :k, 'inline:test', :at, :r)"""),
              {"p": PID, "s": source_id, "k": kind, "at": at, "r": "signed_report" if kind == "daily_report" else "client"})
    for locator, excerpt in passages:
        c.execute(text("""INSERT INTO sitemate.source_passages (project_id, source_id, locator, excerpt, untrusted)
                          VALUES (:p, :s, :l, :e, :u)"""), {"p": PID, "s": source_id, "l": locator, "e": excerpt,
                                                           "u": kind == "email"})
    for code, day, qty, locator in observations:
        c.execute(text("""INSERT INTO sitemate.observations (project_id, activity_code, work_date, source_id, locator,
                          quantity, basis) VALUES (:p, :c, :d, :s, :l, :q, 'signed')"""),
                  {"p": PID, "c": code, "d": day, "s": source_id, "l": locator, "q": qty})


def test_csv_plan_to_client_caused_delay_notice(api):
    client, eng = api
    r = client.post(f"/projects/{PID}/baselines", headers=H,
                    files=[("files", ("schedule.csv", CSV.encode(), "text/csv"))],
                    data={"available_at": "2026-11-01T08:00:00+01:00"})
    assert r.status_code == 202, r.text
    bid = r.json()["id"]
    b = client.get(f"/projects/{PID}/baselines/{bid}", headers=H).json()
    assert b["extraction_status"] == "done" and b["counts"]["activities"] == 3 and b["status"] == "draft", b
    with eng.connect() as c:  # the extraction ran as a durable job row, claimed and finished by the API process
        job = c.execute(text("SELECT status, locked_by FROM sitemate.agent_jobs WHERE project_id=:p AND kind='plan_extract'"),
                        {"p": PID}).one()
        assert job.status == "done" and job.locked_by is None
    assert client.get(f"/projects/{PID}/daily-evaluations/2026-11-03", headers=H).json()["activities"] == []  # not active
    act = client.post(f"/projects/{PID}/baselines/{bid}/activate?as_of=2026-11-01T09:00:00%2B01:00", headers=H)
    assert act.status_code == 200, act.text
    assert act.json()["critical"] == ["A1", "A2"]
    assert client.post(f"/projects/{PID}/baselines/{bid}/activate", headers=H).status_code == 409  # only drafts

    with eng.begin() as c:
        src = c.scalar(text("SELECT source_ids[1] FROM sitemate.plan_baselines WHERE project_id=:p"), {"p": PID})
        _record(c, "R2", "daily_report", "2026-11-02T17:30:00+01:00", [("A1", "A1: actual 10 m3"), ("B1", "B1: actual 25 m2")],
                [("A1", "2026-11-02", 10, "A1"), ("B1", "2026-11-02", 25, "B1")])
        _record(c, "E1", "email", "2026-11-03T09:00:00+01:00",
                [("body.1", "The client instructed us to stop digging the pit until the revised drawing is issued.")])
        _record(c, "R3", "daily_report", "2026-11-03T17:30:00+01:00", [("A1", "A1: actual 5 m3"), ("B1", "B1: actual 15 m2")],
                [("A1", "2026-11-03", 5, "A1"), ("B1", "2026-11-03", 15, "B1")])
        assert c.scalar(text("SELECT count(*) FROM sitemate.plan_targets WHERE project_id=:p AND source_id=:s"),
                        {"p": PID, "s": src}) == 15

    from performance import daily
    from performance.prompts import FakeModels

    def p2(system, content):
        return {"headline": {"text": "A1 stopped on client instruction.", "refs": ["E1:body.1"]},
                "work_done": [{"text": "A1 reached 5 m3.", "refs": ["R3:A1"], "activity_code": "A1"}],
                "disruptions": [{"text": "Digging stopped until the revised drawing.", "refs": ["E1:body.1"],
                                 "activity_code": "A1"}],
                "resources": [], "deliveries": [], "weather": [], "safety_quality": [], "open_items": [],
                "instructions_received": [{"text": "Client stop instruction pending a revised drawing.", "refs": ["E1:body.1"],
                                           "concern": True, "quoted": False, "activity_code": "A1"}]}

    def p3(system, content):
        payload = json.loads(content.split("\n\n", 1)[1])
        assert {r["subject"] for r in payload["rows"]} == {"A1", "B1"}
        return {"attributions": [
            {"activity_code": "A1", "explanation": "The client instructed a stop pending a revised drawing.",
             "cause_category": "client", "responsible_party_ref": None, "confidence": 0.8, "refs": ["E1:body.1"]},
            {"activity_code": "B1", "explanation": "Painters were slow.", "cause_category": "subcontractor",
             "responsible_party_ref": None, "confidence": 0.9, "refs": []}]}

    with eng.begin() as c:
        out = daily.evaluate_day(c, PID, date(2026, 11, 3), datetime.fromisoformat("2026-11-03T18:30:00+01:00"),
                                 models=FakeModels(p2, p3), trigger="test")
    assert out["version"] == 2 and out["status"] == "ok"  # v1: the on-demand GET before activation
    view = client.get(f"/projects/{PID}/daily-evaluations/2026-11-03?as_of=2026-11-03T18:30:00%2B01:00", headers=H).json()
    rows = {a["code"]: a for a in view["activities"]}
    a1, b1 = rows["A1"], rows["B1"]
    assert (a1["status"], a1["severity"], a1["variance_pct"]) == ("behind", "red", -50)
    assert a1["attribution"]["cause_category"] == "client" and a1["attribution"]["excusable"]
    assert b1["attribution"]["cause_category"] == "unknown" and "no_valid_refs" in b1["attribution"]["flags"]
    assert view["summary"]["headline"]["source"] == "model" and view["disclaimer"].startswith("Drafting support only")
    kinds = {s["type"]: s for s in view["suggestions"]}
    # Red deviation, critical activity, client cause -> delay notice; deadline 5 working days (7-day CSV calendar).
    assert kinds["delay_notice"]["deadline"] == "2026-11-08" and kinds["delay_notice"]["alert_id"]
    assert kinds["notice_of_concern"]["deadline"] == "2026-11-03"
    ledger = {(e["subject"], e["rule_key"]): e for e in view["ledger"]}
    assert ledger[("A1", "day.shortfall_red")]["excusable"] and ledger[("B1", "day.shortfall_red")]["points"] == -3
    assert view["day_score"] == -3  # the client-caused demerit is excusable

    draft = client.post(f"/projects/{PID}/drafts", headers=H, json={"alert_id": kinds["delay_notice"]["alert_id"]})
    assert draft.status_code == 201, draft.text
    assert draft.json()["notice_type"] == "delay_notice" and "DELAY NOTICE" in draft.json()["latest"]["body"]
    assert draft.json()["origin"] == "manual" and draft.json()["status"] == "awaiting_review"

    # Automatic correspondence: the evaluation queued one auto_draft job per suggestion; the worker writes private
    # drafts. The manager's delay notice above already exists for that alert, so only the concern notice is new.
    assert out["auto_drafts_queued"] == len(kinds) and kinds["notice_of_concern"]["alert_id"]
    from app import worker
    while worker.process_one(eng, lambda: None):
        pass
    with eng.connect() as c:
        failed = c.execute(text("SELECT kind, last_error FROM sitemate.agent_jobs WHERE project_id=:p AND status='failed'"),
                           {"p": PID}).all()
        assert not failed, failed
        drafts = {r.notice_type: r for r in c.execute(text(
            "SELECT notice_type, origin, submitted_at FROM sitemate.drafts WHERE project_id=:p"), {"p": PID})}
    assert drafts["delay_notice"].origin == "manual"
    concern = drafts["notice_of_concern"]
    assert concern.origin == "alert_auto" and concern.submitted_at is None
    listed = {d["notice_type"]: d for d in client.get(f"/projects/{PID}/drafts", headers=H).json()}
    assert listed["notice_of_concern"]["status"] == "draft"  # private until the manager submits it
    assert "revised drawing" in listed["notice_of_concern"]["latest"]["body"]

    entry = ledger[("B1", "day.shortfall_red")]
    assert client.patch(f"/projects/{PID}/performance/ledger/{entry['id']}", headers=H,
                        json={"status": "disputed"}).status_code == 422
    ok = client.patch(f"/projects/{PID}/performance/ledger/{entry['id']}?as_of=2026-11-03T19:00:00%2B01:00", headers=H,
                      json={"status": "disputed", "note": "Paint delivery was late"})
    assert ok.json()["status"] == "disputed"
    led = client.get(f"/projects/{PID}/performance/ledger?to=2026-11-03&as_of=2026-11-03T19:30:00%2B01:00", headers=H).json()
    assert led["score"] == 0  # excusable A1 and disputed B1 both leave the score
    before = client.get(f"/projects/{PID}/performance/ledger?to=2026-11-03&as_of=2026-11-03T18:45:00%2B01:00", headers=H).json()
    assert before["score"] == -3  # replay before the dispute

    perf = client.get(f"/projects/{PID}/performance?date=2026-11-03&as_of=2026-11-03T19:30:00%2B01:00", headers=H).json()
    m = perf["metrics"]
    # planned to 3 Nov: A1 20/30, B1 40/40; actual A1 15, B1 40. Duration weights A1 3, A2 2, B1 2 (of 7).
    assert (m["weighted_planned_pct"], m["weighted_actual_pct"]) == (round(100 * (3 / 7 * 20 / 30 + 2 / 7), 2),
                                                                     round(100 * (3 / 7 * 15 / 30 + 2 / 7), 2))
    assert m["attribution"]["excusable_days"] == 0.5 and perf["narrative"]["disclaimer"]
    pdf = client.get(f"/projects/{PID}/performance/report.pdf?date=2026-11-03", headers=H)
    docx = client.get(f"/projects/{PID}/performance/report.docx?date=2026-11-03", headers=H)
    assert pdf.content.startswith(b"%PDF") and docx.content[:2] == b"PK"


def test_daily_jobs_are_debounced_and_run_by_the_worker(api, monkeypatch):
    client, eng = api
    from app import worker
    with eng.begin() as c:
        c.execute(text("""INSERT INTO sitemate.activities (project_id, code, name, unit, zone) VALUES (:p,'X','X','m','z')"""),
                  {"p": PID})
    with eng.connect() as c:
        worker.enqueue_daily_eval(c, PID, "2026-11-03", trigger="capture_event")
        worker.enqueue_daily_eval(c, PID, "2026-11-03", trigger="signed_report")
        worker.enqueue_daily_eval(c, PID, "2026-11-04", trigger="signed_report")
        c.commit()
        jobs = c.execute(text("SELECT payload->>'work_date' AS d, run_after > now() + interval '90 seconds' AS later "
                              "FROM sitemate.agent_jobs WHERE project_id=:p AND kind='daily_eval' ORDER BY 1"),
                         {"p": PID}).mappings().all()
        assert [j["d"] for j in jobs] == ["2026-11-03", "2026-11-04"] and all(j["later"] for j in jobs)
        c.execute(text("UPDATE sitemate.agent_jobs SET run_after = now() - interval '1 second' WHERE project_id=:p"), {"p": PID})
        c.commit()
    from performance.prompts import FakeModels, ModelError
    import performance.daily as daily_module
    monkeypatch.setattr(daily_module, "Models", lambda: FakeModels(ModelError("no model in tests")))
    assert worker.process_one(eng, lambda: None)
    with eng.connect() as c:
        done = c.execute(text("SELECT status, last_error FROM sitemate.agent_jobs WHERE project_id=:p AND kind='daily_eval' "
                              "AND status <> 'queued'"), {"p": PID}).mappings().all()
        assert done and done[0]["status"] == "done", done
        assert c.scalar(text("SELECT count(*) FROM sitemate.daily_evaluations WHERE project_id=:p"), {"p": PID}) == 1


def test_activation_refuses_an_activity_without_a_citation(api):
    client, eng = api
    r = client.post(f"/projects/{PID}/baselines", headers=H,
                    files=[("files", ("schedule.csv", CSV.encode(), "text/csv"))],
                    data={"available_at": "2026-11-01T08:00:00+01:00"})
    bid = r.json()["id"]
    detail = client.get(f"/projects/{PID}/baselines/{bid}", headers=H).json()
    rows = detail["extracted"]["activities"]
    rows.append({**rows[0], "code": "NEW", "refs": []})  # a row the manager typed in, citing nothing
    edited = client.patch(f"/projects/{PID}/baselines/{bid}", headers=H, json={"activities": rows})
    assert edited.status_code == 200, edited.text
    act = client.post(f"/projects/{PID}/baselines/{bid}/activate", headers=H)
    assert act.status_code == 409 and "NEW" in act.json()["detail"], act.text
    with eng.connect() as c:  # nothing was written
        assert c.scalar(text("SELECT count(*) FROM sitemate.plan_targets WHERE project_id=:p"), {"p": PID}) == 0
