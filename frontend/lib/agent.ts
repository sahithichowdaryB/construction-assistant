import { ApiError } from "@/lib/api";

/** Client for the capture agent, reached through the /api/agent proxy (token stays server-side). */

export interface AgentEvent {
  event_type: string;
  summary: string;
  zone?: string | null;
  workers_affected?: number | null;
  expected_restart_at?: string | null;
}

export interface AgentQuestion {
  id: string;
  question: string;
  options?: string[] | null;
}

export interface AgentFact {
  id: string;
  field_name: string;
  value: string;
  basis: string;
}

export type AgentResult =
  | { status: "needs_input"; thread_id: string; transcript: string; events: AgentEvent[]; questions: AgentQuestion[]; round: number }
  | { status: "no_events"; transcript: string }
  | { status: "saved"; thread_id: string; events: AgentEvent[]; source_id: string; incident_ids: Record<string, string>; facts: AgentFact[]; gaps: { field_name: string; why: string }[] };

async function post(path: string, body: unknown): Promise<AgentResult> {
  const res = await fetch(`/api/agent/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 202) {
    throw new ApiError(res.status, typeof data.detail === "string" ? data.detail : `Capture failed (HTTP ${res.status})`);
  }
  return data as AgentResult;
}

export const submitNote = (projectId: string, transcript: string) =>
  post(`projects/${encodeURIComponent(projectId)}/captures`, { transcript, recorded_at: new Date().toISOString() });

export const answerQuestions = (projectId: string, threadId: string, answers: { id: string; answer: string }[]) =>
  post(`projects/${encodeURIComponent(projectId)}/captures/${encodeURIComponent(threadId)}/answers`, { answers });
