import type { OwnerException } from "./owner-contracts";

const exceptionGroups = [
  { kind: "field_blocker", title: "Crew-reported work stops", tone: "border-danger" },
  { kind: "blocked_gate", title: "Blocked gates", tone: "border-danger" },
  { kind: "automation_incident", title: "Automation incidents", tone: "border-warning" },
  { kind: "material_exception", title: "Material exceptions", tone: "border-warning" },
  { kind: "finance_exception", title: "Finance exceptions", tone: "border-info" },
  { kind: "untriaged_lead", title: "Untriaged leads", tone: "border-ok" },
  { kind: "lead_triage_unknown", title: "Triage data quality", tone: "border-warning" },
] as const;

export interface ExceptionGroup {
  kind: string;
  title: string;
  tone: string;
  exceptions: OwnerException[];
}

export function groupOwnerExceptions(exceptions: OwnerException[]): ExceptionGroup[] {
  const byKind = new Map<string, OwnerException[]>();
  for (const exception of exceptions) {
    const current = byKind.get(exception.kind) ?? [];
    current.push(exception);
    byKind.set(exception.kind, current);
  }

  const known = exceptionGroups.flatMap((definition) => {
    const exceptionsForKind = byKind.get(definition.kind);
    return exceptionsForKind
      ? [{ ...definition, exceptions: sortExceptions(exceptionsForKind) }]
      : [];
  });
  const knownKinds = new Set<string>(exceptionGroups.map((definition) => definition.kind));
  const unknown = [...byKind.keys()]
    .filter((kind) => !knownKinds.has(kind))
    .sort(compareText)
    .map((kind) => ({
      kind,
      title: `Other: ${humanizeKind(kind)}`,
      tone: "border-border",
      exceptions: sortExceptions(byKind.get(kind) ?? []),
    }));
  return [...known, ...unknown];
}

export function validJobId(value: string | null): value is string {
  return value !== null && /^[A-Za-z0-9][A-Za-z0-9 _./:#()-]{0,139}$/.test(value);
}

export function formatOwnerDate(value: string | null): string {
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
    const dateText = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeZone: "UTC",
    }).format(date);
    return hour && minute ? `${dateText} · ${hour}:${minute}` : dateText;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(parsed),
  );
}

function sortExceptions(exceptions: OwnerException[]): OwnerException[] {
  return [...exceptions].sort((left, right) => {
    const severity = severityPriority(left.severity) - severityPriority(right.severity);
    if (severity !== 0) return severity;
    const dueAt = compareDueAt(left.due_at, right.due_at);
    if (dueAt !== 0) return dueAt;
    const title = compareText(left.title, right.title);
    return title === 0 ? compareText(left.id, right.id) : title;
  });
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

function compareDueAt(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return compareText(left, right);
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function humanizeKind(value: string): string {
  return value.replace(/[_-]+/g, " ");
}
