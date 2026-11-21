"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApp } from "@/components/providers/app-context";
import * as api from "@/lib/api";
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
  incidents: (pid: string, asOf: string) => ["sm", pid, "incidents", asOf] as const,
  incident: (pid: string, id: string, asOf: string) => ["sm", pid, "incident", id, asOf] as const,
  analysis: (pid: string, id: string, asOf: string) => ["sm", pid, "analysis", id, asOf] as const,
  sources: (pid: string, asOf: string) => ["sm", pid, "sources", asOf] as const,
  source: (pid: string, sid: string, asOf: string) => ["sm", pid, "source", sid, asOf] as const,
  summary: (pid: string, sid: string, asOf: string) => ["sm", pid, "summary", sid, asOf] as const,
  evidence: (pid: string, passageId: string, asOf: string) => ["sm", pid, "evidence", passageId, asOf] as const,
  job: (pid: string, id: string) => ["sm", pid, "job", id] as const,
  proposals: (pid: string, sid: string) => ["sm", pid, "proposals", sid] as const,
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

export function useIncidents() {
  const { projectId, asOf } = useApp();
  return useQuery({ queryKey: keys.incidents(projectId, asOf), queryFn: () => api.getIncidents(projectId, asOf) });
}

export function useIncident(id: string) {
  const { projectId, asOf } = useApp();
  return useQuery({ queryKey: keys.incident(projectId, id, asOf), queryFn: () => api.getIncident(projectId, id, asOf) });
}

export function useIncidentAnalysis(id: string) {
  const { projectId, asOf } = useApp();
  return useQuery({
    queryKey: keys.analysis(projectId, id, asOf),
    queryFn: () => api.getIncidentAnalysis(projectId, id, asOf),
    retry: false,
  });
}

export function useAnalyzeIncident(id: string) {
  const { projectId, asOf } = useApp();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.analyzeIncident(projectId, id, asOf),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sm", projectId, "analysis", id] }),
  });
}

export function useSources() {
  const { projectId, asOf } = useApp();
  return useQuery({ queryKey: keys.sources(projectId, asOf), queryFn: () => api.getSources(projectId, asOf) });
}

export function useSource(sid: string) {
  const { projectId, asOf } = useApp();
  return useQuery({ queryKey: keys.source(projectId, sid, asOf), queryFn: () => api.getSource(projectId, sid, asOf) });
}

export function useSourceSummary(sid: string, enabled = true) {
  const { projectId, asOf } = useApp();
  return useQuery({
    queryKey: keys.summary(projectId, sid, asOf),
    queryFn: () => api.getSourceSummary(projectId, sid, asOf),
    enabled,
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
