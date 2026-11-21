"use client";

import { CheckCircle2, Link2, NotebookPen } from "lucide-react";
import { useState } from "react";
import { ProvenanceBadge } from "@/components/badges";
import { CitationChip } from "@/components/citation-chip";
import { useApp } from "@/components/providers/app-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { basisLabel } from "@/lib/format";
import { useConfirmProposal } from "@/lib/queries";
import { denyReason } from "@/lib/roles";
import { fmtDateTime } from "@/lib/time";
import type { Proposal } from "@/lib/types";

const isInstant = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v);

/** Editable transcript plus proposed fields with provenance, follow-ups and duplicate handling. */
export function ReviewForm({ proposal, onDone }: { proposal: Proposal; onDone: (message: string) => void }) {
  const { role } = useApp();
  const confirm = useConfirmProposal();
  const blocked = denyReason(role, "confirm_capture");
  const [transcript, setTranscript] = useState(proposal.transcript);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(proposal.fields.map((f) => [f.key, f.value === null ? "" : isInstant(f.value) ? fmtDateTime(f.value) : String(f.value)])),
  );
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [linkDuplicate, setLinkDuplicate] = useState(true);

  const submit = (mode: "incident" | "diary_note") => {
    confirm.mutate(
      {
        sid: proposal.source_id,
        input: {
          transcript,
          fields: proposal.fields.map((f) => ({ key: f.key, value: values[f.key] || null, provenance: f.provenance })),
          answers,
          link_incident_id: proposal.duplicate_of && linkDuplicate ? proposal.duplicate_of.incident_id : proposal.related_incident?.incident_id ?? null,
          mode,
        },
      },
      {
        onSuccess: () =>
          onDone(
            mode === "diary_note"
              ? "Saved as a diary note (fixture mode: not persisted)."
              : proposal.duplicate_of && linkDuplicate
                ? `Linked to ${proposal.duplicate_of.incident_id} (fixture mode: not persisted).`
                : "Confirmed (fixture mode: not persisted).",
          ),
      },
    );
  };

  const confirmButton = (
    <Button size="touch" onClick={() => submit("incident")} disabled={!!blocked || confirm.isPending}>
      <CheckCircle2 aria-hidden /> Confirm and save
    </Button>
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="transcript">What was said (you can edit this)</Label>
        <Textarea id="transcript" value={transcript} onChange={(e) => setTranscript(e.target.value)} rows={3} />
        <p className="text-xs text-muted-foreground">
          From {proposal.source_id} · {basisLabel(proposal.basis)}
        </p>
      </div>

      {proposal.duplicate_of && (
        <div role="status" className="flex flex-col gap-2 rounded-2xl bg-sky-50 p-4 text-sm text-sky-950 dark:bg-sky-500/10 dark:text-sky-200">
          <p className="flex items-center gap-2 font-medium">
            <Link2 className="size-4" aria-hidden /> Possible duplicate of {proposal.duplicate_of.incident_id}: {proposal.duplicate_of.title}
          </p>
          <p>{proposal.duplicate_of.reason}</p>
          <label className="flex min-h-11 items-center gap-2">
            <input type="checkbox" className="size-5" checked={linkDuplicate} onChange={(e) => setLinkDuplicate(e.target.checked)} />
            Link to the existing incident instead of creating a new one
          </label>
        </div>
      )}
      {proposal.related_incident && (
        <div role="status" className="rounded-2xl bg-sky-50 p-4 text-sm text-sky-950 dark:bg-sky-500/10 dark:text-sky-200">
          <Link2 className="mr-1 inline size-4" aria-hidden />
          This {proposal.kind} will be attached to {proposal.related_incident.incident_id}: {proposal.related_incident.title}
        </div>
      )}

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-semibold">Details to check</legend>
        {proposal.fields.map((f) => (
          <div key={f.key} className={`grid gap-1.5 rounded-2xl p-3 sm:grid-cols-[10rem_1fr] sm:items-start ${f.provenance === "missing" ? "border border-dashed border-amber-400/70 bg-amber-50 dark:bg-amber-500/10" : "bg-muted/50"}`}>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`f-${f.key}`}>{f.label}</Label>
              <ProvenanceBadge provenance={f.provenance} className="self-start" />
            </div>
            <div className="flex flex-col gap-1">
              <Input
                id={`f-${f.key}`}
                value={values[f.key] ?? ""}
                placeholder={f.provenance === "missing" ? "Not in the note. Please fill in." : undefined}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                className="h-11 bg-card md:h-9"
                aria-describedby={f.note ? `n-${f.key}` : undefined}
              />
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {f.source_ref ? <CitationChip refData={f.source_ref} /> : <span>No source given</span>}
                {f.note && <span id={`n-${f.key}`}>{f.note}</span>}
              </div>
            </div>
          </div>
        ))}
      </fieldset>

      {proposal.follow_up_questions.length > 0 && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-semibold">A few questions</legend>
          {proposal.follow_up_questions.map((q) => (
            <div key={q.id} className="flex flex-col gap-1.5">
              <Label htmlFor={`q-${q.id}`}>{q.question}</Label>
              <Input
                id={`q-${q.id}`}
                value={answers[q.id] ?? ""}
                onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                placeholder="Leave blank if you don't know"
                className="h-11 md:h-9"
              />
            </div>
          ))}
        </fieldset>
      )}

      {blocked && <p className="text-sm text-muted-foreground">{blocked}</p>}
      <div className="flex flex-wrap gap-2">
        {blocked ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0}>{confirmButton}</span>
            </TooltipTrigger>
            <TooltipContent>{blocked}</TooltipContent>
          </Tooltip>
        ) : (
          confirmButton
        )}
        <Button variant="outline" size="touch" onClick={() => submit("diary_note")} disabled={!!blocked || confirm.isPending}>
          <NotebookPen aria-hidden /> Save as diary note only
        </Button>
      </div>
    </div>
  );
}
