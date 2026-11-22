/**
 * 3D progress model (backend/model3d): drawings upload, the active model's geometry, progress read from the
 * database, and the timeline for the slider. Every number comes from the server; this module fetches, validates
 * and picks the server-computed state for the date the slider is on.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { useApp } from "@/components/providers/app-context";
import { ApiError } from "@/lib/api";

const num = z.number();
const refs = z.array(z.string()).default([]);

export const POUR_STATUS = ["built", "in_progress", "not_started"] as const;
export type PourStatus = (typeof POUR_STATUS)[number];
export type Basis = "signed" | "estimated" | "event" | null;

const reasonSchema = z.object({ severity: z.enum(["blocking", "warning"]), subject: z.string(), message: z.string(), refs });

const elementSchema = z.object({
  id: z.string(),
  kind: z.string(),
  level: z.string(),
  activity: z.string(),
  pour: z.string(),
  mark: z.string().nullable(),
  box: z.array(num).length(6),
  volume_m3: num,
});

const pourSchema = z
  .object({ id: z.string(), activity: z.string(), seq: num, kind: z.string(), planned: z.string().nullable(), m3: num,
            /** false: drawn only; no plan or report measures it (e.g. walls the programme does not count in m³) */
            tracked: z.boolean().optional() })
  .passthrough();

const activitySpecSchema = z
  .object({ code: z.string(), name: z.string().nullable().optional(), start: z.string().nullable().optional(),
            finish: z.string().nullable().optional(), m3: num.nullable().optional() })
  .passthrough();

const summarySchema = z.object({
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
  deadline: z.string().nullable(),
  review_reasons: z.array(reasonSchema),
  blocking: num,
  counts: z.record(z.string(), num),
  deadline_hint: z.object({ date: z.string().optional(), label: z.string().optional() }).passthrough().nullable(),
});

const modelViewSchema = summarySchema.extend({
  levels: z.array(z.object({ name: z.string(), tos: num, thickness: num, activity: z.string() })),
  activities: z.array(activitySpecSchema),
  pours: z.array(pourSchema),
  elements: z.array(elementSchema),
  bounds: z.array(num),
});

const modelDetailSchema = modelViewSchema.extend({
  spec: z.record(z.string(), z.unknown()),
  sources: z.array(z.object({ id: z.string(), title: z.string().nullable(), filename: z.string().nullable() }).passthrough()),
});

const pourStateSchema = z
  .object({
    status: z.enum(POUR_STATUS),
    pct: num,
    basis: z.enum(["signed", "estimated", "event"]).nullable(),
    done_m3: num,
    finished: z.string().nullable(),
    refs,
    reported_pct: num.optional(),
  })
  .passthrough();

const simpleStateSchema = z.object({ status: z.enum(POUR_STATUS), pct: num });

const whySchema = z.object({
  kind: z.enum(["behind", "late_start", "late_pour", "disruption", "report_remark", "plan_conflict"]),
  activity: z.string().nullable().optional(),
  date: z.string().nullable(),
  text: z.string(),
  refs,
});

const progressSchema = z.object({
  model_id: z.string(),
  date: z.string(),
  deadline: z.string().nullable(),
  version: num.nullable().optional(),
  actual: z.record(z.string(), pourStateSchema),
  planned: z.record(z.string(), simpleStateSchema),
  at_deadline: z.record(z.string(), simpleStateSchema),
  forecast: z.record(z.string(), z.object({ date: z.string().nullable(), slip_wd: num, done: z.boolean() })),
  summary: z.object({
    total_m3: num,
    built_m3: num,
    planned_m3: num,
    pct_built: num,
    pct_planned: num,
    counts: z.record(z.string(), num),
    forecast_completion: z.string().nullable(),
    late_working_days: num.nullable(),
    late_calendar_days: num.nullable(),
    status: z.enum(["late", "on_time"]).nullable(),
    behind_m3: num,
    last_update: z.object({ date: z.string(), ref: z.string() }).nullable(),
  }),
  activities: z.array(
    z.object({
      code: z.string(),
      name: z.string().nullable(),
      planned_start: z.string().nullable(),
      planned_finish: z.string().nullable(),
      forecast_finish: z.string().nullable(),
      variance_wd: num.nullable(),
      done_m3: num,
      total_m3: num,
      planned_m3: num,
      status: z.enum(POUR_STATUS),
    }),
  ),
  why: z.array(whySchema),
  /** Structure activities driven by performance tasks: each task's planned and actual completion on the date */
  tasks: z
    .record(z.string(), z.array(z.object({ code: z.string(), name: z.string().nullable(), pct_done: num.nullable(),
                                           pct_planned: num.nullable(), note: z.string().nullable() })))
    .optional(),
});

const timelineSchema = z.object({
  model_id: z.string(),
  start: z.string().nullable(),
  end: z.string().nullable(),
  today: z.string().optional(),
  deadline: z.string().nullable().optional(),
  forecast_completion: z.string().optional(),
  total_m3: num.optional(),
  points: z.array(z.object({ date: z.string(), planned: num, actual: num.nullable().optional(), forecast: num.nullable().optional() })),
  steps: z.array(z.object({ date: z.string(), pours: z.record(z.string(), z.tuple([z.enum(POUR_STATUS), num, z.enum(["signed", "estimated", "event"]).nullable()])) })),
  planned_windows: z.record(z.string(), z.tuple([z.string(), z.string()])),
  forecast_windows: z.record(z.string(), z.tuple([z.string(), z.string()])),
});

export type ModelSummary = z.infer<typeof summarySchema>;
export type ModelView = z.infer<typeof modelViewSchema>;
export type ModelDetail = z.infer<typeof modelDetailSchema>;
export type Element3D = z.infer<typeof elementSchema>;
export type Pour = z.infer<typeof pourSchema>;
export type Progress = z.infer<typeof progressSchema>;
export type Timeline = z.infer<typeof timelineSchema>;
export type WhyItem = z.infer<typeof whySchema>;
export type PourState = { status: PourStatus; pct: number; basis: Basis };

// ---------- fetching

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

const noRetryOn404 = (count: number, error: unknown) => !(error instanceof ApiError && [403, 404, 503].includes(error.status)) && count < 2;

export function useActiveModel() {
  const { base, projectId } = useBase();
  return useQuery({
    queryKey: ["sm", projectId, "model3d", "active"],
    queryFn: () => call(`${base}/models/active`, modelViewSchema),
    staleTime: 5 * 60_000,
    retry: noRetryOn404,
  });
}

export function useModelProgress(enabled: boolean) {
  const { base, a, asOf, projectId } = useBase();
  return useQuery({
    queryKey: ["sm", projectId, "model3d", "progress", asOf],
    enabled,
    queryFn: () => call(`${base}/models/active/progress?as_of=${a}`, progressSchema),
  });
}

export function useModelTimeline(enabled: boolean) {
  const { base, a, asOf, projectId } = useBase();
  return useQuery({
    queryKey: ["sm", projectId, "model3d", "timeline", asOf],
    enabled,
    queryFn: () => call(`${base}/models/active/timeline?as_of=${a}`, timelineSchema),
  });
}

export function useModels() {
  const { base, projectId } = useBase();
  return useQuery({
    queryKey: ["sm", projectId, "model3d", "list"],
    queryFn: () => call(`${base}/models`, z.object({ active_id: z.string().nullable(), models: z.array(summarySchema) })),
    retry: noRetryOn404,
    refetchInterval: (q) =>
      q.state.data?.models.some((m) => m.extraction_status === "queued" || m.extraction_status === "running") ? 3000 : false,
  });
}

export function useModelDetail(id: string | null) {
  const { base, projectId } = useBase();
  return useQuery({
    queryKey: ["sm", projectId, "model3d", "detail", id],
    enabled: !!id,
    queryFn: () => call(`${base}/models/${id}`, modelDetailSchema),
    refetchInterval: (q) => (q.state.data && ["queued", "running"].includes(q.state.data.extraction_status) ? 3000 : false),
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  const { projectId } = useBase();
  return () => qc.invalidateQueries({ queryKey: ["sm", projectId, "model3d"] });
}

export function useUploadModel() {
  const { base } = useBase();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: { files: File[]; deadline: string; title?: string }) => {
      const form = new FormData();
      for (const f of input.files) form.append("files", f, f.name);
      form.set("deadline", input.deadline);
      if (input.title) form.set("title", input.title);
      return call(`${base}/models`, summarySchema, { method: "POST", body: form });
    },
    onSuccess: invalidate,
  });
}

export function usePatchModel(id: string) {
  const { base } = useBase();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: { spec?: Record<string, unknown>; deadline?: string; title?: string }) =>
      call(`${base}/models/${id}`, summarySchema, jsonInit("PATCH", body)),
    onSuccess: invalidate,
  });
}

export function useActivateModel(id: string) {
  const { base } = useBase();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: () => call(`${base}/models/${id}/activate`, z.object({ id: z.string(), elements: num, pours: num }).passthrough(), { method: "POST" }),
    onSuccess: invalidate,
  });
}

export function useRetryExtraction(id: string) {
  const { base } = useBase();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: () => call(`${base}/models/${id}/extract`, z.object({ id: z.string() }).passthrough(), { method: "POST" }),
    onSuccess: invalidate,
  });
}

// ---------- states for the slider date (picked from the server's results)

export type ViewMode = "actual" | "planned" | "compare";

const dayMs = 86_400_000;
const toDay = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
export const addDays = (iso: string, n: number) => new Date(toDay(iso) + n * dayMs).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string) => Math.round((toDay(b) - toDay(a)) / dayMs);

/** Same rule as progress.window_pct on the server: linear over the pour's window, inclusive. */
function windowPct(w: [string, string] | undefined, d: string): number {
  if (!w) return 0;
  const [a, b] = w;
  if (d >= b) return 100;
  if (d < a) return 0;
  return Math.round((1000 * (daysBetween(a, d) + 1)) / (daysBetween(a, b) + 1)) / 10;
}

const fromPct = (pct: number, basis: Basis = null): PourState => ({
  status: pct >= 100 ? "built" : pct > 0 ? "in_progress" : "not_started",
  pct,
  basis,
});

/** Actual state of every pour on `date`: recorded steps up to today, the forecast after today. */
export function actualStatesAt(date: string, progress: Progress, timeline: Timeline, pourIds: string[]): Record<string, PourState> {
  const out: Record<string, PourState> = {};
  if (date === progress.date) {
    for (const id of pourIds) {
      const s = progress.actual[id];
      out[id] = s ? { status: s.status, pct: s.pct, basis: s.basis } : fromPct(0);
    }
    return out;
  }
  if (date < progress.date) {
    const step = [...timeline.steps].reverse().find((s) => s.date <= date);
    for (const id of pourIds) {
      const s = step?.pours[id];
      out[id] = s ? { status: s[0], pct: s[1], basis: s[2] } : fromPct(0);
    }
    return out;
  }
  for (const id of pourIds) {
    const now = progress.actual[id];
    if (now?.status === "built") out[id] = { status: "built", pct: 100, basis: now.basis };
    else out[id] = fromPct(Math.max(windowPct(timeline.forecast_windows[id], date), now?.pct ?? 0), "estimated");
  }
  return out;
}

export function plannedStatesAt(date: string, timeline: Timeline, pourIds: string[]): Record<string, PourState> {
  return Object.fromEntries(pourIds.map((id) => [id, fromPct(windowPct(timeline.planned_windows[id], date))]));
}

// ---------- labels and colours

/** Activity colours from the drawings' 3D model (Plan 4, colour key per programme activity). */
const PALETTE = ["#8d6748", "#4f8a99", "#4a78b5", "#55a07a", "#d8a537", "#cf6d4f", "#7c5ca8", "#5c7d8a", "#a35d7a", "#6b8f3a"];
export function activityColour(code: string, order: string[]): string {
  const i = order.indexOf(code);
  return PALETTE[(i < 0 ? 0 : i) % PALETTE.length];
}

export const WHY_LABEL: Record<WhyItem["kind"], string> = {
  behind: "Behind the plan",
  late_start: "Late start",
  late_pour: "Late pour",
  disruption: "Recorded disruption",
  report_remark: "Daily report",
  plan_conflict: "Plan conflict",
};

export const EXTRACTION_LABEL: Record<ModelSummary["extraction_status"], string> = {
  queued: "Waiting to read",
  running: "Reading the drawings…",
  done: "Ready to review",
  needs_review: "Check the review notes",
  failed: "Reading failed",
};
