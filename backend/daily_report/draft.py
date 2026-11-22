"""Daily Report Drafter (P5): the day's site report from photos, notes, appointments and the day's figures.

    draft_daily_report(conn, project_id, work_date, when, member_id=None, models=None)

1. Gather (code, as of `when`): the day bundle of performance.daily.gather (plan, signed and estimated quantities,
   confirmed events, incidents, passages of the day), the appointments, the photos and their captions, open actions.
2. Figures (code): planned against signed quantity per activity, idle plant, incidents, appointments, open actions;
   every line cites its record.
3. Remarks (model, P5): cited prose for weather, workforce, deliveries, instructions, safety and quality, open items
   and remarks; uncited items and unsupported numbers are dropped. Without a model the stored day summary (P2) is used
   where it exists, and the remarks stay [MISSING: remarks].
4. Save: one daily_report draft per project and day (drafts.work_date), private to managers until submitted, through
   the same versions, review and export as notices. A redraft with changed content is a new version.
"""

from __future__ import annotations

import json
from datetime import date, datetime, time, timedelta

from sqlalchemy import text

from notice_templates import missing_fields, template, title_line
from performance import daily
from performance.prompts import ModelError, Models, number_tokens, validate_items

from . import appointments as appt
from .prompts import P5_SCHEMA, P5_SECTIONS, P5_SYSTEM

TYPE = "daily_report"
SECTION_TITLES = {"weather": "Weather and shift", "workforce": "Workforce and equipment",
                  "work": "Work performed against plan", "deliveries": "Deliveries",
                  "disruptions": "Disruptions and incidents", "appointments": "Inspections and meetings",
                  "instructions_received": "Instructions received", "safety_quality": "Safety and quality",
                  "open_items": "Open items", "photos": "Photos", "remarks": "Remarks"}


def _tag(refs) -> str:
    keys = [r if isinstance(r, str) else f"{r['source_id']}:{r['locator']}" for r in refs or [] if r]
    pairs = [k.split(":", 1) for k in dict.fromkeys(keys) if ":" in k]
    return (" [" + "; ".join(f"{s} · {loc}" for s, loc in pairs) + "]") if pairs else ""


def _num(v):
    return f"{float(v):g}" if v is not None else "?"


def gather(conn, project_id: str, work_date: date, when: datetime) -> dict:
    bundle = daily.gather(conn, project_id, work_date, when)
    rows = daily.activity_rows(bundle)
    ind = daily.indicators(bundle, rows)
    tz = bundle["tz"]
    start = datetime.combine(work_date, time.min, tz)
    photos = [dict(r) for r in conn.execute(text("""
        SELECT sp.source_id, sp.locator, sp.excerpt, s.available_at FROM sitemate.source_passages sp
        JOIN sitemate.sources s ON (s.project_id, s.id) = (sp.project_id, sp.source_id)
        WHERE sp.project_id = :p AND s.available_at <= :at AND s.available_at >= :s AND s.available_at < :e
          AND (sp.locator LIKE 'image:%' OR (s.kind = 'photo' AND sp.locator = 'caption'))
        ORDER BY s.available_at, sp.source_id, sp.locator LIMIT 12"""),
        {"p": project_id, "at": when, "s": start, "e": start + timedelta(days=1)}).mappings()]
    actions = [dict(r) for r in conn.execute(text("""
        SELECT a.description, a.owner_name, a.due_at, a.source_id, a.locator, sp.excerpt, s.available_at
        FROM sitemate.action_items a
        JOIN sitemate.sources s ON (s.project_id, s.id) = (a.project_id, a.source_id)
        JOIN sitemate.source_passages sp ON (sp.project_id, sp.source_id, sp.locator) = (a.project_id, a.source_id, a.locator)
        WHERE a.project_id = :p AND s.available_at <= :at AND (a.completed_at IS NULL OR a.completed_at > :at)
          AND coalesce(a.status, 'proposed') NOT IN ('done', 'rejected', 'superseded')
          AND (a.due_at IS NULL OR a.due_at < :e)
        ORDER BY a.due_at NULLS LAST LIMIT 10"""), {"p": project_id, "at": when, "e": start + timedelta(days=1)}).mappings()]
    stored = daily.daily_view(conn, project_id, work_date, as_of=when)
    return {"bundle": bundle, "rows": rows, "indicators": ind, "photos": photos, "actions": actions,
            "appointments": appt.current(conn, project_id, work_date, tz, when), "stored": stored}


def _payload(g) -> dict:
    b, tz = g["bundle"], g["bundle"]["tz"]
    passages = daily._passage_payload(b["passages"], tz)
    known = {p["ref"] for p in passages}
    # Photos, open actions (often agreed on an earlier day) and cited appointments may be cited as well.
    extra = [(ph, "photo") for ph in g["photos"]] + [(a, "action item") for a in g["actions"]]
    for item, kind in extra:
        ref = f"{item['source_id']}:{item['locator']}"
        if ref not in known and item.get("excerpt"):
            known.add(ref)
            passages.append({"ref": ref, "source_kind": kind, "title": None, "author_role": None,
                             "available_at": item["available_at"].astimezone(tz).strftime("%Y-%m-%d %H:%M"),
                             "untrusted": False, "page": None, "text": item["excerpt"]})
    return {"work_date": b["work_date"].isoformat(), "metrics": daily._metrics_table(g["rows"], g["indicators"]),
            "appointments": [{"kind": a["kind"], "title": a["title"], "starts_at": a["starts_at"].astimezone(tz).strftime("%H:%M"),
                              "status": a["status"]} for a in g["appointments"]],
            "passages": passages}


def remarks(g, models: Models | None) -> tuple[dict, str | None, str, list[str]]:
    """P5 sections (validated) -> (sections, model, source, dropped). source: model | day_summary | none."""
    payload = _payload(g)
    allowed = {p["ref"] for p in payload["passages"]}
    texts = {p["ref"]: p["text"] for p in payload["passages"]}
    numbers = number_tokens(json.dumps(payload["metrics"]), json.dumps(payload["appointments"]))
    if models is not None:
        try:
            raw, model = models.docs(P5_SYSTEM, [{"type": "text", "text": json.dumps(payload, default=str)}], P5_SCHEMA,
                                     effort="medium", max_tokens=8000)
            out, dropped = {}, []
            for section in P5_SECTIONS:
                kept, lost = validate_items(raw.get(section), allowed, texts, numbers, limit=6)
                out[section], dropped = kept, dropped + lost
            return out, model, "model", dropped
        except ModelError:
            pass
    summary = (g["stored"] or {}).get("summary") or {}
    if summary.get("status") not in (None, "not_requested", "model_unavailable", "all_dropped"):
        mapping = {"weather": "weather", "workforce": "resources", "deliveries": "deliveries",
                   "instructions_received": "instructions_received", "safety_quality": "safety_quality",
                   "open_items": "open_items"}
        return {k: list(summary.get(v) or []) for k, v in mapping.items()} | {"remarks": []}, None, "day_summary", []
    return {k: [] for k in P5_SECTIONS}, None, "none", []


def compose(g, sections: dict, project: dict, prepared_by: str | None) -> tuple[str, list[dict]]:
    b, tz = g["bundle"], g["bundle"]["tz"]
    wd: date = b["work_date"]
    settings = project.get("settings") or {}
    refs: list[str] = []

    def cite(items):
        lines = []
        for i in items:
            refs.extend(i.get("refs") or [])
            extra = ""
            if i.get("owner") or i.get("due"):
                extra = " (" + ", ".join(x for x in (i.get("owner"), f"due {i['due']}" if i.get("due") else None) if x) + ")"
            lines.append(f"- {i['text']}{extra}{_tag(i.get('refs'))}")
        return lines

    blocks = ["\n".join([title_line(TYPE, settings), f"{wd:%A %d %B %Y} | {project['name']}",
                         f"Prepared by: {prepared_by or '[MISSING: site manager signature]'}"])]
    n = 0

    def section(key, lines, empty):
        nonlocal n
        n += 1
        blocks.append(f"{n}. {SECTION_TITLES[key]}\n" + ("\n".join(lines) if lines else empty))

    shift = g.get("shift")
    weather = cite(sections.get("weather") or [])
    section("weather", ([f"Shift: {shift}"] if shift else ["Shift: [MISSING: shift hours]"]) + weather, "")
    plant = []
    for eq, code in sorted(b["assignments"].items()):
        meta = b["equipment"].get(eq) or {}
        plant.append(" ".join(f"- {eq} {meta.get('description') or ''} assigned to {code}".split()))
    for i in g["indicators"]["equipment_idle"]:
        refs.extend(i.get("refs") or [])
        plant.append(f"- {i['equipment_id']} idle {_num(i['hours'])} h{_tag(i.get('refs'))}")
    section("workforce", cite(sections.get("workforce") or []) + plant, "None recorded.")
    work = []
    for r in g["rows"]:
        if not r["planned"] and r["actual"] is None:
            continue
        cited = [x for x in (r.get("plan_ref"), r.get("actual_ref")) if x]
        refs.extend(cited)
        if r["actual"] is None:
            line = f"- {r['code']} {r.get('name') or ''}: planned {_num(r['planned'])} {r.get('unit') or ''}, no signed figure yet"
            if r.get("estimate"):
                refs.append(r["estimate"]["ref"])
                line += f"; estimate {_num(r['estimate']['value'])} {r.get('unit') or ''} (provisional){_tag([r['estimate']['ref']])}"
        else:
            pct = f" ({_num(r['variance_pct'])}%)" if r.get("variance_pct") is not None else ""
            line = (f"- {r['code']} {r.get('name') or ''}: planned {_num(r['planned'])}, signed {_num(r['actual'])} "
                    f"{r.get('unit') or ''}{pct}, {r['status'].replace('_', ' ')}")
        work.append(" ".join(line.split()) + _tag(cited))
    section("work", work, "No work planned or reported.")
    section("deliveries", cite(sections.get("deliveries") or []) +
            [f"- {e['summary']}{_tag([e['source_id'] + ':' + e['locator']])}" for e in b["events"]
             if e.get("category") == "delivery" and e["occurred_at"] >= b["start"]], "None recorded.")
    disruptions = []
    for inc in b["incidents"]:
        refs.extend(inc.get("refs") or [])
        state = "resolved" if inc["resolved_at"] else "open"
        disruptions.append(f"- {inc['occurred_at'].astimezone(tz):%H:%M} {inc['title']} ({state}){_tag(inc.get('refs'))}")
    section("disruptions", disruptions, "None recorded.")
    meetings = []
    for a in g["appointments"]:
        cited = [f"{a['source_id']}:{a['locator']}"] if a.get("source_id") else []
        refs.extend(cited)
        where = f", {a['location']}" if a.get("location") else ""
        status = "" if a["status"] == "planned" else f" ({a['status']})"
        meetings.append(f"- {a['starts_at'].astimezone(tz):%H:%M} {a['kind'].replace('_', ' ')}: {a['title']}{where}{status}"
                        f"{_tag(cited)}")
    section("appointments", meetings, "None recorded.")
    section("instructions_received", cite(sections.get("instructions_received") or []), "None recorded.")
    holds = []
    for q in g["indicators"]["quality_holds"]:
        refs.extend(q.get("refs") or [])
        holds.append(f"- {'Failed' if q['failed'] else 'Recorded'}: {q['text']}{_tag(q.get('refs'))}")
    section("safety_quality", cite(sections.get("safety_quality") or []) + holds, "None recorded.")
    opens = cite(sections.get("open_items") or [])
    for a in g["actions"]:
        cited = [f"{a['source_id']}:{a['locator']}"]
        refs.extend(cited)
        due = f", due {a['due_at'].astimezone(tz):%d %b %H:%M}" if a["due_at"] else ""
        owner = f" ({a['owner_name']}{due})" if a["owner_name"] else (f" ({due[2:]})" if due else "")
        opens.append(f"- {a['description']}{owner}{_tag(cited)}")
    section("open_items", opens, "None recorded.")
    photos = []
    for ph in g["photos"]:
        cited = [f"{ph['source_id']}:{ph['locator']}"]
        refs.extend(cited)
        photos.append(f"- {ph['excerpt'][:160]}{_tag(cited)}")
    section("photos", photos, "None recorded.")
    remark = cite(sections.get("remarks") or [])
    section("remarks", remark, "[MISSING: remarks]")
    blocks.append(f"{template(TYPE, settings)['closing']}: {prepared_by or '[MISSING: site manager signature]'}")
    body = "\n\n".join(blocks)
    unique = []
    for r in refs:
        if r and ":" in r and r not in unique:
            unique.append(r)
    return body, [{"source_id": r.split(":", 1)[0], "locator": r.split(":", 1)[1]} for r in unique]


def _shift(conn, project_id) -> str | None:
    row = conn.execute(text("SELECT shift_start, shift_end FROM sitemate.cost_settings WHERE project_id=:p"),
                       {"p": project_id}).mappings().one_or_none()
    return f"{row['shift_start']:%H:%M}–{row['shift_end']:%H:%M}" if row else None


def draft_daily_report(conn, project_id: str, work_date: date, when: datetime, *, member_id: str | None = None,
                       models: Models | None = None, use_llm: bool = True) -> dict:
    """Write (or revise) the daily report draft in the caller's transaction. Returns {draft_id, version, changed,
    model, remarks_source, dropped, missing}."""
    conn.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))"),
                 {"k": f"daily_report:{project_id}:{work_date}"})
    project = dict(conn.execute(text("SELECT * FROM sitemate.projects WHERE id=:p"), {"p": project_id}).mappings().one())
    g = gather(conn, project_id, work_date, when)
    g["shift"] = _shift(conn, project_id)
    prepared_by = None
    if member_id:
        prepared_by = conn.scalar(text("SELECT coalesce(display_name, member_id) FROM sitemate.project_members "
                                       "WHERE project_id=:p AND member_id=:m"), {"p": project_id, "m": member_id})
    sections, model, source, dropped = remarks(g, (models or Models()) if use_llm else None)
    body, refs = compose(g, sections, project, prepared_by)
    existing = conn.execute(text("""
        SELECT d.id::text AS id, v.version, v.body, v.as_of FROM sitemate.drafts d
        JOIN LATERAL (SELECT * FROM sitemate.draft_versions v WHERE (v.project_id, v.draft_id) = (d.project_id, d.id)
                      ORDER BY v.version DESC LIMIT 1) v ON true
        WHERE d.project_id = :p AND d.notice_type = :t AND d.work_date = :d"""),
        {"p": project_id, "t": TYPE, "d": work_date}).mappings().one_or_none()
    result = {"model": model, "remarks_source": source, "dropped": dropped, "missing": missing_fields(body)}
    if existing and existing["body"] == body:
        return {**result, "draft_id": existing["id"], "version": existing["version"], "changed": False}
    if existing:
        draft_id, version, floor = existing["id"], existing["version"] + 1, existing["as_of"]
    else:
        draft_id = str(conn.scalar(text("""
            INSERT INTO sitemate.drafts (project_id, notice_type, keywords, origin, work_date, created_by,
                                         analysis)
            VALUES (:p, :t, :k, 'daily_report', :d, :m, CAST(:an AS jsonb)) RETURNING id"""),
            {"p": project_id, "t": TYPE, "k": f"daily report {work_date.isoformat()}", "d": work_date, "m": member_id,
             "an": json.dumps({"subject": f"Daily site report {work_date:%d %B %Y}"})}))
        version, floor = 1, when
    conn.execute(text("""
        INSERT INTO sitemate.draft_versions (project_id, draft_id, version, as_of, body, evidence_refs, missing_fields)
        VALUES (:p, CAST(:d AS uuid), :v, greatest(:at, :floor), :b, CAST(:r AS jsonb), CAST(:m AS jsonb))"""),
                 {"p": project_id, "d": draft_id, "v": version, "at": when, "floor": floor, "b": body,
                  "r": json.dumps(refs), "m": json.dumps(missing_fields(body))})
    return {**result, "draft_id": draft_id, "version": version, "changed": True}
