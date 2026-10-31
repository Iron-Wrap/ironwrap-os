import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeAssignmentForJob,
  buildJobProofReadModel,
  buildJobReadModel,
  buildOwnerNowReadModel,
  buildProductionRunwayReadModel,
  buildSalesReadModel,
  buildTodayReadModel,
  buildUniversalWorkPackageReadModel,
  mctbStatus,
} from "../src/app-read-models.ts";
import { handleAuthenticatedRoute } from "../src/app-api.ts";
import {
  FRAPPE_READ_FIELDS,
  OFFICE_SALES_READ_FIELDS,
} from "../src/frappe-read.ts";
import { permissionsForRole } from "../src/app-types.ts";
import type { AppEnv, AppRole, AuthContext } from "../src/app-types.ts";

const MODIFIED = "2026-07-10T11:00:00.000Z";

const jobs = [
  job("JOB-A", "IW-1001", "PROP-A", "CUSTOMER-A"),
  job("JOB-B", "IW-1002", "PROP-B", "CUSTOMER-B"),
  job("JOB-C", "IW-1003", "PROP-C", "CUSTOMER-C"),
];

const assignments = [
  {
    name: "ASSIGN-A",
    assignment_id: "assignment_a",
    roof_job: "JOB-A",
    assignment_type: "Production",
    status: "In Progress",
    assigned_user: "crew@example.com",
    crew_profile: null,
    scheduled_start: "2026-07-10T08:00:00.000Z",
    scheduled_end: "2026-07-10T16:00:00.000Z",
    blocker_reason: null,
    modified: MODIFIED,
  },
  {
    name: "ASSIGN-B",
    assignment_id: "assignment_b",
    roof_job: "JOB-B",
    assignment_type: "Quality",
    status: "Assigned",
    assigned_user: null,
    crew_profile: "CREW-1",
    scheduled_start: "2026-07-11T08:00:00.000Z",
    scheduled_end: null,
    blocker_reason: null,
    modified: MODIFIED,
  },
];

function nativeAssignment(
  id: string,
  roofJobId: string,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    assignment_id: id,
    tenant_id: "ironwrap",
    roof_job_id: roofJobId,
    assignment_version: 1,
    roof_job_version: 1,
    crew_id: "CREW-1",
    crew_version: 3,
    assigned_users_json: JSON.stringify(["crew@example.com"]),
    scheduled_start: "2026-07-18T08:00:00.000Z",
    scheduled_end: null,
    supersedes_assignment_id: null,
    correction_reason: null,
    actor_user_id: "appu_ops",
    command_fingerprint: "a".repeat(64),
    idempotency_key_hash: "b".repeat(64),
    created_at: MODIFIED,
    ...overrides,
  };
}

function nativeTypedAssignment(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    assignment_id: "ASSIGN-SHOP-1",
    tenant_id: "ironwrap",
    work_object_type: "Shop Order",
    work_object_id: "SHOP-001",
    physical_context_type: "Shop Floor",
    physical_context_id: "SHOP-FLOOR-1",
    assignment_version: 1,
    assigned_users_json: JSON.stringify(["appu_field"]),
    scheduled_start: "2026-07-10T16:00:00.000Z",
    scheduled_end: null,
    authority_user_id: "appu_owner",
    authority_role: "owner",
    supersedes_assignment_id: null,
    correction_reason: null,
    actor_user_id: "appu_production",
    command_fingerprint: "c".repeat(64),
    idempotency_key_hash: "d".repeat(64),
    created_at: MODIFIED,
    ...overrides,
  };
}

function nativeGate(
  roofJobId: string,
  gate: string,
  state = "ready",
): Record<string, unknown> {
  return {
    gate_id: `gate_${roofJobId.toLowerCase()}_${gate.toLowerCase()}`,
    roof_job_id: roofJobId,
    gate,
    state,
    blocker_reason:
      state === "blocked" ? "Delivery not confirmed" : "No active blocker",
    owner_user: "production@example.com",
    assigned_at: "2026-07-10T09:00:00.000Z",
    due_at: "2026-07-11T12:00:00.000Z",
    updated_at: MODIFIED,
  };
}

function nativeOwnerQuote(
  id: string,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    quote_revision_id: id,
    tenant_id: "ironwrap",
    customer_quote_id: `customer-${id}`,
    revision_number: 1,
    roof_job_id: "JOB-A",
    customer_id: "CUSTOMER-A",
    supersedes_quote_revision_id: null,
    status: "approved",
    currency: "CAD",
    valid_until: "2026-08-31",
    subtotal_cents: 100_000,
    tax_cents: 5_000,
    total_cents: 105_000,
    terms_json: "{}",
    terms_hash: "1".repeat(64),
    evidence_refs_json: "[]",
    evidence_digest: "2".repeat(64),
    correction_reason: null,
    policy_permit_id: "permit-owner-now",
    quote_revision_approval_id: "approval-owner-now",
    authority_evidence_digest: "3".repeat(64),
    command_fingerprint: "4".repeat(64),
    idempotency_key_hash: "5".repeat(64),
    created_at: MODIFIED,
    ...overrides,
  };
}

function nativeAccountingIntent(
  id: string,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    intent_id: id,
    roof_job_id: "JOB-A",
    kind: "payment",
    state: "reconciled",
    currency: "CAD",
    subtotal: "0.00",
    total_amount: "250.00",
    expected_sha256: "a".repeat(64),
    provider_entity_type: "Payment",
    provider_entity_id: "123",
    blocker_code: null,
    blocker_next_step: null,
    reason_code: null,
    error_code: null,
    provider_submitted_at: "2026-07-10T10:00:00.000Z",
    provider_reconciled_at: "2026-07-10T10:01:00.000Z",
    updated_at: "2026-07-10T10:01:00.000Z",
    ...overrides,
  };
}

function nativeAccountingReconciliation(
  id: string,
  intentId: string,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    reconciliation_id: id,
    intent_id: intentId,
    expected_sha256: "a".repeat(64),
    observed_sha256: "a".repeat(64),
    verdict: "reconciled",
    reason_code: null,
    decided_at: "2026-07-10T10:00:30.000Z",
    ...overrides,
  };
}

function nativeWorkPackageRow(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  const workPackageId = String(overrides.work_package_id ?? "work_package_a");
  const suppliedDefinition = overrides.definition_json
    ? (JSON.parse(String(overrides.definition_json)) as Record<string, unknown>)
    : null;
  const definition = suppliedDefinition ?? {
    assigned_workers: [
      {
        sequence: 1,
        worker_user: "crew@example.com",
        worker_role: "Installer",
        required: true,
      },
    ],
    steps: [
      {
        sequence: 1,
        instruction: "Verify the roof zone.",
        required_evidence: "Zone photo",
        acceptance_criteria: "Zone matches package.",
      },
    ],
    hold_points: [
      {
        sequence: 1,
        hold_point: "Deck condition",
        release_phase: "Pre-start",
        release_authority: "Supervisor",
        required_evidence: "Deck photo",
        acceptance_criteria: "Supervisor release.",
      },
    ],
  };
  const workers = Array.isArray(definition.assigned_workers)
    ? definition.assigned_workers
    : [];
  const firstWorker = workers[0] as Record<string, unknown> | undefined;
  if (!Object.hasOwn(definition, "authority_requirements")) {
    definition.authority_requirements = [
      nativeAuthorityRequirement(
        workPackageId,
        String(firstWorker?.worker_user ?? "crew@example.com"),
      ),
    ];
  }
  return {
    work_package_id: workPackageId,
    tenant_id: "ironwrap",
    version: 1,
    job_id: "JOB-A",
    assignment_id: "ASSIGN-A",
    work_object_type: "Roof Job",
    work_object_id: "JOB-A",
    physical_context_type: "Roof Site",
    physical_context_id: "JOB-A",
    assignment_authority_user: "owner@example.com",
    assignment_authority_role: "IronWrap Owner",
    status: "Released",
    title: "South roof replacement",
    objective: "Install the released metal system.",
    boundaries: "South roof only.",
    prerequisites: "Verify tie-off and material staging.",
    expected_result: "Released roof section complete.",
    stop_conditions: "Stop for unsafe weather or missing controls.",
    make_safe_procedure: "Secure the work area and notify the supervisor.",
    definition_json: JSON.stringify(definition),
    issued_at: "2026-07-10T07:00:00.000Z",
    expires_at: "2026-07-11T07:00:00.000Z",
    released_at: "2026-07-10T07:05:00.000Z",
    release_attempt_id: "attempt-a",
    supersedes_id: null,
    correction_reason: null,
    acknowledged_at: null,
    completed_at: null,
    created_at: MODIFIED,
    updated_at: MODIFIED,
    ...overrides,
    definition_json: JSON.stringify(definition),
  };
}

function nativeAuthorityRequirement(
  workPackageId: string,
  subjectRef: string,
): Record<string, unknown> {
  return {
    subject_type: "Person",
    subject_role: "Worker",
    subject_ref: subjectRef,
    authority_kind: "Worker Competency",
    authority_scope: "field installation",
    scope_type: "Work Package",
    scope_ref: workPackageId,
    issuer_name: "IronWrap Production",
    issuer_jurisdiction: "AB-CA",
    issuer_reference: `internal:competency:${subjectRef}`,
    source_version: "2026-07-01",
  };
}

function nativeAuthorityReadback(
  requirement: Record<string, unknown>,
  index: number,
): Record<string, unknown> {
  return {
    readback_id: `authority_readback_${index}`,
    tenant_id: "ironwrap",
    authority_record_id: `authority_record_${index}`,
    authority_version: 1,
    subject_type: requirement.subject_type,
    subject_role: requirement.subject_role ?? null,
    person_user: requirement.subject_ref,
    organization: null,
    authority_kind: requirement.authority_kind,
    authority_scope: requirement.authority_scope ?? null,
    scope_type: requirement.scope_type,
    scope_ref: requirement.scope_ref,
    roof_job: null,
    scope_json: "{}",
    issuer_name: requirement.issuer_name ?? null,
    issuer_jurisdiction: requirement.issuer_jurisdiction ?? null,
    issuer_reference: requirement.issuer_reference ?? null,
    issuer_source_version: requirement.source_version ?? null,
    verification_state: "verified",
    evidence_refs_json: "[]",
    evidence_sha256: "e".repeat(64),
    authority_state_digest_sha256: "f".repeat(64),
    authority_effective_from: "2026-01-01",
    authority_expires_at: "2027-12-31",
    authority_revoked_at: null,
    supersedes_authority_record_id: null,
    authority_verification_method: "Internal Competency Assessment",
    issuer_receipt_sha256: null,
    observed_by_user_id: "appu_owner",
    observed_at: MODIFIED,
    observation_fingerprint_sha256: "a".repeat(64),
    action_id: null,
  };
}

function nativeWorkPackageEvent(
  eventKind: string,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    event_id: `wpe_${eventKind}`,
    tenant_id: "ironwrap",
    work_package_id: "work_package_a",
    work_package_version: 1,
    job_id: "JOB-A",
    assignment_id: "ASSIGN-A",
    work_object_type: "Roof Job",
    work_object_id: "JOB-A",
    physical_context_type: "Roof Site",
    physical_context_id: "JOB-A",
    release_attempt_id: "attempt-a",
    event_kind: eventKind,
    actor_user_id:
      eventKind === "hold_released"
        ? "production@example.com"
        : "crew@example.com",
    actor_role:
      eventKind === "hold_released" ? "IronWrap Production" : "Installer",
    device_action_id: `device-${eventKind}`,
    occurred_at: "2026-07-10T08:00:00.000Z",
    manifest_key: `work-packages/${eventKind}.json`,
    payload_json: "{}",
    created_at: MODIFIED,
    ...overrides,
  };
}

function nativeFieldEvidenceRows(
  count: number,
  overrides: Partial<Record<string, unknown>> = {},
): Array<Record<string, unknown>> {
  const baseTime = Date.parse("2026-07-10T09:00:00.000Z");
  return Array.from({ length: count }, (_, index) => {
    const capturedAt = new Date(baseTime + index * 1_000).toISOString();
    return {
      device_action_id: `device-action-${index}`,
      tenant_id: "ironwrap",
      job_id: "JOB-A",
      assignment_id: "ASSIGN-A",
      status: "verified",
      manifest_key: `field-actions/device-action-${index}.json`,
      r2_stored_at: capturedAt,
      user_id: "appu_field",
      actor_user: "crew@example.com",
      actor_role: "Installer",
      created_at: capturedAt,
      work_package_id: "work_package_a",
      work_package_version: 1,
      evidence_slot_id: "step:1",
      evidence_requirement: "Zone photo",
      evidence_source: "worker-camera",
      evidence_device_id: "paired-device-1",
      evidence_freshness: "Current",
      evidence_conflict_state: "None",
      evidence_verification: "Verified",
      evidence_disposition: "Open",
      evidence_correction_of: null,
      evidence_item_correction_of: null,
      work_package_release_attempt_id: "attempt-a",
      correction_reason: null,
      work_object_type: "Roof Job",
      work_object_id: "JOB-A",
      physical_context_type: "Roof Site",
      physical_context_id: "JOB-A",
      capture_completed_at: capturedAt,
      evidence_id: `evi_${String(index).padStart(32, "0")}`,
      ...overrides,
    };
  });
}

const proofRows = Array.from({ length: 1_051 }, (_, index) => ({
  name: `EVID-${String(index).padStart(4, "0")}`,
  evidence_id: `evidence_${String(index).padStart(4, "0")}`,
  device_action_id: `action_${index}`,
  roof_job: "JOB-A",
  evidence_type: "Photo",
  proof_slot: "Production",
  source_system: "ironwrap-pwa",
  captured_at: new Date(
    Date.parse("2026-01-01T00:00:00.000Z") + index * 1_000,
  ).toISOString(),
  customer_safe: 0,
  summary: `Photo ${index}`,
  sync_state: "Verified",
  modified: new Date(
    Date.parse("2026-01-01T00:00:00.000Z") + index * 1_000,
  ).toISOString(),
}));

function job(name: string, number: string, property: string, customer: string) {
  return {
    name,
    roof_job_id: name.toLowerCase(),
    job_number: number,
    brand: "ironwrap",
    service_type: "Roofing",
    job_status: "In Production",
    roofing_property: property,
    customer,
    current_gate_state: "Materials: Blocked",
    lead_envelope: null,
    workflow_profile: "Residential Retail",
    quotation: name === "JOB-A" ? "QUOTE-A" : null,
    modified: MODIFIED,
    _assign: JSON.stringify(["must-not-be-used@example.com"]),
    qb_invoice_ref: "financial-secret",
  };
}

function auth(role: AppRole, frappeUserId: string | null): AuthContext {
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: permissionsForRole(role),
    session: {
      session_hash: "a".repeat(64),
      session_created_at: MODIFIED,
      session_expires_at: "2026-07-11T10:00:00.000Z",
      revoked_at: null,
      user_id: `appu_${role}`,
      tenant_id: "ironwrap",
      email_normalized: `${role}@example.com`,
      display_name: role,
      role,
      frappe_user_id: frappeUserId,
      active: 1,
      created_by: "owner@example.com",
      created_at: MODIFIED,
      updated_at: MODIFIED,
    },
  };
}

type NativeOperationsSource =
  | "jobs"
  | "customers"
  | "properties"
  | "gates"
  | "assignments"
  | "typedAssignments"
  | "crews"
  | "materialExceptions"
  | "effectExceptions"
  | "leads"
  | "quotes"
  | "accountingIntents"
  | "accountingReconciliations"
  | "accountingExceptions"
  | "workPackages"
  | "workPackageEvents"
  | "fieldEvidence";

function env(
  nativeOverrides: Partial<
    Record<NativeOperationsSource, Array<Record<string, unknown>>>
  > = {},
  companyProfileRow: Record<string, unknown> | null = null,
): AppEnv {
  const nativeRows: Record<
    NativeOperationsSource,
    Array<Record<string, unknown>>
  > = {
    jobs: jobs.map((row) => ({
      roof_job_id: row.name,
      customer_id: row.customer,
      property_id: row.roofing_property,
      brand: row.brand,
      job_number: row.job_number,
      service_type: row.service_type,
      job_status: "in_progress",
      current_gate_state: "in_progress",
      version: 1,
      updated_at: row.modified,
    })),
    customers: ["A", "B", "C"].map((suffix, index) => ({
      customer_id: `CUSTOMER-${suffix}`,
      display_name: `Customer ${index + 1}`,
      contact_phone: `+1403555000${index}`,
      updated_at: MODIFIED,
    })),
    properties: ["A", "B", "C"].map((suffix) => ({
      property_id: `PROP-${suffix}`,
      address_line1: `${suffix} Native Avenue`,
      city: "Calgary",
      province: "AB",
      postal_code: "T2P 1J9",
      country: "Canada",
      updated_at: MODIFIED,
    })),
    gates: [
      {
        gate_id: "gate_job_a_materials",
        roof_job_id: "JOB-A",
        gate: "Materials",
        state: "blocked",
        blocker_reason: "Delivery not confirmed",
        owner_user: "office-owner@example.com",
        assigned_at: "2026-07-10T09:00:00.000Z",
        due_at: "2026-07-11T12:00:00.000Z",
        updated_at: MODIFIED,
      },
    ],
    assignments: assignments.map((row, index) => ({
      assignment_id: row.name,
      tenant_id: "ironwrap",
      roof_job_id: row.roof_job,
      assignment_version: 1,
      roof_job_version: 1,
      crew_id: row.crew_profile ?? `CREW-DIRECT-${index + 1}`,
      crew_version: 1,
      assigned_users_json: JSON.stringify(["crew@example.com"]),
      scheduled_start: row.scheduled_start,
      scheduled_end: row.scheduled_end,
      supersedes_assignment_id: null,
      correction_reason: null,
      actor_user_id: "appu_ops",
      command_fingerprint: "a".repeat(64),
      idempotency_key_hash: "b".repeat(64),
      created_at: row.modified,
    })),
    typedAssignments: [],
    crews: [
      {
        crew_id: "CREW-1",
        display_name: "Northside Metal",
        version: 3,
        updated_at: MODIFIED,
      },
    ],
    materialExceptions: [],
    effectExceptions: [],
    leads: [
      {
        lead_id: "LEAD-A",
        tenant_id: "ironwrap",
        source_envelope_id: "lead_a",
        source_raw_key: "raw/lead-a.json",
        source: "website",
        contact_name: "Pat Prospect",
        contact_phone: "+14035559999",
        contact_email: "pat@example.com",
        job_ref: "JOB-A",
        lifecycle_status: "untriaged",
        version: 1,
        created_at: "2026-07-10T10:00:00.000Z",
        updated_at: MODIFIED,
      },
    ],
    quotes: [],
    accountingIntents: [],
    accountingReconciliations: [],
    accountingExceptions: [],
    workPackages: [nativeWorkPackageRow()],
    workPackageEvents: [],
    fieldEvidence: [],
    ...nativeOverrides,
  };
  const authorityReadbacks = nativeRows.workPackages.flatMap((row) => {
    const definition = JSON.parse(String(row.definition_json)) as Record<
      string,
      unknown
    >;
    return Array.isArray(definition.authority_requirements)
      ? definition.authority_requirements.map((requirement, index) =>
          nativeAuthorityReadback(
            requirement as Record<string, unknown>,
            authorityReadbacksIndex(row, index),
          ),
        )
      : [];
  });
  return {
    ERPNEXT_BASE_URL: "https://frappe.example.com",
    ERPNEXT_API_KEY: "read-key",
    ERPNEXT_API_SECRET: "read-secret",
    APP_TIME_ZONE: "America/Edmonton",
    DB: {
      prepare(sql: string) {
        return {
          bind(...ids: unknown[]) {
            return {
              ...(sql.includes("FROM tenant_company_profiles")
                ? {
                    first: async () =>
                      companyProfileRow?.tenant_id === ids[0]
                        ? companyProfileRow
                        : null,
                  }
                : sql.includes("FROM authority_record_readbacks")
                ? {
                    first: async () =>
                      authorityReadbacks.find(
                        (row) =>
                          row.tenant_id === ids[0] &&
                          row.readback_id === ids[1],
                      ) ?? null,
                  }
                : sql.includes("FROM work_packages") &&
                    sql.includes("work_package_id = ?") &&
                    !sql.includes("SELECT version")
                  ? {
                      first: async () =>
                        nativeRows.workPackages.find(
                          (row) =>
                            row.tenant_id === ids[0] &&
                            row.work_package_id === ids[1] &&
                            row.version === ids[2],
                        ) ?? null,
                    }
                  : {}),
              all: async () => {
                if (sql.includes("FROM authority_record_readbacks")) {
                  const tenantRows = authorityReadbacks.filter(
                    (row) => row.tenant_id === ids[0],
                  );
                  if (sql.includes("AND subject_type = ?")) {
                    return {
                      results: tenantRows.filter(
                        (row) =>
                          row.subject_type === ids[1] &&
                          row.person_user === ids[2] &&
                          row.authority_kind === ids[3] &&
                          row.scope_type === ids[4] &&
                          row.scope_ref === ids[5],
                      ),
                    };
                  }
                  if (sql.includes("AND supersedes_authority_record_id = ?")) {
                    return {
                      results: tenantRows.filter(
                        (row) => row.supersedes_authority_record_id === ids[1],
                      ),
                    };
                  }
                  if (sql.includes("AND authority_record_id = ?")) {
                    return {
                      results: tenantRows.filter(
                        (row) => row.authority_record_id === ids[1],
                      ),
                    };
                  }
                  if (sql.includes("AND issuer_reference = ?")) {
                    return {
                      results: tenantRows.filter(
                        (row) =>
                          row.subject_type === ids[2] &&
                          row.subject_role === ids[4] &&
                          row.person_user === ids[6] &&
                          row.organization === ids[8] &&
                          row.authority_kind === ids[10] &&
                          row.authority_scope === ids[12] &&
                          row.scope_type === ids[14] &&
                          row.scope_ref === ids[16] &&
                          row.roof_job === ids[18] &&
                          row.scope_json === ids[20] &&
                          row.issuer_reference === ids[21] &&
                          row.issuer_source_version === ids[22] &&
                          row.issuer_jurisdiction === ids[23],
                      ),
                    };
                  }
                  return { results: [] };
                }
                if (
                  sql.includes("FROM operating_roof_jobs") &&
                  sql.includes("job_status IN ('qualified', 'in_progress')")
                ) {
                  return { results: nativeRows.jobs };
                }
                if (sql.includes("FROM operating_roof_jobs")) {
                  return {
                    results: nativeRows.jobs.filter(
                      (row) => row.roof_job_id === ids[1],
                    ),
                  };
                }
                if (sql.includes("FROM operating_customers")) {
                  return {
                    results: nativeRows.customers.filter(
                      (row) => row.customer_id === ids[1],
                    ),
                  };
                }
                if (
                  sql.includes("FROM operating_properties") &&
                  sql.includes("property_id IN")
                ) {
                  return { results: nativeRows.properties };
                }
                if (sql.includes("FROM operating_properties")) {
                  return {
                    results: nativeRows.properties.filter(
                      (row) => row.property_id === ids[1],
                    ),
                  };
                }
                if (sql.includes("FROM operating_production_gates")) {
                  const jobIds = new Set(
                    ids.filter(
                      (value): value is string =>
                        typeof value === "string" &&
                        nativeRows.jobs.some(
                          (row) => row.roof_job_id === value,
                        ),
                    ),
                  );
                  const gates = nativeRows.gates.filter((row) =>
                    jobIds.has(String(row.roof_job_id)),
                  );
                  return {
                    results: sql.includes("AND state = ?")
                      ? gates.filter((row) => row.state === "blocked")
                      : gates,
                  };
                }
                if (sql.includes("FROM operating_job_assignments current")) {
                  const hasRoofJobFilter = sql.includes(
                    "current.roof_job_id = ?",
                  );
                  const actorIds = ids
                    .slice(hasRoofJobFilter ? 2 : 1)
                    .filter(
                      (value): value is string => typeof value === "string",
                    )
                    .map((value) => value.toLowerCase());
                  const jobRows = hasRoofJobFilter
                    ? nativeRows.assignments.filter(
                        (row) => row.roof_job_id === ids[1],
                      )
                    : nativeRows.assignments;
                  return {
                    results: sql.includes("json_each")
                      ? jobRows.filter((row) =>
                          JSON.parse(String(row.assigned_users_json)).some(
                            (user: string) =>
                              actorIds.includes(user.toLowerCase()),
                          ),
                        )
                      : jobRows,
                  };
                }
                if (
                  sql.includes("FROM operating_work_object_assignments current")
                ) {
                  const hasScope = sql.includes("current.work_object_type = ?");
                  const scopeRows = hasScope
                    ? nativeRows.typedAssignments.filter(
                        (row) =>
                          row.work_object_type === ids[1] &&
                          row.work_object_id === ids[2] &&
                          row.physical_context_type === ids[3] &&
                          row.physical_context_id === ids[4],
                      )
                    : nativeRows.typedAssignments;
                  const actorIds = ids
                    .slice(hasScope ? 5 : 1)
                    .filter(
                      (value): value is string => typeof value === "string",
                    )
                    .map((value) => value.toLowerCase());
                  return {
                    results: sql.includes("json_each")
                      ? scopeRows.filter((row) =>
                          JSON.parse(String(row.assigned_users_json)).some(
                            (user: string) =>
                              actorIds.includes(user.toLowerCase()),
                          ),
                        )
                      : scopeRows,
                  };
                }
                if (sql.includes("FROM fleet_crews")) {
                  return { results: nativeRows.crews };
                }
                if (sql.includes("FROM inventory_exceptions")) {
                  return { results: nativeRows.materialExceptions };
                }
                if (sql.includes("FROM external_effect_exceptions")) {
                  return { results: nativeRows.effectExceptions };
                }
                if (sql.includes("FROM operating_leads")) {
                  return { results: nativeRows.leads };
                }
                if (sql.includes("FROM commercial_quote_revisions")) {
                  return { results: nativeRows.quotes };
                }
                if (sql.includes("FROM accounting_reconciliations")) {
                  return { results: nativeRows.accountingReconciliations };
                }
                if (sql.includes("FROM accounting_exceptions")) {
                  return { results: nativeRows.accountingExceptions };
                }
                if (sql.includes("FROM accounting_intents")) {
                  return { results: nativeRows.accountingIntents };
                }
                if (
                  sql.includes("FROM work_packages AS package") &&
                  sql.includes("LEFT JOIN work_package_events AS stopped")
                ) {
                  const selectedJobs = new Set(
                    ids
                      .slice(1, -1)
                      .filter(
                        (value): value is string => typeof value === "string",
                      ),
                  );
                  return {
                    results: nativeRows.workPackages
                      .filter(
                        (row) =>
                          row.tenant_id === ids[0] &&
                          row.status === "Blocked" &&
                          selectedJobs.has(String(row.job_id)),
                      )
                      .map((row) => {
                        const stopped = nativeRows.workPackageEvents
                          .filter(
                            (event) =>
                              event.tenant_id === row.tenant_id &&
                              event.work_package_id === row.work_package_id &&
                              event.work_package_version === row.version &&
                              event.event_kind === "stop_work",
                          )
                          .sort(
                            (left, right) =>
                              String(right.occurred_at).localeCompare(
                                String(left.occurred_at),
                              ) ||
                              String(right.event_id).localeCompare(
                                String(left.event_id),
                              ),
                          )[0];
                        const payload = stopped
                          ? (JSON.parse(String(stopped.payload_json)) as Record<
                              string,
                              unknown
                            >)
                          : {};
                        return {
                          work_package_id: row.work_package_id,
                          version: row.version,
                          job_id: row.job_id,
                          stop_event_id: stopped?.event_id ?? null,
                          blocker_reason: payload.blocker_reason ?? null,
                          occurred_at: stopped?.occurred_at ?? null,
                          manifest_key: stopped?.manifest_key ?? null,
                          updated_at: row.updated_at,
                        };
                      }),
                  };
                }
                if (sql.includes("FROM work_packages")) {
                  if (
                    sql.includes("SELECT version") &&
                    sql.includes("work_package_id = ?")
                  ) {
                    return {
                      results: nativeRows.workPackages
                        .filter(
                          (row) =>
                            row.tenant_id === ids[0] &&
                            row.work_package_id === ids[1],
                        )
                        .sort(
                          (left, right) =>
                            Number(right.version) - Number(left.version),
                        )
                        .slice(0, 2)
                        .map((row) => ({ version: row.version })),
                    };
                  }
                  return {
                    results: sql.includes("work_package_id = ?")
                      ? nativeRows.workPackages.filter(
                          (row) =>
                            row.tenant_id === ids[0] &&
                            row.work_package_id === ids[1] &&
                            row.version === ids[2],
                        )
                      : nativeRows.workPackages
                          .filter(
                            (row) =>
                              row.tenant_id === ids[0] &&
                              row.job_id === ids[1] &&
                              row.assignment_id === ids[2] &&
                              [
                                "Released",
                                "Acknowledged",
                                "In Progress",
                              ].includes(String(row.status)),
                          )
                          .sort(
                            (left, right) =>
                              Number(right.version) - Number(left.version),
                          )
                          .slice(0, 2),
                  };
                }
                if (sql.includes("FROM work_package_events")) {
                  return {
                    results: nativeRows.workPackageEvents.filter(
                      (row) =>
                        row.tenant_id === ids[0] &&
                        row.work_package_id === ids[1] &&
                        row.work_package_version === ids[2],
                    ),
                  };
                }
                if (sql.includes("FROM field_actions a")) {
                  return {
                    results: nativeRows.fieldEvidence.filter(
                      (row) =>
                        (row.tenant_id === undefined ||
                          row.tenant_id === ids[0]) &&
                        (row.job_id === undefined || row.job_id === ids[1]) &&
                        (row.assignment_id === undefined ||
                          row.assignment_id === ids[2]) &&
                        row.work_package_id === ids[3] &&
                        row.work_package_version === ids[4] &&
                        row.work_package_release_attempt_id === ids[5] &&
                        row.work_object_type === ids[6] &&
                        row.work_object_id === ids[7] &&
                        row.physical_context_type === ids[8] &&
                        row.physical_context_id === ids[9] &&
                        (row.status === undefined ||
                          row.status === "verified") &&
                        (row.manifest_key === undefined ||
                          Boolean(row.manifest_key)) &&
                        (row.r2_stored_at === undefined ||
                          Boolean(row.r2_stored_at)),
                    ),
                  };
                }
                if (sql.includes("FROM envelopes")) {
                  return {
                    results: ids
                      .map((id) =>
                        id === "lead_a"
                          ? {
                              envelope_id: "lead_a",
                              received_at: "2026-07-10T10:00:00.000Z",
                              bus_status: "pushed",
                            }
                          : null,
                      )
                      .filter(Boolean),
                  };
                }
                if (sql.includes("FROM lead_ack_receipts")) {
                  return {
                    results: ids
                      .map((id) =>
                        id === "lead_a"
                          ? {
                              receipt_id: "ack_1",
                              envelope_id: "lead_a",
                              channel: "email",
                              outcome: "provider_accepted",
                              observed_at: "2026-07-10T10:00:30.000Z",
                              provider_message_id: "gmail-1",
                              error_code: null,
                              created_at: "2026-07-10T10:00:30.000Z",
                            }
                          : null,
                      )
                      .filter(Boolean),
                  };
                }
                return { results: [] };
              },
            };
          },
        };
      },
    },
  } as never;
}

function savedCompanyProfile(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    tenant_id: "ironwrap",
    profile_version: 1,
    company_name: "IronWrap Exteriors",
    brand_name: "IronWrap",
    service_area: "Calgary",
    phone: "+1 (780) 555-0134",
    email: "office@ironwrap.example",
    website: "",
    address_line1: "",
    address_line2: "",
    city: "",
    region: "",
    postal_code: "",
    country: "Canada",
    brand_labels_json: "{}",
    time_zone: "America/Edmonton",
    currency: "CAD",
    week_start: "monday",
    logo_ref: null,
    logo_content_type: null,
    logo_byte_size: null,
    logo_version: null,
    logo_updated_at: null,
    updated_at: MODIFIED,
    updated_by_user_id: "appu_owner",
    ...overrides,
  };
}

function authorityReadbacksIndex(
  workPackage: Record<string, unknown>,
  requirementIndex: number,
): number {
  const value = `${String(workPackage.work_package_id)}:${requirementIndex}`;
  let hash = 0;
  for (const character of value) {
    hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  }
  return hash;
}

function envWithNativeJobPacket(
  overrides: {
    operatingJobs?: Array<Record<string, unknown>>;
    operatingCustomers?: Array<Record<string, unknown>>;
    operatingProperties?: Array<Record<string, unknown>>;
    fieldEvidence?: Array<Record<string, unknown>>;
  } = {},
): AppEnv {
  return env({
    ...(overrides.operatingJobs ? { jobs: overrides.operatingJobs } : {}),
    ...(overrides.operatingCustomers
      ? { customers: overrides.operatingCustomers }
      : {}),
    ...(overrides.operatingProperties
      ? { properties: overrides.operatingProperties }
      : {}),
    ...(overrides.fieldEvidence
      ? { fieldEvidence: overrides.fieldEvidence }
      : {}),
  });
}

type NativeSalesSource =
  | "leads"
  | "jobs"
  | "estimates"
  | "consents"
  | "triageDecisions"
  | "quotes"
  | "proposals"
  | "publications"
  | "acceptances";

function nativeSalesEnv(
  overrides: Partial<
    Record<NativeSalesSource, Array<Record<string, unknown>>>
  > = {},
): AppEnv {
  const rows: Record<NativeSalesSource, Array<Record<string, unknown>>> = {
    leads: [
      {
        lead_id: "LEAD-A",
        tenant_id: "ironwrap",
        source_envelope_id: "lead_a",
        source_raw_key: "raw/lead-a.json",
        source: "website",
        contact_name: "Pat Prospect",
        contact_phone: "+14035559999",
        contact_email: "pat@example.com",
        job_ref: "JOB-A",
        lifecycle_status: "untriaged",
        version: 1,
        created_at: "2026-07-10T10:00:00.000Z",
        updated_at: MODIFIED,
      },
    ],
    jobs: [
      {
        roof_job_id: "JOB-A",
        tenant_id: "ironwrap",
        lead_id: "LEAD-A",
        customer_id: "CUSTOMER-A",
        job_number: "IW-1001",
        service_type: "Roofing",
        job_status: "in_progress",
        version: 1,
        created_at: "2026-07-10T10:00:00.000Z",
        updated_at: MODIFIED,
      },
    ],
    estimates: [
      {
        estimate_session_id: "estimate_a",
        tenant_id: "ironwrap",
        lead_id: "LEAD-A",
        roof_job_id: "JOB-A",
        service_type: "Roofing",
        status: "needs_review",
        range_low_cents: 1_240_000,
        range_high_cents: 1_590_000,
        estimate_total_cents: null,
        confidence: "Preliminary",
        review_required: 1,
        assumptions:
          "Visible slope and access assumptions require verification.",
        exclusions: "Not a final quote or contract.",
        version: 1,
        created_at: "2026-07-10T10:00:00.000Z",
        updated_at: MODIFIED,
      },
    ],
    consents: [
      {
        consent_id: "consent_a",
        tenant_id: "ironwrap",
        lead_id: "LEAD-A",
        customer_id: "CUSTOMER-A",
        roof_job_id: "JOB-A",
        channel: "email",
        purpose: "estimate_follow_up",
        status: "granted",
        jurisdiction: "AB",
        consent_basis: "express",
        recorded_at: MODIFIED,
        created_at: MODIFIED,
      },
    ],
    triageDecisions: [],
    quotes: [
      {
        quote_revision_id: "QUOTE-A",
        tenant_id: "ironwrap",
        customer_quote_id: "quote_a",
        revision_number: 2,
        roof_job_id: "JOB-A",
        customer_id: "CUSTOMER-A",
        status: "needs_review",
        currency: "CAD",
        valid_until: "2026-07-20",
        total_cents: 1_475_000,
        created_at: MODIFIED,
      },
    ],
    proposals: [
      {
        proposal_revision_id: "PROPOSAL-A",
        tenant_id: "ironwrap",
        proposal_pack_id: "pack_a",
        revision_number: 1,
        quote_revision_id: "QUOTE-A",
        roof_job_id: "JOB-A",
        customer_id: "CUSTOMER-A",
        created_at: MODIFIED,
      },
    ],
    publications: [],
    acceptances: [],
    ...overrides,
  };
  const byTable = (sql: string): Array<Record<string, unknown>> => {
    if (sql.includes("FROM operating_leads")) return rows.leads;
    if (sql.includes("FROM operating_roof_jobs")) return rows.jobs;
    if (sql.includes("FROM operating_instant_estimates")) return rows.estimates;
    if (sql.includes("FROM operating_consents")) return rows.consents;
    if (sql.includes("FROM commercial_lead_triage_decisions"))
      return rows.triageDecisions;
    if (sql.includes("FROM commercial_quote_revisions")) return rows.quotes;
    if (sql.includes("FROM commercial_proposal_revisions"))
      return rows.proposals;
    if (sql.includes("FROM commercial_proposal_publication_events"))
      return rows.publications;
    if (sql.includes("FROM commercial_acceptance_bindings"))
      return rows.acceptances;
    return [];
  };
  return {
    ...env(),
    DB: {
      prepare(sql: string) {
        return {
          bind(...ids: unknown[]) {
            return {
              all: async () => {
                if (sql.includes("FROM envelopes")) {
                  return {
                    results:
                      ids[0] === "lead_a"
                        ? [
                            {
                              envelope_id: "lead_a",
                              received_at: "2026-07-10T10:00:00.000Z",
                              bus_status: "pushed",
                            },
                          ]
                        : [],
                  };
                }
                if (sql.includes("FROM lead_ack_receipts"))
                  return { results: [] };
                return { results: byTable(sql) };
              },
            };
          },
        };
      },
    },
  } as never;
}

/**
 * `buildSalesReadModel` takes no clock, so the policy window is compared against the wall clock.
 * A pinned window would therefore stop containing `now` on the day it ends and the desk would
 * quietly lose native triage, so the window is anchored to the run instead of to the calendar.
 */
function envWithCommercialPolicy(): AppEnv {
  const now = Date.now();
  return {
    ...nativeSalesEnv(),
    COMMERCIAL_AUTHORITY_POLICY_JSON: JSON.stringify({
      schema_version: "ironwrap.commercial-authority-policy.v1",
      policy_id: "commercial-sales-autonomy",
      policy_version: "v1",
      tenant_id: "ironwrap",
      status: "active",
      valid_from: new Date(now - 24 * 60 * 60_000).toISOString(),
      valid_until: new Date(now + 24 * 60 * 60_000).toISOString(),
      max_fact_age_seconds: 3600,
      max_permit_lifetime_seconds: 900,
      allowed_actions: ["lead.triage.record"],
      allowed_actor_types: ["owner", "agent", "worker"],
      max_quote_total_cents: 1_000_000_000,
    }),
  } as AppEnv;
}

function installFrappeMock(
  sourceOverrides: Record<string, Array<Record<string, unknown>>> = {},
) {
  const original = globalThis.fetch;
  const requests: Array<{
    doctype: string;
    documentName: string | null;
    fields: string[];
    filters: unknown[];
    offset: number;
    limit: number;
  }> = [];
  globalThis.fetch = async (input) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const parts = url.pathname.split("/");
    const resourceIndex = parts.lastIndexOf("resource");
    const doctype = decodeURIComponent(parts[resourceIndex + 1] ?? "");
    const documentName = parts[resourceIndex + 2]
      ? decodeURIComponent(parts[resourceIndex + 2]!)
      : null;
    const fields = JSON.parse(
      url.searchParams.get("fields") ?? "[]",
    ) as string[];
    const filters = JSON.parse(
      url.searchParams.get("filters") ?? "[]",
    ) as unknown[];
    const offset = Number(url.searchParams.get("limit_start") ?? "0");
    const limit = Number(url.searchParams.get("limit_page_length") ?? "50");
    requests.push({ doctype, documentName, fields, filters, offset, limit });
    const source = sourceOverrides[doctype] ?? rowsFor(doctype);
    if (documentName) {
      const document = source.find((row) => row.name === documentName);
      return document
        ? Response.json({ data: document })
        : new Response(null, { status: 404 });
    }
    const filtered = source.filter((row) =>
      filters.every((filter) => matchFilter(row, filter)),
    );
    const ordered = [...filtered].sort((left, right) => {
      const modified = String(right.modified ?? "").localeCompare(
        String(left.modified ?? ""),
      );
      return (
        modified ||
        String(right.name ?? "").localeCompare(String(left.name ?? ""))
      );
    });
    return Response.json({ data: ordered.slice(offset, offset + limit) });
  };
  return {
    requests,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function rowsFor(doctype: string): Array<Record<string, unknown>> {
  if (doctype === "Roof Job") return jobs;
  if (doctype === "Job Assignment") return assignments;
  if (doctype === "Crew Member")
    return [
      {
        name: "CREW-MEMBER-1",
        parent: "CREW-1",
        parenttype: "Crew Profile",
        parentfield: "members",
        crew_user: "crew@example.com",
        crew_role: "Installer",
        active: 1,
        joined_on: "2026-01-01",
        left_on: null,
        certification_summary: "private",
        notes: "private",
        modified: MODIFIED,
      },
    ];
  if (doctype === "Crew Profile")
    return [
      {
        name: "CREW-1",
        crew_profile_id: "crew-1",
        crew_name: "Northside Metal",
        status: "Active",
        primary_lead: "private@example.com",
        notes: "private",
        modified: MODIFIED,
      },
    ];
  if (doctype === "Roofing Property")
    return jobs.map((row, index) => ({
      name: row.roofing_property,
      address_line1: `${index + 10} Test Ave`,
      city: "Calgary",
      province: "AB",
      postal_code: "T1T 1T1",
      country: "Canada",
      roof_notes: "internal access secret",
      hazard_notes: "internal hazard secret",
      modified: MODIFIED,
    }));
  if (doctype === "Roofing Customer")
    return jobs.map((row, index) => ({
      name: row.customer,
      display_name: `Customer ${index + 1}`,
      phone: `+1403555000${index}`,
      email: `customer${index}@private.example`,
      notes: "internal customer note",
      modified: MODIFIED,
    }));
  if (doctype === "Production Gate State")
    return [
      {
        name: "GATE-A",
        gate_id: "gate_a",
        roof_job: "JOB-A",
        gate: "Materials",
        state: "Blocked",
        owner_user: "office-owner@example.com",
        due_at: "2026-07-11 12:00:00",
        blocker_reason: "Delivery not confirmed",
        modified: MODIFIED,
      },
    ];
  if (doctype === "Evidence Item") return proofRows;
  if (doctype === "Field Check-in")
    return [
      {
        name: "CHECKIN-BLOCKED",
        checkin_id: "checkin_blocked",
        roof_job: "JOB-A",
        status: "Received",
        sync_state: "Verified",
        blocker_flag: 1,
        blocker_category: "Weather",
        blocker_summary: "Wind exceeds the site plan limit.",
        submitted_at: "2026-07-10 10:05:00",
        modified: MODIFIED,
      },
      {
        name: "CHECKIN-RESOLVED",
        checkin_id: "checkin_resolved",
        roof_job: "JOB-B",
        status: "Resolved",
        sync_state: "Verified",
        blocker_flag: 1,
        blocker_category: "Materials",
        blocker_summary: "Historical shortage already resolved.",
        submitted_at: "2026-07-09 10:05:00",
        modified: MODIFIED,
      },
    ];
  if (doctype === "Scope Clause")
    return [
      {
        name: "SCOPE-A",
        scope_clause_id: "scope_a",
        roof_job: "JOB-A",
        clause_type: "Included",
        title: "Approved roof scope",
        clause_text: "Install approved system",
        version: "1",
        status: "Approved",
        customer_visible: 1,
        notes: "internal",
        modified: MODIFIED,
      },
    ];
  if (doctype === "Measurement Report")
    return [
      {
        name: "MEASURE-A",
        measurement_id: "measure_a",
        roof_job: "JOB-A",
        provider: "RoofRuler",
        review_status: "Approved",
        parsed_at: MODIFIED,
        report_url: "private",
        modified: MODIFIED,
      },
    ];
  if (doctype === "Material Takeoff")
    return [
      {
        name: "TAKEOFF-A",
        takeoff_id: "takeoff_a",
        roof_job: "JOB-A",
        status: "Approved",
        prepared_at: MODIFIED,
        assumptions: "internal pricing assumption",
        exclusions: "internal exclusion",
        modified: MODIFIED,
      },
    ];
  if (doctype === "Supplier Order")
    return [
      {
        name: "ORDER-A",
        supplier_order_id: "order_a",
        roof_job: "JOB-A",
        status: "Ordered",
        requested_delivery_date: "2026-07-12",
        delivery_notes: "Deliver to rear",
        order_summary_json: "financial",
        modified: MODIFIED,
      },
      {
        name: "ORDER-SHORT",
        supplier_order_id: "order_short",
        roof_job: "JOB-B",
        status: "Shortage",
        requested_delivery_date: "2026-07-11",
        delivery_notes: "Starter stock is short",
        modified: MODIFIED,
      },
    ];
  if (doctype === "Automation Incident")
    return [
      {
        name: "INCIDENT-A",
        incident_id: "incident_a",
        status: "Open",
        severity: "High",
        category: "Frappe delivery",
        summary: "Frappe mirror needs review",
        roof_job: "JOB-A",
        modified: MODIFIED,
      },
    ];
  if (doctype === "Payment Milestone")
    return [
      {
        name: "PAYMENT-A",
        payment_milestone_id: "payment_a",
        roof_job: "JOB-A",
        milestone_type: "Deposit",
        status: "Needs Review",
        due_date: "2026-07-11",
        notes: "Deposit receipt needs review",
        modified: MODIFIED,
      },
    ];
  if (doctype === "Lead Envelope")
    return [
      {
        name: "LEAD-A",
        envelope_id: "lead_a",
        status: "received",
        source: "website",
        event_ts: "2026-07-10T10:00:00.000Z",
        intent_queue: "Estimator",
        triage_status: "Untriaged",
        triage_summary:
          "Hail repair inquiry, confirm site details before a final scope.",
        contact_name: "Pat Prospect",
        contact_phone: "+14035559999",
        contact_email: "pat@example.com",
        job_ref: "JOB-A",
        payload_json: "raw-intake-secret",
        raw_key: "r2-private-key",
        modified: MODIFIED,
      },
    ];
  if (doctype === "Instant Estimate Session")
    return [
      {
        name: "ESTIMATE-A",
        estimate_session_id: "estimate_a",
        lead_envelope: "LEAD-A",
        roof_job: "JOB-A",
        source: "website",
        service_type: "Roofing",
        status: "Needs Review",
        range_low: 12_400,
        range_high: 15_900,
        estimate_total: null,
        confidence: "Preliminary",
        review_required: 1,
        reviewed_at: null,
        approved_at: null,
        assumptions:
          "Visible slope and access assumptions require verification.",
        exclusions: "Not a final quote or contract.",
        payload_json: "private-estimate-json",
        modified: MODIFIED,
      },
    ];
  if (doctype === "Customer Quote")
    return [
      {
        name: "QUOTE-A",
        customer_quote_id: "quote_a",
        roof_job: "JOB-A",
        quote_version: 2,
        status: "Needs Review",
        quote_total: 14_750,
        currency: "CAD",
        valid_until: "2026-07-20",
        payment_status: "Not Due",
        prepared_at: MODIFIED,
        approved_at: null,
        accepted_at: null,
        scope_summary: "Replace affected roof system.",
        tax_policy_snapshot_json: "private-tax-policy",
        modified: MODIFIED,
      },
    ];
  if (doctype === "Proposal Evidence Pack")
    return [
      {
        name: "PROPOSAL-A",
        pack_id: "pack_a",
        roof_job: "JOB-A",
        quotation: "QUOTE-A",
        status: "Draft",
        prepared_at: MODIFIED,
        approved_at: null,
        signed_at: null,
        evidence_summary_json: "private-proposal-summary",
        modified: MODIFIED,
      },
    ];
  if (doctype === "Communication Consent")
    return [
      {
        name: "CONSENT-A",
        consent_id: "consent_a",
        customer: "CUSTOMER-A",
        lead_envelope: "LEAD-A",
        roof_job: "JOB-A",
        channel: "Email",
        purpose: "Estimate Follow-up",
        status: "Granted",
        jurisdiction: "AB",
        consent_basis: "Express",
        captured_at: MODIFIED,
        effective_from: MODIFIED,
        expires_at: null,
        revoked_at: null,
        supersedes: null,
        source_reference: "private-form-reference",
        notes: "private-consent-note",
        modified: MODIFIED,
      },
    ];
  if (doctype === "Change Order")
    return [
      {
        name: "CHANGE-A",
        change_order_id: "change_a",
        roof_job: "JOB-A",
        change_number: "CO-1",
        version: 1,
        status: "Accepted",
        title: "Deck repair",
        scope_delta: "Replace damaged deck",
        currency: "CAD",
        total_amount: 50_000,
        notes: "internal",
        modified: MODIFIED,
      },
    ];
  if (doctype === "Safety Plan")
    return [
      {
        name: "SAFETY-A",
        safety_plan_id: "safety_a",
        roof_job: "JOB-A",
        version: 1,
        status: "Ready",
        effective_date: "2026-07-10",
        hazard_summary: "Steep slope",
        controls: "Tie off",
        emergency_plan: "Call 911",
        ppe_requirements: "Harness",
        weather_limits: "Stop in lightning",
        notes: "internal",
        modified: MODIFIED,
      },
    ];
  if (doctype === "Work Package")
    return [
      {
        name: "WORK-PACKAGE-A",
        work_package_id: "work_package_a",
        roof_job: "JOB-A",
        job_assignment: "ASSIGN-A",
        version: 1,
        status: "Released",
        title: "South roof replacement",
        objective: "Install the released metal system.",
        boundaries: "South roof only.",
        prerequisites: "Verify tie-off and material staging.",
        expected_result: "Released roof section complete.",
        stop_conditions: "Stop for unsafe weather or missing controls.",
        make_safe_procedure: "Secure the work area and notify the supervisor.",
        issued_at: "2026-07-10T07:00:00.000Z",
        expires_at: "2026-07-11T07:00:00.000Z",
        released_at: "2026-07-10T07:05:00.000Z",
        release_attempt_id: null,
        supersedes: null,
        correction_reason: null,
        acknowledged_by: null,
        acknowledged_at: null,
        assigned_workers: [
          {
            sequence: 1,
            worker_user: "crew@example.com",
            worker_role: "Installer",
            required: 1,
          },
        ],
        steps: [
          {
            sequence: 1,
            instruction: "Verify the roof zone.",
            required_evidence: "Zone photo",
            acceptance_criteria: "Zone matches package.",
          },
        ],
        hold_points: [
          {
            sequence: 1,
            hold_point: "Deck condition",
            release_authority: "Supervisor",
            required_evidence: "Deck photo",
            acceptance_criteria: "Supervisor release.",
          },
        ],
        released_by: "private-release@example.com",
        blocker_reason: "private blocker",
        raw_key: "r2/private",
        modified: MODIFIED,
      },
    ];
  return [];
}

function matchFilter(row: Record<string, unknown>, raw: unknown): boolean {
  if (!Array.isArray(raw)) return false;
  const [, field, operator, expected] = raw;
  const actual = row[String(field)];
  if (operator === "=") return String(actual ?? "") === String(expected ?? "");
  if (operator === "in" && Array.isArray(expected))
    return expected.map(String).includes(String(actual ?? ""));
  return false;
}

test("field Today uses direct and active crew membership assignments, never generic _assign", async () => {
  const mock = installFrappeMock();
  try {
    const model = await buildTodayReadModel(
      env(),
      auth("field", "crew@example.com"),
    );
    assert.deepEqual(
      model.jobs.map((item) => item.id),
      ["JOB-A", "JOB-B"],
    );
    assert.equal(model.jobs[0]?.assignment?.id, "ASSIGN-A");
    assert.equal(model.jobs[1]?.assignment?.crew_profile, "CREW-1");
    assert.equal(
      mock.requests.some((request) =>
        request.filters.some(
          (filter) => Array.isArray(filter) && filter[1] === "_assign",
        ),
      ),
      false,
    );
    assert.equal(
      FRAPPE_READ_FIELDS["Roof Job"].includes("_assign" as never),
      false,
    );
  } finally {
    mock.restore();
  }
});

test("job assignment authority is native, tenant-scoped, and actor-scoped", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("Frappe must not be consulted for assignment authority");
  };
  try {
    const fieldAssignment = await activeAssignmentForJob(
      env(),
      auth("field", "crew@example.com"),
      "JOB-A",
    );
    assert.equal(fieldAssignment?.name, "ASSIGN-A");
    assert.equal(fieldAssignment?.source_system, "ironwrap-d1");
    assert.equal(
      await activeAssignmentForJob(
        env(),
        auth("field", "unassigned@example.com"),
        "JOB-A",
      ),
      null,
    );
    assert.equal(
      (
        await activeAssignmentForJob(
          env(),
          auth("ops", "ops@example.com"),
          "JOB-A",
        )
      )?.name,
      "ASSIGN-A",
    );
    assert.equal(
      await activeAssignmentForJob(
        { ...env(), APP_TENANT_ID: "another-tenant" },
        auth("ops", "ops@example.com"),
        "JOB-A",
      ),
      null,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("typed Shop Order packet is served through the universal BFF route without a Roof Job", async () => {
  const shopPackage = nativeWorkPackageRow({
    work_package_id: "work_package_shop_1",
    job_id: "SHOP-001",
    assignment_id: "ASSIGN-SHOP-1",
    work_object_type: "Shop Order",
    work_object_id: "SHOP-001",
    physical_context_type: "Shop Floor",
    physical_context_id: "SHOP-FLOOR-1",
    release_attempt_id: "shop-release-attempt-1",
    assignment_authority_user: "appu_owner",
    assignment_authority_role: "IronWrap Owner",
    definition_json: JSON.stringify({
      assigned_workers: [
        {
          sequence: 1,
          worker_user: "appu_field",
          worker_role: "Installer",
          required: true,
        },
      ],
      steps: [
        {
          sequence: 1,
          instruction: "Verify the shop order zone.",
          required_evidence: "Zone photo",
          acceptance_criteria: "Zone matches package.",
        },
      ],
      hold_points: [
        {
          sequence: 1,
          hold_point: "Anchor condition",
          release_phase: "Pre-start",
          release_authority: "Supervisor",
          required_evidence: "Anchor photo",
          acceptance_criteria: "Supervisor release.",
        },
      ],
    }),
  });
  const mock = installFrappeMock({});
  try {
    const response = await handleAuthenticatedRoute(
      new Request(
        "https://app.example.com/api/v1/work-objects/Shop%20Order/SHOP-001/physical-contexts/Shop%20Floor/SHOP-FLOOR-1",
      ),
      env(
        {
          typedAssignments: [nativeTypedAssignment()],
          workPackages: [shopPackage],
        },
        savedCompanyProfile(),
      ),
      auth("field", "crew@example.com"),
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const body = (await response.json()) as {
      version: number;
      source_updated_at: string;
      read_model_generated_at: string;
      stale_fields: string[];
      permissions: string[];
      work_object: Record<string, string>;
      assignment: { id: string };
      work_package: {
        id: string;
        work_object_type: string;
        physical_context_type: string;
      };
      allowed_actions: string[];
    };
    assert.equal(body.version, 1);
    assert.equal(body.source_updated_at, MODIFIED);
    // The claim is "this is an ISO instant", not "this century", so assert the whole shape rather
    // than a `20\d\d` prefix that stops matching the day the clock leaves the 2000s.
    assert.match(
      body.read_model_generated_at,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    assert.deepEqual(body.stale_fields, []);
    assert.deepEqual((body as typeof body & { office_contact: unknown }).office_contact, {
      phone: "+17805550134",
      email: "office@ironwrap.example",
    });
    assert.equal(body.permissions.includes("jobs:read:assigned"), true);
    assert.deepEqual(body.work_object, {
      workObjectType: "Shop Order",
      workObjectId: "SHOP-001",
      physicalContextType: "Shop Floor",
      physicalContextId: "SHOP-FLOOR-1",
    });
    assert.equal(body.assignment.id, "ASSIGN-SHOP-1");
    assert.equal(body.work_package.id, "work_package_shop_1");
    assert.equal(body.work_package.work_object_type, "Shop Order");
    assert.equal(body.work_package.physical_context_type, "Shop Floor");
    assert.equal(body.allowed_actions.includes("field.checkin.create"), true);
    assert.equal(
      body.allowed_actions.includes("work_package.acknowledge"),
      true,
    );
    // With no blocker, the crew's Today row names the job plan as the next step.
    const today = await buildTodayReadModel(
      env({ typedAssignments: [nativeTypedAssignment()] }),
      auth("field", "crew@example.com"),
    );
    assert.deepEqual(
      today.work_objects.map(({ work_object_id, next_action }) => ({
        work_object_id,
        next_action,
      })),
      [{ work_object_id: "SHOP-001", next_action: "See job plan" }],
    );
    const degradedEnv = env({
      typedAssignments: [nativeTypedAssignment()],
      workPackages: [shopPackage],
    });
    const realDb = degradedEnv.DB;
    degradedEnv.DB = {
      ...realDb,
      prepare(sql: string) {
        if (
          sql.includes("a.measurement_area_label") &&
          sql.includes("ORDER BY a.created_at DESC")
        )
          throw new Error("field_measurement_storage_mismatch");
        return realDb.prepare(sql);
      },
    } as never;
    const degradedResponse = await handleAuthenticatedRoute(
      new Request(
        "https://app.example.com/api/v1/work-objects/Shop%20Order/SHOP-001/physical-contexts/Shop%20Floor/SHOP-FLOOR-1",
      ),
      degradedEnv,
      auth("field", "crew@example.com"),
    );
    assert.equal(degradedResponse.status, 200);
    const degraded = (await degradedResponse.json()) as {
      stale_fields: string[];
      field_measurements: unknown[];
      field_measurements_more: boolean;
    };
    assert.ok(
      degraded.stale_fields.includes("field_measurements.native_unavailable"),
    );
    assert.deepEqual(degraded.field_measurements, []);
    assert.equal(degraded.field_measurements_more, false);
    assert.equal(
      mock.requests.some((request) => request.resource === "Job Assignment"),
      false,
      "typed assignment authority must not consult Frappe",
    );
  } finally {
    mock.restore();
  }
});

test("crew job keeps customer and public office contact separate", async () => {
  const mock = installFrappeMock({});
  try {
    const crew = auth("field", "crew@example.com");
    const saved = await buildJobReadModel(
      env({}, savedCompanyProfile()),
      crew,
      "JOB-A",
    );
    assert.deepEqual(saved?.office_contact, {
      phone: "+17805550134",
      email: "office@ironwrap.example",
    });
    assert.equal(saved?.packet.contact?.phone, "+14035550000");
    const jobResponse = await handleAuthenticatedRoute(
      new Request("https://app.example.com/api/v1/jobs/JOB-A"),
      env({}, savedCompanyProfile()),
      crew,
    );
    assert.equal(jobResponse.status, 200);
    assert.equal(jobResponse.headers.get("cache-control"), "private, no-store");

    const unsaved = await buildJobReadModel(env(), crew, "JOB-A");
    assert.equal(unsaved?.office_contact, null);
    assert.equal(unsaved?.stale_fields.includes("office_contact.unavailable"), false);

    const base = env();
    const profileUnavailable = {
      ...base,
      DB: {
        ...base.DB,
        prepare(sql: string) {
          if (sql.includes("FROM tenant_company_profiles")) {
            throw new Error("company_profile_unavailable");
          }
          return base.DB.prepare(sql);
        },
      },
    } as AppEnv;
    const degraded = await buildJobReadModel(profileUnavailable, crew, "JOB-A");
    assert.equal(degraded?.office_contact, null);
    assert.equal(degraded?.stale_fields.includes("office_contact.unavailable"), true);
    assert.equal(degraded?.packet.work_package?.id, saved?.packet.work_package?.id);

    const withheld = await buildJobReadModel(
      env({}, savedCompanyProfile({ phone: "403-555-0100 ext 12", email: "" })),
      crew,
      "JOB-A",
    );
    assert.equal(withheld?.office_contact, null);

    const otherTenant = await buildJobReadModel(
      env({}, savedCompanyProfile({ tenant_id: "other-tenant" })),
      crew,
      "JOB-A",
    );
    assert.equal(otherTenant?.office_contact, null);
  } finally {
    mock.restore();
  }
});

test("field read model fails closed on corrupt or unavailable current authority", async (t) => {
  await t.test("corrupt frozen requirements", async () => {
    const definition = JSON.parse(
      String(nativeWorkPackageRow().definition_json),
    ) as Record<string, unknown>;
    definition.authority_requirements = null;
    const model = await buildJobReadModel(
      env({
        workPackages: [
          nativeWorkPackageRow({
            definition_json: JSON.stringify(definition),
          }),
        ],
      }),
      auth("field", "crew@example.com"),
      "JOB-A",
    );
    assert.deepEqual(model?.packet.work_package?.authority_denials, [
      "authority_unverifiable",
    ]);
    assert.equal(
      model?.allowed_actions.includes("work_package.acknowledge"),
      false,
    );
    assert.equal(
      model?.allowed_actions.includes("work_package.stop_work"),
      true,
    );
  });

  await t.test("authority store unavailable", async () => {
    const base = env();
    const nativeDb = base.DB;
    const unavailable = {
      ...base,
      DB: {
        prepare(sql: string) {
          if (sql.includes("FROM authority_record_readbacks")) {
            throw new Error("authority_store_unavailable");
          }
          return nativeDb.prepare(sql);
        },
      },
    } as AppEnv;
    const model = await buildJobReadModel(
      unavailable,
      auth("field", "crew@example.com"),
      "JOB-A",
    );
    assert.deepEqual(model?.packet.work_package?.authority_denials, [
      "authority_unavailable",
    ]);
    assert.deepEqual(
      model?.allowed_actions.filter((action) =>
        action.startsWith("work_package."),
      ),
      ["work_package.stop_work"],
    );
  });
});

test("typed completion capability requires the immutable assignment authority and an independent actor", async () => {
  const scope = {
    workObjectType: "Shop Order",
    workObjectId: "SHOP-001",
    physicalContextType: "Shop Floor",
    physicalContextId: "SHOP-FLOOR-1",
  } as const;
  const shopPackage = nativeWorkPackageRow({
    work_package_id: "work_package_shop_1",
    job_id: "SHOP-001",
    assignment_id: "ASSIGN-SHOP-1",
    status: "In Progress",
    work_object_type: scope.workObjectType,
    work_object_id: scope.workObjectId,
    physical_context_type: scope.physicalContextType,
    physical_context_id: scope.physicalContextId,
    release_attempt_id: "shop-release-attempt-1",
    assignment_authority_user: "appu_owner",
    assignment_authority_role: "IronWrap Owner",
    definition_json: JSON.stringify({
      assigned_workers: [
        {
          sequence: 1,
          worker_user: "appu_field",
          worker_role: "Installer",
          required: true,
        },
      ],
      steps: [
        {
          sequence: 1,
          instruction: "Verify the shop order zone.",
          required_evidence: "Zone photo",
          acceptance_criteria: "Zone matches package.",
        },
      ],
      hold_points: [
        {
          sequence: 1,
          hold_point: "Anchor condition",
          release_phase: "Pre-start",
          release_authority: "Supervisor",
          required_evidence: "Deck photo",
          acceptance_criteria: "Supervisor release.",
        },
      ],
    }),
  });
  const eventScope = {
    work_package_id: shopPackage.work_package_id,
    work_package_version: shopPackage.version,
    job_id: "SHOP-001",
    assignment_id: "ASSIGN-SHOP-1",
    work_object_type: scope.workObjectType,
    work_object_id: scope.workObjectId,
    physical_context_type: scope.physicalContextType,
    physical_context_id: scope.physicalContextId,
    release_attempt_id: shopPackage.release_attempt_id,
  };
  const acknowledgement = nativeWorkPackageEvent("acknowledged", {
    ...eventScope,
    event_id: "wpe_acknowledged_shop_1",
    actor_user_id: "appu_field",
    actor_role: "Installer",
    device_action_id: "shop-ack-device-1",
    occurred_at: "2026-07-10T07:10:00.000Z",
  });
  const holdRelease = nativeWorkPackageEvent("hold_released", {
    ...eventScope,
    event_id: "wpe_hold_released_shop_1",
    actor_user_id: "appu_owner",
    actor_role: "IronWrap Owner",
    device_action_id: "shop-hold-device-1",
    occurred_at: "2026-07-10T07:20:00.000Z",
    payload_json: JSON.stringify({
      hold_point_sequence: 1,
      evidence_item: "evi_00000000000000000000000000000003",
    }),
  });
  const fieldEvidence = nativeFieldEvidenceRows(2, {
    tenant_id: "ironwrap",
    job_id: "SHOP-001",
    assignment_id: "ASSIGN-SHOP-1",
    actor_user: "appu_field",
    work_package_id: shopPackage.work_package_id,
    work_package_version: shopPackage.version,
    work_package_release_attempt_id: shopPackage.release_attempt_id,
    work_object_type: scope.workObjectType,
    work_object_id: scope.workObjectId,
    physical_context_type: scope.physicalContextType,
    physical_context_id: scope.physicalContextId,
  });
  Object.assign(fieldEvidence[0]!, {
    evidence_id: "evi_00000000000000000000000000000001",
    evidence_slot_id: "step:1",
    evidence_requirement: "Zone photo",
  });
  Object.assign(fieldEvidence[1]!, {
    evidence_id: "evi_00000000000000000000000000000002",
    evidence_slot_id: "hold:1",
    evidence_requirement: "Deck photo",
  });
  const review = (evidence: Record<string, unknown>, index: number) =>
    nativeWorkPackageEvent("evidence_reviewed", {
      ...eventScope,
      event_id: `wpe_review_shop_${index}`,
      actor_user_id: "appu_owner",
      actor_role: "IronWrap Owner",
      device_action_id: `shop-evidence-review-${index}`,
      occurred_at: `2026-07-10T07:3${index}:30.000Z`,
      payload_json: JSON.stringify({
        target_event_id: `wpe_${String(evidence.evidence_id).slice(4)}`,
        evidence_item: evidence.evidence_id,
        evidence_slot_id: evidence.evidence_slot_id,
        disposition: "Accepted",
        correction_reason: null,
      }),
    });
  const nativeSource = {
    workPackages: [shopPackage],
    workPackageEvents: [
      acknowledgement,
      holdRelease,
      review(fieldEvidence[0]!, 1),
      review(fieldEvidence[1]!, 2),
    ],
    fieldEvidence,
  };
  const mock = installFrappeMock({});
  try {
    const authority = await buildUniversalWorkPackageReadModel(
      env({ ...nativeSource, typedAssignments: [nativeTypedAssignment()] }),
      auth("owner", "authority@example.com"),
      scope,
    );
    assert.equal(
      (authority?.allowed_actions as string[]).includes(
        "work_package.complete",
      ),
      true,
    );
    const dispatcher = auth("owner", "dispatcher@example.com");
    dispatcher.session.user_id = "appu_dispatcher";
    const assigningAuthority = await buildUniversalWorkPackageReadModel(
      env({ ...nativeSource, typedAssignments: [nativeTypedAssignment()] }),
      dispatcher,
      scope,
    );
    assert.equal(
      (assigningAuthority?.allowed_actions as string[]).includes(
        "work_package.complete",
      ),
      false,
      "assigned_by is provenance, not typed completion authority",
    );
    for (const role of ["owner", "ops", "production"] as const) {
      const unrelatedActor = auth(role, `${role}@example.com`);
      unrelatedActor.session.user_id = `appu_unrelated_${role}`;
      const unrelated = await buildUniversalWorkPackageReadModel(
        env({ ...nativeSource, typedAssignments: [nativeTypedAssignment()] }),
        unrelatedActor,
        scope,
      );
      assert.equal(
        (unrelated?.allowed_actions as string[]).includes(
          "work_package.complete",
        ),
        false,
        `${role} must not inherit typed completion from role alone`,
      );
    }
  } finally {
    mock.restore();
  }

  const wrongDeclaredRole = installFrappeMock({});
  try {
    const model = await buildUniversalWorkPackageReadModel(
      env({
        ...nativeSource,
        typedAssignments: [
          nativeTypedAssignment({ authority_role: "production" }),
        ],
      }),
      auth("owner", "authority@example.com"),
      scope,
    );
    assert.equal(
      (model?.allowed_actions as string[]).includes("work_package.complete"),
      false,
      "the declared authority role must match the exact app authority role",
    );
  } finally {
    wrongDeclaredRole.restore();
  }

  const workerAuthority = installFrappeMock({});
  try {
    const worker = auth("owner", "crew@example.com");
    worker.session.user_id = "appu_field";
    const model = await buildUniversalWorkPackageReadModel(
      env({
        ...nativeSource,
        typedAssignments: [
          nativeTypedAssignment({ authority_user_id: "appu_field" }),
        ],
      }),
      worker,
      scope,
    );
    assert.equal(
      (model?.allowed_actions as string[]).includes("work_package.complete"),
      false,
      "the immutable authority must still be independent of the frozen worker roster",
    );
  } finally {
    workerAuthority.restore();
  }
});

test("field bootstrap reads native Today even when Frappe is unavailable", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("frappe unavailable");
  };
  try {
    const response = await handleAuthenticatedRoute(
      new Request("https://app.example.com/api/v1/field/bootstrap"),
      env(),
      auth("field", "crew@example.com"),
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const body = (await response.json()) as {
      today: { jobs: Array<{ id: string }> };
    };
    assert.deepEqual(
      body.today.jobs.map(({ id }) => id),
      ["JOB-A", "JOB-B"],
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("Today bootstrap admits an office role through the same today:read capability", async () => {
  const mock = installFrappeMock();
  try {
    const response = await handleAuthenticatedRoute(
      new Request("https://app.example.com/api/v1/field/bootstrap"),
      env(),
      auth("ops", "ops@example.com"),
    );
    const body = (await response.json()) as {
      session: { user: { role: string } };
      today: { jobs: Array<{ id: string }> };
    };

    assert.equal(response.status, 200);
    assert.equal(body.session.user.role, "ops");
    assert.deepEqual(
      new Set(body.today.jobs.map(({ id }) => id)),
      new Set(["JOB-A", "JOB-B", "JOB-C"]),
    );
  } finally {
    mock.restore();
  }
});

test("field is denied an unassigned job while office reads it and Today does not hide it", async () => {
  const mock = installFrappeMock();
  try {
    assert.equal(
      await buildJobReadModel(
        env(),
        auth("field", "crew@example.com"),
        "JOB-C",
      ),
      null,
    );
    const officeJob = await buildJobReadModel(
      env(),
      auth("ops", "ops@example.com"),
      "JOB-C",
    );
    assert.equal(officeJob?.job.id, "JOB-C");
    assert.equal(officeJob?.assignment, null);
    const officeToday = await buildTodayReadModel(
      env(),
      auth("ops", "ops@example.com"),
    );
    assert.deepEqual(
      new Set(officeToday.jobs.map((item) => item.id)),
      new Set(["JOB-A", "JOB-B", "JOB-C"]),
    );
    assert.equal(
      officeToday.jobs.find((item) => item.id === "JOB-C")?.next_action,
      "Assign field work",
    );
  } finally {
    mock.restore();
  }
});

test("assigned field keeps plain check-in authority before a Work Package exists", async () => {
  const withoutWorkPackage = env({ workPackages: [] });

  const assignedField = await buildJobReadModel(
    withoutWorkPackage,
    auth("field", "crew@example.com"),
    "JOB-A",
  );
  assert.ok(assignedField);
  assert.equal(assignedField.assignment?.id, "ASSIGN-A");
  assert.equal(assignedField.packet.work_package, null);
  assert.equal(
    assignedField.allowed_actions.includes("field.checkin.create"),
    true,
  );

  assert.equal(
    await buildJobReadModel(
      withoutWorkPackage,
      auth("field", "unassigned@example.com"),
      "JOB-A",
    ),
    null,
  );

  const office = await buildJobReadModel(
    withoutWorkPackage,
    auth("ops", "ops@example.com"),
    "JOB-A",
  );
  assert.ok(office);
  assert.equal(office.allowed_actions.includes("field.checkin.create"), false);
});

test("owner Now is an office-only, exception-first roofing read model", async () => {
  const original = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error("owner_now_network_forbidden");
  };
  const reviewIntentId = "acct-intent-owner-review";
  const appEnv = env({
    workPackages: [nativeWorkPackageRow({ status: "Blocked" })],
    workPackageEvents: [
      nativeWorkPackageEvent("stop_work", {
        event_id: "checkin_blocked",
        occurred_at: "2026-07-10T10:05:00.000Z",
        manifest_key: "work-packages/checkin-blocked.json",
        payload_json: JSON.stringify({
          blocker_reason: "Wind exceeds the site plan limit.",
        }),
      }),
    ],
    effectExceptions: [
      {
        exception_id: "incident_failed",
        effect_id: "effect_failed",
        reason_code: "provider_readback_mismatch",
        action: "measurement.pdf.ocr",
        provider: "document-ai",
        aggregate_type: "roof_job",
        aggregate_id: "JOB-A",
        created_at: "2026-07-10T10:06:00.000Z",
        updated_at: "2026-07-10T10:07:00.000Z",
      },
    ],
    accountingIntents: [
      nativeAccountingIntent(reviewIntentId, {
        state: "pending_review",
        provider_entity_type: null,
        provider_entity_id: null,
        provider_submitted_at: null,
        provider_reconciled_at: null,
        reason_code: "owner_review_required",
      }),
    ],
    accountingExceptions: [
      {
        exception_id: "accounting-exception-owner-review",
        subject_ref: `accounting_intent:${reviewIntentId}`,
        intent_id: reviewIntentId,
        reason_code: "expected_observed_mismatch",
        status: "open",
        roof_job_id: "JOB-A",
        opened_at: "2026-07-10T10:08:00.000Z",
        updated_at: "2026-07-10T10:09:00.000Z",
      },
    ],
    materialExceptions: [
      {
        exception_id: "material-shortage-a",
        aggregate_id: "JOB-A",
        exception_type: "shortage",
        status: "open",
        reason_code: "coil_shortage",
        created_at: "2026-07-10T10:10:00.000Z",
        updated_at: "2026-07-10T10:11:00.000Z",
      },
    ],
  });
  try {
    const model = await buildOwnerNowReadModel(
      appEnv,
      auth("owner", "owner@example.com"),
    );
    assert.deepEqual(model.summary, {
      active_jobs: 3,
      field_blockers: 1,
      blocked_gates: 1,
      open_incidents: 1,
      finance_exceptions: 1,
      untriaged_leads: 1,
      lead_triage_unknown: 0,
      mctb_unproven_due: 0,
      material_exceptions: 1,
      economics_needs_review: 3,
    });
    assert.deepEqual(
      model.economics.map((projection) => projection.job_id),
      ["JOB-A", "JOB-B", "JOB-C"],
    );
    assert.ok(
      model.economics.every(
        (projection) => projection.metrics.actual_profit.amount_cents === null,
      ),
    );
    assert.deepEqual(
      model.exceptions.map((exception) => exception.kind),
      [
        "field_blocker",
        "blocked_gate",
        "automation_incident",
        "material_exception",
        "finance_exception",
        "untriaged_lead",
      ],
    );
    assert.deepEqual(model.exceptions[0], {
      id: "checkin_blocked",
      kind: "field_blocker",
      severity: null,
      title: "Field work stopped",
      why: "Wind exceeds the site plan limit.",
      next_action: null,
      job_id: "JOB-A",
      occurred_at: "2026-07-10T10:05:00.000Z",
      due_at: null,
      received_at: null,
      bus_status: null,
      triage_status: null,
      mctb: null,
    });
    assert.deepEqual(model.exceptions[1], {
      id: "gate_job_a_materials",
      kind: "blocked_gate",
      severity: null,
      title: "Materials gate blocked",
      why: "Delivery not confirmed",
      next_action: null,
      job_id: "JOB-A",
      occurred_at: "2026-07-10T09:00:00.000Z",
      due_at: "2026-07-11T12:00:00.000Z",
      received_at: null,
      bus_status: null,
      triage_status: null,
      mctb: null,
    });
    assert.ok(model.stale_fields.includes("exceptions.next_action"));
    assert.ok(model.stale_fields.includes("exceptions.due_at"));
    assert.deepEqual(model.partial_sources, []);
    assert.deepEqual(model.allowed_actions, [
      "job.read",
      "lead.read",
      "lead_triage.read",
      "field_blocker.read",
      "incident.read",
      "finance_exception.read",
      "material_exception.read",
    ]);
    assert.equal(
      networkCalls,
      0,
      "Owner Now must not call Frappe or the network",
    );
    await assert.rejects(
      async () =>
        await buildOwnerNowReadModel(env(), auth("field", "crew@example.com")),
      /owner_scope_required/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("owner Now projects only native, exactly reconciled money and marks unsupported costs unavailable", async () => {
  const original = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error("owner_now_network_forbidden");
  };
  const intentId = "acct-intent-payment-a";
  const refundIntentId = "acct-intent-refund-a";
  try {
    const model = await buildOwnerNowReadModel(
      env({
        quotes: [nativeOwnerQuote("QUOTE-A")],
        accountingIntents: [
          nativeAccountingIntent(intentId),
          nativeAccountingIntent(refundIntentId, {
            kind: "refund",
            subtotal: "0.00",
            total_amount: "-50.00",
            expected_sha256: "b".repeat(64),
            provider_entity_type: "RefundReceipt",
            provider_entity_id: "124",
          }),
        ],
        accountingReconciliations: [
          nativeAccountingReconciliation(
            "11111111-1111-4111-8111-111111111111",
            intentId,
          ),
          nativeAccountingReconciliation(
            "44444444-4444-4444-8444-444444444444",
            refundIntentId,
            {
              expected_sha256: "b".repeat(64),
              observed_sha256: "b".repeat(64),
            },
          ),
        ],
      }),
      auth("owner", "owner@example.com"),
    );
    const job = model.economics.find(
      (projection) => projection.job_id === "JOB-A",
    );
    assert.ok(job);
    assert.equal(job.metrics.forecast_revenue.known_cents, 100_000);
    assert.equal(job.metrics.cash_collected.known_cents, 20_000);
    assert.equal(job.metrics.forecast_cost.known_cents, null);
    assert.equal(job.metrics.committed_cost.known_cents, null);
    assert.equal(job.metrics.accrued_actual_cost.known_cents, null);
    assert.equal(job.metrics.posted_actual_cost.known_cents, null);
    assert.equal(job.metrics.actual_profit.amount_cents, null);
    assert.equal(job.source_coverage.matched_payment_milestones, 2);
    assert.ok(
      job.reconciliation_gaps.includes("supplier_order.native_unavailable"),
    );
    assert.ok(
      model.stale_fields.includes(
        "economics.job_cost_event.tax_basis.native_unavailable",
      ),
    );
    assert.equal(
      networkCalls,
      0,
      "Owner Now must not call Frappe or the network",
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("owner Now excludes reconciled money with an invalid provider or sign binding", async () => {
  const original = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error("owner_now_network_forbidden");
  };
  const wrongProviderId = "acct-intent-wrong-provider";
  const wrongSignId = "acct-intent-wrong-sign";
  try {
    const model = await buildOwnerNowReadModel(
      env({
        quotes: [nativeOwnerQuote("QUOTE-A")],
        accountingIntents: [
          nativeAccountingIntent(wrongProviderId, {
            provider_entity_type: "Invoice",
          }),
          nativeAccountingIntent(wrongSignId, {
            kind: "refund",
            total_amount: "50.00",
            expected_sha256: "c".repeat(64),
            provider_entity_type: "RefundReceipt",
            provider_entity_id: "125",
          }),
        ],
        accountingReconciliations: [
          nativeAccountingReconciliation(
            "55555555-5555-4555-8555-555555555555",
            wrongProviderId,
          ),
          nativeAccountingReconciliation(
            "66666666-6666-4666-8666-666666666666",
            wrongSignId,
            {
              expected_sha256: "c".repeat(64),
              observed_sha256: "c".repeat(64),
            },
          ),
        ],
      }),
      auth("owner", "owner@example.com"),
    );
    const job = model.economics.find(
      (projection) => projection.job_id === "JOB-A",
    );
    assert.ok(job);
    assert.equal(job.metrics.cash_collected.known_cents, 0);
    assert.equal(job.metrics.cash_collected.complete, false);
    assert.equal(job.source_coverage.matched_payment_milestones, 0);
    assert.ok(
      job.reconciliation_gaps.includes(
        `payment_milestone.not_matched:${wrongProviderId}`,
      ),
    );
    assert.ok(
      job.reconciliation_gaps.includes(
        `payment_milestone.not_matched:${wrongSignId}`,
      ),
    );
    assert.equal(model.summary.finance_exceptions, 2);
    assert.equal(
      networkCalls,
      0,
      "Owner Now must not call Frappe or the network",
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("owner Now withholds ambiguous native quote and reconciliation heads", async () => {
  const original = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error("owner_now_network_forbidden");
  };
  const intentId = "acct-intent-payment-ambiguous";
  try {
    const model = await buildOwnerNowReadModel(
      env({
        quotes: [
          nativeOwnerQuote("QUOTE-A-ROOT"),
          nativeOwnerQuote("QUOTE-A-OTHER", {
            customer_quote_id: "customer-quote-other",
            subtotal_cents: 120_000,
            total_cents: 126_000,
          }),
        ],
        accountingIntents: [nativeAccountingIntent(intentId)],
        accountingReconciliations: [
          nativeAccountingReconciliation(
            "22222222-2222-4222-8222-222222222222",
            intentId,
          ),
          nativeAccountingReconciliation(
            "33333333-3333-4333-8333-333333333333",
            intentId,
          ),
        ],
      }),
      auth("owner", "owner@example.com"),
    );
    const job = model.economics.find(
      (projection) => projection.job_id === "JOB-A",
    );
    assert.ok(job);
    assert.equal(job.metrics.forecast_revenue.known_cents, null);
    assert.equal(job.metrics.cash_collected.known_cents, null);
    assert.ok(
      job.reconciliation_gaps.includes("customer_quote.selection_ambiguous"),
    );
    assert.ok(
      job.reconciliation_gaps.includes(
        `accounting_reconciliation.selection_ambiguous:${intentId}`,
      ),
    );
    assert.equal(model.summary.finance_exceptions, 1);
    assert.equal(
      networkCalls,
      0,
      "Owner Now must not call Frappe or the network",
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("owner Now reports bounded native sources as lower bounds", async () => {
  const original = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error("owner_now_network_forbidden");
  };
  const partialLeads = Array.from({ length: 51 }, (_, index) => ({
    lead_id: `LEAD-PARTIAL-${index + 1}`,
    tenant_id: "ironwrap",
    source_envelope_id: `lead_partial_${index + 1}`,
    source_raw_key: `raw/lead-partial-${index + 1}.json`,
    source: "website",
    contact_name: `Partial Lead ${index + 1}`,
    contact_phone: null,
    contact_email: null,
    job_ref: index === 0 ? "JOB-A" : null,
    lifecycle_status: "untriaged",
    version: 1,
    created_at: `2026-07-10T10:${String(index).padStart(2, "0")}:00.000Z`,
    updated_at: MODIFIED,
  }));
  const partialQuotes = Array.from({ length: 51 }, (_, index) => {
    const revision = 51 - index;
    return nativeOwnerQuote(`QUOTE-PARTIAL-${revision}`, {
      customer_quote_id: "customer-quote-partial",
      revision_number: revision,
      supersedes_quote_revision_id:
        revision > 1 ? `QUOTE-PARTIAL-${revision - 1}` : null,
    });
  });
  try {
    const model = await buildOwnerNowReadModel(
      env({ leads: partialLeads, quotes: partialQuotes }),
      auth("owner", "owner@example.com"),
    );
    assert.equal(model.summary.untriaged_leads, 50);
    assert.ok(model.partial_sources.includes("untriaged_leads"));
    assert.ok(model.partial_sources.includes("economics.customer_quotes"));
    const job = model.economics.find(
      (projection) => projection.job_id === "JOB-A",
    );
    assert.ok(job);
    assert.equal(job.metrics.forecast_revenue.known_cents, null);
    assert.ok(
      job.reconciliation_gaps.includes(
        "economics.customer_quotes.source_window_partial",
      ),
    );
    assert.equal(
      networkCalls,
      0,
      "Owner Now must not call Frappe or the network",
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("production runway reads native authority and never treats its schedule hint as write authority", async () => {
  const readyGates = ["JOB-B", "JOB-C"].flatMap((roofJob) =>
    ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew"].map(
      (gate) => nativeGate(roofJob, gate),
    ),
  );
  const mock = installFrappeMock();
  const appEnv = env({
    assignments: [nativeAssignment("ASSIGN-C", "JOB-C")],
    gates: [nativeGate("JOB-A", "Materials", "blocked"), ...readyGates],
    materialExceptions: [
      {
        exception_id: "exception:job-a:shortage",
        aggregate_id: "JOB-A",
        exception_type: "shortage",
        status: "open",
        updated_at: MODIFIED,
      },
    ],
  });
  try {
    const model = await buildProductionRunwayReadModel(
      appEnv,
      auth("ops", "ops@example.com"),
    );
    assert.deepEqual(model.summary, {
      active_jobs: 3,
      blocked: 1,
      scheduled: 1,
      needs_assignment: 0,
      ready_for_review: 1,
      needs_verification: 0,
    });
    assert.equal(model.jobs.find((job) => job.id === "JOB-A")?.lane, "blocked");
    assert.equal(
      model.jobs.find((job) => job.id === "JOB-B")?.lane,
      "ready_for_review",
    );
    assert.equal(
      model.jobs.find((job) => job.id === "JOB-B")?.assignment,
      null,
    );
    assert.equal(
      model.jobs.find((job) => job.id === "JOB-C")?.lane,
      "scheduled",
    );
    assert.equal(
      model.jobs.find((job) => job.id === "JOB-C")?.gate_coverage,
      "complete",
    );
    assert.deepEqual(
      model.jobs.find((job) => job.id === "JOB-C")?.gate_summary,
      {
        expected: 6,
        blocked: 0,
        ready: 6,
        waived: 0,
        done: 0,
      },
    );
    assert.deepEqual(
      model.jobs.find((job) => job.id === "JOB-C")?.scheduling_gates,
      [
        { name: "Deposit", state: "Ready" },
        { name: "Materials", state: "Ready" },
        { name: "Safety", state: "Ready" },
        { name: "Access", state: "Ready" },
        { name: "Weather", state: "Ready" },
        { name: "Crew", state: "Ready" },
      ],
    );
    assert.deepEqual(model.crews, [
      { id: "CREW-1", name: "Northside Metal", version: 3 },
    ]);
    assert.deepEqual(model.jobs.find((job) => job.id === "JOB-C")?.assignment, {
      id: "ASSIGN-C",
      type: "Production",
      status: "Assigned",
      assignment_version: 1,
      roof_job_version: 1,
      crew_id: "CREW-1",
      crew_version: 3,
      scheduled_start: "2026-07-18T08:00:00.000Z",
      scheduled_end: null,
    });
    assert.ok(
      model.allowed_actions.includes("operating_job_assignment.create"),
    );
    assert.equal(
      model.jobs.find((job) => job.id === "JOB-B")
        ?.scheduling_preparation_allowed,
      true,
    );
    assert.equal(
      model.jobs
        .find((job) => job.id === "JOB-C")
        ?.next_action.includes("Confirm the schedule"),
      true,
    );
    const serialized = JSON.stringify(model);
    for (const secret of [
      "financial-secret",
      "customer0@private.example",
      "Deliver to rear",
      "office-owner@example.com",
    ]) {
      assert.equal(serialized.includes(secret), false, `leaked ${secret}`);
    }
    assert.equal(mock.requests.length, 0);
    const productionRole = await buildProductionRunwayReadModel(
      appEnv,
      auth("production", "production@example.com"),
    );
    assert.equal(productionRole.summary.active_jobs, 3);
    assert.equal(
      productionRole.allowed_actions.includes(
        "operating_job_assignment.create",
      ),
      true,
    );
    await assert.rejects(
      async () =>
        await buildProductionRunwayReadModel(
          env(),
          auth("field", "crew@example.com"),
        ),
      /production_scope_required/,
    );
  } finally {
    mock.restore();
  }
});

test("production runway does not collapse duplicate scheduling gates into a schedule-ready job", async () => {
  const readyGates = [
    "Deposit",
    "Materials",
    "Safety",
    "Access",
    "Weather",
    "Crew",
  ].map((gate) => nativeGate("JOB-C", gate));
  const model = await buildProductionRunwayReadModel(
    env({
      assignments: [],
      gates: [
        ...readyGates,
        {
          ...nativeGate("JOB-C", "Materials", "blocked"),
          gate_id: "gate_job_c_materials_old",
          gate: "Materials",
          state: "blocked",
          updated_at: "2026-07-10T10:00:00.000Z",
        },
      ],
    }),
    auth("ops", "ops@example.com"),
  );
  const job = model.jobs.find((row) => row.id === "JOB-C");
  assert.equal(job?.gate_coverage, "incomplete");
  assert.equal(job?.lane, "needs_verification");
});

test("production runway with a truncated assignment source does not claim an unreturned crew is missing", async () => {
  const partialAssignments = Array.from({ length: 100 }, (_, index) =>
    nativeAssignment(`ASSIGN-PARTIAL-${index}`, `OTHER-${index}`),
  );
  const model = await buildProductionRunwayReadModel(
    env({ assignments: partialAssignments }),
    auth("ops", "ops@example.com"),
  );
  assert.ok(model.partial_sources.includes("active_assignments"));
  assert.equal(
    model.jobs.find((job) => job.id === "JOB-C")?.lane,
    "needs_verification",
  );
  assert.equal(model.jobs.find((job) => job.id === "JOB-C")?.assignment, null);
});

test("production runway with a truncated material source never promotes a job to ready for review", async () => {
  const readyGates = [
    "Deposit",
    "Materials",
    "Safety",
    "Access",
    "Weather",
    "Crew",
  ].map((gate) => nativeGate("JOB-B", gate));
  const partialMaterials = Array.from({ length: 101 }, (_, index) => ({
    exception_id: `exception:partial:${index}`,
    aggregate_id: "JOB-C",
    exception_type: "shortage",
    status: "open",
    updated_at: MODIFIED,
  }));
  const model = await buildProductionRunwayReadModel(
    env({
      assignments: [],
      gates: [nativeGate("JOB-A", "Materials", "blocked"), ...readyGates],
      materialExceptions: partialMaterials,
    }),
    auth("ops", "ops@example.com"),
  );
  assert.ok(model.partial_sources.includes("material_exceptions"));
  assert.equal(
    model.jobs.find((job) => job.id === "JOB-B")?.gate_coverage,
    "complete",
  );
  assert.equal(
    model.jobs.find((job) => job.id === "JOB-B")?.lane,
    "needs_verification",
  );
});

test("Sales Desk receives a bounded office contract without widening Owner Now or leaking raw records", async () => {
  const mock = installFrappeMock();
  try {
    const model = await buildSalesReadModel(
      nativeSalesEnv(),
      auth("ops", "ops@example.com"),
    );
    assert.deepEqual(model.summary, {
      listed_leads: 1,
      triage_unresolved: 1,
      estimate_needs_review: 1,
      quote_needs_review: 1,
      quote_expired: 0,
      no_linked_consent_record: 0,
    });
    assert.deepEqual(model.partial_sources, []);
    assert.deepEqual(model.allowed_actions.at(-1), "sales.read");
    assert.deepEqual(model.leads[0], {
      id: "LEAD-A",
      envelope_id: "lead_a",
      source: "website",
      received_at: "2026-07-10T10:00:00.000Z",
      transport_status: null,
      intent_queue: null,
      contact: {
        display_name: "Pat Prospect",
        phone: "+14035559999",
        email: "pat@example.com",
      },
      triage: {
        status: "Untriaged",
        summary: null,
        version: 1,
      },
      job: {
        id: "JOB-A",
        job_number: "IW-1001",
        status: "In Progress",
        service_type: "Roofing",
        workflow_profile: null,
      },
      estimate: {
        id: "estimate_a",
        status: "Needs Review",
        service_type: "Roofing",
        range_low: 12_400,
        range_high: 15_900,
        estimate_total: null,
        confidence: "Preliminary",
        review_required: true,
        reviewed_at: null,
        approved_at: null,
        assumptions:
          "Visible slope and access assumptions require verification.",
        exclusions: "Not a final quote or contract.",
      },
      quote: {
        id: "quote_a",
        version: 2,
        status: "Needs Review",
        quote_total: 14_750,
        currency: "CAD",
        valid_until: "2026-07-20",
        payment_status: null,
        prepared_at: MODIFIED,
        approved_at: null,
        accepted_at: null,
        scope_summary: null,
      },
      proposal: {
        id: "pack_a",
        status: "Draft",
        prepared_at: MODIFIED,
        approved_at: null,
        signed_at: null,
        has_published_pack: false,
        published_status: null,
      },
      consent: {
        context: "recorded",
        records: [
          {
            id: "consent_a",
            channel: "Email",
            purpose: "Estimate Follow Up",
            status: "Granted",
            jurisdiction: "AB",
            basis: "Express",
            captured_at: MODIFIED,
            effective_from: null,
            expires_at: null,
            revoked_at: null,
          },
        ],
      },
      partial_fields: [],
      attention: [
        "triage_unresolved",
        "estimate_needs_review",
        "quote_needs_review",
      ],
    });
    const serialized = JSON.stringify(model);
    for (const secret of [
      "raw-intake-secret",
      "r2-private-key",
      "private-estimate-json",
      "private-tax-policy",
      "private-proposal-summary",
      "private-form-reference",
      "private-consent-note",
    ])
      assert.equal(serialized.includes(secret), false, `leaked ${secret}`);

    assert.equal(mock.requests.length, 0, "Sales must not call Frappe");

    const ownerModel = await buildOwnerNowReadModel(
      env(),
      auth("owner", "owner@example.com"),
    );
    assert.equal(ownerModel.summary.untriaged_leads, 1);
    assert.equal(mock.requests.length, 0, "Owner Now must not call Frappe");

    await assert.rejects(
      async () =>
        await buildSalesReadModel(env(), auth("field", "crew@example.com")),
      /office_scope_required/,
    );
  } finally {
    mock.restore();
  }
});

test("Sales Desk reads the native consent ledger without consulting Frappe", async () => {
  const mock = installFrappeMock();
  try {
    const model = await buildSalesReadModel(
      nativeSalesEnv(),
      auth("ops", "ops@example.com"),
    );
    assert.deepEqual(
      model.leads[0]?.consent.records.map(({ id, status }) => ({ id, status })),
      [{ id: "consent_a", status: "Granted" }],
    );
    assert.equal(mock.requests.length, 0);
  } finally {
    mock.restore();
  }
});

test("Sales grants native triage only for current commercial policy and office authority", async () => {
  const mock = installFrappeMock();
  try {
    const ready = await buildSalesReadModel(
      envWithCommercialPolicy(),
      auth("ops", "ops@example.com"),
    );
    assert.equal(
      ready.allowed_actions.includes("commercial.lead_triage.record"),
      true,
    );
    assert.equal(ready.leads[0]?.triage.status, "Untriaged");
    assert.equal(ready.leads[0]?.attention.includes("triage_unresolved"), true);

    const noFrappeIdentity = await buildSalesReadModel(
      envWithCommercialPolicy(),
      auth("ops", null),
    );
    assert.equal(
      noFrappeIdentity.allowed_actions.includes(
        "commercial.lead_triage.record",
      ),
      true,
    );

    const noBroker = await buildSalesReadModel(
      env(),
      auth("ops", "ops@example.com"),
    );
    assert.equal(
      noBroker.allowed_actions.includes("commercial.lead_triage.record"),
      false,
    );

    const readOnly = auth("sales", "sales@example.com");
    readOnly.permissions = readOnly.permissions.filter(
      (permission) => permission !== "approvals:prepare",
    );
    const noPermission = await buildSalesReadModel(
      envWithCommercialPolicy(),
      readOnly,
    );
    assert.equal(
      noPermission.allowed_actions.includes("commercial.lead_triage.record"),
      false,
    );
  } finally {
    mock.restore();
  }
});

test("Sales Desk ignores conflicting legacy proposal data once native authority exists", async () => {
  const mock = installFrappeMock({
    "Customer Quote": [
      {
        name: "QUOTE-OLD",
        customer_quote_id: "quote_old",
        roof_job: "JOB-A",
        quote_version: 1,
        status: "Approved",
        quote_total: 12_000,
        currency: "CAD",
        modified: "2026-07-09T10:00:00.000Z",
      },
      {
        name: "QUOTE-CURRENT",
        customer_quote_id: "quote_current",
        roof_job: "JOB-A",
        quote_version: 2,
        status: "Approved",
        quote_total: 14_750,
        currency: "CAD",
        modified: MODIFIED,
      },
    ],
    "Proposal Evidence Pack": [
      {
        name: "PACK-OLD",
        pack_id: "pack_old",
        roof_job: "JOB-A",
        quotation: "QUOTE-OLD",
        status: "Approved",
        approved_at: "2026-07-09T10:30:00.000Z",
        modified: "2026-07-09T10:30:00.000Z",
      },
      {
        name: "PACK-CURRENT-PUBLISHED",
        pack_id: "pack_current_published",
        roof_job: "JOB-A",
        quotation: "QUOTE-CURRENT",
        status: "Approved",
        approved_at: "2026-07-10T10:30:00.000Z",
        modified: "2026-07-10T10:30:00.000Z",
      },
      {
        name: "PACK-CURRENT-DRAFT",
        pack_id: "pack_current_draft",
        roof_job: "JOB-A",
        quotation: "QUOTE-CURRENT",
        status: "Draft",
        prepared_at: MODIFIED,
        modified: MODIFIED,
      },
    ],
  });
  try {
    const model = await buildSalesReadModel(
      nativeSalesEnv(),
      auth("ops", "ops@example.com"),
    );
    const lead = model.leads[0];
    assert.equal(lead?.quote?.id, "quote_a");
    assert.deepEqual(lead?.proposal, {
      id: "pack_a",
      status: "Draft",
      prepared_at: MODIFIED,
      approved_at: null,
      signed_at: null,
      has_published_pack: false,
      published_status: null,
    });
    assert.deepEqual(lead?.partial_fields, []);
    assert.equal(mock.requests.length, 0);
  } finally {
    mock.restore();
  }
});

test("Sales Desk makes proposal publication inconclusive when its bounded source is partial", async () => {
  const publicationRows = Array.from({ length: 101 }, (_, index) => ({
    publication_event_id: `commercial-publication:${String(index).padStart(3, "0")}`,
    tenant_id: "ironwrap",
    proposal_revision_id: index === 100 ? "PROPOSAL-A" : `PROPOSAL-${index}`,
    proposal_pack_id: index === 100 ? "pack_a" : `pack_${index}`,
    publication_version: 1,
    previous_state: "draft",
    state: "published",
    occurred_at: new Date(Date.parse(MODIFIED) - index * 1_000).toISOString(),
  }));
  const mock = installFrappeMock();
  try {
    const model = await buildSalesReadModel(
      nativeSalesEnv({ publications: publicationRows }),
      auth("ops", "ops@example.com"),
    );
    const lead = model.leads[0];
    assert.equal(
      model.partial_sources.includes("commercial_proposal_publication_events"),
      true,
    );
    assert.deepEqual(lead?.proposal, {
      id: "pack_a",
      status: "Draft",
      prepared_at: MODIFIED,
      approved_at: null,
      signed_at: null,
      has_published_pack: null,
      published_status: null,
    });
    assert.deepEqual(lead?.partial_fields, ["proposal_publication"]);
    assert.equal(lead?.attention.includes("source_partial"), true);
    assert.equal(mock.requests.length, 0);
  } finally {
    mock.restore();
  }
});

test("Sales Desk marks a quote and its dependent records unknown when the bounded quote window omits it", async () => {
  const quoteRows = Array.from({ length: 101 }, (_, index) => ({
    quote_revision_id: index === 100 ? "QUOTE-A" : `QUOTE-${index}`,
    tenant_id: "ironwrap",
    customer_quote_id: index === 100 ? "quote_a" : `quote_${index}`,
    revision_number: 1,
    roof_job_id: index === 100 ? "JOB-A" : `OTHER-${index}`,
    customer_id: index === 100 ? "CUSTOMER-A" : `CUSTOMER-${index}`,
    status: "approved",
    currency: "CAD",
    valid_until: "2026-07-20",
    total_cents: 1_475_000,
    created_at: new Date(Date.parse(MODIFIED) - index * 1_000).toISOString(),
  }));
  const mock = installFrappeMock();
  try {
    const model = await buildSalesReadModel(
      nativeSalesEnv({ quotes: quoteRows }),
      auth("ops", "ops@example.com"),
    );
    const lead = model.leads[0];
    assert.equal(
      model.partial_sources.includes("commercial_quote_revisions"),
      true,
    );
    assert.equal(lead?.quote, null);
    assert.deepEqual(lead?.partial_fields, [
      "quote",
      "proposal",
      "proposal_publication",
      "quote_acceptance",
      "proposal_acceptance",
    ]);
    assert.equal(lead?.attention.includes("source_partial"), true);
    assert.equal(mock.requests.length, 0);
  } finally {
    mock.restore();
  }
});

test("Sales Desk carries row-level uncertainty for every bounded native child join", async () => {
  const cases: Array<{
    source: NativeSalesSource;
    table: string;
    rows: Array<Record<string, unknown>>;
    expected: string[];
  }> = [
    {
      source: "jobs",
      table: "operating_roof_jobs",
      rows: Array.from({ length: 101 }, (_, index) => ({
        roof_job_id: index === 100 ? "JOB-A" : `JOB-${index}`,
        lead_id: index === 100 ? "LEAD-A" : `OTHER-LEAD-${index}`,
        updated_at: new Date(
          Date.parse(MODIFIED) - index * 1_000,
        ).toISOString(),
      })),
      expected: [
        "job",
        "quote",
        "proposal",
        "proposal_publication",
        "quote_acceptance",
        "proposal_acceptance",
      ],
    },
    {
      source: "estimates",
      table: "operating_instant_estimates",
      rows: Array.from({ length: 101 }, (_, index) => ({
        estimate_session_id: `ESTIMATE-${index}`,
        lead_id: index === 100 ? "LEAD-A" : `OTHER-LEAD-${index}`,
        updated_at: new Date(
          Date.parse(MODIFIED) - index * 1_000,
        ).toISOString(),
      })),
      expected: ["estimate"],
    },
    {
      source: "triageDecisions",
      table: "commercial_lead_triage_decisions",
      rows: Array.from({ length: 101 }, (_, index) => ({
        triage_decision_id: `TRIAGE-${index}`,
        lead_id: index === 100 ? "LEAD-A" : `OTHER-LEAD-${index}`,
        decided_at: new Date(
          Date.parse(MODIFIED) - index * 1_000,
        ).toISOString(),
      })),
      expected: ["triage_decision"],
    },
    {
      source: "proposals",
      table: "commercial_proposal_revisions",
      rows: Array.from({ length: 101 }, (_, index) => ({
        proposal_revision_id: `PROPOSAL-${index}`,
        proposal_pack_id: `PACK-${index}`,
        quote_revision_id: index === 100 ? "QUOTE-A" : `OTHER-QUOTE-${index}`,
        created_at: new Date(
          Date.parse(MODIFIED) - index * 1_000,
        ).toISOString(),
      })),
      expected: ["proposal", "proposal_publication", "proposal_acceptance"],
    },
    {
      source: "acceptances",
      table: "commercial_acceptance_bindings",
      rows: Array.from({ length: 101 }, (_, index) => ({
        acceptance_binding_id: `ACCEPTANCE-${index}`,
        quote_revision_id: index === 100 ? "QUOTE-A" : `OTHER-QUOTE-${index}`,
        proposal_revision_id:
          index === 100 ? "PROPOSAL-A" : `OTHER-PROPOSAL-${index}`,
        accepted_at: new Date(
          Date.parse(MODIFIED) - index * 1_000,
        ).toISOString(),
      })),
      expected: ["quote_acceptance", "proposal_acceptance"],
    },
  ];
  const mock = installFrappeMock();
  try {
    for (const scenario of cases) {
      const model = await buildSalesReadModel(
        nativeSalesEnv({ [scenario.source]: scenario.rows }),
        auth("ops", "ops@example.com"),
      );
      assert.equal(model.partial_sources.includes(scenario.table), true);
      assert.deepEqual(model.leads[0]?.partial_fields, scenario.expected);
      assert.equal(model.leads[0]?.attention.includes("source_partial"), true);
    }
    assert.equal(mock.requests.length, 0);
  } finally {
    mock.restore();
  }
});

test("MCTB status distinguishes provider acceptance from delivery and never guesses without timing proof", () => {
  const receivedAt = "2026-07-10T10:00:00.000Z";
  const onTime = mctbStatus(
    receivedAt,
    [
      {
        receipt_id: "ack_1",
        envelope_id: "lead_a",
        channel: "email",
        outcome: "provider_accepted",
        observed_at: "2026-07-10T10:00:59.999Z",
        provider_message_id: "gmail-1",
        error_code: null,
        created_at: "2026-07-10T10:00:59.999Z",
      },
    ],
    new Date("2026-07-10T10:03:00.000Z"),
  );
  assert.equal(onTime.state, "provider_accepted_within_sla");
  assert.equal(onTime.proof_kind, "provider_receipt");

  const late = mctbStatus(
    receivedAt,
    [
      {
        receipt_id: "ack_2",
        envelope_id: "lead_a",
        channel: "email",
        outcome: "provider_accepted",
        observed_at: "2026-07-10T10:01:00.001Z",
        provider_message_id: "gmail-2",
        error_code: null,
        created_at: "2026-07-10T10:01:00.001Z",
      },
    ],
    new Date("2026-07-10T10:03:00.000Z"),
  );
  assert.equal(late.state, "provider_accepted_late");

  assert.equal(
    mctbStatus(receivedAt, [], new Date("2026-07-10T10:01:00.000Z")).state,
    "awaiting_proof",
  );
  assert.equal(
    mctbStatus(receivedAt, [], new Date("2026-07-10T10:01:00.001Z")).state,
    "unproven_after_sla",
  );
});

test("owner Now HTTP route does not expose the office queue to field sessions", async () => {
  const original = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error("owner_now_network_forbidden");
  };
  const appEnv = env({
    workPackages: [nativeWorkPackageRow({ status: "Blocked" })],
    workPackageEvents: [nativeWorkPackageEvent("stop_work")],
  });
  try {
    const request = new Request("https://app.example.com/api/v1/owner/now");
    const office = await handleAuthenticatedRoute(
      request,
      appEnv,
      auth("ops", "ops@example.com"),
    );
    assert.equal(office.status, 200);
    assert.equal(office.headers.get("cache-control"), "private, no-store");
    assert.equal(
      ((await office.json()) as { summary: { field_blockers: number } }).summary
        .field_blockers,
      1,
    );

    const field = await handleAuthenticatedRoute(
      request,
      appEnv,
      auth("field", "crew@example.com"),
    );
    assert.equal(field.status, 403);
    assert.deepEqual(await field.json(), { error: "forbidden" });
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("production runway HTTP route is private and starts no upstream read for field sessions", async () => {
  const mock = installFrappeMock();
  try {
    const request = new Request("https://app.example.com/api/v1/production");
    const office = await handleAuthenticatedRoute(
      request,
      env(),
      auth("ops", "ops@example.com"),
    );
    assert.equal(office.status, 200);
    assert.equal(office.headers.get("cache-control"), "private, no-store");
    assert.equal(
      ((await office.json()) as { summary: { active_jobs: number } }).summary
        .active_jobs,
      3,
    );

    const productionRole = await handleAuthenticatedRoute(
      request,
      env(),
      auth("production", "production@example.com"),
    );
    assert.equal(productionRole.status, 200);
    assert.equal(
      ((await productionRole.json()) as { summary: { active_jobs: number } })
        .summary.active_jobs,
      3,
    );

    const callsBeforeNow = mock.requests.length;
    const productionNow = await handleAuthenticatedRoute(
      new Request("https://app.example.com/api/v1/now"),
      env(),
      auth("production", "production@example.com"),
    );
    const productionNowBody = (await productionNow.json()) as {
      role: string;
      sources: Array<{ id: string }>;
    };
    assert.equal(productionNow.status, 200);
    assert.equal(productionNowBody.role, "production");
    assert.deepEqual(
      productionNowBody.sources.map(({ id }) => id),
      ["production"],
    );
    const productionNowDoctypes = mock.requests
      .slice(callsBeforeNow)
      .map(({ doctype }) => doctype);
    for (const forbidden of [
      "Lead Envelope",
      "Instant Estimate Session",
      "Customer Quote",
      "Proposal Evidence Pack",
      "Communication Consent",
      "Automation Incident",
      "Payment Milestone",
    ]) {
      assert.equal(productionNowDoctypes.includes(forbidden), false, forbidden);
    }

    const productionJob = await handleAuthenticatedRoute(
      new Request("https://app.example.com/api/v1/jobs/JOB-A"),
      env(),
      auth("production", "production@example.com"),
    );
    assert.equal(productionJob.status, 200);
    const productionJobBody = (await productionJob.json()) as {
      allowed_actions: string[];
      packet: {
        work_package: null | {
          id: string;
          status: string;
        };
      };
    };
    assert.deepEqual(productionJobBody.allowed_actions, [
      "job.read",
      "work_package.issue",
      "work_package.hold.release",
      "work_package.evidence.review",
    ]);
    assert.equal(productionJobBody.packet.work_package?.id, "work_package_a");
    assert.equal(productionJobBody.packet.work_package?.status, "Released");

    for (const [path, error] of [
      ["/api/v1/today", "today_read_required"],
      ["/api/v1/owner/now", "forbidden"],
      ["/api/v1/sales", "office_role_required"],
      ["/api/v1/approvals", "office_role_required"],
    ] as const) {
      const callsBeforeDeniedRead = mock.requests.length;
      const deniedRead = await handleAuthenticatedRoute(
        new Request(`https://app.example.com${path}`),
        env(),
        auth("production", "production@example.com"),
      );
      assert.equal(deniedRead.status, 403, path);
      assert.deepEqual(await deniedRead.json(), { error }, path);
      assert.equal(mock.requests.length, callsBeforeDeniedRead, path);
    }

    const callsBeforeDenied = mock.requests.length;
    const field = await handleAuthenticatedRoute(
      request,
      env(),
      auth("field", "crew@example.com"),
    );
    assert.equal(field.status, 403);
    assert.deepEqual(await field.json(), { error: "office_role_required" });
    assert.equal(mock.requests.length, callsBeforeDenied);
  } finally {
    mock.restore();
  }
});

test("Sales Desk and scoped job-plan reads keep sales out of other job records", async () => {
  const mock = installFrappeMock();
  try {
    const request = new Request("https://app.example.com/api/v1/sales");
    const office = await handleAuthenticatedRoute(
      request,
      nativeSalesEnv(),
      auth("ops", "ops@example.com"),
    );
    assert.equal(office.status, 200);
    assert.equal(office.headers.get("cache-control"), "private, no-store");
    assert.equal(
      ((await office.json()) as { leads: Array<{ id: string }> }).leads[0]?.id,
      "LEAD-A",
    );

    const salesRole = await handleAuthenticatedRoute(
      request,
      nativeSalesEnv(),
      auth("sales", "sales@example.com"),
    );
    assert.equal(salesRole.status, 200);

    const callsBeforeNow = mock.requests.length;
    const now = await handleAuthenticatedRoute(
      new Request("https://app.example.com/api/v1/now"),
      env(),
      auth("sales", "sales@example.com"),
    );
    const nowBody = (await now.json()) as {
      role: string;
      sources: Array<{ id: string }>;
    };
    assert.equal(now.status, 200);
    assert.equal(nowBody.role, "sales");
    assert.deepEqual(
      nowBody.sources.map(({ id }) => id),
      ["sales"],
    );
    const salesNowDoctypes = mock.requests
      .slice(callsBeforeNow)
      .map(({ doctype }) => doctype);
    for (const forbidden of [
      "Production Assignment",
      "Job Gate",
      "Automation Incident",
      "Payment Milestone",
      "Supplier Order",
    ]) {
      assert.equal(salesNowDoctypes.includes(forbidden), false, forbidden);
    }

    const salesJob = await handleAuthenticatedRoute(
      new Request("https://app.example.com/api/v1/jobs/JOB-A"),
      env(),
      auth("sales", "sales@example.com"),
    );
    assert.equal(salesJob.status, 200);
    assert.equal(salesJob.headers.get("cache-control"), "private, no-store");
    const salesJobBody = (await salesJob.json()) as {
      job: { id: string };
      permissions: string[];
      allowed_actions: string[];
      packet: { work_package: null | { id: string; status: string } };
    };
    assert.equal(salesJobBody.job.id, "JOB-A");
    assert.equal(salesJobBody.packet.work_package?.id, "work_package_a");
    assert.equal(salesJobBody.packet.work_package?.status, "Released");
    assert.equal(salesJobBody.permissions.includes("jobs:read:any"), false);
    assert.deepEqual(salesJobBody.allowed_actions, ["job.read"]);

    const salesProof = await handleAuthenticatedRoute(
      new Request("https://app.example.com/api/v1/jobs/JOB-A/proof"),
      env(),
      auth("sales", "sales@example.com"),
    );
    assert.equal(salesProof.status, 200);
    assert.equal(salesProof.headers.get("cache-control"), "private, no-store");
    const salesProofBody = (await salesProof.json()) as {
      allowed_actions: string[];
      items: unknown[];
    };
    assert.deepEqual(salesProofBody.allowed_actions, ["job.read"]);
    assert.ok(Array.isArray(salesProofBody.items));

    for (const [path, error] of [
      ["/api/v1/field/bootstrap", "today_read_required"],
      ["/api/v1/today", "today_read_required"],
      ["/api/v1/jobs/JOB-A/history", "job_read_any_required"],
      ["/api/v1/jobs/JOB-A/customer-history", "job_read_any_required"],
      ["/api/v1/jobs/JOB-A/phase", "job_read_any_required"],
    ] as const) {
      const callsBeforeDeniedRead = mock.requests.length;
      const deniedRead = await handleAuthenticatedRoute(
        new Request(`https://app.example.com${path}`),
        env(),
        auth("sales", "sales@example.com"),
      );
      assert.equal(deniedRead.status, 403, path);
      assert.deepEqual(await deniedRead.json(), { error }, path);
      assert.equal(mock.requests.length, callsBeforeDeniedRead, path);
    }

    const callsBeforeDenied = mock.requests.length;
    const field = await handleAuthenticatedRoute(
      request,
      env(),
      auth("field", "crew@example.com"),
    );
    assert.equal(field.status, 403);
    assert.deepEqual(await field.json(), { error: "office_role_required" });
    assert.equal(mock.requests.length, callsBeforeDenied);
  } finally {
    mock.restore();
  }
});

test("field packet contains job-safe contact details and excludes email, financials and internal notes", async () => {
  const mock = installFrappeMock();
  try {
    const model = await buildJobReadModel(
      env(),
      auth("field", "crew@example.com"),
      "JOB-A",
    );
    assert.ok(model);
    assert.deepEqual(model.packet.contact, {
      display_name: "Customer 1",
      phone: "+14035550000",
      access_instructions: null,
    });
    assert.equal(model.gates[0]?.owner, null);
    assert.equal(
      Object.hasOwn(model.packet.change_orders[0] ?? {}, "total_amount"),
      false,
    );
    assert.equal(
      Object.hasOwn(model.packet.change_orders[0] ?? {}, "currency"),
      false,
    );
    assert.deepEqual(model.packet.work_package, {
      id: "work_package_a",
      version: 1,
      status: "Released",
      title: "South roof replacement",
      objective: "Install the released metal system.",
      boundaries: "South roof only.",
      prerequisites: "Verify tie-off and material staging.",
      expected_result: "Released roof section complete.",
      stop_conditions: "Stop for unsafe weather or missing controls.",
      make_safe_procedure: "Secure the work area and notify the supervisor.",
      issued_at: "2026-07-10T07:00:00.000Z",
      expires_at: "2026-07-11T07:00:00.000Z",
      released_at: "2026-07-10T07:05:00.000Z",
      // No safety occurrence, unserviceable PPE, outstanding notification, or
      // overdue high-risk action applies to this package.
      safety_blockers: [],
      authority_denials: [],
      work_object_type: "Roof Job",
      work_object_id: "JOB-A",
      physical_context_type: "Roof Site",
      physical_context_id: "JOB-A",
      release_attempt_id: "attempt-a",
      supersession: null,
      acknowledgement: {
        current_user_acknowledged: false,
        acknowledged_at: null,
        workers: [
          {
            worker_user: "crew@example.com",
            worker_role: "Installer",
            required: true,
            acknowledged: false,
            acknowledged_at: null,
          },
        ],
      },
      evidence_slots: [],
      steps: [
        {
          sequence: 1,
          instruction: "Verify the roof zone.",
          required_evidence: "Zone photo",
          acceptance_criteria: "Zone matches package.",
        },
      ],
      hold_points: [
        {
          sequence: 1,
          hold_point: "Deck condition",
          release_phase: "Pre-start",
          release_authority: "Supervisor",
          required_evidence: "Deck photo",
          acceptance_criteria: "Supervisor release.",
          released: false,
        },
      ],
    });
    assert.equal(
      model.allowed_actions.includes("work_package.acknowledge"),
      true,
    );
    assert.equal(model.allowed_actions.includes("work_package.start"), false);
    assert.equal(
      model.allowed_actions.includes("work_package.stop_work"),
      true,
    );
    assert.ok(
      model.stale_fields.includes("packet.contact.access_instructions"),
    );
    const serialized = JSON.stringify(model);
    for (const secret of [
      "office-owner@example.com",
      "customer0@private.example",
      "financial-secret",
      "internal customer note",
      "internal pricing assumption",
      "internal exclusion",
      "internal access secret",
      "internal hazard secret",
      "private-release@example.com",
      "private blocker",
      "r2/private",
    ])
      assert.equal(serialized.includes(secret), false, `leaked ${secret}`);
    assert.equal(mock.requests.length, 0);
  } finally {
    mock.restore();
  }
});

test("field packet prefers native contact, property, and typed work-package proof when present", async () => {
  const packageRow = {
    ...rowsFor("Work Package")[0]!,
    release_attempt_id: "attempt-a",
  };
  const mock = installFrappeMock({
    "Roofing Customer": [],
    "Roofing Property": [],
    "Work Package": [packageRow],
    "Evidence Item": [],
  });
  try {
    const model = await buildJobReadModel(
      envWithNativeJobPacket({
        operatingJobs: [
          {
            roof_job_id: "JOB-A",
            customer_id: "CUSTOMER-A",
            property_id: "PROP-A",
            brand: "ironwrap",
            job_number: "IW-1001",
            service_type: "Roofing",
            job_status: "in_progress",
            current_gate_state: "in_progress",
            version: 1,
            updated_at: MODIFIED,
          },
        ],
        operatingCustomers: [
          {
            customer_id: "CUSTOMER-A",
            display_name: "Native Customer",
            contact_phone: "+14035551234",
            updated_at: MODIFIED,
          },
        ],
        operatingProperties: [
          {
            property_id: "PROP-A",
            address_line1: "42 Native Ave",
            city: "Calgary",
            province: "AB",
            postal_code: "T2T 2T2",
            country: "Canada",
            updated_at: MODIFIED,
          },
        ],
        fieldEvidence: [
          {
            device_action_id: "device-action-1",
            user_id: "appu_field",
            actor_user: "crew@example.com",
            actor_role: "Installer",
            created_at: "2026-07-10T09:05:00.000Z",
            work_package_id: "work_package_a",
            work_package_version: 1,
            evidence_slot_id: "step:1",
            evidence_requirement: "Zone photo",
            evidence_source: "worker-camera",
            evidence_device_id: "paired-device-1",
            evidence_freshness: "Current",
            evidence_conflict_state: "None",
            evidence_verification: "Verified",
            evidence_disposition: "Open",
            evidence_correction_of: null,
            evidence_item_correction_of: null,
            work_package_release_attempt_id: "attempt-a",
            correction_reason: null,
            work_object_type: "Roof Job",
            work_object_id: "JOB-A",
            physical_context_type: "Roof Site",
            physical_context_id: "JOB-A",
            capture_completed_at: "2026-07-10T09:05:00.000Z",
            evidence_id: "evi_1234567890abcdef1234567890abcdef",
          },
        ],
      }),
      auth("field", "crew@example.com"),
      "JOB-A",
    );
    assert.ok(model);
    assert.equal(model.packet.contact?.display_name, "Native Customer");
    assert.equal(model.packet.contact?.phone, "+14035551234");
    assert.equal(
      model.job.address,
      "42 Native Ave, Calgary AB T2T 2T2, Canada",
    );
    assert.equal(
      model.proof_stream.some(
        (item) => item.id === "evi_1234567890abcdef1234567890abcdef",
      ),
      true,
    );
    assert.equal(
      model.stale_fields.includes("packet.scope_clauses.native_unavailable"),
      true,
    );
    assert.equal(mock.requests.length, 0);
  } finally {
    mock.restore();
  }
});

test("Job and Proof reads never fall back to Frappe when tenant configuration is absent or mismatched", async () => {
  const mock = installFrappeMock({
    "Roof Job": [job("JOB-A", "LEGACY-1001", "PROP-A", "CUSTOMER-A")],
    "Work Package": [rowsFor("Work Package")[0]!],
    "Evidence Item": [proofRows[0]!],
  });
  try {
    for (const configuredTenant of [undefined, "another-tenant"] as const) {
      const runtime = {
        ...env(),
        ...(configuredTenant ? { APP_TENANT_ID: configuredTenant } : {}),
      } as AppEnv;
      const jobModel = await buildJobReadModel(
        runtime,
        auth("field", "crew@example.com"),
        "JOB-A",
      );
      const proofModel = await buildJobProofReadModel(
        runtime,
        auth("field", "crew@example.com"),
        "JOB-A",
        "0",
      );
      assert.equal(jobModel?.packet.work_package?.id, "work_package_a");
      assert.deepEqual(proofModel?.items, []);
    }
    assert.equal(mock.requests.length, 0);
  } finally {
    mock.restore();
  }
});

test("Job and Proof reads fail closed when native Job truth is missing", async () => {
  const mock = installFrappeMock({
    "Roof Job": [job("JOB-A", "LEGACY-1001", "PROP-A", "CUSTOMER-A")],
    "Work Package": [rowsFor("Work Package")[0]!],
    "Evidence Item": [proofRows[0]!],
  });
  try {
    const runtime = env({ jobs: [] });
    assert.equal(
      await buildJobReadModel(
        runtime,
        auth("field", "crew@example.com"),
        "JOB-A",
      ),
      null,
    );
    assert.equal(
      await buildJobProofReadModel(
        runtime,
        auth("field", "crew@example.com"),
        "JOB-A",
        "0",
      ),
      null,
    );
    assert.equal(mock.requests.length, 0);
  } finally {
    mock.restore();
  }
});

test("Job and Proof reads fail closed when native evidence schema is unavailable", async () => {
  const base = env();
  const nativeDb = base.DB;
  const runtime = {
    ...base,
    DB: {
      prepare(sql: string) {
        if (!sql.includes("FROM field_actions a")) {
          return nativeDb.prepare(sql);
        }
        return {
          bind() {
            return {
              async all() {
                throw new Error("no such column: a.work_object_type");
              },
            };
          },
        };
      },
    },
  } as AppEnv;
  const mock = installFrappeMock({
    "Evidence Item": [proofRows[0]!],
  });
  try {
    await assert.rejects(
      () =>
        buildJobReadModel(runtime, auth("field", "crew@example.com"), "JOB-A"),
      /native_job_proof_unavailable/,
    );
    await assert.rejects(
      () =>
        buildJobProofReadModel(
          runtime,
          auth("field", "crew@example.com"),
          "JOB-A",
          "0",
        ),
      /native_job_proof_unavailable/,
    );
    assert.equal(mock.requests.length, 0);
  } finally {
    mock.restore();
  }
});

test("field Work Package Start requires a complete, unique native hold-release ledger", async () => {
  const baseDefinition = JSON.parse(
    String(nativeWorkPackageRow().definition_json),
  );
  const packageRow = nativeWorkPackageRow({
    status: "Acknowledged",
    acknowledged_at: "2026-07-10T07:10:00.000Z",
    definition_json: JSON.stringify({
      ...baseDefinition,
      hold_points: [
        baseDefinition.hold_points[0],
        {
          sequence: 2,
          hold_point: "Flashing inspection",
          release_phase: "Pre-start",
          release_authority: "Supervisor",
          required_evidence: "Flashing photo",
          acceptance_criteria: "Supervisor release.",
        },
      ],
    }),
  });
  const release = (sequence: number, suffix = String(sequence)) =>
    nativeWorkPackageEvent("hold_released", {
      event_id: `wpe_hold_${suffix}`,
      device_action_id: `hold-device-${suffix}`,
      payload_json: JSON.stringify({
        hold_point_sequence: sequence,
        evidence_item: `evi_hold_${suffix}`,
      }),
    });
  const acknowledgement = nativeWorkPackageEvent("acknowledged", {
    event_id: "wpe_acknowledged",
    occurred_at: "2026-07-10T07:10:00.000Z",
  });

  const mock = installFrappeMock({
    "Work Package": [rowsFor("Work Package")[0]!],
    "Work Package Event": [
      {
        name: "legacy-release",
        event_type: "Hold Point Released",
      },
    ],
  });
  try {
    const partial = await buildJobReadModel(
      env({
        workPackages: [packageRow],
        workPackageEvents: [release(1)],
      }),
      auth("field", "crew@example.com"),
      "JOB-A",
    );
    assert.deepEqual(
      partial?.packet.work_package?.hold_points.map((hold) => hold.released),
      [true, false],
    );
    assert.equal(
      partial?.allowed_actions.includes("work_package.start"),
      false,
    );

    const duplicate = await buildJobReadModel(
      env({
        workPackages: [packageRow],
        workPackageEvents: [release(1, "1-a"), release(1, "1-b"), release(2)],
      }),
      auth("field", "crew@example.com"),
      "JOB-A",
    );
    assert.deepEqual(
      duplicate?.packet.work_package?.hold_points.map((hold) => hold.released),
      [false, false],
    );
    assert.equal(
      duplicate?.allowed_actions.includes("work_package.start"),
      false,
    );

    const malformed = await buildJobReadModel(
      env({
        workPackages: [packageRow],
        workPackageEvents: [
          release(1),
          nativeWorkPackageEvent("hold_released", {
            event_id: "wpe_hold_malformed",
            device_action_id: "hold-device-malformed",
            payload_json: JSON.stringify({
              hold_point_sequence: 2,
              evidence_item: "",
            }),
          }),
        ],
      }),
      auth("field", "crew@example.com"),
      "JOB-A",
    );
    assert.deepEqual(
      malformed?.packet.work_package?.hold_points.map((hold) => hold.released),
      [false, false],
    );
    assert.equal(
      malformed?.allowed_actions.includes("work_package.start"),
      false,
    );

    const complete = await buildJobReadModel(
      env({
        workPackages: [packageRow],
        workPackageEvents: [release(1), release(2), acknowledgement],
      }),
      auth("field", "crew@example.com"),
      "JOB-A",
    );
    assert.deepEqual(
      complete?.packet.work_package?.hold_points.map((hold) => hold.released),
      [true, true],
    );
    assert.equal(
      complete?.allowed_actions.includes("work_package.start"),
      true,
    );
    assert.equal(mock.requests.length, 0);
  } finally {
    mock.restore();
  }
});

test("field packet exposes exact native Work Package supersession identity and changed step/hold summary", async () => {
  const baseDefinition = JSON.parse(
    String(nativeWorkPackageRow().definition_json),
  );
  const secondStep = {
    sequence: 2,
    instruction: "Stage the released material.",
    required_evidence: "Material staging photo",
    acceptance_criteria: "Material is protected and staged.",
  };
  const secondHold = {
    sequence: 2,
    hold_point: "Material staging",
    release_phase: "Pre-start",
    release_authority: "Supervisor",
    required_evidence: "Material staging photo",
    acceptance_criteria: "Supervisor releases material staging.",
  };
  const current = nativeWorkPackageRow({
    version: 2,
    status: "Released",
    release_attempt_id: "attempt-b",
    supersedes_id: "work_package_old",
    correction_reason:
      "Changed condition: the deck inspection hold now requires a revised anchor check.",
    definition_json: JSON.stringify({
      ...baseDefinition,
      steps: [
        {
          sequence: 1,
          instruction: "Verify the revised roof zone.",
          required_evidence: "Revised zone photo",
          acceptance_criteria: "Revised zone matches package.",
        },
        secondStep,
      ],
      hold_points: [
        {
          sequence: 1,
          hold_point: "Revised deck condition",
          release_phase: "Pre-start",
          release_authority: "Supervisor",
          required_evidence: "Revised deck photo",
          acceptance_criteria: "Supervisor releases revised deck condition.",
        },
        secondHold,
      ],
    }),
  });
  const prior = nativeWorkPackageRow({
    work_package_id: "work_package_old",
    status: "Superseded",
    release_attempt_id: "attempt-a",
    definition_json: JSON.stringify({
      ...baseDefinition,
      steps: [
        {
          sequence: 1,
          instruction: "Verify the original roof zone.",
          required_evidence: "Original zone photo",
          acceptance_criteria: "Original zone matches package.",
        },
        secondStep,
      ],
      hold_points: [
        {
          sequence: 1,
          hold_point: "Original deck condition",
          release_phase: "Pre-start",
          release_authority: "Supervisor",
          required_evidence: "Original deck photo",
          acceptance_criteria: "Supervisor releases original deck condition.",
        },
        secondHold,
      ],
    }),
  });
  const acknowledgement = nativeWorkPackageEvent("acknowledged", {
    event_id: "wpe_ack_current",
    work_package_version: 2,
    release_attempt_id: "attempt-b",
    occurred_at: "2026-07-10T07:20:00.000Z",
  });
  const mock = installFrappeMock({
    "Work Package": [rowsFor("Work Package")[0]!],
  });
  try {
    const model = await buildJobReadModel(
      env({
        workPackages: [current, prior],
        workPackageEvents: [acknowledgement],
      }),
      auth("field", "crew@example.com"),
      "JOB-A",
    );
    assert.ok(model?.packet.work_package);
    assert.deepEqual(model.packet.work_package.supersession, {
      prior_id: "work_package_old",
      reason:
        "Changed condition: the deck inspection hold now requires a revised anchor check.",
      changed_steps: [1],
      changed_hold_points: [1],
    });
    assert.equal(
      model.packet.work_package.acknowledgement.current_user_acknowledged,
      true,
    );
    assert.equal(
      model.packet.work_package.acknowledgement.acknowledged_at,
      "2026-07-10T07:20:00.000Z",
    );

    const unreadablePrior = await buildJobReadModel(
      env({
        workPackages: [current],
        workPackageEvents: [acknowledgement],
      }),
      auth("field", "crew@example.com"),
      "JOB-A",
    );
    assert.equal(unreadablePrior?.packet.work_package, null);
    assert.equal(mock.requests.length, 0);
  } finally {
    mock.restore();
  }
});

test("field packet ignores native acknowledgements from a prior release attempt", async () => {
  const packageRow = nativeWorkPackageRow({
    status: "Released",
    release_attempt_id: "attempt-b",
  });
  const staleAcknowledgement = nativeWorkPackageEvent("acknowledged", {
    event_id: "wpe_ack_stale",
    release_attempt_id: "attempt-a",
    occurred_at: "2026-07-10T07:10:00.000Z",
  });
  const mock = installFrappeMock({
    "Work Package Event": [
      {
        name: "legacy-ack",
        event_type: "Acknowledged",
        release_attempt_id: "attempt-b",
      },
    ],
  });
  try {
    const model = await buildJobReadModel(
      env({
        workPackages: [packageRow],
        workPackageEvents: [staleAcknowledgement],
      }),
      auth("field", "crew@example.com"),
      "JOB-A",
    );
    assert.equal(
      model?.packet.work_package?.acknowledgement.current_user_acknowledged,
      false,
    );
    assert.equal(
      model?.packet.work_package?.acknowledgement.acknowledged_at,
      null,
    );
    assert.equal(
      model?.allowed_actions.includes("work_package.acknowledge"),
      true,
    );
    assert.equal(model?.allowed_actions.includes("work_package.start"), false);
    assert.equal(mock.requests.length, 0);
  } finally {
    mock.restore();
  }
});

test("field packet binds verified D1/R2 evidence to the exact native release and scope", async () => {
  const validEvidence = nativeFieldEvidenceRows(1);
  const staleAttempt = nativeFieldEvidenceRows(1, {
    evidence_id: "evi_ffffffffffffffffffffffffffffffff",
    device_action_id: "device-action-stale-attempt",
    work_package_release_attempt_id: "attempt-old",
  });
  const wrongScope = nativeFieldEvidenceRows(1, {
    evidence_id: "evi_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    device_action_id: "device-action-wrong-scope",
    physical_context_id: "OTHER-SITE",
  });
  const mock = installFrappeMock({
    "Evidence Item": proofRows.slice(0, 2),
  });
  try {
    const model = await buildJobReadModel(
      env({
        fieldEvidence: [...validEvidence, ...staleAttempt, ...wrongScope],
      }),
      auth("field", "crew@example.com"),
      "JOB-A",
    );
    assert.deepEqual(
      model?.proof_stream.map((item) => item.id),
      ["evi_00000000000000000000000000000000"],
    );
    assert.deepEqual(
      model?.packet.work_package?.evidence_slots.map(
        (item) => item.evidence_item,
      ),
      ["evi_00000000000000000000000000000000"],
    );
    assert.equal(mock.requests.length, 0);
  } finally {
    mock.restore();
  }
});

test("field packet binds native crew roles, acknowledgements, and D1/R2 evidence", async () => {
  const baseDefinition = JSON.parse(
    String(nativeWorkPackageRow().definition_json),
  );
  const packageRow = nativeWorkPackageRow({
    status: "Acknowledged",
    acknowledged_at: "2026-07-10T07:11:00.000Z",
    definition_json: JSON.stringify({
      ...baseDefinition,
      assigned_workers: [
        {
          sequence: 1,
          worker_user: "crew-a@example.com",
          worker_role: "Installer",
          required: true,
        },
        {
          sequence: 2,
          worker_user: "crew-b@example.com",
          worker_role: "Spotter",
          required: true,
        },
      ],
    }),
  });
  const acknowledgements = [
    nativeWorkPackageEvent("acknowledged", {
      event_id: "wpe_ack_crew_a",
      actor_user_id: "crew-a@example.com",
      actor_role: "Installer",
      device_action_id: "ack-crew-a",
      occurred_at: "2026-07-10T07:10:00.000Z",
    }),
    nativeWorkPackageEvent("acknowledged", {
      event_id: "wpe_ack_crew_b",
      actor_user_id: "crew-b@example.com",
      actor_role: "Spotter",
      device_action_id: "ack-crew-b",
      occurred_at: "2026-07-10T07:11:00.000Z",
    }),
  ];
  const mock = installFrappeMock({
    "Work Package": [rowsFor("Work Package")[0]!],
  });
  try {
    const model = await buildJobReadModel(
      env({
        assignments: [
          nativeAssignment("ASSIGN-A", "JOB-A", {
            assigned_users_json: JSON.stringify([
              "crew-a@example.com",
              "crew-b@example.com",
            ]),
          }),
        ],
        workPackages: [packageRow],
        workPackageEvents: acknowledgements,
        fieldEvidence: nativeFieldEvidenceRows(1, {
          user_id: "appu_crew_a",
          actor_user: "crew-a@example.com",
        }),
      }),
      auth("field", "crew-a@example.com"),
      "JOB-A",
    );
    assert.equal(
      model?.packet.work_package?.acknowledgement.current_user_acknowledged,
      true,
    );
    assert.equal(
      model?.allowed_actions.includes("work_package.acknowledge"),
      false,
    );
    assert.deepEqual(
      model?.packet.work_package?.acknowledgement.workers.map((worker) => ({
        user: worker.worker_user,
        role: worker.worker_role,
        acknowledged: worker.acknowledged,
      })),
      [
        {
          user: "crew-a@example.com",
          role: "Installer",
          acknowledged: true,
        },
        {
          user: "crew-b@example.com",
          role: "Spotter",
          acknowledged: true,
        },
      ],
    );
    assert.deepEqual(
      model?.packet.work_package?.evidence_slots.map((item) => ({
        id: item.evidence_item,
        actor_user: item.actor_user,
      })),
      [
        {
          id: "evi_00000000000000000000000000000000",
          actor_user: "crew-a@example.com",
        },
      ],
    );
    assert.equal(mock.requests.length, 0);
  } finally {
    mock.restore();
  }
});

test("field packet bounds native proof output and exposes the continuation cursor", async () => {
  const mock = installFrappeMock({
    "Evidence Item": proofRows,
  });
  try {
    const model = await buildJobReadModel(
      env({ fieldEvidence: nativeFieldEvidenceRows(101) }),
      auth("field", "crew@example.com"),
      "JOB-A",
    );
    assert.equal(model?.proof_stream.length, 100);
    assert.equal(
      model?.proof_stream[0]?.id,
      "evi_00000000000000000000000000000100",
    );
    assert.equal(
      model?.proof_stream.at(-1)?.id,
      "evi_00000000000000000000000000000001",
    );
    assert.deepEqual(model?.proof_page, {
      next_cursor: "100",
      page_size: 100,
    });
    assert.equal(mock.requests.length, 0);
  } finally {
    mock.restore();
  }
});

test("proof pages deterministically traverse 1,051 immutable native items in bounded pages", async () => {
  const runtime = env({ fieldEvidence: nativeFieldEvidenceRows(1_051) });
  const mock = installFrappeMock({
    "Evidence Item": proofRows,
  });
  try {
    const seen: string[] = [];
    let cursor: string | null = "0";
    while (cursor !== null) {
      const page = await buildJobProofReadModel(
        runtime,
        auth("field", "crew@example.com"),
        "JOB-A",
        cursor,
      );
      assert.ok(page);
      assert.ok(page.items.length <= 100);
      seen.push(...page.items.map((item) => item.id));
      cursor = page.next_cursor;
    }
    assert.equal(seen.length, 1_051);
    assert.equal(new Set(seen).size, 1_051);
    assert.equal(seen[0], "evi_00000000000000000000000000001050");
    assert.equal(seen.at(-1), "evi_00000000000000000000000000000000");
    assert.equal(mock.requests.length, 0);
  } finally {
    mock.restore();
  }
});

test("assigned proof pages return only native typed evidence", async () => {
  const fieldEvidence = nativeFieldEvidenceRows(101);
  const mock = installFrappeMock({
    "Evidence Item": proofRows,
  });
  try {
    const first = await buildJobProofReadModel(
      envWithNativeJobPacket({ fieldEvidence }),
      auth("field", "crew@example.com"),
      "JOB-A",
      "0",
    );
    assert.ok(first);
    assert.equal(first.items.length, 100);
    assert.equal(first.next_cursor, "100");
    assert.equal(first.items[0]?.id, "evi_00000000000000000000000000000100");

    const second = await buildJobProofReadModel(
      envWithNativeJobPacket({ fieldEvidence }),
      auth("field", "crew@example.com"),
      "JOB-A",
      first.next_cursor,
    );
    assert.ok(second);
    assert.equal(second.items.length, 1);
    assert.equal(second.items[0]?.id, "evi_00000000000000000000000000000000");
    assert.equal(second.next_cursor, null);
    assert.equal(mock.requests.length, 0);
  } finally {
    mock.restore();
  }
});

test("Frappe read allowlist never requests sensitive contact or commercial fields", () => {
  assert.deepEqual(FRAPPE_READ_FIELDS["Roofing Customer"], [
    "name",
    "display_name",
    "phone",
    "modified",
  ]);
  assert.equal(
    FRAPPE_READ_FIELDS["Change Order"].includes("notes" as never),
    false,
  );
  assert.equal(
    FRAPPE_READ_FIELDS["Roof Job"].includes("qb_invoice_ref" as never),
    false,
  );
  for (const financeField of [
    "recognition_posted_at",
    "recognition_digest",
    "recognition_reconciliation",
  ]) {
    assert.equal(
      FRAPPE_READ_FIELDS["Payment Milestone"].includes(financeField as never),
      true,
    );
  }
  for (const retainedField of ["due_date", "event_ts", "notes"]) {
    assert.equal(
      FRAPPE_READ_FIELDS["Payment Milestone"].includes(retainedField as never),
      true,
    );
  }
  for (const excludedField of ["raw_key", "raw_payload_hash"]) {
    assert.equal(
      FRAPPE_READ_FIELDS["Payment Milestone"].includes(excludedField as never),
      false,
    );
  }
  for (const privateTriageField of [
    "triaged_by",
    "triaged_at",
    "triage_summary",
  ]) {
    assert.equal(
      FRAPPE_READ_FIELDS["Lead Envelope"].includes(privateTriageField as never),
      false,
    );
  }
  for (const rawField of [
    "payload_json",
    "raw_key",
    "tax_policy_snapshot_json",
    "source_reference",
    "notes",
  ]) {
    assert.equal(
      OFFICE_SALES_READ_FIELDS["Lead Envelope"].includes(rawField as never),
      false,
    );
    assert.equal(
      OFFICE_SALES_READ_FIELDS["Customer Quote"].includes(rawField as never),
      false,
    );
    assert.equal(
      OFFICE_SALES_READ_FIELDS["Communication Consent"].includes(
        rawField as never,
      ),
      false,
    );
  }
});
