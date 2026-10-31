import type { JobResponse } from "./field-contracts";
import { formatFieldStamp, type FieldDateOptions } from "./field-formatting";

type JobPlan = NonNullable<JobResponse["packet"]["work_package"]>;
type ActiveStop = JobResponse["active_stops"][number];

/** The clock a reader of this screen uses: the crew phone reads a.m. and p.m., the office 24-hour. */
export type StampClock = "24h" | "12h";

/**
 * The job plan card's badge: never a version number (versions live in System details and the
 * record). Each status carries the moment it began as a label stamp when the read carries that
 * moment; when it does not, the badge leaves the stamp off rather than guess. The read sends only
 * the current plan, so a Completed, Expired or Superseded plan never reaches this card.
 */
export function jobPlanBadge(
  plan: JobPlan,
  crewStops: readonly ActiveStop[],
  dateOptions: FieldDateOptions,
  clock: StampClock,
): string {
  const stamped = (words: string, at: string | null) =>
    at ? `${words} · ${formatFieldStamp(at, dateOptions, { clock })}` : words;
  switch (plan.status) {
    case "Released":
      return stamped("Issued to the crew", plan.released_at);
    case "Acknowledged":
      // The plan turned Acknowledged when the first crew phone sent I reviewed this plan.
      return stamped("Reviewed by the crew", firstCrewReview(plan));
    case "In Progress":
      // The read carries no start time, so this badge has no stamp.
      return "Work started";
    case "Blocked": {
      // Only the legacy activeCrewStops projection identifies this plan's crew event. Generic
      // holding stops (including job-scoped ones) cannot provide its stamp or reason.
      const stop = crewStops[0];
      if (!stop) return "Work stopped";
      const stopped = stamped("Work stopped", stop.reported_at);
      return stop.summary ? `${stopped} · ${stop.summary}` : stopped;
    }
  }
}

/** The earliest crew review the read carries, or null when it carries none. */
export function firstCrewReview(plan: JobPlan): string | null {
  const times = [
    ...plan.acknowledgement.workers.map((worker) => worker.acknowledged_at),
    plan.acknowledgement.acknowledged_at,
  ]
    .filter((value): value is string => Boolean(value) && Number.isFinite(Date.parse(value!)))
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  return times[0] ?? null;
}
