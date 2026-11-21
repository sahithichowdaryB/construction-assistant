"use client";

import { useId, useState } from "react";

type Point = { date: string; planned_pct: number; actual_pct: number | null };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const short = (d: string) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;

/**
 * Planned against actual weighted progress (S-curve). Inline SVG, values come from the server.
 * The actual line draws itself in, the gap to plan is shaded, and hovering shows the values for a date.
 */
export function SCurveChart({ points, today }: { points: Point[]; today: string }) {
  const id = useId().replace(/:/g, "");
  const [hover, setHover] = useState<number | null>(null);
  if (points.length < 2) return <p className="text-sm text-muted-foreground">Not enough plan dates for a curve yet.</p>;

  const W = 720, H = 260, L = 40, R = 18, T = 18, B = 30;
  const x = (i: number) => L + (i * (W - L - R)) / (points.length - 1);
  const y = (v: number) => T + ((100 - v) * (H - T - B)) / 100;
  const r1 = (n: number) => Math.round(n * 10) / 10;

  const planned = points.map((p, i) => `${r1(x(i))},${r1(y(p.planned_pct))}`);
  const actualIdx = points.flatMap((p, i) => (p.actual_pct === null ? [] : [i]));
  const actual = actualIdx.map((i) => `${r1(x(i))},${r1(y(points[i].actual_pct!))}`);
  const lastI = actualIdx.at(-1);
  const firstI = actualIdx[0];

  // Area under the actual line, and the gap between plan and actual over the measured dates.
  const area = actualIdx.length > 1 ? `M${actual.join(" L")} L${r1(x(lastI!))},${y(0)} L${r1(x(firstI))},${y(0)} Z` : "";
  const gap = actualIdx.length > 1
    ? `M${actualIdx.map((i) => planned[i]).join(" L")} L${[...actual].reverse().join(" L")} Z`
    : "";
  const behind = lastI !== undefined && (points[lastI].actual_pct ?? 0) < points[lastI].planned_pct;

  const todayIndex = points.findIndex((p) => p.date >= today);
  const step = Math.max(1, Math.ceil(points.length / 7));
  const h = hover !== null ? points[hover] : null;

  return (
    <figure className="flex flex-col gap-3">
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full touch-none select-none" role="img"
             aria-label={`Progress curve: planned ${points.at(-1)?.planned_pct}% at the end; actual ${lastI !== undefined ? points[lastI].actual_pct : "–"}% on ${lastI !== undefined ? short(points[lastI].date) : "–"}`}
             onPointerMove={(e) => {
               const box = e.currentTarget.getBoundingClientRect();
               const px = ((e.clientX - box.left) / box.width) * W;
               const i = Math.round(((px - L) / (W - L - R)) * (points.length - 1));
               setHover(Math.max(0, Math.min(points.length - 1, i)));
             }}
             onPointerLeave={() => setHover(null)}>
          <defs>
            <linearGradient id={`fill-${id}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="var(--primary)" stopOpacity="0.35" />
              <stop offset="1" stopColor="var(--primary)" stopOpacity="0" />
            </linearGradient>
            <pattern id={`gap-${id}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" fill={behind ? "var(--destructive)" : "var(--success)"} fillOpacity="0.08" />
              <rect width="2" height="6" fill={behind ? "var(--destructive)" : "var(--success)"} fillOpacity="0.28" />
            </pattern>
          </defs>

          {[0, 25, 50, 75, 100].map((v) => (
            <g key={v}>
              <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="stroke-border" strokeDasharray={v % 50 ? "2 5" : undefined} />
              <text x={L - 8} y={y(v) + 4} textAnchor="end" className="fill-muted-foreground text-[10px]">{v}%</text>
            </g>
          ))}
          {points.map((p, i) => (i % step === 0 || i === points.length - 1) && (
            <text key={p.date} x={x(i)} y={H - 9} textAnchor="middle" className="fill-muted-foreground text-[10px]">{short(p.date)}</text>
          ))}

          {area && <path d={area} fill={`url(#fill-${id})`} className="motion-safe:animate-[chart-fade_900ms_ease-out_both]" />}
          {gap && <path d={gap} fill={`url(#gap-${id})`} className="motion-safe:animate-[chart-fade_900ms_300ms_ease-out_both]" />}

          <polyline points={planned.join(" ")} fill="none" className="stroke-muted-foreground" strokeWidth={2} strokeDasharray="6 5" strokeLinecap="round" />
          {actual.length > 1 && (
            <polyline points={actual.join(" ")} fill="none" pathLength={1} className="stroke-primary motion-safe:animate-[chart-draw_1100ms_ease-out_both]"
                      strokeWidth={3.5} strokeLinejoin="round" strokeLinecap="round" strokeDasharray="1" />
          )}

          {todayIndex >= 0 && (
            <g>
              <line x1={x(todayIndex)} x2={x(todayIndex)} y1={T} y2={H - B} className="stroke-foreground" strokeWidth={1.5} strokeDasharray="3 4" />
              <rect x={x(todayIndex) - 22} y={T - 14} width={44} height={16} rx={6} className="fill-foreground" />
              <text x={x(todayIndex)} y={T - 3} textAnchor="middle" className="fill-background text-[10px] font-bold">Today</text>
            </g>
          )}

          {lastI !== undefined && (
            <g className="motion-safe:animate-[chart-fade_400ms_1000ms_ease-out_both]">
              <circle cx={x(lastI)} cy={y(points[lastI].actual_pct!)} r={10} className="fill-primary/25 motion-safe:animate-ping [transform-box:fill-box] [transform-origin:center]" />
              <circle cx={x(lastI)} cy={y(points[lastI].actual_pct!)} r={5.5} className="fill-primary stroke-card" strokeWidth={2.5} />
              <circle cx={x(lastI)} cy={y(points[lastI].planned_pct)} r={4} className="fill-card stroke-muted-foreground" strokeWidth={2} />
            </g>
          )}

          {h && hover !== null && (
            <g pointerEvents="none">
              <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} className="stroke-muted-foreground/60" strokeWidth={1} />
              <circle cx={x(hover)} cy={y(h.planned_pct)} r={4} className="fill-card stroke-muted-foreground" strokeWidth={2} />
              {h.actual_pct !== null && <circle cx={x(hover)} cy={y(h.actual_pct)} r={5} className="fill-primary stroke-card" strokeWidth={2} />}
            </g>
          )}
        </svg>

        {h && hover !== null && (
          <div className="pointer-events-none absolute top-2 rounded-xl bg-foreground px-3 py-2 text-xs text-background shadow-lg"
               style={{ left: `${(x(hover) / W) * 100}%`, transform: `translateX(${hover > points.length / 2 ? "-110%" : "10%"})` }}>
            <p className="font-semibold">{short(h.date)}</p>
            <p className="tabular">Planned {Math.round(h.planned_pct)}%</p>
            <p className="tabular">{h.actual_pct === null ? "Not measured yet" : `Actual ${Math.round(h.actual_pct)}%`}</p>
          </div>
        )}
      </div>

      <figcaption className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><span className="h-1 w-5 rounded bg-primary" /> Actual (signed)</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-5 border-t-2 border-dashed border-muted-foreground" /> Planned</span>
        <span className="inline-flex items-center gap-1.5">
          <span className={behind ? "h-3 w-4 rounded-sm bg-[repeating-linear-gradient(45deg,var(--destructive)_0_2px,transparent_2px_5px)] opacity-60" : "h-3 w-4 rounded-sm bg-[repeating-linear-gradient(45deg,var(--success)_0_2px,transparent_2px_5px)] opacity-60"} />
          {behind ? "Behind plan" : "Ahead of plan"}
        </span>
        {lastI !== undefined && (
          <span className="ml-auto font-semibold text-foreground tabular">
            {short(points[lastI].date)}: {Math.round(points[lastI].actual_pct!)}% done · plan {Math.round(points[lastI].planned_pct)}%
          </span>
        )}
      </figcaption>
    </figure>
  );
}
