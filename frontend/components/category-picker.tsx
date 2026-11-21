"use client";

import { Plus, Sparkles, Trash2, Undo2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { AddedEvent, CategoryDecision, CategorySuggestion } from "@/lib/agent";
import type { EventCategory } from "@/lib/types";
import { cn } from "@/lib/utils";

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** Category chips (grouped by whether they raise an incident) plus a type select for the chosen category. */
function CategoryChips({
  categories,
  category,
  eventType,
  onChange,
  disabled,
  idPrefix,
}: {
  categories: EventCategory[];
  category: string;
  eventType: string;
  onChange: (category: string, eventType: string) => void;
  disabled?: boolean;
  idPrefix: string;
}) {
  const current = categories.find((c) => c.key === category);
  const groups = [
    { label: "Raises an incident", items: categories.filter((c) => c.creates_incident) },
    { label: "Diary note only", items: categories.filter((c) => !c.creates_incident) },
  ];
  return (
    <div className="flex flex-col gap-2">
      {groups.map((g) => (
        <div key={g.label} role="group" aria-label={g.label} className="flex flex-wrap items-center gap-1.5">
          <span className="w-full text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{g.label}</span>
          {g.items.map((c) => (
            <Button
              key={c.key}
              type="button"
              size="sm"
              className="min-h-9"
              variant={c.key === category ? "default" : "outline"}
              aria-pressed={c.key === category}
              title={c.description}
              disabled={disabled}
              onClick={() => onChange(c.key, c.types.find((t) => t.key === eventType)?.key ?? c.types[0]?.key ?? "other")}
            >
              {c.label}
            </Button>
          ))}
        </div>
      ))}
      {current && current.types.length > 1 && (
        <div className="flex items-center gap-2">
          <Label htmlFor={`${idPrefix}-type`} className="text-xs text-muted-foreground">
            Type
          </Label>
          <select
            id={`${idPrefix}-type`}
            className="h-9 rounded-md border bg-background px-2 text-sm"
            value={eventType}
            disabled={disabled}
            onChange={(e) => onChange(category, e.target.value)}
          >
            {current.types.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

interface Choice {
  category: string;
  event_type: string;
  keep: boolean;
}

/**
 * One card per event the AI found. The AI's suggestion is pre-selected with its confidence and reason,
 * but the person has the final say: change the category/type, mark "not an event", or add one the AI missed.
 */
export function CategoryPicker({
  events,
  categories,
  pending,
  onConfirm,
}: {
  events: CategorySuggestion[];
  categories: EventCategory[];
  pending: boolean;
  onConfirm: (decisions: CategoryDecision[], added: AddedEvent[]) => void;
}) {
  const [choices, setChoices] = useState<Choice[]>(() =>
    events.map((e) => ({ category: e.suggested_category, event_type: e.suggested_event_type, keep: true })),
  );
  const [added, setAdded] = useState<AddedEvent[]>([]);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<AddedEvent>({ summary: "", category: "general", event_type: "other" });
  const label = (key: string) => categories.find((c) => c.key === key)?.label ?? key;
  const set = (i: number, patch: Partial<Choice>) => setChoices((cs) => cs.map((c, n) => (n === i ? { ...c, ...patch } : c)));
  const kept = choices.filter((c) => c.keep).length + added.length;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        onConfirm(choices.map((c, index) => ({ index, ...c })), added);
      }}
    >
      <p className="text-sm text-muted-foreground">
        Check what kind of event each one is. This decides whether it raises an incident, so you have the final say.
      </p>
      {events.map((e, i) => {
        const c = choices[i];
        const changed = c.category !== e.suggested_category || c.event_type !== e.suggested_event_type;
        const raises = categories.find((x) => x.key === c.category)?.creates_incident;
        return (
          <fieldset key={i} className={cn("flex flex-col gap-3 rounded-2xl bg-muted/50 p-4", !c.keep && "bg-muted/40 opacity-70")}>
            <legend className="sr-only">Event {i + 1}</legend>
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-medium">{e.summary}</p>
              <Button
                type="button"
                size="sm"
                variant={c.keep ? "ghost" : "secondary"}
                className="min-h-9 shrink-0"
                onClick={() => set(i, { keep: !c.keep })}
                disabled={pending}
              >
                {c.keep ? (
                  <>
                    <Trash2 aria-hidden /> Not an event
                  </>
                ) : (
                  <>
                    <Undo2 aria-hidden /> Keep it
                  </>
                )}
              </Button>
            </div>
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <Sparkles className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>
                Suggested by AI · {pct(e.confidence)} · {label(e.suggested_category)}: {e.rationale}
              </span>
            </p>
            {c.keep && (
              <>
                <CategoryChips
                  categories={categories}
                  category={c.category}
                  eventType={c.event_type}
                  onChange={(category, event_type) => set(i, { category, event_type })}
                  disabled={pending}
                  idPrefix={`ev${i}`}
                />
                <p className="text-xs">
                  {raises ? (
                    <span className="font-medium text-amber-800">This will raise an incident (or join an open one for the same problem).</span>
                  ) : (
                    <span className="text-muted-foreground">Saved as a diary note and facts. No incident.</span>
                  )}
                  {changed && <span className="ml-2 text-muted-foreground">You changed the AI&apos;s suggestion.</span>}
                </p>
              </>
            )}
          </fieldset>
        );
      })}

      {added.map((a, i) => (
        <div key={i} className="flex items-start justify-between gap-2 rounded-lg border border-dashed p-3 text-sm">
          <span>
            <span className="mr-2 rounded bg-secondary px-1.5 py-0.5 text-xs font-medium">{label(a.category)}</span>
            {a.summary} <span className="text-xs text-muted-foreground">(added by you)</span>
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={() => setAdded((x) => x.filter((_, n) => n !== i))}>
            Remove
          </Button>
        </div>
      ))}

      {adding ? (
        <div className="flex flex-col gap-3 rounded-lg border border-dashed p-3">
          <Label htmlFor="added-summary">Something the AI missed</Label>
          <Textarea id="added-summary" rows={2} value={draft.summary} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} placeholder="Describe the event in one sentence" />
          <CategoryChips
            categories={categories}
            category={draft.category}
            eventType={draft.event_type}
            onChange={(category, event_type) => setDraft({ ...draft, category, event_type })}
            idPrefix="added"
          />
          <div className="flex gap-2 self-end">
            <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!draft.summary.trim()}
              onClick={() => {
                setAdded((x) => [...x, { ...draft, summary: draft.summary.trim() }]);
                setDraft({ summary: "", category: "general", event_type: "other" });
                setAdding(false);
              }}
            >
              Add event
            </Button>
          </div>
        </div>
      ) : (
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setAdding(true)} disabled={pending}>
          <Plus aria-hidden /> Add an event the AI missed
        </Button>
      )}

      <Button type="submit" size="touch" disabled={pending} className="self-end">
        {pending ? "Saving…" : kept ? `Confirm ${kept} event${kept === 1 ? "" : "s"}` : "Discard this capture"}
      </Button>
    </form>
  );
}
