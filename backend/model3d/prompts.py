"""P5 "Building spec": read the 2D structural drawings into the spec the generator builds (plan section 4).

Same contract as P1 (performance/prompts.py): untrusted input, JSON schema output, every item cites passages
("source_id:locator") that the server checks (unknown refs are dropped in spec.validate). The model copies values
from the drawings' text (grid dimensions, level table, element schedule, pour schedule); it never measures lines.
"""

from __future__ import annotations

import base64
import json

from performance.prompts import SECURITY, Models

PDF_DOCUMENT_LIMIT = 20 * 1024 * 1024
PASSAGE_BUDGET = 120_000

P5_SYSTEM = f"""You read 2D structural general-arrangement drawings (PDF) of a reinforced-concrete building and write a compact
building spec that a program turns into a 3D massing model. Progress is later shown per pour, so the pours matter most.

{SECURITY}

How to read the drawings:
1. Copy values exactly as the drawings state them, in millimetres (levels in metres such as "+3.20" become 3200;
   "-3.50" becomes -3500). Dates become "YYYY-MM-DD" ("21.10.2026" -> "2026-10-21"). Never measure drawn lines and
   never invent a value: if something is not written, leave it out (or use null / "") and add a short note to "missing".
2. Grid: the grid line names and their positions from the dimension strings (e.g. 7200 between lines 1..7 gives
   x = 0, 7200, 14400 ...; 8000 between A..D gives y = 0, 8000, 16000, 24000). x runs along the numbered lines, y
   along the lettered lines; the first line is at 0.
3. Levels, bottom to top: name (e.g. "Raft", "GF", "L1"... "Roof"), top of slab (tos_mm), slab thickness, the programme
   activity code that builds the level, and kind ("raft" for a foundation raft, "roof" for the top slab, else "slab").
4. Storeys: a column or wall stands in the storey BELOW a level and is named after that level: walls/columns between
   the raft and the ground-floor slab are storey "GF"; between GF and Level 1 are storey "L1"; the top storey is the
   roof level's name. An element schedule saying "GF-L4" for walls standing on GF..L4 means storeys "L1".."Roof".
5. Columns: mark, size, the grid points where the plan labels them (e.g. "1A", "2B" written next to a column) and
   the storeys. Walls: mark, thickness, start and end grid points along one grid line (e.g. core wall "4B" to "5B";
   a shear wall on grid 1 between B and C is "1B" to "1C"; retaining walls run around the perimeter), and storeys.
   Only include positions the drawings show by label or grid reference. List ONE wall per straight segment between
   grid intersections and include every wall type the plans and the element schedule show:
   - retaining / basement walls drawn around the perimeter: one wall per side (e.g. "1A"-"7A", "7A"-"7D", "7D"-"1D", "1D"-"1A");
   - a core drawn as a box between grid lines (e.g. 4-5 / B-C): its four sides as four walls ("4B"-"5B", "5B"-"5C", "5C"-"4C", "4C"-"4B");
   - shear walls labelled on a grid line (e.g. SW1 on grid 1 between B and C: "1B"-"1C");
   - party walls drawn between columns along a grid line (e.g. on grid 2 between A and B: "2A"-"2B").
   Use the element schedule's mark and thickness and its level range for the storeys.
6. Balconies (cantilevers on the south edge), parapet height/thickness and the lift overrun only if the drawings state
   them. The overrun sits on the core: give the two opposite grid-intersection corners of the core box, e.g. "4B" and
   "5C" for a core between grid lines 4-5 and B-C (grid intersections only, never offsets or coordinates).
7. Pours from the pour schedule: id, activity, kind ("slab" for raft/slab/beam pours, "vertical" for walls and
   columns, "other" for parapet/overrun/plinths), the grid range it covers along x (x_from/x_to as a grid line name or
   a dimension in mm such as "21000" for a construction joint at 21.00 m; "" when the pour covers the whole level),
   volume in m3 and planned date.
8. Activities: code, name, planned start and finish, programme quantity in m3.
9. Calendar and deadline: working days and holidays only if stated; deadline_hint is a completion or topping-out
   milestone date if the drawings state one.
10. Every item has "refs": the passages (copied exactly as "source_id:locator" from the passage list) that state its
    values. Cite the most specific passage. Never cite a passage you were not given."""

_S = {"type": "string"}
_N = {"type": ["number", "null"]}
_REFS = {"type": "array", "items": {"type": "string"}}
_STRS = {"type": "array", "items": {"type": "string"}}


def _obj(props: dict) -> dict:
    return {"type": "object", "properties": props, "required": list(props), "additionalProperties": False}


_PROPS = {
    "title": _S,
    "grid": _obj({"x": {"type": "array", "items": _obj({"name": _S, "at_mm": {"type": "number"}})},
                  "y": {"type": "array", "items": _obj({"name": _S, "at_mm": {"type": "number"}})},
                  "refs": _REFS}),
    "raft_overhang_mm": _N,
    "levels": {"type": "array", "items": _obj({"name": _S, "tos_mm": {"type": "number"}, "thickness_mm": {"type": "number"},
                                               "activity": _S, "kind": {"type": "string", "enum": ["raft", "slab", "roof"]},
                                               "refs": _REFS})},
    "columns": {"type": "array", "items": _obj({"mark": _S, "width_mm": {"type": "number"}, "depth_mm": {"type": "number"},
                                                "at": _STRS, "storeys": _STRS, "refs": _REFS})},
    "walls": {"type": "array", "items": _obj({"mark": _S, "thickness_mm": {"type": "number"}, "from": _S, "to": _S,
                                              "storeys": _STRS, "refs": _REFS})},
    "balconies": _obj({"levels": _STRS, "depth_mm": _N, "thickness_mm": _N, "width_mm": _N, "refs": _REFS}),
    "parapet": _obj({"height_mm": _N, "thickness_mm": _N, "refs": _REFS}),
    "cores": {"type": "array", "items": _obj({"mark": _S, "from": _S, "to": _S, "height_above_roof_mm": _N,
                                              "thickness_mm": _N, "refs": _REFS})},
    "pours": {"type": "array", "items": _obj({"id": _S, "activity": _S,
                                              "kind": {"type": "string", "enum": ["slab", "vertical", "other"]},
                                              "x_from": _S, "x_to": _S, "m3": {"type": "number"}, "planned": _S,
                                              "refs": _REFS})},
    "activities": {"type": "array", "items": _obj({"code": _S, "name": _S, "start": _S, "finish": _S, "m3": _N,
                                                   "refs": _REFS})},
    "calendar": _obj({"working_weekdays": {"type": "array", "items": {"type": "integer"}}, "holidays": _STRS,
                      "refs": _REFS}),
    "deadline_hint": _obj({"date": _S, "label": _S, "refs": _REFS}),
    "missing": _STRS,
}
P5_SCHEMA = _obj(_PROPS)   # the whole answer (used by tests and to_spec)

# One structured-output schema for everything is too large for the API's grammar compiler, so P5 runs in three parts
# over the same content (like P1's P1_PARTS) and the answers are merged.
P5_PARTS = [
    ("Part 1 of 3: return title, grid, raft_overhang_mm, levels, activities, calendar, deadline_hint and missing.",
     _obj({k: _PROPS[k] for k in ("title", "grid", "raft_overhang_mm", "levels", "activities", "calendar",
                                  "deadline_hint", "missing")})),
    ("Part 2 of 3: return columns, walls, balconies, parapet and cores (the structural elements and where they stand), "
     "and missing.", _obj({k: _PROPS[k] for k in ("columns", "walls", "balconies", "parapet", "cores", "missing")})),
    ("Part 3 of 3: return every pour of the pour schedule, and missing.",
     _obj({k: _PROPS[k] for k in ("pours", "missing")})),
]


def to_spec(raw: dict) -> dict:
    """Map the P5 answer onto the spec format (spec.py); refs go into spec["refs"] by path."""
    refs: dict[str, list[str]] = {}

    def keep(key, item):
        if item.get("refs"):
            refs[key] = list(dict.fromkeys(item["refs"]))

    grid = raw.get("grid") or {}
    keep("grid", grid)
    spec = {"title": raw.get("title") or "Structural drawings",
            "grid": {"x": [{"name": g["name"], "at": g["at_mm"]} for g in grid.get("x") or []],
                     "y": [{"name": g["name"], "at": g["at_mm"]} for g in grid.get("y") or []]},
            "raft_overhang": raw.get("raft_overhang_mm") or 0, "levels": [], "columns": [], "walls": [],
            "cores": [], "pours": [], "activities": [], "missing": raw.get("missing") or []}
    for lv in raw.get("levels") or []:
        keep(f"levels.{lv['name']}", lv)
        spec["levels"].append({"name": lv["name"], "tos": lv["tos_mm"], "thickness": lv["thickness_mm"],
                               "activity": lv["activity"], "kind": lv["kind"]})
    for c in raw.get("columns") or []:
        keep(f"columns.{c['mark']}", c)
        spec["columns"].append({"mark": c["mark"], "size": [c["width_mm"], c["depth_mm"]], "at": c["at"],
                                "storeys": c["storeys"]})
    for w in raw.get("walls") or []:
        keep(f"walls.{w['mark']}", w)
        spec["walls"].append({"mark": w["mark"], "thickness": w["thickness_mm"], "from": w["from"], "to": w["to"],
                              "storeys": w["storeys"]})
    bal = raw.get("balconies") or {}
    if bal.get("levels") and bal.get("depth_mm") and bal.get("thickness_mm"):
        keep("balconies", bal)
        spec["balconies"] = {"levels": bal["levels"], "depth": bal["depth_mm"], "thickness": bal["thickness_mm"],
                             "width": bal.get("width_mm") or 0}
    par = raw.get("parapet") or {}
    if par.get("height_mm") and par.get("thickness_mm"):
        keep("parapet", par)
        spec["parapet"] = {"height": par["height_mm"], "thickness": par["thickness_mm"]}
    for c in raw.get("cores") or []:
        keep(f"cores.{c['mark']}", c)
        spec["cores"].append({"mark": c["mark"], "from": c["from"], "to": c["to"],
                              "height_above_roof": c.get("height_above_roof_mm") or 0,
                              "thickness": c.get("thickness_mm") or 250})
    for p in raw.get("pours") or []:
        keep(f"pours.{p['id']}", p)
        spec["pours"].append({"id": p["id"], "activity": p["activity"], "kind": p["kind"],
                              "x_from": p.get("x_from") or None, "x_to": p.get("x_to") or None,
                              "m3": p["m3"], "planned": p.get("planned") or None})
    for a in raw.get("activities") or []:
        keep(f"activities.{a['code']}", a)
        spec["activities"].append({"code": a["code"], "name": a["name"], "start": a.get("start") or None,
                                   "finish": a.get("finish") or None, "m3": a.get("m3")})
    cal = raw.get("calendar") or {}
    if cal.get("working_weekdays") or cal.get("holidays"):
        keep("calendar", cal)
        spec["calendar"] = {"working_weekdays": cal.get("working_weekdays") or [1, 2, 3, 4, 5],
                            "holidays": cal.get("holidays") or []}
    hint = raw.get("deadline_hint") or {}
    if hint.get("date"):
        keep("deadline_hint", hint)
        spec["deadline_hint"] = {"date": hint["date"], "label": hint.get("label") or ""}
    spec["refs"] = refs
    return spec


def _content(passages: list[dict], pdfs: list[tuple[str, bytes]]) -> list[dict]:
    blocks = []
    for source_id, data in pdfs:
        if len(data) <= PDF_DOCUMENT_LIMIT:
            blocks.append({"type": "text", "text": f"Original drawing set {source_id} (PDF) follows; cite its passages below."})
            blocks.append({"type": "document", "source": {"type": "base64", "media_type": "application/pdf",
                                                           "data": base64.standard_b64encode(data).decode()}})
    listing, size = [], 0
    for p in passages:
        if size > PASSAGE_BUDGET:
            break
        listing.append({"ref": f"{p['source_id']}:{p['locator']}", "page": p.get("page"), "text": p["excerpt"]})
        size += len(p["excerpt"])
    blocks.append({"type": "text", "text": "Write the building spec. Passages (untrusted data):\n" +
                   json.dumps(listing, ensure_ascii=False)})
    return blocks


P6_SYSTEM = f"""You read ARCHITECTURAL floor plans (one sheet per floor: rooms, walls, doors, windows, a footprint dimension)
so a program can build a simple 3D massing model of the building. You report only geometry the plans show.

{SECURITY}

Rules:
1. footprint: the overall width (west-east, x) and depth (south-north, y) in metres from the dimension strings
   (e.g. "12.00 m" along the bottom = width, "9.00 m" along the side = depth). Cite the passage that states them.
2. floors: one entry per floor plan sheet, bottom floor first, with its name as titled ("Ground floor", "First floor").
3. walls of each floor: every straight wall segment drawn on that sheet, external and internal, as coordinates in
   metres from the SOUTH-WEST outer corner of the footprint (x to the east, y to the north; north is up on the sheet
   unless the north arrow says otherwise). Read positions from the drawing using the footprint dimensions and the scale
   bar, to 0.1 m. Walls only run along x or along y. A door does not break a wall: give the wall from end to end.
   Include the four external walls along the footprint edges, typed "external"; all others "internal".
4. notes: short facts that matter for building it, e.g. "marked not for construction", "no structural information".
5. Never invent floors or walls that are not drawn. refs: copy passages exactly as "source_id:locator"."""

P6_SCHEMA = _obj({
    "title": _S,
    "footprint": _obj({"width_m": _N, "depth_m": _N, "refs": _REFS}),
    "floors": {"type": "array", "items": _obj({
        "name": _S,
        "walls": {"type": "array", "items": _obj({"x1": {"type": "number"}, "y1": {"type": "number"}, "x2": {"type": "number"},
                                                  "y2": {"type": "number"},
                                                  "type": {"type": "string", "enum": ["external", "internal"]}})},
        "refs": _REFS})},
    "notes": _STRS,
})


def is_structural_failure(reasons: list[dict]) -> bool:
    """P5 found no grid or levels: the drawings are probably architectural plans."""
    return any(r.get("severity") == "blocking" and str(r.get("subject", "")).startswith(("grid", "levels", "level"))
               for r in reasons)


def extract_arch(passages: list[dict], pdfs: list[tuple[str, bytes]], models: Models | None = None) -> tuple[dict, str]:
    """Run P6 over architectural plans. Returns (raw answer, model name)."""
    models = models or Models()
    content = _content(passages, pdfs)
    content[-1] = {"type": "text", "text": content[-1]["text"].replace("Write the building spec.", "Read the floor plans.")}
    return models.docs(P6_SYSTEM, content, P6_SCHEMA, effort="medium", max_tokens=16000)


def extract_spec(passages: list[dict], pdfs: list[tuple[str, bytes]], models: Models | None = None) -> tuple[dict, str]:
    """Run P5. Returns (spec, model name)."""
    models = models or Models()
    content = _content(passages, pdfs)
    raw: dict = {"missing": []}
    model = None
    for scope, schema in P5_PARTS:
        part, model = models.docs(P5_SYSTEM, content + [{"type": "text", "text": scope}], schema, effort="medium",
                                  max_tokens=32000)
        missing = raw["missing"] + (part.get("missing") or [])
        raw.update(part)
        raw["missing"] = missing
    return to_spec(raw), model
