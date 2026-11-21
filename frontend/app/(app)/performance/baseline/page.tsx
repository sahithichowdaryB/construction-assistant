"use client";

import { AlertTriangle, CalendarDays, FileText, Lightbulb, Loader2, Sparkles, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PerfTabs } from "@/components/performance/perf-tabs";
import { useApp } from "@/components/providers/app-context";
import { EmptyState, ErrorState, PageHeader } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { planFileUrl, planPageUrl, usePlans, usePlanSummary, useUploadPlan, type PlanFile } from "@/lib/performance";
import { localDateOf } from "@/lib/time";
import { cn } from "@/lib/utils";

const card = "rounded-[22px] bg-card p-6";
const rise = "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-500 motion-safe:fill-mode-both";

const planNumber = (title: string) => /^Plan (\d+)/i.exec(title)?.[1] ?? null;
const shortTitle = (title: string) => title.replace(/^Plan \d+:\s*/i, "");

// ---------- plan viewer ----------

/** Opens a plan straight away: the PDF, with its important pages as a strip to jump between. */
function PlanViewer({ plan, onClose }: { plan: PlanFile | null; onClose: () => void }) {
  const { projectId } = useApp();
  const summary = usePlanSummary(plan?.id ?? null);
  const [page, setPage] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const pages = summary.data?.key_pages ?? [];
  const src = plan ? `${planFileUrl(projectId, plan.id)}${page ? `#page=${page}` : ""}` : "";
  return (
    <Dialog open={!!plan} onOpenChange={(o) => { if (!o) { onClose(); setPage(null); setLoaded(false); } }}>
      <DialogContent className="flex h-[90vh] max-w-[calc(100%-2rem)] flex-col gap-3 sm:max-w-6xl">
        {plan && (
          <>
            <DialogTitle className="flex items-center gap-2 pr-10">
              {planNumber(plan.title) && <span className="rounded-lg bg-foreground px-2 py-0.5 text-xs font-bold text-background">Plan {planNumber(plan.title)}</span>}
              {shortTitle(plan.title)}
            </DialogTitle>
            {summary.data?.overview && <p className="line-clamp-2 text-sm text-muted-foreground">{summary.data.overview}</p>}
            <div className="flex min-h-0 flex-1 gap-3">
              {pages.length > 0 && (
                <ul className="hidden w-36 shrink-0 flex-col gap-2 overflow-y-auto md:flex" aria-label="Important pages">
                  {pages.map((k) => (
                    <li key={k.page}>
                      <button type="button" onClick={() => { setPage(k.page); setLoaded(false); }}
                              className={cn("flex w-full flex-col gap-1 rounded-xl p-1.5 text-left transition hover:bg-muted", page === k.page && "bg-muted ring-2 ring-primary")}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={planPageUrl(projectId, plan.id, k.page)} alt={k.caption} loading="lazy" className="aspect-[3/4] w-full rounded-lg border bg-white object-cover object-top" />
                        <span className="line-clamp-2 text-[11px] text-muted-foreground">p. {k.page} · {k.caption}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border bg-muted">
                {!loaded && <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden /> Opening the plan…</div>}
                <iframe key={src} title={plan.title} src={src} className="size-full" onLoad={() => setLoaded(true)} />
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------- plan shelf ----------

function PlanCard({ plan, index, onOpen }: { plan: PlanFile; index: number; onOpen: () => void }) {
  const { projectId } = useApp();
  const [failed, setFailed] = useState(false);
  const n = planNumber(plan.title);
  return (
    <li className={rise} style={{ animationDelay: `${index * 70}ms` }}>
      <button type="button" onClick={onOpen} aria-label={`Open ${plan.title}`}
              className="group relative block aspect-[3/4] w-full overflow-hidden rounded-[20px] bg-muted text-left shadow-sm transition duration-300 hover:-translate-y-1 hover:shadow-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        {/* a stacked-sheets look behind the cover */}
        <span aria-hidden className="absolute inset-x-3 -bottom-1 h-3 rounded-b-xl bg-border" />
        <span className="absolute inset-0 flex items-center justify-center"><FileText className="size-10 text-muted-foreground/40" aria-hidden /></span>
        {!failed && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={planPageUrl(projectId, plan.id, 1)} alt="" loading="lazy" onError={() => setFailed(true)}
               className="absolute inset-0 size-full bg-white object-cover object-top transition-transform duration-500 group-hover:scale-105" />
        )}
        <span aria-hidden className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/20 to-transparent" />
        {n && <span className="absolute top-3 left-3 flex size-9 items-center justify-center rounded-xl bg-primary text-base font-black text-primary-foreground shadow">{n}</span>}
        <span className="absolute inset-x-3 bottom-3 text-sm leading-snug font-bold text-white">{shortTitle(plan.title)}</span>
      </button>
    </li>
  );
}

function UploadButton({ onDone }: { onDone: (plan: PlanFile) => void }) {
  const upload = useUploadPlan();
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input ref={ref} type="file" accept="application/pdf,.pdf" className="hidden" aria-label="Upload a plan (PDF)"
             onChange={(e) => {
               const f = e.target.files?.[0];
               if (f) upload.mutate(f, { onSuccess: onDone });
               e.target.value = "";
             }} />
      <Button size="sm" variant="outline" disabled={upload.isPending} onClick={() => ref.current?.click()} title="Upload a plan (PDF, up to 25 MB)">
        {upload.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Upload aria-hidden />} {upload.isPending ? "Uploading…" : "Upload"}
      </Button>
      {upload.isError && <span className="text-xs text-red-700">{(upload.error as Error).message}</span>}
    </>
  );
}

// ---------- what the plans say ----------

const MONTH: Record<string, number> = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

/** "05 Nov 2026: M3 raft complete" → its date (first day of a range) and the label. */
function parseKeyDate(s: string) {
  const m = /^(\d{1,2})(?:\s*[-–]\s*\d{1,2})?\s+([A-Z][a-z]{2})\s+(\d{4}):\s*(.*)$/.exec(s.trim());
  if (!m || !MONTH[m[2]]) return { iso: null as string | null, when: null as string | null, what: s };
  const iso = `${m[3]}-${String(MONTH[m[2]]).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return { iso, when: s.slice(0, s.indexOf(":")).replace(/ \d{4}$/, ""), what: m[4] };
}

function KeyDates({ items }: { items: string[] }) {
  const { asOf } = useApp();
  const today = localDateOf(asOf);
  const dates = items.map(parseKeyDate).sort((a, b) => (a.iso ?? "9999").localeCompare(b.iso ?? "9999"));
  const next = dates.findIndex((d) => d.iso !== null && d.iso >= today);
  return (
    <section className={cn(card, "flex flex-col gap-4", rise)} style={{ animationDelay: "120ms" }} aria-label="Key dates">
      <h3 className="flex items-center gap-2 text-sm font-bold"><CalendarDays className="size-4 text-info" aria-hidden /> Key dates</h3>
      <ol className="relative flex flex-col gap-4 pl-6">
        <span aria-hidden className="absolute top-1.5 bottom-1.5 left-[5px] w-0.5 rounded-full bg-border" />
        {dates.map((d, i) => {
          const past = d.iso !== null && d.iso < today;
          const isNext = i === next;
          return (
            <li key={i} className="relative">
              <span aria-hidden className={cn("absolute top-1 -left-6 size-3 rounded-full ring-4 ring-card",
                past ? "bg-muted-foreground/40" : isNext ? "bg-primary motion-safe:animate-pulse" : "bg-info")} />
              <p className={cn("text-xs font-semibold tabular", past ? "text-muted-foreground" : isNext ? "text-foreground" : "text-info")}>
                {d.when ?? ""}{isNext && <span className="ml-2 rounded-md bg-primary px-1.5 py-0.5 text-[10px] font-bold text-primary-foreground">NEXT</span>}
              </p>
              <p className={cn("text-sm", past && "text-muted-foreground")}>{d.what}</p>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** Facts and watch-outs in one card, one at a time, so they don't read as two similar lists. */
function PlanNotes({ facts, risks }: { facts: string[]; risks: string[] }) {
  const [tab, setTab] = useState<"facts" | "risks">(facts.length ? "facts" : "risks");
  const items = tab === "facts" ? facts : risks;
  const tabs = [
    { key: "facts" as const, label: "Facts", n: facts.length, Icon: Lightbulb, on: "bg-primary text-primary-foreground" },
    { key: "risks" as const, label: "Watch out", n: risks.length, Icon: AlertTriangle, on: "bg-amber-500 text-white" },
  ].filter((t) => t.n > 0);
  return (
    <section className={cn(card, "flex flex-col gap-4", rise)} style={{ animationDelay: "60ms" }} aria-label="What the plans say">
      <div role="tablist" aria-label="Plan notes" className="flex gap-1 self-start rounded-xl bg-muted p-1">
        {tabs.map(({ key, label, n, Icon, on }) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
                  className={cn("flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold transition", tab === key ? on : "text-muted-foreground hover:text-foreground")}>
            <Icon className="size-4" aria-hidden /> {label} <span className="text-xs opacity-75 tabular">{n}</span>
          </button>
        ))}
      </div>
      <ul key={tab} className="flex flex-col gap-3">
        {items.map((t, i) => (
          <li key={i} className={cn("flex gap-3 rounded-2xl p-3.5 text-sm leading-relaxed", rise, tab === "facts" ? "bg-muted/40" : "bg-amber-50/70 dark:bg-amber-500/10")}
              style={{ animationDelay: `${i * 40}ms` }}>
            {tab === "facts"
              ? <span className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-primary text-xs font-bold text-primary-foreground">{i + 1}</span>
              : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />}
            {t}
          </li>
        ))}
      </ul>
    </section>
  );
}

function AllPlansSummary() {
  const q = usePlanSummary("all");
  if (q.isPending) {
    return (
      <div className={cn(card, "flex flex-col gap-3")} role="status" aria-live="polite">
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden /> Reading all the plans. The first time can take a minute or two.</p>
        <Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-5/6" /><Skeleton className="h-4 w-2/3" />
      </div>
    );
  }
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const s = q.data;
  return (
    <div className="flex flex-col gap-6">
      <section className={cn(card, "relative overflow-hidden", rise)} aria-label="Overview">
        <span aria-hidden className="pointer-events-none absolute -top-16 -right-16 size-56 rounded-full bg-primary/10 blur-2xl" />
        <p className="relative flex items-center gap-2 text-xs font-semibold text-muted-foreground">
          <Sparkles className="size-4 text-warning" aria-hidden /> In short
          <span className="font-normal">· written by the agent; check the plan before acting</span>
        </p>
        <p className="relative mt-3 max-w-4xl text-[15px] leading-relaxed">{s.overview}</p>
      </section>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        {(s.key_points.length > 0 || s.watch_points.length > 0) && <PlanNotes facts={s.key_points} risks={s.watch_points} />}
        {s.key_dates.length > 0 && <KeyDates items={s.key_dates} />}
      </div>
    </div>
  );
}

export default function PlansPage() {
  const list = usePlans();
  const [open, setOpen] = useState<PlanFile | null>(null);
  // Opening a plan from a link elsewhere: /performance/baseline?plan=<id>
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("plan");
    if (id && list.data) setOpen(list.data.plans.find((p) => p.id === id) ?? null);
  }, [list.data]);
  return (
    <>
      <PageHeader title="Performance" description="The plans the project is measured against." />
      <PerfTabs />
      {list.isPending ? (
        <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-5">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="aspect-[3/4] rounded-[20px]" />)}</div>
      ) : list.isError ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : (
        <div className="flex flex-col gap-8">
          <section aria-label="Plans" className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-base font-bold">Plans <span className="font-normal text-muted-foreground">· {list.data.plans.length}</span></h2>
              <div className="flex items-center gap-2"><UploadButton onDone={setOpen} /></div>
            </div>
            {list.data.plans.length ? (
              <ul className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-5">
                {list.data.plans.map((p, i) => <PlanCard key={p.id} plan={p} index={i} onOpen={() => setOpen(p)} />)}
              </ul>
            ) : <EmptyState title="No plans yet" description="Upload the programme to start." />}
          </section>
          {list.data.plans.length > 0 && <AllPlansSummary />}
        </div>
      )}
      <PlanViewer plan={open} onClose={() => setOpen(null)} />
    </>
  );
}
