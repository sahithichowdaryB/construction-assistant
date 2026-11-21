"use client";

import { endOfISOWeek, format, parseISO, startOfISOWeek } from "date-fns";
import Link from "next/link";
import { useState } from "react";
import { ErrorState, LoadingSkeleton } from "@/components/states";
import { Button } from "@/components/ui/button";
import { fmtDateTime, fmtLocalDate } from "@/lib/time";
import { useDayRecords } from "@/lib/workflow";

export function SiteActivity({ date, onOpenNotice }: { date: string; onOpenNotice?: (id: string) => void }) {
  const [period, setPeriod] = useState<"day" | "week">("day");
  const records = useDayRecords(date, period);
  const drafts = new Set(records.data?.flatMap((r) => r.draft_id ? [r.draft_id] : []));
  const siteRecords = records.data?.filter((r) => !r.draft_id).length ?? 0;
  const selected = parseISO(date);
  const range = period === "day" ? fmtLocalDate(date)
    : `${format(startOfISOWeek(selected), "d MMM")} – ${format(endOfISOWeek(selected), "d MMM yyyy")}`;

  return (
    <section className="mb-5 rounded-2xl border bg-card p-4" aria-label="Site activity">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Site activity · {range}</h2>
        <div role="group" aria-label="Activity period" className="flex gap-1">
          {(["day", "week"] as const).map((p) => (
            <Button key={p} size="sm" variant={period === p ? "default" : "outline"} aria-pressed={period === p} onClick={() => setPeriod(p)}>
              {p === "day" ? "Daily" : "Weekly"}
            </Button>
          ))}
        </div>
      </div>
      {!!records.data?.length && <p className="mb-2 text-sm text-muted-foreground">
        {siteRecords} site record{siteRecords === 1 ? "" : "s"} · {drafts.size} draft{drafts.size === 1 ? "" : "s"}
      </p>}
      {records.isPending ? <LoadingSkeleton rows={2} /> : records.isError ? <ErrorState error={records.error} onRetry={() => void records.refetch()} />
        : records.data.length ? <ul className="divide-y">{records.data.map((r) => (
          <li key={r.id} className="py-2 text-sm [overflow-wrap:anywhere]">
            <p className="text-xs text-muted-foreground">
              {fmtDateTime(r.at)} · {r.kind.replaceAll("_", " ")}{r.draft_id ? ` draft · v${r.version}` : ` · ${r.source_id}`}
            </p>
            {r.correspondence ? <Link className="underline" href={`/manager/write?draft=${r.draft_id}`}>{r.title}</Link>
              : r.draft_id && onOpenNotice ? <button className="text-left underline" onClick={() => onOpenNotice(r.draft_id!)}>{r.title}</button>
              : r.draft_id ? <Link className="underline" href={`/manager?notice=${r.draft_id}`}>{r.title}</Link>
              : r.incident_id ? <Link className="underline" href={`/incidents/${r.incident_id}`}>{r.title}</Link> : r.title}
          </li>
        ))}</ul> : <p className="text-sm text-muted-foreground">No site activity for this {period} at the selected time.</p>}
    </section>
  );
}
