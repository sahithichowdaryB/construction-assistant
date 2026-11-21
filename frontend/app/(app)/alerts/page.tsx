"use client";

import { BellOff } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { AlertCard } from "@/components/alert-card";
import { EmptyState, LoadingSkeleton, PageHeader, QueryState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { AS_OF_PRESETS, fmtDateTime, localToIso } from "@/lib/time";
import { useActivities, useAlerts } from "@/lib/queries";
import { useApp } from "@/components/providers/app-context";
import type { Alert } from "@/lib/types";

const statusOf = (a: Alert) => a.status ?? "open"; // fixture alerts carry no status: they are open
const matches = (a: Alert, f: Filter) =>
  f === "all" ? true
  : f === "open" || f === "acknowledged" ? statusOf(a) === f
  : f === "incident" ? a.kind === "incident"
  : f === "shortfall" ? a.kind !== "incident" && a.kind !== "missing_report"
  : f === "high" ? a.severity === "high" || a.severity === "critical"
  : a.kind === "missing_report";

type Filter = "all" | "open" | "acknowledged" | "incident" | "shortfall" | "high" | "missing_report";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "open", label: "Open" },
  { key: "acknowledged", label: "Acknowledged" },
  { key: "incident", label: "Incident" },
  { key: "shortfall", label: "Shortfall" },
  { key: "high", label: "High+" },
  { key: "missing_report", label: "Missing report" },
];

export default function AlertsPage() {
  const alerts = useAlerts();
  const activities = useActivities();
  const { asOf, setAsOf } = useApp();
  const [filter, setFilter] = useState<Filter>("all");
  const byCode = new Map(activities.data?.map((a) => [a.code, a]));

  return (
    <>
      <PageHeader title="Alerts" description={`Incident alerts, signed shortfalls and missing reports as of ${fmtDateTime(asOf)}`} />
      <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Filter alerts">
        {FILTERS.map((f) => (
          <Button key={f.key} size="touch" variant={filter === f.key ? "default" : "outline"} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
            {f.label}
          </Button>
        ))}
      </div>
      <QueryState
        query={alerts}
        loading={<LoadingSkeleton variant="cards" rows={3} />}
        empty={
          <EmptyState
            icon={<BellOff />}
            title="No open alerts"
            description="No signed reading is below the threshold at this time."
            action={
              <Button size="touch" variant="outline" onClick={() => setAsOf(localToIso(AS_OF_PRESETS[2].local))}>
                Jump to {AS_OF_PRESETS[2].label}
              </Button>
            }
          />
        }
      >
        {(list) => {
          const shown = list.filter((a) => matches(a, filter));
          return shown.length ? (
            <div className="grid gap-2 md:grid-cols-2">
              {shown.map((a) => (
                <AlertCard key={a.id} alert={a} activity={byCode.get(a.activity_code ?? "")} />
              ))}
            </div>
          ) : (
            <EmptyState title="No alerts match this filter" action={<Link href="/alerts" onClick={() => setFilter("all")} className="underline">Show all</Link>} />
          );
        }}
      </QueryState>
    </>
  );
}
