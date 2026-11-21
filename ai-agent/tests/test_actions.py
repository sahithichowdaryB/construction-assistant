import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.actions import ActionContext, apply_guardrails, plan_actions  # noqa: E402
from app.llm import FakeLLM  # noqa: E402

NOW = datetime(2026, 11, 10, 10, 0, tzinfo=timezone.utc)
CONTRACTORS = [{"id": "C1", "name": "Lift Co", "trade": "lifts", "contact_role": "plant_contractor",
                "owns_equipment": ["LIFT-2"], "runs_activities": []}]


def ctx(category="equipment", status="probable", gaps=None, severity="medium", **kw):
    analysis = {"id": "00000000-0000-0000-0000-000000000001", "status": status, "gaps": gaps or [],
                "factual_evidence": [{"source_id": "V1", "locator": "transcript", "quote": "x"}]}
    return ActionContext(incident={"id": "inc1", "category": category, "severity": severity, "summary": "Lift down"},
                         analysis=analysis, playbook={"owner_roles": ["site_manager", "safety_officer"]},
                         contractors=CONTRACTORS, **kw)


def action(**kw):
    return {"action_type": "notify_contractor", "title": "Call Lift Co", "rationale": "r", "owner_role": "site_manager",
            "contractor_id": "C1", "due_in_hours": 4, "priority": "high",
            "evidence_refs": [{"source_id": "V1", "locator": "transcript"}], **kw}


def test_valid_action_passes_through():
    kept, dropped = apply_guardrails([action()], ctx())
    assert [a.title for a in kept] == ["Call Lift Co"] and dropped == []


def test_undetermined_cause_puts_request_evidence_first_with_the_gaps():
    kept, dropped = apply_guardrails([action()], ctx(status="undetermined", gaps=["Who saw the fault first?"]))
    assert kept[0].action_type == "request_evidence"
    assert "Who saw the fault first?" in kept[0].rationale
    assert kept[1].action_type == "notify_contractor"
    assert any("request_evidence" in d for d in dropped)


def test_model_supplied_request_evidence_is_moved_to_the_front():
    ev = action(action_type="request_evidence", title="Ask the foreman", contractor_id=None)
    kept, _ = apply_guardrails([action(), ev], ctx(status="needs_review"))
    assert [a.title for a in kept][:2] == ["Ask the foreman", "Call Lift Co"]


def test_no_analysis_yet_is_treated_as_unknown_cause():
    c = ctx()
    c.analysis = None
    kept, _ = apply_guardrails([], c)
    assert kept[0].action_type == "request_evidence"


def test_unknown_owner_or_contractor_is_rejected():
    kept, dropped = apply_guardrails([action(contractor_id="NOPE"), action(title="B", owner_role="wizard")], ctx())
    assert kept == [] and len(dropped) == 2


def test_evidence_refs_must_be_cited_in_the_analysis():
    kept, dropped = apply_guardrails([action(evidence_refs=[{"source_id": "V1", "locator": "transcript"},
                                                            {"source_id": "V9", "locator": "seg:1"}])], ctx())
    assert kept[0].evidence_refs == [{"source_id": "V1", "locator": "transcript"}]
    assert any("evidence refs" in d for d in dropped)


def test_safety_incident_always_gets_an_isolate_or_stop_work_review():
    kept, _ = apply_guardrails([action(action_type="assign_owner", title="Assign owner", contractor_id=None)],
                               ctx(category="safety"))
    assert any(a.action_type in ("isolate_area", "stop_work") for a in kept)
    kept, _ = apply_guardrails([action(action_type="stop_work", title="Stop work", contractor_id=None)], ctx(category="safety"))
    assert sum(a.action_type in ("isolate_area", "stop_work") for a in kept) == 1


def test_duplicates_of_open_actions_and_malformed_items_are_dropped_and_priority_defaults_from_severity():
    c = ctx(severity="critical", open_actions=[{"action_type": "notify_contractor", "title": "Call Lift Co", "status": "approved"}])
    kept, dropped = apply_guardrails([action(), {"action_type": "fly_to_moon", "title": "x"},
                                      action(title="Book repair", action_type="schedule_repair", priority=None)], c)
    assert [a.title for a in kept] == ["Book repair"] and kept[0].priority == "urgent"
    assert len(dropped) == 2


def test_plan_actions_uses_the_llm_and_records_the_analysis():
    llm = FakeLLM({"actions": [action()]})
    plan = plan_actions(ctx(), llm, NOW)
    assert plan.analysis_id and plan.actions[0].contractor_id == "C1" and plan.model == "fake"
    assert "untrusted" in llm.calls[0][0]
