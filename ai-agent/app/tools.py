"""Read-only evidence access. project_id and as_of are bound at construction, so neither the
model nor the orchestrator can widen scope: every query filters on both."""

from datetime import datetime, timedelta, timezone
from typing import Protocol

from sqlalchemy import text

from .models import Incident, Passage

EVIDENCE_KINDS = ("voice", "voice_note", "text", "email", "minutes", "diary", "daily_report", "photo")
LOOKBACK = timedelta(days=30)
MAX_PASSAGES = 120


class EvidenceStore(Protocol):
    def get_incident(self, incident_id: str) -> Incident | None: ...
    def candidate_passages(self, incident: Incident) -> list[Passage]: ...
    def rules(self, incident: Incident) -> list[str]: ...
    def trust_config(self) -> dict: ...
    def timezone(self) -> str: ...


class SqlEvidenceStore:
    def __init__(self, conn, project_id: str, as_of: datetime):
        if as_of.utcoffset() is None:
            raise ValueError("as_of must include a time zone")
        self.conn, self.project_id, self.as_of = conn, project_id, as_of.astimezone(timezone.utc)

    def get_incident(self, incident_id):
        row = self.conn.execute(text("""
            SELECT i.id::text AS id, i.activity_code, i.kind, i.title, i.occurred_at, a.zone
            FROM sitemate.incidents i
            LEFT JOIN sitemate.activities a ON (a.project_id,a.code)=(i.project_id,i.activity_code)
            WHERE i.project_id=:p AND i.id=CAST(:i AS uuid) AND i.occurred_at <= :cutoff
        """), {"p": self.project_id, "i": incident_id, "cutoff": self.as_of}).mappings().one_or_none()
        return Incident(**row) if row else None

    def candidate_passages(self, incident):
        rows = self.conn.execute(text("""
            SELECT * FROM (
            SELECT p.source_id, p.locator, s.kind, s.author, s.author_role, s.available_at, p.excerpt AS text
            FROM sitemate.source_passages p
            JOIN sitemate.sources s ON (s.project_id,s.id)=(p.project_id,p.source_id)
            WHERE p.project_id=:p AND s.available_at <= :cutoff AND s.available_at >= :since
              AND s.kind = ANY(:kinds)
              AND (s.kind <> 'daily_report' OR p.locator = :activity)
            ORDER BY EXISTS (  -- sources of events grouped into this incident (voice, text, photo captures)
                SELECT 1 FROM sitemate.events ev
                JOIN sitemate.incident_events ie ON (ie.project_id,ie.event_id)=(ev.project_id,ev.id)
                WHERE ev.project_id=p.project_id AND ev.source_id=p.source_id
                  AND ie.incident_id=CAST(:incident AS uuid) AND ie.unlinked_at IS NULL
            ) DESC, EXISTS (
                SELECT 1 FROM sitemate.fact_evidence fe
                JOIN sitemate.capture_facts cf ON (cf.project_id,cf.id)=(fe.project_id,fe.fact_id)
                WHERE fe.project_id=p.project_id AND fe.source_id=p.source_id
                  AND cf.incident_id=CAST(:incident AS uuid) AND cf.review_status<>'rejected'
                  AND EXISTS (
                      SELECT 1 FROM sitemate.sources origin
                      WHERE (origin.project_id,origin.id)=(cf.project_id,cf.source_id)
                        AND origin.available_at <= :cutoff
                  )
            ) DESC, s.available_at DESC, p.source_id, p.locator
            LIMIT :limit
            ) chosen ORDER BY available_at, source_id, locator
        """), {"p": self.project_id, "cutoff": self.as_of, "since": incident.occurred_at - LOOKBACK,
               "kinds": list(EVIDENCE_KINDS), "activity": incident.activity_code or "",
               "incident": incident.id, "limit": MAX_PASSAGES}).mappings().all()
        return [Passage(**row) for row in rows]

    def rules(self, incident):
        if self.conn.scalar(text("SELECT to_regclass('sitemate.business_rules')")) is None:
            return []
        rows = self.conn.execute(text("""
            SELECT description FROM sitemate.business_rules
            WHERE active AND event_type IN ('*', :kind)
            ORDER BY rule_key
        """), {"kind": incident.kind}).scalars().all()
        return list(rows)

    def trust_config(self):
        return self.conn.scalar(text("SELECT trust_config FROM sitemate.projects WHERE id=:p"),
                                {"p": self.project_id}) or {}

    def timezone(self):
        return self.conn.scalar(text("SELECT timezone FROM sitemate.projects WHERE id=:p"),
                                {"p": self.project_id}) or "UTC"


def default_as_of() -> datetime:
    return datetime.now(timezone.utc)
