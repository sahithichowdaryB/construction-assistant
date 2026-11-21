"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  BadgeCheck,
  CircleHelp,
  FileSearch,
  HelpCircle,
  Loader2,
  Quote,
  RefreshCw,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { CitationChip } from "@/components/citation-chip";
import { GatedButton } from "@/components/gated-button";
import { useApp } from "@/components/providers/app-context";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiError } from "@/lib/api";
import { USE_FIXTURES } from "@/lib/endpoints";
import { useIncidentReasoning, useRunReasoning } from "@/lib/queries";
import { can, denyReason } from "@/lib/roles";
import { fmtDateTime } from "@/lib/time";
import type { AnalysisEvidence, AnalysisStatus, AuthorRole, IncidentReasoning } from "@/lib/types";
import { cn } from "@/lib/utils";

// ---------- plain-language labels ----------

const STATUS: Record<AnalysisStatus, { label: string; summary: string; cls: string; Icon: typeof BadgeCheck }> = {
  established: {
    label: "Confirmed",
    summary: "Site staff stated this first-hand and nothing in the records contradicts it.",
    cls: "border-emerald-300 bg-emerald-50 text-emerald-800",
    Icon: BadgeCheck,
  },
  probable: {
    label: "Likely",
    summary: "The records support this, but some questions remain open.",
    cls: "border-sky-300 bg-sky-50 text-sky-800",
    Icon: BadgeCheck,
  },
  unconfirmed: {
    label: "Not confirmed",
    summary: "Only weak or outside-party evidence points to this. Treat it as a lead, not a finding.",
    cls: "border-amber-300 bg-amber-50 text-amber-900",
    Icon: CircleHelp,
  },
  undetermined: {
    label: "Cause not recorded",
    summary: "No record says why this happened. Ask the foreman or site manager to add a note.",
    cls: "border-border bg-muted text-foreground",
    Icon: HelpCircle,
  },
  needs_review: {
    label: "Needs a person to review",
    summary: "The automatic check could not verify this result. Please review the sources below.",
    cls: "border-red-300 bg-red-50 text-red-800",
    Icon: ShieldAlert,
  },
};

const ROLE_LABEL: Record<AuthorRole, string> = {
  site_supervisor: "Site manager",
  foreman: "Foreman",
  signed_report: "Signed report",
  contractor_internal: "Contractor",
  external: "Outside party",
  client: "Client",
  system: "Project record",
  unknown: "Author unknown",
};
const SITE_SIDE: AuthorRole[] = ["site_supervisor", "foreman", "signed_report"];

const STANCE_LABEL: Partial<Record<AnalysisEvidence["stance"], string>> = {
  context_only: "Background only",
  speculates: "Unverified guess",
  contradicts: "Disagrees",
};

/** Known automatic-check notes in plain words; anything else is shown with underscores removed. */
function plainFlag(flag: string): string {
  if (flag.startsWith("dropped_claim")) return "Some statements could not be matched to the source text and were left out.";
  if (flag.startsWith("validation")) return "The automatic check flagged this result. Please review it before relying on it.";
  const known: Record<string, string> = {
    established_without_supervisor_evidence: "Marked as confirmed, but no site-staff statement backs it.",
    external_only_but_high_confidence: "Rated highly, yet only outside parties support it.",
    selected_hypothesis_contradicted_by_supervisor: "A site supervisor's statement disagrees with this cause.",
    undetermined_but_high_confidence: "No cause was found, but the confidence is unusually high.",
  };
  return known[flag] ?? flag.replaceAll("_", " ");
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

function sureness(value: number): { word: string; bar: string } {
  if (value >= 0.75) return { word: "High", bar: "bg-emerald-600" };
  if (value >= 0.45) return { word: "Medium", bar: "bg-sky-600" };
  if (value >= 0.2) return { word: "Low", bar: "bg-amber-500" };
  return { word: "Very low", bar: "bg-slate-400" };
}

// ---------- loading state ----------

const STEPS = ["Reading the site records", "Checking who said what", "Weighing the possible causes", "Writing the summary"];

/** Replaces the previous answer while the agent runs, so nobody reads a stale result by mistake. */
function ReasoningProgress() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setStep((n) => Math.min(n + 1, STEPS.length - 1)), 4500);
    return () => clearInterval(timer);
  }, []);
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-5 py-2">
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-full bg-sky-50 text-sky-700">
          <Loader2 className="size-5 animate-spin" aria-hidden />
        </span>
        <div>
          <p className="font-medium">{STEPS[step]}…</p>
          <p className="text-xs text-muted-foreground">Working out the cause from the records. This usually takes 15 to 30 seconds.</p>
        </div>
      </div>
      <ol className="grid grid-cols-4 gap-1.5" aria-label="Progress">
        {STEPS.map((s, i) => (
          <li key={s} className={cn("h-1.5 rounded-full transition-colors duration-500", i <= step ? "bg-sky-600" : "bg-muted")} />
        ))}
      </ol>
      <div className="flex animate-pulse flex-col gap-3" aria-hidden>
        <div className="h-5 w-24 rounded-md bg-muted" />
        <div className="h-7 w-3/4 rounded-md bg-muted" />
        <div className="h-4 w-full rounded bg-muted" />
        <div className="h-4 w-5/6 rounded bg-muted" />
        <div className="mt-2 h-20 w-full rounded-lg bg-muted" />
        <div className="h-20 w-full rounded-lg bg-muted" />
      </div>
    </div>
  );
}

// ---------- answer ----------

function Answer({ a }: { a: IncidentReasoning }) {
  const s = STATUS[a.status];
  const sure = sureness(a.confidence);
  return (
    <section aria-labelledby="answer-h" className="grid gap-5 rounded-xl border bg-card p-5 md:grid-cols-[minmax(0,1fr)_14rem]">
      <div className="flex flex-col gap-3">
        <h3 id="answer-h" className="sr-only">
          Answer
        </h3>
        <span className={cn("inline-flex w-fit items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium [&_svg]:size-4", s.cls)}>
          <s.Icon aria-hidden /> {s.label}
        </span>
        <p className="text-xl leading-snug font-semibold">{a.headline_cause ?? "The records do not say why this happened"}</p>
        <p className="text-sm text-muted-foreground">{s.summary}</p>
        <div className="rounded-lg bg-muted/60 p-3">
          <p className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">Summary</p>
          <p className="text-sm leading-relaxed">{a.reasoning}</p>
        </div>
      </div>
      <div
        className="flex flex-col justify-center gap-2 rounded-lg border p-4 md:items-stretch"
        role="img"
        aria-label={`Confidence ${pct(a.confidence)}, ${sure.word}`}
      >
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">How sure are we</p>
        <p className="text-3xl font-semibold tabular-nums">{pct(a.confidence)}</p>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div className={cn("h-full rounded-full transition-all", sure.bar)} style={{ width: pct(a.confidence) }} />
        </div>
        <p className="text-sm">
          <span className="font-medium">{sure.word}</span> confidence
        </p>
      </div>
    </section>
  );
}

function StillUnknown({ gaps }: { gaps: string[] }) {
  if (!gaps.length) return null;
  return (
    <section aria-labelledby="gap-h" className="rounded-xl border border-amber-200 bg-amber-50/60 p-5">
      <h3 id="gap-h" className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-950">
        <CircleHelp className="size-4" aria-hidden /> What we still don&apos;t know
      </h3>
      <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-amber-950/90">
        {gaps.map((g) => (
          <li key={g}>{g}</li>
        ))}
      </ul>
    </section>
  );
}

// ---------- sources ----------

function QuoteCard({ e, tone }: { e: AnalysisEvidence; tone: "fact" | "other" }) {
  const note = STANCE_LABEL[e.stance];
  return (
    <figure className={cn("rounded-lg border-l-4 p-3", tone === "fact" ? "border-emerald-500 bg-emerald-50/60" : "border-slate-300 bg-muted/50")}>
      <blockquote className="flex gap-2 text-sm">
        <Quote className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="whitespace-pre-wrap">“{e.quote}”</span>
      </blockquote>
      <figcaption className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span
          className={cn(
            "inline-flex items-center rounded-md border px-1.5 py-0.5 font-medium",
            SITE_SIDE.includes(e.author_role) ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-border bg-muted",
          )}
        >
          {ROLE_LABEL[e.author_role]}
        </span>
        <CitationChip refData={{ source_id: e.source_id }} />
        <span className="font-mono">{e.locator}</span>
        {e.stated_at && <span>said {fmtDateTime(e.stated_at)}</span>}
        {note && <span className="rounded border px-1">{note}</span>}
      </figcaption>
    </figure>
  );
}

function Sources({ a }: { a: IncidentReasoning }) {
  const total = a.factual_evidence.length + a.external_claims.length;
  return (
    <section aria-labelledby="src-h" className="flex flex-col gap-4 rounded-xl border p-5">
      <div>
        <h3 id="src-h" className="flex items-center gap-2 text-base font-semibold">
          Sources
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">{total}</span>
        </h3>
        <p className="text-xs text-muted-foreground">The exact words from the project records that this finding rests on. Select a source to open it.</p>
      </div>
      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-semibold">Where it was said</h4>
        {a.factual_evidence.length ? (
          a.factual_evidence.map((e) => <QuoteCard key={`${e.source_id}-${e.locator}-${e.quote}`} e={e} tone="fact" />)
        ) : (
          <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">No site-staff record states a cause.</p>
        )}
      </div>
      {a.external_claims.length > 0 && (
        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-semibold">Other statements</h4>
          <p className="-mt-1 text-xs text-muted-foreground">From outside parties, background or conflicting records. These were not treated as the cause.</p>
          {a.external_claims.map((e) => (
            <QuoteCard key={`${e.source_id}-${e.locator}-${e.quote}`} e={e} tone="other" />
          ))}
        </div>
      )}
    </section>
  );
}

// ---------- how it was worked out ----------

function HowWeGotHere({ a }: { a: IncidentReasoning }) {
  if (!a.hypotheses.length) return null;
  return (
    <details className="group rounded-xl border p-5">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-sm font-semibold marker:content-none">
        <span>How this was worked out</span>
        <span className="text-xs font-normal text-muted-foreground group-open:hidden">Show</span>
        <span className="hidden text-xs font-normal text-muted-foreground group-open:inline">Hide</span>
      </summary>
      <p className="mt-3 text-xs text-muted-foreground">
        Possible explanations found in the records. The bar shows how strong the evidence is, based on who said it. A foreman or site manager counts for more
        than an outside party. The final call is then made by the AI, which explains any difference.
      </p>
      <ul className="mt-3 flex flex-col gap-2">
        {a.hypotheses.map((h) => {
          const card = a.score_cards.find((c) => c.hypothesis_id === h.id);
          return (
            <li key={h.id} className={cn("rounded-lg border p-3", h.llm_selected && "border-emerald-400 bg-emerald-50/40")}>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{h.statement}</span>
                <span className="rounded border px-1 text-xs text-muted-foreground">{h.level === "root" ? "Underlying reason" : "Immediate cause"}</span>
                {h.llm_selected && <span className="rounded border border-emerald-300 bg-emerald-50 px-1 text-xs text-emerald-800">Chosen</span>}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-slate-500" style={{ width: pct(h.score) }} />
                </div>
                <span className="w-10 text-right text-xs tabular-nums">{pct(h.score)}</span>
              </div>
              {card && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {card.supervisor_backed ? "Backed by site staff" : card.external_only ? "Only outside parties" : "No one states this as a cause"} ·{" "}
                  {card.independent_sources} independent source{card.independent_sources === 1 ? "" : "s"}
                  {card.contradicted_by_supervisor ? " · a site supervisor disagrees" : ""}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

// ---------- the card ----------

export function IncidentReasoning({ incidentId }: { incidentId: string }) {
  const { role, projectId, asOf } = useApp();
  const reasoning = useIncidentReasoning(incidentId);
  const run = useRunReasoning(incidentId);
  const notYet = reasoning.isError && reasoning.error instanceof ApiError && reasoning.error.status === 404;
  const stale = !!reasoning.data?.stale;
  // The mutation stays pending until the refreshed result is loaded, so the old answer is never shown beside a new run.
  const busy = run.isPending;

  // Run automatically when nothing is saved for this incident and clock time, or the records changed since.
  // Once per incident + project + clock, so a failure never loops; the button remains for a manual re-run.
  const attempted = useRef(new Set<string>());
  useEffect(() => {
    if (USE_FIXTURES || run.isPending || !(notYet || stale) || !can(role, "run_reasoning")) return;
    const key = `${projectId}|${incidentId}|${asOf}`;
    if (attempted.current.has(key)) return;
    attempted.current.add(key);
    run.mutate();
  }, [notYet, stale, role, projectId, incidentId, asOf, run]);

  if (USE_FIXTURES) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileSearch className="size-4" aria-hidden /> Why did this happen?
          </CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyState
            icon={<FileSearch />}
            title="Needs the live API"
            description="The cause analysis is produced by the backend from the project database and the AI model. Set NEXT_PUBLIC_USE_FIXTURES=false in frontend/.env.local and restart."
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg">
              <FileSearch className="size-5" aria-hidden /> Why did this happen?
            </CardTitle>
            <p className="mt-1 max-w-prose text-sm text-muted-foreground">
              What the project records say caused this incident, who said it, and how sure we are. Statements from the foreman and site manager count for more
              than outside parties.
            </p>
          </div>
          <GatedButton
            size="sm"
            variant="outline"
            reason={denyReason(role, "run_reasoning")}
            disabled={busy}
            onClick={() => run.mutate()}
          >
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
            {busy ? "Re-checking…" : notYet ? "Find the cause" : "Re-check"}
          </GatedButton>
        </div>
        {!busy && run.isSuccess && (
          <p role="status" className="text-xs text-muted-foreground">
            {run.data.reused ? `Checked again just now: nothing changed, still version ${run.data.version}.` : `Updated just now (version ${run.data.version}).`}
          </p>
        )}
        {!busy && stale && !can(role, "run_reasoning") && (
          <p role="status" className="text-xs text-amber-800">
            New records have arrived since this was produced. A site manager or approver can re-check it.
          </p>
        )}
        {run.isError && !busy && <ErrorState error={run.error} onRetry={() => run.mutate()} />}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {busy ? (
          <ReasoningProgress />
        ) : (
          <>
            {reasoning.isPending && <LoadingSkeleton variant="detail" rows={2} />}
            {notYet && (
              <EmptyState
                icon={<FileSearch />}
                title="No analysis yet"
                description="The cause hasn't been worked out for this incident at this time. A site manager or approver can run it."
              />
            )}
            {reasoning.isError && !notYet && <ErrorState error={reasoning.error} onRetry={() => void reasoning.refetch()} />}
            {reasoning.data && <Result a={reasoning.data} />}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Result({ a }: { a: IncidentReasoning }) {
  const flags = a.guardrail_flags.map(plainFlag);
  return (
    <>
      <Answer a={a} />
      {flags.length > 0 && (
        <div role="note" className="flex gap-2 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <div>
            <p className="font-medium">Check before relying on this</p>
            <ul className="mt-1 list-inside list-disc">
              {[...new Set(flags)].map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <StillUnknown gaps={a.gaps} />
      <Sources a={a} />
      <HowWeGotHere a={a} />
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <Sparkles className="size-3.5" aria-hidden />
        Written by AI from the project records. Review before relying on it. Version {a.version}, updated {fmtDateTime(a.created_at)}.
      </p>
    </>
  );
}
