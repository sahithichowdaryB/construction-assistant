import { z } from "zod";

// Response validation for routes the backend already implements (backend/main.py).

const basis = z.enum(["signed", "provisional", "estimated", "forecast"]);
const severity = z.enum(["none", "low", "medium", "high", "critical"]);
const incidentStatus = z.enum(["pending_confirmation", "open", "monitoring", "resolved", "closed"]);
const alertStatus = z.enum(["open", "acknowledged", "in_progress", "resolved", "dismissed"]);
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
  activity_code: z.string().nullable(),
  kind: z.string(),
  checkpoint_at: z.string(),
  version: z.number(),
  as_of: z.string(),
  severity,
  // shortfall alerts carry the calculation; incident alerts carry a small summary object instead
  calculation: z.unknown().transform((c) => {
    const parsed = z.object({ planned: num, actual: num.nullable(), shortfall_pct: num.nullable(), unit: z.string() }).safeParse(c);
    return parsed.success ? parsed.data : null;
  }),
  evidence_refs: z.array(evidenceRef),
  status: alertStatus.optional(),
  title: z.string().nullish(),
  assigned_to: z.string().nullish(),
  incident_id: z.string().nullish(),
  reason: z.string().nullish(),
  analysis_id: z.string().nullish(),
  category: z.string().nullish(),
  report_count: z.number().nullish(),
  reporter_count: z.number().nullish(),
  incident_status: incidentStatus.nullish(),
  zone: z.string().nullish(),
  asset_key: z.string().nullish(),
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
  z.enum(["schedule", "register", "project", "email", "minutes", "daily_report", "voice", "photo", "diary", "text", "plan"]),
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
  file_missing: z.boolean().optional(),
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
  status: incidentStatus,
  affected_workers: z.number().nullable(),
  equipment_id: z.string().nullable(),
  category: z.string().optional(),
  event_type: z.string().optional(),
  summary: z.string().optional(),
  zone: z.string().nullish(),
  asset_key: z.string().nullish(),
  severity: severity.nullish(),
  report_count: z.number().optional(),
  reporter_count: z.number().optional(),
  first_reported_at: z.string().nullish(),
  last_reported_at: z.string().nullish(),
  merged_into_id: z.string().nullish(),
  recurrence_of_id: z.string().nullish(),
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

// ---------- incident cause analysis (GET /projects/{pid}/incidents/{id}/reasoning) ----------
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
export const incidentReasoningSchema = z.object({
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
  /** The records available now differ from those this reasoning used */
  stale: z.boolean().optional(),
});


// ---------- event pipeline ----------
export const eventCategoriesSchema = z.array(
  z.object({
    key: z.string(),
    label: z.string(),
    description: z.string(),
    icon: z.string().nullable(),
    creates_incident: z.boolean(),
    default_severity: severity.nullable(),
    sort_order: z.number(),
    types: z.array(z.object({ key: z.string(), label: z.string(), severity_hint: severity.nullable() })),
  }),
);

const nullableNum = z.number().nullable();
export const incidentEventsSchema = z.array(
  z.object({
    id: z.string(),
    summary: z.string(),
    category: z.string(),
    event_type: z.string(),
    zone: z.string().nullable(),
    recorded_by: z.string(),
    occurred_at: z.string(),
    recorded_at: z.string(),
    source_id: z.string(),
    locator: z.string(),
    suggested_category: z.string().nullable(),
    suggestion_confidence: nullableNum,
    suggestion_rationale: z.string().nullable(),
    link_type: z.enum(["origin", "corroborating", "update", "resolution", "contradicting"]),
    match_score: nullableNum,
    match_reason: z.string().nullable(),
    linked_by: z.string(),
    linked_at: z.string(),
    unlinked_at: z.string().nullable(),
    channel: z.enum(["voice", "photo", "text", "mixed"]),
    attachments: z.array(z.object({ id: z.string(), kind: z.string(), mime: z.string().nullable(), url: z.string() })),
  }),
);

const actionItem = z.object({
  id: z.string(),
  action_type: z.enum(["assign_owner", "notify_contractor", "schedule_repair", "stop_work", "isolate_area",
    "request_evidence", "draft_notice", "create_rfi", "resolve_incident"]),
  title: z.string(),
  rationale: z.string().nullable(),
  owner_role: z.string().nullable(),
  contractor_id: z.string().nullable(),
  priority: z.enum(["low", "medium", "high", "urgent"]).nullable(),
  due_at: z.string().nullable(),
  status: z.enum(["proposed", "approved", "in_progress", "done", "rejected", "superseded"]),
  proposed_by: z.string(),
  decided_by: z.string().nullable(),
  decided_at: z.string().nullable(),
  executed_at: z.string().nullable(),
  result: z.record(z.string(), z.unknown()).nullable(),
  evidence_refs: z.array(evidenceRef),
  incident_id: z.string().nullable(),
});
export const actionsSchema = z.array(actionItem);

export const alertDetailSchema = z.object({
  id: z.string(),
  status: alertStatus,
  kind: z.string(),
  title: z.string().nullable(),
  incident_id: z.string().nullable(),
  assigned_to: z.string().nullable(),
  incident: z
    .object({
      id: z.string(), category: z.string(), event_type: z.string(), summary: z.string(), zone: z.string().nullable(),
      asset_key: z.string().nullable(), status: incidentStatus, severity: severity.nullable(),
      report_count: z.number(), reporter_count: z.number(),
      first_reported_at: z.string().nullable(), last_reported_at: z.string().nullable(),
    })
    .nullable(),
  analysis: z
    .object({
      id: z.string(), version: z.number(), as_of: z.string(),
      status: z.enum(["established", "probable", "unconfirmed", "undetermined", "needs_review"]),
      confidence: num, headline_cause: z.string().nullable(), reasoning: z.string(), gaps: z.array(z.string()),
    })
    .nullable(),
  revisions: z.array(z.object({
    version: z.number(), as_of: z.string(), severity, reason: z.string().nullable(), analysis_id: z.string().nullable(),
  })),
  activity: z.array(z.object({
    id: z.string(), actor: z.string(), action: z.string(), from_status: z.string().nullable(),
    to_status: z.string().nullable(), note: z.string().nullable(), at: z.string(),
  })),
  actions: actionsSchema,
});

export const capturePromptsSchema = z.array(z.object({
  id: z.string(), title: z.string(), rationale: z.string().nullable(), owner_role: z.string().nullable(),
  incident_id: z.string().nullable(), incident_title: z.string().nullable(), decided_at: z.string().nullable(),
}));

export const okSchema = z.object({}).passthrough();

// ---------- daily recaps ----------
const recapTone = z.enum(["good", "warn", "bad", "info", "neutral"]);
const recapCover = z.enum(["excavation", "breakdown", "steel", "concrete", "rain", "formwork", "meeting", "crack"]);
const recapCardSchema = z.object({
  id: z.string(),
  chapter: z.enum(["overview", "wins", "problems", "decisions", "today"]),
  title: z.string(),
  kicker: z.string().nullish(),
  at: z.string().nullish(),
  tone: recapTone,
  cover: recapCover.nullish(),
  stats: z.array(z.object({ value: z.string(), unit: z.string().nullish(), label: z.string(), tone: recapTone.optional() })).optional(),
  quote: z.object({ text: z.string(), who: z.string() }).nullish(),
  strip: z
    .array(z.object({ from: z.string(), to: z.string(), state: z.enum(["working", "stopped", "rain", "idle"]), label: z.string().nullish() }))
    .nullish(),
  strip_label: z.string().nullish(),
  done: z.array(z.string()).optional(),
  refs: z.array(evidenceRef),
  action: z.object({ label: z.string(), href: z.string() }).nullish(),
});
export const recapsSchema = z.array(
  z.object({
    work_date: z.string(),
    available_at: z.string(),
    live: z.boolean().optional(),
    mood: z.enum(["on_plan", "minor", "disrupted", "weather"]),
    mood_label: z.string(),
    short_label: z.string(),
    cover: recapCover,
    inputs: z.object({ voice: z.number(), photo: z.number(), document: z.number(), report: z.number() }),
    cards: z.array(recapCardSchema),
  }),
);
