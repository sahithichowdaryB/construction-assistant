"""Demo progress for the 3D model, written through the normal tables (plan section 11).

The database has no progress yet for the activities in the structural drawings (A300-A450). This writes signed daily
structure reports for the raft (A300, complete) and the basement walls (A310, walls poured, slab not yet) as
`sources` + `source_passages` + `observations`, exactly like ingested daily reports, so the 3D view reads them like
real data. The report files live in the demo pack (data/riverside-demo/uploads/structure-reports), so the evidence
viewer can open them on every machine.

    python -m model3d.seed_demo            # dry run: print what would be written
    python -m model3d.seed_demo --apply    # write the reports (idempotent)
    python -m model3d.seed_demo --apply --model 2027-03-08
                                           # also create + activate the Riverside model from the reference spec
                                           # (only when no model is active), with that deadline

    python -m model3d.seed_demo --apply --house <model-id>
                                           # the house from house_floor_plan.pdf (uploaded and read as a draft): set its
                                           # programme, activate it and record about half the concrete as signed reports

The drawing set itself is registered from data/riverside-demo/uploads/drawings when --model is used.
"""

from __future__ import annotations

import hashlib
import json
import sys
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from sqlalchemy import text

PACK = Path(__file__).resolve().parents[2] / "data" / "riverside-demo"
FOLDER = "uploads/structure-reports"
DRAWINGS = "uploads/drawings/Plan_3_Structural_GA_Drawings_2D.pdf"
SIGNER = "Sam Reed, Site Manager"

# (work date, activity, pour, m3, remark). Planned dates are in the drawings' pour schedule (S301).
REPORTS = [
    ("2026-10-22", "A300", "A300-P1", 627.7, "Raft bay 1 (grid 1-3) poured, 627.7 m3 C30/37 WU. Pour started one day "
     "late: the concrete pump booked for 21 Oct broke down; replacement pump on site 22 Oct 06:30."),
    ("2026-10-30", "A300", "A300-P2", 595.5, "Raft bay 2 (grid 3-5) poured, 595.5 m3. Pour postponed from 28 Oct because "
     "of heavy rain on 28-29 Oct (pour not permitted, formation flooded)."),
    ("2026-11-06", "A300", "A300-P3", 576.8, "Raft bay 3 (grid 5-7) poured, 576.8 m3 incl. waste allowance. Raft complete. "
     "Delay of two working days: rebar hold point H3 signed late, structural engineer unavailable on 4 Nov."),
    ("2026-11-18", "A310", "A310-W1", 97.1, "Basement walls, columns and core grid 1-4 poured (pour W1), 97.1 m3. Wall "
     "formwork was delivered late by the supplier (due 12 Nov, arrived 16 Nov)."),
    ("2026-11-20", "A310", "A310-W2", 97.1, "Basement walls, columns and core grid 4-7 poured (pour W2), 97.1 m3. "
     "Ground floor slab bay A formwork started; rebar fixing next week."),
]


def _report_text(day: str, code: str, pour: str, m3: float, remark: str) -> str:
    d = date.fromisoformat(day)
    return (f"RIVERSIDE RESIDENCES - BLOCK B | DAILY STRUCTURE REPORT | {d:%A %d %B %Y}\n"
            f"Activity {code} | pour {pour}\n\n"
            f"Concrete placed today: {m3} m3 (pour {pour}).\n\n"
            f"Remarks: {remark}\n\n"
            f"Signed: {SIGNER}\n")


def plan_rows():
    out = []
    for day, code, pour, m3, remark in REPORTS:
        sid = f"R3D-{day.replace('-', '')}"
        out.append({"source_id": sid, "day": day, "code": code, "pour": pour, "m3": m3, "remark": remark,
                    "path": f"{FOLDER}/{sid}.txt", "text": _report_text(day, code, pour, m3, remark)})
    return out


def write_files(rows):
    for r in rows:
        target = PACK / r["path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists() or target.read_text(encoding="utf-8") != r["text"]:
            target.write_text(r["text"], encoding="utf-8")


def seed_reports(conn, project_id: str = "RIV") -> list[str]:
    """Insert the reports (idempotent). The activities must exist (activating the model adds them)."""
    tz = ZoneInfo(conn.scalar(text("SELECT timezone FROM sitemate.projects WHERE id=:p"), {"p": project_id}))
    rows = plan_rows()
    missing = {r["code"] for r in rows} - set(conn.execute(text(
        "SELECT code FROM sitemate.activities WHERE project_id=:p AND code = ANY(:c)"),
        {"p": project_id, "c": list({r["code"] for r in rows})}).scalars())
    if missing:
        raise RuntimeError(f"activities {sorted(missing)} do not exist; activate the 3D model first")
    written = []
    for r in rows:
        at = datetime.combine(date.fromisoformat(r["day"]), datetime.min.time().replace(hour=17, minute=30), tz)
        conn.execute(text("""INSERT INTO sitemate.sources (project_id, id, kind, path, available_at, sha256, title, meta,
                                                          author, author_role)
            VALUES (:p, :s, 'daily_report', :path, :at, :sha, :title, CAST(:meta AS jsonb), :author, 'site_supervisor')
            ON CONFLICT (project_id, id) DO NOTHING"""),
                     {"p": project_id, "s": r["source_id"], "path": r["path"], "at": at,
                      "sha": hashlib.sha256(r["text"].encode()).hexdigest(),
                      "title": f"Daily structure report {date.fromisoformat(r['day']):%d %b %Y} ({r['pour']})",
                      "meta": json.dumps({"filename": Path(r["path"]).name, "work_date": r["day"], "demo": "model3d"}),
                      "author": SIGNER})
        passages = [(r["code"], f"{r['code']} concrete placed today: {r['m3']} m3 (pour {r['pour']}). Signed: {SIGNER}.",
                     "record", 1),
                    ("remarks", f"Remarks: {r['remark']}", "paragraph", 2)]
        for locator, excerpt, kind, ordinal in passages:
            conn.execute(text("""INSERT INTO sitemate.source_passages (project_id, source_id, locator, page, excerpt, ordinal,
                                                                     kind, section)
                VALUES (:p, :s, :l, 1, :e, :o, :k, 'Daily structure report') ON CONFLICT DO NOTHING"""),
                         {"p": project_id, "s": r["source_id"], "l": locator, "e": excerpt, "o": ordinal, "k": kind})
        conn.execute(text("""INSERT INTO sitemate.observations (project_id, activity_code, work_date, source_id, locator,
                                                               quantity, basis)
            VALUES (:p, :c, :d, :s, :c, :q, 'signed') ON CONFLICT DO NOTHING"""),
                     {"p": project_id, "c": r["code"], "d": date.fromisoformat(r["day"]), "s": r["source_id"], "q": r["m3"]})
        written.append(r["source_id"])
    return written


def record_report(conn, project_id: str, *, source_id: str, day: str, code: str, pour: str, m3: float, remark: str,
                  title_prefix: str = "Daily structure report") -> None:
    """One signed daily report, written like an ingested one: file in the demo pack, source, passages, observation."""
    tz = ZoneInfo(conn.scalar(text("SELECT timezone FROM sitemate.projects WHERE id=:p"), {"p": project_id}))
    body = _report_text(day, code, pour, m3, remark)
    path = f"{FOLDER}/{source_id}.txt"
    target = PACK / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(body, encoding="utf-8")
    at = datetime.combine(date.fromisoformat(day), datetime.min.time().replace(hour=17, minute=30), tz)
    conn.execute(text("""INSERT INTO sitemate.sources (project_id, id, kind, path, available_at, sha256, title, meta, author, author_role)
        VALUES (:p, :s, 'daily_report', :path, :at, :sha, :title, CAST(:meta AS jsonb), :author, 'site_supervisor')
        ON CONFLICT (project_id, id) DO NOTHING"""),
                 {"p": project_id, "s": source_id, "path": path, "at": at, "sha": hashlib.sha256(body.encode()).hexdigest(),
                  "title": f"{title_prefix} {date.fromisoformat(day):%d %b %Y} ({pour})",
                  "meta": json.dumps({"filename": Path(path).name, "work_date": day, "demo": "model3d"}), "author": SIGNER})
    for locator, excerpt, kind, ordinal in (
            (code, f"{code} concrete placed today: {m3} m3 (pour {pour}). Signed: {SIGNER}.", "record", 1),
            ("remarks", f"Remarks: {remark}", "paragraph", 2)):
        conn.execute(text("""INSERT INTO sitemate.source_passages (project_id, source_id, locator, page, excerpt, ordinal, kind, section)
            VALUES (:p, :s, :l, 1, :e, :o, :k, 'Daily structure report') ON CONFLICT DO NOTHING"""),
                     {"p": project_id, "s": source_id, "l": locator, "e": excerpt, "o": ordinal, "k": kind})
    conn.execute(text("""INSERT INTO sitemate.observations (project_id, activity_code, work_date, source_id, locator, quantity, basis)
        VALUES (:p, :c, :d, :s, :c, :q, 'signed') ON CONFLICT DO NOTHING"""),
                 {"p": project_id, "c": code, "d": date.fromisoformat(day), "s": source_id, "q": m3})


def seed_house_demo(conn, project_id: str, model_id: str, member_id: str) -> dict:
    """The house from house_floor_plan.pdf (a draft read in architectural-plan mode): set a programme that started in
    late October, activate it, and record about half the concrete as signed reports (ground slab and ground-floor walls
    poured, first-floor slab half poured). Returns a summary."""
    from datetime import timedelta

    from . import store
    from .spec import validate

    row = store.get_model(conn, project_id, model_id)
    if row is None:
        raise LookupError(model_id)
    spec = row["spec"]
    pre = spec["levels"][0]["activity"].split("-")[0]           # e.g. "B2"
    gf, l1, roof = (f"{pre}-GF", f"{pre}-L1", f"{pre}-ROOF")
    programme = {gf: ("2026-10-26", "2026-11-06"), l1: ("2026-11-09", "2026-11-27"), roof: ("2026-11-30", "2026-12-18")}
    pour_dates = {f"{gf}-S": "2026-11-06", f"{l1}-V": "2026-11-18", f"{l1}-S": "2026-11-27",
                  f"{roof}-V": "2026-12-09", f"{roof}-S": "2026-12-18"}
    if row["status"] == "draft":
        for a in spec["activities"]:
            a["start"], a["finish"] = programme[a["code"]]
        for p in spec["pours"]:
            p["planned"] = pour_dates[p["id"]]
        spec, reasons = validate(spec, None)
        kept = [r for r in row["review_reasons"] or [] if r.get("severity") == "warning" and r.get("subject") != "programme"]
        kept.append({"severity": "warning", "subject": "programme", "refs": [],
                     "message": "programme dates entered by the site manager (ground slab 26 Oct - 6 Nov, ground-floor walls "
                                "and first-floor slab 9-27 Nov, first-floor walls and roof 30 Nov - 18 Dec)"})
        spec["source_type"] = "architectural_plan"
        store.update_draft(conn, project_id, model_id, spec=spec, reasons=kept + reasons, extraction_status="done")
        conn.execute(text("UPDATE sitemate.building_models SET status='superseded' WHERE project_id=:p AND status='active'"),
                     {"p": project_id})
        store.activate(conn, project_id, model_id, member_id=member_id,
                       as_of=datetime.now(ZoneInfo("UTC")).replace(microsecond=0) - timedelta(seconds=1))
    m3 = {p["id"]: p["m3"] for p in spec["pours"]}
    reports = [
        ("H2-20261109", "2026-11-09", gf, f"{gf}-S", m3[f"{gf}-S"],
         "Ground floor slab poured, 21.6 m3. Pour moved from Fri 6 Nov to Mon 9 Nov: heavy rain on 6 Nov, slab pour not permitted."),
        ("H2-20261119", "2026-11-19", l1, f"{l1}-V", m3[f"{l1}-V"],
         "Ground floor walls poured (external and internal). One day late: wall formwork panels delivered 18 Nov instead of 17 Nov."),
        ("H2-20261120", "2026-11-20", l1, f"{l1}-S", round(m3[f"{l1}-S"] / 2, 1),
         "First floor slab: west half poured (about half of the slab). East half rebar fixing continues next week."),
    ]
    for sid, day, code, pour, q, remark in reports:
        record_report(conn, project_id, source_id=sid, day=day, code=code, pour=pour, m3=q, remark=remark,
                      title_prefix="House daily report")
    total = sum(m3.values())
    done = sum(r[4] for r in reports)
    return {"model_id": model_id, "reports": [r[0] for r in reports], "built_m3": done, "total_m3": total,
            "pct": round(100 * done / total, 1)}


def seed_model(conn, project_id: str, deadline: date, member_id: str) -> str | None:
    """Create and activate the Riverside model from the reference spec when none is active."""
    from . import store
    from .spec import riverside_spec, validate

    if store.active_model(conn, project_id):
        return None
    now = datetime.now(ZoneInfo("UTC")).replace(microsecond=0)
    source_ids = []
    pdf = PACK / DRAWINGS
    if pdf.exists():
        data = pdf.read_bytes()
        conn.execute(text("""INSERT INTO sitemate.sources (project_id, id, kind, path, available_at, sha256, title, meta,
                                                          author, author_role)
            VALUES (:p, 'DRW-PLAN3', 'plan', :path, :at, :sha, :title, CAST(:meta AS jsonb), :a, 'site_supervisor')
            ON CONFLICT (project_id, id) DO NOTHING"""),
                     {"p": project_id, "path": DRAWINGS, "at": now, "sha": hashlib.sha256(data).hexdigest(),
                      "title": "Structural GA drawings RR-B-STR-S001..S301 Rev C1",
                      "meta": json.dumps({"filename": pdf.name, "kind": "drawings"}), "a": SIGNER})
        source_ids.append("DRW-PLAN3")
    spec, reasons = validate(riverside_spec())
    model_id = store.create_model(conn, project_id, source_ids=source_ids, title="Riverside Block B structure (reference spec)",
                                  deadline=deadline, member_id=member_id, as_of=now, extraction_status="done",
                                  spec=spec, reasons=reasons)
    store.activate(conn, project_id, model_id, member_id=member_id, as_of=now)
    return model_id


def main():
    from database import engine_for

    rows = plan_rows()
    apply = "--apply" in sys.argv
    deadline = None
    if "--model" in sys.argv:
        deadline = date.fromisoformat(sys.argv[sys.argv.index("--model") + 1])
    if not apply:
        for r in rows:
            print(f"would write {r['source_id']}: {r['day']} {r['code']} {r['pour']} {r['m3']} m3 signed")
        if deadline:
            print(f"would create and activate the Riverside model with deadline {deadline} (if none is active)")
        print("Dry run. Add --apply to write.")
        return
    if "--house" in sys.argv:
        model_id = sys.argv[sys.argv.index("--house") + 1]
        with engine_for("MIGRATION_DATABASE_URL").begin() as conn:
            manager = conn.scalar(text("SELECT member_id FROM sitemate.project_members WHERE project_id='RIV' "
                                       "AND role='manager' ORDER BY member_id LIMIT 1"))
            print(seed_house_demo(conn, "RIV", model_id, manager or "seed"))
        return
    write_files(rows)
    with engine_for("MIGRATION_DATABASE_URL").begin() as conn:
        if deadline:
            manager = conn.scalar(text("SELECT member_id FROM sitemate.project_members WHERE project_id='RIV' "
                                       "AND role='manager' ORDER BY member_id LIMIT 1"))
            made = seed_model(conn, "RIV", deadline, manager or "seed")
            print(f"model: {'activated ' + made if made else 'an active model already exists; left as is'}")
        print("reports:", ", ".join(seed_reports(conn, "RIV")))


if __name__ == "__main__":
    main()
