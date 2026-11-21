"use client";

import { AlertTriangle, CheckCircle2, CircleDashed, FilePen, Hammer, MessageSquareWarning, Search, Send, Truck } from "lucide-react";
import { useEffect, useState } from "react";
import { CitationChip } from "@/components/citation-chip";
import { DayNav } from "@/components/day-nav";
import { SiteActivity } from "@/components/site-activity";
import { DayPerformanceCard } from "@/components/performance/day-performance-card";
import { GatedButton } from "@/components/gated-button";
import { NoticeText } from "@/components/notice-text";
import { NoticeDownloads } from "@/components/notice-downloads";
import { RecapStrip } from "@/components/recap/recap-strip";
import { EvidenceAt, useApp } from "@/components/providers/app-context";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader } from "@/components/states";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { fmtQty, SOURCE_TYPE_LABEL } from "@/lib/format";
import { useAlerts } from "@/lib/queries";
import { denyReason } from "@/lib/roles";
import { fmtDateTime, fmtLocalDate, localDateOf } from "@/lib/time";
import type { SourceType } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  STATUS_LABEL,
  STATUS_TONE,
  useDraftNotice,
  noticeLabel,
  useFieldNotes,
  useNotices,
  useRelated,
  useReviseNotice,
  useSiteDay,
  type DayActivity,
  type NoticeDraft,
} from "@/lib/workflow";

const ROW_STATUS: Record<DayActivity["status"], { label: string; cls: string }> = {
  behind: { label: "Behind", cls: "bg-red-50 text-red-800 ring-red-200" },
  not_reported: { label: "Not reported yet", cls: "bg-muted text-muted-foreground ring-border" },
  on_track: { label: "On track", cls: "bg-emerald-50 text-emerald-800 ring-emerald-200" },
};

function DayTable({ rows, selected, onSelect }: { rows: DayActivity[]; selected: string | null; onSelect: (code: string) => void }) {
  return (
    <ul className="divide-y overflow-hidden rounded-2xl border bg-card shadow-xs" aria-label="Activities planned for the day">
      {rows.map((a) => {
        const pct = a.actual === null ? 0 : Math.min(100, (100 * a.actual) / a.planned);
        return (
          <li key={a.code}>
            <button
              type="button"
              aria-pressed={selected === a.code}
              onClick={() => onSelect(a.code)}
              className={cn(
                "grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-3 text-left transition-colors hover:bg-muted/40 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_8rem_auto]",
                selected === a.code && "bg-primary/10 hover:bg-primary/10",
              )}
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold">{a.name}</span>
                <span className="text-xs text-muted-foreground">
                  <span className="font-mono">{a.code}</span>
                  {a.contractor ? ` · ${a.contractor}` : ""}
                  {a.notes.total ? ` · ${a.notes.total} field note${a.notes.total === 1 ? "" : "s"}` : ""}
                </span>
              </span>
              <span className="order-last col-span-2 flex items-center gap-2 md:order-none md:col-span-1">
                <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                  <span className={cn("block h-full rounded-full", a.status === "behind" ? "bg-red-500" : "bg-primary")} style={{ width: `${pct}%` }} />
                </span>
                <span className="w-28 text-right text-xs tabular-nums">
                  {a.actual === null ? "—" : fmtQty(a.actual)} / {fmtQty(a.planned, a.unit)}
                </span>
              </span>
              <span className="hidden text-xs tabular-nums md:block">
                {a.shortfall_pct ? <span className="font-semibold text-red-800">{a.shortfall_pct}% short</span> : a.actual !== null ? "0% short" : ""}
              </span>
              <span className={cn("justify-self-end rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset", ROW_STATUS[a.status].cls)}>
                {a.notice ? STATUS_LABEL[a.notice.status] : ROW_STATUS[a.status].label}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Detail({ a, date }: { a: DayActivity; date: string }) {
  const short = a.actual === null ? null : Math.max(a.planned - a.actual, 0);
  return (
    <section className="rounded-2xl border bg-card p-5 shadow-xs" aria-labelledby="detail-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
            {fmtLocalDate(date)} · Zone {a.zone ?? "—"}
          </p>
          <h2 id="detail-title" className="mt-1 text-xl font-bold tracking-tight md:text-2xl">
            {a.name} · {a.actual === null ? "not reported" : <span className="tabular-nums">{fmtQty(a.actual)}</span>} of{" "}
            <span className="tabular-nums">{fmtQty(a.planned, a.unit)}</span>
          </h2>
        </div>
        {a.status === "behind" && (
          <span className={cn("rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset", a.severity === "high" ? "bg-red-50 text-red-800 ring-red-200" : "bg-amber-50 text-amber-900 ring-amber-200")}>
            {a.shortfall_pct}% short · {a.severity}
          </span>
        )}
      </div>
      <div className="mt-4 h-3 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full", a.status === "behind" ? "bg-red-500" : "bg-primary")} style={{ width: `${a.actual === null ? 0 : Math.min(100, (100 * a.actual) / a.planned)}%` }} />
      </div>
      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted-foreground">Planned</dt>
          <dd className="flex items-center gap-1.5 font-semibold">
            {fmtQty(a.planned, a.unit)} <CitationChip refData={a.plan_ref} />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Signed report</dt>
          <dd className="flex items-center gap-1.5 font-semibold">
            {a.actual === null ? "Not in yet" : fmtQty(a.actual, a.unit)}
            {a.actual_ref && <CitationChip refData={a.actual_ref} />}
          </dd>
          {a.reported_at && <dd className="text-xs text-muted-foreground">received {fmtDateTime(a.reported_at)}</dd>}
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{short === null ? "Estimate" : "Behind plan"}</dt>
          <dd className="flex items-center gap-1.5 font-semibold">
            {short !== null ? fmtQty(short, a.unit) : a.estimate ? `${fmtQty(a.estimate.value, a.unit)} (estimate)` : "None"}
            {short === null && a.estimate && <CitationChip refData={a.estimate.ref} />}
          </dd>
        </div>
      </dl>
      {!!a.equipment.length && (
        <p className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <Truck className="size-3.5" aria-hidden /> Equipment:
          {a.equipment.map((e) => (
            <span key={e.id} className="rounded bg-muted px-1.5 py-0.5 text-foreground">
              {e.id} · {e.description}
            </span>
          ))}
        </p>
      )}
    </section>
  );
}

function ForemanNotes({ code, date }: { code: string; date: string }) {
  const notes = useFieldNotes();
  const mine = (notes.data ?? []).filter(
    (n) => localDateOf(n.recorded_at) === date && n.facts.some((f) => f.field === "activity_code" && f.value === code),
  );
  return (
    <section className="rounded-2xl border bg-card p-5 shadow-xs" aria-labelledby="notes-title">
      <h2 id="notes-title" className="mb-3 flex items-center gap-2 text-base font-semibold">
        <Hammer className="size-4 text-muted-foreground" aria-hidden /> Field notes
      </h2>
      {notes.isPending ? (
        <LoadingSkeleton rows={1} />
      ) : notes.isError ? (
        <ErrorState error={notes.error} onRetry={() => void notes.refetch()} />
      ) : mine.length ? (
        <ul className="flex flex-col gap-2">
          {mine.map((n) => (
            <li key={n.source_id} className="rounded-xl border p-3 text-sm">
              <p className="font-medium">“{n.text}”</p>
              <p className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className={cn("rounded-full px-2 py-0.5 font-medium", n.status === "confirmed" ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-900")}>
                  {n.status === "confirmed" ? "Confirmed" : "Not confirmed yet"}
                </span>
                {n.author} · {fmtDateTime(n.recorded_at)}
                <CitationChip refData={{ source_id: n.source_id, locator: "transcript", passage_id: `${n.source_id}:transcript` }} />
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No field note about this work on this day.</p>
      )}
      {mine.some((n) => n.status !== "confirmed") && <p className="mt-2 text-xs text-muted-foreground">Only confirmed notes are quoted in a notice.</p>}
    </section>
  );
}

function RelatedRecords({ code, date }: { code: string; date: string }) {
  const related = useRelated(code, date);
  return (
    <section className="rounded-2xl border bg-card p-5 shadow-xs" aria-labelledby="related-title">
      <h2 id="related-title" className="mb-1 flex items-center gap-2 text-base font-semibold">
        <Search className="size-4 text-muted-foreground" aria-hidden /> Related records
      </h2>
      <p className="mb-3 text-xs text-muted-foreground">Found by document search in what was available at the clock time.</p>
      {related.isPending ? (
        <LoadingSkeleton rows={2} />
      ) : related.isError ? (
        <ErrorState error={related.error} onRetry={() => void related.refetch()} />
      ) : related.data.results.length ? (
        <ul className="flex flex-col gap-2">
          {related.data.results.map((r) => (
            <li key={r.ref.passage_id} className="rounded-xl border p-3 text-sm">
              <p className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <CitationChip refData={r.ref} />
                {SOURCE_TYPE_LABEL[r.source_kind as SourceType] ?? r.source_kind} · {fmtDateTime(r.available_at)}
                {r.untrusted && <span className="rounded bg-amber-100 px-1.5 text-amber-900">external text</span>}
              </p>
              <p className="line-clamp-3">{r.excerpt}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No other records mention this work yet.</p>
      )}
    </section>
  );
}

function ReviseForm({ notice }: { notice: NoticeDraft }) {
  const { role } = useApp();
  const revise = useReviseNotice();
  const [values, setValues] = useState<Record<string, string>>({});
  const missing = notice.latest.missing_fields.filter((f) => f === "contract reference" || f === "contract clause");
  const [body, setBody] = useState(notice.latest.body);
  const needsRevision = notice.status === "changes_requested";
  if (!missing.length && !needsRevision) return null;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        revise.mutate({
          draftId: notice.id,
          expected_version: notice.latest.version,
          body: body !== notice.latest.body ? body : undefined,
          contract_reference: values["contract reference"] || undefined,
          contract_clause: values["contract clause"] || undefined,
        });
      }}
      className="flex flex-col gap-3 rounded-xl border bg-muted/30 p-4"
    >
      {needsRevision && (
        <label className="grid gap-2 text-sm font-medium">
          Revise notice
          <Textarea rows={8} value={body} onChange={(event) => setBody(event.target.value)} />
        </label>
      )}
      {missing.length > 0 && <p className="text-sm font-semibold">Fill in the missing details</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        {missing.map((field) => (
          <div key={field} className="flex flex-col gap-1.5">
            <Label htmlFor={field} className="capitalize">
              {field}
            </Label>
            <Input id={field} value={values[field] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [field]: e.target.value }))} className="h-11 md:h-9" />
          </div>
        ))}
      </div>
      <GatedButton
        type="submit"
        reason={denyReason(role, "edit_draft")}
        size="sm"
        disabled={(body === notice.latest.body && !Object.values(values).some((v) => v.trim())) || revise.isPending}
        className="self-start"
      >
        <Send aria-hidden /> {revise.isPending ? "Saving…" : `Submit version ${notice.latest.version + 1} for approval`}
      </GatedButton>
      {revise.isError && <p className="text-sm text-red-800">{revise.error.message}</p>}
    </form>
  );
}

function NoticePanel({ notice }: { notice: NoticeDraft }) {
  const review = notice.latest.review;
  return (
    <section className="flex flex-col gap-4 rounded-2xl border bg-card p-5 shadow-xs" aria-labelledby="notice-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="notice-title" className="flex items-center gap-2 text-base font-semibold">
          <FilePen className="size-4 text-muted-foreground" aria-hidden /> {noticeLabel(notice)} · version {notice.latest.version}
        </h2>
        <span className={cn("rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset", STATUS_TONE[notice.status])}>{STATUS_LABEL[notice.status]}</span>
      </div>
      {review?.decision === "changes_requested" && (
        <div className="flex gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          <MessageSquareWarning className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>
            <strong>{review.reviewer}</strong> asked for changes: “{review.reason}”
          </p>
        </div>
      )}
      {notice.status === "approved" && review && (
        <p className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
          <CheckCircle2 className="size-4" aria-hidden /> Approved by {review.reviewer} on {fmtDateTime(review.decided_at)}. Ready to send.
        </p>
      )}
      {notice.status === "awaiting_review" && !!notice.latest.missing_fields.length && (
        <p className="flex gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          With the approver. It cannot be approved until these are filled in: {notice.latest.missing_fields.join(", ")}.
        </p>
      )}
      <EvidenceAt at={notice.latest.as_of}>
        <NoticeText body={notice.latest.body} />
      </EvidenceAt>
      <NoticeDownloads notice={notice} />
      {notice.status !== "approved" && <ReviseForm key={notice.latest.version} notice={notice} />}
    </section>
  );
}

function NoticeArea({ a, date }: { a: DayActivity; date: string }) {
  const { role } = useApp();
  const notices = useNotices();
  const draft = useDraftNotice();
  const notice =
    notices.data?.find((n) => (a.notice && n.id === a.notice.id) || (a.alert_id && n.alert_id === a.alert_id)) ??
    (draft.data && draft.data.activity_code === a.code ? draft.data : undefined);

  if (notices.isPending) return <LoadingSkeleton variant="cards" rows={1} />;
  if (notices.isError) return <ErrorState error={notices.error} onRetry={() => void notices.refetch()} />;
  if (notice) return <NoticePanel notice={notice} />;
  if (a.status !== "behind") {
    return (
      <section className="flex gap-3 rounded-2xl border border-dashed bg-card p-5 text-sm text-muted-foreground">
        <CircleDashed className="mt-0.5 size-4 shrink-0" aria-hidden />
        {a.status === "not_reported"
          ? "No signed figure yet for this day. A delay notice needs the signed daily report; move the clock past the report to see it."
          : "Within the alert threshold. No delay notice is needed."}
      </section>
    );
  }
  return (
    <section className="flex flex-col items-start gap-3 rounded-2xl border border-dashed bg-card p-5">
      <h2 className="text-base font-semibold">No notice yet</h2>
      <p className="text-sm text-muted-foreground">
        SiteMate drafts it from the signed report, the programme and confirmed field notes. Every statement carries its source; contract
        details the project record lacks are marked as missing.
      </p>
      <GatedButton
        reason={denyReason(role, "create_draft")}
        size="touch"
        disabled={draft.isPending}
        onClick={() => draft.mutate(a.alert_id ? { alert_id: a.alert_id } : { activity_code: a.code, work_date: date })}
      >
        <FilePen aria-hidden /> {draft.isPending ? "Drafting…" : "Draft & send for review"}
      </GatedButton>
      {draft.isError && <ErrorState error={draft.error} />}
    </section>
  );
}

export default function ManagerPage() {
  const { asOf } = useApp();
  const clockDate = localDateOf(asOf);
  const notices = useNotices();
  const alerts = useAlerts();
  const openShortfalls = alerts.data?.filter((alert) => alert.kind === "shortfall" && alert.activity_code &&
    !["dismissed", "resolved"].includes(alert.status ?? "open") && !notices.data?.some((notice) => notice.alert_id === alert.id));
  const [inboxId, setInboxId] = useState<string | null>(null);
  useEffect(() => { setInboxId(new URLSearchParams(window.location.search).get("notice")); }, []);
  const inboxNotice = notices.data?.find((notice) => notice.id === inboxId);
  const [dayChoice, setDayChoice] = useState<{ date: string; clockDay: string } | null>(null);
  const setPickedDate = (date: string | null) => setDayChoice(date ? { date, clockDay: clockDate } : null);
  const date = dayChoice?.clockDay === clockDate && dayChoice.date <= clockDate ? dayChoice.date : clockDate;
  const day = useSiteDay(date);
  const [pickedCode, setPickedCode] = useState<string | null>(null);
  const rows = (day.data?.activities ?? []).map((activity) => {
    const notice = activity.alert_id && notices.data?.find((item) => item.alert_id === activity.alert_id);
    return notice ? { ...activity, notice: { id: notice.id, status: notice.status } } : activity;
  });
  const selected = rows.find((r) => r.code === pickedCode) ?? rows[0];
  const behind = rows.filter((r) => r.status === "behind").length;

  return (
    <>
      <PageHeader
        title="Shortfalls & notices"
        description={
          day.data
            ? `${rows.length} activities planned · ${behind} behind by more than ${day.data.threshold}% · figures known at ${fmtDateTime(asOf)}`
            : "Planned against signed quantities for the day, and the notice to the client."
        }
        actions={
          <DayNav
            date={date}
            clockDate={clockDate}
            onChange={(d) => {
              setInboxId(null);
              setPickedDate(d);
              setPickedCode(null);
            }}
          />
        }
      />
      {!inboxNotice && <RecapStrip />}
      {!inboxNotice && <SiteActivity date={date} onOpenNotice={setInboxId} />}
      {!inboxNotice && <div className="mb-5"><DayPerformanceCard date={date} /></div>}
      {!!openShortfalls?.length && notices.isSuccess && (
        <section className="mb-5 grid gap-2" aria-label="Shortfalls without a notice">
          <h2 className="text-sm font-semibold">Shortfalls without a notice</h2>
          <div className="flex flex-wrap gap-2">
            {openShortfalls.map((alert) => (
              <button key={alert.id} type="button" className="rounded-xl border bg-card px-3 py-2 text-sm hover:bg-muted"
                onClick={() => {
                  setInboxId(null);
                  setPickedDate(localDateOf(alert.checkpoint_at));
                  setPickedCode(alert.activity_code);
                }}>
                {alert.activity_code} · {fmtLocalDate(localDateOf(alert.checkpoint_at))} · {alert.calculation?.shortfall_pct}% short
              </button>
            ))}
          </div>
        </section>
      )}
      {!!notices.data?.length && (
        <section className="mb-5 grid gap-2" aria-label="Project notices">
          <h2 className="text-sm font-semibold">Project notices</h2>
          <div className="flex flex-wrap gap-2">
            {notices.data.map((notice) => (
              <button type="button" key={notice.id} aria-pressed={inboxId === notice.id}
                className="rounded-xl border bg-card px-3 py-2 text-sm hover:bg-muted"
                onClick={() => setInboxId(inboxId === notice.id ? null : notice.id)}>
                {notice.title ?? noticeLabel(notice)} · {STATUS_LABEL[notice.status]}
              </button>
            ))}
          </div>
        </section>
      )}
      {inboxNotice ? (
        <div className="grid gap-3">
          <button type="button" className="justify-self-start text-sm underline" onClick={() => setInboxId(null)}>Back to shortfalls</button>
          <NoticePanel key={inboxNotice.id} notice={inboxNotice} />
        </div>
      ) : day.isPending ? (
        <LoadingSkeleton variant="cards" rows={2} />
      ) : day.isError ? (
        <ErrorState error={day.error} onRetry={() => void day.refetch()} />
      ) : !selected ? (
        <EmptyState title="Nothing planned on this day" description="Pick another day in the programme." />
      ) : (
        <div className="flex flex-col gap-5">
          <DayTable rows={rows} selected={selected.code} onSelect={setPickedCode} />
          <Detail a={selected} date={date} />
          <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <div className="flex flex-col gap-5">
              <ForemanNotes code={selected.code} date={date} />
              <RelatedRecords code={selected.code} date={date} />
            </div>
            <NoticeArea key={`${selected.code}-${date}`} a={selected} date={date} />
          </div>
        </div>
      )}
    </>
  );
}
