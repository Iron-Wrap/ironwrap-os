import { dateTimeFormatter } from "../lib/intl-cache";
import type { ActiveStop } from "./field-contracts";

/** The crew's words for a work stop that holds a job (one module, so ruled copy swaps in here). */
export const STOP_WORDS = {
  /** A stop whose job wasn't found holds every job (orchestrator ruling). */
  tenant: "Work is stopped on every job: a stop's job wasn't found. The office is told.",
  /** A stop on this job; the job is named the D5 way after the lead-in. */
  jobLeadIn: "Work is stopped on the job:",
  jobUnnamed: "Work is stopped on this job.",
  /** Nobody restarts work from the phone. */
  waits: "The office releases the stop.",
  /** The card's next step while a stop holds its job. */
  nextStep: "Wait for the office to release the stop",
  /** A work check on a stopped job is its own thing: clearing it never restarts work. */
  separateCheck: (check: string | null) =>
    check
      ? `Separate work check: ${check.trim().replace(/\.+$/, "")}. Clearing it doesn't restart work.`
      : "A separate work check is open. Clearing it doesn't restart work.",
  callOffice: "Call the office",
} as const;

/** "today at 10:24 a.m.", or "on Thu 9 Jul at 4:05 p.m." on another day; null for an unreadable time. */
export function crewStopWhen(
  iso: string,
  options: { locale?: string; timeZone?: string },
  now?: Date,
): string | null {
  const stamp = crewStopStamp(iso, options, now);
  if (!stamp) return null;
  if (stamp.startsWith("Today ")) return `today at ${stamp.slice("Today ".length)}`;
  const [weekday, day, month, ...time] = stamp.split(" ");
  return `on ${weekday} ${day} ${month} at ${time.join(" ")}`;
}

/** "Today 10:24 a.m.", or "Mon 14 Sep 10:24 a.m." on another day, in the company's time zone. */
export function crewStopStamp(
  iso: string,
  options: { locale?: string; timeZone?: string },
  now: Date = new Date(),
): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  try {
    const timeZone = options.timeZone;
    const day = (value: Date) =>
      dateTimeFormatter("en-CA", { timeZone, dateStyle: "short" }).format(value);
    const time = dateTimeFormatter("en-CA", {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(at);
    if (day(at) === day(now)) return `Today ${time}`;
    const parts = dateTimeFormatter("en-CA", {
      timeZone,
      weekday: "short",
      day: "numeric",
      month: "short",
    }).formatToParts(at);
    const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
    return `${part("weekday")} ${part("day")} ${part("month")} ${time}`;
  } catch {
    // A time zone this device cannot read: the stop still shows, without a time.
    return null;
  }
}

/**
 * "Stopped today at 10:24 a.m. by Tom Lachance · Ice on the north slope": the stop's own time, so it
 * never reads as old beside the run sheet's stamp. Parts the read lacks are left out.
 */
export function stopDetail(
  stop: ActiveStop,
  options: { locale?: string; timeZone?: string },
  now?: Date,
): string {
  const when = crewStopWhen(stop.reported_at, options, now);
  const raiser = stop.raiser_display_name?.trim();
  const stopped = ["Stopped", when, raiser ? `by ${raiser}` : null].filter(Boolean).join(" ");
  return [stopped, stop.summary?.trim() || null].filter(Boolean).join(" · ");
}

/** Every stop that holds any of these jobs, once each, oldest first. */
export function uniqueStops(stopLists: ActiveStop[][]): ActiveStop[] {
  const seen = new Map<string, ActiveStop>();
  for (const stop of stopLists.flat())
    if (!seen.has(stop.occurrence_id)) seen.set(stop.occurrence_id, stop);
  const at = (stop: ActiveStop) => Date.parse(stop.reported_at) || 0;
  return [...seen.values()].sort((a, b) => at(a) - at(b));
}
