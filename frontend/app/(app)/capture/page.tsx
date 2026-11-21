"use client";

import { Camera, CheckCircle2, Keyboard, Mic, Paperclip, RefreshCw, Send, ShieldCheck, Sparkles } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AgentReview } from "@/components/agent-review";
import { JobStatusBadge } from "@/components/badges";
import { MicButton, type Recording } from "@/components/mic-button";
import { useApp } from "@/components/providers/app-context";
import { RECORDINGS_KEY, RecordingsList } from "@/components/recordings-list";
import { ReviewForm } from "@/components/review-form";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/states";
import { Button } from "@/components/ui/button";
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
  const [lastNote, setLastNote] = useState<NoteInput | null>(null);
  const showResult = (r: AgentResult) => {
    setAgentResult(r);
    if (r.status === "saved") void queryClient.invalidateQueries({ queryKey: RECORDINGS_KEY(projectId) });
  };

  // Typed and recorded notes go to the capture agent (Claude + database); photos/files still use the fixture flow.
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
  // The speaker's last look at the extracted facts, just before anything is saved.
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

  const quoteText = agentResult && "transcript" in agentResult ? agentResult.transcript : lastNote && "text" in lastNote ? lastNote.text : "";
  const busy = note.isPending || upload.isPending || (!!jobId && !indexedSource && job.data?.status !== "failed");
  const reviewing = !!agentResult || !!indexedSource;
  const saved = !!done || agentResult?.status === "saved";
  const stage = saved ? 3 : reviewing ? 2 : busy ? 1 : 0;
  const STEPS = ["Note sent", "Details picked out", "You confirm"];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold md:text-[28px]">Site notes</h1>
        <p className="mt-1 text-sm text-muted-foreground">Say what happened. SiteMate turns it into a diary entry, and you check every detail before it is saved.</p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
        {/* Capture */}
        <section aria-label="New note" className="relative flex flex-col gap-6 overflow-hidden rounded-[28px] bg-hero p-6 text-hero-foreground md:p-8">
          <div>
            <p className="inline-flex items-center gap-2 text-sm font-semibold text-primary">
              <span className="size-2 rounded-full bg-primary" aria-hidden /> New site note
            </p>
            <h2 className="mt-2 text-2xl font-bold">What happened on site?</h2>
            <p className="mt-1 text-sm text-hero-muted">Say what, where, when, and who was affected. Any language is fine.</p>
          </div>

          <MicButton onSubmit={submitRecording} disabled={!!micBlocked || upload.isPending || note.isPending} disabledReason={micBlocked} />

          <div className="flex flex-wrap justify-center gap-2">
            <Button
              variant="ghost"
              size="touch"
              className={typing ? "rounded-xl bg-white text-[#111214] hover:bg-white/90" : "rounded-xl bg-white/10 text-white hover:bg-white/15 hover:text-white"}
              onClick={() => setTyping((t) => !t)}
              aria-expanded={typing}
            >
              <Keyboard aria-hidden /> Type instead
            </Button>
            <Button variant="ghost" size="touch" className="rounded-xl bg-white/10 text-white hover:bg-white/15 hover:text-white" asChild>
              <label className={blocked ? "pointer-events-none opacity-50" : "cursor-pointer"}>
                <Camera aria-hidden /> Add photo or file
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
            <div className="flex items-center justify-between gap-2 rounded-2xl bg-white/10 px-4 py-3 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                <Paperclip className="size-4 shrink-0" aria-hidden />
                <span className="truncate font-medium">{file.name}</span>
              </span>
              <Button variant="ghost" size="sm" className="text-hero-muted hover:bg-white/10 hover:text-white" onClick={() => setFile(null)}>
                Remove
              </Button>
            </div>
          )}

          {typing && (
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (!text.trim()) return;
                if (file) return send({ type: file.type.startsWith("image/") ? "photo" : "diary", text, file, filename: file.name });
                sendNote({ text });
              }}
            >
              <Label htmlFor="note-text" className="sr-only">
                Note
              </Label>
              <Textarea
                id="note-text"
                rows={4}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Excavator EX-02 stopped at 10:00 in Zone B, hydraulic hose burst, three workers waiting…"
                disabled={!!blocked}
                className="rounded-2xl border-white/10 bg-white/5 text-[15px] text-white placeholder:text-white/40 focus-visible:border-primary dark:bg-white/5"
              />
              <div className="flex flex-col gap-2">
                <p className="text-xs font-medium text-hero-muted">Try a note from the Riverside demo</p>
                <div className="grid gap-2 sm:grid-cols-3">
                  {DEMO_NOTES.map((n) => (
                    <button
                      key={n.id}
                      type="button"
                      onClick={() => setText(n.text)}
                      disabled={!!blocked}
                      className="rounded-2xl bg-white/5 p-3 text-left text-xs leading-relaxed text-white/80 ring-1 ring-white/10 transition hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
                    >
                      <span className="mb-1 block font-mono text-[11px] font-semibold text-primary">{n.id}</span>
                      <span className="line-clamp-2">{n.text}</span>
                    </button>
                  ))}
                </div>
              </div>
              <Button type="submit" size="touch" disabled={!!blocked || !text.trim() || upload.isPending || note.isPending} className="h-12 self-end rounded-2xl px-5 md:h-12">
                <Send aria-hidden /> Send note
              </Button>
            </form>
          )}
          {!typing && file && (
            <Button size="touch" className="h-12 rounded-2xl md:h-12" onClick={() => send({ type: "photo", file, filename: file.name })} disabled={!!blocked || upload.isPending}>
              <Send aria-hidden /> Send attachment
            </Button>
          )}
        </section>

        {/* Check */}
        <section aria-label="Check the details" aria-live="polite" className="flex flex-col gap-5 rounded-[28px] bg-card p-6 md:p-8">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-lg font-bold">Check the details</h2>
            {job.data && <JobStatusBadge status={job.data.status} />}
          </div>
          <ol className="grid grid-cols-3 gap-2" aria-label="Progress">
            {STEPS.map((label, i) => {
              const doneStep = stage > i;
              const current = stage === i + 1 || (stage === 0 && i === 0);
              return (
                <li key={label} className="flex flex-col gap-1.5">
                  <span className={`h-1.5 rounded-full ${doneStep ? "bg-primary" : current && stage > 0 ? "animate-pulse bg-primary/50" : "bg-muted"}`} />
                  <span className={`text-xs ${doneStep ? "font-semibold" : "text-muted-foreground"}`}>{label}</span>
                </li>
              );
            })}
          </ol>

          {agentActive ? (
            note.isPending ? (
              <Working text="Reading your note and picking out the details… this can take up to a minute." />
            ) : note.isError ? (
              <ErrorState error={note.error} onRetry={() => lastNote && note.mutate(lastNote)} />
            ) : agentResult ? (
              <div className="flex flex-col gap-3">
                {quoteText && agentResult.status !== "no_events" && <Quote text={quoteText} label={lastNote && "rec" in lastNote ? "What was heard" : "Your note"} />}
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
              icon={<CheckCircle2 className="text-success" />}
              title="Saved to the site diary"
              description={done}
              action={
                <Button size="touch" onClick={reset}>
                  Add another note
                </Button>
              }
            />
          ) : upload.isError ? (
            <ErrorState error={upload.error} onRetry={() => lastInput && send(lastInput)} />
          ) : !jobId ? (
            <HowItWorks />
          ) : job.isError ? (
            <ErrorState error={job.error} onRetry={() => void job.refetch()} />
          ) : job.data?.status === "failed" ? (
            <div className="flex flex-col gap-2">
              <ErrorState error={new Error(job.data.error ?? "Processing failed")} />
              <Button size="touch" variant="outline" onClick={() => lastInput && send(lastInput)}>
                <RefreshCw aria-hidden /> Try again
              </Button>
            </div>
          ) : !indexedSource ? (
            <Working text="Turning your note into details…" />
          ) : proposals.isPending ? (
            <LoadingSkeleton rows={4} />
          ) : proposals.isError ? (
            <ErrorState error={proposals.error} onRetry={() => void proposals.refetch()} />
          ) : proposals.data.length === 0 ? (
            <EmptyState title="Nothing to check" description="No details could be picked out. Add more detail to the note and try again." />
          ) : (
            <ReviewForm key={proposals.data[0].source_id + jobId} proposal={proposals.data[0]} onDone={setDone} />
          )}
        </section>
      </div>

      <RecordingsList projectId={projectId} />
    </div>
  );
}

function Working({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Sparkles className="size-4 animate-pulse text-warning" aria-hidden /> {text}
      </p>
      <LoadingSkeleton rows={3} />
    </div>
  );
}

function Quote({ text, label }: { text: string; label: string }) {
  return (
    <blockquote className="rounded-2xl bg-muted/60 p-4 text-sm leading-relaxed">
      <span className="mb-1 block text-xs font-semibold text-muted-foreground">{label}</span>
      &ldquo;{text}&rdquo;
    </blockquote>
  );
}

const EXAMPLE = [
  { k: "Time", v: "10:00" },
  { k: "Machine", v: "EX-02" },
  { k: "Zone", v: "B" },
  { k: "Crew stopped", v: "3 workers" },
  { k: "Cause", v: "Hydraulic hose burst" },
  { k: "Source", v: "Voice note V01" },
];

function HowItWorks() {
  return (
    <div className="flex flex-col gap-5">
      <ol className="flex flex-col gap-3 text-sm">
        {[
          { Icon: Mic, t: "Speak or type", d: "One short note from the field. No forms." },
          { Icon: Sparkles, t: "SiteMate picks out the details", d: "Time, machine, zone, crew and cause, each linked to what you said." },
          { Icon: ShieldCheck, t: "You confirm", d: "Nothing is saved until you have checked it. Missing details are asked, never guessed." },
        ].map(({ Icon, t, d }, i) => (
          <li key={t} className="flex gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted">
              <Icon className="size-4" aria-hidden />
              <span className="sr-only">Step {i + 1}</span>
            </span>
            <span>
              <span className="block font-semibold">{t}</span>
              <span className="text-muted-foreground">{d}</span>
            </span>
          </li>
        ))}
      </ol>
      <div className="rounded-2xl border border-dashed p-4">
        <p className="mb-3 text-xs font-semibold tracking-wider text-muted-foreground uppercase">Example result</p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          {EXAMPLE.map(({ k, v }) => (
            <div key={k}>
              <dt className="text-xs text-muted-foreground">{k}</dt>
              <dd className="text-sm font-semibold">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
