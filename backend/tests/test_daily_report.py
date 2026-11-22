"""Daily report drafts and appointments (scripted model, scratch DB).

    TEST_DATABASE_URL=postgresql+psycopg://postgres@127.0.0.1:54329/sm  pytest backend/tests/test_daily_report.py
"""

import hashlib
import os
import sys
from datetime import date, datetime
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "ai-agent"))

URL = os.environ.get("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not URL, reason="set TEST_DATABASE_URL to run daily report tests")
PID, TOKEN, FOREMAN = "DRPTEST", "tok-drp-manager", "tok-drp-foreman"
H = {"Authorization": f"Bearer {TOKEN}"}
AT = "?as_of=2026-11-10T18:30:00%2B01:00"
WHEN = datetime.fromisoformat("2026-11-10T18:30:00+01:00")
PROTECTED = ("draft_versions", "reviews", "draft_gap_resolutions", "appointments")


def _clean(c):
    for t in PROTECTED:
        c.execute(text(f"ALTER TABLE sitemate.{t} DISABLE TRIGGER keep_revision"))
    for t in ("exports", "draft_gap_resolutions", "reviews", "draft_versions", "drafts", "appointments", "action_items",
              "document_summaries", "observations", "plan_targets", "equipment_assignments", "equipment",
              "source_passages", "sources", "activities", "contractors", "project_members"):
        c.execute(text(f"DELETE FROM sitemate.{t} WHERE project_id=:p"), {"p": PID})
    for t in PROTECTED:
        c.execute(text(f"ALTER TABLE sitemate.{t} ENABLE TRIGGER keep_revision"))
    c.execute(text("DELETE FROM sitemate.projects WHERE id=:p"), {"p": PID})


@pytest.fixture()
def eng():
    os.environ["DATABASE_URL"] = os.environ.get("TEST_READER_URL", URL)
    os.environ["MIGRATION_DATABASE_URL"] = URL
    os.environ.pop("WRITER_DATABASE_URL", None)
    from database import engine_for
    engine_for.cache_clear()
    e = create_engine(URL)
    with e.begin() as c:
        _clean(c)
        c.execute(text("INSERT INTO sitemate.projects (id, name, timezone, threshold, high_threshold) "
                       "VALUES (:p, 'Riverside test', 'Europe/Berlin', 15, 25)"), {"p": PID})
        for m, tok, role, name in (("mgr", TOKEN, "manager", "Sam Reed"), ("fm", FOREMAN, "contributor", "Foreman B")):
            c.execute(text("INSERT INTO sitemate.project_members (project_id, member_id, token_hash, role, display_name) "
                           "VALUES (:p, :m, :h, :r, :n)"),
                      {"p": PID, "m": m, "h": hashlib.sha256(tok.encode()).hexdigest(), "r": role, "n": name})
        c.execute(text("INSERT INTO sitemate.contractors VALUES (:p, 'GW', 'GroundWorks', 'earthworks', 'Site lead')"),
                  {"p": PID})
        c.execute(text("INSERT INTO sitemate.activities (project_id, code, name, unit, zone, contractor_id) "
                       "VALUES (:p, 'EXC-B', 'Excavation Zone B', 'm3', 'B', 'GW')"), {"p": PID})
        c.execute(text("INSERT INTO sitemate.equipment VALUES (:p, 'EX-02', 'Tracked excavator', 'GW')"), {"p": PID})
        c.execute(text("INSERT INTO sitemate.equipment_assignments VALUES (:p, 'EX-02', '2026-11-10', 'EXC-B')"),
                  {"p": PID})
        for sid, kind, at, loc, excerpt in (
                ("SCH", "schedule", "2026-11-06T08:00:00+01:00", "EXC-B", "EXC-B 100 m3 per day"),
                ("M07", "minutes", "2026-11-07T12:40:00+01:00", "actions.1",
                 "GroundWorks to send the backup excavator plan by 10 November 12:00."),
                ("D10", "diary", "2026-11-10T15:00:00+01:00", "handover", "Approx. 70 m3 dug so far; rain from 14:00."),
                ("P1", "photo", "2026-11-10T11:00:00+01:00", "caption", "Burst hydraulic hose on EX-02 in Zone B."),
                ("R10", "daily_report", "2026-11-10T17:30:00+01:00", "EXC-B", "EXC-B: actual 65 m3")):
            c.execute(text("INSERT INTO sitemate.sources (project_id, id, kind, path, available_at) "
                           "VALUES (:p, :s, :k, 'inline:test', :at)"), {"p": PID, "s": sid, "k": kind, "at": at})
            c.execute(text("INSERT INTO sitemate.source_passages (project_id, source_id, locator, excerpt) "
                           "VALUES (:p, :s, :l, :e)"), {"p": PID, "s": sid, "l": loc, "e": excerpt})
        c.execute(text("INSERT INTO sitemate.plan_targets VALUES (:p, 'EXC-B', '2026-11-10', 100, 'SCH', 'EXC-B')"),
                  {"p": PID})
        c.execute(text("""INSERT INTO sitemate.observations (project_id, activity_code, work_date, source_id, locator,
                          quantity, basis) VALUES (:p, 'EXC-B', '2026-11-10', 'R10', 'EXC-B', 65, 'signed'),
                          (:p, 'EXC-B', '2026-11-10', 'D10', 'handover', 70, 'estimated')"""), {"p": PID})
        c.execute(text("""INSERT INTO sitemate.action_items (project_id, description, owner_name, due_at, source_id, locator)
                          VALUES (:p, 'Send the backup excavator plan', 'GroundWorks', '2026-11-10T12:00:00+01:00',
                                  'M07', 'actions.1')"""), {"p": PID})
    yield e
    with e.begin() as c:
        _clean(c)


def _p5(**overrides):
    base = {"weather": [{"text": "Rain from 14:00.", "refs": ["D10:handover"]}],
            "workforce": [{"text": "Three workers stood idle for 9 hours.", "refs": ["D10:handover"]}],  # unsupported
            "deliveries": [], "instructions_received": [], "safety_quality": [],
            "open_items": [{"text": "Backup excavator plan from GroundWorks.", "refs": ["M07:actions.1"],
                            "owner": "GroundWorks", "due": None}],
            "remarks": [{"text": "A hose failure on EX-02 cut output.", "refs": ["P1:caption"]},
                        {"text": "The client caused it.", "refs": ["X:1"]}]}
    return base | overrides


def test_draft_figures_remarks_and_redraft(eng):
    from daily_report.draft import draft_daily_report
    from performance.prompts import FakeModels
    with eng.begin() as c:
        out = draft_daily_report(c, PID, date(2026, 11, 10), WHEN, member_id="mgr", models=FakeModels(_p5()))
        body = c.scalar(text("SELECT body FROM sitemate.draft_versions WHERE project_id=:p"), {"p": PID})
    assert out["changed"] and out["version"] == 1 and out["remarks_source"] == "model"
    assert len(out["dropped"]) == 2  # the unsupported 9 hours and the invented ref
    assert "DAILY SITE REPORT (DRAFT FOR REVIEW)" in body and "Prepared by: Sam Reed" in body
    assert "EXC-B Excavation Zone B: planned 100, signed 65 m3 (-35%), behind [SCH · EXC-B; R10 · EXC-B]" in body
    assert "EX-02 Tracked excavator assigned to EXC-B" in body
    assert "Rain from 14:00. [D10 · handover]" in body and "Three workers" not in body and "client caused" not in body
    assert "Send the backup excavator plan (GroundWorks, due 10 Nov 12:00) [M07 · actions.1]" in body
    assert "Burst hydraulic hose on EX-02 in Zone B. [P1 · caption]" in body
    assert "Shift: [MISSING: shift hours]" in body and out["missing"] == ["shift hours"]
    # Same inputs: no new version. A new appointment: version 2.
    with eng.begin() as c:
        again = draft_daily_report(c, PID, date(2026, 11, 10), WHEN, member_id="mgr", models=FakeModels(_p5()))
        assert not again["changed"] and again["version"] == 1
        from daily_report import appointments as appt
        appt.create(c, PID, {"kind": "inspection", "title": "Formation level inspection",
                             "starts_at": datetime.fromisoformat("2026-11-10T15:30:00+01:00"), "location": "Zone B"},
                    "mgr", WHEN)
        third = draft_daily_report(c, PID, date(2026, 11, 10), WHEN, member_id="mgr", models=FakeModels(_p5()))
        body = c.scalar(text("SELECT body FROM sitemate.draft_versions WHERE project_id=:p AND version=2"), {"p": PID})
    assert third["changed"] and third["version"] == 2
    assert "15:30 inspection: Formation level inspection, Zone B" in body


def test_without_a_model_the_figures_still_come_and_remarks_stay_missing(eng):
    from daily_report.draft import draft_daily_report
    from performance.prompts import FakeModels, ModelError
    with eng.begin() as c:
        out = draft_daily_report(c, PID, date(2026, 11, 10), WHEN, models=FakeModels(ModelError("offline")))
        body = c.scalar(text("SELECT body FROM sitemate.draft_versions WHERE project_id=:p"), {"p": PID})
    assert out["remarks_source"] == "none" and "[MISSING: remarks]" in body and "signed 65 m3" in body
    assert "[MISSING: site manager signature]" in body


def test_routes_appointments_extraction_and_lifecycle(eng, monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from documents import storage
    monkeypatch.setattr(storage, "STORAGE_ROOT", tmp_path)
    from daily_report import draft as dr
    from performance.prompts import FakeModels
    monkeypatch.setattr(dr, "Models", lambda: FakeModels(_p5(), _p5(), _p5()))
    from main import app
    client = TestClient(app)
    base = f"/projects/{PID}"

    # Extraction proposes the minutes deadline; confirming it saves a cited appointment (foreman may add).
    props = client.post(f"{base}/appointments/extract{AT}", headers=H, json={"date": "2026-11-10"}).json()["proposals"]
    assert [p["source_id"] for p in props] == ["M07"] and props[0]["kind"] == "deadline"
    add = client.post(f"{base}/appointments{AT}", headers={"Authorization": f"Bearer {FOREMAN}"},
                      json={**{k: props[0][k] for k in ("kind", "title", "starts_at", "source_id", "locator")}})
    assert add.status_code == 201, add.text
    assert add.json()["origin"] == "extracted" and add.json()["local_time"] == "12:00"
    assert client.post(f"{base}/appointments/extract{AT}", headers=H, json={"date": "2026-11-10"}).json()["proposals"] == []
    moved = client.post(f"{base}/appointments/{add.json()['id']}/supersede{AT}", headers=H,
                        json={"kind": "deadline", "title": "Backup plan (moved)", "starts_at": "2026-11-10T16:00:00+01:00",
                              "status": "moved"})
    assert moved.status_code == 201
    day = client.get(f"{base}/appointments?date=2026-11-10", headers=H).json()
    assert [a["title"] for a in day] == ["Backup plan (moved)"]
    early = client.get(f"{base}/appointments?date=2026-11-10&as_of=2026-11-10T09:00:00%2B01:00", headers=H).json()
    assert early == []  # recorded at 18:30: not visible earlier
    assert client.post(f"{base}/appointments{AT}", headers=H,
                       json={"kind": "visit", "title": "x", "starts_at": "2026-11-10T09:00:00"}).status_code == 422

    # Draft, fill the shift, submit, approve, export.
    r = client.post(f"{base}/daily-reports{AT}", headers=H, json={"work_date": "2026-11-10"})
    assert r.status_code == 201, r.text
    d = r.json()["draft"]
    assert d["notice_type"] == "daily_report" and d["origin"] == "daily_report" and d["status"] == "draft"
    assert d["work_date"] == "2026-11-10" and "16:00 deadline: Backup plan (moved) (moved)" in d["latest"]["body"]
    assert client.post(f"{base}/daily-reports{AT}", headers=H, json={"work_date": "2026-11-12"}).status_code == 422
    url = f"{base}/drafts/{d['id']}"
    d = client.post(f"{url}/versions/1/gaps{AT}", headers=H,
                    json={"field": "shift hours", "resolution": "filled", "value": "07:00–17:30"}).json()
    assert d["latest"]["missing_fields"] == []
    assert client.post(f"{url}/submit{AT}", headers=H).json()["status"] == "awaiting_review"
    listed = client.get(f"{base}/daily-reports", headers=H).json()
    assert [x["id"] for x in listed] == [d["id"]]
