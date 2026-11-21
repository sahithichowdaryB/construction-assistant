"use client";

import { Siren } from "lucide-react";
import Link from "next/link";
import { CitationList } from "@/components/citation-chip";
import { EmptyState, LoadingSkeleton, PageHeader, QueryState } from "@/components/states";
import { TimelineStages } from "@/components/timeline";
import { useIncidents } from "@/lib/queries";
import { fmtDateTime } from "@/lib/time";
import { cn } from "@/lib/utils";

export default function IncidentsPage() {
  const incidents = useIncidents();
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
                  <span
                    className={cn(
                      "rounded-md border px-1.5 py-0.5 text-xs font-medium",
                      i.status === "resolved" ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-amber-300 bg-amber-50 text-amber-900",
                    )}
                  >
                    {i.status === "resolved" ? "Resolved" : "Open"}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">{i.id}</span>
                  {i.activity_code && <span className="font-mono text-xs">{i.activity_code}</span>}
                </div>
                <Link href={`/incidents/${i.id}`} className="mt-1 block font-medium after:absolute after:inset-0 hover:underline">
                  {i.title}
                </Link>
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
