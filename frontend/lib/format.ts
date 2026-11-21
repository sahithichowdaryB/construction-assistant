import type { Basis, EvidenceRef, NoticeType, SourceType } from "@/lib/types";

/** Never renders a missing number as 0 or blank. */
export function fmtQty(value: number | null | undefined, unit?: string | null): string {
  if (value === null || value === undefined) return "Unknown";
  const n = Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
  return unit ? `${n} ${unit}` : n;
}

export function fmtPct(value: number | null | undefined): string {
  if (value === null || value === undefined) return "Unknown";
  return `${Number.isInteger(value) ? value : value.toFixed(2).replace(/\.?0+$/, "")}%`;
}

export function basisLabel(basis: Basis | null | undefined): string {
  switch (basis) {
    case "signed":
      return "Signed";
    case "estimated":
    case "provisional":
      return "Provisional";
    case "forecast":
      return "Forecast";
    default:
      return "No reading";
  }
}

export function refLabel(ref: EvidenceRef): string {
  const parts = [ref.source_id];
  if (ref.page) parts.push(`p.${ref.page}`);
  if (ref.locator && ref.locator !== "transcript" && ref.locator !== "body") parts.push(ref.locator);
  return parts.join(" · ");
}

/** Passage id convention shared with the fixtures: "<source_id>:<locator>". */
export function passageIdOf(ref: EvidenceRef): string | null {
  if (ref.passage_id) return ref.passage_id;
  return ref.locator ? `${ref.source_id}:${ref.locator}` : null;
}

export const NOTICE_LABEL: Record<NoticeType, string> = {
  delay: "Delay notice",
  additional_cost: "Additional cost notice",
  defect: "Defect notice",
  concern: "Letter of concern",
};

export const SOURCE_TYPE_LABEL: Record<SourceType, string> = {
  schedule: "Schedule",
  register: "Register",
  project: "Project record",
  email: "Email",
  minutes: "Minutes",
  daily_report: "Daily report",
  voice: "Voice note",
  photo: "Photo",
  diary: "Diary",
};
