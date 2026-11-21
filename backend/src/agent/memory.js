import { withTransaction, query } from "../database/pool.js";
import { normalizeAssetKey } from "./assets.js";
import { correlateEvents } from "./tools/incidentCorrelation.js";
import { loadTaxonomy } from "./taxonomy.js";

const parseValue = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return v;
  if (/^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return v;
};

// Extra event fields kept on events.attributes (the typed columns hold the rest).
const ATTRIBUTE_FIELDS = ["severity_flags", "material", "quantity", "unit", "quantity_basis", "outstanding_quantity",
  "delay_minutes", "expected_restart_at", "impact", "description", "location", "evidence_quote",
  "equipment_description", "successor_activity_code"];

export const sourceKind = ({ audio, images, text }) => (audio ? "voice" : images && !text ? "photo" : "text");

/**
 * Writes the capture into project memory in ONE transaction:
 * passages -> events -> incidents/alerts (grouping under advisory locks) -> proposed capture_facts -> evidence.
 * The source and capture rows already exist (created when the upload arrived). Facts stay review_status='proposed'.
 */
export async function updateProjectMemory(state, deps = {}) {
  const { projectId, captureId, sourceId, capturedBy, transcript, recordedAt, perception = [], events, validation,
    answers, matches, context } = state;
  const taxonomy = deps.taxonomy ?? await loadTaxonomy(projectId);
  let ctxDeps = deps.correlation;
  if (!ctxDeps) { // lazy: importing the LLM client needs ANTHROPIC_API_KEY
    const { makeAdjudicator, makeSeverityAdjuster } = await import("./tools/llmSteps.js");
    ctxDeps = { adjudicate: makeAdjudicator(projectId, captureId), adjustSeverity: makeSeverityAdjuster(projectId, captureId) };
  }

  const result = await withTransaction(async (db) => {
    const passage = (locator, excerpt) => db.query(
      `INSERT INTO sitemate.source_passages (project_id, source_id, locator, page, excerpt) VALUES ($1,$2,$3,NULL,$4)
       ON CONFLICT DO NOTHING`, [projectId, sourceId, locator, excerpt]);
    if (transcript) await passage("transcript", transcript);
    for (const p of perception) await passage(`image:${p.n}`, p.passage);
    for (const a of answers) await passage(`answer:${a.id}`, `Q: ${a.question}\nA: ${a.answer}`);
    const ownRefs = [transcript && "transcript", ...perception.map((p) => `image:${p.n}`),
      ...answers.map((a) => `answer:${a.id}`)].filter(Boolean).map((l) => `${sourceId}|${l}`);

    const knownRefs = new Set([...matches.flatMap((m) => m.passages.map((p) => `${p.source_id}|${p.locator}`)), ...ownRefs]);
    const knownActivities = new Set([...context.activities.map((a) => a.code), ...matches.flatMap((m) => m.activities.map((a) => a.code))]);
    const factValue = (i, field) => validation.validated_facts.find((f) => f.event_index === i && f.field_name === field)?.value;
    const registerIds = new Set(context.equipment.map((e) => e.id));

    // 1. events (the user-confirmed category is final; the LLM suggestion is kept for auditing)
    const rows = [];
    for (const [i, event] of events.entries()) {
      const activity = factValue(i, "activity_code") ?? event.activity_code;
      const spoken = factValue(i, "equipment_id") ?? event.equipment_id_spoken;
      const equipmentId = registerIds.has(spoken) ? spoken : null;
      const assetKey = normalizeAssetKey({ asset_key: event.asset_key, equipment_id_spoken: equipmentId ?? spoken }, context.equipment);
      const occurredAt = factValue(i, "occurred_at") ?? event.occurred_at ?? recordedAt;
      const attributes = Object.fromEntries(ATTRIBUTE_FIELDS.filter((k) => event[k] != null).map((k) => [k, event[k]]));
      const locator = transcript ? "transcript" : perception[0] ? `image:${perception[0].n}` : "transcript";
      const { rows: [row] } = await db.query(
        `INSERT INTO sitemate.events
           (project_id, capture_id, source_id, locator, event_index, recorded_by, occurred_at, recorded_at,
            suggested_category, suggested_event_type, suggestion_confidence, suggestion_rationale, suggestion_alternatives,
            category, event_type, confirmed_by, confirmed_at, summary, zone, activity_code, equipment_id, asset_key,
            workers_affected, injured_count, attributes, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$6,now(),$16,$17,$18,$19,$20,$21,$22,$23,'confirmed')
         RETURNING id`,
        [projectId, captureId, sourceId, locator, i, capturedBy, occurredAt, recordedAt,
          event.suggested_category ?? null, event.suggested_event_type ?? null,
          event.confidence == null ? null : Math.min(1, Math.max(0, event.confidence)), event.rationale ?? null,
          JSON.stringify(event.alternatives ?? []), event.category, event.event_type, event.summary, event.zone ?? null,
          knownActivities.has(activity) ? activity : null, equipmentId, assetKey,
          Number.isFinite(Number(factValue(i, "workers_affected") ?? event.workers_affected)) ? Number(factValue(i, "workers_affected") ?? event.workers_affected) : null,
          event.injured_count ?? null, JSON.stringify(attributes)]);
      rows.push({ id: row.id, event_index: i, category: event.category, event_type: event.event_type, summary: event.summary,
        zone: event.zone ?? null, activity_code: knownActivities.has(activity) ? activity : null, asset_key: assetKey,
        occurred_at: occurredAt, recorded_at: recordedAt, material: event.material ?? null });
    }

    // 2. group into incidents / attach updates
    const links = await correlateEvents(db, { projectId, taxonomy, deps: ctxDeps }, rows);
    const incidentIds = Object.fromEntries(links.map((l) => [l.event_index, l.incident_id]));

    // 3. facts + evidence
    const saved = [];
    for (const f of validation.validated_facts) {
      const locator = f.source.startsWith("answer:") && answers.some((a) => `answer:${a.id}` === f.source)
        ? f.source : (transcript ? "transcript" : `image:${perception[0]?.n ?? 1}`);
      const effectiveAt = factValue(f.event_index, "occurred_at") ?? events[f.event_index]?.occurred_at ?? recordedAt;
      const { rows: [fact] } = await db.query(
        `INSERT INTO sitemate.capture_facts
           (project_id, incident_id, source_id, locator, field_name, value, basis, effective_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [projectId, incidentIds[f.event_index] ?? null, sourceId, locator, f.field_name,
          JSON.stringify(parseValue(f.value)), f.basis, effectiveAt]);
      for (const ref of f.evidence_refs.filter((r) => knownRefs.has(`${r.source_id}|${r.locator}`))) {
        await db.query(
          `INSERT INTO sitemate.fact_evidence (project_id, fact_id, source_id, locator) VALUES ($1,$2,$3,$4)
           ON CONFLICT DO NOTHING`, [projectId, fact.id, ref.source_id, ref.locator]);
      }
      saved.push({ id: fact.id, ...f });
    }
    await db.query("UPDATE sitemate.captures SET status='saved' WHERE project_id=$1 AND id=$2", [projectId, captureId]);
    return {
      source_id: sourceId, capture_id: captureId, incident_ids: incidentIds, facts: saved, gaps: validation.missing,
      incident_links: links.map((l) => ({ event_index: l.event_index, incident_id: l.incident_id, link_type: l.link_type,
        created: l.created, severity: l.severity, report_count: l.report_count, reporter_count: l.reporter_count,
        title: l.title, alert_id: l.alert_id })),
      saved_events: rows.map((r) => ({ index: r.event_index, id: r.id, category: r.category, event_type: r.event_type })),
    };
  });
  return result;
}

export async function setCaptureStatus(projectId, captureId, status) {
  await query("UPDATE sitemate.captures SET status=$3 WHERE project_id=$1 AND id=$2", [projectId, captureId, status]);
}
