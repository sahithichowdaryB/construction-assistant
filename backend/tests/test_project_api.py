"""GET /projects/{pid} and /activities (scratch DB)."""

import hashlib
import os
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "ai-agent"))

URL = os.environ.get("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not URL, reason="set TEST_DATABASE_URL")
PID, TOKEN = "PRJTEST", "tok-prj"
H = {"Authorization": f"Bearer {TOKEN}"}


def _clean(c):
    for t in ("plan_targets", "activity_dependencies", "source_passages", "sources", "activities", "project_members"):
        c.execute(text(f"DELETE FROM sitemate.{t} WHERE project_id=:p"), {"p": PID})
    c.execute(text("DELETE FROM sitemate.projects WHERE id=:p"), {"p": PID})


@pytest.fixture()
def client():
    os.environ["DATABASE_URL"] = os.environ.get("TEST_READER_URL", URL)
    os.environ["MIGRATION_DATABASE_URL"] = URL
    from database import engine_for
    engine_for.cache_clear()
    from fastapi.testclient import TestClient
    from main import app
    eng = create_engine(URL)
    with eng.begin() as c:
        _clean(c)
        c.execute(text("INSERT INTO sitemate.projects (id, name, timezone, threshold, high_threshold, recipient) "
                       "VALUES (:p, 'Proj', 'Europe/Berlin', 15, 25, 'Client')"), {"p": PID})
        c.execute(text("INSERT INTO sitemate.project_members (project_id, member_id, token_hash, role) VALUES (:p,'m',:h,'viewer')"),
                  {"p": PID, "h": hashlib.sha256(TOKEN.encode()).hexdigest()})
        c.execute(text("INSERT INTO sitemate.activities (project_id, code, name, unit, zone) VALUES "
                       "(:p,'A','Dig','m3','Z'), (:p,'B','Pour','m3','Z')"), {"p": PID})
        c.execute(text("INSERT INTO sitemate.activity_dependencies VALUES (:p,'A','B')"), {"p": PID})
        c.execute(text("INSERT INTO sitemate.sources (project_id,id,kind,path,available_at) VALUES "
                       "(:p,'SCH','schedule','x','2026-11-01T08:00:00+01:00')"), {"p": PID})
        c.execute(text("INSERT INTO sitemate.source_passages (project_id,source_id,locator,excerpt) VALUES "
                       "(:p,'SCH','A','A'), (:p,'SCH','B','B')"), {"p": PID})
        for code, day, q in (("A", "2026-11-02", 10), ("A", "2026-11-03", 10), ("B", "2026-11-04", 5)):
            c.execute(text("INSERT INTO sitemate.plan_targets VALUES (:p,:c,:d,:q,'SCH',:c)"), {"p": PID, "c": code, "d": day, "q": q})
    yield TestClient(app)
    with eng.begin() as c:
        _clean(c)


def test_project_and_activities(client):
    p = client.get(f"/projects/{PID}", headers=H).json()
    assert p["thresholds"] == {"deviation_pct": 15, "high_above_pct": 25} and p["recipient"]["name"] == "Client"
    assert p["contract_reference"] is None and p["rate_table"] is None
    acts = {a["code"]: a for a in client.get(f"/projects/{PID}/activities", headers=H).json()}
    assert acts["A"]["planned_start"] == "2026-11-02" and acts["A"]["planned_end"] == "2026-11-03"
    assert acts["A"]["planned_total_qty"] == 20 and acts["B"]["predecessors"] == ["A"]
    assert client.get(f"/projects/{PID}/activities?as_of=2026-10-01T00:00:00%2B01:00", headers=H).json() == []
    assert client.get("/projects/OTHER", headers=H).status_code in (401, 403, 404)
