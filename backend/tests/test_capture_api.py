"""HTTP tests for the capture routes served by FastAPI (fake LLM, scratch database). See test_ops_api.py for setup."""

import hashlib
import os
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text

URL = os.environ.get("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not URL, reason="set TEST_DATABASE_URL to run API tests")
PID = "CAPITEST"
HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "ai-agent"))

sha = lambda t: hashlib.sha256(t.encode()).hexdigest()  # noqa: E731
AUTH = {"Authorization": "Bearer tok-writer"}
PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 32


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_UPLOAD_DIR", str(tmp_path / "a"))  # the audio route reads the same configured directory
    monkeypatch.setenv("AGENT_IMAGE_DIR", str(tmp_path / "i"))
    os.environ["DATABASE_URL"] = os.environ.get("TEST_READER_URL", URL)
    os.environ["OPS_DATABASE_URL"] = os.environ.get("TEST_OPS_URL", URL)
    from database import engine_for
    engine_for.cache_clear()
    from fastapi.testclient import TestClient
    from app.capture.pipeline import CaptureService
    from app.capture.storage import DiskStorage
    from capture import get_capture_service
    from main import app
    from tests.test_capture_pipeline import FakeLLM

    admin = create_engine(URL)
    with admin.begin() as c:
        _clean(c)
        c.execute(text("INSERT INTO sitemate.projects (id,name,timezone,threshold,high_threshold) VALUES (:p,'c','UTC',10,30)"), {"p": PID})
        for m, role in (("writer", "contributor"), ("other", "contributor"), ("viewer", "viewer"), ("manager", "manager")):
            c.execute(text("INSERT INTO sitemate.project_members (project_id,member_id,token_hash,role) VALUES (:p,:m,:h,:r)"),
                      {"p": PID, "m": m, "h": sha(f"tok-{m}"), "r": role})
    service = CaptureService(create_engine(os.environ.get("TEST_AGENT_URL", URL)), FakeLLM(),
                             images=DiskStorage(tmp_path / "i"), audio=DiskStorage(tmp_path / "a"),
                             transcribe=lambda *a: "spoken", transcription_on=lambda: False)
    app.dependency_overrides[get_capture_service] = lambda: service
    yield TestClient(app)
    app.dependency_overrides.clear()
    with admin.begin() as c:
        _clean(c)


def _clean(c):
    for t in ("alert_revisions", "incident_severity_history"):
        c.execute(text(f"ALTER TABLE sitemate.{t} DISABLE TRIGGER keep_revision"))
        c.execute(text(f"DELETE FROM sitemate.{t} WHERE project_id=:p"), {"p": PID})
        c.execute(text(f"ALTER TABLE sitemate.{t} ENABLE TRIGGER keep_revision"))
    for t in ("agent_runs", "agent_jobs", "alert_activity", "incident_events", "alerts", "fact_evidence", "capture_facts", "events",
              "capture_attachments", "captures", "incidents", "source_passages", "sources", "project_members"):
        c.execute(text(f"DELETE FROM sitemate.{t} WHERE project_id=:p"), {"p": PID})
    c.execute(text("DELETE FROM sitemate.projects WHERE id=:p"), {"p": PID})


def test_auth_and_validation(client):
    url = f"/projects/{PID}/captures"
    assert client.post(url).status_code in (401, 403)
    assert client.post(url, headers={"Authorization": "Bearer tok-viewer"}, data={"transcript": "x"}).status_code == 403
    r = client.post(url, headers=AUTH, data={"recorded_at": "2026-01-01T00:00:00Z"})
    assert r.status_code == 422 and "transcript" in r.json()["detail"]
    r = client.post(url, headers=AUTH, files=[("images", ("a.txt", b"hi", "text/plain"))])
    assert r.status_code == 422 and "JPEG" in r.json()["detail"]
    r = client.post(url, headers=AUTH, files=[("audio", ("n.webm", b"x", "audio/webm"))])
    assert r.status_code == 422 and "not configured" in r.json()["detail"]
    r = client.post(url, headers={"Authorization": "Bearer tok-manager"}, files=[("audio", ("n.webm", b"x", "audio/webm"))])
    assert r.status_code == 403
    assert client.post(url, headers={"Authorization": "Bearer tok-manager"}, data={"transcript": "A typed note"}).status_code == 403
    r = client.post(url, headers=AUTH, files=[("images", (f"{i}.png", PNG, "image/png")) for i in range(6)])
    assert r.status_code == 422
    assert client.post(f"{url}/00000000-0000-0000-0000-000000000000/categories", headers=AUTH, json={"events": []}).status_code == 404
    assert client.post(f"{url}/00000000-0000-0000-0000-000000000000/answers", headers=AUTH, json={"answers": []}).status_code == 404


def run_to_review(client, text_="The lift is not working", files=None, headers=AUTH):
    url = f"/projects/{PID}/captures"
    r = client.post(url, headers=headers, data={"transcript": text_}, files=files or [])
    assert r.status_code == 202
    body = r.json()
    r = client.post(f"{url}/{body['thread_id']}/categories", headers=headers,
                    json={"events": [{"index": 0, "category": "equipment", "event_type": "equipment_failure", "keep": True}], "added": []})
    while r.status_code == 202 and r.json()["status"] == "needs_input":  # business rules ask for details
        qs = r.json()["questions"]
        r = client.post(f"{url}/{body['thread_id']}/answers", headers=headers, json={"answers": [{"id": x["id"], "answer": "unknown"} for x in qs]})
    assert r.status_code == 202 and r.json()["status"] == "needs_review"
    return url, body, r.json()


def test_multipart_capture_confirm_answer_review_and_save(client):
    url = f"/projects/{PID}/captures"
    r = client.post(url, headers=AUTH, data={"transcript": "The lift is not working"}, files=[("images", ("p.png", PNG, "image/png"))])
    assert r.status_code == 202
    body = r.json()
    assert body["status"] == "needs_category" and body["events"][0]["suggested_category"] == "equipment"
    assert body["photo_descriptions"][0]["n"] == 1
    r = client.post(f"{url}/{body['thread_id']}/categories", headers=AUTH,
                    json={"events": [{"index": 0, "category": "equipment", "event_type": "equipment_failure", "keep": True}], "added": []})
    assert r.status_code == 202 and r.json()["status"] == "needs_input"  # business rule asks for details
    qs = r.json()["questions"]
    assert qs[0]["field_name"]  # the UI picks a date-time input from the field name
    r = client.post(f"{url}/{body['thread_id']}/answers", headers=AUTH, json={"answers": [{"id": x["id"], "answer": "unknown"} for x in qs]})
    assert r.status_code == 202 and r.json()["status"] == "needs_review"  # the speaker's last look before saving
    assert client.post(f"{url}/{body['thread_id']}/review", headers={"Authorization": "Bearer tok-other"}, json={}).status_code == 403
    r = client.post(f"{url}/{body['thread_id']}/review", headers=AUTH, json={})
    assert r.status_code == 201
    saved = r.json()
    assert saved["status"] == "saved" and saved["incident_links"][0]["created"] is True and saved["incident_links"][0]["severity"] == "medium"
    # the same endpoints the UI reads now show the incident
    incidents = client.get(f"/projects/{PID}/incidents", headers=AUTH).json()
    assert incidents[0]["report_count"] == 1 and incidents[0]["category"] == "equipment"
    assert client.post(f"{url}/{body['thread_id']}/review", headers=AUTH, json={}).status_code == 404


def test_review_validation_and_discard(client):
    url, body, review = run_to_review(client)
    r = client.post(f"{url}/{body['thread_id']}/review", headers=AUTH, json={"additions": [
        {"event_index": 0, "field_name": "occurred_at", "value": "yesterday-ish"}]})
    assert r.status_code == 422 and "date and time" in r.json()["detail"]
    assert client.post(f"{url}/{body['thread_id']}/review", headers=AUTH, json={"discard": True}).json() == {"status": "discarded"}
    assert client.get(url, headers=AUTH).json() == {"recordings": []}


def test_recordings_list_and_audio_playback(client, tmp_path):
    client.app.dependency_overrides  # noqa: B018  (the service fixture already stores audio under tmp_path)
    from capture import get_capture_service
    service = client.app.dependency_overrides[get_capture_service]()
    service.transcription_on = lambda: True
    url = f"/projects/{PID}/captures"
    r = client.post(url, headers=AUTH, files=[("audio", ("note.webm", b"RIFFfakeaudio", "audio/webm"))])
    assert r.status_code == 202 and r.json()["transcript"] == "spoken"
    thread = r.json()["thread_id"]
    r = client.post(f"{url}/{thread}/categories", headers=AUTH, json={"events": []})
    while r.json()["status"] == "needs_input":
        r = client.post(f"{url}/{thread}/answers", headers=AUTH, json={"answers": [{"id": x["id"], "answer": "unknown"} for x in r.json()["questions"]]})
    assert client.get(url, headers=AUTH).json() == {"recordings": []}  # not saved yet: not listed
    assert client.post(f"{url}/{thread}/review", headers=AUTH, json={}).status_code == 201
    mine = client.get(url, headers=AUTH).json()["recordings"]
    assert len(mine) == 1 and mine[0]["has_audio"] is True and mine[0]["author"] == "writer" and mine[0]["transcript"] == "spoken"
    assert mine[0]["incidents"] and mine[0]["incidents"][0]["category"] == "equipment"
    # another member does not see it; the owner can play it, with Range support for seeking
    assert client.get(url, headers={"Authorization": "Bearer tok-other"}).json() == {"recordings": []}
    audio = f"{url}/{mine[0]['id']}/audio"
    assert client.get(audio, headers={"Authorization": "Bearer tok-other"}).status_code == 404
    r = client.get(audio, headers=AUTH)
    assert r.status_code == 200 and r.content == b"RIFFfakeaudio" and r.headers["content-type"].startswith("audio/webm")
    r = client.get(audio, headers={**AUTH, "Range": "bytes=0-3"})
    assert r.status_code == 206 and r.content == b"RIFF"
    service.audio.path(f"{PID}/{mine[0]['id']}.webm").unlink()
    assert client.get(url, headers=AUTH).json()["recordings"][0]["has_audio"] is False
    assert client.get(audio, headers=AUTH).status_code == 404
    assert client.get(f"{url}/CAP-NOPE/audio", headers=AUTH).status_code == 404


def test_event_categories_for_any_member(client):
    r = client.get(f"/projects/{PID}/event-categories", headers={"Authorization": "Bearer tok-viewer"})
    assert r.status_code == 200
    cats = {c["key"]: c for c in r.json()}
    assert cats["equipment"]["creates_incident"] is True and cats["progress"]["creates_incident"] is False
    assert {t["key"] for t in cats["safety"]["types"]} >= {"injury", "near_miss"}


def test_unconfigured_capture_returns_503(client):
    from capture import get_capture_service
    from main import app
    app.dependency_overrides.clear()
    os.environ.pop("AGENT_DATABASE_URL", None)
    get_capture_service.__globals__["_service"].cache_clear()
    assert client.post(f"/projects/{PID}/captures", headers=AUTH, data={"transcript": "x"}).status_code == 503
