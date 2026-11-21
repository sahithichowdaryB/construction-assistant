import { z } from "zod";

export const EVENT_TYPES = [
  "equipment_failure", "repair_forecast", "repair_release", "quantity_estimate", "production",
  "material_delivery", "delivery_delay", "quality_observation", "handover", "safety_incident", "other",
];

/** Event types that create a row in sitemate.incidents. */
export const INCIDENT_TYPES = new Set(["equipment_failure", "delivery_delay", "quality_observation", "safety_incident"]);

const str = z.string().nullable();
const num = z.number().nullable();
// Anthropic structured outputs allow at most 16 nullable/union fields per schema, so rarely-used fields are optional (omitted) instead.

/** The JSON structure Claude fills from the transcript (one entry per distinct event in the note). */
export const ExtractedEvent = z.object({
  event_type: z.enum(EVENT_TYPES),
  summary: z.string().describe("One sentence, written as a site diary line"),
  occurred_at: str.describe("ISO 8601 with offset, resolved from the recording time; null if not said"),
  zone: str.describe("Zone letter or name as spoken, e.g. 'B'"),
  activity_code: str.describe("Only a code from the allowed activity list, else null"),
  equipment_id_spoken: str.describe("Only if the speaker named the machine, normalised to the register ID"),
  equipment_description: str.describe("Machine type as spoken, e.g. 'excavator'"),
  material: str,
  quantity: num,
  unit: str,
  quantity_basis: z.enum(["reported", "estimated", "signed"]).nullable(),
  outstanding_quantity: num,
  workers_affected: num,
  injured_count: z.number().optional(),
  expected_restart_at: str.describe("Forecast time, ISO 8601 with offset"),
  delay_minutes: z.number().optional(),
  location: str,
  description: str,
  successor_activity_code: z.string().optional(),
  impact: z.string().optional().describe("Effect on work as described by the speaker; omit if not stated"),
  evidence_quote: z.string().describe("Exact words from the transcript supporting this event"),
});

export const ExtractionResult = z.object({ events: z.array(ExtractedEvent) });

export const ValidationResult = z.object({
  validated_facts: z.array(z.object({
    event_index: z.number().int(),
    field_name: z.string(),
    value: z.string().describe("Value as text; ISO 8601 for times, plain number for quantities"),
    basis: z.enum(["reported", "inferred", "estimated", "forecast", "signed"]),
    source: z.string().describe("'transcript', 'answer:<question id>' or 'db'"),
    evidence_refs: z.array(z.object({ source_id: z.string(), locator: z.string() }))
      .describe("Only (source_id, locator) pairs that appear in the supplied passages"),
    reasoning: z.string(),
  })),
  missing: z.array(z.object({
    event_index: z.number().int(), field_name: z.string(), rule_key: z.string(), why: z.string(),
  })),
  questions: z.array(z.object({
    id: z.string().describe("Short stable id, e.g. q1"),
    event_index: z.number().int(),
    field_name: z.string(),
    question: z.string().describe("Plain-language question for the site manager"),
    options: z.array(z.string()).nullable().describe("Candidate answers from the database, if any"),
  })),
  duplicates: z.array(z.object({ event_index: z.number().int(), incident_id: z.string(), reason: z.string() })),
  resolves: z.array(z.object({ event_index: z.number().int(), incident_id: z.string(), resolved_at: z.string() }))
    .describe("Existing open incidents this note resolves, e.g. a repair release"),
});
