"use client";

import { AlertTriangle, ArrowLeft, FileSearch, Info, RefreshCw, Ruler, Sparkles } from "lucide-react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { type ReactNode, Suspense, useState } from "react";
import { JobStatusBadge } from "@/components/badges";
import { CitationChip, CitationList } from "@/components/citation-chip";
import { OriginalActions, OriginalEmbed } from "@/components/evidence-viewer";
import { GatedButton } from "@/components/gated-button";
import { useApp } from "@/components/providers/app-context";
import { SourceIcon } from "@/components/source-icon";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/states";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiError } from "@/lib/api";
import { USE_FIXTURES } from "@/lib/endpoints";
import { basisLabel, fmtQty, SOURCE_TYPE_LABEL } from "@/lib/format";
import {
  useDocumentJob,
  useInvalidateOnJobDone,
  useRegenerateSummary,
  useReportReadings,
  useSource,
  useSourceSummary,
} from "@/lib/queries";
import { denyReason } from "@/lib/roles";
import { passageWords, sourceTitle } from "@/lib/source-title";
import { fmtDateTime } from "@/lib/time";
import type { Passage, ReportReading, SourceSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Panels size to their content (no empty space under short documents) and stop at the screen height,
 * scrolling inside after that. Long unbroken strings (hashes, file names) wrap instead of overflowing.
 */
const PANEL = "lg:max-h-[calc(100dvh-9rem)] [overflow-wrap:anywhere]";

function SectionLabel({ children, count }: { children: ReactNode; count?: number }) {
  return (
    <h3 className="flex items-center gap-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
      {children}
      {count !== undefined && (
        <span className="rounded-full bg-muted px-1.5 py-px text-[10px] font-medium text-foreground tabular-nums">{count}</span>
      )}
    </h3>
  );
}

function RegenerateSummary({ sourceId, label }: { sourceId: string; label: string }) {
  const { role } = useApp();
  const regenerate = useRegenerateSummary();
  const job = useDocumentJob(regenerate.data?.id ?? null);
  useInvalidateOnJobDone(job.data?.status);
  const running = regenerate.isPending || job.data?.status === "extracting" || job.data?.status === "uploaded";
  if (USE_FIXTURES) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <GatedButton reason={denyReason(role, "upload")} size="sm" variant="outline" disabled={running} onClick={() => regenerate.mutate(sourceId)}>
        <RefreshCw aria-hidden className={running ? "animate-spin" : undefined} /> {running ? "Summarising…" : label}
      </GatedButton>
      {job.data?.status === "failed" && <span className="text-xs text-red-800">{job.data.error}</span>}
      {regenerate.isError && <span className="text-xs text-red-800">{regenerate.error.message}</span>}
    </span>
  );
}

// ------------------------------------------------------------------ quantities

const READING_STATUS: Record<ReportReading["review_status"], { label: string; cls: string }> = {
  accepted: { label: "Accepted", cls: "bg-emerald-50 text-emerald-800 ring-emerald-200" },
  proposed: { label: "Awaiting confirmation", cls: "bg-amber-50 text-amber-900 ring-amber-200" },
  conflict: { label: "Differs from accepted", cls: "bg-red-50 text-red-800 ring-red-200" },
};

function QuantitiesPanel({ sourceId }: { sourceId: string }) {
  const readings = useReportReadings(sourceId);
  if (readings.isPending) return <LoadingSkeleton rows={3} />;
  if (readings.isError)
    return readings.error instanceof ApiError && readings.error.status === 404 ? (
      <EmptyState title="No extracted quantities" description={readings.error.message} />
    ) : (
      <ErrorState error={readings.error} onRetry={() => void readings.refetch()} />
    );
  const rows = readings.data.readings.filter((r) => !r.locator.startsWith("zero-"));
  const zeroRows = readings.data.readings.some((r) => r.locator.startsWith("zero-"));
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">Measured shift quantities read from the report and how they compare with accepted values.</p>
      {!!readings.data.review_reasons.length && (
        <ul className="list-disc rounded-lg border border-amber-300 bg-amber-50 p-3 pl-7 text-sm text-amber-900">
          {readings.data.review_reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      {rows.length ? (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
          {rows.map((r) => (
            <div key={r.locator} className="flex flex-col gap-2 rounded-xl border bg-background p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs font-semibold">{r.activity_code}</span>
                <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset", READING_STATUS[r.review_status].cls)}>
                  {READING_STATUS[r.review_status].label}
                </span>
              </div>
              <p className="text-2xl font-semibold tracking-tight tabular-nums">
                {fmtQty(r.value, r.unit)} <span className="text-xs font-normal text-muted-foreground">{basisLabel(r.basis)}</span>
              </p>
              <CitationChip refData={r.ref} className="self-start" />
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No quantity rows were read from this report.</p>
      )}
      {zeroRows && (
        <p className="flex gap-1.5 text-xs text-muted-foreground">
          <Info className="mt-px size-3.5 shrink-0" aria-hidden />
          The report states that other scheduled activities recorded zero production this shift; those are recorded as 0.
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ summary

function SummaryItems({ items }: { items: SourceSummary["observations"] }) {
  if (!items.length) return <p className="text-sm text-muted-foreground">None recorded.</p>;
  return (
    <ul className="flex flex-col gap-3">
      {items.map((o, i) => (
        <li key={i} className="flex flex-col gap-1.5 border-l-2 border-sky-200 pl-3 text-sm leading-relaxed">
          {o.text}
          <CitationList refs={o.refs} />
        </li>
      ))}
    </ul>
  );
}

function SummaryPanel({ sourceId, pending }: { sourceId: string; pending: boolean }) {
  const summary = useSourceSummary(sourceId, true, pending);
  if (summary.isPending) return <LoadingSkeleton rows={4} />;
  if (summary.isError) {
    if (summary.error instanceof ApiError && summary.error.status === 404 && pending)
      return (
        <EmptyState
          icon={<RefreshCw className="animate-spin" />}
          title="Summarising…"
          description="Claude is reading this document. The summary appears here when it is ready."
        />
      );
    if (summary.error instanceof ApiError && summary.error.status === 404)
      return (
        <EmptyState
          title="No summary yet"
          description="Summaries are prepared for diaries, minutes, emails and daily reports."
          action={<RegenerateSummary sourceId={sourceId} label="Generate summary" />}
        />
      );
    return <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />;
  }
  const d = summary.data;
  return (
    <div className="flex flex-col gap-6">
      {d.headline && (
        <p className="rounded-xl border border-sky-100 bg-gradient-to-br from-sky-50 to-background p-4 text-sm leading-relaxed font-medium">
          {d.headline}
        </p>
      )}
      <section className="flex flex-col gap-2.5">
        <SectionLabel count={d.open_actions.length}>Open actions</SectionLabel>
        {d.open_actions.length ? (
          <ul className="flex flex-col gap-2">
            {d.open_actions.map((a, i) => (
              <li key={i} className="flex flex-col gap-2 rounded-xl border bg-background p-3 text-sm">
                <span className="leading-relaxed">{a.text}</span>
                <span className="flex flex-wrap gap-1.5 text-xs">
                  {/* Owner and due date are shown only when the source records them */}
                  <span className={cn("rounded-md px-2 py-0.5", a.owner ? "bg-muted" : "text-muted-foreground")}>
                    {a.owner ? <>Owner <strong>{a.owner}</strong></> : "Owner not recorded"}
                  </span>
                  <span className={cn("rounded-md px-2 py-0.5", a.due ? "bg-muted" : "text-muted-foreground")}>
                    {a.due ? <>Due <strong>{fmtDateTime(a.due)}</strong></> : "No due date recorded"}
                  </span>
                </span>
                <CitationList refs={a.refs} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">None recorded.</p>
        )}
      </section>
      <section className="flex flex-col gap-2.5">
        <SectionLabel count={d.observations.length}>Observations</SectionLabel>
        <SummaryItems items={d.observations} />
      </section>
      <section className="flex flex-col gap-2.5">
        <SectionLabel count={d.decisions.length}>Decisions</SectionLabel>
        <SummaryItems items={d.decisions} />
      </section>
      {!!d.provisional?.length && (
        <section className="flex flex-col gap-2.5">
          <SectionLabel count={d.provisional.length}>Provisional or unconfirmed</SectionLabel>
          <SummaryItems items={d.provisional} />
        </section>
      )}
      {!!d.quoted_external_instructions?.length && (
        <section className="flex flex-col gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-amber-900">
            <AlertTriangle className="size-4" aria-hidden /> Quoted external text (not acted on)
          </h3>
          <ul className="flex flex-col gap-2 text-sm text-amber-950">
            {d.quoted_external_instructions.map((o, i) => (
              <li key={i} className="flex flex-col gap-1">
                {o.text}
                <CitationList refs={o.refs} />
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-xs text-muted-foreground">
        <span>
          {d.version !== undefined ? `Machine-generated summary v${d.version}` : "Summary"}
          {d.model ? ` · ${d.model}` : ""} · check the cited passages
        </span>
        {d.version !== undefined && <RegenerateSummary sourceId={sourceId} label="Regenerate" />}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ passages

function PassagesPanel({ passages, selected, onSelect, words }: { passages: Passage[]; selected: string | null; onSelect: (p: Passage) => void; words: ReturnType<typeof passageWords> }) {
  if (!passages.length) return <p className="text-sm text-muted-foreground">{words.none}</p>;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">{words.hint}</p>
      <ul className="flex flex-col gap-2">
        {passages.map((p) => {
          const active = selected === p.locator;
          return (
            <li key={p.id} id={`passage-${p.locator}`}>
              <button
                type="button"
                onClick={() => onSelect(p)}
                aria-pressed={active}
                className={cn(
                  "w-full rounded-xl border bg-background p-3 text-left transition-all hover:border-foreground/20 hover:shadow-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  active && "border-amber-400 bg-amber-50 ring-1 ring-amber-300 hover:border-amber-400 dark:bg-amber-500/10",
                )}
              >
                <span className="mb-1.5 flex flex-wrap items-center gap-1.5">
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{p.locator}</span>
                  {p.page ? <span className="text-[11px] text-muted-foreground">page {p.page}</span> : null}
                  {p.section ? <span className="truncate text-[11px] text-muted-foreground">{p.section}</span> : null}
                  {p.untrusted && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-900">External text, quoted</span>}
                </span>
                <span className="block text-sm leading-relaxed whitespace-pre-wrap">{p.text}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------ page

function DocumentInner() {
  const { sourceId } = useParams<{ sourceId: string }>();
  const initial = useSearchParams().get("locator");
  const [focus, setFocus] = useState<{ locator: string | null; page: number | null }>({ locator: initial, page: null });
  const source = useSource(sourceId);
  const [tab, setTab] = useState<string | null>(initial ? "passages" : null);

  const back = (
    <Link
      href="/documents"
      className="mb-4 inline-flex min-h-11 items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground md:min-h-0"
    >
      <ArrowLeft className="size-4" aria-hidden /> All documents
    </Link>
  );
  if (source.isPending)
    return (
      <>
        {back}
        <LoadingSkeleton variant="detail" rows={2} />
      </>
    );
  if (source.isError)
    return (
      <>
        {back}
        {source.error instanceof ApiError && source.error.status === 404 ? (
          <EmptyState title="Document not available" description={source.error.message} />
        ) : (
          <ErrorState error={source.error} onRetry={() => void source.refetch()} />
        )}
      </>
    );

  const s = source.data;
  const hasSummary = s.type === "diary" || s.type === "minutes" || s.type === "email" || s.type === "daily_report";
  const hasQuantities = s.type === "daily_report" && !USE_FIXTURES;
  const activeTab = tab ?? (hasSummary ? "summary" : hasQuantities ? "quantities" : "passages");
  const focusPage = focus.page ?? s.passages.find((p) => p.locator === focus.locator)?.page ?? null;
  const words = passageWords(s.type);
  const facts: [string, ReactNode][] = [
    ["Document ID", <span key="id" className="font-mono">{s.id}</span>],
    ["Type", SOURCE_TYPE_LABEL[s.type]],
    ["Received", fmtDateTime(s.available_at)],
    ...(s.pages ? ([["Pages", s.pages]] as [string, ReactNode][]) : []),
    [words.count, s.passages.length],
    ...(s.summary_version ? ([["Summary", `v${s.summary_version}`]] as [string, ReactNode][]) : []),
  ];

  return (
    <>
      {back}

      {/* Overview */}
      <section className="mb-5 overflow-hidden rounded-2xl border bg-card shadow-xs [overflow-wrap:anywhere]">
        <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start">
          <SourceIcon type={s.type} size="lg" />
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold tracking-tight break-words md:text-2xl">{sourceTitle(s)}</h1>
            <p className="mt-1 truncate text-sm text-muted-foreground">{s.filename}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            <JobStatusBadge status={s.status} />
            <OriginalActions source={s} />
          </div>
        </div>
        <dl className="-mr-px -mb-px flex flex-wrap border-t bg-muted/30">
          {facts.map(([k, v]) => (
            <div key={k} className="flex min-w-0 flex-1 basis-36 flex-col gap-0.5 border-r border-b px-5 py-3">
              <dt className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{k}</dt>
              <dd className="truncate text-sm font-semibold">{v}</dd>
            </div>
          ))}
        </dl>
        {(!!s.review_reasons?.length || s.note) && (
          <div role="status" className="flex gap-2 border-t border-amber-200 bg-amber-50 px-5 py-3 text-sm text-amber-900">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            {s.review_reasons?.length ? (
              <ul className="flex flex-col gap-0.5">
                {s.review_reasons.map((r) => (
                  <li key={r}>Needs review: {r}</li>
                ))}
              </ul>
            ) : (
              <p>{s.note}</p>
            )}
          </div>
        )}
      </section>

      {/* Original | details, same height on large screens */}
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <section
          aria-labelledby="original-title"
          className={cn("flex min-w-0 flex-col overflow-hidden rounded-2xl border bg-card shadow-xs lg:sticky lg:top-20", PANEL)}
        >
          <header className="flex items-center justify-between gap-3 border-b px-5 py-3">
            <h2 id="original-title" className="text-base font-semibold">
              Original
            </h2>
            <p className="min-w-0 truncate text-xs text-muted-foreground">
              {focus.locator ? (
                <>
                  Highlighting <span className="font-mono text-foreground">{focus.locator}</span>
                  {focusPage ? ` · page ${focusPage}` : ""}
                </>
              ) : (
                s.filename
              )}
            </p>
          </header>
          <div className="min-h-0 flex-auto overflow-auto p-4">
            <OriginalEmbed source={s} page={focusPage} locator={focus.locator} passages={s.passages} showActions={false} tall />
          </div>
        </section>

        <Tabs
          value={activeTab}
          onValueChange={setTab}
          className={cn("flex min-w-0 flex-col gap-0 overflow-hidden rounded-2xl border bg-card shadow-xs", PANEL)}
        >
          <div className="border-b px-3 pt-3">
            <TabsList variant="line" className="w-full justify-start gap-0">
              {hasSummary && (
                <TabsTrigger value="summary" className="flex-none px-3 pb-2.5">
                  <Sparkles aria-hidden /> Summary
                </TabsTrigger>
              )}
              {hasQuantities && (
                <TabsTrigger value="quantities" className="flex-none px-3 pb-2.5">
                  <Ruler aria-hidden /> Quantities
                </TabsTrigger>
              )}
              <TabsTrigger value="passages" className="flex-none px-3 pb-2.5">
                <FileSearch aria-hidden /> {words.tab}
                <span className="rounded-full bg-muted px-1.5 text-[11px] tabular-nums">{s.passages.length}</span>
              </TabsTrigger>
            </TabsList>
          </div>
          <div className="min-h-0 flex-auto overflow-x-hidden overflow-y-auto p-5">
            {hasSummary && (
              <TabsContent value="summary">
                <SummaryPanel
                  sourceId={s.id}
                  pending={s.summary_status === "queued" || s.summary_status === "running" || s.status === "extracting"}
                />
              </TabsContent>
            )}
            {hasQuantities && (
              <TabsContent value="quantities">
                <QuantitiesPanel sourceId={s.id} />
              </TabsContent>
            )}
            <TabsContent value="passages">
              <PassagesPanel
                passages={s.passages}
                selected={focus.locator}
                onSelect={(p) => setFocus({ locator: p.locator, page: p.page ?? null })}
                words={words}
              />
            </TabsContent>
          </div>
        </Tabs>
      </div>

    </>
  );
}

export default function DocumentPage() {
  return (
    <Suspense fallback={<LoadingSkeleton variant="detail" rows={2} />}>
      <DocumentInner />
    </Suspense>
  );
}
