"use client";

import { Clock, Download, FilePen, Gauge, RefreshCw, Wrench } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CitationList } from "@/components/citation-chip";
import { BandChip, CauseChip, StatusChip } from "@/components/performance/chips";
import { VarianceBar } from "@/components/performance/variance-bar";
import { useApp } from "@/components/providers/app-context";
import { ErrorState, LoadingSkeleton } from "@/components/states";
import { Button } from "@/components/ui/button";
import {
  dailyReportUrl,
  deadlineLabel,
  NOTICE_TEXT,
  toRefs,
  useDailyEvaluation,
  useDraftSuggestion,
  useRecomputeDay,
  type DailyEvaluation,
  type Suggestion,
} from "@/lib/performance";
import { localDateOf } from "@/lib/time";
import { cn } from "@/lib/utils";

const TONE = { red: "text-red-700 dark:text-red-400", amber: "text-amber-800 dark:text-amber-300", muted: "text-muted-foreground" };

function SuggestionCard({ s, clockDate }: { s: Suggestion; clockDate: string }) {
  const draft = useDraftSuggestion();
  const router = useRouter();
  const due = deadlineLabel(s.deadline, clockDate);
  return (
    <li className="flex flex-col gap-2 rounded-2xl border bg-background p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold">
          {NOTICE_TEXT[s.type]} {s.activity_code ? <span className="font-mono text-xs">· {s.activity_code}</span> : null}
        </p>
        <span className={cn("inline-flex items-center gap-1 text-xs font-medium", TONE[due.tone])}>
          <Clock className="size-3.5" aria-hidden /> {due.text}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">{s.reason}</p>
      {s.amount != null && <p className="text-sm">Indicative amount: <span className="font-semibold tabular">{s.amount} {s.currency}</span></p>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CitationList refs={toRefs(s.refs)} />
        <Button size="sm" disabled={!s.alert_id || draft.isPending}
          onClick={() => draft.mutate(s, { onSuccess: (d) => router.push(`/drafts/${d.id}`) })}>
          <FilePen aria-hidden /> {draft.isPending ? "Drafting…" : "Draft notice"}
        </Button>
      </div>
      {draft.isError && <p className="text-xs text-red-700">{(draft.error as Error).message}</p>}
    </li>
  );
}

export function DayPerformance({ d, clockDate }: { d: DailyEvaluation; clockDate: string }) {
  const recompute = useRecomputeDay();
  const { projectId, asOf } = useApp();
  const flagged = d.activities.filter((a) => a.planned > 0 || (a.actual ?? 0) > 0 || a.status === "late_start");
  const upcoming = d.activities.filter((a) => a.status === "not_started_ok");
  const idle = d.indicators.equipment_idle;
  return (
    <section className="flex flex-col gap-4 rounded-[22px] bg-card p-5 md:p-6" aria-label="Day performance">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-bold">
            <Gauge className="size-4" aria-hidden /> Day performance
          </h2>
          <p className="mt-1 text-sm">{d.summary.headline.text}</p>
          {d.summary.headline.refs.length > 0 && <CitationList className="mt-1.5" refs={toRefs(d.summary.headline.refs)} />}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <BandChip band={d.day_severity} label={d.day_status.replaceAll("_", " ")} />
          <span className={cn("rounded-md border px-1.5 py-0.5 text-xs font-semibold tabular", d.day_score < 0 ? "border-red-200 text-red-800" : "border-emerald-200 text-emerald-800")}>
            Score {d.day_score > 0 ? "+" : ""}{d.day_score}
          </span>
          <Button size="sm" variant="outline" disabled={recompute.isPending} onClick={() => recompute.mutate(d.work_date)}>
            <RefreshCw className={cn(recompute.isPending && "animate-spin")} aria-hidden /> Recompute
          </Button>
        </div>
      </div>
      {d.provisional && <p className="text-xs text-amber-800 dark:text-amber-300">Provisional: the signed daily report is not in yet.</p>}
      {d.summary.status && !["ok"].includes(d.summary.status) && (
        <p className="text-xs text-muted-foreground">
          {d.summary.status === "not_requested" ? "Figures only. Recompute to add the written, cited summary." :
            d.summary.status === "model_unavailable" ? "The summary model was unavailable; the figures are complete." :
              "Summary items that could not be cited were left out."}
        </p>
      )}

      <ul className="flex flex-col divide-y">
        {flagged.map((a) => (
          <li key={a.code} className="flex flex-col gap-2 py-3 sm:grid sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] sm:items-center sm:gap-4">
            <div className="min-w-0">
              <p className="truncate text-sm"><span className="font-mono text-xs font-semibold">{a.code}</span> <span className="font-medium">{a.name}</span></p>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <StatusChip a={a} />
                {a.attribution && a.attribution.cause_category && (a.severity !== "none" || a.status === "unplanned_work" || a.status === "exceeded") && (
                  <CauseChip cause={a.attribution.cause_category} confidence={a.attribution.confidence} excusable={a.attribution.excusable} />
                )}
                {a.estimate && a.actual === null && <span className="text-xs text-muted-foreground">estimate {a.estimate.value} (not used)</span>}
              </div>
              {a.attribution && a.attribution.status === "ok" && (a.severity !== "none" || a.status === "unplanned_work") && (
                <p className="mt-1 text-xs text-muted-foreground">{a.attribution.explanation} <CitationList refs={toRefs(a.attribution.refs)} /></p>
              )}
            </div>
            <VarianceBar planned={a.planned} actual={a.actual} unit={a.unit} variancePct={a.variance_pct} />
          </li>
        ))}
      </ul>
      {upcoming.length > 0 && (
        <p className="text-xs text-muted-foreground">Starting soon: {upcoming.map((a) => a.code).join(", ")}</p>
      )}
      {idle.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-2xl bg-muted/50 p-3">
          {idle.map((i) => (
            <p key={i.equipment_id} className="flex flex-wrap items-center gap-2 text-sm">
              <Wrench className="size-4" aria-hidden /> <span className="font-mono text-xs font-semibold">{i.equipment_id}</span>
              {i.hours != null ? <span>idle {i.hours} h</span> : <span className="text-muted-foreground">{i.note}</span>}
              <BandChip band={i.severity} label={i.severity === "none" ? "Idle" : undefined} />
              {i.attribution && i.attribution.status === "ok" && <CauseChip cause={i.attribution.cause_category} confidence={i.attribution.confidence} />}
              <CitationList refs={toRefs(i.refs).slice(0, 3)} />
            </p>
          ))}
        </div>
      )}
      {d.suggestions.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Correspondence to consider</h3>
          <ul className="flex flex-col gap-2">
            {d.suggestions.map((s, i) => <SuggestionCard key={`${s.type}-${i}`} s={s} clockDate={clockDate} />)}
          </ul>
          <p className="text-xs text-muted-foreground">Suggestions only. Nothing is drafted or sent until you choose to.</p>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 border-t pt-4" aria-label="Download daily report">
        <p className="mr-auto text-sm font-semibold">Daily report</p>
        <Button asChild size="sm" variant="outline"><a href={dailyReportUrl(projectId, d.work_date, asOf, "pdf")} download><Download aria-hidden /> PDF</a></Button>
        <Button asChild size="sm" variant="outline"><a href={dailyReportUrl(projectId, d.work_date, asOf, "docx")} download><Download aria-hidden /> Word</a></Button>
      </div>
      <p className="text-xs text-muted-foreground">
        v{d.version} · {d.disclaimer} · <Link className="underline" href="/performance">Overall performance</Link>
      </p>
    </section>
  );
}

/** The Today / manager card: loads the day's evaluation at the As of clock. */
export function DayPerformanceCard({ date }: { date: string }) {
  const { asOf } = useApp();
  const q = useDailyEvaluation(date);
  if (q.isPending) return <LoadingSkeleton variant="cards" rows={1} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return <DayPerformance d={q.data} clockDate={localDateOf(asOf)} />;
}
