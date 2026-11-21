"use client";

import { useEffect, useState } from "react";
import { dayShort, MOOD, readSeen, seenKey } from "@/components/recap/recap-meta";
import { RecapCoverArt } from "@/components/recap/recap-cover";
import type { DayRecap } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Re-reads the per-browser "seen" list whenever the viewer marks a recap as watched. */
export function useSeenRecaps() {
  const [seen, setSeen] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const sync = () => setSeen(readSeen());
    sync();
    window.addEventListener("sitemate-recaps", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("sitemate-recaps", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return seen;
}

/** Instagram-style row of day circles. Coloured ring = not watched yet. */
export function StoryRail({
  recaps,
  onOpen,
  size = "md",
  className,
}: {
  recaps: DayRecap[];
  onOpen: (workDate: string) => void;
  size?: "sm" | "md";
  className?: string;
}) {
  const seen = useSeenRecaps();
  const circle = size === "sm" ? "size-16" : "size-[76px]";
  return (
    <ul className={cn("flex gap-4 overflow-x-auto pb-1 [scrollbar-width:none]", className)} aria-label="Daily recaps">
      {recaps.map((r, i) => {
        const fresh = !seen.has(seenKey(r));
        const latest = !r.live && recaps.findIndex((x) => !x.live) === i;
        const name = r.live ? "Today" : latest ? "Latest" : dayShort(r.work_date);
        const sub = r.live ? "so far" : latest ? dayShort(r.work_date) : r.short_label;
        return (
          <li key={r.work_date} className="shrink-0">
            <button
              type="button"
              onClick={() => onOpen(r.work_date)}
              className="group flex w-[84px] flex-col items-center gap-1.5 rounded-2xl p-1 text-center focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              aria-label={`Play recap for ${dayShort(r.work_date)}: ${r.mood_label}${fresh ? ", not watched" : ""}`}
            >
              <span
                className={cn("relative rounded-full p-[3px] transition-transform group-hover:scale-105", circle)}
                style={{ background: fresh ? "conic-gradient(#ffc400, #ff8a00, #d23b2c, #ffc400)" : "var(--border)" }}
              >
                <span className="block size-full overflow-hidden rounded-full border-[3px] border-background">
                  <RecapCoverArt kind={r.cover} className="size-full" />
                </span>
                {r.live && (
                  <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 rounded-md bg-destructive px-1.5 text-[10px] leading-4 font-bold tracking-wide text-white ring-2 ring-background">
                    LIVE
                  </span>
                )}
              </span>
              <span className="text-[12.5px] leading-tight font-semibold">{name}</span>
              <span className="-mt-1 flex items-center gap-1 text-[11px] leading-tight text-muted-foreground">
                <span className={cn("size-1.5 rounded-full", MOOD[r.mood].bar)} aria-hidden />
                {sub}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
