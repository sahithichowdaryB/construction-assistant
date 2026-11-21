/**
 * One typed function per backend endpoint. Each decides between fixtures and the real API through
 * servedFromFixtures() in lib/endpoints.ts. Real calls go to the server-side proxy at /api/sm/*,
 * which attaches the bearer token; the browser never talks to FastAPI directly.
 */
import { z } from "zod";
import { servedFromFixtures, type EndpointKey } from "@/lib/endpoints";
import * as fx from "@/lib/fixture-server";
import { alertsSchema, healthSchema, incidentAnalysisSchema, incidentSchema, incidentsSchema, progressSchema } from "@/lib/schemas";
import type {
  Activity,
  Alert,
  AlertContext,
  AskAnswer,
  Draft,
  DraftSummary,
  Export,
  Gap,
  HealthStatus,
  Incident,
  IncidentAnalysis,
  NoticeType,
  Passage,
  Progress,
  Project,
  Proposal,
  Role,
  Source,
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
  return fixture("alertContext", () => fx.fxAlertContext(alert.activity_code, workDate));
}

export async function dismissAlert(pid: string, id: string, reason: string, asOf: string) {
  void pid;
  return fixture("dismissAlert", () => fx.fxDismissAlert(id, reason, asOf));
}

// ---------- incidents ----------
export async function getIncidents(pid: string, asOf: string): Promise<Incident[]> {
  if (servedFromFixtures("incidents")) return fixture("incidents", () => fx.fxIncidents(asOf));
  return http(`/projects/${encodeURIComponent(pid)}/incidents${qs({ as_of: asOf })}`, incidentsSchema);
}

export async function getIncident(pid: string, id: string, asOf: string): Promise<Incident> {
  if (servedFromFixtures("incident")) return fixture("incident", () => fx.fxIncident(id, asOf));
  return http(`/projects/${encodeURIComponent(pid)}/incidents/${encodeURIComponent(id)}${qs({ as_of: asOf })}`, incidentSchema);
}

/** Latest cause analysis for an incident (404 when the agent has not run yet, or nothing was known at as_of). */
export async function getIncidentAnalysis(pid: string, id: string, asOf: string): Promise<IncidentAnalysis> {
  if (servedFromFixtures("incidentAnalysis")) return fixture("incidentAnalysis", () => fx.fxIncidentAnalysis(id, asOf));
  return http(
    `/projects/${encodeURIComponent(pid)}/incidents/${encodeURIComponent(id)}/analysis${qs({ as_of: asOf })}`,
    incidentAnalysisSchema,
  );
}

/** Runs the evidence agent and stores a new version. The caller refetches the analysis afterwards. */
export async function analyzeIncident(pid: string, id: string, asOf: string): Promise<void> {
  if (servedFromFixtures("analyzeIncident")) return fixture("analyzeIncident", () => void fx.fxIncidentAnalysis(id, asOf));
  await http(
    `/projects/${encodeURIComponent(pid)}/incidents/${encodeURIComponent(id)}/analyze${qs({ as_of: asOf })}`,
    z.object({ version: z.number() }).passthrough(),
    { method: "POST" },
  );
}

// ---------- documents & evidence ----------
export async function getSources(pid: string, asOf: string): Promise<Source[]> {
  void pid;
  return fixture("sources", () => fx.fxSources(asOf));
}

export async function getSource(pid: string, sid: string, asOf: string): Promise<Source & { passages: Passage[] }> {
  void pid;
  return fixture("sources", () => ({ ...fx.fxSource(sid, asOf), passages: fx.fxPassagesFor(sid) }));
}

export async function getSourceSummary(pid: string, sid: string, asOf: string): Promise<SourceSummary> {
  void pid;
  return fixture("summary", () => fx.fxSummary(sid, asOf));
}

export async function getEvidence(pid: string, passageId: string, asOf: string): Promise<{ passage: Passage; source: Source }> {
  void pid;
  return fixture("evidence", () => fx.fxEvidence(passageId, asOf));
}

/** URL of the original file, always through the proxy (it falls back to the demo pack in fixture mode). */
export function sourceFileUrl(pid: string, sid: string, asOf: string): string {
  return `/api/sm/projects/${encodeURIComponent(pid)}/sources/${encodeURIComponent(sid)}/file${qs({ as_of: asOf })}`;
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
