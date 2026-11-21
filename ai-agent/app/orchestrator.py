"""analyze_incident: gather -> extract claims -> validate -> score cards -> LLM decides -> validate.

Code never overrides the LLM's decision. It only checks that the output is well formed and that every
citation is real, retries once with the errors, and otherwise stores the result as needs_review."""

import hashlib
import json
import re
from datetime import datetime
from zoneinfo import ZoneInfo

from pydantic import ValidationError

from .llm import LLMClient, LLMError
from .models import (Claim, EvidenceItem, Hypothesis, IncidentAnalysis, Passage, ScoreCard, Verdict)
from .prompts import DECIDE_SYSTEM, EXTRACT_SYSTEM
from .scoring import DEFAULT_ROLE_WEIGHTS, SUPERVISOR_ROLES, claim_weight, score_cards
from .tools import EvidenceStore, default_as_of

DEVIATION_LIMIT = 0.2


class IncidentNotFound(LookupError):
    pass


def _norm(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip().casefold()


def input_digest(incident_id: str, passages: list[Passage]) -> str:
    parts = sorted(f"{p.source_id}|{p.locator}|{p.author_role}|{hashlib.sha256(p.text.encode()).hexdigest()}"
                   for p in passages)
    return hashlib.sha256(("\n".join([incident_id, *parts])).encode()).hexdigest()


def validate_claims(raw_claims, passages: list[Passage]):
    """Keep only claims whose quote really appears in the cited passage. Roles/times come from the DB."""
    by_ref = {p.ref: p for p in passages}
    kept, dropped = [], []
    for raw in raw_claims or []:
        try:
            claim = Claim(**{k: v for k, v in raw.items() if k != "passage_ref"},
                          source_id=raw["passage_ref"].split("#", 1)[0],
                          locator=raw["passage_ref"].split("#", 1)[1])
        except (ValidationError, KeyError, IndexError, AttributeError, TypeError):
            dropped.append(f"malformed claim {raw!r:.80}")
            continue
        passage = by_ref.get(f"{claim.source_id}#{claim.locator}")
        if passage is None:
            dropped.append(f"{claim.id}: unknown passage")
        elif not claim.quote.strip() or _norm(claim.quote) not in _norm(passage.text):
            dropped.append(f"{claim.id}: quote not found in {passage.ref}")
        else:
            claim.author_role, claim.stated_at = passage.author_role, passage.available_at
            kept.append(claim)
    ids = {c.id for c in kept}
    if len(ids) != len(kept):
        raise LLMError("Duplicate claim ids from the model")
    for claim in kept:
        if claim.derived_from not in ids:
            claim.derived_from = None
    return kept, dropped


def validate_hypotheses(raw_hypotheses, claims: list[Claim]) -> list[Hypothesis]:
    ids = {c.id for c in claims}
    out = []
    for raw in raw_hypotheses or []:
        try:
            h = Hypothesis(**raw)
        except (ValidationError, TypeError):
            continue
        h.supporting = [c for c in h.supporting if c in ids]
        h.contradicting = [c for c in h.contradicting if c in ids]
        if h.supporting or h.contradicting:
            out.append(h)
    return out


def _evidence(claim: Claim, weight: float, hypothesis_id=None) -> EvidenceItem:
    return EvidenceItem(source_id=claim.source_id, locator=claim.locator, quote=claim.quote,
                        author_role=claim.author_role, stance=claim.stance, weight=round(weight, 3),
                        stated_at=claim.stated_at, hypothesis_id=hypothesis_id)


def verdict_errors(verdict: Verdict, hypotheses, claims, cards) -> list[str]:
    errors = []
    by_id = {c.id: c for c in claims}
    chosen = next((h for h in hypotheses if h.id == verdict.selected_hypothesis_id), None)
    if verdict.selected_hypothesis_id and chosen is None:
        errors.append(f"selected_hypothesis_id {verdict.selected_hypothesis_id!r} does not exist")
    if verdict.status != "undetermined" and chosen is None:
        errors.append("a non-undetermined status needs a selected_hypothesis_id")
    for cid in verdict.evidence_claim_ids + verdict.external_claim_ids:
        if cid not in by_id:
            errors.append(f"unknown claim id {cid!r}")
    if chosen:
        allowed = set(chosen.supporting)
        for cid in verdict.evidence_claim_ids:
            if cid in by_id and cid not in allowed:
                errors.append(f"evidence claim {cid!r} does not support {chosen.id}")
        if verdict.status != "undetermined" and not verdict.evidence_claim_ids:
            errors.append("cite at least one evidence claim for the selected hypothesis")
        card = next((c for c in cards if c.hypothesis_id == chosen.id), None)
        if card and abs(verdict.confidence - card.score) > DEVIATION_LIMIT and not verdict.score_deviation_reason:
            errors.append(f"confidence {verdict.confidence} differs from score {card.score} by more than "
                          f"{DEVIATION_LIMIT}; fill score_deviation_reason")
    return errors


def guardrail_flags(verdict: Verdict, hypotheses, claims, cards, dropped) -> list[str]:
    flags = [f"dropped_claim: {d}" for d in dropped]
    by_id = {c.id: c for c in claims}
    cited = [by_id[c] for c in verdict.evidence_claim_ids if c in by_id]
    card = next((c for c in cards if c.hypothesis_id == verdict.selected_hypothesis_id), None)
    if verdict.status == "established" and not any(c.author_role in SUPERVISOR_ROLES for c in cited):
        flags.append("established_without_supervisor_evidence")
    if card and card.external_only and verdict.confidence > 0.45:
        flags.append("external_only_but_high_confidence")
    if card and card.contradicted_by_supervisor and verdict.status in ("established", "probable"):
        flags.append("selected_hypothesis_contradicted_by_supervisor")
    if verdict.status == "undetermined" and verdict.confidence > 0.35:
        flags.append("undetermined_but_high_confidence")
    return flags


def _local(value: datetime | None, tz: str):
    """Times go to the model in the project's own time zone, as people on site would read them."""
    return value.astimezone(ZoneInfo(tz)).isoformat() if value else None


def _incident_view(incident, tz):
    return {**json.loads(incident.model_dump_json()), "occurred_at": _local(incident.occurred_at, tz)}


def _extract_payload(incident, passages, rules, tz):
    return json.dumps({
        "time_zone": tz,
        "incident": _incident_view(incident, tz),
        "project_rules": rules,
        "passages": [{"passage_ref": p.ref, "source_kind": p.kind, "author": p.author,
                      "author_role": p.author_role, "available_at": _local(p.available_at, tz),
                      "text": p.text} for p in passages]}, ensure_ascii=False)


def _decide_payload(incident, claims, hypotheses, cards, tz, errors=None):
    payload = {
        "time_zone": tz,
        "incident": _incident_view(incident, tz),
        "claims": [{"id": c.id, "passage": f"{c.source_id}#{c.locator}", "author_role": c.author_role,
                    "stance": c.stance, "statement": c.statement, "quote": c.quote,
                    "speaker_certainty": c.speaker_certainty, "derived_from": c.derived_from,
                    "stated_at": _local(c.stated_at, tz)} for c in claims],
        "hypotheses": [h.model_dump() for h in hypotheses],
        "score_cards": [c.model_dump() for c in cards]}
    if errors:
        payload["previous_answer_errors"] = errors
    return json.dumps(payload, ensure_ascii=False)


def _undetermined(incident, as_of, digest, model, reasoning, gaps, hypotheses=(), cards=(), flags=()):
    return IncidentAnalysis(
        incident_id=incident.id, as_of=as_of, status="undetermined", confidence=0.0, headline_cause=None,
        reasoning=reasoning, hypotheses=list(hypotheses), score_cards=list(cards), factual_evidence=[],
        external_claims=[], gaps=gaps, guardrail_flags=list(flags), input_digest=digest, model=model)


def analyze_incident(store: EvidenceStore, llm: LLMClient, incident_id: str,
                     as_of: datetime | None = None) -> IncidentAnalysis:
    as_of = as_of or default_as_of()
    incident = store.get_incident(incident_id)
    if incident is None:
        raise IncidentNotFound(incident_id)
    passages = store.candidate_passages(incident)
    digest = input_digest(incident.id, passages)
    if not passages:
        return _undetermined(incident, as_of, digest, llm.model,
                             "No dated records about this incident were available at this time.",
                             ["No voice note, diary, report or email is available yet."])
    tz = store.timezone()
    extracted = llm.generate_json(EXTRACT_SYSTEM, _extract_payload(incident, passages, store.rules(incident), tz))
    claims, dropped = validate_claims(extracted.get("claims"), passages)
    hypotheses = validate_hypotheses(extracted.get("hypotheses"), claims)
    if not hypotheses:
        return _undetermined(incident, as_of, digest, llm.model,
                             "No record states a reason for this incident.",
                             ["Ask the foreman or site manager what caused it and record it as a note."],
                             flags=[f"dropped_claim: {d}" for d in dropped])
    weights = {**DEFAULT_ROLE_WEIGHTS, **(store.trust_config().get("role_weights") or {})}
    cards = score_cards(hypotheses, claims, weights)

    errors, verdict = [], None
    for _ in range(2):  # one retry with validator feedback
        try:
            verdict = Verdict(**llm.generate_json(DECIDE_SYSTEM, _decide_payload(
                incident, claims, hypotheses, cards, tz, errors or None)))
            errors = verdict_errors(verdict, hypotheses, claims, cards)
        except (ValidationError, TypeError) as exc:
            verdict, errors = None, [f"invalid verdict shape: {exc}"]
        if not errors:
            break
    flags = guardrail_flags(verdict, hypotheses, claims, cards, dropped) if verdict and not errors else \
        [f"dropped_claim: {d}" for d in dropped]

    by_id = {c.id: c for c in claims}
    best = max(cards, key=lambda c: c.score)
    if errors:  # still invalid after the retry: keep the facts, ask a human
        return IncidentAnalysis(
            incident_id=incident.id, as_of=as_of, status="needs_review", confidence=best.score,
            headline_cause=None,
            reasoning=(verdict.reasoning if verdict else "The model did not produce a valid decision."),
            hypotheses=hypotheses, score_cards=cards, factual_evidence=[], external_claims=[],
            gaps=["Automatic decision failed validation; review the candidate causes manually."],
            guardrail_flags=[*flags, *[f"validation: {e}" for e in errors]], input_digest=digest, model=llm.model)
    chosen = verdict.selected_hypothesis_id
    return IncidentAnalysis(
        incident_id=incident.id, as_of=as_of, status=verdict.status, confidence=round(verdict.confidence, 3),
        headline_cause=verdict.headline_cause if verdict.status != "undetermined" else None,
        reasoning=verdict.reasoning, hypotheses=hypotheses, score_cards=cards,
        factual_evidence=[_evidence(by_id[c], claim_weight(by_id[c], weights), chosen)
                          for c in dict.fromkeys(verdict.evidence_claim_ids)],
        external_claims=[_evidence(by_id[c], claim_weight(by_id[c], weights))
                         for c in dict.fromkeys(verdict.external_claim_ids)],
        gaps=verdict.gaps, guardrail_flags=flags, input_digest=digest, model=llm.model)
