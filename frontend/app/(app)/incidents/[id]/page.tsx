"use client";

import { ArrowLeft, ArrowRight, FilePen } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { CitationList } from "@/components/citation-chip";
import { GatedButton } from "@/components/gated-button";
import { IncidentReasoning } from "@/components/incident-reasoning";
import { useApp } from "@/components/providers/app-context";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader } from "@/components/states";
import { Timeline, TimelineStages } from "@/components/timeline";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiError } from "@/lib/api";
import { INCIDENT_STATUS_LABEL, INCIDENT_TYPE_LABEL } from "@/lib/format";
import { useIncident } from "@/lib/queries";
import { denyReason } from "@/lib/roles";
import { fmtDateTime } from "@/lib/time";

export default function IncidentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const incidentId = decodeURIComponent(id);
  const { role } = useApp();
  const router = useRouter();
  const incident = useIncident(incidentId);

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

  return (
    <>
      {back}
      <PageHeader
        title={i.title}
        description={`${INCIDENT_TYPE_LABEL[i.type]} · ${i.status === "resolved" ? `resolved ${fmtDateTime(i.resolved_at)}` : INCIDENT_STATUS_LABEL[i.status].toLowerCase()} · ${i.id}`}
        actions={
          <GatedButton reason={noticeReason} size="touch" onClick={() => router.push(`/drafts/new?incident=${encodeURIComponent(i.id)}`)}>
            <FilePen aria-hidden /> Create a notice
          </GatedButton>
        }
      />

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
                <dt className="text-muted-foreground">Activity</dt>
                <dd>{i.activity_code ?? "Not linked to an activity"}</dd>
                <dt className="text-muted-foreground">Happened</dt>
                <dd>{i.occurred_at ? fmtDateTime(i.occurred_at) : "Time not recorded"}</dd>
                <dt className="text-muted-foreground">Reported</dt>
                <dd>{fmtDateTime(i.reported_at)}</dd>
                <dt className="text-muted-foreground">People affected</dt>
                <dd>{i.affected_workers ?? "Not recorded"}</dd>
                <dt className="text-muted-foreground">Equipment</dt>
                <dd>{i.equipment_id ?? "Not recorded"}</dd>
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
    </>
  );
}
