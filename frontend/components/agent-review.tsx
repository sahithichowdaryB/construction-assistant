"use client";

import { CheckCircle2, Send } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { CategoryPicker } from "@/components/category-picker";
import { EmptyState, LoadingSkeleton } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AddedEvent, AgentEvent, AgentResult, CategoryDecision, IncidentLinkResult } from "@/lib/agent";
import type { EventCategory } from "@/lib/types";

const ordinal = (n: number) => {
  const v = n % 100;
  const s = ["th", "st", "nd", "rd"];
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};

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

/** What happened to each event: opened a new incident, joined an existing one, or recorded an update. */
function IncidentLinks({ links }: { links: IncidentLinkResult[] }) {
  if (!links.length) return <p className="text-sm text-muted-foreground">Saved as diary notes and facts. No incident was raised.</p>;
  return (
    <ul className="flex flex-col gap-1.5 text-sm">
      {links.map((l) => {
        const where = (
          <Link className="font-medium underline" href={`/incidents/${l.incident_id}`}>
            {l.title}
          </Link>
        );
        return (
          <li key={l.event_index} className="rounded-md border p-2">
            {l.created ? (
              <>Opened a new incident: {where}</>
            ) : l.link_type === "resolution" ? (
              <>Recorded as a repair update on {where}. It is now being monitored until a manager confirms.</>
            ) : l.link_type === "update" ? (
              <>Added an update to {where}</>
            ) : (
              <>
                Linked to existing incident {where} ({ordinal(l.report_count)} report from {l.reporter_count}{" "}
                {l.reporter_count === 1 ? "person" : "people"})
              </>
            )}
            <span className="ml-2 text-xs text-muted-foreground">Severity {l.severity}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** Shows the AI's category suggestions for confirmation, asks its follow-up questions, and reports what was saved. */
export function AgentReview({
  result,
  categories,
  pending,
  onConfirmCategories,
  onAnswer,
  onReset,
}: {
  result: AgentResult;
  categories: EventCategory[] | undefined;
  pending: boolean;
  onConfirmCategories: (decisions: CategoryDecision[], added: AddedEvent[]) => void;
  onAnswer: (answers: { id: string; answer: string }[]) => void;
  onReset: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});

  if (result.status === "no_events") {
    return <EmptyState title="No events found" description="Nothing is left to record from that capture. Add more detail and try again." action={<Button size="touch" onClick={onReset}>Try again</Button>} />;
  }

  if (result.status === "needs_category") {
    if (!categories) return <LoadingSkeleton rows={3} />;
    return (
      <div className="flex flex-col gap-3">
        {result.photo_descriptions.length > 0 && (
          <ul className="flex flex-col gap-1 rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">
            {result.photo_descriptions.map((p) => (
              <li key={p.n}>
                <span className="font-medium text-foreground">Photo {p.n}:</span> {p.passage}
              </li>
            ))}
          </ul>
        )}
        <CategoryPicker key={result.thread_id} events={result.events} categories={categories} pending={pending} onConfirm={onConfirmCategories} />
      </div>
    );
  }

  if (result.status === "saved") {
    return (
      <div className="flex flex-col gap-4">
        <EmptyState
          icon={<CheckCircle2 className="text-emerald-600" />}
          title="Captured"
          description={`Saved ${result.events.length} event${result.events.length === 1 ? "" : "s"} and ${result.facts.length} proposed fact${result.facts.length === 1 ? "" : "s"} as ${result.source_id}. A person still confirms the facts.`}
          action={<Button size="touch" onClick={onReset}>Capture another</Button>}
        />
        <IncidentLinks links={result.incident_links ?? []} />
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
