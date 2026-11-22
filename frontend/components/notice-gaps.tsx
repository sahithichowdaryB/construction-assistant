"use client";

import { Check, EyeOff } from "lucide-react";
import { useState } from "react";
import { GatedButton } from "@/components/gated-button";
import { useApp } from "@/components/providers/app-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { denyReason } from "@/lib/roles";
import { useResolveGap, type NoticeDraft } from "@/lib/workflow";

/**
 * Every [MISSING: …] field of the latest version: fill it in, or (where the notice template permits) leave it out
 * with a reason. Each decision creates a new version; the approver sees who filled or omitted what, and why.
 */
export function NoticeGaps({ notice }: { notice: NoticeDraft }) {
  const { role } = useApp();
  const resolve = useResolveGap();
  const [values, setValues] = useState<Record<string, string>>({});
  const [omitting, setOmitting] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const fields = notice.latest.missing_fields;
  if (!fields.length) return null;
  const deny = denyReason(role, "edit_draft");
  const send = (field: string, resolution: "filled" | "omitted") =>
    resolve.mutate(
      {
        draftId: notice.id,
        version: notice.latest.version,
        field,
        resolution,
        value: resolution === "filled" ? values[field]?.trim() : undefined,
        reason: resolution === "omitted" ? reason.trim() : undefined,
      },
      { onSuccess: () => { setOmitting(null); setReason(""); } },
    );
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50/60 p-4" aria-label="Missing details">
      <p className="text-sm font-semibold">
        {fields.length} missing detail{fields.length === 1 ? "" : "s"}. The notice cannot be approved until each is filled in or left out with a reason.
      </p>
      <ul className="flex flex-col gap-3">
        {fields.map((field) => {
          const canOmit = notice.omittable_fields.includes(field);
          return (
            <li key={field} className="flex flex-col gap-2 rounded-lg border bg-card p-3">
              <label className="flex flex-col gap-1.5 text-sm font-medium capitalize">
                {field}
                <Input
                  value={values[field] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [field]: e.target.value }))}
                  placeholder="Type the value"
                  className="h-11 normal-case md:h-9"
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <GatedButton reason={deny} size="sm" disabled={!values[field]?.trim() || resolve.isPending} onClick={() => send(field, "filled")}>
                  <Check aria-hidden /> Fill in
                </GatedButton>
                {canOmit && omitting !== field && (
                  <GatedButton reason={deny} size="sm" variant="outline" disabled={resolve.isPending} onClick={() => setOmitting(field)}>
                    <EyeOff aria-hidden /> Leave out
                  </GatedButton>
                )}
              </div>
              {omitting === field && (
                <form
                  className="flex flex-col gap-2 border-t pt-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    send(field, "omitted");
                  }}
                >
                  <label className="flex flex-col gap-1 text-xs font-medium">
                    Why is it left out? (shown to the approver)
                    <Input value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={1000} />
                  </label>
                  <div className="flex gap-2">
                    <Button type="submit" size="sm" disabled={!reason.trim() || resolve.isPending}>Leave out</Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setOmitting(null)}>Cancel</Button>
                  </div>
                </form>
              )}
              {!canOmit && <p className="text-xs text-muted-foreground">Required in this notice type; it cannot be left out.</p>}
            </li>
          );
        })}
      </ul>
      {resolve.isError && <p className="text-sm text-red-800" role="alert">{resolve.error.message}</p>}
    </section>
  );
}

/** Fill/omit decisions recorded on a version (for the approver and the history). */
export function GapResolutions({ version }: { version: NoticeDraft["latest"] }) {
  if (!version.gap_resolutions.length) return null;
  return (
    <ul className="flex flex-col gap-1 text-xs text-muted-foreground" aria-label="Filled or omitted details">
      {version.gap_resolutions.map((g) => (
        <li key={g.field}>
          <span className="font-medium text-foreground capitalize">{g.field}</span>{" "}
          {g.resolution === "filled" ? `filled in as “${g.value}”` : `left out: “${g.reason}”`}
          {g.decided_by ? ` · ${g.decided_by}` : ""}
        </li>
      ))}
    </ul>
  );
}
