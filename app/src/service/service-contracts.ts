import { z } from "zod";

// The app contract for the service lifecycle BFF (`/api/v1/service-cases`). Every field the office
// acts on is validated here, so a drifted server response fails loudly at the boundary rather than
// rendering a callback whose state the app misread.

const boundedText = (min: number, max: number) => z.string().trim().min(min).max(max);
const identifier = boundedText(1, 160);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const timestamp = boundedText(1, 80);
const cents = z.number().int().min(0);

export const serviceCaseStates = [
  "intake",
  "triaged",
  "diagnosed",
  "remedy_issued",
  "remedy_verified",
  "customer_accepted",
  "disputed",
  "closed",
  "reopened",
] as const;
export const serviceCaseSeverities = ["emergency", "urgent", "standard", "monitor"] as const;
export const serviceReportedChannels = ["phone", "portal", "email", "field", "partner"] as const;
export const serviceTriageCategories = [
  "emergency",
  "workmanship",
  "material_manufacturer",
  "weather",
  "excluded",
  "unknown",
] as const;
export const serviceResponsibilities = [
  "ironwrap_workmanship",
  "manufacturer",
  "supplier",
  "customer",
  "third_party",
  "weather",
  "undetermined",
] as const;
export const serviceClosureReasons = [
  "remedied_accepted",
  "no_fault_unknown",
  "excluded",
  "withdrawn",
] as const;
export const serviceCounterpartyKinds = ["supplier", "manufacturer", "insurer"] as const;

/** An emergency callback may never be parked behind a routine response window. */
export const EMERGENCY_RESPONSE_SLA_CEILING_MINUTES = 240;

export const serviceCaseSchema = z
  .object({
    service_case_id: identifier,
    customer_id: identifier,
    property_key: identifier,
    roof_job_id: identifier,
    asset_ref: identifier.nullable(),
    warranty_packet_id: identifier.nullable(),
    origin_work_package_ref: identifier.nullable(),
    severity: z.enum(serviceCaseSeverities),
    symptom_code: identifier,
    reported_channel: z.enum(serviceReportedChannels),
    consent_ref: identifier,
    intake_evidence_digest: digest,
    response_sla_minutes: z.number().int().positive(),
    response_due_at: timestamp,
    state: z.enum(serviceCaseStates),
    version: z.number().int().positive(),
    last_event_type: boundedText(1, 60),
    last_transition_code: boundedText(1, 160).nullable(),
    last_evidence_digest: digest.nullable(),
    duplicate_of_case_id: identifier.nullable(),
    closure_reason: z.enum([...serviceClosureReasons, "duplicate"]).nullable(),
    closed_at: timestamp.nullable(),
    reopen_count: z.number().int().min(0),
    opened_by_user_id: identifier,
    last_actor_user_id: identifier,
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict();

export const serviceCaseEventSchema = z
  .object({
    event_id: z.number().int(),
    service_case_id: identifier,
    tenant_id: identifier,
    event_type: boundedText(1, 60),
    case_state: z.enum(serviceCaseStates),
    case_version: z.number().int().positive(),
    actor_user_id: identifier,
    detail_code: boundedText(1, 160).nullable(),
    evidence_digest: digest.nullable(),
    created_at: timestamp,
  })
  .strict();

export const serviceTriageSchema = z
  .object({
    triage_id: identifier,
    service_case_id: identifier,
    tenant_id: identifier,
    case_version: z.number().int().positive(),
    advisory_source: z.enum(["model", "rule", "none"]),
    advisory_category: z.enum(serviceTriageCategories).nullable(),
    advisory_confidence_bps: z.number().int().min(0).max(10_000).nullable(),
    final_category: z.enum(serviceTriageCategories),
    responsibility: z.enum(serviceResponsibilities),
    authority_kind: z.literal("human"),
    decided_by_user_id: identifier,
    decided_by_role: boundedText(1, 140),
    evidence_digest: digest,
    decided_at: timestamp,
    created_at: timestamp,
  })
  .strict();

export const serviceDiagnosisSchema = z
  .object({
    diagnosis_id: identifier,
    service_case_id: identifier,
    tenant_id: identifier,
    case_version: z.number().int().positive(),
    triage_id: identifier,
    root_cause_code: identifier,
    corrective_action_code: identifier,
    recurrence_of_case_id: identifier.nullable(),
    work_package_ref: identifier,
    work_package_version: z.number().int().positive(),
    warranty_reserve_cents: cents,
    evidence_digest: digest,
    diagnosed_by_user_id: identifier,
    diagnosed_at: timestamp,
    created_at: timestamp,
  })
  .strict();

export const serviceRemedySchema = z
  .object({
    remedy_id: identifier,
    service_case_id: identifier,
    tenant_id: identifier,
    case_version: z.number().int().positive(),
    diagnosis_id: identifier,
    scheduled_start_at: timestamp,
    scheduled_end_at: timestamp,
    parts_manifest_digest: digest,
    field_evidence_digest: digest.nullable(),
    verification_state: z.enum(["pending", "verified", "failed"]),
    verified_at: timestamp.nullable(),
    verified_by_user_id: identifier.nullable(),
    failure_code: boundedText(1, 160).nullable(),
    customer_acceptance_state: z.enum(["pending", "accepted", "disputed"]),
    customer_decision_at: timestamp.nullable(),
    customer_acceptance_ref: identifier.nullable(),
    dispute_code: boundedText(1, 160).nullable(),
    cost_actual_cents: cents.nullable(),
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict();

export const costRecoveryClaimSchema = z
  .object({
    claim_id: identifier,
    service_case_id: identifier,
    case_version: z.number().int().positive(),
    diagnosis_id: identifier,
    counterparty_kind: z.enum(serviceCounterpartyKinds),
    counterparty_ref: identifier,
    claim_basis_code: identifier,
    claimed_amount_cents: cents,
    currency: z.literal("CAD"),
    evidence_digest: digest,
    effect_kind: z.literal("cost_recovery_claim_submission"),
    actor_user_id: identifier,
    actor_role: z.enum(["owner", "ops"]),
    authority_ref: identifier,
    correlation_id: identifier,
    deadline_at: timestamp,
    idempotency_key: boundedText(8, 160),
    state: z.enum(["pending", "leased", "succeeded", "failed", "uncertain", "reconciled"]),
    attempt_count: z.number().int().min(0).max(1),
    attempt_mode: z.enum(["none", "leased", "inferred_terminal"]),
    due_at: timestamp,
    lease_ref: boundedText(1, 160).nullable(),
    lease_expires_at: timestamp.nullable(),
    attempted_at: timestamp.nullable(),
    result_ref: boundedText(1, 160).nullable(),
    result_code: boundedText(1, 160).nullable(),
    recovered_amount_cents: cents.nullable(),
    reconciled_at: timestamp.nullable(),
    reconciliation_outcome: z.enum(["executed", "not_executed", "inconclusive"]).nullable(),
    reconciliation_ref: boundedText(1, 160).nullable(),
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict();

export const serviceCaseCostSchema = z
  .object({
    warranty_reserve_cents: cents,
    actual_cost_cents: cents,
    recovered_cents: cents,
    net_cost_cents: cents,
    recurrence_count: z.number().int().min(0),
  })
  .strict();

const envelope = z.object({
  version: z.literal(1),
  read_model_generated_at: timestamp,
  allowed_actions: z.array(boundedText(1, 80)).max(20),
});

export const serviceCaseListResponseSchema = envelope
  .extend({ service_cases: z.array(serviceCaseSchema) })
  .strict();

export const serviceCaseDetailResponseSchema = envelope
  .extend({
    service_case: serviceCaseSchema,
    triage: z.array(serviceTriageSchema),
    diagnoses: z.array(serviceDiagnosisSchema),
    remedies: z.array(serviceRemedySchema),
    cost_recovery_claims: z.array(costRecoveryClaimSchema),
    events: z.array(serviceCaseEventSchema),
    cost: serviceCaseCostSchema,
  })
  .strict();

export const serviceCaseIntakeResponseSchema = envelope
  .extend({
    result: z.enum(["opened", "duplicate"]),
    service_case: serviceCaseSchema,
    original_case: serviceCaseSchema.nullable(),
  })
  .strict();

export const serviceCaseMutationResponseSchema = envelope
  .extend({ service_case: serviceCaseSchema })
  .strict();

export const serviceTriageResponseSchema = envelope
  .extend({ service_case: serviceCaseSchema, triage: serviceTriageSchema })
  .strict();

export const serviceDiagnosisResponseSchema = envelope
  .extend({ service_case: serviceCaseSchema, diagnosis: serviceDiagnosisSchema })
  .strict();

export const serviceRemedyResponseSchema = envelope
  .extend({ service_case: serviceCaseSchema, remedy: serviceRemedySchema })
  .strict();

export const costRecoveryMutationResponseSchema = envelope
  .extend({
    claim: costRecoveryClaimSchema,
    result: z.enum(["opened", "already_recorded", "claimed", "already_attempted"]).optional(),
  })
  .strict();

/**
 * The intake a human fills in. The response window is a declared number of minutes; the bus
 * derives the due timestamp from it, so the form never sends one.
 */
export const serviceCaseIntakeInputSchema = z
  .object({
    customerId: boundedText(3, 140),
    propertyKey: boundedText(3, 140),
    roofJobId: boundedText(3, 140),
    warrantyPacketId: boundedText(3, 140).nullable().optional(),
    severity: z.enum(serviceCaseSeverities),
    symptomCode: boundedText(3, 80).regex(/^[a-z0-9_]+$/),
    reportedChannel: z.enum(serviceReportedChannels),
    consentRef: boundedText(3, 140),
    intakeEvidenceDigest: digest,
    responseSlaMinutes: z
      .number()
      .int()
      .min(1)
      .max(60 * 24 * 30),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.severity === "emergency" &&
      input.responseSlaMinutes > EMERGENCY_RESPONSE_SLA_CEILING_MINUTES
    ) {
      context.addIssue({
        code: "custom",
        path: ["responseSlaMinutes"],
        message: "emergency_response_window_exceeded",
      });
    }
  });

export type ServiceCase = z.infer<typeof serviceCaseSchema>;
export type ServiceCaseEvent = z.infer<typeof serviceCaseEventSchema>;
export type ServiceTriage = z.infer<typeof serviceTriageSchema>;
export type ServiceDiagnosis = z.infer<typeof serviceDiagnosisSchema>;
export type ServiceRemedy = z.infer<typeof serviceRemedySchema>;
export type CostRecoveryClaim = z.infer<typeof costRecoveryClaimSchema>;
export type ServiceCaseCost = z.infer<typeof serviceCaseCostSchema>;
export type ServiceCaseListResponse = z.infer<typeof serviceCaseListResponseSchema>;
export type ServiceCaseDetailResponse = z.infer<typeof serviceCaseDetailResponseSchema>;
export type ServiceCaseIntakeResponse = z.infer<typeof serviceCaseIntakeResponseSchema>;
export type ServiceCaseIntakeInput = z.infer<typeof serviceCaseIntakeInputSchema>;
export type ServiceCaseMutationResponse = z.infer<typeof serviceCaseMutationResponseSchema>;
export type ServiceTriageResponse = z.infer<typeof serviceTriageResponseSchema>;
export type ServiceDiagnosisResponse = z.infer<typeof serviceDiagnosisResponseSchema>;
export type ServiceRemedyResponse = z.infer<typeof serviceRemedyResponseSchema>;
export type CostRecoveryMutationResponse = z.infer<typeof costRecoveryMutationResponseSchema>;
