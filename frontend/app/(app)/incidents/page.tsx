"use client";

import { Siren } from "lucide-react";
import Link from "next/link";
import { IncidentStatusBadge, SeverityBadge } from "@/components/badges";
import { CitationList } from "@/components/citation-chip";
import { EmptyState, LoadingSkeleton, PageHeader, QueryState } from "@/components/states";
import { TimelineStages } from "@/components/timeline";
import { useCategoryLabel, useIncidents } from "@/lib/queries";
import { fmtDateTime } from "@/lib/time";

export default function IncidentsPage() {
  const incidents = useIncidents();
  const categoryLabel = useCategoryLabel();
  return (
    <>
      <PageHeader title="Incidents" description="Confirmed site events and the evidence, alerts and drafts linked to them." />
      <QueryState
        query={incidents}
        loading={<LoadingSkeleton variant="cards" rows={2} />}
        empty={<EmptyState icon={<Siren />} title="No incidents yet" description="Nothing has been reported by this time." />}
      >
        {(list) => (
          <ul className="flex flex-col gap-3">
            {list.map((i) => (
              <li key={i.id} className="relative rounded-lg border p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <IncidentStatusBadge status={i.status} />
                  {i.severity && <SeverityBadge severity={i.severity} />}
                  {i.category && <span className="rounded-md border bg-secondary px-1.5 py-0.5 text-xs font-medium">{categoryLabel(i.category)}</span>}
                  {i.activity_code && <span className="font-mono text-xs">{i.activity_code}</span>}
                  {i.zone && <span className="text-xs text-muted-foreground">Zone {i.zone}</span>}
                </div>
                <Link href={`/incidents/${i.id}`} className="mt-1 block font-medium after:absolute after:inset-0 hover:underline">
                  {i.summary ?? i.title}
                </Link>
                {i.report_count != null && (
                  <p className="text-sm">
                    {i.report_count} report{i.report_count === 1 ? "" : "s"} from {i.reporter_count} {i.reporter_count === 1 ? "person" : "people"}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  Occurred {i.occurred_at ? fmtDateTime(i.occurred_at) : "Unknown"} · reported {fmtDateTime(i.reported_at)}
                </p>
                <div className="relative z-10 mt-3 flex flex-col gap-2">
                  <TimelineStages events={i.timeline} />
                  <CitationList refs={i.refs} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
    </>
  );
}
