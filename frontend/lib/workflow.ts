/**
 * The three-screen demo (backend/workflow.py): foreman field notes, the site manager's delay notice,
 * and the approver's decision. Calls go through the /api/sm proxy, which adds the user's session.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { useApp } from "@/components/providers/app-context";
import { ApiError } from "@/lib/api";

const refSchema = z.object({ source_id: z.string(), locator: z.string(), passage_id: z.string() });

const factSchema = z.object({
  id: z.string(),
  field: z.string(),
  label: z.string(),
  value: z.unknown(),
  display: z.string(),
  basis: z.enum(["reported", "inferred", "estimated", "forecast", "signed"]),
  review_status: z.enum(["proposed", "confirmed", "rejected"]),
  refs: z.array(refSchema),
});

export const fieldNoteSchema = z.object({
  source_id: z.string(),
  text: z.string(),
  recorded_at: z.string(),
  author: z.string().nullable(),
  status: z.enum(["proposed", "confirmed"]),
  confirmed_by: z.string().nullable(),
  confirmed_at: z.string().nullable(),
  facts: z.array(factSchema),
});

const versionSchema = z.object({
  version: z.number(),
  as_of: z.string(),
  body: z.string(),
  evidence_refs: z.array(refSchema),
  missing_fields: z.array(z.string()),
  review: z
    .object({ decision: z.enum(["approved", "changes_requested"]), reason: z.string().nullable(), reviewer: z.string(), decided_at: z.string() })
    .nullable(),
  gap_resolutions: z
    .array(
      z.object({
        field: z.string(),
        resolution: z.enum(["filled", "omitted"]),
        value: z.string().nullable(),
        reason: z.string().nullable(),
        decided_by: z.string().nullable(),
        decided_at: z.string(),
      }),
    )
    .default([]),
  exports: z
    .array(z.object({ format: z.string(), sha256: z.string(), bytes: z.number().nullable(), filename: z.string().nullable(), created_at: z.string() }))
    .default([]),
});

export const draftSchema = z.object({
  id: z.string(),
  notice_type: z.string(),
  alert_id: z.string().nullable(),
  incident_id: z.string().nullable().optional(),
  activity_code: z.string().nullable(),
  activity_name: z.string().nullable(),
  kind_label: z.string().optional(),
  title: z.string().nullable().optional(),
  written_with_agent: z.boolean().optional(),
  origin: z.enum(["manual", "keywords", "alert_auto", "suggestion", "daily_report"]).optional(),
  work_date: z.string().nullable().optional(),
  submitted_at: z.string().nullable().optional(),
  omittable_fields: z.array(z.string()).default([]),
  approval_roles: z.array(z.string()).default(["approver"]),
  disclaimer: z.string().optional(),
  status: z.enum(["draft", "awaiting_review", "changes_requested", "approved"]),
  latest: versionSchema,
  versions: z.array(versionSchema),
});

const dayActivitySchema = z.object({
  code: z.string(),
  name: z.string(),
  unit: z.string(),
  zone: z.string().nullable(),
  contractor: z.string().nullable(),
  planned: z.number(),
  plan_ref: refSchema,
  actual: z.number().nullable(),
  actual_ref: refSchema.nullable(),
  reported_at: z.string().nullable(),
  estimate: z.object({ value: z.number(), basis: z.string(), ref: refSchema }).nullable(),
  shortfall_pct: z.number().nullable(),
  severity: z.enum(["none", "low", "medium", "high", "critical"]).nullable(),
  status: z.enum(["behind", "not_reported", "on_track"]),
  equipment: z.array(z.object({ id: z.string(), description: z.string() })),
  notes: z.object({ total: z.number(), confirmed: z.number() }),
  alert_id: z.string().nullable(),
  notice: z.object({ id: z.string(), status: z.enum(["draft", "awaiting_review", "changes_requested", "approved"]) }).nullable(),
});

export const siteDaySchema = z.object({
  date: z.string(),
  timezone: z.string(),
  threshold: z.number(),
  high_threshold: z.number(),
  first_day: z.string().nullable(),
  last_day: z.string().nullable(),
  activities: z.array(dayActivitySchema),
});

const relatedSchema = z.object({
  query: z.string(),
  results: z.array(
    z.object({
      source_id: z.string(),
      locator: z.string(),
      excerpt: z.string(),
      source_kind: z.string(),
      source_title: z.string().nullable(),
      available_at: z.string(),
      untrusted: z.boolean(),
      ref: refSchema,
    }),
  ),
});

export type SiteDay = z.infer<typeof siteDaySchema>;
export type DayActivity = z.infer<typeof dayActivitySchema>;
export type FieldNote = z.infer<typeof fieldNoteSchema>;
export type NoticeDraft = z.infer<typeof draftSchema>;
export type DraftStatus = NoticeDraft["status"];

const dayRecordsSchema = z.array(z.object({
  id: z.string(), title: z.string(), kind: z.string(), at: z.string(), source_id: z.string().nullable(), incident_id: z.string().nullable(),
  draft_id: z.string().nullable(), version: z.number().nullable(), correspondence: z.boolean(),
}));
const incidentPreviewSchema = z.object({
  body: z.string(), evidence_refs: z.array(refSchema), existing_id: z.string().nullable(), as_of: z.string(),
});

export const noticeLabel = (draft: NoticeDraft) =>
  draft.kind_label ?? (draft.notice_type === "incident_notice" ? "Site incident notice" : "Delay notice");

export function useDayRecords(date: string, period: "day" | "week") {
  const { base, projectId, asOf, live } = useBase();
  const cutoff = live ? null : asOf;
  const params = new URLSearchParams({ date, period });
  if (cutoff) params.set("as_of", cutoff);
  return useQuery({
    queryKey: ["sm", projectId, "day-records", date, period, cutoff],
    queryFn: () => call(`${base}/day-records?${params}`, dayRecordsSchema),
    refetchInterval: live ? 15_000 : false,
    refetchOnWindowFocus: "always",
  });
}

export function useIncidentPreview(id: string, at: string | null) {
  const { base, projectId } = useBase();
  return useQuery({
    queryKey: ["sm", projectId, "incident-notice-preview", id, at], enabled: !!at,
    queryFn: () => call(`${base}/incidents/${encodeURIComponent(id)}/notice-preview?as_of=${encodeURIComponent(at!)}`, incidentPreviewSchema),
  });
}

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

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

function useBase() {
  const { projectId, asOf, live } = useApp();
  return { base: `/projects/${encodeURIComponent(projectId)}`, asOf, live, q: live ? "" : `?as_of=${encodeURIComponent(asOf)}`, projectId };
}

// ---------- the day on site

/** Plan vs signed quantities for every activity on a day, as known at the As of time. */
export function useSiteDay(date: string | null) {
  const { base, asOf, projectId } = useBase();
  return useQuery({
    queryKey: ["sm", projectId, "site-day", date, asOf],
    queryFn: () =>
      call(`${base}/site-day?as_of=${encodeURIComponent(asOf)}${date ? `&date=${date}` : ""}`, siteDaySchema),
  });
}

/** Other records about an activity on a day, from the documents search. */
export function useRelated(code: string | null, date: string | null) {
  const { base, asOf, projectId } = useBase();
  return useQuery({
    queryKey: ["sm", projectId, "related", code, date, asOf],
    enabled: !!code && !!date,
    queryFn: () =>
      call(`${base}/related?activity_code=${encodeURIComponent(code!)}&date=${date}&as_of=${encodeURIComponent(asOf)}`, relatedSchema),
  });
}

// ---------- foreman

export function useFieldNotes(mine = false) {
  const { base, q, asOf, projectId } = useBase();
  return useQuery({
    queryKey: ["sm", projectId, "field-notes", mine ? "mine" : asOf],
    refetchInterval: mine ? 15_000 : false,
    refetchOnMount: mine ? "always" : true,
    queryFn: () => call(`${base}/field-notes${mine ? "?mine=true" : q}`, z.array(fieldNoteSchema)),
  });
}

export function useRecordNote() {
  const { base, q, projectId } = useBase();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { text: string; activity_code?: string | null }) =>
      call(`${base}/field-notes${q}`, fieldNoteSchema, json(input)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sm", projectId] }),
  });
}

export function useConfirmNote() {
  const { base, q, projectId } = useBase();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sourceId: string) =>
      call(`${base}/field-notes/${encodeURIComponent(sourceId)}/confirm${q}`, fieldNoteSchema, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sm", projectId] }),
  });
}

// ---------- notices

export function useNotices() {
  const { base, projectId } = useBase();
  return useQuery({
    queryKey: ["sm", projectId, "notices", "latest"],
    queryFn: () => call(`${base}/drafts`, z.array(draftSchema)),
    refetchInterval: 5_000,
    refetchOnWindowFocus: "always",
  });
}

function useNoticeMutation<T>(fn: (base: string, q: string, input: T) => Promise<NoticeDraft>) {
  const { base, q, projectId } = useBase();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: T) => fn(base, q, input),
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) return qc.invalidateQueries({ queryKey: ["sm", projectId, "notices"] });
    },
    // Notices change the day view (notice status) and alerts (a shortfall may be recorded as one).
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sm", projectId] }),
  });
}

export function useDraftNotice() {
  return useNoticeMutation(
    (base, q, { previewAt, ...input }: { incident_id?: string; previewAt?: string; alert_id?: string | null; activity_code?: string; work_date?: string }) =>
      call(`${base}/drafts${previewAt ? "?as_of=" + encodeURIComponent(previewAt) : q}`, draftSchema, json(input)),
  );
}

export function useReviseNotice() {
  return useNoticeMutation(
    (base, _q, input: { draftId: string; expected_version: number; contract_reference?: string; contract_clause?: string; body?: string }) =>
      call(`${base}/drafts/${input.draftId}/versions`, draftSchema, json(input)),
  );
}

export function useReviewNotice() {
  return useNoticeMutation(
    (base, _q, input: { draftId: string; version: number; decision: "approved" | "changes_requested"; reason?: string }) =>
      call(`${base}/drafts/${input.draftId}/versions/${input.version}/review`, draftSchema, json(input)),
  );
}

/** Fill a [MISSING: …] field, or leave it out with a reason (template-permitted fields only). Creates a new version. */
export function useResolveGap() {
  return useNoticeMutation(
    (base, q, input: { draftId: string; version: number; field: string; resolution: "filled" | "omitted"; value?: string; reason?: string }) =>
      call(`${base}/drafts/${input.draftId}/versions/${input.version}/gaps${q}`, draftSchema, json(input)),
  );
}

/** Send a private draft (written with SiteMate, auto-drafted or a daily report) to the approver's queue. */
export function useSubmitNotice() {
  return useNoticeMutation((base, q, input: { draftId: string; expected_version: number }) =>
    call(`${base}/drafts/${input.draftId}/submit${q}`, draftSchema, json({ expected_version: input.expected_version })),
  );
}

/** The most recent approved version (an edit after approval adds a newer, unapproved one). */
export function latestApproved(draft: NoticeDraft) {
  return [...draft.versions].reverse().find((v) => v.review?.decision === "approved") ?? null;
}

export const ORIGIN_LABEL: Record<string, string> = {
  alert_auto: "Auto-drafted from an alert",
  keywords: "Written with SiteMate",
  daily_report: "Daily report",
};

export const STATUS_LABEL: Record<DraftStatus, string> = {
  draft: "Draft (not sent)",
  awaiting_review: "Awaiting review",
  changes_requested: "Changes requested",
  approved: "Approved",
};

export const STATUS_TONE: Record<DraftStatus, string> = {
  draft: "bg-muted text-foreground ring-border",
  awaiting_review: "bg-amber-50 text-amber-900 ring-amber-200",
  changes_requested: "bg-red-50 text-red-800 ring-red-200",
  approved: "bg-emerald-50 text-emerald-800 ring-emerald-200",
};
