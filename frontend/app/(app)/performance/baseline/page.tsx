"use client";

import { ExternalLink, FileText, Layers, Loader2, Sparkles, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { BaselineManager } from "@/components/performance/baseline-review";
import { PerfTabs } from "@/components/performance/perf-tabs";
import { GatedButton } from "@/components/gated-button";
import { useApp } from "@/components/providers/app-context";
import { denyReason } from "@/lib/roles";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { planFileUrl, planPageUrl, usePlans, usePlanSummary, useUploadPlan } from "@/lib/performance";
import { cn } from "@/lib/utils";

function Bullets({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <h3 className="text-sm font-semibold">{title}</h3>
      <ul className="mt-1 flex list-disc flex-col gap-1 pl-5 text-sm">{items.map((t, i) => <li key={i}>{t}</li>)}</ul>
    </div>
  );
}

/** A picture (or the whole PDF) shown in a popup over the page. */
function Popup({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode }) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="flex h-[88vh] max-w-[calc(100%-2rem)] flex-col sm:max-w-5xl">
        <DialogTitle className="pr-10">{title}</DialogTitle>
        <div className="relative min-h-0 flex-1 overflow-auto rounded-lg border bg-muted">{children}</div>
      </DialogContent>
    </Dialog>
  );
}

function PdfFrame({ src, title }: { src: string; title: string }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <>
      {!loaded && <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden /> Opening the plan…</div>}
      <iframe title={title} src={src} className="size-full" onLoad={() => setLoaded(true)} />
    </>
  );
}

function Summary({ id, title, onSelect }: { id: string; title: string; onSelect: (id: string) => void }) {
  const { projectId } = useApp();
  const q = usePlanSummary(id);
  const [viewer, setViewer] = useState<"pdf" | number | null>(null);
  const pages = q.data?.key_pages ?? [];
  const isAll = id === "all";
  return (
    <section className="flex flex-col gap-4 rounded-[22px] bg-card p-5 md:p-6" aria-label="Plan summary">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-base font-bold"><Sparkles className="size-4 text-warning" aria-hidden /> {title}</h2>
        {!isAll && <Button size="sm" variant="outline" onClick={() => setViewer("pdf")}><ExternalLink aria-hidden /> Open the plan</Button>}
      </div>
      {q.isPending ? (
        <div className="flex flex-col gap-3" role="status" aria-live="polite">
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden /> The agent is reading {isAll ? "all the plans" : "this plan"}. The first time can take a minute or two.</p>
          <Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-5/6" /><Skeleton className="h-4 w-2/3" />
          <div className="grid grid-cols-2 gap-3"><Skeleton className="h-40" /><Skeleton className="h-40" /></div>
        </div>
      ) : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : (
        <>
          <p className="text-sm">{q.data.overview}</p>
          {isAll && q.data.plans.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold">The plans</h3>
              <ul className="mt-2 flex flex-col gap-2">
                {q.data.plans.map((p) => (
                  <li key={p.id}>
                    <button type="button" onClick={() => onSelect(p.id)} className="w-full rounded-2xl border bg-background px-3 py-2 text-left text-sm hover:bg-muted">
                      <span className="font-medium">{p.title}</span>
                      <span className="block text-xs text-muted-foreground">{p.role}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {pages.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold">Important pages</h3>
              <ul className="mt-2 grid grid-cols-2 gap-3">
                {pages.map((k) => (
                  <li key={k.page}>
                    <button type="button" onClick={() => setViewer(k.page)} className="group flex w-full flex-col gap-1 text-left">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={planPageUrl(projectId, id, k.page)} alt={k.caption} loading="lazy"
                           className="aspect-[4/3] w-full rounded-xl border bg-muted object-contain transition group-hover:ring-2 group-hover:ring-ring" />
                      <span className="text-xs text-muted-foreground">p. {k.page} · {k.caption}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <Bullets title="Key points" items={q.data.key_points} />
          <Bullets title="Key dates" items={q.data.key_dates} />
          <Bullets title="Keep in mind" items={q.data.watch_points} />
          <p className="text-xs text-muted-foreground">Written by the agent from the plan document. Check the plan itself before acting on it.</p>
        </>
      )}
      <Popup open={viewer !== null} onClose={() => setViewer(null)} title={viewer === "pdf" || viewer === null ? title : `${title} · page ${viewer}`}>
        {viewer === "pdf" ? <PdfFrame src={planFileUrl(projectId, id)} title={title} /> : viewer !== null ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={planPageUrl(projectId, id, viewer)} alt={pages.find((k) => k.page === viewer)?.caption ?? ""} className="mx-auto h-auto max-w-full" />
        ) : null}
      </Popup>
    </section>
  );
}

function UploadButton({ onDone }: { onDone: (id: string) => void }) {
  const { role } = useApp();
  const upload = useUploadPlan();
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-col gap-2">
      <input ref={ref} type="file" accept="application/pdf,.pdf" className="hidden" aria-label="Upload a plan (PDF)"
             onChange={(e) => {
               const f = e.target.files?.[0];
               if (f) upload.mutate(f, { onSuccess: (p) => onDone(p.id) });
               e.target.value = "";
             }} />
      <GatedButton reason={denyReason(role, "manage_baseline")} className="w-full" disabled={upload.isPending} onClick={() => ref.current?.click()}>
        {upload.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Upload aria-hidden />} {upload.isPending ? "Uploading…" : "Upload a new plan"}
      </GatedButton>
      <p className="text-xs text-muted-foreground">PDF, up to 25 MB. Managers only.</p>
      {upload.isError && <p className="text-xs text-red-700">{(upload.error as Error).message}</p>}
    </div>
  );
}

export default function PlansPage() {
  const list = usePlans();
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    if (!selected && list.data?.plans.length) setSelected("all");
  }, [list.data, selected]);
  const current = selected === "all" ? { id: "all", title: "All plans" } : list.data?.plans.find((p) => p.id === selected);
  return (
    <>
      <PageHeader title="Performance" description="Plans and baseline: the documents the project is measured against. Pick one to see what it says." />
      <PerfTabs />
      {list.isPending ? <LoadingSkeleton rows={3} /> : list.isError ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : (
        <div className="grid items-start gap-5 lg:h-[calc(100dvh-17rem)] lg:min-h-[26rem] lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
          <div className="flex flex-col gap-3 lg:max-h-full lg:overflow-y-auto lg:pr-1">
            <UploadButton onDone={setSelected} />
            {!list.data.plans.length ? <EmptyState title="No plans yet" description="Upload the programme to start." /> : (
              <ul className="flex flex-col gap-2" role="tablist" aria-label="Plans">
                <li>
                  <button type="button" role="tab" aria-selected={selected === "all"} onClick={() => setSelected("all")}
                          className={cn("flex w-full items-start gap-3 rounded-2xl border px-3 py-3 text-left text-sm", selected === "all" ? "bg-secondary font-semibold" : "bg-card hover:bg-muted")}>
                    <Layers className="mt-0.5 size-4 shrink-0" aria-hidden />
                    <span className="min-w-0">All plans<span className="block text-xs font-normal text-muted-foreground">Overall summary of every plan</span></span>
                  </button>
                </li>
                {list.data.plans.map((p) => (
                  <li key={p.id}>
                    <button type="button" role="tab" aria-selected={selected === p.id} onClick={() => setSelected(p.id)}
                            className={cn("flex w-full items-start gap-3 rounded-2xl border px-3 py-3 text-left text-sm", selected === p.id ? "bg-secondary font-semibold" : "bg-card hover:bg-muted")}>
                      <FileText className="mt-0.5 size-4 shrink-0" aria-hidden />
                      <span className="min-w-0">
                        {p.title}
                        <span className="block truncate text-xs font-normal text-muted-foreground">{p.filename} · {p.size_kb} KB</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="min-h-0 lg:h-full lg:overflow-y-auto lg:overscroll-contain" tabIndex={0} aria-label="Summary, scrollable">
            {current && <Summary key={current.id} id={current.id} title={current.title} onSelect={setSelected} />}
          </div>
        </div>
      )}
      <div className="mt-6">
        <BaselineManager />
      </div>
    </>
  );
}
