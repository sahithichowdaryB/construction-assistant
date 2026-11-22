/**
 * Daily report drafts and appointments (backend/daily_report). A daily report is a draft like a notice, so it opens in
 * the same notice panel (gaps, submit, approval, stored exports). Calls go through the /api/sm proxy.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { useApp } from "@/components/providers/app-context";
import { ApiError } from "@/lib/api";
import { draftSchema } from "@/lib/workflow";

export const APPOINTMENT_KINDS = ["meeting", "inspection", "hold_point", "delivery", "visit", "deadline", "other"] as const;
export type AppointmentKind = (typeof APPOINTMENT_KINDS)[number];

const appointmentSchema = z.object({
  id: z.string(),
  kind: z.enum(APPOINTMENT_KINDS),
  title: z.string(),
  starts_at: z.string(),
  ends_at: z.string().nullable(),
  location: z.string().nullable(),
  activity_code: z.string().nullable(),
  status: z.enum(["planned", "held", "cancelled", "moved"]),
  origin: z.string(),
  source_id: z.string().nullable(),
  locator: z.string().nullable(),
  local_time: z.string(),
});
const proposalSchema = z.object({
  kind: z.enum(APPOINTMENT_KINDS),
  title: z.string(),
  starts_at: z.string(),
  source_id: z.string(),
  locator: z.string(),
  basis: z.string(),
});
export type Appointment = z.infer<typeof appointmentSchema>;
export type AppointmentProposal = z.infer<typeof proposalSchema>;

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
    throw new ApiError(res.status, typeof detail === "string" ? detail : detail?.message ?? `Request failed (${res.status})`);
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new ApiError(502, `Unexpected response from ${path.split("?")[0]}`);
  return parsed.data;
}

const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function useBase() {
  const { projectId, asOf } = useApp();
  return { base: `/projects/${encodeURIComponent(projectId)}`, a: encodeURIComponent(asOf), asOf, projectId };
}

export function useAppointments(date: string) {
  const { base, a, asOf, projectId } = useBase();
  return useQuery({
    queryKey: ["sm", projectId, "appointments", date, asOf],
    queryFn: () => call(`${base}/appointments?date=${date}&as_of=${a}`, z.array(appointmentSchema)),
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  const { projectId } = useApp();
  return () => qc.invalidateQueries({ queryKey: ["sm", projectId] });
}

export function useAddAppointment() {
  const { base, a } = useBase();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: { kind: AppointmentKind; title: string; starts_at: string; location?: string | null; source_id?: string; locator?: string }) =>
      call(`${base}/appointments?as_of=${a}`, appointmentSchema, post(input)),
    onSuccess: invalidate,
  });
}

export function useCancelAppointment() {
  const { base, a } = useBase();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (x: Appointment) =>
      call(`${base}/appointments/${x.id}/supersede?as_of=${a}`, z.object({ id: z.string() }).passthrough(),
        post({ kind: x.kind, title: x.title, starts_at: x.starts_at, ends_at: x.ends_at, location: x.location,
               activity_code: x.activity_code, status: "cancelled", source_id: x.source_id, locator: x.locator })),
    onSuccess: invalidate,
  });
}

export function useExtractAppointments() {
  const { base, a } = useBase();
  return useMutation({
    mutationFn: (date: string) => call(`${base}/appointments/extract?as_of=${a}`, z.object({ proposals: z.array(proposalSchema) }), post({ date })),
  });
}

export function useDailyReport(date: string) {
  const { base, a, asOf, projectId } = useBase();
  return useQuery({
    queryKey: ["sm", projectId, "daily-report", date, asOf],
    queryFn: async () => (await call(`${base}/daily-reports?from=${date}&to=${date}&as_of=${a}`, z.array(draftSchema)))[0] ?? null,
  });
}

export function useDraftDailyReport() {
  const { base, a } = useBase();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (workDate: string) =>
      call(`${base}/daily-reports?as_of=${a}`, z.object({ draft: draftSchema, changed: z.boolean(), remarks_source: z.string(), missing: z.array(z.string()) }).passthrough(), post({ work_date: workDate })),
    onSuccess: invalidate,
  });
}

export const KIND_LABEL: Record<AppointmentKind, string> = {
  meeting: "Meeting",
  inspection: "Inspection",
  hold_point: "Hold point",
  delivery: "Delivery",
  visit: "Visit",
  deadline: "Deadline",
  other: "Other",
};
