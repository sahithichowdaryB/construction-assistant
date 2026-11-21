import { basisLabel, fmtPct, fmtQty } from "@/lib/format";
import type { Basis, Severity } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Plan vs actual. Bar length is only a visual scale; the shortfall figure shown is the one the server
 * returned. A missing reading stays "Unknown" and a zero target shows no percentage.
 */
export function ProgressBar({
  planned,
  actual,
  unit,
  basis,
  shortfallPct,
  severity,
  className,
}: {
  planned: number;
  actual: number | null;
  unit: string;
  basis: Basis | null;
  shortfallPct?: number | null;
  /** Server-assigned severity; colours the bar (never derived here) */
  severity?: Severity | null;
  className?: string;
}) {
  const known = actual !== null;
  const zeroTarget = planned === 0;
  const ratio = known && !zeroTarget ? Math.min(actual / planned, 1) : known ? 1 : 0;
  const tone = !known
    ? "bg-transparent"
    : basis === "signed"
      ? severity === "high"
        ? "bg-red-500"
        : severity === "medium"
          ? "bg-amber-500"
          : "bg-emerald-500"
      : "bg-sky-400 bg-[repeating-linear-gradient(45deg,transparent,transparent_4px,rgba(255,255,255,.45)_4px,rgba(255,255,255,.45)_8px)]";

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-sm">
        <span>
          <span className="font-semibold">{fmtQty(actual)}</span>
          <span className="text-muted-foreground"> / {fmtQty(planned, unit)} planned</span>
        </span>
        <span className="text-xs text-muted-foreground">
          {basisLabel(basis)}
          {zeroTarget
            ? " · no target, no percentage"
            : shortfallPct !== null && shortfallPct !== undefined
              ? ` · ${fmtPct(shortfallPct)} short`
              : known
                ? ""
                : " · not reported"}
        </span>
      </div>
      <div
        className={cn("h-2.5 w-full overflow-hidden rounded-full bg-muted", !known && "border border-dashed border-muted-foreground/40")}
        role="img"
        aria-label={`${fmtQty(actual, unit)} of ${fmtQty(planned, unit)}, ${basisLabel(basis)}`}
      >
        <div className={cn("h-full rounded-full", tone)} style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}
