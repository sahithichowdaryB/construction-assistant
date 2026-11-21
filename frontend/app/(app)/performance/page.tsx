"use client";

import { CheckCircle2, Circle, Download, RefreshCw } from "lucide-react";
import { useState } from "react";
import { DayNav } from "@/components/day-nav";
import { BandChip, OverallChip, StatusChip } from "@/components/performance/chips";
import { PerfTabs } from "@/components/performance/perf-tabs";
import { SCurveChart } from "@/components/performance/s-curve-chart";
import { VarianceBar } from "@/components/performance/variance-bar";
import { useApp } from "@/components/providers/app-context";
import { EmptyState, ErrorState, PageHeader } from "@/components/states";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { reportUrl, useDailyEvaluation, usePerformance, type DailyEvaluation, type Snapshot } from "@/lib/performance";
import { fmtLocalDate, localDateOf } from "@/lib/time";

const card = "rounded-[22px] bg-card p-5 md:p-6";

function Kpi({ label, value, sub, chip }: { label: string; value: string; sub?: string; chip?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-[22px] bg-card p-4 md:p-5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold tabular">{value}</p>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">{chip}{sub}</div>
    </div>
  );
}

function KpiRow({ s }: { s: Snapshot }) {
  const m = s.metrics;
  const v = m.completion_variance_days;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Kpi label="Progress, actual / planned" value={`${m.weighted_actual_pct ?? "–"}% / ${m.weighted_planned_pct ?? "–"}%`}
           chip={<BandChip band={m.cumulative_band} label={`${m.points_behind} pts behind`} />} />
      <Kpi label="Schedule performance (SPI)" value={m.spi === null ? "–" : String(m.spi)} chip={<BandChip band={m.spi_band} />} />
      <Kpi label="Forecast completion" value={m.forecast_completion ? fmtLocalDate(m.forecast_completion) : "–"}
           chip={<OverallChip status={m.overall_status} />}
           sub={v === null ? undefined : v === 0 ? "on the planned date" : `${Math.abs(v)} working day${Math.abs(v) === 1 ? "" : "s"} ${v > 0 ? "late" : "early"}`} />
      <Kpi label="Score to date" value={`${m.score > 0 ? "+" : ""}${m.score}`}
           sub={`${m.ledger_counts.accepted ?? 0} accepted · ${m.ledger_counts.disputed ?? 0} disputed`} />
    </div>
  );
}

function KpiSkeleton() {
  return <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" role="status" aria-label="Loading metrics">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-28 rounded-[22px]" />)}</div>;
}

/** The day as a task list: what the plan says must be completed, and how far each task got. */
function DaySummary({ d }: { d: DailyEvaluation }) {
  const rows = d.activities.filter((a) => a.planned > 0 || (a.actual ?? 0) > 0).sort((x, y) => Number(y.planned > 0) - Number(x.planned > 0));
  const events = [
    ...d.indicators.equipment_idle.map((i) => `${i.equipment_id}: ${i.hours != null ? `idle ${i.hours} h` : (i.note ?? "idle")}`),
    ...d.indicators.quality_holds.filter((h) => h.text).map((h) => h.text as string),
  ];
  const planned = rows.filter((r) => r.planned > 0);
  const done = planned.filter((r) => r.actual !== null && r.actual >= r.planned).length;
  return (
    <>
      {d.provisional && <p className="text-xs text-amber-800 dark:text-amber-300">Provisional: the signed daily report is not in yet.</p>}
      {planned.length > 0 && <p className="text-sm text-muted-foreground tabular">{done} of {planned.length} tasks completed to target</p>}
      {rows.length ? (
        <ul className="flex flex-col divide-y">
          {rows.map((a) => {
            const complete = a.planned > 0 && a.actual !== null && a.actual >= a.planned;
            return (
              <li key={a.code} className="flex flex-col gap-2 py-3 sm:grid sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] sm:items-center sm:gap-4">
                <div className="flex min-w-0 items-start gap-2.5">
                  {complete ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" aria-label="Completed" /> : <Circle className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-label="Not completed" />}
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{a.planned > 0 ? `Complete ${a.planned} ${a.unit ?? ""} · ${a.name ?? a.code}` : `${a.name ?? a.code} (not in today's plan)`}</p>
                    <div className="mt-1"><StatusChip a={a} /></div>
                  </div>
                </div>
                <VarianceBar planned={a.planned} actual={a.actual} unit={a.unit} variancePct={a.variance_pct} />
              </li>
            );
          })}
        </ul>
      ) : <EmptyState title="No tasks are planned for this day" />}
      {events.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold">Events registered</h3>
          <ul className="mt-1 flex list-disc flex-col gap-1 pl-5 text-sm">{events.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </div>
      )}
    </>
  );
}

export default function PerformancePage() {
  const { asOf, projectId } = useApp();
  const clockDate = localDateOf(asOf);
  const [picked, setPicked] = useState<string | null>(null);
  const date = picked && picked <= clockDate ? picked : clockDate;
  const snap = usePerformance(date);
  const day = useDailyEvaluation(date);
  const refreshing = snap.isFetching || day.isFetching;
  return (
    <>
      <PageHeader
        title="Performance"
        description="How the project is doing against the plan, and what happened on the selected day."
        actions={<DayNav date={date} clockDate={clockDate} onChange={setPicked} />}
      />
      <PerfTabs />
      <div className="mb-4 flex items-center justify-end gap-3">
        <p className="text-xs text-muted-foreground">Loaded once. Refresh to pick up new reports.</p>
        <Button size="sm" variant="outline" disabled={refreshing} onClick={() => void Promise.all([snap.refetch(), day.refetch()])}>
          <RefreshCw className={cn(refreshing && "animate-spin")} aria-hidden /> {refreshing ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      <div className="flex flex-col gap-5">
        {snap.isPending ? <KpiSkeleton /> : snap.isError ? <ErrorState error={snap.error} onRetry={() => void snap.refetch()} /> : (
          <>
            <KpiRow s={snap.data} />
            <section className={card} aria-label="S-curve">
              <h2 className="text-base font-bold">Progress over time</h2>
              <SCurveChart points={snap.data.s_curve} today={date} />
            </section>
          </>
        )}
        <section className={`${card} flex flex-col gap-4`} aria-label="Selected day">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-bold">Tasks to complete on {fmtLocalDate(date)}</h2>
            <div className="flex gap-2">
              <Button asChild size="sm" variant="outline"><a href={reportUrl(projectId, date, asOf, "pdf")}><Download aria-hidden /> PDF</a></Button>
              <Button asChild size="sm" variant="outline"><a href={reportUrl(projectId, date, asOf, "docx")}><Download aria-hidden /> Word</a></Button>
            </div>
          </div>
          {day.isPending ? (
            <div className="flex flex-col gap-3" role="status" aria-label="Loading the day">
              <Skeleton className="h-4 w-2/3" />
              <div className="grid grid-cols-3 gap-3"><Skeleton className="h-16" /><Skeleton className="h-16" /><Skeleton className="h-16" /></div>
              <Skeleton className="h-12" /><Skeleton className="h-12" />
            </div>
          ) : day.isError ? <ErrorState error={day.error} onRetry={() => void day.refetch()} /> : <DaySummary d={day.data} />}
        </section>
      </div>
    </>
  );
}
