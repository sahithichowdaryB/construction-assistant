import { ApiError } from "@/lib/api";
import { eventCategoriesSchema } from "@/lib/schemas";
import type { EventCategory, LinkType, Severity } from "@/lib/types";

/** Client for the capture pipeline (served by FastAPI), reached through the /api/sm proxy (token stays server-side). */

export interface AgentEvent {
  event_type: string;
  category?: string;
  summary: string;
  zone?: string | null;
  workers_affected?: number | null;
  expected_restart_at?: string | null;
}

export interface CategoryAlternative {
  category: string;
  event_type: string;
}

/** One event the AI found, with its suggested category. The person picks the final one. */
export interface CategorySuggestion {
  index: number;
  summary: string;
  suggested_category: string;
  suggested_event_type: string;
  confidence: number;
  rationale: string;
  alternatives: CategoryAlternative[];
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

export interface IncidentLinkResult {
  event_index: number;
  incident_id: string;
  link_type: LinkType;
  /** True when this report opened a new incident */
  created: boolean;
  severity: Severity;
  report_count: number;
  reporter_count: number;
  title: string;
  alert_id: string;
}

export type AgentResult =
  | { status: "needs_category"; thread_id: string; capture_id: string; transcript: string | null; photo_descriptions: { n: number; passage: string }[]; events: CategorySuggestion[] }
  | { status: "needs_input"; thread_id: string; capture_id?: string; transcript: string | null; events: AgentEvent[]; questions: AgentQuestion[]; round: number }
  | { status: "needs_review"; thread_id: string; capture_id?: string; transcript: string | null; events: AgentEvent[]; facts: ReviewFact[]; gaps: ReviewGap[] }
  | { status: "needs_transcript"; thread_id: string; capture_id: string; reason: string | null; message: string }
  | { status: "discarded" }
  | { status: "no_events"; capture_id?: string; transcript: string | null }
  | {
      status: "saved";
      thread_id: string;
      capture_id?: string;
      events: AgentEvent[];
      source_id: string;
      incident_ids: Record<string, string>;
      incident_links: IncidentLinkResult[];
      facts: AgentFact[];
      gaps: { field_name: string; why: string }[];
    };

export interface CategoryDecision {
  index: number;
  category: string;
  event_type: string;
  keep: boolean;
}

export interface AddedEvent {
  summary: string;
  category: string;
  event_type: string;
}

async function request(path: string, init: RequestInit): Promise<AgentResult> {
  let res: Response;
  try {
    res = await fetch(`/api/sm/${path}`, init);
  } catch {
    throw new ApiError(0, "Network error: the SiteMate proxy could not be reached");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 202) {
    throw new ApiError(res.status, typeof data.detail === "string" ? data.detail : `Capture failed (HTTP ${res.status})`);
  }
  return data as AgentResult;
}

const postJson = (path: string, body: unknown) =>
  request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const base = (projectId: string) => `projects/${encodeURIComponent(projectId)}/captures`;

export interface CaptureInput {
  text?: string;
  audio?: { blob: Blob; filename: string } | null;
  images?: File[];
}

/** Voice, photos and/or text in one submission (multipart). Resolves to `needs_category` with the AI's suggestions. */
export function submitCapture(projectId: string, input: CaptureInput) {
  const form = new FormData();
  form.set("recorded_at", new Date().toISOString());
  if (input.text?.trim()) form.set("transcript", input.text.trim());
  if (input.audio) form.append("audio", input.audio.blob, input.audio.filename);
  for (const img of input.images ?? []) form.append("images", img, img.name);
  return request(base(projectId), { method: "POST", body: form });
}

export const submitNote = (projectId: string, text: string) => submitCapture(projectId, { text });

/** Sends a recording; the server transcribes it (needs a speech-to-text service) and then treats it like a typed note. */
export const submitAudio = (projectId: string, audio: Blob, filename: string) => submitCapture(projectId, { audio: { blob: audio, filename } });

export const confirmCategories = (projectId: string, threadId: string, events: CategoryDecision[], added: AddedEvent[] = []) =>
  postJson(`${base(projectId)}/${encodeURIComponent(threadId)}/categories`, { events, added });

export const answerQuestions = (projectId: string, threadId: string, answers: { id: string; answer: string }[]) =>
  postJson(`${base(projectId)}/${encodeURIComponent(threadId)}/answers`, { answers });

/** Speech-to-text was unavailable: the speaker types what the recording said, and the capture continues. */
export const provideTranscript = (projectId: string, threadId: string, text: string) =>
  postJson(`${base(projectId)}/${encodeURIComponent(threadId)}/transcript`, { text });

/** The speaker's last look before saving: corrected values, removed facts, or discard the whole note. */
export const submitReview = (projectId: string, threadId: string, decision: ReviewDecision) =>
  postJson(`${base(projectId)}/${encodeURIComponent(threadId)}/review`, decision);

export async function getEventCategories(projectId: string): Promise<EventCategory[]> {
  const res = await fetch(`/api/sm/projects/${encodeURIComponent(projectId)}/event-categories`, { cache: "no-store" });
  if (!res.ok) throw new ApiError(res.status, "Could not load event categories");
  const parsed = eventCategoriesSchema.safeParse(await res.json());
  if (!parsed.success) throw new ApiError(502, "Unexpected response from the API");
  return parsed.data;
}

// ---------- the member's saved notes ----------
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
  category?: string | null;
  status?: string | null;
  severity?: Severity | null;
}

export interface SavedRecording {
  photos?: { id: string; description: string | null }[];
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
  const res = await fetch(`/api/sm/${base(projectId)}`, { cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, typeof data.detail === "string" ? data.detail : `Could not load recordings (HTTP ${res.status})`);
  return data.recordings as SavedRecording[];
}

export const recordingAudioUrl = (projectId: string, sourceId: string) =>
  `/api/sm/${base(projectId)}/${encodeURIComponent(sourceId)}/audio`;
