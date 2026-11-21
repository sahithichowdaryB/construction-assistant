"""Exercise the running HTTP API against the Riverside evaluation fixture."""

import json
import os
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
load_dotenv(HERE / ".env")
BASE = "http://127.0.0.1:8000"


def fetch(path, *, authorize=True):
    headers = {"Authorization": "Bearer " + os.environ["RIVERSIDE_DEMO_TOKEN"]} if authorize else {}
    with urlopen(Request(BASE + path, headers=headers), timeout=15) as response:
        return response.read()


def reading(code, day, as_of=None):
    params = {"date": day}
    if as_of:
        params["as_of"] = as_of
    route = f"/projects/RIV/activities/{code}/progress?" + urlencode(params)
    return json.loads(fetch(route))


if __name__ == "__main__":
    fixture = HERE.parent / "data/riverside-demo/evaluation/ground_truth.json"
    key = json.loads(fixture.read_text(encoding="utf-8"))
    for case in key["progress_after_all_reports"]:
        data = reading(case["activity_id"], case["date"])
        assert (data["planned"], data["actual"], data["unit"], data["severity"]) == (
            case["planned"], case["actual"], case["unit"], case["severity"]), case
    prior = reading("EXC-B", "2026-11-10", "2026-11-10T17:29:00+01:00")
    assert prior["actual"] == 70 and prior["basis"] == "estimated" and prior["severity"] is None
    after = reading("EXC-B", "2026-11-10", "2026-11-10T17:30:00+01:00")
    assert after["shortfall_pct"] == 35 and after["evidence"]["page"] == 2
    assert [row["quantity"] for row in after["observations"]] == [65, 70]
    assert reading("EXC-B", "2026-11-11", "2026-11-11T17:30:00+01:00")["actual"] is None
    assert reading("EXC-B", "2026-11-11", "2026-11-12T07:15:00+01:00")["actual"] == 80
    assert reading("EXC-B", "2026-11-12")["shortfall_pct"] is None
    assert fetch("/projects/RIV/sources/R10/file").startswith(b"%PDF")
    alerts = json.loads(fetch("/projects/RIV/alerts"))
    assert len(alerts) == 6
    assert sorted(a["severity"] for a in alerts) == ["high"] * 2 + ["medium"] * 4
    cutoff = urlencode({"as_of": "2026-11-10T17:29:00+01:00"})
    assert len(json.loads(fetch("/projects/RIV/alerts?" + cutoff))) == 2
    for route, authorized, status in [
        ("/projects/RIV/activities/EXC-B/progress?date=2026-11-10", False, 401),
        ("/projects/OTHER/sources/R10/file", True, 403),
        ("/projects/RIV/sources/R11/file?as_of=2026-11-11T17%3A30%3A00%2B01%3A00", True, 404),
    ]:
        try:
            fetch(route, authorize=authorized)
        except HTTPError as exc:
            assert exc.code == status, (route, exc.code)
        else:
            raise AssertionError(f"Unexpectedly allowed {route}")
    print("Passed: 50 activity/day results, historical readings, PDF retrieval and project access.")
