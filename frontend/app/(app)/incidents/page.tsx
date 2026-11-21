"use client";

import { ChevronRight, Siren } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { IncidentStatusBadge, SeverityBadge } from "@/components/badges";
import { CitationList } from "@/components/citation-chip";
import { useApp } from "@/components/providers/app-context";
import { EmptyState, LoadingSkeleton, PageHeader, QueryState } from "@/components/states";
import { TimelineStages } from "@/components/timeline";
import { SiteActivity } from "@/components/site-activity";
import { Button } from "@/components/ui/button";
import { INCIDENT_TYPE_LABEL } from "@/lib/format";
import { useCategoryLabel, useIncidents } from "@/lib/queries";
import { fmtDateTime, localDateOf } from "@/lib/time";
import type { Incident } from "@/lib/types";
import { cn } from "@/lib/utils";

type Filter = "all" | "open" | "resolved";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "resolved", label: "Resolved" },
];

const FINISHED = new Set<Incident["status"]>(["resolved", "closed"]);
/** "Open" covers everything not yet resolved: new, being monitored after a repair, or awaiting confirmation. */
const matches = (i: Incident, f: Filter) => (f === "all" ? true : f === "resolved" ? FINISHED.has(i.status) : !FINISHED.has(i.status));

export default function IncidentsPage() {
  const { asOf, role } = useApp();
  const [filter, setFilter] = useState<Filter>("all");
  const [scope, setScope] = useState("all");
  const upToAsOf = scope !== "all";
  const incidents = useIncidents({ upToAsOf });
  const categoryLabel = useCategoryLabel();

  const day = localDateOf(asOf);
  const visible = useMemo(() => {
    const all = incidents.data ?? [];
    if (scope !== "day") return all;
    return all.filter((i) => [i.occurred_at, i.reported_at, ...i.timeline.map((e) => e.at)]
      .some((instant) => instant && localDateOf(instant) === day));
  }, [incidents.data, scope, day]);
  const counts = useMemo(() => {
    const list = visible;
    return Object.fromEntries(FILTERS.map((f) => [f.value, list.filter((i) => matches(i, f.value)).length])) as Record<Filter, number>;
  }, [visible]);

  return (
    <>
      <PageHeader
        title="Incident insights"
        description={
          upToAsOf
            ? `Incidents reported by ${fmtDateTime(asOf)}.`
            : "Every incident reported on site, with its current status and the evidence behind it."
        }
      />

      {role === "site_manager" && <SiteActivity date={day} />}
      <h2 className="mb-2 font-semibold">Incidents</h2>
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
          Show
          <select className="rounded-md border p-2" value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="all">All dates</option>
            <option value="day">Activity on {day}</option>
            <option value="cutoff">Reported by the selected time</option>
          </select>
        </label>
      </div>

      <QueryState
        query={incidents}
        loading={<LoadingSkeleton variant="cards" rows={3} />}
        empty={
          <EmptyState
            icon={<Siren />}
            title={upToAsOf ? "Nothing reported by this time" : "No incidents reported"}
            description={upToAsOf ? "Choose All dates to see every incident." : "Incidents reported from Site notes appear here."}
          />
        }
      >
        {() => {
          const shown = visible.filter((i) => matches(i, filter));
          if (!shown.length)
            return (
              <EmptyState
                title={scope === "day" ? "No matching incidents on this day" : filter === "open" ? "No open incidents" : "No resolved incidents"}
                action={
                  <Button variant="outline" size="touch" onClick={() => { setFilter("all"); setScope("all"); }}>
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
                    <IncidentStatusBadge status={i.status} />
                    {i.severity && <SeverityBadge severity={i.severity} />}
                    <span className="text-muted-foreground">{i.category ? categoryLabel(i.category) : INCIDENT_TYPE_LABEL[i.type]}</span>
                    {i.zone && <span className="text-muted-foreground">Zone {i.zone}</span>}
                    {i.activity_code && <span className="font-mono">Activity {i.activity_code}</span>}
                    <span className="ml-auto font-mono text-muted-foreground">{i.id}</span>
                  </div>
                  <Link href={`/incidents/${encodeURIComponent(i.id)}`} className="mt-1.5 flex items-start gap-1 font-medium after:absolute after:inset-0 hover:underline">
                    {i.summary ?? i.title}
                    <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  </Link>
                  {i.report_count != null && (
                    <p className="text-sm">
                      {i.report_count} report{i.report_count === 1 ? "" : "s"} from {i.reporter_count} {i.reporter_count === 1 ? "person" : "people"}
                    </p>
                  )}
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
