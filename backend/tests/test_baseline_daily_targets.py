"""Activities carried over from a revision with another calendar keep their explicit daily targets."""

import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from performance import baseline as bl  # noqa: E402
from performance import metrics as m  # noqa: E402

MON_FRI = m.Calendar.from_settings(m.merge_settings({"calendar": {"working_weekdays": [0, 1, 2, 3, 4]}}))


def _plan(daily, total=50):
    return {"activities": [{"code": "FND-A", "name": "Foundations", "unit": "m³", "planned_start": "2026-11-08",
                            "planned_finish": "2026-11-09", "planned_total": total, "target_per_day": 25,
                            "duration_wd": 2, "refs": ["SCH:FND-A"], "daily_targets": daily}]}


def test_daily_targets_survive_validation_and_replace_the_working_day_expansion():
    clean, reasons = bl.validate(_plan({"2026-11-08": 25, "2026-11-09": 25}), {}, grounded=False)
    assert not bl.blocking(reasons)
    series = bl.expand_targets(clean["activities"], MON_FRI)["FND-A"]
    assert series[date(2026, 11, 8)] == 25 and series[date(2026, 11, 9)] == 25   # Sunday kept in a Mon-Fri plan


def test_without_daily_targets_the_weekend_day_is_dropped():
    clean, _ = bl.validate(_plan(None), {}, grounded=False)
    series = bl.expand_targets(clean["activities"], MON_FRI)["FND-A"]
    assert series[date(2026, 11, 8)] == 0 and series[date(2026, 11, 9)] == 25


def test_daily_targets_must_add_up_and_stay_in_the_window():
    _, reasons = bl.validate(_plan({"2026-11-08": 25, "2026-11-09": 20}), {}, grounded=False)
    assert any("add up to 45" in r["message"] for r in bl.blocking(reasons))
    _, reasons = bl.validate(_plan({"2026-11-07": 25, "2026-11-09": 25}), {}, grounded=False)
    assert any("outside" in r["message"] for r in bl.blocking(reasons))


def test_model_output_cannot_set_daily_targets():
    clean, _ = bl.validate(_plan({"2026-11-08": 25, "2026-11-09": 25}), {"SCH:FND-A": "FND-A 2026-11-08 2026-11-09 50 25 2"},
                           grounded=True)
    assert all("daily_targets" not in a for a in clean["activities"])
