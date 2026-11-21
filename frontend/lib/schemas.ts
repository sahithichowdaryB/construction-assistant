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

// ---------- documents and search (backend/documents/routes.py) ----------

/** Other modules write a few kinds under different names; read them as the matching document type. */
const SOURCE_TYPE_ALIASES: Record<string, string> = {
  voice_note: "voice",
  "voice-note": "voice",
  audio: "voice",
  "daily-report": "daily_report",
  report: "daily_report",
  meeting_minutes: "minutes",
  image: "photo",
  site_diary: "diary",
};
const sourceType = z.preprocess(
  (v) => (typeof v === "string" ? (SOURCE_TYPE_ALIASES[v] ?? v) : v),
  z.enum(["schedule", "register", "project", "email", "minutes", "daily_report", "voice", "photo", "diary"]),
);
const jobStatus = z.enum(["uploaded", "extracting", "indexed", "failed"]);
const ref = evidenceRef;
const cited = z.object({ text: z.string(), refs: z.array(ref) });

export const sourceSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  type: sourceType,
  title: z.string(),
  filename: z.string(),
  mime: z.string(),
  available_at: z.string(),
  status: jobStatus,
  pages: z.number().nullable(),
  note: z.string().nullish(),
  passage_count: z.number().optional(),
  summary_version: z.number().nullish(),
  review_reasons: z.array(z.string()).optional(),
  parse_status: z.string().nullish(),
  summary_status: z.string().nullish(),
  /** False for records captured in the app (typed or transcribed): there is no original file */
  has_file: z.boolean().optional(),
});
/** One malformed record must not hide the whole document list: skip it and say so in the console. */
export const sourcesSchema = z.array(z.unknown()).transform((items) =>
  items.flatMap((item) => {
    const parsed = sourceSchema.safeParse(item);
    if (parsed.success) return [parsed.data];
    const id = (item as { id?: unknown } | null)?.id;
    console.warn(`Skipped source ${String(id)}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    return [];
  }),
);

export const passageSchema = z.object({
  id: z.string(),
  source_id: z.string(),
  locator: z.string(),
  text: z.string(),
  page: z.number().nullable(),
  kind: z.string().optional(),
  section: z.string().nullish(),
  untrusted: z.boolean().optional(),
});

export const sourceDetailSchema = sourceSchema.extend({ passages: z.array(passageSchema) });

export const evidenceSchema = z.object({ passage: passageSchema, source: sourceSchema });

export const summarySchema = z.object({
  source_id: z.string(),
  title: z.string(),
  observations: z.array(cited),
  decisions: z.array(cited),
  open_actions: z.array(
    z.object({ text: z.string(), owner: z.string().nullable(), due: z.string().nullable(), quote: z.string().nullish(), refs: z.array(ref) }),
  ),
  evidence_ids: z.array(z.string()),
  headline: z.string().nullish(),
  provisional: z.array(cited).optional(),
  quoted_external_instructions: z.array(cited).optional(),
  version: z.number().optional(),
  model: z.string().nullish(),
});

export const uploadJobSchema = z.object({
  id: z.string(),
  source_id: z.string(),
  status: jobStatus,
  error: z.string().nullable(),
  created_at: z.string(),
  review_reasons: z.array(z.string()).optional(),
  duplicate: z.boolean().optional(),
  /** When the source counts as received (documents upload only) */
  available_at: z.string().optional(),
});

export const readingsSchema = z.object({
  source_id: z.string(),
  job_status: z.string(),
  review_reasons: z.array(z.string()),
  readings: z.array(
    z.object({
      activity_code: z.string(),
      work_date: z.string(),
      value: num,
      unit: z.string(),
      basis,
      locator: z.string(),
      page: z.number().nullable(),
      planned_on_report: num.nullable(),
      review_status: z.enum(["proposed", "accepted", "conflict"]),
      accepted_value: num.nullable(),
      ref,
    }),
  ),
});

export const searchSchema = z.object({
  query: z.string(),
  reranked: z.boolean(),
  results: z.array(
    z.object({
      passage_id: z.string(),
      source_id: z.string(),
      locator: z.string(),
      page: z.number().nullable(),
      excerpt: z.string(),
      kind: z.string(),
      section: z.string().nullable(),
      untrusted: z.boolean(),
      source_kind: sourceType,
      source_title: z.string().nullable(),
      available_at: z.string(),
      score: z.number(),
      ref,
    }),
  ),
});

export const actionItemsSchema = z.array(
  z.object({
    id: z.string(),
    description: z.string(),
    owner_name: z.string().nullable(),
    due_at: z.string().nullable(),
    completed_at: z.string().nullable(),
    quote: z.string().nullable(),
    source_id: z.string(),
    source_type: sourceType,
    source_title: z.string().nullable(),
    available_at: z.string(),
    overdue: z.boolean(),
    ref,
  }),
);

export const storageSchema = z.object({
  source_id: z.string(),
  file: z.object({
    location: z.string(),
    path: z.string(),
    sha256: z.string().nullable(),
    size_bytes: z.number().nullable(),
    mime: z.string(),
    available: z.boolean(),
  }),
  tables: z.array(
    z.object({
      table: z.string(),
      stores: z.string(),
      columns: z.array(z.string()),
      rows: z.array(z.array(z.unknown())),
      row_count: z.number(),
      truncated: z.boolean(),
    }),
  ),
});

const previewBlockSchema = z.object({
  type: z.enum(["title", "heading", "paragraph", "list", "table"]),
  text: z.string().optional(),
  level: z.number().nullable().optional(),
  locator: z.string().nullable().optional(),
  rows: z.array(z.array(z.string())).optional(),
  locators: z.array(z.string()).optional(),
  flagged: z.boolean().optional(),
});

export const previewSchema = z.discriminatedUnion("kind", [
  z.object({ source_id: z.string(), kind: z.literal("document"), blocks: z.array(previewBlockSchema) }),
  z.object({
    source_id: z.string(),
    kind: z.literal("email"),
    headers: z.array(z.object({ name: z.string(), value: z.string() })),
    attachments: z.array(z.string()),
    blocks: z.array(previewBlockSchema),
  }),
  z.object({
    source_id: z.string(),
    kind: z.literal("table"),
    columns: z.array(z.string()),
    rows: z.array(z.array(z.string())),
    row_count: z.number(),
    truncated: z.boolean(),
  }),
  z.object({ source_id: z.string(), kind: z.literal("text"), text: z.string(), language: z.string().optional() }),
]);

export const actionUpdateSchema =z.object({ id: z.string(), completed_at: z.string().nullable() });

export const healthSchema = z.object({
  mode: z.enum(["fixtures", "live"]),
  api: z.enum(["connected", "unreachable", "error"]),
  database: z.string().nullable(),
  detail: z.string().nullable(),
});
