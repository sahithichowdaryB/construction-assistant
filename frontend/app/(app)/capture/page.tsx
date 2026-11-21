"use client";

import { CheckCircle2, Keyboard, Paperclip, RefreshCw, Send } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AgentReview } from "@/components/agent-review";
import { JobStatusBadge } from "@/components/badges";
import { MicButton, type Recording } from "@/components/mic-button";
import { useApp } from "@/components/providers/app-context";
import { RECORDINGS_KEY, RecordingsList } from "@/components/recordings-list";
import { ReviewForm } from "@/components/review-form";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { answerQuestions, submitAudio, submitNote, submitReview, type AgentResult, type ReviewDecision } from "@/lib/agent";
import type { UploadInput } from "@/lib/api";
import { useJob, useProposals, useUpload } from "@/lib/queries";
import { denyReason } from "@/lib/roles";

const DEMO_NOTES = [
  { id: "V01", label: "V01 breakdown", text: "The excavator broke down at ten. Hydraulic hose burst. Three workers can't continue digging in Zone B." },
  { id: "V02", label: "V02 forecast", text: "Just heard from the mechanic. He expects it back tomorrow at noon. That's his estimate." },
  { id: "V03", label: "V03 duplicate", text: "Same machine at Zone B. Three of us are still waiting on the excavator." },
];

type NoteInput = { text: string } | { rec: Recording };

// Recordings need a speech-to-text service behind the agent (OPENAI_API_KEY or WHISPER_BASE_URL in backend/.env).
// Until then the mic is disabled and notes are typed or dictated. Set NEXT_PUBLIC_VOICE_TRANSCRIPTION=true to enable it.
const VOICE_READY = process.env.NEXT_PUBLIC_VOICE_TRANSCRIPTION === "true";
const VOICE_OFF_REASON = "Voice recording isn't set up. Tap “Type instead” and dictate (Mac: press the dictation key).";

export default function CapturePage() {
  const { role, projectId } = useApp();
  const blocked = denyReason(role, "capture");
  const micBlocked = blocked ?? (VOICE_READY ? null : VOICE_OFF_REASON);
  const [typing, setTyping] = useState(!VOICE_READY);
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [lastInput, setLastInput] = useState<UploadInput | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const [agentResult, setAgentResult] = useState<AgentResult | null>(null);
  const showResult = (r: AgentResult) => {
    setAgentResult(r);
    if (r.status === "saved") void queryClient.invalidateQueries({ queryKey: RECORDINGS_KEY(projectId) });
  };
  const [lastNote, setLastNote] = useState<NoteInput | null>(null);

  // Typed notes go to the capture agent (Claude + database); photos/files still use the fixture flow.
  const note = useMutation({
    mutationFn: (n: NoteInput) => ("text" in n ? submitNote(projectId, n.text) : submitAudio(projectId, n.rec.blob, `note.${n.rec.mimeType.includes("mp4") ? "m4a" : "webm"}`)),
    onSuccess: showResult,
  });
  const sendNote = (n: NoteInput) => {
    setLastNote(n);
    note.mutate(n);
  };
  const answers = useMutation({
    mutationFn: (a: { id: string; answer: string }[]) => {
      if (agentResult?.status !== "needs_input") throw new Error("No capture is waiting for answers");
      return answerQuestions(projectId, agentResult.thread_id, a);
    },
    onSuccess: showResult,
  });
  const review = useMutation({
    mutationFn: (d: ReviewDecision) => {
      if (agentResult?.status !== "needs_review") throw new Error("No capture is waiting for review");
      return submitReview(projectId, agentResult.thread_id, d);
    },
    onSuccess: showResult,
  });
  const agentActive = !!agentResult || note.isPending || note.isError;

  const upload = useUpload();
  const job = useJob(jobId);
  const indexedSource = job.data?.status === "indexed" ? job.data.source_id : null;
  const proposals = useProposals(indexedSource);

  const send = (input: UploadInput) => {
    setDone(null);
    setLastInput(input);
    upload.mutate(input, { onSuccess: (j) => setJobId(j.id) });
  };

  const submitRecording = (rec: Recording) => sendNote({ rec });

  const reset = () => {
    setJobId(null);
    setText("");
    setFile(null);
    setDone(null);
    setAgentResult(null);
    note.reset();
    answers.reset();
    review.reset();
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
            <MicButton onSubmit={submitRecording} disabled={!!micBlocked || upload.isPending} disabledReason={micBlocked} />

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
                  if (!text.trim()) return;
                  if (file) return send({ type: "voice", text, file, filename: file.name });
                  sendNote({ text });
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
                <Button type="submit" size="touch" disabled={!!blocked || !text.trim() || upload.isPending || note.isPending} className="self-end">
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
            {agentActive ? (
              note.isPending ? (
                <div className="flex flex-col gap-2">
                  <p className="text-sm text-muted-foreground">Reading your note and extracting fields… this can take up to a minute.</p>
                  <LoadingSkeleton rows={3} />
                </div>
              ) : note.isError ? (
                <ErrorState error={note.error} onRetry={() => lastNote && note.mutate(lastNote)} />
              ) : agentResult ? (
                <div className="flex flex-col gap-3">
                  {(answers.isError || review.isError) && <ErrorState error={answers.error ?? review.error} />}
                  <AgentReview
                    result={agentResult}
                    pending={answers.isPending || review.isPending}
                    onAnswer={(a) => answers.mutate(a)}
                    onReview={(d) => review.mutate(d)}
                    onReset={reset}
                  />
                </div>
              ) : null
            ) : done ? (
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
      <RecordingsList projectId={projectId} />
    </>
  );
}
