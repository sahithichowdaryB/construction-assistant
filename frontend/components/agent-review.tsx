"use client";

import { CheckCircle2, Save, Send, Trash2, Undo2 } from "lucide-react";
import { useState } from "react";
import { EmptyState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { AgentEvent, AgentQuestion, AgentResult, ReviewDecision, ReviewFact, ReviewGap } from "@/lib/agent";
import { isoToLocalInput, localToIso, PROJECT_TZ, toIsoWithOffset } from "@/lib/time";

const label = (s: string) => s.replace(/_/g, " ");
const text = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
const gapKey = (g: ReviewGap) => `${g.event_index}:${g.field_name}`;
const isLong = (f: ReviewFact) => f.field_name === "summary" || f.field_name === "description" || text(f.value).length > 40;
const isTimeField = (field: string) => field.endsWith("_at");
// The agent normally names the field, but also catch questions that just ask "what time" or "which date".
const asksForTime = (q: AgentQuestion) => (q.field_name ? isTimeField(q.field_name) : false) || /\b(what time|at what time|when did|when was|which date|what date)\b/i.test(q.question);
const hint = (field: string) => (field.includes("count") || field.includes("minutes") ? "a number, e.g. 0" : "type it here, or leave empty");

/** Date and time picker in the project's time zone. The value is an ISO string with a UTC offset (or "" when empty). */
function DateTimeField({ id, value, onChange, disabled }: { id: string; value: string; onChange: (iso: string) => void; disabled?: boolean }) {
  const valid = value && !Number.isNaN(Date.parse(value));
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        id={id}
        type="datetime-local"
        value={valid ? isoToLocalInput(value) : ""}
        onChange={(e) => onChange(e.target.value ? localToIso(`${e.target.value}:00`) : "")}
        disabled={disabled}
        className="w-auto min-w-52"
        title={`Time in ${PROJECT_TZ}`}
      />
      <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onChange(toIsoWithOffset(new Date()))}>
        Now
      </Button>
      {value && !valid && <span className="text-xs text-amber-700">Not a date: “{value}”. Pick one.</span>}
    </div>
  );
}

function Events({ events }: { events: AgentEvent[] }) {
  if (!events.length) return null;
  return (
    <ul className="flex flex-col gap-1.5 text-sm">
      {events.map((e, i) => (
        <li key={i} className="rounded-md border bg-muted/40 p-2">
          <span className="mr-2 rounded bg-secondary px-1.5 py-0.5 text-xs font-medium">{label(e.event_type)}</span>
          {e.summary}
        </li>
      ))}
    </ul>
  );
}

/** The speaker's last look at the extracted facts. Nothing is written until they press Save. */
function FactsReview({
  events,
  facts,
  gaps,
  pending,
  onSubmit,
}: {
  events: AgentEvent[];
  facts: ReviewFact[];
  gaps: ReviewGap[];
  pending: boolean;
  onSubmit: (d: ReviewDecision) => void;
}) {
  const [values, setValues] = useState<Record<number, string>>(() => Object.fromEntries(facts.map((f) => [f.index, text(f.value)])));
  const [removed, setRemoved] = useState<Set<number>>(new Set());
  const [filled, setFilled] = useState<Record<string, string>>({});

  const toggle = (index: number) =>
    setRemoved((prev) => {
      const next = new Set(prev);
      if (!next.delete(index)) next.add(index);
      return next;
    });

  const save = () =>
    onSubmit({
      edits: facts.filter((f) => !removed.has(f.index) && values[f.index].trim() && values[f.index] !== text(f.value)).map((f) => ({ index: f.index, value: values[f.index] })),
      removed: [...removed],
      additions: gaps.filter((g) => filled[gapKey(g)]?.trim()).map((g) => ({ event_index: g.event_index, field_name: g.field_name, value: filled[gapKey(g)].trim() })),
    });

  const eventIndexes = [...new Set([...facts.map((f) => f.event_index), ...gaps.map((g) => g.event_index)])].sort((a, b) => a - b);
  const changed =
    facts.filter((f) => !removed.has(f.index) && values[f.index] !== text(f.value)).length + gaps.filter((g) => filled[gapKey(g)]?.trim()).length;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-sm font-medium">Check what was understood before it is saved</p>
        <p className="text-xs text-muted-foreground">
          Nothing is saved yet. Correct any value that is wrong and remove anything you did not say, then press Save.
        </p>
      </div>

      {eventIndexes.map((ei) => (
        <fieldset key={ei} className="flex flex-col gap-2 rounded-md border p-3">
          <legend className="px-1 text-sm font-medium">{events[ei] ? `${label(events[ei].event_type)}: ${events[ei].summary}` : `Event ${ei + 1}`}</legend>
          {facts
            .filter((f) => f.event_index === ei)
            .map((f) => {
              const gone = removed.has(f.index);
              return (
                <div key={f.index} className="grid grid-cols-[7.5rem_1fr_auto] items-center gap-2 text-sm">
                  <Label htmlFor={`fact-${f.index}`} className="font-normal text-muted-foreground">
                    {label(f.field_name)}
                  </Label>
                  {isTimeField(f.field_name) ? (
                    <DateTimeField id={`fact-${f.index}`} value={values[f.index]} onChange={(iso) => setValues((v) => ({ ...v, [f.index]: iso }))} disabled={gone || pending} />
                  ) : isLong(f) ? (
                    <Textarea
                      id={`fact-${f.index}`}
                      rows={3}
                      value={values[f.index]}
                      onChange={(e) => setValues((v) => ({ ...v, [f.index]: e.target.value }))}
                      disabled={gone || pending}
                      className={gone ? "line-through opacity-50" : undefined}
                    />
                  ) : (
                    <Input
                      id={`fact-${f.index}`}
                      value={values[f.index]}
                      onChange={(e) => setValues((v) => ({ ...v, [f.index]: e.target.value }))}
                      disabled={gone || pending}
                      className={gone ? "line-through opacity-50" : undefined}
                    />
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={pending}
                    onClick={() => toggle(f.index)}
                    aria-label={gone ? `Keep ${label(f.field_name)}` : `Remove ${label(f.field_name)}`}
                    title={f.basis === "inferred" ? "Inferred by the agent. You did not say this." : gone ? "Keep this" : "Remove this"}
                  >
                    {gone ? <Undo2 aria-hidden /> : <Trash2 aria-hidden />}
                  </Button>
                </div>
              );
            })}
          {gaps
            .filter((g) => g.event_index === ei)
            .map((g) => (
              <div key={gapKey(g)} className="grid grid-cols-[7.5rem_1fr] items-center gap-2 rounded-md bg-amber-50 p-2 text-sm dark:bg-amber-950/30">
                <Label htmlFor={`gap-${gapKey(g)}`} className="font-normal text-amber-900 dark:text-amber-200">
                  {label(g.field_name)} <span className="text-xs">(missing)</span>
                </Label>
                {isTimeField(g.field_name) ? (
                  <DateTimeField id={`gap-${gapKey(g)}`} value={filled[gapKey(g)] ?? ""} onChange={(iso) => setFilled((v) => ({ ...v, [gapKey(g)]: iso }))} disabled={pending} />
                ) : (
                  <Input
                    id={`gap-${gapKey(g)}`}
                    value={filled[gapKey(g)] ?? ""}
                    onChange={(e) => setFilled((v) => ({ ...v, [gapKey(g)]: e.target.value }))}
                    placeholder={hint(g.field_name)}
                    disabled={pending}
                  />
                )}
              </div>
            ))}
        </fieldset>
      ))}
      {facts.some((f) => f.basis === "inferred") && (
        <p className="text-xs text-muted-foreground">Values the agent worked out from the schedule (not stated by you) are marked “inferred” once saved.</p>
      )}
      {gaps.length > 0 && <p className="text-xs text-muted-foreground">Fields marked “missing” are required for this kind of note. Fill in what you know; anything left empty is saved as missing.</p>}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="touch" disabled={pending} onClick={() => onSubmit({ edits: [], removed: [], discard: true })}>
          Discard note
        </Button>
        <Button type="button" size="touch" disabled={pending} onClick={save}>
          <Save aria-hidden /> {pending ? "Saving…" : `Save to project${changed || removed.size ? ` (${changed} changed, ${removed.size} removed)` : ""}`}
        </Button>
      </div>
    </div>
  );
}

/** Shows what the capture agent extracted, asks its follow-up questions, lets the speaker review, and confirms the save. */
export function AgentReview({
  result,
  pending,
  onAnswer,
  onReview,
  onReset,
}: {
  result: AgentResult;
  pending: boolean;
  onAnswer: (answers: { id: string; answer: string }[]) => void;
  onReview: (decision: ReviewDecision) => void;
  onReset: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});

  if (result.status === "no_events") {
    return (
      <div className="flex flex-col gap-3">
        <EmptyState
          title="No site events found in that note"
          description="Nothing was saved. Check what was heard below: if it is wrong or unclear, record again, speaking close to the microphone, or type the note."
          action={<Button size="touch" onClick={onReset}>Try again</Button>}
        />
        <div className="rounded-md border bg-muted/40 p-3 text-sm">
          <p className="mb-1 text-xs font-medium text-muted-foreground">What was heard</p>
          <p className="whitespace-pre-line">{result.transcript || "(nothing)"}</p>
        </div>
      </div>
    );
  }

  if (result.status === "discarded") {
    return <EmptyState title="Note discarded" description="Nothing was saved." action={<Button size="touch" onClick={onReset}>Capture another</Button>} />;
  }

  if (result.status === "needs_review") {
    return <FactsReview key={result.thread_id} events={result.events} facts={result.facts} gaps={result.gaps} pending={pending} onSubmit={onReview} />;
  }

  if (result.status === "saved") {
    return (
      <div className="flex flex-col gap-4">
        <EmptyState
          icon={<CheckCircle2 className="text-emerald-600" />}
          title="Saved to the project"
          description={`${result.facts.length} fact${result.facts.length === 1 ? "" : "s"} saved as ${result.source_id}. You can find it under Your recordings.`}
          action={<Button size="touch" onClick={onReset}>Capture another</Button>}
        />
        <Events events={result.events} />
        {result.gaps.length > 0 && (
          <p className="text-sm text-amber-700">Still missing: {result.gaps.map((g) => label(g.field_name)).join(", ")}</p>
        )}
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        onAnswer(result.questions.map((q) => ({ id: q.id, answer: values[q.id]?.trim() || "unknown" })));
      }}
    >
      <Events events={result.events} />
      <p className="text-sm font-medium">A few details are missing (round {result.round})</p>
      {result.questions.map((q) => (
        <div key={q.id} className="flex flex-col gap-1.5">
          <Label htmlFor={`q-${q.id}`}>{q.question}</Label>
          {asksForTime(q) ? (
            <DateTimeField id={`q-${q.id}`} value={values[q.id] ?? ""} onChange={(iso) => setValues((v) => ({ ...v, [q.id]: iso }))} disabled={pending} />
          ) : (
            <Input
              id={`q-${q.id}`}
              value={values[q.id] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [q.id]: e.target.value }))}
              placeholder={q.options?.length ? `e.g. ${q.options.join(" / ")}` : "Answer, or leave blank for unknown"}
              disabled={pending}
            />
          )}
        </div>
      ))}
      <Button type="submit" size="touch" disabled={pending} className="self-end">
        <Send aria-hidden /> {pending ? "Checking…" : "Submit answers"}
      </Button>
    </form>
  );
}
