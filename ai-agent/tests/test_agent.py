import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.llm import FakeLLM  # noqa: E402
from app.models import Claim, Hypothesis, Incident, Passage  # noqa: E402
from app.orchestrator import analyze_incident, validate_claims  # noqa: E402
from app.scoring import EXTERNAL_ONLY_CAP, score_cards  # noqa: E402

T = datetime(2026, 11, 10, 10, 15, tzinfo=timezone.utc)
INCIDENT = Incident(id="inc1", activity_code="EXC-B", kind="equipment_failure",
                    title="EX-02 breakdown", occurred_at=datetime(2026, 11, 10, 9, 0, tzinfo=timezone.utc))
V01 = Passage(source_id="V01", locator="seg:2", kind="voice", author="Foreman", author_role="foreman",
              available_at=T, text="Hydraulic hose burst.")
E01 = Passage(source_id="E01", locator="para:1", kind="email", author="plant@groundworks", author_role="external",
              available_at=T, text="The routine service on EX-02 is overdue. We have no diagnosis of a hydraulic fault today.")
E09 = Passage(source_id="E09", locator="para:1", kind="email", author="vendor", author_role="external",
              available_at=T, text="Operator misuse destroyed the hose.")


class Store:
    def __init__(self, passages):
        self.passages = passages

    def get_incident(self, _):
        return INCIDENT

    def candidate_passages(self, _):
        return self.passages

    def rules(self, _):
        return []

    def trust_config(self):
        return {}


def claim(cid, passage, stance="states_cause", role=None, **kw):
    return Claim(id=cid, source_id=passage.source_id, locator=passage.locator, quote="x", stance=stance,
                 statement="s", author_role=role or passage.author_role, **kw)


def test_supervisor_cause_scores_high_external_only_is_capped():
    claims = [claim("c1", V01), claim("c2", E09)]
    cards = {c.hypothesis_id: c for c in score_cards(
        [Hypothesis(id="h1", statement="hose", supporting=["c1"]),
         Hypothesis(id="h2", statement="misuse", supporting=["c2"])], claims)}
    assert cards["h1"].score >= 0.85 and cards["h1"].supervisor_backed
    assert cards["h2"].external_only and cards["h2"].score <= EXTERNAL_ONLY_CAP
    assert "external_only" in cards["h2"].flags


def test_repeat_claims_do_not_inflate_score():
    c1 = claim("c1", V01)
    c2 = claim("c2", V01, derived_from="c1")
    one = score_cards([Hypothesis(id="h", statement="x", supporting=["c1"])], [c1])[0].score
    both = score_cards([Hypothesis(id="h", statement="x", supporting=["c1", "c2"])], [c1, c2])[0].score
    assert one == both


def test_context_only_claim_gives_no_support():
    card = score_cards([Hypothesis(id="h", statement="service overdue", supporting=["c1"])],
                       [claim("c1", E01, stance="context_only")])[0]
    assert card.score == 0 and "no_cause_statement" in card.flags


def test_supervisor_contradiction_lowers_score():
    claims = [claim("c1", E09), claim("c2", V01, stance="contradicts")]
    card = score_cards([Hypothesis(id="h", statement="misuse", supporting=["c1"], contradicting=["c2"])], claims)[0]
    assert card.contradicted_by_supervisor and card.score < 0.15


def test_fabricated_quote_is_dropped():
    kept, dropped = validate_claims([
        {"id": "c1", "passage_ref": "V01#seg:2", "quote": "hydraulic HOSE burst", "stance": "states_cause", "statement": "s"},
        {"id": "c2", "passage_ref": "V01#seg:2", "quote": "the pump seized", "stance": "states_cause", "statement": "s"},
    ], [V01])
    assert [c.id for c in kept] == ["c1"] and kept[0].author_role == "foreman" and len(dropped) == 1


def extraction(*claims, hypotheses):
    return {"claims": list(claims), "hypotheses": hypotheses}


GOOD_CLAIMS = [
    {"id": "c1", "passage_ref": "V01#seg:2", "quote": "Hydraulic hose burst", "stance": "states_cause", "statement": "hose burst"},
    {"id": "c2", "passage_ref": "E09#para:1", "quote": "Operator misuse", "stance": "states_cause", "statement": "misuse"},
]
HYPS = [{"id": "h1", "statement": "Hydraulic hose burst", "supporting": ["c1"], "contradicting": ["c2"]},
        {"id": "h2", "statement": "Operator misuse", "supporting": ["c2"], "contradicting": ["c1"]}]


def test_llm_decides_and_supervisor_wins():
    llm = FakeLLM(extraction(*GOOD_CLAIMS, hypotheses=HYPS), {
        "status": "probable", "selected_hypothesis_id": "h1", "headline_cause": "Hydraulic hose burst",
        "confidence": 0.8, "reasoning": "Foreman stated it; vendor email disputes.", "score_deviation_reason": None,
        "evidence_claim_ids": ["c1"], "external_claim_ids": ["c2"], "gaps": ["Why the hose failed"]})
    result = analyze_incident(Store([V01, E09]), llm, "inc1", T)
    assert result.status == "probable" and result.confidence == 0.8
    assert [e.source_id for e in result.factual_evidence] == ["V01"]
    assert [e.source_id for e in result.external_claims] == ["E09"]
    assert result.factual_evidence[0].stated_at == T


def test_bad_citation_retries_then_succeeds():
    bad = {"status": "probable", "selected_hypothesis_id": "h1", "headline_cause": "x", "confidence": 0.8,
           "reasoning": "r", "evidence_claim_ids": ["c9"]}
    good = {**bad, "evidence_claim_ids": ["c1"]}
    llm = FakeLLM(extraction(*GOOD_CLAIMS, hypotheses=HYPS), bad, good)
    result = analyze_incident(Store([V01, E09]), llm, "inc1", T)
    assert result.status == "probable" and "previous_answer_errors" in llm.calls[-1][1]


def test_persistent_invalid_decision_becomes_needs_review():
    bad = {"status": "established", "selected_hypothesis_id": "h9", "headline_cause": "x", "confidence": 0.9,
           "reasoning": "r"}
    llm = FakeLLM(extraction(*GOOD_CLAIMS, hypotheses=HYPS), bad, bad)
    result = analyze_incident(Store([V01, E09]), llm, "inc1", T)
    assert result.status == "needs_review" and any(f.startswith("validation:") for f in result.guardrail_flags)


def test_large_deviation_requires_reason():
    base = {"status": "probable", "selected_hypothesis_id": "h1", "headline_cause": "x", "confidence": 0.3,
            "reasoning": "r", "evidence_claim_ids": ["c1"]}
    fixed = {**base, "score_deviation_reason": "Single unmeasured statement"}
    llm = FakeLLM(extraction(*GOOD_CLAIMS, hypotheses=HYPS), base, fixed)
    result = analyze_incident(Store([V01, E09]), llm, "inc1", T)
    assert result.status == "probable" and result.confidence == 0.3


def test_no_passages_is_undetermined_without_llm_call():
    llm = FakeLLM()
    result = analyze_incident(Store([]), llm, "inc1", T)
    assert result.status == "undetermined" and result.confidence == 0 and not llm.calls


def test_context_only_records_give_undetermined():
    claims = [{"id": "c1", "passage_ref": "E01#para:1", "quote": "no diagnosis of a hydraulic fault",
               "stance": "context_only", "statement": "no diagnosis"}]
    hyps = [{"id": "h1", "statement": "Overdue service", "level": "root", "supporting": ["c1"]}]
    llm = FakeLLM(extraction(*claims, hypotheses=hyps), {
        "status": "undetermined", "selected_hypothesis_id": None, "headline_cause": None, "confidence": 0.05,
        "reasoning": "Nobody states why it failed.", "evidence_claim_ids": [], "gaps": ["No statement of cause"]})
    result = analyze_incident(Store([E01]), llm, "inc1", T)
    assert result.status == "undetermined" and result.headline_cause is None and result.factual_evidence == []
    assert "injected" not in result.reasoning
