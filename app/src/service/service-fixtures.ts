import type {
  CostRecoveryClaim,
  ServiceCase,
  ServiceCaseDetailResponse,
  ServiceCaseListResponse,
  ServiceDiagnosis,
  ServiceRemedy,
  ServiceTriage,
} from "./service-contracts";

// Synthetic service-lifecycle fixtures shared by the app tests. They mirror exactly what the BFF
// projects, so a schema drift fails the contract tests rather than quietly reshaping a page test.

export const DIGEST_A = "a".repeat(64);
export const DIGEST_B = "b".repeat(64);

export const OFFICE_ACTIONS = [
  "service_case.read",
  "service_case.open",
  "service_case.triage",
  "service_case.diagnose",
  "service_case.issue_remedy",
  "service_case.verify_remedy",
  "service_case.record_customer_decision",
  "service_case.close",
  "service_case.reopen",
];
export const OWNER_ACTIONS = [...OFFICE_ACTIONS, "service_case.recover_cost"];

export function serviceCase(overrides: Partial<ServiceCase> = {}): ServiceCase {
  return {
    service_case_id: "svc_case_0001",
    customer_id: "CUST-0001",
    property_key: "PROP-0001",
    roof_job_id: "JOB-0001",
    asset_ref: null,
    warranty_packet_id: "WP-0001",
    origin_work_package_ref: null,
    severity: "standard",
    symptom_code: "interior_water_stain",
    reported_channel: "phone",
    consent_ref: "CONSENT-0001",
    intake_evidence_digest: DIGEST_A,
    response_sla_minutes: 1440,
    response_due_at: "2026-08-19T10:00:00.000Z",
    state: "intake",
    version: 1,
    last_event_type: "case_opened",
    last_transition_code: "callback_reported",
    last_evidence_digest: DIGEST_A,
    duplicate_of_case_id: null,
    closure_reason: null,
    closed_at: null,
    reopen_count: 0,
    opened_by_user_id: "appu_ops",
    last_actor_user_id: "appu_ops",
    created_at: "2026-08-18T10:00:00.000Z",
    updated_at: "2026-08-18T10:00:00.000Z",
    ...overrides,
  };
}

export function triage(overrides: Partial<ServiceTriage> = {}): ServiceTriage {
  return {
    triage_id: "svc_triage_0001",
    service_case_id: "svc_case_0001",
    tenant_id: "ironwrap",
    case_version: 1,
    advisory_source: "none",
    advisory_category: null,
    advisory_confidence_bps: null,
    final_category: "material_manufacturer",
    responsibility: "manufacturer",
    authority_kind: "human",
    decided_by_user_id: "appu_ops",
    decided_by_role: "ops",
    evidence_digest: DIGEST_B,
    decided_at: "2026-08-18T11:00:00.000Z",
    created_at: "2026-08-18T11:00:00.000Z",
    ...overrides,
  };
}

export function diagnosis(overrides: Partial<ServiceDiagnosis> = {}): ServiceDiagnosis {
  return {
    diagnosis_id: "svc_diag_0001",
    service_case_id: "svc_case_0001",
    tenant_id: "ironwrap",
    case_version: 2,
    triage_id: "svc_triage_0001",
    root_cause_code: "granule_loss_defect",
    corrective_action_code: "replace_affected_field",
    recurrence_of_case_id: null,
    work_package_ref: "wp:JOB-0001:service",
    work_package_version: 1,
    warranty_reserve_cents: 120_000,
    evidence_digest: DIGEST_B,
    diagnosed_by_user_id: "appu_ops",
    diagnosed_at: "2026-08-19T09:00:00.000Z",
    created_at: "2026-08-19T09:00:00.000Z",
    ...overrides,
  };
}

export function remedy(overrides: Partial<ServiceRemedy> = {}): ServiceRemedy {
  return {
    remedy_id: "svc_remedy_0001",
    service_case_id: "svc_case_0001",
    tenant_id: "ironwrap",
    case_version: 3,
    diagnosis_id: "svc_diag_0001",
    scheduled_start_at: "2026-08-25T14:00:00.000Z",
    scheduled_end_at: "2026-08-25T20:00:00.000Z",
    parts_manifest_digest: DIGEST_B,
    field_evidence_digest: null,
    verification_state: "pending",
    verified_at: null,
    verified_by_user_id: null,
    failure_code: null,
    customer_acceptance_state: "pending",
    customer_decision_at: null,
    customer_acceptance_ref: null,
    dispute_code: null,
    cost_actual_cents: null,
    created_at: "2026-08-19T09:30:00.000Z",
    updated_at: "2026-08-19T09:30:00.000Z",
    ...overrides,
  };
}

export function claim(overrides: Partial<CostRecoveryClaim> = {}): CostRecoveryClaim {
  return {
    claim_id: "svc_recovery_0001",
    service_case_id: "svc_case_0001",
    case_version: 5,
    diagnosis_id: "svc_diag_0001",
    counterparty_kind: "manufacturer",
    counterparty_ref: "SUP-SHINGLE-CO",
    claim_basis_code: "material_defect_granule_loss",
    claimed_amount_cents: 150_000,
    currency: "CAD",
    evidence_digest: DIGEST_B,
    effect_kind: "cost_recovery_claim_submission",
    actor_user_id: "appu_owner",
    actor_role: "owner",
    authority_ref: "svc_triage_0001",
    correlation_id: "svc-case:svc_case_0001",
    deadline_at: "2026-09-19T09:00:00.000Z",
    idempotency_key: "svc-recovery:0123456789abcdef",
    state: "pending",
    attempt_count: 0,
    attempt_mode: "none",
    due_at: "2026-08-20T09:00:00.000Z",
    lease_ref: null,
    lease_expires_at: null,
    attempted_at: null,
    result_ref: null,
    result_code: null,
    recovered_amount_cents: null,
    reconciled_at: null,
    reconciliation_outcome: null,
    reconciliation_ref: null,
    created_at: "2026-08-20T09:00:00.000Z",
    updated_at: "2026-08-20T09:00:00.000Z",
    ...overrides,
  };
}

export function listResponse(cases: ServiceCase[] = [serviceCase()]): ServiceCaseListResponse {
  return {
    version: 1,
    read_model_generated_at: "2026-08-20T09:00:00.000Z",
    allowed_actions: OFFICE_ACTIONS,
    service_cases: cases,
  };
}

export function detailResponse(
  overrides: Partial<ServiceCaseDetailResponse> = {},
): ServiceCaseDetailResponse {
  return {
    version: 1,
    read_model_generated_at: "2026-08-20T09:00:00.000Z",
    allowed_actions: OFFICE_ACTIONS,
    service_case: serviceCase(),
    triage: [],
    diagnoses: [],
    remedies: [],
    cost_recovery_claims: [],
    events: [
      {
        event_id: 1,
        service_case_id: "svc_case_0001",
        tenant_id: "ironwrap",
        event_type: "case_opened",
        case_state: "intake",
        case_version: 1,
        actor_user_id: "appu_ops",
        detail_code: "callback_reported",
        evidence_digest: DIGEST_A,
        created_at: "2026-08-18T10:00:00.000Z",
      },
    ],
    cost: {
      warranty_reserve_cents: 0,
      actual_cost_cents: 0,
      recovered_cents: 0,
      net_cost_cents: 0,
      recurrence_count: 0,
    },
    ...overrides,
  };
}
