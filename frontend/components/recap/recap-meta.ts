import type { DayRecap, RecapCard, RecapChapter, RecapMood, RecapTone } from "@/lib/types";

export const CHAPTERS: { key: RecapChapter; label: string; dot: string }[] = [
  { key: "overview", label: "Overview", dot: "bg-primary" },
  { key: "wins", label: "Wins", dot: "bg-success" },
  { key: "problems", label: "Problems", dot: "bg-destructive" },
  { key: "decisions", label: "Said & decided", dot: "bg-info" },
  { key: "today", label: "Start today", dot: "bg-white" },
];

export const CHAPTER_PILL: Record<RecapChapter, string> = {
  overview: "bg-primary/15 text-primary",
  wins: "bg-success/20 text-[#7fe0a6]",
  problems: "bg-destructive/25 text-[#ff8f82]",
  decisions: "bg-info/20 text-[#9cc4ff]",
  today: "bg-white/12 text-white",
};

export const MOOD: Record<RecapMood, { bar: string; ring: string; text: string }> = {
  on_plan: { bar: "bg-success", ring: "#16894b", text: "text-success" },
  minor: { bar: "bg-warning", ring: "#b86e00", text: "text-warning" },
  disrupted: { bar: "bg-destructive", ring: "#d23b2c", text: "text-destructive" },
  weather: { bar: "bg-info", ring: "#2f6fd6", text: "text-info" },
};

/** Text colour for a stat on the dark story card. */
export const TONE_TEXT: Record<RecapTone, string> = {
  good: "text-[#7fe0a6]",
  warn: "text-[#ffc76a]",
  bad: "text-[#ff8f82]",
  info: "text-[#9cc4ff]",
  neutral: "text-white",
};

export const TONE_TILE: Record<RecapTone, string> = {
  good: "bg-success/15",
  warn: "bg-warning/15",
  bad: "bg-destructive/20",
  info: "bg-info/15",
  neutral: "bg-white/8",
};

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Tue 10" from a project-local YYYY-MM-DD, without going through UTC. */
export function dayShort(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return `${WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d}`;
}

export function dayLong(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return `${WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MONTH[m - 1]}`;
}

export function chapterCount(recap: DayRecap, chapter: RecapChapter): number {
  return recap.cards.filter((c) => c.chapter === chapter).length;
}

// ---------- per-viewer conveniences (browser storage only) ----------
const SEEN_KEY = "sitemate-recaps-seen";
const SAVED_KEY = "sitemate-recaps-saved";

function readSet(key: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(key);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function writeSet(key: string, set: Set<string>) {
  try {
    window.localStorage.setItem(key, JSON.stringify([...set]));
    window.dispatchEvent(new Event("sitemate-recaps"));
  } catch {
    /* storage blocked */
  }
}

export const readSeen = () => readSet(SEEN_KEY);
export function markSeen(workDate: string) {
  const s = readSet(SEEN_KEY);
  if (s.has(workDate)) return;
  s.add(workDate);
  writeSet(SEEN_KEY, s);
}

export const readSaved = () => readSet(SAVED_KEY);
export function toggleSaved(cardKey: string) {
  const s = readSet(SAVED_KEY);
  if (s.has(cardKey)) s.delete(cardKey);
  else s.add(cardKey);
  writeSet(SAVED_KEY, s);
}

/** Saved cards are keyed by work date and card id. */
export const cardKey = (recap: DayRecap, card: RecapCard) => `${recap.work_date}/${card.id}`;
