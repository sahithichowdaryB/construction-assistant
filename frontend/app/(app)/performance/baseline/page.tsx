"use client";

import { AlertOctagon, AlertTriangle, CheckCircle2, FileUp, Loader2, Pencil } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { CitationList } from "@/components/citation-chip";
import { DisclaimerBanner } from "@/components/disclaimer-banner";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  toRefs,
  useActivateBaseline,
  useBaseline,
  useBaselines,
  usePatchBaseline,
  useUploadBaseline,
  type Baseline,
  type BaselineSummary,
  type ExtractedActivity,
} from "@/lib/performance";
import { fmtDateTime } from "@/lib/time";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<BaselineSummary["extraction_status"], string> = {
  queued: "Waiting to read", running: "Reading the plan…", done: "Ready to review", needs_review: "Check the review notes", failed: "Extraction failed",
};

function Upload() {
  const upload = useUploadBaseline();
  const [files, setFiles] = useState<File[]>([]);
  const [title, setTitle] = useState("");
  return (
    <form className="flex flex-col gap-3 rounded-[22px] bg-card p-5 md:p-6"
          onSubmit={(e) => { e.preventDefault(); upload.mutate({ files, title }, { onSuccess: () => { setFiles([]); setTitle(""); } }); }}>
      <h2 className="flex items-center gap-2 text-base font-bold"><FileUp className="size-4" aria-hidden /> Upload the plan</h2>
      <p className="text-sm text-muted-foreground">
        One or more files that together make the plan: programme (Gantt, activity table), resource / cost / contract plan, or a
        schedule CSV. PDF, Word, CSV or text. SiteMate reads them, cites every value, and waits for you to check and activate.
      </p>
      <Input type="file" multiple accept=".pdf,.docx,.csv,.txt,.md" aria-label="Plan files"
             onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
      <Input placeholder="Name (optional), e.g. Baseline Rev C" value={title} onChange={(e) => setTitle(e.target.value)} />
      {files.length > 0 && <p className="text-xs text-muted-foreground">{files.map((f) => f.name).join(" · ")}</p>}
      <Button type="submit" className="self-start" disabled={!files.length || upload.isPending}>
        {upload.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <FileUp aria-hidden />} Upload and read
      </Button>
      {upload.isError && <p className="text-sm text-red-700">{(upload.error as Error).message}</p>}
    </form>
  );
}

function Reasons({ b }: { b: Baseline }) {
  if (!b.review_reasons.length) return <p className="flex items-center gap-2 text-sm text-emerald-800"><CheckCircle2 className="size-4" aria-hidden /> All checks passed.</p>;
  const sorted = [...b.review_reasons].sort((x, y) => (x.severity === "blocking" ? -1 : 0) - (y.severity === "blocking" ? -1 : 0));
  return (
    <ul className="flex flex-col gap-1.5">
      {sorted.map((r, i) => (
        <li key={i} className={cn("flex items-start gap-2 rounded-xl px-3 py-2 text-sm", r.severity === "blocking" ? "bg-red-50 text-red-900" : "bg-amber-50 text-amber-950")}>
          {r.severity === "blocking" ? <AlertOctagon className="mt-0.5 size-4 shrink-0" aria-hidden /> : <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />}
          <span className="min-w-0"><span className="font-mono text-xs font-semibold">{r.subject}</span> {r.message} <CitationList refs={toRefs(r.refs)} /></span>
        </li>
      ))}
    </ul>
  );
}

const FIELDS: { key: keyof ExtractedActivity; label: string; type: "text" | "date" | "number" }[] = [
  { key: "name", label: "Activity", type: "text" },
  { key: "planned_start", label: "Start", type: "date" },
  { key: "planned_finish", label: "Finish", type: "date" },
  { key: "duration_wd", label: "Dur. (wd)", type: "number" },
  { key: "planned_total", label: "Total", type: "number" },
  { key: "unit", label: "Unit", type: "text" },
  { key: "target_per_day", label: "Target/day", type: "number" },
  { key: "weight_pct", label: "Weight %", type: "number" },
];

function RowEditor({ a, onSave, saving }: { a: ExtractedActivity; onSave: (patch: Partial<ExtractedActivity>) => void; saving: boolean }) {
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(FIELDS.map((f) => [f.key, a[f.key] == null ? "" : String(a[f.key])])));
  return (
    <form className="grid grid-cols-2 gap-2 sm:grid-cols-4" onSubmit={(e) => {
      e.preventDefault();
      const patch: Record<string, unknown> = { code: a.code };
      for (const f of FIELDS) {
        const before = a[f.key] == null ? "" : String(a[f.key]);
        if (draft[f.key] !== before) patch[f.key] = draft[f.key] === "" ? null : f.type === "number" ? Number(draft[f.key]) : draft[f.key];
      }
      onSave(patch as Partial<ExtractedActivity>);
    }}>
      {FIELDS.map((f) => (
        <label key={f.key} className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          {f.label}
          <Input type={f.type} step="any" value={draft[f.key]} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />
        </label>
      ))}
      <Button size="sm" type="submit" disabled={saving} className="col-span-2 self-end sm:col-span-1">Save row</Button>
    </form>
  );
}

function Activities({ b }: { b: Baseline }) {
  const patch = usePatchBaseline(b.id);
  const [editing, setEditing] = useState<string | null>(null);
  const draft = b.status === "draft";
  const acts = b.extracted.activities;
  return (
    <section className="rounded-[22px] bg-card p-5 md:p-6" aria-label="Extracted activities">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-bold">Activities ({acts.length})</h2>
        <p className="text-xs text-muted-foreground">Weights total {b.weights_total}% · tap a source to see the page it came from</p>
      </div>
      <ul className="mt-3 flex flex-col divide-y">
        {acts.map((a) => (
          <li key={a.code} className="flex flex-col gap-2 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="min-w-0 text-sm">
                <span className="font-mono text-xs font-semibold">{a.code}</span> <span className="font-medium">{a.name}</span>
                {a.is_critical && <span className="ml-1 rounded bg-primary px-1 text-[10px] font-semibold text-primary-foreground">critical</span>}
              </p>
              <div className="flex items-center gap-2">
                <CitationList refs={toRefs(a.refs)} />
                {draft && <Button size="sm" variant="ghost" aria-label={`Edit ${a.code}`} onClick={() => setEditing(editing === a.code ? null : a.code)}><Pencil aria-hidden /></Button>}
              </div>
            </div>
            <p className="text-xs text-muted-foreground tabular">
              {a.planned_start ?? "?"} → {a.planned_finish ?? "?"} · {a.duration_wd ?? "?"} wd · {a.planned_total ?? "?"} {a.unit ?? ""} ·
              {" "}{a.target_per_day ?? "?"}/day · weight {a.weight_pct ?? "–"}% · after {a.predecessors.join(", ") || "–"}
            </p>
            {(a.missing.length > 0 || a.derived.length > 0 || (a.manager_fields?.length ?? 0) > 0) && (
              <p className="text-xs">
                {a.missing.length > 0 && <span className="mr-2 text-red-700">missing: {a.missing.join(", ")}</span>}
                {a.derived.length > 0 && <span className="mr-2 text-muted-foreground">computed: {a.derived.join(", ")}</span>}
                {(a.manager_fields?.length ?? 0) > 0 && <span className="text-sky-800">edited by you: {a.manager_fields!.join(", ")}</span>}
              </p>
            )}
            {editing === a.code && <RowEditor a={a} saving={patch.isPending}
              onSave={(p) => patch.mutate({ activities: [p] }, { onSuccess: () => setEditing(null) })} />}
          </li>
        ))}
      </ul>
      {patch.isError && <p className="text-sm text-red-700">{(patch.error as Error).message}</p>}
    </section>
  );
}

function Detail({ id }: { id: string }) {
  const q = useBaseline(id);
  const activate = useActivateBaseline(id);
  const [normalize, setNormalize] = useState(false);
  if (q.isPending) return <LoadingSkeleton variant="detail" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const b = q.data;
  const running = ["queued", "running"].includes(b.extraction_status);
  const settings = b.settings_preview as { thresholds?: Record<string, unknown>; notice_rules?: { type: string; deadline_wd?: number | null; immediate?: boolean }[];
    rates?: { equipment?: { item: string; amount: number; currency?: string; per?: string }[] } };
  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-3 rounded-[22px] bg-card p-5 md:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-bold">Revision {b.revision}{b.title ? ` · ${b.title}` : ""}</h2>
          <span className="text-sm text-muted-foreground">{b.status} · {STATUS_LABEL[b.extraction_status]}</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Files: {b.sources.map((s) => s.title ?? s.id).join(" · ")}{b.model ? ` · read by ${b.model}` : ""}
          {b.activated_at ? ` · activated ${fmtDateTime(b.activated_at)}` : ""}
        </p>
        {running && <p className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin" aria-hidden /> Reading the plan. This can take a minute.</p>}
        {b.error && <p className="text-sm text-red-700">{b.error}</p>}
        {!running && <Reasons b={b} />}
        {!running && b.extracted.missing.length > 0 && (
          <p className="text-xs text-muted-foreground">Not stated in the documents: {b.extracted.missing.join(" · ")}</p>
        )}
        {b.status === "draft" && !running && (
          <div className="flex flex-wrap items-center gap-3 border-t pt-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={normalize} onChange={(e) => setNormalize(e.target.checked)} /> Normalise weights to 100%
            </label>
            <Button disabled={b.blocking > 0 || activate.isPending || !b.extracted.activities.length}
                    onClick={() => activate.mutate({ normalize_weights: normalize })}>
              <CheckCircle2 aria-hidden /> Activate this baseline
            </Button>
            {b.blocking > 0 && <span className="text-xs text-red-700">Fix {b.blocking} blocking item{b.blocking === 1 ? "" : "s"} first.</span>}
            {activate.isError && <span className="text-sm text-red-700">{(activate.error as Error).message}</span>}
            {activate.isSuccess && <span className="text-sm text-emerald-800">Active. Daily evaluations now use this plan. <Link className="underline" href="/performance">Open performance</Link></span>}
          </div>
        )}
      </section>
      {!running && (
        <>
          <Activities b={b} />
          {b.extracted.milestones.length > 0 && (
            <section className="rounded-[22px] bg-card p-5 md:p-6">
              <h2 className="text-base font-bold">Milestones ({b.extracted.milestones.length})</h2>
              <ul className="mt-2 flex flex-col divide-y">
                {b.extracted.milestones.map((m) => (
                  <li key={m.code} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                    <span><span className="font-mono text-xs font-semibold">{m.code}</span> {m.name} · {m.planned_date ?? "no date"}{m.contractual ? " · contractual" : ""}</span>
                    <CitationList refs={toRefs(m.refs)} />
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section className="rounded-[22px] bg-card p-5 text-sm md:p-6">
            <h2 className="text-base font-bold">Rules found in the plan</h2>
            <p className="mt-2"><span className="font-semibold">Thresholds:</span> {JSON.stringify(settings.thresholds ?? {})}</p>
            <p className="mt-1"><span className="font-semibold">Notice periods:</span>{" "}
              {(settings.notice_rules ?? []).map((r) => `${r.type.replaceAll("_", " ")} ${r.deadline_wd != null ? `${r.deadline_wd} wd` : r.immediate ? "immediately" : "–"}`).join(" · ") || "none (defaults apply)"}</p>
            <p className="mt-1"><span className="font-semibold">Rates:</span>{" "}
              {(settings.rates?.equipment ?? []).map((r) => `${r.item} ${r.amount} ${r.currency ?? ""}/${r.per}`).join(" · ") || "none"}</p>
          </section>
        </>
      )}
    </div>
  );
}

export default function BaselinePage() {
  const list = useBaselines();
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    if (!selected && list.data?.baselines.length) setSelected(list.data.baselines[0].id);
  }, [list.data, selected]);
  return (
    <>
      <PageHeader title="Plans and baseline" description="The plan the project must follow. Upload it, check what was read, then activate it." />
      <div className="flex flex-col gap-5">
        <DisclaimerBanner text="Drafting support only — not legal advice. Final review lies with the site manager/company." />
        <Upload />
        {list.isPending ? <LoadingSkeleton rows={2} /> : list.isError ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> :
          !list.data.baselines.length ? <EmptyState title="No plan yet" description="Upload the programme to start measuring performance." /> : (
            <>
              <div className="flex flex-wrap gap-2" role="tablist" aria-label="Baseline revisions">
                {list.data.baselines.map((b) => (
                  <button key={b.id} type="button" role="tab" aria-selected={selected === b.id} onClick={() => setSelected(b.id)}
                          className={cn("rounded-xl border px-3 py-2 text-left text-sm", selected === b.id ? "bg-secondary font-semibold" : "bg-card hover:bg-muted")}>
                    Rev {b.revision} · {b.status}{b.id === list.data.active_id ? " (in force)" : ""}
                    <span className="block text-xs font-normal text-muted-foreground">{b.counts.activities ?? 0} activities · {STATUS_LABEL[b.extraction_status]}</span>
                  </button>
                ))}
              </div>
              {selected && <Detail id={selected} />}
            </>
          )}
      </div>
    </>
  );
}
