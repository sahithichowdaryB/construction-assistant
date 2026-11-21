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
import type { Severity } from "@/lib/types";

type Filter = "all" | Severity | "missing_report";

export default function AlertsPage() {
  const alerts = useAlerts();
  const activities = useActivities();
  const { asOf, setAsOf } = useApp();
  const [filter, setFilter] = useState<Filter>("all");
  const byCode = new Map(activities.data?.map((a) => [a.code, a]));

  return (
    <>
      <PageHeader title="Alerts" description={`Signed shortfalls and missing reports as of ${fmtDateTime(asOf)}`} />
      <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Filter alerts">
        {(["all", "high", "medium", "missing_report"] as Filter[]).map((f) => (
          <Button key={f} size="touch" variant={filter === f ? "default" : "outline"} aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {f === "all" ? "All" : f === "missing_report" ? "Missing report" : f[0].toUpperCase() + f.slice(1)}
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
          const shown = list.filter((a) =>
            filter === "all" ? true : filter === "missing_report" ? a.kind === "missing_report" : a.kind !== "missing_report" && a.severity === filter,
          );
          return shown.length ? (
            <div className="grid gap-2 md:grid-cols-2">
              {shown.map((a) => (
                <AlertCard key={a.id} alert={a} activity={byCode.get(a.activity_code)} />
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
