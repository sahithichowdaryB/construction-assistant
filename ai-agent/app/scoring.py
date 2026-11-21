"""Deterministic score cards. They are advisory inputs for the LLM, not the verdict."""

from .models import Claim, Hypothesis, ScoreCard

DEFAULT_ROLE_WEIGHTS = {
    "signed_report": 1.0, "site_supervisor": 0.9, "foreman": 0.9, "contractor_internal": 0.6,
    "system": 0.5, "client": 0.4, "external": 0.35, "unknown": 0.2,
}
SUPERVISOR_ROLES = {"site_supervisor", "foreman", "signed_report"}
STANCE_FACTOR = {"states_cause": 1.0, "speculates": 0.4, "context_only": 0.0, "contradicts": 0.0}
EXTERNAL_ONLY_CAP = 0.45
CONTRADICTION_PENALTY = 0.7


def _or(weights):
    miss = 1.0
    for w in weights:
        miss *= 1.0 - w
    return 1.0 - miss


def claim_weight(claim: Claim, role_weights: dict) -> float:
    return role_weights.get(claim.author_role, 0.2) * STANCE_FACTOR[claim.stance] * claim.speaker_certainty


def _lineage(claim: Claim, by_id: dict) -> str:
    seen = set()
    while claim.derived_from and claim.derived_from in by_id and claim.id not in seen:
        seen.add(claim.id)
        claim = by_id[claim.derived_from]
    return claim.id


def _independent_weights(ids, by_id, role_weights):
    """One weight per source lineage (the strongest), so repeats never inflate a score."""
    best = {}
    for cid in ids:
        claim = by_id.get(cid)
        if claim is None:
            continue
        key = (claim.source_id, _lineage(claim, by_id))
        best[key] = max(best.get(key, 0.0), claim_weight(claim, role_weights))
    return best


def score_cards(hypotheses: list[Hypothesis], claims: list[Claim], role_weights: dict | None = None):
    role_weights = {**DEFAULT_ROLE_WEIGHTS, **(role_weights or {})}
    by_id = {c.id: c for c in claims}
    cards = []
    for h in hypotheses:
        support = _independent_weights(h.supporting, by_id, role_weights)
        # A contradicting claim counts with the weight of its speaker, whatever its stance factor.
        against = {}
        for cid in h.contradicting:
            claim = by_id.get(cid)
            if claim is not None:
                key = (claim.source_id, _lineage(claim, by_id))
                against[key] = max(against.get(key, 0.0),
                                   role_weights.get(claim.author_role, 0.2) * claim.speaker_certainty)
        support_roles = {by_id[c].author_role for c in h.supporting
                         if c in by_id and STANCE_FACTOR[by_id[c].stance] > 0}
        against_roles = {by_id[c].author_role for c in h.contradicting if c in by_id}
        supervisor_backed = bool(support_roles & SUPERVISOR_ROLES)
        external_only = bool(support_roles) and not supervisor_backed
        score = _or(support.values()) * (1 - CONTRADICTION_PENALTY * _or(against.values()))
        flags = []
        if external_only:
            score = min(score, EXTERNAL_ONLY_CAP)
            flags.append("external_only")
        if not support_roles:
            flags.append("no_cause_statement")
        if against_roles & SUPERVISOR_ROLES:
            flags.append("contradicted_by_supervisor")
        cards.append(ScoreCard(
            hypothesis_id=h.id, score=round(score, 3), supervisor_backed=supervisor_backed,
            external_only=external_only, independent_sources=len({k[0] for k, w in support.items() if w > 0}),
            contradicted_by_supervisor=bool(against_roles & SUPERVISOR_ROLES), flags=flags))
    return cards
