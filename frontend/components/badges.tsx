import { AlertOctagon, AlertTriangle, CheckCircle2, CircleDashed, Eye, FilePen, FileQuestion, HelpCircle, MinusCircle, RotateCcw, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DraftStatus, JobStatus, Provenance, Severity } from "@/lib/types";

const base =
  "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap [&_svg]:size-3.5 [&_svg]:shrink-0";

/** Colour + icon + text, so meaning never depends on colour alone. */
export function SeverityBadge({
  severity,
  kind,
  className,
}: {
  severity: Severity | null | undefined;
  kind?: string;
  className?: string;
}) {
  if (kind === "missing_report")
    return (
      <span className={cn(base, "border-amber-300 bg-amber-50 text-amber-900", className)}>
        <FileQuestion aria-hidden /> Report missing
      </span>
    );
  switch (severity) {
    case "high":
      return (
        <span className={cn(base, "border-red-300 bg-red-50 text-red-800", className)}>
          <AlertOctagon aria-hidden /> High
        </span>
      );
    case "medium":
      return (
        <span className={cn(base, "border-amber-300 bg-amber-50 text-amber-900", className)}>
          <AlertTriangle aria-hidden /> Medium
        </span>
      );
    case "none":
      return (
        <span className={cn(base, "border-emerald-300 bg-emerald-50 text-emerald-800", className)}>
          <CheckCircle2 aria-hidden /> Within threshold
        </span>
      );
    default:
      return (
        <span className={cn(base, "border-border bg-muted text-muted-foreground", className)}>
          <HelpCircle aria-hidden /> Unknown
        </span>
      );
  }
}

const PROVENANCE: Record<Provenance, { label: string; cls: string; Icon: typeof CheckCircle2; hint: string }> = {
  verified: {
    label: "Verified",
    cls: "border-emerald-300 bg-emerald-50 text-emerald-800",
    Icon: CheckCircle2,
    hint: "Stated in the source",
  },
  inferred: {
    label: "Inferred",
    cls: "border-amber-300 bg-amber-50 text-amber-900",
    Icon: HelpCircle,
    hint: "Derived from a register or context; please check",
  },
  missing: {
    label: "Missing",
    cls: "border-red-300 bg-red-50 text-red-800",
    Icon: XCircle,
    hint: "Not found in the source",
  },
};

export function ProvenanceBadge({ provenance, className }: { provenance: Provenance; className?: string }) {
  const p = PROVENANCE[provenance];
  return (
    <span className={cn(base, p.cls, className)} title={p.hint}>
      <p.Icon aria-hidden /> {p.label}
    </span>
  );
}

const DRAFT: Record<DraftStatus, { label: string; cls: string; Icon: typeof CheckCircle2 }> = {
  draft: { label: "Draft", cls: "border-border bg-muted text-foreground", Icon: FilePen },
  in_review: { label: "In review", cls: "border-sky-300 bg-sky-50 text-sky-800", Icon: Eye },
  changes_requested: { label: "Changes requested", cls: "border-amber-300 bg-amber-50 text-amber-900", Icon: RotateCcw },
  approved: { label: "Approved", cls: "border-emerald-300 bg-emerald-50 text-emerald-800", Icon: CheckCircle2 },
};

export function DraftStatusBadge({ status, className }: { status: DraftStatus; className?: string }) {
  const d = DRAFT[status];
  return (
    <span className={cn(base, d.cls, className)}>
      <d.Icon aria-hidden /> {d.label}
    </span>
  );
}

const JOB: Record<JobStatus, { label: string; cls: string; Icon: typeof CheckCircle2; spin?: boolean }> = {
  uploaded: { label: "Uploaded", cls: "border-border bg-muted text-foreground", Icon: CircleDashed },
  extracting: { label: "Extracting", cls: "border-sky-300 bg-sky-50 text-sky-800", Icon: CircleDashed, spin: true },
  indexed: { label: "Indexed", cls: "border-emerald-300 bg-emerald-50 text-emerald-800", Icon: CheckCircle2 },
  failed: { label: "Failed", cls: "border-red-300 bg-red-50 text-red-800", Icon: MinusCircle },
};

export function JobStatusBadge({ status, className }: { status: JobStatus; className?: string }) {
  const j = JOB[status];
  return (
    <span className={cn(base, j.cls, className)} role="status">
      <j.Icon aria-hidden className={j.spin ? "animate-spin" : undefined} /> {j.label}
    </span>
  );
}
