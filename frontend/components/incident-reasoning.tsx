"use client";

import { AlertTriangle, BadgeCheck, CircleHelp, FileSearch, Loader2, Quote, RefreshCw, ShieldAlert } from "lucide-react";
import { CitationChip } from "@/components/citation-chip";
import { GatedButton } from "@/components/gated-button";
import { useApp } from "@/components/providers/app-context";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiError } from "@/lib/api";
import { servedFromFixtures } from "@/lib/endpoints";
import { useAnalyzeIncident, useIncidentAnalysis } from "@/lib/queries";
import { denyReason } from "@/lib/roles";
import { fmtDateTime } from "@/lib/time";
import type { AnalysisEvidence, AnalysisStatus, AuthorRole, IncidentAnalysis } from "@/lib/types";
import { cn } from "@/lib/utils";

const STATUS: Record<AnalysisStatus, { label: string; cls: string; Icon: typeof BadgeCheck; hint: string }> = {
  established: { label: "Established", cls: "border-emerald-300 bg-emerald-50 text-emerald-800", Icon: BadgeCheck, hint: "Clear supervisor-side statement, uncontradicted" },
  probable: { label: "Probable", cls: "border-sky-300 bg-sky-50 text-sky-800", Icon: BadgeCheck, hint: "Supported, with open questions" },
  unconfirmed: { label: "Unconfirmed", cls: "border-amber-300 bg-amber-50 text-amber-900", Icon: CircleHelp, hint: "Weak or external-only support" },
  undetermined: { label: "No stated reason", cls: "border-border bg-muted text-foreground", Icon: CircleHelp, hint: "No record says why this happened" },
  needs_review: { label: "Needs review", cls: "border-red-300 bg-red-50 text-red-800", Icon: ShieldAlert, hint: "The automatic decision failed validation" },
};

const ROLE_LABEL: Record<AuthorRole, string> = {
  site_supervisor: "Site manager",
  foreman: "Foreman",
  signed_report: "Signed report",
  contractor_internal: "Contractor",
  external: "External party",
  client: "Client",
  system: "System record",
  unknown: "Unknown author",
};
const SUPERVISOR_SIDE: AuthorRole[] = ["site_supervisor", "foreman", "signed_report"];

function pct(n: number) {
  return `${Math.round(n * 100)}%`;
}

function ConfidenceMeter({ value, status }: { value: number; status: AnalysisStatus }) {
  const tone = value >= 0.75 ? "bg-emerald-600" : value >= 0.45 ? "bg-sky-600" : value >= 0.2 ? "bg-amber-500" : "bg-slate-400";
  return (
    <div className="flex flex-col gap-1" role="img" aria-label={`Confidence ${pct(value)}, ${STATUS[status].label}`}>
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-muted-foreground">Confidence</span>
        <span className="text-lg font-semibold tabular-nums">{pct(value)}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full", tone)} style={{ width: pct(value) }} />
      </div>
    </div>
  );
}

function RoleChip({ role }: { role: AuthorRole }) {
  const strong = SUPERVISOR_SIDE.includes(role);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-medium",
        strong ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-border bg-muted text-muted-foreground",
      )}
    >
      {ROLE_LABEL[role]}
    </span>
  );
}

function QuoteCard({ e, tone }: { e: AnalysisEvidence; tone: "fact" | "context" }) {
  return (
    <figure className={cn("rounded-md border-l-4 p-3", tone === "fact" ? "border-emerald-500 bg-emerald-50/60" : "border-slate-300 bg-muted/50")}>
      <blockquote className="flex gap-2 text-sm">
        <Quote className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="whitespace-pre-wrap">“{e.quote}”</span>
      </blockquote>
      <figcaption className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <RoleChip role={e.author_role} />
        <CitationChip refData={{ source_id: e.source_id }} />
        <span className="font-mono">{e.locator}</span>
        {e.stated_at && <span>stated {fmtDateTime(e.stated_at)}</span>}
        {e.stance !== "states_cause" && <span className="rounded border px-1">{e.stance.replace("_", " ")}</span>}
      </figcaption>
    </figure>
  );
}

function Verdict({ a }: { a: IncidentAnalysis }) {
  const s = STATUS[a.status];
  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="flex flex-col gap-2">
        <span className={cn("inline-flex w-fit items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium [&_svg]:size-3.5", s.cls)} title={s.hint}>
          <s.Icon aria-hidden /> {s.label}
        </span>
        <p className="text-lg font-semibold">
          {a.headline_cause ?? "No record states why this happened"}
        </p>
        <p className="text-sm text-muted-foreground">{a.reasoning}</p>
      </div>
      <ConfidenceMeter value={a.confidence} status={a.status} />
    </div>
  );
}

function Hypotheses({ a }: { a: IncidentAnalysis }) {
  const llmPick = a.hypotheses.find((h) => h.llm_selected);
  return (
    <section aria-labelledby="hyp-h" className="flex flex-col gap-2">
      <h3 id="hyp-h" className="text-sm font-semibold">Candidate causes</h3>
      <p className="text-xs text-muted-foreground">
        The bar is the code&apos;s score from who said it. The model reads these scores, then makes the final call
        {llmPick ? "" : " (it chose none)"}.
      </p>
      <ul className="flex flex-col gap-2">
        {a.hypotheses.map((h) => {
          const card = a.score_cards.find((c) => c.hypothesis_id === h.id);
          return (
            <li key={h.id} className={cn("rounded-md border p-3", h.llm_selected && "border-emerald-400 bg-emerald-50/40")}>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{h.statement}</span>
                <span className="rounded border px-1 text-xs text-muted-foreground">{h.level === "root" ? "root cause" : "immediate cause"}</span>
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
                  {card.supervisor_backed ? "Supervisor-backed" : card.external_only ? "External only" : "No cause stated"} ·{" "}
                  {card.independent_sources} independent source{card.independent_sources === 1 ? "" : "s"}
                  {card.contradicted_by_supervisor ? " · contradicted by a supervisor" : ""}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function IncidentReasoning({ incidentId }: { incidentId: string }) {
  const { role } = useApp();
  const analysis = useIncidentAnalysis(incidentId);
  const run = useAnalyzeIncident(incidentId);
  const sample = servedFromFixtures("incidentAnalysis");
  const notYet = analysis.isError && analysis.error instanceof ApiError && analysis.error.status === 404;

  const runButton = (
    <GatedButton
      size="sm"
      variant="outline"
      reason={denyReason(role, "analyze_incident")}
      disabled={run.isPending}
      onClick={() => run.mutate()}
    >
      {run.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
      {notYet ? "Analyse cause" : "Re-run analysis"}
    </GatedButton>
  );

  return (
    <Card>
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            <FileSearch className="size-4" aria-hidden /> Cause &amp; evidence
          </CardTitle>
          {runButton}
        </div>
        <p className="text-xs text-muted-foreground">
          What the site records say caused this incident. Supervisor and foreman statements outweigh outside parties. Review before relying on it.
          {sample && " Showing sample output (fixture mode)."}
        </p>
        {run.isError && <ErrorState error={run.error} onRetry={() => run.mutate()} />}
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {analysis.isPending && <LoadingSkeleton variant="detail" rows={2} />}
        {notYet && (
          <EmptyState
            icon={<FileSearch />}
            title="No analysis yet"
            description="Nothing has been analysed for this incident at this time. A manager can run the evidence agent."
          />
        )}
        {analysis.isError && !notYet && <ErrorState error={analysis.error} onRetry={() => void analysis.refetch()} />}
        {analysis.data && <AnalysisBody a={analysis.data} />}
      </CardContent>
    </Card>
  );
}

function AnalysisBody({ a }: { a: IncidentAnalysis }) {
  return (
    <>
      <Verdict a={a} />
      {a.guardrail_flags.length > 0 && (
        <div role="note" className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <ul className="list-inside list-disc">
            {a.guardrail_flags.map((f) => (
              <li key={f}>{f.replaceAll("_", " ")}</li>
            ))}
          </ul>
        </div>
      )}
      <section aria-labelledby="ev-h" className="flex flex-col gap-2">
        <h3 id="ev-h" className="text-sm font-semibold">Where it was said</h3>
        {a.factual_evidence.length ? (
          a.factual_evidence.map((e) => <QuoteCard key={`${e.source_id}-${e.locator}-${e.quote}`} e={e} tone="fact" />)
        ) : (
          <p className="text-sm text-muted-foreground">No supervisor-side record states a cause.</p>
        )}
      </section>
      {a.external_claims.length > 0 && (
        <section aria-labelledby="ext-h" className="flex flex-col gap-2">
          <h3 id="ext-h" className="text-sm font-semibold">Outside parties and context (not treated as the cause)</h3>
          {a.external_claims.map((e) => (
            <QuoteCard key={`${e.source_id}-${e.locator}-${e.quote}`} e={e} tone="context" />
          ))}
        </section>
      )}
      <Hypotheses a={a} />
      {a.gaps.length > 0 && (
        <section aria-labelledby="gap-h" className="flex flex-col gap-1">
          <h3 id="gap-h" className="text-sm font-semibold">Still unknown</h3>
          <ul className="list-inside list-disc text-sm text-muted-foreground">
            {a.gaps.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </section>
      )}
      <p className="text-xs text-muted-foreground">
        Version {a.version} · analysed {fmtDateTime(a.created_at)} · model {a.model}
      </p>
    </>
  );
}
