"use client";

import { AlertTriangle } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { CitationChip } from "@/components/citation-chip";
import type { CitedSource } from "@/lib/types";

export const GAP_PATTERN = /\[(MISSING|UNVERIFIED):[^\]]*\]/g;

export function findGapMarkers(text: string): string[] {
  return text.match(GAP_PATTERN) ?? [];
}

const TOKEN = /(\[(?:MISSING|UNVERIFIED):[^\]]*\]|\[\d+\]|\*\*[^*]+\*\*)/g;

function inline(text: string, sources: CitedSource[], keyPrefix: string): ReactNode[] {
  return text.split(TOKEN).map((part, i) => {
    const key = `${keyPrefix}-${i}`;
    if (/^\[(MISSING|UNVERIFIED):/.test(part)) {
      return (
        <mark key={key} className="rounded bg-red-100 px-1 font-medium text-red-800 ring-1 ring-red-300">
          <AlertTriangle className="mr-0.5 inline size-3 align-[-1px]" aria-hidden />
          {part}
        </mark>
      );
    }
    const cite = part.match(/^\[(\d+)\]$/);
    if (cite) {
      const src = sources.find((s) => s.n === Number(cite[1]));
      return src ? (
        <CitationChip key={key} refData={src.ref} n={src.n} className="mx-0.5" />
      ) : (
        <span key={key} className="rounded bg-red-100 px-1 font-mono text-xs text-red-800" title="Citation not in the evidence list">
          {part} (unknown source)
        </span>
      );
    }
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={key}>{part.slice(2, -2)}</strong>;
    return <Fragment key={key}>{part}</Fragment>;
  });
}

/**
 * Minimal Markdown preview (headings, paragraphs, bold) that highlights [MISSING: …] and
 * [UNVERIFIED: …] markers in red and turns [n] into citation chips.
 */
export function GapHighlighter({ text, sources = [] }: { text: string; sources?: CitedSource[] }) {
  const blocks = text.split(/\n{2,}/);
  return (
    <div className="flex flex-col gap-3 text-sm leading-relaxed">
      {blocks.map((block, bi) => {
        const heading = block.match(/^(#{1,3})\s+(.*)$/);
        if (heading && !block.includes("\n")) {
          return (
            <h3 key={bi} className="text-base font-semibold">
              {inline(heading[2], sources, `h${bi}`)}
            </h3>
          );
        }
        const lines = block.split("\n");
        return (
          <p key={bi}>
            {lines.map((line, li) => (
              <Fragment key={li}>
                {inline(line, sources, `p${bi}-${li}`)}
                {li < lines.length - 1 && <br />}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
