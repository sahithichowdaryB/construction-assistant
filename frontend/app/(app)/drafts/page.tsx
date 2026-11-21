"use client";

import { ChevronRight, FilePen, Plus } from "lucide-react";
import Link from "next/link";
import { DraftStatusBadge } from "@/components/badges";
import { GatedButton } from "@/components/gated-button";
import { useApp } from "@/components/providers/app-context";
import { EmptyState, LoadingSkeleton, PageHeader, QueryState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { NOTICE_LABEL } from "@/lib/format";
import { useDrafts } from "@/lib/queries";
import { denyReason } from "@/lib/roles";
import { AS_OF_PRESETS, fmtDateTime, localToIso } from "@/lib/time";
import { useRouter } from "next/navigation";

export default function DraftsPage() {
  const drafts = useDrafts();
  const { role, setAsOf } = useApp();
  const router = useRouter();
  return (
    <>
      <PageHeader
        title="Drafts"
        description="Notices prepared from alerts or keywords. Every version needs review before export."
        actions={
          <GatedButton reason={denyReason(role, "create_draft")} size="touch" onClick={() => router.push("/drafts/new")}>
            <Plus aria-hidden /> New draft
          </GatedButton>
        }
      />
      <QueryState
        query={drafts}
        loading={<LoadingSkeleton rows={3} />}
        empty={
          <EmptyState
            icon={<FilePen />}
            title="No drafts yet"
            description="The delay notice is drafted when the signed report arrives at 17:30 on 10 November."
            action={
              <Button size="touch" variant="outline" onClick={() => setAsOf(localToIso(AS_OF_PRESETS[2].local))}>
                Jump to {AS_OF_PRESETS[2].label}
              </Button>
            }
          />
        }
      >
        {(list) => (
          <ul className="flex flex-col divide-y rounded-lg border">
            {list.map((d) => (
              <li key={d.id}>
                <Link href={`/drafts/${d.id}`} className="flex min-h-14 items-center gap-3 p-3 hover:bg-muted/50 focus-visible:bg-muted focus-visible:outline-none">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{d.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {NOTICE_LABEL[d.type]} · v{d.latest_version} · {d.open_gaps} open gap{d.open_gaps === 1 ? "" : "s"} · updated {fmtDateTime(d.updated_at)}
                    </span>
                  </span>
                  <DraftStatusBadge status={d.status} />
                  <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
    </>
  );
}
