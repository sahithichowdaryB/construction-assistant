"use client";

import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fmtLocalDate } from "@/lib/time";

function shift(date: string, days: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Step through the programme's days; "clock day" returns to the As of date. */
export function DayNav({
  date,
  clockDate,
  first,
  last,
  onChange,
}: {
  date: string;
  clockDate: string;
  first: string | null;
  last: string | null;
  onChange: (date: string | null) => void;
}) {
  const prev = shift(date, -1);
  const next = shift(date, 1);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="icon-touch" className="rounded-xl" aria-label="Previous day" disabled={!!first && prev < first} onClick={() => onChange(prev)}>
        <ChevronLeft aria-hidden />
      </Button>
      <span className="inline-flex min-w-44 items-center justify-center gap-2 rounded-xl border bg-card px-3 py-2 text-sm font-semibold">
        <CalendarDays className="size-4 text-muted-foreground" aria-hidden /> {fmtLocalDate(date)}
      </span>
      <Button variant="outline" size="icon-touch" className="rounded-xl" aria-label="Next day" disabled={(!!last && next > last) || next > clockDate} onClick={() => onChange(next)}>
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
