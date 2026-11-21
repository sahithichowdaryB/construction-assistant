"""Pure tests for performance/metrics.py: no database, no model."""

import sys
from datetime import date, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from performance import metrics as m  # noqa: E402
from performance.metrics import ActivityPlan, Calendar, DayInput  # noqa: E402

D = date.fromisoformat
S = m.merge_settings({"thresholds": {"daily_output": {"amber_pct": 10, "red_pct": 20, "over_pct": 10}}})
MON_FRI = Calendar()


def day(planned, actual, **kw):
    kw.setdefault("work_date", D("2026-11-10"))
    return m.daily_activity(DayInput("A", planned, actual, **kw), S, MON_FRI)


# ------------------------------------------------------------------ statuses and thresholds (6.3)

@pytest.mark.parametrize("actual,status,severity", [
    (110, "exceeded", "none"),       # exactly +10 % -> exceeded (>=)
    (109.99, "on_track", "none"),
    (90, "on_track", "none"),        # exactly 10 % short -> still none (existing /site-day rule: > threshold)
    (89.99, "behind", "amber"),
    (80, "behind", "amber"),         # exactly 20 % short -> amber
    (79.99, "behind", "red"),
    (0, "behind", "red"),
])
def test_output_thresholds_at_the_edges(actual, status, severity):
    out = day(100, actual)
    assert (out["status"], out["severity"]) == (status, severity)


def test_variance_fields_are_signed_and_rounded():
    out = day(100, 92)
    assert out["variance"] == -8 and out["variance_pct"] == -8.0 and out["shortfall_pct"] == 8.0


def test_not_reported_is_red_only_after_the_sweep():
    assert (day(100, None)["status"], day(100, None)["severity"]) == ("not_reported", "none")
    after = day(100, None, after_sweep=True)
    assert (after["status"], after["severity"]) == ("not_reported", "red")


def test_unplanned_work_and_not_started_ok():
    assert day(0, 63)["status"] == "unplanned_work"
    assert day(0, None, planned_start=D("2026-11-12"))["status"] == "not_started_ok"


def test_late_start_amber_then_red_and_critical_is_red():
    base = dict(planned_start=D("2026-11-09"), first_output=None, after_sweep=True)
    one = day(100, 0, work_date=D("2026-11-10"), **base)  # Tue, started Mon: 1 working day late
    assert (one["status"], one["severity"], one["days_late"]) == ("late_start", "amber", 1)
    three = day(100, 0, work_date=D("2026-11-12"), **base)
    assert (three["severity"], three["days_late"]) == ("red", 3)
    crit = day(100, 0, work_date=D("2026-11-10"), is_critical=True, **base)
    assert crit["severity"] == "red"


def test_late_start_needs_signed_coverage_and_skips_weekends():
    no_cover = day(100, 0, work_date=D("2026-11-10"), planned_start=D("2026-11-09"), coverage_complete=False,
                   after_sweep=True)
    assert no_cover["status"] == "behind"
    monday = day(100, 0, work_date=D("2026-11-09"), planned_start=D("2026-11-06"), after_sweep=True)  # Fri -> Mon
    assert monday["days_late"] == 1


def test_consecutive_amber_escalates_to_red():
    first = day(100, 85, prev_amber_run=0)
    second = day(100, 85, prev_amber_run=1)
    assert first["severity"] == "amber" and not first["escalated"]
    assert second["severity"] == "red" and second["escalated"]


def test_project_thresholds_reproduce_site_day_severity():
    riv = m.merge_settings({"thresholds": {"daily_output": {"amber_pct": 15, "red_pct": 25}}})
    cal = Calendar(frozenset(range(7)))
    cases = [(25, 20, "amber"), (40, 32, "amber"), (100, 65, "red"), (100, 80, "amber"), (5, 4, "amber"),
             (30, 20, "red"), (100, 92, "none"), (25, 30, "none")]
    for planned, actual, severity in cases:
        assert m.daily_activity(DayInput("X", planned, actual, work_date=D("2026-11-10")), riv, cal)["severity"] == severity


# ------------------------------------------------------------------ calendar

def test_calendar_weekend_and_holiday():
    cal = Calendar.from_settings({"calendar": {"working_weekdays": [0, 1, 2, 3, 4], "holidays": ["2026-12-25"]}})
    assert cal.add_working_days(D("2026-12-24"), 1) == D("2026-12-28")  # Thu -> skip Fri holiday and weekend
    assert cal.between(D("2026-12-24"), D("2026-12-28")) == 1
    assert cal.between(D("2026-12-28"), D("2026-12-24")) == -1
    assert len(cal.working_days(D("2026-12-21"), D("2026-12-27"))) == 4
    assert cal.next_working(D("2026-12-26")) == D("2026-12-28")


def test_seven_day_calendar_keeps_weekend_work():
    cal = Calendar.from_settings({"calendar": {"working_weekdays": list(range(7))}})
    assert cal.add_working_days(D("2026-11-07"), 1) == D("2026-11-08")  # Saturday -> Sunday


def test_extra_working_day_overrides_weekend():
    cal = Calendar.from_settings({"calendar": {"extra_working_days": ["2026-11-08"]}})
    assert cal.is_working(D("2026-11-08")) and not cal.is_working(D("2026-11-07"))


# ------------------------------------------------------------------ indicators

def test_idle_hours_clip_to_the_shift_and_merge_overlaps():
    s = m.merge_settings({"calendar": {"shift_start": "07:00", "shift_end": "16:00", "shift_hours": 8}})
    assert m.idle_hours([(600, None)], s) == 6.0               # 10:00 to the end of the shift
    assert m.idle_hours([(600, 720), (660, 780)], s) == 3.0     # 10-12 and 11-13 overlap
    assert m.idle_hours([(None, None)], s) == 8.0               # all day, capped at the net shift
    assert m.idle_severity(2.0, s) == "none" and m.idle_severity(2.5, s) == "amber"
    assert m.idle_severity(8.0, s) == "red"


# ------------------------------------------------------------------ cumulative, forecast, S-curve, SPI

def _plan(code, start, finish, total, tpd, weight=None, preds=()):
    return ActivityPlan(code, D(start), D(finish), total, tpd, weight, None, None, list(preds))


def test_cumulative_backlog_and_forecast():
    p = _plan("A", "2026-11-09", "2026-11-13", 500, 100)
    targets = {D(f"2026-11-{d:02d}"): 100 for d in range(9, 14)}
    actuals = {D("2026-11-09"): 100, D("2026-11-10"): 50, D("2026-11-11"): 50}
    out = m.cumulative(p, targets, actuals, D("2026-11-11"), MON_FRI)
    assert (out["planned_cum"], out["actual_cum"], out["backlog"], out["days_behind"]) == (300, 200, 100, 1.0)
    assert out["recent_rate"] == pytest.approx(66.67)
    # 300 left at 66.67 per day -> 5 more working days after Wed 11 Nov -> Wed 18 Nov
    assert out["forecast_finish"] == "2026-11-18" and out["finish_variance_days"] == 3


def test_forecast_with_zero_rate_is_null_and_flagged():
    p = _plan("A", "2026-11-09", "2026-11-13", 500, 100)
    out = m.cumulative(p, {D("2026-11-09"): 100}, {D("2026-11-09"): 0}, D("2026-11-10"), MON_FRI)
    assert out["forecast_finish"] is None and "zero_rate" in out["flags"]


def test_spi_and_s_curve_match_a_hand_calculation():
    # A: weight 60, 4 x 25 = 100 over Mon-Thu. B: weight 40, 2 x 10 = 20 over Wed-Thu.
    plans = [_plan("A", "2026-11-09", "2026-11-12", 100, 25, 60), _plan("B", "2026-11-11", "2026-11-12", 20, 10, 40)]
    targets = {"A": {D(f"2026-11-{d:02d}"): 25 for d in (9, 10, 11, 12)}, "B": {D("2026-11-11"): 10, D("2026-11-12"): 10}}
    actuals = {"A": {D("2026-11-09"): 25, D("2026-11-10"): 15, D("2026-11-11"): 20}, "B": {D("2026-11-11"): 10}}
    # By hand at Wed 11 Nov: planned = 60*75/100 + 40*10/20 = 45 + 20 = 65; actual = 60*60/100 + 40*10/20 = 36 + 20 = 56
    planned, actual = m.weighted_progress(plans, targets, actuals, D("2026-11-11"))
    assert (planned, actual) == (65.0, 56.0)
    assert m.spi(planned, actual) == round(56 / 65, 3) == 0.862
    assert m.band(0.862, 1.0, 0.95) == "red" and m.band(0.97, 1.0, 0.95) == "amber" and m.band(1.0, 1.0, 0.95) == "green"
    curve = m.s_curve(plans, targets, actuals, [D("2026-11-09"), D("2026-11-11"), D("2026-11-12")], D("2026-11-11"))
    assert curve[0] == {"date": "2026-11-09", "planned_pct": 15.0, "actual_pct": 15.0}
    assert curve[1]["planned_pct"] == 65.0 and curve[2] == {"date": "2026-11-12", "planned_pct": 100.0, "actual_pct": None}


def test_weights_fall_back_to_duration():
    plans = [ActivityPlan("A", None, None, 1, 1, None, 3), ActivityPlan("B", None, None, 1, 1, None, 1)]
    weights, basis = m.normalized_weights(plans)
    assert basis == "duration" and weights == {"A": 75.0, "B": 25.0}


# ------------------------------------------------------------------ critical path

def test_forward_pass_on_a_small_dag():
    #   A (Mon-Tue) -> B (Wed-Thu) -> D (Fri)
    #   A           -> C (Wed)     -> D
    plans = [_plan("A", "2026-11-09", "2026-11-10", 20, 10), _plan("B", "2026-11-11", "2026-11-12", 20, 10, preds=["A"]),
             _plan("C", "2026-11-11", "2026-11-11", 10, 10, preds=["A"]),
             _plan("D", "2026-11-13", "2026-11-13", 10, 10, preds=["B", "C"])]
    for p in plans:
        p.duration_wd = len(MON_FRI.working_days(p.planned_start, p.planned_finish))
    floats = m.planned_critical(plans, MON_FRI)
    assert floats == {"A": 0, "B": 0, "C": 1, "D": 0}
    # A finished one day late (Wed): everything after it slips one working day.
    cum = {"A": {"complete": True, "started": True, "actual_start": "2026-11-09", "actual_finish": "2026-11-11"}}
    fp = m.forward_pass(plans, cum, D("2026-11-11"), MON_FRI)
    assert fp["finish"]["B"] == D("2026-11-13") and fp["finish"]["D"] == D("2026-11-16")
    assert fp["completion"] == D("2026-11-16") and fp["float"]["C"] == 1
    ms = m.milestone_forecast([{"code": "M1", "planned_date": "2026-11-13", "activity_codes": ["D"]}],
                              fp["finish"], MON_FRI, D("2026-11-11"))
    assert ms[0]["forecast_date"] == "2026-11-16" and ms[0]["variance_days"] == 1


def test_cycle_is_rejected():
    with pytest.raises(ValueError, match="cycle"):
        m.topo_order(["A", "B"], {"A": ["B"], "B": ["A"]})


def test_ld_exposure_is_indicative_and_capped():
    out = m.ld_exposure(3, {"amount": 4500, "currency": "EUR", "cap_amount": 10000})
    assert out["amount"] == 10000 and out["capped"] and out["label"] == "indicative"
    assert m.ld_exposure(0, {"amount": 4500}) is None


# ------------------------------------------------------------------ ledger rules (7.3)

W = D("2026-11-12")


def _rules(entries):
    return {(e["rule_key"], e["points"]) for e in entries}


def test_ledger_exceeded_and_bonus():
    res = [{"code": "A", "status": "exceeded", "severity": "none", "variance_pct": 12, "variance": 12,
            "planned": 100, "actual": 112},
           {"code": "B", "status": "exceeded", "severity": "none", "variance_pct": 25, "variance": 25,
            "planned": 100, "actual": 125}]
    assert _rules(m.ledger_for_day(W, res, {}, {}, S)) == {("day.exceeded", 1), ("day.exceeded", 2)}


def test_ledger_backlog_recovered_by_unplanned_work():
    res = [{"code": "EXC-B", "status": "unplanned_work", "severity": "none", "planned": 0, "actual": 63}]
    ctx = {"EXC-B": {"backlog_before": 63, "target_per_day": 100}}
    entries = m.ledger_for_day(W, res, ctx, {}, S)
    assert entries[0]["rule_key"] == "backlog.recovered" and entries[0]["points"] == 0.63
    assert entries[0]["detail"]["days_recovered"] == 0.63 and entries[0]["kind"] == "merit"


def test_ledger_shortfalls_late_start_and_attribution():
    attr = {"cause_category": "client", "excusable": True, "responsible_party_ref": "CL"}
    res = [{"code": "A", "status": "behind", "severity": "amber", "planned": 100, "actual": 85, "shortfall_pct": 15},
           {"code": "B", "status": "behind", "severity": "red", "planned": 100, "actual": 50, "shortfall_pct": 50},
           {"code": "C", "status": "late_start", "severity": "amber", "planned": 10, "actual": 0, "days_late": 1},
           {"code": "D", "status": "late_start", "severity": "red", "planned": 10, "actual": 0, "days_late": 3}]
    ctx = {"B": {"attribution": attr}, "D": {"prev_late_severity": "amber"}}
    entries = m.ledger_for_day(W, res, ctx, {}, S)
    assert _rules(entries) == {("day.shortfall_amber", -1), ("day.shortfall_red", -3),
                               ("activity.late_start", -1), ("activity.late_start", -3)}
    b = next(e for e in entries if e["activity_code"] == "B")
    assert b["excusable"] and b["cause_category"] == "client" and b["quantity"] == 50
    # The same late-start level is not booked twice.
    again = m.ledger_for_day(W, res[3:], {"D": {"prev_late_severity": "red"}}, {}, S)
    assert again == []


def test_ledger_early_finish_idle_missing_quality_and_milestones():
    res = [{"code": "A", "status": "on_track", "severity": "none", "planned": 100, "actual": 100}]
    ctx = {"A": {"planned_total": 300, "actual_cum_before": 200, "planned_finish": "2026-11-13"}}
    ind = {"equipment_idle": [{"equipment_id": "EX-02", "hours": 3, "severity": "amber"},
                              {"equipment_id": "TC-01", "hours": 8, "severity": "red"}],
           "missing_report": {"after_sweep": True, "activities": ["B"]},
           "quality_holds": [{"subject": "pour", "failed": True}, {"subject": "rebar", "passed": True}],
           "milestones": [{"code": "M1", "event": "met"}, {"code": "M2", "event": "missed"}]}
    assert _rules(m.ledger_for_day(W, res, ctx, ind, S)) == {
        ("activity.early_finish", 3), ("equipment.idle", -1), ("equipment.idle", -2), ("report.missing", -2),
        ("quality.hold_failed", -3), ("quality.first_time_pass", 1), ("milestone.met", 3), ("milestone.missed", -5)}


def test_ledger_points_come_from_settings():
    tuned = m.merge_settings({"ledger_rules": {"day.shortfall_red": {"points": -10}}})
    res = [{"code": "A", "status": "behind", "severity": "red", "planned": 100, "actual": 0}]
    assert m.ledger_for_day(W, res, {}, {}, tuned)[0]["points"] == -10


def test_score_skips_disputed_superseded_and_excusable():
    entries = [{"points": -3, "status": "proposed", "work_date": "2026-11-10", "kind": "demerit"},
               {"points": 2, "status": "accepted", "work_date": "2026-11-11", "kind": "merit"},
               {"points": -5, "status": "disputed", "work_date": "2026-11-11", "kind": "demerit"},
               {"points": -1, "status": "superseded", "work_date": "2026-11-11", "kind": "demerit"},
               {"points": -3, "status": "proposed", "excusable": True, "work_date": "2026-11-12", "kind": "demerit"}]
    assert m.score(entries) == -1
    best, worst = m.best_worst_days(entries)
    assert best == [{"work_date": "2026-11-11", "points": 2}] and worst == [{"work_date": "2026-11-10", "points": -3}]
    assert m.weekly(entries) == [{"week": "2026-W46", "merits": 2.0, "demerits": -3.0, "score": -1.0}]


# ------------------------------------------------------------------ attribution split (7.2)

def test_excusable_split_is_weighted_by_shortfall_quantity():
    demerits = [{"cause_category": "contractor_internal", "quantity": 35, "excusable": False},
                {"cause_category": "weather", "quantity": 20, "excusable": True},
                {"cause_category": "client", "quantity": 25, "excusable": True}]
    out = m.attribution_split(1.6, demerits)
    assert out["by_cause"] == {"client": 0.5, "contractor_internal": 0.7, "weather": 0.4}
    assert (out["excusable_days"], out["non_excusable_days"]) == (0.9, 0.7)
    assert m.attribution_split(-0.5, demerits)["non_excusable_days"] == 0


def test_weather_is_excusable_only_beyond_the_allowance():
    s = m.merge_settings({"weather_allowance_days": 6})
    assert not m.is_excusable("weather", s, weather_days_used=5)
    assert m.is_excusable("weather", s, weather_days_used=6)
    assert m.is_excusable("client", s) and not m.is_excusable("contractor_internal", s)


# ------------------------------------------------------------------ status and suggestions

def test_overall_status_comes_from_spi_band_and_completion():
    assert m.overall_status("green", -1, S) == "ahead"
    assert m.overall_status("green", 0, S) == "on_plan"
    assert m.overall_status("amber", 0, S) == "at_risk"
    assert m.overall_status("green", 3, S) == "delayed"


def test_red_critical_client_deviation_suggests_a_delay_notice_with_a_working_day_deadline():
    s = m.merge_settings({"notice_rules": [{"type": "delay_notice", "deadline_wd": 5, "causes": ["client"]}]})
    res = [{"code": "FND-B", "severity": "red", "is_critical": True, "shortfall_pct": 33.33, "refs": ["R12:FND-B"],
            "attribution": {"cause_category": "client", "refs": ["E02:para:1"]}},
           {"code": "EXC-B", "severity": "red", "is_critical": True, "shortfall_pct": 35,
            "attribution": {"cause_category": "contractor_internal"}}]
    out = m.suggest_notices(D("2026-11-12"), res, {}, [], s, MON_FRI)
    assert len(out) == 1 and out[0]["type"] == "delay_notice"
    assert out[0]["deadline"] == "2026-11-19"  # Thu + 5 working days (weekend skipped)
    assert out[0]["refs"] == ["E02:para:1", "R12:FND-B"]


def test_idle_caused_by_others_suggests_an_additional_cost_notice_from_the_plan_rate():
    s = m.merge_settings({"rates": {"equipment": [{"item": "Excavator 30 t", "amount": 520, "per": "day",
                                                   "currency": "EUR"}]}})
    idle = {"equipment_id": "EX-02", "hours": 8, "severity": "red", "rate": m.equipment_rate(s, "EX-02", "Excavator"),
            "attribution": {"cause_category": "client", "refs": ["V01:seg:1"]}}
    out = m.suggest_notices(D("2026-11-10"), [], {"equipment_idle": [idle]}, [], s, MON_FRI)
    assert out[0]["type"] == "additional_cost_notice" and out[0]["amount"] == 520
    assert out[0]["deadline"] == (D("2026-11-10") + timedelta(days=14)).isoformat()  # 10 working days
    internal = {**idle, "attribution": {"cause_category": "contractor_internal"}}
    assert m.suggest_notices(D("2026-11-10"), [], {"equipment_idle": [internal]}, [], s, MON_FRI) == []


def test_a_stated_period_wins_over_without_delay():
    rule = {"type": "delay_notice", "deadline_wd": 5, "immediate": True}
    assert m.notice_deadline(D("2026-11-12"), rule, MON_FRI) == D("2026-11-19")
    assert m.notice_deadline(D("2026-11-12"), {"immediate": True, "deadline_wd": None}, MON_FRI) == D("2026-11-12")


def test_concern_notice_is_immediate_and_defect_notice_uses_its_rule():
    out = m.suggest_notices(D("2026-11-10"), [], {"quality_holds": [
        {"subject": "slab", "defect": True, "attribution": {"cause_category": "supplier"}, "refs": ["V07:seg:1"]}]},
        [{"text": "Use the old drawing", "concern": True, "refs": ["M08:para:3"]}], S, MON_FRI)
    kinds = {o["type"]: o["deadline"] for o in out}
    assert kinds == {"defect_notice": "2026-11-13", "notice_of_concern": "2026-11-10"}


def test_day_rollup():
    rows = [{"status": "on_track", "severity": "none", "planned": 1}, {"status": "behind", "severity": "red", "planned": 1}]
    assert m.day_rollup(rows, {}) == ("behind", "red")
    assert m.day_rollup([{"status": "unplanned_work", "severity": "none", "planned": 0}], {}) == ("ahead", "none")
    assert m.day_rollup([], {"equipment_idle": [{"severity": "amber"}]}) == ("no_work", "amber")
