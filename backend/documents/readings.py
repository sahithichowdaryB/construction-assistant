"""Review of the quantities parsed from a signed daily report (migration 0010_reading_review).

Parsing a report only proposes readings (ingestion_jobs.result.proposals). A manager decides each one:

    accepted   the parsed value becomes the observation that progress, alerts and evaluations read
    corrected  the manager's value (with a reason) becomes the observation; the parsed value stays on the review
    rejected   no observation (an earlier accepted one is removed); the reason is kept

Every decision is an immutable reading_reviews row; a later decision on the same row supersedes the earlier one.
The whole request is one transaction: a value that differs from what is already stored is a conflict, and nothing is
written unless the manager marks that row as a correction. Repeating a decision is a no-op, so retries are safe.
Affected work days are queued for their daily evaluation.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from sqlalchemy import text

DECISIONS = ("accepted", "corrected", "rejected")


class ReadingError(Exception):
    """A request that cannot be applied. `status` is the HTTP status the route returns."""

    def __init__(self, status: int, message: str, detail: list | None = None):
        super().__init__(message)
        self.status, self.message, self.detail = status, message, detail or []


@dataclass
class Decision:
    locator: str
    decision: str
    quantity: float | None = None
    reason: str | None = None


@dataclass
class Outcome:
    reviews: list[dict] = field(default_factory=list)
    observations: list[dict] = field(default_factory=list)
    unchanged: list[str] = field(default_factory=list)
    queued_days: list[str] = field(default_factory=list)


def _proposals(conn, project_id, source_id):
    job = conn.execute(text("""
        SELECT id, status, result FROM sitemate.ingestion_jobs
        WHERE project_id=:p AND source_id=:s AND stage='parse'"""), {"p": project_id, "s": source_id}).mappings().one_or_none()
    if job is None:
        raise ReadingError(404, "This source has not been parsed yet")
    if job["status"] in ("queued", "running"):
        raise ReadingError(409, "The report is still being read; try again when parsing has finished")
    if job["status"] == "failed":
        raise ReadingError(409, "Parsing failed; re-run the ingestion before confirming readings")
    return job, {p["locator"]: p for p in (job["result"] or {}).get("proposals", [])}


def latest_reviews(conn, project_id, source_id, as_of=None) -> dict[str, dict]:
    """The decision currently in force per locator (one that no later review supersedes), as of `as_of`."""
    rows = conn.execute(text("""
        SELECT r.id::text AS id, r.locator, r.decision, r.quantity, r.proposed_quantity, r.reason, r.reviewer_id,
               r.decided_at, coalesce(m.display_name, r.reviewer_id) AS reviewer_name
        FROM sitemate.reading_reviews r
        LEFT JOIN sitemate.project_members m ON (m.project_id, m.member_id) = (r.project_id, r.reviewer_id)
        WHERE r.project_id = :p AND r.source_id = :s
          AND r.decided_at <= coalesce(CAST(:cutoff AS timestamptz), 'infinity')
          AND NOT EXISTS (SELECT 1 FROM sitemate.reading_reviews newer
                          WHERE newer.project_id = r.project_id AND newer.supersedes_id = r.id
                            AND newer.decided_at <= coalesce(CAST(:cutoff AS timestamptz), 'infinity'))
    """), {"p": project_id, "s": source_id, "cutoff": as_of}).mappings().all()
    return {r["locator"]: dict(r) for r in rows}


def _same(a, b) -> bool:
    return a is not None and b is not None and abs(float(a) - float(b)) < 1e-9


def plan(decisions: list[Decision], proposals: dict, current: dict, stored: dict, all_signed: bool) -> list[dict]:
    """Pure: work out what to write. Returns one item per locator with `action` in {write, noop}; raises
    ReadingError for unknown rows, invalid values or conflicts (no partial writes)."""
    wanted = {d.locator: d for d in decisions}
    if all_signed:
        for locator, p in proposals.items():
            if p.get("basis") == "signed" and locator not in wanted and locator not in current:
                wanted[locator] = Decision(locator, "accepted")
    if not wanted:
        raise ReadingError(422, "No readings to confirm")
    unknown = sorted(set(wanted) - set(proposals))
    if unknown:
        raise ReadingError(404, "These rows are not readings of this report: " + ", ".join(unknown))
    out, conflicts = [], []
    for locator, d in sorted(wanted.items()):
        p = proposals[locator]
        if d.decision not in DECISIONS:
            raise ReadingError(422, f"{locator}: decision must be one of {', '.join(DECISIONS)}")
        reason = (d.reason or "").strip() or None
        if d.decision in ("corrected", "rejected") and not reason:
            raise ReadingError(422, f"{locator}: say why the reading is {d.decision}")
        if d.decision == "corrected":
            if d.quantity is None or d.quantity < 0:
                raise ReadingError(422, f"{locator}: a correction needs the correct quantity (0 or more)")
            quantity = float(d.quantity)
        elif d.decision == "accepted":
            quantity = float(p["value"])
        else:
            quantity = None
        prior = current.get(locator)
        if prior and prior["decision"] == d.decision and (
                quantity is None and prior["quantity"] is None or _same(prior["quantity"], quantity)):
            out.append({"locator": locator, "action": "noop", "proposal": p})
            continue
        existing = stored.get(locator)
        if d.decision == "accepted" and existing is not None and not _same(existing, quantity):
            conflicts.append({"locator": locator, "stored": float(existing), "parsed": float(p["value"])})
            continue
        out.append({"locator": locator, "action": "write", "decision": d.decision, "quantity": quantity,
                    "reason": reason, "proposal": p, "supersedes": prior["id"] if prior else None})
    if conflicts:
        raise ReadingError(409, "Stored readings differ from the report; confirm these rows as corrections "
                                "with a reason, or reject them", conflicts)
    return out


def confirm_readings(conn, project_id: str, source_id: str, decisions: list[Decision], *, member_id: str, when,
                     all_signed: bool = False, queue=True) -> Outcome:
    """Apply the decisions in the caller's transaction (see the module docstring)."""
    conn.execute(text("SELECT pg_advisory_xact_lock(hashtext(:k))"), {"k": f"readings:{project_id}:{source_id}"})
    available = conn.scalar(text("SELECT available_at FROM sitemate.sources WHERE project_id=:p AND id=:s"),
                            {"p": project_id, "s": source_id})
    if available is None or available > when:
        raise ReadingError(404, "This report is not available at the selected time")
    job, proposals = _proposals(conn, project_id, source_id)
    current = latest_reviews(conn, project_id, source_id)
    stored = {r.locator: float(r.quantity) for r in conn.execute(text("""
        SELECT locator, quantity FROM sitemate.observations WHERE project_id=:p AND source_id=:s"""),
        {"p": project_id, "s": source_id})}
    items = plan(decisions, proposals, current, stored, all_signed)
    outcome, days = Outcome(), set()
    for item in items:
        p = item["proposal"]
        if item["action"] == "noop":
            outcome.unchanged.append(item["locator"])
            continue
        review_id = conn.scalar(text("""
            INSERT INTO sitemate.reading_reviews (project_id, source_id, locator, job_id, activity_code, work_date, unit,
                proposed_quantity, basis, decision, quantity, reason, reviewer_id, decided_at, supersedes_id)
            VALUES (:p, :s, :l, :j, :c, :d, :u, :pq, :b, :dec, :q, :r, :m, :at, CAST(:sup AS uuid))
            RETURNING id::text"""), {
            "p": project_id, "s": source_id, "l": item["locator"], "j": job["id"], "c": p["activity_code"],
            "d": p["work_date"], "u": p.get("unit") or "-", "pq": p.get("value"), "b": p.get("basis") or "signed",
            "dec": item["decision"], "q": item["quantity"], "r": item["reason"], "m": member_id, "at": when,
            "sup": item["supersedes"]})
        key = {"p": project_id, "c": p["activity_code"], "d": p["work_date"], "s": source_id, "l": item["locator"]}
        if item["decision"] == "rejected":
            conn.execute(text("""DELETE FROM sitemate.observations WHERE project_id=:p AND activity_code=:c
                                 AND work_date=:d AND source_id=:s AND locator=:l"""), key)
        else:
            conn.execute(text("""
                INSERT INTO sitemate.observations (project_id, activity_code, work_date, source_id, locator, quantity,
                                                   basis, accepted_by, accepted_at, review_id)
                VALUES (:p, :c, :d, :s, :l, :q, :b, :m, :at, CAST(:rid AS uuid))
                ON CONFLICT (project_id, activity_code, work_date, source_id, locator) DO UPDATE SET
                    quantity = EXCLUDED.quantity, accepted_by = EXCLUDED.accepted_by,
                    accepted_at = EXCLUDED.accepted_at, review_id = EXCLUDED.review_id"""),
                         {**key, "q": item["quantity"], "b": p.get("basis") or "signed", "m": member_id, "at": when,
                          "rid": review_id})
            outcome.observations.append({"activity_code": p["activity_code"], "work_date": p["work_date"],
                                         "quantity": item["quantity"], "basis": p.get("basis") or "signed",
                                         "locator": item["locator"]})
        outcome.reviews.append({"id": review_id, "locator": item["locator"], "decision": item["decision"],
                                "quantity": item["quantity"], "proposed_quantity": p.get("value"),
                                "reason": item["reason"]})
        days.add(p["work_date"])
    if queue and days:
        from performance.daily import queue_day
        for day in sorted(days):
            if queue_day(conn, project_id, day, "signed_report", as_of=when):
                outcome.queued_days.append(day)
    return outcome


def all_confirmed(conn, project_id: str, source_id: str, proposals: list[dict]) -> bool:
    """True when every signed proposal already matches a stored observation (re-reading a seeded or confirmed
    report), so the day can be evaluated straight away."""
    stored = {(r.activity_code, r.work_date.isoformat(), r.locator): float(r.quantity) for r in conn.execute(text("""
        SELECT activity_code, work_date, locator, quantity FROM sitemate.observations
        WHERE project_id=:p AND source_id=:s"""), {"p": project_id, "s": source_id})}
    signed = [p for p in proposals if p.get("basis") == "signed"]
    return bool(signed) and all(_same(stored.get((p["activity_code"], p["work_date"], p["locator"])), p["value"])
                                for p in signed)
