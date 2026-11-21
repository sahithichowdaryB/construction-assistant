"""Pure tests for the 3D progress model (model3d/): spec validation, generator, progress engine, P5 mapping.
No database, no model call."""

import sys
from datetime import date
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from model3d import generator, progress  # noqa: E402
from model3d.prompts import P5_SCHEMA, extract_spec, to_spec  # noqa: E402
from model3d.seed_demo import REPORTS  # noqa: E402
from model3d.spec import Calendar, Grid, blocking, riverside_spec, validate  # noqa: E402
from performance.prompts import FakeModels  # noqa: E402

D = date.fromisoformat

# Plan_3 S301 §2: net concrete per activity (m3)
DRAWING_NET = {"A300": 1791.7, "A310": 624.4, "A410": 429.7, "A420": 429.7, "A430": 429.7, "A440": 429.7, "A450": 448.7}


@pytest.fixture(scope="module")
def spec():
    s, reasons = validate(riverside_spec())
    assert not blocking(reasons)
    return s


@pytest.fixture(scope="module")
def built(spec):
    return generator.generate(spec)


def demo_inputs(upto=None, extra=()):
    obs = [{"activity": code, "date": day, "qty": m3, "basis": "signed", "ref": f"R3D-{day.replace('-', '')}:{code}"}
           for day, code, _, m3, _ in REPORTS if upto is None or D(day) <= upto]
    return {"timezone": "Europe/Berlin", "observations": obs + list(extra), "events": [], "remarks": []}


# ------------------------------------------------------------------ spec and validation

def test_reference_spec_only_warns_about_the_christmas_pour():
    _, reasons = validate(riverside_spec())
    assert [r["subject"] for r in reasons] == ["pour A420-V"]
    assert "Fri 25 Dec 2026" in reasons[0]["message"] and reasons[0]["severity"] == "warning"


def test_grid_points_and_dimensions():
    g = Grid(riverside_spec()["grid"])
    assert g.point("2B") == (7200, 8000)
    assert g.point("B2") == (7200, 8000)
    assert g.point("7D") == (43200, 24000)
    assert g.point("9Z") is None
    assert g.coord_x("4") == 21600 and g.coord_x(21000) == 21000 and g.coord_x("21000") == 21000


@pytest.mark.parametrize("mutate, subject", [
    (lambda s: s["levels"].reverse(), "level"),
    (lambda s: s["columns"][0]["at"].append("9Z"), "column BC"),
    (lambda s: s["walls"].append({"mark": "X", "thickness": 200, "from": "1A", "to": "2B", "storeys": ["L1"]}), "wall X"),
    (lambda s: s["pours"].append(dict(s["pours"][0])), "pour A300-P1"),
    (lambda s: s["columns"][1]["storeys"].append("L9"), "column C1"),
    (lambda s: s["grid"]["x"].reverse(), "grid.x"),
])
def test_validation_blocks_broken_specs(mutate, subject):
    s = riverside_spec()
    mutate(s)
    _, reasons = validate(s)
    assert any(r["severity"] == "blocking" and r["subject"].startswith(subject) for r in reasons), reasons


def test_validation_warns_when_pours_do_not_add_up():
    s = riverside_spec()
    s["pours"] = [p for p in s["pours"] if p["id"] != "A300-P3"]
    _, reasons = validate(s)
    assert any(r["subject"] == "A300" and "add up" in r["message"] for r in reasons)


def test_unknown_refs_are_dropped():
    s = riverside_spec()
    s["refs"] = {"grid": ["DRW-1:p2", "DRW-1:p99"]}
    clean, reasons = validate(s, {"DRW-1:p2": "7200 7200"})
    assert clean["refs"] == {"grid": ["DRW-1:p2"]}
    assert any("dropped 1 citation" in r["message"] for r in reasons)


# ------------------------------------------------------------------ generator

def test_every_pour_builds_elements_and_every_element_has_a_pour(built):
    pours = {p["id"] for p in built["pours"]}
    assert len(pours) == 23
    assert all(p["has_elements"] for p in built["pours"])
    assert all(e["pour"] in pours for e in built["elements"])
    assert 200 <= len(built["elements"]) <= 400


def test_model_volumes_match_the_drawing_quantities(built):
    for code, net in DRAWING_NET.items():
        assert abs(built["volumes"][code] - net) / net < 0.12, (code, built["volumes"][code], net)


def test_geometry_is_in_metres_and_matches_the_sections(built):
    x0, y0, z0, x1, y1, z1 = built["bounds"]
    assert (x0, z0) == (-0.95, -4.9)          # raft overhang 950, underside -4.90
    assert x1 == pytest.approx(44.15) and y1 == pytest.approx(24.95)
    assert z1 == pytest.approx(18.3)           # lift overrun to +18.30
    raft = [e for e in built["elements"] if e["kind"] == "raft"]
    assert {e["pour"] for e in raft} == {"A300-P1", "A300-P2", "A300-P3"}


def test_slabs_split_at_the_construction_joint(built):
    l1 = [e for e in built["elements"] if e["level"] == "L1" and e["kind"] == "slab"]
    assert {e["pour"]: e["box"][3] for e in l1 if e["pour"] == "A410-SA"} == {"A410-SA": 21.0}
    assert {e["pour"] for e in l1} == {"A410-SA", "A410-SB"}


def test_vertical_elements_stand_in_the_storey_below_their_level(built):
    cols = [e for e in built["elements"] if e["level"] == "L1" and e["kind"] == "column"]
    assert len(cols) == 20 and all(e["pour"] == "A410-V" for e in cols)
    assert all(e["box"][2] == 0.0 and e["box"][5] == 2.9 for e in cols)   # GF top 0.00 to L1 soffit 2.90
    basement = [e for e in built["elements"] if e["level"] == "GF" and e["kind"] == "wall"]
    assert {e["pour"] for e in basement} == {"A310-W1", "A310-W2"}


def test_activity_without_pours_gets_one_synthetic_pour():
    s = riverside_spec()
    s["pours"] = [p for p in s["pours"] if p["activity"] != "A450"]
    s, _ = validate(s)
    g = generator.generate(s)
    roof = [p for p in g["pours"] if p["activity"] == "A450"]
    assert [p["id"] for p in roof] == ["A450-ALL"] and roof[0]["synthetic"] and roof[0]["m3"] == 440


# ------------------------------------------------------------------ progress from the records

def test_signed_quantities_fill_pours_in_schedule_order(built):
    st = progress.pour_states(built["pours"], demo_inputs(), D("2026-11-22"))
    assert [st[p]["status"] for p in ("A300-P1", "A300-P2", "A300-P3")] == ["built"] * 3
    assert st["A300-P3"]["finished"] == "2026-11-06"
    assert st["A310-W1"]["status"] == st["A310-W2"]["status"] == "built"
    assert st["A310-S1"]["status"] == "not_started" and st["A410-V"]["status"] == "not_started"
    assert st["A300-P2"]["refs"] == ["R3D-20261030:A300"]


def test_partial_quantity_gives_in_progress_percentage(built):
    extra = [{"activity": "A410", "date": "2026-12-04", "qty": 92.8 + 82.0, "basis": "signed", "ref": "X:A410"}]
    st = progress.pour_states(built["pours"], demo_inputs(extra=extra), D("2026-12-05"))
    assert st["A410-V"]["status"] == "built"
    assert st["A410-SA"]["status"] == "in_progress" and st["A410-SA"]["pct"] == 50.0
    assert st["A410-SB"]["status"] == "not_started"


def test_records_after_the_date_are_ignored(built):
    st = progress.pour_states(built["pours"], demo_inputs(), D("2026-10-25"))
    assert st["A300-P1"]["status"] == "built" and st["A300-P2"]["status"] == "not_started"


def test_estimates_and_events_never_count_as_signed(built):
    extra = [{"activity": "A310", "date": "2026-11-21", "qty": 100, "basis": "estimated", "ref": "E:A310"}]
    inputs = demo_inputs(extra=extra)
    inputs["events"] = [{"id": "e1", "activity": "A310", "date": "2026-11-21", "type": "production", "category": "progress",
                         "summary": "Pour A310-S2 done early", "attributes": {}, "ref": "V:t1", "equipment": None, "zone": None}]
    st = progress.pour_states(built["pours"], inputs, D("2026-11-22"))
    assert st["A310-S1"]["status"] == "in_progress" and st["A310-S1"]["basis"] == "estimated"
    assert st["A310-S2"]["status"] == "built" and st["A310-S2"]["basis"] == "event"


def test_planned_windows_follow_the_pour_dates(spec, built):
    plan = progress.planned_windows(spec, built["pours"])
    assert plan["A300-P1"] == (D("2026-10-02"), D("2026-10-21"))
    assert plan["A300-P2"] == (D("2026-10-22"), D("2026-10-28"))
    assert progress.window_pct(plan["A300-P2"], D("2026-10-25")) == pytest.approx(57.1)


def test_forecast_carries_the_latest_slip_to_the_deadline(spec, built):
    result = progress.compute(spec, built["pours"], demo_inputs(), D("2026-11-22"), D("2027-03-08"))
    fc = result["forecast"]
    assert fc["A310-W2"] == {"date": "2026-11-20", "slip_wd": 1, "done": True}
    assert fc["A310-S1"]["date"] == "2026-11-25"           # planned 24 Nov + 1 working day
    assert fc["A420-V"]["date"] == "2027-01-05"            # 25 Dec is a holiday: next working day 4 Jan, + 1
    s = result["summary"]
    assert s["forecast_completion"] == "2027-03-09" and s["late_working_days"] == 1 and s["status"] == "late"
    assert s["counts"] == {"built": 5, "in_progress": 0, "not_started": 18}
    assert result["at_deadline"]["A450-PP"]["status"] != "built"


def test_why_lists_late_pours_behind_quantity_and_conflicts(spec, built):
    _, reasons = validate(riverside_spec())
    inputs = demo_inputs()
    inputs["remarks"] = [{"ref": "R3D-20261030:remarks", "date": "2026-10-30", "text": "Pour postponed because of heavy rain"}]
    inputs["events"] = [{"id": "e2", "activity": None, "date": "2026-11-19", "type": "equipment_failure",
                         "category": "equipment", "summary": "Crane stopped", "attributes": {}, "ref": "V:x",
                         "equipment": None, "zone": None}]
    result = progress.compute(spec, built["pours"], inputs, D("2026-11-22"), D("2027-03-08"), reasons)
    kinds = [w["kind"] for w in result["why"]]
    assert {"behind", "late_pour", "disruption", "report_remark", "plan_conflict"} <= set(kinds)
    late = [w for w in result["why"] if w["kind"] == "late_pour"]
    assert any("A300-P3" in w["text"] and "2 working days" in w["text"] for w in late)


def test_on_time_when_everything_is_poured_as_planned(spec, built):
    obs = [{"activity": p["activity"], "date": p["planned"], "qty": p["m3"], "basis": "signed", "ref": f"X:{p['id']}"}
           for p in built["pours"] if p["planned"] <= "2026-11-20"]
    result = progress.compute(spec, built["pours"], {"observations": obs, "events": [], "remarks": []},
                              D("2026-11-20"), D("2027-03-08"))
    assert result["summary"]["late_working_days"] <= 0 and result["summary"]["status"] == "on_time"


def test_timeline_has_steps_and_windows(spec, built):
    tl = progress.timeline(spec, built["pours"], demo_inputs(), D("2026-11-22"), D("2027-03-08"))
    assert tl["start"] == "2026-10-02" and tl["end"] == "2027-03-09"
    assert [s["date"] for s in tl["steps"]] == [r[0] for r in REPORTS]
    assert tl["steps"][0]["pours"] == {"A300-P1": ["built", 100.0, "signed"]}
    today = next(p for p in tl["points"] if p["date"] == "2026-11-22")
    # raft reports say 1800 m3 (with waste); its pours are 1791.8 m3, so the lines meet at 1791.8 + 194.2
    assert today["actual"] == pytest.approx(1986.0) and today["forecast"] == pytest.approx(1986.0)
    assert tl["points"][-1]["forecast"] == pytest.approx(tl["total_m3"], rel=0.001)


def test_calendar_counts_working_days():
    cal = Calendar.from_spec(riverside_spec())
    assert cal.between(D("2026-12-24"), D("2027-01-04")) == 1
    assert cal.add_working_days(D("2026-11-20"), 1) == D("2026-11-23")


# ------------------------------------------------------------------ P5 mapping (fake model)

def test_p5_answer_maps_onto_a_valid_spec():
    raw = {
        "title": "GA", "grid": {"x": [{"name": "1", "at_mm": 0}, {"name": "2", "at_mm": 6000}],
                                "y": [{"name": "A", "at_mm": 0}, {"name": "B", "at_mm": 5000}], "refs": ["DRW-1:p2"]},
        "raft_overhang_mm": None,
        "levels": [{"name": "GF", "tos_mm": 0, "thickness_mm": 300, "activity": "S1", "kind": "slab", "refs": []},
                   {"name": "L1", "tos_mm": 3000, "thickness_mm": 250, "activity": "S2", "kind": "roof", "refs": []}],
        "columns": [{"mark": "C", "width_mm": 300, "depth_mm": 300, "at": ["1A", "2B"], "storeys": ["L1"], "refs": []}],
        "walls": [], "balconies": {"levels": [], "depth_mm": None, "thickness_mm": None, "width_mm": None, "refs": []},
        "parapet": {"height_mm": None, "thickness_mm": None, "refs": []}, "cores": [],
        "pours": [{"id": "S2-1", "activity": "S2", "kind": "slab", "x_from": "", "x_to": "", "m3": 7.5,
                   "planned": "2027-01-11", "refs": ["DRW-1:p7"]}],
        "activities": [{"code": "S1", "name": "Ground slab", "start": "2027-01-04", "finish": "2027-01-08", "m3": 9, "refs": []},
                       {"code": "S2", "name": "First floor", "start": "2027-01-11", "finish": "2027-01-15", "m3": 7.5, "refs": []}],
        "calendar": {"working_weekdays": [], "holidays": [], "refs": []},
        "deadline_hint": {"date": "", "label": "", "refs": []}, "missing": ["no pour schedule for S1"],
    }
    part1 = {k: raw[k] for k in ("title", "grid", "raft_overhang_mm", "levels", "activities", "calendar", "deadline_hint", "missing")}
    part2 = {k: raw[k] for k in ("columns", "walls", "balconies", "parapet", "cores")} | {"missing": []}
    part3 = {"pours": raw["pours"], "missing": []}
    fake = FakeModels(part1, part2, part3)
    spec, model = extract_spec([{"source_id": "DRW-1", "locator": "p2", "excerpt": "grid", "page": 2}], [], fake)
    assert model == "fake" and len(fake.calls) == 3
    assert spec["missing"] == ["no pour schedule for S1"]
    spec, reasons = validate(spec, {"DRW-1:p2": "x", "DRW-1:p7": "y"})
    assert not blocking(reasons)
    g = generator.generate(spec)
    assert {p["id"] for p in g["pours"]} == {"S2-1", "S1-ALL"}
    assert len([e for e in g["elements"] if e["kind"] == "column"]) == 2
    assert to_spec(raw)["refs"]["pours.S2-1"] == ["DRW-1:p7"]


# ------------------------------------------------------------------ architectural floor plans (P6 + vector walls)

HOUSE = Path(__file__).resolve().parents[2] / "data" / "riverside-demo" / "uploads" / "drawings" / "house_floor_plan.pdf"


def test_vector_walls_are_read_exactly_from_the_house_plan():
    from model3d.vector import read_plan
    gf, ff = read_plan(str(HOUSE), 12.0)
    assert gf["depth_m"] == ff["depth_m"] == 9.0
    as_set = lambda f: {(w["x1"], w["y1"], w["x2"], w["y2"]) for w in f["walls"]}  # noqa: E731
    assert as_set(gf) == {(4.0, 0.0, 4.0, 4.0), (0.0, 4.0, 6.0, 4.0), (6.0, 0.0, 6.0, 9.0), (10.0, 0.0, 10.0, 9.0),
                          (6.0, 5.0, 12.0, 5.0), (10.0, 2.0, 12.0, 2.0)}
    assert as_set(ff) == {(4.0, 0.0, 4.0, 5.0), (0.0, 5.0, 12.0, 5.0), (6.0, 0.0, 6.0, 9.0), (9.0, 0.0, 9.0, 5.0),
                          (8.0, 5.0, 8.0, 9.0), (10.0, 5.0, 10.0, 9.0)}


def test_architectural_plan_becomes_a_valid_spec_with_assumptions():
    from model3d.arch import build_spec
    from model3d.vector import apply_vector_walls
    raw = {"title": "House", "footprint": {"width_m": 12.0, "depth_m": 9.0, "refs": ["D:p1"]},
           "floors": [{"name": "Ground floor", "walls": [], "refs": []}, {"name": "First floor", "walls": [], "refs": []}],
           "notes": ["Wall positions estimated"]}
    assert apply_vector_walls(raw, [("D", HOUSE.read_bytes())]) == 2
    spec, notes = build_spec(raw, prefix="B2", start=D("2026-11-02"), deadline=D("2026-12-31"), exact_walls=True)
    spec, reasons = validate(spec, {"D:p1": "Footprint 12.0 x 9.0 m"})
    assert not blocking(notes + reasons)
    assert [lv["name"] for lv in spec["levels"]] == ["GF", "L1", "Roof"] and spec["levels"][-1]["tos"] == 6000
    assert any("assumed storey height" in n["message"] for n in notes)
    assert any("exact to the drawing" in n["message"] for n in notes)
    g = generator.generate(spec)
    assert {p["id"] for p in g["pours"]} == {"B2-GF-S", "B2-L1-V", "B2-L1-S", "B2-ROOF-V", "B2-ROOF-S"}
    assert all(p["has_elements"] and p["m3"] > 0 for p in g["pours"])
    assert spec["activities"][0]["start"] == "2026-11-02" and spec["activities"][-1]["finish"] == "2026-12-30"
    walls_gf = [e for e in g["elements"] if e["level"] == "L1" and e["kind"] == "wall"]
    assert len(walls_gf) == 10                                  # 4 external + 6 internal on the ground floor


def test_unreadable_footprint_blocks():
    from model3d.arch import build_spec
    _, notes = build_spec({"footprint": {"width_m": None, "depth_m": None}, "floors": []}, prefix="B9",
                          start=D("2026-11-02"), deadline=D("2026-12-31"))
    assert blocking(notes)


def test_structural_failure_detects_missing_grid_and_levels():
    from model3d.prompts import is_structural_failure
    _, reasons = validate({"title": "x", "grid": {"x": [], "y": []}, "levels": []})
    assert is_structural_failure(reasons)
    _, reasons = validate(riverside_spec())
    assert not is_structural_failure(reasons)


def test_p5_schema_is_strict():
    def walk(node):
        if isinstance(node, dict):
            if node.get("type") == "object":
                assert node["additionalProperties"] is False and set(node["required"]) == set(node["properties"])
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)
    walk(P5_SCHEMA)
