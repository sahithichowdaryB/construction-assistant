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
export type Severity = "none" | "medium" | "high";
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
  | "diary";

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
}

export interface Passage {
  id: string;
  source_id: string;
  locator: string;
  text: string;
  page: number | null;
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

export type IncidentStatus = "pending_confirmation" | "open" | "resolved";

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
}

export interface AlertCalculation {
  planned: number;
  actual: number | null;
  shortfall_pct: number | null;
  unit: string;
}

/** GET /projects/{pid}/alerts item. Matches backend/main.py. */
export interface Alert {
  id: string;
  activity_code: string;
  kind: "shortfall" | "missing_report" | string;
  checkpoint_at: IsoInstant;
  version: number;
  as_of: IsoInstant;
  severity: Severity;
  calculation: AlertCalculation | null;
  evidence_refs: EvidenceRef[];
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
}

export interface SourceSummary {
  source_id: string;
  title: string;
  observations: { text: string; refs: EvidenceRef[] }[];
  decisions: { text: string; refs: EvidenceRef[] }[];
  open_actions: { text: string; owner: string | null; due: IsoInstant | null; refs: EvidenceRef[] }[];
  evidence_ids: string[];
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

export interface IncidentAnalysis {
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
}
