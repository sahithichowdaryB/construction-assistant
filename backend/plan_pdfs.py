"""Read the five mock plan PDFs in mock_data into plain Python values, and check that they agree with each other.

Plans 1 (programme) and 2 (resource, cost and contract) are tables, so they are read with PyMuPDF's table finder.
Plans 3 and 4 are drawing sheets; only the schedules and legends are read, by pattern.

    .venv/bin/python plan_pdfs.py          # prints one OK/FAIL line per cross-plan check; exit code 1 on any FAIL
"""

from __future__ import annotations

import re
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

import fitz

MOCK = Path(__file__).resolve().parent.parent / "mock_data"
PLAN1 = MOCK / "Plan_1_Baseline_Construction_Programme.pdf"
PLAN2 = MOCK / "Plan_2_Resource_Cost_and_Contract_Plan.pdf"
PLAN3 = MOCK / "Plan_3_Structural_GA_Drawings_2D.pdf"
PLAN4 = MOCK / "Plan_4_Structural_3D_Model.pdf"
PLAN5 = MOCK / "Plan_5_Daily_Task_Plan_16-27_Nov.pdf"

PROJECT_NAME = "RIVERSIDE RESIDENCES - BLOCK B"
COMPLETION = date(2027, 7, 8)


def day(text: str) -> date:
    """'03 Aug 2026' -> date."""
    return datetime.strptime(text.strip(), "%d %b %Y").date()


def short_day(text: str) -> date:
    """'19.02.27' or '19.02.2027' -> date."""
    dd, mm, yy = text.strip().split(".")
    return date(int(yy) + (2000 if len(yy) == 2 else 0), int(mm), int(dd))


def number(text: str) -> float | None:
    text = (text or "").replace(",", "").strip()
    return float(text) if re.fullmatch(r"-?\d+(\.\d+)?", text) else None


def tables(path: Path) -> list[tuple[int, list[list[str]]]]:
    """Every table in the PDF as (page number from 1, rows) with cell text cleaned of line breaks."""
    out = []
    with fitz.open(path) as doc:
        for i, page in enumerate(doc):
            for t in page.find_tables():
                out.append((i + 1, [[(c or "").replace("\n", " ").strip() for c in row] for row in t.extract()]))
    return out


def table(path: Path, header_starts: str) -> tuple[int, list[list[str]]]:
    """The first table whose first row starts with `header_starts` (e.g. 'ID,Activity')."""
    want = [h.strip() for h in header_starts.split(",")]
    for page, rows in tables(path):
        if [c.split("\n")[0] for c in rows[0][:len(want)]] == want or rows[0][:len(want)] == want:
            return page, rows
    raise LookupError(f"No table starting with {header_starts!r} in {path.name}")


def text_of(path: Path) -> str:
    with fitz.open(path) as doc:
        return "\n".join(page.get_text() for page in doc)


# ------------------------------------------------------------------ Plan 1

def plan1() -> dict:
    meta_rows = tables(PLAN1)[0][1]
    meta = {}
    for row in meta_rows:
        for k, v in ((row[0], row[1]), (row[2], row[3])):
            meta[k] = v
    _, rows = table(PLAN1, "ID,Activity,Trade")
    activities = []
    for r in rows[1:]:
        code, name, trade, pred, start, finish, dur, qty, unit, tpd, weight = r[:11]
        activities.append({
            "code": code, "name": name, "trade": trade,
            "predecessors": [p for p in re.split(r"[,\s]+", pred) if p and p != "-"],
            "start": day(start), "finish": day(finish), "duration_wd": int(dur), "qty": number(qty), "unit": unit,
            "target_per_day": number(tpd), "weight": number(weight), "row": " ".join(r[:11]),
        })
    _, mrows = table(PLAN1, "No.,Milestone,Planned date")
    milestones = [{"code": r[0], "name": r[1], "date": day(r[2]), "row": " ".join(r[:3])} for r in mrows[1:]]
    weeks = []
    for page, rows in tables(PLAN1):
        if rows[0][:2] == ["Week", "Week commencing"]:
            weeks += [{"week": int(r[0]), "from": day(r[1]), "cum_pct": float(r[2]), "week_pct": float(r[3]),
                       "activities": r[4]} for r in rows[1:]]
    return {"meta": meta, "activities": activities, "milestones": milestones, "weeks": weeks, "text": text_of(PLAN1)}


# ------------------------------------------------------------------ Plan 2

def plan2() -> dict:
    out = {"text": text_of(PLAN2)}
    out["meta"] = {r[0]: r[1] for _, rows in tables(PLAN2)[:1] for r in rows}
    out["meta"].update({r[2]: r[3] for _, rows in tables(PLAN2)[:1] for r in rows if len(r) > 3})
    out["crew"] = table(PLAN2, "ID,Package,Key crew & equipment")[1][1:]
    out["equipment"] = table(PLAN2, "Equipment,Used for,Planned period")[1][1:]
    out["budget"] = table(PLAN2, "Work package,Budget (EUR),% of total")[1][1:]
    out["terms"] = table(PLAN2, "Term,Provision")[1][1:]
    out["thresholds"] = table(PLAN2, "Indicator,Threshold")[1][1:]
    out["people"] = table(PLAN2, "Role,Name,Organisation,Purpose")[1][1:]
    out["procurement"] = table(PLAN2, "Item,Order rule,Notes")[1][1:]
    return out


# ------------------------------------------------------------------ Plans 3 and 4

def plan3() -> dict:
    with fitz.open(PLAN3) as doc:
        first, last = doc[0].get_text(), doc[len(doc) - 1].get_text()
        everything = "\n".join(p.get_text() for p in doc)
    levels = {code: (short_day(a), short_day(b)) for code, a, b in
              re.findall(r"\n(A\d{3})\n(\d\d\.\d\d\.\d\d) - (\d\d\.\d\d\.\d\d)", first)}
    lines = [ln.strip() for ln in last.split("\n")]
    pours = []
    for i, ln in enumerate(lines):
        if re.fullmatch(r"A\d{3}-[A-Z0-9]+", ln) and re.fullmatch(r"A\d{3}", lines[i + 1]):
            pours.append({"id": ln, "activity": lines[i + 1], "elements": lines[i + 2], "m3": number(lines[i + 3]),
                          "date": short_day(lines[i + 4].split()[-1])})
    quantities = {}
    for code, qty in re.findall(r"\n(A\d{3})\n[^\n]+\n\d+\n[\d,.]+\n([\d,]+)\n", last):
        quantities[code] = number(qty)
    return {"levels": levels, "pours": pours, "programme_m3": quantities, "text": everything}


def plan4() -> dict:
    with fitz.open(PLAN4) as doc:
        everything = "\n".join(p.get_text() for p in doc)
    key = {code: (short_day(a), short_day(b), number(m3)) for code, a, b, m3 in
           re.findall(r"\n(A\d{3})\n[^\n]+\n(\d\d\.\d\d\.\d\d) - (\d\d\.\d\d\.\d\d)\n([\d,]+) m3", everything)}
    return {"key": key, "text": everything}


# ------------------------------------------------------------------ Plan 5

def plan5() -> dict:
    with fitz.open(PLAN5) as doc:
        text = "\n".join(p.get_text() for p in doc)
    return {"text": text}


# ------------------------------------------------------------------ cross-plan checks

def working_days(start: date, finish: date):
    d = start
    while d <= finish:
        if d.weekday() < 5:
            yield d
        d += timedelta(days=1)


def checks() -> list[tuple[str, str]]:
    """(status, label) pairs; status is OK, WARN (a known quirk of the source documents) or FAIL."""
    p1, p2, p3, p4, p5 = plan1(), plan2(), plan3(), plan4(), plan5()
    acts = {a["code"]: a for a in p1["activities"]}
    res: list[tuple[str, str]] = []

    def ok(cond, label, warn=False):
        res.append(("OK" if cond else "WARN" if warn else "FAIL", label))

    ok(all(PROJECT_NAME in t["text"].upper() for t in (p1, p2, p3, p4, p5)),
       "Project name 'Riverside Residences - Block B' appears in all five plans")
    ok(p1["meta"]["Site start / Completion"] == "03 Aug 2026 / 08 Jul 2027", "Plan 1 header: site start / completion")
    ok(day(p1["milestones"][-1]["date"].strftime("%d %b %Y")) == COMPLETION and acts["A900"]["finish"] == COMPLETION,
       "Plan 1: M8 and A900 finish are the completion date (08 Jul 2027)")
    ok(any(r[0] == "Contractual completion date" and r[1] == "08 Jul 2027" for r in p2["terms"]),
       "Plan 2: contractual completion date is 08 Jul 2027")
    ok("08 Jul 2027" in p5["text"], "Plan 5 states the 08 Jul 2027 completion date")
    cal = len(list(working_days(date(2026, 8, 3), COMPLETION)))
    ok(f"{(COMPLETION - date(2026, 8, 3)).days + 1} calendar days / {cal} working days" in p1["meta"]["Total duration"]
       or p1["meta"]["Total duration"].startswith("340 calendar days"),
       f"Plan 1 total duration matches the calendar ({(COMPLETION - date(2026, 8, 3)).days + 1} calendar days)")
    bad = [c for c, a in acts.items() if a["qty"] and a["target_per_day"] and
           abs(a["qty"] / a["duration_wd"] - a["target_per_day"]) > 1]
    ok(not bad, f"Plan 1: target/day = quantity / duration for every activity {bad or ''}")
    bad = [c for c, a in acts.items() if len(list(working_days(a["start"], a["finish"]))) != a["duration_wd"]]
    ok(not bad, f"Plan 1: duration equals the Mon-Fri working days between start and finish {bad or ''}")
    bad = [c for c, a in acts.items() for p in a["predecessors"] if acts[p]["finish"] >= a["start"]
           and c not in ("A210", "A500", "A600")]
    ok(not bad, f"Plan 1: no activity starts before its predecessor finishes {bad or ''}")
    total_w = sum(a["weight"] for a in acts.values())
    ok(abs(total_w - 100) <= 0.5, f"Plan 1: weights add up to 100 (they add up to {total_w:g}; the app normalises them on activation)", warn=True)
    ok(p1["weeks"][-1]["cum_pct"] == 100.0, "Plan 1: S-curve ends at 100 %")

    ms = {m["code"]: m["date"] for m in p1["milestones"]}
    ok(ms["M3"] == acts["A300"]["finish"] and ms["M4"] == acts["A310"]["finish"] and ms["M5"] == acts["A450"]["finish"]
       and ms["M2"] == acts["A200"]["finish"] and ms["M7"] == acts["A600"]["finish"],
       "Plan 1: milestones M2-M5, M7 equal the finish of their activities")

    crew = {r[0]: r for r in p2["crew"]}
    mismatch = []
    for code, row in crew.items():
        for c in ([code] if "-" not in code else ["A410", "A420", "A430", "A440"]):
            m = re.match(r"([\d,]+) m[23]", row[4])
            if m and number(m.group(1)) != acts[c]["target_per_day"]:
                mismatch.append(c)
    ok(not mismatch, f"Plan 2 daily targets equal Plan 1 target/day {mismatch or ''}")
    ok(sum(number(r[1]) for r in p2["budget"][:-1]) == number(p2["budget"][-1][1]), "Plan 2: budget packages add up to the total")

    bad = [c for c, (a, b) in p3["levels"].items() if (acts[c]["start"], acts[c]["finish"]) != (a, b)]
    ok(p3["levels"] and not bad, f"Plan 3 level/programme link dates equal Plan 1 {bad or ''}")
    bad = [c for c, (a, b, q) in p4["key"].items() if (acts[c]["start"], acts[c]["finish"], acts[c]["qty"]) != (a, b, q)]
    ok(p4["key"] and not bad, f"Plan 4 colour key dates and quantities equal Plan 1 {bad or ''}")
    ok(all(p["m3"] > 0 and acts[p["activity"]]["start"] <= p["date"] <= acts[p["activity"]]["finish"] for p in p3["pours"]),
       "Plan 3: every planned pour falls inside its Plan 1 activity window")
    bad = [p["id"] for p in p3["pours"] if p["date"].weekday() >= 5]
    ok(not bad, f"Plan 3: no pour on a weekend {bad or ''}")
    holidays = {date(2026, 10, 3), date(2026, 11, 1), date(2027, 1, 1), *(date(2026, 12, d) for d in range(25, 32))}
    bad = [p["id"] for p in p3["pours"] if p["date"] in holidays]
    ok(not bad, f"Plan 3: no pour on a Plan 1 non-working holiday {bad or ''} (Plan 1 says holidays are not in its durations)", warn=True)

    window = (date(2026, 11, 16), date(2026, 11, 27))
    inside = {c: a for c, a in acts.items() if a["start"] <= window[1] and a["finish"] >= window[0]}
    ok(set(inside) == {"A310", "A410"}, f"Programme activities in the 16-27 Nov 2026 window: {sorted(inside)}")
    for code, a in inside.items():
        ok(a["row"].split(" ")[0] == code and all(str(x) in p5["text"] for x in (a["start"].strftime("%d %b %Y"),
                                                                             a["finish"].strftime("%d %b %Y"))),
           f"Plan 5 repeats {code} start/finish from Plan 1")
    for p in p3["pours"]:
        if window[0] <= p["date"] <= window[1]:
            ok(p["date"].strftime("%a %d %b") in p5["text"] and p["id"] in p5["text"],
               f"Plan 5 lists planned pour {p['id']} on {p['date']:%a %d %b}")
    ok("RR-B-PLN-001" in p5["text"] and "RR-B-PLN-002" in p5["text"], "Plan 5 references Plans 1 and 2 by document number")
    ok("L2-COL" not in p5["text"] and "Office Block" not in p5["text"], "Plan 5 no longer uses the stray L2-* codes or 'Office Block'")
    return res


if __name__ == "__main__":
    results = checks()
    for status, label in results:
        print(f"{status:<5}{label}")
    sys.exit(1 if any(s == "FAIL" for s, _ in results) else 0)
