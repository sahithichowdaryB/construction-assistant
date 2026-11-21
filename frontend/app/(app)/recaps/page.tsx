"use client";

import { Bookmark, Clapperboard, Mic, Play } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { cardKey, dayLong, dayShort, MOOD, readSaved } from "@/components/recap/recap-meta";
import { RecapCoverArt } from "@/components/recap/recap-cover";
import { StoryRail } from "@/components/recap/story-rail";
import { StoryViewer } from "@/components/recap/story-viewer";
import { EmptyState, LoadingSkeleton, PageHeader, QueryState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useRecaps } from "@/lib/queries";
import type { DayRecap, RecapMood } from "@/lib/types";
import { cn } from "@/lib/utils";

type Open = { date: string; card: number } | null;

export default function RecapsPage() {
  const recaps = useRecaps();
  const [open, setOpen] = useState<Open>(null);

  return (
    <>
      <PageHeader title="Recaps" description="Every site day as a short story, made the next morning from that day's notes, photos and reports. Replay any day." />
      <QueryState
        query={recaps}
        loading={<LoadingSkeleton variant="cards" rows={2} />}
        isEmpty={(d) => d.length === 0}
        empty={
          <EmptyState
            icon={<Clapperboard className="size-6" aria-hidden />}
            title="No recap yet"
            description="A recap appears the morning after a site day. Move the as-of clock forward to see earlier days."
            action={
              <Button asChild variant="outline">
                <Link href="/capture">
                  <Mic aria-hidden /> Record a site note
                </Link>
              </Button>
            }
          />
        }
      >
        {(list) => (
          <div className="flex flex-col gap-5">
            <Card className="px-5 py-4">
              <StoryRail recaps={list} onOpen={(date) => setOpen({ date, card: 0 })} />
            </Card>
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
              <MonthCalendar recaps={list} onOpen={(date) => setOpen({ date, card: 0 })} />
              <SavedMoments recaps={list} onOpen={setOpen} />
            </div>
          </div>
        )}
      </QueryState>
      {open && recaps.data && <StoryViewer recaps={recaps.data} startDate={open.date} startCard={open.card} onClose={() => setOpen(null)} />}
    </>
  );
}

const LEGEND: { mood: RecapMood; label: string }[] = [
  { mood: "on_plan", label: "On plan" },
  { mood: "minor", label: "Minor issues" },
  { mood: "disrupted", label: "Disrupted" },
  { mood: "weather", label: "Weather" },
];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function MonthCalendar({ recaps, onOpen }: { recaps: DayRecap[]; onOpen: (date: string) => void }) {
  const [y, m] = recaps[0].work_date.split("-").map(Number);
  const byDate = new Map(recaps.map((r) => [r.work_date, r]));
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7; // Monday first
  const cells: (number | null)[] = [...Array<null>(lead).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];

  return (
    <Card className="gap-4 px-5 py-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold">
          {MONTHS[m - 1]} {y}
        </h2>
        <ul className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          {LEGEND.map((l) => (
            <li key={l.mood} className="flex items-center gap-1.5">
              <span className={cn("size-2 rounded-full", MOOD[l.mood].bar)} aria-hidden /> {l.label}
            </li>
          ))}
        </ul>
      </div>
      <div className="grid grid-cols-7 gap-1.5 sm:gap-2">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <p key={d} className="text-center text-[11px] font-semibold text-muted-foreground">
            {d}
          </p>
        ))}
        {cells.map((d, i) => {
          if (d === null) return <span key={`b${i}`} />;
          const date = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          const r = byDate.get(date);
          if (!r)
            return (
              <span key={date} className="flex h-14 items-start rounded-xl p-2 text-xs font-medium text-muted-foreground/60 sm:h-[76px]">
                {d}
              </span>
            );
          return (
            <button
              key={date}
              type="button"
              onClick={() => onOpen(date)}
              aria-label={`Play recap for ${dayLong(date)}: ${r.mood_label}`}
              className="group flex h-14 flex-col justify-between rounded-xl bg-muted p-2 text-left transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:h-[76px]"
            >
              <span className="flex items-center justify-between text-xs font-semibold">
                {d}
                <span className="hidden size-5 items-center justify-center rounded-full bg-foreground text-background sm:flex">
                  <Play className="size-2.5 fill-current" aria-hidden />
                </span>
              </span>
              <span>
                <span className="hidden truncate text-[10.5px] text-muted-foreground sm:block">{r.short_label}</span>
                <span className={cn("mt-1 block h-1.5 rounded-full", MOOD[r.mood].bar)} />
              </span>
            </button>
          );
        })}
      </div>
    </Card>
  );
}

function SavedMoments({ recaps, onOpen }: { recaps: DayRecap[]; onOpen: (o: Open) => void }) {
  const [saved, setSaved] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const sync = () => setSaved(readSaved());
    sync();
    window.addEventListener("sitemate-recaps", sync);
    return () => window.removeEventListener("sitemate-recaps", sync);
  }, []);

  const items = useMemo(
    () =>
      recaps.flatMap((r) =>
        r.cards.flatMap((c, idx) => (saved.has(cardKey(r, c)) ? [{ recap: r, card: c, idx }] : [])),
      ),
    [recaps, saved],
  );

  return (
    <Card className="gap-4 px-5 py-5">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold">
          <Bookmark className="size-4" aria-hidden /> Saved moments
        </h2>
        <span className="text-xs text-muted-foreground">Saved in this browser</span>
      </div>
      {items.length === 0 ? (
        <p className="rounded-2xl bg-muted p-4 text-sm text-muted-foreground">
          Tap the bookmark on any story card (or press <kbd className="rounded bg-background px-1 font-mono text-xs">B</kbd>) to keep it here.
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {items.map(({ recap, card, idx }) => (
            <li key={cardKey(recap, card)}>
              <button
                type="button"
                onClick={() => onOpen({ date: recap.work_date, card: idx })}
                className="group relative flex h-44 w-full flex-col justify-end overflow-hidden rounded-2xl bg-[#17191c] p-3 text-left text-white focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                {card.cover && <RecapCoverArt kind={card.cover} className="absolute inset-0 size-full opacity-80 transition-opacity group-hover:opacity-100" />}
                <span className="absolute inset-0 bg-gradient-to-b from-transparent via-black/20 to-black/85" />
                <span className="relative text-[13px] leading-snug font-semibold">{card.title}</span>
                <span className="relative mt-1 text-[11px] text-white/70">{dayShort(recap.work_date)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
