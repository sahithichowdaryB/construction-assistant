"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { JobStatusBadge } from "@/components/badges";
import { CitationList } from "@/components/citation-chip";
import { OriginalEmbed } from "@/components/evidence-viewer";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiError } from "@/lib/api";
import { SOURCE_TYPE_LABEL } from "@/lib/format";
import { useSource, useSourceSummary } from "@/lib/queries";
import { fmtDateTime } from "@/lib/time";
import type { SourceSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

function SummaryCard({ sourceId }: { sourceId: string }) {
  const summary = useSourceSummary(sourceId);
  const block = (title: string, items: SourceSummary["observations"]) => (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {items.length ? (
        <ul className="flex flex-col gap-2 text-sm">
          {items.map((o, i) => (
            <li key={i} className="flex flex-col gap-1">
              {o.text}
              <CitationList refs={o.refs} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">None recorded.</p>
      )}
    </section>
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Structured summary</CardTitle>
      </CardHeader>
      <CardContent>
        {summary.isPending ? (
          <LoadingSkeleton rows={3} />
        ) : summary.isError ? (
          summary.error instanceof ApiError && summary.error.status === 404 ? (
            <EmptyState title="No summary" description="Summaries are prepared for diaries, minutes and emails." />
          ) : (
            <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />
          )
        ) : (
          <div className="flex flex-col gap-5">
            {block("Observations", summary.data.observations)}
            {block("Decisions", summary.data.decisions)}
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">Open actions</h3>
              {summary.data.open_actions.length ? (
                <ul className="flex flex-col gap-3 text-sm">
                  {summary.data.open_actions.map((a, i) => (
                    <li key={i} className="flex flex-col gap-1 rounded-md border p-2">
                      <span>{a.text}</span>
                      <span className="flex flex-wrap gap-x-3 text-xs">
                        {/* Owner and due date are shown only when the source records them */}
                        {a.owner ? <span>Owner: <strong>{a.owner}</strong></span> : <span className="text-muted-foreground">Owner not recorded</span>}
                        {a.due ? <span>Due: <strong>{fmtDateTime(a.due)}</strong></span> : <span className="text-muted-foreground">No due date recorded</span>}
                      </span>
                      <CitationList refs={a.refs} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">None recorded.</p>
              )}
            </section>
            <p className="text-xs text-muted-foreground">Evidence IDs: {summary.data.evidence_ids.join(", ")}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DocumentInner() {
  const { sourceId } = useParams<{ sourceId: string }>();
  const highlight = useSearchParams().get("locator");
  const source = useSource(sourceId);
  const back = (
    <Link href="/documents" className="mb-3 inline-flex min-h-11 items-center gap-1 text-sm hover:underline md:min-h-0">
      <ArrowLeft className="size-4" aria-hidden /> Documents
    </Link>
  );
  if (source.isPending) return <>{back}<LoadingSkeleton variant="detail" rows={2} /></>;
  if (source.isError)
    return (
      <>
        {back}
        {source.error instanceof ApiError && source.error.status === 404 ? (
          <EmptyState title="Document not available" description={source.error.message} />
        ) : (
          <ErrorState error={source.error} onRetry={() => void source.refetch()} />
        )}
      </>
    );
  const s = source.data;
  const hasSummary = s.type === "diary" || s.type === "minutes" || s.type === "email";
  return (
    <>
      {back}
      <PageHeader
        title={s.title}
        description={`${s.id} · ${SOURCE_TYPE_LABEL[s.type]} · available ${fmtDateTime(s.available_at)}${s.note ? ` · ${s.note}` : ""}`}
        actions={<JobStatusBadge status={s.status} />}
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Original</CardTitle>
          </CardHeader>
          <CardContent>
            <OriginalEmbed source={s} />
          </CardContent>
        </Card>
        <div className="flex flex-col gap-4">
          {hasSummary && <SummaryCard sourceId={s.id} />}
          <Card>
            <CardHeader>
              <CardTitle>Indexed passages ({s.passages.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {s.passages.length ? (
                <ul className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto text-sm">
                  {s.passages.map((p) => (
                    <li key={p.id} id={`passage-${p.locator}`} className={cn("rounded-md border p-2", highlight === p.locator && "border-amber-400 bg-amber-50")}>
                      <p className="mb-1 font-mono text-xs text-muted-foreground">
                        {p.id}
                        {p.page ? ` · page ${p.page}` : ""}
                      </p>
                      <p className="whitespace-pre-wrap">{p.text}</p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No passages indexed for this source.</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}

export default function DocumentPage() {
  return (
    <Suspense fallback={<LoadingSkeleton variant="detail" rows={2} />}>
      <DocumentInner />
    </Suspense>
  );
}
