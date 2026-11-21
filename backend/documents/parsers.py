"""Turn an original file into passages with stable locators.

Parsers are deterministic wherever the file has a text layer. The vision model is used
only for scanned pages (OCR) and photos (captions), and its output is validated against
the project registers before any quantity is proposed.

Locator scheme (unique per source):
    reports   p{page}.header, p{page}.{section-slug}, p{page}.signoff, {ACTIVITY} for a
              measured table row, zero-{ACTIVITY} for the report's explicit zero rule
    email     header, body.{n}
    minutes   title, header.{n}, {section-slug}.{n}
    diary     handover (or the entry label), registers: one record per row id,
    project   one record per field, voice: transcript, photo: caption, every source: meta
"""

import csv
import email
import email.utils
import html
import io
import json
import re
import zipfile
from dataclasses import asdict, dataclass, field
from datetime import datetime
from email import policy
from pathlib import Path
from zoneinfo import ZoneInfo

from pypdf import PdfReader

from . import llm

ZERO_NOTE = "Other scheduled activities recorded zero production this shift."
UNITS = {"m3": "m³", "m^3": "m³", "cbm": "m³", "m2": "m²", "m^2": "m²", "sqm": "m²",
         "pc": "pcs", "pieces": "pcs", "tonnes": "t", "tons": "t"}
INJECTION = re.compile(
    r"ignore (?:all |any )?(?:previous|prior|above) instructions|approve all|disregard (?:the |all )?"
    r"(?:previous |prior )?(?:rules|instructions)|you are now|system prompt", re.I)
KIND_LABEL = {"daily_report": "Daily site report", "email": "Email", "minutes": "Meeting minutes",
              "diary": "Site diary", "voice": "Voice note", "photo": "Site photo",
              "schedule": "Schedule register", "register": "Register", "project": "Project register"}


@dataclass
class Passage:
    locator: str
    excerpt: str
    kind: str = "paragraph"
    page: int | None = None
    section: str | None = None
    untrusted: bool = False
    meta: dict = field(default_factory=dict)


@dataclass
class ParseResult:
    title: str | None = None
    meta: dict = field(default_factory=dict)
    passages: list = field(default_factory=list)
    proposals: list = field(default_factory=list)
    review_reasons: list = field(default_factory=list)
    # Passages whose existing stored text must not be replaced without review (OCR output).
    protected: bool = False

    def add(self, *args, **kwargs):
        self.passages.append(Passage(*args, **kwargs))

    def to_json(self):
        return {"title": self.title, "meta": self.meta, "proposals": self.proposals,
                "review_reasons": self.review_reasons,
                "passages": [asdict(p) for p in self.passages]}


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "section"


def squash(text):
    return re.sub(r"\s+", " ", text or "").strip()


def norm_unit(unit):
    unit = squash(unit)
    return UNITS.get(unit.lower(), unit)


def number(value):
    if isinstance(value, (int, float)):
        return value
    match = re.fullmatch(r"\s*(\d+(?:[.,]\d+)?)\s*", str(value or ""))
    if not match:
        return None
    n = float(match[1].replace(",", "."))
    return int(n) if n.is_integer() else n


def schedule_excerpt(row, successors=()):
    """Shared with seed_riverside.py so seeded and parsed schedule passages are identical."""
    equipment = row.get("equipment_ids", "").replace("|", ", ") or "none"
    predecessors = row.get("predecessors", "").replace("|", ", ") or "none"
    followers = ", ".join(successors) or "none"
    return (f"{row['activity_id']}, {row['activity']}, zone {row['zone']}, {row['planned_start']} to "
            f"{row['planned_end']}, {row['planned_qty_per_day']} {row['unit']} per scheduled shift, "
            f"contractor {row['contractor_id']}, equipment {equipment}, predecessors {predecessors}, "
            f"followed by {followers}")


def schedule_successors(rows):
    successors = {}
    for row in rows:
        for predecessor in filter(None, row["predecessors"].split("|")):
            successors.setdefault(predecessor, []).append(row["activity_id"])
    return successors


# ---------------------------------------------------------------- registers

def parse_csv_register(path, ctx, result):
    rows = list(csv.DictReader(io.StringIO(path.read_text(encoding="utf-8-sig"))))
    if not rows:
        result.review_reasons.append("Register is empty")
        return
    columns = list(rows[0])
    if "activity_id" in columns:
        result.title = "Schedule register"
        successors = schedule_successors(rows)
        for row in rows:
            code = row["activity_id"]
            result.add(code, schedule_excerpt(row, successors.get(code, ())), kind="record",
                       meta={"activity": row["activity"], "unit": row["unit"]})
    elif "equipment_id" in columns:
        result.title = "Equipment register"
        for row in rows:
            owner = row["owner_id"]
            assignments = [f"assigned on {c[len('assignment_on_'):].replace('_', '-')} to {row[c]}"
                           for c in columns if c.startswith("assignment_on_") and row[c]]
            text = (f"{row['equipment_id']}, {row['description']}, owned by {owner} "
                    f"({ctx['contractors'].get(owner, 'unknown contractor')})")
            result.add(row["equipment_id"], ", ".join([text, *assignments]), kind="record")
    elif "contractor_id" in columns:
        result.title = "Contractor register"
        for row in rows:
            result.add(row["contractor_id"], f"{row['contractor_id']}, {row['name']}, trade "
                       f"{row['trade']}, contact role {row['contact_role']}", kind="record")
    else:
        result.title = path.stem
        key = columns[0]
        for row in rows:
            result.add(slug(row[key]), ", ".join(f"{k} {v}" for k, v in row.items()), kind="record")


def parse_project(path, ctx, result):
    data = json.loads(path.read_text(encoding="utf-8"))
    result.title = f"Project register: {data.get('name', data.get('id'))}"
    for key, value in data.items():
        if isinstance(value, (dict, list)):
            value = json.dumps(value, ensure_ascii=False)
        shown = "not recorded" if value in (None, "") else value
        result.add(key, f"{key.replace('_', ' ')}: {shown}", kind="record",
                   meta={"missing": value in (None, "")})


# ---------------------------------------------------------------- PDF reports

HEADING = re.compile(r"^[A-Z][a-z]+(?: [a-z]+){0,5}$")
TABLE_COLUMNS = ["code", "activity", "unit", "planned", "actual"]


def report_date(text, fallback):
    match = re.search(r"\b(\d{1,2} [A-Z][a-z]+ \d{4})\b", text)
    if match:
        try:
            return datetime.strptime(match[1], "%d %B %Y").date().isoformat()
        except ValueError:
            pass
    match = re.search(r"(\d{4}-\d{2}-\d{2})", fallback)
    return match[1] if match else None


def add_quantity_rows(result, ctx, page, rows, zero_rule, work_date, source_id, scanned):
    """Validate table rows against the registers and turn them into passages and proposals."""
    activities = ctx["activities"]
    for row in rows:
        code, unit = row["code"], norm_unit(row["unit"])
        actual, planned = number(row.get("actual")), number(row.get("planned"))
        activity = activities.get(code)
        problems = []
        if activity is None:
            problems.append(f"unknown activity code {code!r}")
        elif unit != activity["unit"]:
            problems.append(f"{code}: unit {unit!r} differs from register unit {activity['unit']!r}")
        if actual is None or actual < 0:
            problems.append(f"{code}: actual quantity {row.get('actual')!r} is not readable")
        target = ctx["targets"].get((code, work_date))
        if planned is not None and target is not None and float(planned) != float(target):
            problems.append(f"{code}: report plans {planned}, schedule plans {target} on {work_date}")
        if row.get("legible") is False:
            problems.append(f"{code}: marked illegible by OCR")
        if problems:
            result.review_reasons.extend(problems)
            continue
        result.add(code, f"{code}: actual {actual} {unit}", kind="table_row", page=page,
                   section="Measured shift quantities",
                   meta={"activity": activity["name"], "planned": planned, "actual": actual, "unit": unit,
                         "ocr": scanned})
        result.proposals.append(dict(activity_code=code, work_date=work_date, kind="quantity",
                                     value=actual, unit=unit, basis="signed", source_id=source_id,
                                     locator=code, page=page, planned_on_report=planned))
    if zero_rule:
        listed = {r["code"] for r in rows}
        for code, activity in activities.items():
            if code in listed:
                continue
            result.add(f"zero-{code}", ZERO_NOTE, kind="table_row", page=page,
                       section="Measured shift quantities", meta={"activity": activity["name"], "actual": 0,
                                                                   "unit": activity["unit"], "rule": "explicit"})
            result.proposals.append(dict(activity_code=code, work_date=work_date, kind="quantity", value=0,
                                         unit=activity["unit"], basis="signed", source_id=source_id,
                                         locator=f"zero-{code}", page=page, planned_on_report=None))


def table_rows(text, ctx):
    """Read "CODE  Activity name  unit  planned  actual" rows from a flattened table.

    Works whether the text layer gives one cell per line or one row per line, because rows are
    anchored on the project's own activity codes and units. Returns (rows, note) where note is the
    text after the table (e.g. the explicit zero-production statement).
    """
    found = []
    for code, activity in ctx["activities"].items():
        units = [activity["unit"]] + [k for k, v in UNITS.items() if v == activity["unit"]]
        unit_alt = "|".join(re.escape(u) for u in sorted(units, key=len, reverse=True))
        pattern = (rf"(?<![A-Z0-9-]){re.escape(code)}(?![A-Z0-9-])\s+(.{{0,60}}?)\s+({unit_alt})\s+"
                   rf"(\d+(?:[.,]\d+)?)\s+(\d+(?:[.,]\d+)?)")
        match = re.search(pattern, text)
        if match:
            found.append((match.start(), match.end(), dict(code=code, activity=match[1], unit=match[2],
                                                          planned=match[3], actual=match[4])))
    found.sort(key=lambda f: f[0])
    end = max((f[1] for f in found), default=0)
    tail = text[end:]
    start = tail.find("Quantities are")
    note = squash(tail[start:] if start >= 0 else tail)
    return [f[2] for f in found], note


def parse_text_page(lines, page_no, ctx, result, work_date, source_id):
    i = 0
    header = []
    for j, line in enumerate(lines):
        if re.fullmatch(r"\d+ of \d+", line):
            header, i = lines[:j + 1], j + 1
            break
    if header:
        result.add(f"p{page_no}.header", " | ".join(squash(h) for h in header), kind="header", page=page_no)
    section, buffer, rows, zero_rule = None, [], [], False

    def flush(locator=None):
        if buffer:
            text = squash(" ".join(buffer))
            result.add(locator or f"p{page_no}.{slug(section or 'text')}", text, page=page_no, section=section)
            buffer.clear()

    while i < len(lines):
        line = lines[i]
        if line.startswith("Recorded and confirmed"):
            flush()
            result.add(f"p{page_no}.signoff", squash(" ".join(lines[i:])), page=page_no, section=section)
            break
        if HEADING.match(line) and len(line) <= 40 and line.lower() not in TABLE_COLUMNS:
            flush()
            section = line
            i += 1
            if line == "Measured shift quantities":
                # The table block runs to the next section heading. Activity names such as
                # "Ground slab" look like headings, so they don't end the block.
                names = {a["name"] for a in ctx["activities"].values()}
                block = []
                while i < len(lines) and not (HEADING.match(lines[i]) and len(lines[i]) <= 40
                                              and lines[i] not in names and lines[i].lower() not in TABLE_COLUMNS):
                    block.append(lines[i])
                    i += 1
                found, note = table_rows(squash(" ".join(block)), ctx)
                rows.extend(found)
                zero_rule = ZERO_NOTE.rstrip(".") in note
                if note:
                    result.add(f"p{page_no}.quantities-note", note, page=page_no, section=section)
                if not found:
                    # Never turn an unreadable table into zeros.
                    zero_rule = False
                    result.review_reasons.append(f"Page {page_no}: quantity table found but no rows could be read")
            continue
        buffer.append(line)
        i += 1
    flush()
    if rows or zero_rule:
        add_quantity_rows(result, ctx, page_no, rows, zero_rule, work_date, source_id, scanned=False)


OCR_PROMPT = """You transcribe one scanned page of a construction daily site report.
Copy the text exactly as printed. Never guess a digit: if any character of a value is unclear,
set "legible" to false for that row and describe it in "illegible_notes".
Fields: header_lines = lines above the first section heading; sections = every titled section except
the quantity table; quantity_table = one row per printed table row; table_note = sentence(s) printed
directly under the quantity table; signoff = the "Recorded and confirmed by ..." line(s) with date/time."""

_STR_OR_NULL = {"type": ["string", "null"]}
_NUM_OR_NULL = {"type": ["number", "null"]}
OCR_SCHEMA = {
    "type": "object",
    "properties": {
        "header_lines": {"type": "array", "items": {"type": "string"}},
        "sections": {"type": "array", "items": {
            "type": "object", "properties": {"heading": {"type": "string"}, "text": {"type": "string"}},
            "required": ["heading", "text"], "additionalProperties": False}},
        "quantity_table": {"type": "array", "items": {
            "type": "object",
            "properties": {"code": {"type": "string"}, "activity": {"type": "string"}, "unit": {"type": "string"},
                           "planned": _NUM_OR_NULL, "actual": _NUM_OR_NULL, "legible": {"type": "boolean"}},
            "required": ["code", "activity", "unit", "planned", "actual", "legible"], "additionalProperties": False}},
        "table_note": _STR_OR_NULL,
        "signoff": _STR_OR_NULL,
        "illegible_notes": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["header_lines", "sections", "quantity_table", "table_note", "signoff", "illegible_notes"],
    "additionalProperties": False,
}


def page_png(page):
    images = page.images
    if not images:
        return None
    image = images[0].image
    if max(image.size) > 2000:
        image.thumbnail((2000, 2000))
    out = io.BytesIO()
    image.save(out, format="PNG")
    return out.getvalue()


def parse_scanned_page(page, page_no, ctx, result, work_date, source_id):
    result.protected = True
    result.meta.setdefault("scanned_pages", []).append(page_no)
    png = page_png(page)
    if png is None:
        result.review_reasons.append(f"Page {page_no} has neither text nor an image")
        return
    try:
        data, model = llm.complete_json(OCR_PROMPT, [llm.image_part(png), {"type": "text", "text": "Transcribe this page."}],
                                        schema=OCR_SCHEMA)
    except llm.ModelUnavailable as exc:
        result.review_reasons.append(f"OCR unavailable for page {page_no}; review the original. {exc}"[:500])
        return
    result.meta["ocr_model"] = model
    header = [squash(h) for h in data.get("header_lines") or [] if squash(h)]
    if header:
        result.add(f"p{page_no}.header", " | ".join(header), kind="ocr", page=page_no)
        work_date = report_date(" ".join(header), work_date or "") or work_date
    for section in data.get("sections") or []:
        heading, text = squash(section.get("heading")), squash(section.get("text"))
        if text and heading.lower() != "measured shift quantities":
            result.add(f"p{page_no}.{slug(heading)}", text, kind="ocr", page=page_no, section=heading or None)
    note = squash(data.get("table_note"))
    if note:
        result.add(f"p{page_no}.quantities-note", note, kind="ocr", page=page_no,
                   section="Measured shift quantities")
    if data.get("signoff"):
        result.add(f"p{page_no}.signoff", squash(data["signoff"]), kind="ocr", page=page_no)
    for issue in data.get("illegible_notes") or []:
        result.review_reasons.append(f"OCR page {page_no}: {issue}")
    rows = [dict(code=squash(r.get("code")).upper(), activity=r.get("activity"), unit=r.get("unit") or "",
                 planned=r.get("planned"), actual=r.get("actual"), legible=r.get("legible", True))
            for r in data.get("quantity_table") or []]
    zero_rule = ZERO_NOTE.rstrip(".").lower() in note.lower()
    if not rows:
        result.review_reasons.append(f"OCR found no quantity table on page {page_no}")
        zero_rule = False  # never turn an unreadable table into zeros
    add_quantity_rows(result, ctx, page_no, rows, zero_rule, work_date, source_id, scanned=True)


def parse_pdf(path, ctx, result):
    reader = PdfReader(path)
    work_date = None
    result.meta["pages"] = len(reader.pages)
    for page_no, page in enumerate(reader.pages, start=1):
        text = page.extract_text() or ""
        if len(text.strip()) < 20:
            parse_scanned_page(page, page_no, ctx, result, work_date or report_date("", path.stem),
                               ctx["source"]["id"])
            continue
        work_date = work_date or report_date(text, path.stem)
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        if page_no == 1:
            ref = re.search(r"Shift return (\w+)", text)
            result.title = (f"Daily site report {ref[1]}, {work_date}" if ref
                            else squash(lines[0]) if lines else path.stem)
        parse_text_page(lines, page_no, ctx, result, work_date, ctx["source"]["id"])
    work_date = work_date or report_date("", path.stem)
    result.meta["work_date"] = work_date
    if result.title is None:
        result.title = f"Scanned daily site report {ctx['source']['id']}, {work_date}"


# ---------------------------------------------------------------- email, minutes, diary

def parse_email(path, ctx, result):
    message = email.message_from_bytes(path.read_bytes(), policy=policy.default)
    headers = {k: str(message[k]) for k in ("From", "To", "Date", "Subject", "Message-ID") if message[k]}
    result.title = headers.get("Subject") or path.stem
    result.meta.update({k.lower(): v for k, v in headers.items()})
    header = [f"{k}: {v}" for k, v in headers.items() if k != "Message-ID"]
    sender = re.match(r"^\"?([^\"<@]*?)\"?\s*<?([^@<>\s]+)@([^>\s]+)>?$", headers.get("From", ""))
    if sender:
        # Searchable words for the sender ("client", "plant", "groundworks") besides the raw address.
        words = " ".join(filter(None, [sender[1], re.sub(r"[._-]+", " ", sender[2]), sender[3].split(".")[0]]))
        header.append(f"Sender: {squash(words)}")
    try:
        sent = email.utils.parsedate_to_datetime(headers["Date"]).astimezone(ZoneInfo(ctx["project"]["timezone"]))
        header.append(f"Sent {sent.day} {sent:%B %Y, %H:%M} local time")
    except (KeyError, TypeError, ValueError):
        pass
    result.add("header", " | ".join(header), kind="header", untrusted=True)
    body = message.get_body(preferencelist=("plain", "html"))
    text = body.get_content() if body else ""
    if body is not None and body.get_content_type() == "text/html":
        text = html.unescape(re.sub(r"<[^>]+>", " ", text))
    paragraphs = [squash(p) for p in re.split(r"\n\s*\n", text) if squash(p)]
    flagged = []
    for n, paragraph in enumerate(paragraphs, start=1):
        suspicious = bool(INJECTION.search(paragraph))
        if suspicious:
            flagged.append(f"body.{n}")
        result.add(f"body.{n}", paragraph, untrusted=True, section="Body",
                   meta={"suspected_instruction": suspicious} if suspicious else {})
    if flagged:
        result.meta["suspected_instructions"] = flagged
    attachments = [part.get_filename() for part in message.iter_attachments() if part.get_filename()]
    if attachments:
        result.meta["attachments"] = attachments


def docx_paragraphs(path):
    xml = zipfile.ZipFile(path).read("word/document.xml").decode("utf-8")
    for raw in re.findall(r"<w:p[ >].*?</w:p>", xml, re.S):
        style = re.search(r'<w:pStyle w:val="([^"]+)"', raw)
        text = re.sub(r"<w:(?:tab|br)\b[^>]*/>", " ", raw)
        text = squash(html.unescape(re.sub(r"<[^>]+>", "", text)))
        if text:
            yield (style[1] if style else ""), text


def parse_docx(path, ctx, result):
    section, counters, header_n = None, {}, 0
    for style, text in docx_paragraphs(path):
        if style == "Title":
            result.title = text
            result.add("title", text, kind="heading")
        elif style.startswith("Heading"):
            section = text
        elif section is None:
            header_n += 1
            result.add(f"header.{header_n}", text, kind="header")
            ref = re.search(r"Minutes (\w+)", text)
            if ref:
                result.meta["minutes_ref"] = ref[1]
        else:
            key = slug(section)
            counters[key] = counters.get(key, 0) + 1
            result.add(f"{key}.{counters[key]}", text, section=section)
    result.title = result.title or path.stem


def parse_diary(path, ctx, result):
    text = path.read_text(encoding="utf-8").strip()
    first = text.splitlines()[0] if text else ""
    parts = [squash(p) for p in first.split("|")]
    label = parts[-1] if len(parts) > 1 else "entry"
    result.title = (f"Site diary {ctx['source']['id']}, {parts[1]}, {label}" if len(parts) == 3
                    else squash(first) or path.stem)
    result.add("handover" if "handover" in label.lower() else slug(label), text, section=label)


# ---------------------------------------------------------------- uploaded plans (performance baselines)

# A table row starts with an ID cell on its own line: A200, M3, EXC-B, A410-A440, 1.2.3 is not an ID.
PLAN_ROW = re.compile(r"^(?:[A-Z]{1,4}\d{1,5}[A-Z]?(?:\s?[-–]\s?[A-Z]{0,4}\d{1,5}[A-Z]?)?|[A-Z]{2,6}-[A-Z0-9]{1,6})$")
PLAN_SECTION = re.compile(r"^\d{1,2}\.\s+\S")
DATEISH = re.compile(r"^(?:\d|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b)")


def _name_like(line):
    return bool(line) and line[0].isalpha() and not DATEISH.match(line) and re.search(r"[a-z]{3}", line) is not None


def plan_rows(lines):
    """Group table lines into rows that start with an ID cell followed by a name cell (so an ID in a predecessor
    column does not start a row). Returns [(row_id, [lines])]."""
    rows, current = [], None
    for i, line in enumerate(lines):
        if PLAN_ROW.match(line) and i + 1 < len(lines) and _name_like(lines[i + 1]):
            current = (line.replace(" ", "").replace("–", "-"), [line])
            rows.append(current)
        elif PLAN_SECTION.match(line) or line.startswith("Page "):
            current = None
        elif current is not None:
            current[1].append(line)
    return [(code, body) for code, body in rows if len(body) > 1]


def parse_plan(path, ctx, result):
    """Programme, resource and contract plans: one passage per page (`p{n}`) and one per table row that starts
    with an ID (`p{n}.r{k}`, row k on the page), so extraction can cite the exact row. The row ID is kept in the
    passage meta, not in the locator, because row detection on extracted PDF text is heuristic.
    Word plans: one passage per paragraph; CSV: register rows."""
    suffix = path.suffix.lower()
    if suffix == ".csv":
        parse_csv_register(path, ctx, result)
        return
    if suffix == ".docx":
        for n, (style, text) in enumerate(docx_paragraphs(path), start=1):
            result.title = result.title or (text if style in ("Title", "Heading1") else None)
            result.add(f"para.{n}", text, kind="heading" if style.startswith(("Title", "Heading")) else "paragraph")
        result.title = result.title or path.stem
        return
    if suffix in (".txt", ".md"):
        blocks = [squash(b) for b in re.split(r"\n\s*\n", path.read_text(encoding="utf-8")) if b.strip()]
        for n, block in enumerate(blocks, start=1):
            result.add(f"para.{n}", block)
        result.title = (blocks[0][:120] if blocks else path.stem)
        return
    if suffix != ".pdf":
        result.title = path.name
        result.review_reasons.append(f"Plans must be PDF, Word, CSV or text; {suffix or 'no extension'} is not supported")
        return
    reader = PdfReader(path)
    result.meta["pages"] = len(reader.pages)
    for page_no, page in enumerate(reader.pages, start=1):
        text = page.extract_text() or ""
        lines = [squash(line) for line in text.splitlines() if squash(line)]
        if not lines:
            result.review_reasons.append(f"Page {page_no} has no text layer; the model reads it from the page image")
            result.add(f"p{page_no}", f"Page {page_no} (no text layer; see the original)", page=page_no)
            continue
        if page_no == 1:
            heading = next((line for line in lines[:12] if len(line) > 12 and not line.startswith("MOCK")), lines[0])
            result.title = heading
        result.add(f"p{page_no}", "\n".join(lines), page=page_no, section=f"Page {page_no}")
        for k, (code, body) in enumerate(plan_rows(lines), start=1):
            result.add(f"p{page_no}.r{k}", " | ".join(body), kind="table_row", page=page_no,
                       section=f"Page {page_no}", meta={"row_id": code})
    result.title = result.title or path.stem


# ---------------------------------------------------------------- voice and photos

def parse_voice(path, ctx, result):
    transcript = ctx.get("transcript_path")
    result.title = f"Voice note {ctx['source']['id']}"
    if transcript and Path(transcript).is_file():
        text = squash(Path(transcript).read_text(encoding="utf-8"))
        result.add("transcript", text, kind="transcript", meta={"origin": "supplied transcript"})
    else:
        result.meta["transcript"] = "pending speech-to-text (voice capture module)"


PHOTO_PROMPT = """Describe this construction site photo for an evidence log in one to three factual
sentences. State only what is visible; do not infer causes, sizes or responsibility.
visible_text lists any text legible in the photo (signs, labels), or is empty."""

PHOTO_SCHEMA = {
    "type": "object",
    "properties": {"caption": {"type": "string"}, "visible_text": {"type": "array", "items": {"type": "string"}}},
    "required": ["caption", "visible_text"],
    "additionalProperties": False,
}


def parse_photo(path, ctx, result):
    # Uploads are stored under their hash, so name the photo after the file the user uploaded.
    stem = Path(ctx["source"].get("filename") or path.name).stem.replace("_", " ")
    stem = re.sub(r"(?<=[a-z])-(?=[a-z])", " ", stem)  # "leaking-hose" -> "leaking hose", keeps "PU-01"
    result.title = f"Site photo {ctx['source']['id']}, {squash(stem)}"
    data = path.read_bytes()
    mime = "image/png" if path.suffix.lower() == ".png" else "image/jpeg"
    try:
        from PIL import Image
        image = Image.open(io.BytesIO(data))
        if max(image.size) > 1600:
            image.thumbnail((1600, 1600))
            out = io.BytesIO()
            image.convert("RGB").save(out, format="JPEG", quality=85)
            data, mime = out.getvalue(), "image/jpeg"
        caption, model = llm.complete_json(PHOTO_PROMPT, [llm.image_part(data, mime), {"type": "text", "text": "Caption this photo."}],
                                           schema=PHOTO_SCHEMA)
    except llm.ModelUnavailable as exc:
        result.meta["caption"] = f"unavailable: {str(exc)[:200]}"
        return
    text = squash(caption.get("caption"))
    if text:
        result.add("caption", text, kind="caption",
                   meta={"basis": "inferred", "model": model, "visible_text": caption.get("visible_text") or []})


# ---------------------------------------------------------------- entry point

PARSERS = {".pdf": parse_pdf, ".eml": parse_email, ".docx": parse_docx, ".json": parse_project,
           ".csv": parse_csv_register, ".wav": parse_voice, ".mp3": parse_voice, ".m4a": parse_voice,
           ".jpg": parse_photo, ".jpeg": parse_photo, ".png": parse_photo}


def metadata_passage(result, ctx, path):
    source = ctx["source"]
    local = source["available_at"].astimezone(ZoneInfo(ctx["project"]["timezone"]))
    label = f"{KIND_LABEL.get(source['kind'], source['kind'])} {source['id']}"
    title = result.title or ""
    named = re.search(rf"\b{re.escape(source['id'])}\b", title)
    bits = [title if named else f"{label}: {title}",
            f"available {local:%d %B %Y %H:%M} ({ctx['project']['timezone']})", f"file {path.name}"]
    if result.meta.get("scanned_pages"):
        bits.append("scanned page without a text layer, text read by OCR")
    if result.meta.get("from"):
        bits.append(f"from {result.meta['from']}")
    result.add("meta", "; ".join(bits), kind="metadata")


def parse_file(path: Path, ctx) -> ParseResult:
    result = ParseResult()
    kind = ctx["source"]["kind"]
    parser = parse_diary if kind == "diary" else parse_plan if kind == "plan" else PARSERS.get(path.suffix.lower())
    if parser is None:
        result.title = path.name
        result.review_reasons.append(f"No parser for {path.suffix or 'files without an extension'}")
    else:
        parser(path, ctx, result)
    metadata_passage(result, ctx, path)
    seen = set()
    for passage in result.passages:
        if passage.locator in seen:
            raise ValueError(f"Duplicate locator {passage.locator} in {path.name}")
        seen.add(passage.locator)
    return result
