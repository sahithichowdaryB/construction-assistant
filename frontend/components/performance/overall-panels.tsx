"use client";

import { Check, Flag, MessageSquareWarning, RefreshCw, Sparkles } from "lucide-react";
import { useState } from "react";
import { CitationList } from "@/components/citation-chip";
import { DisclaimerBanner } from "@/components/disclaimer-banner";
import { GatedButton } from "@/components/gated-button";
import { useApp } from "@/components/providers/app-context";
import { ErrorState, LoadingSkeleton } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toRefs, useLedger, useRegenerateNarrative, useReviewLedger, type LedgerEntry, type Snapshot } from "@/lib/performance";
import { denyReason } from "@/lib/roles";
import { fmtLocalDate } from "@/lib/time";
import { cn } from "@/lib/utils";

const card = "rounded-[22px] bg-card p-5 md:p-6";
const days = (v: number | null | undefined) => (v === null || v === undefined ? "–" : `${v > 0 ? "+" : ""}${v}`);

/** Per-activity backlog, days behind and forecast finish to the selected date (all computed on the server). */
export function ActivityTable({ s }: { s: Snapshot }) {
  const rows = s.metrics.activities.filter((a) => a.planned_cum > 0 || a.actual_cum > 0);
  if (!rows.length) return null;
  return (
    <section className={card} aria-labelledby="perf-activities">
      <h2 id="perf-activities" className="mb-3 text-base font-bold">Activities to date</h2>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Activity</TableHead>
              <TableHead className="text-right">Planned to date</TableHead>
              <TableHead className="text-right">Actual</TableHead>
              <TableHead className="text-right">Backlog</TableHead>
              <TableHead className="text-right">Days behind</TableHead>
              <TableHead>Forecast finish</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((a) => (
              <TableRow key={a.code}>
                <TableCell className="min-w-40">
                  <span className="font-mono text-xs font-semibold">{a.code}</span> {a.name}
                  {(a.is_critical || a.forecast_critical) && (
                    <span className="ml-1.5 rounded bg-red-50 px-1 text-[10px] font-semibold text-red-800 ring-1 ring-red-200">critical</span>
                  )}
                </TableCell>
                <TableCell className="text-right tabular">{a.planned_cum} {a.unit}</TableCell>
                <TableCell className="text-right tabular">{a.actual_cum}</TableCell>
                <TableCell className={cn("text-right tabular", a.backlog > 0 ? "text-red-700" : "text-emerald-700")}>{a.backlog}</TableCell>
                <TableCell className="text-right tabular">{days(a.days_behind)}</TableCell>
                <TableCell className="whitespace-nowrap">
                  {a.forecast_finish ? fmtLocalDate(a.forecast_finish) : a.flags.includes("zero_rate") ? "no recent output" : "–"}
                  {a.finish_variance_days ? <span className="ml-1 text-xs text-muted-foreground">({days(a.finish_variance_days)} wd)</span> : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

// Milestone states from performance/metrics.py: met, met_late, missed, open (open + positive variance = at risk).
const MS_TONE: Record<string, string> = {
  met: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  met_late: "bg-amber-50 text-amber-900 ring-amber-200",
  missed: "bg-red-50 text-red-800 ring-red-200",
  open: "bg-muted text-foreground ring-border",
  at_risk: "bg-amber-50 text-amber-900 ring-amber-200",
};
const msState = (m: { state: string; variance_days: number | null }) =>
  m.state === "open" && (m.variance_days ?? 0) > 0 ? "at_risk" : m.state;
const MS_LABEL: Record<string, string> = { met: "met", met_late: "met late", missed: "missed", open: "on plan", at_risk: "at risk" };

export function MilestoneStrip({ s }: { s: Snapshot }) {
  const ms = s.metrics.milestones;
  if (!ms.length) return null;
  return (
    <section className={card} aria-labelledby="perf-milestones">
      <h2 id="perf-milestones" className="mb-3 flex items-center gap-2 text-base font-bold"><Flag className="size-4" aria-hidden /> Milestones</h2>
      <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {ms.map((m) => (
          <li key={m.code} className="flex flex-col gap-1 rounded-xl border p-3 text-sm">
            <span className="flex items-center justify-between gap-2">
              <span className="font-mono text-xs font-semibold">{m.code}</span>
              <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset", MS_TONE[msState(m)] ?? MS_TONE.open)}>
                {MS_LABEL[msState(m)] ?? m.state}
              </span>
            </span>
            <span className="font-medium">{m.name}{m.contractual ? " (contractual)" : ""}</span>
            <span className="text-xs text-muted-foreground">
              Planned {m.planned_date ? fmtLocalDate(m.planned_date) : "–"} · forecast {m.forecast_date ? fmtLocalDate(m.forecast_date) : "–"}
              {m.variance_days ? ` (${days(m.variance_days)} wd)` : ""}
            </span>
            <CitationList refs={toRefs(m.refs)} />
          </li>
        ))}
      </ol>
    </section>
  );
}

function Cited({ title, items }: { title: string; items: { text: string; refs: string[] }[] }) {
  if (!items.length) return null;
  return (
    <div>
      <h3 className="text-sm font-semibold">{title}</h3>
      <ul className="mt-1 flex flex-col gap-1.5">
        {items.map((i, n) => (
          <li key={n} className="text-sm">
            {i.text} <CitationList className="mt-0.5" refs={toRefs(i.refs)} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The cited overall narrative (P4). The status comes from code (SPI band and critical path); the model explains it. */
export function NarrativePanel({ s, date }: { s: Snapshot; date: string }) {
  const { role } = useApp();
  const regen = useRegenerateNarrative();
  const n = s.narrative;
  return (
    <section className={`${card} flex flex-col gap-4`} aria-labelledby="perf-narrative">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="perf-narrative" className="flex items-center gap-2 text-base font-bold"><Sparkles className="size-4" aria-hidden /> Assessment</h2>
        <GatedButton reason={denyReason(role, "recompute")} size="sm" variant="outline" disabled={regen.isPending} onClick={() => regen.mutate(date)}>
          <RefreshCw className={cn(regen.isPending && "animate-spin")} aria-hidden /> {regen.isPending ? "Writing…" : "Rewrite the assessment"}
        </GatedButton>
      </div>
      {regen.isSuccess && <p className="text-xs text-muted-foreground">Queued: the assessment updates in a moment.</p>}
      {n.source === "code" && <p className="text-xs text-muted-foreground">No model-written assessment yet; figures are shown from the calculation.</p>}
      {n.status_explanation && <Cited title="Status" items={[n.status_explanation]} />}
      {n.trend && <Cited title="Trend" items={[n.trend]} />}
      <div className="grid gap-4 md:grid-cols-2">
        <Cited title="Merits" items={n.merits} />
        <Cited title="Demerits" items={n.demerits} />
        <Cited title="Risks" items={n.risks} />
        <Cited title="Recommended actions" items={n.recommended_actions} />
      </div>
      <Cited title="Correspondence to consider" items={n.correspondence_to_consider} />
      <p className="text-xs text-muted-foreground">{s.metrics.attribution.label}: {s.metrics.attribution.excusable_days} excusable, {s.metrics.attribution.non_excusable_days} non-excusable days behind.</p>
      <DisclaimerBanner text={n.disclaimer || s.disclaimer} />
    </section>
  );
}

function LedgerRow({ e, deny }: { e: LedgerEntry; deny: string | null }) {
  const review = useReviewLedger();
  const [disputing, setDisputing] = useState(false);
  const [note, setNote] = useState("");
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap">{fmtLocalDate(e.work_date)}</TableCell>
      <TableCell className="min-w-44">
        <span className="font-mono text-xs">{e.subject}</span> · {e.rule_key.replaceAll(".", " ").replaceAll("_", " ")}
        {e.excusable && <span className="ml-1.5 rounded bg-sky-50 px-1 text-[10px] text-sky-900 ring-1 ring-sky-200">excusable</span>}
        {e.cause_category && <span className="ml-1 text-xs text-muted-foreground">({e.cause_category.replaceAll("_", " ")})</span>}
        <CitationList className="mt-1" refs={toRefs(e.refs)} />
        {e.note && <p className="mt-1 text-xs text-muted-foreground">“{e.note}”{e.reviewer_name ? ` · ${e.reviewer_name}` : ""}</p>}
      </TableCell>
      <TableCell className={cn("text-right font-semibold tabular", e.points > 0 ? "text-emerald-700" : "text-red-700")}>
        {e.points > 0 ? "+" : ""}{e.points}
      </TableCell>
      <TableCell className="min-w-48">
        {disputing ? (
          <form className="flex flex-col gap-1.5" onSubmit={(ev) => { ev.preventDefault(); review.mutate({ id: e.id, status: "disputed", note }, { onSuccess: () => setDisputing(false) }); }}>
            <Input value={note} onChange={(x) => setNote(x.target.value)} placeholder="Why is this wrong?" required maxLength={1000} />
            <div className="flex gap-1.5">
              <Button type="submit" size="sm" disabled={!note.trim() || review.isPending}>Dispute</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setDisputing(false)}>Cancel</Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset",
              e.status === "accepted" ? "bg-emerald-50 text-emerald-800 ring-emerald-200" : e.status === "disputed" ? "bg-red-50 text-red-800 ring-red-200" : "bg-muted ring-border")}>
              {e.status}
            </span>
            {e.status !== "accepted" && (
              <GatedButton reason={deny} size="sm" variant="ghost" disabled={review.isPending} onClick={() => review.mutate({ id: e.id, status: "accepted" })}>
                <Check aria-hidden /> Accept
              </GatedButton>
            )}
            {e.status !== "disputed" && (
              <GatedButton reason={deny} size="sm" variant="ghost" onClick={() => setDisputing(true)}>
                <MessageSquareWarning aria-hidden /> Dispute
              </GatedButton>
            )}
          </div>
        )}
        {review.isError && <p className="text-xs text-red-800">{review.error.message}</p>}
      </TableCell>
    </TableRow>
  );
}

/** Merit and demerit ledger to the selected date. A disputed entry leaves the score until it is resolved. */
export function LedgerTable({ date }: { date: string }) {
  const { role } = useApp();
  const ledger = useLedger(date);
  const [kind, setKind] = useState<"all" | "merit" | "demerit">("all");
  if (ledger.isPending) return <LoadingSkeleton rows={2} />;
  if (ledger.isError) return <ErrorState error={ledger.error} onRetry={() => void ledger.refetch()} />;
  const rows = ledger.data.entries.filter((e) => kind === "all" || e.kind === kind);
  const deny = denyReason(role, "review_ledger");
  return (
    <section className={card} aria-labelledby="perf-ledger">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id="perf-ledger" className="text-base font-bold">Merits and demerits · score {ledger.data.score > 0 ? "+" : ""}{ledger.data.score}</h2>
        <div className="flex gap-1" role="group" aria-label="Show">
          {(["all", "merit", "demerit"] as const).map((k) => (
            <Button key={k} size="sm" variant={kind === k ? "default" : "outline"} onClick={() => setKind(k)} aria-pressed={kind === k}>
              {k === "all" ? "All" : k === "merit" ? "Merits" : "Demerits"}
            </Button>
          ))}
        </div>
      </div>
      {rows.length ? (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Day</TableHead>
                <TableHead>Entry</TableHead>
                <TableHead className="text-right">Points</TableHead>
                <TableHead>Review</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>{rows.map((e) => <LedgerRow key={e.id} e={e} deny={deny} />)}</TableBody>
          </Table>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No entries yet.</p>
      )}
    </section>
  );
}
