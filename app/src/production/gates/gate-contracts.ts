import { z } from "zod";

/**
 * The office's read and write contracts for a job's scheduling gates and its OD-01 cancellation
 * window (gate train A1-A5, migrations 0153-0160). Each schema mirrors one Worker answer:
 *
 * - `GET /api/v1/production/jobs/{job}/gates` (`handleProductionGatesRead`,
 *   `workers-bus/src/production-gate-clearance.ts`): the six gates with their ledger entries and
 *   open waiver requests, and the `cancellation_window` System state beside them
 *   (`readCancellationWindow`, `workers-bus/src/production-cancellation-window.ts`).
 * - the attestation and reversal answers (`entryResponse`), the waiver decision answer
 *   (`decisionResponse`), the signed-copy record answer, and the Q1 work queue.
 *
 * Unknown keys are refused where the Worker's answer is closed, so a widened read fails loudly in
 * a test instead of being dropped silently. The free-form parts (an attestation's fields, an
 * evidence list) are records: the screen reads only the keys it names.
 */

export const gateNames = ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew"] as const;
export type GateName = (typeof gateNames)[number];

/** The gates a person clears with proof (A3). Deposit clears by contract or settlement, Crew by schedule. */
export const attestableGates = ["Materials", "Safety", "Access", "Weather"] as const;
export type AttestableGate = (typeof attestableGates)[number];

/** Owner ruling: only Deposit, Materials and Access may be waived. */
export const waivableGates = ["Deposit", "Materials", "Access"] as const;
export type WaivableGate = (typeof waivableGates)[number];

export function isAttestableGate(gate: GateName): gate is AttestableGate {
  return (attestableGates as readonly string[]).includes(gate);
}

export function isWaivableGate(gate: GateName): gate is WaivableGate {
  return (waivableGates as readonly string[]).includes(gate);
}

/** D1's gate states (migration 0098). */
export const gateStates = ["blocked", "ready", "complete", "waived"] as const;
export type GateState = (typeof gateStates)[number];

const instant = z.string().min(1);
const nullableInstant = instant.nullable();

export const gateEntrySchema = z
  .object({
    id: z.string().min(1),
    kind: z.string().min(1),
    basis: z.string().min(1),
    to_state: z.string().min(1),
    from_gate_version: z.number().int().nonnegative(),
    actor_role: z.string().nullable(),
    created_at: instant,
    request_id: z.string().nullable(),
    reverses_id: z.string().nullable(),
    self_approval: z.boolean(),
    attestation: z.record(z.string(), z.unknown()).nullable(),
    evidence_refs: z.array(z.record(z.string(), z.unknown())).nullable(),
    reason: z.string().nullable(),
    reason_redacted: z.boolean(),
  })
  .strict();

export type GateEntry = z.infer<typeof gateEntrySchema>;

export const openWaiverRequestSchema = z
  .object({
    request_id: z.string().min(1),
    is_own_request: z.boolean(),
    requested_by_role: z.string().nullable(),
    from_gate_version: z.number().int().nonnegative(),
    reason: z.string().nullable(),
    reason_redacted: z.boolean(),
    created_at: instant,
  })
  .strict();

export type OpenWaiverRequest = z.infer<typeof openWaiverRequestSchema>;

export const jobGateSchema = z
  .object({
    name: z.string().min(1),
    gate: z.enum(gateNames),
    roof_job: z.string().min(1),
    state: z.enum(gateStates),
    version: z.number().int().positive(),
    ledger_complete: z.boolean(),
    entries: z.array(gateEntrySchema),
    open_waiver_requests: z.array(openWaiverRequestSchema),
  })
  .strict();

export type JobGate = z.infer<typeof jobGateSchema>;

export const windowUnknownReasons = [
  "signed_copy_time_missing",
  "signed_copy_unconfirmed",
  "signed_copy_before_contract",
] as const;
export type WindowUnknownReason = (typeof windowUnknownReasons)[number];

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const signedCopyShownSchema = z
  .object({
    id: z.string().min(1),
    acceptance_binding_id: z.string().min(1),
    contract_signed_at: instant,
    shown_at: instant,
    window_ends_at: instant,
    time_zone: z.string().min(1),
    served_at: nullableInstant,
  })
  .strict();

export const signedCopyReceivedSchema = z
  .object({
    id: z.string().min(1),
    received_at: instant,
    window_ends_at: instant,
    time_zone: z.string().min(1),
    contract_signed_at: nullableInstant,
    acceptance_binding_id: z.string().nullable(),
    no_d1_contract: z.boolean(),
    reason: z.string(),
    evidence_ref: z.string(),
    recorded_at: instant,
    recorded_by: z
      .object({ display_name: z.string().nullable(), role: z.string().min(1) })
      .strict(),
  })
  .strict();

export type SignedCopyReceived = z.infer<typeof signedCopyReceivedSchema>;

export const cancellationWindowSchema = z
  .object({
    kind: z.literal("system_state"),
    state: z.enum(["unknown", "open", "ended"]),
    waivable: z.literal(false),
    unknown_reason: z.enum(windowUnknownReasons).nullable(),
    starts_at: nullableInstant,
    started_from: z.enum(["signed_copy_shown", "manual_record"]).nullable(),
    last_day: localDate.nullable(),
    ends_at: nullableInstant,
    ends_on_calendar_day: z.boolean().nullable(),
    contract: z
      .object({ acceptance_binding_id: z.string().min(1), signed_at: instant })
      .strict()
      .nullable(),
    signed_copy_shown: signedCopyShownSchema.nullable(),
    signed_copy_received: signedCopyReceivedSchema.nullable(),
    holds: z.array(z.string()),
    time_zone: z.string().min(1),
    as_of: instant,
  })
  .strict();

export type CancellationWindow = z.infer<typeof cancellationWindowSchema>;

export const jobGatesResponseSchema = z
  .object({
    roof_job: z.string().min(1),
    cancellation_window: cancellationWindowSchema,
    gates: z.array(jobGateSchema).min(1),
  })
  .strict();

export type JobGatesResponse = z.infer<typeof jobGatesResponseSchema>;

/** An appended (or replayed) attestation or reversal, and the gate after it. */
export const gateEntryResponseSchema = z
  .object({
    entry: gateEntrySchema,
    gate: z
      .object({
        name: z.string().min(1),
        gate: z.enum(gateNames),
        roof_job: z.string().min(1),
        state: z.enum(gateStates),
        version: z.number().int().positive(),
      })
      .strict(),
    replayed: z.boolean(),
  })
  .strict();

export type GateEntryResponse = z.infer<typeof gateEntryResponseSchema>;

export const waiverDecisionResponseSchema = z
  .object({
    decision: z
      .object({
        clearance_id: z.string().min(1),
        request_id: z.string().nullable(),
        decision: z.enum(["approve", "decline"]),
        requested_by: z.string().nullable(),
        decided_by: z.string().nullable(),
        actor_role: z.string().nullable(),
        self_approval: z.boolean(),
        self_approval_basis: z.string().nullable(),
        reason: z.string().nullable(),
        created_at: instant,
      })
      .strict(),
    gate: z
      .object({
        name: z.string().min(1),
        gate: z.enum(gateNames),
        roof_job: z.string().min(1),
        state: z.string().min(1),
        version: z.number().int().positive(),
      })
      .strict(),
    replayed: z.boolean(),
  })
  .strict();

export type WaiverDecisionResponse = z.infer<typeof waiverDecisionResponseSchema>;

/** `POST .../cancellation-window/signed-copy`: 201 recorded, 200 replayed or unchanged. */
export const signedCopyRecordResponseSchema = z
  .object({
    cancellation_window: cancellationWindowSchema,
    recorded: z.boolean(),
    receipt_id: z.string().min(1).optional(),
    replayed: z.boolean(),
    unchanged: z.boolean().optional(),
  })
  .strict();

export type SignedCopyRecordResponse = z.infer<typeof signedCopyRecordResponseSchema>;

export const signedCopyQueueCategories = ["window_unknown", "signed_copy_unconfirmed"] as const;

export const signedCopyQueueResponseSchema = z
  .object({
    count: z.number().int().nonnegative(),
    counts: z
      .object({
        window_unknown: z.number().int().nonnegative(),
        signed_copy_unconfirmed: z.number().int().nonnegative(),
      })
      .strict(),
    complete: z.boolean(),
    jobs: z.array(
      z
        .object({
          roof_job_id: z.string().min(1),
          job_number: z.string().nullable(),
          customer_display_name: z.string(),
          address_line1: z.string().nullable(),
          category: z.enum(signedCopyQueueCategories),
          unknown_reason: z.enum(windowUnknownReasons),
          copy_shown_at: nullableInstant,
          contract_on_record: z.boolean(),
          contract_signed_at: nullableInstant,
        })
        .strict(),
    ),
  })
  .strict();

export type SignedCopyQueueResponse = z.infer<typeof signedCopyQueueResponseSchema>;
export type SignedCopyQueueJob = SignedCopyQueueResponse["jobs"][number];

/** The attestation each gate sends (A3, `production-gate-attestation.ts`). */
export type MaterialsAttestation = {
  source: "supplier_delivery" | "reserved_stock" | "customer_supplied" | "none_needed";
  reference: string;
  notes?: string;
};
export type AccessAttestation = {
  confirmed_with: "customer" | "property_manager" | "not_needed";
  confirmed_at: string;
  notes?: string;
};
export type WeatherAttestation = {
  window_start: string;
  window_end: string;
  forecast_source: string;
  forecast_observed_at: string;
  notes?: string;
};
export type SafetyPermitAnswer = "needed_and_held" | "not_needed" | "unknown";
export type SafetyAttestation = {
  hazard_assessment_ref: string;
  permit: { answer: "needed_and_held"; number: string } | { answer: "not_needed" | "unknown" };
  fall_protection: { plan_ref: string } | { no_exposure_at_3m: true };
  assessed_at: string;
  notes?: string;
};
export type GateAttestation =
  MaterialsAttestation | AccessAttestation | WeatherAttestation | SafetyAttestation;

/** A reference the Worker accepts: no spaces, at most 80 characters. */
export const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,79}$/;
/** A permit number: reference words joined by single spaces, at most 80 characters. */
export const PERMIT_NUMBER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/#-]*(?: [A-Za-z0-9._:/#-]+)*$/;
/** Where a forecast came from, as a short lower-case site name ("weather.gc.ca"). */
export const FORECAST_SOURCE_PATTERN = /^[a-z0-9][a-z0-9.-]{1,63}$/;
export const MAX_NOTE_LENGTH = 300;
export const MIN_REASON_LENGTH = 8;
export const MAX_REASON_LENGTH = 1_000;
export const MAX_EVIDENCE_LENGTH = 300;
export const MAX_FORECAST_AGE_HOURS = 72;
export const MAX_WEATHER_WINDOW_DAYS = 14;
