"use client";

/**
 * The 3D building (three.js via React Three Fiber). Elements are boxes from the server (metres, x east, y north,
 * z up); three.js is y-up, so (x, y, z) -> (x, z, -y). Colours by pour state:
 *   built (signed)            solid grey, like the drawings' 4D sequence
 *   built / in progress unsigned (estimate or site event)  activity colour, translucent
 *   in progress (signed)      activity colour, filled to its %: slabs along the pour's grid range, walls and columns upward
 *   not started               ghost outline
 *   compare mode              planned-but-missing parts in red
 * Rendering only: every status and % comes from the server.
 */

import { Edges, OrbitControls } from "@react-three/drei";
import { Canvas, type ThreeEvent } from "@react-three/fiber";
import { useMemo } from "react";
import type { Element3D, PourState, ViewMode } from "@/lib/model3d";

type Piece = {
  key: string;
  elementId: string;
  pos: [number, number, number];
  size: [number, number, number];
  look: "built" | "unsigned" | "progress" | "ghost" | "missing" | "preview";
  colour: string;
};

const GREY = "#9ba4ae";
const RED = "#dc2626";
const VERTICAL = new Set(["column", "wall", "parapet", "overrun"]);

function split(e: Element3D, pct: number, extent: [number, number]): { solid: number[] | null; rest: number[] | null } {
  const [x0, y0, z0, x1, y1, z1] = e.box;
  if (pct >= 100) return { solid: e.box, rest: null };
  if (pct <= 0) return { solid: null, rest: e.box };
  if (VERTICAL.has(e.kind)) {
    const cut = z0 + ((z1 - z0) * pct) / 100;
    return { solid: [x0, y0, z0, x1, y1, cut], rest: [x0, y0, cut, x1, y1, z1] };
  }
  const cut = extent[0] + ((extent[1] - extent[0]) * pct) / 100;
  if (cut <= x0) return { solid: null, rest: e.box };
  if (cut >= x1) return { solid: e.box, rest: null };
  return { solid: [x0, y0, z0, cut, y1, z1], rest: [cut, y0, z0, x1, y1, z1] };
}

function place(box: number[], centre: [number, number, number]): Pick<Piece, "pos" | "size"> {
  const [x0, y0, z0, x1, y1, z1] = box;
  return {
    pos: [(x0 + x1) / 2 - centre[0], (z0 + z1) / 2 - centre[2], -((y0 + y1) / 2 - centre[1])],
    size: [Math.max(x1 - x0, 0.01), Math.max(z1 - z0, 0.01), Math.max(y1 - y0, 0.01)],
  };
}

export function BuildingViewer({
  elements,
  states,
  planned,
  mode,
  colours,
  selected,
  onSelect,
  preview = false,
  className,
}: {
  elements: Element3D[];
  states: Record<string, PourState>;
  planned?: Record<string, PourState>;
  mode: ViewMode;
  colours: Record<string, string>;
  selected?: string | null;
  onSelect?: (id: string | null) => void;
  preview?: boolean;
  className?: string;
}) {
  const { pieces, span, floor } = useMemo(() => {
    const min = [0, 1, 2].map((i) => Math.min(...elements.map((e) => e.box[i])));
    const max = [3, 4, 5].map((i) => Math.max(...elements.map((e) => e.box[i])));
    const centre: [number, number, number] = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const extent: Record<string, [number, number]> = {};
    for (const e of elements) {
      const x = extent[e.pour] ?? [Infinity, -Infinity];
      extent[e.pour] = [Math.min(x[0], e.box[0]), Math.max(x[1], e.box[3])];
    }
    const out: Piece[] = [];
    for (const e of elements) {
      const colour = colours[e.activity] ?? GREY;
      if (preview) {
        out.push({ key: e.id, elementId: e.id, ...place(e.box, centre), look: "preview", colour });
        continue;
      }
      const s = states[e.pour] ?? { status: "not_started", pct: 0, basis: null };
      const { solid, rest } = split(e, s.status === "built" ? 100 : s.pct, extent[e.pour]);
      const unsigned = s.basis === "estimated" || s.basis === "event";
      if (solid) {
        out.push({ key: `${e.id}:s`, elementId: e.id, ...place(solid, centre), colour,
                   look: unsigned ? "unsigned" : s.status === "built" ? "built" : "progress" });
      }
      if (rest) {
        const should = mode === "compare" && planned ? planned[e.pour] : undefined;
        if (should && should.pct > s.pct) {
          const { solid: missing, rest: ghost } = split({ ...e, box: rest }, should.status === "built" ? 100 : should.pct,
                                                       [Math.max(extent[e.pour][0], rest[0]), extent[e.pour][1]]);
          if (missing) out.push({ key: `${e.id}:m`, elementId: e.id, ...place(missing, centre), look: "missing", colour });
          if (ghost) out.push({ key: `${e.id}:g`, elementId: e.id, ...place(ghost, centre), look: "ghost", colour });
        } else {
          out.push({ key: `${e.id}:g`, elementId: e.id, ...place(rest, centre), look: "ghost", colour });
        }
      }
    }
    return { pieces: out, span: Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]), floor: min[2] - centre[2] };
  }, [elements, states, planned, mode, colours, preview]);

  const camera = { position: [-span * 0.95, span * 0.6, span * 1.05] as [number, number, number], fov: 40, near: 0.1, far: span * 20 };

  return (
    <div className={className}>
      <Canvas camera={camera} dpr={[1, 2]} frameloop="demand" onPointerMissed={() => onSelect?.(null)}
              gl={{ antialias: true, preserveDrawingBuffer: true }}>
        <ambientLight intensity={0.75} />
        <directionalLight position={[span, span * 1.6, span * 0.8]} intensity={1.1} />
        <directionalLight position={[-span, span * 0.5, -span]} intensity={0.35} />
        <gridHelper args={[span * 2.4, 24, "#94a3b8", "#cbd5e1"]} position={[0, floor - 0.02, 0]} />
        {pieces.map((p) => (
          <mesh key={p.key} position={p.pos}
                onClick={onSelect ? (ev: ThreeEvent<MouseEvent>) => { ev.stopPropagation(); onSelect(p.elementId); } : undefined}>
            <boxGeometry args={p.size} />
            <PieceMaterial look={p.look} colour={p.colour} selected={selected === p.elementId} />
            {(p.look === "ghost" || p.look === "missing" || selected === p.elementId) && (
              <Edges color={selected === p.elementId ? "#111827" : p.look === "missing" ? RED : "#94a3b8"} />
            )}
          </mesh>
        ))}
        <OrbitControls makeDefault enableDamping={false} maxPolarAngle={Math.PI * 0.49} minDistance={span * 0.3} maxDistance={span * 4} />
      </Canvas>
    </div>
  );
}

function PieceMaterial({ look, colour, selected }: { look: Piece["look"]; colour: string; selected: boolean }) {
  const emissive = selected ? "#facc15" : "#000000";
  switch (look) {
    case "built":
      return <meshStandardMaterial color={GREY} roughness={0.85} emissive={emissive} emissiveIntensity={selected ? 0.35 : 0} />;
    case "progress":
    case "preview":
      return <meshStandardMaterial color={colour} roughness={0.7} emissive={emissive} emissiveIntensity={selected ? 0.35 : 0} />;
    case "unsigned":
      return <meshStandardMaterial color={colour} roughness={0.7} transparent opacity={0.5} depthWrite={false} emissive={emissive} emissiveIntensity={selected ? 0.35 : 0} />;
    case "missing":
      return <meshStandardMaterial color={RED} transparent opacity={0.22} depthWrite={false} />;
    default:
      return <meshStandardMaterial color="#e2e8f0" transparent opacity={0.06} depthWrite={false} />;
  }
}

export function Legend({ mode, future = false }: { mode: ViewMode; future?: boolean }) {
  const item = (swatch: string, label: string, extra = "") => (
    <span className="inline-flex items-center gap-1.5"><span className={`inline-block size-3 rounded-sm ${extra}`} style={{ background: swatch }} />{label}</span>
  );
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {item(GREY, mode === "planned" ? "Planned complete" : "Built (signed report)")}
      {item("linear-gradient(90deg,#4a78b5,#55a07a)", mode === "planned" ? "Planned in progress" : "In progress (activity colour)")}
      {mode !== "planned" && item("rgba(74,120,181,0.45)", future ? "Forecast (not built yet)" : "Reported, not signed yet")}
      {item("transparent", "Not started", "border border-slate-400")}
      {mode === "compare" && item("rgba(220,38,38,0.35)", "Planned by this date but not built", "border border-red-600")}
    </div>
  );
}
