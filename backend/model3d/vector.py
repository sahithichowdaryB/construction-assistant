"""Read wall lines from vector PDF floor plans (pypdf content streams), so wall positions are exact, not estimated.

For each page: collect dark, straight, axis-aligned stroked lines (paths from m/l and re, with their line width and
stroke colour; curves such as door swings are skipped). The thickest dark lines outline the footprint (external
walls). Internal walls are the dark lines with the line width that has the largest total length among the rest
(door leaves, stairs and hatching use other widths and are short). Coordinates become metres from the south-west
outer corner using the footprint width stated on the drawing. Collinear and overlapping pieces are merged; white
strokes drawn over walls for door openings are ignored, so a wall runs end to end.

Returns None for a page without such geometry (scanned or raster plans): P6's estimated walls are used instead.
"""

from __future__ import annotations

from collections import defaultdict

from pypdf import PdfReader
from pypdf.generic import ContentStream

DARK = 0.35        # all stroke colour components at or below this count as "dark"
MIN_WALL_M = 0.4   # shorter pieces are not walls


def _mul(a, b):
    """3x2 affine matrices as (a, b, c, d, e, f): returns a then b."""
    return (a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2],
            a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5])


def _apply(m, x, y):
    return m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]


def page_segments(reader: PdfReader, page) -> list[tuple[float, float, float, float, float]]:
    """Dark, straight, axis-aligned stroked segments: (x1, y1, x2, y2, width) in page points."""
    ops = ContentStream(page.get_contents(), reader).operations
    ctm = (1, 0, 0, 1, 0, 0)
    stack = []
    width, colour = 1.0, (0.0, 0.0, 0.0)
    path, curved, current = [], False, None
    out = []
    for args, op in ops:
        a = [float(x) for x in args if isinstance(x, (int, float)) or hasattr(x, "__float__")]
        if op == b"q":
            stack.append((ctm, width, colour))
        elif op == b"Q" and stack:
            ctm, width, colour = stack.pop()
        elif op == b"cm" and len(a) == 6:
            ctm = _mul(tuple(a), ctm)
        elif op == b"w" and a:
            width = a[0]
        elif op == b"RG" and len(a) == 3:
            colour = tuple(a)
        elif op == b"G" and a:
            colour = (a[0],) * 3
        elif op == b"K" and len(a) == 4:
            colour = tuple(1 - min(1, c + a[3]) for c in a[:3])
        elif op == b"m" and len(a) == 2:
            current = _apply(ctm, *a)
        elif op == b"l" and len(a) == 2 and current is not None:
            nxt = _apply(ctm, *a)
            path.append((*current, *nxt))
            current = nxt
        elif op == b"c":
            curved = True
            if len(a) == 6:
                current = _apply(ctm, a[4], a[5])
        elif op == b"re" and len(a) == 4:
            x, y, w, h = a
            pts = [_apply(ctm, x, y), _apply(ctm, x + w, y), _apply(ctm, x + w, y + h), _apply(ctm, x, y + h)]
            path += [(*pts[i], *pts[(i + 1) % 4]) for i in range(4)]
        elif op in (b"S", b"s", b"B", b"B*", b"b", b"b*"):
            scale = (abs(ctm[0]) + abs(ctm[3])) / 2 or 1
            if not curved and max(colour) <= DARK:
                for x1, y1, x2, y2 in path:
                    if abs(x1 - x2) < 0.01 or abs(y1 - y2) < 0.01:
                        out.append((x1, y1, x2, y2, round(width * scale, 2)))
            path, curved, current = [], False, None
        elif op in (b"n", b"f", b"f*", b"F"):
            path, curved, current = [], False, None
    return out


def _merge(segments: list[tuple[float, float, float, float]], tol: float) -> list[tuple[float, float, float, float]]:
    """Merge collinear overlapping/touching axis-aligned segments (coordinates already in metres)."""
    lines = defaultdict(list)
    for x1, y1, x2, y2 in segments:
        if abs(y1 - y2) < tol:   # horizontal
            lines[("h", round((y1 + y2) / 2, 1))].append(tuple(sorted((x1, x2))))
        else:
            lines[("v", round((x1 + x2) / 2, 1))].append(tuple(sorted((y1, y2))))
    out = []
    for (axis, at), spans in lines.items():
        spans.sort()
        merged = [list(spans[0])]
        for lo, hi in spans[1:]:
            if lo <= merged[-1][1] + tol:
                merged[-1][1] = max(merged[-1][1], hi)
            else:
                merged.append([lo, hi])
        for lo, hi in merged:
            if hi - lo >= MIN_WALL_M:
                out.append((lo, at, hi, at) if axis == "h" else (at, lo, at, hi))
    return out


def read_floor(segs, width_m: float) -> dict | None:
    """One page's walls in metres from the south-west corner, or None when no footprint outline is found."""
    if len(segs) < 4 or not width_m:
        return None
    thickest = max(s[4] for s in segs)
    outline = [s for s in segs if s[4] >= thickest - 0.05]
    # the outline is long; short thick lines (a legend sample "external wall", a north arrow) are not part of it
    longest = max(abs(s[2] - s[0]) + abs(s[3] - s[1]) for s in outline)
    outline = [s for s in outline if abs(s[2] - s[0]) + abs(s[3] - s[1]) >= 0.3 * longest]
    x0 = min(min(s[0], s[2]) for s in outline)
    x1 = max(max(s[0], s[2]) for s in outline)
    y0 = min(min(s[1], s[3]) for s in outline)
    y1 = max(max(s[1], s[3]) for s in outline)
    if x1 - x0 < 10 or y1 - y0 < 10:
        return None
    k = width_m / (x1 - x0)
    tol_pt = 0.15 / k
    inside = [s for s in segs if s[4] < thickest - 0.05
              and min(s[0], s[2]) >= x0 - tol_pt and max(s[0], s[2]) <= x1 + tol_pt
              and min(s[1], s[3]) >= y0 - tol_pt and max(s[1], s[3]) <= y1 + tol_pt]
    length = defaultdict(float)
    for s in inside:
        length[s[4]] += abs(s[2] - s[0]) + abs(s[3] - s[1])
    if not length:
        return {"depth_m": round((y1 - y0) * k, 2), "walls": []}
    wall_width = max(length, key=length.get)
    metres = [((s[0] - x0) * k, (s[1] - y0) * k, (s[2] - x0) * k, (s[3] - y0) * k) for s in inside
              if abs(s[4] - wall_width) <= 0.05]
    walls = []
    for x1m, y1m, x2m, y2m in _merge(metres, 0.15):
        on_edge = (abs(x1m - x2m) < 0.05 and (x1m < 0.15 or x1m > width_m - 0.15)) or \
                  (abs(y1m - y2m) < 0.05 and (y1m < 0.15 or y1m > (y1 - y0) * k - 0.15))
        if not on_edge:
            walls.append({"x1": round(x1m, 2), "y1": round(y1m, 2), "x2": round(x2m, 2), "y2": round(y2m, 2), "type": "internal"})
    return {"depth_m": round((y1 - y0) * k, 2), "walls": walls}


def read_plan(pdf, width_m: float) -> list[dict | None]:
    """Walls per page (None for pages without vector geometry). `pdf` is a path or the file's bytes."""
    import io
    reader = PdfReader(io.BytesIO(pdf) if isinstance(pdf, (bytes, bytearray)) else pdf)
    out = []
    for page in reader.pages:
        try:
            out.append(read_floor(page_segments(reader, page), width_m))
        except Exception:  # noqa: BLE001 - unusual content streams fall back to the model's estimate
            out.append(None)
    return out


def apply_vector_walls(raw: dict, pdfs: list[tuple[str, bytes]]) -> int:
    """Replace P6's estimated walls with the drawn vector walls, page by page (plan sheets in floor order).
    Returns the number of floors updated."""
    width = (raw.get("footprint") or {}).get("width_m")
    floors = raw.get("floors") or []
    pages = [p for _, data in pdfs for p in read_plan(data, width)] if width else []
    pages = [p for p in pages if p is not None]
    if not floors or len(pages) != len(floors):
        return 0
    for floor, page in zip(floors, pages):
        floor["walls"] = page["walls"]
    # the model's remarks about estimating wall positions no longer apply
    raw["notes"] = [n for n in raw.get("notes") or []
                    if not any(w in n.lower() for w in ("estimated", "not listed", "scaled", "approximate wall"))]
    return len(floors)
