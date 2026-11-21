"use client";

import { ArrowLeft, BellOff, FilePen, Link2 } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { SeverityBadge } from "@/components/badges";
import { CitationChip, CitationList } from "@/components/citation-chip";
import { GatedButton } from "@/components/gated-button";
import { ProgressBar } from "@/components/progress-bar";
import { useApp } from "@/components/providers/app-context";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { basisLabel, fmtPct, fmtQty } from "@/lib/format";
import { useActivities, useAlertContext, useAlerts, useCreateDraft, useDismissAlert, useProgress } from "@/lib/queries";
import { denyReason } from "@/lib/roles";
import { fmtDateTime, fmtLocalDate, localDateOf } from "@/lib/time";
import type { Alert } from "@/lib/types";

/** Display-only rendering of the server's calculation; the result is never recomputed here. */
function CalculationLine({ alert }: { alert: Alert }) {
  const c = alert.calculation;
  if (alert.kind === "missing_report")
    return <p className="text-sm">No daily report has been received, so the quantity is unknown. Nothing has been assumed.</p>;
  if (!c) return <p className="text-sm text-muted-foreground">Calculation details are not available yet.</p>;
  if (c.actual === null) return <p className="text-sm">No figure has been recorded, so no percentage can be worked out.</p>;
  if (c.planned === 0) return <p className="text-sm">No target was set for this day, so no percentage applies.</p>;
  return (
    <p className="font-mono text-sm break-words" aria-label="Shortfall calculation">
      100 × max({fmtQty(c.planned)} − {fmtQty(c.actual)}, 0) / {fmtQty(c.planned)} = <strong>{fmtPct(c.shortfall_pct)}</strong>
    </p>
  );
}

export default function AlertDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { role, asOf } = useApp();
  const alerts = useAlerts();
  const activities = useActivities();
  const alert = alerts.data?.find((a) => a.id === decodeURIComponent(id));
  const workDate = alert ? localDateOf(alert.checkpoint_at) : undefined;
  const progress = useProgress(alert?.activity_code ?? null, workDate ?? null);
  const context = useAlertContext(alert, workDate);
  const createDraft = useCreateDraft();
  const dismiss = useDismissAlert();
  const [dismissOpen, setDismissOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [linkOpen, setLinkOpen] = useState(false);

  const back = (
    <Link href="/alerts" className="mb-3 inline-flex min-h-11 items-center gap-1 text-sm underline-offset-2 hover:underline md:min-h-0">
      <ArrowLeft className="size-4" aria-hidden /> Alerts
    </Link>
  );

  if (alerts.isPending) return <>{back}<LoadingSkeleton variant="detail" rows={3} /></>;
  if (alerts.isError) return <>{back}<ErrorState error={alerts.error} onRetry={() => void alerts.refetch()} /></>;
  if (!alert)
    return (
      <>
        {back}
        <EmptyState icon={<BellOff />} title="Alert not available" description={`This alert no longer exists or was closed by ${fmtDateTime(asOf)}.`} />
      </>
    );

  const activity = activities.data?.find((a) => a.code === alert.activity_code);
  const draftReason = denyReason(role, "create_draft") ?? (alert.kind === "missing_report" ? "A delay notice needs a confirmed report first." : null);

  return (
    <>
      {back}
      <PageHeader
        title={`${alert.activity_code} · ${activity?.name ?? "Activity"}`}
        description={`Work date ${fmtLocalDate(workDate)} · last updated ${fmtDateTime(alert.as_of)}`}
        actions={<SeverityBadge severity={alert.severity} kind={alert.kind} className="text-sm" />}
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>How this was worked out</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <CalculationLine alert={alert} />
              <p className="text-xs text-muted-foreground">
                {alert.kind === "missing_report" ? "No report on file." : "Based on the confirmed daily report."} Priority follows the project thresholds.
              </p>
              <CitationList refs={alert.evidence_refs} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recorded quantities for {fmtLocalDate(workDate)}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {progress.isPending ? (
                <LoadingSkeleton rows={2} />
              ) : progress.isError ? (
                <ErrorState error={progress.error} onRetry={() => void progress.refetch()} />
              ) : (
                <>
                  <ProgressBar
                    planned={progress.data.planned}
                    actual={progress.data.actual}
                    unit={progress.data.unit}
                    basis={progress.data.basis}
                    shortfallPct={progress.data.shortfall_pct}
                    severity={progress.data.severity}
                  />
                  {progress.data.observations.length ? (
                    <ul className="flex flex-col divide-y rounded-md border text-sm">
                      {progress.data.observations.map((o) => (
                        <li key={`${o.source_id}-${o.locator}`} className="flex flex-col gap-1 p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span>
                              <span className="font-semibold">{fmtQty(o.quantity, progress.data.unit)}</span>{" "}
                              <span className={o.basis === "signed" ? "text-emerald-700" : "text-sky-700"}>{basisLabel(o.basis)}</span>
                              {o.source_id === progress.data.evidence?.source_id && <span className="text-xs text-muted-foreground"> · used for this alert</span>}
                            </span>
                            <CitationChip refData={{ source_id: o.source_id, locator: o.locator, page: o.page }} />
                          </div>
                          {o.excerpt && <p className="text-xs text-muted-foreground">“{o.excerpt}”</p>}
                          <p className="text-xs text-muted-foreground">Recorded {fmtDateTime(o.available_at)}</p>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground">Nothing has been recorded for this day yet.</p>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Actions</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <GatedButton
                reason={draftReason}
                size="touch"
                disabled={createDraft.isPending}
                onClick={() =>
                  createDraft.mutate(
                    { type: "delay", alert_id: alert.id, incident_id: context.data?.incident_id ?? null },
                    { onSuccess: (d) => router.push(`/drafts/${d.id}`) },
                  )
                }
              >
                <FilePen aria-hidden /> Create delay notice
              </GatedButton>
              <GatedButton reason={denyReason(role, "link_incident")} size="touch" variant="outline" onClick={() => setLinkOpen(true)}>
                <Link2 aria-hidden /> Link to an incident
              </GatedButton>
              <GatedButton reason={denyReason(role, "dismiss_alert")} size="touch" variant="outline" onClick={() => setDismissOpen(true)}>
                <BellOff aria-hidden /> Dismiss alert
              </GatedButton>
              {createDraft.isError && <ErrorState error={createDraft.error} />}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Likely cause</CardTitle>
            </CardHeader>
            <CardContent>
              {context.isPending ? (
                <LoadingSkeleton rows={2} />
              ) : context.isError ? (
                <ErrorState error={context.error} onRetry={() => void context.refetch()} />
              ) : context.data.likely_causes.length ? (
                <ul className="flex flex-col gap-3 text-sm">
                  {context.data.likely_causes.map((c, i) => (
                    <li key={i} className="flex flex-col gap-1">
                      {c.text}
                      <CitationList refs={c.refs} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No likely cause has been recorded yet.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Work that depends on this</CardTitle>
            </CardHeader>
            <CardContent>
              {context.data?.successors_at_risk.length ? (
                <ul className="flex flex-col gap-3 text-sm">
                  {context.data.successors_at_risk.map((s) => (
                    <li key={s.code} className="flex flex-col gap-1">
                      <span>
                        <span className="font-mono font-semibold">{s.code}</span> {s.name} · due to start {fmtLocalDate(s.planned_start)}
                      </span>
                      <CitationList refs={s.refs} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">{context.isPending ? "Loading…" : "No dependent work is recorded."}</p>
              )}
              {context.data?.incident_id && (
                <p className="mt-3 text-sm">
                  Linked incident:{" "}
                  <Link className="underline" href={`/incidents/${context.data.incident_id}`}>
                    {context.data.incident_id}
                  </Link>
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog open={dismissOpen} onOpenChange={setDismissOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Dismiss alert</DialogTitle>
            <DialogDescription>A reason is required and kept with the alert history.</DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              dismiss.mutate(
                { id: alert.id, reason },
                {
                  onSuccess: () => {
                    setDismissOpen(false);
                    router.push("/alerts");
                  },
                },
              );
            }}
          >
            <Label htmlFor="dismiss-reason">Reason</Label>
            <Textarea id="dismiss-reason" value={reason} onChange={(e) => setReason(e.target.value)} required rows={3} />
            {dismiss.isError && <ErrorState error={dismiss.error} />}
            <DialogFooter>
              <Button type="submit" size="touch" disabled={!reason.trim() || dismiss.isPending}>
                Dismiss alert
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={linkOpen} onOpenChange={setLinkOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Link incident</DialogTitle>
            <DialogDescription>Linking is not available yet. This is the incident SiteMate suggests for the same activity and date.</DialogDescription>
          </DialogHeader>
          {context.data?.incident_id ? (
            <p className="text-sm">
              Suggested:{" "}
              <Link className="underline" href={`/incidents/${context.data.incident_id}`}>
                {context.data.incident_id}
              </Link>{" "}
              (same activity and date).
            </p>
          ) : (
            <EmptyState title="No incident suggested" description="Report the incident from Site notes first." />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
