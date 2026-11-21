"""Typed shapes shared by the store, the scorer, the LLM stages and persistence."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

Role = Literal["site_supervisor", "foreman", "signed_report", "contractor_internal",
               "external", "client", "system", "unknown"]
Stance = Literal["states_cause", "speculates", "context_only", "contradicts"]
Status = Literal["established", "probable", "unconfirmed", "undetermined", "needs_review"]


class Incident(BaseModel):
    id: str
    activity_code: str | None = None
    kind: str
    title: str
    occurred_at: datetime
    zone: str | None = None


class Passage(BaseModel):
    source_id: str
    locator: str
    kind: str
    author: str | None = None
    author_role: Role = "unknown"
    available_at: datetime
    text: str

    @property
    def ref(self) -> str:
        return f"{self.source_id}#{self.locator}"


class Claim(BaseModel):
    """One statement about cause, extracted from exactly one passage."""
    id: str
    source_id: str
    locator: str
    quote: str
    stance: Stance
    statement: str
    speaker_certainty: float = Field(1.0, ge=0, le=1)
    derived_from: str | None = None  # id of a claim this one merely repeats or relays
    # Filled in by code from the passage, never trusted from the model:
    author_role: Role = "unknown"
    stated_at: datetime | None = None


class Hypothesis(BaseModel):
    id: str
    statement: str
    level: Literal["proximate", "root"] = "proximate"
    supporting: list[str] = []
    contradicting: list[str] = []


class ScoreCard(BaseModel):
    hypothesis_id: str
    score: float
    supervisor_backed: bool
    external_only: bool
    independent_sources: int
    contradicted_by_supervisor: bool
    flags: list[str] = []


class EvidenceItem(BaseModel):
    source_id: str
    locator: str
    quote: str
    author_role: Role
    stance: Stance
    weight: float
    stated_at: datetime | None = None
    hypothesis_id: str | None = None


class Verdict(BaseModel):
    """What the LLM decides (after seeing the score cards)."""
    status: Literal["established", "probable", "unconfirmed", "undetermined"]
    selected_hypothesis_id: str | None = None
    headline_cause: str | None = None
    confidence: float = Field(ge=0, le=1)
    reasoning: str
    score_deviation_reason: str | None = None
    evidence_claim_ids: list[str] = []
    external_claim_ids: list[str] = []
    gaps: list[str] = []


class IncidentAnalysis(BaseModel):
    incident_id: str
    as_of: datetime
    status: Status
    confidence: float
    headline_cause: str | None
    reasoning: str
    hypotheses: list[Hypothesis]
    score_cards: list[ScoreCard]
    factual_evidence: list[EvidenceItem]
    external_claims: list[EvidenceItem]
    gaps: list[str]
    guardrail_flags: list[str]
    input_digest: str
    model: str
