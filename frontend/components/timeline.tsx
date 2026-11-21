import { BellRing, CheckCircle2, FilePen, FileSearch, Megaphone, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { CitationList } from "@/components/citation-chip";
import { fmtDateTime } from "@/lib/time";
import type { TimelineEvent, TimelineKind } from "@/lib/types";
import { cn } from "@/lib/utils";

const KIND: Record<TimelineKind, { label: string; Icon: typeof BellRing; cls: string }> = {
  reported: { label: "Reported", Icon: Megaphone, cls: "bg-sky-100 text-sky-800" },
  evidence: { label: "Evidence linked", Icon: FileSearch, cls: "bg-muted text-foreground" },
  alert: { label: "Alert", Icon: BellRing, cls: "bg-red-100 text-red-800" },
  draft: { label: "Draft", Icon: FilePen, cls: "bg-violet-100 text-violet-800" },
  approved: { label: "Approved", Icon: ShieldCheck, cls: "bg-emerald-100 text-emerald-800" },
  resolved: { label: "Resolved", Icon: CheckCircle2, cls: "bg-emerald-100 text-emerald-800" },
};

export const TIMELINE_STAGES: TimelineKind[] = ["reported", "evidence", "alert", "draft", "approved", "resolved"];

/** Stage strip (reported → evidence → alert → draft → approved → resolved). */
export function TimelineStages({ events }: { events: TimelineEvent[] }) {
  const reached = new Set(events.map((e) => e.kind));
  return (
    <ol className="flex flex-wrap items-center gap-1 text-xs" aria-label="Incident progress">
      {TIMELINE_STAGES.map((k, i) => {
        const on = reached.has(k);
        return (
          <li key={k} className="flex items-center gap-1">
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5",
                on ? KIND[k].cls + " border-transparent" : "border-dashed text-muted-foreground",
              )}
            >
              {on ? <CheckCircle2 className="size-3" aria-hidden /> : null}
              {KIND[k].label}
              <span className="sr-only">{on ? "(done)" : "(not yet)"}</span>
            </span>
            {i < TIMELINE_STAGES.length - 1 && <span aria-hidden className="text-muted-foreground">→</span>}
          </li>
        );
      })}
    </ol>
  );
}

export function Timeline({ events }: { events: TimelineEvent[] }) {
  return (
    <ol className="relative ml-3 border-l pl-5">
      {events.map((e, i) => {
        const k = KIND[e.kind];
        return (
          <li key={`${e.kind}-${e.at}-${i}`} className="mb-5 last:mb-0">
            <span className={cn("absolute -left-3 flex size-6 items-center justify-center rounded-full ring-4 ring-background", k.cls)} aria-hidden>
              <k.Icon className="size-3.5" />
            </span>
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{k.label}</span> · {fmtDateTime(e.at)}
            </p>
            <p className="text-sm">
              {e.link ? (
                <Link href={e.link} className="underline underline-offset-2">
                  {e.label}
                </Link>
              ) : (
                e.label
              )}
            </p>
            {e.refs.length > 0 && <CitationList refs={e.refs} className="mt-1" />}
          </li>
        );
      })}
    </ol>
  );
}
