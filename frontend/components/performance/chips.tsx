import { AlertOctagon, AlertTriangle, CheckCircle2, CircleDashed, TrendingUp } from "lucide-react";
import { CAUSE_TEXT, OVERALL_TEXT, STATUS_TEXT, type DailyActivity, type Snapshot } from "@/lib/performance";
import { cn } from "@/lib/utils";

const base =
  "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap [&_svg]:size-3.5 [&_svg]:shrink-0";

/** Colour + icon + text, so meaning never depends on colour alone (as components/badges.tsx). */
export function BandChip({ band, label, className }: { band: "none" | "amber" | "red" | "green" | string | null; label?: string; className?: string }) {
  if (band === "red")
    return <span className={cn(base, "border-red-300 bg-red-50 text-red-800", className)}><AlertOctagon aria-hidden /> {label ?? "Red"}</span>;
  if (band === "amber")
    return <span className={cn(base, "border-amber-300 bg-amber-50 text-amber-900", className)}><AlertTriangle aria-hidden /> {label ?? "Amber"}</span>;
  if (band === "green")
    return <span className={cn(base, "border-emerald-300 bg-emerald-50 text-emerald-800", className)}><CheckCircle2 aria-hidden /> {label ?? "Green"}</span>;
  return <span className={cn(base, "border-border bg-muted text-muted-foreground", className)}><CircleDashed aria-hidden /> {label ?? "No deviation"}</span>;
}

export function StatusChip({ a }: { a: Pick<DailyActivity, "status" | "severity" | "days_late" | "escalated"> }) {
  const label = STATUS_TEXT[a.status] + (a.status === "late_start" && a.days_late ? ` · ${a.days_late} wd` : "") + (a.escalated ? " · 2nd amber day" : "");
  if (a.status === "exceeded" || a.status === "unplanned_work")
    return <span className={cn(base, "border-emerald-300 bg-emerald-50 text-emerald-800")}><TrendingUp aria-hidden /> {label}</span>;
  if (a.severity === "none" && a.status !== "behind") return <BandChip band="none" label={label} />;
  return <BandChip band={a.severity} label={label} />;
}

export function CauseChip({ cause, confidence, excusable }: { cause: string; confidence: number; excusable?: boolean }) {
  return (
    <span className={cn(base, cause === "unknown" ? "border-border bg-muted text-muted-foreground" : "border-violet-300 bg-violet-50 text-violet-900")}>
      {CAUSE_TEXT[cause] ?? cause}
      {cause !== "unknown" && <span className="font-normal opacity-75">· {Math.round(confidence * 100)}%</span>}
      {excusable && <span className="font-normal">· excusable?</span>}
    </span>
  );
}

export function OverallChip({ status }: { status: Snapshot["metrics"]["overall_status"] }) {
  const band = status === "delayed" ? "red" : status === "at_risk" ? "amber" : "green";
  return <BandChip band={band} label={OVERALL_TEXT[status]} />;
}
