"use client";

import { CheckCircle2, Keyboard, Paperclip, RefreshCw, Send } from "lucide-react";
import { useState } from "react";
import { JobStatusBadge } from "@/components/badges";
import { MicButton, type Recording } from "@/components/mic-button";
import { useApp } from "@/components/providers/app-context";
import { ReviewForm } from "@/components/review-form";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { UploadInput } from "@/lib/api";
import { useJob, useProposals, useUpload } from "@/lib/queries";
import { denyReason } from "@/lib/roles";

const DEMO_NOTES = [
  { id: "V01", label: "V01 breakdown", text: "The excavator broke down at ten. Hydraulic hose burst. Three workers can't continue digging in Zone B." },
  { id: "V02", label: "V02 forecast", text: "Just heard from the mechanic. He expects it back tomorrow at noon. That's his estimate." },
  { id: "V03", label: "V03 duplicate", text: "Same machine at Zone B. Three of us are still waiting on the excavator." },
];

export default function CapturePage() {
  const { role } = useApp();
  const blocked = denyReason(role, "capture");
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [lastInput, setLastInput] = useState<UploadInput | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const upload = useUpload();
  const job = useJob(jobId);
  const indexedSource = job.data?.status === "indexed" ? job.data.source_id : null;
  const proposals = useProposals(indexedSource);

  const send = (input: UploadInput) => {
    setDone(null);
    setLastInput(input);
    upload.mutate(input, { onSuccess: (j) => setJobId(j.id) });
  };

  const submitRecording = (rec: Recording) =>
    send({ type: "voice", file: rec.blob, filename: `note.${rec.mimeType.includes("mp4") ? "m4a" : "webm"}` });

  const reset = () => {
    setJobId(null);
    setText("");
    setFile(null);
    setDone(null);
    upload.reset();
  };

  return (
    <>
      <PageHeader title="Capture" description="Record or type what happened on site. You confirm every field before anything is saved." />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>New site note</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <MicButton onSubmit={submitRecording} disabled={!!blocked || upload.isPending} disabledReason={blocked} />

            <div className="flex flex-wrap justify-center gap-2">
              <Button variant={typing ? "secondary" : "outline"} size="touch" onClick={() => setTyping((t) => !t)} aria-expanded={typing}>
                <Keyboard aria-hidden /> Type instead
              </Button>
              <Button variant="outline" size="touch" asChild>
                <label className={blocked ? "pointer-events-none opacity-50" : "cursor-pointer"}>
                  <Paperclip aria-hidden /> Attach photo/file
                  <input
                    type="file"
                    accept="image/*,application/pdf,audio/*"
                    capture="environment"
                    className="sr-only"
                    disabled={!!blocked}
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  />
                </label>
              </Button>
            </div>
            {file && (
              <p className="text-center text-sm">
                Attached: <span className="font-medium">{file.name}</span>{" "}
                <Button variant="link" size="sm" onClick={() => setFile(null)}>
                  Remove
                </Button>
              </p>
            )}

            {typing && (
              <form
                className="flex flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (text.trim()) send({ type: "voice", text, file, filename: file?.name });
                }}
              >
                <Label htmlFor="note-text">Site note</Label>
                <Textarea id="note-text" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="What happened, where, how many people affected?" disabled={!!blocked} />
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  Demo notes:
                  {DEMO_NOTES.map((n) => (
                    <Button key={n.id} type="button" variant="secondary" size="sm" className="min-h-9" onClick={() => setText(n.text)} disabled={!!blocked}>
                      {n.label}
                    </Button>
                  ))}
                </div>
                <Button type="submit" size="touch" disabled={!!blocked || !text.trim() || upload.isPending} className="self-end">
                  <Send aria-hidden /> Submit note
                </Button>
              </form>
            )}
            {!typing && file && (
              <Button size="touch" onClick={() => send({ type: "photo", file, filename: file.name })} disabled={!!blocked || upload.isPending}>
                <Send aria-hidden /> Submit attachment
              </Button>
            )}
          </CardContent>
        </Card>

        <Card aria-live="polite">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Review</CardTitle>
            {job.data && <JobStatusBadge status={job.data.status} />}
          </CardHeader>
          <CardContent>
            {done ? (
              <EmptyState
                icon={<CheckCircle2 className="text-emerald-600" />}
                title="Captured"
                description={done}
                action={
                  <Button size="touch" onClick={reset}>
                    Capture another
                  </Button>
                }
              />
            ) : upload.isError ? (
              <ErrorState error={upload.error} onRetry={() => lastInput && send(lastInput)} />
            ) : !jobId ? (
              <EmptyState title="Nothing submitted yet" description="Record or type a note. Proposed fields appear here for you to check." />
            ) : job.isError ? (
              <ErrorState error={job.error} onRetry={() => void job.refetch()} />
            ) : job.data?.status === "failed" ? (
              <div className="flex flex-col gap-2">
                <ErrorState error={new Error(job.data.error ?? "Processing failed")} />
                <Button size="touch" variant="outline" onClick={() => lastInput && send(lastInput)}>
                  <RefreshCw aria-hidden /> Retry processing
                </Button>
              </div>
            ) : !indexedSource ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-muted-foreground">Transcribing and extracting fields…</p>
                <LoadingSkeleton rows={3} />
              </div>
            ) : proposals.isPending ? (
              <LoadingSkeleton rows={4} />
            ) : proposals.isError ? (
              <ErrorState error={proposals.error} onRetry={() => void proposals.refetch()} />
            ) : proposals.data.length === 0 ? (
              <EmptyState title="No fields proposed" description="Nothing could be extracted. Save it as a diary note or add more detail." />
            ) : (
              <ReviewForm key={proposals.data[0].source_id + jobId} proposal={proposals.data[0]} onDone={setDone} />
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
