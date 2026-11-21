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
