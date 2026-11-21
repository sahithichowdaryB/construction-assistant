import { withTransaction } from "../database/pool.js";
import { INCIDENT_TYPES } from "./schemas.js";

const parseValue = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return v;
  if (/^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return v;
};

/**
 * Writes the capture into project memory in one transaction:
 * source + passages (transcript and each manager answer) -> incidents -> proposed capture_facts -> evidence.
 * Facts stay review_status='proposed' until a person confirms them (see SiteMate capture flow).
 */
export async function updateProjectMemory(state) {
  const { projectId, sourceId, storagePath, transcript, recordedAt, events, validation, answers, matches } = state;

  return withTransaction(async (db) => {
    await db.query(
      `INSERT INTO sitemate.sources (project_id, id, kind, path, available_at) VALUES ($1,$2,'voice_note',$3,$4)`,
      [projectId, sourceId, storagePath, recordedAt]);
    await db.query(
      `INSERT INTO sitemate.source_passages (project_id, source_id, locator, page, excerpt) VALUES ($1,$2,'transcript',NULL,$3)`,
      [projectId, sourceId, transcript]);
    for (const a of answers) {
      await db.query(
        `INSERT INTO sitemate.source_passages (project_id, source_id, locator, page, excerpt) VALUES ($1,$2,$3,NULL,$4)`,
        [projectId, sourceId, `answer:${a.id}`, `Q: ${a.question}\nA: ${a.answer}`]);
    }

    // Allowed evidence: passages the search returned (as-of filtered) plus this note's own passages.
    const knownRefs = new Set(matches.flatMap((m) => m.passages.map((p) => `${p.source_id}|${p.locator}`)));
    const knownActivities = new Set(matches.flatMap((m) => m.activities.map((a) => a.code)));
    const factValue = (i, field) => validation.validated_facts.find((f) => f.event_index === i && f.field_name === field)?.value;

    // Only incidents the search actually returned for this project may be linked or resolved.
    const knownIncidents = new Set(matches.flatMap((m) => m.incidents.map((x) => x.id)));
    const incidentIds = {};
    for (const d of validation.duplicates.filter((x) => knownIncidents.has(x.incident_id))) {
      incidentIds[d.event_index] = d.incident_id;
    }
    for (const [i, event] of events.entries()) {
      if (incidentIds[i] || !INCIDENT_TYPES.has(event.event_type)) continue;
      const activity = factValue(i, "activity_code") ?? event.activity_code;
      const { rows } = await db.query(
        `INSERT INTO sitemate.incidents (project_id, activity_code, kind, title, occurred_at)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [projectId, knownActivities.has(activity) ? activity : null, event.event_type, event.summary,
          factValue(i, "occurred_at") ?? event.occurred_at ?? recordedAt]);
      incidentIds[i] = rows[0].id;
    }
    for (const r of validation.resolves.filter((x) => knownIncidents.has(x.incident_id))) {
      await db.query(
        `UPDATE sitemate.incidents SET resolved_at=$3 WHERE project_id=$1 AND id=$2 AND resolved_at IS NULL`,
        [projectId, r.incident_id, r.resolved_at]);
    }

    const saved = [];
    for (const f of validation.validated_facts) {
      const locator = f.source.startsWith("answer:") && answers.some((a) => `answer:${a.id}` === f.source)
        ? f.source : "transcript";
      const effectiveAt = factValue(f.event_index, "occurred_at") ?? events[f.event_index]?.occurred_at ?? recordedAt;
      const { rows } = await db.query(
        `INSERT INTO sitemate.capture_facts
           (project_id, incident_id, source_id, locator, field_name, value, basis, effective_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [projectId, incidentIds[f.event_index] ?? null, sourceId, locator, f.field_name,
          JSON.stringify(parseValue(f.value)), f.basis, effectiveAt]);
      for (const ref of f.evidence_refs.filter((r) => knownRefs.has(`${r.source_id}|${r.locator}`))) {
        await db.query(
          `INSERT INTO sitemate.fact_evidence (project_id, fact_id, source_id, locator) VALUES ($1,$2,$3,$4)
           ON CONFLICT DO NOTHING`,
          [projectId, rows[0].id, ref.source_id, ref.locator]);
      }
      saved.push({ id: rows[0].id, ...f });
    }
    return { source_id: sourceId, incident_ids: incidentIds, facts: saved, gaps: validation.missing };
  });
}
