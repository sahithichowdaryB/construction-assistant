"use client";

import { ChevronRight, FilePen, Plus } from "lucide-react";
import Link from "next/link";
import { DraftStatusBadge } from "@/components/badges";
import { GatedButton } from "@/components/gated-button";
import { useApp } from "@/components/providers/app-context";
import { EmptyState, LoadingSkeleton, PageHeader, QueryState } from "@/components/states";
import { NOTICE_LABEL } from "@/lib/format";
import { useDrafts } from "@/lib/queries";
import { denyReason } from "@/lib/roles";
import { fmtDateTime } from "@/lib/time";
import { useRouter } from "next/navigation";

export default function DraftsPage() {
  const drafts = useDrafts();
  const { role } = useApp();
  const router = useRouter();
  return (
    <>
      <PageHeader
        title="Notices"
        description="Letters drafted from alerts or incidents. Each version is reviewed before it is sent."
        actions={
          <GatedButton reason={denyReason(role, "create_draft")} size="touch" onClick={() => router.push("/drafts/new")}>
            <Plus aria-hidden /> New notice
          </GatedButton>
        }
      />
      <QueryState
        query={drafts}
        loading={<LoadingSkeleton rows={3} />}
        empty={
          <EmptyState
            icon={<FilePen />}
            title="No notices yet"
            description="Create one from an alert or incident, or start from keywords."
            action={
              <GatedButton reason={denyReason(role, "create_draft")} size="touch" variant="outline" onClick={() => router.push("/drafts/new")}>
                <Plus aria-hidden /> New notice
              </GatedButton>
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
                      {NOTICE_LABEL[d.type]} · version {d.latest_version} · {d.open_gaps} item{d.open_gaps === 1 ? "" : "s"} to complete · updated {fmtDateTime(d.updated_at)}
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
