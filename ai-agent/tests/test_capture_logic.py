"""Pure logic of the capture pipeline: asset keys, cluster keys, severity matrix, correlation scoring, categories."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.capture.assets import cluster_key, normalize_asset_key, text_similarity  # noqa: E402
from app.capture.correlation import CONFIG, decide, link_type_for, rank_candidates, score_candidate  # noqa: E402
from app.capture.pipeline import apply_category_decisions  # noqa: E402
from app.capture.schemas import ValidationResult  # noqa: E402
from app.capture.severity import apply_llm_adjustment, rule_severity  # noqa: E402
from app.capture.steps import enforce_required_fields  # noqa: E402
from app.capture.taxonomy import seed_taxonomy  # noqa: E402

REGISTER = [{"id": "LIFT-2", "description": "Goods hoist"}, {"id": "EX-02", "description": "Excavator"}]


def test_asset_keys_share_one_key_when_the_register_knows_the_asset():
    for spoken in ("LIFT-2", "lift-2", "eq:LIFT-2"):
        assert normalize_asset_key(spoken, None, REGISTER) == "eq:LIFT-2"
    assert normalize_asset_key("digger", "ex-02", REGISTER) == "eq:EX-02"


def test_unregistered_assets_fall_back_to_a_slug_with_synonyms_folded():
    assert normalize_asset_key("goods lift") == "lift:goods"
    assert normalize_asset_key("the Goods Hoist") == "lift:goods"
    assert normalize_asset_key("lift 2") == "lift:2"
    assert normalize_asset_key("Hoist L2") == "lift:2"
    assert normalize_asset_key("hoist") == "lift"
    assert normalize_asset_key() is None


def test_cluster_keys():
    assert cluster_key("equipment", {"asset_key": "eq:LIFT-2"}, ["asset_key"]) == "equipment:eq:LIFT-2"
    assert cluster_key("safety", {"zone": "Zone B", "event_type": "near_miss"}, ["zone", "event_type"]) == "safety:b:near_miss"
    assert cluster_key("equipment", {"zone": "B", "event_type": "equipment_failure"}, ["asset_key"]) == "equipment:b:equipment_failure"
    assert cluster_key("weather", {}, ["site"]) == "weather:site"
    assert cluster_key("delivery", {"material": "Rebar 12mm"}, ["material"]) == "delivery:rebar-12mm"


def test_text_similarity():
    assert text_similarity("The lift is not working", "lift not working again") > 0.3
    assert text_similarity("crane fault", "poured concrete slab") == 0


def test_severity_matrix():
    base = {"base": "medium", "category": "equipment"}
    assert rule_severity(**base)["level"] == "medium"
    assert rule_severity(base="low", category="safety", injured_count=1)["floor"] == "high"
    assert rule_severity(base="low", category="safety", flags=["hospitalisation"])["level"] == "critical"
    assert rule_severity(base="low", category="environmental", flags=["spill_to_drain"])["level"] == "high"
    assert rule_severity(base="low", category="safety", flags=["occupied_zone"])["level"] == "medium"
    assert rule_severity(**base, reporter_count=3)["level"] == "high"
    assert rule_severity(base="low", category="equipment", reporter_count=3)["level"] == "medium"
    many = rule_severity(base="low", category="equipment", reporter_count=5, workers_affected=12, successors_at_risk=2,
                         flags=["sole_access"], open_hours=99)
    assert many["level"] == "high" and len(many["escalators"]) == 5
    assert rule_severity(**base, flags=["fatality"], reporter_count=9)["level"] == "critical"


def test_llm_adjustment_is_clamped_and_respects_the_floor_and_the_high_cap():
    rule = rule_severity(base="medium", category="equipment")
    assert apply_llm_adjustment(rule, 5)["level"] == "high"
    assert apply_llm_adjustment(rule, -5)["level"] == "low"
    assert apply_llm_adjustment(rule, "garbage")["level"] == "medium"
    floored = rule_severity(base="low", category="safety", injured_count=2)
    assert apply_llm_adjustment(floored, -1)["level"] == "high"
    assert apply_llm_adjustment(rule_severity(base="medium", category="equipment", reporter_count=3), 1)["level"] == "high"
    assert apply_llm_adjustment(rule_severity(base="low", category="safety", flags=["fatality"]), 1)["level"] == "critical"


T = "2026-11-10T10:00:00+00:00"


def incident(**o):
    return {"id": "i1", "category": "equipment", "event_type": "equipment_failure", "summary": "Lift not working", "zone": "A",
            "asset_key": "eq:LIFT-2", "activity_code": None, "cluster_key": "equipment:eq:LIFT-2", "status": "open",
            "last_reported_at": T, **o}


def event(**o):
    return {"category": "equipment", "event_type": "equipment_failure", "summary": "the lift is broken again", "zone": "A",
            "asset_key": "eq:LIFT-2", "activity_code": None, "cluster_key": "equipment:eq:LIFT-2", "occurred_at": T, **o}


def test_weights_sum_to_one():
    assert abs(sum(CONFIG["weights"].values()) - 1) < 1e-9


def test_same_asset_type_zone_time_auto_links():
    ranked = rank_candidates(event(), [incident()], 24)
    assert ranked[0]["score"] >= 0.8 and decide(ranked)["action"] == "link"


def test_same_asset_but_different_zone_and_later_needs_the_adjudicator():
    ranked = rank_candidates(event(zone="C", occurred_at="2026-11-10T22:00:00+00:00"), [incident()], 24)
    assert decide(ranked)["action"] == "adjudicate"


def test_a_different_asset_is_not_auto_linked():
    ranked = rank_candidates(event(asset_key="eq:CRANE-1", summary="tower crane fault"), [incident()], 24)
    assert decide(ranked)["action"] != "link"


def test_unrelated_incidents_are_not_candidates():
    ranked = rank_candidates(event(zone="Z", asset_key=None, summary="hose burst"),
                             [incident(zone="A", asset_key=None, summary="late rebar")], 24)
    assert ranked == [] and decide(ranked)["action"] == "new"


def test_time_proximity_decays_across_the_window():
    near = score_candidate(event(), incident(), 24)["signals"]["time"]
    far = score_candidate(event(occurred_at="2026-11-11T08:00:00+00:00"), incident(), 24)["signals"]["time"]
    assert near > far > 0
    assert score_candidate(event(occurred_at="2026-11-13T10:00:00+00:00"), incident(), 24)["signals"]["time"] == 0


def test_status_updates_map_to_resolution_or_update():
    assert link_type_for("repair_release") == "resolution" and link_type_for("issue_resolved") == "resolution"
    assert link_type_for("repair_forecast") == "update"


def test_category_decisions_keep_suggestions_drop_rejections_and_add_missed_events():
    tx = seed_taxonomy()
    events = [{"summary": "a", "suggested_category": "equipment", "suggested_event_type": "equipment_failure"},
              {"summary": "b", "suggested_category": "equipment", "suggested_event_type": "equipment_failure"},
              {"summary": "c", "suggested_category": "progress", "suggested_event_type": "production"}]
    out = apply_category_decisions(events, {"events": [{"index": 1, "keep": False}, {"index": 2, "category": "weather", "event_type": "weather_stop"}],
                                           "added": [{"summary": "  oil on the floor ", "category": "environmental", "event_type": "spill"},
                                                     {"summary": "   "}]}, tx)
    assert [(e["summary"], e["category"], e["event_type"]) for e in out] == [
        ("a", "equipment", "equipment_failure"), ("c", "weather", "weather_stop"), ("oil on the floor", "environmental", "spill")]
    assert out[0]["user_changed"] is False and out[1]["user_changed"] is True
    # an event type that does not belong to the chosen category is corrected, an unknown category falls back safely
    assert tx.normalise("equipment", "spill") == ("equipment", "equipment_failure")
    assert tx.normalise("nonsense", "spill") == ("environmental", "spill")


def test_required_fields_are_enforced_unless_the_event_already_has_them():
    rules = [{"rule_key": "r", "event_type": "equipment_failure", "required_fields": ["workers_affected", "zone"], "ask_if_missing": True}]
    events = [{"event_type": "equipment_failure", "summary": "Lift down", "zone": "A", "workers_affected": None}]
    result = enforce_required_fields(ValidationResult(), events, rules, [])
    assert [q.field_name for q in result.questions] == ["workers_affected"]
    assert enforce_required_fields(ValidationResult(), events, rules,
                                   [{"event_index": 0, "field_name": "workers_affected"}]).questions == []
