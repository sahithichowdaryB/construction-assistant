"use client";

import Link from "next/link";
import { useState } from "react";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader } from "@/components/states";
import { cn } from "@/lib/utils";
import { noticeLabel, STATUS_LABEL, STATUS_TONE, useNotices } from "@/lib/workflow";

type Tab = "todo" | "approved" | "all";

/** The project's notice and letter register, moved off the daily shortfalls page. */
export default function NoticesPage() {
  const notices = useNotices();
  const [tab, setTab] = useState<Tab>("todo");
  const all = notices.data ?? [];
  const lists: Record<Tab, typeof all> = {
    todo: all.filter((n) => n.status !== "approved"),
    approved: all.filter((n) => n.status === "approved"),
    all,
  };
  const label: Record<Tab, string> = { todo: "To do", approved: "Approved", all: "All" };
  const shown = lists[tab];

  return (
    <>
      <PageHeader title="Notices" description="Every notice and letter for the project, with where it stands." />
      <div role="tablist" aria-label="Notice status" className="mb-3 flex gap-1 border-b text-sm font-semibold">
        {(Object.keys(lists) as Tab[]).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
            className={cn("px-3 py-2", tab === t ? "shadow-[inset_0_-2px_0_currentColor]" : "text-muted-foreground")}>
            {label[t]} <span className="font-normal text-muted-foreground">{lists[t].length}</span>
          </button>
        ))}
      </div>
      {notices.isPending ? <LoadingSkeleton rows={4} /> : notices.isError ? <ErrorState error={notices.error} onRetry={() => void notices.refetch()} />
        : !shown.length ? <EmptyState title="Nothing here" description="No notices in this list." /> : (
          <ul className="divide-y overflow-hidden rounded-2xl border bg-card">
            {shown.map((n) => (
              <li key={n.id}>
                <Link href={`/manager?notice=${n.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/50">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold">{n.title ?? noticeLabel(n)}</span>
                    <span className="block text-xs text-muted-foreground">{noticeLabel(n)}</span>
                  </span>
                  <span className={cn("ml-auto shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1", STATUS_TONE[n.status])}>
                    {n.status === "draft" ? "Draft" : STATUS_LABEL[n.status]}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
    </>
  );
}
