"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { AlertStatusBadge, SeverityBadge } from "@/components/badges";
import { CitationList } from "@/components/citation-chip";
import { basisLabel, fmtPct, fmtQty } from "@/lib/format";
import { useCategoryLabel } from "@/lib/queries";
import { fmtDateTime, fmtLocalDate, localDateOf } from "@/lib/time";
import type { Activity, Alert } from "@/lib/types";
import { cn } from "@/lib/utils";

export function alertSummary(alert: Alert): string {
  if (alert.kind === "incident") return alert.title ?? "Incident";
  if (alert.kind === "missing_report") return "No daily report received. Quantity unknown.";
  const c = alert.calculation;
  if (!c) return "Details not available yet";
  if (c.actual === null) return `No figure recorded against ${fmtQty(c.planned, c.unit)} planned`;
  if (c.planned === 0) return `${fmtQty(c.actual, c.unit)} done; no target set for this day`;
  return `${fmtQty(c.actual, c.unit)} of ${fmtQty(c.planned, c.unit)} done · ${fmtPct(c.shortfall_pct)} behind plan`;
}

export function AlertCard({ alert, activity, className }: { alert: Alert; activity?: Activity; className?: string }) {
  const categoryLabel = useCategoryLabel();
  const incident = alert.kind === "incident";
  const tone =
    alert.kind === "missing_report"
      ? "bg-amber-500"
      : alert.severity === "high" || alert.severity === "critical"
        ? "bg-red-500"
        : alert.severity === "medium"
          ? "bg-amber-500"
          : "bg-muted-foreground/40";
  return (
    <article className={cn("relative rounded-2xl bg-card p-4 pl-5 shadow-[0_1px_2px_rgba(17,18,20,0.04)] transition hover:shadow-md", className)}>
      <span className={cn("absolute top-4 bottom-4 left-0 w-1 rounded-r-full", tone)} aria-hidden />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={alert.severity} kind={alert.kind} />
            {incident ? (
              <>
                {alert.status && <AlertStatusBadge status={alert.status} />}
                {alert.category && <span className="rounded-md bg-secondary px-1.5 py-0.5 text-xs font-medium">{categoryLabel(alert.category)}</span>}
              </>
            ) : (
              <span className="font-mono text-sm font-semibold">{alert.activity_code}</span>
            )}
            {activity && <span className="truncate text-sm text-muted-foreground">{activity.name}</span>}
          </div>
          <p className="mt-1 text-sm">
            <Link href={`/alerts/${encodeURIComponent(alert.id)}`} className="font-medium after:absolute after:inset-0 hover:underline">
              {alertSummary(alert)}
            </Link>
          </p>
          {incident ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {alert.report_count} report{alert.report_count === 1 ? "" : "s"} from {alert.reporter_count} {alert.reporter_count === 1 ? "person" : "people"}
              {alert.assigned_to ? ` · assigned to ${alert.assigned_to}` : ""} · last updated {fmtDateTime(alert.as_of)}
            </p>
          ) : (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {fmtLocalDate(localDateOf(alert.checkpoint_at))} · last updated {fmtDateTime(alert.as_of)}
              {alert.kind !== "missing_report" && " · " + basisLabel("signed")}
            </p>
          )}
        </div>
        <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden />
      </div>
      <div className="relative z-10 mt-2">
        <CitationList refs={alert.evidence_refs} />
      </div>
    </article>
  );
}
