"""Demo of the capture -> event -> incident -> alert pipeline on the dummy project TST.

  python seed_event_pipeline.py            prepare TST members/equipment, then replay the demo script
  python seed_event_pipeline.py --prepare  only create the members and equipment (no captures)
  python seed_event_pipeline.py --photo oil.jpg   attach a real photo to the spill report

The script talks to the running FastAPI service (SITEMATE_API_URL, default http://127.0.0.1:8000) exactly like the web
app does, so the API needs ANTHROPIC_API_KEY and AGENT_DATABASE_URL. Steps:
  1. three people report the goods lift is broken within 40 minutes   -> ONE incident, 3 sources, severity high
  2. a crane report in the same zone                                  -> a separate incident
  3. "the lift is working again"                                      -> resolution link, status monitoring
  4. an oil spill (photo if --photo is given)                         -> environmental incident, severity high
Each capture accepts the AI's suggested category, as a user would who agrees with it.
"""

import hashlib
import json
import mimetypes
import os
import sys
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import text

from database import engine_for

PID = "TST"
BASE = os.environ.get("SITEMATE_API_URL", "http://127.0.0.1:8000").rstrip("/")
PEOPLE = {"tst-foreman-a": "contributor", "tst-foreman-b": "contributor", "tst-foreman-c": "contributor",
          "tst-manager": "manager"}


def token(member):
    root = os.environ.get("TST_DEMO_TOKEN", "")
    if len(root) < 32:
        raise SystemExit("Set TST_DEMO_TOKEN (32+ random characters) in backend/.env")
    return root if member == "tst-manager" else f"{root}:{member}"


def prepare():
    with engine_for("MIGRATION_DATABASE_URL").begin() as conn:
        conn.execute(text("""INSERT INTO sitemate.projects(id,name,timezone,threshold,high_threshold)
                             VALUES (:p,'Agent test project (dummy data)','Europe/Vienna',15,25) ON CONFLICT DO NOTHING"""), {"p": PID})
        for member, role in PEOPLE.items():
            conn.execute(text("""INSERT INTO sitemate.project_members(project_id,member_id,token_hash,role) VALUES (:p,:m,:h,:r)
                                 ON CONFLICT (project_id,member_id) DO UPDATE SET token_hash=EXCLUDED.token_hash, role=EXCLUDED.role"""),
                         {"p": PID, "m": member, "h": hashlib.sha256(token(member).encode()).hexdigest(), "r": role})
        conn.execute(text("""INSERT INTO sitemate.contractors(project_id,id,name,trade,contact_role)
                             VALUES (:p,'LIFTCO','Vertical Lift Ltd','Lifts and hoists','plant_contractor') ON CONFLICT DO NOTHING"""), {"p": PID})
        conn.execute(text("""INSERT INTO sitemate.equipment(project_id,id,description,owner_id)
                             VALUES (:p,'LIFT-1','Goods lift, core A (the only lift on site)','LIFTCO'),
                                    (:p,'CRANE-1','Tower crane','LIFTCO') ON CONFLICT DO NOTHING"""), {"p": PID})
        conn.execute(text("""INSERT INTO sitemate.activities(project_id,code,name,unit,zone) VALUES (:p,'SITE-1','Site works','m3','Z')
                             ON CONFLICT DO NOTHING"""), {"p": PID})


def multipart(fields, files):
    boundary = uuid.uuid4().hex
    body = b""
    for name, value in fields.items():
        body += f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
    for name, path in files:
        mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
        body += (f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{os.path.basename(path)}"\r\n'
                 f"Content-Type: {mime}\r\n\r\n").encode() + open(path, "rb").read() + b"\r\n"
    return body + f"--{boundary}--\r\n".encode(), f"multipart/form-data; boundary={boundary}"


def call(member, path, payload=None, files=(), fields=None):
    if files or fields is not None:
        data, ctype = multipart(fields or {}, files)
    else:
        data, ctype = json.dumps(payload).encode(), "application/json"
    request = urllib.request.Request(f"{BASE}/projects/{PID}/captures{path}", data=data, method="POST",
                                     headers={"Authorization": f"Bearer {token(member)}", "Content-Type": ctype})
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            return json.load(response)
    except urllib.error.HTTPError as err:
        raise SystemExit(f"{err.code} from the API: {err.read().decode()[:400]}") from None


def capture(member, text_, at, photo=None):
    first = call(member, "", fields={"transcript": text_, "recorded_at": at.isoformat()},
                 files=[("images", photo)] if photo else [])
    assert first["status"] == "needs_category", first
    for e in first["events"]:
        print(f"    suggested {e['suggested_category']}/{e['suggested_event_type']} ({e['confidence']:.0%}): {e['rationale']}")
    result = call(member, f"/{first['thread_id']}/categories", {"events": []})  # accept the suggestions
    while result["status"] == "needs_input":  # answer any required-field question with "unknown"
        result = call(member, f"/{result['thread_id']}/answers", {"answers": [{"id": q["id"], "answer": "unknown"} for q in result["questions"]]})
    for link in result.get("incident_links", []):
        print(f"    -> {'NEW' if link['created'] else 'linked to'} incident {link['incident_id'][:8]} "
              f"({link['link_type']}, severity {link['severity']}, {link['report_count']} reports from {link['reporter_count']} people)")
    return result


def main():
    prepare()
    if "--prepare" in sys.argv:
        print("TST members and equipment are ready.")
        return
    photo = sys.argv[sys.argv.index("--photo") + 1] if "--photo" in sys.argv else None
    now = datetime.now(timezone.utc)
    script = [
        ("1a. first report of the lift", "tst-foreman-a", "The goods lift in core A is not working, it is stuck between floors.", -65, None),
        ("1b. second person, same lift", "tst-foreman-b", "Lift is out again, nobody can get materials up to level 4.", -50, None),
        ("1c. third person, same lift", "tst-foreman-c", "The goods hoist is broken, twelve of my crew are waiting at the bottom.", -30, None),
        ("2.  crane, same zone", "tst-foreman-a", "Tower crane has stopped, the wind alarm tripped in zone A.", -25, None),
        ("3.  lift repaired", "tst-manager", "The lift is working again, the mechanic finished at eleven.", -5, None),
        ("4.  oil spill", "tst-foreman-b", "Hydraulic oil leaking from the excavator by the gate, running towards the drain.", -1, photo),
    ]
    for label, member, words, minutes, image in script:
        print(f"{label}: {member}: {words}")
        capture(member, words, now + timedelta(minutes=minutes), image)
    print("Done. Open the Incidents and Alerts pages (project TST), then wait ~1 minute for the worker to add causes and actions.")


if __name__ == "__main__":
    main()
