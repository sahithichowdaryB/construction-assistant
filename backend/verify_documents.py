"""Check the P4 documents and search acceptance criteria against the running API.

This harness is the only code that reads data/riverside-demo/evaluation/; the answer key never
enters application retrieval. Run the API first, then:
    .venv/Scripts/python.exe verify_documents.py [--no-rerank]
"""

import json
import os
import sys
import time
import uuid
from datetime import datetime
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
load_dotenv(HERE / ".env")
BASE = os.environ.get("SITEMATE_API", "http://127.0.0.1:8000")
PACK = HERE.parent / "data/riverside-demo"
TOKEN = os.environ["RIVERSIDE_DEMO_TOKEN"]
failures = []


def call(path, *, method="GET", body=None, headers=None, token=TOKEN):
    headers = dict(headers or {})
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = Request(BASE + path, data=body, method=method, headers=headers)
    with urlopen(request, timeout=120) as response:
        return json.loads(response.read() or b"null")


def status_of(path, **kwargs):
    try:
        call(path, **kwargs)
        return 200
    except HTTPError as exc:
        return exc.code


def check(name, condition, detail=""):
    print(("PASS " if condition else "FAIL ") + name + (f"  ({detail})" if detail and not condition else ""))
    if not condition:
        failures.append(name)


def multipart(fields, filename, data):
    boundary = uuid.uuid4().hex
    parts = [f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
             for k, v in fields.items()]
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
                 f"Content-Type: application/octet-stream\r\n\r\n".encode() + data + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), {"Content-Type": f"multipart/form-data; boundary={boundary}"}


def retrieval(rerank):
    key = json.loads((PACK / "evaluation/ground_truth.json").read_text(encoding="utf-8"))
    hits1 = hits3 = 0
    reciprocal = 0.0
    for case in key["retrieval_questions"]:
        params = urlencode({"q": case["question"], "limit": 10, "rerank": str(rerank).lower()})
        data = call(f"/projects/RIV/search?{params}")
        ranked = list(dict.fromkeys(r["source_id"] for r in data["results"]))
        rank = ranked.index(case["expected_source"]) + 1 if case["expected_source"] in ranked else None
        hits1 += rank == 1
        hits3 += bool(rank and rank <= 3)
        reciprocal += 1 / rank if rank else 0
        print(f"   {'ok ' if rank == 1 else 'top3' if rank and rank <= 3 else 'MISS'} "
              f"{case['expected_source']:4} rank={rank} got={ranked[:3]} q={case['question']}")
    n = len(key["retrieval_questions"])
    print(f"   hit@1 {hits1}/{n}  hit@3 {hits3}/{n}  MRR {reciprocal / n:.2f}  reranked={data['reranked']}")
    check("retrieval: expected source in top 3 for every question", hits3 == n, f"{hits3}/{n}")


def main():
    rerank = "--no-rerank" not in sys.argv
    print("== Retrieval (15 Riverside questions)")
    retrieval(rerank)

    print("== Report extraction")
    ev = call("/projects/RIV/evidence/R10:EXC-B")
    check("R10 EXC-B signed 65 m³ cites page 2",
          ev["passage"]["page"] == 2 and "65 m³" in ev["passage"]["text"] and ev["source"]["mime"] == "application/pdf", ev)
    readings = call("/projects/RIV/sources/R10/readings")["readings"]
    exc_b = next(p for p in readings if p["activity_code"] == "EXC-B")
    check("R10 reading EXC-B = 65 signed and already accepted",
          exc_b["value"] == 65 and exc_b["basis"] == "signed" and exc_b["review_status"] == "accepted", exc_b)
    r11 = call("/projects/RIV/sources/R11/readings")
    values = {p["activity_code"]: p["value"] for p in r11["readings"]}
    check("R11 scanned page OCR gives EXC-B 80 and REBAR-L1 4",
          values.get("EXC-B") == 80 and values.get("REBAR-L1") == 4, r11)
    check("D10 keeps the provisional 70 m³ estimate",
          "70 m³" in call("/projects/RIV/evidence/D10:handover")["passage"]["text"])
    sources = call("/projects/RIV/sources")
    check("source list matches the frontend Source shape",
          len(sources) >= 29 and all({"id", "type", "title", "filename", "mime", "status"} <= set(s) for s in sources))
    detail = call("/projects/RIV/sources/R10")
    check("source detail carries passages with ids", any(p["id"] == "R10:EXC-B" for p in detail["passages"]))

    print("== Time and isolation")
    before = urlencode({"as_of": "2026-11-11T17:30:00+01:00"})
    after = urlencode({"as_of": "2026-11-12T07:15:00+01:00"})
    check("R11 hidden at 17:30 on 11 Nov", status_of(f"/projects/RIV/sources/R11?{before}") == 404)
    check("R11 available at 07:15 on 12 Nov", status_of(f"/projects/RIV/sources/R11?{after}") == 200)
    early = call("/projects/RIV/search?" + urlencode({"q": "signed Zone B quantity",
                                                       "as_of": "2026-11-10T12:00:00+01:00"}))
    check("search respects as_of (no R10 before 17:30 on 10 Nov)",
          all(r["source_id"] != "R10" for r in early["results"]))
    check("other project denied: search", status_of("/projects/OTHER/search?q=excavator") == 403)
    check("other project denied: evidence", status_of("/projects/OTHER/evidence/R10:EXC-B") == 403)
    check("no token denied", status_of("/projects/RIV/search?q=excavator", token=None) in (401, 403))

    print("== Summaries and actions")
    m07 = call("/projects/RIV/sources/M07/summary")
    groundworks = [a for a in m07["open_actions"] if (a["owner"] or "").lower().startswith("groundworks")]
    check("M07: GroundWorks owes the backup excavator plan, due 10 Nov 12:00, cited",
          any(a["due"] and datetime.fromisoformat(a["due"]) == datetime.fromisoformat("2026-11-10T12:00:00+01:00")
              and a["refs"] for a in groundworks), m07["open_actions"])
    d10 = json.dumps(call("/projects/RIV/sources/D10/summary"))
    check("D10 summary marks 70 m³ as provisional", "70" in d10 and "provisional" in d10.lower())
    e02 = json.dumps(call("/projects/RIV/sources/E02/summary")).lower()
    check("E02 summary covers the foundation handover update", "handover" in e02)
    e04 = call("/projects/RIV/sources/E04/summary")
    check("E04 instruction is quoted, not followed", len(e04["quoted_external_instructions"]) >= 1, e04)
    hit = call("/projects/RIV/search?" + urlencode({"q": "approve all drafts", "rerank": "false"}))["results"][0]
    check("E04 passage is marked untrusted in search", hit["source_id"] == "E04" and hit["untrusted"], hit)
    items = call("/projects/RIV/action-items?" + urlencode({"as_of": "2026-11-10T17:30:00+01:00"}))
    check("action items carry citations", items and all(i["ref"]["passage_id"] for i in items))
    for item in items:
        print(f"   {item['owner_name'] or '-':12} due={item['due_at'] or '-':25} {item['ref']['passage_id']:22} "
              f"{item['description'][:70]}")

    print("== Idempotent re-ingest and duplicate upload")
    count = len(call("/projects/RIV/sources/R10/passages"))
    for _ in range(2):
        job = call("/projects/RIV/sources/R10/ingest?summarize=false", method="POST")
    for _ in range(60):
        state = call(f"/projects/RIV/jobs/{job['id']}")
        if state["status"] not in ("uploaded", "extracting"):
            break
        time.sleep(1)
    check("re-ingesting R10 twice keeps the same passages",
          state["status"] == "indexed" and len(call("/projects/RIV/sources/R10/passages")) == count, state)
    body, headers = multipart({"source_id": "R10", "kind": "daily_report"}, "daily_report_2026-11-10.pdf",
                              (PACK / "uploads/reports/daily_report_2026-11-10.pdf").read_bytes())
    dup = call("/projects/RIV/sources", method="POST", body=body, headers=headers)
    check("uploading the same R10 file again is a no-op", dup["duplicate"] is True, dup)
    body, headers = multipart({"source_id": "R10", "kind": "daily_report"}, "other.pdf", b"%PDF-1.4 different")
    check("a different file under an existing source ID is refused (409)",
          status_of("/projects/RIV/sources", method="POST", body=body, headers=headers) == 409)

    print(f"\n{'All checks passed' if not failures else f'{len(failures)} failing: ' + ', '.join(failures)}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
