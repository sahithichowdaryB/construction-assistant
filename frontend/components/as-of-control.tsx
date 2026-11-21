"use client";

import { Clock } from "lucide-react";
import { useState } from "react";
import { useApp } from "@/components/providers/app-context";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AS_OF_PRESETS, fmtDateTime, fmtShort, isoToLocalInput, localToIso, zoneAbbrev } from "@/lib/time";

/** Global replay clock. Site evidence is scoped to this instant; times shown in Europe/Berlin. */
export function AsOfControl() {
  const { asOf, setAsOf, goLive } = useApp();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(isoToLocalInput(asOf));

  const apply = (iso: string) => {
    setAsOf(iso);
    setOpen(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setDraft(isoToLocalInput(asOf));
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="touch" className="font-normal" aria-label={`Showing the project as of ${fmtDateTime(asOf)}. Change time`}>
          <Clock aria-hidden />
          <span className="hidden text-muted-foreground sm:inline">Showing</span>
          <span className="font-medium tabular-nums">
            <span className="sm:hidden">{fmtShort(asOf)}</span>
            <span className="hidden sm:inline">{fmtDateTime(asOf)}</span>
          </span>
          <span className="text-xs text-muted-foreground">{zoneAbbrev(asOf)}</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Look back in time</DialogTitle>
          <DialogDescription>
            Choose a time to view site reports and quantities. Times are shown in Munich local time.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Button variant="secondary" size="touch" onClick={() => { goLive(); setOpen(false); }}>
            Now (live)
          </Button>
          {AS_OF_PRESETS.map((p) => {
            const iso = localToIso(p.local);
            const active = iso === asOf;
            return (
              <Button key={p.local} variant={active ? "default" : "outline"} size="touch" onClick={() => apply(iso)} aria-pressed={active}>
                {p.label}
              </Button>
            );
          })}
        </div>
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft) apply(localToIso(`${draft}:00`));
          }}
        >
          <Label htmlFor="as-of-input">Custom date and time</Label>
          <Input id="as-of-input" type="datetime-local" value={draft} onChange={(e) => setDraft(e.target.value)} className="h-11 md:h-9" />
          <DialogFooter>
            <Button type="submit" size="touch">
              Show this time
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
