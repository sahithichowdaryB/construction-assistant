"""The building spec: what P5 extracts from the 2D drawings and what the generator turns into 3D elements.

All lengths are millimetres, as the drawings state them; the generator outputs metres. A spec is a small JSON
document, not geometry:

    grid        {"x": [{"name": "1", "at": 0}, ...], "y": [{"name": "A", "at": 0}, ...]}
    levels      bottom to top: {"name", "tos", "thickness", "activity", "kind": raft|slab|roof}
    columns     {"mark", "size": [w, d], "at": ["2B", ...], "storeys": ["L1", ...]}
    walls       {"mark", "thickness", "from": "1A", "to": "7A", "storeys": [...]}
    balconies   {"levels": [...], "depth", "thickness", "width"} on the south edge (grid y minimum)
    parapet     {"height", "thickness"} on the roof
    cores       {"mark", "from", "to", "height_above_roof"} (lift overrun on the roof)
    pours       {"id", "activity", "kind": slab|vertical|other, "x_from", "x_to", "m3", "planned"}
    activities  {"code", "name", "start", "finish", "m3"}
    calendar    {"working_weekdays": [1..7, Monday=1], "holidays": ["YYYY-MM-DD", ...]}
    deadline_hint {"date", "label"}
    refs        {"<path>": ["source_id:locator", ...]} for the values read from the drawings

A vertical element in storey S (a level name) spans from the top of the level below S up to the soffit of S, and
is built by S's activity: "Level 1: walls & columns (storey below)" in the pour schedule.
"""

from __future__ import annotations

import copy
import re
from datetime import date, timedelta

SEVERITIES = ("blocking", "warning")
POUR_KINDS = ("slab", "vertical", "other")
LEVEL_KINDS = ("raft", "slab", "roof")
MATCH_TOLERANCE = 0.03      # pours of an activity must add up to its m3 within 3%


def reason(severity: str, subject: str, message: str, refs=()) -> dict:
    return {"severity": severity, "subject": subject, "message": message, "refs": list(refs)}


def blocking(reasons: list[dict]) -> list[dict]:
    return [r for r in reasons if r.get("severity") == "blocking"]


def parse_day(value) -> date | None:
    if value in (None, ""):
        return None
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


# ------------------------------------------------------------------ calendar

class Calendar:
    """Working days: weekdays (Monday=1) minus holidays."""

    def __init__(self, working_weekdays=None, holidays=()):
        self.weekdays = set(working_weekdays or (1, 2, 3, 4, 5))
        self.holidays = {d for d in (parse_day(h) for h in holidays or ()) if d}

    @classmethod
    def from_spec(cls, spec: dict) -> "Calendar":
        cal = spec.get("calendar") or {}
        return cls(cal.get("working_weekdays") or None, cal.get("holidays") or ())

    def is_working(self, d: date) -> bool:
        return d.isoweekday() in self.weekdays and d not in self.holidays

    def next_working(self, d: date) -> date:
        while not self.is_working(d):
            d += timedelta(days=1)
        return d

    def add_working_days(self, start: date, n: int) -> date:
        """The n-th working day after `start` (n=0: start itself, moved to a working day)."""
        d = self.next_working(start)
        while n > 0:
            d += timedelta(days=1)
            if self.is_working(d):
                n -= 1
        return d

    def count(self, start: date, end: date) -> int:
        """Working days in [start, end] (0 when end < start)."""
        n, d = 0, start
        while d <= end:
            n += self.is_working(d)
            d += timedelta(days=1)
        return n

    def between(self, a: date, b: date) -> int:
        """Signed working-day difference b - a (b later: positive)."""
        if b == a:
            return 0
        if b > a:
            return self.count(a + timedelta(days=1), b)
        return -self.count(b + timedelta(days=1), a)


# ------------------------------------------------------------------ Riverside reference spec (from Plan_3)

def _grid_x():
    return [{"name": str(i + 1), "at": i * 7200} for i in range(7)]


def _grid_y():
    return [{"name": n, "at": i * 8000} for i, n in enumerate("ABCD")]


UPPER = ["L1", "L2", "L3", "L4", "Roof"]
PERIMETER = [f"{x}{y}" for y in "AD" for x in "1234567"]
INTERNAL = ["2B", "2C", "3B", "3C", "6B", "6C"]
CORE_WALLS = [("4B", "5B"), ("5B", "5C"), ("5C", "4C"), ("4C", "4B")]
PARTY_WALLS = [(f"{x}A", f"{x}B") for x in "2356"] + [(f"{x}C", f"{x}D") for x in "2356"]

RIVERSIDE_SPEC: dict = {
    "title": "Riverside Residences - Block B, structural GA drawings RR-B-STR-S001..S301 Rev C1",
    "grid": {"x": _grid_x(), "y": _grid_y()},
    "raft_overhang": 950,
    "levels": [
        {"name": "Raft", "tos": -3500, "thickness": 1400, "activity": "A300", "kind": "raft"},
        {"name": "GF", "tos": 0, "thickness": 400, "activity": "A310", "kind": "slab"},
        {"name": "L1", "tos": 3200, "thickness": 300, "activity": "A410", "kind": "slab"},
        {"name": "L2", "tos": 6400, "thickness": 300, "activity": "A420", "kind": "slab"},
        {"name": "L3", "tos": 9600, "thickness": 300, "activity": "A430", "kind": "slab"},
        {"name": "L4", "tos": 12800, "thickness": 300, "activity": "A440", "kind": "slab"},
        {"name": "Roof", "tos": 16000, "thickness": 280, "activity": "A450", "kind": "roof"},
    ],
    "columns": [
        {"mark": "BC", "size": [500, 500], "at": INTERNAL, "storeys": ["GF"]},
        {"mark": "C1", "size": [400, 400], "at": PERIMETER, "storeys": UPPER},
        {"mark": "C2", "size": [450, 450], "at": INTERNAL, "storeys": UPPER},
    ],
    "walls": [
        *[{"mark": "RW", "thickness": 350, "from": a, "to": b, "storeys": ["GF"]}
          for a, b in (("1A", "7A"), ("7A", "7D"), ("7D", "1D"), ("1D", "1A"))],
        *[{"mark": f"CW{i + 1}", "thickness": 250, "from": a, "to": b, "storeys": ["GF", *UPPER]}
          for i, (a, b) in enumerate(CORE_WALLS)],
        # Element schedule "B1-L4" / "GF-L4" are the floors the walls stand on, i.e. storeys GF/L1 .. Roof here.
        {"mark": "SW1", "thickness": 250, "from": "1B", "to": "1C", "storeys": UPPER},
        {"mark": "SW2", "thickness": 250, "from": "7B", "to": "7C", "storeys": UPPER},
        *[{"mark": "PW", "thickness": 200, "from": a, "to": b, "storeys": UPPER} for a, b in PARTY_WALLS],
    ],
    "balconies": {"levels": ["L1", "L2", "L3", "L4"], "depth": 1600, "thickness": 220, "width": 5600},
    "parapet": {"height": 1100, "thickness": 200},
    "cores": [{"mark": "LIFT OVERRUN", "from": "4B", "to": "5C", "height_above_roof": 2300, "thickness": 250}],
    "pours": [
        {"id": "A300-P1", "activity": "A300", "kind": "slab", "x_from": "1", "x_to": "3", "m3": 627.7, "planned": "2026-10-21"},
        {"id": "A300-P2", "activity": "A300", "kind": "slab", "x_from": "3", "x_to": "5", "m3": 595.5, "planned": "2026-10-28"},
        {"id": "A300-P3", "activity": "A300", "kind": "slab", "x_from": "5", "x_to": "7", "m3": 568.6, "planned": "2026-11-04"},
        {"id": "A310-W1", "activity": "A310", "kind": "vertical", "x_from": "1", "x_to": "4", "m3": 97.1, "planned": "2026-11-16"},
        {"id": "A310-W2", "activity": "A310", "kind": "vertical", "x_from": "4", "x_to": "7", "m3": 97.1, "planned": "2026-11-19"},
        {"id": "A310-S1", "activity": "A310", "kind": "slab", "x_from": "1", "x_to": 21000, "m3": 209.2, "planned": "2026-11-24"},
        {"id": "A310-S2", "activity": "A310", "kind": "slab", "x_from": 21000, "x_to": "7", "m3": 220.9, "planned": "2026-11-26"},
        *[p for code, level, v, sa, sb in (
            ("A410", "1", "2026-12-04", "2026-12-14", "2026-12-16"),
            ("A420", "2", "2026-12-25", "2027-01-04", "2027-01-06"),
            ("A430", "3", "2027-01-15", "2027-01-25", "2027-01-27"),
            ("A440", "4", "2027-02-05", "2027-02-15", "2027-02-17"))
          for p in (
            {"id": f"{code}-V", "activity": code, "kind": "vertical", "m3": 92.8, "planned": v},
            {"id": f"{code}-SA", "activity": code, "kind": "slab", "x_from": "1", "x_to": 21000, "m3": 164.0, "planned": sa},
            {"id": f"{code}-SB", "activity": code, "kind": "slab", "x_from": 21000, "x_to": "7", "m3": 172.9, "planned": sb})],
        {"id": "A450-V", "activity": "A450", "kind": "vertical", "m3": 93.5, "planned": "2027-02-25"},
        {"id": "A450-SA", "activity": "A450", "kind": "slab", "x_from": "1", "x_to": 21000, "m3": 151.4, "planned": "2027-03-03"},
        {"id": "A450-SB", "activity": "A450", "kind": "slab", "x_from": 21000, "x_to": "7", "m3": 159.9, "planned": "2027-03-05"},
        {"id": "A450-PP", "activity": "A450", "kind": "other", "m3": 44.0, "planned": "2027-03-08"},
    ],
    "activities": [
        {"code": "A300", "name": "Raft foundation", "start": "2026-10-02", "finish": "2026-11-05", "m3": 1800},
        {"code": "A310", "name": "Basement walls & ground slab", "start": "2026-11-06", "finish": "2026-11-26", "m3": 620},
        {"code": "A410", "name": "Structure Level 1", "start": "2026-11-27", "finish": "2026-12-17", "m3": 420},
        {"code": "A420", "name": "Structure Level 2", "start": "2026-12-18", "finish": "2027-01-07", "m3": 420},
        {"code": "A430", "name": "Structure Level 3", "start": "2027-01-08", "finish": "2027-01-28", "m3": 420},
        {"code": "A440", "name": "Structure Level 4", "start": "2027-01-29", "finish": "2027-02-18", "m3": 420},
        {"code": "A450", "name": "Roof slab & parapet", "start": "2027-02-19", "finish": "2027-03-08", "m3": 440},
    ],
    "calendar": {"working_weekdays": [1, 2, 3, 4, 5],
                 "holidays": ["2026-12-25", "2026-12-26", "2026-12-27", "2026-12-28", "2026-12-29", "2026-12-30",
                              "2026-12-31", "2027-01-01"]},
    "deadline_hint": {"date": "2027-03-08", "label": "M5 Structure topped out"},
    "refs": {},
}


def riverside_spec() -> dict:
    return copy.deepcopy(RIVERSIDE_SPEC)


# ------------------------------------------------------------------ grid helpers

GRID_POINT = re.compile(r"^\s*([0-9]+[A-Z]?|[A-Z]+[0-9]*)\s*[/-]?\s*([A-Z]+|[0-9]+)\s*$")


class Grid:
    def __init__(self, grid: dict):
        self.x = {str(g["name"]).strip(): float(g["at"]) for g in grid.get("x") or []}
        self.y = {str(g["name"]).strip(): float(g["at"]) for g in grid.get("y") or []}

    @property
    def x_min(self):
        return min(self.x.values())

    @property
    def x_max(self):
        return max(self.x.values())

    @property
    def y_min(self):
        return min(self.y.values())

    @property
    def y_max(self):
        return max(self.y.values())

    def coord_x(self, value) -> float | None:
        """A grid-line name ("4") or a dimension in mm (21000)."""
        if value is None or value == "":
            return None
        if isinstance(value, (int, float)):
            return float(value)
        s = str(value).strip()
        if s in self.x:
            return self.x[s]
        try:
            return float(s)
        except ValueError:
            return None

    def point(self, ref: str) -> tuple[float, float] | None:
        """"2B" -> (x of line 2, y of line B). Accepts "2/B", "B2" too."""
        s = str(ref or "").strip().upper().replace(" ", "")
        for i in range(1, len(s)):
            a, b = s[:i], s[i:]
            for xs, ys in ((a, b), (b, a)):
                xs_, ys_ = xs.strip("/-"), ys.strip("/-")
                if xs_ in self.x and ys_ in self.y:
                    return self.x[xs_], self.y[ys_]
        return None


# ------------------------------------------------------------------ validation

def _num(value):
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(str(value).replace(",", "").strip())
    except ValueError:
        return None


def validate(spec: dict, passages: dict[str, str] | None = None) -> tuple[dict, list[dict]]:
    """Normalise the spec and list review reasons. Blocking reasons stop activation; warnings are shown.
    `passages` ({"source_id:locator": text}) checks that every ref exists (unknown refs are dropped)."""
    s = copy.deepcopy(spec or {})
    reasons: list[dict] = []
    refs = s.get("refs") or {}

    def refs_for(key):
        return refs.get(key) or []

    # refs must point at passages that were supplied
    if passages is not None:
        clean = {}
        for key, values in refs.items():
            good = [r for r in values or [] if r in passages]
            bad = [r for r in values or [] if r not in passages]
            if bad:
                reasons.append(reason("warning", key, f"dropped {len(bad)} citation(s) that are not passages of the drawings"))
            if good:
                clean[key] = good
        s["refs"] = refs = clean

    # grid
    grid = s.get("grid") or {}
    for axis in ("x", "y"):
        lines = grid.get(axis) or []
        for g in lines:
            g["name"] = str(g.get("name", "")).strip()
            g["at"] = _num(g.get("at"))
        if len(lines) < 2 or any(g["at"] is None or not g["name"] for g in lines):
            reasons.append(reason("blocking", f"grid.{axis}", "needs at least two named grid lines with positions"))
            continue
        positions = [g["at"] for g in lines]
        if positions != sorted(positions) or len(set(positions)) != len(positions):
            reasons.append(reason("blocking", f"grid.{axis}", "grid positions must increase", refs_for("grid")))
        if len({g["name"] for g in lines}) != len(lines):
            reasons.append(reason("blocking", f"grid.{axis}", "grid line names must be unique"))
    s["grid"] = grid
    if blocking(reasons):
        return s, reasons
    g = Grid(grid)

    # activities
    acts = {}
    for a in s.get("activities") or []:
        code = str(a.get("code") or "").strip()
        if not code:
            reasons.append(reason("blocking", "activities", "an activity has no code"))
            continue
        a["code"] = code
        a["m3"] = _num(a.get("m3"))
        a["start"], a["finish"] = (parse_day(a.get("start")) or None), (parse_day(a.get("finish")) or None)
        if a["start"] and a["finish"] and a["finish"] < a["start"]:
            reasons.append(reason("blocking", code, "finishes before it starts", refs_for(f"activities.{code}")))
        if not a["start"] or not a["finish"]:
            reasons.append(reason("warning", code, "planned start or finish missing; forecast uses the pour dates",
                                  refs_for(f"activities.{code}")))
        a["start"] = a["start"].isoformat() if a["start"] else None
        a["finish"] = a["finish"].isoformat() if a["finish"] else None
        acts[code] = a
    s["activities"] = list(acts.values())

    # levels
    levels = s.get("levels") or []
    names = set()
    previous = None
    for lv in levels:
        lv["name"] = str(lv.get("name") or "").strip()
        lv["tos"], lv["thickness"] = _num(lv.get("tos")), _num(lv.get("thickness"))
        lv["kind"] = lv.get("kind") if lv.get("kind") in LEVEL_KINDS else "slab"
        subject = f"level {lv['name'] or '?'}"
        if not lv["name"] or lv["name"] in names:
            reasons.append(reason("blocking", subject, "levels need unique names"))
        names.add(lv["name"])
        if lv["tos"] is None or not lv["thickness"] or lv["thickness"] <= 0:
            reasons.append(reason("blocking", subject, "top of slab and slab thickness are required", refs_for(f"levels.{lv['name']}")))
            continue
        if previous is not None and lv["tos"] <= previous["tos"]:
            reasons.append(reason("blocking", subject, "levels must be listed bottom to top"))
        if previous is not None and lv["tos"] - lv["thickness"] <= previous["tos"]:
            reasons.append(reason("blocking", subject, "storey height is not larger than the slab thickness"))
        code = str(lv.get("activity") or "").strip()
        lv["activity"] = code
        if not code:
            reasons.append(reason("blocking", subject, "no programme activity linked to this level"))
        elif code not in acts:
            reasons.append(reason("warning", subject, f"activity {code} is not in the activity list; it is added without dates"))
            acts[code] = {"code": code, "name": f"{lv['name']} structure", "start": None, "finish": None, "m3": None}
            s["activities"] = list(acts.values())
        previous = lv
    if len(levels) < 1:
        reasons.append(reason("blocking", "levels", "no levels found"))
    s["levels"] = levels
    storey_names = {lv["name"] for lv in levels[1:]}

    # vertical elements
    for key in ("columns", "walls"):
        for e in s.get(key) or []:
            subject = f"{key[:-1]} {e.get('mark') or '?'}"
            storeys = [str(x).strip() for x in e.get("storeys") or []]
            unknown = [x for x in storeys if x not in storey_names]
            if unknown:
                reasons.append(reason("blocking", subject, f"unknown storey {', '.join(unknown)} (storeys are the level names above the first)"))
            e["storeys"] = [x for x in storeys if x in storey_names]
            if key == "columns":
                size = e.get("size") or []
                if len(size) != 2 or any((_num(v) or 0) <= 0 for v in size):
                    reasons.append(reason("blocking", subject, "column size [width, depth] in mm is required"))
                else:
                    e["size"] = [_num(v) for v in size]
                bad = [p for p in e.get("at") or [] if g.point(p) is None]
                if bad:
                    reasons.append(reason("blocking", subject, f"grid point(s) {', '.join(map(str, bad))} not on the grid"))
            else:
                e["thickness"] = _num(e.get("thickness"))
                if not e["thickness"] or e["thickness"] <= 0:
                    reasons.append(reason("blocking", subject, "wall thickness in mm is required"))
                a, b = g.point(e.get("from")), g.point(e.get("to"))
                if a is None or b is None:
                    reasons.append(reason("blocking", subject, f"wall ends {e.get('from')}-{e.get('to')} are not grid points"))
                elif a[0] != b[0] and a[1] != b[1]:
                    reasons.append(reason("blocking", subject, "walls must run along a grid line"))
                elif a == b:
                    reasons.append(reason("blocking", subject, "wall has zero length"))
    # the lift overrun only decorates the roof: a core that is not on grid points is left out, it does not block
    cores = []
    for c in s.get("cores") or []:
        if g.point(c.get("from")) is None or g.point(c.get("to")) is None:
            reasons.append(reason("warning", f"core {c.get('mark') or '?'}",
                                  f"corners {c.get('from')!r} - {c.get('to')!r} are not grid points; left out of the model"))
        else:
            cores.append(c)
    s["cores"] = cores

    # pours
    cal = Calendar.from_spec(s)
    seen = set()
    by_activity: dict[str, float] = {}
    for p in s.get("pours") or []:
        pid = str(p.get("id") or "").strip()
        p["id"] = pid
        subject = f"pour {pid or '?'}"
        if not pid or pid in seen:
            reasons.append(reason("blocking", subject, "pours need unique ids"))
        seen.add(pid)
        code = str(p.get("activity") or "").strip()
        p["activity"] = code
        if code not in acts:
            reasons.append(reason("blocking", subject, f"activity {code or '?'} is not a level activity"))
        p["kind"] = p.get("kind") if p.get("kind") in POUR_KINDS else "slab"
        p["m3"] = _num(p.get("m3"))
        if not p["m3"] or p["m3"] <= 0:
            reasons.append(reason("blocking", subject, "concrete volume (m3) is required", refs_for(f"pours.{pid}")))
        for side in ("x_from", "x_to"):
            if p.get(side) not in (None, "") and g.coord_x(p[side]) is None:
                reasons.append(reason("blocking", subject, f"{side} {p[side]!r} is not a grid line or a dimension"))
        day = parse_day(p.get("planned"))
        p["planned"] = day.isoformat() if day else None
        if day is None:
            reasons.append(reason("warning", subject, "no planned pour date; the planned view spreads it over its activity"))
        else:
            if not cal.is_working(day):
                reasons.append(reason("warning", subject, f"planned on {day:%a %d %b %Y}, which is not a working day "
                                                          "in the programme calendar", refs_for(f"pours.{pid}")))
            a = acts.get(code) or {}
            start, finish = parse_day(a.get("start")), parse_day(a.get("finish"))
            if start and finish and not (start <= day <= finish):
                reasons.append(reason("warning", subject, f"planned {day} is outside its activity window {start} - {finish}"))
        if p["m3"]:
            by_activity[code] = by_activity.get(code, 0) + p["m3"]
    for code, a in acts.items():
        total = by_activity.get(code)
        if total and a.get("m3"):
            diff = (total - a["m3"]) / a["m3"]
            if abs(diff) > MATCH_TOLERANCE:
                reasons.append(reason("warning", code, f"its pours add up to {total:.1f} m3 but the activity states "
                                                       f"{a['m3']:.0f} m3 ({diff:+.1%})", refs_for(f"activities.{code}")))
        elif not total:
            reasons.append(reason("warning", code, "no pours listed; the whole activity is shown as one pour"))

    hint = s.get("deadline_hint") or {}
    if hint.get("date") and not parse_day(hint.get("date")):
        s["deadline_hint"] = {}
    return s, reasons
