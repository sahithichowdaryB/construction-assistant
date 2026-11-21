"use client";

import { Bookmark, ChevronLeft, ChevronRight, HardHat, Pause, Play, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CHAPTERS, cardKey, chapterCount, dayShort, markSeen, readSaved, seenKey, toggleSaved } from "@/components/recap/recap-meta";
import { StoryCard } from "@/components/recap/story-card";
import type { DayRecap } from "@/lib/types";
import { cn } from "@/lib/utils";

const CARD_MS = 7000;

/**
 * Full-screen story player for daily recaps. Recaps are newest first; the day switcher shows them
 * oldest to newest like a timeline. It sits below the evidence sheet (z-40) so citations open on top.
 */
export function StoryViewer({
  recaps,
  startDate,
  startCard = 0,
  onClose,
}: {
  recaps: DayRecap[];
  startDate: string;
  startCard?: number;
  onClose: () => void;
}) {
  const days = useMemo(() => [...recaps].sort((a, b) => a.work_date.localeCompare(b.work_date)), [recaps]);
  const [dayIdx, setDayIdx] = useState(() => Math.max(0, days.findIndex((d) => d.work_date === startDate)));
  const [cardIdx, setCardIdx] = useState(startCard);
  const [paused, setPaused] = useState(false);
  const [saved, setSaved] = useState<Set<string>>(() => new Set());
  const closeRef = useRef<HTMLButtonElement>(null);

  const day = days[dayIdx];
  const card = day?.cards[cardIdx];

  useEffect(() => {
    setSaved(readSaved());
    closeRef.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    if (day) markSeen(seenKey(day));
  }, [day]);

  const go = useCallback(
    (delta: 1 | -1) => {
      if (!day) return;
      const next = cardIdx + delta;
      if (next >= 0 && next < day.cards.length) return setCardIdx(next);
      if (delta === 1 && dayIdx < days.length - 1) {
        setDayIdx(dayIdx + 1);
        setCardIdx(0);
      } else if (delta === -1 && dayIdx > 0) {
        setDayIdx(dayIdx - 1);
        setCardIdx(days[dayIdx - 1].cards.length - 1);
      } else if (delta === 1) {
        setPaused(true);
      }
    },
    [cardIdx, day, dayIdx, days],
  );

  const pickDay = (i: number) => {
    setDayIdx(i);
    setCardIdx(0);
    setPaused(false);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector("[data-slot=sheet-content]")) return; // evidence sheet is open
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === " ") {
        e.preventDefault();
        setPaused((p) => !p);
      } else if (e.key.toLowerCase() === "b" && day && card) {
        toggleSaved(cardKey(day, card));
        setSaved(readSaved());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [card, day, go, onClose]);

  if (!day || !card) return null;
  const isSaved = saved.has(cardKey(day, card));
  const prevCard = cardIdx > 0 ? day.cards[cardIdx - 1] : null;
  const nextCard = cardIdx < day.cards.length - 1 ? day.cards[cardIdx + 1] : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Daily recap, ${dayShort(day.work_date)}`}
      className="fixed inset-0 z-40 flex flex-col bg-[#0c0d0f] text-white animate-in fade-in-0 duration-200"
      // Following a link on a card leaves the recap; opening a citation pauses it.
      onClickCapture={(e) => {
        const el = e.target as HTMLElement;
        if (el.closest("a[href]")) onClose();
        else if (el.closest('button[aria-label^="Open evidence"]')) setPaused(true);
      }}
    >
      {/* Top bar */}
      <div className="flex items-center gap-3 px-4 pt-[max(env(safe-area-inset-top),0.75rem)] pb-2 md:px-7">
        <span className="flex size-8 items-center justify-center rounded-[10px] bg-primary text-primary-foreground">
          <HardHat className="size-4" aria-hidden />
        </span>
        <p className="hidden text-[15px] font-semibold sm:block">Daily recap</p>
        <div className="ml-1 flex min-w-0 flex-1 gap-1.5 overflow-x-auto md:ml-6" role="tablist" aria-label="Days">
          {days.map((d, i) => (
            <button
              key={d.work_date}
              type="button"
              role="tab"
              aria-selected={i === dayIdx}
              onClick={() => pickDay(i)}
              className={cn(
                "shrink-0 rounded-full px-3 py-1.5 text-[12.5px] font-medium whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none",
                i === dayIdx ? "bg-white text-[#111214]" : "bg-white/8 text-white/70 hover:bg-white/15",
              )}
            >
              {d.live ? (
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-1.5 animate-pulse rounded-full bg-destructive" aria-hidden /> Today · live
                </span>
              ) : (
                dayShort(d.work_date)
              )}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => {
            toggleSaved(cardKey(day, card));
            setSaved(readSaved());
          }}
          aria-pressed={isSaved}
          aria-label={isSaved ? "Remove from saved moments" : "Save this moment"}
          className="flex size-10 items-center justify-center rounded-xl bg-white/8 hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none"
        >
          <Bookmark className={cn("size-[18px]", isSaved && "fill-primary text-primary")} aria-hidden />
        </button>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close recap"
          className="flex size-10 items-center justify-center rounded-xl bg-white/8 hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none"
        >
          <X className="size-5" aria-hidden />
        </button>
      </div>

      {/* Stage */}
      <div className="flex min-h-0 flex-1 items-center justify-center gap-6 px-2 md:px-6">
        <SidePreview card={prevCard} onClick={() => go(-1)} side="left" />
        <NavButton dir="left" onClick={() => go(-1)} disabled={cardIdx === 0 && dayIdx === 0} />

        <div className="relative h-full max-h-[760px] w-full max-w-[430px] overflow-hidden rounded-[28px] shadow-[0_40px_80px_-30px_rgba(0,0,0,0.8)] md:h-[calc(100%-1rem)]">
          <StoryCard key={`${day.work_date}/${card.id}`} card={card} />
          {/* progress + header overlay */}
          <div className="pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-b from-black/55 to-transparent px-3.5 pt-3 pb-8">
            <div className="flex gap-1">
              {day.cards.map((c, i) => (
                <span key={c.id} className="h-[3px] flex-1 overflow-hidden rounded-full bg-white/25">
                  {i < cardIdx && <span className="block h-full w-full bg-white" />}
                  {i === cardIdx && (
                    <span
                      key={`${day.work_date}/${c.id}`}
                      className="block h-full origin-left bg-white motion-safe:animate-[story-progress_7s_linear_forwards]"
                      style={{ animationDuration: `${CARD_MS}ms`, animationPlayState: paused ? "paused" : "running" }}
                      onAnimationEnd={() => go(1)}
                    />
                  )}
                </span>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-2 text-[12.5px] font-semibold">
              <span className="flex size-7 items-center justify-center rounded-full bg-primary text-primary-foreground ring-2 ring-black/40">
                <HardHat className="size-3.5" aria-hidden />
              </span>
              {dayShort(day.work_date)}
              <span className="font-normal text-white/60">
                · {day.mood_label} · {cardIdx + 1} of {day.cards.length}
              </span>
            </div>
          </div>
          {/* tap zones (mobile) */}
          <button type="button" aria-label="Previous card" className="absolute top-20 bottom-28 left-0 w-1/3 md:hidden" onClick={() => go(-1)} />
          <button type="button" aria-label="Next card" className="absolute top-20 right-0 bottom-28 w-1/3 md:hidden" onClick={() => go(1)} />
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            aria-label={paused ? "Play" : "Pause"}
            className="absolute top-12 right-3 flex size-8 items-center justify-center rounded-full text-white/85 hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none"
          >
            {paused ? <Play className="size-4" aria-hidden /> : <Pause className="size-4" aria-hidden />}
          </button>
        </div>

        <NavButton dir="right" onClick={() => go(1)} disabled={cardIdx === day.cards.length - 1 && dayIdx === days.length - 1} />
        <SidePreview card={nextCard} onClick={() => go(1)} side="right" />
      </div>

      {/* Chapter dock */}
      <div className="flex items-center justify-center px-3 pt-3 pb-[max(env(safe-area-inset-bottom),0.9rem)]">
        <div className="flex max-w-full gap-1 overflow-x-auto rounded-2xl bg-white/6 p-1.5" role="tablist" aria-label="Chapters">
          {CHAPTERS.filter((c) => chapterCount(day, c.key) > 0).map((c) => {
            const first = day.cards.findIndex((x) => x.chapter === c.key);
            const active = card.chapter === c.key;
            const n = chapterCount(day, c.key);
            return (
              <button
                key={c.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => {
                  setCardIdx(first);
                  setPaused(false);
                }}
                className={cn(
                  "flex shrink-0 items-center gap-2 rounded-xl px-3 py-2 text-[13px] font-medium whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none",
                  active ? "bg-white text-[#111214]" : "text-white/65 hover:text-white",
                )}
              >
                <span className={cn("size-2 rounded-full", c.dot, c.key === "today" && active && "bg-[#111214]")} aria-hidden />
                {c.label}
                {n > 1 && <span className={cn("rounded-md px-1.5 text-[11px] tabular", active ? "bg-[#111214] text-white" : "bg-white/10")}>{n}</span>}
              </button>
            );
          })}
        </div>
        <p className="ml-6 hidden text-[11.5px] text-white/40 xl:block">← → card · Space pause · B save · Esc close</p>
      </div>
    </div>
  );
}

function NavButton({ dir, onClick, disabled }: { dir: "left" | "right"; onClick: () => void; disabled: boolean }) {
  const Icon = dir === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={dir === "left" ? "Previous card" : "Next card"}
      className="hidden size-11 shrink-0 items-center justify-center rounded-full bg-white/90 text-[#111214] transition hover:bg-white disabled:opacity-25 focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none md:flex"
    >
      <Icon className="size-5" aria-hidden />
    </button>
  );
}

function SidePreview({ card, onClick, side }: { card: DayRecap["cards"][number] | null; onClick: () => void; side: "left" | "right" }) {
  return (
    <div className="hidden h-[68%] max-h-[540px] w-[290px] shrink-0 xl:block">
      {card && (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          onClick={onClick}
          className={cn(
            "h-full w-full overflow-hidden rounded-[22px] text-left opacity-40 saturate-50 transition hover:opacity-60",
            side === "left" ? "origin-right" : "origin-left",
          )}
        >
          <StoryCard card={card} compact />
        </button>
      )}
    </div>
  );
}
