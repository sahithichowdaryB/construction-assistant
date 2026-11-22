"""Acceptance checks for the features added after the performance module, against the running API (Riverside).

    python verify_workflows.py            read-only checks
    python verify_workflows.py --write    also confirms R10's readings (idempotent), drafts the 10 Nov daily report,
                                          and, with ANTHROPIC_API_KEY, asks the 15 Riverside retrieval questions

Covers: capabilities, project and activity reads, reading review (T3, T7), alert context (FND-B at risk), the stored
export audit, Ask SiteMate grounding (15 questions, cross-project isolation T10) and the daily report draft.
SITEMATE_API overrides the base URL (default http://127.0.0.1:8000). Skipped checks are listed, never counted as passed.
"""

import json
import os
import sys
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
load_dotenv(HERE / ".env")
BASE = os.environ.get("SITEMATE_API", "http://127.0.0.1:8000")
P = "/projects/RIV"
WRITE = "--write" in sys.argv
MODEL = bool(os.environ.get("ANTHROPIC_API_KEY"))
AT_REPORT = quote("2026-11-10T18:00:00+01:00")
RESULTS, SKIPPED = [], []


def call(path, method="GET", body=None, token=None):
    headers = {"Authorization": "Bearer " + (token or os.environ["RIVERSIDE_DEMO_TOKEN"])}
    data = None
    if body is not None:
        data, headers["Content-Type"] = json.dumps(body).encode(), "application/json"
    try:
        with urlopen(Request(BASE + path, data=data, headers=headers, method=method), timeout=180) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw[:1] in (b"{", b"[") else raw)
    except HTTPError as exc:
        raw = exc.read()
        return exc.code, (json.loads(raw) if raw[:1] in (b"{", b"[") else raw)


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok)))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""))


def main():
    status, caps = call("/health/capabilities")
    check("capabilities report db/llm/stt/worker", status == 200 and {"db", "llm", "stt", "worker"} <= set(caps), caps)
    if not caps.get("worker"):
        print("note  no worker heartbeat in the last 10 minutes (python worker.py)")

    status, project = call(P)
    check("project info (thresholds 15/25)", status == 200 and project["thresholds"] == {"deviation_pct": 15, "high_above_pct": 25})
    status, acts = call(f"{P}/activities")
    check("activity register with planned dates", status == 200 and any(a["code"] == "EXC-B" for a in acts))

    status, readings = call(f"{P}/sources/R10/readings")
    if status == 200:
        rows = {r["locator"]: r for r in readings["readings"]}
        check("R10 EXC-B reading is 65 m3 (T3)", rows.get("EXC-B", {}).get("value") == 65)
        if WRITE:
            status, out = call(f"{P}/sources/R10/readings/confirm?as_of={AT_REPORT}", "POST", {"all_signed": True})
            check("confirming R10 readings succeeds (idempotent)", status == 200, out)
            status, again = call(f"{P}/sources/R10/readings/confirm?as_of={AT_REPORT}", "POST", {"all_signed": True})
            check("re-confirming writes nothing new", status in (200, 422) and not (again or {}).get("reviews"), again)
    else:
        SKIPPED.append("R10 readings (source not parsed: python -m documents.ingest --source R10)")

    status, prog = call(f"{P}/activities/EXC-B/progress?date=2026-11-10&as_of={quote('2026-11-10T17:29:00+01:00')}")
    check("70 m3 estimate before the signed report (T7)", status == 200 and prog["actual"] == 70 and prog["basis"] == "estimated")

    status, alerts = call(f"{P}/alerts?as_of={AT_REPORT}")
    exc = next((a for a in alerts if a.get("activity_code") == "EXC-B" and a["kind"] == "shortfall"), None) if status == 200 else None
    if exc:
        status, ctx = call(f"{P}/alerts/{exc['id']}/context?as_of={AT_REPORT}")
        check("alert context names FND-B at risk", status == 200 and any(s["code"] == "FND-B" for s in ctx["successors_at_risk"]), ctx)
    else:
        SKIPPED.append("alert context (no EXC-B shortfall alert at 18:00 on 10 Nov)")

    status, drafts = call(f"{P}/drafts")
    if status == 200:
        approved = [d for d in drafts if any((v.get("review") or {}).get("decision") == "approved" for v in d["versions"])]
        for d in approved[:1]:
            v = next(v["version"] for v in reversed(d["versions"]) if (v.get("review") or {}).get("decision") == "approved")
            s1, e1 = call(f"{P}/drafts/{d['id']}/versions/{v}/exports", "POST", {"format": "pdf"})
            s2, e2 = call(f"{P}/drafts/{d['id']}/versions/{v}/exports", "POST", {"format": "pdf"})
            check("stored export is identical on repeat", s1 in (200, 201) and e1.get("sha256") == e2.get("sha256"), (e1, e2))
        if not approved:
            SKIPPED.append("stored export (no approved notice yet)")
    else:
        SKIPPED.append(f"drafts ({status}: the demo token may not be a manager)")

    if WRITE:
        status, rep = call(f"{P}/daily-reports?as_of={AT_REPORT}", "POST", {"work_date": "2026-11-10"})
        body = (rep.get("draft") or {}).get("latest", {}).get("body", "") if status == 201 else ""
        check("daily report draft cites R10 and shows 65 of 100", "R10 · EXC-B" in body and "signed 65" in body, status)

    if MODEL:
        key = json.loads((HERE.parent / "data/riverside-demo/evaluation/ground_truth.json").read_text(encoding="utf-8"))
        hits = 0
        for case in key["retrieval_questions"]:
            status, out = call(f"{P}/ask", "POST", {"question": case["question"]})
            cited = {c["source_id"] for c in out.get("citations", [])} if status == 200 else set()
            hits += case["expected_source"] in cited
            print(f"      {'hit ' if case['expected_source'] in cited else 'miss'} {case['expected_source']:4} {case['question']}")
        check("Ask cites the expected source for at least 13 of 15 questions", hits >= 13, f"{hits}/15")
    else:
        SKIPPED.append("Ask retrieval (no ANTHROPIC_API_KEY)")
    other = os.environ.get("TST_DEMO_TOKEN")
    if other:
        status, _ = call(f"{P}/ask", "POST", {"question": "Who flagged the overdue excavator service?"}, token=other)
        check("a member of another project cannot ask about Riverside (T10)", status in (401, 403, 404))
    else:
        SKIPPED.append("cross-project isolation (no TST_DEMO_TOKEN)")

    failed = [n for n, ok in RESULTS if not ok]
    print(f"\n{len(RESULTS) - len(failed)} passed, {len(failed)} failed, {len(SKIPPED)} skipped")
    for s in SKIPPED:
        print("skipped:", s)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
