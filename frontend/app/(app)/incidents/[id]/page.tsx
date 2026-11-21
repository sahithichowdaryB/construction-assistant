"use client";

import { ArrowLeft, ArrowRight, FilePen } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { IncidentStatusBadge, SeverityBadge } from "@/components/badges";
import { CitationList } from "@/components/citation-chip";
import { GatedButton } from "@/components/gated-button";
import { IncidentReasoning } from "@/components/incident-reasoning";
import { IncidentSources } from "@/components/incident-sources";
import { useApp } from "@/components/providers/app-context";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader } from "@/components/states";
import { Timeline, TimelineStages } from "@/components/timeline";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiError } from "@/lib/api";
import { INCIDENT_STATUS_LABEL, INCIDENT_TYPE_LABEL } from "@/lib/format";
import { useCategoryLabel, useIncident, usePatchIncident } from "@/lib/queries";
import { denyReason } from "@/lib/roles";
import { fmtDateTime } from "@/lib/time";

export default function IncidentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const incidentId = decodeURIComponent(id);
  const { role } = useApp();
  const router = useRouter();
  const incident = useIncident(incidentId);
  const patch = usePatchIncident(incidentId);
  const categoryLabel = useCategoryLabel();

  const back = (
    <Link href="/incidents" className="mb-3 inline-flex min-h-11 items-center gap-1 text-sm hover:underline md:min-h-0">
      <ArrowLeft className="size-4" aria-hidden /> All incidents
    </Link>
  );
  if (incident.isPending)
    return (
      <>
        {back}
        <LoadingSkeleton variant="detail" rows={2} />
      </>
    );
  if (incident.isError)
    return (
      <>
        {back}
        {incident.error instanceof ApiError && incident.error.status === 404 ? (
          <EmptyState title="Incident not found" description="It may have been removed, or the link is out of date." />
        ) : (
          <ErrorState error={incident.error} onRetry={() => void incident.refetch()} />
        )}
      </>
    );

  const i = incident.data;
  // Timeline entries with a link point at the alert or notice already raised for this incident.
  const related = i.timeline.filter((e) => e.link);
  const noticeReason = denyReason(role, "create_draft");
  const manageReason = denyReason(role, "act_on_alert");
  const finished = i.status === "resolved" || i.status === "closed";

  return (
    <>
      {back}
      <PageHeader
        title={i.summary ?? i.title}
        description={`${i.category ? categoryLabel(i.category) : INCIDENT_TYPE_LABEL[i.type]}${i.report_count != null ? ` · ${i.report_count} report${i.report_count === 1 ? "" : "s"} from ${i.reporter_count} ${i.reporter_count === 1 ? "person" : "people"}` : ""} · ${i.id}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {i.severity && <SeverityBadge severity={i.severity} className="text-sm" />}
            <IncidentStatusBadge status={i.status} className="text-sm" />
            {finished ? (
              <GatedButton reason={manageReason} size="touch" variant="outline" disabled={patch.isPending} onClick={() => patch.mutate("open")}>
                Reopen
              </GatedButton>
            ) : (
              <GatedButton reason={manageReason} size="touch" variant="outline" disabled={patch.isPending} onClick={() => patch.mutate("resolved")}>
                {i.status === "monitoring" ? "Confirm resolved" : "Mark resolved"}
              </GatedButton>
            )}
            <GatedButton reason={noticeReason} size="touch" onClick={() => router.push(`/drafts/new?incident=${encodeURIComponent(i.id)}`)}>
              <FilePen aria-hidden /> Create a notice
            </GatedButton>
          </div>
        }
      />
      {patch.isError && <ErrorState error={patch.error} />}
      {i.merged_into_id && (
        <p className="mb-3 rounded-2xl bg-muted p-3 text-sm">
          This incident was merged into{" "}
          <Link className="underline" href={`/incidents/${i.merged_into_id}`}>
            another incident
          </Link>
          .
        </p>
      )}
      {i.recurrence_of_id && (
        <p className="mb-3 rounded-2xl bg-warning/10 p-3 text-sm">
          This problem came back: it was resolved within the last 72 hours.{" "}
          <Link className="underline" href={`/incidents/${i.recurrence_of_id}`}>
            See the earlier incident
          </Link>
          .
        </p>
      )}

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="sources">Reports{i.report_count != null ? ` (${i.report_count})` : ""}</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <div className="flex flex-col gap-4">
              <Card>
                <CardHeader>
                  <CardTitle>Details</CardTitle>
                </CardHeader>
                <CardContent>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                    <dt className="text-muted-foreground">Status</dt>
                    <dd>{INCIDENT_STATUS_LABEL[i.status]}</dd>
                    <dt className="text-muted-foreground">Zone</dt>
                    <dd>{i.zone ?? "Not recorded"}</dd>
                    <dt className="text-muted-foreground">Activity</dt>
                    <dd>{i.activity_code ?? "Not linked to an activity"}</dd>
                    <dt className="text-muted-foreground">Happened</dt>
                    <dd>{i.occurred_at ? fmtDateTime(i.occurred_at) : "Time not recorded"}</dd>
                    <dt className="text-muted-foreground">Reported</dt>
                    <dd>{fmtDateTime(i.reported_at)}</dd>
                    <dt className="text-muted-foreground">People affected</dt>
                    <dd>{i.affected_workers ?? "Not recorded"}</dd>
                    <dt className="text-muted-foreground">Equipment</dt>
                    <dd>{i.equipment_id ?? i.asset_key ?? "Not recorded"}</dd>
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
                <CardHeader>
                  <CardTitle>Next steps</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                  {related.length ? (
                    related.map((e, n) => (
                      <Button key={`${e.kind}-${e.at}-${n}`} asChild variant="outline" size="touch" className="h-auto min-h-11 justify-between py-2 whitespace-normal">
                        <Link href={e.link!}>
                          <span className="text-left">{e.label}</span>
                          <ArrowRight aria-hidden />
                        </Link>
                      </Button>
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      No alert or notice is linked yet.{!noticeReason && " Use “Create a notice” to start the paperwork."}
                    </p>
                  )}
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader className="gap-3">
                <CardTitle>What has happened</CardTitle>
                <TimelineStages events={i.timeline} />
              </CardHeader>
              <CardContent>{i.timeline.length ? <Timeline events={i.timeline} /> : <EmptyState title="Nothing recorded yet" />}</CardContent>
            </Card>
          </div>

          <div className="mt-4">
            <IncidentReasoning incidentId={i.id} />
          </div>
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
