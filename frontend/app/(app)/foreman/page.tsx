"use client";

import { CheckCircle2, ClipboardPen, Clock, Info, RotateCcw, Truck } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { CitationChip } from "@/components/citation-chip";
import { GatedButton } from "@/components/gated-button";
import { useApp } from "@/components/providers/app-context";
import { ErrorState, LoadingSkeleton, PageHeader } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { fmtQty } from "@/lib/format";
import { denyReason } from "@/lib/roles";
import { fmtDateTime, fmtLocalDate, localDateOf } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useConfirmNote, useRecordNote, useSiteDay, type DayActivity, type FieldNote } from "@/lib/workflow";

function Steps({ step }: { step: 1 | 2 | 3 }) {
  const items = ["Record the note", "Check the facts", "Confirmed"];
  return (
    <ol className="mb-5 flex flex-wrap items-center gap-2 text-xs font-medium sm:text-sm" aria-label="Progress">
      {items.map((label, i) => {
        const n = i + 1;
        const state = n < step ? "done" : n === step ? "current" : "todo";
        return (
          <li key={label} className="flex items-center gap-2" aria-current={state === "current" ? "step" : undefined}>
            <span
              className={cn(
                "flex size-6 items-center justify-center rounded-full text-[11px] font-bold",
                state === "done" && "bg-emerald-600 text-white",
                state === "current" && "bg-primary text-primary-foreground",
                state === "todo" && "bg-muted text-muted-foreground",
              )}
            >
              {state === "done" ? "✓" : n}
            </span>
            <span className={cn(state === "todo" && "text-muted-foreground")}>{label}</span>
            {n < items.length && <span className="h-px w-5 bg-border sm:w-10" aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}

/** The day's planned work from the programme: the foreman picks what the problem affects. */
function ActivityPicker({
  activities,
  value,
  onChange,
}: {
  activities: DayActivity[];
  value: string | null;
  onChange: (code: string | null) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium">Which work is affected?</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {activities.map((a) => {
          const active = value === a.code;
          return (
            <button
              key={a.code}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(active ? null : a.code)}
              className={cn(
                "flex flex-col gap-1 rounded-xl border bg-background p-3 text-left text-sm transition-colors hover:border-foreground/30",
                active && "border-primary bg-primary/10 ring-1 ring-primary",
              )}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="font-semibold">{a.name}</span>
                <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{a.code}</span>
              </span>
              <span className="text-xs text-muted-foreground">
                Plan {fmtQty(a.planned, a.unit)}
                {a.contractor ? ` · ${a.contractor}` : ""}
              </span>
              {!!a.equipment.length && (
                <span className="flex flex-wrap gap-1 text-[11px] text-muted-foreground">
                  {a.equipment.map((e) => (
                    <span key={e.id} className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5">
                      <Truck className="size-3" aria-hidden /> {e.id} {e.description}
                    </span>
                  ))}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">Not sure? Leave it empty: SiteMate matches the machine you name to the equipment register.</p>
    </fieldset>
  );
}

function FactList({ note }: { note: FieldNote }) {
  return (
    <dl className="divide-y rounded-xl border">
      {note.facts
        .filter((f) => f.field !== "summary")
        .map((f) => (
          <div key={f.id} className="grid gap-1 px-4 py-3 sm:grid-cols-[10rem_minmax(0,1fr)_auto] sm:items-center sm:gap-4">
            <dt className="text-xs font-medium text-muted-foreground">{f.label}</dt>
            <dd className="text-sm font-semibold">{f.display}</dd>
            <dd className="flex flex-wrap items-center gap-1.5">
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset",
                  f.basis === "inferred" ? "bg-sky-50 text-sky-900 ring-sky-200" : "bg-muted text-foreground ring-border",
                )}
                title={f.basis === "inferred" ? "Not in the note itself: worked out from the project records" : "Stated by you"}
              >
                {f.basis === "inferred" ? "From records" : "From you"}
              </span>
              {f.refs.map((r) => (
                <CitationChip key={r.passage_id} refData={r} />
              ))}
            </dd>
          </div>
        ))}
    </dl>
  );
}

export default function ForemanPage() {
  const { role, asOf } = useApp();
  const blocked = denyReason(role, "capture");
  const today = localDateOf(asOf);
  const day = useSiteDay(today);
  const [text, setText] = useState("");
  const [activity, setActivity] = useState<string | null>(null);
  const record = useRecordNote();
  const confirm = useConfirmNote();
  const note = record.data ?? null;
  const [lastReported, setLastReported] = useState<string | null>(null);
  const step = note ? 2 : 1;
  const planned = day.data?.activities ?? [];
  const picked = planned.find((a) => a.code === activity);

  const reset = () => {
    record.reset();
    confirm.reset();
    setText("");
    setActivity(null);
  };
  const mention = (words: string) => setText((t) => (t.trim() ? `${t.trim()} ${words}` : words));
  const finish = (reported: FieldNote) => {
    if (reported.status !== "confirmed") return;
    setLastReported(reported.source_id);
    reset();
  };

  return (
    <>
      <PageHeader
        title="Report a problem"
        description={`${fmtLocalDate(today)} on site. Say what happened in your own words; SiteMate pulls out the facts and you confirm them.`}
      />
      <Steps step={step} />
      {lastReported && <p role="status" className="mb-4 text-sm">Report {lastReported} confirmed. <Link className="underline" href="/foreman/reports">View My reports</Link></p>}
      <Link href="/capture" className="mb-4 inline-block text-sm font-medium underline">Record a voice note or attach a photo</Link>

      <div className="grid items-start gap-5 max-w-3xl">
        <section className="rounded-2xl border bg-card p-5 shadow-xs" aria-labelledby="note-title">
          {step === 1 && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (text.trim()) {
                  setLastReported(null);
                  record.mutate({ text: text.trim(), activity_code: activity }, { onSuccess: finish });
                }
              }}
              className="flex flex-col gap-5"
            >
              <div className="flex items-center gap-2">
                <ClipboardPen className="size-5 text-muted-foreground" aria-hidden />
                <h2 id="note-title" className="text-base font-semibold">
                  New site note
                </h2>
              </div>

              {day.isPending ? (
                <LoadingSkeleton rows={2} />
              ) : day.isError ? (
                <ErrorState error={day.error} onRetry={() => void day.refetch()} />
              ) : planned.length ? (
                <ActivityPicker activities={planned} value={activity} onChange={setActivity} />
              ) : (
                <p className="rounded-xl border border-dashed p-3 text-sm text-muted-foreground">
                  No work is planned in the programme for {fmtLocalDate(today)}. You can still record a note.
                </p>
              )}

              <div className="flex flex-col gap-2">
                <label htmlFor="note-text" className="text-sm font-medium">
                  What happened?
                </label>
                <Textarea
                  id="note-text"
                  placeholder="What happened, when, and who or what is affected"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={4}
                  maxLength={2000}
                  className="min-h-28 text-base"
                  disabled={!!blocked}
                />
                {!!picked?.equipment.length && (
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="text-muted-foreground">Mention a machine:</span>
                    {picked.equipment.map((e) => (
                      <button
                        key={e.id}
                        type="button"
                        onClick={() => mention(`${e.description} ${e.id}`)}
                        className="inline-flex items-center gap-1 rounded-full border bg-muted/40 px-2.5 py-1 hover:bg-muted"
                      >
                        <Truck className="size-3" aria-hidden /> {e.id} · {e.description}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Clock className="size-3.5" aria-hidden /> Recorded at {fmtDateTime(asOf)} on the project clock.
              </p>
              <GatedButton type="submit" reason={blocked} size="touch" disabled={!text.trim() || record.isPending} className="self-start">
                {record.isPending ? "Reading your note…" : "Record note"}
              </GatedButton>
              {record.isError && <ErrorState error={record.error} />}
            </form>
          )}

          {note && (
            <div className="flex flex-col gap-4">
              <div>
                <h2 className="text-base font-semibold">Check what SiteMate understood</h2>
                <p className="text-sm text-muted-foreground">
                  Note {note.source_id} · {fmtDateTime(note.recorded_at)} · {note.author}
                </p>
              </div>
              <blockquote className="rounded-xl border-l-4 border-primary bg-muted/40 px-4 py-3 text-sm">“{note.text}”</blockquote>
              <FactList note={note} />
              {step === 2 && (
                <>
                  {note.facts.some((f) => f.basis === "inferred") && (
                    <p className="flex gap-1.5 text-xs text-muted-foreground">
                      <Info className="mt-px size-3.5 shrink-0" aria-hidden />
                      “From records” values are not in your note. They come from the equipment register. Check them before you confirm.
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <GatedButton reason={denyReason(role, "confirm_capture")} size="touch" disabled={confirm.isPending} onClick={() => confirm.mutate(note.source_id, { onSuccess: finish })}>
                      <CheckCircle2 aria-hidden /> {confirm.isPending ? "Confirming…" : "Confirm"}
                    </GatedButton>
                    <Button variant="outline" size="touch" disabled={confirm.isPending} onClick={reset}>
                      <RotateCcw aria-hidden /> Start again
                    </Button>
                  </div>
                  {confirm.isError && <ErrorState error={confirm.error} />}
                </>
              )}
            </div>
          )}
        </section>


      </div>
    </>
  );
}
