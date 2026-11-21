"""Save and load immutable analysis versions. Same evidence + same incident -> the existing version."""

import json
import uuid
from datetime import datetime

from sqlalchemy import text

from .models import IncidentAnalysis


def save_analysis(conn, project_id: str, analysis: IncidentAnalysis) -> dict:
    latest = conn.execute(text("""
        SELECT id::text AS id, version, input_digest, status, confidence, headline_cause, reasoning
        FROM sitemate.incident_analyses
        WHERE project_id=:p AND incident_id=CAST(:i AS uuid) ORDER BY version DESC LIMIT 1
    """), {"p": project_id, "i": analysis.incident_id}).mappings().one_or_none()
    # Same evidence AND the same finding -> nothing new to record. A different answer is a new version.
    if (latest and latest["input_digest"] == analysis.input_digest and latest["status"] == analysis.status
            and float(latest["confidence"]) == round(analysis.confidence, 3)
            and latest["headline_cause"] == analysis.headline_cause and latest["reasoning"] == analysis.reasoning
            and analysis.status != "needs_review"):
        return {"id": latest["id"], "version": latest["version"], "reused": True}
    analysis_id, version = str(uuid.uuid4()), (latest["version"] + 1 if latest else 1)
    conn.execute(text("""
        INSERT INTO sitemate.incident_analyses
            (project_id,id,incident_id,version,as_of,status,confidence,headline_cause,reasoning,
             score_cards,guardrail_flags,gaps,external_claims,input_digest,model)
        VALUES (:p,CAST(:id AS uuid),CAST(:i AS uuid),:v,:as_of,:status,:conf,:headline,:reasoning,
                CAST(:cards AS jsonb),CAST(:flags AS jsonb),CAST(:gaps AS jsonb),CAST(:ext AS jsonb),:digest,:model)
    """), {"p": project_id, "id": analysis_id, "i": analysis.incident_id, "v": version, "as_of": analysis.as_of,
           "status": analysis.status, "conf": analysis.confidence, "headline": analysis.headline_cause,
           "reasoning": analysis.reasoning, "digest": analysis.input_digest, "model": analysis.model,
           "cards": json.dumps([c.model_dump() for c in analysis.score_cards]),
           "flags": json.dumps(analysis.guardrail_flags), "gaps": json.dumps(analysis.gaps),
           "ext": json.dumps([e.model_dump(mode="json") for e in analysis.external_claims])})
    chosen = {e.hypothesis_id for e in analysis.factual_evidence if e.hypothesis_id}
    for h in analysis.hypotheses:
        card = next(c for c in analysis.score_cards if c.hypothesis_id == h.id)
        conn.execute(text("""
            INSERT INTO sitemate.analysis_hypotheses(project_id,analysis_id,id,statement,level,score,llm_selected)
            VALUES (:p,CAST(:a AS uuid),:id,:s,:level,:score,:sel)
        """), {"p": project_id, "a": analysis_id, "id": h.id, "s": h.statement, "level": h.level,
               "score": card.score, "sel": h.id in chosen})
    for e in analysis.factual_evidence:
        conn.execute(text("""
            INSERT INTO sitemate.analysis_evidence(project_id,analysis_id,hypothesis_id,source_id,locator,
                quote,stance,author_role,weight,stated_at)
            VALUES (:p,CAST(:a AS uuid),:h,:src,:loc,:q,:stance,:role,:w,:at) ON CONFLICT DO NOTHING
        """), {"p": project_id, "a": analysis_id, "h": e.hypothesis_id, "src": e.source_id, "loc": e.locator,
               "q": e.quote, "stance": e.stance, "role": e.author_role, "w": e.weight, "at": e.stated_at})
    conn.commit()
    return {"id": analysis_id, "version": version, "reused": False}


def load_analysis(conn, project_id: str, incident_id: str, as_of: datetime | None = None):
    row = conn.execute(text("""
        SELECT id::text AS id, version, as_of, status, confidence, headline_cause, reasoning, score_cards,
               guardrail_flags, gaps, external_claims, model, created_at, input_digest
        FROM sitemate.incident_analyses
        WHERE project_id=:p AND incident_id=CAST(:i AS uuid) AND as_of <= coalesce(CAST(:cutoff AS timestamptz),'infinity')
        ORDER BY as_of DESC, version DESC LIMIT 1
    """), {"p": project_id, "i": incident_id, "cutoff": as_of}).mappings().one_or_none()
    if row is None:
        return None
    result = dict(row)
    result["confidence"] = float(result["confidence"])
    result["hypotheses"] = [dict(r) | {"score": float(r["score"])} for r in conn.execute(text("""
        SELECT id, statement, level, score, llm_selected FROM sitemate.analysis_hypotheses
        WHERE project_id=:p AND analysis_id=CAST(:a AS uuid) ORDER BY score DESC, id
    """), {"p": project_id, "a": row["id"]}).mappings()]
    result["factual_evidence"] = [dict(r) | {"weight": float(r["weight"])} for r in conn.execute(text("""
        SELECT hypothesis_id, source_id, locator, quote, stance, author_role, weight, stated_at
        FROM sitemate.analysis_evidence WHERE project_id=:p AND analysis_id=CAST(:a AS uuid)
        ORDER BY stated_at, source_id, locator
    """), {"p": project_id, "a": row["id"]}).mappings()]
    return result
