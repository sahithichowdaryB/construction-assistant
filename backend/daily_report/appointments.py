"""Appointments of a work day: meetings, inspections, hold points, deliveries, visits and deadlines.

Rows are immutable (keep_revision): an edit, a move or a cancellation is a new row that supersedes the old one, so the
day's appointments can be replayed for any clock. `extract_proposals` reads the records for a date and proposes
appointments (an action item due that day, a minutes or email passage naming a time on that day); nothing is saved
until a person confirms the proposal.
"""

from __future__ import annotations

import re
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import text

CUTOFF = "coalesce(CAST(:cutoff AS timestamptz), 'infinity')"
KIND_WORDS = (("inspection", ("inspect", "hold point", "sign-off", "sign off", "survey")),
              ("delivery", ("deliver", "docket", "truck", "dispatch")),
              ("meeting", ("meeting", "jour fixe", "site walk", "call", "review")),
              ("visit", ("visit", "client on site", "walkthrough")))
TIME = re.compile(r"\b([01]?\d|2[0-3])[:.]([0-5]\d)\b|\b(noon|midday)\b", re.I)


def current(conn, project_id: str, day: date, tz: ZoneInfo, as_of) -> list[dict]:
    """Appointments starting on `day` (local), as known at `as_of`: rows nothing supersedes yet."""
    start = datetime.combine(day, time.min, tz)
    rows = conn.execute(text(f"""
        SELECT a.id::text AS id, a.kind, a.title, a.starts_at, a.ends_at, a.location, a.activity_code, a.attendees,
               a.status, a.origin, a.source_id, a.locator, a.created_by, a.available_at
        FROM sitemate.appointments a
        WHERE a.project_id = :p AND a.starts_at >= :s AND a.starts_at < :e AND a.available_at <= {CUTOFF}
          AND NOT EXISTS (SELECT 1 FROM sitemate.appointments n WHERE n.project_id = a.project_id
                          AND n.supersedes_id = a.id AND n.available_at <= {CUTOFF})
        ORDER BY a.starts_at, a.title"""), {"p": project_id, "s": start, "e": start + timedelta(days=1),
                                            "cutoff": as_of}).mappings().all()
    return [dict(r) for r in rows]


def _kind(text_: str) -> str:
    low = text_.lower()
    return next((k for k, words in KIND_WORDS if any(w in low for w in words)), "deadline")


def _time_on(day: date, match, tz) -> datetime:
    if match.group(3):
        return datetime.combine(day, time(12, 0), tz)
    return datetime.combine(day, time(int(match.group(1)), int(match.group(2))), tz)


def extract_proposals(conn, project_id: str, day: date, tz: ZoneInfo, as_of) -> list[dict]:
    """Code-only proposals for `day`, each citing its passage; existing appointments from the same passage are
    skipped. The manager confirms a proposal by POSTing it as an appointment (origin 'extracted')."""
    taken = {(a["source_id"], a["locator"]) for a in current(conn, project_id, day, tz, as_of) if a["source_id"]}
    out, seen = [], set()
    start = datetime.combine(day, time.min, tz)
    for r in conn.execute(text(f"""
        SELECT a.description, a.owner_name, a.due_at, a.source_id, a.locator FROM sitemate.action_items a
        JOIN sitemate.sources s ON (s.project_id, s.id) = (a.project_id, a.source_id)
        WHERE a.project_id = :p AND a.due_at >= :s AND a.due_at < :e AND s.available_at <= {CUTOFF}
          AND (a.completed_at IS NULL OR a.completed_at > {CUTOFF})"""),
            {"p": project_id, "s": start, "e": start + timedelta(days=1), "cutoff": as_of}).mappings():
        key = (r["source_id"], r["locator"])
        if key in taken or key in seen:
            continue
        seen.add(key)
        owner = f" ({r['owner_name']})" if r["owner_name"] else ""
        out.append({"kind": "deadline", "title": f"Due: {r['description']}{owner}"[:300], "starts_at": r["due_at"],
                    "source_id": r["source_id"], "locator": r["locator"], "basis": "action item due date"})
    for r in conn.execute(text(f"""
        SELECT sp.source_id, sp.locator, sp.excerpt, s.kind FROM sitemate.source_passages sp
        JOIN sitemate.sources s ON (s.project_id, s.id) = (sp.project_id, sp.source_id)
        WHERE sp.project_id = :p AND s.kind IN ('minutes', 'email', 'diary') AND s.available_at <= {CUTOFF}
          AND s.available_at >= :s - interval '7 days' AND s.available_at < :e
          AND coalesce(sp.kind, 'paragraph') <> 'metadata'"""),
            {"p": project_id, "s": start, "e": start + timedelta(days=1), "cutoff": as_of}).mappings():
        key = (r["source_id"], r["locator"])
        excerpt = r["excerpt"] or ""
        mentions_day = (day.strftime("%d %B").lstrip("0") in excerpt or day.strftime("%d %b").lstrip("0") in excerpt
                        or day.isoformat() in excerpt or f"{day.day} {day:%B}" in excerpt or f"{day.day} {day:%b}" in excerpt)
        match = TIME.search(excerpt)
        if key in taken or key in seen or not mentions_day or not match:
            continue
        seen.add(key)
        out.append({"kind": _kind(excerpt), "title": re.sub(r"\s+", " ", excerpt).strip()[:200],
                    "starts_at": _time_on(day, match, tz), "source_id": r["source_id"], "locator": r["locator"],
                    "basis": f"{r['kind']} names {match.group(0)} on {day:%d %b}"})
    return sorted(out, key=lambda x: x["starts_at"])[:20]


def create(conn, project_id: str, item: dict, member_id: str, when, supersedes: str | None = None) -> str:
    if supersedes:
        prior = conn.execute(text("""SELECT 1 FROM sitemate.appointments WHERE project_id=:p AND id=CAST(:i AS uuid)
            AND NOT EXISTS (SELECT 1 FROM sitemate.appointments n WHERE n.project_id=:p AND n.supersedes_id=CAST(:i AS uuid))"""),
                             {"p": project_id, "i": supersedes}).scalar()
        if not prior:
            raise LookupError("Appointment not found, or already changed")
    import json
    return str(conn.scalar(text("""
        INSERT INTO sitemate.appointments (project_id, kind, title, starts_at, ends_at, location, activity_code, attendees,
                                           status, origin, source_id, locator, supersedes_id, created_by, available_at)
        VALUES (:p, :k, :t, :s, :e, :loc, :a, CAST(:att AS jsonb), :st, :o, :src, :l, CAST(:sup AS uuid), :m, :at)
        RETURNING id"""), {"p": project_id, "k": item["kind"], "t": item["title"], "s": item["starts_at"],
                           "e": item.get("ends_at"), "loc": item.get("location"), "a": item.get("activity_code"),
                           "att": json.dumps(item.get("attendees") or []), "st": item.get("status") or "planned",
                           "o": item.get("origin") or "manual", "src": item.get("source_id"),
                           "l": item.get("locator"), "sup": supersedes, "m": member_id, "at": when}))
