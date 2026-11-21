"""Typed shapes for what the model returns. Validation happens in code: the model's JSON is never trusted as-is."""

from __future__ import annotations

from enum import Enum
from typing import Annotated, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, field_validator

SEVERITY_FLAGS = ("hospitalisation", "fatality", "structural_collapse", "occupied_zone", "spill_to_drain", "sole_access")
FACT_BASES = ("reported", "inferred", "estimated", "forecast", "signed")


class Lenient(BaseModel):
    model_config = ConfigDict(extra="ignore")


class Alternative(Lenient):
    category: str
    event_type: str


class EventClassification(Lenient):
    suggested_category: str
    suggested_event_type: str
    confidence: float = 0.0
    rationale: str = ""
    alternatives: list[Alternative] = Field(default_factory=list)
    severity_flags: list[str] = Field(default_factory=list)
    summary: str
    evidence_quote: str = ""

    @field_validator("severity_flags", mode="after")
    @classmethod
    def _known_flags(cls, v):
        return [f for f in v if f in SEVERITY_FLAGS]


class EventDetails(Lenient):
    asset_key: str | None = None
    occurred_at: str | None = None
    zone: str | None = None
    activity_code: str | None = None
    equipment_id_spoken: str | None = None
    equipment_description: str | None = None
    material: str | None = None
    quantity: float | None = None
    unit: str | None = None
    quantity_basis: Literal["reported", "estimated", "signed"] | None = None
    outstanding_quantity: float | None = None
    workers_affected: float | None = None
    injured_count: float | None = None
    expected_restart_at: str | None = None
    delay_minutes: float | None = None
    location: str | None = None
    description: str | None = None
    successor_activity_code: str | None = None
    impact: str | None = None

    @field_validator("quantity_basis", mode="before")
    @classmethod
    def _basis(cls, v):
        return v if v in ("reported", "estimated", "signed") else None


class ExtractedEvent(EventClassification, EventDetails):
    """Flat, typed event used throughout the capture pipeline."""


DetailName = Enum("DetailName", {name: name for name in EventDetails.model_fields}, type=str)


class ReportedDetail(Lenient):
    name: DetailName
    value: str


class ReportedEvent(EventClassification):
    details: list[ReportedDetail]


def expand_reported_details(value):
    event = ReportedEvent.model_validate(value)
    flat = event.model_dump(exclude={"details"})
    for detail in event.details:
        name = detail.name.value
        if name in flat:
            raise ValueError(f"Repeated event detail: {name}")
        flat[name] = detail.value
    return flat


class ExtractionResult(Lenient):
    # Claude emits only the details present. Pydantic restores the typed fields and defaults for downstream callers.
    events: list[Annotated[ExtractedEvent, BeforeValidator(expand_reported_details, json_schema_input_type=ReportedEvent)]]


class PhotoDescription(Lenient):
    description: str
    visible_assets: list[str] = Field(default_factory=list)
    hazards: list[str] = Field(default_factory=list)
    text_in_image: list[str] = Field(default_factory=list)


class EvidenceReference(Lenient):
    source_id: str
    locator: str


class ValidatedFact(Lenient):
    event_index: int
    field_name: str
    value: str
    basis: str = "reported"
    source: str = "transcript"
    evidence_refs: list[EvidenceReference] = Field(default_factory=list)
    reasoning: str = ""

    @field_validator("value", mode="before")
    @classmethod
    def _text(cls, v):
        return "" if v is None else str(v)

    @field_validator("basis", mode="after")
    @classmethod
    def _basis(cls, v):
        return v if v in FACT_BASES else "reported"


class MissingField(Lenient):
    event_index: int
    field_name: str
    rule_key: str = ""
    why: str = ""


class Question(Lenient):
    id: str
    event_index: int
    field_name: str
    question: str
    options: list[str] | None = None


class ValidationResult(Lenient):
    validated_facts: list[ValidatedFact] = Field(default_factory=list)
    missing: list[MissingField] = Field(default_factory=list)
    questions: list[Question] = Field(default_factory=list)


class Adjudication(Lenient):
    decision: Literal["link", "new"]
    incident_id: str | None = None
    link_type: Literal["corroborating", "update", "resolution", "contradicting"] | None = None
    confidence: float = 0.0
    reason: str = ""


class SeverityAdjustment(Lenient):
    adjustment: int = 0
    reason: str | None = None
