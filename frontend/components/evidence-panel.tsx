"use client";

import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { useState } from "react";
import { CitationChip } from "@/components/citation-chip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fmtDateTime } from "@/lib/time";
import type { CitedSource, Gap } from "@/lib/types";

function GapRow({ gap, editable, onFill, onOmit }: { gap: Gap; editable: boolean; onFill: (v: string) => void; onOmit: (reason: string) => void }) {
  const [mode, setMode] = useState<"none" | "fill" | "omit">("none");
  const [value, setValue] = useState("");
  if (gap.resolution) {
    return (
      <li className="flex flex-col gap-0.5 rounded-xl bg-emerald-50 p-3 text-sm dark:bg-emerald-500/10">
        <span className="flex items-center gap-1.5 font-medium text-emerald-900 dark:text-emerald-300">
          <CheckCircle2 className="size-4" aria-hidden /> {gap.label}: {gap.resolution.action === "filled" ? "filled" : "omitted"}
        </span>
        <span className="text-xs text-emerald-900/80 dark:text-emerald-300/80">
          {gap.resolution.action === "filled" ? `Value: ${gap.resolution.value}` : `Reason: ${gap.resolution.value}`} · {gap.resolution.by} ·{" "}
          {fmtDateTime(gap.resolution.at)}
        </span>
      </li>
    );
  }
  return (
    <li className="flex flex-col gap-2.5 rounded-xl border border-dashed border-amber-400/70 bg-amber-50 p-3 text-sm dark:bg-amber-500/10">
      <span className="flex items-start gap-2 text-amber-950 dark:text-amber-200">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>
          <span className="font-semibold">{gap.label}</span>
          <br />
          <span className="font-mono text-[11px] opacity-70">{gap.marker}</span>
        </span>
      </span>
      {editable && mode === "none" && (
        <span className="flex gap-2">
          <Button size="touch" onClick={() => setMode("fill")}>
            Fill
          </Button>
          <Button size="touch" variant="ghost" onClick={() => setMode("omit")}>
            Omit with reason
          </Button>
        </span>
      )}
      {editable && mode !== "none" && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!value.trim()) return;
            if (mode === "fill") onFill(value.trim());
            else onOmit(value.trim());
          }}
        >
          <label className="text-xs font-medium" htmlFor={`gap-${gap.id}`}>
            {mode === "fill" ? "Value from a verified source" : "Why is this omitted?"}
          </label>
          <Input id={`gap-${gap.id}`} value={value} onChange={(e) => setValue(e.target.value)} className="h-11 bg-card md:h-9" autoFocus />
          <span className="flex gap-2">
            <Button type="submit" size="touch" disabled={!value.trim()}>
              {mode === "fill" ? "Fill" : "Omit"}
            </Button>
            <Button type="button" size="touch" variant="ghost" onClick={() => setMode("none")}>
              Cancel
            </Button>
          </span>
        </form>
      )}
    </li>
  );
}

export function EvidencePanel({
  sources,
  gaps,
  strayMarkers,
  assumptions,
  editable,
  onFill,
  onOmit,
}: {
  sources: CitedSource[];
  gaps: Gap[];
  strayMarkers: string[];
  assumptions: string[];
  editable: boolean;
  onFill: (gap: Gap, value: string) => void;
  onOmit: (gap: Gap, reason: string) => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">To complete</h3>
        {gaps.length || strayMarkers.length ? (
          <ul className="flex flex-col gap-2">
            {gaps.map((g) => (
              <GapRow key={g.id} gap={g} editable={editable} onFill={(v) => onFill(g, v)} onOmit={(r) => onOmit(g, r)} />
            ))}
            {strayMarkers.map((m) => (
              <li key={m} className="rounded-xl border border-dashed border-amber-400/70 bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-500/10 dark:text-amber-200">
                <span className="font-mono text-xs">{m}</span> is still in the letter. Edit the text to resolve it.
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Nothing left to fill in.</p>
        )}
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Sources ({sources.length})</h3>
        {sources.length ? (
          <ol className="flex flex-col gap-1.5 text-sm">
            {sources.map((s) => (
              <li key={s.n} className="flex items-start gap-2">
                <CitationChip refData={s.ref} n={s.n} />
                <span>{s.label}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">No evidence retrieved yet.</p>
        )}
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Assumptions</h3>
        {assumptions.length ? (
          <ul className="flex flex-col gap-1.5 text-sm">
            {assumptions.map((a, i) => (
              <li key={i} className="flex gap-2">
                <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden /> {a}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">None recorded.</p>
        )}
      </section>
    </div>
  );
}
