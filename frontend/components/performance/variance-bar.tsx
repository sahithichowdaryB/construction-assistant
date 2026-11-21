import { cn } from "@/lib/utils";

/** Planned against actual for one day. Green when at or above plan, red when behind; no number is computed here
 *  beyond the bar widths (the variance label comes from the server). */
export function VarianceBar({
  planned,
  actual,
  unit,
  variancePct,
  className,
}: {
  planned: number;
  actual: number | null;
  unit?: string | null;
  variancePct: number | null;
  className?: string;
}) {
  const scale = Math.max(planned, actual ?? 0, 1) * 1.1;
  const ahead = actual !== null && actual >= planned;
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
        {actual !== null && (
          <div className={cn("absolute inset-y-0 left-0 rounded-full", ahead ? "bg-emerald-500" : "bg-red-500")}
               style={{ width: `${(100 * actual) / scale}%` }} />
        )}
        {planned > 0 && <div className="absolute inset-y-[-2px] w-0.5 bg-foreground/70" style={{ left: `${(100 * planned) / scale}%` }} />}
      </div>
      <p className="text-xs text-muted-foreground tabular">
        {actual === null ? "No signed figure yet" : `${actual} of ${planned} ${unit ?? ""}`.trim()}
        {variancePct !== null && (
          <span className={cn("ml-1 font-semibold", variancePct >= 0 ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400")}>
            {variancePct > 0 ? "+" : ""}{variancePct}%
          </span>
        )}
      </p>
    </div>
  );
}
