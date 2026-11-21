import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { query } from "../../database/pool.js";

const STOP = new Set(["the", "and", "for", "that", "this", "with", "are", "was", "but", "can", "still", "just",
  "from", "have", "has", "our", "his", "her", "its", "not", "out", "all", "any", "some", "there", "they"]);

export const localDate = (iso, timeZone) => new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(iso));

const normZone = (zone) => zone?.replace(/^zones?\s+/i, "").trim() || null;

/** OR-query of the note's content words; parameter-safe because words are reduced to [a-z0-9]. */
function tsQuery(text) {
  const words = [...new Set((text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !STOP.has(w)))];
  return words.slice(0, 12).join(" | ") || null;
}

async function searchEvent(projectId, event, { timezone, recordedAt }) {
  const at = event.occurred_at ?? recordedAt;
  const workDate = localDate(at, timezone);
  const zone = normZone(event.zone);

  const activities = await query(
    `SELECT a.code, a.name, a.zone, a.unit, a.contractor_id, t.quantity AS planned_qty_on_date
     FROM sitemate.activities a
     LEFT JOIN sitemate.plan_targets t
       ON (t.project_id, t.activity_code, t.work_date) = (a.project_id, a.code, $4::date)
     WHERE a.project_id=$1
       AND (a.code = ANY($2) OR ($3::text IS NOT NULL AND (upper(a.zone)=upper($3) OR a.zone ILIKE '%' || $3 || '%')))
     ORDER BY (t.quantity > 0) DESC NULLS LAST, a.code`,
    [projectId, [event.activity_code, event.successor_activity_code].filter(Boolean), zone, workDate]);
  const codes = activities.map((a) => a.code);

  const equipment = await query(
    `SELECT e.id, e.description, e.owner_id, ea.activity_code AS assigned_to, ea.work_date
     FROM sitemate.equipment e
     LEFT JOIN sitemate.equipment_assignments ea
       ON (ea.project_id, ea.equipment_id, ea.work_date) = (e.project_id, e.id, $3::date)
     WHERE e.project_id=$1 AND (e.id = $2 OR ea.activity_code = ANY($4))
     ORDER BY e.id`,
    [projectId, event.equipment_id_spoken, workDate, codes]);

  const progress = codes.length ? await query(
    `SELECT o.activity_code, o.quantity, o.basis, o.source_id, o.locator
     FROM sitemate.observations o JOIN sitemate.sources s ON (s.project_id, s.id) = (o.project_id, o.source_id)
     WHERE o.project_id=$1 AND o.activity_code = ANY($2) AND o.work_date=$3 AND s.available_at <= $4
     ORDER BY (o.basis='signed') DESC, s.available_at DESC`,
    [projectId, codes, workDate, recordedAt]) : [];

  // Open incidents or ones from the last day on the same activities: duplicate / resolution candidates.
  const incidents = await query(
    `SELECT i.id, i.activity_code, i.kind, i.title, i.occurred_at, i.resolved_at,
            coalesce(json_agg(json_build_object('field', f.field_name, 'value', f.value, 'basis', f.basis))
                     FILTER (WHERE f.id IS NOT NULL), '[]') AS facts
     FROM sitemate.incidents i
     LEFT JOIN sitemate.capture_facts f
       ON (f.project_id, f.incident_id) = (i.project_id, i.id) AND f.review_status <> 'rejected'
     WHERE i.project_id=$1 AND (i.activity_code = ANY($2) OR cardinality($2) = 0)
       AND i.occurred_at <= $3 AND (i.resolved_at IS NULL OR i.occurred_at > $3::timestamptz - interval '24 hours')
     GROUP BY i.project_id, i.id ORDER BY i.occurred_at DESC LIMIT 10`,
    [projectId, codes, recordedAt]);

  // Keyword search over evidence available at recording time, plus the schedule rows of matched activities.
  // (Swap for a pgvector similarity query once passages are embedded.)
  const q = tsQuery(`${event.evidence_quote} ${event.summary}`);
  const passages = await query(
    `SELECT sp.source_id, sp.locator, sp.page, left(sp.excerpt, 500) AS excerpt, s.kind, s.available_at
     FROM sitemate.source_passages sp JOIN sitemate.sources s ON (s.project_id, s.id) = (sp.project_id, sp.source_id)
     WHERE sp.project_id=$1 AND s.available_at <= $2
       AND (sp.locator = ANY($3) OR ($4::text IS NOT NULL AND to_tsvector('english', sp.excerpt) @@ to_tsquery('english', $4)))
     ORDER BY (sp.locator = ANY($3)) DESC,
              ts_rank(to_tsvector('english', sp.excerpt), to_tsquery('english', coalesce($4, ''))) DESC
     LIMIT 8`,
    [projectId, recordedAt, codes, q]);

  return { work_date: workDate, activities, equipment, progress, incidents, passages };
}

export const databaseSearchTool = tool(
  async ({ projectId, events, timezone, recordedAt }) =>
    Promise.all(events.map((event, i) => searchEvent(projectId, event, { timezone, recordedAt })
      .then((matches) => ({ event_index: i, ...matches })))),
  {
    name: "database_search",
    description: "Find matching DB records for each extracted event: activities, equipment, progress, "
      + "open/recent incidents and evidence passages, as of the recording time.",
    schema: z.object({
      projectId: z.string(),
      events: z.array(z.any()),
      timezone: z.string(),
      recordedAt: z.string(),
    }),
  },
);
