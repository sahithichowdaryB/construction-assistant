"use client";

import { GitMerge, Unlink } from "lucide-react";
import { useState } from "react";
import { CitationChip } from "@/components/citation-chip";
import { useApp } from "@/components/providers/app-context";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/states";
import { GatedButton } from "@/components/gated-button";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { attachmentUrl } from "@/lib/api";
import { useIncidentEvents, useIncidents, useMergeIncident, useUnlinkEvent } from "@/lib/queries";
import { denyReason } from "@/lib/roles";
import { fmtDateTime } from "@/lib/time";
import type { LinkType } from "@/lib/types";

const LINK_LABEL: Record<LinkType, string> = {
  origin: "First report",
  corroborating: "Another report",
  update: "Update",
  resolution: "Repair / resolution",
  contradicting: "Contradicts",
};

/** The reports (events) behind an incident: who said what, when, how it was linked, with photos. Managers can correct grouping. */
export function IncidentSources({ incidentId }: { incidentId: string }) {
  const { role } = useApp();
  const events = useIncidentEvents(incidentId);
  const unlink = useUnlinkEvent(incidentId);
  const merge = useMergeIncident(incidentId);
  const incidents = useIncidents();
  const [mergeOpen, setMergeOpen] = useState(false);
  const [target, setTarget] = useState("");
  const manage = denyReason(role, "merge_incident");

  if (events.isPending) return <LoadingSkeleton rows={3} />;
  if (events.isError) return <ErrorState error={events.error} onRetry={() => void events.refetch()} />;
  const active = events.data.filter((e) => !e.unlinked_at);
  const removed = events.data.filter((e) => e.unlinked_at);
  const others = (incidents.data ?? []).filter((i) => i.id !== incidentId && i.status !== "closed");

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {active.length} linked report{active.length === 1 ? "" : "s"} from {new Set(active.map((e) => e.recorded_by)).size} people
        </p>
        <GatedButton reason={manage} size="sm" variant="outline" onClick={() => setMergeOpen(true)}>
          <GitMerge aria-hidden /> Merge into another incident
        </GatedButton>
      </div>
      {active.length === 0 ? (
        <EmptyState title="No linked reports" description="Incidents opened before event capture have no linked reports." />
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {active.map((e) => (
            <li key={e.id} className="flex flex-col gap-2 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="rounded border bg-secondary px-1.5 py-0.5 text-xs font-medium">{LINK_LABEL[e.link_type]}</span>
                  <span className="font-medium">{e.recorded_by}</span>
                  <span className="text-xs text-muted-foreground">{fmtDateTime(e.recorded_at)} · via {e.channel}</span>
                </span>
                {e.link_type !== "origin" && (
                  <GatedButton
                    reason={manage}
                    size="sm"
                    variant="ghost"
                    disabled={unlink.isPending}
                    onClick={() => {
                      if (window.confirm("Unlink this report from the incident? You can make it its own incident next.")) {
                        unlink.mutate({ eventId: e.id, makeNew: window.confirm("Make it a new incident of its own? (Cancel keeps it as a plain event)") });
                      }
                    }}
                  >
                    <Unlink aria-hidden /> Unlink
                  </GatedButton>
                )}
              </div>
              <p>{e.summary}</p>
              {e.attachments.length > 0 && (
                <ul className="flex flex-wrap gap-2">
                  {e.attachments.map((a) => (
                    <li key={a.id}>
                      <a href={attachmentUrl(a.url)} target="_blank" rel="noreferrer">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={attachmentUrl(a.url)} alt={`Photo from ${e.recorded_by}`} className="size-20 rounded-md border object-cover" />
                      </a>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <CitationChip refData={{ source_id: e.source_id, locator: e.locator }} />
                {e.match_reason && <span>Linked: {e.match_reason}{e.match_score != null ? ` (score ${e.match_score})` : ""}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {removed.length > 0 && <p className="text-xs text-muted-foreground">{removed.length} report{removed.length === 1 ? " was" : "s were"} unlinked by a manager.</p>}
      {unlink.isError && <ErrorState error={unlink.error} />}

      <Dialog open={mergeOpen} onOpenChange={setMergeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Merge into another incident</DialogTitle>
            <DialogDescription>
              Every report moves to the incident you choose, and this incident and its alert are retired. Use it when two incidents describe the same problem.
            </DialogDescription>
          </DialogHeader>
          <Label htmlFor="merge-target">Merge into</Label>
          <Input id="merge-target" list="merge-options" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="Choose or paste an incident id" />
          <datalist id="merge-options">
            {others.map((i) => (
              <option key={i.id} value={i.id}>{i.summary ?? i.title}</option>
            ))}
          </datalist>
          {merge.isError && <ErrorState error={merge.error} />}
          <DialogFooter>
            <Button
              size="touch"
              disabled={!target.trim() || merge.isPending}
              onClick={() => merge.mutate(target.trim(), { onSuccess: () => setMergeOpen(false) })}
            >
              Merge
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
