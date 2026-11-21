"use client";

import { ArrowLeft, CheckCircle2, Circle, Download, Eye, History, PencilLine, Save, Scale, Send, ShieldCheck, Undo2 } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { DraftStatusBadge } from "@/components/badges";
import { DISCLAIMER } from "@/components/disclaimer-banner";
import { EvidencePanel } from "@/components/evidence-panel";
import { findGapMarkers, GapHighlighter } from "@/components/gap-highlighter";
import { GatedButton } from "@/components/gated-button";
import { useApp } from "@/components/providers/app-context";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/states";
import { Button } from "@/components/ui/button";
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
    denyReason(role, "approve") ?? reviewBase ?? (openCount > 0 ? `${openCount} item${openCount === 1 ? "" : "s"} still to complete. Fill each one in or remove it.` : null);
  const changesReason = denyReason(role, "request_changes") ?? reviewBase;
  const exportReason = version.status !== "approved" ? "Approve this version before downloading it." : denyReason(role, "export");

  const mutationError = save.error ?? review.error ?? exporter.error;
  const busy = save.isPending || review.isPending || exporter.isPending;

  const doExport = () =>
    exporter.mutate(
      { version: version.version, format: "pdf" },
      {
        onSuccess: (exp) => {
          const a = document.createElement("a");
          a.href = exp.url;
          a.download = `${draft.id}-v${version.version}.txt`;
          a.click();
          // The object URL is only needed for this click; release it afterwards.
          window.setTimeout(() => URL.revokeObjectURL(exp.url), 1000);
        },
      },
    );

  const steps = [
    { label: "Details complete", done: openCount === 0, hint: openCount ? `${openCount} to fill in` : "All filled" },
    { label: "Saved as a version", done: !dirty, hint: dirty ? "Unsaved changes" : `Version ${version.version}` },
    { label: "Submitted for review", done: version.status === "in_review" || version.status === "approved", hint: version.status === "changes_requested" ? "Changes requested" : null },
    { label: "Approved", done: version.status === "approved", hint: null },
  ];
  const doneCount = steps.filter((st) => st.done).length;

  /** The one action that moves this notice forward right now. */
  const next =
    dirty && editable
      ? { label: "Save changes", Icon: Save, reason: saveReason, run: () => save.mutate({ body, gaps, base_version: version.version, author: ROLE_PERSON[role] }, { onSuccess: onSaved }) }
      : version.status === "draft" || version.status === "changes_requested"
        ? { label: "Submit for review", Icon: Send, reason: submitReason, run: () => review.mutate({ version: version.version, decision: "submitted", reviewer: ROLE_PERSON[role] }) }
        : version.status === "in_review"
          ? { label: "Approve notice", Icon: ShieldCheck, reason: approveReason, run: () => review.mutate({ version: version.version, decision: "approved", reviewer: ROLE_PERSON[role] }) }
          : { label: "Download approved letter", Icon: Download, reason: exportReason, run: doExport };

  return (
    <>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* Letter */}
        <section aria-label="Letter" className="flex min-w-0 flex-col gap-3">
          <Tabs defaultValue="preview" className="gap-0">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <TabsList className="rounded-xl">
                <TabsTrigger value="preview" className="min-h-9 rounded-lg px-4">
                  <Eye aria-hidden /> Read
                </TabsTrigger>
                <TabsTrigger value="edit" disabled={!editable} className="min-h-9 rounded-lg px-4">
                  <PencilLine aria-hidden /> Edit
                </TabsTrigger>
              </TabsList>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                {dirty && <span className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-900">Unsaved changes</span>}
                Based on records up to {fmtDateTime(version.as_of)}
              </span>
            </div>
            <div className="rounded-[22px] bg-[#fffdf8] text-[#1c1d20] shadow-[0_1px_2px_rgba(17,18,20,0.05),0_12px_32px_-12px_rgba(17,18,20,0.12)] ring-1 ring-black/5">
              <div className="flex items-center justify-between border-b border-black/5 px-6 py-3 text-[11px] font-semibold tracking-wider text-[#b45309] uppercase md:px-10">
                <span>Version {version.version}</span>
                <span className="text-[#6b7078]">{NOTICE_LABEL[draft.type]}</span>
              </div>
              <TabsContent value="preview" className="px-6 py-7 text-[15px] md:px-10 md:py-9 [&_p]:leading-7">
                <GapHighlighter text={body} sources={version.evidence_refs} />
              </TabsContent>
              <TabsContent value="edit" className="px-4 py-4 md:px-8 md:py-6">
                <Label htmlFor="draft-body" className="sr-only">
                  Letter text
                </Label>
                <Textarea
                  id="draft-body"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={24}
                  className="min-h-[520px] resize-y border-0 bg-transparent text-[15px] leading-7 text-[#1c1d20] shadow-none focus-visible:ring-0 dark:bg-transparent"
                  readOnly={!editable}
                />
                <p className="mt-2 text-xs text-[#6b7078]">Text in [square brackets] still needs information. Fill it in on the right or remove it before approval.</p>
              </TabsContent>
              <p className="flex items-center gap-2 border-t border-black/5 px-6 py-3 text-xs text-[#6b7078] md:px-10">
                <Scale className="size-3.5 shrink-0" aria-hidden /> {DISCLAIMER}
              </p>
            </div>
          </Tabs>
        </section>

        {/* Review rail */}
        <aside className="flex flex-col gap-4 lg:sticky lg:top-20 lg:self-start">
          <div className="rounded-[22px] bg-card p-5">
            <div className="flex items-baseline justify-between">
              <h2 className="text-base font-bold">Before it goes out</h2>
              <span className="text-sm text-muted-foreground tabular">
                {doneCount}/{steps.length}
              </span>
            </div>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${(doneCount / steps.length) * 100}%` }} />
            </div>
            <ol className="mt-4 flex flex-col gap-3">
              {steps.map((st) => (
                <li key={st.label} className="flex items-center gap-3 text-sm">
                  {st.done ? (
                    <CheckCircle2 className="size-5 shrink-0 text-success" aria-hidden />
                  ) : (
                    <Circle className="size-5 shrink-0 text-muted-foreground/50" aria-hidden />
                  )}
                  <span className={st.done ? "font-medium" : "text-muted-foreground"}>{st.label}</span>
                  {st.hint && <span className="ml-auto text-xs text-muted-foreground">{st.hint}</span>}
                  <span className="sr-only">{st.done ? "done" : "not done"}</span>
                </li>
              ))}
            </ol>

            <GatedButton reason={next.reason} size="touch" disabled={busy} onClick={next.run} className="mt-5 h-12 w-full rounded-2xl text-[15px] md:h-12">
              <next.Icon aria-hidden /> {next.label}
            </GatedButton>
            <div className="mt-2 flex flex-wrap justify-center gap-1">
              {version.status === "in_review" && (
                <GatedButton reason={changesReason} size="touch" variant="ghost" disabled={busy} onClick={() => setReasonOpen(true)}>
                  <Undo2 aria-hidden /> Request changes
                </GatedButton>
              )}
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
            </div>
            {latest.status === "draft" && draft.versions.some((v) => v.status === "approved") && (
              <p className="mt-2 text-xs text-muted-foreground">An earlier version was approved; this edit needs its own review.</p>
            )}
            {mutationError && <ErrorState error={mutationError} className="mt-3" />}
          </div>

          <div className="rounded-[22px] bg-card p-5">
            <EvidencePanel
              sources={version.evidence_refs}
              gaps={gaps}
              strayMarkers={strayMarkers}
              assumptions={version.assumptions}
              editable={editable}
              onFill={(g, v) => resolve(g, "filled", v)}
              onOmit={(g, r) => resolve(g, "omitted", r)}
            />
          </div>

          <details className="group rounded-[22px] bg-card p-5">
            <summary className="flex cursor-pointer list-none items-center justify-between text-base font-bold">
              History
              <span className="text-sm font-normal text-muted-foreground">
                version {version.version} · {version.reviews.length} review{version.reviews.length === 1 ? "" : "s"}
              </span>
            </summary>
            <div className="mt-3 flex flex-col gap-3 text-sm">
              <p className="text-xs text-muted-foreground">
                Created {fmtDateTime(version.created_at)} by {version.created_by} · based on records as of {fmtDateTime(version.as_of)}
              </p>
              {version.reviews.length ? (
                <ul className="flex flex-col gap-2">
                  {version.reviews.map((r, i) => (
                    <li key={i} className="rounded-xl bg-muted/60 p-3">
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
                      {e.format.toUpperCase()} · {fmtDateTime(e.created_at)} · fingerprint <span className="font-mono text-xs" title={e.digest}>{e.digest.slice(0, 12)}…</span>
                    </li>
                  ))}
                  <li className="text-xs text-muted-foreground">Demo build: the download is a plain-text copy of the approved wording. The live service will produce PDF and Word files.</li>
                </ul>
              )}
            </div>
          </details>
        </aside>
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

  return (
    <>
      <Link href="/drafts" className="mb-4 inline-flex min-h-11 items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground md:min-h-0">
        <ArrowLeft className="size-4" aria-hidden /> Notices
      </Link>
      {draft.isPending ? (
        <LoadingSkeleton variant="detail" rows={2} />
      ) : draft.isError ? (
        draft.error instanceof ApiError && draft.error.status === 404 ? (
          <EmptyState title="Notice not available" description="This notice had not been created by the time you are viewing. Move the time forward to see it." />
        ) : (
          <ErrorState error={draft.error} onRetry={() => void draft.refetch()} />
        )
      ) : !version || !latest ? (
        <EmptyState title="No versions yet" />
      ) : (
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <DraftStatusBadge status={version.status} />
                <span>{NOTICE_LABEL[draft.data.type]}</span>
                {draft.data.alert_id && (
                  <>
                    ·
                    <Link className="font-medium text-foreground underline-offset-2 hover:underline" href={`/alerts/${draft.data.alert_id}`}>
                      from alert
                    </Link>
                  </>
                )}
                {draft.data.incident_id && (
                  <>
                    ·
                    <Link className="font-medium text-foreground underline-offset-2 hover:underline" href={`/incidents/${draft.data.incident_id}`}>
                      from incident
                    </Link>
                  </>
                )}
              </div>
              <h1 className="mt-1.5 text-2xl font-bold md:text-[28px]">{draft.data.title}</h1>
            </div>
            <Select value={String(version.version)} onValueChange={(v) => setSelected(Number(v))}>
              <SelectTrigger aria-label="Version" className="h-11 min-w-56 rounded-xl bg-card md:h-10">
                <History className="size-4" aria-hidden />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[...versions].reverse().map((v) => (
                  <SelectItem key={v.id} value={String(v.version)}>
                    Version {v.version} · {v.status.replace("_", " ")} · {fmtDateTime(v.created_at)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Editor key={`${version.id}-${version.status}-${version.reviews.length}`} draft={draft.data} version={version} latest={latest} onSaved={() => setSelected(null)} />
        </div>
      )}
    </>
  );
}
