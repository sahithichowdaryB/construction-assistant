"""Add the three 13 November Riverside test incidents to an existing Riverside project."""

import json
import uuid

from pypdf import PdfReader
from sqlalchemy import text

from database import engine_for


# Fact values are what the source reported. Expected AI judgments live in evaluation/.
CASES = [
    ("pump-inspection", "West wing pour on hold", "POUR-L1", "inspection_hold", "V11", None, [
        ("V11", "seg:2", "workers_affected", {"count": 2}, "reported"),
        ("V11", "seg:1", "hold_reason", {"text": "Pump inspection sticker expired"}, "reported"),
        ("E05", "para:1", "inspection_register", {"text": "Site manager confirmed expiry"}, "reported"),
    ]),
    ("spacer-delivery", "Zone B spacer delivery late", "FND-B", "delivery_delay", "V12", "G13", [
        ("V12", "seg:2", "workers_affected", {"count": 4}, "reported"),
        ("E06", "para:1", "arrival_estimate", {"local_time": "10:30"}, "forecast"),
        ("G13", "page:1", "arrival", {"local_time": "10:45"}, "reported"),
        ("E07", "para:1", "delivery_update", {"text": "Gate docket checked"}, "reported"),
    ]),
    ("survey-tablet", "Zone B survey tablet stopped saving", "FND-B", "equipment_failure", "V13", None, [
        ("V13", "seg:2", "workers_affected", {"count": 1}, "reported"),
        ("V13", "seg:3", "diagnosis", {"text": "No fault code or diagnosis"}, "reported"),
    ]),
]


def seed(conn, root, parse_text):
    manifest = json.loads((root / "index.json").read_text("utf8"))
    records = {entry["id"]: entry for entry in manifest["records"]}
    source_ids = {fact[0] for *_, facts in CASES for fact in facts}
    for source_id in sorted(source_ids):
        record = records[source_id]
        path = root / record["path"]
        if not path.is_file():
            raise FileNotFoundError(path)
        conn.execute(text("""
            INSERT INTO sitemate.sources (project_id,id,kind,path,available_at,author,author_role)
            VALUES ('RIV',:id,:type,:path,:available_at,:author,:author_role) ON CONFLICT DO NOTHING
        """), record)
        if path.suffix == ".pdf":
            passages = [(f"page:{n}", n, page.extract_text().strip())
                        for n, page in enumerate(PdfReader(path).pages, 1)]
        else:
            passages = [(locator, None, excerpt) for locator, excerpt in parse_text(record, root)]
        for locator, page_no, excerpt in passages:
            if not excerpt:
                raise ValueError(f"Empty passage in {source_id} at {locator}")
            conn.execute(text("""
                INSERT INTO sitemate.source_passages (project_id,source_id,locator,page,excerpt)
                VALUES ('RIV',:s,:l,:page,:excerpt) ON CONFLICT DO NOTHING
            """), dict(s=source_id, l=locator, page=page_no, excerpt=excerpt))

    for key, title, activity, kind, first, last, facts in CASES:
        incident_id = uuid.uuid5(uuid.NAMESPACE_URL, f"sitemate/RIV/2026-11-13/{key}")
        conn.execute(text("""
            INSERT INTO sitemate.incidents (project_id,id,activity_code,kind,title,occurred_at,resolved_at)
            VALUES ('RIV',:id,:activity,:kind,:title,:start,:finish) ON CONFLICT DO NOTHING
        """), dict(id=incident_id, activity=activity, kind=kind, title=title,
                   start=records[first]["available_at"], finish=records[last]["available_at"] if last else None))
        for source_id, locator, field, value, basis in facts:
            fact_id = uuid.uuid5(incident_id, f"{source_id}/{locator}/{field}")
            params = dict(id=fact_id, incident=incident_id, s=source_id, l=locator, field=field,
                          value=json.dumps(value), basis=basis)
            conn.execute(text("""
                INSERT INTO sitemate.capture_facts (project_id,id,incident_id,source_id,locator,field_name,value,basis)
                VALUES ('RIV',:id,:incident,:s,:l,:field,CAST(:value AS jsonb),:basis) ON CONFLICT DO NOTHING
            """), params)
            conn.execute(text("""
                INSERT INTO sitemate.fact_evidence (project_id,fact_id,source_id,locator)
                VALUES ('RIV',:id,:s,:l) ON CONFLICT DO NOTHING
            """), params)


if __name__ == "__main__":
    from seed_riverside import ROOT, text_passages

    with engine_for("MIGRATION_DATABASE_URL").begin() as connection:
        seed(connection, ROOT, text_passages)
    print("Riverside field cases ready: 3 incidents, 7 sources, 9 linked facts.")
