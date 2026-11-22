/**
 * Write with SiteMate (backend/correspondence.py): the site manager describes a situation, the agent
 * analyses the project records and drafts the email or letter. Plus the project's cost rates.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { useApp } from "@/components/providers/app-context";
import { ApiError } from "@/lib/api";
import { draftSchema } from "@/lib/workflow";

const refSchema = z.object({ source_id: z.string(), locator: z.string(), passage_id: z.string() });

export const kindKeys = ["email", "delay_notice", "additional_cost", "notice_of_concern", "defect_notice"] as const;
export type Kind = (typeof kindKeys)[number];

const optionsSchema = z.object({
  kinds: z.array(z.object({ key: z.enum(kindKeys), label: z.string(), formal: z.boolean(), uses_costs: z.boolean(), description: z.string() })),
  recipients: z.array(
    z.object({ type: z.enum(["client", "contractor", "internal"]), id: z.string(), label: z.string(), detail: z.string().nullable().optional() }),
  ),
  rates: z.object({ total: z.number(), set: z.number(), examples: z.number() }),
  sender: z.string().nullable(),
});

const factSchema = z.object({
  id: z.string(),
  text: z.string(),
  refs: z.array(refSchema),
  source: z.enum(["record", "calculated", "your request", "document"]),
  untrusted: z.boolean().optional(),
  title: z.string().nullable().optional(),
});

const costLineSchema = z.object({
  key: z.string(),
  label: z.string(),
  quantity: z.number(),
  unit: z.string().nullable(),
  rate: z.number().nullable(),
  amount: z.number().nullable(),
  is_example: z.boolean(),
  rate_label: z.string(),
});

export const analysisSchema = z.object({
  understood: z.object({
    activity_code: z.string().nullable(),
    equipment_ids: z.array(z.string()),
    occurred_local_time: z.string().nullable(),
    workers_affected: z.number().nullable(),
    cause: z.string().nullable(),
    responsible_contractor_id: z.string().nullable(),
    topic: z.string().nullable().optional(),
    goal: z.string().nullable().optional(),
    basis: z.record(z.string(), z.string()),
  }),
  day: z.string(),
  activity: z.object({ code: z.string(), name: z.string(), unit: z.string(), zone: z.string().nullable() }).nullable(),
  responsible: z.object({ id: z.string(), name: z.string(), contact_role: z.string() }).nullable(),
  incident: z.object({ id: z.string(), title: z.string() }).nullable(),
  figures: z.record(z.string(), z.union([z.number(), z.string()])),
  timeline: z
    .object({ start: z.string(), end: z.string(), resolved: z.boolean(), working_hours: z.number(), days: z.number(), shift: z.string() })
    .nullable(),
  costs: z.object({ currency: z.string(), lines: z.array(costLineSchema), total: z.number(), complete: z.boolean(), uses_examples: z.boolean() }),
  actions: z.array(
    z.object({ id: z.string(), description: z.string(), owner: z.string().nullable(), due_at: z.string().nullable(), overdue: z.boolean(), ref: refSchema.nullable() }),
  ),
  facts: z.array(factSchema),
  removed: z.array(z.object({ text: z.string(), reason: z.string() })).optional(),
  subject: z.string().optional(),
  model: z.string().nullable().optional(),
  instruction: z.string().optional(),
});

export const correspondenceSchema = z.object({
  draft: draftSchema,
  request: z.object({ what_happened: z.string(), emphasis: z.string().nullable().optional(), kind: z.string(), work_date: z.string().nullable().optional() }),
  recipient: z.object({ type: z.string(), id: z.string().nullable(), chosen_by: z.string() }),
  recipient_label: z.string().nullable(),
  analysis: analysisSchema,
  submitted_at: z.string().nullable(),
});

const listSchema = z.array(
  z.object({
    id: z.string(),
    kind: z.string(),
    kind_label: z.string(),
    subject: z.string().nullable(),
    recipient_label: z.string().nullable(),
    status: z.enum(["draft", "awaiting_review", "changes_requested", "approved"]),
    version: z.number(),
    updated_at: z.string(),
    missing: z.number(),
  }),
);

const rateRowSchema = z.object({
  key: z.string(),
  label: z.string(),
  unit: z.string(),
  amount: z.number().nullable(),
  is_example: z.boolean(),
  updated_by: z.string().nullable(),
  updated_at: z.string().nullable(),
});
export const ratesSchema = z.object({ currency: z.string(), shift_start: z.string(), shift_end: z.string(), rates: z.array(rateRowSchema) });

export type Correspondence = z.infer<typeof correspondenceSchema>;
export type Analysis = z.infer<typeof analysisSchema>;
export type Options = z.infer<typeof optionsSchema>;
export type Rates = z.infer<typeof ratesSchema>;

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

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

function useBase() {
  const { projectId, asOf, live } = useApp();
  return { base: `/projects/${encodeURIComponent(projectId)}`, q: live ? "" : `?as_of=${encodeURIComponent(asOf)}`, projectId };
}

export function useWriterOptions() {
  const { base, projectId } = useBase();
  return useQuery({ queryKey: ["sm", projectId, "correspondence", "options"], queryFn: () => call(`${base}/correspondence/options`, optionsSchema) });
}

export function useCorrespondenceList() {
  const { base, projectId } = useBase();
  return useQuery({ queryKey: ["sm", projectId, "correspondence", "list"], queryFn: () => call(`${base}/correspondence`, listSchema) });
}

export function useCorrespondence(id: string | null) {
  const { base, projectId } = useBase();
  return useQuery({
    queryKey: ["sm", projectId, "correspondence", "item", id],
    enabled: !!id,
    queryFn: () => call(`${base}/correspondence/${id}`, correspondenceSchema),
  });
}

function useWrite<T>(fn: (base: string, q: string, input: T) => Promise<Correspondence>) {
  const { base, q, projectId } = useBase();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: T) => fn(base, q, input),
    onSuccess: (data) => {
      qc.setQueryData(["sm", projectId, "correspondence", "item", data.draft.id], data);
      return qc.invalidateQueries({ queryKey: ["sm", projectId] });
    },
  });
}

export interface WriteInput {
  what_happened: string;
  kind: Kind;
  recipient?: { type: "client" | "contractor" | "internal"; id?: string } | null;
  emphasis?: string | null;
  work_date?: string | null;
}

export function useCreateDraft() {
  return useWrite((base, q, input: WriteInput) => call(`${base}/correspondence${q}`, correspondenceSchema, send("POST", input)));
}

export function useRegenerate() {
  return useWrite((base, q, input: { id: string; instruction?: string }) =>
    call(`${base}/correspondence/${input.id}/regenerate${q}`, correspondenceSchema, send("POST", { instruction: input.instruction || null })),
  );
}

export function useSubmitDraft() {
  return useWrite((base, q, id: string) => call(`${base}/correspondence/${id}/submit${q}`, correspondenceSchema, send("POST")));
}

/** Manual edit of the text: a new version through the existing notice route. */
export function useSaveEdit() {
  const { base, projectId } = useBase();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; body: string; expected_version: number }) =>
      call(`${base}/drafts/${input.id}/versions`, draftSchema, send("POST", { body: input.body, expected_version: input.expected_version })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sm", projectId] }),
  });
}

export function useRates() {
  const { base, projectId } = useBase();
  return useQuery({ queryKey: ["sm", projectId, "cost-rates"], queryFn: () => call(`${base}/cost-rates`, ratesSchema) });
}

export function useSaveRates() {
  const { base, projectId } = useBase();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { currency: string; shift_start: string; shift_end: string; rates: { key: string; amount: number | null }[] }) =>
      call(`${base}/cost-rates`, ratesSchema, send("PUT", input)),
    onSuccess: (data) => {
      qc.setQueryData(["sm", projectId, "cost-rates"], data);
      return qc.invalidateQueries({ queryKey: ["sm", projectId, "correspondence", "options"] });
    },
  });
}

export function useExampleRates() {
  const { base, projectId } = useBase();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => call(`${base}/cost-rates/examples`, ratesSchema, send("POST")),
    onSuccess: (data) => {
      qc.setQueryData(["sm", projectId, "cost-rates"], data);
      return qc.invalidateQueries({ queryKey: ["sm", projectId, "correspondence", "options"] });
    },
  });
}

export function money(value: number, currency: string) {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(value);
}

const mailStatusSchema = z.object({ configured: z.boolean(), from: z.string().nullable() });
const sentSchema = z.object({ sent: z.boolean(), to: z.array(z.string()), cc: z.array(z.string()), subject: z.string() });

/** Whether the server has an SMTP account, so the Send button is only offered when it can work. */
export function useMailStatus() {
  const { base, projectId } = useBase();
  return useQuery({
    queryKey: ["sm", projectId, "mail-status"],
    queryFn: () => call(`${base}/mail/status`, mailStatusSchema),
    staleTime: 60_000,
    retry: false,
  });
}

export function useSendEmail() {
  const { base } = useBase();
  return useMutation({
    mutationFn: (input: { id: string; version: number; to: string[]; cc: string[] }) =>
      call(`${base}/drafts/${input.id}/versions/${input.version}/send`, sentSchema, send("POST", { to: input.to, cc: input.cc })),
  });
}
