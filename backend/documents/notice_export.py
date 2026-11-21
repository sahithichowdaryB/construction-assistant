"""Render the stored wording of an approved notice as an A4 letter."""

from io import BytesIO
from xml.sax.saxutils import escape

from docx import Document
from docx.shared import Mm, Pt
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer


def word_letter(body):
    document = Document()
    section = document.sections[0]
    section.page_width, section.page_height = Mm(210), Mm(297)
    section.left_margin = section.right_margin = Mm(23)
    section.top_margin = section.bottom_margin = Mm(21)
    normal = document.styles["Normal"]
    normal.font.name, normal.font.size = "Calibri", Pt(11)
    for block in body.split("\n\n"):
        document.add_paragraph(block)
    output = BytesIO()
    document.save(output)
    return output.getvalue()


def pdf_letter(body):
    # Vera ships with ReportLab, including on machines without system fonts.
    pdfmetrics.registerFont(TTFont("NoticeVera", "Vera.ttf"))
    style = ParagraphStyle("Notice", fontName="NoticeVera", fontSize=10, leading=14)
    output = BytesIO()
    letter = SimpleDocTemplate(output, pagesize=A4, leftMargin=23*mm, rightMargin=23*mm,
                               topMargin=21*mm, bottomMargin=21*mm, title="SiteMate notice")
    content = []
    for block in body.split("\n\n"):
        content.extend([Paragraph(escape(block).replace("\n", "<br/>"), style), Spacer(1, 7)])
    letter.build(content)
    return output.getvalue()
