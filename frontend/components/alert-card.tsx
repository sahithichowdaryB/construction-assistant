"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { SeverityBadge } from "@/components/badges";
import { CitationList } from "@/components/citation-chip";
import { basisLabel, fmtPct, fmtQty } from "@/lib/format";
import { fmtDateTime, fmtLocalDate, localDateOf } from "@/lib/time";
import type { Activity, Alert } from "@/lib/types";
import { cn } from "@/lib/utils";

export function alertSummary(alert: Alert): string {
  if (alert.kind === "missing_report") return "Shift report not received. Quantity unknown.";
  const c = alert.calculation;
  if (!c) return "No calculation recorded";
  if (c.actual === null) return `Unknown of ${fmtQty(c.planned, c.unit)} (no reading)`;
  if (c.planned === 0) return `${fmtQty(c.actual, c.unit)} against a zero target (no percentage)`;
  return `${fmtQty(c.actual, c.unit)} of ${fmtQty(c.planned, c.unit)} · ${fmtPct(c.shortfall_pct)} short`;
}

export function AlertCard({ alert, activity, className }: { alert: Alert; activity?: Activity; className?: string }) {
  const tone =
    alert.kind === "missing_report"
      ? "border-l-amber-500"
      : alert.severity === "high"
        ? "border-l-red-500"
        : alert.severity === "medium"
          ? "border-l-amber-500"
          : "border-l-border";
  return (
    <article className={cn("relative rounded-lg border border-l-4 bg-card p-3 shadow-xs", tone, className)}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={alert.severity} kind={alert.kind} />
            <span className="font-mono text-sm font-semibold">{alert.activity_code}</span>
            {activity && <span className="truncate text-sm text-muted-foreground">{activity.name}</span>}
          </div>
          <p className="mt-1 text-sm">
            <Link href={`/alerts/${encodeURIComponent(alert.id)}`} className="font-medium after:absolute after:inset-0 hover:underline">
              {alertSummary(alert)}
            </Link>
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Work date {fmtLocalDate(localDateOf(alert.checkpoint_at))} · revision {alert.version} as of {fmtDateTime(alert.as_of)}
            {alert.kind !== "missing_report" && " · " + basisLabel("signed")}
          </p>
        </div>
        <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden />
      </div>
      <div className="relative z-10 mt-2">
        <CitationList refs={alert.evidence_refs} />
      </div>
    </article>
  );
}
