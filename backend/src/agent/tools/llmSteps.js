import { config } from "../../config.js";
import { structured } from "../llm.js";
import { Adjudication, SeverityAdjustment } from "../schemas.js";
import { audited } from "../runs.js";

const adjudicator = structured(Adjudication, "incident_adjudication");
const severityJudge = structured(SeverityAdjustment, "severity_adjustment");

const ADJUDICATE_SYSTEM = `You decide whether a new site event is another report of an EXISTING open incident or a new problem.
A different asset or a different symptom means a different incident: "lift stuck at level 3" and "lift door sensor
faulty" can be the same lift and the same incident, while "crane down" is a different one. Reports from different people
about the same asset and fault are corroboration of one incident. A repair or status update links to the incident it
repairs ("update", or "resolution" when work is complete). Each candidate lists its last linked events and events a
manager unlinked from it; never re-link something that resembles an unlinked event. Return decision "new" with a null
incident_id when none fits. incident_id must be one of the candidate ids.`;

/** deps.adjudicate for correlateEvents: one audited LLM call per ambiguous event. */
export const makeAdjudicator = (projectId, captureId) => ({ event, candidates }) => {
  const input = {
    event: { summary: event.summary, category: event.category, event_type: event.event_type, zone: event.zone,
      asset_key: event.asset_key, occurred_at: event.occurred_at },
    candidates: candidates.map((c) => ({
      incident_id: c.incident.id, summary: c.incident.summary, category: c.incident.category, zone: c.incident.zone,
      asset_key: c.incident.asset_key, status: c.incident.status, score: c.score, signals: c.signals,
      last_linked_events: c.history.linked.slice(0, 5), unlinked_events: c.history.unlinked.slice(0, 5),
    })),
  };
  return audited({ projectId, captureId, agent: "correlation", model: config.claudeModel, input }, () =>
    adjudicator.invoke([{ role: "system", content: ADJUDICATE_SYSTEM }, { role: "user", content: JSON.stringify(input, null, 1) }]));
};

const SEVERITY_SYSTEM = `You review a rule-based severity for a construction incident. Respond with adjustment -1, 0 or 1 and a one-sentence
reason. Adjust only when the facts clearly warrant it (e.g. work is stopped site-wide: +1; a cosmetic issue: -1).
Default to 0. Hard rules and a floor are enforced by code regardless of your answer.`;

export const makeSeverityAdjuster = (projectId, captureId) => ({ incident, rule, stats }) => {
  const input = { incident: { summary: incident.summary, category: incident.category, zone: incident.zone,
    status: incident.status }, rule_level: rule.level, floor: rule.floor, escalators: rule.escalators, stats };
  return audited({ projectId, captureId, incidentId: incident.id, agent: "severity", model: config.claudeModel, input }, () =>
    severityJudge.invoke([{ role: "system", content: SEVERITY_SYSTEM }, { role: "user", content: JSON.stringify(input, null, 1) }]));
};
