"""Rule-based severity with a bounded LLM nudge. Pure: every input is passed in, so the matrix is unit-testable."""

from .taxonomy import SEVERITIES, severity_rank

HARD_CRITICAL = ("hospitalisation", "fatality", "structural_collapse")


def _max_level(*levels):
    return max((l for l in levels if l), key=severity_rank, default="low")


def rule_severity(*, base=None, category=None, injured_count=0, flags=(), reporter_count=1, successors_at_risk=0,
                  workers_affected=0, open_hours=0, escalate_after_hours=24) -> dict:
    """base: severity hint of the event type, else the category default.
    floor: hard rules; nothing (not even the LLM) may go below it.
    escalators: +1 level each, capped at high unless a hard rule already put the floor higher."""
    flags = list(flags or [])
    hard, floor = [], "low"

    def raise_to(level, why):
        nonlocal floor
        hard.append(why)
        floor = _max_level(floor, level)

    if (injured_count or 0) > 0:
        raise_to("high", "injured_count > 0")
    if any(f in HARD_CRITICAL for f in flags):
        raise_to("critical", "hospitalisation, fatality or structural collapse")
    if category == "safety" and "occupied_zone" in flags:
        raise_to("medium", "safety issue in an occupied zone")
    if "spill_to_drain" in flags:
        raise_to("high", "spill reached a drain")

    escalators = []
    if reporter_count >= 3:
        escalators.append("reporter_count >= 3")
    if successors_at_risk > 0:
        escalators.append("critical-path successors within 48h")
    if (workers_affected or 0) >= 10:
        escalators.append("workers_affected >= 10")
    if "sole_access" in flags:
        escalators.append("sole means of access")
    if open_hours > escalate_after_hours:
        escalators.append(f"open longer than {escalate_after_hours}h")

    pre = _max_level(base or "low", floor)
    cap = _max_level("high", floor)
    if severity_rank(pre) >= severity_rank(cap):
        level = pre
    else:
        level = SEVERITIES[min(severity_rank(pre) + len(escalators), severity_rank(cap))]
    return {"level": level, "floor": floor, "base": base or "low", "hard": hard, "escalators": escalators}


def apply_llm_adjustment(rule: dict, adjustment=0) -> dict:
    """The LLM may move the rule result by at most one level, never below the floor, never above max(high, floor)."""
    try:
        step = max(-1, min(1, int(adjustment or 0)))
    except (TypeError, ValueError):
        step = 0
    ceiling = severity_rank(_max_level("high", rule["floor"]))
    current = severity_rank(rule["level"])
    wanted = max(0, min(len(SEVERITIES) - 1, current + step))
    rank = max(severity_rank(rule["floor"]), min(wanted, max(ceiling, current)))
    return {"level": SEVERITIES[rank], "adjustment": rank - current}
