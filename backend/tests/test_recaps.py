"""Recap building from action items: pure logic, no database."""
from datetime import datetime
from zoneinfo import ZoneInfo

from recaps import build_recaps

TZ = ZoneInfo("Europe/Berlin")


def at(day, hh=9, mm=0):
    return datetime(2026, 11, day, hh, mm, tzinfo=TZ)


def item(i, raised, due=None, completed=None, owner="GroundWorks"):
    return {"id": f"a{i}", "description": f"Action {i}", "owner_name": owner, "due_at": due,
            "completed_at": completed, "quote": f"quote {i}", "source_id": f"M0{i}", "locator": "actions",
            "page": None, "source_type": "minutes", "source_title": f"Minutes M0{i}", "available_at": raised}


def by_date(recaps):
    return {r["work_date"]: r for r in recaps}


def test_raised_done_and_overdue_land_on_their_own_days():
    rows = [item(1, at(7), due=at(10, 12)), item(2, at(8), completed=at(9, 15))]
    days = by_date(build_recaps(rows, TZ, at(11, 7), include_today=False))
    assert set(days) == {"2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10"}
    assert [c["chapter"] for c in days["2026-11-09"]["cards"]][:2] == ["overview", "wins"]
    late = days["2026-11-10"]
    assert late["mood"] == "minor" and late["cards"][1]["chapter"] == "problems"
    assert late["cards"][1]["refs"][0]["passage_id"] == "M01:actions"


def test_recap_publishes_next_morning_and_respects_as_of():
    rows = [item(1, at(10, 10))]
    assert build_recaps(rows, TZ, at(11, 5, 59), include_today=False) == []
    (recap,) = build_recaps(rows, TZ, at(11, 6, 0), include_today=False)
    assert recap["work_date"] == "2026-11-10" and recap["available_at"].startswith("2026-11-11T06:00")


def test_items_done_before_due_are_not_overdue_and_open_items_carry_over():
    rows = [item(1, at(7), due=at(9, 12), completed=at(8, 16)), item(2, at(7), due=at(20))]
    days = by_date(build_recaps(rows, TZ, at(12), include_today=False))
    assert "2026-11-09" not in days
    today = days["2026-11-08"]["cards"][-1]
    assert today["chapter"] == "today" and today["done"] == ["GroundWorks · Action 2"]


def test_today_so_far_is_live_and_first():
    rows = [item(1, at(7), due=at(20)), item(2, at(11, 8), due=at(11, 9), owner="plant desk")]
    recaps = build_recaps(rows, TZ, at(11, 14))
    live = recaps[0]
    assert live["live"] is True and live["work_date"] == "2026-11-11"
    assert live["short_label"] == "so far" and live["mood"] == "minor"
    assert "live to 14:00" in live["cards"][0]["kicker"]
    today = live["cards"][-1]
    assert today["title"] == "2 open now" and today["done"][0].startswith("Plant desk · ")
    assert all(not r["live"] for r in recaps[1:])


def test_quiet_today_still_shows_open_items():
    (live, _) = build_recaps([item(1, at(7))], TZ, at(9, 10))
    assert live["cards"][0]["title"] == "Quiet so far"
    assert live["cards"][-1]["chapter"] == "today"


def test_phrases_drop_repeated_owner_and_stop():
    row = item(1, at(7), owner="plant desk")
    row["description"] = "Plant desk to propose cover for the Zone B shifts."
    (recap,) = build_recaps([row], TZ, at(9), include_today=False)
    assert recap["cards"][-1]["done"] == ["Plant desk · Propose cover for the Zone B shifts"]
