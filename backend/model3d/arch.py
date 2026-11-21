"""Architectural floor plans -> building spec, with every structural value an explicit assumption.

Used when the uploaded drawings are architectural plans (rooms, walls, footprint, one sheet per floor) instead of
structural GA drawings: P5 then finds no grid, levels or pours. P6 (prompts.extract_arch) reads only what such a
plan does show: the footprint dimensions, the floors and the wall lines (metres from the south-west corner). This
module turns that into a spec:

    grid       one grid line at every distinct wall coordinate (so walls stand on grid points)
    levels     ground slab, one slab per upper floor, a roof slab: ASSUMED storey height and slab thickness
    walls      the drawn walls; ASSUMED thicknesses (external / internal)
    pours      per floor: walls+columns ("vertical") then the slab above, volumes from the generated model
    activities one per level; planned dates ASSUMED: spread evenly from the start date to the deadline

Every assumption becomes a warning review note, so the manager confirms (or edits) it before activating.
"""

from __future__ import annotations

from datetime import date, timedelta

from .generator import generate
from .spec import reason

STOREY_MM = 3000
SLAB_MM = 200
EXTERNAL_MM = 250
INTERNAL_MM = 150
SNAP_MM = 100


def _snap(v_m: float) -> int:
    return int(round(float(v_m) * 1000 / SNAP_MM) * SNAP_MM)


def build_spec(raw: dict, *, prefix: str, start: date, deadline: date, refs_by_floor: dict | None = None,
               exact_walls: bool = False) -> tuple[dict, list[dict]]:
    """raw = P6 answer. Returns (spec, assumption notes)."""
    fp = raw.get("footprint") or {}
    width, depth = _snap(fp.get("width_m") or 0), _snap(fp.get("depth_m") or 0)
    floors = [f for f in raw.get("floors") or [] if f.get("walls") is not None] or [{"name": "Ground floor", "walls": []}]
    notes: list[dict] = []
    fp_refs = fp.get("refs") or []
    if not (width > 0 and depth > 0):
        return {"title": raw.get("title") or "Floor plans", "grid": {}, "levels": []}, [
            reason("blocking", "footprint", "the footprint dimensions could not be read from the plans")]

    # walls: snapped, orthogonal, inside the footprint; the footprint perimeter is always external wall
    per_floor: list[list[tuple[int, int, int, int, str]]] = []
    dropped = 0
    for f in floors:
        walls = []
        for w in f.get("walls") or []:
            x1, y1, x2, y2 = (_snap(w.get(k) or 0) for k in ("x1", "y1", "x2", "y2"))
            x1, x2 = sorted((min(max(x1, 0), width), min(max(x2, 0), width)))
            y1, y2 = sorted((min(max(y1, 0), depth), min(max(y2, 0), depth)))
            if (x1 != x2 and y1 != y2) or (x1 == x2 and y1 == y2):
                dropped += 1
                continue
            on_edge = (x1 == x2 and x1 in (0, width)) or (y1 == y2 and y1 in (0, depth))
            if on_edge:
                continue          # replaced by the perimeter below
            walls.append((x1, y1, x2, y2, "internal"))
        walls += [(0, 0, width, 0, "external"), (width, 0, width, depth, "external"),
                  (0, depth, width, depth, "external"), (0, 0, 0, depth, "external")]
        per_floor.append(walls)
    if dropped:
        notes.append(reason("warning", "walls", f"{dropped} drawn wall(s) were not straight along x or y and were left out"))

    xs = sorted({0, width} | {v for walls in per_floor for w in walls for v in (w[0], w[2])})
    ys = sorted({0, depth} | {v for walls in per_floor for w in walls for v in (w[1], w[3])})
    gx = {v: f"X{i + 1}" for i, v in enumerate(xs)}
    gy = {v: f"Y{i + 1}" for i, v in enumerate(ys)}

    n = len(per_floor)
    levels = [{"name": "GF", "tos": 0, "thickness": SLAB_MM, "activity": f"{prefix}-GF", "kind": "slab"}]
    names = ["GF"] + [f"L{i}" for i in range(1, n)] + ["Roof"]
    for i in range(1, n + 1):
        levels.append({"name": names[i], "tos": i * STOREY_MM, "thickness": SLAB_MM,
                       "activity": f"{prefix}-{names[i].upper()}", "kind": "roof" if i == n else "slab"})

    walls_spec = []
    for i, walls in enumerate(per_floor):
        storey = names[i + 1]          # walls of floor i stand in the storey below level i+1
        for x1, y1, x2, y2, kind in walls:
            walls_spec.append({"mark": "EW" if kind == "external" else "IW",
                               "thickness": EXTERNAL_MM if kind == "external" else INTERNAL_MM,
                               "from": f"{gx[x1]}{gy[y1]}", "to": f"{gx[x2]}{gy[y2]}", "storeys": [storey]})

    floor_names = [str(f.get("name") or f"Floor {i + 1}") for i, f in enumerate(floors)]
    activities = [{"code": levels[0]["activity"], "name": "Ground floor slab"}]
    for i in range(1, n + 1):
        below = floor_names[i - 1]
        activities.append({"code": levels[i]["activity"],
                           "name": f"{below} walls + {'roof slab' if i == n else floor_names[i] + ' slab'}"})

    # planned dates: activities share the time from start to deadline evenly
    span = max((deadline - start).days, len(activities))
    pours = []
    for k, a in enumerate(activities):
        a_start = start + timedelta(days=round(span * k / len(activities)))
        a_finish = start + timedelta(days=round(span * (k + 1) / len(activities)) - 1)
        a["start"], a["finish"] = a_start.isoformat(), a_finish.isoformat()
        mid = a_start + (a_finish - a_start) / 2
        if k > 0:
            pours.append({"id": f"{a['code']}-V", "activity": a["code"], "kind": "vertical", "m3": 1, "planned": mid.isoformat()})
        pours.append({"id": f"{a['code']}-S", "activity": a["code"], "kind": "slab", "m3": 1, "planned": a_finish.isoformat()})

    spec = {
        "title": raw.get("title") or "Building from architectural floor plans",
        "source_type": "architectural_plan",
        "grid": {"x": [{"name": gx[v], "at": v} for v in xs], "y": [{"name": gy[v], "at": v} for v in ys]},
        "levels": levels, "columns": [], "walls": walls_spec, "cores": [], "pours": pours, "activities": activities,
        "calendar": {"working_weekdays": [1, 2, 3, 4, 5], "holidays": []},
        "refs": {"grid": fp_refs, **(refs_by_floor or {})},
    }
    # pour volumes from the generated model (concrete in the assumed walls and slabs)
    built = generate(spec)
    vol: dict[str, float] = {}
    for e in built["elements"]:
        vol[e["pour"]] = vol.get(e["pour"], 0) + e["volume_m3"]
    for p in spec["pours"]:
        p["m3"] = round(vol.get(p["id"], 0), 1)
    for a in activities:
        a["m3"] = round(sum(p["m3"] for p in pours if p["activity"] == a["code"]), 1)

    notes += [
        reason("warning", "source", "architectural floor plans, not structural drawings: the structure below is assumed "
               "from the footprint and the drawn walls. Check it before activating.", fp_refs),
        reason("warning", "levels", f"assumed storey height {STOREY_MM / 1000:.1f} m and slab thickness {SLAB_MM} mm "
               f"({n} floor{'s' if n != 1 else ''} + roof)"),
        reason("warning", "walls", f"assumed thickness: external {EXTERNAL_MM} mm, internal {INTERNAL_MM} mm; positions " +
               ("taken from the drawing's wall lines (exact to the drawing)" if exact_walls
                else f"estimated from the drawing image to {SNAP_MM} mm, approximate")),
        reason("warning", "pours", "assumed one pour for each floor's walls and one for the slab above; volumes computed from "
               "the model"),
        reason("warning", "programme", f"no programme in the drawings: activities spread evenly from {start:%d %b %Y} to the "
               f"deadline {deadline:%d %b %Y}. Edit the dates to the real programme."),
    ]
    for note in raw.get("notes") or []:
        notes.append(reason("warning", "drawings", str(note)[:300]))
    return spec, notes
