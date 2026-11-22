"""Needs a migrated scratch database:  TEST_DATABASE_URL=postgresql+psycopg://postgres@127.0.0.1:54329/sm"""

import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import worker  # noqa: E402
from app.actions import ActionPlan, RecommendedAction, save_actions  # noqa: E402
from app.llm import FakeLLM, LLMError  # noqa: E402

URL = os.environ.get("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not URL, reason="set TEST_DATABASE_URL to run worker tests")
PID = "WTEST"


@pytest.fixture()
def engine():
    admin = create_engine(URL)  # seeds and cleans up; the worker itself runs as TEST_OPS_URL (sitemate_ops) when set
    with admin.begin() as c:
        _clean(c)
        c.execute(text("INSERT INTO sitemate.projects (id,name,timezone,threshold,high_threshold) VALUES (:p,'w','UTC',10,30)"), {"p": PID})
    yield create_engine(os.environ.get("TEST_OPS_URL", URL))
    with admin.begin() as c:
        _clean(c)


def _clean(c):
    for t in ("alert_revisions", "incident_severity_history", "analysis_evidence", "analysis_hypotheses", "incident_analyses"):
        c.execute(text(f"ALTER TABLE sitemate.{t} DISABLE TRIGGER keep_revision"))
        c.execute(text(f"DELETE FROM sitemate.{t} WHERE project_id=:p"), {"p": PID})
        c.execute(text(f"ALTER TABLE sitemate.{t} ENABLE TRIGGER keep_revision"))
    for t in ("action_items", "agent_runs", "agent_jobs", "alert_activity", "alerts", "incidents"):
        c.execute(text(f"DELETE FROM sitemate.{t} WHERE project_id=:p"), {"p": PID})
    c.execute(text("DELETE FROM sitemate.projects WHERE id=:p"), {"p": PID})


def incident(conn, status="open", severity="medium", age_hours=0, category="equipment"):
    iid = str(uuid.uuid4())
    conn.execute(text("""
        INSERT INTO sitemate.incidents (project_id,id,kind,title,occurred_at,category,event_type,summary,status,severity,
            severity_version,first_reported_at,last_reported_at,cluster_key)
        VALUES (:p,CAST(:i AS uuid),'equipment_failure','Lift down',now() - make_interval(hours => :h),:c,'equipment_failure','Lift down',
                :s,:sev,1,now() - make_interval(hours => :h),now() - make_interval(hours => :h),:k)"""),
                 {"p": PID, "i": iid, "h": age_hours, "c": category, "s": status, "sev": severity, "k": f"k:{iid}"})
    conn.execute(text("""INSERT INTO sitemate.alerts (project_id,kind,status,incident_id,title,checkpoint_at)
                         VALUES (:p,'incident','acknowledged',CAST(:i AS uuid),'Lift down',now())"""), {"p": PID, "i": iid})
    conn.execute(text("""
        INSERT INTO sitemate.alert_revisions (project_id,alert_id,version,as_of,severity,calculation,evidence_refs)
        SELECT :p, id, 1, now(), :sev, '{}', '[]' FROM sitemate.alerts WHERE project_id=:p AND incident_id=CAST(:i AS uuid)"""),
                 {"p": PID, "i": iid, "sev": severity})
    conn.commit()
    return iid


def test_claims_in_order_skips_future_jobs_and_debounces(engine):
    with engine.connect() as conn:
        a = incident(conn)
        worker.enqueue(conn, PID, "reasoning", a, 0)
        worker.enqueue(conn, PID, "reasoning", a, 600)  # debounce: same queued job, earliest run_after wins
        conn.commit()
        assert conn.scalar(text("SELECT count(*) FROM sitemate.agent_jobs WHERE project_id=:p"), {"p": PID}) == 1
        job = worker.claim_job(conn)
        assert job["kind"] == "reasoning" and job["incident_id"] == a and job["attempts"] == 1
        assert worker.claim_job(conn) is None  # running jobs are not claimed twice
        worker.enqueue(conn, PID, "plan_actions", a, 600)
        conn.commit()
        assert worker.claim_job(conn) is None  # not due yet


def test_two_workers_never_claim_the_same_job(engine):
    with engine.connect() as c1, engine.connect() as c2:
        worker.enqueue(c1, PID, "reasoning", incident(c1), 0)
        c1.commit()
        got = [worker.claim_job(c1), worker.claim_job(c2)]
        assert sum(g is not None for g in got) == 1


def test_failures_retry_with_backoff_then_stay_failed_with_the_error(engine):
    class Boom:
        model = "fake"

        def generate_json(self, *_):
            raise LLMError("model down")

    with engine.connect() as conn:
        a = incident(conn)
        worker.enqueue(conn, PID, "plan_actions", a, 0)
        conn.commit()
    worker.HANDLERS["plan_actions"], original = (lambda c, l, j: (_ for _ in ()).throw(LLMError("model down"))), worker.HANDLERS["plan_actions"]
    try:
        assert worker.process_one(engine, Boom) is True
        with engine.connect() as conn:
            row = conn.execute(text("SELECT status, attempts, last_error, run_after > now() AS later FROM sitemate.agent_jobs WHERE project_id=:p"), {"p": PID}).mappings().one()
            assert row["status"] == "queued" and row["attempts"] == 1 and "model down" in row["last_error"] and row["later"]
            conn.execute(text("UPDATE sitemate.agent_jobs SET attempts=2, run_after=now() WHERE project_id=:p"), {"p": PID})
            conn.commit()
        worker.process_one(engine, Boom)
        with engine.connect() as conn:
            assert conn.scalar(text("SELECT status FROM sitemate.agent_jobs WHERE project_id=:p"), {"p": PID}) == "failed"
    finally:
        worker.HANDLERS["plan_actions"] = original


def test_plan_actions_job_end_to_end_with_a_fake_llm(engine):
    with engine.connect() as conn:
        a = incident(conn)
        worker.enqueue(conn, PID, "plan_actions", a, 0)
        conn.commit()
    llm = FakeLLM({"actions": [{"action_type": "assign_owner", "title": "Assign an owner", "owner_role": "site_manager", "priority": "high"}]})
    assert worker.process_one(engine, lambda: llm)
    with engine.connect() as conn:
        rows = conn.execute(text("SELECT action_type, status, proposed_by, alert_id IS NOT NULL AS has_alert FROM sitemate.action_items WHERE project_id=:p ORDER BY created_at"), {"p": PID}).mappings().all()
        # no analysis exists yet -> the guardrail put request_evidence first
        assert [r["action_type"] for r in rows] == ["request_evidence", "assign_owner"]
        assert all(r["status"] == "proposed" and r["proposed_by"] == "agent" and r["has_alert"] for r in rows)
        assert conn.scalar(text("SELECT status FROM sitemate.agent_jobs WHERE project_id=:p"), {"p": PID}) == "done"
        assert conn.scalar(text("SELECT count(*) FROM sitemate.agent_runs WHERE project_id=:p AND agent='action_planner'"), {"p": PID}) == 1


def test_replanning_supersedes_untouched_proposals_but_keeps_approved_actions(engine):
    with engine.connect() as conn:
        a = incident(conn)
        analysis_id = None

        def plan(title, analysis):
            return ActionPlan(incident_id=a, analysis_id=analysis, model="fake", as_of=datetime.now(timezone.utc),
                              actions=[RecommendedAction(action_type="assign_owner", title=title, priority="high")])
        save_actions(conn, PID, plan("First", None))
        conn.execute(text("UPDATE sitemate.action_items SET status='approved' WHERE project_id=:p AND title='First'"), {"p": PID})
        save_actions(conn, PID, plan("Second", None))
        save_actions(conn, PID, plan("Third", None))
        conn.commit()
        statuses = dict(conn.execute(text("SELECT title, status FROM sitemate.action_items WHERE project_id=:p"), {"p": PID}).all())
        assert statuses == {"First": "approved", "Second": "superseded", "Third": "proposed"}


def test_escalation_after_24h_once_and_reopens_an_acknowledged_alert(engine):
    with engine.connect() as conn:
        old = incident(conn, age_hours=30, severity="medium")
        fresh = incident(conn, age_hours=1, severity="medium")
        assert worker.escalate_long_open(conn, 24) == 1
        assert worker.escalate_long_open(conn, 24) == 0  # only once
        sev = dict(conn.execute(text("SELECT id::text, severity FROM sitemate.incidents WHERE project_id=:p"), {"p": PID}).all())
        assert sev[old] == "high" and sev[fresh] == "medium"
        assert conn.scalar(text("SELECT status FROM sitemate.alerts WHERE project_id=:p AND incident_id=CAST(:i AS uuid)"), {"p": PID, "i": old}) == "open"
        assert conn.scalar(text("SELECT count(*) FROM sitemate.alert_activity WHERE project_id=:p AND action='escalated'"), {"p": PID}) == 1


def test_auto_resolve_quiet_monitoring_incidents(engine):
    with engine.connect() as conn:
        quiet = incident(conn, status="monitoring", age_hours=20)
        recent = incident(conn, status="monitoring", age_hours=1)
        assert worker.auto_resolve_quiet(conn, 12) == 1
        states = dict(conn.execute(text("SELECT id::text, status FROM sitemate.incidents WHERE project_id=:p"), {"p": PID}).all())
        assert states[quiet] == "resolved" and states[recent] == "monitoring"


def test_claim_stamps_the_lock_and_recovery_requeues_a_stuck_job(engine):
    with engine.connect() as conn:
        worker.enqueue(conn, PID, "reasoning", incident(conn), 0)
        conn.commit()
        job = worker.claim_job(conn)
        row = conn.execute(text("SELECT locked_at, locked_by FROM sitemate.agent_jobs WHERE id=CAST(:i AS uuid)"),
                           {"i": job["id"]}).one()
        assert row.locked_at is not None and row.locked_by == worker.WORKER_ID
        assert worker.recover_stuck(conn) == 0  # fresh lock: the worker is still on it
        conn.execute(text("UPDATE sitemate.agent_jobs SET locked_at = now() - interval '1 hour' WHERE id=CAST(:i AS uuid)"),
                     {"i": job["id"]})
        conn.commit()
        assert worker.recover_stuck(conn) == 1
        row = conn.execute(text("SELECT status, locked_at, last_error FROM sitemate.agent_jobs WHERE id=CAST(:i AS uuid)"),
                           {"i": job["id"]}).one()
        assert row.status == "queued" and row.locked_at is None and "stopped" in row.last_error
        again = worker.claim_job(conn)
        assert again["id"] == job["id"] and again["attempts"] == 2  # attempts are kept, not reset


def test_recovery_fails_a_stuck_job_whose_attempts_are_used_up(engine):
    with engine.connect() as conn:
        worker.enqueue(conn, PID, "reasoning", incident(conn), 0)
        conn.execute(text("""UPDATE sitemate.agent_jobs SET status='running', attempts=:m,
                             locked_at = now() - interval '1 hour' WHERE project_id=:p"""),
                     {"p": PID, "m": worker.MAX_ATTEMPTS})
        conn.commit()
        assert worker.recover_stuck(conn) == 1
        assert conn.scalar(text("SELECT status FROM sitemate.agent_jobs WHERE project_id=:p"), {"p": PID}) == "failed"


def test_enqueue_job_debounces_per_subject(engine):
    with engine.connect() as conn:
        for _ in range(3):
            worker.enqueue_job(conn, PID, "ingest", {"source_id": "R10"})
            worker.enqueue_job(conn, PID, "auto_draft", {"alert_id": "a1", "notice_type": "delay_notice"})
        worker.enqueue_job(conn, PID, "ingest", {"source_id": "R11"})
        worker.enqueue_job(conn, PID, "auto_draft", {"alert_id": "a1", "notice_type": "defect_notice"})
        conn.commit()
        kinds = dict(conn.execute(text("""SELECT kind, count(*) FROM sitemate.agent_jobs WHERE project_id=:p
                                          GROUP BY kind"""), {"p": PID}).all())
        assert kinds == {"ingest": 2, "auto_draft": 2}


def test_heartbeat_records_the_worker(engine):
    with engine.connect() as conn:
        worker.heartbeat(conn)
        worker.heartbeat(conn)
        n = conn.scalar(text("SELECT count(*) FROM sitemate.worker_heartbeats WHERE worker_id=:w"), {"w": worker.WORKER_ID})
        assert n == 1
        conn.execute(text("DELETE FROM sitemate.worker_heartbeats WHERE worker_id=:w"), {"w": worker.WORKER_ID})
        conn.commit()
