/**
 * Construction-site scenery behind every page. In dark mode it is drawn in light lines and stronger, so
 * it reads on the dark background. Moving parts: the crane jib swings, its hook bobs with a beam, the
 * warning light blinks, an excavator drives along the ground digging, a dump truck follows, dust puffs
 * rise, and a few hard hats, cones and beams drift in the margins.
 * It never takes clicks and sits under the cards; motion is dropped for people who prefer reduced motion.
 */
export function Backdrop() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden text-foreground dark:text-[#e8e2d0]">
      {/* blueprint grid */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            "linear-gradient(color-mix(in oklab, currentColor 7%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in oklab, currentColor 7%, transparent) 1px, transparent 1px), linear-gradient(color-mix(in oklab, currentColor 3.5%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in oklab, currentColor 3.5%, transparent) 1px, transparent 1px)",
          backgroundSize: "128px 128px, 128px 128px, 32px 32px, 32px 32px",
        }}
      />
      {/* warm site glows */}
      <div className="absolute -top-48 right-[-8%] size-[40rem] rounded-full bg-primary/15 blur-3xl motion-safe:animate-[float-slow_22s_ease-in-out_infinite] dark:bg-primary/12" />
      <div className="absolute bottom-[-14rem] left-[20%] size-[30rem] rounded-full bg-primary/8 blur-3xl motion-safe:animate-[float-slow_30s_ease-in-out_infinite_reverse] dark:bg-amber-500/10" />

      {/* tower crane on the right */}
      <svg viewBox="0 0 320 760" className="absolute right-[-40px] bottom-16 h-[82vh] max-h-[760px] opacity-[0.16] dark:opacity-[0.32]" preserveAspectRatio="xMaxYMax meet">
        <g fill="none" stroke="currentColor" strokeWidth="3" strokeLinejoin="round">
          <path d="M200 760 V120 M236 760 V120" />
          {Array.from({ length: 20 }, (_, i) => (
            <path key={i} d={`M200 ${760 - i * 32} L236 ${728 - i * 32} M236 ${760 - i * 32} L200 ${728 - i * 32}`} strokeWidth="1.6" />
          ))}
          <rect x="190" y="100" width="56" height="34" rx="3" className="fill-primary/50" />
          <g className="motion-safe:animate-[crane-swing_10s_ease-in-out_infinite] [transform-box:view-box] [transform-origin:218px_100px]">
            <path d="M-120 100 H300 M-120 84 H300" strokeWidth="2.4" />
            {Array.from({ length: 14 }, (_, i) => <path key={i} d={`M${-120 + i * 30} 100 L${-105 + i * 30} 84`} strokeWidth="1.4" />)}
            <path d="M218 40 L-110 84 M218 40 L290 84 M218 40 V100" strokeWidth="2" />
            <rect x="250" y="100" width="44" height="26" className="fill-current opacity-40" />
            {/* warning light at the top */}
            <circle cx="218" cy="36" r="6" className="fill-red-500 stroke-none motion-safe:animate-[blink_1.6s_steps(2,start)_infinite]" />
            <g className="motion-safe:animate-[hook-bob_6s_ease-in-out_infinite]">
              <rect x="-30" y="100" width="18" height="8" />
              <path d="M-21 108 V300" strokeWidth="1.6" strokeDasharray="5 4" />
              <path d="M-21 300 q-9 0 -9 10 q0 10 9 10" strokeWidth="2.4" />
              <path d="M-70 334 H28" strokeWidth="9" className="stroke-primary" />
              <path d="M-21 320 L-60 334 M-21 320 L18 334" strokeWidth="1.6" />
            </g>
          </g>
        </g>
      </svg>

      {/* skyline */}
      <svg viewBox="0 0 1400 220" preserveAspectRatio="xMidYMax slice" className="absolute inset-x-0 bottom-0 h-56 w-full opacity-[0.14] dark:opacity-[0.3]">
        <g fill="none" stroke="currentColor" strokeWidth="2.4">
          <path d="M0 200 H1400" />
          <path d="M40 200 V110 H170 V200" />
          {[130, 150, 170].map((y) => <path key={y} d={`M58 ${y} h22 M100 ${y} h22 M142 ${y} h18`} strokeWidth="5" />)}
          <path d="M210 200 V60 H330 V200" />
          {[80, 100, 120, 140, 160, 180].map((y) => (
            <path key={y} d={`M228 ${y} h20 M268 ${y} h20 M306 ${y} h14`} strokeWidth="5"
                  className={y === 120 || y === 160 ? "stroke-primary motion-safe:animate-[window-glow_7s_ease-in-out_infinite]" : undefined} />
          ))}
          <path d="M420 200 V90 H600 V200 M420 135 H600 M480 90 V200 M540 90 V200" />
          <path d="M408 200 V80 M612 200 V80 M408 110 H612 M408 150 H612 M408 190 H612" strokeWidth="1.4" strokeDasharray="6 5" />
          <path d="M408 110 L440 150 M440 110 L408 150 M580 150 L612 190 M612 150 L580 190" strokeWidth="1.2" />
          {/* welding spark on the frame */}
          <g className="motion-safe:animate-[blink_0.9s_steps(2,start)_infinite]">
            <path d="M540 135 l8 -8 M540 135 l10 2 M540 135 l4 9 M540 135 l-7 -6" className="stroke-primary" strokeWidth="2" />
          </g>
          <path d="M720 200 V130 H840 V200" />
          {[150, 172].map((y) => <path key={y} d={`M738 ${y} h20 M778 ${y} h20 M816 ${y} h12`} strokeWidth="5" />)}
          <path d="M900 200 l10 -26 l10 26 z M935 200 l10 -26 l10 26 z" className="fill-primary" strokeWidth="1.6" />
          <path d="M980 200 V176 M1060 200 V176 M972 176 H1068" strokeWidth="2.4" />
          <path d="M1130 200 V100 H1260 V200" />
          {[120, 145, 170].map((y) => <path key={y} d={`M1148 ${y} h22 M1192 ${y} h22 M1234 ${y} h14`} strokeWidth="5" />)}
          <path d="M1300 200 V150 H1380 V200" />
        </g>
      </svg>

      {/* an excavator and a dump truck driving along the ground */}
      <div className="absolute bottom-3 left-0 motion-safe:animate-[drive_70s_linear_infinite] opacity-[0.2] dark:opacity-[0.4]">
        <svg viewBox="0 0 330 90" className="h-16 w-auto">
          <g fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinejoin="round">
            {/* dump truck */}
            <path d="M8 66 V40 H70 L86 56 V66 Z" className="fill-primary/60" />
            <path d="M86 66 V48 H110 L118 58 V66 Z" />
            <circle cx="30" cy="70" r="8" /><circle cx="100" cy="70" r="8" />
            {/* excavator */}
            <rect x="160" y="62" width="110" height="16" rx="8" />
            <circle cx="172" cy="70" r="5" /><circle cx="258" cy="70" r="5" />
            <path d="M178 62 V40 H236 V62 Z" className="fill-primary/60" />
            <path d="M200 40 V24 H228 V40" />
            <g className="motion-safe:animate-[dig_4s_ease-in-out_infinite] [transform-box:fill-box] [transform-origin:0%_100%]">
              <path d="M236 46 L284 18 L314 46" strokeWidth="5" className="stroke-primary" />
              <path d="M314 46 l-14 14 l20 0 z" className="fill-current" />
            </g>
          </g>
        </svg>
      </div>
      {/* dust puffs */}
      {[18, 46, 74].map((left, i) => (
        <span key={left} className="absolute bottom-20 size-6 rounded-full bg-current opacity-0 blur-md motion-safe:animate-[dust_6s_ease-out_infinite] dark:bg-amber-200"
              style={{ left: `${left}%`, animationDelay: `${i * 2}s` }} />
      ))}
      <div className="absolute inset-x-0 bottom-0 h-2 bg-[repeating-linear-gradient(-45deg,var(--primary)_0_14px,#111214_14px_28px)] opacity-60 motion-safe:animate-[stripe-slide_3s_linear_infinite] dark:opacity-70" style={{ backgroundSize: "40px 40px" }} />

      {/* drifting site icons in the margins */}
      <svg viewBox="0 0 64 64" className="absolute top-[18%] right-[22%] size-14 opacity-[0.16] motion-safe:animate-[float-slow_18s_ease-in-out_infinite] dark:opacity-[0.35]">
        <path d="M10 42 h44 v6 H10z" className="fill-primary" />
        <path d="M14 42 a18 18 0 0 1 36 0" fill="none" stroke="currentColor" strokeWidth="3" />
        <path d="M32 24 v18" stroke="currentColor" strokeWidth="3" />
      </svg>
      <svg viewBox="0 0 64 64" className="absolute top-[62%] right-[30%] size-10 opacity-[0.14] motion-safe:animate-[float-slow_24s_ease-in-out_infinite_reverse] dark:opacity-[0.32]">
        <path d="M32 6 L48 56 H16 Z" className="fill-primary" />
        <path d="M24 32 h16 M20 44 h24" stroke="currentColor" strokeWidth="4" />
        <path d="M10 56 h44" stroke="currentColor" strokeWidth="4" />
      </svg>
      <svg viewBox="0 0 80 40" className="absolute top-[38%] right-[8%] w-16 opacity-[0.14] motion-safe:animate-[float-slow_20s_ease-in-out_infinite] dark:opacity-[0.32]">
        <path d="M4 6 h72 v6 H44 v16 h32 v6 H4 v-6 h32 V12 H4z" fill="none" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" />
      </svg>
      <svg viewBox="0 0 64 64" className="absolute top-[8%] left-[32%] size-12 opacity-[0.12] motion-safe:animate-[float-slow_26s_ease-in-out_infinite] dark:opacity-[0.28]">
        {/* brick stack */}
        <g fill="none" stroke="currentColor" strokeWidth="3">
          <rect x="6" y="40" width="24" height="12" /><rect x="34" y="40" width="24" height="12" /><rect x="20" y="26" width="24" height="12" className="fill-primary/60" />
        </g>
      </svg>
      <svg viewBox="0 0 64 64" className="absolute top-[78%] left-[44%] size-10 opacity-[0.12] motion-safe:animate-[float-slow_22s_ease-in-out_infinite_reverse] dark:opacity-[0.28]">
        {/* wrench */}
        <path d="M44 8 a12 12 0 0 0 -12 16 L10 46 a5 5 0 0 0 8 8 L40 32 a12 12 0 0 0 16 -12 l-8 6 l-6 -2 l-2 -6 z" fill="none" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" />
      </svg>
    </div>
  );
}
