"""Seed the dummy project TST with incidents that exercise the incident evidence agent.

  python seed_agent_demo.py            insert/refresh the dummy data (idempotent)
  python seed_agent_demo.py --clean    remove everything for project TST

Cases (one incident each, Dec 2026):
  A  supervisor names a cause, an external email names a different one  -> supervisor wins
  B  only an external email states a cause                              -> not established
  C  nobody states why                                                  -> undetermined, low score
  D  two supervisor notes disagree                                      -> low confidence, both cited
  E  a later note corrects an earlier one                               -> verdict differs by as_of
"""

import hashlib
import json
import os
import sys
import uuid

from sqlalchemy import text

from database import engine_for

PID = "TST"
NS = uuid.NAMESPACE_URL
ROLE = {"F": ("Site foreman", "foreman"), "S": ("Site manager", "site_supervisor"),
        "X": ("Equipment hire office", "external"), "C": ("Client representative", "client")}


def incident_id(key):
    return str(uuid.uuid5(NS, f"sitemate/{PID}/{key}"))


# (source id, kind, role key, available_at, [paragraphs])
SOURCES = [
    ("A-V1", "voice", "F", "2026-12-01T10:20:00+01:00",
     ["The tower crane stopped at ten.", "The wind speed alarm tripped and we shut it down as the manual says.",
      "Two riggers are standing by."]),
    ("A-E1", "email", "X", "2026-12-01T15:00:00+01:00",
     ["Our engineer believes the crane stopped because the slew motor failed.",
      "Please arrange a site visit."]),
    ("B-E1", "email", "X", "2026-12-02T16:00:00+01:00",
     ["The pump failed because the site team ran it dry.", "We will invoice the call-out."]),
    ("B-V1", "voice", "F", "2026-12-02T11:00:00+01:00", ["The dewatering pump is out of action since nine."]),
    ("C-V1", "voice", "F", "2026-12-03T14:30:00+01:00",
     ["The slab pour stopped at two.", "The crew has been sent home.", "Concrete is still on the trucks."]),
    ("D-V1", "voice", "F", "2026-12-04T09:30:00+01:00",
     ["Power cut at eight forty. That is why the hoist stopped."]),
    ("D-D1", "diary", "S", "2026-12-04T17:00:00+01:00",
     ["The hoist stopped at eight forty because the generator ran out of fuel."]),
    ("E-V1", "voice", "F", "2026-12-07T10:00:00+01:00",
     ["The concrete mixer stopped at nine thirty.", "I think the drum is blocked."]),
    ("E-V2", "voice", "F", "2026-12-07T14:00:00+01:00",
     ["Update on the mixer. It was not blocked.", "The mechanic found a leaking hydraulic seal."]),
]
INCIDENTS = [  # key, title, occurred_at
    ("A", "Tower crane stopped", "2026-12-01T10:00:00+01:00"),
    ("B", "Dewatering pump outage", "2026-12-02T09:00:00+01:00"),
    ("C", "Slab pour stopped", "2026-12-03T14:00:00+01:00"),
    ("D", "Hoist stopped", "2026-12-04T08:40:00+01:00"),
    ("E", "Concrete mixer stopped", "2026-12-07T09:30:00+01:00"),
]


def token():
    value = os.environ.get("TST_DEMO_TOKEN", "")
    if len(value) < 32:
        raise SystemExit("Set TST_DEMO_TOKEN (32+ random characters) in backend/.env")
    return value


def clean(conn):
    # analysis history is immutable (keep_revision trigger); the owner role may switch it off for cleanup
    for table in ("analysis_evidence", "analysis_hypotheses", "incident_analyses"):
        conn.execute(text(f"ALTER TABLE sitemate.{table} DISABLE TRIGGER keep_revision"))
        conn.execute(text(f"DELETE FROM sitemate.{table} WHERE project_id=:p"), {"p": PID})
        conn.execute(text(f"ALTER TABLE sitemate.{table} ENABLE TRIGGER keep_revision"))
    for table in ("alert_revisions", "incident_severity_history"):  # immutable history, same cleanup rule
        conn.execute(text(f"ALTER TABLE sitemate.{table} DISABLE TRIGGER keep_revision"))
        conn.execute(text(f"DELETE FROM sitemate.{table} WHERE project_id=:p"), {"p": PID})
        conn.execute(text(f"ALTER TABLE sitemate.{table} ENABLE TRIGGER keep_revision"))
    for table in ("action_items", "agent_runs", "agent_jobs", "alert_activity", "alerts", "incident_events", "events",
                  "capture_attachments", "captures", "fact_evidence", "capture_facts", "incidents", "source_passages",
                  "sources", "equipment", "contractors", "activities", "project_members", "projects"):
        column = "id" if table == "projects" else "project_id"
        conn.execute(text(f"DELETE FROM sitemate.{table} WHERE {column}=:p"), {"p": PID})


def seed(conn):
    conn.execute(text("""
        INSERT INTO sitemate.projects(id,name,timezone,threshold,high_threshold)
        VALUES (:p,'Agent test project (dummy data)','Europe/Vienna',15,25) ON CONFLICT DO NOTHING
    """), {"p": PID})
    conn.execute(text("""
        INSERT INTO sitemate.project_members(project_id,member_id,token_hash,role)
        VALUES (:p,'tst-manager',:h,'manager')
        ON CONFLICT (project_id,member_id) DO UPDATE SET token_hash=EXCLUDED.token_hash, role='manager'
    """), {"p": PID, "h": hashlib.sha256(token().encode()).hexdigest()})
    conn.execute(text("""
        INSERT INTO sitemate.activities(project_id,code,name,unit,zone) VALUES (:p,'SITE-1','Site works','m3','Z')
        ON CONFLICT DO NOTHING
    """), {"p": PID})
    for sid, kind, who, at, paragraphs in SOURCES:
        author, role = ROLE[who]
        conn.execute(text("""
            INSERT INTO sitemate.sources(project_id,id,kind,path,available_at,author,author_role)
            VALUES (:p,:id,:kind,:path,:at,:a,:r)
            ON CONFLICT (project_id,id) DO UPDATE SET available_at=EXCLUDED.available_at,
                author=EXCLUDED.author, author_role=EXCLUDED.author_role
        """), {"p": PID, "id": sid, "kind": kind, "path": f"dummy/{sid}.txt", "at": at, "a": author, "r": role})
        prefix = "seg" if kind == "voice" else "para"
        n = 0
        for paragraph in paragraphs:
            n += 1
            conn.execute(text("""
                INSERT INTO sitemate.source_passages(project_id,source_id,locator,page,excerpt)
                VALUES (:p,:s,:l,NULL,:t)
                ON CONFLICT (project_id,source_id,locator) DO UPDATE SET excerpt=EXCLUDED.excerpt
            """), {"p": PID, "s": sid, "l": f"{prefix}:{n}", "t": paragraph})
    for key, title, at in INCIDENTS:
        conn.execute(text("""
            INSERT INTO sitemate.incidents(project_id,id,activity_code,kind,title,occurred_at)
            VALUES (:p,CAST(:id AS uuid),'SITE-1','equipment_failure',:t,:at) ON CONFLICT DO NOTHING
        """), {"p": PID, "id": incident_id(key), "t": title, "at": at})


def main():
    with engine_for("MIGRATION_DATABASE_URL").begin() as conn:
        if "--clean" in sys.argv:
            clean(conn)
            print("Removed project TST.")
            return
        seed(conn)
    print(json.dumps({k: incident_id(k) for k, _, _ in INCIDENTS}, indent=1))


if __name__ == "__main__":
    main()
