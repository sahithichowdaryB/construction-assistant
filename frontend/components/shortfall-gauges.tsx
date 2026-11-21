"use client";

import { ChevronRight, FileText } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { fmtLocalDate, localDateOf } from "@/lib/time";
import type { Alert } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { NoticeDraft } from "@/lib/workflow";

function Ring({ pct }: { pct: number }) {
  const r = 24;
  const c = 2 * Math.PI * r;
  const severe = pct >= 30;
  return (
    <span className="relative size-14 shrink-0">
      <svg viewBox="0 0 56 56" className="size-14 -rotate-90" aria-hidden>
        <circle cx="28" cy="28" r={r} fill="none" strokeWidth="6" className={severe ? "stroke-red-100 dark:stroke-red-500/20" : "stroke-amber-100 dark:stroke-amber-500/20"} />
        <circle cx="28" cy="28" r={r} fill="none" strokeWidth="6" strokeLinecap="round"
          strokeDasharray={`${Math.round((Math.min(pct, 100) / 100) * c)} ${Math.round(c)}`}
          className={severe ? "stroke-red-600" : "stroke-amber-600"} />
      </svg>
      <b className={cn("absolute inset-0 flex items-center justify-center text-[13px] tabular", severe ? "text-red-600" : "text-amber-700 dark:text-amber-400")}>
        {Math.round(pct)}%
      </b>
    </span>
  );
}

/** Shortfalls that still need a notice, as gauges with one action each, plus a link to the notice register. */
export function ShortfallGauges({ shortfalls, notices, onDraft }: {
  shortfalls: Alert[];
  notices: NoticeDraft[] | undefined;
  onDraft: (alert: Alert) => void;
}) {
  const [all, setAll] = useState(false);
  const worstFirst = [...shortfalls].sort((a, b) => (b.calculation?.shortfall_pct ?? 0) - (a.calculation?.shortfall_pct ?? 0));
  const shown = all ? worstFirst : worstFirst.slice(0, 4);
  const done = notices?.filter((n) => n.status === "approved").length ?? 0;
  const todo = (notices?.length ?? 0) - done;
  return (
    <section className="mb-5 rounded-2xl border bg-card p-4" aria-label="Shortfalls that need a notice">
      {shortfalls.length > 0 && (
        <>
          <div className="mb-2 flex items-center gap-2">
            <h2 className="font-semibold">Needs a notice</h2>
            <span className="rounded-full bg-destructive px-2 text-xs leading-5 font-bold text-white tabular">{shortfalls.length}</span>
            {shortfalls.length > 4 && (
              <button type="button" onClick={() => setAll(!all)} className="ml-auto text-xs font-semibold text-muted-foreground hover:text-foreground">
                {all ? "Show worst 4" : `Show all ${shortfalls.length}`}
              </button>
            )}
          </div>
          <ul className="mb-3 grid gap-2 sm:grid-cols-2">
            {shown.map((a) => (
              <li key={a.id} className="flex items-center gap-3 rounded-xl bg-muted/40 p-2.5">
                <Ring pct={a.calculation?.shortfall_pct ?? 0} />
                <span className="min-w-0">
                  <span className="block truncate text-[15px] font-bold">{a.activity_code}</span>
                  <span className="block text-xs text-muted-foreground">{fmtLocalDate(localDateOf(a.checkpoint_at)).replace(/ \d{4}$/, "")}</span>
                </span>
                <button type="button" onClick={() => onDraft(a)}
                  className="ml-auto rounded-xl bg-primary px-3.5 py-2 text-sm font-bold text-primary-foreground hover:bg-primary/90">
                  Draft
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <Link href="/manager/notices" className="flex items-center gap-2.5 rounded-xl bg-muted/50 px-3 py-2.5 text-sm font-semibold hover:bg-muted">
        <FileText className="size-4 text-muted-foreground" aria-hidden /> Notices
        <span className="ml-auto flex items-center gap-1.5 text-xs">
          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">{todo} to do</span>
          <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300">{done} done</span>
          <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
        </span>
      </Link>
    </section>
  );
}
