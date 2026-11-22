"use client";

import { AlertTriangle, ArrowLeft, Check, CheckCheck, ChevronRight, Database, FileSearch, Info, Pencil, RefreshCw, Ruler, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { type ReactNode, Suspense, useState } from "react";
import { JobStatusBadge } from "@/components/badges";
import { CitationChip, CitationList } from "@/components/citation-chip";
import { OriginalActions, OriginalEmbed } from "@/components/evidence-viewer";
import { GatedButton } from "@/components/gated-button";
import { useApp } from "@/components/providers/app-context";
import { SourceIcon } from "@/components/source-icon";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiError } from "@/lib/api";
import { USE_FIXTURES } from "@/lib/endpoints";
import { basisLabel, fmtQty, SOURCE_TYPE_LABEL } from "@/lib/format";
import {
  useDocumentJob,
  useInvalidateOnJobDone,
  useRegenerateSummary,
  useConfirmReadings,
  useReportReadings,
  useSource,
  useSourceStorage,
  useSourceSummary,
} from "@/lib/queries";
import { denyReason } from "@/lib/roles";
import { fmtDateTime } from "@/lib/time";
import type { Passage, ReadingDecision, ReportReading, SourceSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Panels size to their content (no empty space under short documents) and stop at the screen height,
 * scrolling inside after that. Long unbroken strings (hashes, file names) wrap instead of overflowing.
 */
const PANEL = "lg:max-h-[calc(100dvh-9rem)] [overflow-wrap:anywhere]";

function SectionLabel({ children, count }: { children: ReactNode; count?: number }) {
  return (
    <h3 className="flex items-center gap-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
      {children}
      {count !== undefined && (
        <span className="rounded-full bg-muted px-1.5 py-px text-[10px] font-medium text-foreground tabular-nums">{count}</span>
      )}
    </h3>
  );
}

function RegenerateSummary({ sourceId, label }: { sourceId: string; label: string }) {
  const { role } = useApp();
  const regenerate = useRegenerateSummary();
  const job = useDocumentJob(regenerate.data?.id ?? null);
  useInvalidateOnJobDone(job.data?.status);
  const running = regenerate.isPending || job.data?.status === "extracting" || job.data?.status === "uploaded";
  if (USE_FIXTURES) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <GatedButton reason={denyReason(role, "upload")} size="sm" variant="outline" disabled={running} onClick={() => regenerate.mutate(sourceId)}>
        <RefreshCw aria-hidden className={running ? "animate-spin" : undefined} /> {running ? "Summarising…" : label}
      </GatedButton>
      {job.data?.status === "failed" && <span className="text-xs text-red-800">{job.data.error}</span>}
      {regenerate.isError && <span className="text-xs text-red-800">{regenerate.error.message}</span>}
    </span>
  );
}

// ------------------------------------------------------------------ quantities

const READING_STATUS: Record<ReportReading["review_status"], { label: string; cls: string }> = {
  accepted: { label: "Accepted", cls: "bg-emerald-50 text-emerald-800 ring-emerald-200" },
  corrected: { label: "Corrected", cls: "bg-sky-50 text-sky-900 ring-sky-200" },
  proposed: { label: "Awaiting confirmation", cls: "bg-amber-50 text-amber-900 ring-amber-200" },
  conflict: { label: "Differs from accepted", cls: "bg-red-50 text-red-800 ring-red-200" },
  rejected: { label: "Rejected", cls: "bg-muted text-muted-foreground ring-border" },
};

type Pending = { locator: string; mode: "corrected" | "rejected" };

function ReadingCard({
  r,
  editing,
  onEdit,
  onDecide,
  busy,
  deny,
}: {
  r: ReportReading;
  editing: Pending | null;
  onEdit: (p: Pending | null) => void;
  onDecide: (d: ReadingDecision) => void;
  busy: boolean;
  deny: string | null;
}) {
  const [qty, setQty] = useState<string>(String(r.accepted_value ?? r.value));
  const [reason, setReason] = useState("");
  const open = editing?.locator === r.locator ? editing.mode : null;
  const decidable = r.review_status === "proposed" || r.review_status === "conflict";
  const shown = r.review_status === "corrected" && r.accepted_value !== null ? r.accepted_value : r.value;
  return (
    <div className="flex flex-col gap-2 rounded-xl border bg-background p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs font-semibold">{r.activity_code}</span>
        <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset", READING_STATUS[r.review_status].cls)}>
          {READING_STATUS[r.review_status].label}
        </span>
      </div>
      <p className="text-2xl font-semibold tracking-tight tabular-nums">
        {fmtQty(shown, r.unit)} <span className="text-xs font-normal text-muted-foreground">{basisLabel(r.basis)}</span>
      </p>
      {r.review_status === "corrected" && (
        <p className="text-xs text-muted-foreground">Report read {fmtQty(r.value, r.unit)}; corrected by the site manager.</p>
      )}
      {r.review_status === "conflict" && r.accepted_value !== null && (
        <p className="text-xs text-red-800">
          Stored value is {fmtQty(r.accepted_value, r.unit)}. Accept the report only as a correction, with a reason.
        </p>
      )}
      {r.review && (
        <p className="text-xs text-muted-foreground">
          {r.review.decision === "accepted" ? "Accepted" : r.review.decision === "corrected" ? "Corrected" : "Rejected"}
          {r.review.reviewer ? ` by ${r.review.reviewer}` : ""} · {fmtDateTime(r.review.decided_at)}
          {r.review.reason ? ` · “${r.review.reason}”` : ""}
        </p>
      )}
      <CitationChip refData={r.ref} className="self-start" />
      {decidable && !open && (
        <div className="flex flex-wrap gap-2 pt-1">
          {r.review_status === "proposed" && (
            <GatedButton reason={deny} size="sm" disabled={busy} onClick={() => onDecide({ locator: r.locator, decision: "accepted" })}>
              <Check aria-hidden /> Accept
            </GatedButton>
          )}
          <GatedButton reason={deny} size="sm" variant="outline" disabled={busy} onClick={() => onEdit({ locator: r.locator, mode: "corrected" })}>
            <Pencil aria-hidden /> Correct
          </GatedButton>
          <GatedButton reason={deny} size="sm" variant="ghost" disabled={busy} onClick={() => onEdit({ locator: r.locator, mode: "rejected" })}>
            <X aria-hidden /> Reject
          </GatedButton>
        </div>
      )}
      {open && (
        <form
          className="flex flex-col gap-2 border-t pt-2"
          onSubmit={(e) => {
            e.preventDefault();
            onDecide({
              locator: r.locator,
              decision: open,
              quantity: open === "corrected" ? Number(qty) : null,
              reason: reason.trim(),
            });
          }}
        >
          {open === "corrected" && (
            <label className="flex flex-col gap-1 text-xs font-medium">
              Correct quantity ({r.unit})
              <Input type="number" min={0} step="any" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} required />
            </label>
          )}
          <label className="flex flex-col gap-1 text-xs font-medium">
            {open === "corrected" ? "Why is the report value wrong?" : "Why is this reading not used?"}
            <Input value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={1000} placeholder="Required" />
          </label>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy || !reason.trim() || (open === "corrected" && qty === "")}>
              {open === "corrected" ? "Save correction" : "Reject reading"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => onEdit(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

function QuantitiesPanel({ sourceId }: { sourceId: string }) {
  const { role } = useApp();
  const readings = useReportReadings(sourceId);
  const confirm = useConfirmReadings(sourceId);
  const [editing, setEditing] = useState<Pending | null>(null);
  if (readings.isPending) return <LoadingSkeleton rows={3} />;
  if (readings.isError)
    return readings.error instanceof ApiError && readings.error.status === 404 ? (
      <EmptyState title="No extracted quantities" description={readings.error.message} />
    ) : (
      <ErrorState error={readings.error} onRetry={() => void readings.refetch()} />
    );
  const deny = denyReason(role, "confirm_readings");
  const all = readings.data.readings;
  const rows = all.filter((r) => !r.locator.startsWith("zero-"));
  const zeroRows = all.filter((r) => r.locator.startsWith("zero-"));
  const waiting = all.filter((r) => r.review_status === "proposed" && r.basis === "signed").length;
  const conflicts = all.filter((r) => r.review_status === "conflict").length;
  const decide = (d: ReadingDecision) =>
    confirm.mutate({ decisions: [d] }, { onSuccess: () => setEditing(null) });
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Measured shift quantities read from the report. They count in progress, alerts and the daily evaluation only after the
        site manager confirms them.
      </p>
      {!!readings.data.review_reasons.length && (
        <ul className="list-disc rounded-lg border border-amber-300 bg-amber-50 p-3 pl-7 text-sm text-amber-900">
          {readings.data.review_reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      {(waiting > 0 || conflicts > 0) && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/40 p-3">
          <p className="flex-1 text-sm">
            {waiting > 0 && `${waiting} signed reading${waiting === 1 ? "" : "s"} waiting for confirmation.`}{" "}
            {conflicts > 0 && `${conflicts} differ${conflicts === 1 ? "s" : ""} from a stored value and need a correction or rejection.`}
          </p>
          {waiting > 0 && (
            <GatedButton reason={deny} size="sm" disabled={confirm.isPending} onClick={() => confirm.mutate({ all_signed: true })}>
              <CheckCheck aria-hidden /> {confirm.isPending ? "Confirming…" : `Confirm ${waiting} signed`}
            </GatedButton>
          )}
        </div>
      )}
      {confirm.isError && <p className="text-sm text-red-800" role="alert">{confirm.error.message}</p>}
      {confirm.isSuccess && !!confirm.data.queued_days.length && (
        <p className="text-sm text-emerald-800" role="status">
          Saved. The daily evaluation for {confirm.data.queued_days.join(", ")} is queued and updates within about two minutes.
        </p>
      )}
      {rows.length ? (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
          {rows.map((r) => (
            <ReadingCard key={r.locator} r={r} editing={editing} onEdit={setEditing} onDecide={decide} busy={confirm.isPending} deny={deny} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No quantity rows were read from this report.</p>
      )}
      {!!zeroRows.length && (
        <p className="flex gap-1.5 text-xs text-muted-foreground">
          <Info className="mt-px size-3.5 shrink-0" aria-hidden />
          The report states that other scheduled activities recorded zero production this shift ({zeroRows.length} row
          {zeroRows.length === 1 ? "" : "s"}); confirming the signed rows records those as 0.
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ summary

function SummaryItems({ items }: { items: SourceSummary["observations"] }) {
  if (!items.length) return <p className="text-sm text-muted-foreground">None recorded.</p>;
  return (
    <ul className="flex flex-col gap-3">
      {items.map((o, i) => (
        <li key={i} className="flex flex-col gap-1.5 border-l-2 border-sky-200 pl-3 text-sm leading-relaxed">
          {o.text}
          <CitationList refs={o.refs} />
        </li>
      ))}
    </ul>
  );
}

function SummaryPanel({ sourceId, pending }: { sourceId: string; pending: boolean }) {
  const summary = useSourceSummary(sourceId, true, pending);
  if (summary.isPending) return <LoadingSkeleton rows={4} />;
  if (summary.isError) {
    if (summary.error instanceof ApiError && summary.error.status === 404 && pending)
      return (
        <EmptyState
          icon={<RefreshCw className="animate-spin" />}
          title="Summarising…"
          description="Claude is reading this document. The summary appears here when it is ready."
        />
      );
    if (summary.error instanceof ApiError && summary.error.status === 404)
      return (
        <EmptyState
          title="No summary yet"
          description="Summaries are prepared for diaries, minutes, emails and daily reports."
          action={<RegenerateSummary sourceId={sourceId} label="Generate summary" />}
        />
      );
    return <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />;
  }
  const d = summary.data;
  return (
    <div className="flex flex-col gap-6">
      {d.headline && (
        <p className="rounded-xl border border-sky-100 bg-gradient-to-br from-sky-50 to-background p-4 text-sm leading-relaxed font-medium">
          {d.headline}
        </p>
      )}
      <section className="flex flex-col gap-2.5">
        <SectionLabel count={d.open_actions.length}>Open actions</SectionLabel>
        {d.open_actions.length ? (
          <ul className="flex flex-col gap-2">
            {d.open_actions.map((a, i) => (
              <li key={i} className="flex flex-col gap-2 rounded-xl border bg-background p-3 text-sm">
                <span className="leading-relaxed">{a.text}</span>
                <span className="flex flex-wrap gap-1.5 text-xs">
                  {/* Owner and due date are shown only when the source records them */}
                  <span className={cn("rounded-md px-2 py-0.5", a.owner ? "bg-muted" : "text-muted-foreground")}>
                    {a.owner ? <>Owner <strong>{a.owner}</strong></> : "Owner not recorded"}
                  </span>
                  <span className={cn("rounded-md px-2 py-0.5", a.due ? "bg-muted" : "text-muted-foreground")}>
                    {a.due ? <>Due <strong>{fmtDateTime(a.due)}</strong></> : "No due date recorded"}
                  </span>
                </span>
                <CitationList refs={a.refs} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">None recorded.</p>
        )}
      </section>
      <section className="flex flex-col gap-2.5">
        <SectionLabel count={d.observations.length}>Observations</SectionLabel>
        <SummaryItems items={d.observations} />
      </section>
      <section className="flex flex-col gap-2.5">
        <SectionLabel count={d.decisions.length}>Decisions</SectionLabel>
        <SummaryItems items={d.decisions} />
      </section>
      {!!d.provisional?.length && (
        <section className="flex flex-col gap-2.5">
          <SectionLabel count={d.provisional.length}>Provisional or unconfirmed</SectionLabel>
          <SummaryItems items={d.provisional} />
        </section>
      )}
      {!!d.quoted_external_instructions?.length && (
        <section className="flex flex-col gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-amber-900">
            <AlertTriangle className="size-4" aria-hidden /> Quoted external text (not acted on)
          </h3>
          <ul className="flex flex-col gap-2 text-sm text-amber-950">
            {d.quoted_external_instructions.map((o, i) => (
              <li key={i} className="flex flex-col gap-1">
                {o.text}
                <CitationList refs={o.refs} />
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-xs text-muted-foreground">
        <span>
          {d.version !== undefined ? `Machine-generated summary v${d.version}` : "Summary"}
          {d.model ? ` · ${d.model}` : ""} · check the cited passages
        </span>
        {d.version !== undefined && <RegenerateSummary sourceId={sourceId} label="Regenerate" />}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ passages

function PassagesPanel({ passages, selected, onSelect }: { passages: Passage[]; selected: string | null; onSelect: (p: Passage) => void }) {
  if (!passages.length) return <p className="text-sm text-muted-foreground">No passages indexed for this source.</p>;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">Select a passage to find it in the original.</p>
      <ul className="flex flex-col gap-2">
        {passages.map((p) => {
          const active = selected === p.locator;
          return (
            <li key={p.id} id={`passage-${p.locator}`}>
              <button
                type="button"
                onClick={() => onSelect(p)}
                aria-pressed={active}
                className={cn(
                  "w-full rounded-xl border bg-background p-3 text-left transition-all hover:border-foreground/20 hover:shadow-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  active && "border-amber-400 bg-amber-50 ring-1 ring-amber-300 hover:border-amber-400 dark:bg-amber-500/10",
                )}
              >
                <span className="mb-1.5 flex flex-wrap items-center gap-1.5">
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{p.locator}</span>
                  {p.page ? <span className="text-[11px] text-muted-foreground">page {p.page}</span> : null}
                  {p.section ? <span className="truncate text-[11px] text-muted-foreground">{p.section}</span> : null}
                  {p.untrusted && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-900">External text, quoted</span>}
                </span>
                <span className="block text-sm leading-relaxed whitespace-pre-wrap">{p.text}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------ storage

function fmtBytes(n: number | null) {
  if (n === null) return "Unknown size";
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** One stored value: null stays visible as "null"; JSON and long text fold open on click. */
function CellValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground italic">null</span>;
  if (typeof value === "boolean") return <span className="font-mono">{String(value)}</span>;
  const isJson = typeof value === "object";
  const text = isJson ? JSON.stringify(value) : String(value);
  if (text.length <= 140) return <span className={cn(isJson && "font-mono")}>{text}</span>;
  return (
    <details>
      <summary className="cursor-pointer text-sky-800">
        <span className={cn(isJson && "font-mono")}>{text.slice(0, 90)}…</span> <span className="underline">show all</span>
      </summary>
      <pre className="mt-1 max-h-96 overflow-auto rounded bg-muted p-2 font-mono text-[11px] whitespace-pre-wrap">
        {isJson ? JSON.stringify(value, null, 2) : text}
      </pre>
    </details>
  );
}

function StorageSection({ sourceId }: { sourceId: string }) {
  const storage = useSourceStorage(sourceId);
  return (
    <section aria-labelledby="storage-title" className="rounded-2xl border bg-card shadow-xs">
      <header className="flex flex-col gap-1 border-b px-5 py-4">
        <h2 id="storage-title" className="flex items-center gap-2 text-base font-semibold">
          <Database className="size-4 text-muted-foreground" aria-hidden /> Where this is stored
        </h2>
        <p className="text-sm text-muted-foreground">
          Every row this document has in schema <span className="font-mono">sitemate</span>, with every column, exactly as stored.
        </p>
      </header>
      <div className="flex flex-col gap-3 p-5">
        {storage.isPending ? (
          <LoadingSkeleton rows={3} />
        ) : storage.isError ? (
          <ErrorState error={storage.error} onRetry={() => void storage.refetch()} />
        ) : (
          <>
            <dl className="grid gap-x-6 gap-y-3 rounded-xl border bg-muted/30 p-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">Original file</dt>
                <dd>{storage.data.file.location}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Type and size</dt>
                <dd>
                  {storage.data.file.mime} · {fmtBytes(storage.data.file.size_bytes)}
                  {storage.data.file.available ? "" : " · file missing"}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs text-muted-foreground">Path</dt>
                <dd className="font-mono text-xs break-all">{storage.data.file.path}</dd>
              </div>
              {storage.data.file.sha256 && (
                <div className="sm:col-span-2">
                  <dt className="text-xs text-muted-foreground">SHA-256</dt>
                  <dd className="font-mono text-xs break-all">{storage.data.file.sha256}</dd>
                </div>
              )}
            </dl>
            {storage.data.tables.map((t) => (
              <details
                key={t.table}
                open={t.row_count > 0 && t.row_count <= 25}
                className={cn("group rounded-xl border", t.row_count === 0 && "text-muted-foreground")}
              >
                <summary className="flex cursor-pointer list-none items-start gap-3 rounded-xl p-3 hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                  <ChevronRight className="mt-0.5 size-4 shrink-0 transition-transform group-open:rotate-90" aria-hidden />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="font-mono text-sm font-semibold">{t.table}</span>
                    <span className="text-xs text-muted-foreground">{t.stores}</span>
                  </span>
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-2 py-0.5 text-xs tabular-nums",
                      t.row_count ? "bg-sky-50 text-sky-900 ring-1 ring-sky-200 ring-inset" : "bg-muted",
                    )}
                  >
                    {t.row_count} {t.row_count === 1 ? "row" : "rows"}
                    {t.truncated ? " (first 200)" : ""}
                  </span>
                </summary>
                {t.row_count > 0 ? (
                  <div className="max-h-[32rem] overflow-auto border-t">
                    <Table>
                      <TableHeader className="sticky top-0 z-10 bg-muted/95 backdrop-blur">
                        <TableRow>
                          {t.columns.map((c) => (
                            <TableHead key={c} className="font-mono text-xs whitespace-nowrap">
                              {c}
                            </TableHead>
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {t.rows.map((row, i) => (
                          <TableRow key={i}>
                            {row.map((value, j) => (
                              <TableCell key={t.columns[j]} className="max-w-[28rem] min-w-24 align-top text-xs break-words whitespace-pre-wrap">
                                <CellValue value={value} />
                              </TableCell>
                            ))}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                ) : (
                  <p className="border-t px-3 py-2 pl-10 text-xs">No rows for this document.</p>
                )}
              </details>
            ))}
          </>
        )}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ page

function DocumentInner() {
  const { sourceId } = useParams<{ sourceId: string }>();
  const initial = useSearchParams().get("locator");
  const [focus, setFocus] = useState<{ locator: string | null; page: number | null }>({ locator: initial, page: null });
  const source = useSource(sourceId);
  const [tab, setTab] = useState<string | null>(initial ? "passages" : null);

  const back = (
    <Link
      href="/documents"
      className="mb-4 inline-flex min-h-11 items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground md:min-h-0"
    >
      <ArrowLeft className="size-4" aria-hidden /> All documents
    </Link>
  );
  if (source.isPending)
    return (
      <>
        {back}
        <LoadingSkeleton variant="detail" rows={2} />
      </>
    );
  if (source.isError)
    return (
      <>
        {back}
        {source.error instanceof ApiError && source.error.status === 404 ? (
          <EmptyState title="Document not available" description={source.error.message} />
        ) : (
          <ErrorState error={source.error} onRetry={() => void source.refetch()} />
        )}
      </>
    );

  const s = source.data;
  const hasSummary = s.type === "diary" || s.type === "minutes" || s.type === "email" || s.type === "daily_report";
  const hasQuantities = s.type === "daily_report" && !USE_FIXTURES;
  const activeTab = tab ?? (hasSummary ? "summary" : hasQuantities ? "quantities" : "passages");
  const focusPage = focus.page ?? s.passages.find((p) => p.locator === focus.locator)?.page ?? null;
  const facts: [string, ReactNode][] = [
    ["Document ID", <span key="id" className="font-mono">{s.id}</span>],
    ["Type", SOURCE_TYPE_LABEL[s.type]],
    ["Received", fmtDateTime(s.available_at)],
    ...(s.pages ? ([["Pages", s.pages]] as [string, ReactNode][]) : []),
    ["Passages", s.passages.length],
    ...(s.summary_version ? ([["Summary", `v${s.summary_version}`]] as [string, ReactNode][]) : []),
  ];

  return (
    <>
      {back}

      {/* Overview */}
      <section className="mb-5 overflow-hidden rounded-2xl border bg-card shadow-xs [overflow-wrap:anywhere]">
        <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start">
          <SourceIcon type={s.type} size="lg" />
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold tracking-tight break-words md:text-2xl">{s.title}</h1>
            <p className="mt-1 truncate text-sm text-muted-foreground">{s.filename}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            <JobStatusBadge status={s.status} />
            <OriginalActions source={s} />
          </div>
        </div>
        <dl className="-mr-px -mb-px flex flex-wrap border-t bg-muted/30">
          {facts.map(([k, v]) => (
            <div key={k} className="flex min-w-0 flex-1 basis-36 flex-col gap-0.5 border-r border-b px-5 py-3">
              <dt className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{k}</dt>
              <dd className="truncate text-sm font-semibold">{v}</dd>
            </div>
          ))}
        </dl>
        {(!!s.review_reasons?.length || s.note) && (
          <div role="status" className="flex gap-2 border-t border-amber-200 bg-amber-50 px-5 py-3 text-sm text-amber-900">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            {s.review_reasons?.length ? (
              <ul className="flex flex-col gap-0.5">
                {s.review_reasons.map((r) => (
                  <li key={r}>Needs review: {r}</li>
                ))}
              </ul>
            ) : (
              <p>{s.note}</p>
            )}
          </div>
        )}
      </section>

      {/* Original | details, same height on large screens */}
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <section
          aria-labelledby="original-title"
          className={cn("flex min-w-0 flex-col overflow-hidden rounded-2xl border bg-card shadow-xs lg:sticky lg:top-20", PANEL)}
        >
          <header className="flex items-center justify-between gap-3 border-b px-5 py-3">
            <h2 id="original-title" className="text-base font-semibold">
              Original
            </h2>
            <p className="min-w-0 truncate text-xs text-muted-foreground">
              {focus.locator ? (
                <>
                  Highlighting <span className="font-mono text-foreground">{focus.locator}</span>
                  {focusPage ? ` · page ${focusPage}` : ""}
                </>
              ) : (
                s.filename
              )}
            </p>
          </header>
          <div className="min-h-0 flex-auto overflow-auto p-4">
            <OriginalEmbed source={s} page={focusPage} locator={focus.locator} passages={s.passages} showActions={false} tall />
          </div>
        </section>

        <Tabs
          value={activeTab}
          onValueChange={setTab}
          className={cn("flex min-w-0 flex-col gap-0 overflow-hidden rounded-2xl border bg-card shadow-xs", PANEL)}
        >
          <div className="border-b px-3 pt-3">
            <TabsList variant="line" className="w-full justify-start gap-0">
              {hasSummary && (
                <TabsTrigger value="summary" className="flex-none px-3 pb-2.5">
                  <Sparkles aria-hidden /> Summary
                </TabsTrigger>
              )}
              {hasQuantities && (
                <TabsTrigger value="quantities" className="flex-none px-3 pb-2.5">
                  <Ruler aria-hidden /> Quantities
                </TabsTrigger>
              )}
              <TabsTrigger value="passages" className="flex-none px-3 pb-2.5">
                <FileSearch aria-hidden /> Passages
                <span className="rounded-full bg-muted px-1.5 text-[11px] tabular-nums">{s.passages.length}</span>
              </TabsTrigger>
            </TabsList>
          </div>
          <div className="min-h-0 flex-auto overflow-x-hidden overflow-y-auto p-5">
            {hasSummary && (
              <TabsContent value="summary">
                <SummaryPanel
                  sourceId={s.id}
                  pending={s.summary_status === "queued" || s.summary_status === "running" || s.status === "extracting"}
                />
              </TabsContent>
            )}
            {hasQuantities && (
              <TabsContent value="quantities">
                <QuantitiesPanel sourceId={s.id} />
              </TabsContent>
            )}
            <TabsContent value="passages">
              <PassagesPanel
                passages={s.passages}
                selected={focus.locator}
                onSelect={(p) => setFocus({ locator: p.locator, page: p.page ?? null })}
              />
            </TabsContent>
          </div>
        </Tabs>
      </div>

      {!USE_FIXTURES && (
        <div className="mt-6">
          <StorageSection sourceId={s.id} />
        </div>
      )}
    </>
  );
}

export default function DocumentPage() {
  return (
    <Suspense fallback={<LoadingSkeleton variant="detail" rows={2} />}>
      <DocumentInner />
    </Suspense>
  );
}
