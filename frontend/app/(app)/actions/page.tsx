"use client";

import { CheckCircle2, ListChecks } from "lucide-react";
import Link from "next/link";
import { CitationChip } from "@/components/citation-chip";
import { GatedButton } from "@/components/gated-button";
import { useApp } from "@/components/providers/app-context";
import { EmptyState, LoadingSkeleton, PageHeader, QueryState } from "@/components/states";
import { Card, CardContent } from "@/components/ui/card";
import { SOURCE_TYPE_LABEL } from "@/lib/format";
import { useActionItems, useCompleteAction } from "@/lib/queries";
import { denyReason } from "@/lib/roles";
import { fmtDateTime } from "@/lib/time";
import { cn } from "@/lib/utils";

export default function ActionsPage() {
  const { role } = useApp();
  const items = useActionItems();
  const complete = useCompleteAction();
  const blocked = denyReason(role, "upload");

  return (
    <>
      <PageHeader
        title="Action items"
        description="Open actions from minutes, diaries, emails and reports. An owner and due date appear only when the source records them."
      />
      <QueryState
        query={items}
        loading={<LoadingSkeleton rows={5} />}
        empty={<EmptyState icon={<ListChecks />} title="No open actions at this time" />}
      >
        {(list) => (
          <ul className="flex flex-col gap-3">
            {list.map((a) => (
              <li key={a.id}>
                <Card className={cn("py-3", a.overdue && "border-red-300")}>
                  <CardContent className="flex flex-col gap-2 px-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <p className="min-w-0 flex-1 text-sm font-medium">{a.description}</p>
                      {a.overdue && (
                        <span className="rounded border border-red-300 bg-red-50 px-1.5 py-0.5 text-xs font-medium text-red-800">Overdue</span>
                      )}
                    </div>
                    <span className="flex flex-wrap gap-x-3 text-xs">
                      {a.owner_name ? <span>Owner: <strong>{a.owner_name}</strong></span> : <span className="text-muted-foreground">Owner not recorded</span>}
                      {a.due_at ? <span>Due: <strong>{fmtDateTime(a.due_at)}</strong></span> : <span className="text-muted-foreground">No due date recorded</span>}
                    </span>
                    {a.quote && <blockquote className="border-l-2 pl-2 text-xs text-muted-foreground">“{a.quote}”</blockquote>}
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <CitationChip refData={a.ref} />
                        <Link href={`/documents/${a.source_id}`} className="hover:underline">
                          {SOURCE_TYPE_LABEL[a.source_type]} · {a.source_title ?? a.source_id}
                        </Link>
                      </span>
                      <GatedButton
                        reason={blocked}
                        size="sm"
                        variant="outline"
                        disabled={complete.isPending}
                        onClick={() => complete.mutate({ id: a.id, completed: true })}
                      >
                        <CheckCircle2 aria-hidden /> Mark done
                      </GatedButton>
                    </div>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
      {complete.isError && <p className="mt-3 text-sm text-red-800">{complete.error.message}</p>}
    </>
  );
}
