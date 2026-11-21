/** Planned against actual weighted progress (S-curve). Inline SVG, no chart dependency; values come from the server. */
export function SCurveChart({ points, today }: { points: { date: string; planned_pct: number; actual_pct: number | null }[]; today: string }) {
  if (points.length < 2) return <p className="text-sm text-muted-foreground">Not enough plan dates for a curve yet.</p>;
  const W = 640, H = 220, L = 36, R = 12, T = 12, B = 28;
  const x = (i: number) => L + (i * (W - L - R)) / (points.length - 1);
  const y = (v: number) => T + ((100 - v) * (H - T - B)) / 100;
  const line = (key: "planned_pct" | "actual_pct") =>
    points
      .map((p, i) => (p[key] === null ? null : `${x(i).toFixed(1)},${y(p[key] as number).toFixed(1)}`))
      .filter(Boolean)
      .join(" ");
  const todayIndex = points.findIndex((p) => p.date >= today);
  const step = Math.max(1, Math.ceil(points.length / 6));
  const last = [...points].reverse().find((p) => p.actual_pct !== null);
  return (
    <figure className="flex flex-col gap-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img"
           aria-label={`S-curve: planned ${points.at(-1)?.planned_pct}% at the end; actual ${last?.actual_pct ?? "–"}% on ${last?.date ?? "–"}`}>
        {[0, 25, 50, 75, 100].map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="stroke-border" strokeDasharray={v % 50 ? "2 4" : undefined} />
            <text x={L - 6} y={y(v) + 4} textAnchor="end" className="fill-muted-foreground text-[10px]">{v}%</text>
          </g>
        ))}
        {points.map((p, i) => (i % step === 0 || i === points.length - 1) && (
          <text key={p.date} x={x(i)} y={H - 8} textAnchor="middle" className="fill-muted-foreground text-[10px]">{p.date.slice(5)}</text>
        ))}
        {todayIndex >= 0 && <line x1={x(todayIndex)} x2={x(todayIndex)} y1={T} y2={H - B} className="stroke-primary" strokeWidth={2} />}
        <polyline points={line("planned_pct")} fill="none" className="stroke-muted-foreground" strokeWidth={2} strokeDasharray="5 4" />
        <polyline points={line("actual_pct")} fill="none" stroke="#e8590c" strokeWidth={3} strokeLinejoin="round" />
      </svg>
      <figcaption className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-5 border-t-2 border-dashed border-muted-foreground" /> Planned (weighted %)</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-1 w-5 rounded bg-[#e8590c]" /> Actual (signed)</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-3 w-0.5 bg-primary" /> As of date</span>
      </figcaption>
    </figure>
  );
}
