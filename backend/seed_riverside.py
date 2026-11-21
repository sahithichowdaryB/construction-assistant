"""Replay the checked-in Riverside inputs into PostgreSQL. Run after migrations."""

import csv
import hashlib
import json
import os
import re
from datetime import date, timedelta
from pathlib import Path

from pypdf import PdfReader
from sqlalchemy import text

from database import engine_for
from documents.parsers import schedule_excerpt, schedule_successors

ROOT = Path(__file__).resolve().parents[1] / "data/riverside-demo"
REGISTERS = ROOT / "uploads/registers"
SCANNED_R11 = "e6315b3e69db41f32cfeb7e2258585eb96006f45a2f1ef89200dfc0faf73b6e8"


def csv_rows(name):
    with (REGISTERS / name).open(encoding="utf-8-sig", newline="") as source:
        return list(csv.DictReader(source))


def report_rows(path, activities):
    # Reviewed transcription of the included scanned page. A different scan needs OCR/review.
    if hashlib.sha256(path.read_bytes()).hexdigest() == SCANNED_R11:
        return 1, {"EXC-B": 80, "REBAR-L1": 4}, "Other scheduled activities recorded zero production this shift."
    for page_number, page in enumerate(PdfReader(path).pages, start=1):
        content = page.extract_text() or ""
        if "Measured shift quantities" not in content:
            continue
        rows = {}
        for activity in activities:
            code, unit = activity["activity_id"], activity["unit"]
            match = re.search(
                rf"^{re.escape(code)}\n[^\n]+\n{re.escape(unit)}\n\d+\n(\d+)$", content, re.M
            )
            if match:
                rows[code] = int(match[1])
        zero_note = "Other scheduled activities recorded zero production this shift."
        if rows and zero_note in " ".join(content.split()):
            return page_number, rows, zero_note
    raise ValueError(f"Unrecognized quantity table in {path.name}; review before importing")


def collect_rows():
    project = json.loads((REGISTERS / "project.json").read_text(encoding="utf8"))
    manifest = json.loads((ROOT / "index.json").read_text(encoding="utf8"))
    pid = project["id"]
    tables = {}

    def add(table, **fields):
        tables.setdefault(table, []).append({"project_id": pid, **fields})

    tables["projects"] = [dict(id=pid, name=project["name"], timezone=project["timezone"],
                               threshold=project["deviation_threshold_pct"],
                               high_threshold=project["high_if_shortfall_pct_above"])]
    for field in ("sender", "sender_address", "recipient", "recipient_address", "contract_reference", "contract_clause"):
        tables["projects"][0][field] = project[field]
    entries = manifest["records"]
    for entry in entries:
        if not (ROOT / entry["path"]).is_file():
            raise FileNotFoundError(entry["path"])
        add("sources", id=entry["id"], kind=entry["type"], path=entry["path"],
            available_at=entry["available_at"])
    for row in csv_rows("contractors.csv"):
        add("contractors", id=row["contractor_id"], name=row["name"], trade=row["trade"],
            contact_role=row["contact_role"])
    activities = csv_rows("schedule.csv")
    first = date.fromisoformat(min(a["planned_start"] for a in activities))
    last = date.fromisoformat(max(a["planned_end"] for a in activities))
    successors = schedule_successors(activities)
    for a in activities:
        code = a["activity_id"]
        add("activities", code=code, name=a["activity"], unit=a["unit"], zone=a["zone"],
            contractor_id=a["contractor_id"])
        for predecessor in filter(None, a["predecessors"].split("|")):
            add("activity_dependencies", predecessor=predecessor, successor=code)
        add("source_passages", source_id="SCH", locator=code, page=None,
            excerpt=schedule_excerpt(a, successors.get(code, ())))
        for offset in range((last - first).days + 1):
            day = (first + timedelta(days=offset)).isoformat()
            active = a["planned_start"] <= day <= a["planned_end"]
            add("plan_targets", activity_code=code, work_date=day,
                quantity=int(a["planned_qty_per_day"]) if active else 0,
                source_id="SCH", locator=code)
    for e in csv_rows("equipment.csv"):
        add("equipment", id=e["equipment_id"], description=e["description"], owner_id=e["owner_id"])
        add("equipment_assignments", equipment_id=e["equipment_id"], work_date="2026-11-10",
            activity_code=e["assignment_on_2026_11_10"])
    for entry in entries:
        path = ROOT / entry["path"]
        if entry["type"] == "daily_report":
            page, rows, zero_note = report_rows(path, activities)
            for a in activities:
                code = a["activity_id"]
                actual = rows.get(code, 0)
                locator = code if code in rows else f"zero-{code}"
                excerpt = f"{code}: actual {actual} {a['unit']}" if code in rows else zero_note
                add("source_passages", source_id=entry["id"], locator=locator, page=page, excerpt=excerpt)
                add("observations", activity_code=code, work_date=path.stem[-10:], quantity=actual,
                    basis="signed", source_id=entry["id"], locator=locator)
        elif entry["id"] == "D10":
            excerpt = path.read_text(encoding="utf8").strip()
            match = re.search(r"estimates (\d+) m³ in Excavation Zone B", excerpt)
            if not match:
                raise ValueError("Review changed D10 diary")
            add("source_passages", source_id="D10", locator="handover", page=None, excerpt=excerpt)
            add("observations", activity_code="EXC-B", work_date=path.stem, quantity=int(match[1]),
                basis="estimated", source_id="D10", locator="handover")
    token = os.environ["RIVERSIDE_DEMO_TOKEN"]
    # A pasted line ending in "...=postgresql://..." must not become everyone's password.
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", token):
        raise ValueError("RIVERSIDE_DEMO_TOKEN must be 32-128 letters, digits, '-' or '_' "
                         f"(got {len(token)} characters); check backend/.env for a broken line")
    add("project_members", member_id="riverside-demo", token_hash=hashlib.sha256(token.encode()).hexdigest(),
        role="manager")
    return tables


# Order follows foreign keys. All identifiers come from this module.
KEYS = {
    "projects": "id", "project_members": "project_id member_id", "sources": "project_id id",
    "source_passages": "project_id source_id locator", "contractors": "project_id id",
    "activities": "project_id code", "activity_dependencies": "project_id predecessor successor",
    "equipment": "project_id id", "equipment_assignments": "project_id equipment_id work_date",
    "plan_targets": "project_id activity_code work_date",
    "observations": "project_id activity_code work_date source_id locator",
}


def seed_workflows(conn):
    """Materialize the Riverside diary and its initial signed shortfall alerts."""
    conn.execute(text("""
        INSERT INTO sitemate.diary_entries
            (project_id,id,work_date,body,source_id,locator,recorded_at)
        SELECT s.project_id,'2ad2a5f6-8003-4b30-a8bb-e94e30a07385',o.work_date,
               sp.excerpt,s.id,sp.locator,s.available_at
        FROM sitemate.sources s JOIN sitemate.source_passages sp
          ON (sp.project_id,sp.source_id)=(s.project_id,s.id)
        JOIN sitemate.observations o ON (o.project_id,o.source_id,o.locator)=(sp.project_id,sp.source_id,sp.locator)
        WHERE s.project_id='RIV' AND s.id='D10' AND sp.locator='handover'
        ON CONFLICT DO NOTHING
    """))
    rows = conn.execute(text("""
        SELECT o.activity_code,o.work_date,o.quantity AS actual,o.source_id,o.locator,s.available_at,
               t.quantity AS planned,t.source_id AS plan_source,t.locator AS plan_locator,
               p.threshold,p.high_threshold,p.timezone,a.unit,
               ((o.work_date + TIME '17:30') AT TIME ZONE p.timezone) AS checkpoint
        FROM sitemate.observations o JOIN sitemate.plan_targets t USING(project_id,activity_code,work_date)
        JOIN sitemate.sources s ON (s.project_id,s.id)=(o.project_id,o.source_id)
        JOIN sitemate.activities a ON (a.project_id,a.code)=(o.project_id,o.activity_code)
        JOIN sitemate.projects p ON p.id=o.project_id
        WHERE o.project_id='RIV' AND o.basis='signed' AND t.quantity>0
          AND 100*(t.quantity-o.quantity)>p.threshold*t.quantity
        ORDER BY s.available_at,o.activity_code
    """)).mappings().all()
    for row in rows:
        params = {"code": row["activity_code"], "checkpoint": row["checkpoint"]}
        conn.execute(text("""
            INSERT INTO sitemate.alerts(project_id,activity_code,checkpoint_at,kind)
            VALUES ('RIV',:code,:checkpoint,'shortfall') ON CONFLICT DO NOTHING
        """), params)
        pct = 100 * (row["planned"] - row["actual"]) / row["planned"]
        params.update(as_of=row["available_at"], severity="high" if pct > row["high_threshold"] else "medium",
                      calculation=json.dumps(dict(planned=float(row["planned"]), actual=float(row["actual"]),
                                                  shortfall_pct=float(round(pct, 2)), unit=row["unit"])),
                      refs=json.dumps([{"source_id": row["plan_source"], "locator": row["plan_locator"]},
                                       {"source_id": row["source_id"], "locator": row["locator"]}]))
        conn.execute(text("""
            INSERT INTO sitemate.alert_revisions(project_id,alert_id,version,as_of,severity,calculation,evidence_refs)
            SELECT project_id,id,1,:as_of,:severity,CAST(:calculation AS jsonb),CAST(:refs AS jsonb)
              FROM sitemate.alerts WHERE project_id='RIV' AND activity_code=:code
               AND checkpoint_at=:checkpoint AND kind='shortfall'
            ON CONFLICT DO NOTHING
        """), params)


def main():
    tables = collect_rows()
    with engine_for("MIGRATION_DATABASE_URL").begin() as conn:
        for table, key in KEYS.items():
            rows = tables[table]
            columns = list(rows[0])
            updates = [f"{c} = EXCLUDED.{c}" for c in columns if c not in key.split()]
            conflict = "DO UPDATE SET " + ", ".join(updates) if updates else "DO NOTHING"
            statement = text(f"INSERT INTO sitemate.{table} ({', '.join(columns)}) "
                             f"VALUES ({', '.join(':' + c for c in columns)}) "
                             f"ON CONFLICT ({', '.join(key.split())}) {conflict}")
            conn.execute(statement, rows)
        seed_workflows(conn)
    print(f"Imported {len(tables['sources'])} sources and {len(tables['observations'])} observations.")


if __name__ == "__main__":
    main()
