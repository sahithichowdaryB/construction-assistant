import { cn } from "@/lib/utils";

export type ZoneKey = "A" | "B" | "west" | "east";
export type ZoneStatus = "ok" | "warn" | "stop" | "idle";

/** Plan-view rectangles (site metres, roughly) for the four Riverside work areas. */
const ZONES: Record<ZoneKey, { x: number; y: number; w: number; h: number; height: number; label: string }> = {
  west: { x: 0, y: 0, w: 80, h: 58, height: 46, label: "West wing" },
  east: { x: 90, y: 0, w: 90, h: 58, height: 70, label: "East wing" },
  A: { x: 0, y: 72, w: 80, h: 68, height: 0, label: "Zone A" },
  B: { x: 90, y: 72, w: 90, h: 68, height: 0, label: "Zone B" },
};

const OX = 200;
const OY = 92;
const A = 1.0;
const B = 0.58;
const iso = (px: number, py: number, z = 0): [number, number] => [OX + (px - py) * A, OY + (px + py) * B - z];
const pts = (list: [number, number][]) => list.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

const STROKE: Record<ZoneStatus, string> = {
  ok: "var(--success)",
  warn: "var(--warning)",
  stop: "var(--destructive)",
  idle: "rgba(255,255,255,0.18)",
};

export const zoneLabel = (k: ZoneKey) => ZONES[k].label;

/** Map an activity's zone text from the programme to an illustration zone. */
export function zoneKeyOf(zone: string | null | undefined): ZoneKey | null {
  if (!zone) return null;
  const z = zone.toLowerCase();
  if (z.includes("west")) return "west";
  if (z.includes("east")) return "east";
  if (z === "a") return "A";
  if (z === "b") return "B";
  return null;
}

/**
 * Isometric drawing of the site. Colours only reflect statuses passed in (derived from server severities);
 * the drawing itself is decorative.
 */
export function SiteIllustration({
  status,
  pin,
  className,
}: {
  status: Partial<Record<ZoneKey, ZoneStatus>>;
  pin?: { zone: ZoneKey; title: string; subtitle?: string } | null;
  className?: string;
}) {
  const st = (k: ZoneKey): ZoneStatus => status[k] ?? "idle";

  const floor = (k: ZoneKey) => {
    const z = ZONES[k];
    const s = st(k);
    const dig = (k === "A" || k === "B") && s !== "idle";
    return (
      <polygon
        key={`f-${k}`}
        points={pts([iso(z.x, z.y), iso(z.x + z.w, z.y), iso(z.x + z.w, z.y + z.h), iso(z.x, z.y + z.h)])}
        fill={dig ? "#7a5a3a" : "rgba(255,255,255,0.05)"}
        fillOpacity={dig ? 0.75 : 1}
        stroke={STROKE[s]}
        strokeWidth={s === "stop" ? 2.5 : 1.5}
        className={s === "stop" ? "animate-pulse" : undefined}
      />
    );
  };

  const building = (k: ZoneKey) => {
    const z = ZONES[k];
    const h = z.height;
    const s = st(k);
    const x0 = z.x;
    const y0 = z.y;
    const x1 = z.x + z.w;
    const y1 = z.y + z.h;
    const floors = Math.floor(h / 23);
    return (
      <g key={`b-${k}`}>
        <polygon points={pts([iso(x0, y1), iso(x1, y1), iso(x1, y1, h), iso(x0, y1, h)])} fill="#3a3f46" />
        <polygon points={pts([iso(x1, y1), iso(x1, y0), iso(x1, y0, h), iso(x1, y1, h)])} fill="#4a5058" />
        <polygon points={pts([iso(x0, y0, h), iso(x1, y0, h), iso(x1, y1, h), iso(x0, y1, h)])} fill="#5a6069" stroke={STROKE[s]} strokeWidth={s === "idle" ? 1 : 2} />
        {Array.from({ length: floors }).map((_, i) => {
          const zz = (i + 1) * 23;
          if (zz >= h) return null;
          return (
            <g key={i} stroke="#15171a" strokeOpacity={0.45} strokeWidth={1.5}>
              <line x1={iso(x0, y1, zz)[0]} y1={iso(x0, y1, zz)[1]} x2={iso(x1, y1, zz)[0]} y2={iso(x1, y1, zz)[1]} />
              <line x1={iso(x1, y1, zz)[0]} y1={iso(x1, y1, zz)[1]} x2={iso(x1, y0, zz)[0]} y2={iso(x1, y0, zz)[1]} />
            </g>
          );
        })}
        {Array.from({ length: Math.max(floors, 1) }).map((_, f) =>
          [0.25, 0.55, 0.8].map((t) => {
            const [wx, wy] = iso(x1, y1 - z.h * t, 10 + f * 23);
            return <rect key={`${f}-${t}`} x={wx - 4} y={wy - 6} width={8} height={6} fill="#ffc400" opacity={0.85} />;
          }),
        )}
      </g>
    );
  };

  const pinZone = pin ? ZONES[pin.zone] : null;
  const [px, py] = pinZone ? iso(pinZone.x + pinZone.w * 0.55, pinZone.y + pinZone.h * 0.35, pinZone.height) : [0, 0];
  const labelX = Math.min(px + 18, 452 - 170);
  const labelY = Math.max(py - 92, 4);

  return (
    <svg viewBox="0 0 460 320" className={cn("h-auto w-full", className)} role="img" aria-label="Site overview by work area">
      <polygon points={pts([iso(-12, -12), iso(192, -12), iso(192, 152), iso(-12, 152)])} fill="#24272c" />
      {floor("A")}
      {floor("B")}
      {floor("west")}
      {floor("east")}
      {building("west")}
      {building("east")}

      {/* Tower crane */}
      <g stroke="#ffc400" strokeWidth={3} fill="none" strokeLinecap="round">
        <line x1={70} y1={176} x2={70} y2={22} />
        <line x1={40} y1={26} x2={240} y2={26} />
        <line x1={70} y1={22} x2={102} y2={8} />
        <line x1={102} y1={8} x2={240} y2={26} />
        <line x1={200} y1={26} x2={200} y2={58} />
      </g>
      <rect x={40} y={26} width={18} height={10} fill="#ffc400" />
      <rect x={193} y={58} width={14} height={8} fill="#8c95a0" />

      {/* Excavator in zone B, truck in zone A */}
      <g transform={`translate(${iso(140, 108)[0] - 18},${iso(140, 108)[1] - 18})`}>
        <rect x={0} y={12} width={32} height={11} rx={3} fill="#15171a" />
        <rect x={4} y={0} width={18} height={13} rx={3} fill="#ffc400" />
        <path d="M21 4 L40 -12 L49 5" stroke="#ffc400" strokeWidth={4} fill="none" strokeLinecap="round" />
        <path d="M45 5 L55 5 L51 13 Z" fill="#ffc400" />
      </g>
      <g transform={`translate(${iso(34, 104)[0] - 14},${iso(34, 104)[1] - 14})`}>
        <rect x={0} y={5} width={28} height={12} rx={3} fill="#6aa8ff" />
        <rect x={20} y={0} width={11} height={11} rx={2} fill="#6aa8ff" />
        <circle cx={6} cy={19} r={3.5} fill="#e7e4dc" />
        <circle cx={24} cy={19} r={3.5} fill="#e7e4dc" />
      </g>

      {pin && (
        <g>
          <line x1={px} y1={py - 34} x2={px} y2={py - 8} stroke="var(--destructive)" strokeWidth={2.5} />
          <g className="animate-bounce [animation-duration:1.8s]">
            <circle cx={px} cy={py - 46} r={13} fill="var(--destructive)" />
            <text x={px} y={py - 40.5} textAnchor="middle" fill="#fff" fontSize={16} fontWeight={700}>
              !
            </text>
          </g>
          <g transform={`translate(${labelX},${labelY})`}>
            <rect width={170} height={pin.subtitle ? 44 : 28} rx={11} fill="#ffffff" />
            <text x={12} y={18} fontSize={12.5} fontWeight={600} fill="#111214">
              {pin.title.length > 23 ? `${pin.title.slice(0, 22)}…` : pin.title}
            </text>
            {pin.subtitle && (
              <text x={12} y={35} fontSize={11} fill="#6e737a">
                {pin.subtitle.length > 27 ? `${pin.subtitle.slice(0, 26)}…` : pin.subtitle}
              </text>
            )}
          </g>
        </g>
      )}
    </svg>
  );
}
