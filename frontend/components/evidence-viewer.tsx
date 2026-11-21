"use client";

import { ExternalLink, FileText, Quote } from "lucide-react";
import Link from "next/link";
import { useApp } from "@/components/providers/app-context";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/states";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { sourceFileUrl } from "@/lib/api";
import { passageIdOf, refLabel, SOURCE_TYPE_LABEL } from "@/lib/format";
import { useEvidence, useSource } from "@/lib/queries";
import { fmtDateTime } from "@/lib/time";
import type { EvidenceRef, Passage, Source } from "@/lib/types";

/** Embeds the original file next to the cited passage. */
export function OriginalEmbed({ source, page }: { source: Source; page?: number | null }) {
  const { projectId, asOf } = useApp();
  if (source.id.startsWith("UP")) {
    return <EmptyState title="Original not stored" description="Files uploaded in this session are not persisted in fixture mode." />;
  }
  const url = sourceFileUrl(projectId, source.id, asOf);
  const open = (
    <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-sky-800 underline underline-offset-2">
      <ExternalLink className="size-3.5" aria-hidden /> Open original ({source.filename})
    </a>
  );
  if (source.mime === "application/pdf") {
    return (
      <div className="flex flex-col gap-2">
        <iframe
          title={`${source.title}${page ? `, page ${page}` : ""}`}
          src={`${url}#page=${page ?? 1}&view=FitH`}
          className="h-[60vh] w-full rounded-md border bg-muted"
        />
        {open}
      </div>
    );
  }
  if (source.mime.startsWith("image/")) {
    return (
      <div className="flex flex-col gap-2">
        {/* eslint-disable-next-line @next/next/no-img-element -- served by the auth proxy, not optimisable */}
        <img src={url} alt={source.title} className="max-h-[60vh] w-full rounded-md border object-contain" />
        {open}
      </div>
    );
  }
  if (source.mime.startsWith("audio/")) {
    return (
      <div className="flex flex-col gap-2">
        <audio controls src={url} className="w-full">
          <track kind="captions" />
        </audio>
        {open}
      </div>
    );
  }
  if (source.mime.startsWith("text/") || source.mime === "message/rfc822" || source.mime === "application/json") {
    return (
      <div className="flex flex-col gap-2">
        <iframe title={source.title} src={url} className="h-64 w-full rounded-md border bg-white" />
        {open}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3 text-sm text-muted-foreground">
      <p>No inline preview for this file type. The cited passage is shown above.</p>
      {open}
    </div>
  );
}

function PassageBlock({ passage }: { passage: Passage }) {
  return (
    <figure className="rounded-md border-l-4 border-amber-400 bg-amber-50 p-3">
      <figcaption className="mb-1 flex items-center gap-1 text-xs font-medium text-amber-900">
        <Quote className="size-3.5" aria-hidden />
        Cited passage · {passage.page ? `page ${passage.page} · ` : ""}
        {passage.locator}
      </figcaption>
      <blockquote>
        <mark className="bg-amber-200/70 px-0.5 whitespace-pre-wrap text-foreground">{passage.text}</mark>
      </blockquote>
    </figure>
  );
}

/** Shows a source passage with its locator and the original file. */
export function EvidenceViewer({ refData }: { refData: EvidenceRef }) {
  const pid = passageIdOf(refData);
  const evidence = useEvidence(pid);
  const source = useSource(refData.source_id);

  if (source.isPending) return <LoadingSkeleton variant="detail" rows={2} />;
  if (source.isError) return <ErrorState error={source.error} onRetry={() => void source.refetch()} />;
  const s = source.data;
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Source</dt>
        <dd className="font-mono">{s.id}</dd>
        <dt className="text-muted-foreground">Type</dt>
        <dd>{SOURCE_TYPE_LABEL[s.type]}</dd>
        <dt className="text-muted-foreground">Available</dt>
        <dd>{fmtDateTime(s.available_at)}</dd>
        <dt className="text-muted-foreground">Locator</dt>
        <dd>{refLabel(refData)}</dd>
      </dl>
      {pid && evidence.isPending && <LoadingSkeleton rows={1} />}
      {pid && evidence.isError && (
        <p className="text-sm text-muted-foreground">Passage {pid} could not be resolved; showing the whole source.</p>
      )}
      {evidence.data && <PassageBlock passage={evidence.data.passage} />}
      <OriginalEmbed source={s} page={refData.page ?? evidence.data?.passage.page} />
      <Link href={`/documents/${s.id}`} className="inline-flex items-center gap-1 text-sm underline underline-offset-2">
        <FileText className="size-3.5" aria-hidden /> Open in Documents
      </Link>
    </div>
  );
}

/** Global sheet bound to the CitationChip context. */
export function EvidenceSheet() {
  const { evidence, closeEvidence } = useApp();
  return (
    <Sheet open={!!evidence} onOpenChange={(o) => !o && closeEvidence()}>
      <SheetContent side="right" className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Evidence</SheetTitle>
          <SheetDescription>{evidence ? refLabel(evidence) : ""}</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6">{evidence && <EvidenceViewer refData={evidence} />}</div>
      </SheetContent>
    </Sheet>
  );
}
