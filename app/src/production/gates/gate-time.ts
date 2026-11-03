import { dateTimeFormatter } from "../../lib/intl-cache";

/**
 * Office times for the gate screens (Track B time ruling): a 24-hour stamp, "Today 14:05" for
 * the same day and "Fri 10 Jul 09:15" for any other; in a sentence, "today at 14:05". The
 * cancellation window's deadline is a day, "Fri 30 Oct", read from `last_day`; its exact end is
 * shown only when the Worker says the hold does not end with that day (`ends_on_calendar_day`
 * false). Never "next week", a bare weekday or "11:59 PM".
 */

const FALLBACK_TIME_ZONE = "America/Edmonton";

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: string;
  monthName: string;
}

function partsIn(instant: Date, timeZone: string): Parts {
  const numeric = dateTimeFormatter("en-CA", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(instant);
  const named = dateTimeFormatter("en-GB", {
    timeZone,
    weekday: "short",
    month: "short",
  }).formatToParts(instant);
  const number = (type: string) => Number(numeric.find((part) => part.type === type)?.value);
  const text = (type: string) => named.find((part) => part.type === type)?.value ?? "";
  return {
    year: number("year"),
    month: number("month"),
    day: number("day"),
    hour: number("hour") % 24,
    minute: number("minute"),
    weekday: text("weekday"),
    monthName: text("month"),
  };
}

function safeZone(timeZone: string): string {
  try {
    dateTimeFormatter("en-CA", { timeZone });
    return timeZone;
  } catch {
    return FALLBACK_TIME_ZONE;
  }
}

const pad = (value: number) => String(value).padStart(2, "0");

function clock(parts: Parts): string {
  return `${pad(parts.hour)}:${pad(parts.minute)}`;
}

function sameDay(left: Parts, right: Parts): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day;
}

function dayWords(parts: Parts): string {
  return `${parts.weekday} ${parts.day} ${parts.monthName}`;
}

/** "Today 14:05" or "Fri 10 Jul 09:15"; null when the time cannot be read. */
export function officeStamp(
  value: string | null | undefined,
  { timeZone, now }: { timeZone: string; now: Date },
): string | null {
  if (!value) return null;
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return null;
  const zone = safeZone(timeZone);
  const parts = partsIn(instant, zone);
  if (sameDay(parts, partsIn(now, zone))) return `Today ${clock(parts)}`;
  return `${dayWords(parts)} ${clock(parts)}`;
}

/** The same time inside a sentence: "today at 14:05", or "Tue 20 Oct 18:10". */
export function proseTime(
  value: string | null | undefined,
  { timeZone, now }: { timeZone: string; now: Date },
): string | null {
  if (!value) return null;
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return null;
  const zone = safeZone(timeZone);
  const parts = partsIn(instant, zone);
  if (sameDay(parts, partsIn(now, zone))) return `today at ${clock(parts)}`;
  return `${dayWords(parts)} ${clock(parts)}`;
}

/** A sentence's first word written with a capital: "Today at 18:26 hasn't happened yet". */
export function capitalized(text: string): string {
  return text.length === 0 ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** A local calendar day, `YYYY-MM-DD`, as "Fri 30 Oct"; null when it is not a real day. */
export function dayLabel(localDate: string | null | undefined): string | null {
  if (!localDate) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const noon = new Date(Date.UTC(year, month - 1, day, 12));
  if (noon.getUTCMonth() !== month - 1 || noon.getUTCDate() !== day) return null;
  return dayWords(partsIn(noon, "UTC"));
}

/**
 * How the window's end reads: the last day the customer may cancel on, or, only when the hold
 * does not end with that day, the exact end as a stamp.
 */
export type WindowDeadline =
  { kind: "day"; label: string } | { kind: "exact"; label: string } | { kind: "none" };

export function windowDeadline(
  window: {
    last_day: string | null;
    ends_at: string | null;
    ends_on_calendar_day: boolean | null;
    time_zone: string;
  },
  now: Date,
): WindowDeadline {
  if (window.ends_on_calendar_day === false) {
    const exact = officeStamp(window.ends_at, { timeZone: window.time_zone, now });
    if (exact) return { kind: "exact", label: exact };
  }
  const day = dayLabel(window.last_day);
  return day ? { kind: "day", label: day } : { kind: "none" };
}

/** The value a `datetime-local` control shows for an instant, in the business zone. */
export function localInputValue(value: string | null | undefined, timeZone: string): string {
  if (!value) return "";
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return "";
  const parts = partsIn(instant, safeZone(timeZone));
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${clock(parts)}`;
}

/** The zone's offset from UTC at an instant, in minutes (Edmonton in summer: -360). */
function offsetMinutes(instant: number, timeZone: string): number {
  const parts = partsIn(new Date(instant), timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  const floored = Math.floor(instant / 60_000) * 60_000;
  return Math.round((asUtc - floored) / 60_000);
}

/**
 * A wall time typed in the business zone ("2026-10-20T18:26") as the instant it names. A time
 * the zone skips reads one offset later; a repeated one reads as its first occurrence.
 */
export function instantFromLocal(
  local: string,
  timeZone: string,
): { iso: string; withOffset: string } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const zone = safeZone(timeZone);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  if (Number.isNaN(wall)) return null;
  let guess = wall - offsetMinutes(wall, zone) * 60_000;
  guess = wall - offsetMinutes(guess, zone) * 60_000;
  const offset = offsetMinutes(guess, zone);
  const sign = offset < 0 ? "-" : "+";
  const absolute = Math.abs(offset);
  const withOffset = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00${sign}${pad(
    Math.floor(absolute / 60),
  )}:${pad(absolute % 60)}`;
  return { iso: new Date(guess).toISOString(), withOffset };
}

/** Whole calendar days a work window spans, its first and last day counted: "2 days". */
export function spanDays(startIso: string, endIso: string, timeZone: string): number | null {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null;
  const zone = safeZone(timeZone);
  const day = (parts: Parts) => Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000;
  return day(partsIn(end, zone)) - day(partsIn(start, zone)) + 1;
}
