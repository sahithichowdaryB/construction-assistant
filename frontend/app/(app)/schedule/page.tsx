"use client";

import { X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { SeverityBadge } from "@/components/badges";
import { CitationChip } from "@/components/citation-chip";
import { ProgressBar } from "@/components/progress-bar";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader, QueryState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { servedFromFixtures } from "@/lib/endpoints";
import { basisLabel, fmtQty } from "@/lib/format";
import { useActivities, useProgress } from "@/lib/queries";
import { fmtDateTime, fmtLocalDate } from "@/lib/time";
import type { Activity } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Reporting window of the Riverside demo (five signed reports). */
const REPORT_DATES = ["2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12"];

function DayView({ activity, date, onDate, onClose }: { activity: Activity; date: string; onDate: (d: string) => void; onClose: () => void }) {
  const progress = useProgress(activity.code, date);
  const live = !servedFromFixtures("progress");
  return (
    <Card className="mt-4" aria-live="polite">
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle>
            <span className="font-mono">{activity.code}</span> {activity.name}
          </CardTitle>
          <p className="text-xs text-muted-foreground">Day view · data from {live ? "live API" : "fixtures"}</p>
        </div>
        <Button variant="ghost" size="icon-touch" onClick={onClose} aria-label="Close day view">
          <X aria-hidden />
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Work date">
          {REPORT_DATES.map((d) => (
            <Button key={d} size="touch" variant={d === date ? "default" : "outline"} aria-pressed={d === date} onClick={() => onDate(d)}>
              {fmtLocalDate(d).replace(" 2026", "")}
            </Button>
          ))}
        </div>
        {progress.isPending ? (
          <LoadingSkeleton rows={2} />
        ) : progress.isError ? (
          <ErrorState error={progress.error} onRetry={() => void progress.refetch()} />
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <SeverityBadge severity={progress.data.severity} />
              <span className="text-sm text-muted-foreground">Plan</span>
              <CitationChip refData={progress.data.plan_evidence} />
              {progress.data.evidence && (
                <>
                  <span className="text-sm text-muted-foreground">Reading</span>
                  <CitationChip refData={progress.data.evidence} />
                </>
              )}
            </div>
            <ProgressBar
              planned={progress.data.planned}
              actual={progress.data.actual}
              unit={progress.data.unit}
              basis={progress.data.basis}
              shortfallPct={progress.data.shortfall_pct}
              severity={progress.data.severity}
            />
            <h3 className="text-sm font-semibold">Eligible observations</h3>
            {progress.data.observations.length ? (
              <ul className="flex flex-col divide-y rounded-md border text-sm">
                {progress.data.observations.map((o) => (
                  <li key={`${o.source_id}-${o.locator}`} className="flex flex-wrap items-center justify-between gap-2 p-3">
                    <span>
                      <span className="font-semibold">{fmtQty(o.quantity, progress.data.unit)}</span> · {basisLabel(o.basis)} · available {fmtDateTime(o.available_at)}
                    </span>
                    <CitationChip refData={{ source_id: o.source_id, locator: o.locator, page: o.page }} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No reading at this time: actual is Unknown.</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ScheduleInner() {
  const activities = useActivities();
  const params = useSearchParams();
  const router = useRouter();
  const code = params.get("code");
  const date = params.get("date") ?? "2026-11-10";

  const select = (c: string | null, d: string = date) => {
    const sp = new URLSearchParams();
    if (c) {
      sp.set("code", c);
      sp.set("date", d);
    }
    router.replace(`/schedule${sp.size ? `?${sp}` : ""}`, { scroll: false });
  };

  return (
    <>
      <PageHeader title="Schedule" description="Baseline programme. Select an activity to see plan versus actual for a day." />
      <QueryState query={activities} loading={<LoadingSkeleton rows={6} />} empty={<EmptyState title="No activities in the schedule" />}>
        {(list) => {
          const selected = list.find((a) => a.code === code);
          return (
            <>
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Code</TableHead>
                      <TableHead>Activity</TableHead>
                      <TableHead className="hidden sm:table-cell">Zone</TableHead>
                      <TableHead className="hidden md:table-cell">Unit</TableHead>
                      <TableHead className="hidden md:table-cell">Dates</TableHead>
                      <TableHead className="text-right">Planned/day</TableHead>
                      <TableHead className="hidden lg:table-cell">Predecessors</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {list.map((a) => (
                      <TableRow key={a.code} className={cn("cursor-pointer", a.code === code && "bg-muted")} aria-selected={a.code === code}>
                        <TableCell className="p-0">
                          <button
                            type="button"
                            className="min-h-11 w-full px-2 text-left font-mono font-semibold focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                            onClick={() => select(a.code)}
                            aria-label={`Open day view for ${a.code} ${a.name}`}
                          >
                            {a.code}
                          </button>
                        </TableCell>
                        <TableCell onClick={() => select(a.code)} className="whitespace-normal">
                          {a.name}
                        </TableCell>
                        <TableCell className="hidden sm:table-cell" onClick={() => select(a.code)}>{a.zone}</TableCell>
                        <TableCell className="hidden md:table-cell" onClick={() => select(a.code)}>{a.unit}</TableCell>
                        <TableCell className="hidden md:table-cell" onClick={() => select(a.code)}>
                          {fmtLocalDate(a.planned_start)} – {fmtLocalDate(a.planned_end)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums" onClick={() => select(a.code)}>
                          {fmtQty(a.planned_qty_per_day, a.unit)}
                        </TableCell>
                        <TableCell className="hidden lg:table-cell font-mono text-xs" onClick={() => select(a.code)}>
                          {a.predecessors.length ? a.predecessors.join(", ") : "None"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {selected && <DayView activity={selected} date={date} onDate={(d) => select(selected.code, d)} onClose={() => select(null)} />}
            </>
          );
        }}
      </QueryState>
    </>
  );
}

export default function SchedulePage() {
  return (
    <Suspense fallback={<LoadingSkeleton rows={6} />}>
      <ScheduleInner />
    </Suspense>
  );
}
