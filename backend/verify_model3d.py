"""End-to-end checks for the 3D progress model.

    python verify_model3d.py --db    schema + reference model + demo reports + progress, in ONE transaction that is
                                     rolled back at the end (nothing stays in the database)
    python verify_model3d.py --api   the same, through the HTTP routes (FastAPI TestClient on that transaction)
    python verify_model3d.py --llm   P5 on mock_data/Plan_3_Structural_GA_Drawings_2D.pdf (one model call, no database),
                                     compared with the hand-written reference spec

Without flags it runs --db and --api.
"""

from __future__ import annotations

import os
import sys
from datetime import date, datetime, timezone
from pathlib import Path

from sqlalchemy import text

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from database import engine_for  # noqa: E402
from model3d import progress, schema, seed_demo, store  # noqa: E402
from model3d.spec import blocking, riverside_spec, validate  # noqa: E402

D = date.fromisoformat
DEADLINE = D("2027-03-08")
failures: list[str] = []


def check(ok: bool, label: str):
    print(("  ok    " if ok else "  FAIL  ") + label)
    if not ok:
        failures.append(label)


def prepare(conn):
    for statement in schema.UPGRADE:
        conn.exec_driver_sql(statement)
    manager = conn.scalar(text("SELECT member_id FROM sitemate.project_members WHERE project_id='RIV' AND role='manager' "
                               "ORDER BY member_id LIMIT 1")) or "seed"
    # an active model in the shared database would be kept by seed_model; supersede it inside this transaction only
    conn.execute(text("UPDATE sitemate.building_models SET status='superseded' WHERE project_id='RIV' AND status='active'"))
    model_id = seed_demo.seed_model(conn, "RIV", DEADLINE, manager)
    seed_demo.seed_reports(conn, "RIV")
    return model_id


def verify_db():
    print("Database (rolled back at the end)")
    with engine_for("MIGRATION_DATABASE_URL").connect() as conn:
        tx = conn.begin()
        try:
            model_id = prepare(conn)
            check(model_id is not None, "reference model created and activated")
            geo = store.geometry(conn, "RIV", model_id)
            check(len(geo["pours"]) == 23 and len(geo["elements"]) > 200,
                  f"pours and elements stored ({len(geo['pours'])} pours, {len(geo['elements'])} elements)")
            codes = [p["activity"] for p in geo["pours"]]
            acts = set(conn.execute(text("SELECT code FROM sitemate.activities WHERE project_id='RIV' AND code = ANY(:c)"),
                                    {"c": list(set(codes))}).scalars())
            check(acts == set(codes), "activities A300-A450 exist so reports can record quantities")
            row = store.active_model(conn, "RIV")
            day = D("2026-11-22")
            inputs = progress.load_inputs(conn, "RIV", list(dict.fromkeys(codes)), day, None)
            check(len([o for o in inputs["observations"] if o["basis"] == "signed"]) == 5,
                  "five signed structure reports read from sitemate.observations")
            result = progress.compute(row["spec"], geo["pours"], inputs, day, row["deadline"], row["review_reasons"])
            a = result["actual"]
            check(all(a[p]["status"] == "built" for p in ("A300-P1", "A300-P2", "A300-P3", "A310-W1", "A310-W2")),
                  "22 Nov: raft and basement walls built")
            check(a["A310-S1"]["status"] == "not_started" and a["A410-V"]["status"] == "not_started",
                  "22 Nov: ground slab and upper levels not started (ghosts)")
            s = result["summary"]
            check(s["forecast_completion"] == "2027-03-09" and s["late_working_days"] == 1,
                  f"forecast {s['forecast_completion']}, {s['late_working_days']} working day(s) late vs deadline {DEADLINE}")
            kinds = {w["kind"] for w in result["why"]}
            check({"late_pour", "report_remark", "plan_conflict"} <= kinds, f"why: {sorted(kinds)}")
            check(any("rain" in w["text"] for w in result["why"]), "why cites the rain remark from the 30 Oct report")
            early = progress.load_inputs(conn, "RIV", list(dict.fromkeys(codes)), day,
                                         datetime(2026, 10, 31, 12, tzinfo=timezone.utc))
            st = progress.pour_states(geo["pours"], early, day)
            check(st["A300-P2"]["status"] == "built" and st["A300-P3"]["status"] == "not_started",
                  "As of 31 Oct: only the reports known then count (P1, P2 built; P3 not yet)")
            digest = progress.input_digest(inputs, day)
            v1 = store.save_progress(conn, "RIV", model_id, day, datetime.now(timezone.utc), digest, a)
            v2 = store.save_progress(conn, "RIV", model_id, day, datetime.now(timezone.utc), digest, a)
            check(v1 == v2 == 1, "element_progress stores one version per input digest")
            tl = progress.timeline(row["spec"], geo["pours"], inputs, day, row["deadline"])
            check(len(tl["steps"]) == 5 and tl["points"][0]["date"] == "2026-10-02", "timeline steps and points")
        finally:
            tx.rollback()
    print("  rolled back")


def verify_api():
    print("HTTP routes (TestClient, rolled back at the end)")
    from fastapi.testclient import TestClient

    import deps
    from main import app

    token = os.environ["RIVERSIDE_DEMO_TOKEN"]
    with engine_for("MIGRATION_DATABASE_URL").connect() as conn:
        tx = conn.begin()
        try:
            prepare(conn)

            def same_connection():
                yield conn

            app.dependency_overrides[deps.connection] = same_connection
            client = TestClient(app)
            h = {"Authorization": f"Bearer {token}"}
            r = client.get("/projects/RIV/models", headers=h)
            check(r.status_code == 200 and r.json()["active_id"], f"GET /models {r.status_code}")
            r = client.get("/projects/RIV/models/active", headers=h)
            body = r.json()
            check(r.status_code == 200 and len(body["elements"]) > 200 and body["deadline"] == "2027-03-08",
                  f"GET /models/active {r.status_code}: {len(body.get('elements', []))} elements, deadline {body.get('deadline')}")
            r = client.get("/projects/RIV/models/active/progress?date=2026-11-22", headers=h)
            body = r.json()
            check(r.status_code == 200 and body["summary"]["status"] == "late" and body["actual"]["A300-P1"]["status"] == "built",
                  f"GET /models/active/progress {r.status_code}: {body.get('summary', {}).get('status')}")
            r = client.get("/projects/RIV/models/active/progress?as_of=2026-11-01T12:00:00%2B01:00", headers=h)
            body = r.json()
            check(r.status_code == 200 and body["date"] == "2026-11-01" and body["actual"]["A300-P3"]["status"] == "not_started",
                  "progress follows the As of clock (1 Nov)")
            r = client.get("/projects/RIV/models/active/timeline?date=2026-11-22", headers=h)
            check(r.status_code == 200 and len(r.json()["points"]) > 100, f"GET /models/active/timeline {r.status_code}")
            r = client.get(f"/projects/RIV/models/{client.get('/projects/RIV/models', headers=h).json()['active_id']}", headers=h)
            check(r.status_code == 200 and r.json()["spec"]["levels"], "GET /models/{id} with spec")
            r = client.get("/projects/RIV/models/active/progress", headers={"Authorization": "Bearer wrong"})
            check(r.status_code == 403, "a wrong token is refused")
        finally:
            app.dependency_overrides.clear()
            tx.rollback()
    print("  rolled back")


def verify_llm():
    print("P5 extraction from Plan_3 (live model call, no database)")
    from documents.parsers import ParseResult, parse_plan

    from model3d.generator import generate
    from model3d.prompts import extract_spec

    pdf = ROOT.parent / "mock_data" / "Plan_3_Structural_GA_Drawings_2D.pdf"
    result = ParseResult()
    parse_plan(pdf, {"source": {"id": "DRW-TEST"}, "project": {"timezone": "Europe/Berlin"}}, result)
    passages = [{"source_id": "DRW-TEST", "locator": p.locator, "excerpt": p.excerpt, "page": p.page} for p in result.passages]
    spec, model = extract_spec(passages, [("DRW-TEST", pdf.read_bytes())])
    spec, reasons = validate(spec, {f"DRW-TEST:{p['locator']}": p["excerpt"] for p in passages})
    ref, _ = validate(riverside_spec())
    print(f"  model {model}; {len(reasons)} review notes, {len(blocking(reasons))} blocking")
    print(f"  columns {[(c['mark'], len(c['at']), c['storeys']) for c in spec['columns']]}")
    print(f"  walls {len(spec['walls'])}, cores {[(c['mark'], c['from'], c['to']) for c in spec['cores']]}")
    for r in reasons[:12]:
        print(f"    {r['severity']:8} {r['subject']}: {r['message'][:110]}")
    check(not blocking(reasons), "no blocking review notes")
    check([g["at"] for g in spec["grid"]["x"]] == [g["at"] for g in ref["grid"]["x"]], "grid x matches the drawings")
    check([g["at"] for g in spec["grid"]["y"]] == [g["at"] for g in ref["grid"]["y"]], "grid y matches the drawings")
    check([(lv["name"], lv["tos"], lv["activity"]) for lv in spec["levels"]] ==
          [(lv["name"], lv["tos"], lv["activity"]) for lv in ref["levels"]] or len(spec["levels"]) == 7,
          f"levels: {[(lv['name'], lv['tos'], lv['activity']) for lv in spec['levels']]}")
    check({p["id"] for p in spec["pours"]} == {p["id"] for p in ref["pours"]}, f"pours: {len(spec['pours'])} of 23")
    check(sum(len(v) for v in spec["refs"].values()) > 0, f"citations kept: {sum(len(v) for v in spec['refs'].values())}")
    if not blocking(reasons):
        g = generate(spec)
        check(len(g["elements"]) > 100, f"3D model generated from the extracted spec: {len(g['elements'])} elements, "
                                        f"volumes {g['volumes']}")


if __name__ == "__main__":
    flags = set(sys.argv[1:]) or {"--db", "--api"}
    if "--db" in flags:
        verify_db()
    if "--api" in flags:
        verify_api()
    if "--llm" in flags:
        verify_llm()
    print(f"\n{'All checks passed' if not failures else f'{len(failures)} check(s) failed'}")
    sys.exit(1 if failures else 0)
