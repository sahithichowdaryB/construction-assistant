import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

export const PROJECT_TZ = "Europe/Vienna";

/** Default demo clock: Tuesday 10 November 2026, 10:15 in Vienna. */
export const DEFAULT_AS_OF = toIsoWithOffset(fromZonedTime("2026-11-10T10:15:00", PROJECT_TZ));

export const AS_OF_PRESETS: { label: string; local: string }[] = [
  { label: "10 Nov 07:00", local: "2026-11-10T07:00:00" },
  { label: "10 Nov 10:15", local: "2026-11-10T10:15:00" },
  { label: "10 Nov 17:30", local: "2026-11-10T17:30:00" },
  { label: "11 Nov 17:30", local: "2026-11-11T17:30:00" },
  { label: "12 Nov 07:15", local: "2026-11-12T07:15:00" },
];

/** ISO string with the project's UTC offset, e.g. 2026-11-10T10:15:00+01:00 */
export function toIsoWithOffset(date: Date, tz: string = PROJECT_TZ): string {
  return formatInTimeZone(date, tz, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

/** Interpret a wall-clock time ("2026-11-10T10:15") in the project zone. */
export function localToIso(local: string, tz: string = PROJECT_TZ): string {
  return toIsoWithOffset(fromZonedTime(local, tz), tz);
}

/** Value for <input type="datetime-local"> in the project zone. */
export function isoToLocalInput(iso: string, tz: string = PROJECT_TZ): string {
  return formatInTimeZone(new Date(iso), tz, "yyyy-MM-dd'T'HH:mm");
}

export function fmtDateTime(iso: string | null | undefined, tz: string = PROJECT_TZ): string {
  if (!iso) return "Unknown";
  return formatInTimeZone(new Date(iso), tz, "EEE d MMM yyyy, HH:mm");
}

export function fmtShort(iso: string | null | undefined, tz: string = PROJECT_TZ): string {
  if (!iso) return "Unknown";
  return formatInTimeZone(new Date(iso), tz, "d MMM HH:mm");
}

export function fmtTime(iso: string | null | undefined, tz: string = PROJECT_TZ): string {
  if (!iso) return "Unknown";
  return formatInTimeZone(new Date(iso), tz, "HH:mm");
}

/** Formats a project-local date (YYYY-MM-DD) without shifting it through UTC. */
export function fmtLocalDate(date: string | null | undefined): string {
  if (!date) return "Unknown";
  const [y, m, d] = date.split("-").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d} ${months[m - 1]} ${y}`;
}

/** Project-local calendar date of an instant. */
export function localDateOf(iso: string, tz: string = PROJECT_TZ): string {
  return formatInTimeZone(new Date(iso), tz, "yyyy-MM-dd");
}

export function zoneAbbrev(iso: string, tz: string = PROJECT_TZ): string {
  return formatInTimeZone(new Date(iso), tz, "zzz");
}

export function isAvailable(availableAt: string, asOf: string): boolean {
  return new Date(availableAt).getTime() <= new Date(asOf).getTime();
}
