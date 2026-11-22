"use client";

import { ArrowRight, ChevronRight, FilePen, ClipboardPen, Siren, Sparkles, TriangleAlert, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { alertSummary } from "@/components/alert-card";
import { CitationList } from "@/components/citation-chip";
import { DayPerformanceCard } from "@/components/performance/day-performance-card";
import { ProgressBar } from "@/components/progress-bar";
import { useApp } from "@/components/providers/app-context";
import { SiteIllustration, zoneKeyOf, zoneLabel, type ZoneKey, type ZoneStatus } from "@/components/site-illustration";
import { EmptyState, LoadingSkeleton, QueryState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { USE_FIXTURES } from "@/lib/endpoints";
import { NOTICE_LABEL } from "@/lib/format";
import { useActivities, useIncidents, useToday } from "@/lib/queries";
import { ROLE_PERSON } from "@/lib/roles";
import { ROLE_HOME } from "@/lib/session";
import { fmtDateTime, fmtLocalDate, fmtShort, PROJECT_TZ } from "@/lib/time";
import type { Activity, Incident, TodayBriefing } from "@/lib/types";
import { cn } from "@/lib/utils";

type Task = {
  key: string;
  href: string;
  Icon: LucideIcon;
  tone: "red" | "amber" | "blue";
  eyebrow: string;
  title: string;
  detail: string;
  cta: string;
};

const TONE: Record<Task["tone"], string> = {
  red: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
  blue: "bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300",
};

function greeting(iso: string) {
  const h = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: PROJECT_TZ }).format(new Date(iso)));
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/** Builds the short "needs you" list from what the server returned. Nothing is calculated here. */
/** Incidents reported after the selected time are hidden here so the page matches the clock. */
function knownIncidents(t: TodayBriefing, live: Incident[] | undefined) {
  const list = live ?? t.open_incidents;
  return list
    .filter((i) => i.status !== "resolved" && new Date(i.reported_at).getTime() <= new Date(t.as_of).getTime())
    .sort((a, b) => b.reported_at.localeCompare(a.reported_at));
}

function buildTasks(t: TodayBriefing, byCode: Map<string, Activity>, known: Incident[]): Task[] {
  const tasks: Task[] = [];
  for (const d of t.drafts_awaiting_review) {
    tasks.push({
      key: `d-${d.id}`,
      href: `/drafts/${d.id}`,
      Icon: FilePen,
      tone: "amber",
      eyebrow: NOTICE_LABEL[d.type],
      title: d.title,
      detail: d.open_gaps ? `${d.open_gaps} item${d.open_gaps === 1 ? "" : "s"} to complete before approval` : "Ready for your approval",
      cta: "Review notice",
    });
  }
  for (const i of known) {
    tasks.push({
      key: `i-${i.id}`,
      href: `/incidents/${i.id}`,
      Icon: Siren,
      tone: "red",
      eyebrow: `Incident · reported ${fmtShort(i.reported_at)}`,
      title: i.title,
      detail: i.affected_workers ? `${i.affected_workers} workers affected${i.equipment_id ? ` · ${i.equipment_id}` : ""}` : "Check cause and evidence",
      cta: "Open incident",
    });
  }
  for (const a of [...t.open_alerts].sort((x, y) => (x.severity === "high" ? -1 : 0) - (y.severity === "high" ? -1 : 0))) {
    const act = byCode.get(a.activity_code ?? "");
    tasks.push({
      key: `a-${a.id}`,
      href: `/alerts/${encodeURIComponent(a.id)}`,
      Icon: TriangleAlert,
      tone: a.severity === "high" ? "red" : "amber",
      eyebrow: `${a.activity_code}${act ? ` · ${act.name}` : ""}`,
      title: a.kind === "missing_report" ? "Daily report missing" : "Behind plan",
      detail: alertSummary(a),
      cta: "See deviation",
    });
  }
  return tasks;
}

function zoneStatuses(t: TodayBriefing, byCode: Map<string, Activity>, known: Incident[]): Partial<Record<ZoneKey, ZoneStatus>> {
  const rank: Record<ZoneStatus, number> = { idle: 0, ok: 1, warn: 2, stop: 3 };
  const out: Partial<Record<ZoneKey, ZoneStatus>> = {};
  const bump = (k: ZoneKey | null, s: ZoneStatus) => {
    if (k && rank[s] > rank[out[k] ?? "idle"]) out[k] = s;
  };
  for (const a of t.activities) {
    const s: ZoneStatus = a.severity === "high" ? "stop" : a.severity === "medium" ? "warn" : a.actual !== null ? "ok" : "idle";
    bump(zoneKeyOf(a.zone), s);
  }
  for (const i of known) bump(zoneKeyOf(byCode.get(i.activity_code ?? "")?.zone), "stop");
  return out;
}

/** Live mode: the role's own home (for a site manager, Shortfalls & notices) replaces this fixture-only overview. */
export default function TodayPage() {
  const { role } = useApp();
  const router = useRouter();
  useEffect(() => {
    if (!USE_FIXTURES) router.replace(ROLE_HOME[role]);
  }, [role, router]);
  if (!USE_FIXTURES) return <LoadingSkeleton rows={2} />;
  return <FixtureToday />;
}

function FixtureToday() {
  const today = useToday();
  const activities = useActivities();
  const incidents = useIncidents({ upToAsOf: true });
  const { role } = useApp();
  const byCode = new Map(activities.data?.map((a) => [a.code, a]));
  const firstName = role === "site_manager" ? ROLE_PERSON[role].split(" ")[0] : null;

  return (
    <QueryState query={today} loading={<LoadingSkeleton variant="cards" rows={3} />}>
      {(t) => {
        const known = knownIncidents(t, incidents.data);
        const tasks = buildTasks(t, byCode, known);
        const incident = known[0];
        const worst = [...t.activities].filter((a) => a.severity === "high").sort((x, y) => (y.shortfall_pct ?? 0) - (x.shortfall_pct ?? 0))[0];
        const incZone = incident ? zoneKeyOf(byCode.get(incident.activity_code ?? "")?.zone) : null;
        const pin = incident && incZone
          ? { zone: incZone, title: `${zoneLabel(incZone)} · ${incident.equipment_id ?? "work stopped"}`, subtitle: incident.title }
          : worst && zoneKeyOf(worst.zone)
            ? { zone: zoneKeyOf(worst.zone)!, title: `${worst.code} behind plan`, subtitle: worst.shortfall_pct !== null ? `${Math.round(worst.shortfall_pct)}% short · ${worst.name}` : worst.name }
            : null;
        const shown = tasks.slice(0, 3);
        return (
          <div className="flex flex-col gap-8">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <p className="text-sm text-muted-foreground">{fmtLocalDate(t.work_date)}</p>
                <h1 className="text-2xl font-bold md:text-[28px]">
                  {greeting(t.as_of)}
                  {firstName ? `, ${firstName}` : ""}
                </h1>
              </div>
              <p className="text-xs text-muted-foreground">Showing records up to {fmtDateTime(t.as_of)}</p>
            </div>

            {/* Hero */}
            <section className="relative overflow-hidden rounded-[28px] bg-hero text-hero-foreground">
              <div className="grid items-center gap-2 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
                <div className="flex flex-col gap-5 p-7 md:p-10">
                  <span className="inline-flex items-center gap-2 text-sm font-semibold text-primary">
                    <span className="size-2 rounded-full bg-primary" aria-hidden /> Today on site
                  </span>
                  <div>
                    <p className="text-5xl font-semibold tabular md:text-6xl">
                      {tasks.length}
                      <span className="ml-3 align-middle text-xl font-semibold md:text-2xl">
                        {tasks.length === 1 ? "thing needs you" : "things need you"}
                      </span>
                    </p>
                    <p className="mt-4 max-w-md text-base leading-relaxed text-hero-muted md:text-lg">{t.briefing.headline}</p>
                  </div>
                  <div className="flex flex-wrap gap-3">
                    {shown[0] && (
                      <Button asChild size="touch" className="h-12 rounded-2xl px-5 text-[15px] md:h-12 md:px-5">
                        <Link href={shown[0].href}>
                          {shown[0].cta} <ArrowRight aria-hidden />
                        </Link>
                      </Button>
                    )}
                    {role === "foreman" && <Button asChild size="touch" variant="ghost" className="h-12 rounded-2xl bg-white/10 px-5 text-[15px] text-white hover:bg-white/15 hover:text-white md:h-12 md:px-5">
                      <Link href="/capture">
                        <ClipboardPen aria-hidden /> Add a site note
                      </Link>
                    </Button>}
                  </div>
                </div>
                <div className="px-4 pb-6 lg:px-6 lg:py-6">
                  <SiteIllustration
                    status={zoneStatuses(t, byCode, known)}
                    pin={pin}
                  />
                </div>
              </div>
            </section>

            {/* Needs you today */}
            <section className="flex flex-col gap-4">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="text-lg font-bold">Needs you today</h2>
                {tasks.length > 3 && (
                  <Link href="/alerts" className="text-sm font-medium text-muted-foreground hover:text-foreground">
                    See all {tasks.length}
                  </Link>
                )}
              </div>
              {shown.length ? (
                <div className={cn("grid gap-4", shown.length === 2 ? "md:grid-cols-2" : "md:grid-cols-3")}>
                  {shown.map((task, i) => (
                    <Link
                      key={task.key}
                      href={task.href}
                      className="group flex flex-col gap-4 rounded-[22px] bg-card p-5 shadow-[0_1px_2px_rgba(17,18,20,0.04)] transition hover:-translate-y-0.5 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:p-6"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className={cn("flex size-11 items-center justify-center rounded-2xl", TONE[task.tone])}>
                          <task.Icon className="size-5" aria-hidden />
                        </span>
                        <span className="truncate text-xs text-muted-foreground">{task.eyebrow}</span>
                      </div>
                      <div className="min-w-0">
                        <p className="text-[17px] leading-snug font-semibold">{task.title}</p>
                        <p className="mt-1 text-sm text-muted-foreground">{task.detail}</p>
                      </div>
                      <span
                        className={cn(
                          "mt-auto inline-flex w-fit items-center gap-1.5 rounded-xl px-3.5 py-2 text-sm font-semibold transition-colors",
                          i === 0 ? "bg-primary text-primary-foreground" : "bg-secondary group-hover:bg-muted",
                        )}
                      >
                        {task.cta} <ChevronRight className="size-4" aria-hidden />
                      </span>
                    </Link>
                  ))}
                </div>
              ) : (
                <EmptyState title="Nothing needs you right now" description="Every activity is on track and no notices are waiting." />
              )}
            </section>

            {/* Day performance against the plan (server-computed daily evaluation) */}
            {!USE_FIXTURES && <DayPerformanceCard date={t.work_date} />}

            {/* Details, one level down */}
            <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <div className="rounded-[22px] bg-card p-5 md:p-6">
                <h2 className="flex items-center gap-2 text-base font-bold">
                  <Sparkles className="size-4 text-warning" aria-hidden /> Briefing
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">Written from the diary, reports, minutes and emails. Tap a source to check it.</p>
                {t.briefing.bullets.length ? (
                  <ul className="mt-4 flex flex-col gap-3">
                    {t.briefing.bullets.map((b, i) => (
                      <li key={i} className="flex gap-3">
                        <span className="mt-2 size-1.5 shrink-0 rounded-full bg-foreground/40" aria-hidden />
                        <div className="flex min-w-0 flex-col gap-1.5 text-sm">
                          <span>{b.text}</span>
                          <CitationList refs={b.refs} />
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-4 text-sm text-muted-foreground">No briefing items for this time.</p>
                )}
              </div>

              <div className="rounded-[22px] bg-card p-5 md:p-6">
                <div className="flex items-baseline justify-between">
                  <h2 className="text-base font-bold">Programme today</h2>
                  <Link href="/schedule" className="text-sm font-medium text-muted-foreground hover:text-foreground">
                    Open programme
                  </Link>
                </div>
                {t.activities.length ? (
                  <ul className="mt-3 flex flex-col divide-y">
                    {t.activities.map((a) => (
                      <li key={a.code} className="py-3">
                        <Link href={`/schedule?code=${encodeURIComponent(a.code)}&date=${t.work_date}`} className="mb-1.5 flex items-center justify-between gap-2 text-sm hover:underline">
                          <span className="min-w-0 truncate">
                            <span className="font-mono text-xs font-semibold">{a.code}</span> <span className="font-medium">{a.name}</span>
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">zone {a.zone}</span>
                        </Link>
                        <ProgressBar planned={a.planned} actual={a.actual} unit={a.unit} basis={a.basis} shortfallPct={a.shortfall_pct} severity={a.severity} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyState className="mt-4" title="No activities scheduled" description="The programme has no planned work on this date." />
                )}
              </div>
            </section>
          </div>
        );
      }}
    </QueryState>
  );
}
