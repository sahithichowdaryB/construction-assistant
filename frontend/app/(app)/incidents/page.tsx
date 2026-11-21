"use client";

import { ChevronRight, Siren } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { CitationList } from "@/components/citation-chip";
import { useApp } from "@/components/providers/app-context";
import { EmptyState, LoadingSkeleton, PageHeader, QueryState } from "@/components/states";
import { TimelineStages } from "@/components/timeline";
import { Button } from "@/components/ui/button";
import { INCIDENT_STATUS_LABEL, INCIDENT_TYPE_LABEL } from "@/lib/format";
import { useIncidents } from "@/lib/queries";
import { fmtDateTime } from "@/lib/time";
import type { Incident } from "@/lib/types";
import { cn } from "@/lib/utils";

type Filter = "all" | "open" | "resolved";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "resolved", label: "Resolved" },
];

/** "Open" covers everything not yet resolved, including reports awaiting confirmation. */
const matches = (i: Incident, f: Filter) => (f === "all" ? true : f === "resolved" ? i.status === "resolved" : i.status !== "resolved");

const STATUS_CLS: Record<Incident["status"], string> = {
  resolved: "border-emerald-300 bg-emerald-50 text-emerald-800",
  open: "border-amber-300 bg-amber-50 text-amber-900",
  pending_confirmation: "border-sky-300 bg-sky-50 text-sky-800",
};

export default function IncidentsPage() {
  const { asOf } = useApp();
  const [filter, setFilter] = useState<Filter>("all");
  const [upToAsOf, setUpToAsOf] = useState(false);
  const incidents = useIncidents({ upToAsOf });

  const counts = useMemo(() => {
    const list = incidents.data ?? [];
    return Object.fromEntries(FILTERS.map((f) => [f.value, list.filter((i) => matches(i, f.value)).length])) as Record<Filter, number>;
  }, [incidents.data]);

  return (
    <>
      <PageHeader
        title="Incidents"
        description={
          upToAsOf
            ? `Incidents reported by ${fmtDateTime(asOf)}.`
            : "Every incident reported on site, with its current status and the evidence behind it."
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter incidents by status">
          {FILTERS.map((f) => (
            <Button key={f.value} size="touch" variant={filter === f.value ? "default" : "outline"} aria-pressed={filter === f.value} onClick={() => setFilter(f.value)}>
              {f.label}
              {incidents.data && <span className={cn("tabular-nums", filter !== f.value && "text-muted-foreground")}>({counts[f.value]})</span>}
            </Button>
          ))}
        </div>
        <label className="flex min-h-11 items-center gap-2 text-sm md:ml-auto md:min-h-0">
          <input type="checkbox" className="size-4" checked={upToAsOf} onChange={(e) => setUpToAsOf(e.target.checked)} />
          Only show what was reported by the time I&apos;m viewing
        </label>
      </div>

      <QueryState
        query={incidents}
        loading={<LoadingSkeleton variant="cards" rows={3} />}
        empty={
          <EmptyState
            icon={<Siren />}
            title={upToAsOf ? "Nothing reported by this time" : "No incidents reported"}
            description={upToAsOf ? "Untick the time filter to see every incident." : "Incidents reported from Site notes appear here."}
          />
        }
      >
        {(list) => {
          const shown = list.filter((i) => matches(i, filter));
          if (!shown.length)
            return (
              <EmptyState
                title={filter === "open" ? "No open incidents" : "No resolved incidents"}
                action={
                  <Button variant="outline" size="touch" onClick={() => setFilter("all")}>
                    Show all incidents
                  </Button>
                }
              />
            );
          return (
            <ul className="flex flex-col gap-3">
              {shown.map((i) => (
                <li key={i.id} className="relative rounded-lg border bg-card p-4 shadow-xs">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className={cn("rounded-md border px-1.5 py-0.5 font-medium", STATUS_CLS[i.status])}>{INCIDENT_STATUS_LABEL[i.status]}</span>
                    <span className="text-muted-foreground">{INCIDENT_TYPE_LABEL[i.type]}</span>
                    {i.activity_code && <span className="font-mono">Activity {i.activity_code}</span>}
                    <span className="ml-auto font-mono text-muted-foreground">{i.id}</span>
                  </div>
                  <Link href={`/incidents/${encodeURIComponent(i.id)}`} className="mt-1.5 flex items-start gap-1 font-medium after:absolute after:inset-0 hover:underline">
                    {i.title}
                    <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    Happened {i.occurred_at ? fmtDateTime(i.occurred_at) : "(time not recorded)"} · reported {fmtDateTime(i.reported_at)}
                    {i.resolved_at && <> · resolved {fmtDateTime(i.resolved_at)}</>}
                  </p>
                  <div className="relative z-10 mt-3 flex flex-col gap-2">
                    <TimelineStages events={i.timeline} />
                    <CitationList refs={i.refs} />
                  </div>
                </li>
              ))}
            </ul>
          );
        }}
      </QueryState>
    </>
  );
}
