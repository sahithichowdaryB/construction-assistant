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
});

export const draftSchema = z.object({
  id: z.string(),
  notice_type: z.string(),
  alert_id: z.string(),
  activity_code: z.string().nullable(),
  activity_name: z.string().nullable(),
  status: z.enum(["awaiting_review", "changes_requested", "approved"]),
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
  notice: z.object({ id: z.string(), status: z.enum(["awaiting_review", "changes_requested", "approved"]) }).nullable(),
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
  const { projectId, asOf } = useApp();
  return { base: `/projects/${encodeURIComponent(projectId)}`, asOf, q: `?as_of=${encodeURIComponent(asOf)}`, projectId };
}

// ---------- the day on site

/** Plan vs signed quantities for every activity on a day, as known at the As of time. */
export function useSiteDay(date: string | null) {
  const { base, asOf, projectId } = useBase();
  return useQuery({
    queryKey: ["sm", projectId, "site-day", date, asOf],
    queryFn: () =>
      call(`${base}/site-day?as_of=${encodeURIComponent(asOf)}${date ? `&date=${date}` : ""}`, siteDaySchema),
    placeholderData: (prev) => prev,
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

export function useFieldNotes() {
  const { base, q, asOf, projectId } = useBase();
  return useQuery({
    queryKey: ["sm", projectId, "field-notes", asOf],
    queryFn: () => call(`${base}/field-notes${q}`, z.array(fieldNoteSchema)),
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
  const { base, q, asOf, projectId } = useBase();
  return useQuery({
    queryKey: ["sm", projectId, "notices", asOf],
    queryFn: () => call(`${base}/drafts${q}`, z.array(draftSchema)),
  });
}

function useNoticeMutation<T>(fn: (base: string, q: string, input: T) => Promise<NoticeDraft>) {
  const { base, q, projectId } = useBase();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: T) => fn(base, q, input),
    // Notices change the day view (notice status) and alerts (a shortfall may be recorded as one).
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sm", projectId] }),
  });
}

export function useDraftNotice() {
  return useNoticeMutation(
    (base, q, input: { alert_id?: string | null; activity_code?: string; work_date?: string }) =>
      call(`${base}/drafts${q}`, draftSchema, json(input)),
  );
}

export function useReviseNotice() {
  return useNoticeMutation(
    (base, q, input: { draftId: string; contract_reference?: string; contract_clause?: string }) =>
      call(`${base}/drafts/${input.draftId}/versions${q}`, draftSchema, json(input)),
  );
}

export function useReviewNotice() {
  return useNoticeMutation(
    (base, q, input: { draftId: string; version: number; decision: "approved" | "changes_requested"; reason?: string }) =>
      call(`${base}/drafts/${input.draftId}/versions/${input.version}/review${q}`, draftSchema, json(input)),
  );
}

export const STATUS_LABEL: Record<DraftStatus, string> = {
  awaiting_review: "Awaiting approval",
  changes_requested: "Changes requested",
  approved: "Approved",
};

export const STATUS_TONE: Record<DraftStatus, string> = {
  awaiting_review: "bg-amber-50 text-amber-900 ring-amber-200",
  changes_requested: "bg-red-50 text-red-800 ring-red-200",
  approved: "bg-emerald-50 text-emerald-800 ring-emerald-200",
};
