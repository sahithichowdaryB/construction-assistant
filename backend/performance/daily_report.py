"""Generate the daily site report for one work date as PDF (ReportLab) or Word (python-docx).

The report covers that day only, as known at `as_of`:
  - Safety incidents safety incidents that occurred that day: time, incident, severity (shown only when any)
  - Delays           material and delivery delays only, under one heading "Materials and deliveries": delivery
                     incidents of the day (late, short or damaged material) with the shortfalls they caused, and
                     supplier-caused shortfalls, naming the material (see delay_groups)            (only when any)
                     A line says how many working days it delayed project completion, when the forecast completion
                     date would have been earlier had that activity met its plan that day (see project_impact)
  - Tasks            action items raised from that day's records and the open items in the day summary, with their
                     due time (only when any)
The day's activities (from the daily evaluation, performance/daily.py) are not listed; they feed the delay lines.
No model is called here. The output is a draft for the site manager to check and sign, not a signed record.
"""

from __future__ import annotations

import json
import re
from datetime import date, datetime, time, timedelta
from functools import lru_cache
from io import BytesIO
from pathlib import Path
from xml.sax.saxutils import escape
from zoneinfo import ZoneInfo

from sqlalchemy import text

from . import metrics as m
from .baseline import active_baseline, load_settings
from .daily import _plans, load_series
from .metrics import DISCLAIMER

PDF = "application/pdf"
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
TAXONOMY = Path(__file__).resolve().parents[1] / "rules" / "event_taxonomy.json"
SAFETY = {"safety"}
# The report lists material and delivery delays only (taxonomy category "delivery"), under this heading.
DELAY_GROUPS = {"delivery": "Materials and deliveries"}
GROUP_ORDER = list(DELAY_GROUPS.values())
# A shortfall with no linked incident is kept when its attributed cause is the supplier (a material delay).
CAUSE_GROUP = {"supplier": DELAY_GROUPS["delivery"]}
EQUIPMENT_ID = re.compile(r"\b[A-Z]{2}-\d{2}\b")
# Fallback when no material is recorded on the incident's events or facts: common materials named in its text.
MATERIALS = re.compile(r"\b(ready-mix concrete|concrete|cement|grout|mortar|rebar|reinforcement|steel|formwork|timber|"
                       r"aggregate|gravel|sand|bricks?|blocks?|asphalt|bitumen|pipes?|cables?|glass|insulation|"
                       r"plasterboard|drywall|tiles?|paint)\b", re.I)
SAFETY_HEAD = ["Time", "Incident", "Severity"]
TASK_HEAD = ["Task", "Due"]
NOTHING = "No safety incidents, material delays or open tasks were recorded for this day."


@lru_cache(maxsize=1)
def _categories() -> dict[str, str]:
    """Event type -> category, from the capture taxonomy."""
    types = json.loads(TAXONOMY.read_text())["types"]
    items = types.items() if isinstance(types, dict) else ((t.get("key") or t.get("id"), t) for t in types)
    return {key: (t.get("category") if isinstance(t, dict) else t) for key, t in items}


def category_of(incident: dict) -> str | None:
    cats = _categories()
    return incident.get("category") or cats.get(incident.get("event_type") or "") or cats.get(incident.get("kind") or "")


def day_records(conn, project_id: str, work_date: date, as_of: datetime | None, timezone: str) -> dict:
    """Incidents that occurred on the work date and action items raised from that day's records, known at as_of."""
    start = datetime.combine(work_date, time.min, ZoneInfo(timezone))
    params = {"p": project_id, "start": start, "end": start + timedelta(days=1), "cutoff": as_of}
    cutoff = "coalesce(CAST(:cutoff AS timestamptz), 'infinity')"
    incidents = conn.execute(text(f"""
        SELECT i.id::text AS id, i.asset_key, i.title, i.summary, i.activity_code, i.occurred_at, i.kind, i.event_type, i.category, i.severity,
               CASE WHEN i.resolved_at <= {cutoff} THEN i.resolved_at END AS resolved_at
        FROM sitemate.incidents i
        WHERE i.project_id = :p AND i.merged_into_id IS NULL AND i.occurred_at >= :start AND i.occurred_at < :end
          AND i.occurred_at <= {cutoff}
        ORDER BY i.occurred_at, i.id"""), params).mappings().all()
    tasks = conn.execute(text(f"""
        SELECT a.description, a.owner_name, a.due_at, a.source_id, a.locator
        FROM sitemate.action_items a
        JOIN sitemate.sources s ON (s.project_id, s.id) = (a.project_id, a.source_id)
        WHERE a.project_id = :p AND s.available_at >= :start AND s.available_at < :end AND s.available_at <= {cutoff}
          AND (a.completed_at IS NULL OR a.completed_at > {cutoff})
        ORDER BY s.available_at, a.id"""), params).mappings().all()
    # Equipment and material recorded for each incident: on its linked events and on its reviewed capture facts.
    details = {}
    ids = [r["id"] for r in incidents]
    if ids:
        for r in conn.execute(text(f"""
            SELECT ie.incident_id::text AS id, e.equipment_id AS equipment, e.attributes->>'material' AS material
            FROM sitemate.incident_events ie
            JOIN sitemate.events e ON (e.project_id, e.id) = (ie.project_id, ie.event_id)
            WHERE ie.project_id = :p AND ie.unlinked_at IS NULL AND e.recorded_at <= {cutoff}
              AND ie.incident_id = ANY(CAST(:ids AS uuid[]))
            UNION ALL
            SELECT cf.incident_id::text, CASE WHEN cf.field_name = 'equipment_id' THEN cf.value #>> '{{}}' END,
                   CASE WHEN cf.field_name = 'material' THEN cf.value #>> '{{}}' END
            FROM sitemate.capture_facts cf JOIN sitemate.sources s ON (s.project_id, s.id) = (cf.project_id, cf.source_id)
            WHERE cf.project_id = :p AND cf.incident_id = ANY(CAST(:ids AS uuid[]))
              AND cf.field_name IN ('equipment_id', 'material') AND cf.review_status <> 'rejected'
              AND s.available_at <= {cutoff}"""), {**params, "ids": ids}).mappings():
            item = details.setdefault(r["id"], {"equipment": [], "materials": []})
            if r["equipment"] and r["equipment"] not in item["equipment"]:
                item["equipment"].append(r["equipment"])
            if r["material"] and r["material"].strip().lower() not in [x.lower() for x in item["materials"]]:
                item["materials"].append(r["material"].strip())
    equipment = {r["id"]: r["description"] for r in conn.execute(text(
        "SELECT id, description FROM sitemate.equipment WHERE project_id = :p"), params).mappings()}
    return {"incidents": [dict(r) for r in incidents], "tasks": [dict(r) for r in tasks], "details": details,
            "equipment": equipment}


def project_impact(conn, project_id: str, work_date: date, when: datetime, codes: set[str]) -> dict | None:
    """How the work date moved the project's forecast completion, and which of `codes` caused it.

    Uses the overall evaluation's forecast (performance/metrics.py: cumulative progress per activity, then a forward
    pass over the dependencies; the latest finish is the completion date), with the records known at `when`:
      - before:  measured to the end of the previous working day
      - after:   measured to the end of the work date
      - per activity in `codes`: `after` again, as if that activity had produced its planned quantity on the work date.
        The working days that brings completion forward are the days of project delay that activity caused.
    None when there is no plan or no signed quantity for the work date yet (the day's outcome is not known)."""
    baseline = active_baseline(conn, project_id, when)
    baseline_id = baseline["id"] if baseline else None
    settings = load_settings(conn, project_id, baseline_id)
    cal = m.Calendar.from_settings(settings)
    targets, _, signed, _ = load_series(conn, project_id, when)
    plans = _plans(conn, project_id, baseline_id, targets)
    if not plans or not any(work_date in series for series in signed.values()):
        return None
    window = int(settings.get("recent_rate_window") or 5)
    produced = {c: {d: v["quantity"] for d, v in series.items()} for c, series in signed.items()}

    def forecast(to, met=None):
        given = {c: dict(series) for c, series in produced.items()}
        if met:
            planned = targets.get(met, {}).get(work_date) or 0
            given.setdefault(met, {})[work_date] = max(given.get(met, {}).get(work_date) or 0, planned)
        actuals, _, _ = m.carry_in(targets, given)
        cum = {p.code: m.cumulative(p, targets.get(p.code, {}), actuals.get(p.code, {}), to, cal, window) for p in plans}
        return cum, m.forward_pass(plans, cum, to, cal)

    _, before = forecast(cal.previous_working(work_date))
    cum, after = forecast(work_date)
    if not after["completion"]:
        return None
    caused = {}
    for code in sorted(codes & {p.code for p in plans}):
        _, alt = forecast(work_date, met=code)
        caused[code] = max(cal.between(alt["completion"], after["completion"]), 0) if alt["completion"] else 0
    planned = max((p.planned_finish for p in plans if p.planned_finish), default=None)
    carried = [c for c, f in after["float"].items() if f is not None and f <= 0 and (cum[c].get("days_behind") or 0) > 0
               and not caused.get(c)]
    return {"planned_completion": planned, "before": before["completion"], "after": after["completion"],
            "slip": cal.between(before["completion"], after["completion"]) if before["completion"] else None,
            "late": cal.between(planned, after["completion"]) if planned else None,
            "caused": caused, "carried": sorted(carried)}


def _days(n: int) -> str:
    return f"{n} working day{'' if abs(n) == 1 else 's'}"


def _qty(value) -> str:
    return "-" if value is None else f"{value:g}"


def _cite(item: dict) -> str:
    """The item's text. Source references are not printed in the report."""
    return item["text"]


def _equipment_of(incident: dict, recorded: list[str]) -> list[str]:
    """Equipment ids of an incident: recorded on its events or facts, else its asset key, else ids named in its text."""
    if recorded:
        return list(recorded)
    key = incident.get("asset_key") or ""
    if key.startswith("eq:"):
        return [key[3:]]
    return list(dict.fromkeys(EQUIPMENT_ID.findall(f"{incident.get('title') or ''} {incident.get('summary') or ''}")))


def _materials_in(*texts) -> list[str]:
    found = []
    for t in texts:
        for word in MATERIALS.findall(t or ""):
            if word.lower() not in found:
                found.append(word.lower())
    return found


def _shortfall(a: dict) -> str:
    name = f"{a['code']} {a.get('name') or ''}".strip()
    if a["status"] == "late_start":
        return f"{name} not started as planned" + (f", {a['days_late']} working days late" if a.get("days_late") else "")
    return f"{name} {_qty(a['actual'])} of {_qty(a['planned'])} {a.get('unit') or ''}".rstrip() + \
        (f" ({a['variance_pct']:+g} %)" if a["variance_pct"] is not None else "")


def _idle_hours(i: dict) -> str:
    return f"idle {i['hours']:g} h" if i.get("hours") is not None else "idle, hours not recorded"


def delay_groups(todays, incidents, idle, disruptions, clock, caused: dict[str, int] | None = None,
                 details: dict | None = None, equipment_names: dict | None = None) -> list[tuple[str, list[str]]]:
    """One line per material or delivery delay, under "Materials and deliveries".

    Each delivery incident of the day (late, short or damaged material) starts an entry, and the shortfall of its
    activity is merged into it as impact, so one late delivery is one line. A supplier-caused shortfall with no
    incident is an entry of its own. Summary disruptions that repeat an entry's event are added to it as a note; the
    rest are left out, as are equipment, utility, weather and design delays and idle plant on its own.
    `caused` (activity code -> working days of project delay, from project_impact) adds how many working days the
    entry delayed project completion; other checked entries say they did not move it.
    Every line names the material, from the incident's events and facts (`details`), else from the text."""
    details, names = details or {}, dict(equipment_names or {})
    entries = []

    def entry(group, head, code=None, incident_id=None, equipment=(), materials=(), refs=()):
        e = {"group": group, "head": head, "code": code, "incident_id": incident_id, "equipment": list(equipment),
             "materials": list(materials), "idle": {}, "impacts": [], "notes": [], "refs": list(refs)}
        entries.append(e)
        return e

    for i in incidents:
        recorded = details.get(i.get("id")) or {}
        text_ = f"{i.get('title') or ''} {i.get('summary') or ''}"
        entry(DELAY_GROUPS[category_of(i)],
              f"{clock(i['occurred_at'])} {i.get('title') or i.get('summary') or ''}".rstrip(". ") +
              (f" ({i['activity_code']})" if i.get("activity_code") else ""),
              code=i.get("activity_code"), incident_id=i.get("id"),
              equipment=_equipment_of(i, recorded.get("equipment") or []),
              materials=recorded.get("materials") or _materials_in(text_))
    for i in idle:
        if i.get("hours") == 0:
            continue
        names.setdefault(i["equipment_id"], i.get("description"))
        target = next((e for e in entries if e["incident_id"] and e["incident_id"] in (i.get("incident_ids") or [])), None) \
            or next((e for e in entries if i["equipment_id"] in e["equipment"]), None)
        if target is None:
            continue  # idle plant on its own is an equipment delay, which the report does not list
        if i["equipment_id"] not in target["equipment"]:
            target["equipment"].append(i["equipment_id"])
        target["idle"][i["equipment_id"]] = _idle_hours(i)
        target["refs"] += i.get("refs") or []
        target["code"] = target["code"] or i.get("activity_code")
    for a in todays:
        if a["status"] not in ("behind", "late_start"):
            continue
        cause = (a.get("attribution") or {}).get("cause_category")
        target = next((e for e in entries if e["code"] == a["code"]), None)
        if target:
            target["impacts"].append(_shortfall(a))
        elif cause in CAUSE_GROUP:
            why = (a.get("attribution") or {}).get("explanation") or ""
            entry(CAUSE_GROUP[cause], _shortfall(a) + (f", cause: {cause.replace('_', ' ')}"
                                                                  if cause and cause != "unknown" else ""),
                  code=a["code"], equipment=[x for x in EQUIPMENT_ID.findall(why)], materials=_materials_in(why))
    for d in disruptions:
        # The same event told again in the summary joins its entry: same activity, else same machine, else material.
        kit, stuff = EQUIPMENT_ID.findall(d["text"]), _materials_in(d["text"])
        target = next((e for e in entries if d.get("activity_code") and e["code"] == d["activity_code"]), None) \
            or next((e for e in entries if e["incident_id"] and set(kit) & set(e["equipment"])), None) \
            or next((e for e in entries if e["incident_id"] and not kit and
                     set(stuff) & {w for x in e["materials"] for w in _materials_in(x)}), None)
        if target:
            target["notes"].append(d["text"].rstrip("."))
            target["refs"] += d.get("refs") or []
            target["materials"] += [x for x in _materials_in(d["text"]) if x not in target["materials"]]
    grouped = {}
    for e in entries:
        # Keep registered machines and proper plant codes; captures sometimes store bare numbers ("11") as ids.
        e["equipment"] = [x for x in dict.fromkeys(e["equipment"]) if names.get(x) or EQUIPMENT_ID.fullmatch(x)]
        # "C30 concrete" makes a separate "concrete" redundant.
        e["materials"] = [x for x in e["materials"] if not any(x.lower() != y.lower() and x.lower() in y.lower()
                                                               for y in e["materials"])]
        kit = [" ".join(filter(None, [x, names.get(x)])) + (f" ({e['idle'][x]})" if x in e["idle"] else "")
               for x in e["equipment"]]
        line = e["head"] + (f". Equipment: {', '.join(kit)}" if kit else "") + \
            (f". Material: {', '.join(e['materials'])}" if e["materials"] else "") + \
            (f". Impact: {'; '.join(e['impacts'])}" if e["impacts"] else "") + \
            "".join(f". Reported: {n}" for n in e["notes"])
        group, days = e["group"], (caused or {}).get(e["code"]) if e["code"] else None
        if days:
            line += f". Delayed project completion by {_days(days)}"
        elif caused is not None and e["code"] in caused:
            line += ". Did not move the completion date"
        grouped.setdefault(group, []).append(_cite({"text": line, "refs": list(dict.fromkeys(e["refs"]))}))
    return [(g, grouped[g]) for g in GROUP_ORDER if g in grouped]


def _content(project: dict, view: dict, records: dict, member: dict, generated_at: datetime,
             impact: dict | None = None) -> dict:
    """Everything the report prints, as plain strings, shared by the PDF and the Word layout."""
    tz = ZoneInfo(project["timezone"])
    day = date.fromisoformat(view["work_date"])
    summary, ind = view.get("summary") or {}, view.get("indicators") or {}
    stamp = lambda ts: f"{ts.astimezone(tz):%d %b %Y %H:%M}"  # noqa: E731
    clock = lambda ts: f"{ts.astimezone(tz):%H:%M}"  # noqa: E731
    header = [f"Daily site report · {project['name']}", f"{day:%A, %d %B %Y}",
              f"Generated {stamp(generated_at)} ({project['timezone']}) from records known at {stamp(view['as_of'])}, "
              f"evaluation v{view['version']}. Prepared for: {member['display_name']} ({member['role']})."]
    notes = ["Provisional: the signed quantities for this day are not all in yet."] if view.get("provisional") else []

    # The day's activities (planned for it or worked on it) are not printed; their shortfalls feed the delay lines.
    todays = [a for a in view["activities"] if (a["planned"] or 0) > 0 or (a["actual"] or 0) > 0]

    incidents = records["incidents"]
    safety = [[clock(i["occurred_at"]), i.get("title") or i.get("summary") or "", (i.get("severity") or "-").capitalize()]
              for i in incidents if category_of(i) in SAFETY]

    delays = delay_groups(todays, [i for i in incidents if category_of(i) in DELAY_GROUPS],
                          ind.get("equipment_idle") or [], summary.get("disruptions") or [], clock,
                          impact["caused"] if impact else None, records.get("details"), records.get("equipment"))

    tasks = [[t["description"], f"{t['due_at'].astimezone(tz):%d %b %H:%M}" if t.get("due_at") else "-"]
             for t in records["tasks"]]
    seen = {t[0].strip().lower() for t in tasks}
    for item in summary.get("open_items") or []:
        if item["text"].strip().lower() not in seen:
            tasks.append([item["text"], item.get("due") or "-"])

    return {"header": header, "headline": _cite(summary["headline"]) if summary.get("headline") else "", "notes": notes,
            "safety": safety, "delays": delays, "tasks": tasks}


def render(fmt: str, project: dict, view: dict, records: dict, member: dict, generated_at: datetime,
           impact: dict | None = None) -> tuple[bytes, str]:
    content = _content(project, view, records, member, generated_at, impact)
    return (_pdf(content), PDF) if fmt == "pdf" else (_docx(content), DOCX)


def _pdf(c: dict) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    pdfmetrics.registerFont(TTFont("NoticeVera", "Vera.ttf"))
    pdfmetrics.registerFont(TTFont("NoticeVeraBold", "VeraBd.ttf"))
    body = ParagraphStyle("b", fontName="NoticeVera", fontSize=9, leading=12)
    cell = ParagraphStyle("c", fontName="NoticeVera", fontSize=7.5, leading=9.5)
    title = ParagraphStyle("t", fontName="NoticeVeraBold", fontSize=14, leading=18)
    head = ParagraphStyle("h", fontName="NoticeVeraBold", fontSize=10.5, leading=14, spaceBefore=8, spaceAfter=3)
    sub = ParagraphStyle("u", fontName="NoticeVeraBold", fontSize=9, leading=12, spaceBefore=4, spaceAfter=1)
    small = ParagraphStyle("s", fontName="NoticeVera", fontSize=7.5, leading=10, textColor=colors.HexColor("#555555"))
    grid = TableStyle([("FONTNAME", (0, 0), (-1, -1), "NoticeVera"), ("FONTSIZE", (0, 0), (-1, -1), 7.5),
                       ("FONTNAME", (0, 0), (-1, 0), "NoticeVeraBold"),
                       ("GRID", (0, 0), (-1, -1), 0.3, colors.grey), ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#FFD400")),
                       ("VALIGN", (0, 0), (-1, -1), "TOP")])

    def table(head_row, rows, widths):
        wrapped = [[Paragraph(escape(str(v)), cell) for v in row] for row in rows]
        return Table([head_row] + wrapped, style=grid, repeatRows=1, colWidths=[w * mm for w in widths])

    out = BytesIO()
    doc = SimpleDocTemplate(out, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=16 * mm,
                            bottomMargin=16 * mm, title=c["header"][0])
    story = [Paragraph(escape(c["header"][0]), title), Paragraph(escape(c["header"][1]), body),
             Paragraph(escape(c["header"][2]), small), Spacer(1, 6)]
    if c["headline"]:
        story.append(Paragraph(escape(c["headline"]), body))
    story += [Paragraph(escape(n), small) for n in c["notes"]]
    if not (c["safety"] or c["delays"] or c["tasks"]):
        story += [Spacer(1, 6), Paragraph(NOTHING, body)]
    if c["safety"]:
        story += [Paragraph("Safety incidents", head), table(SAFETY_HEAD, c["safety"], [18, 128, 28])]
    if c["delays"]:
        story.append(Paragraph("Delays", head))
        for group, lines in c["delays"]:
            story.append(Paragraph(escape(group), sub))
            story += [Paragraph("• " + escape(d), body) for d in lines]
    if c["tasks"]:
        story += [Paragraph("Tasks", head), table(TASK_HEAD, c["tasks"], [146, 28])]
    story += [Spacer(1, 18), Paragraph("Checked and signed by (site manager): ______________________________"
                                       "&nbsp;&nbsp;&nbsp;&nbsp;Date: ________________", body),
              Spacer(1, 8), Paragraph("Generated from the site records. Check it before signing. "
                                      + escape(DISCLAIMER), small)]
    doc.build(story)
    return out.getvalue()


def _docx(c: dict) -> bytes:
    from docx import Document
    from docx.shared import Mm, Pt

    document = Document()
    section = document.sections[0]
    section.page_width, section.page_height = Mm(210), Mm(297)
    section.left_margin = section.right_margin = Mm(18)
    document.styles["Normal"].font.name, document.styles["Normal"].font.size = "Calibri", Pt(10)
    document.add_heading(c["header"][0], level=1)
    document.add_paragraph(c["header"][1])
    document.add_paragraph(c["header"][2]).runs[0].italic = True
    if c["headline"]:
        document.add_paragraph(c["headline"])
    for note in c["notes"]:
        document.add_paragraph(note).runs[0].italic = True

    def table(head_row, rows):
        t = document.add_table(rows=1, cols=len(head_row))
        t.style = "Table Grid"
        for i, h in enumerate(head_row):
            t.rows[0].cells[i].text = h
        for row in rows:
            cells = t.add_row().cells
            for i, v in enumerate(row):
                cells[i].text = str(v)

    if not (c["safety"] or c["delays"] or c["tasks"]):
        document.add_paragraph(NOTHING)
    if c["safety"]:
        document.add_heading("Safety incidents", level=2)
        table(SAFETY_HEAD, c["safety"])
    if c["delays"]:
        document.add_heading("Delays", level=2)
        for group, lines in c["delays"]:
            document.add_heading(group, level=3)
            for d in lines:
                document.add_paragraph(d, style="List Bullet")
    if c["tasks"]:
        document.add_heading("Tasks", level=2)
        table(TASK_HEAD, c["tasks"])
    document.add_paragraph()
    document.add_paragraph("Checked and signed by (site manager): ______________________________    Date: ________________")
    document.add_paragraph(f"Generated from the site records. Check it before signing. {DISCLAIMER}"
                           ).runs[0].italic = True
    out = BytesIO()
    document.save(out)
    return out.getvalue()
