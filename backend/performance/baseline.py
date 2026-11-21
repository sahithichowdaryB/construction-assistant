"""Phase 0: ingest the plan, validate it, let the manager review it, activate it.

Paths
- CSV schedule registers are mapped deterministically (column synonyms; the Riverside schedule.csv is one case).
- Any other plan (PDF programme, resource/cost/contract plan, Word, text, or a CSV with unknown columns) goes through
  prompt P1 over the passages from documents.ingest. PDFs are also sent as documents so the model can read Gantt bars.
- Several files form one baseline: they are extracted together so a resource plan can complete a programme.

Validation is code (section 5.2): unique codes, finish >= start, weights add up to 100 +/- 0.5, predecessors exist,
target/day x duration ~ total (2 %), and every extracted value must appear in the passages it cites. A value the
documents do not contain is left empty and marked missing; target/day may be derived (total / duration) by code and
is marked so. Nothing is activated automatically: activation is a manager action and runs in one transaction.

CLI:  python -m performance.baseline --backfill RIV     (Riverside schedule.csv as baseline revision 1)
"""

from __future__ import annotations

import argparse
import base64
import csv
import io
import json
import re
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import text

from . import metrics as m
from .prompts import P1_PARTS, P1_SYSTEM, Models, valid_refs

CUTOFF = "coalesce(CAST(:cutoff AS timestamptz), 'infinity')"
MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
PDF_DOCUMENT_LIMIT = 20 * 1024 * 1024
PASSAGE_BUDGET = 160_000  # characters per P1 call; larger uploads are extracted per file and merged


def _json(value):
    return json.dumps(value, default=lambda o: o.isoformat() if isinstance(o, (date, datetime)) else str(o))


def _iso(value) -> str | None:
    if value in (None, ""):
        return None
    try:
        return date.fromisoformat(str(value)[:10]).isoformat()
    except ValueError:
        return None


def _num(value):
    if value in (None, "", "-"):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    raw = str(value).strip().replace(" ", "").replace(" ", "")
    if re.fullmatch(r"\d{1,3}(,\d{3})+(\.\d+)?", raw):
        raw = raw.replace(",", "")
    raw = raw.replace(",", ".")
    try:
        return float(raw)
    except ValueError:
        return None


def _clean_num(value):
    """Integral floats as int so numeric columns keep their existing text form (100, not 100.0)."""
    if value is None:
        return None
    value = float(value)
    return int(value) if value.is_integer() else round(value, 4)


# ------------------------------------------------------------------ grounding: a value must be in its cited text

def _norm(text_: str) -> str:
    return re.sub(r"\s+", " ", (text_ or "").replace(" ", " ")).lower()


def number_in(value, text_: str) -> bool:
    if value is None:
        return True
    v = float(value)
    for raw in re.findall(r"\d[\d.,]*", text_ or ""):
        n = _num(raw.rstrip(".,"))
        if n is not None and abs(n - v) < 1e-9:
            return True
        # "1.200" (German thousands) or "6.400"
        if re.fullmatch(r"\d{1,3}(\.\d{3})+", raw) and abs(float(raw.replace(".", "")) - v) < 1e-9:
            return True
    return False


def date_in(iso: str | None, text_: str) -> bool:
    if not iso:
        return True
    d = date.fromisoformat(iso)
    t = _norm(text_)
    month = MONTHS[d.month - 1]
    pats = [rf"\b0?{d.day}(?:st|nd|rd|th)?\.?\s+{month}[a-z]*\.?(?:\s+'?(?:{d.year}|{d.year % 100:02d}))?\b",
            rf"\b{month}[a-z]*\s+0?{d.day}\b", rf"\b{d.isoformat()}\b",
            rf"\b0?{d.day}[./]0?{d.month}[./](?:{d.year}|{d.year % 100:02d})\b",
            rf"\b0?{d.month}/0?{d.day}/(?:{d.year}|{d.year % 100:02d})\b"]
    if any(re.search(p, t) for p in pats):
        return True
    # A day inside a stated range: "25-31 Dec 2026", "25 Dec - 31 Dec".
    for a, b in re.findall(rf"\b(\d{{1,2}})\.?\s*(?:{month}[a-z]*\.?\s*)?[-–]\s*(\d{{1,2}})\.?\s+{month}", t):
        if int(a) <= d.day <= int(b):
            return True
    return False


def code_in(code: str, text_: str) -> bool:
    return re.search(rf"(?<![A-Za-z0-9]){re.escape(code)}(?![A-Za-z0-9])", text_ or "") is not None


# ------------------------------------------------------------------ CSV registers (deterministic)

CSV_COLUMNS = {
    "code": ("activity_id", "activity_code", "code", "id", "task_id", "wbs", "activity id"),
    "name": ("activity", "activity_name", "name", "description", "task", "task_name"),
    "zone": ("zone", "area", "location"),
    "unit": ("unit", "uom"),
    "planned_start": ("planned_start", "start", "start_date", "baseline_start"),
    "planned_finish": ("planned_end", "planned_finish", "finish", "end", "finish_date", "end_date", "baseline_finish"),
    "target_per_day": ("planned_qty_per_day", "target_per_day", "qty_per_day", "daily_target", "rate_per_day"),
    "planned_total": ("planned_total_qty", "planned_total", "total_qty", "quantity", "planned_qty", "qty"),
    "duration_wd": ("duration", "duration_wd", "working_days", "dur"),
    "weight_pct": ("weight", "weight_pct", "weight_%", "weighting"),
    "predecessors": ("predecessors", "predecessor", "depends_on", "dependencies"),
    "is_critical": ("critical", "is_critical", "critical_path"),
    "contractor": ("contractor_id", "contractor", "subcontractor"),
    "trade": ("trade",),
}


def map_csv(rows: list[dict], source_id: str) -> dict | None:
    """Map a schedule CSV onto the extraction shape, or None when the columns are not recognised."""
    if not rows:
        return None
    lower = {c.strip().lower(): c for c in rows[0]}
    col = {k: next((lower[s] for s in syns if s in lower), None) for k, syns in CSV_COLUMNS.items()}
    if not (col["code"] and col["planned_start"] and col["planned_finish"]):
        return None
    activities = []
    for row in rows:
        code = (row.get(col["code"]) or "").strip()
        if not code:
            continue
        get = lambda k: (row.get(col[k]) or "").strip() if col[k] else ""  # noqa: E731
        preds = [p.strip() for p in re.split(r"[|;,]", get("predecessors")) if p.strip()]
        critical = get("is_critical").lower()
        activities.append({
            "code": code, "name": get("name") or code, "trade": get("trade") or None,
            "contractor": get("contractor") or None, "zone": get("zone") or None, "unit": get("unit") or None,
            "planned_start": _iso(get("planned_start")), "planned_finish": _iso(get("planned_finish")),
            "duration_wd": _num(get("duration_wd")), "planned_total": _num(get("planned_total")),
            "target_per_day": _num(get("target_per_day")), "weight_pct": _num(get("weight_pct")),
            "predecessors": preds, "is_critical": True if critical in ("1", "true", "yes", "y", "x") else
            False if critical in ("0", "false", "no", "n") else None,
            "refs": [f"{source_id}:{code}"], "missing": [], "derived": []})
    # A schedule register states no calendar: every date in an activity's range is a scheduled shift (the existing
    # seed semantics, which keeps Riverside's Sunday shift). The manager can change it in the draft.
    return {"title": f"Schedule register {source_id}", "activities": activities, "milestones": [],
            "calendar": {"working_weekdays": list(range(7)), "holidays": [], "refs": [],
                         "note": "Schedule registers carry no calendar; every date in an activity's range is scheduled."},
            "thresholds": [], "notice_rules": [], "rates": [], "addressees": [], "missing": [],
            "contract_completion": {"date": None, "refs": []}, "weather_allowance_days": {"value": None, "refs": []},
            "method": "csv"}


# ------------------------------------------------------------------ P1 extraction over passages

def load_passages(conn, project_id, source_ids) -> list[dict]:
    rows = conn.execute(text("""
        SELECT sp.source_id, sp.locator, sp.page, sp.excerpt, sp.kind, s.title, s.path, s.kind AS source_kind
        FROM sitemate.source_passages sp JOIN sitemate.sources s ON (s.project_id, s.id) = (sp.project_id, sp.source_id)
        WHERE sp.project_id = :p AND sp.source_id = ANY(:ids) AND sp.kind <> 'metadata'
        ORDER BY sp.source_id, sp.ordinal NULLS LAST, sp.locator
    """), {"p": project_id, "ids": list(source_ids)}).mappings().all()
    return [dict(r) for r in rows]


def _p1_content(passages, pdfs):
    blocks = []
    for source_id, data in pdfs:
        blocks.append({"type": "text", "text": f"Original document {source_id} (PDF) follows; cite its passages below."})
        blocks.append({"type": "document", "source": {"type": "base64", "media_type": "application/pdf",
                                                       "data": base64.standard_b64encode(data).decode()}})
    listing = [{"ref": f"{p['source_id']}:{p['locator']}", "document": p["title"], "page": p["page"],
                "text": p["excerpt"]} for p in passages]
    blocks.append({"type": "text", "text": "Extract the plan. Passages (untrusted data):\n" +
                   json.dumps(listing, ensure_ascii=False)})
    return blocks


def _batches(passages):
    by_source = {}
    for p in passages:
        by_source.setdefault(p["source_id"], []).append(p)
    if sum(len(p["excerpt"]) for p in passages) <= PASSAGE_BUDGET:
        return [passages]
    out = []
    for items in by_source.values():
        batch, size = [], 0
        for p in items:
            if batch and size + len(p["excerpt"]) > PASSAGE_BUDGET:
                out.append(batch)
                batch, size = [], 0
            batch.append(p)
            size += len(p["excerpt"])
        out.append(batch)
    return out


def merge_extractions(parts: list[dict]) -> tuple[dict, list[str]]:
    """Merge per-batch extractions: activities and milestones by code (later fills empty fields; a conflicting value
    is kept from the first and reported), other lists concatenated."""
    out = {"title": None, "activities": [], "milestones": [], "calendar": None, "thresholds": [], "notice_rules": [],
           "rates": [], "addressees": [], "missing": [], "contract_completion": {"date": None, "refs": []},
           "weather_allowance_days": {"value": None, "refs": []}}
    conflicts = []
    index = {"activities": {}, "milestones": {}}
    for part in parts:
        out["title"] = out["title"] or part.get("title")
        for key in ("activities", "milestones"):
            for item in part.get(key) or []:
                code = str(item.get("code") or "").strip()
                if code in index[key]:
                    have = index[key][code]
                    for field, value in item.items():
                        if field == "refs":
                            have["refs"] = list(dict.fromkeys(have.get("refs", []) + (value or [])))
                        elif have.get(field) in (None, "", []) and value not in (None, "", []):
                            have[field] = value
                        elif value not in (None, "", []) and have.get(field) != value and field not in ("name",):
                            conflicts.append(f"{code}: {field} {have.get(field)!r} vs {value!r} in another document")
                else:
                    index[key][code] = dict(item)
                    out[key].append(index[key][code])
        cal = part.get("calendar")
        if cal and (cal.get("working_weekdays") or cal.get("holidays")) and not out["calendar"]:
            out["calendar"] = cal
        for key in ("thresholds", "notice_rules", "rates", "addressees", "missing"):
            out[key] += part.get(key) or []
        for key, field in (("contract_completion", "date"), ("weather_allowance_days", "value")):
            if (part.get(key) or {}).get(field) is not None and out[key][field] is None:
                out[key] = part[key]
    out["calendar"] = out["calendar"] or {"working_weekdays": [], "holidays": [], "refs": []}
    return out, conflicts


def extract_plan(passages: list[dict], pdfs: list[tuple[str, bytes]], models: Models | None = None) -> dict:
    """Run P1 over the passages (and the PDFs). Returns the raw merged extraction plus `model` and `dropped`."""
    models = models or Models()
    parts, model = [], None
    for batch in _batches(passages):
        ids = {p["source_id"] for p in batch}
        docs = [(s, d) for s, d in pdfs if s in ids and len(d) <= PDF_DOCUMENT_LIMIT]
        content = _p1_content(batch, docs)
        data = {}
        for scope, schema in P1_PARTS:
            part, model = models.docs(P1_SYSTEM, content + [{"type": "text", "text": scope}], schema, effort="medium",
                                      max_tokens=32000)
            missing = data.get("missing", []) + (part.get("missing") or [])
            data.update(part)
            data["missing"] = missing
        parts.append(data)
    merged, conflicts = merge_extractions(parts)
    merged["model"], merged["merge_conflicts"] = model, conflicts
    return merged


# ------------------------------------------------------------------ validation (section 5.2)

def _reason(severity, subject, message, refs=()):
    return {"severity": severity, "subject": subject, "message": message, "refs": list(refs)}


def validate(extracted: dict, passages: dict[str, str], *, grounded: bool) -> tuple[dict, list[dict]]:
    """Clean the extraction and list review reasons. `passages` maps "source:locator" to text.

    grounded=True (model output): refs must be supplied passages and every value must appear in its cited text.
    grounded=False (deterministic CSV): only the structural checks run.
    """
    allowed = set(passages)
    extracted = normalise(extracted)
    reasons: list[dict] = [_reason("warning", "merge", c) for c in extracted.get("merge_conflicts") or []]
    dropped = 0
    out = dict(extracted)

    def cited(item):
        refs = valid_refs(item.get("refs"), allowed) if grounded else list(item.get("refs") or [])
        return refs, " \n".join(passages.get(r, "") for r in refs)

    acts, seen = [], set()
    for raw in extracted.get("activities") or []:
        a = {k: raw.get(k) for k in ("code", "name", "trade", "contractor", "zone", "unit", "planned_start",
                                     "planned_finish", "duration_wd", "planned_total", "target_per_day", "weight_pct",
                                     "predecessors", "is_critical")}
        a["code"] = str(a.get("code") or "").strip()
        a["missing"], a["derived"] = list(raw.get("missing") or []), list(raw.get("derived") or [])
        refs, cited_text = cited(raw)
        if not a["code"]:
            continue
        if grounded and not refs:
            dropped += 1
            reasons.append(_reason("warning", a["code"], "Dropped: the model cited no supplied passage"))
            continue
        if grounded and not code_in(a["code"], cited_text):
            dropped += 1
            reasons.append(_reason("warning", a["code"], "Dropped: the code does not appear in its cited passages", refs))
            continue
        a["refs"] = refs
        if a["code"] in seen:
            reasons.append(_reason("blocking", a["code"], "Duplicate activity code", refs))
            continue
        seen.add(a["code"])
        for field in ("planned_start", "planned_finish"):
            a[field] = _iso(a[field])
        for field in ("duration_wd", "planned_total", "target_per_day", "weight_pct"):
            a[field] = _num(a[field])
        if grounded:
            for field in ("planned_start", "planned_finish"):
                if a[field] and not date_in(a[field], cited_text):
                    reasons.append(_reason("warning", a["code"], f"{field} {a[field]} is not in the cited text; left empty",
                                           refs))
                    a[field] = None
            for field in ("duration_wd", "planned_total", "target_per_day", "weight_pct"):
                if a[field] is not None and not number_in(a[field], cited_text):
                    reasons.append(_reason("warning", a["code"], f"{field} {a[field]:g} is not in the cited text; "
                                                                 "left empty", refs))
                    a[field] = None
            preds = []
            for p in a.get("predecessors") or []:
                p = str(p).strip()
                if p and code_in(p, cited_text):
                    preds.append(p)
                elif p:
                    reasons.append(_reason("warning", a["code"], f"predecessor {p} is not in the cited text; dropped", refs))
            a["predecessors"] = preds
        a["predecessors"] = [str(p).strip() for p in a.get("predecessors") or [] if str(p).strip()]
        for field in ("planned_start", "planned_finish", "planned_total"):
            if a[field] is None and field not in a["missing"]:
                a["missing"].append(field)
        acts.append(a)
    out["activities"] = acts
    codes = {a["code"] for a in acts}

    cal = m.Calendar.from_settings({"calendar": calendar_settings(extracted.get("calendar"))})
    for a in acts:
        if a["planned_start"] and a["planned_finish"] and a["planned_finish"] < a["planned_start"]:
            reasons.append(_reason("blocking", a["code"], "Planned finish is before the planned start", a["refs"]))
        for p in a["predecessors"]:
            if p not in codes:
                reasons.append(_reason("blocking", a["code"], f"Predecessor {p} is not an activity in this plan", a["refs"]))
        if not (a["planned_start"] and a["planned_finish"]):
            reasons.append(_reason("blocking", a["code"], "Planned start or finish is missing", a["refs"]))
            continue
        working = len(cal.working_days(date.fromisoformat(a["planned_start"]), date.fromisoformat(a["planned_finish"])))
        if a["duration_wd"] is None:
            a["duration_wd"] = working
            a["derived"].append("duration_wd")
        elif int(a["duration_wd"]) != working:
            reasons.append(_reason("warning", a["code"], f"Duration {a['duration_wd']:g} wd, but the calendar has {working} "
                                   "working days in the window (holidays or calendar differ); targets follow the "
                                   "calendar", a["refs"]))
        tpd, total, dur = a["target_per_day"], a["planned_total"], a["duration_wd"]
        if tpd is None and total is not None and dur:
            a["target_per_day"] = round(total / dur, 4)
            a["derived"].append("target_per_day")
        elif tpd is not None and total is not None and dur and total > 0 and abs(tpd * dur - total) / total > 0.02:
            reasons.append(_reason("warning", a["code"], f"Target/day x duration = {tpd * dur:g}, planned total {total:g} "
                                   "(more than 2 % apart)", a["refs"]))
        if total is None and tpd is not None and dur:
            a["planned_total"] = round(tpd * dur, 4)
            a["derived"].append("planned_total")
            if "planned_total" in a["missing"]:
                a["missing"].remove("planned_total")
    try:
        m.topo_order(sorted(codes), {a["code"]: a["predecessors"] for a in acts})
    except ValueError as exc:
        reasons.append(_reason("blocking", "dependencies", str(exc)))
    weights = [a["weight_pct"] for a in acts if a["weight_pct"] is not None]
    if weights and len(weights) == len(acts) and abs(sum(weights) - 100) > 0.5:
        reasons.append(_reason("warning", "weights", f"Weights add up to {sum(weights):g} %, not 100 ± 0.5. Edit them, or "
                               "activate with normalised weights."))
    elif weights and len(weights) != len(acts):
        reasons.append(_reason("warning", "weights", f"{len(acts) - len(weights)} activities have no weight; progress "
                               "is weighted by planned duration instead"))
    if not acts:
        reasons.append(_reason("blocking", "activities", "No activities were found in the uploaded plan"))

    ms, seen_ms = [], set()
    for raw in extracted.get("milestones") or []:
        refs, cited_text = cited(raw)
        code = str(raw.get("code") or "").strip()
        if not code or (grounded and not refs):
            dropped += 1
            continue
        planned = _iso(raw.get("planned_date"))
        if grounded and planned and not date_in(planned, cited_text):
            reasons.append(_reason("warning", code, f"Milestone date {planned} is not in the cited text; left empty", refs))
            planned = None
        if code in seen_ms:
            reasons.append(_reason("blocking", code, "Duplicate milestone code", refs))
            continue
        seen_ms.add(code)
        linked = [c for c in raw.get("activity_codes") or [] if c in codes]
        ms.append({"code": code, "name": raw.get("name") or code, "planned_date": planned,
                   "contractual": bool(raw.get("contractual")), "activity_codes": linked, "refs": refs})
        if planned is None:
            reasons.append(_reason("warning", code, "Milestone has no planned date", refs))
    out["milestones"] = ms

    for key, number_fields in (("thresholds", ("amber_from", "amber_to", "red_above", "consecutive_amber_days_to_red")),
                               ("notice_rules", ("deadline_working_days", "deadline_calendar_days")),
                               ("rates", ("amount", "cap_pct"))):
        kept = []
        for raw in extracted.get(key) or []:
            refs, cited_text = cited(raw)
            if grounded and not refs:
                dropped += 1
                continue
            item = {**raw, "refs": refs}
            for field in number_fields:
                if item.get(field) is not None and grounded and not number_in(item[field], cited_text):
                    reasons.append(_reason("warning", key, f"{field} {item[field]} is not in the cited text; left empty",
                                           refs))
                    item[field] = None
            kept.append(item)
        out[key] = kept
    for key, field, check in (("contract_completion", "date", date_in), ("weather_allowance_days", "value", number_in)):
        raw = extracted.get(key) or {}
        refs, cited_text = cited(raw)
        value = raw.get(field)
        if grounded and value is not None and (not refs or not check(value, cited_text)):
            value = None
        out[key] = {field: value, "refs": refs}
    calendar = dict(extracted.get("calendar") or {})
    if grounded:
        refs, cited_text = cited(calendar)
        calendar["refs"] = refs
        calendar["holidays"] = [h for h in (_iso(x) for x in calendar.get("holidays") or [])
                                if h and refs and date_in(h, cited_text)]
        if not refs:
            calendar["working_weekdays"] = []
            reasons.append(_reason("warning", "calendar", "The plan states no working calendar; Monday-Friday is assumed "
                                   "until you set it"))
    out["calendar"] = calendar
    if grounded and not extracted.get("notice_rules"):
        reasons.append(_reason("warning", "notice_rules", "No notice periods found; defaults apply until you add them"))
    out["dropped"] = dropped
    out["missing"] = list(dict.fromkeys((extracted.get("missing") or [])))
    return out, reasons


def _flag(value):
    if isinstance(value, bool) or value is None:
        return value
    return {"yes": True, "true": True, "no": False, "false": False}.get(str(value).strip().lower())


def normalise(extracted: dict) -> dict:
    """P1 returns strings ("" = not stated) and yes/no/unknown flags; turn them into values or None."""
    x = dict(extracted)
    blank = lambda v: None if isinstance(v, str) and not v.strip() else v  # noqa: E731
    x["activities"] = [{**a, **{k: blank(a.get(k)) for k in ("trade", "contractor", "zone", "unit", "crew", "planned_start",
                                                             "planned_finish", "name")},
                        "is_critical": _flag(a.get("is_critical"))} for a in x.get("activities") or []]
    x["milestones"] = [{**ms, "planned_date": blank(ms.get("planned_date")), "contractual": _flag(ms.get("contractual"))}
                       for ms in x.get("milestones") or []]
    nums = {"thresholds": ("amber_from", "amber_to", "red_above", "consecutive_amber_days_to_red"),
            "notice_rules": ("deadline_working_days", "deadline_calendar_days"), "rates": ("amount", "cap_pct")}
    for key, fields in nums.items():
        x[key] = [{**i, **{f: _num(i.get(f)) for f in fields},
                   **{f: _flag(i.get(f)) for f in ("red_full_shift", "critical_path_late_is_red") if f in i},
                   **{f: blank(i.get(f)) for f in ("addressee_role", "addressee_name", "requirements", "currency",
                                                   "cap_text") if f in i}} for i in x.get(key) or []]
    cal = dict(x.get("calendar") or {})
    cal["shift_hours"] = _num(cal.get("shift_hours"))
    for f in ("shift_start", "shift_end"):
        cal[f] = blank(cal.get(f))
    x["calendar"] = cal
    for key, field in (("contract_completion", "date"), ("weather_allowance_days", "value")):
        item = dict(x.get(key) or {})
        item[field] = blank(item.get(field))
        if field == "value":
            item[field] = _num(item[field])
        x[key] = item
    return x


def blocking(reasons) -> list[dict]:
    return [r for r in reasons if r.get("severity") == "blocking"]


# ------------------------------------------------------------------ extraction -> settings

def calendar_settings(cal: dict | None) -> dict:
    cal = cal or {}
    out = {}
    if cal.get("working_weekdays"):
        out["working_weekdays"] = sorted({int(x) for x in cal["working_weekdays"] if 0 <= int(x) <= 6})
    if cal.get("holidays"):
        out["holidays"] = sorted({h for h in (_iso(x) for x in cal["holidays"]) if h})
    for key in ("shift_start", "shift_end"):
        if cal.get(key) and re.fullmatch(r"\d{1,2}:\d{2}", str(cal[key])):
            out[key] = cal[key]
    if cal.get("shift_hours"):
        out["shift_hours"] = float(cal["shift_hours"])
    return out


def settings_from_extracted(extracted: dict, project: dict | None = None) -> dict:
    """The settings layer a baseline contributes (merged over DEFAULT_SETTINGS when loaded)."""
    layer: dict = {"thresholds": {}, "sources": {}}
    if project:
        # Without a plan document the project's own thresholds apply (Riverside: 15 % / 25 %).
        layer["thresholds"]["daily_output"] = {"amber_pct": float(project["threshold"]),
                                               "red_pct": float(project["high_threshold"])}
    cal = calendar_settings(extracted.get("calendar"))
    if cal:
        layer["calendar"] = cal
        layer["sources"]["calendar"] = extracted.get("calendar", {}).get("refs") or []
    for t in extracted.get("thresholds") or []:
        ind, refs = t.get("indicator"), t.get("refs") or []
        if ind == "daily_output" and t.get("unit") == "percent":
            d = layer["thresholds"].setdefault("daily_output", {})
            # "Amber 10-20 % below target": amber starts above amber_from (the existing strict rule).
            if t.get("amber_from") is not None:
                d["amber_pct"] = float(t["amber_from"])
            red = t.get("red_above") if t.get("red_above") is not None else t.get("amber_to")
            if red is not None:
                d["red_pct"] = float(red)
            if t.get("consecutive_amber_days_to_red"):
                d["consecutive_amber_to_red"] = int(t["consecutive_amber_days_to_red"])
        elif ind == "start_finish" and t.get("unit") == "working_days":
            d = layer["thresholds"].setdefault("start_finish", {})
            if t.get("amber_from") is not None:
                d["amber_days"] = int(t["amber_from"])
            if t.get("red_above") is not None:
                d["red_days"] = int(t["red_above"])
            if t.get("critical_path_late_is_red") is not None:
                d["critical_late_is_red"] = bool(t["critical_path_late_is_red"])
        elif ind == "cumulative_progress":
            d = layer["thresholds"].setdefault("cumulative_points", {})
            if t.get("amber_from") is not None:
                d["amber"] = float(t["amber_from"])
            if t.get("red_above") is not None:
                d["red"] = float(t["red_above"])
        elif ind == "equipment_idle" and t.get("unit") == "hours":
            d = layer["thresholds"].setdefault("equipment_idle", {})
            if t.get("amber_from") is not None:
                d["amber_hours"] = float(t["amber_from"])
            if t.get("red_above") is not None and not t.get("red_full_shift"):
                d["red_hours"] = float(t["red_above"])
        elif ind == "labour" and t.get("unit") == "percent":
            d = layer["thresholds"].setdefault("labour", {})
            if t.get("amber_from") is not None:
                d["amber_pct"] = float(t["amber_from"])
            red = t.get("red_above") if t.get("red_above") is not None else t.get("amber_to")
            if red is not None:
                d["red_pct"] = float(red)
        else:
            continue
        layer["sources"][f"thresholds.{ind}"] = refs
    rules = []
    for n in extracted.get("notice_rules") or []:
        if n.get("type") not in ("delay_notice", "additional_cost_notice", "defect_notice", "notice_of_concern"):
            continue
        rule = {"type": n["type"], "deadline_wd": n.get("deadline_working_days"), "immediate": bool(n.get("immediate")),
                "addressee_role": n.get("addressee_role"), "addressee_name": n.get("addressee_name"),
                "requirements": n.get("requirements"), "refs": n.get("refs") or []}
        if rule["deadline_wd"] is None and n.get("deadline_calendar_days") is not None:
            rule["deadline_calendar_days"] = n["deadline_calendar_days"]
        if rule["deadline_wd"] is None and not rule["immediate"] and rule.get("deadline_calendar_days") is None:
            continue
        if n["type"] == "delay_notice":
            rule["causes"] = ["client", "designer", "supplier", "third_party"]
        rules.append(rule)
    if rules:
        defaults = {r["type"]: r for r in m.DEFAULT_SETTINGS["notice_rules"]}
        present = {r["type"] for r in rules}
        layer["notice_rules"] = rules + [r for t, r in defaults.items() if t not in present]
    equipment, ld = [], None
    for r in extracted.get("rates") or []:
        if r.get("kind") == "liquidated_damages":
            ld = {"amount": r.get("amount"), "currency": r.get("currency"), "per": r.get("per"),
                  "cap_pct": r.get("cap_pct"), "cap_text": r.get("cap_text"), "refs": r.get("refs") or []}
        elif r.get("amount") is not None:
            equipment.append({"item": r.get("item"), "kind": r.get("kind"), "equipment_ids": r.get("equipment_ids") or [],
                              "amount": r["amount"], "currency": r.get("currency"), "per": r.get("per"),
                              "refs": r.get("refs") or []})
    if equipment or ld:
        layer["rates"] = {"equipment": equipment, "liquidated_damages": ld}
    if (extracted.get("weather_allowance_days") or {}).get("value") is not None:
        layer["weather_allowance_days"] = float(extracted["weather_allowance_days"]["value"])
    if (extracted.get("contract_completion") or {}).get("date"):
        layer["contract_completion"] = extracted["contract_completion"]
    if extracted.get("addressees"):
        layer["addressees"] = extracted["addressees"]
    return layer


# ------------------------------------------------------------------ persistence

def stamp(as_of):
    return as_of or datetime.now(timezone.utc).replace(microsecond=0)


def create_baseline(conn, project_id, extracted, reasons, source_ids, *, as_of, member_id=None, title=None,
                    model=None, extraction_status="done", error=None) -> dict:
    revision = conn.scalar(text("SELECT coalesce(max(revision), 0) + 1 FROM sitemate.plan_baselines WHERE project_id=:p"),
                           {"p": project_id})
    row = conn.execute(text("""
        INSERT INTO sitemate.plan_baselines (project_id, revision, status, extraction_status, title, source_ids,
                                             extracted, review_reasons, model, error, created_by, as_of)
        VALUES (:p, :rev, 'draft', :es, :title, :ids, CAST(:x AS jsonb), CAST(:r AS jsonb), :model, :err, :by, :at)
        RETURNING id::text AS id, revision
    """), {"p": project_id, "rev": revision, "es": extraction_status, "title": title or extracted.get("title"),
           "ids": list(source_ids), "x": _json(extracted), "r": _json(reasons), "model": model, "err": error,
           "by": member_id, "at": stamp(as_of)}).mappings().one()
    return dict(row)


def update_draft(conn, project_id, baseline_id, extracted, reasons, *, extraction_status=None, model=None, error=None):
    conn.execute(text("""
        UPDATE sitemate.plan_baselines SET extracted = CAST(:x AS jsonb), review_reasons = CAST(:r AS jsonb),
               extraction_status = coalesce(:es, extraction_status), model = coalesce(:model, model), error = :err,
               title = coalesce(title, :title)
        WHERE project_id = :p AND id = CAST(:b AS uuid) AND status = 'draft'
    """), {"p": project_id, "b": baseline_id, "x": _json(extracted), "r": _json(reasons), "es": extraction_status,
           "model": model, "err": error, "title": extracted.get("title")})


def get_baseline(conn, project_id, baseline_id) -> dict | None:
    row = conn.execute(text("""
        SELECT id::text AS id, project_id, revision, status, extraction_status, title, source_ids, extracted,
               review_reasons, model, error, created_by, created_at, as_of, activated_by, activated_at
        FROM sitemate.plan_baselines WHERE project_id = :p AND id = CAST(:b AS uuid)
    """), {"p": project_id, "b": baseline_id}).mappings().one_or_none()
    return dict(row) if row else None


def active_baseline(conn, project_id, as_of=None) -> dict | None:
    """The baseline in force at `as_of`: the latest one activated by then (active now, or superseded later)."""
    row = conn.execute(text(f"""
        SELECT id::text AS id, revision, status, activated_at, title FROM sitemate.plan_baselines
        WHERE project_id = :p AND status IN ('active', 'superseded') AND activated_at <= {CUTOFF}
        ORDER BY activated_at DESC, revision DESC LIMIT 1
    """), {"p": project_id, "cutoff": as_of}).mappings().one_or_none()
    return dict(row) if row else None


def load_settings(conn, project_id, baseline_id) -> dict:
    layer = conn.scalar(text("SELECT settings FROM sitemate.performance_settings WHERE project_id=:p "
                             "AND baseline_id = CAST(:b AS uuid)"), {"p": project_id, "b": baseline_id}) if baseline_id else None
    if layer is None:
        project = conn.execute(text("SELECT threshold, high_threshold FROM sitemate.projects WHERE id=:p"),
                               {"p": project_id}).mappings().one_or_none()
        layer = settings_from_extracted({}, dict(project) if project else None)
    return m.merge_settings(layer)


def load_plans(conn, project_id, baseline_id) -> list[m.ActivityPlan]:
    rows = conn.execute(text("""
        SELECT activity_code, name, unit, planned_start, planned_finish, duration_wd, planned_total, target_per_day,
               weight, is_critical, predecessors
        FROM sitemate.activity_plan WHERE project_id = :p AND baseline_id = CAST(:b AS uuid) ORDER BY activity_code
    """), {"p": project_id, "b": baseline_id}).mappings().all()
    return [m.ActivityPlan(r["activity_code"], r["planned_start"], r["planned_finish"],
                           float(r["planned_total"]) if r["planned_total"] is not None else None,
                           float(r["target_per_day"]) if r["target_per_day"] is not None else None,
                           float(r["weight"]) if r["weight"] is not None else None, r["duration_wd"], r["is_critical"],
                           list(r["predecessors"] or []), r["name"], r["unit"]) for r in rows]


def expand_targets(activities: list[dict], cal: m.Calendar) -> dict[str, dict[date, float]]:
    """Target per day on each working day from start to finish; 0 on every other day of the plan's span."""
    dated = [a for a in activities if a.get("planned_start") and a.get("planned_finish")]
    if not dated:
        return {}
    first = min(date.fromisoformat(a["planned_start"]) for a in dated)
    last = max(date.fromisoformat(a["planned_finish"]) for a in dated)
    out = {}
    for a in dated:
        start, finish = date.fromisoformat(a["planned_start"]), date.fromisoformat(a["planned_finish"])
        tpd = float(a.get("target_per_day") or 0)
        working = set(cal.working_days(start, finish))
        series, day = {}, first
        while day <= last:
            series[day] = tpd if day in working else 0.0
            day += timedelta(days=1)
        out[a["code"]] = series
    return out


def activate(conn, project_id, baseline_id, *, member_id, as_of, normalize_weights=False, project=None) -> dict:
    """One transaction (the caller's): upsert activities and dependencies, write activity_plan, expand plan_targets,
    write milestones and settings, supersede the previous baseline."""
    b = get_baseline(conn, project_id, baseline_id)
    if b is None:
        raise LookupError("Baseline not found")
    if b["status"] != "draft":
        raise ValueError(f"Baseline revision {b['revision']} is {b['status']}; only a draft can be activated")
    if b["extraction_status"] in ("queued", "running"):
        raise ValueError("Extraction is still running")
    if blocking(b["review_reasons"]):
        raise ValueError("Fix the blocking review reasons first: " +
                         "; ".join(f"{r['subject']}: {r['message']}" for r in blocking(b["review_reasons"])))
    x = b["extracted"]
    acts = [a for a in x.get("activities") or [] if a.get("planned_start") and a.get("planned_finish")]
    if not acts:
        raise ValueError("The baseline has no dated activities")
    project = project or dict(conn.execute(text("SELECT * FROM sitemate.projects WHERE id=:p"), {"p": project_id}).mappings().one())
    layer = {**settings_from_extracted(x, project if x.get("method") == "csv" or not x.get("thresholds") else None),
             **(x.get("settings_overrides") or {})}
    settings = m.merge_settings(layer)
    cal = m.Calendar.from_settings(settings)
    weights = [a.get("weight_pct") for a in acts]
    if normalize_weights and all(w is not None for w in weights) and sum(weights):
        total = sum(weights)
        for a in acts:
            a["weight_pct"] = round(a["weight_pct"] * 100 / total, 4)
    plans = [m.ActivityPlan(a["code"], date.fromisoformat(a["planned_start"]), date.fromisoformat(a["planned_finish"]),
                            a.get("planned_total"), a.get("target_per_day"), a.get("weight_pct"),
                            int(a["duration_wd"]) if a.get("duration_wd") else None, a.get("is_critical"),
                            a.get("predecessors") or []) for a in acts]
    floats = m.planned_critical(plans, cal)
    contractors = set(conn.execute(text("SELECT id FROM sitemate.contractors WHERE project_id=:p"),
                                   {"p": project_id}).scalars().all())
    known = {r["code"]: dict(r) for r in conn.execute(text(
        "SELECT code, name, unit, zone, contractor_id FROM sitemate.activities WHERE project_id=:p"),
        {"p": project_id}).mappings()}
    when = stamp(as_of)
    conn.execute(text("""UPDATE sitemate.plan_baselines SET status = 'superseded'
                         WHERE project_id = :p AND status = 'active'"""), {"p": project_id})
    conn.execute(text("""UPDATE sitemate.plan_baselines SET status = 'active', activated_by = :by, activated_at = :at,
                                extracted = CAST(:x AS jsonb)
                         WHERE project_id = :p AND id = CAST(:b AS uuid)"""),
                 {"p": project_id, "b": baseline_id, "by": member_id, "at": when, "x": _json(x)})
    for a in acts:
        old = known.get(a["code"], {})
        contractor = a.get("contractor") if a.get("contractor") in contractors else old.get("contractor_id")
        conn.execute(text("""
            INSERT INTO sitemate.activities (project_id, code, name, unit, zone, contractor_id)
            VALUES (:p, :c, :n, :u, :z, :ct)
            ON CONFLICT (project_id, code) DO UPDATE SET name = EXCLUDED.name, unit = EXCLUDED.unit,
                zone = EXCLUDED.zone, contractor_id = EXCLUDED.contractor_id
            WHERE (sitemate.activities.name, sitemate.activities.unit, sitemate.activities.zone,
                   sitemate.activities.contractor_id) IS DISTINCT FROM
                  (EXCLUDED.name, EXCLUDED.unit, EXCLUDED.zone, EXCLUDED.contractor_id)
        """), {"p": project_id, "c": a["code"], "n": a.get("name") or old.get("name") or a["code"],
               "u": a.get("unit") or old.get("unit") or "-", "z": a.get("zone") or old.get("zone") or a.get("trade") or "-",
               "ct": contractor})
    codes = [a["code"] for a in acts]
    wanted = {(p, a["code"]) for a in acts for p in a.get("predecessors") or [] if p in codes}
    existing = {tuple(r) for r in conn.execute(text("""SELECT predecessor, successor FROM sitemate.activity_dependencies
        WHERE project_id = :p AND successor = ANY(:c)"""), {"p": project_id, "c": codes}).all()}
    for pred, succ in existing - wanted:
        conn.execute(text("DELETE FROM sitemate.activity_dependencies WHERE project_id=:p AND predecessor=:a AND successor=:b"),
                     {"p": project_id, "a": pred, "b": succ})
    for pred, succ in wanted - existing:
        conn.execute(text("INSERT INTO sitemate.activity_dependencies (project_id, predecessor, successor) VALUES (:p,:a,:b)"),
                     {"p": project_id, "a": pred, "b": succ})
    for a in acts:
        src, loc = (a["refs"][0].split(":", 1) if a.get("refs") else (None, None))
        critical = a.get("is_critical")
        basis = "document" if critical is not None else "computed"
        if critical is None and a["code"] in floats:
            critical = floats[a["code"]] <= 0
        conn.execute(text("""
            INSERT INTO sitemate.activity_plan (project_id, baseline_id, activity_code, name, unit, trade, planned_start,
                planned_finish, duration_wd, planned_total, target_per_day, weight, is_critical, critical_basis,
                predecessors, source_id, locator)
            VALUES (:p, CAST(:b AS uuid), :c, :n, :u, :t, :s, :f, :d, :tot, :tpd, :w, :crit, :basis, :preds, :src, :loc)
        """), {"p": project_id, "b": baseline_id, "c": a["code"], "n": a.get("name"), "u": a.get("unit"),
               "t": a.get("trade"), "s": a["planned_start"], "f": a["planned_finish"],
               "d": int(a["duration_wd"]) if a.get("duration_wd") is not None else None,
               "tot": _clean_num(a.get("planned_total")), "tpd": _clean_num(a.get("target_per_day")),
               "w": _clean_num(a.get("weight_pct")), "crit": critical, "basis": basis,
               "preds": a.get("predecessors") or [], "src": src, "loc": loc})
    written, series = 0, expand_targets(acts, cal)
    for a in acts:
        src, loc = a["refs"][0].split(":", 1)
        rows = [{"p": project_id, "c": a["code"], "d": d, "q": _clean_num(q), "s": src, "l": loc}
                for d, q in series[a["code"]].items()]
        result = conn.execute(text("""
            INSERT INTO sitemate.plan_targets (project_id, activity_code, work_date, quantity, source_id, locator)
            VALUES (:p, :c, :d, :q, :s, :l)
            ON CONFLICT (project_id, activity_code, work_date) DO UPDATE SET quantity = EXCLUDED.quantity,
                source_id = EXCLUDED.source_id, locator = EXCLUDED.locator
            WHERE (sitemate.plan_targets.quantity, sitemate.plan_targets.source_id, sitemate.plan_targets.locator)
                  IS DISTINCT FROM (EXCLUDED.quantity, EXCLUDED.source_id, EXCLUDED.locator)
        """), rows)
        written += result.rowcount or 0
    for ms in x.get("milestones") or []:
        src, loc = (ms["refs"][0].split(":", 1) if ms.get("refs") else (None, None))
        conn.execute(text("""
            INSERT INTO sitemate.milestones (project_id, baseline_id, code, name, planned_date, contractual, activity_codes,
                                             source_id, locator)
            VALUES (:p, CAST(:b AS uuid), :c, :n, :d, :k, :a, :s, :l)
        """), {"p": project_id, "b": baseline_id, "c": ms["code"], "n": ms["name"], "d": ms.get("planned_date"),
               "k": bool(ms.get("contractual")), "a": ms.get("activity_codes") or [], "s": src, "l": loc})
    conn.execute(text("""INSERT INTO sitemate.performance_settings (project_id, baseline_id, settings)
                         VALUES (:p, CAST(:b AS uuid), CAST(:s AS jsonb))"""),
                 {"p": project_id, "b": baseline_id, "s": _json(layer)})
    return {"baseline_id": baseline_id, "revision": b["revision"], "activities": len(acts),
            "milestones": len(x.get("milestones") or []), "plan_targets_changed": written,
            "activated_at": when, "critical": sorted(c for c, f in floats.items() if f <= 0)}


# ------------------------------------------------------------------ CSV baseline from an existing source (back-fill)

def csv_rows_for_source(conn, project_id, source_id) -> list[dict]:
    from documents import storage
    path = conn.scalar(text("SELECT path FROM sitemate.sources WHERE project_id=:p AND id=:s"),
                       {"p": project_id, "s": source_id})
    resolved = storage.resolve(project_id, path) if path else None
    if resolved is None:
        raise FileNotFoundError(f"Original file for {source_id} is not available")
    return list(csv.DictReader(io.StringIO(resolved.read_text(encoding="utf-8-sig"))))


def backfill(conn, project_id, source_id="SCH") -> dict:
    """Record the seeded CSV schedule as baseline revision 1, activated when the schedule became available.

    Idempotent: does nothing when the project already has a baseline. plan_targets rows are only rewritten where
    the expansion differs, so the Riverside rows (source SCH, locator = activity code) stay as they are."""
    if conn.scalar(text("SELECT count(*) FROM sitemate.plan_baselines WHERE project_id=:p"), {"p": project_id}):
        return {"skipped": "baseline exists"}
    available = conn.scalar(text("SELECT available_at FROM sitemate.sources WHERE project_id=:p AND id=:s"),
                            {"p": project_id, "s": source_id})
    if available is None:
        raise LookupError(f"Source {source_id} not found in {project_id}")
    extracted = map_csv(csv_rows_for_source(conn, project_id, source_id), source_id)
    if extracted is None:
        raise ValueError(f"{source_id} is not a schedule register")
    passages = dict(conn.execute(text("""SELECT source_id || ':' || locator, excerpt FROM sitemate.source_passages
                                         WHERE project_id=:p AND source_id=:s"""), {"p": project_id, "s": source_id}).all())
    extracted, reasons = validate(extracted, passages, grounded=False)
    created = create_baseline(conn, project_id, extracted, reasons, [source_id], as_of=available,
                              title=f"Schedule register {source_id} (seeded)", model=None)
    return activate(conn, project_id, created["id"], member_id=None, as_of=available)


def main():
    parser = argparse.ArgumentParser(description="Performance baselines")
    parser.add_argument("--backfill", metavar="PROJECT", help="record the seeded CSV schedule as baseline revision 1")
    parser.add_argument("--source", default="SCH")
    args = parser.parse_args()
    from database import writer_engine
    if args.backfill:
        with writer_engine().begin() as conn:
            print(json.dumps(backfill(conn, args.backfill, args.source), default=str))


if __name__ == "__main__":
    main()
