"use client";

import { ArrowLeft, Download, FileDown, Save, Send, ShieldCheck, Undo2 } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { DraftStatusBadge } from "@/components/badges";
import { DisclaimerBanner } from "@/components/disclaimer-banner";
import { EvidencePanel } from "@/components/evidence-panel";
import { findGapMarkers, GapHighlighter } from "@/components/gap-highlighter";
import { GatedButton } from "@/components/gated-button";
import { useApp } from "@/components/providers/app-context";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api";
import { NOTICE_LABEL } from "@/lib/format";
import { useDraft, useExportDraft, useReviewDraft, useSaveDraftVersion } from "@/lib/queries";
import { denyReason, ROLE_PERSON } from "@/lib/roles";
import { fmtDateTime } from "@/lib/time";
import type { Draft, DraftVersion, Gap } from "@/lib/types";

const DECISION_LABEL = { submitted: "Submitted for review", approved: "Approved", changes_requested: "Changes requested" } as const;

/** Removes a marker; drops the whole "Label: [MISSING: …]" line when the marker was its only value. */
function omitMarker(body: string, marker: string): string {
  return body
    .split("\n")
    .filter((line) => !new RegExp(`^[^:\\[]+:\\s*${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`).test(line))
    .join("\n")
    .split(marker)
    .join("")
    .replace(/[ \t]{2,}/g, " ");
}

function Editor({ draft, version, latest, onSaved }: { draft: Draft; version: DraftVersion; latest: DraftVersion; onSaved: () => void }) {
  const { role, asOf } = useApp();
  const [body, setBody] = useState(version.body);
  const [gaps, setGaps] = useState<Gap[]>(version.gaps);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState("");
  const save = useSaveDraftVersion(draft.id);
  const review = useReviewDraft(draft.id);
  const exporter = useExportDraft(draft.id);

  const isLatest = version.version === latest.version;
  const editDenied = denyReason(role, "edit_draft");
  const editable = isLatest && !editDenied;
  const dirty = body !== version.body || JSON.stringify(gaps) !== JSON.stringify(version.gaps);

  const markers = findGapMarkers(body);
  const unresolved = gaps.filter((g) => !g.resolution);
  const strayMarkers = [...new Set(markers.filter((m) => !gaps.some((g) => g.marker === m && !g.resolution)))];
  const openCount = unresolved.length + strayMarkers.length;

  const resolve = (gap: Gap, action: "filled" | "omitted", value: string) => {
    setBody((b) => (action === "filled" ? b.split(gap.marker).join(value) : omitMarker(b, gap.marker)));
    setGaps((gs) => gs.map((g) => (g.id === gap.id ? { ...g, resolution: { action, value, by: ROLE_PERSON[role], at: asOf } } : g)));
  };

  const notLatest = isLatest ? null : `You are viewing v${version.version}. Only the latest version (v${latest.version}) can change.`;
  const saveReason = notLatest ?? editDenied ?? (!dirty ? "No changes to save." : null);
  const submitReason =
    notLatest ??
    denyReason(role, "submit_review") ??
    (dirty ? "Save your changes as a new version first." : null) ??
    (version.status === "draft" || version.status === "changes_requested" ? null : `A version that is ${version.status.replace("_", " ")} cannot be submitted.`);
  const reviewBase =
    notLatest ?? (dirty ? "Save your changes as a new version first." : null) ?? (version.status !== "in_review" ? "Submit the version for review first." : null);
  const approveReason =
    denyReason(role, "approve") ?? reviewBase ?? (openCount > 0 ? `${openCount} gap${openCount === 1 ? "" : "s"} remain. Fill or omit each one with a reason.` : null);
  const changesReason = denyReason(role, "request_changes") ?? reviewBase;
  const exportReason = version.status !== "approved" ? "Only an approved version can be exported." : denyReason(role, "export");

  const mutationError = save.error ?? review.error ?? exporter.error;
  const busy = save.isPending || review.isPending || exporter.isPending;

  const doExport = (format: "pdf" | "docx") =>
    exporter.mutate(
      { version: version.version, format },
      {
        onSuccess: (exp) => {
          const a = document.createElement("a");
          a.href = exp.url;
          a.download = `${draft.id}-v${version.version}.${format}.txt`;
          a.click();
        },
      },
    );

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <DraftStatusBadge status={version.status} className="text-sm" />
        {openCount > 0 ? (
          <span className="text-sm text-red-800">{openCount} open gap{openCount === 1 ? "" : "s"}</span>
        ) : (
          <span className="text-sm text-emerald-800">No open gaps</span>
        )}
        {dirty && <span className="text-sm text-amber-800">Unsaved changes</span>}
        {latest.status === "draft" && draft.versions.some((v) => v.status === "approved") && (
          <span className="text-sm text-muted-foreground">An earlier version was approved; this edit needs its own review.</span>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <GatedButton reason={saveReason} size="touch" disabled={busy} onClick={() => save.mutate({ body, gaps, base_version: version.version, author: ROLE_PERSON[role] }, { onSuccess: onSaved })}>
          <Save aria-hidden /> Save version
        </GatedButton>
        {dirty && editable && (
          <Button
            variant="ghost"
            size="touch"
            onClick={() => {
              setBody(version.body);
              setGaps(version.gaps);
            }}
          >
            <Undo2 aria-hidden /> Discard changes
          </Button>
        )}
        <GatedButton reason={submitReason} size="touch" variant="outline" disabled={busy} onClick={() => review.mutate({ version: version.version, decision: "submitted", reviewer: ROLE_PERSON[role] })}>
          <Send aria-hidden /> Submit for review
        </GatedButton>
        <GatedButton reason={approveReason} size="touch" variant="outline" disabled={busy} onClick={() => review.mutate({ version: version.version, decision: "approved", reviewer: ROLE_PERSON[role] })}>
          <ShieldCheck aria-hidden /> Approve
        </GatedButton>
        <GatedButton reason={changesReason} size="touch" variant="outline" disabled={busy} onClick={() => setReasonOpen(true)}>
          <Undo2 aria-hidden /> Request changes
        </GatedButton>
        <GatedButton reason={exportReason} size="touch" variant="outline" disabled={busy} onClick={() => doExport("pdf")}>
          <FileDown aria-hidden /> Export PDF
        </GatedButton>
        <GatedButton reason={exportReason} size="touch" variant="outline" disabled={busy} onClick={() => doExport("docx")}>
          <Download aria-hidden /> Export Word
        </GatedButton>
      </div>
      {mutationError && <ErrorState error={mutationError} />}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Letter</CardTitle>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue={editable ? "edit" : "preview"}>
              <TabsList>
                <TabsTrigger value="edit" disabled={!editable} className="min-h-9">
                  Edit
                </TabsTrigger>
                <TabsTrigger value="preview" className="min-h-9">
                  Preview
                </TabsTrigger>
              </TabsList>
              <TabsContent value="edit" className="mt-3">
                <Label htmlFor="draft-body" className="sr-only">
                  Letter text (Markdown)
                </Label>
                <Textarea id="draft-body" value={body} onChange={(e) => setBody(e.target.value)} rows={22} className="font-mono text-sm" readOnly={!editable} />
                <p className="mt-1 text-xs text-muted-foreground">Markdown. [n] cites source n. Keep [MISSING: …] until resolved.</p>
              </TabsContent>
              <TabsContent value="preview" className="mt-3 rounded-md border bg-white p-4">
                <GapHighlighter text={body} sources={version.evidence_refs} />
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Evidence</CardTitle>
            </CardHeader>
            <CardContent>
              <EvidencePanel
                sources={version.evidence_refs}
                gaps={gaps}
                strayMarkers={strayMarkers}
                assumptions={version.assumptions}
                editable={editable}
                onFill={(g, v) => resolve(g, "filled", v)}
                onOmit={(g, r) => resolve(g, "omitted", r)}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Review and export history (v{version.version})</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              <p className="text-xs text-muted-foreground">
                Created {fmtDateTime(version.created_at)} by {version.created_by} · evidence as of {fmtDateTime(version.as_of)}
              </p>
              {version.reviews.length ? (
                <ul className="flex flex-col gap-2">
                  {version.reviews.map((r, i) => (
                    <li key={i} className="rounded-md border p-2">
                      <span className="font-medium">{DECISION_LABEL[r.decision]}</span> by {r.reviewer} · {fmtDateTime(r.decided_at)}
                      {r.reason && <p className="text-muted-foreground">Reason: {r.reason}</p>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground">No reviews yet.</p>
              )}
              {version.exports.length > 0 && (
                <ul className="flex flex-col gap-1">
                  {version.exports.map((e, i) => (
                    <li key={i} className="break-all">
                      {e.format.toUpperCase()} · {fmtDateTime(e.created_at)} · SHA-256 <span className="font-mono text-xs">{e.digest.slice(0, 16)}…</span>
                    </li>
                  ))}
                  <li className="text-xs text-muted-foreground">Fixture mode exports the exact approved text; the backend will render PDF and Word.</li>
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog open={reasonOpen} onOpenChange={setReasonOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request changes</DialogTitle>
            <DialogDescription>The reason is kept with version {version.version}.</DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              review.mutate(
                { version: version.version, decision: "changes_requested", reason, reviewer: ROLE_PERSON[role] },
                {
                  onSuccess: () => {
                    setReasonOpen(false);
                    setReason("");
                  },
                },
              );
            }}
          >
            <Label htmlFor="changes-reason">Reason (required)</Label>
            <Textarea id="changes-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} required />
            <DialogFooter>
              <Button type="submit" size="touch" disabled={!reason.trim() || review.isPending}>
                Request changes
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function DraftEditorPage() {
  const { id } = useParams<{ id: string }>();
  const draft = useDraft(id);
  const [selected, setSelected] = useState<number | null>(null);
  const versions = useMemo(() => draft.data?.versions ?? [], [draft.data]);
  const latest = versions.at(-1);
  const version = versions.find((v) => v.version === selected) ?? latest;

  const back = (
    <Link href="/drafts" className="mb-3 inline-flex min-h-11 items-center gap-1 text-sm hover:underline md:min-h-0">
      <ArrowLeft className="size-4" aria-hidden /> Drafts
    </Link>
  );

  return (
    <>
      {back}
      <div className="mb-4">
        <DisclaimerBanner />
      </div>
      {draft.isPending ? (
        <LoadingSkeleton variant="detail" rows={2} />
      ) : draft.isError ? (
        draft.error instanceof ApiError && draft.error.status === 404 ? (
          <EmptyState title="Draft not available" description="This draft did not exist yet at the selected time. Move the clock forward." />
        ) : (
          <ErrorState error={draft.error} onRetry={() => void draft.refetch()} />
        )
      ) : !version || !latest ? (
        <EmptyState title="No versions yet" />
      ) : (
        <div className="flex flex-col gap-4">
          <PageHeader
            title={draft.data.title}
            description={
              <>
                {NOTICE_LABEL[draft.data.type]}
                {draft.data.alert_id && (
                  <>
                    {" · from "}
                    <Link className="underline" href={`/alerts/${draft.data.alert_id}`}>
                      alert
                    </Link>
                  </>
                )}
                {draft.data.incident_id && (
                  <>
                    {" · incident "}
                    <Link className="underline" href={`/incidents/${draft.data.incident_id}`}>
                      {draft.data.incident_id}
                    </Link>
                  </>
                )}
              </>
            }
            actions={
              <Select value={String(version.version)} onValueChange={(v) => setSelected(Number(v))}>
                <SelectTrigger aria-label="Version" className="h-11 min-w-56 md:h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[...versions].reverse().map((v) => (
                    <SelectItem key={v.id} value={String(v.version)}>
                      v{v.version} · {v.status.replace("_", " ")} · {fmtDateTime(v.created_at)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
          <Editor key={`${version.id}-${version.status}-${version.reviews.length}`} draft={draft.data} version={version} latest={latest} onSaved={() => setSelected(null)} />
        </div>
      )}
    </>
  );
}
