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
} as const;

/** "Today 10:24 a.m.", or "Mon 14 Sep 10:24 a.m." on another day, in the company's time zone. */
export function crewStopStamp(
  iso: string,
  options: { locale?: string; timeZone?: string },
  now: Date = new Date(),
): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const zone = options.timeZone;
  const day = (value: Date) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: zone, dateStyle: "short" }).format(value);
  const time = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(at);
  if (day(at) === day(now)) return `Today ${time}`;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).formatToParts(at);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("weekday")} ${part("day")} ${part("month")} ${time}`;
}

/** "Tom Lachance stopped it · Today 10:24 a.m. · Ice on the north slope"; parts it lacks are left out. */
export function stopDetail(
  stop: ActiveStop,
  options: { locale?: string; timeZone?: string },
  now?: Date,
): string {
  return [
    stop.raiser_display_name?.trim() ? `${stop.raiser_display_name.trim()} stopped it` : null,
    crewStopStamp(stop.reported_at, options, now),
    stop.summary?.trim() || null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Every stop that holds any of these jobs, once each, oldest first. */
export function uniqueStops(stopLists: ActiveStop[][]): ActiveStop[] {
  const seen = new Map<string, ActiveStop>();
  for (const stop of stopLists.flat())
    if (!seen.has(stop.occurrence_id)) seen.set(stop.occurrence_id, stop);
  return [...seen.values()].sort((a, b) => a.reported_at.localeCompare(b.reported_at));
}
