import { z } from "zod";
import { SEED } from "./taxonomy.js";

export const EVENT_TYPES = SEED.types.map((t) => t.key);
export const EVENT_CATEGORIES = SEED.categories.map((c) => c.key);

/** Flags the speaker or photo makes explicit; they feed the hard severity rules (see severity.js). */
export const SEVERITY_FLAGS = ["hospitalisation", "fatality", "structural_collapse", "occupied_zone", "spill_to_drain",
  "sole_access"];

const Alternative = z.object({ category: z.enum(EVENT_CATEGORIES), event_type: z.enum(EVENT_TYPES) });

const str = z.string().nullable();
const num = z.number().nullable();
// Anthropic structured outputs allow at most 16 nullable/union fields per schema, so rarely-used fields are optional (omitted) instead.

/** The JSON structure Claude fills from the transcript (one entry per distinct event in the note). */
export const ExtractedEvent = z.object({
  suggested_category: z.enum(EVENT_CATEGORIES),
  suggested_event_type: z.enum(EVENT_TYPES).describe("A type that belongs to the suggested category"),
  confidence: z.number().describe("0-1: how sure you are of the suggested category"),
  rationale: z.string().describe("One sentence on why this category fits"),
  alternatives: z.array(Alternative).describe("The two next-best category/type pairs"),
  asset_key: z.string().optional().describe("Equipment register ID when the asset is known, else a slug like 'lift:goods'"),
  severity_flags: z.array(z.enum(SEVERITY_FLAGS)).optional().describe("Only flags the note or photo explicitly supports"),
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
});

/** Claude vision output for one site photo. */
export const PhotoDescription = z.object({
  description: z.string().describe("What the photo shows, factual, 1-3 sentences"),
  visible_assets: z.array(z.string()).describe("Machines, structures or materials visible"),
  hazards: z.array(z.string()).describe("Visible safety, quality or environmental problems"),
  text_in_image: z.array(z.string()).describe("Legible signs, labels or numbers"),
});

/** The correlation adjudicator's decision for an ambiguous event. */
export const Adjudication = z.object({
  decision: z.enum(["link", "new"]),
  incident_id: z.string().nullable(),
  link_type: z.enum(["corroborating", "update", "resolution", "contradicting"]).nullable(),
  confidence: z.number(),
  reason: z.string(),
});

/** Bounded severity nudge from the LLM; code clamps it to +-1 and to the hard-rule floor. */
export const SeverityAdjustment = z.object({
  adjustment: z.number().int().describe("-1, 0 or 1"),
  reason: z.string(),
});
