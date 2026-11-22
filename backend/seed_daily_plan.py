"""Make Plan 5 agree with Plans 1-4 and load the plan set into the performance tables for project RIV.

1. Regenerates mock_data/Plan_5_Daily_Task_Plan_16-27_Nov.pdf as the Block B daily task plan for 16-27 Nov 2026. Every
   figure in it is read from Plan 1 (programme), Plan 2 (resources, contract) and Plan 3 (pour schedule).
2. Registers Plans 1, 2 and 5 as sources with one passage per table row, so every value in the baseline cites a row.
3. Builds one baseline from the tables in Plans 1 and 2 (21 activities, 8 milestones, thresholds, notice rules, rates,
   addressees, calendar, 08 Jul 2027 completion), validates it against those passages and activates it. Plan 1's weights
   add up to 101 %, so they are normalised on activation. Earlier baselines stay as superseded versions.
4. Replaces the old Level 2 demo reports (R16-R20) with signed daily reports that match the plan, evaluates 16-20 Nov
   and writes overall snapshots.

    .venv/bin/python seed_daily_plan.py            # do it
    .venv/bin/python seed_daily_plan.py --dry-run  # run everything, print the result, roll the database back
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
load_dotenv(HERE / ".env")
sys.path.insert(0, str(HERE))

from reportlab.lib import colors  # noqa: E402
from reportlab.lib.pagesizes import A4, landscape  # noqa: E402
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet  # noqa: E402
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle  # noqa: E402
from sqlalchemy import text  # noqa: E402

import plan_pdfs as pp  # noqa: E402
from database import writer_engine  # noqa: E402
from documents import storage  # noqa: E402
from performance import baseline as bl, daily, overall  # noqa: E402

PROJECT = "RIV"
TITLE = "Block B baseline: RR-B-PLN-001 Rev C + RR-B-PLN-002 Rev B + daily plan RR-B-PLN-003 Rev A"
FIRST, LAST = date(2026, 11, 16), date(2026, 11, 27)
ISSUED = datetime(2026, 11, 13, 7, 0, tzinfo=timezone.utc)
PLAN_ISSUED = datetime(2026, 7, 24, 7, 0, tzinfo=timezone.utc)
UNITS = {"m3": "m³", "m2": "m²", "m3 conc.": "m³"}
NAVY = colors.HexColor("#1f3a5f")

# Signed daily reports the project already has for this window are R3D-20261118 (pour A310-W1, 97.1 m3) and
# R3D-20261120 (pour A310-W2, 97.1 m3). These days had no pour, so a signed report records zero concrete placed.
ZERO_DAYS = {
    "2026-11-16": "No concrete placed. Wall formwork arrived on site today (due 12 Nov); erection started. Pour A310-W1 moved to 18 Nov.",
    "2026-11-17": "No concrete placed. Wall formwork and rebar for grid 1-4 in progress; rebar inspection (H3) booked for 18 Nov.",
    "2026-11-19": "No concrete placed. Preparing pour A310-W2 (grid 4-7); formwork and rebar inspection (H3) in progress; pour moved to 20 Nov.",
}


def fmt(d: date) -> str:
    return d.strftime("%d %b %Y")


# ------------------------------------------------------------------ Plan 5 PDF

def plan5_pdf(p1: dict, p2: dict, p3: dict) -> bytes:
    acts = {a["code"]: a for a in p1["activities"]}
    window = [a for a in p1["activities"] if a["start"] <= LAST and a["finish"] >= FIRST]
    base = getSampleStyleSheet()
    normal = ParagraphStyle("n", parent=base["Normal"], fontSize=8.5, leading=11)
    cell = ParagraphStyle("c", parent=normal, fontSize=8, leading=10)
    title = ParagraphStyle("t", parent=base["Title"], alignment=0, textColor=NAVY, fontSize=24, leading=28)
    h2 = ParagraphStyle("h", parent=base["Heading2"], textColor=NAVY, fontSize=15)
    meta = p1["meta"]

    def grid(rows, widths, header=True):
        t = Table([[Paragraph(str(c), cell) for c in r] for r in rows], colWidths=widths, repeatRows=1 if header else 0)
        style = [("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#cfd6df")), ("VALIGN", (0, 0), (-1, -1), "TOP")]
        if header:
            style += [("BACKGROUND", (0, 0), (-1, 0), NAVY), ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#e8edf4")])]
        t.setStyle(TableStyle(style))
        if header:  # header text white
            for i in range(len(rows[0])):
                t._cellvalues[0][i] = Paragraph(f'<font color="white"><b>{rows[0][i]}</b></font>', cell)
        return t

    def info(rows):
        t = Table([[Paragraph(f"<b>{a}</b>", cell), Paragraph(b, cell), Paragraph(f"<b>{c}</b>", cell), Paragraph(d, cell)]
                   for a, b, c, d in rows], colWidths=[95, 290, 95, 290])
        t.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#cfd6df")), ("VALIGN", (0, 0), (-1, -1), "TOP")]))
        return t

    story = [Paragraph("Daily Task Plan: 16-27 November 2026", title),
             Paragraph("Riverside Residences - Block B | Short-term plan for weeks 16-17, taken from Baseline Programme "
                       "RR-B-PLN-001 Rev C", normal), Spacer(1, 8),
             info([("Document no.", "RR-B-PLN-003", "Revision", "Rev A - Issued for site use"),
                   ("Client", meta["Client"], "Issue date", "13 Nov 2026"),
                   ("Main contractor", meta["Main contractor"], "Prepared by", "T. Wagner, Site Manager"),
                   ("Site address", meta["Site address"], "Plan period", "16 Nov 2026 - 27 Nov 2026 (Mon-Fri)"),
                   ("Baseline", "RR-B-PLN-001 Rev C (programme), RR-B-PLN-002 Rev B (resources, cost, contract), "
                                "RR-B-STR-S102 and S301 Rev C1 (pours)", "Contractual completion",
                    f"{fmt(pp.COMPLETION)} (unchanged; liquidated damages apply thereafter)"),
                   ("Working calendar", meta["Working calendar"], "Site start / Completion", meta["Site start / Completion"])]),
             Spacer(1, 6),
             Paragraph("1. Programme activities in this period", h2),
             Paragraph("Rows are copied from Plan 1 section 2 without change. Target/day is the daily production benchmark; "
                       "daily performance is measured against it.", normal), Spacer(1, 4)]
    head = ["ID", "Activity", "Trade", "Predecessor", "Start", "Finish", "Dur. (wd)", "Planned qty", "Unit", "Target/day", "Weight %"]
    rows = [head]
    for a in window:
        rows.append([a["code"], a["name"], a["trade"], ", ".join(a["predecessors"]) or "-", fmt(a["start"]), fmt(a["finish"]),
                     a["duration_wd"], f"{a['qty']:,.0f}", a["unit"], f"{a['target_per_day']:g}", f"{a['weight']:g}"])
    story += [grid(rows, [38, 175, 62, 62, 66, 66, 48, 62, 52, 55, 45]), Spacer(1, 4),
              Paragraph("A310 finishes on 26 Nov 2026 (milestone M4, ground slab complete). A410 starts on 27 Nov 2026; only its "
                        "first day falls in this plan.", normal),
              Paragraph("2. Tasks to complete each day", h2)]
    pours = [p for p in p3["pours"] if FIRST <= p["date"] <= LAST]
    rows = [["Date", "Programme task and daily target", "Planned pour (Plan 3, RR-B-STR-S301)", "Hold points and notes"]]
    d = FIRST
    while d <= LAST:
        if d.weekday() < 5:
            due = [f"{a['code']}: {a['target_per_day']:g} {UNITS.get(a['unit'], a['unit'])}" for a in window
                   if d in set(pp.working_days(a["start"], a["finish"]))]
            pour = [f"{p['id']}: {p['m3']:g} m³, {p['elements']}" for p in pours if p["date"] == d]
            notes = []
            nxt = [p for p in p3["pours"] if p["date"] == d + timedelta(days=1 if d.weekday() < 4 else 3)]
            if nxt:
                notes.append(f"H3 rebar and cover check by 24 h before {nxt[0]['id']}")
            if pour:
                notes.append("Book ready-mix 48 h ahead; pump and tower crane on site")
            if d == date(2026, 11, 26):
                notes.append("A310 complete; M4 due")
            if d == date(2026, 11, 27):
                notes.append("A410 starts; order windows/facade and lifts by 30 Nov 2026")
            rows.append([d.strftime("%a %d %b"), "; ".join(due) or "-", "<br/>".join(pour) or "-", "; ".join(notes) or "-"])
        d += timedelta(days=1)
    story += [grid(rows, [60, 190, 300, 230]), Spacer(1, 4),
              Paragraph("3. Planned progress for the period", h2),
              Paragraph("From the weekly S-curve in Plan 1 section 4 (cumulative weighted progress at the end of each week).", normal),
              Spacer(1, 4)]
    wk = [w for w in p1["weeks"] if date(2026, 11, 9) <= w["from"] <= date(2026, 11, 30)]
    story.append(grid([["Week", "Week commencing", "Planned % cum.", "Planned % this week", "Main activities in progress"]] +
                      [[w["week"], fmt(w["from"]), f"{w['cum_pct']:.1f}", f"{w['week_pct']:.1f}", w["activities"]] for w in wk],
                      [50, 100, 100, 110, 300]))
    crew = next(r for r in p2["crew"] if r[0] == "A310")
    equipment = {r[0].split(" (")[0]: r for r in p2["equipment"]}
    story += [Paragraph("4. Resources and procurement for A310 (from Plan 2)", h2),
              grid([["Item", "Plan 2 value"],
                    ["Crew", f"{crew[2]} ({crew[3]} people)"],
                    ["Daily target", f"{crew[4]} (Plan 1: A310 target/day 41)"],
                    ["Tower crane TC-1", equipment["Tower crane TC-1"][3]],
                    ["Concrete pump (stationary)", equipment["Concrete pump"][3] + ", pour days only"],
                    ["Ready-mix C30/37 (BetonWerk Nord GmbH)", next(r for r in p2["procurement"] if r[0].startswith("Ready-mix"))[1] +
                     "; " + next(r for r in p2["procurement"] if r[0].startswith("Ready-mix"))[2]],
                    ["Reinforcement steel", next(r for r in p2["procurement"] if r[0].startswith("Reinforcement"))[1]],
                    ["Windows & facade system, lifts", "Order by 30 Nov 2026 (12 weeks / 20 weeks)"]], [190, 530]),
              Paragraph("5. Deviation thresholds", h2),
              Paragraph("The thresholds in Plan 2 section 5 apply unchanged: " +
                        "; ".join(f"<b>{r[0]}</b> - {r[1]}" for r in p2["thresholds"][:3]) + ". Escalation: Amber - note in the "
                        "daily report and inform the Site Manager. Red - the Site Manager decides on a notice within 24 h; "
                        "the Project Manager is informed the same day.", normal)]

    def decorate(canvas, doc):
        canvas.saveState()
        w, h = landscape(A4)
        canvas.setFont("Helvetica-Bold", 8)
        canvas.setFillColor(NAVY)
        canvas.drawString(36, h - 28, "RIVERSIDE RESIDENCES - BLOCK B  |  DAILY TASK PLAN")
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(colors.grey)
        canvas.drawRightString(w - 36, h - 28, "RR-B-PLN-003 Rev A")
        canvas.drawString(36, 22, "MOCK DOCUMENT - fictional project data for prototype testing only")
        canvas.drawRightString(w - 36, 22, f"Page {doc.page}")
        canvas.restoreState()

    buf = io.BytesIO()
    SimpleDocTemplate(buf, pagesize=landscape(A4), leftMargin=36, rightMargin=36, topMargin=44, bottomMargin=36,
                      title="Daily Task Plan 16-27 Nov 2026", author="Nordbau Construction AG").build(
        story, onFirstPage=decorate, onLaterPages=decorate)
    return buf.getvalue()


def report_pdf(day_: str, note: str) -> bytes:
    s = getSampleStyleSheet()
    a = {x["code"]: x for x in pp.plan1()["activities"]}["A310"]
    rows = [["ID", "Activity", "Unit", "Done today"], ["A310", a["name"], "m³", 0]]
    buf = io.BytesIO()
    SimpleDocTemplate(buf, pagesize=A4, leftMargin=36, rightMargin=36, topMargin=36, bottomMargin=36).build([
        Paragraph(f"Daily site report, {day_}", s["Title"]),
        Paragraph("Riverside Residences - Block B. Signed by the site supervisor. Fictional demo data.", s["Normal"]),
        Spacer(1, 8), Table(rows, style=TableStyle([("GRID", (0, 0), (-1, -1), 0.4, colors.grey)])), Spacer(1, 8),
        Paragraph("Remarks: " + note, s["Normal"])])
    return buf.getvalue()


# ------------------------------------------------------------------ extraction from the PDFs

def build_extraction(p1: dict, p2: dict):
    """The baseline `extracted` dict, plus the passages it cites ({locator: (source, section, excerpt)})."""
    passages: dict[str, tuple[str, str, str, int]] = {}  # "SRC:locator" -> (section, excerpt, page, ...)

    def cite(source, locator, section, excerpt, page=1):
        passages[f"{source}:{locator}"] = (section, re.sub(r"\s+", " ", excerpt).strip(), page)
        return f"{source}:{locator}"

    activities = []
    for a in p1["activities"]:
        ref = cite("PLN1", a["code"], "Activity schedule", a["row"], 2)
        activities.append({
            "code": a["code"], "name": a["name"], "trade": a["trade"], "zone": None, "contractor": None,
            "unit": UNITS.get(a["unit"], a["unit"]), "planned_start": a["start"].isoformat(),
            "planned_finish": a["finish"].isoformat(), "duration_wd": a["duration_wd"], "planned_total": a["qty"],
            "target_per_day": a["target_per_day"], "weight_pct": a["weight"], "predecessors": a["predecessors"],
            "is_critical": None, "refs": [ref], "missing": [], "derived": []})
    milestones = []
    links = {"M1": ["A100"], "M2": ["A200"], "M3": ["A300"], "M4": ["A310"], "M5": ["A450"], "M6": ["A510", "A520"],
             "M7": ["A600"], "M8": ["A900"]}
    for m in p1["milestones"]:
        extra = (" Contractual completion date: 08 Jul 2027. Liquidated damages apply thereafter."
                 if m["code"] == "M8" else "")
        ref = cite("PLN1", m["code"], "Key milestones", m["row"] + extra, 1)
        milestones.append({"code": m["code"], "name": m["name"], "planned_date": m["date"].isoformat(),
                           "contractual": m["code"] == "M8", "activity_codes": links[m["code"]], "refs": [ref]})
    cal_ref = cite("PLN1", "calendar", "Header", "Working calendar " + p1["meta"]["Working calendar"], 1)
    weather = re.search(r"Weather: allowance of (\d+) lost days[^\n]*", p1["text"])
    weather_ref = cite("PLN1", "weather", "Assumptions & constraints", weather.group(0), 5)
    cite("PLN1", "holidays", "Assumptions & constraints",
         re.search(r"Public holidays:[^\n]*(\n[^\n•]*)?", p1["text"]).group(0), 5)

    thr_rows = {r[0]: r for r in p2["thresholds"]}
    thr_ref = {k: cite("PLN2", "threshold-" + re.sub(r"\W+", "-", k.lower()).strip("-"), "Deviation thresholds", " ".join(r), 3)
               for k, r in thr_rows.items()}
    spec = [("Daily output vs target", dict(indicator="daily_output", unit="percent", amber_from=10, amber_to=20, red_above=20,
                                           consecutive_amber_days_to_red=2)),
            ("Activity start/finish", dict(indicator="start_finish", unit="working_days", amber_from=1, amber_to=2, red_above=2,
                                           critical_path_late_is_red=True)),
            ("Planned vs actual cumulative progress", dict(indicator="cumulative_progress", unit="points", amber_from=2,
                                                           amber_to=4, red_above=4)),
            ("Equipment idle", dict(indicator="equipment_idle", unit="hours", amber_from=2, red_full_shift=True)),
            ("Labour", dict(indicator="labour", unit="percent", amber_from=10, red_above=20)),
            ("Cost vs budget", dict(indicator="cost", unit="percent", amber_from=3, red_above=5)),
            ("Quality", dict(indicator="quality", unit="other"))]
    thresholds = [{**s, "text": " ".join(thr_rows[k]), "refs": [thr_ref[k]]} for k, s in spec]

    terms = {r[0]: r for r in p2["terms"]}
    client_pm = next(r for r in p2["people"] if r[0] == "Client's Project Manager")
    notice_spec = [("Delay notice (Behinderungsanzeige)", "delay_notice", 5, True),
                   ("Additional cost notice", "additional_cost_notice", 10, False),
                   ("Notice of concern (Bedenkenanzeige)", "notice_of_concern", None, True),
                   ("Defect notice", "defect_notice", 3, False),
                   ("Change instructions", "change_confirmation", 2, False)]
    notice_rules = []
    for key, kind, days, immediate in notice_spec:
        row = terms[key]
        ref = cite("PLN2", "term-" + kind, "Contract terms", " ".join(row), 2)
        notice_rules.append({"type": kind, "deadline_working_days": days, "deadline_calendar_days": None,
                             "immediate": immediate, "addressee_role": client_pm[0] if kind != "defect_notice" else None,
                             "addressee_name": client_pm[1] if kind != "defect_notice" else None,
                             "requirements": row[1], "refs": [ref]})

    ld = terms["Liquidated damages"]
    rates = [{"kind": "liquidated_damages", "item": "Liquidated damages", "equipment_ids": [], "amount": 4500, "currency": "EUR",
              "per": "calendar_day", "cap_pct": 5, "cap_text": "5% of contract sum",
              "refs": [cite("PLN2", "term-liquidated-damages", "Contract terms", " ".join(ld), 2)]}]
    eq_spec = {"Tower crane TC-1 (60 m jib)": ("equipment_standby", 780, "day", ["TC-1"]),
               "Excavator 30 t (x2)": ("equipment_idle", 520, "day", []),
               "Dump trucks (x8)": ("equipment_idle", 240, "day", []),
               "Concrete pump (stationary)": ("equipment_hire", 650, "call_out", []),
               "Well-point dewatering set": ("equipment_standby", 310, "day", []),
               "Material hoist": ("equipment_standby", 190, "day", []),
               "Mobile crane 50 t": ("equipment_hire", 1150, "day", [])}
    for r in p2["equipment"]:
        kind, amount, per, ids = eq_spec[r[0]]
        rates.append({"kind": kind, "item": r[0], "equipment_ids": ids, "amount": amount, "currency": "EUR", "per": per,
                      "cap_pct": None, "cap_text": None,
                      "refs": [cite("PLN2", "equipment-" + re.sub(r"\W+", "-", r[0].lower()).strip("-"), "Equipment plan",
                                    " ".join(r), 1)]})
    addressees = [{"role": r[0], "name": r[1], "organisation": r[2], "purpose": r[3],
                   "refs": [cite("PLN2", "person-" + re.sub(r"\W+", "-", r[0].lower()).strip("-"), "Key personnel", " ".join(r), 3)]}
                  for r in p2["people"]]
    completion_ref = cite("PLN2", "term-completion", "Contract terms", " ".join(terms["Contractual completion date"]), 2)
    extracted = {
        "title": TITLE, "method": "pdf-tables", "activities": activities, "milestones": milestones,
        "thresholds": thresholds, "notice_rules": notice_rules, "rates": rates, "addressees": addressees,
        "calendar": {"working_weekdays": [0, 1, 2, 3, 4], "holidays": [], "shift_start": "07:00", "shift_end": "16:00",
                     "shift_hours": 8, "refs": [cal_ref]},
        "contract_completion": {"date": pp.COMPLETION.isoformat(), "refs": [completion_ref]},
        "weather_allowance_days": {"value": 6, "refs": [weather_ref]}, "missing": [], "dropped": 0}
    return extracted, passages


def plan5_passages(p1, p3):
    """One passage per planned day in Plan 5, so a daily task can be cited."""
    out = {}
    acts = [a for a in p1["activities"] if a["start"] <= LAST and a["finish"] >= FIRST]
    d = FIRST
    while d <= LAST:
        if d.weekday() < 5:
            due = [f"{a['code']}: {a['target_per_day']:g} {UNITS.get(a['unit'], a['unit'])}" for a in acts
                   if d in set(pp.working_days(a["start"], a["finish"]))]
            pour = [f"{p['id']} {p['m3']:g} m³" for p in p3["pours"] if p["date"] == d]
            out[f"day-{d.isoformat()}"] = ("Tasks to complete each day", f"{d:%a %d %b %Y}: " + "; ".join(due + pour))
        d += timedelta(days=1)
    return out


# ------------------------------------------------------------------ database

def insert_source(conn, sid, kind, path, digest, at, title, meta, author):
    conn.execute(text("""INSERT INTO sitemate.sources (project_id, id, kind, path, available_at, sha256, title, meta, author, author_role)
        VALUES (:p, :id, :k, :path, :at, :sha, :title, CAST(:meta AS jsonb), :a, 'site_supervisor')
        ON CONFLICT (project_id, id) DO UPDATE SET path = EXCLUDED.path, sha256 = EXCLUDED.sha256, title = EXCLUDED.title,
            meta = EXCLUDED.meta, available_at = EXCLUDED.available_at, author = EXCLUDED.author"""),
                 {"p": PROJECT, "id": sid, "k": kind, "path": path, "at": at, "sha": digest, "title": title,
                  "meta": json.dumps(meta), "a": author})


def insert_passage(conn, source, locator, page, excerpt, ordinal, section, kind="table_row"):
    conn.execute(text("""INSERT INTO sitemate.source_passages (project_id, source_id, locator, page, excerpt, ordinal, kind, section)
        VALUES (:p, :s, :l, :pg, :e, :o, :k, :sec)
        ON CONFLICT (project_id, source_id, locator) DO UPDATE SET excerpt = EXCLUDED.excerpt, page = EXCLUDED.page,
            section = EXCLUDED.section"""),
                 {"p": PROJECT, "s": source, "l": locator, "pg": page, "e": excerpt, "o": ordinal, "k": kind, "sec": section})


def remove_old_reports(conn):
    """The Level 2 demo reports R16-R20 (L2-* quantities from the old Plan 5) are replaced, not kept as unplanned work."""
    ids = ["R16", "R17", "R18", "R19", "R20"]
    gone = {}
    gone["observations"] = conn.execute(text("DELETE FROM sitemate.observations WHERE project_id=:p AND source_id = ANY(:i)"),
                                        {"p": PROJECT, "i": ids}).rowcount
    gone["passages"] = conn.execute(text("DELETE FROM sitemate.source_passages WHERE project_id=:p AND source_id = ANY(:i)"),
                                    {"p": PROJECT, "i": ids}).rowcount
    gone["sources"] = conn.execute(text("DELETE FROM sitemate.sources WHERE project_id=:p AND id = ANY(:i)"),
                                   {"p": PROJECT, "i": ids}).rowcount
    return gone


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="run everything, then roll the database back")
    args = ap.parse_args()

    p1, p2, p3 = pp.plan1(), pp.plan2(), pp.plan3()
    pp.PLAN5.write_bytes(plan5_pdf(p1, p2, p3))
    results = pp.checks()
    failed = [label for status, label in results if status == "FAIL"]
    for status, label in results:
        print(f"{status:<5}{label}")
    if failed:
        sys.exit("Plans still disagree; not touching the database.")

    extracted, passages = build_extraction(p1, p2)
    plan5_text = plan5_passages(p1, p3)
    engine = writer_engine()
    conn = engine.connect()
    trans = conn.begin()
    try:
        if conn.scalar(text("SELECT 1 FROM sitemate.plan_baselines WHERE project_id=:p AND title=:t"), {"p": PROJECT, "t": TITLE}):
            print("Already seeded.")
            trans.rollback()
            return
        gone = remove_old_reports(conn)
        print("Removed old R16-R20 demo reports:", gone)
        for sid, path, at, title, author in (
                ("PLN1", pp.PLAN1, PLAN_ISSUED, "Plan 1 Baseline Construction Programme RR-B-PLN-001 Rev C", "M. Keller, Planning Engineer"),
                ("PLN2", pp.PLAN2, PLAN_ISSUED, "Plan 2 Resource, Cost and Contract Plan RR-B-PLN-002 Rev B", "S. Brandt, Commercial Manager"),
                ("PLN5", pp.PLAN5, ISSUED, "Plan 5 Daily Task Plan 16-27 Nov 2026 RR-B-PLN-003 Rev A", "T. Wagner, Site Manager")):
            stored, digest = storage.save_upload(PROJECT, path.read_bytes(), ".pdf")
            insert_source(conn, sid, "plan", stored, digest, at, title, {"filename": path.name}, author)
        ordinals: dict[str, int] = {}
        for key, (section, excerpt, page) in passages.items():
            src, loc = key.split(":", 1)
            ordinals[src] = ordinals.get(src, 0) + 1
            insert_passage(conn, src, loc, page, excerpt, ordinals[src], section)
        for i, (loc, (section, excerpt)) in enumerate(plan5_text.items()):
            insert_passage(conn, "PLN5", loc, 1, excerpt, i, section)

        # The same extraction and checks the upload flow uses; every value must appear in the row that cites it.
        texts = {k: v[1] for k, v in passages.items()}
        cleaned, reasons = bl.validate(extracted, texts, grounded=True)
        for r in reasons:
            print(f"  review [{r['severity']}] {r['subject']}: {r['message']}")
        if bl.blocking(reasons):
            raise SystemExit("Blocking review reasons; not activating.")
        created = bl.create_baseline(conn, PROJECT, cleaned, reasons, ["PLN1", "PLN2", "PLN5"], as_of=ISSUED, title=TITLE)
        activated_at = datetime.now(timezone.utc).replace(microsecond=0)  # after the previous baseline's activation
        result = bl.activate(conn, PROJECT, created["id"], member_id=None, as_of=activated_at, normalize_weights=True)
        print("Activated baseline revision", result["revision"], {k: v for k, v in result.items() if k != "baseline_id"})

        row = conn.execute(text("""SELECT kind, section FROM sitemate.source_passages WHERE project_id=:p
                                   AND source_id='R3D-20261118' AND locator='remarks'"""), {"p": PROJECT}).one_or_none()
        a310 = next(a for a in p1["activities"] if a["code"] == "A310")
        for dd, note in ZERO_DAYS.items():
            sid = f"R{dd[8:]}"
            stored, digest = storage.save_upload(PROJECT, report_pdf(dd, note), ".pdf")
            conn.execute(text("""INSERT INTO sitemate.sources (project_id, id, kind, path, available_at, sha256, title, meta, author, author_role)
                VALUES (:p, :s, 'daily_report', :path, :at, :sha, :title, CAST(:meta AS jsonb), 'Signed daily report', 'signed_report')"""),
                         {"p": PROJECT, "s": sid, "path": stored, "sha": digest,
                          "at": datetime.fromisoformat(dd + "T17:00:00+00:00"), "title": f"Daily site report {sid}, {dd}",
                          "meta": json.dumps({"pages": 1, "work_date": dd, "review_reasons": []})})
            insert_passage(conn, sid, "zero-A310", 1, "A310: no work recorded", 0, "Measured shift quantities")
            if row:
                insert_passage(conn, sid, "remarks", 1, "Remarks: " + note, 1, row.section, row.kind)
            conn.execute(text("""INSERT INTO sitemate.observations (project_id, activity_code, work_date, source_id, locator, quantity, basis)
                VALUES (:p, 'A310', :d, :s, 'zero-A310', 0, 'signed')"""), {"p": PROJECT, "d": dd, "s": sid})

        when = datetime.now(timezone.utc)
        for i in range((date(2026, 11, 20) - FIRST).days + 1):
            d = FIRST + timedelta(days=i)
            r = daily.evaluate_day(conn, PROJECT, d, when, use_llm=False, trigger="seed", force=True)
            view = conn.execute(text("""SELECT day_status, day_severity, day_score FROM sitemate.daily_evaluations
                WHERE project_id=:p AND work_date=:d AND version=:v"""), {"p": PROJECT, "d": d, "v": r["version"]}).one()
            res = conn.execute(text("""SELECT activity_code, planned, actual, status, severity FROM sitemate.daily_activity_results
                WHERE project_id=:p AND work_date=:d AND version=:v AND (planned > 0 OR actual > 0) ORDER BY 1"""),
                               {"p": PROJECT, "d": d, "v": r["version"]}).all()
            print(f"  {d} v{r['version']} {tuple(view)} {[tuple(map(str, x)) for x in res]}")
        for to in (date(2026, 11, 20), date(2026, 11, 22)):
            s = overall.snapshot(conn, PROJECT, to, when, use_llm=False, force=True)
            m = conn.execute(text("""SELECT metrics, score FROM sitemate.performance_snapshots WHERE project_id=:p AND as_of_date=:d
                AND version=:v"""), {"p": PROJECT, "d": to, "v": s["version"]}).one()
            met = m.metrics
            print(f"  snapshot {to} v{s['version']}: planned {met.get('weighted_planned_pct')} % actual {met.get('weighted_actual_pct')} % "
                  f"spi {met.get('spi')} planned completion {met.get('planned_completion')} forecast {met.get('forecast_completion')} "
                  f"status {met.get('overall_status')} score {m.score}")
        if args.dry_run:
            trans.rollback()
            print("Dry run: database rolled back.")
        else:
            trans.commit()
            print("Done. Plans 1, 2 and 5 are loaded; set the app clock to 20 Nov 2026 evening or later.")
    except BaseException:
        trans.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
