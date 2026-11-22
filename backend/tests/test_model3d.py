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


def _plan_mapped_spec(**pour_overrides):
    """A small building whose pours carry programme codes: one foundation level split between two activities,
    walls in an untracked pour (the mapping used to put a model on the performance plan's codes)."""
    return {
        "grid": {"x": [{"name": "X1", "at": 0}, {"name": "X2", "at": 4000}, {"name": "X3", "at": 12000}],
                 "y": [{"name": "Y1", "at": 0}, {"name": "Y2", "at": 9000}]},
        "levels": [{"name": "FND", "kind": "raft", "tos": -300, "thickness": 500, "activity": "FND-A"},
                   {"name": "GF", "kind": "slab", "tos": 0, "thickness": 200, "activity": "SLAB"},
                   {"name": "L1", "kind": "slab", "tos": 3000, "thickness": 200, "activity": "POUR-L1"}],
        "walls": [{"mark": "W", "thickness": 250, "from": "X1Y1", "to": "X3Y1", "storeys": ["L1"]}],
        "activities": [{"code": c, "name": c, "start": "2026-11-02", "finish": "2026-11-14", "m3": m}
                       for c, m in (("FND-A", 50), ("FND-B", 90), ("SLAB", 40), ("POUR-L1", 50))]
                      + [{"code": "WALLS", "name": "Walls", "tracked": False}],
        "pours": [{"id": "FND-A-P", "activity": "FND-A", "kind": "slab", "level": "FND", "x_from": "X1", "x_to": "X2",
                   "m3": 50, "planned": "2026-11-09"},
                  {"id": "FND-B-P", "activity": "FND-B", "kind": "slab", "level": "FND", "x_from": "X2", "x_to": "X3",
                   "m3": 90, "planned": "2026-11-14", **pour_overrides},
                  {"id": "SLAB-P", "activity": "SLAB", "kind": "slab", "m3": 40, "planned": "2026-11-10"},
                  {"id": "POUR-L1-P", "activity": "POUR-L1", "kind": "slab", "m3": 50, "planned": "2026-11-13"},
                  {"id": "WALLS-GF", "activity": "WALLS", "kind": "vertical", "level": "L1", "m3": 6}],
    }


def test_a_pour_naming_a_level_splits_it_between_activities_and_keeps_walls_apart():
    from model3d.spec import untracked
    spec, reasons = validate(_plan_mapped_spec())
    assert not blocking(reasons)
    g = generator.generate(spec)
    by_pour = {}
    for e in g["elements"]:
        by_pour.setdefault(e["pour"], []).append(e)
    a, b = by_pour["FND-A-P"][0], by_pour["FND-B-P"][0]
    assert (a["activity"], b["activity"]) == ("FND-A", "FND-B")       # elements carry their pour's activity
    assert a["box"][3] == 4.0 and b["box"][0] == 4.0                    # the raft is split at grid X2
    assert {e["activity"] for e in by_pour["WALLS-GF"]} == {"WALLS"} and by_pour["WALLS-GF"][0]["kind"] == "wall"
    assert [e["kind"] for e in by_pour["POUR-L1-P"]] == ["slab"]        # the L1 slab stays with its level activity
    assert [p["id"] for p in g["pours"]][:2] == ["FND-A-P", "FND-B-P"]  # FND-B is ordered with its level
    assert untracked(spec) == {"WALLS"}
    obs = [{"activity": "FND-A", "date": "2026-11-09", "qty": 50, "basis": "signed", "ref": "R9:1"},
           {"activity": "FND-B", "date": "2026-11-12", "qty": 20, "basis": "signed", "ref": "R12:1"}]
    tracked = [p for p in g["pours"] if p["activity"] not in untracked(spec)]
    st = progress.pour_states(tracked, {"observations": obs, "events": []}, D("2026-11-22"))
    assert st["FND-A-P"]["status"] == "built" and st["FND-B-P"]["pct"] == 22.2 and "WALLS-GF" not in st


def test_a_pour_naming_an_unknown_level_blocks():
    _, reasons = validate(_plan_mapped_spec(level="B9"))
    assert any(r["subject"] == "pour FND-B-P" and "B9" in r["message"] for r in blocking(reasons))


def test_shared_performance_forecast_replaces_the_model_forecast_for_its_activities():
    spec, _ = validate(_plan_mapped_spec())
    g = generator.generate(spec)
    from model3d.spec import untracked
    pours = [p for p in g["pours"] if p["activity"] not in untracked(spec)]
    obs = [{"activity": "FND-A", "date": "2026-11-09", "qty": 50, "basis": "signed", "ref": "R9:1"}]
    inputs = {"observations": obs, "events": [], "remarks": []}
    today = D("2026-11-22")
    own = progress.compute(spec, pours, inputs, today, D("2026-12-31"))
    shared = {"POUR-L1": {"start": D("2026-11-20"), "finish": D("2026-11-30")},
              "FND-A": {"start": D("2026-11-08"), "finish": D("2026-11-09")}}   # built: keeps its actual date
    r = progress.compute(spec, pours, inputs, today, D("2026-12-31"), shared=shared)
    assert own["forecast_source"] == "model" and r["forecast_source"] == "mixed"
    assert r["forecast"]["POUR-L1-P"]["date"] == "2026-11-30" and r["forecast"]["POUR-L1-P"]["source"] == "performance"
    assert r["forecast"]["FND-A-P"] == own["forecast"]["FND-A-P"]                 # built pours are not re-forecast
    assert r["forecast"]["FND-B-P"] == own["forecast"]["FND-B-P"]                 # not in the shared forecast
    t = progress.timeline(spec, pours, inputs, today, D("2026-12-31"), shared=shared)
    assert t["forecast_windows"]["POUR-L1-P"] == ["2026-11-23", "2026-11-30"]   # remaining work starts tomorrow


def test_tasks_drive_a_structure_activity_by_their_average_completion():
    from model3d import tasks
    s = _plan_mapped_spec()
    s["activities"] = [a for a in s["activities"] if a["code"] != "POUR-L1"] + [
        {"code": "POUR-L1", "name": "Level 1", "start": "2026-12-01", "finish": "2026-12-20", "tasks": ["FORM-L1", "POUR-L1-T", "NO-PLAN"]}]
    s["pours"] = [p for p in s["pours"] if p["id"] != "POUR-L1-P"] + [
        {"id": "L1-V", "activity": "POUR-L1", "kind": "vertical", "m3": 30, "planned": "2026-12-10"},
        {"id": "L1-S", "activity": "POUR-L1", "kind": "slab", "m3": 70, "planned": "2026-12-20"}]
    spec, reasons = validate(s)
    assert not blocking(reasons) and tasks.drivers(spec) == {"POUR-L1": ["FORM-L1", "POUR-L1-T", "NO-PLAN"]}
    pours = generator.generate(spec)["pours"]
    ti = {"targets": {"FORM-L1": {"2026-11-02": 60, "2026-11-03": 60}, "POUR-L1-T": {"2026-11-13": 50}},
          "observations": [{"task": "FORM-L1", "date": "2026-11-02", "qty": 60, "basis": "signed", "ref": "R2:form"},
                           {"task": "FORM-L1", "date": "2026-11-03", "qty": 80, "basis": "signed", "ref": "R3:form"}],
          "names": {}}
    obs = tasks.observations(spec, pours, ti)
    # formwork 100% (capped), pour 0%, NO-PLAN ignored: Level 1 is 50% of its 100 m3, cited by the real reports
    assert round(sum(o["qty"] for o in obs), 6) == 50 and {o["ref"] for o in obs} == {"R2:form", "R3:form"}
    plan_spec, plan_pours = tasks.plan(spec, pours, ti)
    act = next(a for a in plan_spec["activities"] if a["code"] == "POUR-L1")
    assert (act["start"], act["finish"]) == ("2026-11-02", "2026-11-13")
    # planned average reaches 30% (end of the vertical pour) on 3 Nov (formwork done = 50%), 100% on 13 Nov
    assert {p["id"]: p["planned"] for p in plan_pours if p["activity"] == "POUR-L1"} == {"L1-V": "2026-11-03", "L1-S": "2026-11-13"}
    st = progress.pour_states([p for p in plan_pours if p["activity"] == "POUR-L1"],
                              {"observations": obs, "events": []}, D("2026-11-22"))
    assert st["L1-V"]["status"] == "built" and st["L1-S"]["pct"] == round(100 * 20 / 70, 1)
    rows = {r["code"]: r for r in tasks.summary(spec, ti, D("2026-11-22"))["POUR-L1"]}
    assert rows["FORM-L1"]["pct_done"] == 100 and rows["POUR-L1-T"]["pct_done"] == 0 and rows["NO-PLAN"]["note"]
