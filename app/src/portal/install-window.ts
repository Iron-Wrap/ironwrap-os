import type { CustomerPortalResponse } from "./portal-contracts";

type InstallWindow = NonNullable<CustomerPortalResponse["install_window"]>;

const OFFSET = /(Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * The office commits the window in the company's local time and the timestamp
 * carries that offset. Show that wall-clock time as written, so a customer
 * whose phone is set to another zone still sees the time the office booked.
 */
function wallClock(value: string): Date | null {
  const match = OFFSET.exec(value);
  const instant = Date.parse(value);
  if (!match || Number.isNaN(instant)) return null;
  const offsetMinutes =
    match[1] === "Z" ? 0 : (match[2] === "-" ? -1 : 1) * (Number(match[3]) * 60 + Number(match[4]));
  return new Date(instant + offsetMinutes * 60_000);
}

const dayFormat = new Intl.DateTimeFormat("en-CA", {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const timeFormat = new Intl.DateTimeFormat("en-CA", {
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
});

function sameDay(a: Date, b: Date): boolean {
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
}

/** Plain words for the booked installation, or null when nothing usable is shared. */
export function describeInstallWindow(
  window: InstallWindow | null | undefined,
): { day: string; time: string } | null {
  if (!window) return null;
  const start = wallClock(window.scheduled_start);
  if (!start) return null;
  const end = window.scheduled_end ? wallClock(window.scheduled_end) : null;
  const day = dayFormat.format(start);
  const startTime = timeFormat.format(start);
  if (!end || end <= start) return { day, time: `Work starts at ${startTime}` };
  const endTime = timeFormat.format(end);
  return sameDay(start, end)
    ? { day, time: `Work planned from ${startTime} to ${endTime}` }
    : { day, time: `Work planned from ${startTime} to ${dayFormat.format(end)} at ${endTime}` };
}
