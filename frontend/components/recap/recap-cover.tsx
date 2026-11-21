import type { ReactNode } from "react";
import type { RecapCover } from "@/lib/types";

/**
 * Flat site illustrations used as story covers. They are decoration only: the evidence (real photos,
 * voice notes) opens from the citation chips on each card.
 */
export function RecapCoverArt({ kind, className }: { kind: RecapCover; className?: string }) {
  return (
    <svg viewBox="0 0 420 260" preserveAspectRatio="xMidYMid slice" className={className} aria-hidden>
      <defs>
        <linearGradient id={`sky-${kind}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={kind === "rain" ? "#46566a" : "#5a6b80"} />
          <stop offset="1" stopColor={kind === "rain" ? "#6b7a8c" : "#93a4b6"} />
        </linearGradient>
      </defs>
      <rect width="420" height="260" fill={`url(#sky-${kind})`} />
      <path d="M0 170 L420 150 L420 260 L0 260z" fill="#6b5442" />
      <path d="M0 205 L420 190 L420 260 L0 260z" fill="#57422f" />
      {SCENES[kind]}
    </svg>
  );
}

const excavator = (x: number, y: number, burst = false) => (
  <g transform={`translate(${x},${y})`}>
    <rect x="0" y="40" width="130" height="52" rx="8" fill="#ffc400" />
    <rect x="26" y="4" width="62" height="40" rx="6" fill="#ffd84d" />
    <rect x="36" y="12" width="42" height="22" rx="3" fill="#2b3a4a" />
    <rect x="-8" y="88" width="148" height="22" rx="11" fill="#2b2f35" />
    <path d="M128 58 L190 -8 L212 26" stroke="#ffc400" strokeWidth="13" fill="none" strokeLinejoin="round" />
    <path d="M206 22 l14 22 l-22 6z" fill="#e0ab00" />
    {burst && (
      <>
        <path d="M142 66 q11 -14 23 -4 q8 8 -4 18" stroke="#111214" strokeWidth="5" fill="none" />
        <ellipse cx="164" cy="116" rx="46" ry="8" fill="#151515" opacity="0.75" />
        <path d="M160 80 q4 16 2 32" stroke="#1a1a1a" strokeWidth="3" fill="none" />
        <circle cx="158" cy="76" r="30" fill="none" stroke="#ff6b5b" strokeWidth="3" strokeDasharray="7 5" />
      </>
    )}
  </g>
);

const SCENES: Record<RecapCover, ReactNode> = {
  breakdown: excavator(70, 70, true),
  excavation: (
    <>
      <path d="M150 196 L380 186 L360 236 L170 244z" fill="#3e2e22" />
      {excavator(40, 80)}
    </>
  ),
  concrete: (
    <>
      <path d="M40 190 L390 176 L390 214 L40 230z" fill="#b8b4aa" />
      <path d="M40 190 L390 176 L390 184 L40 198z" fill="#d6d2c8" />
      <rect x="250" y="88" width="120" height="62" rx="10" fill="#e5e1d8" />
      <ellipse cx="300" cy="104" rx="42" ry="26" fill="#ffc400" />
      <path d="M262 136 L210 178" stroke="#6b7078" strokeWidth="10" strokeLinecap="round" />
      <rect x="248" y="146" width="132" height="16" rx="8" fill="#2b2f35" />
    </>
  ),
  steel: (
    <>
      {[0, 1, 2, 3, 4, 5, 6].map((i) => (
        <line key={i} x1="70" x2="350" y1={150 + i * 7} y2={164 + i * 7} stroke="#8a4f2a" strokeWidth="5" strokeLinecap="round" />
      ))}
      <rect x="120" y="140" width="10" height="70" fill="#2b2f35" />
      <rect x="290" y="146" width="10" height="70" fill="#2b2f35" />
    </>
  ),
  formwork: (
    <>
      {[0, 1, 2, 3].map((i) => (
        <rect key={i} x={70 + i * 72} y="96" width="62" height="98" rx="3" fill={i % 2 ? "#c79a5b" : "#d9ad6c"} stroke="#8a6a3c" strokeWidth="2" />
      ))}
      <line x1="60" x2="370" y1="120" y2="120" stroke="#6b7078" strokeWidth="5" />
      <line x1="60" x2="370" y1="170" y2="170" stroke="#6b7078" strokeWidth="5" />
    </>
  ),
  meeting: (
    <>
      <rect x="130" y="54" width="160" height="176" rx="12" fill="#f4f3ef" />
      <rect x="180" y="44" width="60" height="22" rx="8" fill="#6b7078" />
      {[0, 1, 2, 3, 4].map((i) => (
        <rect key={i} x="152" y={92 + i * 24} width={i === 4 ? 70 : 116} height="9" rx="4.5" fill="#c9c4b8" />
      ))}
      <circle cx="300" cy="80" r="30" fill="#ffc400" />
      <path d="M288 80 l9 9 l16 -18" stroke="#111214" strokeWidth="6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  crack: (
    <>
      <path d="M30 176 L400 160 L400 222 L30 240z" fill="#b8b4aa" />
      <path d="M210 168 l-12 16 l14 8 l-16 14 l10 10 l-12 16" stroke="#2b2f35" strokeWidth="4" fill="none" strokeLinejoin="round" />
      <circle cx="205" cy="200" r="40" fill="none" stroke="#ff6b5b" strokeWidth="3" strokeDasharray="7 5" />
    </>
  ),
  rain: (
    <>
      <path d="M40 196 L390 182 L390 214 L40 228z" fill="#3e4b5a" />
      {Array.from({ length: 22 }, (_, i) => (
        <line key={i} x1={20 + i * 19} x2={12 + i * 19} y1={20 + (i % 4) * 26} y2={40 + (i % 4) * 26} stroke="#cfe0f2" strokeWidth="2" strokeLinecap="round" opacity="0.8" />
      ))}
      <rect x="250" y="130" width="110" height="46" rx="8" fill="#e5e1d8" />
      <rect x="240" y="170" width="130" height="14" rx="7" fill="#2b2f35" />
    </>
  ),
};
