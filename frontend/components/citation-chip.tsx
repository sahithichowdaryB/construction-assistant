"use client";

import { FileText } from "lucide-react";
import { useApp } from "@/components/providers/app-context";
import { refLabel } from "@/lib/format";
import type { EvidenceRef } from "@/lib/types";
import { cn } from "@/lib/utils";

/** A clickable source reference. Opens the EvidenceViewer in a sheet. */
export function CitationChip({ refData, n, className }: { refData: EvidenceRef; n?: number; className?: string }) {
  const { openEvidence } = useApp();
  const label = refLabel(refData);
  return (
    <button
      type="button"
      onClick={() => openEvidence(refData)}
      aria-label={`Open evidence ${n ? `[${n}] ` : ""}${label}`}
      className={cn(
        "inline-flex min-h-6 items-center gap-1 whitespace-nowrap rounded border border-sky-200 bg-sky-50 px-1.5 align-middle font-mono text-[11px] leading-none text-sky-900",
        "hover:bg-sky-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        className,
      )}
    >
      {n ? <span className="font-semibold">[{n}]</span> : <FileText className="size-3" aria-hidden />}
      {label}
    </button>
  );
}

export function CitationList({ refs, className }: { refs: EvidenceRef[]; className?: string }) {
  if (!refs.length) return <span className={cn("text-xs text-muted-foreground", className)}>No source</span>;
  return (
    <span className={cn("inline-flex flex-wrap gap-1", className)}>
      {refs.map((r, i) => (
        <CitationChip key={`${r.source_id}-${r.locator ?? ""}-${i}`} refData={r} />
      ))}
    </span>
  );
}
