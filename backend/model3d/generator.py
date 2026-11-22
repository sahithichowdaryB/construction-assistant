"""Spec -> 3D elements (pure, deterministic, no database).

Every element is an axis-aligned box [x0, y0, z0, x1, y1, z1] in metres (x east, y north, z up, origin at the
first grid intersection and +-0.00), with its level, programme activity and the pour that builds it. A massing
model at about LOD 200: enough to show progress, labelled "progress model, not for construction".

Pour assignment: slabs, rafts and balconies belong to the activity's "slab" pours, columns and walls to its
"vertical" pours, the parapet and lift overrun to its "other" pours. When an activity has several pours of a kind
with grid ranges (slab bays, wall halves), an element is split at the pour boundaries so each piece belongs to
exactly one pour. A range that starts or ends at the outer grid line also covers the overhang beyond it.

A pour may name a `level`: it then builds that level's elements of its kind whatever the level's activity is. That
lets one level be split between programme activities (foundations zone A / zone B), and lets elements the programme
does not measure in m3 (walls) sit in their own untracked pour.
"""

from __future__ import annotations

from .spec import Grid

EPS = 1.0  # mm


def _kind_class(kind: str) -> str:
    return {"raft": "slab", "slab": "slab", "balcony": "slab", "column": "vertical", "wall": "vertical",
            "parapet": "other", "overrun": "other"}[kind]


def _pours_by_activity(spec: dict) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for seq, p in enumerate(spec.get("pours") or []):
        out.setdefault(p["activity"], []).append({**p, "seq": seq})
    return out


def model_pours(spec: dict) -> list[dict]:
    """The pours, in schedule order, plus one synthetic pour for each level activity that has none."""
    pours = [dict(p, seq=i) for i, p in enumerate(spec.get("pours") or [])]
    have = {p["activity"] for p in pours}
    acts = {a["code"]: a for a in spec.get("activities") or []}
    for lv in spec.get("levels") or []:
        code = lv["activity"]
        if code not in have:
            a = acts.get(code) or {}
            pours.append({"id": f"{code}-ALL", "activity": code, "kind": "slab", "x_from": None, "x_to": None,
                          "m3": a.get("m3") or 0, "planned": a.get("finish"), "seq": len(pours), "synthetic": True})
            have.add(code)
    order = {lv["activity"]: i for i, lv in enumerate(spec.get("levels") or [])}
    level_order = {lv["name"]: i for i, lv in enumerate(spec.get("levels") or [])}
    pours.sort(key=lambda p: (level_order.get(p.get("level"), order.get(p["activity"], 99)), p["seq"]))
    for i, p in enumerate(pours):
        p["seq"] = i
    return pours


def _ranges(pours: list[dict], grid: Grid) -> list[tuple[dict, float, float]]:
    out = []
    for p in pours:
        a, b = grid.coord_x(p.get("x_from")), grid.coord_x(p.get("x_to"))
        lo = float("-inf") if a is None or a <= grid.x_min + EPS else a
        hi = float("inf") if b is None or b >= grid.x_max - EPS else b
        out.append((p, lo, hi))
    return out


def _assign(box_mm, kind, activity, level, pours_of: dict[str, list[dict]], pours_at: dict[str, list[dict]], grid: Grid):
    """Split a box at pour boundaries: [(pour_id, box_mm)]."""
    cls = _kind_class(kind)
    same = [p for p in pours_at.get(level) or [] if p["kind"] == cls]   # pours that name this level come first
    if same:
        candidates = same
    else:
        candidates = [p for p in pours_of.get(activity) or [] if not p.get("level")]
        same = [p for p in candidates if p["kind"] == cls]
    if not same:
        fallback = {"other": ("vertical", "slab"), "vertical": ("slab", "other"), "slab": ("vertical", "other")}[cls]
        for alt in fallback:
            same = [p for p in candidates if p["kind"] == alt]
            if same:
                break
    if not same:
        return [(f"{activity}-ALL", box_mm)]
    if len(same) == 1:
        return [(same[0]["id"], box_mm)]
    x0, y0, z0, x1, y1, z1 = box_mm
    pieces = []
    for p, lo, hi in _ranges(same, grid):
        a, b = max(x0, lo), min(x1, hi)
        if b - a > EPS:
            pieces.append((p["id"], [a, y0, z0, b, y1, z1]))
    if not pieces:
        # no range covers it (e.g. several vertical pours without ranges): the first pour of the kind builds it
        return [(same[0]["id"], box_mm)]
    return pieces


def generate(spec: dict) -> dict:
    """Return {"elements": [...], "pours": [...], "bounds": [...], "volumes": {activity: m3}}."""
    grid = Grid(spec["grid"])
    levels = spec["levels"]
    pours = model_pours(spec)
    pours_of: dict[str, list[dict]] = {}
    pours_at: dict[str, list[dict]] = {}
    for p in pours:
        pours_of.setdefault(p["activity"], []).append(p)
        if p.get("level"):
            pours_at.setdefault(p["level"], []).append(p)
    X0, X1, Y0, Y1 = grid.x_min, grid.x_max, grid.y_min, grid.y_max
    raw: list[tuple[str, str, str, str | None, list[float]]] = []   # (kind, level, activity, mark, box_mm)
    by_name = {lv["name"]: i for i, lv in enumerate(levels)}

    for i, lv in enumerate(levels):
        tos, thk, act = lv["tos"], lv["thickness"], lv["activity"]
        if lv["kind"] == "raft":
            oh = float(spec.get("raft_overhang") or 0)
            raw.append(("raft", lv["name"], act, "RAFT", [X0 - oh, Y0 - oh, tos - thk, X1 + oh, Y1 + oh, tos]))
        else:
            raw.append(("slab", lv["name"], act, "SLAB", [X0, Y0, tos - thk, X1, Y1, tos]))

    def storey(name):
        i = by_name[name]
        below, here = levels[i - 1], levels[i]
        return below["tos"], here["tos"] - here["thickness"], here["activity"]

    for col in spec.get("columns") or []:
        w, d = col["size"]
        for name in col.get("storeys") or []:
            z0, z1, act = storey(name)
            for at in col.get("at") or []:
                x, y = grid.point(at)
                raw.append(("column", name, act, f"{col.get('mark') or 'C'} {at}", [x - w / 2, y - d / 2, z0, x + w / 2, y + d / 2, z1]))

    for wall in spec.get("walls") or []:
        t = wall["thickness"]
        (ax, ay), (bx, by) = grid.point(wall["from"]), grid.point(wall["to"])
        for name in wall.get("storeys") or []:
            z0, z1, act = storey(name)
            if ay == by:   # runs east-west
                lo, hi = min(ax, bx), max(ax, bx)
                box = [lo - t / 2, ay - t / 2, z0, hi + t / 2, ay + t / 2, z1]
            else:          # runs north-south
                lo, hi = min(ay, by), max(ay, by)
                box = [ax - t / 2, lo - t / 2, z0, ax + t / 2, hi + t / 2, z1]
            raw.append(("wall", name, act, f"{wall.get('mark') or 'W'} {wall['from']}-{wall['to']}", box))

    bal = spec.get("balconies") or {}
    if bal.get("levels"):
        xs = sorted(grid.x.values())
        width, depth, thk = float(bal.get("width") or 0), float(bal.get("depth") or 0), float(bal.get("thickness") or 0)
        for name in bal["levels"]:
            if name not in by_name or not (width and depth and thk):
                continue
            lv = levels[by_name[name]]
            for a, b in zip(xs, xs[1:]):
                mid, half = (a + b) / 2, min(width, b - a) / 2
                raw.append(("balcony", name, lv["activity"], "BALCONY",
                            [mid - half, Y0 - depth, lv["tos"] - thk, mid + half, Y0, lv["tos"]]))

    roof = levels[-1] if levels else None
    if roof is not None and len(levels) > 1:
        par = spec.get("parapet") or {}
        h, t = float(par.get("height") or 0), float(par.get("thickness") or 0)
        if h and t:
            z0, z1 = roof["tos"], roof["tos"] + h
            for box in ([X0, Y0, z0, X1, Y0 + t, z1], [X0, Y1 - t, z0, X1, Y1, z1],
                        [X0, Y0 + t, z0, X0 + t, Y1 - t, z1], [X1 - t, Y0 + t, z0, X1, Y1 - t, z1]):
                raw.append(("parapet", roof["name"], roof["activity"], "PARAPET", box))
        for core in spec.get("cores") or []:
            (ax, ay), (bx, by) = grid.point(core["from"]), grid.point(core["to"])
            hh, t = float(core.get("height_above_roof") or 0), float(core.get("thickness") or 250)
            if hh:
                x0, y0, x1, y1, z0, z1 = min(ax, bx), min(ay, by), max(ax, bx), max(ay, by), roof["tos"], roof["tos"] + hh
                mark = core.get("mark") or "OVERRUN"
                for box in ([x0, y0, z0, x1, y0 + t, z1], [x0, y1 - t, z0, x1, y1, z1],   # hollow: four walls
                            [x0, y0 + t, z0, x0 + t, y1 - t, z1], [x1 - t, y0 + t, z0, x1, y1 - t, z1]):
                    raw.append(("overrun", roof["name"], roof["activity"], mark, box))

    pour_activity = {p["id"]: p["activity"] for p in pours}
    elements, volumes, counter = [], {}, {}
    for kind, level, level_act, mark, box in raw:
        for pour_id, piece in _assign(box, kind, level_act, level, pours_of, pours_at, grid):
            act = pour_activity.get(pour_id, level_act)   # the activity of the pour that builds it
            counter[(level, kind)] = counter.get((level, kind), 0) + 1
            m = [round(v / 1000, 3) for v in piece]
            vol = round((m[3] - m[0]) * (m[4] - m[1]) * (m[5] - m[2]), 3)
            volumes[act] = volumes.get(act, 0) + vol
            elements.append({"id": f"{level}-{kind}-{counter[(level, kind)]}", "kind": kind, "level": level,
                             "activity": act, "pour": pour_id, "mark": mark, "box": m, "volume_m3": vol})

    pour_volume: dict[str, float] = {}
    for e in elements:
        pour_volume[e["pour"]] = pour_volume.get(e["pour"], 0) + e["volume_m3"]
    used = set(pour_volume)
    out_pours = []
    for p in pours:
        out_pours.append({"id": p["id"], "activity": p["activity"], "kind": p["kind"], "seq": p["seq"],
                          "planned": p.get("planned"), "m3": float(p.get("m3") or 0),
                          "x_from": grid.coord_x(p.get("x_from")), "x_to": grid.coord_x(p.get("x_to")),
                          "model_m3": round(pour_volume.get(p["id"], 0), 1), "has_elements": p["id"] in used,
                          "synthetic": bool(p.get("synthetic"))})
    bounds = [round(min(e["box"][i] for e in elements), 3) for i in range(3)] + \
             [round(max(e["box"][i] for e in elements), 3) for i in range(3, 6)] if elements else [0] * 6
    return {"elements": elements, "pours": out_pours, "bounds": bounds,
            "volumes": {k: round(v, 1) for k, v in volumes.items()}}
