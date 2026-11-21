import { SOURCE_TYPE_LABEL } from "@/lib/format";
import type { Source, SourceType } from "@/lib/types";

/** True when the stored title is only a file name or record id, not words a person would read. */
export function isMachineTitle(s: Pick<Source, "id" | "title">) {
  return /\.(webm|aiff?|wav|m4a|mp3|ogg|jpe?g|png|heic)$/i.test(s.title) || /^Record\s+[A-Z]+-/i.test(s.title) || s.title === s.id;
}

/** What to call a document: its own title, or for app captures what was said or seen, else its type. */
export function sourceTitle(s: Pick<Source, "id" | "title" | "type" | "headline">) {
  if (!isMachineTitle(s)) return s.title;
  return s.headline || SOURCE_TYPE_LABEL[s.type as SourceType];
}

/** Voice notes call their text a transcript; every other document keeps "passages". */
export function passageWords(type: SourceType) {
  if (type === "voice") return { tab: "Transcript", count: "Transcript lines", hint: "Select a line to find it in the recording.", none: "No transcript yet." };
  return { tab: "Passages", count: "Passages", hint: "Select a passage to find it in the original.", none: "No passages indexed for this source." };
}
