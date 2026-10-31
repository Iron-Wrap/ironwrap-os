import { dateTimeFormatter } from "../lib/intl-cache";
import type { ActiveStop } from "./field-contracts";

/** The crew's words for a work stop that holds a job (one module, so ruled copy swaps in here). */
export const STOP_WORDS = {
  /** A stop nobody could match to a job holds every job (orchestrator ruling: one meaning everywhere). */
  tenant: "Work is stopped on every job.",
  /** What happened, said the same way wherever such a stop shows; "You" when the viewer raised it. */
  unmatched: (raiser: string | null) =>
    raiser
      ? `${raiser} reported a stop, and we couldn't tell which job it's for. The office is told.`
      : "A stop was reported, and we couldn't tell which job it's for. The office is told.",
  /** The short job line where one is needed (S21). */
  unmatchedJob: "Job: couldn't tell which one",
  /** A stop on this job; the job is named the D5 way after the lead-in. */
  jobLeadIn: "Work is stopped on the job:",
  jobUnnamed: "Work is stopped on this job.",
  /** Nobody restarts work from the phone. */
  waits: "The office must release the stop. The person who reported it cannot release it.",
  /** The card's next step while a stop holds its job. */
  nextStep: "Wait for the office to release the stop",
  unavailable: "Safety stops need checking",
  unavailableDetail:
    "Stop status could not be checked. Keep work stopped until the office has checked it. A missing status does not mean work is clear.",
  unavailableNextStep: "Ask the office to check safety stops before starting work",
  /** A work check on a stopped job is its own thing: clearing it never restarts work. */
  separateCheck: (check: string | null) =>
    `${check ? `Work to check: ${check.trim().replace(/\.+$/, "")}. ` : ""}Open work checks must also be cleared before starting. Clearing them does not release the stop, and releasing the stop does not clear them.`,
  callOffice: "Call the office",
} as const;

/** A response snapshot time is separate from when its stop was reported. */
export function stopReadStatus(
  stops: ActiveStop[],
  checkedAt: string,
  offline: boolean,
  options: { locale?: string; timeZone?: string },
  now?: Date,
): string {
  const checked = Date.parse(checkedAt);
  const stamp = crewStopStamp(checkedAt, options, now);
  if (
    !stamp ||
    !Number.isFinite(checked) ||
    stops.some((stop) => Date.parse(stop.reported_at) > checked)
  ) {
    return "Stop status needs checking. Keep work stopped and call the office.";
  }
  return offline
    ? `Saved stop status as of ${stamp.replace(/\.$/, "")}. Go online to check for changes; keep work stopped.`
    : `Stop status as of ${stamp}`;
}

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
 * "Stopped today at 10:24 a.m. by Tom Lachance · Reason: Ice on the north slope": the stop's own time, so it
 * never reads as old beside the run sheet's stamp. Parts the read lacks are left out.
 */
export function stopDetail(
  stop: ActiveStop,
  options: { locale?: string; timeZone?: string },
  now?: Date,
  { withRaiser = true }: { withRaiser?: boolean } = {},
): string {
  const when = crewStopWhen(stop.reported_at, options, now);
  const raiser = withRaiser ? stop.raiser_display_name?.trim() : undefined;
  const stopped = ["Stopped", when, raiser ? `by ${raiser}` : null].filter(Boolean).join(" ");
  // The crew's words carry their label, or they read as one more fact (gate e-stop-banner).
  const reason = stop.summary?.trim();
  return [stopped, reason ? `Reason: ${reason}` : null].filter(Boolean).join(" · ");
}

/** Every stop that holds any of these jobs, once each, oldest first. */
export function uniqueStops(stopLists: ActiveStop[][]): ActiveStop[] {
  const seen = new Map<string, ActiveStop>();
  for (const stop of stopLists.flat())
    if (!seen.has(stop.occurrence_id)) seen.set(stop.occurrence_id, stop);
  const at = (stop: ActiveStop) => Date.parse(stop.reported_at) || 0;
  return [...seen.values()].sort((a, b) => at(a) - at(b));
}
