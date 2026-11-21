"use client";

import type { ReactNode } from "react";
import { CitationChip } from "@/components/citation-chip";
import { cn } from "@/lib/utils";

// [MISSING: contract clause] or a citation group such as [R10 · EXC-B; SCH · FND-B]
const TOKEN = /\[(MISSING: [^\]]+|[A-Za-z0-9-]+ · [^\]]+)\]/g;

function Line({ line }: { line: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of line.matchAll(TOKEN)) {
    if (m.index > last) parts.push(line.slice(last, m.index));
    const inner = m[1];
    if (inner.startsWith("MISSING: ")) {
      parts.push(
        <mark key={m.index} className="rounded bg-red-100 px-1 py-0.5 font-medium text-red-900 ring-1 ring-red-300 ring-inset dark:bg-red-500/20 dark:text-red-200">
          Missing: {inner.slice(9)}
        </mark>,
      );
    } else {
      parts.push(
        <span key={m.index} className="ml-0.5 inline-flex flex-wrap gap-1 align-middle">
          {inner.split(";").map((cite) => {
            const [source_id, locator] = cite.trim().split(" · ");
            return <CitationChip key={cite} refData={{ source_id, locator, passage_id: `${source_id}:${locator}` }} />;
          })}
        </span>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < line.length) parts.push(line.slice(last));
  return <>{parts}</>;
}

/** A notice as a letter: header lines, paragraphs, clickable citations and highlighted gaps. */
export function NoticeText({ body, className }: { body: string; className?: string }) {
  const blocks = body.split(/\n\s*\n/);
  return (
    <article className={cn("rounded-xl border bg-background px-5 py-5 text-sm leading-relaxed shadow-xs sm:px-7", className)}>
      {blocks.map((block, i) => (
        <p key={i} className={cn("mb-3 last:mb-0", i === 0 && "text-[13px] text-muted-foreground")}>
          {block.split("\n").map((line, j) => (
            <span key={j} className={cn("block", i === 0 && j === 0 && "mb-1 text-sm font-bold tracking-wide text-foreground")}>
              <Line line={line} />
            </span>
          ))}
        </p>
      ))}
    </article>
  );
}
