// production-gate-attestation.ts - what a person attests when they clear a gate, as typed data.
//
// Four scheduling gates clear on a person's attestation (migration 0158): Materials, Safety, Access
// and Weather. Each has one small shape, parsed here with exact keys. The only free text is an
// optional note of at most 300 characters, counted in code points; it never enters the structured
// attestation, because the route stores it in the ledger's redactable `reason`. References are
// short identifiers, never prose, and times are UTC instants. Evidence is cited by reference only:
// the route resolves and checksums each one, so a client never sends a hash. Migration 0158 repeats
// every rule here in D1, so a writer that skipped this parser is refused there too.

export const ATTESTABLE_PRODUCTION_GATES = ["Materials", "Safety", "Access", "Weather"] as const;
export type AttestableProductionGate = (typeof ATTESTABLE_PRODUCTION_GATES)[number];

export const MATERIALS_SOURCES = [
  "supplier_delivery",
  "reserved_stock",
  "customer_supplied",
  "none_needed",
] as const;
export const ACCESS_CONFIRMED_WITH = ["customer", "property_manager", "not_needed"] as const;
/** What the crew must plan around on site, named as in the target pre-start checklist. */
export const ACCESS_CONSTRAINTS = [
  "occupants",
  "tenants",
  "pets",
  "parking",
  "neighbours",
  "utilities",
  "overhead_lines",
  "roof_access",
  "bin_placement",
  "road_occupancy",
  "washroom",
  "storage",
  "delivery",
  "valuables",
  "landscape",
  "interior_protection",
] as const;

export const MAX_NOTE_CODE_POINTS = 300;
export const MAX_EVIDENCE_REFS = 10;
export const MAX_WEATHER_WINDOW_DAYS = 14;
export const MAX_FORECAST_AGE_HOURS = 72;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** A time observed on the caller's device may run this far ahead of the Worker's clock. */
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const REFERENCE_RE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,79}$/;
const FORECAST_SOURCE_RE = /^[a-z0-9][a-z0-9.-]{1,63}$/;
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const FIELD_EVIDENCE_REF_RE = /^field-evidence:\/\/(evi_[0-9a-f]{32})$/;
const STOCK_RESERVATION_REF_RE = /^stock-reservation:\/\/([A-Za-z0-9][A-Za-z0-9._:-]{11,199})$/;

export interface MaterialsAttestation {
  source: (typeof MATERIALS_SOURCES)[number];
  reference: string;
}

export interface AccessAttestation {
  confirmed_with: (typeof ACCESS_CONFIRMED_WITH)[number];
  confirmed_at: string;
  constraints?: Array<(typeof ACCESS_CONSTRAINTS)[number]>;
}

export interface WeatherAttestation {
  window_start: string;
  window_end: string;
  forecast_source: string;
  forecast_observed_at: string;
}

export interface SafetyAttestation {
  hazard_assessment_ref: string;
  fall_protection: { plan_ref: string } | { no_exposure_at_3m: true };
  assessed_at: string;
}

export type GateAttestation =
  | MaterialsAttestation
  | AccessAttestation
  | WeatherAttestation
  | SafetyAttestation;

export interface ProductionGateAttestationRequest {
  gate: AttestableProductionGate;
  expectedGateVersion: number;
  attestation: GateAttestation;
  note: string | null;
  /** `field-evidence://…` and `stock-reservation://…` references, sorted and distinct. */
  evidenceRefs: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function reference(value: unknown): value is string {
  return typeof value === "string" && REFERENCE_RE.test(value);
}

/** A UTC instant, stored as `toISOString()` writes it; a calendar date that does not exist fails. */
function instant(value: unknown): string | null {
  if (typeof value !== "string" || !INSTANT_RE.test(value)) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  const canonical = parsed.toISOString();
  return canonical === value || canonical === value.replace("Z", ".000Z") ? canonical : null;
}

/** When something was observed, confirmed or assessed: never in the future. */
function observed(value: unknown, now: Date): string | null {
  const time = instant(value);
  return time && Date.parse(time) <= now.getTime() + MAX_CLOCK_SKEW_MS ? time : null;
}

/** The optional note: trimmed, at most 300 code points; `undefined` means it is not acceptable. */
function attestationNote(value: unknown): string | null | undefined {
  if (value === undefined) return null;
  if (typeof value !== "string") return undefined;
  const note = value.trim();
  if (note.length === 0) return null;
  if (/[\u0000\r]/.test(note) || [...note].length > MAX_NOTE_CODE_POINTS) return undefined;
  return note;
}

function materials(value: Record<string, unknown>): MaterialsAttestation | null {
  if (!exactKeys(value, ["source", "reference"])) return null;
  if (!oneOf(MATERIALS_SOURCES, value.source) || !reference(value.reference)) return null;
  return { source: value.source, reference: value.reference };
}

function access(value: Record<string, unknown>, now: Date): AccessAttestation | null {
  if (!exactKeys(value, ["confirmed_with", "confirmed_at"], ["constraints"])) return null;
  const confirmedAt = observed(value.confirmed_at, now);
  if (!oneOf(ACCESS_CONFIRMED_WITH, value.confirmed_with) || !confirmedAt) return null;
  const constraints = value.constraints ?? [];
  if (
    !Array.isArray(constraints) ||
    !constraints.every((constraint) => oneOf(ACCESS_CONSTRAINTS, constraint)) ||
    new Set(constraints).size !== constraints.length
  ) {
    return null;
  }
  return {
    confirmed_with: value.confirmed_with,
    confirmed_at: confirmedAt,
    // An empty list says what an absent one says, so only one of them is ever stored.
    ...(constraints.length > 0 ? { constraints: [...constraints].sort() } : {}),
  };
}

function weather(value: Record<string, unknown>, now: Date): WeatherAttestation | null {
  if (!exactKeys(value, ["window_start", "window_end", "forecast_source", "forecast_observed_at"])) {
    return null;
  }
  const windowStart = instant(value.window_start);
  const windowEnd = instant(value.window_end);
  const forecastObservedAt = observed(value.forecast_observed_at, now);
  const source = value.forecast_source;
  if (!windowStart || !windowEnd || !forecastObservedAt) return null;
  if (typeof source !== "string" || !FORECAST_SOURCE_RE.test(source)) return null;
  return {
    window_start: windowStart,
    window_end: windowEnd,
    forecast_source: source,
    forecast_observed_at: forecastObservedAt,
  };
}

function safety(value: Record<string, unknown>, now: Date): SafetyAttestation | null {
  if (!exactKeys(value, ["hazard_assessment_ref", "fall_protection", "assessed_at"])) return null;
  const assessedAt = observed(value.assessed_at, now);
  const fall = value.fall_protection;
  if (!reference(value.hazard_assessment_ref) || !assessedAt || !isRecord(fall)) return null;
  let fallProtection: SafetyAttestation["fall_protection"];
  if (exactKeys(fall, ["plan_ref"]) && reference(fall.plan_ref)) {
    fallProtection = { plan_ref: fall.plan_ref };
  } else if (exactKeys(fall, ["no_exposure_at_3m"]) && fall.no_exposure_at_3m === true) {
    fallProtection = { no_exposure_at_3m: true };
  } else {
    return null;
  }
  return {
    hazard_assessment_ref: value.hazard_assessment_ref,
    fall_protection: fallProtection,
    assessed_at: assessedAt,
  };
}

export function isAttestableProductionGate(value: string): value is AttestableProductionGate {
  return (ATTESTABLE_PRODUCTION_GATES as readonly string[]).includes(value);
}

/** One gate's attestation and its note, or null when the shape is not exactly that gate's. */
export function parseGateAttestation(
  gate: AttestableProductionGate,
  value: unknown,
  now: Date,
): { attestation: GateAttestation; note: string | null } | null {
  if (!isRecord(value)) return null;
  const { notes, ...fields } = value;
  const note = attestationNote(notes);
  if (note === undefined) return null;
  const attestation = gate === "Materials"
    ? materials(fields)
    : gate === "Access"
    ? access(fields, now)
    : gate === "Weather"
    ? weather(fields, now)
    : safety(fields, now);
  return attestation ? { attestation, note } : null;
}

/** 0 to 10 distinct references to a Work Package capture or a stock reservation, sorted. */
export function parseEvidenceRefs(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_REFS) return null;
  if (
    !value.every((ref) =>
      typeof ref === "string" &&
      (FIELD_EVIDENCE_REF_RE.test(ref) || STOCK_RESERVATION_REF_RE.test(ref))
    ) ||
    new Set(value).size !== value.length
  ) {
    return null;
  }
  return [...(value as string[])].sort();
}

/** The evidence id a `field-evidence://` reference names, or null. */
export function fieldEvidenceId(ref: string): string | null {
  return FIELD_EVIDENCE_REF_RE.exec(ref)?.[1] ?? null;
}

/** The reservation id a `stock-reservation://` reference names, or null. */
export function stockReservationId(ref: string): string | null {
  return STOCK_RESERVATION_REF_RE.exec(ref)?.[1] ?? null;
}

/** The person-attestation body: exactly `{basis, expected_gate_version, attestation, evidence_refs?}`. */
export function parseProductionGateAttestation(
  gate: AttestableProductionGate,
  body: unknown,
  now: Date,
): ProductionGateAttestationRequest | null {
  if (!isRecord(body) || body.basis !== "person_attestation") return null;
  if (!exactKeys(body, ["basis", "expected_gate_version", "attestation"], ["evidence_refs"])) {
    return null;
  }
  const version = body.expected_gate_version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1 || version > 1_000_000) {
    return null;
  }
  const parsed = parseGateAttestation(gate, body.attestation, now);
  const evidenceRefs = parseEvidenceRefs(body.evidence_refs);
  if (!parsed || !evidenceRefs) return null;
  return {
    gate,
    expectedGateVersion: version,
    attestation: parsed.attestation,
    note: parsed.note,
    evidenceRefs,
  };
}

/**
 * Why a Weather attestation may not stand now, or null: its forecast was observed more than 72
 * hours ago, or its work window is empty, longer than 14 days, already over, or ends more than 14
 * days after the forecast it rests on. Holding a schedule to the window is the assignment guard's.
 */
export function weatherRefusal(
  attestation: WeatherAttestation,
  now: Date,
): "production_gate_forecast_stale" | "production_gate_weather_window_invalid" | null {
  const start = Date.parse(attestation.window_start);
  const end = Date.parse(attestation.window_end);
  const forecast = Date.parse(attestation.forecast_observed_at);
  if (forecast < now.getTime() - MAX_FORECAST_AGE_HOURS * HOUR_MS) {
    return "production_gate_forecast_stale";
  }
  if (
    end <= start ||
    end - start > MAX_WEATHER_WINDOW_DAYS * DAY_MS ||
    end <= now.getTime() ||
    end > forecast + MAX_WEATHER_WINDOW_DAYS * DAY_MS
  ) {
    return "production_gate_weather_window_invalid";
  }
  return null;
}
