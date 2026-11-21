"use client";

import { Loader2, MessageCircleQuestion, Send } from "lucide-react";
import { useState } from "react";
import { CitationChip } from "@/components/citation-chip";
import { GapHighlighter } from "@/components/gap-highlighter";
import { useApp } from "@/components/providers/app-context";
import { ErrorState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useAsk } from "@/lib/queries";
import { denyReason } from "@/lib/roles";
import { fmtDateTime } from "@/lib/time";
import type { AskAnswer } from "@/lib/types";

const SUGGESTIONS = [
  "Which excavator was involved?",
  "When is the excavator expected back?",
  "How much did Zone B excavate today?",
  "What does GroundWorks owe us?",
  "Is the foundation handover at risk?",
];

export function AskDrawer() {
  const { askOpen, setAskOpen, asOf, role } = useApp();
  const [question, setQuestion] = useState("");
  const [history, setHistory] = useState<AskAnswer[]>([]);
  const ask = useAsk();
  const blocked = denyReason(role, "ask");

  const submit = (q: string) => {
    const text = q.trim();
    if (!text || blocked) return;
    ask.mutate(text, {
      onSuccess: (a) => {
        setHistory((h) => [a, ...h]);
        setQuestion("");
      },
    });
  };

  return (
    <Sheet open={askOpen} onOpenChange={setAskOpen}>
      <SheetContent side="right" className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <MessageCircleQuestion className="size-5" aria-hidden /> Ask SiteMate
          </SheetTitle>
          <SheetDescription>Answers cite Riverside records available as of {fmtDateTime(asOf)}.</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4 pb-6">
          {blocked && <p className="rounded-md bg-muted p-2 text-sm text-muted-foreground">{blocked}</p>}
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              submit(question);
            }}
          >
            <label htmlFor="ask-input" className="text-sm font-medium">
              Your question
            </label>
            <Textarea
              id="ask-input"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="e.g. Which excavator broke down?"
              rows={3}
              disabled={!!blocked}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit(question);
                }
              }}
            />
            <Button type="submit" size="touch" disabled={!!blocked || ask.isPending || !question.trim()} className="self-end">
              {ask.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />} Ask
            </Button>
          </form>
          <div className="flex flex-wrap gap-1.5" aria-label="Suggested questions">
            {SUGGESTIONS.map((s) => (
              <Button key={s} variant="secondary" size="sm" className="h-auto min-h-9 py-1.5 whitespace-normal" disabled={!!blocked || ask.isPending} onClick={() => submit(s)}>
                {s}
              </Button>
            ))}
          </div>
          {ask.isError && <ErrorState error={ask.error} onRetry={() => submit(ask.variables ?? question)} />}
          <ol className="flex flex-col gap-3" aria-live="polite">
            {history.map((a, i) => (
              <li key={`${a.question}-${i}`} className="rounded-lg border p-3">
                <p className="text-sm font-medium">{a.question}</p>
                <div className="mt-2">
                  <GapHighlighter text={a.answer} sources={a.citations} />
                </div>
                {a.citations.length > 0 ? (
                  <ul className="mt-2 flex flex-col gap-1 text-xs">
                    {a.citations.map((c) => (
                      <li key={c.n} className="flex items-center gap-2">
                        <CitationChip refData={c.ref} n={c.n} /> {c.label}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-xs text-muted-foreground">No sources cited.</p>
                )}
                <p className="mt-2 text-[11px] text-muted-foreground">As of {fmtDateTime(a.as_of)}</p>
              </li>
            ))}
          </ol>
        </div>
      </SheetContent>
    </Sheet>
  );
}
