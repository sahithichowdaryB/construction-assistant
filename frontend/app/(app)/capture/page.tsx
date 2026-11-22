"use client";

import { Camera, Keyboard, Megaphone, Send, ShieldCheck, Sparkles, X } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { AgentReview, SavedNoteDetails } from "@/components/agent-review";
import { MicButton, type Recording } from "@/components/mic-button";
import { useApp } from "@/components/providers/app-context";
import { RECORDINGS_KEY, RecordingsList } from "@/components/recordings-list";
import { ErrorState, LoadingSkeleton } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  answerQuestions,
  confirmCategories,
  submitCapture,
  submitReview,
  type AddedEvent,
  type AgentResult,
  type CaptureInput,
  type CategoryDecision,
  type ReviewDecision,
} from "@/lib/agent";
import { useCapturePrompts, useEventCategories, useInvalidateProject } from "@/lib/queries";
import { denyReason } from "@/lib/roles";
import { useSession } from "@/lib/auth";
import { AUTH_REQUIRED } from "@/lib/session";

const MAX_IMAGES = 5;
const PHOTO_TYPES: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif",
};
const acceptedPhotoTypes = new Set(Object.values(PHOTO_TYPES));

const DEMO_NOTES = [
  { id: "L1", label: "Lift broken", text: "The goods lift in core A is not working, it is stuck between floors." },
  { id: "L2", label: "Lift again", text: "The lift is out again, nobody can get materials up to level 4." },
  { id: "L3", label: "Lift fixed", text: "The lift is working again, the mechanic finished at eleven." },
  { id: "V01", label: "Excavator", text: "The excavator broke down at ten. Hydraulic hose burst. Three workers can't continue digging in Zone B." },
];

// Recordings need a speech-to-text service behind the API (WHISPER_BASE_URL or OPENAI_API_KEY in backend/.env).
// Until then the mic is disabled and notes are typed or dictated. Set NEXT_PUBLIC_VOICE_TRANSCRIPTION=true to enable it.
const VOICE_READY = process.env.NEXT_PUBLIC_VOICE_TRANSCRIPTION === "true";
const VOICE_OFF_REASON = "Voice recording isn't set up. Tap “Type instead” and dictate (Mac: press the dictation key).";

export default function CapturePage() {
  const { role, projectId } = useApp();
  const session = useSession();
  const canCapture = AUTH_REQUIRED
    ? session.data?.memberships.some((m) => m.project_id === projectId && (m.role === "contributor" || m.role === "manager"))
    : role === "foreman" || role === "site_manager";
  if (AUTH_REQUIRED && session.isPending) return <LoadingSkeleton rows={2} />;
  if (!canCapture) return <p>Only foremen and site managers can add site notes.</p>;
  return <ForemanCapture />;
}

function ForemanCapture() {
  const { role, projectId } = useApp();
  const blocked = denyReason(role, "capture");
  const micBlocked = blocked ?? (VOICE_READY ? null : VOICE_OFF_REASON);
  const queryClient = useQueryClient();
  const invalidateProject = useInvalidateProject();
  const categories = useEventCategories();
  const prompts = useCapturePrompts();

  const [typing, setTyping] = useState(!VOICE_READY);
  const [text, setText] = useState("");
  const [images, setImages] = useState<File[]>([]);
  const [photoError, setPhotoError] = useState("");
  const [agentResult, setAgentResult] = useState<AgentResult | null>(null);
  const [lastInput, setLastInput] = useState<CaptureInput | null>(null);
  const [micKey, setMicKey] = useState(0);
  const [wasRecorded, setWasRecorded] = useState(false);

  const clearComposer = () => {
    setText("");
    setImages([]);
    setPhotoError("");
    setTyping(!VOICE_READY);
    setLastInput(null);
    setMicKey((key) => key + 1);
  };

  const showResult = (r: AgentResult) => {
    setAgentResult(r);
    if (r.status === "saved") {
      void queryClient.invalidateQueries({ queryKey: RECORDINGS_KEY(projectId) });
      invalidateProject(); // new incidents and alerts exist now
    }
  };

  // Voice, photos and typed text all go to the same pipeline: suggested categories -> questions -> your review -> saved.
  const capture = useMutation({
    mutationFn: (input: CaptureInput) => submitCapture(projectId, input),
    onSuccess: (result, input) => {
      clearComposer();
      setWasRecorded(!!input.audio);
      showResult(result);
    },
  });
  const categoriesMut = useMutation({
    mutationFn: (v: { decisions: CategoryDecision[]; added: AddedEvent[] }) => {
      if (agentResult?.status !== "needs_category") throw new Error("No capture is waiting for categories");
      return confirmCategories(projectId, agentResult.thread_id, v.decisions, v.added);
    },
    onSuccess: showResult,
  });
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

  const stepPending = categoriesMut.isPending || answers.isPending || review.isPending;
  const busy = capture.isPending || stepPending;
  const send = (input: CaptureInput) => {
    if (busy) return;
    setAgentResult(null);
    categoriesMut.reset();
    answers.reset();
    review.reset();
    setLastInput(input);
    capture.mutate(input);
  };
  const submitRecording = (rec: Recording) =>
    send({ audio: { blob: rec.blob, filename: `note.${rec.mimeType.includes("mp4") ? "m4a" : "webm"}` }, images });

  const reset = () => {
    clearComposer();
    setAgentResult(null);
    capture.reset();
    categoriesMut.reset();
    answers.reset();
    review.reset();
  };
  const addImages = (files: FileList | null) => {
    if (!files?.length) return;
    // FileList is live. Copy the selection before the change handler clears the input.
    const selected = Array.from(files);
    const attachments: File[] = [];
    const errors: string[] = [];
    for (const file of selected) {
      const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
      const mime = file.type && file.type !== "application/octet-stream"
        ? file.type
        : PHOTO_TYPES[extension];
      if (!acceptedPhotoTypes.has(mime)) {
        errors.push("Choose a JPEG, PNG, WebP or GIF photo.");
      } else if (!file.size || file.size > 5 * 1024 * 1024) {
        errors.push(file.size ? "Choose a photo of 5 MB or less." : "The camera returned an empty photo. Take it again.");
      } else {
        attachments.push(mime === file.type ? file : new File([file], file.name, { type: mime, lastModified: file.lastModified }));
      }
    }
    setPhotoError([...new Set(errors)].join(" "));
    setImages((cur) => [...cur, ...attachments].slice(0, MAX_IMAGES));
  };

  const canSubmit = !blocked && !busy && (text.trim().length > 0 || images.length > 0);
  const quoteText = agentResult && "transcript" in agentResult && agentResult.transcript ? agentResult.transcript : "";
  const finished = agentResult?.status === "saved";
  const reviewing = !!agentResult && !finished && agentResult.status !== "discarded" && agentResult.status !== "no_events";
  const stage = reviewing ? 2 : capture.isPending ? 1 : 0;
  const STEPS = ["Note sent", "Details picked out", "You confirm"];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold md:text-[28px]">Site notes</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Record a voice note, type a note or add photos. Check the details before saving to the site diary.
        </p>
      </div>

      {prompts.data && prompts.data.length > 0 && (
        <section aria-label="Evidence requested" className="rounded-2xl bg-warning/10 p-4">
          <p className="flex items-center gap-2 text-sm font-bold">
            <Megaphone className="size-4" aria-hidden /> Evidence requested
          </p>
          <ul className="mt-2 flex flex-col gap-2 text-sm">
            {prompts.data.map((p) => (
              <li key={p.id}>
                <span className="font-semibold">{p.title}</span>
                {p.incident_id && (
                  <>
                    {" "}
                    for{" "}
                    <Link className="underline" href={`/incidents/${p.incident_id}`}>
                      {p.incident_title ?? "the incident"}
                    </Link>
                  </>
                )}
                {p.rationale && <span className="block text-xs text-muted-foreground">{p.rationale}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
        {/* Capture */}
        <fieldset aria-label="New note" disabled={busy || reviewing} className="relative flex min-w-0 flex-col gap-6 overflow-hidden rounded-[28px] bg-hero p-6 text-hero-foreground md:p-8">
          <div>
            <p className="inline-flex items-center gap-2 text-sm font-semibold text-primary">
              <span className="size-2 rounded-full bg-primary" aria-hidden /> New site note
            </p>
            <h2 className="mt-2 text-2xl font-bold">What happened on site?</h2>
            <p className="mt-1 text-sm text-hero-muted">Describe what happened, where, when, and who was affected.</p>
          </div>

          <MicButton key={micKey} onSubmit={submitRecording} disabled={!!micBlocked || busy || reviewing} disabledReason={reviewing ? "Finish checking your current note below." : micBlocked} />

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
              <label className={blocked || images.length >= MAX_IMAGES ? "pointer-events-none opacity-50" : "cursor-pointer"}>
                <Camera aria-hidden /> Add photos ({images.length}/{MAX_IMAGES})
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  multiple
                  className="sr-only"
                  disabled={!!blocked || images.length >= MAX_IMAGES}
                  onChange={(e) => {
                    addImages(e.target.files);
                    e.target.value = "";
                  }}
                />
              </label>
            </Button>
            <Button variant="ghost" size="touch" className="rounded-xl bg-white/10 text-white hover:bg-white/15 hover:text-white md:hidden" asChild>
              <label className={blocked || images.length >= MAX_IMAGES ? "pointer-events-none opacity-50" : "cursor-pointer"}>
                <Camera aria-hidden /> Take photo
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="sr-only"
                  disabled={!!blocked || images.length >= MAX_IMAGES}
                  onChange={(e) => {
                    addImages(e.target.files);
                    e.target.value = "";
                  }}
                />
              </label>
            </Button>
          </div>

          {photoError && <p role="alert" className="text-sm text-hero-foreground">{photoError}</p>}
          {images.length > 0 && (
            <ul className="flex flex-wrap gap-2" aria-label="Attached photos">
              {images.map((f, i) => (
                <li key={`${f.name}-${i}`} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={URL.createObjectURL(f)} alt={f.name} className="size-20 rounded-2xl object-cover" onLoad={(e) => URL.revokeObjectURL(e.currentTarget.src)} />
                  <button
                    type="button"
                    className="absolute -top-2 -right-2 flex size-6 items-center justify-center rounded-full bg-white text-[#111214] shadow"
                    aria-label={`Remove ${f.name}`}
                    onClick={() => setImages((cur) => cur.filter((_, n) => n !== i))}
                  >
                    <X className="size-3.5" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {(typing || text) && (
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (canSubmit) send({ text, images });
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
                placeholder="The goods lift in core A has stopped between floors, nobody can get materials up…"
                disabled={!!blocked}
                className="rounded-2xl border-white/10 bg-white/5 text-[15px] text-white placeholder:text-white/40 focus-visible:border-primary dark:bg-white/5"
              />
              <div className="flex flex-col gap-2">
                <p className="text-xs font-medium text-hero-muted">Try a note</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {DEMO_NOTES.map((n) => (
                    <button
                      key={n.id}
                      type="button"
                      onClick={() => setText(n.text)}
                      disabled={!!blocked}
                      className="rounded-2xl bg-white/5 p-3 text-left text-xs leading-relaxed text-white/80 ring-1 ring-white/10 transition hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
                    >
                      <span className="mb-1 block font-mono text-[11px] font-semibold text-primary">{n.label}</span>
                      <span className="line-clamp-2">{n.text}</span>
                    </button>
                  ))}
                </div>
              </div>
              <Button type="submit" size="touch" disabled={!canSubmit} className="h-12 self-end rounded-2xl px-5 md:h-12">
                <Send aria-hidden /> Send note
              </Button>
            </form>
          )}
          {!typing && !text && images.length > 0 && (
            <Button size="touch" className="h-12 rounded-2xl md:h-12" onClick={() => send({ images })} disabled={!canSubmit}>
              <Send aria-hidden /> Send {images.length === 1 ? "photo" : "photos"}
            </Button>
          )}
        </fieldset>

        {/* Check */}
        <section aria-label="Check the details" aria-live="polite" className="flex min-w-0 flex-col gap-5 rounded-[28px] bg-card p-4 [overflow-wrap:anywhere] sm:p-6 md:p-8">
          <h2 className="text-lg font-bold">Check the details</h2>
          <ol className="grid grid-cols-3 gap-2" aria-label="Progress">
            {STEPS.map((label, i) => {
              const doneStep = stage > i;
              const current = stage > 0 && i === stage;
              return (
                <li key={label} aria-current={current ? "step" : undefined} className="flex flex-col gap-1.5">
                  <span className={`h-1.5 rounded-full ${doneStep ? "bg-primary" : current ? "animate-pulse bg-primary/50" : "bg-muted"}`} />
                  <span className={`text-xs ${doneStep ? "font-semibold" : "text-muted-foreground"}`}>{label}</span>
                </li>
              );
            })}
          </ol>

          {capture.isPending ? (
            <Working text={[
              lastInput?.audio && "Transcribing your recording.",
              !!lastInput?.images?.length && "Reading your photos.",
              "Picking out site events for you to check.",
            ].filter(Boolean).join(" ")} />
          ) : capture.isError ? (
            <ErrorState error={capture.error} onRetry={lastInput ? () => capture.mutate(lastInput) : undefined} />
          ) : finished ? (
            <div role="status" className="rounded-xl border p-3 text-sm">
              <p className="font-semibold">Saved to the project. Ready for your next note.</p>
              {role === "foreman" && <Link className="underline" href="/foreman/reports">View My reports</Link>}
              <details className="mt-2">
                <summary className="cursor-pointer">Last saved note</summary>
                <SavedNoteDetails result={agentResult} />
              </details>
            </div>
          ) : agentResult ? (
            <div className="flex flex-col gap-3">
              {quoteText && agentResult.status !== "no_events" && agentResult.status !== "needs_category" && (
                <Quote text={quoteText} label={wasRecorded ? "What was heard" : "Your note"} />
              )}
              {(categoriesMut.isError || answers.isError || review.isError) && <ErrorState error={categoriesMut.error ?? answers.error ?? review.error} />}
              <AgentReview
                key={agentResult.status === "needs_input" ? `${agentResult.thread_id}-${agentResult.round}` : agentResult.status}
                result={agentResult}
                categories={categories.data}
                pending={stepPending}
                onConfirmCategories={(decisions, added) => categoriesMut.mutate({ decisions, added })}
                onAnswer={(a) => answers.mutate(a)}
                onReview={(d) => review.mutate(d)}
                onReset={reset}
              />
              {reviewing && <Button variant="ghost" size="sm" disabled={busy} onClick={reset}>Leave review and start another note</Button>}
              {agentResult.status === "needs_category" && categories.isError && <ErrorState error={categories.error} onRetry={() => void categories.refetch()} />}
            </div>
          ) : (
            <HowItWorks />
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
          { Icon: Keyboard, t: "Add a site note", d: "Describe what happened on site." },
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
