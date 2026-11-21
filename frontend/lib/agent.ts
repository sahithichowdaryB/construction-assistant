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
  /** The field the answer fills, e.g. "occurred_at". Time and date fields get a date-time picker. */
  field_name?: string;
  question: string;
  options?: string[] | null;
}

export interface AgentFact {
  id: string;
  field_name: string;
  value: string;
  basis: string;
}

/** One extracted fact shown to the speaker before anything is saved. `index` identifies it in the review reply. */
export interface ReviewFact {
  index: number;
  event_index: number;
  field_name: string;
  value: unknown;
  basis: string;
}

/** A field the business rules require but nobody supplied. The speaker may fill it in during review. */
export interface ReviewGap {
  event_index: number;
  field_name: string;
  why?: string;
}

export interface ReviewDecision {
  edits: { index: number; value: string }[];
  removed: number[];
  additions?: { event_index: number; field_name: string; value: string }[];
  discard?: boolean;
}

export type AgentResult =
  | { status: "needs_input"; thread_id: string; transcript: string; events: AgentEvent[]; questions: AgentQuestion[]; round: number }
  | { status: "needs_review"; thread_id: string; transcript: string; events: AgentEvent[]; facts: ReviewFact[]; gaps: ReviewGap[] }
  | { status: "discarded" }
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

/** Sends a recording; the agent transcribes it (needs a speech-to-text service) and then behaves like a typed note. */
export async function submitAudio(projectId: string, audio: Blob, filename: string): Promise<AgentResult> {
  const form = new FormData();
  form.append("audio", audio, filename);
  form.append("recorded_at", new Date().toISOString());
  const res = await fetch(`/api/agent/projects/${encodeURIComponent(projectId)}/captures`, { method: "POST", body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 202) {
    throw new ApiError(res.status, typeof data.detail === "string" ? data.detail : `Capture failed (HTTP ${res.status})`);
  }
  return data as AgentResult;
}

export interface RecordingFact {
  field_name: string;
  value: unknown;
  basis: string;
  review_status: "proposed" | "confirmed" | "rejected";
  incident_id: string | null;
  reviewed_by: string | null;
}

export interface RecordingIncident {
  id: string;
  kind: string;
  title: string;
  activity_code: string | null;
  occurred_at: string;
  resolved_at: string | null;
}

export interface SavedRecording {
  id: string;
  recorded_at: string;
  has_audio: boolean;
  author: string | null;
  author_role: string;
  transcript: string | null;
  answers: string[];
  facts: RecordingFact[];
  incidents: RecordingIncident[];
}

/** This member's saved notes, newest first. */
export async function listRecordings(projectId: string): Promise<SavedRecording[]> {
  const res = await fetch(`/api/agent/projects/${encodeURIComponent(projectId)}/captures`, { cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, typeof data.detail === "string" ? data.detail : `Could not load recordings (HTTP ${res.status})`);
  return data.recordings as SavedRecording[];
}

export const recordingAudioUrl = (projectId: string, sourceId: string) =>
  `/api/agent/projects/${encodeURIComponent(projectId)}/captures/${encodeURIComponent(sourceId)}/audio`;

/** The speaker's last look before saving: corrected values, removed facts, or discard the whole note. */
export const submitReview = (projectId: string, threadId: string, decision: ReviewDecision) =>
  post(`projects/${encodeURIComponent(projectId)}/captures/${encodeURIComponent(threadId)}/review`, decision);
