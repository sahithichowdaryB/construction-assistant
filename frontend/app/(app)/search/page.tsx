"use client";

import { Search as SearchIcon, TextSearch } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { CitationChip } from "@/components/citation-chip";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SOURCE_TYPE_LABEL } from "@/lib/format";
import { useSearch } from "@/lib/queries";
import { fmtDateTime } from "@/lib/time";

const EXAMPLES = [
  "Who flagged the overdue excavator service?",
  "What was the signed Zone B quantity on 10 November?",
  "Which activity follows EXC-B?",
  "Where was the crack observed?",
];

function SearchInner() {
  const router = useRouter();
  const params = useSearchParams();
  const submitted = params.get("q") ?? "";
  const [draft, setDraft] = useState(submitted);
  const results = useSearch(submitted);

  const go = (q: string) => {
    setDraft(q);
    router.replace(`/search?q=${encodeURIComponent(q)}`);
  };

  return (
    <>
      <PageHeader
        title="Search evidence"
        description="Find the passage that answers a question. Only sources available at the selected time are searched."
      />
      <form
        className="mb-4 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim().length >= 2) go(draft.trim());
        }}
      >
        <Input
          aria-label="Search question"
          placeholder="e.g. Who owns EX-02?"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="h-11 min-w-0 flex-1 md:h-9"
        />
        <Button type="submit" size="touch" disabled={draft.trim().length < 2}>
          <SearchIcon aria-hidden /> Search
        </Button>
      </form>

      {!submitted ? (
        <EmptyState
          icon={<TextSearch />}
          title="Ask about any record"
          description={
            <span className="flex flex-col items-center gap-1.5">
              Try one of these:
              {EXAMPLES.map((q) => (
                <button key={q} type="button" onClick={() => go(q)} className="text-sky-800 underline underline-offset-2">
                  {q}
                </button>
              ))}
            </span>
          }
        />
      ) : results.isPending ? (
        <LoadingSkeleton rows={4} />
      ) : results.isError ? (
        <ErrorState error={results.error} onRetry={() => void results.refetch()} />
      ) : results.data.results.length === 0 ? (
        <EmptyState title="No matching passages" description="Nothing available at this time matches. Try other words or move the clock forward." />
      ) : (
        <section className="flex flex-col gap-3" aria-label="Search results">
          <p className="text-xs text-muted-foreground">
            {results.data.results.length} passages · {results.data.reranked ? "ranked by relevance model" : "ranked by text match"}
          </p>
          {results.data.results.map((r, i) => (
            <Card key={r.passage_id} className="py-3">
              <CardContent className="flex flex-col gap-2 px-3">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <span className="font-semibold text-foreground">{i + 1}.</span>
                  <Link href={`/documents/${r.source_id}?locator=${encodeURIComponent(r.locator)}#passage-${r.locator}`} className="font-medium text-foreground hover:underline">
                    {r.source_title ?? r.source_id}
                  </Link>
                  <span>
                    {SOURCE_TYPE_LABEL[r.source_kind]} · {fmtDateTime(r.available_at)}
                  </span>
                  {r.untrusted && <span className="text-amber-800">· External text, quoted</span>}
                </div>
                <p className="text-sm whitespace-pre-wrap">{r.excerpt}</p>
                <span>
                  <CitationChip refData={r.ref} />
                </span>
              </CardContent>
            </Card>
          ))}
        </section>
      )}
    </>
  );
}

export default function SearchPage() {
  return (
    <Suspense fallback={<LoadingSkeleton rows={4} />}>
      <SearchInner />
    </Suspense>
  );
}
