"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { CitationList } from "@/components/citation-chip";
import { IncidentReasoning } from "@/components/incident-reasoning";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader } from "@/components/states";
import { Timeline, TimelineStages } from "@/components/timeline";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiError } from "@/lib/api";
import { useIncident } from "@/lib/queries";
import { fmtDateTime } from "@/lib/time";

export default function IncidentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const incident = useIncident(id);
  const back = (
    <Link href="/incidents" className="mb-3 inline-flex min-h-11 items-center gap-1 text-sm hover:underline md:min-h-0">
      <ArrowLeft className="size-4" aria-hidden /> Incidents
    </Link>
  );
  if (incident.isPending) return <>{back}<LoadingSkeleton variant="detail" rows={2} /></>;
  if (incident.isError)
    return (
      <>
        {back}
        {incident.error instanceof ApiError && incident.error.status === 404 ? (
          <EmptyState title="Incident not available" description={incident.error.message} />
        ) : (
          <ErrorState error={incident.error} onRetry={() => void incident.refetch()} />
        )}
      </>
    );
  const i = incident.data;
  return (
    <>
      {back}
      <PageHeader title={i.title} description={`${i.id} · ${i.status === "resolved" ? `resolved ${fmtDateTime(i.resolved_at)}` : "open"}`} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Facts</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Activity</dt>
              <dd className="font-mono">{i.activity_code ?? "Unknown"}</dd>
              <dt className="text-muted-foreground">Occurred</dt>
              <dd>{i.occurred_at ? fmtDateTime(i.occurred_at) : "Unknown"}</dd>
              <dt className="text-muted-foreground">Reported</dt>
              <dd>{fmtDateTime(i.reported_at)}</dd>
              <dt className="text-muted-foreground">Affected workers</dt>
              <dd>{i.affected_workers ?? "Unknown"}</dd>
              <dt className="text-muted-foreground">Equipment</dt>
              <dd>{i.equipment_id ?? "Unknown"}</dd>
              <dt className="text-muted-foreground">Resolved</dt>
              <dd>{i.resolved_at ? fmtDateTime(i.resolved_at) : "Not yet"}</dd>
              <dt className="text-muted-foreground">Sources</dt>
              <dd>
                <CitationList refs={i.refs} />
              </dd>
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="gap-2">
            <CardTitle>Timeline</CardTitle>
            <TimelineStages events={i.timeline} />
          </CardHeader>
          <CardContent>{i.timeline.length ? <Timeline events={i.timeline} /> : <EmptyState title="No events yet" />}</CardContent>
        </Card>
      </div>
      <div className="mt-4">
        <IncidentReasoning incidentId={i.id} />
      </div>
    </>
  );
}
