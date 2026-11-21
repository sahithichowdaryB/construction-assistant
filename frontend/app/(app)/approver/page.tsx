"use client";

import { BadgeCheck, CheckCircle2, FileWarning, GitCompareArrows, History, MessageSquareWarning, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { CitationChip } from "@/components/citation-chip";
import { GatedButton } from "@/components/gated-button";
import { NoticeText } from "@/components/notice-text";
import { useApp } from "@/components/providers/app-context";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useEvidence } from "@/lib/queries";
import { denyReason } from "@/lib/roles";
import { fmtDateTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { STATUS_LABEL, STATUS_TONE, useNotices, useReviewNotice, type DraftStatus, type NoticeDraft } from "@/lib/workflow";

type Filter = "all" | DraftStatus;
const FILTERS: Filter[] = ["awaiting_review", "changes_requested", "approved", "all"];
const FILTER_LABEL: Record<Filter, string> = { ...STATUS_LABEL, all: "All" };

/** One cited passage, resolved to its stored text so the approver can check the claim. */
function EvidenceLine({ item: r }: { item: NoticeDraft["latest"]["evidence_refs"][number] }) {
  const evidence = useEvidence(r.passage_id);
  return (
    <li className="flex flex-col gap-1 rounded-xl border p-3 text-sm">
      <span className="flex flex-wrap items-center gap-2">
        <CitationChip refData={r} />
        {evidence.data?.source.title && <span className="truncate text-xs text-muted-foreground">{evidence.data.source.title}</span>}
      </span>
      {evidence.isPending ? (
        <span className="h-4 w-2/3 animate-pulse rounded bg-muted" />
      ) : evidence.isError ? (
        <span className="text-xs text-muted-foreground">Passage not available at this time</span>
      ) : (
        <span className="line-clamp-3 text-muted-foreground">{evidence.data.passage.text}</span>
      )}
    </li>
  );
}

/** Lines of the latest version that differ from the previous one. */
function Changes({ notice }: { notice: NoticeDraft }) {
  if (notice.versions.length < 2) return null;
  const prev = notice.versions[notice.versions.length - 2];
  const before = new Set(prev.body.split("\n"));
  const after = new Set(notice.latest.body.split("\n"));
  const added = notice.latest.body.split("\n").filter((l) => l.trim() && !before.has(l));
  const removed = prev.body.split("\n").filter((l) => l.trim() && !after.has(l));
  if (!added.length && !removed.length) return null;
  return (
    <div className="flex flex-col gap-2 rounded-xl border bg-muted/30 p-3 text-sm">
      <p className="flex items-center gap-2 font-semibold">
        <GitCompareArrows className="size-4 text-muted-foreground" aria-hidden /> Changed since version {prev.version}
      </p>
      <ul className="flex flex-col gap-1 font-mono text-xs">
        {removed.map((l) => (
          <li key={`-${l}`} className="rounded bg-red-50 px-2 py-1 text-red-900 line-through decoration-red-400">
            − {l}
          </li>
        ))}
        {added.map((l) => (
          <li key={`+${l}`} className="rounded bg-emerald-50 px-2 py-1 text-emerald-900">
            + {l}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Decision({ notice }: { notice: NoticeDraft }) {
  const { role } = useApp();
  const review = useReviewNotice();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const latest = notice.latest;
  const missing = latest.missing_fields;

  if (latest.review) {
    const approved = latest.review.decision === "approved";
    return (
      <div className={cn("flex gap-2 rounded-xl border p-4 text-sm", approved ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-red-200 bg-red-50 text-red-900")}>
        {approved ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden /> : <MessageSquareWarning className="mt-0.5 size-4 shrink-0" aria-hidden />}
        <p>
          {latest.review.reviewer} {approved ? "approved" : "asked for changes to"} version {latest.version} on {fmtDateTime(latest.review.decided_at)}.
          {!approved && <> Waiting for a new version from the site manager: “{latest.review.reason}”</>}
        </p>
      </div>
    );
  }

  const approveBlocked = denyReason(role, "approve") ?? (missing.length ? `Fill in first: ${missing.join(", ")}. Ask the site manager for a new version.` : null);
  return (
    <div className="flex flex-col gap-3">
      {asking ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            review.mutate({ draftId: notice.id, version: latest.version, decision: "changes_requested", reason });
          }}
          className="flex flex-col gap-2"
        >
          <label htmlFor="reason" className="text-sm font-medium">
            What needs to change?
          </label>
          <Textarea id="reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          {!!missing.length && (
            <button
              type="button"
              className="self-start rounded-full border bg-muted/40 px-3 py-1 text-xs hover:bg-muted"
              onClick={() => setReason(`Add the ${missing.join(" and ")} before this goes out.`)}
            >
              Ask for the missing {missing.join(" and ")}
            </button>
          )}
          <div className="flex flex-wrap gap-2">
            <GatedButton type="submit" reason={denyReason(role, "request_changes")} size="touch" disabled={!reason.trim() || review.isPending}>
              {review.isPending ? "Sending…" : "Send back to site manager"}
            </GatedButton>
            <Button type="button" variant="ghost" size="touch" onClick={() => setAsking(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <GatedButton reason={approveBlocked} size="touch" disabled={review.isPending} onClick={() => review.mutate({ draftId: notice.id, version: latest.version, decision: "approved" })}>
            <BadgeCheck aria-hidden /> Approve version {latest.version}
          </GatedButton>
          <GatedButton reason={denyReason(role, "request_changes")} variant="outline" size="touch" onClick={() => setAsking(true)}>
            Request changes
          </GatedButton>
        </div>
      )}
      {review.isError && <ErrorState error={review.error} />}
    </div>
  );
}

function NoticeReview({ notice }: { notice: NoticeDraft }) {
  const latest = notice.latest;
  const earlier = notice.versions.slice(0, -1).reverse();
  return (
    <section className="flex flex-col gap-4 rounded-2xl border bg-card p-5 shadow-xs" aria-labelledby="review-title">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="review-title" className="text-base font-semibold">
            Delay notice · {notice.activity_name ?? notice.activity_code}
          </h2>
          <p className="text-sm text-muted-foreground">
            Version {latest.version} of {notice.versions.length} · drafted {fmtDateTime(latest.as_of)}
          </p>
        </div>
        <span className={cn("rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset", STATUS_TONE[notice.status])}>{STATUS_LABEL[notice.status]}</span>
      </div>

      {latest.missing_fields.length ? (
        <div className="flex gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>
            <strong>Missing: {latest.missing_fields.join(", ")}.</strong> The project record does not contain it, so SiteMate did not invent
            one. This version cannot be approved.
          </p>
        </div>
      ) : (
        <p className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
          <CheckCircle2 className="size-4" aria-hidden /> All required fields are filled in.
        </p>
      )}

      <Changes notice={notice} />
      <NoticeText body={latest.body} />

      <div className="flex flex-col gap-2">
        <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">Check the evidence ({latest.evidence_refs.length})</p>
        <ul className="grid gap-2 md:grid-cols-2">
          {latest.evidence_refs.map((r) => (
            <EvidenceLine key={r.passage_id} item={r} />
          ))}
        </ul>
      </div>

      <Decision notice={notice} />

      {!!earlier.length && (
        <details className="rounded-xl border">
          <summary className="flex cursor-pointer list-none items-center gap-2 p-3 text-sm font-medium hover:bg-muted/50">
            <History className="size-4 text-muted-foreground" aria-hidden /> Earlier versions ({earlier.length})
          </summary>
          <ul className="flex flex-col gap-2 border-t p-3 text-sm">
            {earlier.map((v) => (
              <li key={v.version} className="flex flex-col gap-0.5">
                <span className="font-medium">
                  Version {v.version} · {fmtDateTime(v.as_of)}
                </span>
                {v.review && (
                  <span className="text-muted-foreground">
                    {v.review.decision === "approved" ? "Approved" : "Changes requested"} by {v.review.reviewer}
                    {v.review.reason ? `: “${v.review.reason}”` : ""}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

export default function ApproverPage() {
  const notices = useNotices();
  const [filter, setFilter] = useState<Filter>("awaiting_review");
  const [picked, setPicked] = useState<string | null>(null);
  const all = notices.data ?? [];
  const count = (f: Filter) => (f === "all" ? all.length : all.filter((n) => n.status === f).length);
  const list = filter === "all" ? all : all.filter((n) => n.status === filter);
  const selected = list.find((n) => n.id === picked) ?? list[0];
  const waiting = count("awaiting_review");

  return (
    <>
      <PageHeader
        title="Approvals"
        description={waiting ? `${waiting} notice${waiting === 1 ? "" : "s"} waiting for your decision.` : "No notice is waiting for your decision."}
      />
      <div role="group" aria-label="Filter notices" className="-mx-1 mb-4 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => {
              setFilter(f);
              setPicked(null);
            }}
            className={cn(
              "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors",
              filter === f ? "border-foreground bg-foreground text-background" : "bg-card hover:bg-muted",
            )}
          >
            {FILTER_LABEL[f]}
            <span className={cn("rounded-full px-1.5 text-[11px] tabular-nums", filter === f ? "bg-background/20" : "bg-muted text-muted-foreground")}>{count(f)}</span>
          </button>
        ))}
      </div>
      {notices.isPending ? (
        <LoadingSkeleton variant="cards" rows={2} />
      ) : notices.isError ? (
        <ErrorState error={notices.error} onRetry={() => void notices.refetch()} />
      ) : !selected ? (
        <EmptyState
          icon={<FileWarning />}
          title={filter === "awaiting_review" ? "Nothing waiting for you" : `No notices: ${FILTER_LABEL[filter].toLowerCase()}`}
          description="Notices the site manager drafts appear here once the project clock reaches them."
        />
      ) : (
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,2.4fr)]">
          <nav aria-label="Notices" className="flex flex-col gap-2">
            {list.map((n) => (
              <button
                key={n.id}
                type="button"
                aria-current={n.id === selected.id ? "true" : undefined}
                onClick={() => setPicked(n.id)}
                className={cn(
                  "flex flex-col gap-1.5 rounded-2xl border bg-card p-4 text-left shadow-xs transition-colors hover:border-foreground/20",
                  n.id === selected.id && "border-foreground/40 ring-1 ring-foreground/20",
                )}
              >
                <span className="text-sm font-semibold">{n.activity_name ?? n.activity_code}</span>
                <span className="text-xs text-muted-foreground">
                  Delay notice · v{n.latest.version} · {fmtDateTime(n.latest.as_of)}
                </span>
                <span className="flex flex-wrap gap-1.5">
                  <span className={cn("w-fit rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset", STATUS_TONE[n.status])}>{STATUS_LABEL[n.status]}</span>
                  {!!n.latest.missing_fields.length && (
                    <span className="rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-800 ring-1 ring-red-200 ring-inset">
                      {n.latest.missing_fields.length} missing
                    </span>
                  )}
                </span>
              </button>
            ))}
          </nav>
          <NoticeReview key={selected.id} notice={selected} />
        </div>
      )}
    </>
  );
}
