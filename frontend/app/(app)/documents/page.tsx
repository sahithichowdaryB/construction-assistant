"use client";

import { ChevronRight, Clock, FileUp, FolderOpen, RefreshCw, Search, Upload, X } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { JobStatusBadge } from "@/components/badges";
import { GatedButton } from "@/components/gated-button";
import { useApp } from "@/components/providers/app-context";
import { SourceIcon } from "@/components/source-icon";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { USE_FIXTURES } from "@/lib/endpoints";
import { SOURCE_TYPE_LABEL } from "@/lib/format";
import { useDocumentJob, useInvalidateOnJobDone, useSources, useUploadDocument } from "@/lib/queries";
import { denyReason } from "@/lib/roles";
import { fmtDateTime } from "@/lib/time";
import type { SourceType } from "@/lib/types";
import { cn } from "@/lib/utils";

const UPLOAD_TYPES: SourceType[] = ["daily_report", "diary", "minutes", "email", "photo", "voice", "register"];

/** Best guess of the document type from the file name; the user can still change it. */
function guessType(name: string): SourceType | null {
  const n = name.toLowerCase();
  const ext = n.split(".").pop() ?? "";
  if (ext === "eml") return "email";
  if (["jpg", "jpeg", "png"].includes(ext)) return "photo";
  if (["wav", "mp3", "m4a"].includes(ext)) return "voice";
  if (ext === "csv") return "register";
  if (ext === "docx") return "minutes";
  if (ext === "txt") return n.includes("diary") ? "diary" : null;
  if (ext === "pdf") return "daily_report";
  return null;
}

function fmtSize(bytes: number) {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function UploadPanel() {
  const { role } = useApp();
  const blocked = denyReason(role, "upload");
  const [type, setType] = useState<SourceType>("daily_report");
  const [file, setFile] = useState<File | null>(null);
  const [drag, setDrag] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const upload = useUploadDocument();
  const job = useDocumentJob(jobId);
  useInvalidateOnJobDone(job.data?.status);

  const choose = (f: File | null) => {
    setFile(f);
    setJobId(null);
    setDuplicate(false);
    upload.reset();
    const guess = f && guessType(f.name);
    if (guess) setType(guess);
  };
  const send = () =>
    file &&
    upload.mutate(
      { type, file },
      {
        onSuccess: (j) => {
          setDuplicate(!!j.duplicate);
          setJobId(j.id);
        },
      },
    );

  return (
    <section aria-labelledby="upload-title" className="overflow-hidden rounded-2xl border bg-card shadow-xs">
      <div className="flex flex-col gap-4 p-4 md:flex-row md:items-stretch md:p-5">
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            if (!blocked) choose(e.dataTransfer.files?.[0] ?? null);
          }}
          className={cn(
            "group flex min-h-28 flex-1 cursor-pointer items-center gap-4 rounded-xl border-2 border-dashed bg-muted/30 px-5 py-4 transition-all hover:border-foreground/30 hover:bg-muted/50 focus-within:ring-2 focus-within:ring-ring",
            drag && "scale-[1.01] border-sky-500 bg-sky-50",
            file && "border-solid border-sky-300 bg-sky-50/60",
            blocked && "pointer-events-none opacity-50",
          )}
        >
          <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-background shadow-xs ring-1 ring-border transition-transform group-hover:-translate-y-0.5">
            <FileUp className="size-5 text-sky-700" aria-hidden />
          </span>
          <span className="flex min-w-0 flex-col gap-0.5 text-left">
            <span id="upload-title" className="text-sm font-semibold">
              {file ? file.name : "Upload a document"}
            </span>
            <span className="text-xs text-muted-foreground">
              {file
                ? `${fmtSize(file.size)} · detected as ${SOURCE_TYPE_LABEL[type]} · click to choose another file`
                : "Drop a file here or click to browse · PDF, Word, email (.eml), CSV, text, photo or audio · up to 25 MB"}
            </span>
          </span>
          <input
            ref={input}
            type="file"
            className="sr-only"
            disabled={!!blocked}
            onChange={(e) => choose(e.target.files?.[0] ?? null)}
          />
        </label>

        <div className="flex flex-col justify-center gap-3 md:w-72">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="upload-type" className="text-xs text-muted-foreground">
              Document type
            </Label>
            <Select value={type} onValueChange={(v) => setType(v as SourceType)}>
              <SelectTrigger id="upload-type" className="h-11 w-full md:h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {UPLOAD_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {SOURCE_TYPE_LABEL[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-2">
            <GatedButton reason={blocked} size="touch" className="flex-1" disabled={!file || upload.isPending} onClick={send}>
              <Upload aria-hidden /> {upload.isPending ? "Uploading…" : "Upload"}
            </GatedButton>
            {file && (
              <Button
                size="icon-touch"
                variant="outline"
                aria-label="Clear selected file"
                onClick={() => {
                  choose(null);
                  if (input.current) input.current.value = "";
                }}
              >
                <X aria-hidden />
              </Button>
            )}
          </div>
        </div>
      </div>

      {!USE_FIXTURES && (
        <p className="flex items-center gap-1.5 border-t bg-muted/30 px-5 py-2 text-xs text-muted-foreground">
          <Clock className="size-3.5 shrink-0" aria-hidden />
          Recorded as received at the moment you upload it. The As of clock then moves to that time so the document shows up.
        </p>
      )}

      {(job.data || duplicate || upload.isError) && (
        <div className="flex flex-col gap-2 border-t px-5 py-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            {job.data && <JobStatusBadge status={job.data.status} />}
            {upload.data?.available_at && (
              <span className="text-muted-foreground">
                {duplicate ? "First received" : "Received"}{" "}
                <strong className="font-medium text-foreground">{fmtDateTime(upload.data.available_at)}</strong>
              </span>
            )}
            {duplicate && <span className="text-muted-foreground">This file was already uploaded; nothing new was stored.</span>}
            {job.data?.status === "failed" && (
              <Button size="sm" variant="outline" onClick={send}>
                <RefreshCw aria-hidden /> Retry
              </Button>
            )}
            {job.data?.status === "indexed" && !job.data.source_id.startsWith("UP0") && (
              <Button asChild size="sm" variant="outline" className="ml-auto">
                <Link href={`/documents/${job.data.source_id}`}>
                  Open {job.data.source_id} <ChevronRight aria-hidden />
                </Link>
              </Button>
            )}
          </div>
          {job.data?.error && <p className="text-red-800">{job.data.error}</p>}
          {!!job.data?.review_reasons?.length && (
            <ul className="list-disc pl-5 text-amber-900">
              {job.data.review_reasons.map((r) => (
                <li key={r}>Needs review: {r}</li>
              ))}
            </ul>
          )}
          {upload.isError && <ErrorState error={upload.error} onRetry={send} />}
        </div>
      )}
    </section>
  );
}

export default function DocumentsPage() {
  const sources = useSources();
  const [type, setType] = useState<"all" | SourceType>("all");
  const [q, setQ] = useState("");
  const list = sources.data ?? [];
  const counts = list.reduce<Partial<Record<SourceType, number>>>((acc, s) => ({ ...acc, [s.type]: (acc[s.type] ?? 0) + 1 }), {});
  const types = (Object.keys(SOURCE_TYPE_LABEL) as SourceType[]).filter((t) => counts[t]);
  const ql = q.trim().toLowerCase();
  const shown = list
    .filter(
      (s) =>
        (type === "all" || s.type === type) &&
        (!ql || s.id.toLowerCase().includes(ql) || s.title.toLowerCase().includes(ql) || s.filename.toLowerCase().includes(ql)),
    )
    .sort((a, b) => b.available_at.localeCompare(a.available_at));

  return (
    <>
      <PageHeader title="Documents" description="Every source SiteMate can cite, filtered to what was available at the selected time." />

      <div className="flex flex-col gap-5">
        {/* Search and type filters */}
        <div className="flex flex-col gap-3">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              aria-label="Search documents"
              placeholder="Search by ID, title or file name"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="h-11 rounded-xl pl-9 shadow-xs"
            />
            {q && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQ("")}
                className="absolute top-1/2 right-2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="size-4" aria-hidden />
              </button>
            )}
          </div>
          <div role="group" aria-label="Filter by type" className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
            {(["all", ...types] as const).map((t) => {
              const active = type === t;
              return (
                <button
                  key={t}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setType(t)}
                  className={cn(
                    "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                    active ? "border-foreground bg-foreground text-background" : "bg-card hover:bg-muted",
                  )}
                >
                  {t === "all" ? "All" : SOURCE_TYPE_LABEL[t]}
                  <span
                    className={cn(
                      "rounded-full px-1.5 text-[11px] tabular-nums",
                      active ? "bg-background/20 text-background" : "bg-muted text-muted-foreground",
                    )}
                  >
                    {t === "all" ? list.length : counts[t]}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <UploadPanel />

        {/* Document list */}
        {sources.isPending ? (
          <LoadingSkeleton rows={6} />
        ) : sources.isError ? (
          <ErrorState error={sources.error} onRetry={() => void sources.refetch()} />
        ) : !list.length ? (
          <EmptyState icon={<FolderOpen />} title="No documents yet" description="Upload the first document above." />
        ) : !shown.length ? (
          <EmptyState title="No documents match" description="Try another search or type." />
        ) : (
          <section aria-label="Documents" className="overflow-hidden rounded-2xl border bg-card shadow-xs">
            <div className="hidden grid-cols-[minmax(0,1fr)_9rem_11rem_8rem_1.25rem] gap-4 border-b bg-muted/40 px-4 py-2.5 text-xs font-medium tracking-wide text-muted-foreground uppercase md:grid">
              <span>Document</span>
              <span>Type</span>
              <span>Received</span>
              <span>Status</span>
              <span />
            </div>
            <ul className="divide-y">
              {shown.map((s) => (
                <li key={s.id}>
                  <Link
                    href={`/documents/${s.id}`}
                    className="group grid grid-cols-[minmax(0,1fr)_1.25rem] items-center gap-x-4 gap-y-1 px-4 py-3 transition-colors hover:bg-muted/40 focus-visible:bg-muted focus-visible:outline-none md:grid-cols-[minmax(0,1fr)_9rem_11rem_8rem_1.25rem]"
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <SourceIcon type={s.type} />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium group-hover:underline group-hover:underline-offset-2">
                          {s.title}
                        </span>
                        <span className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                          <span className="shrink-0 rounded bg-muted px-1.5 py-px font-mono text-[11px] text-foreground">{s.id}</span>
                          <span className="truncate">{s.filename}</span>
                        </span>
                        {s.note && <span className="mt-1 block truncate text-xs text-amber-800">{s.note}</span>}
                        <span className="mt-1 block text-xs text-muted-foreground md:hidden">
                          {SOURCE_TYPE_LABEL[s.type]} · {fmtDateTime(s.available_at)}
                        </span>
                      </span>
                    </span>
                    <span className="hidden text-sm text-muted-foreground md:block">{SOURCE_TYPE_LABEL[s.type]}</span>
                    <span className="hidden text-sm text-muted-foreground tabular-nums md:block">{fmtDateTime(s.available_at)}</span>
                    <span className="hidden md:block">
                      <JobStatusBadge status={s.status} />
                    </span>
                    <ChevronRight
                      className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
                      aria-hidden
                    />
                  </Link>
                </li>
              ))}
            </ul>
            <p className="border-t bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
              {shown.length} of {list.length} documents · newest first
            </p>
          </section>
        )}
      </div>
    </>
  );
}
