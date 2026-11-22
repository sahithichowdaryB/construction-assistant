"""Database reads and writes for the 3D model (tables in model3d/schema.py)."""

from __future__ import annotations

import json
from datetime import date, datetime

from sqlalchemy import text

from . import generator
from .spec import blocking, parse_day, untracked

COLUMNS = """project_id, id::text AS id, revision, status, extraction_status, title, source_ids, spec, review_reasons,
             deadline, model, error, created_by, created_at, as_of, activated_by, activated_at"""


def tables_installed(conn) -> bool:
    return conn.scalar(text("SELECT to_regclass('sitemate.building_models') IS NOT NULL")) is True


def create_model(conn, project_id: str, *, source_ids: list[str], title: str | None, deadline: date | None,
                 member_id: str, as_of: datetime, extraction_status: str = "queued", spec: dict | None = None,
                 reasons: list[dict] | None = None) -> str:
    revision = conn.scalar(text("SELECT coalesce(max(revision), 0) + 1 FROM sitemate.building_models WHERE project_id=:p"),
                           {"p": project_id})
    return conn.scalar(text("""
        INSERT INTO sitemate.building_models (project_id, revision, extraction_status, title, source_ids, spec,
                                              review_reasons, deadline, created_by, as_of)
        VALUES (:p, :r, :x, :t, :s, CAST(:spec AS jsonb), CAST(:rr AS jsonb), :d, :m, :at)
        RETURNING id::text"""), {"p": project_id, "r": revision, "x": extraction_status, "t": title, "s": source_ids,
                                 "spec": json.dumps(spec or {}), "rr": json.dumps(reasons or []), "d": deadline,
                                 "m": member_id, "at": as_of})


def get_model(conn, project_id: str, model_id: str) -> dict | None:
    row = conn.execute(text(f"SELECT {COLUMNS} FROM sitemate.building_models WHERE project_id=:p AND id=CAST(:i AS uuid)"),
                       {"p": project_id, "i": model_id}).mappings().one_or_none()
    return dict(row) if row else None


def list_models(conn, project_id: str, as_of: datetime | None) -> list[dict]:
    rows = conn.execute(text(f"""SELECT {COLUMNS} FROM sitemate.building_models WHERE project_id=:p
        AND as_of <= coalesce(CAST(:cutoff AS timestamptz), 'infinity') ORDER BY revision DESC"""),
                        {"p": project_id, "cutoff": as_of}).mappings().all()
    return [dict(r) for r in rows]


def active_model(conn, project_id: str) -> dict | None:
    """The active model. It is not filtered by the As of clock: the drawings describe the building to be built;
    the clock only decides which progress records are known."""
    row = conn.execute(text(f"SELECT {COLUMNS} FROM sitemate.building_models WHERE project_id=:p AND status='active'"),
                       {"p": project_id}).mappings().one_or_none()
    return dict(row) if row else None


def update_draft(conn, project_id: str, model_id: str, *, spec: dict | None = None, reasons: list[dict] | None = None,
                 extraction_status: str | None = None, model: str | None = None, deadline: date | None = None,
                 title: str | None = None, error: str | None = None):
    conn.execute(text("""
        UPDATE sitemate.building_models SET
            spec = coalesce(CAST(:spec AS jsonb), spec), review_reasons = coalesce(CAST(:rr AS jsonb), review_reasons),
            extraction_status = coalesce(:x, extraction_status), model = coalesce(:model, model),
            deadline = coalesce(:d, deadline), title = coalesce(:t, title), error = :e
        WHERE project_id=:p AND id=CAST(:i AS uuid) AND status='draft'"""),
                 {"p": project_id, "i": model_id, "spec": json.dumps(spec) if spec is not None else None,
                  "rr": json.dumps(reasons) if reasons is not None else None, "x": extraction_status, "model": model,
                  "d": deadline, "t": title, "e": error})


def activate(conn, project_id: str, model_id: str, *, member_id: str, as_of: datetime) -> dict:
    """One transaction: generate the elements, write pours and elements, add missing activities (so reports can
    record quantities against them), supersede the previous active model, activate this one."""
    row = conn.execute(text(f"SELECT {COLUMNS} FROM sitemate.building_models WHERE project_id=:p AND id=CAST(:i AS uuid) "
                            "FOR UPDATE"), {"p": project_id, "i": model_id}).mappings().one_or_none()
    if row is None:
        raise LookupError(model_id)
    if row["status"] != "draft":
        raise ValueError("Only a draft model can be activated")
    if row["extraction_status"] in ("queued", "running"):
        raise ValueError("The drawings are still being read")
    if blocking(row["review_reasons"] or []):
        raise ValueError("Resolve the blocking review notes first")
    if row["deadline"] is None:
        raise ValueError("Enter the deadline before activating")
    spec = row["spec"] or {}
    if not spec.get("levels"):
        raise ValueError("The model has no levels")
    built = generator.generate(spec)
    refs = spec.get("refs") or {}
    for p in built["pours"]:
        conn.execute(text("""INSERT INTO sitemate.model_pours (project_id, model_id, pour_id, activity_code, seq, kind,
                                planned_date, m3, x_from, x_to, refs)
            VALUES (:p, CAST(:m AS uuid), :id, :a, :seq, :k, :d, :m3, :xf, :xt, CAST(:refs AS jsonb))"""),
                     {"p": project_id, "m": model_id, "id": p["id"], "a": p["activity"], "seq": p["seq"], "k": p["kind"],
                      "d": parse_day(p["planned"]), "m3": p["m3"], "xf": p["x_from"], "xt": p["x_to"],
                      "refs": json.dumps(refs.get(f"pours.{p['id']}") or [])})
    conn.execute(text("""INSERT INTO sitemate.model_elements (project_id, model_id, element_id, kind, level, activity_code,
                            pour_id, mark, box, volume_m3)
        SELECT :p, CAST(:m AS uuid), e->>'id', e->>'kind', e->>'level', e->>'activity', e->>'pour', e->>'mark',
               e->'box', (e->>'volume_m3')::numeric
        FROM jsonb_array_elements(CAST(:els AS jsonb)) e"""),
                 {"p": project_id, "m": model_id, "els": json.dumps(built["elements"])})
    names = {a["code"]: a.get("name") for a in spec.get("activities") or []}
    levels = {lv["activity"]: lv["name"] for lv in spec.get("levels") or []}
    added = []
    skip = untracked(spec)   # drawn only: not a programme activity, so not added to the activity list
    for code in dict.fromkeys(p["activity"] for p in built["pours"] if p["activity"] not in skip):
        made = conn.execute(text("""INSERT INTO sitemate.activities (project_id, code, name, unit, zone)
            VALUES (:p, :c, :n, 'm³', :z) ON CONFLICT (project_id, code) DO NOTHING RETURNING code"""),
                            {"p": project_id, "c": code, "n": names.get(code) or f"{levels.get(code, code)} structure",
                             "z": levels.get(code) or "building"}).scalar()
        if made:
            added.append(made)
    conn.execute(text("""UPDATE sitemate.building_models SET status='superseded'
                         WHERE project_id=:p AND status='active' AND id <> CAST(:m AS uuid)"""), {"p": project_id, "m": model_id})
    conn.execute(text("""UPDATE sitemate.building_models SET status='active', activated_by=:u, activated_at=:at
                         WHERE project_id=:p AND id=CAST(:m AS uuid)"""),
                 {"p": project_id, "m": model_id, "u": member_id, "at": as_of})
    return {"id": model_id, "status": "active", "elements": len(built["elements"]), "pours": len(built["pours"]),
            "activities_added": added}


def geometry(conn, project_id: str, model_id: str) -> dict:
    pours = conn.execute(text("""SELECT pour_id AS id, activity_code AS activity, seq, kind, planned_date, m3, x_from, x_to, refs
        FROM sitemate.model_pours WHERE project_id=:p AND model_id=CAST(:m AS uuid) ORDER BY seq"""),
                         {"p": project_id, "m": model_id}).mappings().all()
    elements = conn.execute(text("""SELECT element_id AS id, kind, level, activity_code AS activity, pour_id AS pour, mark,
            box, volume_m3 FROM sitemate.model_elements WHERE project_id=:p AND model_id=CAST(:m AS uuid)
        ORDER BY element_id"""), {"p": project_id, "m": model_id}).mappings().all()
    return {
        "pours": [{"id": p["id"], "activity": p["activity"], "seq": p["seq"], "kind": p["kind"],
                   "planned": p["planned_date"].isoformat() if p["planned_date"] else None, "m3": float(p["m3"]),
                   "x_from": float(p["x_from"]) if p["x_from"] is not None else None,
                   "x_to": float(p["x_to"]) if p["x_to"] is not None else None, "refs": p["refs"] or []} for p in pours],
        "elements": [{"id": e["id"], "kind": e["kind"], "level": e["level"], "activity": e["activity"], "pour": e["pour"],
                      "mark": e["mark"], "box": [float(v) for v in e["box"]], "volume_m3": float(e["volume_m3"])}
                     for e in elements],
    }


def save_progress(conn, project_id: str, model_id: str, day: date, as_of: datetime, digest: str,
                  actual: dict[str, dict]) -> int:
    """Store the pour states as a new version unless the latest version for that date has the same inputs."""
    latest = conn.execute(text("""SELECT version, input_digest FROM sitemate.element_progress
        WHERE project_id=:p AND model_id=CAST(:m AS uuid) AND work_date=:d ORDER BY version DESC LIMIT 1"""),
                          {"p": project_id, "m": model_id, "d": day}).one_or_none()
    if latest and latest.input_digest == digest:
        return latest.version
    version = (latest.version if latest else 0) + 1
    conn.execute(text("""INSERT INTO sitemate.element_progress (project_id, model_id, work_date, version, pour_id, status,
                            pct, done_m3, basis, refs, as_of, input_digest)
        SELECT :p, CAST(:m AS uuid), :d, :v, s->>'pour_id', s->>'status', (s->>'pct')::numeric, (s->>'done_m3')::numeric,
               s->>'basis', s->'refs', :at, :dig
        FROM jsonb_array_elements(CAST(:states AS jsonb)) s"""),
                 {"p": project_id, "m": model_id, "d": day, "v": version, "at": as_of, "dig": digest,
                  "states": json.dumps([{"pour_id": pid, **{k: st[k] for k in ("status", "pct", "done_m3", "basis", "refs")}}
                                        for pid, st in actual.items()])})
    return version
