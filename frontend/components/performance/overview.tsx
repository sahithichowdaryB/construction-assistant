"use client";

import { ArrowRight, Truck, Wrench } from "lucide-react";
import Link from "next/link";
import type { DailyEvaluation, Snapshot } from "@/lib/performance";
import { fmtLocalDate } from "@/lib/time";
import { cn } from "@/lib/utils";

type Metrics = Snapshot["metrics"];
type Activity = Metrics["activities"][number];

const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
const card = "rounded-[22px] bg-card p-6";

/** ① Are we on time? ② How much is done? ③ Is it getting better? — straight from the snapshot. */
function Questions({ m }: { m: Metrics }) {
  const v = m.completion_variance_days ?? 0;
  const onTime = m.overall_status === "delayed" ? { text: `No · +${days(v)}`, tone: "text-red-600 dark:text-red-400" }
    : m.overall_status === "at_risk" ? { text: "At risk", tone: "text-amber-700 dark:text-amber-400" }
    : m.overall_status === "ahead" ? { text: v < 0 ? `Yes · ${days(-v)} early` : "Yes, ahead", tone: "text-emerald-700 dark:text-emerald-400" }
    : { text: "Yes", tone: "text-emerald-700 dark:text-emerald-400" };

  const actual = m.weighted_actual_pct;
  const planned = m.weighted_planned_pct;

  const weeks = m.weekly.slice(-3);
  const last = weeks.at(-1)?.score;
  const prev = weeks.at(-2)?.score;
  const trend = last === undefined || prev === undefined ? { text: "Too early", tone: "text-muted-foreground" }
    : last >= 0 && last >= prev ? { text: "Yes", tone: "text-emerald-700 dark:text-emerald-400" }
    : last > prev ? { text: "Slightly", tone: "text-amber-700 dark:text-amber-400" }
    : { text: "No", tone: "text-red-600 dark:text-red-400" };
  const lo = Math.min(...weeks.map((w) => w.score), 0);
  const hi = Math.max(...weeks.map((w) => w.score), 0);
  const y = (s: number) => (hi === lo ? 20 : 6 + ((hi - s) / (hi - lo)) * 28);
  const pts = weeks.map((w, i) => `${weeks.length === 1 ? 60 : 8 + (i * 104) / (weeks.length - 1)},${y(w.score)}`).join(" ");

  return (
    <div className="grid gap-4 md:grid-cols-3">
      <section className={cn(card, "flex flex-col gap-2")} aria-label="Are we on time?">
        <p className="text-xs font-semibold text-muted-foreground">① Are we on time?</p>
        <p className={cn("text-3xl font-bold tracking-tight", onTime.tone)}>{onTime.text}</p>
        <p className="text-sm text-muted-foreground">
          {m.forecast_completion ? <>Finishing {fmtLocalDate(m.forecast_completion)}</> : "No forecast yet"}
          {m.planned_completion && <> · plan {fmtLocalDate(m.planned_completion)}</>}
        </p>
      </section>

      <section className={cn(card, "flex flex-col gap-2")} aria-label="How much is done?">
        <p className="text-xs font-semibold text-muted-foreground">② How much is done?</p>
        <p className="text-3xl font-bold tracking-tight tabular">{actual === null ? "–" : `${Math.round(actual)}%`}</p>
        <div className="relative h-2.5 overflow-hidden rounded-full bg-muted">
          <span className="absolute inset-y-0 left-0 rounded-full bg-primary" style={{ width: `${Math.min(100, actual ?? 0)}%` }} />
          {planned !== null && <span className="absolute inset-y-[-2px] w-0.5 bg-foreground" style={{ left: `${Math.min(100, planned)}%` }} aria-hidden />}
        </div>
        <p className="text-sm text-muted-foreground">{planned === null ? "No plan figure" : `Plan says ${Math.round(planned)}% by today`}</p>
      </section>

      <section className={cn(card, "flex flex-col gap-2")} aria-label="Is it getting better?">
        <p className="text-xs font-semibold text-muted-foreground">③ Is it getting better?</p>
        <div className="flex items-center gap-4">
          <p className={cn("text-3xl font-bold tracking-tight", trend.tone)}>{trend.text}</p>
          {weeks.length > 1 && (
            <svg viewBox="0 0 120 40" className="h-10 w-28" aria-hidden>
              <polyline points={pts} fill="none" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="stroke-current text-muted-foreground" />
              <circle cx={pts.split(" ").at(-1)!.split(",")[0]} cy={pts.split(" ").at(-1)!.split(",")[1]} r="4" className="fill-current text-foreground" />
            </svg>
          )}
        </div>
        <p className="text-sm text-muted-foreground tabular">
          {weeks.length ? <>Weekly score {weeks.map((w) => Math.round(w.score)).join(" → ")}</> : "No weekly score yet"}
        </p>
      </section>
    </div>
  );
}

/** Every late activity, with what its lateness means for the finish date. */
function WhyLate({ m }: { m: Metrics }) {
  const late = m.activities.filter((a) => (a.finish_variance_days ?? 0) > 0).sort((a, b) => (b.finish_variance_days ?? 0) - (a.finish_variance_days ?? 0));
  const max = Math.max(1, ...late.map((a) => a.finish_variance_days ?? 0));
  const tag = (a: Activity) =>
    a.forecast_finish && a.forecast_finish === m.forecast_completion ? { text: "sets the finish", cls: "bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300", bar: "bg-red-500" }
      : a.forecast_critical || a.is_critical ? { text: "critical", cls: "bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300", bar: "bg-amber-500" }
      : { text: "has float", cls: "bg-muted text-muted-foreground", bar: "bg-amber-400" };
  const v = m.completion_variance_days ?? 0;

  return (
    <section className={cn(card, "flex flex-col gap-5")} aria-label="Why the finish is late">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-base font-bold">{v > 0 ? `Why ${days(v)} late` : "Activities running late"}</h2>
        <p className="text-xs text-muted-foreground">working days late, per activity</p>
      </div>
      {late.length === 0 ? <p className="text-sm text-muted-foreground">Nothing is running late.</p> : (
        <ul className="flex flex-col gap-4">
          {late.map((a) => {
            const t = tag(a);
            const n = a.finish_variance_days ?? 0;
            return (
              <li key={a.code} className="grid grid-cols-[minmax(0,7.5rem)_1fr_2.5rem] items-center gap-4 sm:grid-cols-[minmax(0,9rem)_1fr_2.5rem_7rem]">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-bold">{a.code}</span>
                  <span className="block truncate text-xs text-muted-foreground">{a.name}</span>
                </span>
                <span className="h-3 overflow-hidden rounded-full bg-muted">
                  <span className={cn("block h-full rounded-full", t.bar)} style={{ width: `${(n / max) * 100}%` }} />
                </span>
                <span className="text-right text-sm font-bold tabular">+{n}</span>
                <span className={cn("hidden justify-self-start rounded-full px-2.5 py-0.5 text-xs font-semibold sm:inline", t.cls)}>{t.text}</span>
              </li>
            );
          })}
        </ul>
      )}
      {m.planned_completion && m.forecast_completion && (
        <div className="mt-auto flex items-center gap-3 rounded-2xl bg-muted/50 px-4 py-3 text-sm">
          <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300">Plan {fmtLocalDate(m.planned_completion)}</span>
          <span aria-hidden className={cn("h-0.5 flex-1", v > 0 ? "bg-[repeating-linear-gradient(90deg,var(--destructive)_0_6px,transparent_6px_10px)]" : "bg-border")} />
          <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", v > 0 ? "bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300" : "bg-muted")}>Forecast {fmtLocalDate(m.forecast_completion)}</span>
        </div>
      )}
    </section>
  );
}

/** The biggest levers first: the activity that sets the finish, then plant standing idle on the selected day. */
function WhatWouldHelp({ m, day }: { m: Metrics; day: DailyEvaluation | undefined }) {
  const drivers = m.activities
    .filter((a) => (a.finish_variance_days ?? 0) > 0 && (a.forecast_finish === m.forecast_completion || a.forecast_critical))
    .sort((a, b) => (b.finish_variance_days ?? 0) - (a.finish_variance_days ?? 0))
    .slice(0, 2);
  const idle = (day?.indicators.equipment_idle ?? []).filter((e) => (e.hours ?? 0) > 0).sort((a, b) => (b.hours ?? 0) - (a.hours ?? 0));
  const rows = [
    ...drivers.map((a) => ({
      key: a.code,
      Icon: Wrench,
      tone: "bg-red-50 text-red-600 dark:bg-red-500/15 dark:text-red-300",
      title: `Speed up ${a.code}`,
      sub: `${a.actual_cum} of ${a.planned_cum} ${a.unit ?? ""} by today · +${days(a.finish_variance_days ?? 0)}`,
      href: "/performance/baseline",
      action: "See plan",
    })),
    ...idle.map((e) => {
      const incident = (e.incident_ids as string[] | undefined)?.[0];
      return {
        key: e.equipment_id,
        Icon: Truck,
        tone: "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
        title: `${e.equipment_id} idle ${e.hours} h`,
        sub: [e.description, e.attribution?.explanation && e.attribution.explanation !== "No record states a cause yet." ? e.attribution.explanation : null].filter(Boolean).join(" · "),
        href: incident ? `/incidents/${incident}` : null,
        action: "Open incident",
      };
    }),
  ];

  return (
    <section className={cn(card, "flex flex-col gap-5")} aria-label="What would help">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-base font-bold">What would help</h2>
        <p className="text-xs text-muted-foreground">biggest effect first</p>
      </div>
      {rows.length === 0 ? <p className="text-sm text-muted-foreground">Nothing stands out today.</p> : (
        <ul className="flex flex-col gap-3">
          {rows.map(({ key, Icon, tone, title, sub, href, action }) => (
            <li key={key} className="flex items-center gap-4 rounded-2xl bg-muted/40 px-4 py-3.5">
              <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl", tone)}><Icon className="size-5" aria-hidden /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-bold">{title}</span>
                {sub && <span className="block truncate text-xs text-muted-foreground">{sub}</span>}
              </span>
              {href && (
                <Link href={href} className="inline-flex shrink-0 items-center gap-1 rounded-xl bg-primary px-3.5 py-2 text-xs font-bold text-primary-foreground hover:bg-primary/90">
                  {action} <ArrowRight className="size-3.5" aria-hidden />
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Performance at a glance: three answers, why the finish is late, and what would help. */
export function PerformanceOverview({ snapshot, day }: { snapshot: Snapshot; day: DailyEvaluation | undefined }) {
  return (
    <div className="flex flex-col gap-6">
      <Questions m={snapshot.metrics} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <WhyLate m={snapshot.metrics} />
        <WhatWouldHelp m={snapshot.metrics} day={day} />
      </div>
    </div>
  );
}
