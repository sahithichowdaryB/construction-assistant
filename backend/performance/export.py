"""Render a performance snapshot as PDF (ReportLab, with the S-curve chart) or Word (python-docx).

Same libraries and A4 layout as documents/notice_export.py. The report prints who requested it, the ledger review
state (who accepted or disputed what) and the disclaimer. It is drafting support, not a formal record.
"""

from __future__ import annotations

from io import BytesIO
from xml.sax.saxutils import escape

from .metrics import DISCLAIMER

PDF = "application/pdf"
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def _lines(view: dict, entries: list[dict]) -> dict:
    m, n = view["metrics"], view["narrative"] or {}
    kpis = [("Weighted progress (planned / actual)", f"{m.get('weighted_planned_pct')} % / {m.get('weighted_actual_pct')} %"),
            ("SPI", f"{m.get('spi')} ({m.get('spi_band')})"),
            ("Planned / forecast completion", f"{m.get('planned_completion')} / {m.get('forecast_completion')} "
                                              f"({m.get('completion_variance_days')} working days)"),
            ("Overall status", m.get("overall_status")), ("Score to date", f"{m.get('score')}"),
            ("Excusable / non-excusable days (for review)",
             f"{m['attribution']['excusable_days']} / {m['attribution']['non_excusable_days']}")]
    if m.get("ld_exposure"):
        ld = m["ld_exposure"]
        kpis.append(("Indicative LD exposure", f"{ld['amount']} {ld.get('currency') or ''} ({ld['days_late']} days)"))
    acts = [[a["code"], a.get("name") or "", f"{a['planned_cum']}", f"{a['actual_cum']}", f"{a['backlog']}",
             f"{a['days_behind'] if a['days_behind'] is not None else '-'}", a.get("forecast_finish") or "-",
             f"{a['finish_variance_days'] if a['finish_variance_days'] is not None else '-'}"] for a in m["activities"]]
    ledger = [[e["work_date"], e["subject"], e["rule_key"], f"{e['points']:+g}", e.get("cause_category") or "",
               ("excusable" if e["excusable"] else ""), e["status"] + (f" by {e['reviewer_name']}" if e.get("reviewer_id") else ""),
               e.get("note") or ""] for e in entries]
    narrative = []
    for key, label in (("status_explanation", "Status"), ("trend", "Trend")):
        item = n.get(key)
        if item:
            narrative.append((label, [item]))
    for key, label in (("merits", "Merits"), ("demerits", "Demerits"), ("risks", "Risks"),
                       ("recommended_actions", "Recommended actions"),
                       ("correspondence_to_consider", "Correspondence to consider")):
        if n.get(key):
            narrative.append((label, n[key]))
    return {"kpis": kpis, "activities": acts, "ledger": ledger, "narrative": narrative}


def _cite(item):
    refs = item.get("refs") or []
    return f"{item['text']}" + (f" [{'; '.join(refs)}]" if refs else "")


def render(fmt: str, project: dict, view: dict, entries: list[dict], member: dict) -> tuple[bytes, str]:
    data = _lines(view, entries)
    reviewed = sorted({e["reviewer_name"] for e in entries if e.get("reviewer_id")})
    from zoneinfo import ZoneInfo
    local = view["as_of"].astimezone(ZoneInfo(project["timezone"]))
    header = [f"Performance report · {project['name']}", f"As of {view['as_of_date']} (snapshot v{view['version']}, "
              f"records known at {local:%d %b %Y %H:%M} {project['timezone']})",
              f"Prepared for: {member['display_name']} ({member['role']}). Ledger reviewed by: "
              f"{', '.join(reviewed) or 'not yet reviewed'}. "
              f"Entries: {sum(1 for e in entries if e['status'] == 'accepted')} accepted, "
              f"{sum(1 for e in entries if e['status'] == 'disputed')} disputed, "
              f"{sum(1 for e in entries if e['status'] == 'proposed')} proposed."]
    return (_pdf(header, data, view), PDF) if fmt == "pdf" else (_docx(header, data, view), DOCX)


def _pdf(header, data, view) -> bytes:
    from reportlab.graphics.charts.lineplots import LinePlot
    from reportlab.graphics.shapes import Drawing, String
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    pdfmetrics.registerFont(TTFont("NoticeVera", "Vera.ttf"))
    body = ParagraphStyle("b", fontName="NoticeVera", fontSize=8.5, leading=11)
    head = ParagraphStyle("h", fontName="NoticeVera", fontSize=12, leading=15, spaceAfter=4)
    small = ParagraphStyle("s", fontName="NoticeVera", fontSize=7, leading=9)
    out = BytesIO()
    doc = SimpleDocTemplate(out, pagesize=landscape(A4), leftMargin=15 * mm, rightMargin=15 * mm, topMargin=14 * mm,
                            bottomMargin=14 * mm, title="SiteMate performance report")
    grid = TableStyle([("FONTNAME", (0, 0), (-1, -1), "NoticeVera"), ("FONTSIZE", (0, 0), (-1, -1), 7.5),
                       ("GRID", (0, 0), (-1, -1), 0.3, colors.grey), ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#FFD400")),
                       ("VALIGN", (0, 0), (-1, -1), "TOP")])
    story = [Paragraph(escape(header[0]), head), Paragraph(escape(header[1]), body), Paragraph(escape(header[2]), body),
             Paragraph(escape(DISCLAIMER), small), Spacer(1, 6)]
    story.append(Table([["Indicator", "Value"]] + [[k, str(v)] for k, v in data["kpis"]], style=grid,
                       colWidths=[90 * mm, 120 * mm]))
    points = [p for p in view.get("s_curve") or []]
    if len(points) > 1:
        drawing = Drawing(250 * mm, 70 * mm)
        plot = LinePlot()
        plot.x, plot.y, plot.width, plot.height = 15 * mm, 10 * mm, 225 * mm, 52 * mm
        planned = [(i, p["planned_pct"]) for i, p in enumerate(points)]
        actual = [(i, p["actual_pct"]) for i, p in enumerate(points) if p["actual_pct"] is not None]
        plot.data = [planned, actual or [(0, 0)]]
        plot.lines[0].strokeColor, plot.lines[1].strokeColor = colors.HexColor("#555555"), colors.HexColor("#E8590C")
        plot.lines[1].strokeWidth = 2
        plot.yValueAxis.valueMin, plot.yValueAxis.valueMax = 0, 100
        plot.xValueAxis.valueMin, plot.xValueAxis.valueMax = 0, len(points) - 1
        step = max(1, len(points) // 8)
        plot.xValueAxis.valueSteps = list(range(0, len(points), step))
        plot.xValueAxis.labelTextFormat = lambda i: points[int(i)]["date"][5:] if 0 <= int(i) < len(points) else ""
        drawing.add(plot)
        drawing.add(String(15 * mm, 65 * mm, "S-curve: weighted progress % (grey planned, orange actual)",
                           fontName="NoticeVera", fontSize=8))
        story += [Spacer(1, 6), drawing]
    story += [Spacer(1, 6), Paragraph("Activities", head),
              Table([["Code", "Activity", "Planned cum.", "Actual cum.", "Backlog", "Days behind", "Forecast finish",
                      "Var. (wd)"]] + data["activities"], style=grid, repeatRows=1)]
    if data["narrative"]:
        story += [Spacer(1, 6), Paragraph("Narrative (cited)", head)]
        for label, items in data["narrative"]:
            story.append(Paragraph(f"<b>{escape(label)}</b>", body))
            story += [Paragraph("• " + escape(_cite(i)), body) for i in items]
    story += [Spacer(1, 6), Paragraph("Merit and demerit ledger", head),
              Table([["Date", "Subject", "Rule", "Points", "Cause", "", "Review", "Note"]] +
                    [[Paragraph(escape(c), small) for c in row] for row in data["ledger"]] if data["ledger"] else [["-"] * 8],
                    style=grid, repeatRows=1, colWidths=[20 * mm, 40 * mm, 40 * mm, 15 * mm, 30 * mm, 18 * mm, 40 * mm, 60 * mm]),
              Spacer(1, 6), Paragraph(escape(DISCLAIMER), body)]
    doc.build(story)
    return out.getvalue()


def _docx(header, data, view) -> bytes:
    from docx import Document
    from docx.shared import Pt

    document = Document()
    document.styles["Normal"].font.name, document.styles["Normal"].font.size = "Calibri", Pt(10)
    document.add_heading(header[0], level=1)
    for line in header[1:]:
        document.add_paragraph(line)
    document.add_paragraph(DISCLAIMER).runs[0].italic = True

    def table(rows, head):
        t = document.add_table(rows=1, cols=len(head))
        t.style = "Table Grid"
        for i, h in enumerate(head):
            t.rows[0].cells[i].text = h
        for row in rows:
            cells = t.add_row().cells
            for i, v in enumerate(row):
                cells[i].text = str(v)
    table(data["kpis"], ["Indicator", "Value"])
    document.add_heading("S-curve (weighted %)", level=2)
    points = view.get("s_curve") or []
    step = max(1, len(points) // 20)
    table([[p["date"], p["planned_pct"], "" if p["actual_pct"] is None else p["actual_pct"]] for p in points[::step]],
          ["Date", "Planned %", "Actual %"])
    document.add_heading("Activities", level=2)
    table(data["activities"], ["Code", "Activity", "Planned cum.", "Actual cum.", "Backlog", "Days behind",
                               "Forecast finish", "Var. (wd)"])
    if data["narrative"]:
        document.add_heading("Narrative (cited)", level=2)
        for label, items in data["narrative"]:
            document.add_paragraph(label).runs[0].bold = True
            for i in items:
                document.add_paragraph(_cite(i), style="List Bullet")
    document.add_heading("Merit and demerit ledger", level=2)
    table(data["ledger"], ["Date", "Subject", "Rule", "Points", "Cause", "", "Review", "Note"])
    document.add_paragraph(DISCLAIMER)
    out = BytesIO()
    document.save(out)
    return out.getvalue()
