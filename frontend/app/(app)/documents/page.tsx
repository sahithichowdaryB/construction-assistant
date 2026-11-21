"use client";

import { ChevronRight, FileUp, FolderOpen, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { JobStatusBadge } from "@/components/badges";
import { GatedButton } from "@/components/gated-button";
import { useApp } from "@/components/providers/app-context";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader, QueryState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SOURCE_TYPE_LABEL } from "@/lib/format";
import { useJob, useSources, useUpload } from "@/lib/queries";
import { denyReason } from "@/lib/roles";
import { fmtDateTime } from "@/lib/time";
import type { SourceType } from "@/lib/types";
import { cn } from "@/lib/utils";

const UPLOAD_TYPES: SourceType[] = ["daily_report", "diary", "minutes", "email", "photo", "voice", "register"];

function UploadCard() {
  const { role } = useApp();
  const blocked = denyReason(role, "upload");
  const [type, setType] = useState<SourceType>("daily_report");
  const [file, setFile] = useState<File | null>(null);
  const [drag, setDrag] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const upload = useUpload();
  const job = useJob(jobId);

  const send = () => file && upload.mutate({ type, file, filename: file.name }, { onSuccess: (j) => setJobId(j.id) });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Upload a document</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            if (!blocked) setFile(e.dataTransfer.files?.[0] ?? null);
          }}
          className={cn(
            "flex min-h-28 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed p-4 text-center text-sm focus-within:ring-2 focus-within:ring-ring",
            drag && "border-sky-500 bg-sky-50",
            blocked && "pointer-events-none opacity-50",
          )}
        >
          <FileUp className="size-6 text-muted-foreground" aria-hidden />
          {file ? <span className="font-medium">{file.name}</span> : <span>Drop a PDF, Word, email, photo or audio file, or tap to choose</span>}
          <span className="text-xs text-muted-foreground">Tip: a file name containing “fail” simulates a failed job</span>
          <input type="file" className="sr-only" disabled={!!blocked} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="upload-type">Document type</Label>
            <Select value={type} onValueChange={(v) => setType(v as SourceType)}>
              <SelectTrigger id="upload-type" className="h-11 min-w-44 md:h-9">
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
          <GatedButton reason={blocked} size="touch" disabled={!file || upload.isPending} onClick={send}>
            Upload
          </GatedButton>
          {job.data && <JobStatusBadge status={job.data.status} />}
          {job.data?.status === "failed" && (
            <Button size="touch" variant="outline" onClick={send}>
              <RefreshCw aria-hidden /> Retry
            </Button>
          )}
        </div>
        {job.data?.error && <p className="text-sm text-red-800">{job.data.error}</p>}
        {upload.isError && <ErrorState error={upload.error} onRetry={send} />}
      </CardContent>
    </Card>
  );
}

export default function DocumentsPage() {
  const sources = useSources();
  const [type, setType] = useState<"all" | SourceType>("all");
  const [q, setQ] = useState("");

  return (
    <>
      <PageHeader title="Documents" description="Every source SiteMate can cite, filtered to what was available at the selected time." />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <UploadCard />
        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            <Input aria-label="Search documents" placeholder="Search by ID or title" value={q} onChange={(e) => setQ(e.target.value)} className="h-11 max-w-xs md:h-9" />
            <Select value={type} onValueChange={(v) => setType(v as typeof type)}>
              <SelectTrigger aria-label="Filter by type" className="h-11 min-w-40 md:h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                {Object.entries(SOURCE_TYPE_LABEL).map(([k, v]) => (
                  <SelectItem key={k} value={k}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <QueryState
            query={sources}
            loading={<LoadingSkeleton rows={6} />}
            empty={<EmptyState icon={<FolderOpen />} title="No documents yet" />}
          >
            {(list) => {
              const ql = q.trim().toLowerCase();
              const shown = list
                .filter((s) => (type === "all" || s.type === type) && (!ql || s.id.toLowerCase().includes(ql) || s.title.toLowerCase().includes(ql)))
                .sort((a, b) => b.available_at.localeCompare(a.available_at));
              return shown.length ? (
                <ul className="flex flex-col divide-y rounded-lg border">
                  {shown.map((s) => (
                    <li key={s.id}>
                      <Link href={`/documents/${s.id}`} className="flex min-h-14 items-center gap-3 p-3 hover:bg-muted/50 focus-visible:bg-muted focus-visible:outline-none">
                        <span className="w-10 shrink-0 font-mono text-sm font-semibold">{s.id}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm">{s.title}</span>
                          <span className="text-xs text-muted-foreground">
                            {SOURCE_TYPE_LABEL[s.type]} · {fmtDateTime(s.available_at)}
                            {s.note ? ` · ${s.note}` : ""}
                          </span>
                        </span>
                        <JobStatusBadge status={s.status} />
                        <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState title="No documents match" />
              );
            }}
          </QueryState>
        </section>
      </div>
    </>
  );
}
