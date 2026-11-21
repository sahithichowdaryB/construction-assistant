"use client";

import { ArrowRight, CheckCircle2, Clock } from "lucide-react";
import Link from "next/link";
import { CitationChip } from "@/components/citation-chip";
import { CHAPTER_PILL, CHAPTERS, TONE_TEXT, TONE_TILE } from "@/components/recap/recap-meta";
import { RecapCoverArt } from "@/components/recap/recap-cover";
import { fmtTime } from "@/lib/time";
import type { RecapCard, RecapStripSegment } from "@/lib/types";
import { cn } from "@/lib/utils";

const STRIP_COLOR: Record<RecapStripSegment["state"], string> = {
  working: "bg-success",
  stopped: "bg-destructive",
  rain: "bg-info",
  idle: "bg-white/20",
};

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

function DayStrip({ segments, label }: { segments: RecapStripSegment[]; label?: string | null }) {
  const start = toMin(segments[0].from);
  const end = toMin(segments.at(-1)!.to);
  const span = Math.max(1, end - start);
  return (
    <div>
      <div className="mb-1.5 flex justify-between text-[11px] text-white/55">
        <span>{label ? `${label} through the day` : "Through the day"}</span>
        <span>
          {segments[0].from}–{segments.at(-1)!.to}
        </span>
      </div>
      <div className="flex h-3 gap-0.5 overflow-hidden rounded-full">
        {segments.map((s) => (
          <span key={s.from} className={cn("h-full", STRIP_COLOR[s.state])} style={{ width: `${((toMin(s.to) - toMin(s.from)) / span) * 100}%` }} />
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-white/70">
        {segments
          .filter((s) => s.label || s.state !== "working")
          .map((s) => (
            <span key={s.from}>
              {s.from} {s.label ?? s.state}
            </span>
          ))}
      </div>
    </div>
  );
}

/** One story card. Dark, full height; everything on it comes from the recap record. */
export function StoryCard({ card, compact = false }: { card: RecapCard; compact?: boolean }) {
  const chapter = CHAPTERS.find((c) => c.key === card.chapter)!;
  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-[#17191c] text-white">
      {card.cover && (
        <div className="relative h-[38%] shrink-0">
          <RecapCoverArt kind={card.cover} className="size-full" />
          <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-transparent to-[#17191c]" />
        </div>
      )}
      <div className={cn("relative flex min-h-0 flex-1 flex-col gap-3.5 px-5 pb-5", card.cover ? "-mt-10" : "pt-20")}>
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn("rounded-lg px-2 py-1 text-[11px] font-bold tracking-wider uppercase", CHAPTER_PILL[card.chapter])}>{chapter.label}</span>
          {card.at && (
            <span className="inline-flex items-center gap-1 rounded-lg bg-black/40 px-2 py-1 text-[11px] font-semibold tabular">
              <Clock className="size-3" aria-hidden /> {fmtTime(card.at)}
            </span>
          )}
        </div>
        <div>
          {card.kicker && <p className="text-[13px] text-white/60">{card.kicker}</p>}
          <h3 className={cn("font-semibold tracking-tight text-balance", compact ? "text-xl" : "text-[26px] leading-[1.15]")}>{card.title}</h3>
        </div>

        {!!card.stats?.length && (
          <div className={cn("grid gap-2", card.stats.length >= 3 ? "grid-cols-3" : "grid-cols-2")}>
            {card.stats.map((s) => (
              <div key={s.label} className={cn("rounded-2xl px-3 py-2.5", TONE_TILE[s.tone ?? "neutral"])}>
                <p className={cn("text-[22px] leading-none font-bold tabular", TONE_TEXT[s.tone ?? "neutral"])}>
                  {s.value}
                  {s.unit && (
                    <span className={cn("text-xs font-medium whitespace-nowrap text-white/60", card.stats!.length >= 3 ? "mt-1 block" : "ml-1")}>{s.unit}</span>
                  )}
                </p>
                <p className="mt-1.5 text-[11.5px] leading-tight text-white/65">{s.label}</p>
              </div>
            ))}
          </div>
        )}

        {card.strip && <DayStrip segments={card.strip} label={card.strip_label} />}

        {card.quote && (
          <figure className="rounded-2xl bg-white/7 p-3.5">
            <blockquote className="text-[14px] leading-relaxed">“{card.quote.text}”</blockquote>
            <figcaption className="mt-2 text-[11.5px] text-white/55">{card.quote.who}</figcaption>
          </figure>
        )}

        {!!card.done?.length && (
          <ol className="flex flex-col gap-2">
            {card.done.map((d, i) => (
              <li key={d} className="flex items-center gap-3 rounded-2xl bg-white/7 px-3.5 py-3 text-[14px]">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-primary text-xs font-bold text-primary-foreground">{i + 1}</span>
                {d}
              </li>
            ))}
          </ol>
        )}

        {!compact && card.refs.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <CheckCircle2 className="size-3.5 text-white/50" aria-hidden />
            <span className="text-[11px] text-white/50">From</span>
            {card.refs.map((r) => (
              <CitationChip key={`${r.source_id}-${r.passage_id ?? ""}`} refData={r} />
            ))}
          </div>
        )}

        {!compact && card.action && (
          <Link
            href={card.action.href}
            className="mt-auto inline-flex h-12 items-center justify-center gap-2 rounded-2xl bg-primary text-[15px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none"
          >
            {card.action.label} <ArrowRight className="size-4" aria-hidden />
          </Link>
        )}
      </div>
    </div>
  );
}
