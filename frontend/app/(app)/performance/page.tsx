"use client";

import { Check, Download, FileUp, Flag, Sparkles, ThumbsDown, Undo2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { CitationList } from "@/components/citation-chip";
import { DayNav } from "@/components/day-nav";
import { DisclaimerBanner } from "@/components/disclaimer-banner";
import { BandChip, CauseChip, OverallChip } from "@/components/performance/chips";
import { DayPerformanceCard } from "@/components/performance/day-performance-card";
import { SCurveChart } from "@/components/performance/s-curve-chart";
import { useApp } from "@/components/providers/app-context";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  deadlineLabel,
  NOTICE_TEXT,
  reportUrl,
  RULE_TEXT,
  toRefs,
  useLedger,
  usePerformance,
  useRegenerateNarrative,
  useReviewLedger,
  type LedgerEntry,
  type Snapshot,
} from "@/lib/performance";
import { fmtLocalDate, localDateOf } from "@/lib/time";
import { cn } from "@/lib/utils";

function Kpi({ label, value, sub, chip }: { label: string; value: string; sub?: string; chip?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-[22px] bg-card p-4 md:p-5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold tabular">{value}</p>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">{chip}{sub}</div>
    </div>
  );
}

function Kpis({ s }: { s: Snapshot }) {
  const m = s.metrics;
  const v = m.completion_variance_days;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Kpi label="Weighted progress, actual / planned" value={`${m.weighted_actual_pct ?? "–"}% / ${m.weighted_planned_pct ?? "–"}%`}
           chip={<BandChip band={m.cumulative_band} label={`${m.points_behind} pts behind`} />}
           sub={m.weight_basis === "duration" ? "weighted by duration" : undefined} />
      <Kpi label="Schedule performance (SPI)" value={m.spi === null ? "–" : String(m.spi)} chip={<BandChip band={m.spi_band} />} />
      <Kpi label="Forecast completion" value={m.forecast_completion ? fmtLocalDate(m.forecast_completion) : "–"}
           chip={<OverallChip status={m.overall_status} />}
           sub={v === null ? undefined : v === 0 ? "on the planned date" : `${Math.abs(v)} working day${Math.abs(v) === 1 ? "" : "s"} ${v > 0 ? "late" : "early"}`} />
      <Kpi label="Score to date" value={`${m.score > 0 ? "+" : ""}${m.score}`}
           sub={`${m.ledger_counts.accepted ?? 0} accepted · ${m.ledger_counts.disputed ?? 0} disputed · ${m.ledger_counts.proposed ?? 0} to review`} />
    </div>
  );
}

function ActivityTable({ s }: { s: Snapshot }) {
  const acts = s.metrics.activities;
  return (
    <section className="rounded-[22px] bg-card p-5 md:p-6" aria-label="Activities">
      <h2 className="text-base font-bold">Activities to date</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Critical path: {s.metrics.critical_path.join(" → ") || "–"}
        {s.metrics.tracking_start ? ` · signed reports tracked from ${fmtLocalDate(s.metrics.tracking_start)}; earlier days assumed as planned` : ""}
      </p>
      <ul className="mt-3 flex flex-col divide-y md:hidden">
        {acts.map((a) => (
          <li key={a.code} className="py-3 text-sm">
            <p className="flex items-center justify-between gap-2">
              <span className="truncate"><span className="font-mono text-xs font-semibold">{a.code}</span> {a.name}</span>
              {a.forecast_critical && <span className="text-xs font-semibold text-primary-foreground bg-primary rounded px-1">critical</span>}
            </p>
            <p className="mt-1 text-xs text-muted-foreground tabular">
              {a.actual_cum} / {a.planned_cum} {a.unit} · backlog {a.backlog} · {a.days_behind ?? "–"} days behind · finish {a.forecast_finish ?? "no rate"}
              {a.finish_variance_days ? ` (${a.finish_variance_days > 0 ? "+" : ""}${a.finish_variance_days} wd)` : ""}
            </p>
          </li>
        ))}
      </ul>
      <div className="mt-3 hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>{["Activity", "Planned cum.", "Actual cum.", "Backlog", "Days behind", "Forecast finish", "Var. (wd)", "Delay split"].map((h) =>
              <th key={h} className="px-2 py-1.5 font-medium">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y tabular">
            {acts.map((a) => (
              <tr key={a.code} className={cn(a.forecast_critical && "bg-primary/5")}>
                <td className="px-2 py-2"><span className="font-mono text-xs font-semibold">{a.code}</span> {a.name}
                  {a.forecast_critical && <span className="ml-1 rounded bg-primary px-1 text-[10px] font-semibold text-primary-foreground">critical</span>}
                  {a.flags.includes("zero_rate") && !a.forecast_finish && <span className="ml-1 text-[10px] text-red-700">no recent output</span>}
                </td>
                <td className="px-2 py-2">{a.planned_cum} {a.unit}</td>
                <td className="px-2 py-2">{a.actual_cum}</td>
                <td className={cn("px-2 py-2", a.backlog > 0 && "text-red-700 dark:text-red-400")}>{a.backlog}</td>
                <td className="px-2 py-2">{a.days_behind ?? "–"}</td>
                <td className="px-2 py-2">{a.forecast_finish ?? "–"}</td>
                <td className="px-2 py-2">{a.finish_variance_days ?? "–"}</td>
                <td className="px-2 py-2 text-xs">
                  {Object.entries(a.attribution_split.by_cause).map(([c, d]) => <span key={c} className="mr-1">{c}: {d}</span>)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Delay split (for review, not legal advice): excusable {s.metrics.attribution.excusable_days} days ·
        non-excusable {s.metrics.attribution.non_excusable_days} days
        {s.metrics.ld_exposure ? ` · indicative LD exposure ${s.metrics.ld_exposure.amount} ${s.metrics.ld_exposure.currency ?? ""}` : ""}
      </p>
    </section>
  );
}

function Milestones({ s }: { s: Snapshot }) {
  if (!s.metrics.milestones.length) return null;
  return (
    <section className="rounded-[22px] bg-card p-5 md:p-6" aria-label="Milestones">
      <h2 className="flex items-center gap-2 text-base font-bold"><Flag className="size-4" aria-hidden /> Milestones</h2>
      <ol className="mt-3 flex gap-3 overflow-x-auto pb-1">
        {s.metrics.milestones.map((m) => (
          <li key={m.code} className="min-w-44 rounded-2xl border bg-background p-3 text-sm">
            <p className="font-semibold">{m.code} {m.contractual && <span className="text-xs text-red-700">contractual</span>}</p>
            <p className="truncate text-xs text-muted-foreground">{m.name}</p>
            <p className="mt-1 text-xs tabular">plan {m.planned_date ?? "–"} · forecast {m.forecast_date ?? "–"}</p>
            <BandChip className="mt-1" band={m.state === "missed" ? "red" : (m.variance_days ?? 0) > 0 ? "amber" : "green"}
                      label={m.state === "met" ? "Met" : m.state === "missed" ? "Missed" : (m.variance_days ?? 0) > 0 ? `+${m.variance_days} wd` : "On plan"} />
            <CitationList className="mt-1" refs={toRefs(m.refs)} />
          </li>
        ))}
      </ol>
    </section>
  );
}

function Narrative({ s, date }: { s: Snapshot; date: string }) {
  const n = s.narrative;
  const regen = useRegenerateNarrative();
  const groups: [string, typeof n.merits][] = [["Merits", n.merits], ["Demerits", n.demerits], ["Risks", n.risks],
    ["Recommended actions", n.recommended_actions], ["Correspondence to consider", n.correspondence_to_consider]];
  return (
    <section className="flex flex-col gap-3 rounded-[22px] bg-card p-5 md:p-6" aria-label="Narrative">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-base font-bold"><Sparkles className="size-4 text-warning" aria-hidden /> Overall narrative</h2>
        <Button size="sm" variant="outline" disabled={regen.isPending} onClick={() => regen.mutate(date)}>
          {regen.isPending ? "Queued…" : n.source === "model" ? "Rewrite" : "Write cited narrative"}
        </Button>
      </div>
      <DisclaimerBanner text={n.disclaimer} />
      {n.source !== "model" && <p className="text-xs text-muted-foreground">Figures-only summary from the ledger. The written narrative cites every statement.</p>}
      {[n.status_explanation, n.trend].filter(Boolean).map((item, i) => (
        <p key={i} className="text-sm">{item!.text} <CitationList refs={toRefs(item!.refs)} /></p>
      ))}
      {groups.filter(([, items]) => items.length).map(([label, items]) => (
        <div key={label}>
          <h3 className="text-sm font-semibold">{label}</h3>
          <ul className="mt-1 flex flex-col gap-1.5">
            {items.map((i, k) => <li key={k} className="text-sm">{i.text} <CitationList refs={toRefs(i.refs)} /></li>)}
          </ul>
        </div>
      ))}
    </section>
  );
}

function LedgerRow({ e }: { e: LedgerEntry }) {
  const review = useReviewLedger();
  const [disputing, setDisputing] = useState(false);
  const [note, setNote] = useState("");
  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">
          <span className="text-xs text-muted-foreground tabular">{e.work_date}</span>{" "}
          <span className="font-mono text-xs font-semibold">{e.subject.replace("equipment:", "")}</span>{" "}
          {RULE_TEXT[e.rule_key] ?? e.rule_key}
        </p>
        <span className={cn("rounded-md px-1.5 text-sm font-semibold tabular", e.kind === "merit" ? "text-emerald-700" : "text-red-700")}>
          {e.points > 0 ? "+" : ""}{e.points}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {e.cause_category && <CauseChip cause={e.cause_category} confidence={1} excusable={e.excusable} />}
        <span className={cn("rounded-md border px-1.5 py-0.5 text-xs", e.status === "disputed" ? "border-red-300 text-red-800" : e.status === "accepted" ? "border-emerald-300 text-emerald-800" : "text-muted-foreground")}>
          {e.status}{e.reviewer_name && e.status !== "proposed" ? ` by ${e.reviewer_name}` : ""}
        </span>
        <CitationList refs={toRefs(e.refs).slice(0, 3)} />
      </div>
      {e.note && <p className="text-xs text-muted-foreground">Note: {e.note}</p>}
      {disputing ? (
        <form className="flex flex-col gap-2" onSubmit={(ev) => { ev.preventDefault(); review.mutate({ id: e.id, status: "disputed", note }, { onSuccess: () => setDisputing(false) }); }}>
          <Textarea required value={note} onChange={(ev) => setNote(ev.target.value)} placeholder="Why is this entry disputed?" />
          <div className="flex gap-2">
            <Button size="sm" type="submit" disabled={!note.trim() || review.isPending}>Dispute</Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => setDisputing(false)}>Cancel</Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          {e.status !== "accepted" && <Button size="sm" variant="outline" onClick={() => review.mutate({ id: e.id, status: "accepted" })}><Check aria-hidden /> Accept</Button>}
          {e.status !== "disputed" && <Button size="sm" variant="outline" onClick={() => setDisputing(true)}><ThumbsDown aria-hidden /> Dispute</Button>}
          {e.status !== "proposed" && <Button size="sm" variant="ghost" onClick={() => review.mutate({ id: e.id, status: "proposed" })}><Undo2 aria-hidden /> Reopen</Button>}
        </div>
      )}
      {review.isError && <p className="text-xs text-red-700">{(review.error as Error).message}</p>}
    </li>
  );
}

function Ledger({ date }: { date: string }) {
  const q = useLedger(date);
  const [kind, setKind] = useState<"all" | "merit" | "demerit">("all");
  if (q.isPending) return <LoadingSkeleton rows={3} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const entries = q.data.entries.filter((e) => kind === "all" || e.kind === kind).slice().reverse();
  return (
    <section className="rounded-[22px] bg-card p-5 md:p-6" aria-label="Merit and demerit ledger">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-bold">Merits and demerits</h2>
        <div className="flex gap-1" role="group" aria-label="Filter">
          {(["all", "merit", "demerit"] as const).map((k) => (
            <Button key={k} size="sm" variant={kind === k ? "default" : "ghost"} aria-pressed={kind === k} onClick={() => setKind(k)}>{k}</Button>
          ))}
        </div>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">Proposed by the system from the daily results. Disputed and excusable entries do not count against the score.</p>
      {entries.length ? <ul className="mt-2 flex flex-col divide-y">{entries.map((e) => <LedgerRow key={e.id} e={e} />)}</ul>
        : <EmptyState className="mt-3" title="No entries yet" />}
    </section>
  );
}

export default function PerformancePage() {
  const { asOf, projectId } = useApp();
  const clockDate = localDateOf(asOf);
  const [picked, setPicked] = useState<string | null>(null);
  const date = picked && picked <= clockDate ? picked : clockDate;
  const snap = usePerformance(date);
  return (
    <>
      <PageHeader
        title="Performance"
        description="Progress against the active plan, the daily deviations, and the merit and demerit ledger. Every figure is computed from signed records."
        actions={<DayNav date={date} clockDate={clockDate} onChange={setPicked} />}
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <Button asChild size="sm" variant="outline"><Link href="/performance/baseline"><FileUp aria-hidden /> Plans and baseline</Link></Button>
        <Button asChild size="sm" variant="outline"><a href={reportUrl(projectId, date, asOf, "pdf")}><Download aria-hidden /> PDF report</a></Button>
        <Button asChild size="sm" variant="outline"><a href={reportUrl(projectId, date, asOf, "docx")}><Download aria-hidden /> Word report</a></Button>
      </div>
      {snap.isPending ? <LoadingSkeleton variant="cards" rows={3} /> : snap.isError ? <ErrorState error={snap.error} onRetry={() => void snap.refetch()} /> : (
        <div className="flex flex-col gap-5">
          <Kpis s={snap.data} />
          <section className="rounded-[22px] bg-card p-5 md:p-6" aria-label="S-curve">
            <h2 className="text-base font-bold">S-curve</h2>
            <SCurveChart points={snap.data.s_curve} today={date} />
          </section>
          <DayPerformanceCard date={date} />
          <Milestones s={snap.data} />
          <ActivityTable s={snap.data} />
          <div className="grid items-start gap-5 lg:grid-cols-2">
            <Narrative s={snap.data} date={date} />
            <section className="rounded-[22px] bg-card p-5 md:p-6" aria-label="Open suggestions">
              <h2 className="text-base font-bold">Open correspondence suggestions</h2>
              {snap.data.metrics.open_suggestions.length ? (
                <ul className="mt-2 flex flex-col gap-2">
                  {snap.data.metrics.open_suggestions.map((s, i) => {
                    const due = deadlineLabel(s.deadline, clockDate);
                    return (
                      <li key={i} className="rounded-2xl border bg-background p-3 text-sm">
                        <p className="font-semibold">{NOTICE_TEXT[s.type]} · {s.activity_code ?? s.equipment_id} <span className="text-xs font-normal text-muted-foreground">({s.work_date})</span></p>
                        <p className="text-xs text-muted-foreground">{s.reason}</p>
                        <p className={cn("text-xs font-medium", due.tone === "red" ? "text-red-700" : due.tone === "amber" ? "text-amber-800" : "text-muted-foreground")}>{due.text}</p>
                      </li>
                    );
                  })}
                </ul>
              ) : <p className="mt-2 text-sm text-muted-foreground">No open suggestions.</p>}
            </section>
          </div>
          <Ledger date={date} />
          <p className="text-xs text-muted-foreground">Snapshot v{snap.data.version} · {snap.data.disclaimer}</p>
        </div>
      )}
    </>
  );
}
