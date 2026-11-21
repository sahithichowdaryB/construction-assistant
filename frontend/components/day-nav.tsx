"use client";

import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

function shift(date: string, days: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Step through the programme's days; "clock day" returns to the As of date. */
export function DayNav({
  date,
  clockDate,
  onChange,
}: {
  date: string;
  clockDate: string;
  onChange: (date: string | null) => void;
}) {
  const prev = shift(date, -1);
  const next = shift(date, 1);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="icon-touch" className="rounded-xl" aria-label="Previous day" onClick={() => onChange(prev)}>
        <ChevronLeft aria-hidden />
      </Button>
      <span className="inline-flex min-w-44 items-center justify-center gap-2 rounded-xl border bg-card px-3 py-2 text-sm font-semibold">
        <CalendarDays className="size-4 text-muted-foreground" aria-hidden />
        <input type="date" aria-label="Site day" value={date} max={clockDate}
          onChange={(e) => { if (e.target.value && e.target.value <= clockDate) onChange(e.target.value); }} />
      </span>
      <Button variant="outline" size="icon-touch" className="rounded-xl" aria-label="Next day" disabled={next > clockDate} onClick={() => onChange(next)}>
        <ChevronRight aria-hidden />
      </Button>
      {date !== clockDate && (
        <Button variant="ghost" size="sm" onClick={() => onChange(null)}>
          Back to the clock day
        </Button>
      )}
    </div>
  );
}
