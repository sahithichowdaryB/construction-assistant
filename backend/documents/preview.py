"""Structured previews of originals that browsers cannot show inline (Word, CSV, email, text, JSON).

Each block carries the passage locator the parser gave the same text, when there is one, so the
frontend can highlight the cited passage inside the original.
"""

import csv
import email
import io
import json
import re
import zipfile
from email import policy
from xml.etree import ElementTree

from .parsers import INJECTION, slug, squash

MAX_TEXT = 200_000
MAX_ROWS = 500
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def _read_text(path):
    data = path.read_bytes()[:MAX_TEXT]
    for encoding in ("utf-8-sig", "cp1252"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def _para_text(p):
    parts = []
    for node in p.iter():
        if node.tag == W + "t" and node.text:
            parts.append(node.text)
        elif node.tag in (W + "tab", W + "br"):
            parts.append(" ")
    return squash("".join(parts))


def _para_style(p):
    style = p.find(f"{W}pPr/{W}pStyle")
    return style.get(W + "val", "") if style is not None else ""


def docx_preview(path):
    root = ElementTree.fromstring(zipfile.ZipFile(path).read("word/document.xml"))
    body = root.find(W + "body")
    blocks = []
    # Same locator sequence as parsers.parse_docx, which walks every paragraph in document order.
    state = {"section": None, "counters": {}, "header": 0}

    def locate(style, text):
        if style == "Title":
            return "title"
        if style.startswith("Heading"):
            state["section"] = text
            return None
        if state["section"] is None:
            state["header"] += 1
            return f"header.{state['header']}"
        key = slug(state["section"])
        state["counters"][key] = state["counters"].get(key, 0) + 1
        return f"{key}.{state['counters'][key]}"

    for child in list(body) if body is not None else []:
        if child.tag == W + "p":
            text, style = _para_text(child), _para_style(child)
            if not text:
                continue
            locator = locate(style, text)
            kind = ("title" if style == "Title" else "heading" if style.startswith("Heading")
                    else "list" if child.find(f"{W}pPr/{W}numPr") is not None or style.startswith("List")
                    else "paragraph")
            level = int(re.sub(r"\D", "", style) or 1) if kind == "heading" else None
            blocks.append({"type": kind, "text": text, "level": level, "locator": locator})
        elif child.tag == W + "tbl":
            rows, locators = [], []
            for tr in child.iter(W + "tr"):
                cells = []
                for tc in tr.findall(W + "tc"):
                    texts = []
                    for p in tc.iter(W + "p"):
                        text = _para_text(p)
                        if text:
                            texts.append(text)
                            loc = locate(_para_style(p), text)
                            if loc:
                                locators.append(loc)
                    cells.append(" ".join(texts))
                rows.append(cells)
            if rows:
                blocks.append({"type": "table", "rows": rows, "locators": locators})
    return {"kind": "document", "blocks": blocks}


def csv_preview(path):
    text = _read_text(path)
    try:
        dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    rows = list(csv.reader(io.StringIO(text), dialect))
    rows = [r for r in rows if any(c.strip() for c in r)]
    columns = rows[0] if rows else []
    body = rows[1:MAX_ROWS + 1]
    return {"kind": "table", "columns": columns, "rows": body,
            "row_count": max(len(rows) - 1, 0), "truncated": len(rows) - 1 > MAX_ROWS}


def email_preview(path):
    message = email.message_from_bytes(path.read_bytes(), policy=policy.default)
    headers = [{"name": k, "value": str(message[k])} for k in ("From", "To", "Cc", "Date", "Subject") if message[k]]
    body = message.get_body(preferencelist=("plain", "html"))
    text = body.get_content() if body else ""
    if body is not None and body.get_content_type() == "text/html":
        text = re.sub(r"<[^>]+>", " ", text)
    # Same paragraph split and numbering as parsers.parse_email (body.n).
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if squash(p)]
    attachments = [part.get_filename() for part in message.iter_attachments() if part.get_filename()]
    return {"kind": "email", "headers": headers, "attachments": attachments,
            "blocks": [{"type": "paragraph", "text": p, "locator": f"body.{n}",
                        "flagged": bool(INJECTION.search(squash(p)))}
                       for n, p in enumerate(paragraphs, start=1)]}


def text_preview(path):
    return {"kind": "text", "text": _read_text(path)}


def json_preview(path):
    raw = _read_text(path)
    try:
        raw = json.dumps(json.loads(raw), indent=2, ensure_ascii=False)
    except ValueError:
        pass
    return {"kind": "text", "text": raw, "language": "json"}


def build_preview(path):
    """Return a preview dict for the file, or None when the browser can show it natively."""
    suffix = path.suffix.lower()
    if suffix == ".docx":
        return docx_preview(path)
    if suffix in (".csv", ".tsv"):
        return csv_preview(path)
    if suffix == ".eml":
        return email_preview(path)
    if suffix == ".json":
        return json_preview(path)
    if suffix in (".txt", ".md", ".log"):
        return text_preview(path)
    return None
