/**
 * Domain types for SiteMate. They mirror plan/SiteMate-architecture.puml (04_domain) and the
 * JSON the FastAPI backend returns today. Fields the backend owns are never computed in the UI.
 */

/** ISO-8601 instant with a UTC offset, e.g. 2026-11-10T10:15:00+01:00 */
export type IsoInstant = string;
/** Project-local calendar date, YYYY-MM-DD */
export type LocalDate = string;

export type Role = "foreman" | "site_manager" | "approver";

/** The backend stores the diary estimate as "estimated"; the domain model calls it provisional. */
export type Basis = "signed" | "provisional" | "estimated" | "forecast";
/** Shortfall alerts use none|medium|high; incident alerts use low|medium|high|critical. */
export type Severity = "none" | "low" | "medium" | "high" | "critical";
export type Provenance = "verified" | "inferred" | "missing";
export type ReviewStatus = "proposed" | "accepted" | "rejected" | "superseded";

export interface Party {
  name: string;
  address: string | null;
}

export interface Project {
  id: string;
  name: string;
  timezone: string;
  thresholds: {
    /** An alert is raised when the signed shortfall is above this percentage */
    deviation_pct: number;
    /** Severity becomes high above this percentage */
    high_above_pct: number;
  };
  sender: Party;
  recipient: Party;
  contract_reference: string | null;
  contract_clause: string | null;
  rate_table: string | null;
  calendar_note: string | null;
}

export type SourceType =
  | "schedule"
  | "register"
  | "project"
  | "email"
  | "minutes"
  | "daily_report"
  | "voice"
  | "photo"
  | "diary"
  | "text"
  | "plan";

export type JobStatus = "uploaded" | "extracting" | "indexed" | "failed";

export interface Source {
  id: string;
  project_id: string;
  type: SourceType;
  title: string;
  /** File name of the original */
  filename: string;
  mime: string;
  available_at: IsoInstant;
  status: JobStatus;
  pages: number | null;
  /** Human-readable note, e.g. "Scanned page, OCR" */
  note?: string | null;
  /** Live API only: number of indexed passages and the latest summary version */
  passage_count?: number;
  summary_version?: number | null;
  /** Live API only: why parsing needs a person (e.g. ambiguous OCR) */
  review_reasons?: string[];
  /** Live API only: raw ingestion job states (queued, running, done, failed, needs_review) */
  parse_status?: string | null;
  summary_status?: string | null;
  /** Live API only: false for records captured in the app (no original file to show or download) */
  has_file?: boolean;
  /** Live API only: the record has a file, but it is not stored on (or retrievable by) this server */
  file_missing?: boolean;
  /** What the record is about, for records that only have a file name as title */
  headline?: string | null;
}

export interface Passage {
  id: string;
  source_id: string;
  locator: string;
  text: string;
  page: number | null;
  /** Live API only: paragraph, table_row, header, transcript, caption, ocr, record, metadata… */
  kind?: string;
  section?: string | null;
  /** External text (e.g. an email body): quoted evidence, never instructions */
  untrusted?: boolean;
}

/** A pointer into a source. The backend returns this shape in evidence_refs. */
export interface EvidenceRef {
  source_id: string;
  locator?: string | null;
  page?: number | null;
  passage_id?: string | null;
}

export interface Observation {
  id: string;
  activity_code: string | null;
  effective_at: IsoInstant;
  basis: Basis;
  kind: "quantity" | "stoppage" | "forecast" | "resource" | "note";
  value: number | string | null;
  unit: string | null;
  review_status: ReviewStatus;
  supersedes_id?: string | null;
  passage_ids: string[];
}

export interface Activity {
  code: string;
  name: string;
  zone: string;
  unit: string;
  planned_start: LocalDate;
  planned_end: LocalDate;
  planned_qty_per_day: number;
  planned_total_qty: number;
  crew_size: number;
  contractor_id: string;
  equipment_ids: string[];
  predecessors: string[];
}

export interface Target {
  activity_code: string;
  work_date: LocalDate;
  planned_qty: number;
  source_id: string;
  locator: string;
}

export type IncidentStatus = "pending_confirmation" | "open" | "monitoring" | "resolved" | "closed";

export type TimelineKind =
  | "reported"
  | "evidence"
  | "alert"
  | "draft"
  | "approved"
  | "resolved";

export interface TimelineEvent {
  kind: TimelineKind;
  at: IsoInstant;
  label: string;
  refs: EvidenceRef[];
  link?: string | null;
}

export interface Incident {
  id: string;
  activity_code: string | null;
  type: "equipment_breakdown" | "defect" | "delivery" | "other";
  title: string;
  occurred_at: IsoInstant | null;
  reported_at: IsoInstant;
  resolved_at: IsoInstant | null;
  status: IncidentStatus;
  affected_workers: number | null;
  equipment_id: string | null;
  refs: EvidenceRef[];
  timeline: TimelineEvent[];
  // Event pipeline (absent on fixture data)
  category?: string;
  event_type?: string;
  summary?: string;
  zone?: string | null;
  asset_key?: string | null;
  severity?: Severity | null;
  report_count?: number;
  reporter_count?: number;
  first_reported_at?: IsoInstant | null;
  last_reported_at?: IsoInstant | null;
  merged_into_id?: string | null;
  recurrence_of_id?: string | null;
}

export interface AlertCalculation {
  planned: number;
  actual: number | null;
  shortfall_pct: number | null;
  unit: string;
}

/** GET /projects/{pid}/alerts item. Matches backend/main.py. */
export type AlertStatus = "open" | "acknowledged" | "in_progress" | "resolved" | "dismissed";

export interface Alert {
  id: string;
  /** Null for incident alerts that are not tied to a schedule activity */
  activity_code: string | null;
  kind: "shortfall" | "missing_report" | "incident" | string;
  checkpoint_at: IsoInstant;
  version: number;
  as_of: IsoInstant;
  severity: Severity;
  calculation: AlertCalculation | null;
  evidence_refs: EvidenceRef[];
  // Event pipeline (absent on fixture data)
  status?: AlertStatus;
  title?: string | null;
  assigned_to?: string | null;
  incident_id?: string | null;
  reason?: string | null;
  analysis_id?: string | null;
  category?: string | null;
  report_count?: number | null;
  reporter_count?: number | null;
  incident_status?: IncidentStatus | null;
  zone?: string | null;
  asset_key?: string | null;
}

/** One stored revision of an alert (domain model). */
export interface AlertRevision {
  alert_id: string;
  version: number;
  as_of: IsoInstant;
  severity: Severity;
  calculation: AlertCalculation | null;
  evidence_refs: EvidenceRef[];
}

/** Planned context for the alert detail screen (causes, successors). Fixture-only for now. */
export interface AlertContext {
  activity_code: string;
  work_date: LocalDate;
  likely_causes: { text: string; refs: EvidenceRef[] }[];
  successors_at_risk: { code: string; name: string; planned_start: LocalDate; refs: EvidenceRef[] }[];
  incident_id: string | null;
  draft_id: string | null;
}

/** GET /projects/{pid}/activities/{code}/progress. Matches backend/main.py. */
export interface ProgressObservation {
  quantity: number;
  basis: Basis;
  source_id: string;
  locator: string;
  page: number | null;
  excerpt: string | null;
  available_at: IsoInstant;
}

export interface Progress {
  activity_code: string;
  work_date: LocalDate;
  unit: string;
  planned: number;
  actual: number | null;
  basis: Basis | null;
  shortfall_pct: number | null;
  severity: Severity | null;
  plan_evidence: { source_id: string; locator: string };
  evidence: { source_id: string; page: number | null; locator: string } | null;
  observations: ProgressObservation[];
}

export type NoticeType = "delay" | "additional_cost" | "defect" | "concern";
export type DraftStatus = "draft" | "in_review" | "changes_requested" | "approved";

export interface Gap {
  id: string;
  /** Exactly as it appears in the body, e.g. "[MISSING: contract reference]" */
  marker: string;
  kind: "missing" | "unverified";
  label: string;
  resolution: { action: "filled" | "omitted"; value: string; by: string; at: IsoInstant } | null;
}

export interface CitedSource {
  /** The number used in the body, e.g. 1 for "[1]" */
  n: number;
  ref: EvidenceRef;
  label: string;
}

export interface Review {
  decision: "approved" | "changes_requested" | "submitted";
  reason: string | null;
  reviewer: string;
  decided_at: IsoInstant;
}

export interface Export {
  format: "pdf" | "docx";
  url: string;
  digest: string;
  created_at: IsoInstant;
}

export interface DraftVersion {
  id: string;
  version: number;
  as_of: IsoInstant;
  created_at: IsoInstant;
  created_by: string;
  status: DraftStatus;
  body: string;
  evidence_refs: CitedSource[];
  gaps: Gap[];
  assumptions: string[];
  reviews: Review[];
  exports: Export[];
}

export interface Draft {
  id: string;
  project_id: string;
  type: NoticeType;
  title: string;
  keywords: string | null;
  incident_id?: string | null;
  alert_id?: string | null;
  created_at: IsoInstant;
  versions: DraftVersion[];
}

export interface DraftSummary {
  id: string;
  type: NoticeType;
  title: string;
  latest_version: number;
  status: DraftStatus;
  open_gaps: number;
  updated_at: IsoInstant;
}

export interface ProposalField {
  key: string;
  label: string;
  value: string | number | null;
  unit?: string | null;
  provenance: Provenance;
  source_ref: EvidenceRef | null;
  note?: string | null;
}

export interface Proposal {
  source_id: string;
  transcript: string;
  kind: "incident" | "forecast" | "duplicate";
  basis: Basis;
  fields: ProposalField[];
  follow_up_questions: { id: string; question: string }[];
  duplicate_of: { incident_id: string; title: string; reason: string } | null;
  /** Non-duplicate link, e.g. a forecast that attaches to an existing incident */
  related_incident: { incident_id: string; title: string } | null;
}

export interface UploadJob {
  id: string;
  source_id: string;
  status: JobStatus;
  error: string | null;
  created_at: IsoInstant;
  /** Live API only: reasons a parsed document needs review */
  review_reasons?: string[];
  /** Live API only: the same file was already uploaded under this source id */
  duplicate?: boolean;
  /** Live API only: when the uploaded document counts as received (the real upload time) */
  available_at?: IsoInstant;
}

export interface SourceSummary {
  source_id: string;
  title: string;
  observations: { text: string; refs: EvidenceRef[] }[];
  decisions: { text: string; refs: EvidenceRef[] }[];
  open_actions: { text: string; owner: string | null; due: IsoInstant | null; quote?: string | null; refs: EvidenceRef[] }[];
  evidence_ids: string[];
  /** Live API only */
  headline?: string | null;
  provisional?: { text: string; refs: EvidenceRef[] }[];
  /** Instruction-like text found in the source; shown as quoted evidence and never acted on */
  quoted_external_instructions?: { text: string; refs: EvidenceRef[] }[];
  version?: number;
  model?: string | null;
}

/** GET /projects/{pid}/sources/{sid}/readings: quantities read from a daily report. */
export interface ReportReading {
  activity_code: string;
  work_date: LocalDate;
  value: number;
  unit: string;
  basis: Basis;
  locator: string;
  page: number | null;
  planned_on_report: number | null;
  /** accepted = already an observation with the same value; conflict = stored value differs */
  review_status: "proposed" | "accepted" | "conflict";
  accepted_value: number | null;
  ref: EvidenceRef;
}

export interface ReportReadings {
  source_id: string;
  job_status: string;
  review_reasons: string[];
  readings: ReportReading[];
}

/** GET /projects/{pid}/sources/{sid}/storage: where the original and everything derived from it is stored. */
export interface SourceStorage {
  source_id: string;
  file: {
    location: string;
    path: string;
    sha256: string | null;
    size_bytes: number | null;
    mime: string;
    available: boolean;
  };
  /** Every row (all columns) that each table holds for this source */
  tables: {
    table: string;
    stores: string;
    columns: string[];
    rows: unknown[][];
    row_count: number;
    truncated: boolean;
  }[];
}

/** A block of a structured preview; `locator` matches the passage parsed from the same text. */
export interface PreviewBlock {
  type: "title" | "heading" | "paragraph" | "list" | "table";
  text?: string;
  level?: number | null;
  locator?: string | null;
  rows?: string[][];
  locators?: string[];
  /** Email paragraph that looks like an instruction to the reader (quoted, never acted on) */
  flagged?: boolean;
}

/** GET /projects/{pid}/sources/{sid}/preview: originals a browser cannot render inline. */
export type SourcePreview =
  | { source_id: string; kind: "document"; blocks: PreviewBlock[] }
  | { source_id: string; kind: "email"; headers: { name: string; value: string }[]; attachments: string[]; blocks: PreviewBlock[] }
  | { source_id: string; kind: "table"; columns: string[]; rows: string[][]; row_count: number; truncated: boolean }
  | { source_id: string; kind: "text"; text: string; language?: string };

/** GET /projects/{pid}/search item */
export interface SearchResult {
  passage_id: string;
  source_id: string;
  locator: string;
  page: number | null;
  excerpt: string;
  kind: string;
  section: string | null;
  untrusted: boolean;
  source_kind: SourceType;
  source_title: string | null;
  available_at: IsoInstant;
  score: number;
  ref: EvidenceRef;
}

export interface SearchResponse {
  query: string;
  reranked: boolean;
  results: SearchResult[];
}

/** GET /projects/{pid}/action-items item. Owner and due date only when the source records them. */
export interface ActionItem {
  id: string;
  description: string;
  owner_name: string | null;
  due_at: IsoInstant | null;
  completed_at: IsoInstant | null;
  quote: string | null;
  source_id: string;
  source_type: SourceType;
  source_title: string | null;
  available_at: IsoInstant;
  overdue: boolean;
  ref: EvidenceRef;
}

export interface TodayActivity {
  code: string;
  name: string;
  zone: string;
  unit: string;
  planned: number;
  actual: number | null;
  basis: Basis | null;
  /** Only shown when the server supplies it */
  shortfall_pct: number | null;
  severity: Severity | null;
  plan_ref: EvidenceRef;
  actual_ref: EvidenceRef | null;
}

export interface TodayBriefing {
  as_of: IsoInstant;
  work_date: LocalDate;
  briefing: { headline: string; bullets: { text: string; refs: EvidenceRef[] }[] };
  activities: TodayActivity[];
  open_alerts: Alert[];
  open_incidents: Incident[];
  drafts_awaiting_review: DraftSummary[];
}

export interface AskAnswer {
  question: string;
  answer: string;
  citations: { n: number; ref: EvidenceRef; label: string }[];
  as_of: IsoInstant;
}

export interface HealthStatus {
  mode: "fixtures" | "live";
  api: "connected" | "unreachable" | "error";
  database: string | null;
  detail: string | null;
}

// ---------- incident cause analysis (ai-agent) ----------
export type AnalysisStatus = "established" | "probable" | "unconfirmed" | "undetermined" | "needs_review";
export type AuthorRole =
  | "site_supervisor"
  | "foreman"
  | "signed_report"
  | "contractor_internal"
  | "external"
  | "client"
  | "system"
  | "unknown";

export interface AnalysisEvidence {
  source_id: string;
  locator: string;
  quote: string;
  author_role: AuthorRole;
  stance: "states_cause" | "speculates" | "context_only" | "contradicts";
  weight: number;
  stated_at: IsoInstant | null;
  hypothesis_id?: string | null;
}

export interface AnalysisHypothesis {
  id: string;
  statement: string;
  level: "proximate" | "root";
  /** Advisory score computed by code from who said it */
  score: number;
  /** True for the cause the LLM chose */
  llm_selected: boolean;
}

export interface AnalysisScoreCard {
  hypothesis_id: string;
  score: number;
  supervisor_backed: boolean;
  external_only: boolean;
  independent_sources: number;
  contradicted_by_supervisor: boolean;
  flags: string[];
}

export interface IncidentReasoning {
  id: string;
  version: number;
  as_of: IsoInstant;
  status: AnalysisStatus;
  /** The LLM's final confidence (0-1) that headline_cause is the real cause */
  confidence: number;
  headline_cause: string | null;
  reasoning: string;
  hypotheses: AnalysisHypothesis[];
  score_cards: AnalysisScoreCard[];
  factual_evidence: AnalysisEvidence[];
  external_claims: AnalysisEvidence[];
  gaps: string[];
  guardrail_flags: string[];
  model: string;
  created_at: IsoInstant;
  stale?: boolean;
}

// ---------- event pipeline ----------
export interface EventTypeInfo {
  key: string;
  label: string;
  severity_hint: Severity | null;
}

export interface EventCategory {
  key: string;
  label: string;
  description: string;
  icon: string | null;
  creates_incident: boolean;
  default_severity: Severity | null;
  sort_order: number;
  types: EventTypeInfo[];
}

export type LinkType = "origin" | "corroborating" | "update" | "resolution" | "contradicting";

/** One report (event) that is a source of an incident: GET /incidents/{id}/events */
export interface IncidentEventLink {
  id: string;
  summary: string;
  category: string;
  event_type: string;
  zone: string | null;
  recorded_by: string;
  occurred_at: IsoInstant;
  recorded_at: IsoInstant;
  source_id: string;
  locator: string;
  suggested_category: string | null;
  suggestion_confidence: number | null;
  suggestion_rationale: string | null;
  link_type: LinkType;
  match_score: number | null;
  match_reason: string | null;
  linked_by: string;
  linked_at: IsoInstant;
  unlinked_at: IsoInstant | null;
  channel: "voice" | "photo" | "text" | "mixed";
  attachments: { id: string; kind: string; mime: string | null; url: string }[];
}

export type ActionType =
  | "assign_owner" | "notify_contractor" | "schedule_repair" | "stop_work" | "isolate_area"
  | "request_evidence" | "draft_notice" | "create_rfi" | "resolve_incident";
export type ActionStatus = "proposed" | "approved" | "in_progress" | "done" | "rejected" | "superseded";

export interface RecommendedAction {
  id: string;
  action_type: ActionType;
  title: string;
  rationale: string | null;
  owner_role: string | null;
  contractor_id: string | null;
  priority: "low" | "medium" | "high" | "urgent" | null;
  due_at: IsoInstant | null;
  status: ActionStatus;
  proposed_by: string;
  decided_by: string | null;
  decided_at: IsoInstant | null;
  executed_at: IsoInstant | null;
  result: Record<string, unknown> | null;
  evidence_refs: EvidenceRef[];
  incident_id: string | null;
}

export interface AlertActivity {
  id: string;
  actor: string;
  action: string;
  from_status: string | null;
  to_status: string | null;
  note: string | null;
  at: IsoInstant;
}

/** GET /alerts/{id} */
export interface AlertDetail {
  id: string;
  status: AlertStatus;
  kind: string;
  title: string | null;
  incident_id: string | null;
  assigned_to: string | null;
  incident: {
    id: string; category: string; event_type: string; summary: string; zone: string | null; asset_key: string | null;
    status: IncidentStatus; severity: Severity | null; report_count: number; reporter_count: number;
    first_reported_at: IsoInstant | null; last_reported_at: IsoInstant | null;
  } | null;
  analysis: {
    id: string; version: number; as_of: IsoInstant; status: AnalysisStatus; confidence: number;
    headline_cause: string | null; reasoning: string; gaps: string[];
  } | null;
  revisions: { version: number; as_of: IsoInstant; severity: Severity; reason: string | null; analysis_id: string | null }[];
  activity: AlertActivity[];
  actions: RecommendedAction[];
}

export interface CapturePrompt {
  id: string;
  title: string;
  rationale: string | null;
  owner_role: string | null;
  incident_id: string | null;
  incident_title: string | null;
  decided_at: IsoInstant | null;
}

// ---------- daily recaps (story format) ----------
export type RecapMood = "on_plan" | "minor" | "disrupted" | "weather";
export type RecapChapter = "overview" | "wins" | "problems" | "decisions" | "today";
export type RecapTone = "good" | "warn" | "bad" | "info" | "neutral";
export type RecapCover = "excavation" | "breakdown" | "steel" | "concrete" | "rain" | "formwork" | "meeting" | "crack";

export interface RecapStat {
  value: string;
  unit?: string | null;
  label: string;
  tone?: RecapTone;
}

export interface RecapStripSegment {
  from: string; // "07:00"
  to: string;
  state: "working" | "stopped" | "rain" | "idle";
  label?: string | null;
}

export interface RecapCard {
  id: string;
  chapter: RecapChapter;
  title: string;
  kicker?: string | null;
  at?: IsoInstant | null;
  tone: RecapTone;
  cover?: RecapCover | null;
  stats?: RecapStat[];
  quote?: { text: string; who: string } | null;
  strip?: RecapStripSegment[] | null;
  strip_label?: string | null;
  done?: string[];
  refs: EvidenceRef[];
  action?: { label: string; href: string } | null;
}

export interface DayRecap {
  work_date: string; // project-local YYYY-MM-DD
  available_at: IsoInstant;
  /** The current day, still in progress: rebuilt on every read ("Today so far"). */
  live?: boolean;
  mood: RecapMood;
  mood_label: string;
  short_label: string;
  cover: RecapCover;
  inputs: { voice: number; photo: number; document: number; report: number };
  cards: RecapCard[];
}
