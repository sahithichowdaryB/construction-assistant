"""Pure performance arithmetic: no database, no web framework, no model.

Every number that reaches a summary, a notice or a score is computed here, so it can be reproduced and
unit-tested (tests/test_performance_metrics.py). The LLM prompts receive these results as read-only input.

Conventions
- Quantities are floats. Percentages are 0-100 and rounded to 2 decimals.
- Severities are "none" | "amber" | "red". Alert revisions store them as "none" | "medium" | "high"
  (ALERT_SEVERITY) because that is the existing alert vocabulary.
- Thresholds follow the existing `/site-day` rule: a shortfall exactly at the amber threshold is still
  "none"; amber starts strictly above it, red strictly above the red threshold.
- Working days come from a Calendar built from the plan, never from a hard-coded Monday-Friday week.
- Every constant below is a documented default; the live values come from performance_settings.
"""

from __future__ import annotations

import copy
import math
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta

DISCLAIMER = "Drafting support only — not legal advice. Final review lies with the site manager/company."
ALERT_SEVERITY = {"none": "none", "amber": "medium", "red": "high"}
SEVERITY_RANK = {"none": 0, "amber": 1, "red": 2}
CAUSES = ("contractor_internal", "subcontractor", "client", "designer", "supplier", "weather", "third_party",
          "unknown")

# Documented defaults. A project's settings are DEFAULT_SETTINGS deep-merged with what the plan document
# (or, for the Riverside CSV baseline, projects.threshold / high_threshold) says.
DEFAULT_SETTINGS = {
    "calendar": {
        "working_weekdays": [0, 1, 2, 3, 4],  # Monday = 0
        "holidays": [], "extra_working_days": [],
        "shift_start": "07:00", "shift_end": "16:00", "shift_hours": 8,
        "sweep_time": "18:00",  # end-of-day sweep: an unreported planned activity becomes red
    },
    "thresholds": {
        "daily_output": {"amber_pct": 10, "red_pct": 20, "over_pct": 10, "consecutive_amber_to_red": 2},
        "start_finish": {"amber_days": 1, "red_days": 3, "critical_late_is_red": True},
        "cumulative_points": {"amber": 2, "red": 4},
        "equipment_idle": {"amber_hours": 2, "red_hours": None},  # None = one full shift
        "labour": {"amber_pct": 10, "red_pct": 20},
        "spi": {"green": 1.0, "amber": 0.95},
        "finish_variance_days": {"amber": 1, "red": 3},
    },
    "notice_rules": [
        {"type": "delay_notice", "deadline_wd": 5, "causes": ["client", "designer", "supplier", "third_party"]},
        {"type": "additional_cost_notice", "deadline_wd": 10},
        {"type": "defect_notice", "deadline_wd": 3},
        {"type": "notice_of_concern", "deadline_wd": 0},
    ],
    "rates": {"equipment": [], "liquidated_damages": None},
    "excusable_causes": ["client", "designer", "weather"],
    "weather_allowance_days": None,
    "recent_rate_window": 5,
    "recovery_window": 5,
    "ledger_rules": {
        "day.exceeded": {"kind": "merit", "points": 1, "bonus_pct": 25, "bonus_points": 2},
        "backlog.recovered": {"kind": "merit", "points_per_day": 1},
        "activity.early_finish": {"kind": "merit", "points": 3},
        "milestone.met": {"kind": "merit", "points": 3},
        "quality.first_time_pass": {"kind": "merit", "points": 1},
        "day.shortfall_amber": {"kind": "demerit", "points": -1},
        "day.shortfall_red": {"kind": "demerit", "points": -3},
        "activity.late_start": {"kind": "demerit", "amber_points": -1, "red_points": -3},
        "equipment.idle": {"kind": "demerit", "points": -1, "full_shift_points": -2},
        "report.missing": {"kind": "demerit", "points": -2},
        "quality.hold_failed": {"kind": "demerit", "points": -3},
        "milestone.missed": {"kind": "demerit", "points": -5},
    },
}


def merge_settings(*layers: dict | None) -> dict:
    """Deep-merge settings layers; later layers win. Lists are replaced, not appended."""
    out = copy.deepcopy(DEFAULT_SETTINGS)

    def merge(into, new):
        for key, value in (new or {}).items():
            if isinstance(value, dict) and isinstance(into.get(key), dict):
                merge(into[key], value)
            elif value is not None or key not in into:
                into[key] = copy.deepcopy(value)
    for layer in layers:
        merge(out, layer)
    return out


def r2(value):
    return None if value is None else round(float(value) + 0.0, 2)


# ------------------------------------------------------------------ calendar

def _d(value) -> date:
    return value if isinstance(value, date) else date.fromisoformat(str(value)[:10])


@dataclass(frozen=True)
class Calendar:
    working_weekdays: frozenset = frozenset({0, 1, 2, 3, 4})
    holidays: frozenset = frozenset()
    extra_working_days: frozenset = frozenset()

    @classmethod
    def from_settings(cls, settings: dict | None) -> "Calendar":
        cal = (settings or {}).get("calendar") or {}
        weekdays = cal.get("working_weekdays")
        return cls(frozenset(weekdays if weekdays is not None else (0, 1, 2, 3, 4)),
                   frozenset(_d(x) for x in cal.get("holidays") or []),
                   frozenset(_d(x) for x in cal.get("extra_working_days") or []))

    def is_working(self, day: date) -> bool:
        if day in self.extra_working_days:
            return True
        return day.weekday() in self.working_weekdays and day not in self.holidays

    def _guard(self):
        if not self.working_weekdays and not self.extra_working_days:
            raise ValueError("The calendar has no working days")

    def next_working(self, day: date) -> date:
        """`day` itself if it is a working day, else the next one."""
        self._guard()
        for _ in range(3700):
            if self.is_working(day):
                return day
            day += timedelta(days=1)
        raise ValueError("No working day within ten years")

    def add_working_days(self, day: date, n: int) -> date:
        """Move n working days forward (n >= 0) from `day`. n = 0 returns `day` unchanged."""
        if n < 0:
            raise ValueError("n must be >= 0")
        self._guard()
        while n > 0:
            day += timedelta(days=1)
            if self.is_working(day):
                n -= 1
        return day

    def previous_working(self, day: date) -> date:
        self._guard()
        day -= timedelta(days=1)
        while not self.is_working(day):
            day -= timedelta(days=1)
        return day

    def working_days(self, start: date, finish: date) -> list[date]:
        """Working dates in [start, finish], inclusive."""
        out, day = [], start
        while day <= finish:
            if self.is_working(day):
                out.append(day)
            day += timedelta(days=1)
        return out

    def between(self, a: date, b: date) -> int:
        """Signed working days from a to b: the number of working days in (a, b] (negative if b < a)."""
        if a == b:
            return 0
        if b > a:
            return len(self.working_days(a + timedelta(days=1), b))
        return -len(self.working_days(b + timedelta(days=1), a))


# ------------------------------------------------------------------ daily activity metrics (6.3)

@dataclass
class DayInput:
    """What the caller knows about one activity on one work date (all values as of `as_of`)."""
    code: str
    planned: float
    actual: float | None                 # signed quantity, None when no signed report yet
    planned_start: date | None = None
    planned_finish: date | None = None
    work_date: date | None = None
    first_output: date | None = None     # first date with a signed actual > 0 since planned_start
    complete_before: bool = False        # signed cumulative reached the planned total before this day
    prev_severity: str | None = None     # daily-output severity on the previous planned working day
    prev_amber_run: int = 0              # consecutive amber days immediately before this one
    is_critical: bool = False
    after_sweep: bool = False            # the end-of-day sweep for this date has passed at as_of
    coverage_complete: bool = True       # a signed reading exists for every working day since planned_start


def output_severity(shortfall_pct: float | None, th: dict) -> str:
    if shortfall_pct is None or shortfall_pct <= float(th["amber_pct"]):
        return "none"
    return "red" if shortfall_pct > float(th["red_pct"]) else "amber"


def late_start_severity(days_late: int, is_critical: bool, th: dict) -> str:
    if days_late < int(th.get("amber_days", 1)):
        return "none"
    if days_late >= int(th.get("red_days", 3)) or (is_critical and th.get("critical_late_is_red", True)):
        return "red"
    return "amber"


def daily_activity(x: DayInput, settings: dict, cal: Calendar) -> dict:
    """Status, severity and variance for one activity on one day (section 6.3)."""
    th = settings["thresholds"]["daily_output"]
    sf = settings["thresholds"]["start_finish"]
    planned = float(x.planned or 0)
    actual = None if x.actual is None else float(x.actual)
    out = {"code": x.code, "planned": r2(planned), "actual": r2(actual), "variance": None, "variance_pct": None,
           "shortfall_pct": None, "status": None, "severity": "none", "escalated": False, "days_late": None}
    if actual is not None:
        out["variance"] = r2(actual - planned)
        if planned > 0:
            out["variance_pct"] = r2(100 * (actual - planned) / planned)
            out["shortfall_pct"] = r2(max(planned - actual, 0) * 100 / planned)

    due = x.planned_start is not None and x.work_date is not None and x.work_date >= x.planned_start
    started = x.first_output is not None and (x.work_date is None or x.first_output <= x.work_date)
    if (due and not started and not x.complete_before and x.coverage_complete
            and x.work_date > x.planned_start and not (actual and actual > 0)):
        # Late start: the first planned day has passed and no output has been signed since.
        days = cal.between(x.planned_start, x.work_date)
        if actual is None and planned > 0 and not x.after_sweep:
            days -= 1 if cal.is_working(x.work_date) else 0  # today is still open
        if days >= int(sf.get("amber_days", 1)):
            out.update(status="late_start", days_late=days,
                       severity=late_start_severity(days, x.is_critical, sf))
            return out

    if planned > 0:
        if actual is None:
            out.update(status="not_reported", severity="red" if x.after_sweep else "none")
            return out
        pct = 100 * (actual - planned) / planned
        if pct >= float(th["over_pct"]):
            out["status"] = "exceeded"
            return out
        severity = output_severity(out["shortfall_pct"], th)
        if severity == "none":
            out["status"] = "on_track"
            return out
        run = int(th.get("consecutive_amber_to_red") or 0)
        if severity == "amber" and run and x.prev_amber_run + 1 >= run:
            severity, out["escalated"] = "red", True
        out.update(status="behind", severity=severity)
        return out
    if actual is not None and actual > 0:
        out["status"] = "unplanned_work"
        return out
    out["status"] = "not_started_ok" if not due else "on_track"
    return out


# ------------------------------------------------------------------ day-level indicators

def _minutes(hhmm: str) -> int:
    h, m = str(hhmm).split(":")[:2]
    return int(h) * 60 + int(m)


def idle_hours(intervals: list[tuple[int | None, int | None]], settings: dict) -> float:
    """Hours idle inside the shift window. Intervals are (start, end) minutes after local midnight; None
    means before the shift start / after the shift end. Overlaps are merged."""
    cal = settings["calendar"]
    lo, hi = _minutes(cal["shift_start"]), _minutes(cal["shift_end"])
    spans = sorted((max(lo, a if a is not None else lo), min(hi, b if b is not None else hi)) for a, b in intervals)
    total, cursor = 0, lo
    for a, b in spans:
        a = max(a, cursor)
        if b > a:
            total += b - a
            cursor = b
    return r2(min(total / 60, float(cal.get("shift_hours") or (hi - lo) / 60)))


def idle_severity(hours: float | None, settings: dict) -> str:
    th = settings["thresholds"]["equipment_idle"]
    full = float(th.get("red_hours") or settings["calendar"].get("shift_hours") or 8)
    if hours is None or hours <= float(th["amber_hours"]):
        return "none"
    return "red" if hours >= full else "amber"


def labour_severity(attended: float | None, planned: float | None, settings: dict) -> str:
    th = settings["thresholds"]["labour"]
    if not planned or attended is None:
        return "none"
    short = 100 * max(planned - attended, 0) / planned
    return output_severity(short, {"amber_pct": th["amber_pct"], "red_pct": th["red_pct"]})


def day_rollup(results: list[dict], indicators: dict) -> tuple[str, str]:
    """(day_status, day_severity): the worst severity over activities and indicators."""
    severities = [r["severity"] for r in results]
    severities += [i.get("severity", "none") for i in indicators.get("equipment_idle", [])]
    severities += ["red" for _ in indicators.get("quality_holds", []) if _.get("failed")]
    worst = max(severities, key=lambda s: SEVERITY_RANK[s], default="none")
    statuses = {r["status"] for r in results}
    if any(r["severity"] != "none" and r["status"] in ("behind", "late_start") for r in results):
        status = "behind"
    elif "not_reported" in statuses:
        status = "not_reported"
    elif statuses & {"exceeded", "unplanned_work"}:
        status = "ahead"
    elif any(r["planned"] for r in results):
        status = "on_track"
    else:
        status = "no_work"
    return status, worst


# ------------------------------------------------------------------ cumulative metrics (7.1)

@dataclass
class ActivityPlan:
    code: str
    planned_start: date | None
    planned_finish: date | None
    planned_total: float | None
    target_per_day: float | None
    weight: float | None = None
    duration_wd: int | None = None
    is_critical: bool | None = None
    predecessors: list[str] = field(default_factory=list)
    name: str | None = None
    unit: str | None = None


def recent_rate(actuals: dict[date, float], to: date, window: int) -> float | None:
    """Mean of signed actuals over the last `window` dates with output, up to `to`."""
    days = sorted((d for d, q in actuals.items() if d <= to and q and q > 0), reverse=True)[:window]
    return r2(sum(actuals[d] for d in days) / len(days)) if days else None


def cumulative(plan: ActivityPlan, targets: dict[date, float], actuals: dict[date, float], to: date,
               cal: Calendar, window: int = 5) -> dict:
    planned_cum = sum(q for d, q in targets.items() if d <= to)
    actual_cum = sum(q for d, q in actuals.items() if d <= to and q is not None)
    total = float(plan.planned_total) if plan.planned_total else sum(targets.values())
    backlog = planned_cum - actual_cum
    tpd = float(plan.target_per_day) if plan.target_per_day else None
    rate = recent_rate(actuals, to, window)
    out = {"code": plan.code, "planned_total": r2(total), "planned_cum": r2(planned_cum), "actual_cum": r2(actual_cum),
           "backlog": r2(backlog), "pct_complete_planned": r2(100 * min(planned_cum / total, 1)) if total else None,
           "pct_complete_actual": r2(100 * min(actual_cum / total, 1)) if total else None,
           "days_behind": r2(backlog / tpd) if tpd else None, "recent_rate": rate, "forecast_finish": None,
           "finish_variance_days": None, "flags": [], "complete": bool(total) and actual_cum >= total - 1e-9,
           "started": actual_cum > 0, "actual_start": None, "actual_finish": None}
    produced = sorted(d for d, q in actuals.items() if d <= to and q and q > 0)
    if produced:
        out["actual_start"] = produced[0].isoformat()
    if out["complete"]:
        running = 0.0
        for d in sorted(d for d in actuals if d <= to):
            running += actuals[d] or 0
            if running >= total - 1e-9:
                out["actual_finish"] = d.isoformat()
                out["forecast_finish"] = d.isoformat()
                break
    elif not produced and plan.planned_start and to < plan.planned_start:
        out["forecast_finish"] = plan.planned_finish.isoformat() if plan.planned_finish else None
    elif rate:
        need = math.ceil((total - actual_cum) / rate - 1e-9)
        out["forecast_finish"] = cal.add_working_days(cal.next_working(to) if not cal.is_working(to) else to,
                                                      max(need, 0)).isoformat()
    else:
        out["flags"].append("zero_rate")
    if out["forecast_finish"] and plan.planned_finish:
        out["finish_variance_days"] = cal.between(plan.planned_finish, _d(out["forecast_finish"]))
    return out


def carry_in(targets: dict[str, dict[date, float]], actuals: dict[str, dict[date, float]]
             ) -> tuple[dict[str, dict[date, float]], date | None, dict[str, int]]:
    """Progress before the project's first signed report is unknown to the system. Those planned quantities are
    assumed done as planned (flagged per activity), so missing history neither inflates nor hides a delay.
    Returns (actuals with the assumption, tracking start, {code: assumed days})."""
    starts = [d for series in actuals.values() for d in series]
    if not starts:
        return actuals, None, {}
    tracking = min(starts)
    out, assumed = {}, {}
    for code in set(targets) | set(actuals):
        series = dict(actuals.get(code, {}))
        n = 0
        for d, q in targets.get(code, {}).items():
            if d < tracking and d not in series and q:
                series[d] = q
                n += 1
        out[code] = series
        if n:
            assumed[code] = n
    return out, tracking, assumed


def normalized_weights(plans: list[ActivityPlan]) -> tuple[dict[str, float], str]:
    """Weights that sum to 100. Uses the plan's weights; without them, planned duration in working days."""
    given = {p.code: float(p.weight) for p in plans if p.weight is not None and float(p.weight) > 0}
    if given and len(given) == len(plans):
        basis, raw = "plan", given
    else:
        basis = "duration"
        raw = {p.code: float(p.duration_wd or 1) for p in plans}
    total = sum(raw.values()) or 1
    return {k: v * 100 / total for k, v in raw.items()}, basis


def weighted_progress(plans: list[ActivityPlan], targets: dict[str, dict[date, float]],
                      actuals: dict[str, dict[date, float]], to: date) -> tuple[float, float]:
    """(planned %, actual %) weighted progress to date `to`."""
    weights, _ = normalized_weights(plans)
    planned = actual = 0.0
    for p in plans:
        t = targets.get(p.code, {})
        total = float(p.planned_total) if p.planned_total else sum(t.values())
        if not total:
            continue
        pc = sum(q for d, q in t.items() if d <= to) / total
        ac = sum(q for d, q in actuals.get(p.code, {}).items() if d <= to and q) / total
        planned += weights[p.code] * min(pc, 1)
        actual += weights[p.code] * min(ac, 1)
    return r2(planned), r2(actual)


def s_curve(plans, targets, actuals, dates: list[date], to: date) -> list[dict]:
    """Planned and actual weighted progress per date; actual stops at `to`."""
    out = []
    for d in dates:
        planned, actual = weighted_progress(plans, targets, actuals, d)
        out.append({"date": d.isoformat(), "planned_pct": planned, "actual_pct": actual if d <= to else None})
    return out


def spi(planned_pct: float | None, actual_pct: float | None) -> float | None:
    if not planned_pct:
        return None
    return round(float(actual_pct or 0) / float(planned_pct), 3)


def band(value: float | None, green: float, amber: float) -> str | None:
    if value is None:
        return None
    return "green" if value >= green else "amber" if value >= amber else "red"


# ------------------------------------------------------------------ critical path (7.1)

def topo_order(codes: list[str], predecessors: dict[str, list[str]]) -> list[str]:
    """Kahn's algorithm. Unknown predecessors are ignored; a cycle raises ValueError."""
    known = set(codes)
    indegree = {c: 0 for c in codes}
    succ = defaultdict(list)
    for c in codes:
        for p in predecessors.get(c, []):
            if p in known:
                indegree[c] += 1
                succ[p].append(c)
    queue = sorted(c for c, n in indegree.items() if n == 0)
    out = []
    while queue:
        c = queue.pop(0)
        out.append(c)
        for s in sorted(succ[c]):
            indegree[s] -= 1
            if indegree[s] == 0:
                queue.append(s)
        queue.sort()
    if len(out) != len(codes):
        raise ValueError("The activity dependencies contain a cycle: " + ", ".join(sorted(set(codes) - set(out))))
    return out


def _duration(p: ActivityPlan, cal: Calendar) -> int:
    if p.duration_wd:
        return int(p.duration_wd)
    if p.planned_start and p.planned_finish:
        return max(len(cal.working_days(p.planned_start, p.planned_finish)), 1)
    return 1


def backward_float(starts: dict[str, date], finishes: dict[str, date], durations: dict[str, int],
                   predecessors: dict[str, list[str]], cal: Calendar) -> dict[str, int]:
    """Total float in working days for each activity against the latest finish."""
    codes = list(finishes)
    order = topo_order(codes, predecessors)
    succ = defaultdict(list)
    for c in codes:
        for p in predecessors.get(c, []):
            if p in finishes:
                succ[p].append(c)
    end = max(finishes.values())
    late_finish, late_start = {}, {}
    for c in reversed(order):
        lf = min((cal.previous_working(late_start[s]) for s in succ[c]), default=end)
        late_finish[c] = lf
        late_start[c] = lf
        for _ in range(max(durations[c] - 1, 0)):
            late_start[c] = cal.previous_working(late_start[c])
    return {c: cal.between(finishes[c], late_finish[c]) for c in codes}


def planned_critical(plans: list[ActivityPlan], cal: Calendar) -> dict[str, int]:
    """Total float of each activity on the baseline dates (0 or less = critical)."""
    dated = [p for p in plans if p.planned_start and p.planned_finish]
    if not dated:
        return {}
    preds = {p.code: list(p.predecessors) for p in dated}
    return backward_float({p.code: p.planned_start for p in dated}, {p.code: p.planned_finish for p in dated},
                          {p.code: _duration(p, cal) for p in dated}, preds, cal)


def forward_pass(plans: list[ActivityPlan], cum: dict[str, dict], to: date, cal: Calendar) -> dict:
    """Forecast start/finish per activity from actual progress and dependencies (finish-to-start).

    Complete activities keep their actual finish. Started ones finish at their recent rate (or, with no
    recent output, at the planned rate, flagged). Not started ones start after their latest predecessor
    and no earlier than the planned start or the next working day after `to`.
    """
    by = {p.code: p for p in plans if p.planned_start}
    preds = {c: [x for x in by[c].predecessors if x in by] for c in by}
    order = topo_order(list(by), preds)
    start, finish, flags = {}, {}, defaultdict(list)
    tomorrow = cal.add_working_days(to, 1) if cal.is_working(to) else cal.next_working(to)
    for c in order:
        p, m = by[c], cum.get(c, {})
        dur = _duration(p, cal)
        after_preds = max((cal.add_working_days(finish[x], 1) for x in preds[c]), default=None)
        if m.get("complete"):
            start[c] = _d(m["actual_start"]) if m.get("actual_start") else p.planned_start
            finish[c] = _d(m["actual_finish"])
            continue
        if m.get("started"):
            start[c] = _d(m["actual_start"])
            if m.get("forecast_finish"):
                finish[c] = _d(m["forecast_finish"])
            else:
                remaining = max(float(m.get("planned_total") or 0) - float(m.get("actual_cum") or 0), 0)
                tpd = float(p.target_per_day or 0) or None
                need = math.ceil(remaining / tpd - 1e-9) if tpd else dur
                finish[c] = cal.add_working_days(to, max(need, 1))
                flags[c].append("assumed_plan_rate")
            continue
        es = cal.next_working(p.planned_start)
        if after_preds and after_preds > es:
            es = after_preds
        if es <= to:
            es = tomorrow
        start[c], finish[c] = es, cal.add_working_days(es, dur - 1)
    floats = backward_float(start, finish, {c: max(len(cal.working_days(start[c], finish[c])), 1) for c in by},
                            preds, cal) if by else {}
    return {"start": start, "finish": finish, "float": floats, "flags": dict(flags),
            "completion": max(finish.values()) if finish else None}


def milestone_forecast(milestones: list[dict], finish: dict[str, date], cal: Calendar, to: date) -> list[dict]:
    """Forecast each milestone from its activities' forecast finishes (or keep the plan when unlinked)."""
    out = []
    for m in milestones:
        planned = _d(m["planned_date"]) if m.get("planned_date") else None
        linked = [finish[c] for c in m.get("activity_codes") or [] if c in finish]
        forecast = max(linked) if linked else planned
        achieved = _d(m["achieved_date"]) if m.get("achieved_date") else None
        state = ("met" if achieved and planned and achieved <= planned else
                 "met_late" if achieved else
                 "missed" if planned and planned < to else "open")
        out.append({"code": m["code"], "name": m.get("name"), "planned_date": planned.isoformat() if planned else None,
                    "forecast_date": forecast.isoformat() if forecast else None,
                    "variance_days": cal.between(planned, forecast) if planned and forecast else None,
                    "contractual": bool(m.get("contractual")), "achieved_date": achieved.isoformat() if achieved else None,
                    "state": state, "linked": bool(linked), "refs": m.get("refs") or []})
    return out


def ld_exposure(days_late_calendar: int | None, ld: dict | None) -> dict | None:
    """Indicative liquidated-damages exposure: calendar days late x rate (capped when a cap amount is known)."""
    if not ld or not ld.get("amount") or not days_late_calendar or days_late_calendar <= 0:
        return None
    amount = float(ld["amount"]) * days_late_calendar
    cap = ld.get("cap_amount")
    return {"days_late": days_late_calendar, "rate": float(ld["amount"]), "currency": ld.get("currency"),
            "amount": r2(min(amount, float(cap)) if cap else amount), "capped": bool(cap and amount > float(cap)),
            "label": "indicative", "refs": ld.get("refs") or []}


def recovery(backlog_series: dict[str, list[tuple[date, float]]], target_per_day: dict[str, float | None],
             window_start: date) -> list[dict]:
    """Activities whose backlog fell since `window_start`, with the working days recovered."""
    out = []
    for code, series in backlog_series.items():
        before = [b for d, b in series if d < window_start]
        after = [b for d, b in series if d >= window_start]
        if not before or not after:
            continue
        start, end = before[-1], after[-1]
        tpd = target_per_day.get(code)
        if start > end + 1e-9 and start > 0:
            out.append({"code": code, "backlog_from": r2(start), "backlog_to": r2(end),
                        "days_recovered": r2((start - end) / tpd) if tpd else None})
    return out


# ------------------------------------------------------------------ attribution (7.2)

def is_excusable(cause: str | None, settings: dict, weather_days_used: int = 0) -> bool:
    """Client, designer and weather (beyond the plan's allowance, when one is set) are excusable."""
    if cause not in set(settings.get("excusable_causes") or []):
        return False
    if cause == "weather" and settings.get("weather_allowance_days") is not None:
        return weather_days_used >= float(settings["weather_allowance_days"])
    return True


def attribution_split(days_behind: float | None, demerits: list[dict]) -> dict:
    """Split the days behind by cause, weighted by each day's shortfall quantity (section 7.2)."""
    qty = defaultdict(float)
    excusable_qty = 0.0
    for e in demerits:
        q = float(e.get("quantity") or 0)
        if q <= 0:
            continue
        qty[e.get("cause_category") or "unknown"] += q
        if e.get("excusable"):
            excusable_qty += q
    total = sum(qty.values())
    behind = max(float(days_behind or 0), 0)
    if not total or not behind:
        return {"by_cause": {}, "excusable_days": 0.0, "non_excusable_days": r2(behind), "basis_qty": r2(total)}
    return {"by_cause": {c: r2(behind * q / total) for c, q in sorted(qty.items())},
            "excusable_days": r2(behind * excusable_qty / total),
            "non_excusable_days": r2(behind * (total - excusable_qty) / total), "basis_qty": r2(total),
            "label": "for review, not legal advice"}


# ------------------------------------------------------------------ ledger (7.3)

def _entry(rule_key, rules, work_date, subject, points, *, code=None, quantity=None, refs=(), detail=None,
           attribution=None):
    a = attribution or {}
    return {"work_date": work_date.isoformat() if isinstance(work_date, date) else work_date,
            "activity_code": code, "subject": subject, "rule_key": rule_key, "kind": rules[rule_key]["kind"],
            "points": r2(points), "quantity": r2(quantity), "refs": list(refs), "detail": detail or {},
            "cause_category": a.get("cause_category"), "responsible_party": a.get("responsible_party_ref"),
            "excusable": bool(a.get("excusable"))}


def ledger_for_day(work_date: date, results: list[dict], context: dict, indicators: dict, settings: dict) -> list[dict]:
    """Merit and demerit entries for one evaluated day (section 7.3). Pure: everything comes in `context`.

    context[code] = {"backlog_before", "target_per_day", "planned_total", "actual_cum_before",
                     "planned_finish", "attribution", "refs", "prev_late_severity"}
    indicators: equipment_idle [{equipment_id, hours, severity, attribution, refs}], quality_holds
                [{failed|passed, subject, refs}], milestones [{code, state, refs}], missing_report {..} or None
    """
    rules = settings["ledger_rules"]
    out = []
    for r in results:
        code = r["code"]
        ctx = context.get(code, {})
        refs, attr = ctx.get("refs") or r.get("refs") or [], ctx.get("attribution") or r.get("attribution")
        status, sev = r["status"], r["severity"]
        if status == "exceeded" and "day.exceeded" in rules:
            rule = rules["day.exceeded"]
            bonus = r.get("variance_pct") is not None and r["variance_pct"] >= float(rule.get("bonus_pct", 1e9))
            out.append(_entry("day.exceeded", rules, work_date, code,
                              rule.get("bonus_points", rule["points"]) if bonus else rule["points"], code=code,
                              quantity=r.get("variance"), refs=refs, detail={"variance_pct": r.get("variance_pct")}))
        if status in ("exceeded", "unplanned_work") and "backlog.recovered" in rules:
            backlog = float(ctx.get("backlog_before") or 0)
            excess = float(r.get("actual") or 0) - float(r.get("planned") or 0)
            tpd = float(ctx.get("target_per_day") or 0)
            if backlog > 0 and excess > 0 and tpd > 0:
                recovered = min(excess, backlog)
                days = recovered / tpd
                out.append(_entry("backlog.recovered", rules, work_date, code,
                                  rules["backlog.recovered"]["points_per_day"] * days, code=code, quantity=recovered,
                                  refs=refs, detail={"days_recovered": r2(days), "backlog_before": r2(backlog)}))
        if status == "behind" and sev in ("amber", "red"):
            key = "day.shortfall_red" if sev == "red" else "day.shortfall_amber"
            short = max(float(r.get("planned") or 0) - float(r.get("actual") or 0), 0)
            out.append(_entry(key, rules, work_date, code, rules[key]["points"], code=code, quantity=short, refs=refs,
                              attribution=attr, detail={"shortfall_pct": r.get("shortfall_pct"),
                                                        "escalated": r.get("escalated", False)}))
        if status == "late_start" and sev in ("amber", "red") and sev != ctx.get("prev_late_severity"):
            rule = rules["activity.late_start"]
            out.append(_entry("activity.late_start", rules, work_date, code,
                              rule["red_points"] if sev == "red" else rule["amber_points"], code=code,
                              quantity=float(r.get("planned") or ctx.get("target_per_day") or 0), refs=refs,
                              attribution=attr, detail={"days_late": r.get("days_late"), "severity": sev}))
        total, before = ctx.get("planned_total"), float(ctx.get("actual_cum_before") or 0)
        finish = ctx.get("planned_finish")
        if (total and finish and before < float(total) - 1e-9
                and before + float(r.get("actual") or 0) >= float(total) - 1e-9 and work_date < _d(finish)):
            out.append(_entry("activity.early_finish", rules, work_date, code, rules["activity.early_finish"]["points"],
                              code=code, refs=refs, detail={"planned_finish": str(finish)}))
    for idle in indicators.get("equipment_idle", []):
        if idle.get("severity") in ("amber", "red") and idle.get("hours"):
            rule = rules["equipment.idle"]
            out.append(_entry("equipment.idle", rules, work_date, f"equipment:{idle['equipment_id']}",
                              rule["full_shift_points"] if idle["severity"] == "red" else rule["points"],
                              code=idle.get("activity_code"), quantity=idle["hours"], refs=idle.get("refs") or [],
                              attribution=idle.get("attribution"), detail={"hours": idle["hours"]}))
    missing = indicators.get("missing_report")
    if missing and missing.get("after_sweep"):
        out.append(_entry("report.missing", rules, work_date, "report", rules["report.missing"]["points"],
                          refs=missing.get("refs") or [], detail={"activities": missing.get("activities", [])}))
    for q in indicators.get("quality_holds", []):
        if q.get("failed"):
            out.append(_entry("quality.hold_failed", rules, work_date, f"quality:{q['subject']}",
                              rules["quality.hold_failed"]["points"], code=q.get("activity_code"),
                              refs=q.get("refs") or [], attribution=q.get("attribution")))
        elif q.get("passed"):
            out.append(_entry("quality.first_time_pass", rules, work_date, f"quality:{q['subject']}",
                              rules["quality.first_time_pass"]["points"], code=q.get("activity_code"),
                              refs=q.get("refs") or []))
    for m in indicators.get("milestones", []):
        # The caller decides the event: "met" on the achievement day (on or before plan), "missed" on the
        # first evaluated working day after the planned date with the milestone still open.
        if m.get("event") in ("met", "missed"):
            key = f"milestone.{m['event']}"
            out.append(_entry(key, rules, work_date, f"milestone:{m['code']}", rules[key]["points"],
                              refs=m.get("refs") or [], detail={"planned_date": m.get("planned_date")}))
    return [e for e in out if e["rule_key"] in rules]


def score(entries: list[dict]) -> float:
    """score_to_date: accepted and proposed, non-excusable entries. Disputed and superseded are left out."""
    return r2(sum(float(e["points"]) for e in entries
                  if e.get("status", "proposed") in ("proposed", "accepted") and not e.get("excusable")))


def weekly(entries: list[dict]) -> list[dict]:
    weeks = defaultdict(lambda: {"merits": 0.0, "demerits": 0.0, "score": 0.0})
    for e in entries:
        if e.get("status", "proposed") not in ("proposed", "accepted") or e.get("excusable"):
            continue
        y, w, _ = _d(e["work_date"]).isocalendar()
        bucket = weeks[f"{y}-W{w:02d}"]
        bucket["merits" if e["kind"] == "merit" else "demerits"] += float(e["points"])
        bucket["score"] += float(e["points"])
    return [{"week": k, **{x: r2(v) for x, v in b.items()}} for k, b in sorted(weeks.items())]


def best_worst_days(entries: list[dict], n: int = 5) -> tuple[list[dict], list[dict]]:
    days = defaultdict(float)
    for e in entries:
        if e.get("status", "proposed") in ("proposed", "accepted") and not e.get("excusable"):
            days[e["work_date"]] += float(e["points"])
    ranked = sorted(days.items(), key=lambda kv: (kv[1], kv[0]))
    worst = [{"work_date": d, "points": r2(p)} for d, p in ranked if p < 0][:n]
    best = [{"work_date": d, "points": r2(p)} for d, p in sorted(days.items(), key=lambda kv: (-kv[1], kv[0])) if p > 0][:n]
    return best, worst


def overall_status(spi_band: str | None, completion_variance_days: int | None, settings: dict) -> str:
    """ahead | on_plan | at_risk | delayed, from the SPI band and the forecast completion (code, not model)."""
    th = settings["thresholds"]["finish_variance_days"]
    var = completion_variance_days or 0
    if spi_band == "red" or var >= int(th["red"]):
        return "delayed"
    if spi_band == "amber" or var >= int(th["amber"]):
        return "at_risk"
    if spi_band == "green" and var < 0:
        return "ahead"
    return "on_plan"


# ------------------------------------------------------------------ correspondence suggestions (6.7)

def notice_rule(settings: dict, notice_type: str) -> dict | None:
    return next((r for r in settings.get("notice_rules") or [] if r.get("type") == notice_type), None)


def notice_deadline(event_date: date, rule: dict, cal: Calendar) -> date:
    """Deadline counted in working days on the project calendar. A stated number of working days wins over
    "without delay" ("without delay, and within 5 working days" = 5); "immediately" with no number = the same day."""
    n = rule.get("deadline_wd")
    return cal.add_working_days(event_date, int(n) if n is not None else 0)


def equipment_rate(settings: dict, equipment_id: str | None, description: str | None) -> dict | None:
    """The plan's idle/standby rate for a machine, matched by ID, then by description words."""
    rates = (settings.get("rates") or {}).get("equipment") or []
    for rate in rates:
        if equipment_id and equipment_id in (rate.get("equipment_ids") or []):
            return rate
    words = {w for w in (description or "").lower().replace("-", " ").split() if len(w) > 3}
    for rate in rates:
        item = (rate.get("item") or "").lower()
        if words and any(w in item for w in words):
            return rate
    return None


def suggest_notices(work_date: date, results: list[dict], indicators: dict, instructions: list[dict],
                    settings: dict, cal: Calendar) -> list[dict]:
    """Suggested correspondence (never drafted or sent automatically). Each carries type, deadline, reason, refs."""
    out = []
    delay = notice_rule(settings, "delay_notice")
    delay_causes = set((delay or {}).get("causes") or ["client", "designer", "supplier", "third_party"])
    for r in results:
        attr = r.get("attribution") or {}
        if (delay and r["severity"] == "red" and r.get("is_critical")
                and attr.get("cause_category") in delay_causes):
            out.append({"type": "delay_notice", "activity_code": r["code"],
                        "deadline": notice_deadline(work_date, delay, cal).isoformat(),
                        "reason": (f"Red deviation on critical activity {r['code']} "
                                   f"({r.get('shortfall_pct') or r.get('days_late')}{'%' if r.get('shortfall_pct') else ' days late'}); "
                                   f"cause recorded as {attr['cause_category']}"),
                        "refs": list(dict.fromkeys((attr.get("refs") or []) + (r.get("refs") or []))),
                        "addressee_role": delay.get("addressee_role"), "rule_refs": delay.get("refs") or []})
    cost = notice_rule(settings, "additional_cost_notice")
    for idle in indicators.get("equipment_idle", []):
        attr = idle.get("attribution") or {}
        if cost and idle.get("severity") == "red" and attr.get("cause_category") not in (None, "unknown",
                                                                                          "contractor_internal"):
            rate = idle.get("rate")
            days = r2(float(idle["hours"]) / float(settings["calendar"].get("shift_hours") or 8))
            amount = r2(float(rate["amount"]) * days) if rate and rate.get("amount") and rate.get("per") == "day" else \
                r2(float(rate["amount"]) * float(idle["hours"])) if rate and rate.get("amount") and rate.get("per") == "hour" else None
            out.append({"type": "additional_cost_notice", "activity_code": idle.get("activity_code"),
                        "equipment_id": idle["equipment_id"], "deadline": notice_deadline(work_date, cost, cal).isoformat(),
                        "reason": f"{idle['equipment_id']} idle {idle['hours']} h, caused by {attr['cause_category']}",
                        "amount": amount, "currency": (rate or {}).get("currency"),
                        "calculation": f"{rate['amount']} {rate.get('currency') or ''}/{rate.get('per')} x {days if rate.get('per') == 'day' else idle['hours']}"
                        if amount is not None else "[MISSING: idle rate]",
                        "refs": list(dict.fromkeys((attr.get("refs") or []) + (idle.get("refs") or []))),
                        "addressee_role": cost.get("addressee_role"), "rule_refs": cost.get("refs") or []})
    defect = notice_rule(settings, "defect_notice")
    for q in indicators.get("quality_holds", []):
        attr = q.get("attribution") or {}
        if defect and q.get("defect") and attr.get("cause_category") in ("subcontractor", "client", "supplier",
                                                                          "designer", "third_party"):
            out.append({"type": "defect_notice", "activity_code": q.get("activity_code"),
                        "deadline": notice_deadline(work_date, defect, cal).isoformat(),
                        "reason": f"Defect recorded in work or material of others ({attr['cause_category']})",
                        "refs": q.get("refs") or [], "addressee_role": defect.get("addressee_role"),
                        "rule_refs": defect.get("refs") or []})
    concern = notice_rule(settings, "notice_of_concern")
    for item in instructions:
        if concern and item.get("concern"):
            out.append({"type": "notice_of_concern", "activity_code": item.get("activity_code"),
                        "deadline": notice_deadline(work_date, concern, cal).isoformat(),
                        "reason": f"Instruction or design concern: {item.get('text', '')[:160]}",
                        "refs": item.get("refs") or [], "addressee_role": concern.get("addressee_role"),
                        "rule_refs": concern.get("refs") or []})
    return out
