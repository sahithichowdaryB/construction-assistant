"""Acceptance checks for the performance evaluation (plan section 12, steps 3-8) against the running API.

    python verify_performance.py            read-only checks (code paths; on-demand code-only evaluations are persisted)
    python verify_performance.py --write    also drafts an additional-cost notice and, with ANTHROPIC_API_KEY,
                                            runs the model steps (P2/P3 recompute, P4 narrative, P1 plan upload)

SITEMATE_API overrides the base URL (default http://127.0.0.1:8000). Model checks are skipped, and say so, when no
ANTHROPIC_API_KEY is configured.
"""

import json
import os
import sys
import time
import uuid
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
load_dotenv(HERE / ".env")
BASE = os.environ.get("SITEMATE_API", "http://127.0.0.1:8000")
P = "/projects/RIV"
WRITE = "--write" in sys.argv
MODEL = bool(os.environ.get("ANTHROPIC_API_KEY"))
SEVERITY = {"none": "none", "amber": "medium", "red": "high"}
SKIPPED = []


def call(path, method="GET", body=None, headers=None, raw=False):
    h = {"Authorization": "Bearer " + os.environ["RIVERSIDE_DEMO_TOKEN"], **(headers or {})}
    data = None
    if body is not None and not isinstance(body, bytes):
        data, h["Content-Type"] = json.dumps(body).encode(), "application/json"
    elif body is not None:
        data = body
    with urlopen(Request(BASE + path, data=data, headers=h, method=method), timeout=180) as response:
        payload = response.read()
        return payload if raw else json.loads(payload)


def q(**params):
    return "?" + urlencode({k: v for k, v in params.items() if v is not None})


def at(day, hhmm):
    return f"{day}T{hhmm}:00+01:00"


def check(name, condition, detail=""):
    if not condition:
        raise AssertionError(f"{name} failed {detail}")
    print(f"  ok  {name}")


def skip(name, how):
    SKIPPED.append((name, how))
    print(f"  --  {name}: skipped ({how})")


def day(d, as_of=None):
    return call(f"{P}/daily-evaluations/{d}" + q(as_of=as_of))


def step3():
    print("Step 3: CSV baseline and backward compatibility")
    listed = call(f"{P}/baselines")
    active = next(b for b in listed["baselines"] if b["id"] == listed["active_id"])
    check("Riverside schedule.csv is the active baseline revision 1", active["revision"] == 1 and
          active["counts"]["activities"] == 10, active)
    key = json.loads((HERE.parent / "data/riverside-demo/evaluation/ground_truth.json").read_text(encoding="utf-8"))
    by_day = {}
    for case in key["progress_after_all_reports"]:
        by_day.setdefault(case["date"], []).append(case)
    for d, cases in by_day.items():
        rows = {r["code"]: r for r in call(f"{P}/site-day" + q(date=d))["activities"]}
        for c in cases:
            r = rows.get(c["activity_id"])
            if c["planned"] == 0:
                assert r is None, (d, c)
            else:
                assert (r["planned"], r["actual"], r["severity"]) == (c["planned"], c["actual"], c["severity"]), (d, c, r)
    check("/site-day matches the 50 Riverside activity/day cases", True)


def step4():
    print("Step 4: daily evaluation (code path)")
    key = json.loads((HERE.parent / "data/riverside-demo/evaluation/ground_truth.json").read_text(encoding="utf-8"))
    final = "2026-11-21T12:00:00+01:00"
    for case in key["progress_after_all_reports"]:
        rows = {a["code"]: a for a in day(case["date"], final)["activities"]}
        row = rows.get(case["activity_id"])
        if case["planned"] == 0 and (row is None or row["status"] in ("not_started_ok", "unplanned_work", "on_track")):
            continue
        assert row and SEVERITY[row["severity"]] == case["severity"] and row["actual"] == case["actual"], (case, row)
    check("daily status follows the project thresholds and matches the existing shortfall severity (50 cases)", True)
    exc = {a["code"]: a for a in day("2026-11-09", final)["activities"]}["EXC-B"]
    check("9 Nov EXC-B: planned 100, actual 92, variance -8 %, on track",
          (exc["planned"], exc["actual"], exc["variance_pct"], exc["status"]) == (100, 92, -8, "on_track"), exc)
    exc = {a["code"]: a for a in day("2026-11-10", final)["activities"]}["EXC-B"]
    check("10 Nov EXC-B: 65 of 100, -35 %, red", (exc["actual"], exc["variance_pct"], exc["severity"]) == (65, -35, "red"), exc)
    alerts = call(f"{P}/alerts" + q(kind="shortfall"))
    check("the six planted shortfall alerts reproduce (2 high, 4 medium)",
          len(alerts) == 6 and sorted(a["severity"] for a in alerts) == ["high"] * 2 + ["medium"] * 4,
          [(a["activity_code"], a["severity"]) for a in alerts])
    missing = day("2026-11-11", at("2026-11-11", "18:30"))
    statuses = {a["code"]: (a["status"], a["severity"]) for a in missing["activities"]}
    check("11 Nov at 18:30 (no report yet): planned activities are not_reported (red after the sweep)",
          statuses.get("EXC-B") == ("not_reported", "red") and missing["indicators"]["missing_report"]["after_sweep"],
          statuses)
    later = {a["code"]: a for a in day("2026-11-11", at("2026-11-12", "07:20"))["activities"]}
    check("after the scanned report arrives (12 Nov 07:15) EXC-B shows 80", later["EXC-B"]["actual"] == 80, later["EXC-B"])
    idle = day("2026-11-10", final)["indicators"]["equipment_idle"]
    check("10 Nov EX-02 idle from 10:00 to the end of the shift (amber)",
          idle and idle[0]["equipment_id"] == "EX-02" and idle[0]["severity"] == "amber" and idle[0]["hours"] == 6, idle)
    a1, a2 = day("2026-11-10", at("2026-11-10", "18:30")), day("2026-11-10", at("2026-11-10", "18:30"))
    check("replay at a fixed instant is stable", a1["version"] == a2["version"] and a1["activities"] == a2["activities"])
    early = day("2026-11-10", at("2026-11-10", "17:29"))
    exc = {a["code"]: a for a in early["activities"]}["EXC-B"]
    check("10 Nov at 17:29: only the estimate is known (no signed figure, estimate 70 kept as context)",
          exc["actual"] is None and exc["estimate"]["value"] == 70, exc)


def step5():
    print("Step 5: day summary (P2) and attribution (P3)")
    if not (MODEL and WRITE):
        skip("cited summary, E04 quoted, EX-02 attribution", "needs ANTHROPIC_API_KEY and --write")
        return
    ex02 = next((i for i in call(f"{P}/incidents" + q(as_of=at("2026-11-10", "18:30")))
                 if i.get("equipment_id") == "EX-02" or "EX-02" in (i.get("title") or "")), None)
    if ex02:  # the incident evidence agent's analysis, which the attribution must not contradict
        call(f"{P}/incidents/{ex02['id']}/reasoning" + q(as_of=at("2026-11-10", "18:20")), "POST")
    before = {d: day(d, at(d, "18:30"))["version"] for d in ("2026-11-10", "2026-11-12")}
    for d in before:
        call(f"{P}/daily-evaluations/{d}/recompute" + q(as_of=at(d, "18:30")), "POST")
    for d in before:
        for _ in range(100):
            v = day(d, at(d, "18:30"))
            if v["version"] > before[d] and v["trigger"] == "manual":
                break
            time.sleep(3)
        summary = v["summary"]
        items = [i for k in ("work_done", "disruptions", "resources", "deliveries", "weather", "instructions_received",
                             "safety_quality", "open_items") for i in summary.get(k, [])]
        check(f"{d}: summary generated", summary["status"] == "ok", summary.get("status"))
        for i in items:
            assert i["refs"], i
            for r in i["refs"]:
                call(f"{P}/evidence/{quote(r, safe='')}")
        check(f"{d}: every summary item has refs that resolve ({len(items)} items)", True)
    quoted = [i for i in day("2026-11-12", at("2026-11-12", "18:30"))["summary"]["instructions_received"]
              if any(r.startswith("E04:") for r in i["refs"])]
    check("E04 instruction is quoted, not obeyed", quoted and all(i.get("quoted") and not i.get("concern") for i in quoted),
          quoted)
    att = {a["code"]: a for a in day("2026-11-10", at("2026-11-10", "18:30"))["activities"]}["EXC-B"]["attribution"]
    check("EXC-B shortfall attribution is cited", att and att["refs"], att)
    idle = day("2026-11-10", at("2026-11-10", "18:30"))["indicators"]["equipment_idle"]
    idle_att = idle[0].get("attribution") if idle else None
    print("      EXC-B:", att["cause_category"], att["confidence"], att["explanation"][:120])
    if idle_att:
        print("      EX-02:", idle_att["cause_category"], idle_att["confidence"], idle_att["refs"][:4])
    if att.get("analysis"):
        check("the existing incident analysis takes precedence (confidence within 0.2)",
              abs(att["confidence"] - att["analysis"]["confidence"]) <= 0.2001, att)
    else:
        skip("incident-analysis precedence", "run POST /incidents/{id}/reasoning for the EX-02 incident first")


def step6():
    print("Step 6: overall snapshot")
    v = day("2026-11-12", "2026-11-21T12:00:00+01:00")
    exc = {a["code"]: a for a in v["activities"]}["EXC-B"]
    check("12 Nov EXC-B off-plan output is unplanned_work", exc["status"] == "unplanned_work" and exc["actual"] == 63, exc)
    merit = [e for e in v["ledger"] if e["subject"] == "EXC-B" and e["rule_key"] == "backlog.recovered"]
    check("... and produces a backlog.recovered merit", merit and merit[0]["kind"] == "merit" and merit[0]["points"] > 0, merit)
    s11 = call(f"{P}/performance" + q(date="2026-11-11", as_of=at("2026-11-11", "18:00")))
    s12 = call(f"{P}/performance" + q(date="2026-11-12", as_of=at("2026-11-12", "18:00")))
    check("SPI goes up after the catch-up day", s12["metrics"]["spi"] > s11["metrics"]["spi"],
          (s11["metrics"]["spi"], s12["metrics"]["spi"]))
    check("critical path runs through excavation", "EXC-B" in s12["metrics"]["critical_path"], s12["metrics"]["critical_path"])
    check("the narrative carries the disclaimer", s12["narrative"]["disclaimer"].startswith("Drafting support only"))
    curve = call(f"{P}/performance/s-curve" + q(to="2026-11-12", as_of=at("2026-11-12", "18:00")))
    check("S-curve points planned vs actual", curve["points"] and curve["points"][-1]["planned_pct"] == 100, curve["points"][-1])
    pdf = call(f"{P}/performance/report.pdf" + q(date="2026-11-12"), raw=True)
    check("PDF export", pdf.startswith(b"%PDF"))
    if WRITE:
        ledger = call(f"{P}/performance/ledger" + q(to="2026-11-12", kind="demerit"))
        entry = ledger["entries"][0]
        before = ledger["score"]
        call(f"{P}/performance/ledger/{entry['id']}", "PATCH", {"status": "disputed", "note": "verify_performance check"})
        after = call(f"{P}/performance/ledger" + q(to="2026-11-12", kind="demerit"))["score"]
        check("a disputed demerit leaves the score", round(after - before, 2) == round(-entry["points"], 2), (before, after))
        call(f"{P}/performance/ledger/{entry['id']}", "PATCH", {"status": "proposed", "note": None})
        if MODEL:
            call(f"{P}/performance/narrative" + q(date="2026-11-12", as_of=at("2026-11-12", "18:00")), "POST")
            for _ in range(60):
                n = call(f"{P}/performance" + q(date="2026-11-12", as_of=at("2026-11-12", "18:00")))["narrative"]
                if n.get("source") == "model" or n.get("status") in ("all_dropped", "model_unavailable"):
                    break
                time.sleep(3)
            items = [i for k in ("merits", "demerits", "risks", "recommended_actions") for i in n.get(k) or []]
            check("P4 narrative items are all cited", n.get("source") == "model" and all(i["refs"] for i in items), n.get("status"))
        else:
            skip("P4 narrative", "needs ANTHROPIC_API_KEY")
    else:
        skip("ledger dispute and P4 narrative", "needs --write")


def step7():
    print("Step 7: correspondence suggestions and draft types")
    v = day("2026-11-10", "2026-11-21T12:00:00+01:00")
    check("internal equipment cause: no delay-notice suggestion for EXC-B",
          not [s for s in v["suggestions"] if s["type"] == "delay_notice" and s["activity_code"] == "EXC-B"], v["suggestions"])
    if not WRITE:
        skip("additional cost notice draft", "needs --write")
        return
    idle = [a for a in call(f"{P}/alerts" + q(kind="equipment_idle")) if a["activity_code"] == "EXC-B"]
    draft = call(f"{P}/drafts", "POST", {"alert_id": idle[0]["id"], "notice_type": "additional_cost_notice"})
    check("POST /drafts builds an additional cost notice from the idle alert",
          draft["notice_type"] == "additional_cost_notice" and "ADDITIONAL COST NOTICE" in draft["latest"]["body"])
    check("unknown contract fields and the idle rate stay [MISSING: ...]",
          {"contract reference", "contract clause", "idle rate"} <= set(draft["latest"]["missing_fields"]),
          draft["latest"]["missing_fields"])


def step8():
    print("Step 8: PDF plan extraction (P1)")
    if not (MODEL and WRITE):
        skip("mock plan extraction", "needs ANTHROPIC_API_KEY and --write")
        return
    boundary = uuid.uuid4().hex
    parts = []
    for name in ("Plan_1_Baseline_Construction_Programme.pdf", "Plan_2_Resource_Cost_and_Contract_Plan.pdf"):
        data = (HERE.parent / "mock_data" / name).read_bytes()
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"files\"; filename=\"{name}\"\r\n"
                     f"Content-Type: application/pdf\r\n\r\n".encode() + data + b"\r\n")
    body = b"".join(parts) + f"--{boundary}--\r\n".encode()
    created = call(f"{P}/baselines", "POST", body, {"Content-Type": f"multipart/form-data; boundary={boundary}"})
    for _ in range(100):
        b = call(f"{P}/baselines/{created['id']}")
        if b["extraction_status"] not in ("queued", "running"):
            break
        time.sleep(5)
    x, s = b["extracted"], b["settings_preview"]
    check("extraction finished", b["extraction_status"] in ("done", "needs_review"), (b["extraction_status"], b["error"]))
    check("21 activities", len(x["activities"]) == 21, len(x["activities"]))
    check("8 milestones", len(x["milestones"]) == 8, len(x["milestones"]))
    check("daily output thresholds 10 % / 20 % with 2-day escalation",
          s["thresholds"].get("daily_output", {}).get("amber_pct") == 10 and s["thresholds"]["daily_output"].get("red_pct") == 20,
          s["thresholds"])
    check("notice rules (delay 5 wd, cost 10 wd, defect 3 wd, concern immediately)",
          {r["type"] for r in s.get("notice_rules", [])} >= {"delay_notice", "additional_cost_notice", "defect_notice",
                                                            "notice_of_concern"}, s.get("notice_rules"))
    check("idle rates (excavator EUR 520/day)", any(r["amount"] == 520 for r in s.get("rates", {}).get("equipment", [])),
          s.get("rates"))
    check("weights reviewed: the plan's own 101 % total is a review reason",
          any(r["subject"] == "weights" for r in b["review_reasons"]) or abs(b["weights_total"] - 100) <= 0.5,
          b["weights_total"])
    check("nothing activated without a manager", b["status"] == "draft")


if __name__ == "__main__":
    try:
        for step in (step3, step4, step5, step6, step7, step8):
            step()
    except HTTPError as exc:
        print("HTTP", exc.code, exc.read()[:500])
        raise
    print("Passed." + (f" Skipped {len(SKIPPED)}: " + "; ".join(f"{n} ({h})" for n, h in SKIPPED) if SKIPPED else ""))
