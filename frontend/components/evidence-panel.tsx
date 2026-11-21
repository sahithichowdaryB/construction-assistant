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
      <li className="flex flex-col gap-0.5 rounded-md border border-emerald-200 bg-emerald-50 p-2 text-sm">
        <span className="flex items-center gap-1 font-medium text-emerald-900">
          <CheckCircle2 className="size-4" aria-hidden /> {gap.label}: {gap.resolution.action === "filled" ? "filled" : "omitted"}
        </span>
        <span className="text-xs text-emerald-900">
          {gap.resolution.action === "filled" ? `Value: ${gap.resolution.value}` : `Reason: ${gap.resolution.value}`} · {gap.resolution.by} ·{" "}
          {fmtDateTime(gap.resolution.at)}
        </span>
      </li>
    );
  }
  return (
    <li className="flex flex-col gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-sm">
      <span className="flex items-start gap-1 text-red-900">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>
          <span className="font-mono text-xs">{gap.marker}</span>
          <br />
          {gap.label}
        </span>
      </span>
      {editable && mode === "none" && (
        <span className="flex gap-2">
          <Button size="touch" variant="outline" className="bg-white" onClick={() => setMode("fill")}>
            Fill
          </Button>
          <Button size="touch" variant="outline" className="bg-white" onClick={() => setMode("omit")}>
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
          <Input id={`gap-${gap.id}`} value={value} onChange={(e) => setValue(e.target.value)} className="h-11 bg-white md:h-9" autoFocus />
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
        <h3 className="text-sm font-semibold">Gaps</h3>
        {gaps.length || strayMarkers.length ? (
          <ul className="flex flex-col gap-2">
            {gaps.map((g) => (
              <GapRow key={g.id} gap={g} editable={editable} onFill={(v) => onFill(g, v)} onOmit={(r) => onOmit(g, r)} />
            ))}
            {strayMarkers.map((m) => (
              <li key={m} className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-900">
                <span className="font-mono text-xs">{m}</span> is still in the letter. Edit the text to resolve it.
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No gaps.</p>
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
