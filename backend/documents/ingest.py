"""Ingestion pipeline: original file -> passages (+ quantity proposals) -> summary.

Every run is tracked in ingestion_jobs (one row per source and stage, reused on retry).
Re-running the same file is idempotent: passages upsert on (project, source, locator),
and a quantity table row that differs from what is stored is never overwritten; the job
goes to needs_review with the differences instead.

CLI:  python -m documents.ingest [--source R10 ...] [--no-summaries]
"""

import argparse
import json
import traceback
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import text

from database import writer_engine

from . import parsers, storage

SUMMARY_KINDS = {"diary", "minutes", "email", "daily_report"}


def _json(value):
    return json.dumps(value, default=lambda o: o.isoformat() if isinstance(o, (date, datetime)) else str(o))


def start_job(conn, project_id, source_id, stage):
    row = conn.execute(text("""
        INSERT INTO sitemate.ingestion_jobs (project_id, source_id, stage, status, attempts)
        VALUES (:p, :s, :stage, 'running', 1)
        ON CONFLICT (project_id, source_id, stage) DO UPDATE
            SET status='running', attempts=sitemate.ingestion_jobs.attempts + 1, error=NULL, updated_at=now()
        RETURNING id
    """), {"p": project_id, "s": source_id, "stage": stage}).one()
    return row.id


def queue_job(conn, project_id, source_id, stage):
    return conn.execute(text("""
        INSERT INTO sitemate.ingestion_jobs (project_id, source_id, stage, status)
        VALUES (:p, :s, :stage, 'queued')
        ON CONFLICT (project_id, source_id, stage) DO UPDATE SET status='queued', error=NULL, updated_at=now()
        RETURNING id
    """), {"p": project_id, "s": source_id, "stage": stage}).one().id


def finish_job(conn, project_id, job_id, status, error=None, result=None):
    conn.execute(text("""
        UPDATE sitemate.ingestion_jobs SET status=:status, error=:error,
               result=CAST(:result AS jsonb), updated_at=now()
        WHERE project_id=:p AND id=:id
    """), {"p": project_id, "id": job_id, "status": status, "error": error, "result": _json(result or {})})


def load_context(conn, project_id, source_id):
    project = conn.execute(text("SELECT id, name, timezone FROM sitemate.projects WHERE id=:p"),
                           {"p": project_id}).mappings().one()
    source = conn.execute(text("""SELECT id, kind, path, available_at, sha256, meta->>'filename' AS filename
                                  FROM sitemate.sources
                                  WHERE project_id=:p AND id=:s"""),
                          {"p": project_id, "s": source_id}).mappings().one_or_none()
    if source is None:
        raise LookupError(f"Source {source_id} not found in project {project_id}")
    activities = {r.code: {"name": r.name, "unit": r.unit} for r in conn.execute(text(
        "SELECT code, name, unit FROM sitemate.activities WHERE project_id=:p ORDER BY code"), {"p": project_id})}
    contractors = dict(conn.execute(text("SELECT id, name FROM sitemate.contractors WHERE project_id=:p"),
                                    {"p": project_id}).all())
    targets = {(r.activity_code, r.work_date.isoformat()): float(r.quantity) for r in conn.execute(text(
        "SELECT activity_code, work_date, quantity FROM sitemate.plan_targets WHERE project_id=:p"),
        {"p": project_id})}
    transcript = storage.transcript_for(project_id, source_id)
    return {"project": dict(project), "source": dict(source), "activities": activities,
            "contractors": contractors, "targets": targets,
            "transcript_path": str(transcript) if transcript else None}


def save_passages(conn, project_id, source_id, result):
    """Upsert passages. Returns conflicts that were left untouched for review."""
    existing = dict(conn.execute(text("""SELECT locator, excerpt FROM sitemate.source_passages
                                         WHERE project_id=:p AND source_id=:s"""),
                                 {"p": project_id, "s": source_id}).all())
    conflicts, rows = [], []
    for ordinal, passage in enumerate(result.passages, start=1):
        stored = existing.get(passage.locator)
        # Quantity rows feed observations and alerts: a differing re-read never replaces them silently.
        # Narrative text (including OCR paragraphs) is refreshed.
        if stored is not None and stored != passage.excerpt and passage.kind == "table_row":
            conflicts.append({"locator": passage.locator, "stored": stored, "parsed": passage.excerpt})
            continue
        rows.append({"p": project_id, "s": source_id, "locator": passage.locator, "page": passage.page,
                     "excerpt": passage.excerpt, "ordinal": ordinal, "kind": passage.kind,
                     "section": passage.section, "untrusted": passage.untrusted, "meta": _json(passage.meta)})
    if rows:
        conn.execute(text("""
            INSERT INTO sitemate.source_passages
                (project_id, source_id, locator, page, excerpt, ordinal, kind, section, untrusted, meta)
            VALUES (:p, :s, :locator, :page, :excerpt, :ordinal, :kind, :section, :untrusted, CAST(:meta AS jsonb))
            ON CONFLICT (project_id, source_id, locator) DO UPDATE SET
                page=EXCLUDED.page, excerpt=EXCLUDED.excerpt, ordinal=EXCLUDED.ordinal, kind=EXCLUDED.kind,
                section=EXCLUDED.section, untrusted=EXCLUDED.untrusted, meta=EXCLUDED.meta
        """), rows)
    return conflicts, len(rows)


def parse_source(project_id, source_id):
    """Run the parse stage. Returns the job summary dict."""
    engine = writer_engine()
    with engine.begin() as conn:
        job_id = start_job(conn, project_id, source_id, "parse")
    try:
        with engine.connect() as conn:
            ctx = load_context(conn, project_id, source_id)
        path = storage.resolve(project_id, ctx["source"]["path"])
        if path is None:
            raise FileNotFoundError(f"Original file for {source_id} is not available")
        digest = storage.sha256_file(path)
        if ctx["source"]["sha256"] and ctx["source"]["sha256"] != digest:
            raise ValueError("Stored file hash changed; upload the correction as a new source")
        result = parsers.parse_file(path, ctx)
        # A report cannot be received before the day it reports on; that usually means the upload
        # used the wrong replay clock and would leak future evidence into earlier replays.
        work_date = result.meta.get("work_date")
        received = ctx["source"]["available_at"].astimezone(ZoneInfo(ctx["project"]["timezone"]))
        if work_date and work_date > received.date().isoformat():
            result.review_reasons.append(
                f"Report is dated {work_date} but recorded as received {received:%Y-%m-%d %H:%M}; "
                "check the received time before using its quantities")
        with engine.begin() as conn:
            conflicts, written = save_passages(conn, project_id, source_id, result)
            meta = {**result.meta, "review_reasons": result.review_reasons}
            conn.execute(text("""
                UPDATE sitemate.sources SET sha256=:sha, title=:title,
                       meta=coalesce(meta, '{}') || CAST(:meta AS jsonb), ingested_at=now()
                WHERE project_id=:p AND id=:s
            """), {"p": project_id, "s": source_id, "sha": digest, "title": result.title, "meta": _json(meta)})
            reasons = result.review_reasons + [f"{c['locator']}: parsed text differs from stored text"
                                               for c in conflicts]
            status = "needs_review" if reasons else "done"
            summary = {"passages_written": written, "passages_parsed": len(result.passages),
                       "proposals": result.proposals, "review_reasons": reasons, "conflicts": conflicts,
                       "title": result.title}
            finish_job(conn, project_id, job_id, status, result=summary)
        return {"job_id": str(job_id), "stage": "parse", "status": status, **summary}
    except Exception as exc:  # recorded on the job so the UI can offer a retry
        with engine.begin() as conn:
            finish_job(conn, project_id, job_id, "failed", error=f"{type(exc).__name__}: {exc}"[:1000],
                       result={"trace": traceback.format_exc()[-1500:]})
        return {"job_id": str(job_id), "stage": "parse", "status": "failed", "error": str(exc)}


def ingest_source(project_id, source_id, summarize=None):
    outcome = parse_source(project_id, source_id)
    if outcome["status"] == "failed":
        return outcome
    with writer_engine().connect() as conn:
        kind = conn.scalar(text("SELECT kind FROM sitemate.sources WHERE project_id=:p AND id=:s"),
                           {"p": project_id, "s": source_id})
    if summarize is None:
        summarize = kind in SUMMARY_KINDS
    if summarize:
        from .summaries import summarize_source
        outcome["summary"] = summarize_source(project_id, source_id)
    return outcome


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--project", default="RIV")
    parser.add_argument("--source", action="append", help="limit to these source IDs")
    parser.add_argument("--no-summaries", action="store_true")
    args = parser.parse_args()
    with writer_engine().connect() as conn:
        ids = [r.id for r in conn.execute(text("""SELECT id FROM sitemate.sources WHERE project_id=:p
                                                  ORDER BY available_at, id"""), {"p": args.project})]
    for source_id in ids:
        if args.source and source_id not in args.source:
            continue
        outcome = ingest_source(args.project, source_id, summarize=False if args.no_summaries else None)
        line = f"{source_id:5} parse={outcome['status']:12} passages={outcome.get('passages_written', '-')}"
        if "summary" in outcome:
            line += f" summary={outcome['summary']['status']}"
        print(line, flush=True)
        for reason in outcome.get("review_reasons", [])[:5]:
            print("      review:", reason[:160])
        if outcome.get("error"):
            print("      error:", outcome["error"][:300])
        if outcome.get("summary", {}).get("error"):
            print("      summary error:", outcome["summary"]["error"][:300])
    print("done", datetime.now(timezone.utc).isoformat(timespec="seconds"))


if __name__ == "__main__":
    main()
