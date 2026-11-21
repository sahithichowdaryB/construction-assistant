/**
 * Performance evaluation (backend/performance): baselines, daily evaluations, overall snapshot, ledger.
 * Every number shown comes from the server; this module only fetches, validates and labels.
 * Calls go through the /api/sm proxy like lib/workflow.ts, scoped to the As of clock.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { useApp } from "@/components/providers/app-context";
import { ApiError } from "@/lib/api";
import type { EvidenceRef } from "@/lib/types";

const num = z.number();
const refs = z.array(z.string()).default([]);
const cited = z.object({ text: z.string(), refs }).passthrough();

const attributionSchema = z
  .object({
    subject: z.string().optional(),
    explanation: z.string(),
    cause_category: z.string(),
    confidence: num,
    refs,
    excusable: z.boolean().optional(),
    status: z.string().optional(),
    flags: z.array(z.string()).optional(),
    analysis: z.object({ status: z.string(), confidence: num, headline_cause: z.string().nullable() }).nullable().optional(),
  })
  .passthrough();

const dayActivitySchema = z.object({
  code: z.string(),
  name: z.string().nullable(),
  unit: z.string().nullable(),
  planned: num,
  actual: num.nullable(),
  basis: z.string().nullable(),
  variance: num.nullable(),
  variance_pct: num.nullable(),
  status: z.enum(["exceeded", "on_track", "behind", "not_reported", "unplanned_work", "late_start", "not_started_ok"]),
  severity: z.enum(["none", "amber", "red"]),
  escalated: z.boolean(),
  days_late: num.nullable(),
  estimate: z.object({ value: num, ref: z.string() }).passthrough().nullable(),
  attribution: attributionSchema.nullable(),
  refs,
});

const suggestionSchema = z
  .object({
    type: z.enum(["delay_notice", "additional_cost_notice", "defect_notice", "notice_of_concern"]),
    activity_code: z.string().nullable().optional(),
    equipment_id: z.string().nullable().optional(),
    deadline: z.string(),
    reason: z.string(),
    refs,
    alert_id: z.string().nullable().optional(),
    amount: num.nullable().optional(),
    currency: z.string().nullable().optional(),
    addressee_role: z.string().nullable().optional(),
  })
  .passthrough();

const ledgerEntrySchema = z
  .object({
    id: z.string(),
    work_date: z.string(),
    activity_code: z.string().nullable(),
    subject: z.string(),
    rule_key: z.string(),
    kind: z.enum(["merit", "demerit"]),
    points: num,
    cause_category: z.string().nullable(),
    excusable: z.boolean(),
    refs,
    status: z.enum(["proposed", "accepted", "disputed"]),
    note: z.string().nullable(),
    reviewer_name: z.string().nullable().optional(),
    detail: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const summarySchema = z
  .object({
    status: z.string().optional(),
    headline: z.object({ text: z.string(), refs, source: z.string().optional() }),
    work_done: z.array(cited).default([]),
    disruptions: z.array(cited).default([]),
    resources: z.array(cited).default([]),
    deliveries: z.array(cited).default([]),
    weather: z.array(cited).default([]),
    instructions_received: z.array(cited.extend({ concern: z.boolean().optional(), quoted: z.boolean().optional() })).default([]),
    safety_quality: z.array(cited).default([]),
    open_items: z.array(cited.extend({ owner: z.string().nullable().optional(), due: z.string().nullable().optional() })).default([]),
  })
  .passthrough();

const idleSchema = z
  .object({ equipment_id: z.string(), description: z.string().nullable().optional(), hours: num.nullable(), severity: z.string(),
            note: z.string().nullable().optional(), refs, attribution: attributionSchema.nullable().optional() })
  .passthrough();

export const dailySchema = z.object({
  work_date: z.string(),
  version: num,
  as_of: z.string(),
  baseline_id: z.string().nullable(),
  day_status: z.string(),
  day_severity: z.enum(["none", "amber", "red"]),
  day_score: num,
  provisional: z.boolean(),
  status: z.string(),
  model: z.string().nullable(),
  trigger: z.string().nullable(),
  notes: z.array(z.string()).default([]),
  summary: summarySchema,
  activities: z.array(dayActivitySchema),
  indicators: z
    .object({
      equipment_idle: z.array(idleSchema).default([]),
      quality_holds: z.array(z.object({ text: z.string().nullable(), failed: z.boolean(), refs }).passthrough()).default([]),
      missing_report: z.object({ activities: z.array(z.string()), after_sweep: z.boolean() }).passthrough().nullable().optional(),
    })
    .passthrough(),
  suggestions: z.array(suggestionSchema),
  ledger: z.array(ledgerEntrySchema),
  disclaimer: z.string(),
});

const perfActivitySchema = z
  .object({
    code: z.string(),
    name: z.string().nullable(),
    unit: z.string().nullable(),
    planned_total: num.nullable(),
    planned_cum: num,
    actual_cum: num,
    backlog: num,
    pct_complete_planned: num.nullable(),
    pct_complete_actual: num.nullable(),
    days_behind: num.nullable(),
    recent_rate: num.nullable(),
    forecast_finish: z.string().nullable(),
    finish_variance_days: num.nullable(),
    planned_start: z.string().nullable(),
    planned_finish: z.string().nullable(),
    is_critical: z.boolean(),
    forecast_critical: z.boolean(),
    flags: z.array(z.string()),
    assumed_days_before_tracking: num.optional(),
    attribution_split: z.object({ by_cause: z.record(z.string(), num), excusable_days: num, non_excusable_days: num }).passthrough(),
  })
  .passthrough();

const milestoneSchema = z
  .object({ code: z.string(), name: z.string().nullable(), planned_date: z.string().nullable(), forecast_date: z.string().nullable(),
            variance_days: num.nullable(), contractual: z.boolean(), state: z.string(), refs })
  .passthrough();

export const snapshotSchema = z.object({
  as_of_date: z.string(),
  version: num,
  as_of: z.string(),
  status: z.string(),
  model: z.string().nullable(),
  score: num,
  metrics: z
    .object({
      weighted_planned_pct: num.nullable(),
      weighted_actual_pct: num.nullable(),
      weight_basis: z.string().nullable(),
      points_behind: num,
      cumulative_band: z.string(),
      spi: num.nullable(),
      spi_band: z.string().nullable(),
      planned_completion: z.string().nullable(),
      forecast_completion: z.string().nullable(),
      completion_variance_days: num.nullable(),
      overall_status: z.enum(["ahead", "on_plan", "at_risk", "delayed"]),
      critical_path: z.array(z.string()),
      milestones: z.array(milestoneSchema),
      ld_exposure: z.object({ amount: num, currency: z.string().nullable(), days_late: num, label: z.string() }).passthrough().nullable(),
      activities: z.array(perfActivitySchema),
      recovery: z.array(z.object({ code: z.string(), days_recovered: num.nullable() }).passthrough()),
      attribution: z.object({ excusable_days: num, non_excusable_days: num, label: z.string() }),
      score: num,
      weekly: z.array(z.object({ week: z.string(), merits: num, demerits: num, score: num })),
      best_days: z.array(z.object({ work_date: z.string(), points: num })),
      worst_days: z.array(z.object({ work_date: z.string(), points: num })),
      ledger_counts: z.record(z.string(), num),
      tracking_start: z.string().nullable().optional(),
      open_suggestions: z.array(suggestionSchema.extend({ work_date: z.string() })).default([]),
      zero_rate_activities: z.array(z.string()).default([]),
    })
    .passthrough(),
  s_curve: z.array(z.object({ date: z.string(), planned_pct: num, actual_pct: num.nullable() })),
  narrative: z
    .object({
      source: z.string().optional(),
      status: z.string().optional(),
      overall_status: z.string(),
      disclaimer: z.string(),
      status_explanation: cited.nullable().optional(),
      trend: cited.nullable().optional(),
      merits: z.array(cited).default([]),
      demerits: z.array(cited).default([]),
      risks: z.array(cited).default([]),
      recommended_actions: z.array(cited).default([]),
      correspondence_to_consider: z.array(cited).default([]),
    })
    .passthrough(),
  disclaimer: z.string(),
});

const reasonSchema = z.object({ severity: z.enum(["blocking", "warning"]), subject: z.string(), message: z.string(), refs });
const baselineSummarySchema = z
  .object({
    id: z.string(),
    revision: num,
    status: z.enum(["draft", "active", "superseded"]),
    extraction_status: z.enum(["queued", "running", "done", "needs_review", "failed"]),
    title: z.string().nullable(),
    source_ids: z.array(z.string()),
    model: z.string().nullable(),
    error: z.string().nullable(),
    created_at: z.string(),
    activated_at: z.string().nullable(),
    review_reasons: z.array(reasonSchema),
    blocking: num,
    counts: z.record(z.string(), num),
    weights_total: num,
  })
  .passthrough();
export const extractedActivitySchema = z
  .object({
    code: z.string(),
    name: z.string().nullable().optional(),
    trade: z.string().nullable().optional(),
    unit: z.string().nullable().optional(),
    planned_start: z.string().nullable().optional(),
    planned_finish: z.string().nullable().optional(),
    duration_wd: num.nullable().optional(),
    planned_total: num.nullable().optional(),
    target_per_day: num.nullable().optional(),
    weight_pct: num.nullable().optional(),
    predecessors: z.array(z.string()).default([]),
    is_critical: z.boolean().nullable().optional(),
    refs,
    missing: z.array(z.string()).default([]),
    derived: z.array(z.string()).default([]),
    manager_fields: z.array(z.string()).optional(),
  })
  .passthrough();
const baselineDetailSchema = baselineSummarySchema.extend({
  extracted: z
    .object({
      activities: z.array(extractedActivitySchema).default([]),
      milestones: z.array(z.object({ code: z.string(), name: z.string(), planned_date: z.string().nullable(), contractual: z.boolean(), refs }).passthrough()).default([]),
      missing: z.array(z.string()).default([]),
    })
    .passthrough(),
  settings_preview: z.record(z.string(), z.unknown()),
  sources: z.array(z.object({ id: z.string(), title: z.string().nullable(), filename: z.string().nullable(), pages: z.string().nullable() }).passthrough()),
});

export type DailyEvaluation = z.infer<typeof dailySchema>;
export type DailyActivity = z.infer<typeof dayActivitySchema>;
export type Suggestion = z.infer<typeof suggestionSchema>;
export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Baseline = z.infer<typeof baselineDetailSchema>;
export type BaselineSummary = z.infer<typeof baselineSummarySchema>;
export type ExtractedActivity = z.infer<typeof extractedActivitySchema>;

/** "R10:EXC-B" -> the EvidenceRef the citation chips and the evidence viewer use. */
export function toRef(ref: string): EvidenceRef {
  const i = ref.indexOf(":");
  return i < 0 ? { source_id: ref } : { source_id: ref.slice(0, i), locator: ref.slice(i + 1), passage_id: ref };
}
export const toRefs = (list: string[] | undefined) => (list ?? []).map(toRef);

export const STATUS_TEXT: Record<DailyActivity["status"], string> = {
  exceeded: "Ahead of plan",
  on_track: "On plan",
  behind: "Behind plan",
  not_reported: "Not reported",
  unplanned_work: "Off-plan work",
  late_start: "Late start",
  not_started_ok: "Not due yet",
};
export const NOTICE_TEXT: Record<Suggestion["type"], string> = {
  delay_notice: "Delay notice",
  additional_cost_notice: "Additional cost notice",
  defect_notice: "Defect notice",
  notice_of_concern: "Notice of concern",
};
export const OVERALL_TEXT: Record<Snapshot["metrics"]["overall_status"], string> = {
  ahead: "Ahead",
  on_plan: "On plan",
  at_risk: "At risk",
  delayed: "Delayed",
};
export const CAUSE_TEXT: Record<string, string> = {
  contractor_internal: "Own resources",
  subcontractor: "Subcontractor",
  client: "Client",
  designer: "Designer",
  supplier: "Supplier",
  weather: "Weather",
  third_party: "Third party",
  unknown: "Cause unknown",
};
export const RULE_TEXT: Record<string, string> = {
  "day.exceeded": "Beat the daily target",
  "backlog.recovered": "Backlog recovered",
  "activity.early_finish": "Finished early",
  "milestone.met": "Milestone met",
  "quality.first_time_pass": "Passed first time",
  "day.shortfall_amber": "Shortfall (amber)",
  "day.shortfall_red": "Shortfall (red)",
  "activity.late_start": "Late start",
  "equipment.idle": "Equipment idle",
  "report.missing": "Report missing",
  "quality.hold_failed": "Hold point failed",
  "milestone.missed": "Milestone missed",
};

async function call<S extends z.ZodTypeAny>(path: string, schema: S, init?: RequestInit): Promise<z.infer<S>> {
  let res: Response;
  try {
    res = await fetch(`/api/sm${path}`, { cache: "no-store", ...init });
  } catch {
    throw new ApiError(0, "Network error. Check your connection.");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = data?.detail;
    throw new ApiError(res.status, typeof detail === "string" ? detail : `Request failed (${res.status})`);
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new ApiError(502, `Unexpected response from ${path.split("?")[0]}`);
  return parsed.data;
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

function useBase() {
  const { projectId, asOf } = useApp();
  return { base: `/projects/${encodeURIComponent(projectId)}`, asOf, a: encodeURIComponent(asOf), projectId };
}

// ---------- daily

export function useDailyEvaluation(date: string | null) {
  const { base, a, asOf, projectId } = useBase();
  return useQuery({
    queryKey: ["sm", projectId, "perf", "day", date, asOf],
    enabled: !!date,
    queryFn: () => call(`${base}/daily-evaluations/${date}?as_of=${a}`, dailySchema),
  });
}

export function useRecomputeDay() {
  const { base, a, projectId } = useBase();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (date: string) =>
      call(`${base}/daily-evaluations/${date}/recompute?as_of=${a}`, z.object({ queued: z.boolean() }).passthrough(), { method: "POST" }),
    onSuccess: () => {
      // The run continues in the background (summary and attribution); refresh a few times.
      for (const ms of [4000, 12000, 30000]) setTimeout(() => void qc.invalidateQueries({ queryKey: ["sm", projectId, "perf"] }), ms);
    },
  });
}

/** Draft the suggested notice through the existing POST /drafts flow. Nothing is sent. */
export function useDraftSuggestion() {
  const { base, a, projectId } = useBase();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (s: Suggestion) =>
      call(`${base}/drafts?as_of=${a}`, z.object({ id: z.string(), notice_type: z.string() }).passthrough(),
        jsonInit("POST", { alert_id: s.alert_id, notice_type: s.type })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sm", projectId] }),
  });
}

// ---------- overall

export function usePerformance(date: string | null) {
  const { base, a, asOf, projectId } = useBase();
  return useQuery({
    queryKey: ["sm", projectId, "perf", "snapshot", date, asOf],
    queryFn: () => call(`${base}/performance?as_of=${a}${date ? `&date=${date}` : ""}`, snapshotSchema),
  });
}

export function useRegenerateNarrative() {
  const { base, a, projectId } = useBase();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (date: string) =>
      call(`${base}/performance/narrative?date=${date}&as_of=${a}`, z.object({ queued: z.boolean() }).passthrough(), { method: "POST" }),
    onSuccess: () => {
      for (const ms of [6000, 15000, 35000]) setTimeout(() => void qc.invalidateQueries({ queryKey: ["sm", projectId, "perf"] }), ms);
    },
  });
}

export function useLedger(to: string | null) {
  const { base, a, asOf, projectId } = useBase();
  return useQuery({
    queryKey: ["sm", projectId, "perf", "ledger", to, asOf],
    enabled: !!to,
    queryFn: () => call(`${base}/performance/ledger?to=${to}&as_of=${a}`, z.object({ entries: z.array(ledgerEntrySchema), score: num })),
  });
}

export function useReviewLedger() {
  const { base, a, projectId } = useBase();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; status: "accepted" | "disputed" | "proposed"; note?: string }) =>
      call(`${base}/performance/ledger/${input.id}?as_of=${a}`, z.object({ id: z.string() }).passthrough(),
        jsonInit("PATCH", { status: input.status, note: input.note ?? null })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sm", projectId, "perf"] }),
  });
}

export function reportUrl(projectId: string, date: string, asOf: string, fmt: "pdf" | "docx") {
  return `/api/sm/projects/${encodeURIComponent(projectId)}/performance/report.${fmt}?date=${date}&as_of=${encodeURIComponent(asOf)}`;
}

// ---------- baselines

export function useBaselines() {
  const { base, projectId } = useBase();
  return useQuery({
    queryKey: ["sm", projectId, "perf", "baselines"],
    queryFn: () => call(`${base}/baselines`, z.object({ active_id: z.string().nullable(), baselines: z.array(baselineSummarySchema) })),
    refetchInterval: (q) => (q.state.data?.baselines.some((b) => ["queued", "running"].includes(b.extraction_status)) ? 4000 : false),
  });
}

export function useBaseline(id: string | null) {
  const { base, projectId } = useBase();
  return useQuery({
    queryKey: ["sm", projectId, "perf", "baseline", id],
    enabled: !!id,
    queryFn: () => call(`${base}/baselines/${id}`, baselineDetailSchema),
    refetchInterval: (q) => (["queued", "running"].includes(q.state.data?.extraction_status ?? "") ? 4000 : false),
  });
}

export function useUploadBaseline() {
  const { base, projectId } = useBase();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { files: File[]; title?: string }) => {
      const form = new FormData();
      for (const f of input.files) form.append("files", f, f.name);
      if (input.title) form.set("title", input.title);
      return call(`${base}/baselines`, baselineSummarySchema, { method: "POST", body: form });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sm", projectId, "perf"] }),
  });
}

export function usePatchBaseline(id: string) {
  const { base, projectId } = useBase();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { activities?: Partial<ExtractedActivity>[]; normalize_weights?: boolean }) =>
      call(`${base}/baselines/${id}`, baselineDetailSchema, jsonInit("PATCH", body)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sm", projectId, "perf"] }),
  });
}

export function useActivateBaseline(id: string) {
  const { base, a, projectId } = useBase();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { normalize_weights: boolean }) =>
      call(`${base}/baselines/${id}/activate?as_of=${a}`, z.object({ activities: num }).passthrough(), jsonInit("POST", body)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sm", projectId] }),
  });
}

/** Working-day countdown is computed on the server; this only says how far the deadline is from the clock day. */
export function deadlineLabel(deadline: string, clockDate: string): { text: string; tone: "red" | "amber" | "muted" } {
  const days = Math.round((Date.parse(`${deadline}T12:00:00Z`) - Date.parse(`${clockDate}T12:00:00Z`)) / 86_400_000);
  if (days < 0) return { text: `Deadline passed ${-days} day${days === -1 ? "" : "s"} ago`, tone: "red" };
  if (days === 0) return { text: "Due today", tone: "red" };
  return { text: `Due in ${days} day${days === 1 ? "" : "s"} (${deadline})`, tone: days <= 2 ? "amber" : "muted" };
}
