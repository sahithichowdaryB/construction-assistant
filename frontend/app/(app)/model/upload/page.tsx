"use client";

import { AlertOctagon, AlertTriangle, ArrowLeft, CheckCircle2, FileUp, Loader2, RefreshCw, Rocket } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CitationList } from "@/components/citation-chip";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api";
import {
  activityColour,
  EXTRACTION_LABEL,
  useActivateModel,
  useModelDetail,
  useModels,
  usePatchModel,
  useRetryExtraction,
  useUploadModel,
  type ModelDetail,
  type ModelSummary,
} from "@/lib/model3d";
import { toRefs } from "@/lib/performance";
import { fmtDateTime, fmtLocalDate } from "@/lib/time";
import { cn } from "@/lib/utils";

const BuildingViewer = dynamic(() => import("@/components/model3d/building-viewer").then((m) => m.BuildingViewer), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading 3D preview…</div>,
});

function Upload({ onUploaded }: { onUploaded: (id: string) => void }) {
  const upload = useUploadModel();
  const [files, setFiles] = useState<File[]>([]);
  const [deadline, setDeadline] = useState("");
  const [title, setTitle] = useState("");
  return (
    <form className="flex flex-col gap-3 rounded-[22px] bg-card p-5 md:p-6"
          onSubmit={(e) => {
            e.preventDefault();
            upload.mutate({ files, deadline, title }, { onSuccess: (m) => { setFiles([]); setTitle(""); onUploaded(m.id); } });
          }}>
      <h2 className="flex items-center gap-2 text-base font-bold"><FileUp className="size-4" aria-hidden /> Upload the 2D drawings</h2>
      <p className="text-sm text-muted-foreground">
        Structural general-arrangement drawings as PDF: plans, sections and the schedules (elements, pours, quantities).
        SiteMate reads the grid, levels, elements and pours, cites every value, and builds the 3D model after you check it.
      </p>
      <Input type="file" multiple accept=".pdf,application/pdf" aria-label="Drawing files" onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm font-medium">
          Deadline (required)
          <Input type="date" required value={deadline} onChange={(e) => setDeadline(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Name (optional)
          <Input placeholder="e.g. Block B structure Rev C1" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
      </div>
      {files.length > 0 && <p className="text-xs text-muted-foreground">{files.map((f) => f.name).join(" · ")}</p>}
      <Button type="submit" className="self-start" disabled={!files.length || !deadline || upload.isPending}>
        {upload.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <FileUp aria-hidden />} Upload and read
      </Button>
      {upload.isError && <p className="text-sm text-red-700">{(upload.error as Error).message}</p>}
    </form>
  );
}

function StatusChip({ m }: { m: ModelSummary }) {
  if (m.status !== "draft") {
    return <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", m.status === "active" ? "bg-emerald-100 text-emerald-900" : "bg-muted text-muted-foreground")}>{m.status}</span>;
  }
  const busy = m.extraction_status === "queued" || m.extraction_status === "running";
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold",
                        m.extraction_status === "failed" ? "bg-red-100 text-red-900" : m.blocking ? "bg-amber-100 text-amber-950" : "bg-sky-100 text-sky-900")}>
      {busy && <Loader2 className="size-3 animate-spin" aria-hidden />} draft · {EXTRACTION_LABEL[m.extraction_status]}
    </span>
  );
}

function Reasons({ m }: { m: ModelDetail }) {
  if (!m.review_reasons.length) return <p className="flex items-center gap-2 text-sm text-emerald-800"><CheckCircle2 className="size-4" aria-hidden /> All checks passed.</p>;
  const sorted = [...m.review_reasons].sort((a, b) => (a.severity === "blocking" ? -1 : 0) - (b.severity === "blocking" ? -1 : 0));
  return (
    <ul className="flex flex-col gap-1.5">
      {sorted.map((r, i) => (
        <li key={i} className={cn("flex items-start gap-2 rounded-xl px-3 py-2 text-sm", r.severity === "blocking" ? "bg-red-50 text-red-900" : "bg-amber-50 text-amber-950")}>
          {r.severity === "blocking" ? <AlertOctagon className="mt-0.5 size-4 shrink-0" aria-hidden /> : <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />}
          <span className="min-w-0"><span className="font-mono text-xs font-semibold">{r.subject}</span> {r.message} {r.refs.length > 0 && <CitationList refs={toRefs(r.refs)} />}</span>
        </li>
      ))}
    </ul>
  );
}

function SpecEditor({ m }: { m: ModelDetail }) {
  const patch = usePatchModel(m.id);
  const [textValue, setText] = useState(() => JSON.stringify(m.spec, null, 2));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(JSON.stringify(m.spec, null, 2)), [m.spec]);
  return (
    <details className="rounded-[22px] bg-card p-5 md:p-6">
      <summary className="cursor-pointer text-base font-bold">Edit the building spec (advanced)</summary>
      <p className="mt-2 text-sm text-muted-foreground">
        Fix a value SiteMate read wrongly: grid (mm), levels (top of slab and thickness in mm, activity), columns and walls (grid points,
        storeys), pours (activity, kind, grid range, m³, planned date). Saving checks it again and rebuilds the preview.
      </p>
      <Textarea className="mt-3 h-80 font-mono text-xs" value={textValue} onChange={(e) => setText(e.target.value)} aria-label="Building spec JSON" />
      <div className="mt-2 flex items-center gap-3">
        <Button size="sm" disabled={patch.isPending} onClick={() => {
          try {
            const spec = JSON.parse(textValue);
            setError(null);
            patch.mutate({ spec });
          } catch (e) {
            setError(`Not valid JSON: ${(e as Error).message}`);
          }
        }}>{patch.isPending && <Loader2 className="animate-spin" aria-hidden />} Save and check</Button>
        {(error || patch.isError) && <p className="text-sm text-red-700">{error ?? (patch.error as Error).message}</p>}
      </div>
    </details>
  );
}

function Review({ id }: { id: string }) {
  const q = useModelDetail(id);
  const activate = useActivateModel(id);
  const retry = useRetryExtraction(id);
  const patch = usePatchModel(id);
  const [deadline, setDeadline] = useState("");
  useEffect(() => setDeadline(q.data?.deadline ?? ""), [q.data?.deadline]);
  const order = useMemo(() => (q.data?.levels ?? []).map((l) => l.activity), [q.data?.levels]);
  const colours = useMemo(() => Object.fromEntries(order.map((c) => [c, activityColour(c, order)])), [order]);
  if (q.isPending) return <LoadingSkeleton variant="detail" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const m = q.data;
  const draft = m.status === "draft";
  const busy = m.extraction_status === "queued" || m.extraction_status === "running";
  const hint = m.deadline_hint?.date;
  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-3 rounded-[22px] bg-card p-5 md:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-bold">{m.title ?? "Drawings"} <span className="text-sm font-normal text-muted-foreground">rev {m.revision}</span></h2>
            <p className="text-xs text-muted-foreground">
              Uploaded {fmtDateTime(m.created_at)} · {m.counts.levels ?? 0} levels · {m.counts.columns ?? 0} column types · {m.counts.walls ?? 0} walls ·
              {" "}{m.counts.pours ?? 0} pours{m.model ? ` · read by ${m.model}` : ""}
            </p>
            {m.sources.length > 0 && <div className="mt-1"><CitationList refs={toRefs(m.sources.map((s) => s.id))} /></div>}
          </div>
          <StatusChip m={m} />
        </div>
        {busy && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden /> Reading the drawings. This takes about a minute.</p>}
        {m.extraction_status === "failed" && (
          <div className="flex flex-wrap items-center gap-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-900">
            <span className="min-w-0 flex-1">{m.error}</span>
            <Button size="sm" variant="secondary" disabled={retry.isPending} onClick={() => retry.mutate()}><RefreshCw aria-hidden /> Read again</Button>
          </div>
        )}
        {!busy && <Reasons m={m} />}
        {draft && (
          <div className="flex flex-wrap items-end gap-3 border-t pt-3">
            <label className="flex flex-col gap-1 text-sm font-medium">
              Deadline
              <Input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
            </label>
            <Button size="sm" variant="secondary" disabled={!deadline || deadline === m.deadline || patch.isPending}
                    onClick={() => patch.mutate({ deadline })}>Save deadline</Button>
            {hint && hint !== deadline && (
              <Button size="sm" variant="ghost" onClick={() => setDeadline(hint)}>
                Use {m.deadline_hint?.label || "the drawings' date"} ({fmtLocalDate(hint)})
              </Button>
            )}
            <div className="flex-1" />
            <Button disabled={busy || m.blocking > 0 || !m.deadline || activate.isPending || m.elements.length === 0}
                    onClick={() => activate.mutate()}>
              {activate.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Rocket aria-hidden />} Activate 3D model
            </Button>
          </div>
        )}
        {activate.isError && <p className="text-sm text-red-700">{(activate.error as Error).message}</p>}
        {activate.isSuccess && (
          <p className="flex items-center gap-2 text-sm text-emerald-800"><CheckCircle2 className="size-4" aria-hidden /> Activated.
            <Link className="font-semibold underline" href="/model">Open the 3D progress view</Link></p>
        )}
        {!draft && <p className="text-sm text-muted-foreground">Deadline {fmtLocalDate(m.deadline)}. To change the drawings or the deadline, upload a new revision.</p>}
      </section>

      {m.elements.length > 0 && (
        <section className="flex flex-col gap-3 rounded-[22px] bg-card p-4 md:p-5" aria-label="3D preview">
          <h2 className="text-base font-bold">3D preview ({m.elements.length} elements)</h2>
          <BuildingViewer preview className="h-[340px] w-full overflow-hidden rounded-2xl bg-gradient-to-b from-sky-50 to-white md:h-[440px] dark:from-slate-900 dark:to-slate-950"
                          elements={m.elements} states={{}} mode="planned" colours={colours} />
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {order.map((c) => (
              <span key={c} className="inline-flex items-center gap-1.5"><span className="size-3 rounded-sm" style={{ background: colours[c] }} />{c} {m.activities.find((a) => a.code === c)?.name ?? ""}</span>
            ))}
          </div>
        </section>
      )}

      {m.levels.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="rounded-[22px] bg-card p-5 md:p-6" aria-label="Levels">
            <h2 className="text-base font-bold">Levels ({m.levels.length})</h2>
            <ul className="mt-2 flex flex-col divide-y text-sm">
              {[...m.levels].reverse().map((l) => (
                <li key={l.name} className="flex justify-between gap-2 py-2">
                  <span><span className="font-semibold">{l.name}</span> <span className="font-mono text-xs text-muted-foreground">{l.activity}</span></span>
                  <span className="text-xs text-muted-foreground tabular">top {(l.tos / 1000).toFixed(2)} m · slab {l.thickness} mm</span>
                </li>
              ))}
            </ul>
          </section>
          <section className="rounded-[22px] bg-card p-5 md:p-6" aria-label="Pours">
            <h2 className="text-base font-bold">Pours ({m.pours.length})</h2>
            <ul className="mt-2 flex max-h-96 flex-col divide-y overflow-y-auto text-sm">
              {m.pours.map((p) => (
                <li key={p.id} className="flex justify-between gap-2 py-2">
                  <span className="font-mono text-xs font-semibold">{p.id}</span>
                  <span className="text-xs text-muted-foreground tabular">{p.kind} · {p.m3} m³ · {fmtLocalDate(p.planned)}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
      {draft && !busy && <SpecEditor m={m} />}
    </div>
  );
}

export default function ModelUploadPage() {
  const list = useModels();
  const [selected, setSelected] = useState<string | null>(null);
  const models = list.data?.models ?? [];
  const current = selected ?? models.find((m) => m.status === "draft")?.id ?? list.data?.active_id ?? models[0]?.id ?? null;
  const notInstalled = list.error instanceof ApiError && list.error.status === 503;
  return (
    <>
      <PageHeader title="Drawings & deadline"
                  description="Upload the 2D structural drawings and the deadline. The 3D progress model is built from them."
                  actions={<Button asChild variant="ghost" size="sm"><Link href="/model"><ArrowLeft aria-hidden /> 3D progress</Link></Button>} />
      <div className="flex flex-col gap-4">
        {notInstalled ? (
          <EmptyState title="3D model not installed on the server" description={(list.error as Error).message} />
        ) : (
          <>
            <Upload onUploaded={setSelected} />
            {list.isPending ? <LoadingSkeleton /> : list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : models.length > 0 && (
              <section className="rounded-[22px] bg-card p-5 md:p-6" aria-label="Revisions">
                <h2 className="text-base font-bold">Revisions</h2>
                <ul className="mt-2 flex flex-col divide-y">
                  {models.map((m) => (
                    <li key={m.id}>
                      <button onClick={() => setSelected(m.id)} aria-current={m.id === current ? "true" : undefined}
                              className={cn("flex w-full flex-wrap items-center justify-between gap-2 rounded-xl px-2 py-2.5 text-left text-sm",
                                            m.id === current ? "bg-muted" : "hover:bg-muted/60")}>
                        <span><span className="font-semibold">rev {m.revision}</span> {m.title} <span className="text-xs text-muted-foreground">· deadline {fmtLocalDate(m.deadline)}</span></span>
                        <StatusChip m={m} />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {current && <Review key={current} id={current} />}
          </>
        )}
      </div>
    </>
  );
}
