"use client";

import { ChevronRight, ClipboardList, Clock, FileUp, FolderOpen, Image as ImageIcon, Loader2, Mail, Mic, PencilRuler, RefreshCw, Search, StickyNote, Upload, X, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { JobStatusBadge } from "@/components/badges";
import { GatedButton } from "@/components/gated-button";
import { useApp } from "@/components/providers/app-context";
import { DocumentsGridSkeleton, DocumentTilesSkeleton } from "@/components/route-skeletons";
import { EmptyState, ErrorState, PageHeader } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { sourceFileUrl } from "@/lib/api";
import { USE_FIXTURES } from "@/lib/endpoints";
import { SOURCE_TYPE_LABEL } from "@/lib/format";
import { sourceTitle } from "@/lib/source-title";
import { useDocumentJob, useInvalidateOnJobDone, useSources, useUploadDocument } from "@/lib/queries";
import { denyReason } from "@/lib/roles";
import { fmtDateTime, fmtTime, localDateOf } from "@/lib/time";
import type { Source, SourceType } from "@/lib/types";
import { cn } from "@/lib/utils";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtShortDate = (iso: string) => {
  const d = localDateOf(iso);
  return `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
};

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

// ---------- picture library ----------

type Group = { key: string; label: string; types: SourceType[]; Icon: LucideIcon; tile: string; ink: string };

const GROUPS: Group[] = [
  { key: "voice", label: "Voice", types: ["voice"], Icon: Mic, tile: "bg-violet-50 dark:bg-violet-500/10", ink: "text-violet-700 dark:text-violet-300" },
  { key: "reports", label: "Reports", types: ["daily_report"], Icon: ClipboardList, tile: "bg-sky-50 dark:bg-sky-500/10", ink: "text-sky-800 dark:text-sky-300" },
  { key: "notes", label: "Notes", types: ["text", "diary"], Icon: StickyNote, tile: "bg-stone-100 dark:bg-white/5", ink: "text-stone-700 dark:text-stone-300" },
  { key: "photos", label: "Photos", types: ["photo"], Icon: ImageIcon, tile: "bg-emerald-50 dark:bg-emerald-500/10", ink: "text-emerald-800 dark:text-emerald-300" },
  { key: "emails", label: "Emails", types: ["email"], Icon: Mail, tile: "bg-amber-50 dark:bg-amber-500/10", ink: "text-amber-800 dark:text-amber-300" },
  { key: "more", label: "Plans & more", types: ["plan", "minutes", "register", "schedule", "project"], Icon: PencilRuler, tile: "bg-red-50 dark:bg-red-500/10", ink: "text-red-800 dark:text-red-300" },
];
const groupOf = (t: SourceType) => GROUPS.find((g) => g.types.includes(t))!;

/** Records captured in the app are named after their file; show what was said or seen instead. */
const displayTitle = (s: Source) => sourceTitle(s);

/** Same id, same bars: a decorative waveform for voice notes. */
function Wave({ seed }: { seed: string }) {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) % 9973;
  return (
    <span className="flex h-8 items-center gap-[3px]" aria-hidden>
      {Array.from({ length: 22 }, (_, i) => (
        <i key={i} className="block w-[3px] rounded-full bg-violet-500/80" style={{ height: `${6 + Math.round((Math.sin(i * 1.7 + h) + 1) * 9 + ((i * 7 + h) % 5))}px` }} />
      ))}
    </span>
  );
}

function Sheet({ accent }: { accent: string }) {
  return (
    <svg viewBox="0 0 80 100" className="h-[78%] drop-shadow-md" aria-hidden>
      <rect width="80" height="100" rx="4" fill="#fff" />
      <rect x="8" y="9" width="38" height="6" rx="2" className={accent} />
      {[0, 1, 2, 3, 4, 5].map((i) => <rect key={i} x="8" y={23 + i * 9} width={64 - (i % 3) * 12} height="3.5" rx="1.5" fill="#d6d2c8" />)}
      <rect x="8" y="80" width="64" height="12" rx="2" fill="#f1efe9" />
    </svg>
  );
}

function Envelope() {
  return (
    <svg viewBox="0 0 90 62" className="h-[58%] drop-shadow-md" aria-hidden>
      <rect width="90" height="62" rx="6" fill="#fff" />
      <path d="M4 6 L45 36 L86 6" fill="none" stroke="#e8cf9c" strokeWidth="3" strokeLinejoin="round" />
    </svg>
  );
}

function Visual({ s }: { s: Source }) {
  const { projectId, asOf } = useApp();
  const [failed, setFailed] = useState(false);
  const g = groupOf(s.type);
  if (s.type === "photo" && s.has_file !== false && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={sourceFileUrl(projectId, s.id, asOf)} alt="" loading="lazy" onError={() => setFailed(true)}
           className="size-full object-cover transition-transform duration-500 group-hover:scale-105" />
    );
  }
  const body =
    s.type === "voice" ? <Wave seed={s.id} />
      : s.type === "email" ? <Envelope />
      : (s.type === "text" || s.type === "diary") && displayTitle(s) !== SOURCE_TYPE_LABEL[s.type] ? (
        <span className="line-clamp-3 px-3 text-left text-[11.5px] leading-snug font-medium text-foreground/80">“{displayTitle(s)}”</span>
      )
      : s.type === "text" || s.type === "diary" ? <StickyNote className="size-8 text-stone-500/60" aria-hidden />
      : s.type === "photo" ? <ImageIcon className="size-8 text-emerald-700/50" aria-hidden />
      : <Sheet accent={s.type === "plan" ? "fill-red-700" : s.type === "daily_report" ? "fill-sky-800" : "fill-stone-500"} />;
  return <span className={cn("flex size-full items-center justify-center", g.tile)}>{body}</span>;
}

function DocCard({ s, today, index }: { s: Source; today: string; index: number }) {
  const g = groupOf(s.type);
  const when = localDateOf(s.available_at) === today ? fmtTime(s.available_at) : fmtShortDate(s.available_at);
  // App captures stay "uploaded" for good; only a file being read, or one that failed, gets a badge.
  const busy = s.status === "extracting" || s.status === "failed";
  return (
    <li className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-500 motion-safe:fill-mode-both"
        style={{ animationDelay: `${Math.min(index, 14) * 35}ms` }}>
      <Link href={`/documents/${s.id}`}
            className="group flex h-full flex-col overflow-hidden rounded-2xl bg-card shadow-xs transition duration-300 hover:-translate-y-0.5 hover:shadow-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        <span className="relative block h-20 overflow-hidden">
          <Visual s={s} />
          {busy && (
            <span className={cn("absolute top-2 right-2 rounded-full px-2 py-0.5 text-[10px] font-bold",
              s.status === "failed" ? "bg-red-600 text-white" : "bg-black/60 text-white")}>
              {s.status === "failed" ? "Failed" : "Processing"}
            </span>
          )}
        </span>
        <span className="flex items-center gap-1.5 px-2.5 py-2">
          <g.Icon className={cn("size-3.5 shrink-0", g.ink)} aria-hidden />
          <span className="min-w-0 flex-1 truncate text-xs font-semibold">{displayTitle(s)}</span>
          <span className="shrink-0 text-[11px] font-semibold text-muted-foreground tabular">{when}</span>
        </span>
      </Link>
    </li>
  );
}

const PAGE = 10;

/** Page numbers around the current page, with the first and last always shown. */
function Pager({ page, pages, total, onPage }: { page: number; pages: number; total: number; onPage: (p: number) => void }) {
  if (pages <= 1) return null;
  const nums = [...new Set([0, page - 1, page, page + 1, pages - 1])].filter((n) => n >= 0 && n < pages).sort((a, b) => a - b);
  const btn = "flex h-8 min-w-8 items-center justify-center rounded-lg px-2 text-sm font-semibold tabular transition";
  return (
    <nav aria-label="Pages" className="flex items-center justify-center gap-1">
      <button type="button" className={cn(btn, "hover:bg-muted disabled:opacity-30")} disabled={page === 0} onClick={() => onPage(page - 1)} aria-label="Previous page">‹</button>
      {nums.map((n, i) => (
        <span key={n} className="flex items-center gap-1">
          {i > 0 && n - nums[i - 1] > 1 && <span className="px-1 text-muted-foreground">…</span>}
          <button type="button" aria-current={n === page ? "page" : undefined} onClick={() => onPage(n)}
                  className={cn(btn, n === page ? "bg-foreground text-background" : "hover:bg-muted")}>{n + 1}</button>
        </span>
      ))}
      <button type="button" className={cn(btn, "hover:bg-muted disabled:opacity-30")} disabled={page === pages - 1} onClick={() => onPage(page + 1)} aria-label="Next page">›</button>
      <span className="ml-3 text-xs text-muted-foreground tabular">{page * PAGE + 1}–{Math.min(total, page * PAGE + PAGE)} of {total}</span>
    </nav>
  );
}

export default function DocumentsPage() {
  const sources = useSources();
  const { asOf } = useApp();
  const today = localDateOf(asOf);
  const [group, setGroup] = useState<string>("all");
  const [q, setQ] = useState("");
  const [showUpload, setShowUpload] = useState(false);
  const [page, setPage] = useState(0);
  const list = sources.data ?? [];
  const ql = q.trim().toLowerCase();
  const inGroup = (s: Source) => group === "all" || groupOf(s.type).key === group;
  const shown = list
    .filter((s) => inGroup(s) && (!ql || [s.id, s.title, s.filename, displayTitle(s)].some((v) => v.toLowerCase().includes(ql))))
    .sort((a, b) => b.available_at.localeCompare(a.available_at));
  const count = (g: Group) => list.filter((s) => g.types.includes(s.type)).length;
  const fresh = (g: Group) => list.filter((s) => g.types.includes(s.type) && localDateOf(s.available_at) === today).length;

  return (
    <>
      <PageHeader
        title="Documents"
        description={sources.isPending ? <span className="inline-flex items-center gap-2"><Loader2 className="size-3.5 animate-spin text-primary" aria-hidden /> Loading records…</span> : `${list.length} records · newest first`}
      />
      <div className="flex flex-col gap-6">
        {sources.isPending ? <DocumentTilesSkeleton /> : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7" aria-label="Document types">
          <li>
            <button type="button" aria-pressed={group === "all"} onClick={() => { setGroup("all"); setPage(0); }}
                    className={cn("flex h-full w-full flex-col gap-3 rounded-[18px] bg-hero p-4 text-left text-hero-foreground transition", group === "all" ? "ring-2 ring-primary" : "hover:-translate-y-0.5")}>
              <FolderOpen className="size-5 text-primary" aria-hidden />
              <span><span className="block text-3xl leading-none font-bold tabular">{list.length}</span><span className="text-xs font-bold">All</span></span>
            </button>
          </li>
          {GROUPS.filter((g) => count(g) > 0).map((g) => {
            const n = fresh(g);
            return (
              <li key={g.key}>
                <button type="button" aria-pressed={group === g.key} onClick={() => { setGroup(g.key); setPage(0); }}
                        className={cn("relative flex h-full w-full flex-col gap-3 rounded-[18px] p-4 text-left transition", g.tile, g.ink, group === g.key ? "ring-2 ring-foreground" : "hover:-translate-y-0.5")}>
                  {n > 0 && <span className="absolute top-3 right-3 rounded-full bg-destructive px-2 text-[10px] leading-5 font-bold text-white">{n} new</span>}
                  <g.Icon className="size-5" aria-hidden />
                  <span><span className="block text-3xl leading-none font-bold tabular">{count(g)}</span><span className="text-xs font-bold">{g.label}</span></span>
                </button>
              </li>
            );
          })}
        </ul>
        )}

        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input aria-label="Search documents" placeholder="Search reports, notes, photos…" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }}
                   className="h-11 rounded-xl border-0 bg-card pl-10 shadow-xs" />
            {q && (
              <button type="button" aria-label="Clear search" onClick={() => setQ("")}
                      className="absolute top-1/2 right-2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
                <X className="size-4" aria-hidden />
              </button>
            )}
          </div>
          <Button className="h-11 rounded-xl" aria-expanded={showUpload} onClick={() => setShowUpload((v) => !v)}>
            {showUpload ? <X aria-hidden /> : <Upload aria-hidden />} {showUpload ? "Close" : "Upload"}
          </Button>
        </div>

        {showUpload && <div className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-2"><UploadPanel /></div>}

        {sources.isPending ? (
          <DocumentsGridSkeleton />
        ) : sources.isError ? (
          <ErrorState error={sources.error} onRetry={() => void sources.refetch()} />
        ) : !list.length ? (
          <EmptyState icon={<FolderOpen />} title="No documents yet" description="Use Upload to add the first one." />
        ) : !shown.length ? (
          <EmptyState title="Nothing matches" description="Try another search or type." />
        ) : (
          <>
            <ul key={`${group}-${page}`} className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5" aria-label="Documents">
              {shown.slice(page * PAGE, page * PAGE + PAGE).map((s, i) => <DocCard key={s.id} s={s} today={today} index={i} />)}
            </ul>
            <Pager page={page} pages={Math.ceil(shown.length / PAGE)} total={shown.length} onPage={setPage} />
          </>
        )}
      </div>
    </>
  );
}
