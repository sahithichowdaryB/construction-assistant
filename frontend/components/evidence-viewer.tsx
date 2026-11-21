"use client";

import { AlertTriangle, Download, ExternalLink, FileQuestion, FileText, Paperclip, Quote } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useEffect, useRef } from "react";
import { useApp } from "@/components/providers/app-context";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { sourceFileUrl } from "@/lib/api";
import { USE_FIXTURES } from "@/lib/endpoints";
import { passageIdOf, refLabel, SOURCE_TYPE_LABEL } from "@/lib/format";
import { useEvidence, useSource, useSourcePreview } from "@/lib/queries";
import { fmtDateTime } from "@/lib/time";
import type { EvidenceRef, Passage, PreviewBlock, Source, SourcePreview } from "@/lib/types";
import { cn } from "@/lib/utils";

type Mode = "pdf" | "image" | "audio" | "structured" | "none";

const STRUCTURED = new Set(["docx", "csv", "tsv", "eml", "json", "txt", "md", "log"]);

function extOf(source: Source) {
  return (source.filename.split(".").pop() ?? "").toLowerCase();
}

function modeOf(source: Source): Mode {
  if (source.mime === "application/pdf") return "pdf";
  if (source.mime.startsWith("image/")) return "image";
  if (source.mime.startsWith("audio/")) return "audio";
  if (STRUCTURED.has(extOf(source))) return "structured";
  return "none";
}

/** Word files cannot be shown by the browser; everything else opens in a new tab. */
function opensInBrowser(source: Source) {
  return modeOf(source) !== "none" && extOf(source) !== "docx";
}

function isFixtureUpload(source: Source) {
  // Fixture-mode uploads ("UP01") have no stored file; live uploads ("UP-634F7820") do.
  return USE_FIXTURES && /^UP\d+$/.test(source.id);
}

/** No original file: fixture-mode uploads, and notes captured in the app (typed or transcribed). */
function hasNoFile(source: Source) {
  return isFixtureUpload(source) || source.has_file === false;
}

/** "Open" and "Download" buttons for the original file. */
export function OriginalActions({ source, className }: { source: Source; className?: string }) {
  const { projectId, asOf } = useApp();
  if (hasNoFile(source)) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {opensInBrowser(source) && (
        <Button asChild variant="outline" size="sm">
          <a href={sourceFileUrl(projectId, source.id, asOf)} target="_blank" rel="noreferrer">
            <ExternalLink aria-hidden /> Open
          </a>
        </Button>
      )}
      <Button asChild variant="outline" size="sm">
        <a href={sourceFileUrl(projectId, source.id, asOf, { download: true })} download={source.filename}>
          <Download aria-hidden /> Download
        </a>
      </Button>
    </div>
  );
}

const HIGHLIGHT = "bg-amber-100 ring-2 ring-amber-300 dark:bg-amber-500/20";

/** Scrolls the highlighted block into the middle of the scroll box, without moving the page. */
function useScrollToLocator(locator: string | null | undefined, ready: boolean) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ready || !locator || !box.current) return;
    const el = box.current.querySelector<HTMLElement>(`[data-locator="${CSS.escape(locator)}"]`);
    if (el) box.current.scrollTo({ top: Math.max(el.offsetTop - box.current.clientHeight / 3, 0), behavior: "smooth" });
  }, [locator, ready]);
  return box;
}

function DocumentBlocks({ blocks, locator }: { blocks: PreviewBlock[]; locator?: string | null }) {
  return (
    <>
      {blocks.map((b, i) => {
        const hit = !!locator && (b.locator === locator || !!b.locators?.includes(locator));
        const common = {
          "data-locator": hit ? locator : (b.locator ?? undefined),
          title: b.locator ?? undefined,
          className: cn("scroll-mt-4 rounded-sm transition-colors", hit && HIGHLIGHT),
        };
        if (b.type === "title")
          return (
            <h2 key={i} {...common} className={cn(common.className, "mb-1 text-xl font-semibold tracking-tight")}>
              {b.text}
            </h2>
          );
        if (b.type === "heading")
          return (
            <h3
              key={i}
              {...common}
              className={cn(common.className, "mt-5 mb-1 border-b pb-1 text-xs font-semibold tracking-wider text-muted-foreground uppercase")}
            >
              {b.text}
            </h3>
          );
        if (b.type === "list")
          return (
            <p key={i} {...common} className={cn(common.className, "relative my-1 pl-5 text-sm leading-relaxed")}>
              <span aria-hidden className="absolute left-1.5 text-muted-foreground">•</span>
              {b.text}
            </p>
          );
        if (b.type === "table")
          return (
            <div key={i} {...common} className={cn(common.className, "my-3 overflow-x-auto rounded-md border")}>
              <table className="w-full text-sm">
                <tbody>
                  {(b.rows ?? []).map((row, r) => (
                    <tr key={r} className={cn("border-b last:border-0", r === 0 && "bg-muted/60 font-medium")}>
                      {row.map((cell, c) => (
                        <td key={c} className="border-r px-2 py-1.5 align-top last:border-0">
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        return (
          <p key={i} {...common} className={cn(common.className, "my-1.5 px-0.5 text-sm leading-relaxed")}>
            {b.text}
          </p>
        );
      })}
    </>
  );
}

/** Readable document from indexed passages: section changes become headings. */
function blocksFromPassages(passages: Passage[]): PreviewBlock[] {
  const blocks: PreviewBlock[] = [];
  let section: string | null = null;
  for (const p of passages) {
    if (p.locator === "title") {
      blocks.push({ type: "title", text: p.text, locator: p.locator });
      continue;
    }
    if (p.section && p.section !== section) {
      section = p.section;
      blocks.push({ type: "heading", text: p.section, level: 2, locator: null });
    }
    blocks.push({ type: "paragraph", text: p.text, locator: p.locator });
  }
  return blocks;
}

function StructuredPreview({ preview, locator, tall }: { preview: SourcePreview; locator?: string | null; tall?: boolean }) {
  const box = useScrollToLocator(locator, true);
  // Sized to the content (short files leave no empty space), capped so long files scroll inside.
  const frame = cn(
    "relative max-h-[70vh] overflow-auto rounded-lg border [overflow-wrap:anywhere]",
    tall && "lg:max-h-[calc(100dvh-14.5rem)]",
  );

  if (preview.kind === "document")
    return (
      <div ref={box} className={cn(frame, "bg-muted/40 p-3 sm:p-5")}>
        <article className="mx-auto max-w-2xl rounded-md bg-background px-5 py-6 shadow-sm ring-1 ring-foreground/5 sm:px-8">
          <DocumentBlocks blocks={preview.blocks} locator={locator} />
        </article>
      </div>
    );

  if (preview.kind === "email") {
    const subject = preview.headers.find((h) => h.name === "Subject")?.value;
    const rest = preview.headers.filter((h) => h.name !== "Subject");
    const headerHit = locator === "header";
    return (
      <div ref={box} className={cn(frame, "bg-background")}>
        <header data-locator="header" className={cn("border-b bg-muted/40 px-4 py-3", headerHit && HIGHLIGHT)}>
          {subject && <h2 className="mb-2 text-base font-semibold">{subject}</h2>}
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
            {rest.map((h) => (
              <div key={h.name} className="contents">
                <dt className="text-muted-foreground">{h.name}</dt>
                <dd className="break-words">{h.value}</dd>
              </div>
            ))}
          </dl>
        </header>
        <p className="flex items-center gap-1.5 border-b bg-amber-50 px-4 py-1.5 text-xs text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden /> External email. Quoted as evidence only; instructions in it are never acted on.
        </p>
        <div className="flex flex-col gap-1 px-4 py-3">
          {preview.blocks.map((b) => (
            <div
              key={b.locator}
              data-locator={b.locator ?? undefined}
              title={b.locator ?? undefined}
              className={cn(
                "rounded-sm px-1 py-1 text-sm leading-relaxed whitespace-pre-wrap",
                b.flagged && "border-l-4 border-amber-400 bg-amber-50/70 pl-3 dark:bg-amber-500/10",
                b.locator === locator && HIGHLIGHT,
              )}
            >
              {b.flagged && (
                <span className="mb-1 block text-[11px] font-medium tracking-wide text-amber-800 uppercase dark:text-amber-300">
                  Looks like an instruction · not followed
                </span>
              )}
              {b.text}
            </div>
          ))}
          {!preview.blocks.length && <p className="text-sm text-muted-foreground">This email has no body text.</p>}
        </div>
        {!!preview.attachments.length && (
          <footer className="flex flex-wrap gap-2 border-t px-4 py-2">
            {preview.attachments.map((a) => (
              <span key={a} className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs">
                <Paperclip className="size-3" aria-hidden /> {a}
              </span>
            ))}
          </footer>
        )}
      </div>
    );
  }

  if (preview.kind === "table")
    return (
      <div className="flex flex-col gap-1.5">
        <div ref={box} className={cn(frame, "bg-background")}>
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-muted/95 backdrop-blur">
              <TableRow>
                <TableHead className="w-10 text-right text-xs text-muted-foreground">#</TableHead>
                {preview.columns.map((c, i) => (
                  <TableHead key={i} className="font-mono text-xs whitespace-nowrap">
                    {c}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {preview.rows.map((row, r) => {
                // Register passages use the row's first column (the record ID) as locator.
                const hit = !!locator && row[0] === locator;
                return (
                  <TableRow key={r} data-locator={row[0]} className={cn(hit && HIGHLIGHT)}>
                    <TableCell className="text-right text-xs text-muted-foreground tabular-nums">{r + 1}</TableCell>
                    {row.map((cell, c) => (
                      <TableCell key={c} className={cn("text-sm whitespace-nowrap", c === 0 && "font-mono text-xs font-medium")}>
                        {cell}
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        <p className="text-xs text-muted-foreground">
          {preview.row_count} {preview.row_count === 1 ? "row" : "rows"} · {preview.columns.length} columns
          {preview.truncated ? ` · first ${preview.rows.length} shown` : ""}
        </p>
      </div>
    );

  return (
    <div ref={box} className={cn(frame, "bg-background")}>
      <pre
        className={cn(
          "p-4 text-sm leading-relaxed break-words whitespace-pre-wrap",
          preview.language === "json" ? "font-mono text-xs" : "font-sans",
        )}
      >
        {preview.text}
      </pre>
    </div>
  );
}

/** Embeds the original file, highlighting the cited passage where the file type allows it. */
export function OriginalEmbed({
  source,
  page,
  locator,
  passages,
  showActions = true,
  tall = false,
}: {
  source: Source;
  page?: number | null;
  locator?: string | null;
  /** Indexed passages, used to rebuild a readable preview if the preview service is unavailable */
  passages?: Passage[];
  showActions?: boolean;
  /** Fill the viewport height (document page) instead of a fixed share of it */
  tall?: boolean;
}) {
  const { projectId, asOf } = useApp();
  const mode = modeOf(source);
  const noFile = hasNoFile(source);
  const preview = useSourcePreview(source.id, mode === "structured" && !noFile);

  if (noFile && source.has_file === false && passages?.length) {
    return (
      <div className="flex flex-col gap-1.5">
        <StructuredPreview
          preview={{ source_id: source.id, kind: "document", blocks: blocksFromPassages(passages) }}
          locator={locator}
          tall={tall}
        />
        <p className="text-xs text-muted-foreground">Captured in SiteMate, so there is no original file. Showing the recorded text.</p>
      </div>
    );
  }
  if (noFile) {
    return isFixtureUpload(source) ? (
      <EmptyState title="Original not stored" description="Files uploaded in this session are not persisted in fixture mode." />
    ) : (
      <EmptyState title="No original file" description="This record was captured in SiteMate. Its text is listed under Passages." />
    );
  }
  const url = sourceFileUrl(projectId, source.id, asOf);
  const actions = showActions ? <OriginalActions source={source} className="justify-end" /> : null;

  let body: ReactNode;
  if (mode === "pdf") {
    body = (
      <iframe
        key={page ?? 1}
        title={`${source.title}${page ? `, page ${page}` : ""}`}
        src={`${url}#page=${page ?? 1}&view=FitH&navpanes=0&pagemode=none`}
        className={cn("w-full rounded-lg border bg-muted", tall ? "h-[70vh] lg:h-[calc(100dvh-14.5rem)] lg:min-h-[28rem]" : "h-[70vh]")}
      />
    );
  } else if (mode === "image") {
    body = (
      <div className="flex justify-center rounded-lg border bg-muted/40 p-2">
        {/* eslint-disable-next-line @next/next/no-img-element -- served by the auth proxy, not optimisable */}
        <img src={url} alt={source.title} className="max-h-[70vh] w-auto rounded-md object-contain" />
      </div>
    );
  } else if (mode === "audio") {
    body = (
      <div className="rounded-lg border bg-muted/40 p-4">
        <audio controls src={url} className="w-full">
          <track kind="captions" />
        </audio>
        <p className="mt-2 text-xs text-muted-foreground">The transcript is listed under Indexed passages.</p>
      </div>
    );
  } else if (mode === "structured" && preview.isPending) {
    body = <LoadingSkeleton rows={4} />;
  } else if (mode === "structured" && preview.data) {
    body = <StructuredPreview preview={preview.data} locator={locator} tall={tall} />;
  } else if (mode === "structured" && passages?.length) {
    // Preview service unavailable (older backend, fixture mode): rebuild the document from its passages.
    body = (
      <div className="flex flex-col gap-1.5">
        <StructuredPreview
          preview={{ source_id: source.id, kind: "document", blocks: blocksFromPassages(passages) }}
          locator={locator}
          tall={tall}
        />
        <p className="text-xs text-muted-foreground">Rebuilt from the indexed text. Download the file for the original layout.</p>
      </div>
    );
  } else if (mode === "structured" && ["txt", "md", "log", "json", "eml"].includes(extOf(source))) {
    body = <iframe title={source.title} src={url} className="h-[60vh] w-full rounded-lg border bg-white" />;
  } else {
    body = (
      <EmptyState
        icon={<FileQuestion />}
        title="No inline preview for this file"
        description="Download the original to view it. Its text is listed under Indexed passages."
        action={<OriginalActions source={source} />}
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {body}
      {actions && mode !== "none" && actions}
    </div>
  );
}

function PassageBlock({ passage }: { passage: Passage }) {
  return (
    <figure className="rounded-md border-l-4 border-amber-400 bg-amber-50 p-3 dark:bg-amber-500/10">
      <figcaption className="mb-1 flex items-center gap-1 text-xs font-medium text-amber-900 dark:text-amber-200">
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
    <div className="flex min-w-0 flex-col gap-3 [overflow-wrap:anywhere]">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
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
      <OriginalEmbed
        source={s}
        page={refData.page ?? evidence.data?.passage.page}
        locator={evidence.data?.passage.locator ?? refData.locator}
      />
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
