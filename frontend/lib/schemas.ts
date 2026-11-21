import { z } from "zod";

// Response validation for routes the backend already implements (backend/main.py).

const basis = z.enum(["signed", "provisional", "estimated", "forecast"]);
const severity = z.enum(["none", "medium", "high"]);
// FastAPI serialises Decimal columns as strings in some drivers; accept both and keep the number.
const num = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/).transform(Number)]);

const evidenceRef = z.object({
  source_id: z.string(),
  locator: z.string().nullish(),
  page: z.number().nullish(),
  passage_id: z.string().nullish(),
});

export const alertSchema = z.object({
  id: z.string(),
  activity_code: z.string(),
  kind: z.string(),
  checkpoint_at: z.string(),
  version: z.number(),
  as_of: z.string(),
  severity,
  calculation: z
    .object({ planned: num, actual: num.nullable(), shortfall_pct: num.nullable(), unit: z.string() })
    .nullable(),
  evidence_refs: z.array(evidenceRef),
});
export const alertsSchema = z.array(alertSchema);

export const progressSchema = z.object({
  activity_code: z.string(),
  work_date: z.string(),
  unit: z.string(),
  planned: num,
  actual: num.nullable(),
  basis: basis.nullable(),
  shortfall_pct: num.nullable(),
  severity: severity.nullable(),
  plan_evidence: z.object({ source_id: z.string(), locator: z.string() }),
  evidence: z.object({ source_id: z.string(), page: z.number().nullable(), locator: z.string() }).nullable(),
  observations: z.array(
    z.object({
      quantity: num,
      basis,
      source_id: z.string(),
      locator: z.string(),
      page: z.number().nullable(),
      excerpt: z.string().nullable(),
      available_at: z.string(),
    }),
  ),
});

export const healthSchema = z.object({
  mode: z.enum(["fixtures", "live"]),
  api: z.enum(["connected", "unreachable", "error"]),
  database: z.string().nullable(),
  detail: z.string().nullable(),
});

// ---------- incidents (GET /projects/{pid}/incidents) ----------
const evidenceRefLoose = evidenceRef;
export const incidentSchema = z.object({
  id: z.string(),
  activity_code: z.string().nullable(),
  type: z.enum(["equipment_breakdown", "defect", "delivery", "other"]),
  title: z.string(),
  occurred_at: z.string().nullable(),
  reported_at: z.string(),
  resolved_at: z.string().nullable(),
  status: z.enum(["pending_confirmation", "open", "resolved"]),
  affected_workers: z.number().nullable(),
  equipment_id: z.string().nullable(),
  refs: z.array(evidenceRefLoose),
  timeline: z.array(
    z.object({
      kind: z.enum(["reported", "evidence", "alert", "draft", "approved", "resolved"]),
      at: z.string(),
      label: z.string(),
      refs: z.array(evidenceRefLoose),
      link: z.string().nullish(),
    }),
  ),
});
export const incidentsSchema = z.array(incidentSchema);

// ---------- incident cause analysis (GET /projects/{pid}/incidents/{id}/analysis) ----------
const authorRole = z.enum([
  "site_supervisor", "foreman", "signed_report", "contractor_internal", "external", "client", "system", "unknown",
]);
const analysisEvidence = z.object({
  source_id: z.string(),
  locator: z.string(),
  quote: z.string(),
  author_role: authorRole,
  stance: z.enum(["states_cause", "speculates", "context_only", "contradicts"]),
  weight: num,
  stated_at: z.string().nullable(),
  hypothesis_id: z.string().nullish(),
});
export const incidentAnalysisSchema = z.object({
  id: z.string(),
  version: z.number(),
  as_of: z.string(),
  status: z.enum(["established", "probable", "unconfirmed", "undetermined", "needs_review"]),
  confidence: num,
  headline_cause: z.string().nullable(),
  reasoning: z.string(),
  hypotheses: z.array(
    z.object({ id: z.string(), statement: z.string(), level: z.enum(["proximate", "root"]), score: num, llm_selected: z.boolean() }),
  ),
  score_cards: z.array(
    z.object({
      hypothesis_id: z.string(),
      score: num,
      supervisor_backed: z.boolean(),
      external_only: z.boolean(),
      independent_sources: z.number(),
      contradicted_by_supervisor: z.boolean(),
      flags: z.array(z.string()),
    }),
  ),
  factual_evidence: z.array(analysisEvidence),
  external_claims: z.array(analysisEvidence),
  gaps: z.array(z.string()),
  guardrail_flags: z.array(z.string()),
  model: z.string(),
  created_at: z.string(),
});
