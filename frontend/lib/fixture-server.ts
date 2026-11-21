/**
 * In-browser stand-in for the backend routes that don't exist yet.
 *
 * It only filters and looks up fixture records by the as-of clock (available_at <= as_of) and keeps
 * session state for the draft lifecycle. Every number it returns was precomputed in fixtures/ by
 * scripts/build-fixtures.mjs; nothing here calculates a business result.
 * State lives in memory and resets on page reload.
 */
import activitiesJson from "@/fixtures/activities.json";
import alertContextJson from "@/fixtures/alert-context.json";
import alertsJson from "@/fixtures/alerts.json";
import askJson from "@/fixtures/ask.json";
import briefingsJson from "@/fixtures/briefings.json";
import draftsJson from "@/fixtures/drafts.json";
import incidentsJson from "@/fixtures/incidents.json";
import passagesJson from "@/fixtures/passages.json";
import progressJson from "@/fixtures/progress.json";
import projectJson from "@/fixtures/project.json";
import proposalsJson from "@/fixtures/proposals.json";
import sourcesJson from "@/fixtures/sources.json";
import summariesJson from "@/fixtures/summaries.json";
import { isAvailable, localDateOf } from "@/lib/time";
import type {
  ActionItem,
  Activity,
  Alert,
  AlertContext,
  AskAnswer,
  Draft,
  DraftSummary,
  DraftVersion,
  EvidenceRef,
  Export,
  Gap,
  Incident,
  NoticeType,
  Passage,
  Progress,
  ProgressObservation,
  Project,
  Proposal,
  ReportReadings,
  Role,
  SearchResponse,
  Source,
  SourceSummary,
  SourceType,
  TodayActivity,
  TodayBriefing,
  UploadJob,
} from "@/lib/types";

export class FixtureError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type FixtureAlert = Alert & { available_at: string; retired_at: string | null };
type ProgressSnapshot = {
  available_at: string;
  actual: number | null;
  basis: Progress["basis"];
  shortfall_pct: number | null;
  severity: Progress["severity"];
  evidence: Progress["evidence"];
  observations: ProgressObservation[];
};
type FixtureProgress = Omit<Progress, "actual" | "basis" | "shortfall_pct" | "severity" | "evidence" | "observations"> & {
  snapshots: ProgressSnapshot[];
};
type Briefings = {
  headlines: { work_date: string; available_at: string; text: string }[];
  bullets: { work_date: string; available_at: string; text: string; refs: EvidenceRef[] }[];
};

const project = projectJson as Project;
const activities = activitiesJson as Activity[];
const alerts = alertsJson as FixtureAlert[];
const alertContexts = alertContextJson as AlertContext[];
const progress = progressJson as unknown as FixtureProgress[];
const passages = passagesJson as Passage[];
const proposals = proposalsJson as unknown as Proposal[];
const summaries = summariesJson as SourceSummary[];
const incidents = incidentsJson as unknown as Incident[];
const briefings = briefingsJson as Briefings;
const ask = askJson as {
  rules: { match: string[]; available_at: string; answer: string; citations: AskAnswer["citations"] }[];
  fallback: string;
};
const baseSources = (sourcesJson as (Source & { path: string })[]).map(({ path: _path, ...s }) => {
  void _path;
  return s as Source;
});

// ---------- session state ----------
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const state = {
  drafts: clone(draftsJson) as unknown as Draft[],
  dismissed: new Map<string, { reason: string; at: string }>(),
  jobs: new Map<string, UploadJob & { started: number; fail: boolean; proposal: string | null }>(),
  uploads: [] as Source[],
  seq: 1,
};

const latest = <T extends { available_at: string }>(items: T[], asOf: string): T | undefined =>
  items.filter((i) => isAvailable(i.available_at, asOf)).at(-1);

// ---------- project, schedule, sources ----------
export const fxProject = (): Project => project;
export const fxActivities = (): Activity[] => activities;

export function fxSources(asOf: string): Source[] {
  const fromUploads = state.uploads.map((s) => ({ ...s, status: jobStatusFor(s.id) ?? s.status }));
  return [...baseSources, ...fromUploads].filter((s) => isAvailable(s.available_at, asOf));
}

export function fxSource(id: string, asOf: string): Source {
  const s = fxSources(asOf).find((x) => x.id === id);
  if (!s) throw new FixtureError(404, `Source ${id} is not available at this time`);
  return s;
}

export function fxEvidence(passageId: string, asOf: string): { passage: Passage; source: Source } {
  const passage = passages.find((p) => p.id === passageId);
  if (!passage) throw new FixtureError(404, `Passage ${passageId} not found`);
  return { passage, source: fxSource(passage.source_id, asOf) };
}

export function fxPassagesFor(sourceId: string): Passage[] {
  return passages.filter((p) => p.source_id === sourceId);
}

export function fxSummary(sourceId: string, asOf: string): SourceSummary {
  fxSource(sourceId, asOf);
  const s = summaries.find((x) => x.source_id === sourceId);
  if (!s) throw new FixtureError(404, "No summary for this source yet");
  return s;
}

/** Fixture stand-in for GET /search: keyword overlap over the fixture passages (no ranking model). */
export function fxSearch(query: string, asOf: string): SearchResponse {
  const terms = query.toLowerCase().split(/[^a-z0-9³²-]+/).filter((t) => t.length > 2);
  const visible = new Map(fxSources(asOf).map((s) => [s.id, s]));
  const results = passages
    .filter((p) => visible.has(p.source_id))
    .map((p) => ({ p, score: terms.filter((t) => p.text.toLowerCase().includes(t)).length }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ p, score }) => {
      const s = visible.get(p.source_id)!;
      return {
        passage_id: p.id,
        source_id: p.source_id,
        locator: p.locator,
        page: p.page,
        excerpt: p.text,
        kind: "paragraph",
        section: null,
        untrusted: s.type === "email",
        source_kind: s.type,
        source_title: s.title,
        available_at: s.available_at,
        score,
        ref: { source_id: p.source_id, locator: p.locator, page: p.page, passage_id: p.id },
      };
    });
  return { query, reranked: false, results };
}

/** Fixture stand-in for GET /action-items: the open actions of the fixture summaries. */
export function fxActionItems(asOf: string): ActionItem[] {
  const visible = new Map(fxSources(asOf).map((s) => [s.id, s]));
  return summaries
    .filter((s) => visible.has(s.source_id))
    .flatMap((s) =>
      s.open_actions.map((a, i) => {
        const src = visible.get(s.source_id)!;
        return {
          id: `${s.source_id}-${i}`,
          description: a.text,
          owner_name: a.owner,
          due_at: a.due,
          completed_at: null,
          quote: null,
          source_id: s.source_id,
          source_type: src.type,
          source_title: src.title,
          available_at: src.available_at,
          overdue: !!a.due && isAvailable(a.due, asOf),
          ref: a.refs[0] ?? { source_id: s.source_id },
        };
      }),
    );
}

export function fxReadings(sourceId: string, asOf: string): ReportReadings {
  fxSource(sourceId, asOf);
  throw new FixtureError(404, "Report readings come from the live API (set NEXT_PUBLIC_USE_FIXTURES=false)");
}

// ---------- progress and alerts ----------
export function fxProgress(code: string, date: string, asOf: string): Progress {
  const p = progress.find((x) => x.activity_code === code && x.work_date === date);
  const snap = p ? latest(p.snapshots, asOf) : undefined;
  if (!p || !snap) throw new FixtureError(404, "No baseline for this activity and date");
  const { snapshots: _s, ...base } = p;
  void _s;
  const { available_at: _a, ...rest } = snap;
  void _a;
  return { ...base, ...rest };
}

export function fxAlerts(asOf: string): Alert[] {
  return alerts
    .filter((a) => isAvailable(a.available_at, asOf) && (!a.retired_at || !isAvailable(a.retired_at, asOf)))
    .filter((a) => !state.dismissed.has(a.id))
    .map(({ available_at: _a, retired_at: _r, ...a }) => {
      void _a;
      void _r;
      return a;
    });
}

export function fxAlertContext(activityCode: string, workDate: string): AlertContext {
  return (
    alertContexts.find((c) => c.activity_code === activityCode && c.work_date === workDate) ?? {
      activity_code: activityCode,
      work_date: workDate,
      likely_causes: [],
      successors_at_risk: [],
      incident_id: null,
      draft_id: null,
    }
  );
}

export function fxDismissAlert(id: string, reason: string, asOf: string) {
  if (!reason.trim()) throw new FixtureError(422, "A reason is required to dismiss an alert");
  state.dismissed.set(id, { reason, at: asOf });
  return { id, dismissed: true };
}

// ---------- incidents ----------
export function fxIncidents(asOf: string): Incident[] {
  return incidents
    .filter((i) => isAvailable(i.reported_at, asOf))
    .map((i) => {
      const resolved = i.resolved_at && isAvailable(i.resolved_at, asOf) ? i.resolved_at : null;
      const timeline = i.timeline.filter((e) => isAvailable(e.at, asOf));
      for (const d of state.drafts.filter((d) => d.incident_id === i.id)) {
        for (const v of d.versions) {
          const approval = v.reviews.find((r) => r.decision === "approved");
          if (approval && isAvailable(approval.decided_at, asOf))
            timeline.push({
              kind: "approved",
              at: approval.decided_at,
              label: `Draft v${v.version} approved by ${approval.reviewer}`,
              refs: [],
              link: `/drafts/${d.id}`,
            });
        }
      }
      timeline.sort((a, b) => a.at.localeCompare(b.at));
      return { ...i, resolved_at: resolved, status: resolved ? "resolved" : "open", timeline } as Incident;
    })
    .sort((a, b) => b.reported_at.localeCompare(a.reported_at));
}

export function fxIncident(id: string, asOf: string): Incident {
  const i = fxIncidents(asOf).find((x) => x.id === id);
  if (!i) throw new FixtureError(404, `Incident ${id} is not available at this time`);
  return i;
}

// ---------- today ----------
export function fxToday(asOf: string): TodayBriefing {
  const workDate = localDateOf(asOf, project.timezone);
  const headline = latest(
    briefings.headlines.filter((h) => h.work_date === workDate),
    asOf,
  );
  const bullets = briefings.bullets
    .filter((b) => b.work_date === workDate && isAvailable(b.available_at, asOf))
    .map(({ text, refs }) => ({ text, refs }));

  const todays: TodayActivity[] = [];
  for (const p of progress.filter((x) => x.work_date === workDate)) {
    const snap = latest(p.snapshots, asOf);
    if (!snap) continue;
    if (p.planned === 0 && !snap.actual) continue;
    const act = activities.find((a) => a.code === p.activity_code);
    todays.push({
      code: p.activity_code,
      name: act?.name ?? p.activity_code,
      zone: act?.zone ?? "Unknown",
      unit: p.unit,
      planned: p.planned,
      actual: snap.actual,
      basis: snap.basis,
      shortfall_pct: snap.shortfall_pct,
      severity: snap.severity,
      plan_ref: { source_id: p.plan_evidence.source_id, locator: p.plan_evidence.locator, passage_id: `SCH:${p.activity_code}` },
      actual_ref: snap.evidence
        ? { ...snap.evidence, passage_id: `${snap.evidence.source_id}:${snap.evidence.locator}` }
        : null,
    });
  }
  // Activities scheduled for a date beyond the reporting window have no fixture rows yet.
  if (!progress.some((x) => x.work_date === workDate)) {
    for (const a of activities.filter((a) => a.planned_start <= workDate && a.planned_end >= workDate)) {
      todays.push({
        code: a.code,
        name: a.name,
        zone: a.zone,
        unit: a.unit,
        planned: a.planned_qty_per_day,
        actual: null,
        basis: null,
        shortfall_pct: null,
        severity: null,
        plan_ref: { source_id: "SCH", locator: a.code, passage_id: `SCH:${a.code}` },
        actual_ref: null,
      });
    }
  }

  return {
    as_of: asOf,
    work_date: workDate,
    briefing: {
      headline: headline?.text ?? "No briefing has been prepared for this time.",
      bullets,
    },
    activities: todays,
    open_alerts: fxAlerts(asOf),
    open_incidents: fxIncidents(asOf).filter((i) => i.status !== "resolved"),
    drafts_awaiting_review: fxDrafts(asOf).filter((d) => d.status !== "approved"),
  };
}

// ---------- capture ----------
function jobStatusFor(sourceId: string) {
  const job = [...state.jobs.values()].find((j) => j.source_id === sourceId);
  return job ? fxJob(job.id).status : undefined;
}

export function fxUpload(input: {
  type: SourceType;
  text?: string | null;
  filename?: string | null;
  mime?: string | null;
  proposal?: string | null;
  asOf: string;
}): UploadJob {
  const n = state.seq++;
  const sourceId = `UP${String(n).padStart(2, "0")}`;
  const text = (input.text ?? "").toLowerCase();
  const fail = /\bfail\b/.test(text) || (input.filename ?? "").toLowerCase().includes("fail");
  let proposal = input.proposal ?? null;
  if (!proposal && (input.type === "voice" || input.text)) {
    if (/mechanic|tomorrow|noon|estimate/.test(text)) proposal = "V02";
    else if (/same machine|still waiting/.test(text)) proposal = "V03";
    else proposal = "V01";
  }
  state.uploads.push({
    id: sourceId,
    project_id: project.id,
    type: input.type,
    title: input.filename ? input.filename : input.type === "voice" ? "Voice note (this session)" : "Typed note (this session)",
    filename: input.filename ?? `${sourceId}.txt`,
    mime: input.mime ?? "text/plain",
    available_at: input.asOf,
    status: "uploaded",
    pages: null,
    note: "Uploaded in this session (fixture, not persisted)",
  });
  const job = {
    id: `JOB-${n}`,
    source_id: sourceId,
    status: "uploaded" as const,
    error: null,
    created_at: input.asOf,
    started: Date.now(),
    fail,
    proposal,
  };
  state.jobs.set(job.id, job);
  return fxJob(job.id);
}

export function fxJob(id: string): UploadJob {
  const job = state.jobs.get(id);
  if (!job) throw new FixtureError(404, "Job not found");
  const elapsed = Date.now() - job.started;
  let status: UploadJob["status"] = "uploaded";
  if (elapsed > 700) status = "extracting";
  if (elapsed > 2000) status = job.fail ? "failed" : "indexed";
  return {
    id: job.id,
    source_id: job.source_id,
    status,
    error: status === "failed" ? "Parser could not read the file (simulated failure)" : null,
    created_at: job.created_at,
  };
}

export function fxProposals(sourceId: string): Proposal[] {
  const job = [...state.jobs.values()].find((j) => j.source_id === sourceId);
  const demoId = job ? job.proposal : sourceId;
  return proposals.filter((p) => p.source_id === demoId);
}

export function fxConfirm(sourceId: string, payload: unknown) {
  void payload;
  return { source_id: sourceId, accepted: true, persisted: false };
}

// ---------- ask ----------
export function fxAsk(question: string, asOf: string): AskAnswer {
  const q = question.toLowerCase();
  const rule = ask.rules.find((r) => isAvailable(r.available_at, asOf) && r.match.some((m) => q.includes(m)));
  return rule
    ? { question, answer: rule.answer, citations: rule.citations, as_of: asOf }
    : { question, answer: ask.fallback, citations: [], as_of: asOf };
}

// ---------- drafts ----------
const visibleVersions = (d: Draft, asOf: string) => d.versions.filter((v) => isAvailable(v.created_at, asOf));

export function fxDrafts(asOf: string): DraftSummary[] {
  return state.drafts
    .filter((d) => isAvailable(d.created_at, asOf))
    .map((d) => {
      const vs = visibleVersions(d, asOf);
      const v = vs.at(-1)!;
      return {
        id: d.id,
        type: d.type,
        title: d.title,
        latest_version: v.version,
        status: v.status,
        open_gaps: v.gaps.filter((g) => !g.resolution).length,
        updated_at: v.created_at,
      };
    })
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export function fxDraft(id: string, asOf: string): Draft {
  const d = state.drafts.find((x) => x.id === id);
  if (!d || !isAvailable(d.created_at, asOf)) throw new FixtureError(404, "Draft not available at this time");
  return clone({ ...d, versions: visibleVersions(d, asOf) });
}

const TEMPLATES: Record<NoticeType, { title: string; body: string; gaps: Omit<Gap, "id" | "resolution">[] }> = {
  delay: {
    title: "Delay notice",
    body: "Contract reference: [MISSING: contract reference]\nApplicable clause: [MISSING: relevant contract clause]\n\n## Subject: [MISSING: affected activity]\n\nDear Project Manager,\n\nWe give notice of a delay to [MISSING: affected activity]. [MISSING: cause and date from project evidence]\n\nSam Reed\nSite Manager",
    gaps: [
      { marker: "[MISSING: contract reference]", kind: "missing", label: "Contract reference" },
      { marker: "[MISSING: relevant contract clause]", kind: "missing", label: "Contract clause" },
      { marker: "[MISSING: affected activity]", kind: "missing", label: "Affected activity" },
      { marker: "[MISSING: cause and date from project evidence]", kind: "missing", label: "Cause and date" },
    ],
  },
  additional_cost: {
    title: "Additional cost notice",
    body: "Contract reference: [MISSING: contract reference]\nApplicable clause: [MISSING: relevant contract clause]\n\n## Subject: Notice of additional cost\n\nDear Project Manager,\n\nWe notify you of additional cost arising from [MISSING: event]. Quantities affected: [UNVERIFIED: quantity]. No amount is stated because the project record has no rate table. [MISSING: rate table]\n\nSam Reed\nSite Manager",
    gaps: [
      { marker: "[MISSING: contract reference]", kind: "missing", label: "Contract reference" },
      { marker: "[MISSING: relevant contract clause]", kind: "missing", label: "Contract clause" },
      { marker: "[MISSING: event]", kind: "missing", label: "Event" },
      { marker: "[UNVERIFIED: quantity]", kind: "unverified", label: "Quantity" },
      { marker: "[MISSING: rate table]", kind: "missing", label: "Rate table" },
    ],
  },
  defect: {
    title: "Defect notice",
    body: "Contract reference: [MISSING: contract reference]\n\n## Subject: Notice of defect\n\nDear Project Manager,\n\nA defect was observed at [MISSING: location]. Measured extent: [UNVERIFIED: width or extent]. An engineering assessment is [MISSING: assessment status].\n\nSam Reed\nSite Manager",
    gaps: [
      { marker: "[MISSING: contract reference]", kind: "missing", label: "Contract reference" },
      { marker: "[MISSING: location]", kind: "missing", label: "Location" },
      { marker: "[UNVERIFIED: width or extent]", kind: "unverified", label: "Extent" },
      { marker: "[MISSING: assessment status]", kind: "missing", label: "Assessment status" },
    ],
  },
  concern: {
    title: "Letter of concern",
    body: "## Subject: [MISSING: subject]\n\nDear Project Manager,\n\nWe wish to raise a concern about [MISSING: matter of concern].\n\nSam Reed\nSite Manager",
    gaps: [
      { marker: "[MISSING: subject]", kind: "missing", label: "Subject" },
      { marker: "[MISSING: matter of concern]", kind: "missing", label: "Matter of concern" },
    ],
  },
};

export function fxCreateDraft(
  input: { type: NoticeType; keywords?: string | null; alert_id?: string | null; incident_id?: string | null },
  asOf: string,
): Draft {
  // One draft per alert and notice type, as the backend will enforce.
  const existing = state.drafts.find((d) => input.alert_id && d.alert_id === input.alert_id && d.type === input.type);
  if (existing) return fxDraft(existing.id, asOf);
  const t = TEMPLATES[input.type];
  const id = `DRF-${state.drafts.length + 1}`;
  const draft: Draft = {
    id,
    project_id: project.id,
    type: input.type,
    title: input.keywords ? `${t.title}: ${input.keywords}` : t.title,
    keywords: input.keywords ?? null,
    alert_id: input.alert_id ?? null,
    incident_id: input.incident_id ?? null,
    created_at: asOf,
    versions: [
      {
        id: `${id}-v1`,
        version: 1,
        as_of: asOf,
        created_at: asOf,
        created_by: "SiteMate (template, fixture)",
        status: "draft",
        body: `DRAFT FOR SITE MANAGER REVIEW\nFrom: ${project.sender.name}\nTo: ${project.recipient.name}\n${t.body}`,
        evidence_refs: [],
        gaps: t.gaps.map((g, i) => ({ ...g, id: `gap-${i + 1}`, resolution: null })),
        assumptions: input.keywords ? [`Started from keywords: "${input.keywords}". No evidence has been retrieved yet.`] : [],
        reviews: [],
        exports: [],
      },
    ],
  };
  state.drafts.push(draft);
  return clone(draft);
}

function mustDraft(id: string) {
  const d = state.drafts.find((x) => x.id === id);
  if (!d) throw new FixtureError(404, "Draft not found");
  return d;
}

export function fxSaveVersion(
  id: string,
  input: { body: string; gaps: Gap[]; base_version: number; author: string },
  asOf: string,
): Draft {
  const d = mustDraft(id);
  const last = d.versions.at(-1)!;
  if (input.base_version !== last.version)
    throw new FixtureError(409, `Version ${last.version} was saved since you started editing. Reload first.`);
  const next: DraftVersion = {
    ...clone(last),
    id: `${d.id}-v${last.version + 1}`,
    version: last.version + 1,
    as_of: asOf,
    created_at: asOf,
    created_by: input.author,
    status: "draft",
    body: input.body,
    gaps: input.gaps,
    reviews: [],
    exports: [],
  };
  d.versions.push(next);
  return fxDraft(id, asOf);
}

export function fxReview(
  id: string,
  version: number,
  input: { decision: "submitted" | "approved" | "changes_requested"; reason?: string | null; role: Role; reviewer: string },
  asOf: string,
): Draft {
  const d = mustDraft(id);
  const v = d.versions.find((x) => x.version === version);
  if (!v) throw new FixtureError(404, "Version not found");
  if (version !== d.versions.at(-1)!.version) throw new FixtureError(409, "Only the latest version can be reviewed");
  const open = v.gaps.some((g) => !g.resolution) || /\[(MISSING|UNVERIFIED):/.test(v.body);

  if (input.decision === "submitted") {
    if (v.status !== "draft" && v.status !== "changes_requested")
      throw new FixtureError(409, "Only a draft version can be submitted");
    v.status = "in_review";
  } else {
    if (input.role !== "approver") throw new FixtureError(403, "Only an approver can review a version");
    if (v.status !== "in_review") throw new FixtureError(409, "Submit the version for review first");
    if (input.decision === "approved") {
      if (open) throw new FixtureError(409, "Resolve or omit every gap before approval");
      v.status = "approved";
    } else {
      if (!input.reason?.trim()) throw new FixtureError(422, "A reason is required to request changes");
      v.status = "changes_requested";
    }
  }
  v.reviews.push({ decision: input.decision, reason: input.reason ?? null, reviewer: input.reviewer, decided_at: asOf });
  return fxDraft(id, asOf);
}

export async function fxExport(id: string, version: number, format: Export["format"], role: Role, asOf: string) {
  const d = mustDraft(id);
  const v = d.versions.find((x) => x.version === version);
  if (!v) throw new FixtureError(404, "Version not found");
  if (v.status !== "approved") throw new FixtureError(409, "Only an approved version can be exported");
  if (role !== "approver") throw new FixtureError(403, "Only an approver can export");
  const bytes = new TextEncoder().encode(v.body);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const digest = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
  // Fixture stand-in: the exact approved wording as plain text. The backend will render PDF / DOCX.
  const url = URL.createObjectURL(new Blob([v.body], { type: "text/plain" }));
  const exp: Export = { format, url, digest, created_at: asOf };
  v.exports.push(exp);
  return exp;
}
