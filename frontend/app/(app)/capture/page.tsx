"use client";

import { ImagePlus, Keyboard, Megaphone, Send, X } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { AgentReview } from "@/components/agent-review";
import { MicButton, type Recording } from "@/components/mic-button";
import { useApp } from "@/components/providers/app-context";
import { EmptyState, ErrorState, LoadingSkeleton, PageHeader } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  answerQuestions,
  confirmCategories,
  submitCapture,
  type AddedEvent,
  type AgentResult,
  type CaptureInput,
  type CategoryDecision,
} from "@/lib/agent";
import { useCapturePrompts, useEventCategories, useInvalidateProject } from "@/lib/queries";
import { denyReason } from "@/lib/roles";

const MAX_IMAGES = 5;

const DEMO_NOTES = [
  { id: "L1", label: "Lift broken", text: "The goods lift in core A is not working, it is stuck between floors." },
  { id: "L2", label: "Lift again", text: "The lift is out again, nobody can get materials up to level 4." },
  { id: "L3", label: "Lift fixed", text: "The lift is working again, the mechanic finished at eleven." },
  { id: "V01", label: "Excavator", text: "The excavator broke down at ten. Hydraulic hose burst. Three workers can't continue digging in Zone B." },
];

export default function CapturePage() {
  const { role, projectId } = useApp();
  const blocked = denyReason(role, "capture");
  const invalidate = useInvalidateProject();
  const categories = useEventCategories();
  const prompts = useCapturePrompts();

  const [typing, setTyping] = useState(false);
  const [text, setText] = useState("");
  const [images, setImages] = useState<File[]>([]);
  const [agentResult, setAgentResult] = useState<AgentResult | null>(null);
  const [lastInput, setLastInput] = useState<CaptureInput | null>(null);

  const onResult = (r: AgentResult) => {
    setAgentResult(r);
    if (r.status === "saved") invalidate(); // new incidents and alerts exist now
  };
  // Voice, photos and typed text all go to the same agent. It replies with category suggestions to confirm.
  const capture = useMutation({ mutationFn: (input: CaptureInput) => submitCapture(projectId, input), onSuccess: onResult });
  const categoriesMut = useMutation({
    mutationFn: (v: { decisions: CategoryDecision[]; added: AddedEvent[] }) => {
      if (agentResult?.status !== "needs_category") throw new Error("No capture is waiting for categories");
      return confirmCategories(projectId, agentResult.thread_id, v.decisions, v.added);
    },
    onSuccess: onResult,
  });
  const answers = useMutation({
    mutationFn: (a: { id: string; answer: string }[]) => {
      if (agentResult?.status !== "needs_input") throw new Error("No capture is waiting for answers");
      return answerQuestions(projectId, agentResult.thread_id, a);
    },
    onSuccess: onResult,
  });
  const busy = capture.isPending || categoriesMut.isPending || answers.isPending;

  const send = (input: CaptureInput) => {
    setLastInput(input);
    capture.mutate(input);
  };
  const submitRecording = (rec: Recording) =>
    send({ audio: { blob: rec.blob, filename: `note.${rec.mimeType.includes("mp4") ? "m4a" : "webm"}` }, text, images });

  const reset = () => {
    setText("");
    setImages([]);
    setAgentResult(null);
    capture.reset();
    categoriesMut.reset();
    answers.reset();
  };

  const addImages = (files: FileList | null) => {
    if (!files) return;
    setImages((cur) => [...cur, ...Array.from(files).filter((f) => f.type.startsWith("image/"))].slice(0, MAX_IMAGES));
  };

  const canSubmit = !blocked && !busy && (text.trim().length > 0 || images.length > 0);

  return (
    <>
      <PageHeader title="Capture" description="Record, photograph or type what happened. The AI suggests a category; you choose the final one before anything is saved." />

      {prompts.data && prompts.data.length > 0 && (
        <Card className="mb-4 border-amber-300 bg-amber-50/60">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Megaphone className="size-4" aria-hidden /> Evidence requested
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-2 text-sm">
              {prompts.data.map((p) => (
                <li key={p.id}>
                  <span className="font-medium">{p.title}</span>
                  {p.incident_id && (
                    <>
                      {" "}
                      for{" "}
                      <Link className="underline" href={`/incidents/${p.incident_id}`}>
                        {p.incident_title ?? "the incident"}
                      </Link>
                    </>
                  )}
                  {p.rationale && <p className="text-xs text-muted-foreground">{p.rationale}</p>}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>New site report</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <MicButton onSubmit={submitRecording} disabled={!!blocked || busy} disabledReason={blocked} />

            <div className="flex flex-wrap justify-center gap-2">
              <Button variant={typing ? "secondary" : "outline"} size="touch" onClick={() => setTyping((t) => !t)} aria-expanded={typing}>
                <Keyboard aria-hidden /> Type instead
              </Button>
              <Button variant="outline" size="touch" asChild>
                <label className={blocked || images.length >= MAX_IMAGES ? "pointer-events-none opacity-50" : "cursor-pointer"}>
                  <ImagePlus aria-hidden /> Add photos ({images.length}/{MAX_IMAGES})
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif"
                    multiple
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

            {images.length > 0 && (
              <ul className="flex flex-wrap gap-2" aria-label="Attached photos">
                {images.map((f, i) => (
                  <li key={`${f.name}-${i}`} className="relative">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={URL.createObjectURL(f)} alt={f.name} className="size-20 rounded-md border object-cover" onLoad={(e) => URL.revokeObjectURL(e.currentTarget.src)} />
                    <button
                      type="button"
                      className="absolute -top-2 -right-2 flex size-6 items-center justify-center rounded-full border bg-background shadow"
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
                className="flex flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (canSubmit) send({ text, images });
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
                <Button type="submit" size="touch" disabled={!canSubmit} className="self-end">
                  <Send aria-hidden /> Submit report
                </Button>
              </form>
            )}
            {!typing && !text && images.length > 0 && (
              <Button size="touch" onClick={() => send({ images })} disabled={!canSubmit}>
                <Send aria-hidden /> Submit {images.length === 1 ? "photo" : "photos"}
              </Button>
            )}
          </CardContent>
        </Card>

        <Card aria-live="polite">
          <CardHeader>
            <CardTitle>Review</CardTitle>
          </CardHeader>
          <CardContent>
            {capture.isPending ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-muted-foreground">Listening, looking and classifying… this can take up to a minute.</p>
                <LoadingSkeleton rows={3} />
              </div>
            ) : capture.isError ? (
              <ErrorState error={capture.error} onRetry={lastInput ? () => capture.mutate(lastInput) : undefined} />
            ) : agentResult ? (
              <div className="flex flex-col gap-3">
                {categoriesMut.isError && <ErrorState error={categoriesMut.error} />}
                {answers.isError && <ErrorState error={answers.error} />}
                <AgentReview
                  result={agentResult}
                  categories={categories.data}
                  pending={busy}
                  onConfirmCategories={(decisions, added) => categoriesMut.mutate({ decisions, added })}
                  onAnswer={(a) => answers.mutate(a)}
                  onReset={reset}
                />
                {agentResult.status === "needs_category" && categories.isError && <ErrorState error={categories.error} onRetry={() => void categories.refetch()} />}
              </div>
            ) : (
              <EmptyState title="Nothing submitted yet" description="Record, photograph or type a report. The events it contains appear here with a suggested category to confirm." />
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
