"use client";

import { ChevronRight, Play } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { dayLong, MOOD, readSeen, seenKey } from "@/components/recap/recap-meta";
import { StoryRail } from "@/components/recap/story-rail";
import { StoryViewer } from "@/components/recap/story-viewer";
import { useRecaps } from "@/lib/queries";
import { cn } from "@/lib/utils";

const AUTO_KEY = "sitemate-recap-autoplayed";

/**
 * Home-page entry to the daily recaps. The newest recap plays by itself the first time it is
 * available in this browser; after that it is one tap away here or on the Recaps page.
 */
export function RecapStrip() {
  const recaps = useRecaps();
  const [open, setOpen] = useState<string | null>(null);
  // Auto-play and the headline use the newest finished day; the live "today" story is one tap away.
  const latest = recaps.data?.find((r) => !r.live) ?? recaps.data?.[0];

  useEffect(() => {
    if (!latest) return;
    let played: string | null = null;
    try {
      played = window.sessionStorage.getItem(AUTO_KEY);
    } catch {
      /* storage blocked */
    }
    if (latest.live || played === latest.work_date || readSeen().has(seenKey(latest))) return;
    try {
      window.sessionStorage.setItem(AUTO_KEY, latest.work_date);
    } catch {
      /* storage blocked */
    }
    setOpen(latest.work_date);
  }, [latest]);

  if (!recaps.data?.length || !latest) return null;

  return (
    <section aria-label="Daily recaps" className="mb-5 flex flex-col gap-3 rounded-2xl border bg-card p-4 md:flex-row md:items-center md:gap-5">
      <button
        type="button"
        onClick={() => setOpen(latest.work_date)}
        className="flex items-center gap-3 rounded-2xl text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:w-64 md:shrink-0"
      >
        <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-foreground text-background">
          <Play className="size-4 fill-current" aria-hidden />
        </span>
        <span className="min-w-0">
          <span className="block text-[15px] font-semibold">Recap of {dayLong(latest.work_date)}</span>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className={cn("size-1.5 rounded-full", MOOD[latest.mood].bar)} aria-hidden />
            {latest.mood_label} · {latest.cards.length} cards
          </span>
        </span>
      </button>
      <StoryRail recaps={recaps.data.slice(0, 6)} onOpen={setOpen} size="sm" className="min-w-0 flex-1" />
      <Link href="/recaps" className="inline-flex items-center gap-1 self-start text-sm font-medium text-muted-foreground hover:text-foreground md:self-center">
        All recaps <ChevronRight className="size-4" aria-hidden />
      </Link>
      {open && <StoryViewer recaps={recaps.data} startDate={open} onClose={() => setOpen(null)} />}
    </section>
  );
}
