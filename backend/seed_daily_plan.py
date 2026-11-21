"""Seed the "Level 2 daily task plan" (fictional) for project RIV: a PDF in mock_data, an activated baseline with a
task list for every working day 16-27 Nov 2026, and signed daily reports with fake actuals for 16-20 Nov, then
evaluate each day and the overall snapshot. Safe to re-run (skips when the baseline already exists).

    .venv/bin/python seed_daily_plan.py
"""

from __future__ import annotations

import io
import os
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
load_dotenv(HERE / ".env")
sys.path.insert(0, str(HERE))

from reportlab.lib import colors  # noqa: E402
from reportlab.lib.pagesizes import A4  # noqa: E402
from reportlab.lib.styles import getSampleStyleSheet  # noqa: E402
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle  # noqa: E402
from sqlalchemy import text  # noqa: E402

from database import writer_engine  # noqa: E402
from documents import storage  # noqa: E402
from performance import baseline as bl, daily, overall  # noqa: E402

PROJECT = "RIV"
TITLE = "Level 2 Daily Task Plan (16-27 Nov)"
PLAN_PDF = HERE.parent / "mock_data" / "Plan_5_Level2_Daily_Task_Plan.pdf"
PLAN_AT = datetime(2026, 11, 13, 7, 0, tzinfo=timezone.utc)
FIRST, LAST = date(2026, 11, 16), date(2026, 11, 27)

# code, name, unit, start, finish, total, per day, predecessors
TASKS = [
    ("L2-COL", "Columns Level 2", "pcs", "2026-11-16", "2026-11-20", 20, 4, []),
    ("L2-FORM", "Formwork slab Level 2", "m²", "2026-11-16", "2026-11-20", 600, 120, []),
    ("L2-REBAR", "Rebar slab Level 2", "t", "2026-11-17", "2026-11-23", 30, 6, ["L2-FORM"]),
    ("L2-BLOCK", "Masonry core walls Level 2", "m²", "2026-11-18", "2026-11-24", 400, 80, []),
    ("L2-MEP", "Services sleeves Level 2", "pcs", "2026-11-20", "2026-11-26", 50, 10, ["L2-FORM"]),
    ("L2-POUR", "Concrete pour slab Level 2", "m³", "2026-11-24", "2026-11-26", 180, 60, ["L2-REBAR", "L2-COL"]),
]
# Fake signed actuals per day (only activities that produced something; the rest are signed as zero).
ACTUALS = {
    "2026-11-16": {"L2-FORM": 125, "L2-COL": 4},
    "2026-11-17": {"L2-FORM": 110, "L2-COL": 4, "L2-REBAR": 6},
    "2026-11-18": {"L2-FORM": 120, "L2-COL": 3, "L2-REBAR": 4, "L2-BLOCK": 80},
    "2026-11-19": {"L2-FORM": 90, "L2-COL": 4, "L2-REBAR": 6, "L2-BLOCK": 70},
    "2026-11-20": {"L2-FORM": 120, "L2-COL": 4, "L2-REBAR": 5, "L2-BLOCK": 80, "L2-MEP": 6},
}


def workdays(start: str, finish: str):
    d, end = date.fromisoformat(start), date.fromisoformat(finish)
    while d <= end:
        if d.weekday() < 5:
            yield d
        d += timedelta(days=1)


def pdf(story) -> bytes:
    buf = io.BytesIO()
    SimpleDocTemplate(buf, pagesize=A4, leftMargin=36, rightMargin=36, topMargin=36, bottomMargin=36).build(story)
    return buf.getvalue()


def table(rows, widths=None):
    t = Table(rows, colWidths=widths, repeatRows=1)
    t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e8590c")), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                           ("GRID", (0, 0), (-1, -1), 0.4, colors.grey), ("FONTSIZE", (0, 0), (-1, -1), 8.5),
                           ("VALIGN", (0, 0), (-1, -1), "TOP")]))
    return t


def plan_pdf() -> bytes:
    s = getSampleStyleSheet()
    story = [Paragraph("Riverside Office Block: Level 2 Daily Task Plan", s["Title"]),
             Paragraph("Fictional demo data. Programme 16-27 November 2026, Monday to Friday working week. "
                       "Each task lists its target quantity per working day; daily performance is measured against these targets.", s["Normal"]),
             Spacer(1, 10), Paragraph("1. Activities", s["Heading2"]),
             table([["Code", "Activity", "Unit", "Start", "Finish", "Total", "Per day", "After"]] +
                   [[c, n, u, st, f, tot, tpd, ", ".join(p) or "-"] for c, n, u, st, f, tot, tpd, p in TASKS]),
             Spacer(1, 12), Paragraph("2. Tasks to complete each day", s["Heading2"])]
    days = [FIRST + timedelta(days=i) for i in range((LAST - FIRST).days + 1) if (FIRST + timedelta(days=i)).weekday() < 5]
    rows = [["Date", "Tasks and daily target"]]
    for d in days:
        due = [f"{c}: {tpd} {u}" for c, _, u, st, f, _, tpd, _ in TASKS if d in set(workdays(st, f))]
        rows.append([d.strftime("%a %d %b"), "; ".join(due) or "-"])
    story.append(table(rows, [80, 440]))
    return pdf(story)


def report_pdf(day: str, got: dict) -> bytes:
    s = getSampleStyleSheet()
    rows = [["Code", "Activity", "Unit", "Done today"]] + [[c, n, u, got.get(c, 0)] for c, n, u, *_ in TASKS]
    return pdf([Paragraph(f"Daily site report, {day}", s["Title"]), Paragraph("Riverside Office Block. Signed by the site supervisor. Fictional demo data.", s["Normal"]),
                Spacer(1, 8), table(rows)])


def passage(conn, source_id, locator, page, excerpt, ordinal, section, kind):
    conn.execute(text("""INSERT INTO sitemate.source_passages (project_id, source_id, locator, page, excerpt, ordinal, kind, section)
        VALUES (:p, :s, :l, :pg, :e, :o, :k, :sec) ON CONFLICT DO NOTHING"""),
                 {"p": PROJECT, "s": source_id, "l": locator, "pg": page, "e": excerpt, "o": ordinal, "k": kind, "sec": section})


def main():
    PLAN_PDF.write_bytes(plan_pdf())
    engine = writer_engine()
    with engine.begin() as conn:
        if conn.scalar(text("SELECT 1 FROM sitemate.plan_baselines WHERE project_id=:p AND title=:t"), {"p": PROJECT, "t": TITLE}):
            print("Already seeded.")
            return
        path, digest = storage.save_upload(PROJECT, PLAN_PDF.read_bytes(), ".pdf")
        conn.execute(text("""INSERT INTO sitemate.sources (project_id, id, kind, path, available_at, sha256, title, meta, author, author_role)
            VALUES (:p, 'PLN5', 'plan', :path, :at, :sha, :title, CAST(:meta AS jsonb), 'Site manager', 'site_supervisor')
            ON CONFLICT DO NOTHING"""), {"p": PROJECT, "path": path, "at": PLAN_AT, "sha": digest, "title": PLAN_PDF.stem.replace("_", " "),
                                         "meta": '{"filename": "%s"}' % PLAN_PDF.name})
        acts = [{"code": c, "name": n, "unit": u, "zone": "Level 2", "planned_start": st, "planned_finish": f,
                 "duration_wd": len(list(workdays(st, f))), "planned_total": tot, "target_per_day": tpd, "weight_pct": None,
                 "predecessors": p, "refs": [f"PLN5:{c}"], "missing": [], "derived": ["duration_wd"], "is_critical": None,
                 "trade": None, "contractor": "GW"} for c, n, u, st, f, tot, tpd, p in TASKS]
        for i, (c, n, u, st, f, tot, tpd, p) in enumerate(TASKS):
            passage(conn, "PLN5", c, 1, f"{c} {n}: {st} to {f}, {tot} {u} in total, {tpd} {u} per working day", i, "Activities", "table_row")
        extracted = {"title": TITLE, "method": "seed", "activities": acts, "milestones": [], "thresholds": [], "notice_rules": [],
                     "rates": [], "addressees": [], "missing": [], "dropped": 0,
                     "calendar": {"working_weekdays": [0, 1, 2, 3, 4], "holidays": [], "refs": []},
                     "contract_completion": {"date": None, "refs": []}, "weather_allowance_days": {"value": None, "refs": []}}
        created = bl.create_baseline(conn, PROJECT, extracted, [], ["PLN5"], as_of=PLAN_AT, title=TITLE)
        bl.activate(conn, PROJECT, created["id"], member_id=None, as_of=PLAN_AT)
        for day, got in ACTUALS.items():
            sid = f"R{day[8:]}"
            data = report_pdf(day, got)
            path, digest = storage.save_upload(PROJECT, data, ".pdf")
            conn.execute(text("""INSERT INTO sitemate.sources (project_id, id, kind, path, available_at, sha256, title, meta, author, author_role)
                VALUES (:p, :s, 'daily_report', :path, :at, :sha, :title, CAST(:meta AS jsonb), 'Signed daily report', 'signed_report')
                ON CONFLICT DO NOTHING"""), {"p": PROJECT, "s": sid, "path": path, "sha": digest,
                                            "at": datetime.fromisoformat(day + "T17:00:00+00:00"),
                                            "title": f"Daily site report {sid}, {day}",
                                            "meta": '{"pages": 1, "work_date": "%s", "review_reasons": []}' % day})
            for i, (c, n, u, *_rest) in enumerate(TASKS):
                qty = got.get(c, 0)
                passage(conn, sid, c if qty else f"zero-{c}", 1, f"{c}: actual {qty} {u}" if qty else f"{c}: no work recorded",
                        i, "Measured shift quantities", "table_row")
                conn.execute(text("""INSERT INTO sitemate.observations (project_id, activity_code, work_date, source_id, locator, quantity, basis)
                    VALUES (:p, :c, :d, :s, :l, :q, 'signed')"""),
                             {"p": PROJECT, "c": c, "d": day, "s": sid, "l": c if qty else f"zero-{c}", "q": qty})
    as_of = datetime(2026, 11, 21, 9, 0, tzinfo=timezone.utc)
    with engine.begin() as conn:
        for i in range((date(2026, 11, 21) - FIRST).days + 1):
            daily.evaluate_day(conn, PROJECT, FIRST + timedelta(days=i), as_of, use_llm=False, trigger="seed", force=True)
        overall.snapshot(conn, PROJECT, date(2026, 11, 20), as_of, use_llm=False, force=True)
    print("Seeded:", TITLE, "- set the app clock to 20 Nov 2026 evening or later to see it.")


if __name__ == "__main__":
    main()
