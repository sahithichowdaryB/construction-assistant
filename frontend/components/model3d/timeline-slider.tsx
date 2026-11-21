"use client";

/** The "3D line": a date slider from project start to the deadline/forecast, with planned, actual and forecast
 * cumulative concrete (m³) above it and markers for today, the deadline and the forecast finish. Values come from
 * GET /models/active/timeline. */

import { Pause, Play, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { addDays, daysBetween, type Timeline } from "@/lib/model3d";
import { fmtLocalDate } from "@/lib/time";

/** Labels for today, the deadline and the forecast; the deadline and forecast share one label when they are close. */
function markerLabels(today: string, deadline: string | null | undefined, forecast: string | undefined, total: number, start: string) {
  const out: { label: string; d: string; cls: string }[] = [{ label: "Today", d: today, cls: "text-foreground" }];
  const close = deadline && forecast && Math.abs(daysBetween(start, deadline) - daysBetween(start, forecast)) < total * 0.06;
  if (close && deadline !== forecast) out.push({ label: "Deadline · Forecast", d: forecast!, cls: "text-red-700 dark:text-red-400" });
  else {
    if (deadline) out.push({ label: deadline === forecast ? "Deadline = Forecast" : "Deadline", d: deadline, cls: "text-red-700 dark:text-red-400" });
    if (forecast && forecast !== deadline) out.push({ label: "Forecast", d: forecast, cls: "text-amber-700 dark:text-amber-400" });
  }
  return out;
}

export function TimelineSlider({ timeline, date, onChange }: { timeline: Timeline; date: string; onChange: (d: string) => void }) {
  const start = timeline.start ?? date;
  const end = timeline.end ?? date;
  const total = Math.max(daysBetween(start, end), 1);
  const today = timeline.today ?? date;
  const [playing, setPlaying] = useState(false);
  const dateRef = useRef(date);
  dateRef.current = date;

  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      const next = addDays(dateRef.current, Math.max(1, Math.round(total / 120)));
      if (next >= end) {
        onChange(end);
        setPlaying(false);
      } else onChange(next);
    }, 90);
    return () => window.clearInterval(id);
  }, [playing, total, end, onChange]);

  const W = 720, H = 120, L = 8, R = 8, T = 8, B = 4;
  const max = Math.max(timeline.total_m3 ?? 0, ...timeline.points.map((p) => Math.max(p.planned, p.actual ?? 0, p.forecast ?? 0)), 1);
  const x = (d: string) => L + (daysBetween(start, d) * (W - L - R)) / total;
  const y = (v: number) => T + ((max - v) * (H - T - B)) / max;
  const line = (key: "planned" | "actual" | "forecast") =>
    timeline.points.filter((p) => p[key] != null).map((p) => `${x(p.date).toFixed(1)},${y(p[key] as number).toFixed(1)}`).join(" ");
  const marker = (d: string | null | undefined, colour: string, dash?: string) =>
    d && d >= start && d <= end ? <line x1={x(d)} x2={x(d)} y1={T} y2={H - B} stroke={colour} strokeWidth={2} strokeDasharray={dash} /> : null;
  const offset = daysBetween(start, date);
  const pct = (d: string | null | undefined) => (d ? `${(100 * daysBetween(start, d)) / total}%` : undefined);

  return (
    <div className="flex flex-col gap-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-24 w-full md:h-28" preserveAspectRatio="none" role="img"
           aria-label="Cumulative concrete: planned, actual and forecast">
        <polyline points={line("planned")} fill="none" className="stroke-muted-foreground" strokeWidth={1.5} strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />
        <polyline points={line("forecast")} fill="none" stroke="#e8590c" strokeWidth={1.5} strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
        <polyline points={line("actual")} fill="none" stroke="#e8590c" strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
        {marker(today, "var(--primary)")}
        {marker(timeline.deadline, "#dc2626")}
        {timeline.forecast_completion !== timeline.deadline && marker(timeline.forecast_completion, "#d97706", "3 3")}
        {marker(date, "currentColor", "1 3")}
      </svg>
      <div className="relative">
        <input type="range" min={0} max={total} value={Math.min(Math.max(offset, 0), total)} aria-label="Date"
               aria-valuetext={fmtLocalDate(date)} className="w-full accent-[#e8590c]"
               onChange={(e) => { setPlaying(false); onChange(addDays(start, Number(e.target.value))); }} />
        <div className="pointer-events-none relative h-4 text-[10px] text-muted-foreground">
          {markerLabels(today, timeline.deadline, timeline.forecast_completion, total, start).map(({ label, d, cls }) => {
            const at = (100 * daysBetween(start, d)) / total;
            // keep labels near the ends inside the track
            const shift = at > 92 ? "-translate-x-full" : at < 8 ? "" : "-translate-x-1/2";
            return d >= start && d <= end ? (
              <span key={label} className={`absolute font-semibold whitespace-nowrap ${shift} ${cls}`} style={{ left: pct(d) }}>{label}</span>
            ) : null;
          })}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => { if (date >= end) onChange(start); setPlaying((p) => !p); }}
                  aria-label={playing ? "Pause" : "Play the build"}>
            {playing ? <Pause aria-hidden /> : <Play aria-hidden />} {playing ? "Pause" : "Play"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { setPlaying(false); onChange(today); }}>
            <RotateCcw aria-hidden /> Today
          </Button>
        </div>
        <p className="text-sm font-semibold tabular">
          {fmtLocalDate(date)}
          <span className="ml-2 font-normal text-muted-foreground">
            {date < today ? "recorded" : date === today ? "today" : "forecast"}
          </span>
        </p>
      </div>
      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><span className="w-5 border-t-2 border-dashed border-muted-foreground" /> Planned m³</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-1 w-5 rounded bg-[#e8590c]" /> Actual (signed)</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-5 border-t-2 border-dotted border-[#e8590c]" /> Forecast</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-3 w-0.5 bg-red-600" /> Deadline</span>
      </div>
    </div>
  );
}
