"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { IncidentStatusBadge, SeverityBadge } from "@/components/badges";
import { CitationList } from "@/components/citation-chip";
import { IncidentSources } from "@/components/incident-sources";
import { GatedButton } from "@/components/gated-button";
import { useApp } from "@/components/providers/app-context";
import { IncidentReasoning } from "@/components/incident-reasoning";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader } from "@/components/states";
import { Timeline, TimelineStages } from "@/components/timeline";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiError } from "@/lib/api";
import { useCategoryLabel, useIncident, usePatchIncident } from "@/lib/queries";
import { denyReason } from "@/lib/roles";
import { fmtDateTime } from "@/lib/time";

export default function IncidentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const incident = useIncident(id);
  const { role } = useApp();
  const patch = usePatchIncident(id);
  const categoryLabel = useCategoryLabel();
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
  const manage = denyReason(role, "act_on_alert");
  const closed = i.status === "resolved" || i.status === "closed";
  return (
    <>
      {back}
      <PageHeader
        title={i.summary ?? i.title}
        description={`${i.id}${i.category ? ` · ${categoryLabel(i.category)}` : ""}${i.report_count != null ? ` · ${i.report_count} report${i.report_count === 1 ? "" : "s"} from ${i.reporter_count} ${i.reporter_count === 1 ? "person" : "people"}` : ""}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {i.severity && <SeverityBadge severity={i.severity} className="text-sm" />}
            <IncidentStatusBadge status={i.status} className="text-sm" />
            {closed ? (
              <GatedButton reason={manage} size="sm" variant="outline" disabled={patch.isPending} onClick={() => patch.mutate("open")}>
                Reopen
              </GatedButton>
            ) : (
              <GatedButton reason={manage} size="sm" disabled={patch.isPending} onClick={() => patch.mutate("resolved")}>
                {i.status === "monitoring" ? "Confirm resolved" : "Mark resolved"}
              </GatedButton>
            )}
          </div>
        }
      />
      {patch.isError && <ErrorState error={patch.error} />}
      {i.merged_into_id && (
        <p className="mb-3 rounded-md border bg-muted p-3 text-sm">
          This incident was merged into{" "}
          <Link className="underline" href={`/incidents/${i.merged_into_id}`}>
            another incident
          </Link>
          .
        </p>
      )}
      {i.recurrence_of_id && (
        <p className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
          Recurrence: this problem was resolved within the last 72 hours.{" "}
          <Link className="underline" href={`/incidents/${i.recurrence_of_id}`}>
            See the earlier incident
          </Link>
          .
        </p>
      )}
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="sources">Sources{i.report_count != null ? ` (${i.report_count})` : ""}</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="flex flex-col gap-4">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <Card>
              <CardHeader>
                <CardTitle>Facts</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                  <dt className="text-muted-foreground">Activity</dt>
                  <dd className="font-mono">{i.activity_code ?? "Unknown"}</dd>
                  <dt className="text-muted-foreground">Zone</dt>
                  <dd>{i.zone ?? "Unknown"}</dd>
                  <dt className="text-muted-foreground">Occurred</dt>
                  <dd>{i.occurred_at ? fmtDateTime(i.occurred_at) : "Unknown"}</dd>
                  <dt className="text-muted-foreground">Reported</dt>
                  <dd>{fmtDateTime(i.reported_at)}</dd>
                  <dt className="text-muted-foreground">Affected workers</dt>
                  <dd>{i.affected_workers ?? "Unknown"}</dd>
                  <dt className="text-muted-foreground">Equipment</dt>
                  <dd>{i.equipment_id ?? i.asset_key ?? "Unknown"}</dd>
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
          <IncidentReasoning incidentId={i.id} />
        </TabsContent>
        <TabsContent value="sources">
          <Card>
            <CardHeader>
              <CardTitle>Reports behind this incident</CardTitle>
            </CardHeader>
            <CardContent>
              <IncidentSources incidentId={i.id} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </>
  );
}
