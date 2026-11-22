"""Pure tests for performance/daily_report.py: no database, no model."""

import sys
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from performance import daily_report as dr  # noqa: E402

UTC = timezone.utc
PROJECT = {"name": "Riverside <Block A>", "timezone": "Europe/Berlin"}
MEMBER = {"display_name": "Mara", "role": "manager"}
NOW = datetime(2026, 11, 11, 7, 0, tzinfo=UTC)


def activity(code, status, **kw):
    return {"code": code, "name": f"Activity {code}", "unit": "m3", "planned": 100.0, "actual": 70.0, "basis": "signed",
            "variance": -30.0, "variance_pct": -30.0, "status": status, "severity": "red", "escalated": False,
            "days_late": None, "estimate": None, "attribution": {"cause_category": "equipment_breakdown"}, "refs": []} | kw


def view(**kw):
    summary = {"status": "ok", "headline": {"text": "Pour fell 30 % short.", "refs": ["R10:p1"]},
               "disruptions": [{"text": "Pump hose burst at 09:15.", "refs": ["R10:p2"], "activity_code": "A1"}],
               "open_items": [{"text": "Repair pump", "refs": ["R10:p3"], "owner": "Plant Co", "due": None}]}
    return {"work_date": "2026-11-10", "version": 3, "as_of": NOW, "provisional": False, "summary": summary,
            "activities": [activity("A1", "behind"),
                           activity("A2", "not_started_ok", planned=0.0, actual=None, variance=None, variance_pct=None),
                           activity("A3", "on_track", planned=10.0, actual=10.0, variance=0.0, variance_pct=0.0)],
            "indicators": {"equipment_idle": [{"equipment_id": "CP-01", "description": "Concrete pump", "hours": 3.5,
                                               "refs": ["V1:transcript"]}]}} | kw


def incident(title, kind, category=None, **kw):
    return {"title": title, "summary": None, "activity_code": "A1", "kind": kind, "event_type": kind, "category": category,
            "severity": "high", "occurred_at": datetime(2026, 11, 10, 9, 15, tzinfo=UTC), "resolved_at": None} | kw


RECORDS = {"incidents": [incident("Worker cut hand", "injury"), incident("Pump CP-01 breakdown", "equipment_failure"),
                         incident("Honeycombing on wall", "quality_observation", "quality")],
           "tasks": [{"description": "Reconcile the last ticket", "owner_name": None, "due_at": None,
                      "source_id": "D10", "locator": "p1"}]}


def test_only_the_days_activities_and_sections_with_content():
    c = dr._content(PROJECT, view(), RECORDS, MEMBER, NOW)
    assert c["header"][1] == "Tuesday, 10 November 2026"
    assert "activities" not in c  # the day's activities are not listed
    assert c["safety"] == [["10:15", "Worker cut hand", "High"]]  # project-local time; no activity, state or source
    assert c["delays"] == []  # the pump breakdown is an equipment delay, which the report does not list
    assert c["headline"] == "Pour fell 30 % short."
    assert c["tasks"] == [["Reconcile the last ticket", "-"], ["Repair pump", "-"]]  # task and due, no owner


def test_only_material_and_delivery_delays_are_listed():
    acts = [activity("A1", "behind", attribution={"cause_category": "supplier"}),
            activity("B1", "late_start", days_late=2, attribution=None),
            activity("C1", "behind", attribution={"cause_category": "unknown"})]
    records = {"incidents": [incident("Rain stopped the pour", "weather_stop", activity_code="D1"),
                             incident("Lift out of service", "utility_outage", activity_code=None)], "tasks": []}
    idle = {"equipment_idle": [{"equipment_id": "EX-02", "description": "Excavator", "hours": 6, "activity_code": "C1",
                                "refs": ["V3:seg:1"]}, {"equipment_id": "TC-01", "hours": 0, "refs": []}]}
    summary = {"headline": {"text": "x", "refs": []}, "disruptions": [{"text": "Gate closed by police", "refs": ["E1:body.1"]}]}
    c = dr._content(PROJECT, view(activities=acts, indicators=idle, summary=summary), records, MEMBER, NOW)
    # Idle plant, weather, utilities, the unexplained late start and the unrelated disruption are left out.
    assert c["delays"] == [("Materials and deliveries", ["A1 Activity A1 70 of 100 m3 (-30 %), cause: supplier"])]


def test_equipment_and_material_named_on_each_delay():
    acts = [activity("SLAB", "behind", attribution={"cause_category": "supplier",
                                                     "explanation": "Ready-mix concrete truck arrived late."})]
    records = {"tasks": [], "equipment": {"TC-01": "Tower crane"},
               "incidents": [incident("Concrete delivery 90 minutes late", "delivery_delay", activity_code="POUR", id="i1"),
                             incident("Crane stopped", "equipment_failure", activity_code="L4", id="i2"),
                             incident("Rebar short by one tonne", "material_shortage", activity_code="REB", id="i3")],
               "details": {"i2": {"equipment": ["TC-01", "11"], "materials": []},
                           "i3": {"equipment": [], "materials": ["B500B reinforcement"]}}}
    summary = {"headline": {"text": "x", "refs": []}, "disruptions": [{"text": "Concrete arrived late again", "refs": ["D1:p1"]}]}
    c = dr._content(PROJECT, view(activities=acts, indicators={}, summary=summary), records, MEMBER, NOW)
    assert dict(c["delays"]) == {
        "Materials and deliveries": [
            "10:15 Concrete delivery 90 minutes late (POUR). Material: concrete. "            # named in the text
            "Reported: Concrete arrived late again",                                           # same material
            "10:15 Rebar short by one tonne (REB). Material: B500B reinforcement",            # recorded wins
            "SLAB Activity SLAB 70 of 100 m3 (-30 %), cause: supplier. Material: ready-mix concrete"]}


def test_quiet_day_has_no_safety_delay_or_task_sections():
    quiet = view(summary={"status": "not_requested", "headline": {"text": "All on plan.", "refs": []}},
                 activities=[activity("A3", "on_track", planned=10.0, actual=10.0, variance=0.0, variance_pct=0.0)],
                 indicators={})
    c = dr._content(PROJECT, quiet, {"incidents": [], "tasks": []}, MEMBER, NOW)
    assert (c["safety"], c["delays"], c["tasks"]) == ([], [], [])
    from docx import Document
    words = "\n".join(p.text for p in Document(BytesIO(dr.render("docx", PROJECT, quiet, {"incidents": [], "tasks": []},
                                                                  MEMBER, NOW)[0])).paragraphs)
    assert dr.NOTHING in words and not any(h in words for h in ("Activities", "Safety incidents", "Delays", "Tasks"))


def test_renders_pdf_and_word():
    pdf, mime = dr.render("pdf", PROJECT, view(), RECORDS, MEMBER, NOW)
    assert mime == dr.PDF and pdf.startswith(b"%PDF")
    docx, mime = dr.render("docx", PROJECT, view(), RECORDS, MEMBER, NOW)
    assert mime == dr.DOCX
    from docx import Document
    doc = Document(BytesIO(docx))
    words = "\n".join(p.text for p in doc.paragraphs)
    assert "Daily site report · Riverside <Block A>" in words and "Safety incidents" in words and "Tasks" in words
    assert [c.text for c in doc.tables[0].rows[0].cells] == ["Time", "Incident", "Severity"]
    assert [c.text for c in doc.tables[1].rows[0].cells] == ["Task", "Due"]
    assert "Activities" not in words
    empty, _ = dr.render("pdf", PROJECT, view(activities=[]), {"incidents": [], "tasks": []}, MEMBER, NOW)
    assert empty.startswith(b"%PDF")


# ------------------------------------------------------------------ project impact (counterfactual forecast)

def _plan_fixture(monkeypatch, produced):
    """A (dig, 2 days x 10, critical) -> B (pour, 2 days), and C (paint, 2 days x 10, with float)."""
    from datetime import date
    from performance import metrics as m
    D = date.fromisoformat
    plans = [m.ActivityPlan("A", D("2026-11-09"), D("2026-11-10"), 20, 10, duration_wd=2),
             m.ActivityPlan("B", D("2026-11-11"), D("2026-11-12"), 10, 5, duration_wd=2, predecessors=["A"]),
             m.ActivityPlan("C", D("2026-11-09"), D("2026-11-10"), 20, 10, duration_wd=2)]
    targets = {"A": {D("2026-11-09"): 10, D("2026-11-10"): 10}, "B": {D("2026-11-11"): 5, D("2026-11-12"): 5},
               "C": {D("2026-11-09"): 10, D("2026-11-10"): 10}}
    signed = {code: {D(d): {"quantity": q} for d, q in days.items()} for code, days in produced.items()}
    monkeypatch.setattr(dr, "active_baseline", lambda *a: None)
    monkeypatch.setattr(dr, "load_settings", lambda *a: m.merge_settings({}))
    monkeypatch.setattr(dr, "load_series", lambda *a: (targets, {}, signed, {}))
    monkeypatch.setattr(dr, "_plans", lambda *a: plans)
    return D("2026-11-10")


def test_a_critical_shortfall_is_charged_with_the_project_delay(monkeypatch):
    day = _plan_fixture(monkeypatch, {"A": {"2026-11-09": 10, "2026-11-10": 0}, "C": {"2026-11-09": 10, "2026-11-10": 0}})
    impact = dr.project_impact(None, "P", day, NOW, {"A", "C"})
    assert impact["slip"] > 0 and impact["late"] > 0
    assert impact["caused"]["A"] >= 1          # A drives B: meeting A's plan would have kept the date
    assert impact["caused"]["C"] == 0          # C has float: its shortfall did not move completion
    supplier = {"cause_category": "supplier"}
    c = dr._content(PROJECT, view(activities=[activity("A", "behind", attribution=supplier),
                                              activity("C", "behind", attribution=supplier)], indicators={},
                                  summary={"headline": {"text": "x", "refs": []}}),
                    {"incidents": [], "tasks": []}, MEMBER, NOW, impact)
    groups = dict(c["delays"])
    a_line, c_line = groups["Materials and deliveries"]
    assert a_line.startswith("A Activity A 70 of 100 m3 (-30 %), cause: supplier. Delayed project completion by")
    assert c_line == "C Activity C 70 of 100 m3 (-30 %), cause: supplier. Did not move the completion date"
    assert list(groups) == ["Materials and deliveries"]


def test_no_impact_before_the_days_quantities_are_signed(monkeypatch):
    day = _plan_fixture(monkeypatch, {"A": {"2026-11-09": 10}})
    assert dr.project_impact(None, "P", day, NOW, {"A"}) is None
