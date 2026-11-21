"use client";

import { BellOff } from "lucide-react";
import { useState } from "react";
import { AlertCard } from "@/components/alert-card";
import { useApp } from "@/components/providers/app-context";
import { EmptyState, LoadingSkeleton, PageHeader, QueryState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { useActivities, useAlerts } from "@/lib/queries";
import { AS_OF_PRESETS, fmtDateTime, localToIso } from "@/lib/time";
import type { Alert } from "@/lib/types";

type Filter = "all" | "open" | "acknowledged" | "incident" | "shortfall" | "high" | "missing_report";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "acknowledged", label: "Acknowledged" },
  { value: "incident", label: "Reported problems" },
  { value: "shortfall", label: "Behind plan" },
  { value: "high", label: "High priority" },
  { value: "missing_report", label: "No report" },
];

const statusOf = (a: Alert) => a.status ?? "open"; // fixture alerts carry no status: they are open
const matches = (a: Alert, f: Filter) =>
  f === "all" ? true
  : f === "open" || f === "acknowledged" ? statusOf(a) === f
  : f === "incident" ? a.kind === "incident"
  : f === "shortfall" ? a.kind !== "incident" && a.kind !== "missing_report"
  : f === "high" ? a.severity === "high" || a.severity === "critical"
  : a.kind === "missing_report";

export default function AlertsPage() {
  const alerts = useAlerts();
  const activities = useActivities();
  const { asOf, setAsOf } = useApp();
  const [filter, setFilter] = useState<Filter>("all");
  const byCode = new Map(activities.data?.map((a) => [a.code, a]));

  return (
    <>
      <PageHeader title="Alerts" description={`Problems reported on site, activities behind plan, and missing daily reports, as of ${fmtDateTime(asOf)}.`} />
      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filter alerts">
        {FILTERS.map((f) => (
          <Button key={f.value} size="touch" variant={filter === f.value ? "default" : "outline"} aria-pressed={filter === f.value} onClick={() => setFilter(f.value)}>
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
            description="Every activity is on track at this time."
            action={
              <Button size="touch" variant="outline" onClick={() => setAsOf(localToIso(AS_OF_PRESETS[2].local))}>
                Look at {AS_OF_PRESETS[2].label}
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
            <EmptyState
              title="No alerts match this filter"
              action={
                <Button variant="outline" size="touch" onClick={() => setFilter("all")}>
                  Show all alerts
                </Button>
              }
            />
          );
        }}
      </QueryState>
    </>
  );
}
