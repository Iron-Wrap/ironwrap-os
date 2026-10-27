import { dateTimeFormatter } from "../lib/intl-cache";

/** The tenant's locale and time zone, absent on a device that has not paired yet. */
export type FieldDateOptions = { locale?: string; timeZone?: string };

export function formatFieldDay(value: string, options: FieldDateOptions): string {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "Date unavailable";
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return "Date unavailable";
  return formatWithLocale(
    date,
    options,
    { weekday: "long", month: "short", day: "numeric", year: "numeric" },
    "UTC",
  );
}

export function formatFieldTimestamp(value: string, options: FieldDateOptions): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "time unavailable";
  return formatWithLocale(new Date(parsed), options, { dateStyle: "medium", timeStyle: "short" });
}

export function formatFieldSchedule(value: string | null, options: FieldDateOptions): string {
  if (!value) return "Not scheduled";
  const floating = value.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/,
  );
  if (floating) {
    const year = Number(floating[1]);
    const month = Number(floating[2]);
    const day = Number(floating[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    )
      return "Not scheduled";
    const dateText = formatWithLocale(
      date,
      options,
      { month: "short", day: "numeric", year: "numeric" },
      "UTC",
    );
    return floating[4] && floating[5] ? `${dateText} · ${floating[4]}:${floating[5]}` : dateText;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "Not scheduled";
  return formatWithLocale(new Date(parsed), options, { dateStyle: "medium", timeStyle: "short" });
}

function formatWithLocale(
  date: Date,
  options: FieldDateOptions,
  format: Intl.DateTimeFormatOptions,
  fallbackTimeZone?: string,
): string {
  try {
    return dateTimeFormatter(options.locale, {
      ...format,
      timeZone: fallbackTimeZone ?? options.timeZone,
    }).format(date);
  } catch {
    return dateTimeFormatter(undefined, {
      ...format,
      timeZone: fallbackTimeZone,
    }).format(date);
  }
}

/**
 * Plain names for the record fields a read flags as possibly old (`stale_fields`). A key that
 * is not listed is hidden, never title-cased: machine keys printed as words
 * ("Packet Materials Takeoffs Native Unavailable") are vocabulary nobody on a crew learned.
 */
const fieldNames: Readonly<Record<string, string>> = {
  "job.address": "Job address",
  "jobs.address": "Job addresses",
  "jobs.address_partial": "Job addresses",
  "jobs.partial_source": "Job list",
  "jobs.partial_sources": "Job list",
  "jobs.blocked_gates_partial": "Work checks",
  "jobs.gate_coverage": "Work checks",
  "gates.partial_source": "Work checks",
  "gates.native_incomplete": "Work checks",
  "packet.contact.display_name": "Job contact name",
  "packet.contact.phone": "Job contact phone",
  "packet.contact.access_instructions": "Site access instructions",
  "packet.scope_clauses.native_unavailable": "Approved scope",
  "packet.measurements.native_unavailable": "Measurements",
  "packet.materials.takeoffs.native_unavailable": "Materials list",
  "packet.materials.supplier_orders.native_unavailable": "Supplier orders",
  "packet.change_orders.native_unavailable": "Change orders",
  "packet.safety_plan.native_unavailable": "Safety plan",
  "packet.work_package.native_unavailable": "Job plan",
  "proof_stream.native_scope_unavailable": "Photos and notes",
  "proof_stream.unavailable": "Photos and notes",
};

/** The plain name of one flagged field, or null when nobody has written one. */
export function humanizeFieldName(key: string): string | null {
  return Object.hasOwn(fieldNames, key) ? (fieldNames[key] ?? null) : null;
}

/** Plain names for flagged fields, each once, in order; unknown keys are left out. */
export function plainFieldNames(keys: readonly string[]): string[] {
  return [...new Set(keys.map(humanizeFieldName).filter((name): name is string => name !== null))];
}
