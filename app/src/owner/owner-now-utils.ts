import type { OwnerException } from "./owner-contracts";

const laneDefinitions = [
  {
    id: "work_stopped",
    title: "Work stopped",
    description: "Crew reports and job gates that stop work.",
    kinds: ["field_blocker", "blocked_gate"],
  },
  {
    id: "operating_exceptions",
    title: "Needs a check",
    description: "App, material, and money records to check.",
    kinds: ["automation_incident", "material_exception", "finance_exception"],
  },
  {
    id: "lead_attention",
    title: "Lead checks",
    description: "New leads and reply proof to check.",
    kinds: ["untriaged_lead", "lead_triage_unknown"],
  },
  {
    id: "other_exceptions",
    title: "Other checks",
    description: "Saved records that still need a check.",
    kinds: [],
  },
] as const;

export interface DecisionLane {
  id: (typeof laneDefinitions)[number]["id"];
  title: string;
  description: string;
  exceptions: OwnerException[];
}

export interface OwnerDateFormatOptions {
  locale?: string;
  timeZone?: string;
}

export function buildDecisionLanes(
  exceptions: OwnerException[],
  { dueTimingAvailable = true }: { dueTimingAvailable?: boolean } = {},
): DecisionLane[] {
  const buckets = new Map<string, OwnerException[]>();
  for (const exception of exceptions) {
    const lane = laneDefinitions.find((definition) =>
      definition.kinds.includes(exception.kind as never),
    );
    const bucketId = lane?.id ?? "other_exceptions";
    const current = buckets.get(bucketId) ?? [];
    current.push(exception);
    buckets.set(bucketId, current);
  }
  return laneDefinitions.flatMap((definition) => {
    const laneExceptions = buckets.get(definition.id) ?? [];
    if (laneExceptions.length === 0) return [];
    return [
      {
        id: definition.id,
        title: definition.title,
        description: definition.description,
        exceptions: sortExceptions(laneExceptions, dueTimingAvailable),
      },
    ];
  });
}

export function validJobId(value: string | null): value is string {
  return value !== null && /^[A-Za-z0-9][A-Za-z0-9 _./:#()-]{0,139}$/.test(value);
}

export function canOpenJob(
  allowedActions: readonly string[],
  exception: Pick<OwnerException, "job_id">,
): exception is OwnerException & { job_id: string } {
  return allowedActions.includes("job.read") && validJobId(exception.job_id);
}

export function formatOwnerDate(
  value: string | null,
  options: OwnerDateFormatOptions = {},
): string {
  if (!value) return "Date unavailable";
  const floating = value.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/,
  );
  if (floating) {
    const year = Number(floating[1]);
    const month = Number(floating[2]);
    const day = Number(floating[3]);
    const hour = floating[4];
    const minute = floating[5];
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      return "Date unavailable";
    }
    const dateText = formatDate(date, options, "UTC", false);
    return hour && minute ? `${dateText} · ${hour}:${minute}` : dateText;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "Date unavailable";
  return formatDate(new Date(parsed), options);
}

export function severityPriority(value: string | null): number {
  switch (value?.trim().toLowerCase()) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    case "low":
      return 3;
    default:
      return 4;
  }
}

export function humanizeSource(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._:/-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function humanizeStaleField(value: string): string {
  switch (value) {
    case "exceptions.next_action":
      return "The next step is missing from this list.";
    case "exceptions.due_at":
      return "Some due times are missing.";
    case "exceptions.partial_sources":
      return "Some counts may be low.";
    default:
      if (value.endsWith(".native_unavailable")) {
        const path = value.slice(0, -".native_unavailable".length).split(".");
        return `${humanizeSource(path.slice(1).join(".") || path[0] || "Work data")} could not be checked.`;
      }
      return `${humanizeSource(value)} may be old.`;
  }
}

export function mctbEvidenceLabel(state: NonNullable<OwnerException["mctb"]>["state"]): string {
  switch (state) {
    case "provider_accepted_within_sla":
      return "Reply was saved within 60 seconds";
    case "provider_accepted_late":
      return "Reply was saved after 60 seconds";
    case "no_eligible_channel":
      return "No safe reply path was found";
    case "awaiting_proof":
      return "Waiting for reply proof";
    case "unproven_after_sla":
      return "No reply proof after 60 seconds";
    case "time_unavailable":
      return "Lead time is not known";
  }
}

function sortExceptions(
  exceptions: OwnerException[],
  dueTimingAvailable: boolean,
): OwnerException[] {
  return [...exceptions].sort((left, right) => {
    const severity = severityPriority(left.severity) - severityPriority(right.severity);
    if (severity !== 0) return severity;
    if (dueTimingAvailable) {
      const dueAt = compareDueAt(left.due_at, right.due_at);
      if (dueAt !== 0) return dueAt;
    }
    const title = compareText(left.title, right.title);
    return title === 0 ? compareText(left.id, right.id) : title;
  });
}

function compareDueAt(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return compareText(left, right);
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function formatDate(
  date: Date,
  options: OwnerDateFormatOptions,
  fallbackTimeZone?: string,
  includeTime = true,
): string {
  try {
    return new Intl.DateTimeFormat(options.locale, {
      dateStyle: "medium",
      ...(includeTime ? { timeStyle: "short" as const } : {}),
      timeZone: fallbackTimeZone ?? options.timeZone,
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      ...(includeTime ? { timeStyle: "short" as const } : {}),
      timeZone: fallbackTimeZone,
    }).format(date);
  }
}
