/**
 * One typed function per backend endpoint. Each decides between fixtures and the real API through
 * servedFromFixtures() in lib/endpoints.ts. Real calls go to the server-side proxy at /api/sm/*,
 * which attaches the bearer token; the browser never talks to FastAPI directly.
 */
import { z } from "zod";
import { servedFromFixtures, type EndpointKey } from "@/lib/endpoints";
import * as fx from "@/lib/fixture-server";
import {
  actionItemsSchema,
  actionUpdateSchema,
  alertDetailSchema,
  alertsSchema,
  capturePromptsSchema,
  evidenceSchema,
  healthSchema,
  incidentEventsSchema,
  incidentReasoningSchema,
  incidentSchema,
  incidentsSchema,
  okSchema,
  previewSchema,
  progressSchema,
  readingsSchema,
  searchSchema,
  sourceDetailSchema,
  sourcesSchema,
  storageSchema,
  summarySchema,
  uploadJobSchema,
} from "@/lib/schemas";
import type {
  ActionItem,
  Activity,
  Alert,
  AlertContext,
  AlertDetail,
  CapturePrompt,
  IncidentEventLink,
  AskAnswer,
  DayRecap,
  Draft,
  DraftSummary,
  Export,
  Gap,
  HealthStatus,
  Incident,
  IncidentReasoning,
  NoticeType,
  Passage,
  Progress,
  Project,
  Proposal,
  ReportReadings,
  Role,
  SearchResponse,
  Source,
  SourcePreview,
  SourceStorage,
  SourceSummary,
  SourceType,
  TodayBriefing,
  UploadJob,
} from "@/lib/types";

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export const SIMULATE_ERRORS_KEY = "sitemate.simulateErrors";
const FIXTURE_LATENCY_MS = 250;

function simulateErrors(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SIMULATE_ERRORS_KEY) === "1";
  } catch {
    return false;
  }
}

/** Runs a fixture handler with a short delay so loading states are visible, mapping errors to ApiError. */
async function fixture<T>(key: EndpointKey, run: () => T | Promise<T>): Promise<T> {
  await new Promise((r) => setTimeout(r, FIXTURE_LATENCY_MS));
  if (simulateErrors()) throw new ApiError(503, `Simulated failure for ${key} (turn off in Settings)`);
  try {
    return await run();
  } catch (e) {
    if (e instanceof fx.FixtureError) throw new ApiError(e.status, e.message);
    throw e;
  }
}

async function http<S extends z.ZodTypeAny>(path: string, schema: S, init?: RequestInit): Promise<z.infer<S>> {
  let res: Response;
  try {
    res = await fetch(`/api/sm${path}`, { cache: "no-store", ...init });
  } catch {
    throw new ApiError(0, "Network error: the SiteMate proxy could not be reached");
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { detail?: unknown; message?: unknown };
      const detail = body.detail ?? body.message;
      if (typeof detail === "string") message = detail;
      else if (detail) message = JSON.stringify(detail);
    } catch {
      /* body was not JSON */
    }
    throw new ApiError(res.status, message);
  }
  const parsed = schema.safeParse(await res.json());
  if (!parsed.success) throw new ApiError(502, `Unexpected response from ${path}`);
  return parsed.data;
}

const qs = (params: Record<string, string | null | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) s.set(k, v);
  const str = s.toString();
  return str ? `?${str}` : "";
};

// ---------- health ----------
export async function getHealth(): Promise<HealthStatus> {
  return http("/health", healthSchema);
}

// ---------- project & schedule ----------
export async function getProject(pid: string): Promise<Project> {
  void pid;
  return fixture("project", () => fx.fxProject());
}

export async function getActivities(pid: string): Promise<Activity[]> {
  void pid;
  return fixture("activities", () => fx.fxActivities());
}

export async function getProgress(pid: string, code: string, date: string, asOf: string): Promise<Progress> {
  if (servedFromFixtures("progress")) return fixture("progress", () => fx.fxProgress(code, date, asOf));
  return http(
    `/projects/${encodeURIComponent(pid)}/activities/${encodeURIComponent(code)}/progress${qs({ date, as_of: asOf })}`,
    progressSchema,
  );
}

// ---------- today ----------
export async function getToday(pid: string, asOf: string): Promise<TodayBriefing> {
  void pid;
  return fixture("today", () => fx.fxToday(asOf));
}

// ---------- alerts ----------
export async function getAlerts(pid: string, asOf: string): Promise<Alert[]> {
  if (servedFromFixtures("alerts")) return fixture("alerts", () => fx.fxAlerts(asOf));
  return http(`/projects/${encodeURIComponent(pid)}/alerts${qs({ as_of: asOf })}`, alertsSchema);
}

export async function getAlertContext(pid: string, alert: Alert, workDate: string): Promise<AlertContext> {
  void pid;
  return fixture("alertContext", () => fx.fxAlertContext(alert.activity_code ?? "", workDate));
}

export async function dismissAlert(pid: string, id: string, reason: string, asOf: string) {
  void pid;
  return fixture("dismissAlert", () => fx.fxDismissAlert(id, reason, asOf));
}

// ---------- incidents ----------
/** Every incident on record. Pass asOf only to limit the list to what was known at that instant. */
export async function getIncidents(pid: string, asOf: string | null = null): Promise<Incident[]> {
  if (servedFromFixtures("incidents")) return fixture("incidents", () => fx.fxIncidents(asOf));
  return http(`/projects/${encodeURIComponent(pid)}/incidents${qs({ as_of: asOf })}`, incidentsSchema);
}

export async function getIncident(pid: string, id: string, asOf: string | null = null): Promise<Incident> {
  if (servedFromFixtures("incident")) return fixture("incident", () => fx.fxIncident(id, asOf));
  return http(`/projects/${encodeURIComponent(pid)}/incidents/${encodeURIComponent(id)}${qs({ as_of: asOf })}`, incidentSchema);
}

/** Latest cause reasoning for an incident (404 until the agent has run, or nothing was known at as_of). */
export async function getIncidentReasoning(pid: string, id: string, asOf: string | null): Promise<IncidentReasoning> {
  return http(
    `/projects/${encodeURIComponent(pid)}/incidents/${encodeURIComponent(id)}/reasoning${qs({ as_of: asOf })}`,
    incidentReasoningSchema,
  );
}

/** Runs the evidence agent now (database read + LLM calls) and stores the result. Callers refetch afterwards. */
export async function runIncidentReasoning(pid: string, id: string, asOf: string | null) {
  return http(
    `/projects/${encodeURIComponent(pid)}/incidents/${encodeURIComponent(id)}/reasoning${qs({ as_of: asOf })}`,
    z.object({ version: z.number(), reused: z.boolean() }).passthrough(),
    { method: "POST" },
  );
}

// ---------- event pipeline: incident sources, alert lifecycle, recommended actions ----------
// These always come from the backend (database + agents); there are no fixtures for them.
const proj = (pid: string) => `/projects/${encodeURIComponent(pid)}`;
const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body ?? {}),
});

export async function getIncidentEvents(pid: string, id: string): Promise<IncidentEventLink[]> {
  return http(`${proj(pid)}/incidents/${encodeURIComponent(id)}/events`, incidentEventsSchema);
}

export async function patchIncident(pid: string, id: string, status: "open" | "monitoring" | "resolved" | "closed") {
  return http(`${proj(pid)}/incidents/${encodeURIComponent(id)}`, okSchema, json("PATCH", { status }));
}

export async function mergeIncident(pid: string, id: string, intoId: string) {
  return http(`${proj(pid)}/incidents/${encodeURIComponent(id)}/merge`, okSchema, json("POST", { into_id: intoId }));
}

export async function unlinkIncidentEvent(pid: string, id: string, eventId: string, makeNewIncident: boolean) {
  return http(
    `${proj(pid)}/incidents/${encodeURIComponent(id)}/events/${encodeURIComponent(eventId)}/unlink`,
    okSchema,
    json("POST", { make_new_incident: makeNewIncident }),
  );
}

export async function getAlertDetail(pid: string, id: string): Promise<AlertDetail> {
  return http(`${proj(pid)}/alerts/${encodeURIComponent(id)}`, alertDetailSchema);
}

export type AlertTransition = "ack" | "assign" | "dismiss" | "resolve" | "reopen";
export async function transitionAlert(
  pid: string,
  id: string,
  action: AlertTransition,
  body: { note?: string; assignee?: string; resolve_incident?: boolean } = {},
) {
  return http(`${proj(pid)}/alerts/${encodeURIComponent(id)}/${action}`, okSchema, json("POST", body));
}

export async function decideAction(
  pid: string,
  alertId: string,
  actionId: string,
  decision: "approve" | "reject" | "complete",
  body: { assignee?: string } = {},
) {
  return http(
    `${proj(pid)}/alerts/${encodeURIComponent(alertId)}/actions/${encodeURIComponent(actionId)}/${decision}`,
    okSchema,
    json("POST", body),
  );
}

export async function editAction(
  pid: string,
  alertId: string,
  actionId: string,
  patch: { title?: string; rationale?: string; owner_role?: string; contractor_id?: string | null; priority?: string },
) {
  return http(
    `${proj(pid)}/alerts/${encodeURIComponent(alertId)}/actions/${encodeURIComponent(actionId)}`,
    okSchema,
    json("PATCH", patch),
  );
}

export async function getCapturePrompts(pid: string): Promise<CapturePrompt[]> {
  return http(`${proj(pid)}/capture-prompts`, capturePromptsSchema);
}

/** URL of an incident photo, through the proxy. `url` is the backend path from the events response. */
export const attachmentUrl = (url: string) => `/api/sm${url}`;

// ---------- documents & evidence ----------
const projectPath = (pid: string) => `/projects/${encodeURIComponent(pid)}`;

export async function getSources(pid: string, asOf: string): Promise<Source[]> {
  if (servedFromFixtures("sources")) return fixture("sources", () => fx.fxSources(asOf));
  return http(`${projectPath(pid)}/sources${qs({ as_of: asOf })}`, sourcesSchema);
}

export async function getSource(pid: string, sid: string, asOf: string): Promise<Source & { passages: Passage[] }> {
  if (servedFromFixtures("source"))
    return fixture("source", () => ({ ...fx.fxSource(sid, asOf), passages: fx.fxPassagesFor(sid) }));
  return http(`${projectPath(pid)}/sources/${encodeURIComponent(sid)}${qs({ as_of: asOf })}`, sourceDetailSchema);
}

export async function getSourceSummary(pid: string, sid: string, asOf: string): Promise<SourceSummary> {
  if (servedFromFixtures("summary")) return fixture("summary", () => fx.fxSummary(sid, asOf));
  return http(`${projectPath(pid)}/sources/${encodeURIComponent(sid)}/summary${qs({ as_of: asOf })}`, summarySchema);
}

/** Queues a fresh summary for a source. Returns the ingestion job to poll. */
export async function regenerateSummary(pid: string, sid: string): Promise<UploadJob> {
  if (servedFromFixtures("regenerateSummary"))
    return fixture("regenerateSummary", () => {
      throw new fx.FixtureError(501, "Summaries are generated by the live API (set NEXT_PUBLIC_USE_FIXTURES=false)");
    });
  return http(`${projectPath(pid)}/sources/${encodeURIComponent(sid)}/summary`, uploadJobSchema, { method: "POST" });
}

export async function getEvidence(pid: string, passageId: string, asOf: string): Promise<{ passage: Passage; source: Source }> {
  if (servedFromFixtures("evidence")) return fixture("evidence", () => fx.fxEvidence(passageId, asOf));
  return http(`${projectPath(pid)}/evidence/${encodeURIComponent(passageId)}${qs({ as_of: asOf })}`, evidenceSchema);
}

/** Quantities read from a daily report (text layer or OCR), compared with accepted observations. */
export async function getReportReadings(pid: string, sid: string, asOf: string): Promise<ReportReadings> {
  if (servedFromFixtures("readings")) return fixture("readings", () => fx.fxReadings(sid, asOf));
  return http(`${projectPath(pid)}/sources/${encodeURIComponent(sid)}/readings${qs({ as_of: asOf })}`, readingsSchema);
}

/** Where the original file and every derived record of a source are stored (live API only). */
export async function getSourceStorage(pid: string, sid: string, asOf: string): Promise<SourceStorage> {
  if (servedFromFixtures("storage"))
    return fixture("storage", () => {
      throw new fx.FixtureError(404, "Storage details come from the live API (set NEXT_PUBLIC_USE_FIXTURES=false)");
    });
  return http(`${projectPath(pid)}/sources/${encodeURIComponent(sid)}/storage${qs({ as_of: asOf })}`, storageSchema);
}

/** Structured preview of an original the browser cannot render inline (Word, CSV, email, text). */
export async function getSourcePreview(pid: string, sid: string, asOf: string): Promise<SourcePreview> {
  if (servedFromFixtures("preview"))
    return fixture("preview", () => {
      throw new fx.FixtureError(404, "Structured previews come from the live API");
    });
  return http(`${projectPath(pid)}/sources/${encodeURIComponent(sid)}/preview${qs({ as_of: asOf })}`, previewSchema);
}

/** Project-scoped evidence search; only sources available at as_of are searched. */
export async function searchEvidence(pid: string, q: string, asOf: string): Promise<SearchResponse> {
  if (servedFromFixtures("search")) return fixture("search", () => fx.fxSearch(q, asOf));
  return http(`${projectPath(pid)}/search${qs({ q, as_of: asOf, limit: "10" })}`, searchSchema);
}

export async function getActionItems(pid: string, asOf: string): Promise<ActionItem[]> {
  if (servedFromFixtures("actionItems")) return fixture("actionItems", () => fx.fxActionItems(asOf));
  return http(`${projectPath(pid)}/action-items${qs({ as_of: asOf })}`, actionItemsSchema);
}

export async function setActionItemCompleted(pid: string, id: string, completed: boolean) {
  if (servedFromFixtures("completeAction"))
    return fixture("completeAction", () => ({ id, completed_at: completed ? new Date().toISOString() : null }));
  return http(`${projectPath(pid)}/action-items/${encodeURIComponent(id)}`, actionUpdateSchema, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ completed }),
  });
}

/**
 * Uploads a document (report, minutes, email, photo, register...) for parsing and indexing.
 * The live API stores the original privately, hashes it and queues parsing. It records the real upload
 * time as available_at (no time is sent), and returns it so the as-of clock can catch up.
 */
export async function uploadDocument(pid: string, input: { type: SourceType; file: File }, asOf: string): Promise<UploadJob> {
  if (servedFromFixtures("uploadDocument"))
    return fixture("uploadDocument", () =>
      fx.fxUpload({ type: input.type, filename: input.file.name, mime: input.file.type || null, asOf }),
    );
  const form = new FormData();
  form.set("file", input.file, input.file.name);
  form.set("kind", input.type);
  return http(`${projectPath(pid)}/sources`, uploadJobSchema, { method: "POST", body: form });
}

export async function getDocumentJob(pid: string, jobId: string): Promise<UploadJob> {
  if (servedFromFixtures("documentJob")) return fixture("documentJob", () => fx.fxJob(jobId));
  return http(`${projectPath(pid)}/jobs/${encodeURIComponent(jobId)}`, uploadJobSchema);
}

/** URL of the original file, always through the proxy (it falls back to the demo pack in fixture mode). */
export function sourceFileUrl(pid: string, sid: string, asOf: string, opts: { download?: boolean } = {}): string {
  const params = { as_of: asOf, download: opts.download ? "true" : null };
  return `/api/sm/projects/${encodeURIComponent(pid)}/sources/${encodeURIComponent(sid)}/file${qs(params)}`;
}

// ---------- capture ----------
export interface UploadInput {
  type: SourceType;
  text?: string | null;
  file?: Blob | null;
  filename?: string | null;
  /** Demo only: pick which Riverside proposal the fixture returns */
  proposal?: string | null;
}

export async function uploadSource(pid: string, input: UploadInput, asOf: string): Promise<UploadJob> {
  void pid;
  return fixture("uploadSource", () =>
    fx.fxUpload({
      type: input.type,
      text: input.text,
      filename: input.filename,
      mime: input.file?.type ?? null,
      proposal: input.proposal,
      asOf,
    }),
  );
}

export async function getJob(pid: string, jobId: string): Promise<UploadJob> {
  void pid;
  return fixture("job", () => fx.fxJob(jobId));
}

export async function getProposals(pid: string, sid: string): Promise<Proposal[]> {
  void pid;
  return fixture("proposals", () => fx.fxProposals(sid));
}

export interface ConfirmInput {
  transcript: string;
  fields: { key: string; value: string | number | null; provenance: Proposal["fields"][number]["provenance"] }[];
  answers: Record<string, string>;
  link_incident_id: string | null;
  mode: "incident" | "diary_note";
}

export async function confirmProposal(pid: string, sid: string, input: ConfirmInput) {
  void pid;
  return fixture("confirm", () => fx.fxConfirm(sid, input));
}

// ---------- ask ----------
export async function askSiteMate(pid: string, question: string, asOf: string): Promise<AskAnswer> {
  void pid;
  return fixture("ask", () => fx.fxAsk(question, asOf));
}

// ---------- recaps ----------
export async function getRecaps(pid: string, asOf: string): Promise<DayRecap[]> {
  void pid;
  return fixture("recaps", () => fx.fxRecaps(asOf));
}

// ---------- drafts ----------
export async function getDrafts(pid: string, asOf: string): Promise<DraftSummary[]> {
  void pid;
  return fixture("drafts", () => fx.fxDrafts(asOf));
}

export async function getDraft(id: string, asOf: string): Promise<Draft> {
  return fixture("getDraft", () => fx.fxDraft(id, asOf));
}

export async function createDraft(
  pid: string,
  input: { type: NoticeType; keywords?: string | null; alert_id?: string | null; incident_id?: string | null },
  asOf: string,
): Promise<Draft> {
  void pid;
  return fixture("createDraft", () => fx.fxCreateDraft(input, asOf));
}

export async function saveDraftVersion(
  id: string,
  input: { body: string; gaps: Gap[]; base_version: number; author: string },
  asOf: string,
): Promise<Draft> {
  return fixture("patchDraft", () => fx.fxSaveVersion(id, input, asOf));
}

export async function reviewDraftVersion(
  id: string,
  version: number,
  input: { decision: "submitted" | "approved" | "changes_requested"; reason?: string | null; role: Role; reviewer: string },
  asOf: string,
): Promise<Draft> {
  return fixture("review", () => fx.fxReview(id, version, input, asOf));
}

export async function exportDraftVersion(
  id: string,
  version: number,
  format: Export["format"],
  role: Role,
  asOf: string,
): Promise<Export> {
  return fixture("export", () => fx.fxExport(id, version, format, role, asOf));
}
