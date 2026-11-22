"use client";

import { AlertTriangle, Box, CalendarClock, CheckCircle2, FileUp, HelpCircle } from "lucide-react";
import { PerfTabs } from "@/components/performance/perf-tabs";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CitationList } from "@/components/citation-chip";
import { DisclaimerBanner } from "@/components/disclaimer-banner";
import { Legend } from "@/components/model3d/building-viewer";
import { TimelineSlider } from "@/components/model3d/timeline-slider";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader } from "@/components/states";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import {
  activityColour,
  actualStatesAt,
  plannedStatesAt,
  useActiveModel,
  useModelProgress,
  useModelTimeline,
  WHY_LABEL,
  type ModelView,
  type Progress,
  type Timeline,
  type ViewMode,
} from "@/lib/model3d";
import { toRefs } from "@/lib/performance";
import { fmtLocalDate } from "@/lib/time";
import { cn } from "@/lib/utils";

const BuildingViewer = dynamic(() => import("@/components/model3d/building-viewer").then((m) => m.BuildingViewer), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading 3D view…</div>,
});

const DISCLAIMER_3D =
  "Progress model generated from the 2D structural drawings: simplified boxes, not for construction. The drawings govern. " +
  "Progress comes from signed daily reports and confirmed site records in SiteMate.";

function DeadlineBanner({ p }: { p: Progress }) {
  const s = p.summary;
  const late = s.status === "late";
  const n = Math.abs(s.late_working_days ?? 0);
  return (
    <section className={cn("flex flex-col gap-3 rounded-[22px] p-5 md:flex-row md:items-center md:justify-between md:p-6",
                           late ? "bg-red-50 text-red-950 dark:bg-red-950/40 dark:text-red-100" : "bg-emerald-50 text-emerald-950 dark:bg-emerald-950/40 dark:text-emerald-100")}
             aria-label="Deadline check">
      <div className="flex items-start gap-3">
        {late ? <AlertTriangle className="mt-0.5 size-6 shrink-0" aria-hidden /> : <CheckCircle2 className="mt-0.5 size-6 shrink-0" aria-hidden />}
        <div>
          <p className="text-lg font-bold">
            {s.status === null ? "No deadline set" : late ? `${n} working day${n === 1 ? "" : "s"} late` : n === 0 ? "On time" : `${n} working day${n === 1 ? "" : "s"} early`}
          </p>
          <p className="text-sm">
            Forecast finish <strong>{fmtLocalDate(s.forecast_completion)}</strong> · deadline <strong>{fmtLocalDate(p.deadline)}</strong>
            {s.late_calendar_days
              ? ` · ${Math.abs(s.late_calendar_days)} calendar day${Math.abs(s.late_calendar_days) === 1 ? "" : "s"} ${s.late_calendar_days > 0 ? "after" : "before"}`
              : ""}
          </p>
        </div>
      </div>
      {p.why.length > 0 && (
        <Button variant={late ? "default" : "secondary"} size="sm" onClick={() => document.getElementById("why")?.scrollIntoView({ behavior: "smooth" })}>
          <HelpCircle aria-hidden /> Why?
        </Button>
      )}
    </section>
  );
}

function Kpis({ p }: { p: Progress }) {
  const s = p.summary;
  const tile = (label: string, value: string, sub?: React.ReactNode) => (
    <div className="flex flex-col gap-1 rounded-[22px] bg-card p-4 md:p-5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold tabular">{value}</p>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {tile("Built (signed)", `${s.pct_built}%`, `${Math.round(s.built_m3)} of ${Math.round(s.total_m3)} m³ concrete`)}
      {tile("Planned by today", `${s.pct_planned}%`, s.behind_m3 > 0 ? `${Math.round(s.behind_m3)} m³ behind the plan` : "on or ahead of the plan")}
      {tile("Pours", `${s.counts.built ?? 0} / ${(s.counts.built ?? 0) + (s.counts.in_progress ?? 0) + (s.counts.not_started ?? 0)}`,
            `${s.counts.in_progress ?? 0} in progress · ${s.counts.not_started ?? 0} not started`)}
      {tile("Last record", s.last_update ? fmtLocalDate(s.last_update.date) : "–",
            s.last_update ? <CitationList refs={toRefs([s.last_update.ref])} /> : "no report yet")}
    </div>
  );
}

function ElementPanel({ id, model, progress, states }: { id: string; model: ModelView; progress: Progress; states: ReturnType<typeof actualStatesAt> }) {
  const e = model.elements.find((x) => x.id === id);
  if (!e) return null;
  const pour = model.pours.find((p) => p.id === e.pour);
  const now = progress.actual[e.pour];
  const shown = states[e.pour];
  const f = progress.forecast[e.pour];
  return (
    <section className="rounded-[22px] bg-card p-5" aria-label="Selected element">
      <p className="text-xs font-medium text-muted-foreground">Selected element</p>
      <p className="mt-1 font-semibold">{e.mark ?? e.kind} <span className="font-normal text-muted-foreground">· {e.kind} · level {e.level}</span></p>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Activity</dt><dd className="font-mono text-xs">{e.activity}</dd>
        <dt className="text-muted-foreground">Pour</dt><dd className="font-mono text-xs">{e.pour} · {pour?.m3} m³</dd>
        {pour?.tracked === false ? (
          <><dt className="text-muted-foreground">Progress</dt><dd>Not tracked: the plan has no m³ activity for it</dd></>
        ) : (
          <>
            <dt className="text-muted-foreground">On the slider date</dt><dd>{shown ? `${shown.status.replace("_", " ")} ${shown.status === "in_progress" ? `(${shown.pct}%)` : ""}` : "–"}</dd>
            <dt className="text-muted-foreground">Planned pour</dt><dd>{fmtLocalDate(pour?.planned)}</dd>
            <dt className="text-muted-foreground">{now?.finished ? "Poured" : "Forecast"}</dt>
            <dd>{fmtLocalDate(now?.finished ?? f?.date)}{f && f.slip_wd > 0 ? <span className="text-red-700"> (+{f.slip_wd} wd)</span> : null}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Volume (model)</dt><dd className="tabular">{e.volume_m3} m³</dd>
      </dl>
      <div className="mt-3"><p className="mb-1 text-xs text-muted-foreground">Recorded in</p><CitationList refs={toRefs(now?.refs)} /></div>
    </section>
  );
}

function ActivityTable({ p, order }: { p: Progress; order: string[] }) {
  return (
    <section className="rounded-[22px] bg-card p-5 md:p-6" aria-label="Activities">
      <h2 className="text-base font-bold">Levels and activities</h2>
      <ul className="mt-3 flex flex-col divide-y">
        {p.activities.map((a) => {
          const pct = a.total_m3 ? Math.min(100, (100 * a.done_m3) / a.total_m3) : 0;
          const plannedPct = a.total_m3 ? Math.min(100, (100 * a.planned_m3) / a.total_m3) : 0;
          return (
            <li key={a.code} className="flex flex-col gap-1.5 py-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="size-3 shrink-0 rounded-sm" style={{ background: activityColour(a.code, order) }} aria-hidden />
                  <span className="font-mono text-xs font-semibold">{a.code}</span>
                  <span className="truncate">{a.name}</span>
                </span>
                <span className="text-xs text-muted-foreground tabular">
                  {Math.round(a.done_m3)} / {Math.round(a.total_m3)} m³ · planned finish {fmtLocalDate(a.planned_finish)} · forecast {fmtLocalDate(a.forecast_finish)}
                  {a.variance_wd ? <span className={a.variance_wd > 0 ? "font-semibold text-red-700" : "text-emerald-700"}> ({a.variance_wd > 0 ? "+" : ""}{a.variance_wd} wd)</span> : null}
                </span>
              </div>
              <div className="relative h-2 overflow-hidden rounded-full bg-muted" role="img" aria-label={`${Math.round(pct)}% built, ${Math.round(plannedPct)}% planned`}>
                <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${pct}%`, background: activityColour(a.code, order) }} />
                <div className="absolute inset-y-0 w-0.5 bg-foreground" style={{ left: `${plannedPct}%` }} />
              </div>
              {p.tasks?.[a.code] ? (
                <ul className="flex flex-wrap gap-1.5 pt-0.5" aria-label={`Tasks of ${a.code}`}>
                  {p.tasks[a.code].map((t) => (
                    <li key={t.code} title={t.note ?? `${t.name ?? t.code}: ${t.pct_done}% done, ${t.pct_planned}% planned`}
                        className={cn("rounded-full px-2 py-0.5 text-[11px] tabular",
                          t.pct_done === null ? "bg-muted text-muted-foreground line-through"
                            : t.pct_done >= 100 ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300"
                            : t.pct_done < (t.pct_planned ?? 0) ? "bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300"
                            : "bg-muted")}>
                      <span className="font-mono">{t.code}</span> {t.pct_done === null ? "no plan" : `${Math.round(t.pct_done)}%`}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">
        Bar: built (signed). Black tick: planned by today.{p.tasks && Object.keys(p.tasks).length ? " A level with tasks is as complete as the average of its tasks (red: behind plan, green: done); the others follow the programme." : ""}
      </p>
    </section>
  );
}

function Why({ p }: { p: Progress }) {
  return (
    <section id="why" className="scroll-mt-24 rounded-[22px] bg-card p-5 md:p-6" aria-label="Why">
      <h2 className="text-base font-bold">Why {p.summary.status === "late" ? "it will finish late" : "it deviates from the plan"}</h2>
      <p className="mt-1 text-xs text-muted-foreground">From the database: signed reports, confirmed site events and the drawings. Tap a source to read it.</p>
      {p.why.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">Nothing recorded: the site is on plan.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {p.why.map((w, i) => (
            <li key={i} className={cn("flex flex-col gap-1 rounded-xl px-3 py-2 text-sm",
                                      w.kind === "behind" || w.kind === "late_start" || w.kind === "late_pour" ? "bg-red-50 text-red-950 dark:bg-red-950/30 dark:text-red-100"
                                        : w.kind === "plan_conflict" ? "bg-amber-50 text-amber-950 dark:bg-amber-950/30 dark:text-amber-100" : "bg-muted")}>
              <span className="text-[11px] font-semibold tracking-wide uppercase opacity-80">{WHY_LABEL[w.kind]}</span>
              <span>{w.text}</span>
              {w.refs.length > 0 && <CitationList refs={toRefs(w.refs)} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ModelScreen({ model, progress, timeline }: { model: ModelView; progress: Progress; timeline: Timeline }) {
  const [date, setDate] = useState(progress.date);
  const [mode, setMode] = useState<ViewMode>("actual");
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => setDate(progress.date), [progress.date]);

  // level activities first, then activities that only some pours carry (e.g. foundations zone B)
  const order = useMemo(
    () => [...new Set([...model.levels.map((l) => l.activity), ...model.pours.filter((p) => p.tracked !== false).map((p) => p.activity)])],
    [model.levels, model.pours],
  );
  const colours = useMemo(() => Object.fromEntries(order.map((c) => [c, activityColour(c, order)])), [order]);
  const pourIds = useMemo(() => model.pours.filter((p) => p.tracked !== false).map((p) => p.id), [model.pours]);
  const actual = useMemo(() => actualStatesAt(date, progress, timeline, pourIds), [date, progress, timeline, pourIds]);
  const planned = useMemo(() => plannedStatesAt(date, timeline, pourIds), [date, timeline, pourIds]);
  const states = mode === "planned" ? planned : actual;
  const builtNow = Object.values(states).filter((s) => s.status === "built").length;

  return (
    <div className="flex flex-col gap-4">
      <DeadlineBanner p={progress} />
      <Kpis p={progress} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <section className="flex flex-col gap-3 rounded-[22px] bg-card p-4 md:p-5" aria-label="3D model">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="inline-flex rounded-xl bg-muted p-1" role="tablist" aria-label="View">
              {(["actual", "planned", "compare"] as ViewMode[]).map((m) => (
                <button key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)}
                        className={cn("rounded-lg px-3 py-1.5 text-sm font-medium capitalize", mode === m ? "bg-background shadow-sm" : "text-muted-foreground")}>
                  {m}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{builtNow} of {pourIds.length} pours {mode === "planned" ? "planned complete" : "built"} on {fmtLocalDate(date)} · drag to rotate, scroll to zoom</p>
          </div>
          <BuildingViewer className="h-[380px] w-full overflow-hidden rounded-2xl bg-gradient-to-b from-sky-50 to-white md:h-[520px] dark:from-slate-900 dark:to-slate-950"
                          elements={model.elements} states={states} planned={mode === "compare" ? planned : undefined} mode={mode}
                          colours={colours} selected={selected} onSelect={setSelected} />
          <Legend mode={mode} future={mode !== "planned" && date > progress.date} />
          <TimelineSlider timeline={timeline} date={date} onChange={setDate} />
        </section>
        <aside className="flex flex-col gap-4">
          {selected ? (
            <ElementPanel id={selected} model={model} progress={progress} states={states} />
          ) : (
            <section className="rounded-[22px] bg-card p-5 text-sm text-muted-foreground">
              <p className="font-medium text-foreground">Tap an element</p>
              <p className="mt-1">See its pour, planned and actual date, and the report that recorded it.</p>
            </section>
          )}
          <section className="rounded-[22px] bg-card p-5 text-sm">
            <p className="flex items-center gap-2 font-medium"><CalendarClock className="size-4" aria-hidden /> Deadline</p>
            <p className="mt-1 text-2xl font-semibold tabular">{fmtLocalDate(model.deadline)}</p>
            <p className="mt-1 text-xs text-muted-foreground">Entered with the drawings ({model.title}). Change it on the drawings page.</p>
          </section>
        </aside>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <ActivityTable p={progress} order={order} />
        <Why p={progress} />
      </div>
      <DisclaimerBanner text={DISCLAIMER_3D} />
    </div>
  );
}

export default function ModelPage() {
  const model = useActiveModel();
  const ready = model.isSuccess;
  const progress = useModelProgress(ready);
  const timeline = useModelTimeline(ready);
  const header = (
    <>
      <PageHeader title="Performance"
                  description="The structure from the 2D structural drawings, completed level by level as its tasks are completed."
                  actions={<Button asChild variant="secondary" size="sm"><Link href="/performance/model/upload"><FileUp aria-hidden /> Drawings & deadline</Link></Button>} />
      <PerfTabs />
    </>
  );
  if (model.isError) {
    const status = model.error instanceof ApiError ? model.error.status : 0;
    return (
      <>
        {header}
        {status === 404 ? (
          <EmptyState icon={<Box />} title="No 3D model yet"
                      description="Upload the 2D structural drawings and enter the deadline. SiteMate reads the drawings, you check them, and the 3D model appears here."
                      action={<Button asChild size="sm"><Link href="/performance/model/upload"><FileUp aria-hidden /> Upload drawings</Link></Button>} />
        ) : status === 503 ? (
          <EmptyState icon={<Box />} title="3D model not installed on the server" description={(model.error as Error).message} />
        ) : (
          <ErrorState error={model.error} onRetry={() => model.refetch()} />
        )}
      </>
    );
  }
  if (!ready || progress.isPending || timeline.isPending) return <>{header}<LoadingSkeleton variant="cards" rows={3} /></>;
  if (progress.isError) return <>{header}<ErrorState error={progress.error} onRetry={() => progress.refetch()} /></>;
  if (timeline.isError) return <>{header}<ErrorState error={timeline.error} onRetry={() => timeline.refetch()} /></>;
  return <>{header}<ModelScreen model={model.data} progress={progress.data} timeline={timeline.data} /></>;
}
