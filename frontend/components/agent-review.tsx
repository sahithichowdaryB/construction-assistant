"use client";

import { CheckCircle2, Send } from "lucide-react";
import { useState } from "react";
import { EmptyState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AgentEvent, AgentResult } from "@/lib/agent";

function Events({ events }: { events: AgentEvent[] }) {
  if (!events.length) return null;
  return (
    <ul className="flex flex-col gap-1.5 text-sm">
      {events.map((e, i) => (
        <li key={i} className="rounded-md border bg-muted/40 p-2">
          <span className="mr-2 rounded bg-secondary px-1.5 py-0.5 text-xs font-medium">{e.event_type.replace(/_/g, " ")}</span>
          {e.summary}
        </li>
      ))}
    </ul>
  );
}

/** Shows what the capture agent extracted, asks its follow-up questions, and confirms what was saved. */
export function AgentReview({
  result,
  pending,
  onAnswer,
  onReset,
}: {
  result: AgentResult;
  pending: boolean;
  onAnswer: (answers: { id: string; answer: string }[]) => void;
  onReset: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});

  if (result.status === "no_events") {
    return <EmptyState title="No events found" description="The agent could not find anything to record in that note. Add more detail and try again." action={<Button size="touch" onClick={onReset}>Try again</Button>} />;
  }

  if (result.status === "saved") {
    return (
      <div className="flex flex-col gap-4">
        <EmptyState
          icon={<CheckCircle2 className="text-emerald-600" />}
          title="Captured"
          description={`Saved ${result.facts.length} proposed fact${result.facts.length === 1 ? "" : "s"} as ${result.source_id}. A person still confirms them.`}
          action={<Button size="touch" onClick={onReset}>Capture another</Button>}
        />
        <Events events={result.events} />
        {result.facts.length > 0 && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            {result.facts.map((f) => (
              <div key={f.id} className="contents">
                <dt className="text-muted-foreground">{f.field_name.replace(/_/g, " ")}</dt>
                <dd>
                  {f.value} <span className="text-xs text-muted-foreground">({f.basis})</span>
                </dd>
              </div>
            ))}
          </dl>
        )}
        {result.gaps.length > 0 && (
          <p className="text-sm text-amber-700">Still missing: {result.gaps.map((g) => g.field_name.replace(/_/g, " ")).join(", ")}</p>
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
          <Input
            id={`q-${q.id}`}
            value={values[q.id] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [q.id]: e.target.value }))}
            placeholder={q.options?.length ? `e.g. ${q.options.join(" / ")}` : "Answer, or leave blank for unknown"}
            disabled={pending}
          />
        </div>
      ))}
      <Button type="submit" size="touch" disabled={pending} className="self-end">
        <Send aria-hidden /> {pending ? "Saving…" : "Submit answers"}
      </Button>
    </form>
  );
}
