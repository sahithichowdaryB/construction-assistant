"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useApp } from "@/components/providers/app-context";
import * as api from "@/lib/api";
import { toIsoWithOffset } from "@/lib/time";
import type { Alert, Export, Gap, NoticeType } from "@/lib/types";

/** Query keys always start with the project id; time-scoped reads include as_of. */
export const keys = {
  all: (pid: string) => ["sm", pid] as const,
  project: (pid: string) => ["sm", pid, "project"] as const,
  activities: (pid: string) => ["sm", pid, "activities"] as const,
  today: (pid: string, asOf: string) => ["sm", pid, "today", asOf] as const,
  alerts: (pid: string, asOf: string) => ["sm", pid, "alerts", asOf] as const,
  alertContext: (pid: string, id: string, workDate: string) => ["sm", pid, "alert-context", id, workDate] as const,
  progress: (pid: string, code: string, date: string, asOf: string) => ["sm", pid, "progress", code, date, asOf] as const,
  incidents: (pid: string, asOf: string | null) => ["sm", pid, "incidents", asOf ?? "all"] as const,
  incident: (pid: string, id: string, asOf: string | null) => ["sm", pid, "incident", id, asOf ?? "all"] as const,
  reasoning: (pid: string, id: string, asOf: string) => ["sm", pid, "reasoning", id, asOf] as const,
  sources: (pid: string, asOf: string) => ["sm", pid, "sources", asOf] as const,
  source: (pid: string, sid: string, asOf: string) => ["sm", pid, "source", sid, asOf] as const,
  summary: (pid: string, sid: string, asOf: string) => ["sm", pid, "summary", sid, asOf] as const,
  evidence: (pid: string, passageId: string, asOf: string) => ["sm", pid, "evidence", passageId, asOf] as const,
  job: (pid: string, id: string) => ["sm", pid, "job", id] as const,
  proposals: (pid: string, sid: string) => ["sm", pid, "proposals", sid] as const,
  readings: (pid: string, sid: string, asOf: string) => ["sm", pid, "readings", sid, asOf] as const,
  search: (pid: string, q: string, asOf: string) => ["sm", pid, "search", q, asOf] as const,
  actionItems: (pid: string, asOf: string) => ["sm", pid, "action-items", asOf] as const,
  documentJob: (pid: string, id: string) => ["sm", pid, "document-job", id] as const,
  drafts: (pid: string, asOf: string) => ["sm", pid, "drafts", asOf] as const,
  draft: (pid: string, id: string, asOf: string) => ["sm", pid, "draft", id, asOf] as const,
  health: () => ["sm", "health"] as const,
};

export function useHealth() {
  return useQuery({ queryKey: keys.health(), queryFn: api.getHealth, staleTime: 10_000, retry: false });
}

export function useProject() {
  const { projectId } = useApp();
  return useQuery({ queryKey: keys.project(projectId), queryFn: () => api.getProject(projectId), staleTime: Infinity });
}

export function useActivities() {
  const { projectId } = useApp();
  return useQuery({ queryKey: keys.activities(projectId), queryFn: () => api.getActivities(projectId), staleTime: Infinity });
}

export function useToday() {
  const { projectId, asOf } = useApp();
  return useQuery({ queryKey: keys.today(projectId, asOf), queryFn: () => api.getToday(projectId, asOf) });
}

export function useAlerts() {
  const { projectId, asOf } = useApp();
  return useQuery({ queryKey: keys.alerts(projectId, asOf), queryFn: () => api.getAlerts(projectId, asOf) });
}

export function useAlertContext(alert: Alert | undefined, workDate: string | undefined) {
  const { projectId } = useApp();
  return useQuery({
    queryKey: keys.alertContext(projectId, alert?.id ?? "", workDate ?? ""),
    queryFn: () => api.getAlertContext(projectId, alert!, workDate!),
    enabled: !!alert && !!workDate,
  });
}

export function useProgress(code: string | null, date: string | null) {
  const { projectId, asOf } = useApp();
  return useQuery({
    queryKey: keys.progress(projectId, code ?? "", date ?? "", asOf),
    queryFn: () => api.getProgress(projectId, code!, date!, asOf),
    enabled: !!code && !!date,
  });
}

/**
 * Incidents are reported in full by default: nothing is hidden by the look-back clock.
 * Pass upToAsOf to show only what had been reported by the selected time.
 */
export function useIncidents({ upToAsOf = false }: { upToAsOf?: boolean } = {}) {
  const { projectId, asOf } = useApp();
  const cutoff = upToAsOf ? asOf : null;
  return useQuery({ queryKey: keys.incidents(projectId, cutoff), queryFn: () => api.getIncidents(projectId, cutoff) });
}

export function useIncident(id: string, { upToAsOf = false }: { upToAsOf?: boolean } = {}) {
  const { projectId, asOf } = useApp();
  const cutoff = upToAsOf ? asOf : null;
  return useQuery({ queryKey: keys.incident(projectId, id, cutoff), queryFn: () => api.getIncident(projectId, id, cutoff) });
}

export function useIncidentReasoning(id: string) {
  const { projectId, asOf } = useApp();
  return useQuery({
    queryKey: keys.reasoning(projectId, id, asOf),
    queryFn: () => api.getIncidentReasoning(projectId, id, asOf),
    retry: false,
  });
}

/** Calls the reasoning agent on the backend (LLM). Slow by design; the button shows progress. */
export function useRunReasoning(id: string) {
  const { projectId, asOf } = useApp();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.runIncidentReasoning(projectId, id, asOf),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sm", projectId, "reasoning", id] }),
  });
}

export function useSources() {
  const { projectId, asOf } = useApp();
  return useQuery({ queryKey: keys.sources(projectId, asOf), queryFn: () => api.getSources(projectId, asOf) });
}

const RUNNING = new Set(["queued", "running"]);

/** True while the backend is still parsing or summarising this source. */
export const isProcessing = (s: { parse_status?: string | null; summary_status?: string | null } | undefined) =>
  !!s && (RUNNING.has(s.parse_status ?? "") || RUNNING.has(s.summary_status ?? ""));

export function useSource(sid: string) {
  const { projectId, asOf } = useApp();
  return useQuery({
    queryKey: keys.source(projectId, sid, asOf),
    queryFn: () => api.getSource(projectId, sid, asOf),
    // Keep checking while a parse or summary job is running, so new results appear on their own.
    refetchInterval: (q) => (isProcessing(q.state.data) ? 3000 : false),
  });
}

export function useSourceSummary(sid: string, enabled = true, pending = false) {
  const { projectId, asOf } = useApp();
  return useQuery({
    queryKey: keys.summary(projectId, sid, asOf),
    queryFn: () => api.getSourceSummary(projectId, sid, asOf),
    enabled,
    retry: (count, error) => !(error instanceof api.ApiError && error.status === 404) && count < 2,
    refetchInterval: pending ? 3000 : false,
  });
}

export function useEvidence(passageId: string | null) {
  const { projectId, asOf } = useApp();
  return useQuery({
    queryKey: keys.evidence(projectId, passageId ?? "", asOf),
    queryFn: () => api.getEvidence(projectId, passageId!, asOf),
    enabled: !!passageId,
  });
}

/** Polls an ingestion job until it reaches a terminal state. */
export function useJob(jobId: string | null) {
  const { projectId } = useApp();
  return useQuery({
    queryKey: keys.job(projectId, jobId ?? ""),
    queryFn: () => api.getJob(projectId, jobId!),
    enabled: !!jobId,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === "indexed" || s === "failed" ? false : 500;
    },
  });
}

/** Polls a document ingestion job (parse or summary) until it reaches a terminal state. */
export function useDocumentJob(jobId: string | null) {
  const { projectId } = useApp();
  return useQuery({
    queryKey: keys.documentJob(projectId, jobId ?? ""),
    queryFn: () => api.getDocumentJob(projectId, jobId!),
    enabled: !!jobId,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === "indexed" || s === "failed" ? false : 1000;
    },
  });
}

export function useReportReadings(sid: string, enabled = true) {
  const { projectId, asOf } = useApp();
  return useQuery({
    queryKey: keys.readings(projectId, sid, asOf),
    queryFn: () => api.getReportReadings(projectId, sid, asOf),
    enabled,
    retry: false,
  });
}

export function useSourceStorage(sid: string, enabled = true) {
  const { projectId, asOf } = useApp();
  return useQuery({
    queryKey: [...keys.source(projectId, sid, asOf), "storage"],
    queryFn: () => api.getSourceStorage(projectId, sid, asOf),
    enabled,
    retry: false,
  });
}

export function useSourcePreview(sid: string, enabled = true) {
  const { projectId, asOf } = useApp();
  return useQuery({
    queryKey: [...keys.source(projectId, sid, asOf), "preview"],
    queryFn: () => api.getSourcePreview(projectId, sid, asOf),
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
  });
}

export function useSearch(q: string) {
  const { projectId, asOf } = useApp();
  const query = q.trim();
  return useQuery({
    queryKey: keys.search(projectId, query, asOf),
    queryFn: () => api.searchEvidence(projectId, query, asOf),
    enabled: query.length >= 2,
    staleTime: 60_000,
  });
}

export function useActionItems() {
  const { projectId, asOf } = useApp();
  return useQuery({ queryKey: keys.actionItems(projectId, asOf), queryFn: () => api.getActionItems(projectId, asOf) });
}

export function useProposals(sid: string | null) {
  const { projectId } = useApp();
  return useQuery({
    queryKey: keys.proposals(projectId, sid ?? ""),
    queryFn: () => api.getProposals(projectId, sid!),
    enabled: !!sid,
  });
}

export function useDrafts() {
  const { projectId, asOf } = useApp();
  return useQuery({ queryKey: keys.drafts(projectId, asOf), queryFn: () => api.getDrafts(projectId, asOf) });
}

export function useDraft(id: string) {
  const { projectId, asOf } = useApp();
  return useQuery({ queryKey: keys.draft(projectId, id, asOf), queryFn: () => api.getDraft(id, asOf) });
}

// ---------- mutations ----------
function useInvalidateProject() {
  const qc = useQueryClient();
  const { projectId } = useApp();
  return () => qc.invalidateQueries({ queryKey: keys.all(projectId) });
}

export function useUpload() {
  const { projectId, asOf } = useApp();
  const invalidate = useInvalidateProject();
  return useMutation({
    mutationFn: (input: api.UploadInput) => api.uploadSource(projectId, input, asOf),
    onSuccess: invalidate,
  });
}

export function useUploadDocument() {
  const { projectId, asOf, setAsOf } = useApp();
  const invalidate = useInvalidateProject();
  return useMutation({
    mutationFn: (input: { type: Parameters<typeof api.uploadDocument>[1]["type"]; file: File }) =>
      api.uploadDocument(projectId, input, asOf),
    onSuccess: (job) => {
      // Uploads are stamped with the real time; move the clock forward so the new document is visible.
      const received = job.available_at ? Date.parse(job.available_at) : NaN;
      if (received > Date.parse(asOf)) setAsOf(toIsoWithOffset(new Date(Math.ceil(received / 1000) * 1000)));
      return invalidate();
    },
  });
}

export function useRegenerateSummary() {
  const { projectId } = useApp();
  return useMutation({ mutationFn: (sid: string) => api.regenerateSummary(projectId, sid) });
}

export function useCompleteAction() {
  const { projectId } = useApp();
  const invalidate = useInvalidateProject();
  return useMutation({
    mutationFn: ({ id, completed }: { id: string; completed: boolean }) => api.setActionItemCompleted(projectId, id, completed),
    onSuccess: invalidate,
  });
}

/** Refreshes project data once a polled job finishes (new passages, summary or source status). */
export function useInvalidateOnJobDone(status: string | undefined) {
  const qc = useQueryClient();
  const { projectId } = useApp();
  const seen = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (status === seen.current) return;
    seen.current = status;
    if (status === "indexed" || status === "failed") void qc.invalidateQueries({ queryKey: keys.all(projectId) });
  }, [status, qc, projectId]);
}

export function useConfirmProposal() {
  const { projectId } = useApp();
  return useMutation({
    mutationFn: ({ sid, input }: { sid: string; input: api.ConfirmInput }) => api.confirmProposal(projectId, sid, input),
  });
}

export function useAsk() {
  const { projectId, asOf } = useApp();
  return useMutation({ mutationFn: (question: string) => api.askSiteMate(projectId, question, asOf) });
}

export function useDismissAlert() {
  const { projectId, asOf } = useApp();
  const invalidate = useInvalidateProject();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api.dismissAlert(projectId, id, reason, asOf),
    onSuccess: invalidate,
  });
}

export function useCreateDraft() {
  const { projectId, asOf } = useApp();
  const invalidate = useInvalidateProject();
  return useMutation({
    mutationFn: (input: { type: NoticeType; keywords?: string | null; alert_id?: string | null; incident_id?: string | null }) =>
      api.createDraft(projectId, input, asOf),
    onSuccess: invalidate,
  });
}

export function useSaveDraftVersion(id: string) {
  const { asOf } = useApp();
  const invalidate = useInvalidateProject();
  return useMutation({
    mutationFn: (input: { body: string; gaps: Gap[]; base_version: number; author: string }) =>
      api.saveDraftVersion(id, input, asOf),
    onSuccess: invalidate,
  });
}

export function useReviewDraft(id: string) {
  const { asOf, role } = useApp();
  const invalidate = useInvalidateProject();
  return useMutation({
    mutationFn: (input: { version: number; decision: "submitted" | "approved" | "changes_requested"; reason?: string; reviewer: string }) =>
      api.reviewDraftVersion(id, input.version, { ...input, role }, asOf),
    onSuccess: invalidate,
  });
}

export function useExportDraft(id: string) {
  const { asOf, role } = useApp();
  const invalidate = useInvalidateProject();
  return useMutation({
    mutationFn: ({ version, format }: { version: number; format: Export["format"] }) =>
      api.exportDraftVersion(id, version, format, role, asOf),
    onSuccess: invalidate,
  });
}
