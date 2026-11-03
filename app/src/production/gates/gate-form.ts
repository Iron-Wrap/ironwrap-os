import {
  FORECAST_SOURCE_PATTERN,
  MAX_NOTE_LENGTH,
  PERMIT_NUMBER_PATTERN,
  REFERENCE_PATTERN,
  type AccessAttestation,
  type AttestableGate,
  type GateAttestation,
  type MaterialsAttestation,
  type SafetyAttestation,
  type SafetyPermitAnswer,
  type WeatherAttestation,
} from "./gate-contracts";
import { instantFromLocal } from "./gate-time";

/** What a gate's proof form holds while the person types, before it is an attestation. */
export interface FormState {
  supplier: string;
  reference: string;
  hazardRef: string;
  assessedAt: string;
  permit: SafetyPermitAnswer | null;
  permitNumber: string;
  fall: "plan" | "no_exposure" | null;
  fallPlanRef: string;
  confirmedWith: AccessAttestation["confirmed_with"] | null;
  confirmedAt: string;
  accessNote: string;
  windowStart: string;
  windowEnd: string;
  forecast: string;
  forecastAt: string;
  forecastSource: string;
}

export const emptyForm: FormState = {
  supplier: "",
  reference: "",
  hazardRef: "",
  assessedAt: "",
  permit: null,
  permitNumber: "",
  fall: null,
  fallPlanRef: "",
  confirmedWith: null,
  confirmedAt: "",
  accessNote: "",
  windowStart: "",
  windowEnd: "",
  forecast: "",
  forecastAt: "",
  forecastSource: "",
};

function note(value: string): { notes?: string } {
  const trimmed = value.trim();
  return trimmed.length > 0 ? { notes: trimmed.slice(0, MAX_NOTE_LENGTH) } : {};
}

/** The attestation the form describes, or null while it is not yet one the Worker would read. */
export function attestationFrom(
  gate: AttestableGate,
  form: FormState,
  timeZone: string,
): GateAttestation | null {
  const at = (local: string) => instantFromLocal(local, timeZone)?.iso ?? null;
  if (gate === "Materials") {
    const reference = form.reference.trim();
    if (!REFERENCE_PATTERN.test(reference)) return null;
    return {
      source: "supplier_delivery",
      reference,
      ...note(form.supplier),
    } satisfies MaterialsAttestation;
  }
  if (gate === "Access") {
    const confirmedAt = at(form.confirmedAt);
    if (!form.confirmedWith || !confirmedAt) return null;
    return {
      confirmed_with: form.confirmedWith,
      confirmed_at: confirmedAt,
      ...note(form.accessNote),
    } satisfies AccessAttestation;
  }
  if (gate === "Weather") {
    const start = at(form.windowStart);
    const end = at(form.windowEnd);
    const read = at(form.forecastAt);
    const source = form.forecastSource.trim();
    if (!start || !end || !read || !FORECAST_SOURCE_PATTERN.test(source)) return null;
    return {
      window_start: start,
      window_end: end,
      forecast_source: source,
      forecast_observed_at: read,
      ...note(form.forecast),
    } satisfies WeatherAttestation;
  }
  const hazard = form.hazardRef.trim();
  const assessedAt = at(form.assessedAt);
  if (!REFERENCE_PATTERN.test(hazard) || !assessedAt || !form.permit || !form.fall) return null;
  const number = form.permitNumber.trim().replace(/\s+/g, " ");
  if (
    form.permit === "needed_and_held" &&
    !(number.length <= 80 && PERMIT_NUMBER_PATTERN.test(number))
  ) {
    return null;
  }
  const planRef = form.fallPlanRef.trim();
  if (form.fall === "plan" && !REFERENCE_PATTERN.test(planRef)) return null;
  return {
    hazard_assessment_ref: hazard,
    permit:
      form.permit === "needed_and_held"
        ? { answer: "needed_and_held", number }
        : { answer: form.permit },
    fall_protection: form.fall === "plan" ? { plan_ref: planRef } : { no_exposure_at_3m: true },
    assessed_at: assessedAt,
  } satisfies SafetyAttestation;
}
