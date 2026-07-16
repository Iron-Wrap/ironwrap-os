const MIN_PORTAL_TTL_MS = 60 * 60 * 1_000;
const MAX_PORTAL_TTL_MS = 90 * 24 * 60 * 60 * 1_000;

/**
 * `datetime-local` has minute precision while the Worker compares exact timestamps. Round the
 * visible min up and the max down so every selectable bound is accepted by the authoritative API.
 */
export function customerPortalExpiryBounds(now = Date.now()): { min: string; max: string } {
  return {
    min: toDatetimeLocal(new Date(roundUpToMinute(now + MIN_PORTAL_TTL_MS))),
    max: toDatetimeLocal(new Date(roundDownToMinute(now + MAX_PORTAL_TTL_MS))),
  };
}

export function customerPortalExpiryToIso(value: string, now = Date.now()): string | null {
  if (!value) return null;
  const date = new Date(value);
  const time = date.getTime();
  if (Number.isNaN(time) || time < now + MIN_PORTAL_TTL_MS || time > now + MAX_PORTAL_TTL_MS)
    return null;
  return date.toISOString();
}

function toDatetimeLocal(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

function roundUpToMinute(value: number): number {
  return Math.ceil(value / 60_000) * 60_000;
}

function roundDownToMinute(value: number): number {
  return Math.floor(value / 60_000) * 60_000;
}
