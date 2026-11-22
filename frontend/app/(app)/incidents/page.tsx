"use client";

import { ChevronRight, CircleDot, Droplets, HeartPulse, Search, Siren, Truck, Wrench, X, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useApp } from "@/components/providers/app-context";
import { EmptyState, LoadingSkeleton, PageHeader, QueryState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { INCIDENT_TYPE_LABEL } from "@/lib/format";
import { useCategoryLabel, useIncidents } from "@/lib/queries";
import { fmtDateTime, fmtTime, localDateOf } from "@/lib/time";
import type { Incident } from "@/lib/types";
import { cn } from "@/lib/utils";

type Status = "open" | "resolved" | "all";
type Scope = "all" | "day" | "cutoff";

const FINISHED = new Set<Incident["status"]>(["resolved", "closed"]);
/** "Open" covers everything not yet resolved: new, being monitored after a repair, or awaiting confirmation. */
const matches = (i: Incident, f: Status) => (f === "all" ? true : f === "resolved" ? FINISHED.has(i.status) : !FINISHED.has(i.status));

type Look = { Icon: LucideIcon; bar: string; tile: string; ink: string };
const CATEGORY: Record<string, Look> = {
  safety: { Icon: HeartPulse, bar: "bg-red-500", tile: "bg-red-50 dark:bg-red-500/15", ink: "text-red-600 dark:text-red-300" },
  equipment: { Icon: Wrench, bar: "bg-amber-500", tile: "bg-amber-50 dark:bg-amber-500/15", ink: "text-amber-700 dark:text-amber-300" },
  quality: { Icon: Droplets, bar: "bg-sky-500", tile: "bg-sky-50 dark:bg-sky-500/15", ink: "text-sky-700 dark:text-sky-300" },
  delivery: { Icon: Truck, bar: "bg-violet-500", tile: "bg-violet-50 dark:bg-violet-500/15", ink: "text-violet-700 dark:text-violet-300" },
};
const OTHER: Look = { Icon: CircleDot, bar: "bg-stone-400", tile: "bg-muted", ink: "text-muted-foreground" };
const lookOf = (c: string | null | undefined) => (c && CATEGORY[c]) || OTHER;

const SEV: Record<string, { stripe: string; label: string; pill: string }> = {
  critical: { stripe: "bg-red-600", label: "Critical", pill: "bg-red-600 text-white" },
  high: { stripe: "bg-red-500", label: "High", pill: "bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300" },
  medium: { stripe: "bg-amber-500", label: "Medium", pill: "bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300" },
  low: { stripe: "bg-sky-400", label: "Low", pill: "bg-sky-50 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300" },
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDay = (iso: string) => {
  const d = localDateOf(iso);
  return `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
};
/** First clause of the summary, so each row reads as a headline. */
const headline = (t: string) => t.split(/[;.]\s/)[0].replace(/[.;]$/, "").trim();

const PAGE = 10;

function Tile({ value, label, tone, onClick, active }: { value: number; label: string; tone: string; onClick?: () => void; active?: boolean }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
            className={cn("flex flex-col gap-1 rounded-2xl bg-card px-4 py-3 text-left transition hover:-translate-y-0.5", active && "ring-2 ring-foreground")}>
      <span className={cn("text-2xl leading-none font-bold tabular", tone)}>{value}</span>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
    </button>
  );
}

export default function IncidentsPage() {
  const { asOf } = useApp();
  const [status, setStatus] = useState<Status>("open");
  const [scope, setScope] = useState<Scope>("all");
  const [category, setCategory] = useState<string | null>(null);
  const [highOnly, setHighOnly] = useState(false);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const incidents = useIncidents({ upToAsOf: scope !== "all" });
  const categoryLabel = useCategoryLabel();
  const today = localDateOf(asOf);

  const inScope = useMemo(() => {
    const all = incidents.data ?? [];
    if (scope !== "day") return all;
    return all.filter((i) => [i.occurred_at, i.reported_at, ...i.timeline.map((e) => e.at)].some((t) => t && localDateOf(t) === today));
  }, [incidents.data, scope, today]);

  const reset = () => setPage(0);
  const ql = q.trim().toLowerCase();
  const shown = inScope
    .filter((i) => matches(i, status))
    .filter((i) => !category || (i.category ?? "other") === category)
    .filter((i) => !highOnly || i.severity === "high" || i.severity === "critical")
    .filter((i) => !ql || [i.summary, i.title, i.zone, i.activity_code, i.equipment_id].some((v) => v?.toLowerCase().includes(ql)))
    .sort((a, b) => (b.occurred_at ?? b.reported_at).localeCompare(a.occurred_at ?? a.reported_at));

  const open = inScope.filter((i) => matches(i, "open"));
  const cats = [...new Set(inScope.map((i) => i.category ?? "other"))]
    .map((c) => ({ key: c, n: inScope.filter((i) => (i.category ?? "other") === c).length }))
    .sort((a, b) => b.n - a.n);
  const pages = Math.ceil(shown.length / PAGE);

  return (
    <>
      <PageHeader
        title="Incident insights"
        description={scope === "cutoff" ? `Incidents reported by ${fmtDateTime(asOf)}.` : "What went wrong on site, how serious it is, and where it stands."}
      />
      <QueryState
        query={incidents}
        loading={<LoadingSkeleton variant="cards" rows={3} />}
        empty={<EmptyState icon={<Siren />} title="No incidents reported" description="Incidents reported from site notes appear here." />}
      >
        {() => (
          <div className="flex flex-col gap-6">
            {/* At a glance */}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Tile value={open.length} label="Open" tone="text-red-600 dark:text-red-400" active={status === "open" && !highOnly}
                    onClick={() => { setStatus("open"); setHighOnly(false); reset(); }} />
              <Tile value={open.filter((i) => i.severity === "high" || i.severity === "critical").length} label="High severity, open" tone="text-red-600 dark:text-red-400"
                    active={highOnly} onClick={() => { setStatus("open"); setHighOnly(!highOnly); reset(); }} />
              <Tile value={inScope.filter((i) => localDateOf(i.reported_at) === today).length} label="Reported today" tone="text-foreground"
                    active={scope === "day"} onClick={() => { setScope(scope === "day" ? "all" : "day"); reset(); }} />
              <Tile value={inScope.filter((i) => FINISHED.has(i.status)).length} label="Resolved" tone="text-emerald-700 dark:text-emerald-400"
                    active={status === "resolved"} onClick={() => { setStatus(status === "resolved" ? "open" : "resolved"); setHighOnly(false); reset(); }} />
            </div>

            {/* By category: one bar that is also the filter */}
            {cats.length > 0 && (
              <section className="flex flex-col gap-3 rounded-2xl bg-card p-4" aria-label="Incidents by category">
                <div className="flex h-3 overflow-hidden rounded-full">
                  {cats.map((c) => (
                    <span key={c.key} className={cn("h-full transition-opacity", lookOf(c.key).bar, category && category !== c.key && "opacity-25")}
                          style={{ width: `${(c.n / inScope.length) * 100}%` }} title={`${categoryLabel(c.key) || "Other"}: ${c.n}`} />
                  ))}
                </div>
                <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by category">
                  {cats.map((c) => {
                    const look = lookOf(c.key);
                    const on = category === c.key;
                    return (
                      <button key={c.key} type="button" aria-pressed={on} onClick={() => { setCategory(on ? null : c.key); reset(); }}
                              className={cn("flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold capitalize transition", on ? "bg-foreground text-background" : cn(look.tile, look.ink, "hover:opacity-80"))}>
                        <look.Icon className="size-3.5" aria-hidden /> {categoryLabel(c.key) || "Other"} <span className="tabular opacity-70">{c.n}</span>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Filters */}
            <div className="flex flex-wrap items-center gap-2">
              <div role="group" aria-label="Status" className="flex rounded-xl bg-muted p-1 text-sm font-semibold">
                {(["open", "resolved", "all"] as const).map((s) => (
                  <button key={s} type="button" aria-pressed={status === s} onClick={() => { setStatus(s); reset(); }}
                          className={cn("rounded-lg px-3 py-1.5 capitalize", status === s ? "bg-card shadow-xs" : "text-muted-foreground")}>{s}</button>
                ))}
              </div>
              <div role="group" aria-label="Dates" className="flex rounded-xl bg-muted p-1 text-sm font-semibold">
                {([["all", "All dates"], ["day", "Today"], ["cutoff", "By selected time"]] as const).map(([s, l]) => (
                  <button key={s} type="button" aria-pressed={scope === s} onClick={() => { setScope(s); reset(); }}
                          className={cn("rounded-lg px-3 py-1.5", scope === s ? "bg-card shadow-xs" : "text-muted-foreground")}>{l}</button>
                ))}
              </div>
              <div className="relative ml-auto w-full sm:w-64">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input aria-label="Search incidents" placeholder="Search incidents…" value={q} onChange={(e) => { setQ(e.target.value); reset(); }}
                       className="h-10 rounded-xl border-0 bg-card pl-9" />
                {q && (
                  <button type="button" aria-label="Clear search" onClick={() => setQ("")} className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-muted">
                    <X className="size-3.5" aria-hidden />
                  </button>
                )}
              </div>
            </div>

            {/* Incidents */}
            {!shown.length ? (
              <EmptyState title="No incidents match" description="Try another status, date or category."
                          action={<Button variant="outline" onClick={() => { setStatus("all"); setScope("all"); setCategory(null); setHighOnly(false); setQ(""); }}>Show all incidents</Button>} />
            ) : (
              <>
                <ul key={`${status}-${scope}-${category}-${highOnly}-${page}`} className="flex flex-col gap-2" aria-label="Incidents">
                  {shown.slice(page * PAGE, page * PAGE + PAGE).map((i, idx) => {
                    const look = lookOf(i.category);
                    const sev = i.severity ? SEV[i.severity] : undefined;
                    const when = i.occurred_at ?? i.reported_at;
                    const done = FINISHED.has(i.status);
                    return (
                      <li key={i.id} className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-300 motion-safe:fill-mode-both"
                          style={{ animationDelay: `${idx * 30}ms` }}>
                        <Link href={`/incidents/${encodeURIComponent(i.id)}`}
                              className="group relative flex items-center gap-3 overflow-hidden rounded-2xl bg-card py-3 pr-3 pl-4 transition hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                          <span aria-hidden className={cn("absolute inset-y-0 left-0 w-1", sev?.stripe ?? "bg-border")} />
                          <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl", look.tile, look.ink)}><look.Icon className="size-5" aria-hidden /></span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-semibold group-hover:underline">{headline(i.summary ?? i.title)}</span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {i.category ? categoryLabel(i.category) : INCIDENT_TYPE_LABEL[i.type]}
                              {i.zone && <> · {i.zone.replace(/^zone /i, "Zone ")}</>}
                              {i.equipment_id && <> · {i.equipment_id}</>}
                              {(i.report_count ?? 0) > 1 && <> · {i.report_count} reports</>}
                            </span>
                          </span>
                          {sev && <span className={cn("hidden shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold sm:inline", sev.pill)}>{sev.label}</span>}
                          <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold", done ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300" : "bg-muted text-foreground")}>
                            {done ? "Resolved" : i.status === "monitoring" ? "Monitoring" : "Open"}
                          </span>
                          <span className="w-12 shrink-0 text-right text-xs font-semibold text-muted-foreground tabular">
                            {localDateOf(when) === today ? fmtTime(when) : shortDay(when)}
                          </span>
                          <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
                        </Link>
                      </li>
                    );
                  })}
                </ul>
                {pages > 1 && (
                  <nav aria-label="Pages" className="flex items-center justify-center gap-1">
                    <button type="button" className="h-8 min-w-8 rounded-lg px-2 text-sm font-semibold hover:bg-muted disabled:opacity-30" disabled={page === 0} onClick={() => setPage(page - 1)} aria-label="Previous page">‹</button>
                    {Array.from({ length: pages }, (_, n) => (
                      <button key={n} type="button" aria-current={n === page ? "page" : undefined} onClick={() => setPage(n)}
                              className={cn("h-8 min-w-8 rounded-lg px-2 text-sm font-semibold tabular", n === page ? "bg-foreground text-background" : "hover:bg-muted")}>{n + 1}</button>
                    ))}
                    <button type="button" className="h-8 min-w-8 rounded-lg px-2 text-sm font-semibold hover:bg-muted disabled:opacity-30" disabled={page === pages - 1} onClick={() => setPage(page + 1)} aria-label="Next page">›</button>
                    <span className="ml-3 text-xs text-muted-foreground tabular">{page * PAGE + 1}–{Math.min(shown.length, page * PAGE + PAGE)} of {shown.length}</span>
                  </nav>
                )}
              </>
            )}
          </div>
        )}
      </QueryState>
    </>
  );
}
