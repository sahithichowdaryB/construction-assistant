"use client";

import { AlertTriangle, CheckCircle2, Loader2, Pencil, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CitationList } from "@/components/citation-chip";
import { GatedButton } from "@/components/gated-button";
import { useApp } from "@/components/providers/app-context";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  toRefs,
  useActivateBaseline,
  useBaseline,
  useBaselines,
  usePatchBaseline,
  useUploadBaseline,
  type ExtractedActivity,
} from "@/lib/performance";
import { denyReason } from "@/lib/roles";
import { fmtDateTime, fmtLocalDate } from "@/lib/time";
import { cn } from "@/lib/utils";

const STATUS_TONE: Record<string, string> = {
  active: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  draft: "bg-amber-50 text-amber-900 ring-amber-200",
  superseded: "bg-muted text-muted-foreground ring-border",
};

function EditRow({ a, baselineId, onDone }: { a: ExtractedActivity; baselineId: string; onDone: () => void }) {
  const patch = usePatchBaseline(baselineId);
  const [v, setV] = useState({
    planned_start: a.planned_start ?? "",
    planned_finish: a.planned_finish ?? "",
    planned_total: a.planned_total?.toString() ?? "",
    target_per_day: a.target_per_day?.toString() ?? "",
    weight_pct: a.weight_pct?.toString() ?? "",
  });
  const num = (x: string) => (x.trim() === "" ? null : Number(x));
  return (
    <TableRow>
      <TableCell className="font-mono text-xs">{a.code}</TableCell>
      <TableCell colSpan={6}>
        <form
          className="grid gap-2 sm:grid-cols-5"
          onSubmit={(e) => {
            e.preventDefault();
            patch.mutate(
              { activities: [{ code: a.code, planned_start: v.planned_start || null, planned_finish: v.planned_finish || null,
                               planned_total: num(v.planned_total), target_per_day: num(v.target_per_day), weight_pct: num(v.weight_pct) }] },
              { onSuccess: onDone },
            );
          }}
        >
          <Input type="date" aria-label="Start" value={v.planned_start} onChange={(e) => setV({ ...v, planned_start: e.target.value })} />
          <Input type="date" aria-label="Finish" value={v.planned_finish} onChange={(e) => setV({ ...v, planned_finish: e.target.value })} />
          <Input inputMode="decimal" aria-label="Total" placeholder="Total" value={v.planned_total} onChange={(e) => setV({ ...v, planned_total: e.target.value })} />
          <Input inputMode="decimal" aria-label="Per day" placeholder="Per day" value={v.target_per_day} onChange={(e) => setV({ ...v, target_per_day: e.target.value })} />
          <Input inputMode="decimal" aria-label="Weight %" placeholder="Weight %" value={v.weight_pct} onChange={(e) => setV({ ...v, weight_pct: e.target.value })} />
          <div className="flex gap-2 sm:col-span-5">
            <Button type="submit" size="sm" disabled={patch.isPending}>Save row</Button>
            <Button type="button" size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
            {patch.isError && <span className="text-xs text-red-800">{patch.error.message}</span>}
          </div>
        </form>
      </TableCell>
    </TableRow>
  );
}

function Detail({ id }: { id: string }) {
  const { role } = useApp();
  const b = useBaseline(id);
  const activate = useActivateBaseline(id);
  const [normalize, setNormalize] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  if (b.isPending) return <LoadingSkeleton rows={3} />;
  if (b.isError) return <ErrorState error={b.error} onRetry={() => void b.refetch()} />;
  const d = b.data;
  const running = ["queued", "running"].includes(d.extraction_status);
  const blocking = d.review_reasons.filter((r) => r.severity === "blocking");
  const deny = denyReason(role, "manage_baseline");
  const draft = d.status === "draft";
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold">Revision {d.revision}{d.title ? ` · ${d.title}` : ""}</span>
        <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset", STATUS_TONE[d.status])}>{d.status}</span>
        <span className="text-xs text-muted-foreground">
          {d.counts.activities ?? 0} activities · {d.counts.milestones ?? 0} milestones · weights {d.weights_total}% · from {d.sources.map((s) => s.filename ?? s.id).join(", ")}
        </span>
      </div>
      {running && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden /> Reading the plan…</p>}
      {d.extraction_status === "failed" && <p className="text-sm text-red-800">Extraction failed: {d.error}</p>}
      {!!d.review_reasons.length && (
        <ul className="flex flex-col gap-1.5 rounded-xl border border-amber-200 bg-amber-50/60 p-3 text-sm">
          {d.review_reasons.map((r, i) => (
            <li key={i} className={cn("flex gap-2", r.severity === "blocking" ? "text-red-900" : "text-amber-900")}>
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span><strong>{r.subject}</strong>: {r.message} {!!r.refs.length && <CitationList className="mt-0.5" refs={toRefs(r.refs)} />}</span>
            </li>
          ))}
        </ul>
      )}
      {d.extracted.activities.length ? (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Activity</TableHead>
                <TableHead>Start – finish</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Per day</TableHead>
                <TableHead className="text-right">Weight</TableHead>
                <TableHead>Source</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.extracted.activities.map((a) =>
                editing === a.code ? (
                  <EditRow key={a.code} a={a} baselineId={id} onDone={() => setEditing(null)} />
                ) : (
                  <TableRow key={a.code}>
                    <TableCell className="font-mono text-xs">
                      {a.code}{a.is_critical ? <span className="ml-1 text-[10px] font-semibold text-red-700">crit</span> : null}
                    </TableCell>
                    <TableCell className="min-w-36">
                      {a.name}
                      {!!a.missing.length && <p className="text-xs text-amber-800">missing: {a.missing.join(", ")}</p>}
                      {!!a.manager_fields?.length && <p className="text-xs text-sky-800">edited: {a.manager_fields.join(", ")}</p>}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {a.planned_start ? fmtLocalDate(a.planned_start) : "–"} – {a.planned_finish ? fmtLocalDate(a.planned_finish) : "–"}
                    </TableCell>
                    <TableCell className="text-right tabular">{a.planned_total ?? "–"} {a.unit ?? ""}</TableCell>
                    <TableCell className="text-right tabular">{a.target_per_day ?? "–"}</TableCell>
                    <TableCell className="text-right tabular">{a.weight_pct ?? "–"}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <CitationList refs={toRefs(a.refs)} />
                        {draft && (
                          <GatedButton reason={deny} size="sm" variant="ghost" aria-label={`Edit ${a.code}`} onClick={() => setEditing(a.code)}>
                            <Pencil aria-hidden />
                          </GatedButton>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ),
              )}
            </TableBody>
          </Table>
        </div>
      ) : (
        !running && <EmptyState title="No activities were read" description="Check the review reasons, or upload the programme table as CSV." />
      )}
      {draft && !running && (
        <div className="flex flex-col gap-2 rounded-xl border bg-muted/30 p-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={normalize} onChange={(e) => setNormalize(e.target.checked)} />
            Scale the weights so they add up to 100%
          </label>
          <GatedButton
            reason={deny ?? (blocking.length ? `Fix ${blocking.length} blocking reason${blocking.length === 1 ? "" : "s"} first.` : null)}
            size="sm"
            className="self-start"
            disabled={activate.isPending}
            onClick={() => activate.mutate({ normalize_weights: normalize })}
          >
            <CheckCircle2 aria-hidden /> {activate.isPending ? "Activating…" : "Activate this baseline"}
          </GatedButton>
          <p className="text-xs text-muted-foreground">Activation replaces the current baseline from today. Earlier results stay as they were.</p>
          {activate.isError && <p className="text-sm text-red-800">{activate.error.message}</p>}
          {activate.isSuccess && <p className="text-sm text-emerald-800">Active: daily targets were written for {String(activate.data.activities)} activities.</p>}
        </div>
      )}
    </div>
  );
}

/** Upload a programme (PDF or CSV), review what was read against the original, fix rows, then activate. */
export function BaselineManager() {
  const { role } = useApp();
  const list = useBaselines();
  const upload = useUploadBaseline();
  const ref = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    if (!selected && list.data?.baselines.length) setSelected(list.data.baselines.find((b) => b.status === "draft")?.id ?? list.data.baselines[0].id);
  }, [list.data, selected]);
  return (
    <section className="flex flex-col gap-4 rounded-[22px] bg-card p-5 md:p-6" aria-labelledby="baseline-title">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="baseline-title" className="text-base font-bold">Baseline</h2>
          <p className="text-sm text-muted-foreground">The plan performance is measured against. Nothing becomes active until a manager activates it.</p>
        </div>
        <input ref={ref} type="file" multiple accept=".pdf,.csv,.docx,.txt,.md" className="hidden" aria-label="Upload plan files for a new baseline"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length) upload.mutate({ files }, { onSuccess: (b) => setSelected(b.id) });
            e.target.value = "";
          }} />
        <GatedButton reason={denyReason(role, "manage_baseline")} size="sm" disabled={upload.isPending} onClick={() => ref.current?.click()}>
          {upload.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Upload aria-hidden />} New baseline from files
        </GatedButton>
      </div>
      {upload.isError && <p className="text-sm text-red-800">{upload.error.message}</p>}
      {list.isPending ? <LoadingSkeleton rows={2} /> : list.isError ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : (
        <>
          {list.data.baselines.length ? (
            <div className="flex flex-wrap gap-2" role="tablist" aria-label="Baselines">
              {list.data.baselines.map((b) => (
                <button key={b.id} type="button" role="tab" aria-selected={selected === b.id} onClick={() => setSelected(b.id)}
                  className={cn("rounded-xl border px-3 py-2 text-left text-sm", selected === b.id ? "bg-secondary font-semibold" : "hover:bg-muted")}>
                  Rev {b.revision} · {b.status}
                  <span className="block text-xs font-normal text-muted-foreground">{fmtDateTime(b.created_at)}{b.blocking ? ` · ${b.blocking} blocking` : ""}</span>
                </button>
              ))}
            </div>
          ) : (
            <EmptyState title="No baseline yet" description="Upload the programme (and the resource and contract plan) to start." />
          )}
          {selected && <Detail key={selected} id={selected} />}
        </>
      )}
    </section>
  );
}
