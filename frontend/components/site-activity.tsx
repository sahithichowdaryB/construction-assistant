"use client";

import { endOfISOWeek, format, parseISO, startOfISOWeek } from "date-fns";
import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { ErrorState, LoadingSkeleton } from "@/components/states";
import { fmtLocalDate, fmtTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useDayRecords, useNotices, type DraftStatus } from "@/lib/workflow";

type DayRecord = NonNullable<ReturnType<typeof useDayRecords>["data"]>[number];

/** Same words at the start means the same report sent again (voice notes are often repeated). */
const titleKey = (t: string) =>
  t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean).slice(0, 6).join(" ");

/** First clause of a record's text, so each line reads as a short headline. */
const headline = (t: string) => t.split(/[;.–—]\s/)[0].replace(/[.;]$/, "").trim();

type Stage = "new" | "progress" | "done";
type Event = {
  key: string;
  title: string;
  latest: string;
  records: DayRecord[];
  status: DraftStatus | null;
  stage: Stage;
};

const STATUS_RANK: Record<DraftStatus, number> = { draft: 1, changes_requested: 1, awaiting_review: 2, approved: 3 };

/** Groups the day's records into events: one per incident, per notice or letter, or per repeated report. */
function groupEvents(records: DayRecord[], statusOf: Map<string, DraftStatus>, incidentOf: Map<string, string>): Event[] {
  const groups = new Map<string, DayRecord[]>();
  for (const r of records) {
    const incident = r.incident_id ?? (r.draft_id ? incidentOf.get(r.draft_id) : undefined);
    const key = incident ? `i:${incident}` : r.draft_id ? `d:${r.draft_id}` : `t:${titleKey(r.title)}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.entries()]
    .map(([key, rs]) => {
      const site = rs.find((r) => !r.draft_id);
      let status: DraftStatus | null = null;
      for (const r of rs) {
        if (!r.draft_id) continue;
        const s = statusOf.get(r.draft_id) ?? "draft";
        if (!status || STATUS_RANK[s] > STATUS_RANK[status]) status = s;
      }
      const stage: Stage = !status ? "new" : status === "approved" ? "done" : "progress";
      return {
        key,
        title: headline((site ?? rs[0]).title),
        latest: rs.reduce((m, r) => (r.at > m ? r.at : m), rs[0].at),
        records: [...rs].sort((a, b) => a.at.localeCompare(b.at)),
        status,
        stage,
      };
    })
    .sort((a, b) => b.latest.localeCompare(a.latest));
}

const STAGE: Record<Stage, { node: string; label: string; tile: string; num: string }> = {
  new: { node: "bg-red-500", label: "New, no action", tile: "bg-red-50 dark:bg-red-500/10", num: "text-red-600 dark:text-red-400" },
  progress: { node: "bg-primary", label: "In progress", tile: "bg-amber-50 dark:bg-amber-500/10", num: "text-amber-700 dark:text-amber-400" },
  done: { node: "bg-emerald-500", label: "Done", tile: "bg-emerald-50 dark:bg-emerald-500/10", num: "text-emerald-700 dark:text-emerald-400" },
};

const PILL: Record<DraftStatus | "new", { text: string; cls: string }> = {
  new: { text: "New", cls: "bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300" },
  draft: { text: "Draft", cls: "bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300" },
  changes_requested: { text: "Changes", cls: "bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300" },
  awaiting_review: { text: "Review", cls: "bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300" },
  approved: { text: "Approved", cls: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300" },
};

const SHOWN = 8;

export function SiteActivity({ date, onOpenNotice }: { date: string; onOpenNotice?: (id: string) => void }) {
  const [period, setPeriod] = useState<"day" | "week">("day");
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const records = useDayRecords(date, period);
  const notices = useNotices();
  const events = useMemo(() => {
    const statusOf = new Map(notices.data?.map((n) => [n.id, n.status]));
    const incidentOf = new Map(notices.data?.flatMap((n) => (n.incident_id ? [[n.id, n.incident_id] as const] : [])));
    return groupEvents(records.data ?? [], statusOf, incidentOf);
  }, [records.data, notices.data]);
  const counts = { new: 0, progress: 0, done: 0 } as Record<Stage, number>;
  for (const e of events) counts[e.stage] += 1;
  const selected = parseISO(date);
  const range = period === "day" ? format(selected, "d MMM")
    : `${format(startOfISOWeek(selected), "d MMM")} – ${format(endOfISOWeek(selected), "d MMM")}`;
  const shown = all ? events : events.slice(0, SHOWN);

  /** Where a record opens: a letter, a notice, or its incident. Plain site notes open nothing. */
  const target = (r: DayRecord): { href?: string; onClick?: () => void } | null =>
    r.correspondence ? { href: `/manager/write?draft=${r.draft_id}` }
      : r.draft_id && onOpenNotice ? { onClick: () => onOpenNotice(r.draft_id!) }
      : r.draft_id ? { href: `/manager?notice=${r.draft_id}` }
      : r.incident_id ? { href: `/incidents/${r.incident_id}` } : null;

  const asLink = (r: DayRecord, className: string, children: ReactNode) => {
    const t = target(r);
    if (t?.href) return <Link href={t.href} className={className}>{children}</Link>;
    if (t?.onClick) return <button type="button" onClick={t.onClick} className={cn("text-left", className)}>{children}</button>;
    return <div className={className}>{children}</div>;
  };

  const step = (r: DayRecord) =>
    r.draft_id ? `${r.correspondence ? "Letter" : "Notice"} v${r.version}` : `Reported · ${r.kind.replaceAll("_", " ")}`;

  /** Small line under the headline: what the latest step is, and how many records the event holds. */
  const detail = (e: Event) => {
    const last = e.records.at(-1)!;
    const parts = [];
    if (last.draft_id) parts.push(`${last.correspondence ? "letter" : "notice"} v${last.version}`);
    if (e.records.length > 1) parts.push(`${e.records.length} records`);
    return parts.join(" · ");
  };

  return (
    <section className="mb-5 rounded-2xl border bg-card p-4" aria-label="Site activity">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-semibold">
          On site <span className="font-normal text-muted-foreground">· {range}</span>
        </h2>
        <div role="group" aria-label="Activity period" className="flex rounded-lg bg-muted p-0.5 text-xs font-semibold">
          {(["day", "week"] as const).map((p) => (
            <button key={p} type="button" aria-pressed={period === p} onClick={() => setPeriod(p)}
              className={cn("rounded-md px-2.5 py-1", period === p ? "bg-background shadow-xs" : "text-muted-foreground")}>
              {p === "day" ? "Day" : "Week"}
            </button>
          ))}
        </div>
      </div>

      {records.isPending ? <LoadingSkeleton rows={3} /> : records.isError ? <ErrorState error={records.error} onRetry={() => void records.refetch()} />
        : !events.length ? <p className="text-sm text-muted-foreground">Nothing recorded on {fmtLocalDate(date)}{period === "week" ? " this week" : ""}.</p> : (
          <>
            <div className="mb-3 grid grid-cols-3 gap-2">
              {(["new", "progress", "done"] as const).map((s) => (
                <div key={s} className={cn("rounded-xl px-3 py-2", STAGE[s].tile)}>
                  <p className={cn("text-2xl leading-none font-bold tabular", STAGE[s].num)}>{counts[s]}</p>
                  <p className="mt-1 text-xs font-medium text-muted-foreground">{STAGE[s].label}</p>
                </div>
              ))}
            </div>

            <ol className="relative flex flex-col">
              <span aria-hidden className="absolute top-3 bottom-3 left-[calc(4rem-1px)] w-0.5 rounded-full bg-border" />
              {shown.map((e) => {
                const single = e.records.length === 1;
                const expanded = open === e.key;
                const pill = PILL[e.status ?? "new"];
                const sub = detail(e);
                const row = (
                  <>
                    <span className="w-10 shrink-0 text-right text-xs font-semibold text-muted-foreground tabular">{fmtTime(e.latest)}</span>
                    <span aria-hidden className={cn("relative z-10 size-3 shrink-0 rounded-full ring-[3px] ring-card", STAGE[e.stage].node)} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{e.title}</span>
                      {sub && <span className="block truncate text-xs text-muted-foreground">{sub}</span>}
                    </span>
                    <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold", pill.cls)}>{pill.text}</span>
                    {!single && <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-180")} aria-hidden />}
                  </>
                );
                const rowClass = "flex w-full items-center gap-3 rounded-xl px-1.5 py-2 text-left hover:bg-muted/60";
                return (
                  <li key={e.key}>
                    {/* One record: the row opens it. Several: the row expands into the steps. */}
                    {single ? asLink(e.records[0], rowClass, row) : (
                      <button type="button" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : e.key)} className={rowClass}>
                        {row}
                      </button>
                    )}
                    {!single && expanded && (
                      <ol className="flex flex-col gap-1 pt-0.5 pb-2 pl-[4.6rem] text-[13px]">
                        {e.records.map((r) => (
                          <li key={r.id} className="flex items-baseline gap-2 [overflow-wrap:anywhere]">
                            <span className="w-11 shrink-0 text-xs text-muted-foreground tabular">{fmtTime(r.at)}</span>
                            {asLink(r, "font-medium hover:underline", step(r))}
                          </li>
                        ))}
                      </ol>
                    )}
                  </li>
                );
              })}
            </ol>
            {events.length > SHOWN && (
              <button type="button" onClick={() => setAll(!all)} className="mt-2 w-full rounded-xl py-2 text-xs font-semibold text-muted-foreground hover:bg-muted/60 hover:text-foreground">
                {all ? "Show less" : `Show all ${events.length}`}
              </button>
            )}
          </>
        )}
    </section>
  );
}
