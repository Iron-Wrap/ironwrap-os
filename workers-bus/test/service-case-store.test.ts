import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { AppEnv } from "../src/app-types.ts";
import {
  closeServiceCase,
  getServiceCase,
  issueServiceRemedy,
  listServiceCaseEvents,
  openCostRecoveryClaim,
  openServiceCase,
  reconcileCostRecoveryEffect,
  recordCustomerServiceDecision,
  recordServiceDiagnosis,
  recordServiceTriage,
  reopenServiceCase,
  serviceCaseResponseDueAt,
  summarizeServiceCaseCost,
  verifyServiceRemedy,
  type OpenServiceCaseInput,
} from "../src/service-case-store.ts";

const TENANT = "ironwrap";
const OPENED = "2026-08-18T10:00:00.000Z";
const OWNER = "appu_owner_0001";
const SUPERVISOR = "appu_ops_0001";
const DIGEST_INTAKE = "a".repeat(64);
const DIGEST_TRIAGE = "b".repeat(64);
const DIGEST_DIAGNOSIS = "c".repeat(64);
const DIGEST_PARTS = "d".repeat(64);
const DIGEST_FIELD = "e".repeat(64);
const DIGEST_CUSTOMER = "f".repeat(64);
const DIGEST_RECOVERY = "1".repeat(64);

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  /** Fires as each statement is prepared -- the seam a racing writer needs to land mid-call. */
  onPrepare: ((sql: string) => void) | null = null;

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    for (const migration of [
      "0011_app_bff_auth.sql",
      "0056_service_case_lifecycle.sql",
    ]) {
      this.raw.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
    }
    const insertUser = this.raw.prepare(
      `INSERT INTO app_users (
        user_id, tenant_id, email_normalized, display_name, role, frappe_user_id,
        active, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 'seed', ?, ?)`,
    );
    insertUser.run(OWNER, TENANT, "owner@example.invalid", "Owner", "owner", "owner@example.invalid", OPENED, OPENED);
    insertUser.run(SUPERVISOR, TENANT, "ops@example.invalid", "Supervisor", "ops", "ops@example.invalid", OPENED, OPENED);
  }

  /**
   * Real D1 counts trigger-written rows in `meta.changes`; `sqlite3_changes()`, which
   * `node:sqlite` reports, does not. The lifecycle tables are covered in AFTER-UPDATE triggers, so
   * a fake that forwarded `result.changes` would report 1 where production reports 2 and hide any
   * guard that mis-reads a triggered write. `total_changes()` deltas match D1's semantics.
   */
  private totalChanges(): number {
    return Number((this.raw.prepare("SELECT total_changes() AS total").get() as { total: number }).total);
  }

  prepare(sql: string) {
    this.onPrepare?.(sql);
    return {
      bind: (...args: unknown[]) => {
        const statement = this.raw.prepare(sql);
        return {
          first: async <T>() => (statement.get(...(args as never[])) ?? null) as T | null,
          all: async <T>() => ({ results: statement.all(...(args as never[])) as T[] }),
          run: async () => {
            const before = this.totalChanges();
            statement.run(...(args as never[]));
            return { success: true, meta: { changes: this.totalChanges() - before } };
          },
        };
      },
    };
  }

}

function env(db = new SqliteD1()): AppEnv {
  return { DB: db as never } as AppEnv;
}

function intake(overrides: Partial<OpenServiceCaseInput> = {}): OpenServiceCaseInput {
  return {
    serviceCaseId: "svc_case_0001",
    tenantId: TENANT,
    customerId: "CUST-0001",
    propertyKey: "PROP-0001",
    roofJobId: "JOB-0001",
    assetRef: "ROOF-AREA-0001",
    warrantyPacketId: "WP-0001",
    originWorkPackageRef: "wp:JOB-0001:install",
    severity: "standard",
    symptomCode: "interior_water_stain",
    reportedChannel: "phone",
    consentRef: "CONSENT-0001",
    intakeEvidenceDigest: DIGEST_INTAKE,
    responseSlaMinutes: 1440,
    openedByUserId: OWNER,
    intakeCode: "callback_reported",
    now: OPENED,
    ...overrides,
  };
}

async function triaged(
  appEnv: AppEnv,
  overrides: {
    caseId?: string;
    triageId?: string;
    finalCategory?: "emergency" | "workmanship" | "material_manufacturer" | "weather" | "excluded" | "unknown";
    responsibility?:
      | "ironwrap_workmanship"
      | "manufacturer"
      | "supplier"
      | "customer"
      | "third_party"
      | "weather"
      | "undetermined";
  } = {},
) {
  return recordServiceTriage(appEnv, {
    triageId: overrides.triageId ?? "svc_triage_0001",
    tenantId: TENANT,
    serviceCaseId: overrides.caseId ?? "svc_case_0001",
    advisorySource: "model",
    advisoryCategory: "workmanship",
    advisoryConfidenceBps: 8200,
    finalCategory: overrides.finalCategory ?? "workmanship",
    responsibility: overrides.responsibility ?? "ironwrap_workmanship",
    decidedByUserId: SUPERVISOR,
    decidedByRole: "IronWrap Production",
    evidenceDigest: DIGEST_TRIAGE,
    now: "2026-08-18T11:00:00.000Z",
  });
}

async function diagnosed(
  appEnv: AppEnv,
  overrides: { diagnosisId?: string; triageId?: string; reserveCents?: number } = {},
) {
  return recordServiceDiagnosis(appEnv, {
    diagnosisId: overrides.diagnosisId ?? "svc_diag_0001",
    tenantId: TENANT,
    serviceCaseId: "svc_case_0001",
    triageId: overrides.triageId ?? "svc_triage_0001",
    rootCauseCode: "flashing_seam_not_sealed",
    correctiveActionCode: "reseal_and_reflash",
    workPackageRef: "wp:JOB-0001:service-001",
    workPackageVersion: 1,
    warrantyReserveCents: overrides.reserveCents ?? 120_000,
    evidenceDigest: DIGEST_DIAGNOSIS,
    diagnosedByUserId: SUPERVISOR,
    now: "2026-08-18T12:00:00.000Z",
  });
}

async function remedyIssued(appEnv: AppEnv, remedyId = "svc_remedy_0001", diagnosisId = "svc_diag_0001") {
  return issueServiceRemedy(appEnv, {
    remedyId,
    tenantId: TENANT,
    serviceCaseId: "svc_case_0001",
    diagnosisId,
    scheduledStartAt: "2026-08-19T15:00:00.000Z",
    scheduledEndAt: "2026-08-19T19:00:00.000Z",
    partsManifestDigest: DIGEST_PARTS,
    issuedByUserId: SUPERVISOR,
    now: "2026-08-18T13:00:00.000Z",
  });
}

test("a complaint binds customer, property, job, asset, warranty, consent, and a response SLA", async () => {
  const appEnv = env();
  const opened = await openServiceCase(appEnv, intake());
  assert.equal(opened.kind, "opened");
  const record = opened.serviceCase;
  assert.equal(record.state, "intake");
  assert.equal(record.version, 1);
  assert.equal(record.customer_id, "CUST-0001");
  assert.equal(record.property_key, "PROP-0001");
  assert.equal(record.roof_job_id, "JOB-0001");
  assert.equal(record.asset_ref, "ROOF-AREA-0001");
  assert.equal(record.warranty_packet_id, "WP-0001");
  assert.equal(record.origin_work_package_ref, "wp:JOB-0001:install");
  assert.equal(record.consent_ref, "CONSENT-0001");
  assert.equal(record.response_due_at, "2026-08-19T10:00:00.000Z");

  const events = await listServiceCaseEvents(appEnv, {
    tenantId: TENANT,
    serviceCaseId: "svc_case_0001",
  });
  assert.deepEqual(events.map((event) => event.event_type), ["case_opened"]);
  assert.equal(events[0]?.evidence_digest, DIGEST_INTAKE);
});

test("an emergency callback cannot be opened behind a routine response window", async () => {
  const appEnv = env();
  await assert.rejects(
    openServiceCase(appEnv, intake({ severity: "emergency", responseSlaMinutes: 1440 })),
    /service_case_emergency_sla_exceeded/,
  );

  const emergency = await openServiceCase(
    appEnv,
    intake({
      severity: "emergency",
      symptomCode: "active_leak_occupied_room",
      responseSlaMinutes: 120,
    }),
  );
  assert.equal(emergency.kind, "opened");
  assert.equal(emergency.serviceCase.severity, "emergency");
  assert.equal(emergency.serviceCase.response_sla_minutes, 120);
});

test("D1 refuses an emergency case whose SLA was widened outside the store", async () => {
  const db = new SqliteD1();
  assert.throws(
    () =>
      db.raw.exec(
        `INSERT INTO service_cases (
          service_case_id, tenant_id, customer_id, property_key, roof_job_id, asset_ref,
          warranty_packet_id, origin_work_package_ref, severity, symptom_code, reported_channel,
          consent_ref, intake_evidence_digest, response_sla_minutes, response_due_at, state, version,
          last_event_type, last_transition_code, last_evidence_digest, duplicate_of_case_id,
          closure_reason, closed_at, reopen_count, opened_by_user_id, last_actor_user_id,
          created_at, updated_at
        ) VALUES (
          'svc_case_bypass', 'ironwrap', 'CUST-0001', 'PROP-0001', 'JOB-0001', NULL, NULL, NULL,
          'emergency', 'active_leak', 'phone', 'CONSENT-0001', '${DIGEST_INTAKE}', 1440,
          '2026-08-19T10:00:00.000Z', 'intake', 1, 'case_opened', NULL, '${DIGEST_INTAKE}', NULL,
          NULL, NULL, 0, '${OWNER}', '${OWNER}', '${OPENED}', '${OPENED}'
        )`,
      ),
    /CHECK constraint failed/,
  );
});

test("a duplicate callback is linked to the live case instead of forking a second lifecycle", async () => {
  const appEnv = env();
  const first = await openServiceCase(appEnv, intake());
  assert.equal(first.kind, "opened");

  const second = await openServiceCase(
    appEnv,
    intake({
      serviceCaseId: "svc_case_0002",
      reportedChannel: "portal",
      now: "2026-08-18T10:30:00.000Z",
      intakeCode: "duplicate_callback",
    }),
  );
  assert.equal(second.kind, "duplicate");
  if (second.kind !== "duplicate") return;
  assert.equal(second.original.service_case_id, "svc_case_0001");
  assert.equal(second.serviceCase.state, "closed");
  assert.equal(second.serviceCase.closure_reason, "duplicate");
  assert.equal(second.serviceCase.duplicate_of_case_id, "svc_case_0001");

  // The original lifecycle is untouched and still the only live case for the symptom.
  const original = await getServiceCase(appEnv, { tenantId: TENANT, serviceCaseId: "svc_case_0001" });
  assert.equal(original?.state, "intake");
  assert.equal(original?.version, 1);
  const duplicateEvents = await listServiceCaseEvents(appEnv, {
    tenantId: TENANT,
    serviceCaseId: "svc_case_0002",
  });
  assert.deepEqual(duplicateEvents.map((event) => event.event_type), ["duplicate_linked"]);
});

test("triage records a model advisory but the final category always carries a named human", async () => {
  const appEnv = env();
  await openServiceCase(appEnv, intake());
  const { triage, serviceCase } = await triaged(appEnv);
  assert.equal(triage.advisory_source, "model");
  assert.equal(triage.advisory_category, "workmanship");
  assert.equal(triage.advisory_confidence_bps, 8200);
  assert.equal(triage.authority_kind, "human");
  assert.equal(triage.decided_by_user_id, SUPERVISOR);
  assert.equal(serviceCase.state, "triaged");
  assert.equal(serviceCase.version, 2);
});

test("D1 refuses a triage decision that claims model final authority", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  await openServiceCase(appEnv, intake());
  assert.throws(
    () =>
      db.raw.exec(
        `INSERT INTO service_case_triage (
          triage_id, service_case_id, tenant_id, case_version, advisory_source, advisory_category,
          advisory_confidence_bps, final_category, responsibility, authority_kind,
          decided_by_user_id, decided_by_role, evidence_digest, decided_at, created_at
        ) VALUES (
          'svc_triage_model', 'svc_case_0001', 'ironwrap', 1, 'model', 'workmanship', 9900,
          'workmanship', 'ironwrap_workmanship', 'model', '${SUPERVISOR}', 'agent',
          '${DIGEST_TRIAGE}', '${OPENED}', '${OPENED}'
        )`,
      ),
    /CHECK constraint failed/,
  );
});

test("a no-fault unknown triage cannot assign blame and cannot be diagnosed into remedy work", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  await openServiceCase(appEnv, intake());
  const { triage, serviceCase } = await triaged(appEnv, {
    finalCategory: "unknown",
    responsibility: "undetermined",
  });
  assert.equal(triage.final_category, "unknown");
  assert.equal(triage.responsibility, "undetermined");
  assert.equal(serviceCase.state, "triaged");

  await assert.rejects(diagnosed(appEnv), /service_case_diagnosis_requires_actionable_triage/);

  const closed = await closeServiceCase(appEnv, {
    tenantId: TENANT,
    serviceCaseId: "svc_case_0001",
    closureReason: "no_fault_unknown",
    detailCode: "no_defect_observed",
    evidenceDigest: DIGEST_TRIAGE,
    actorUserId: SUPERVISOR,
    now: "2026-08-18T14:00:00.000Z",
  });
  assert.equal(closed.state, "closed");
  assert.equal(closed.closure_reason, "no_fault_unknown");

  const events = await listServiceCaseEvents(appEnv, {
    tenantId: TENANT,
    serviceCaseId: "svc_case_0001",
  });
  assert.deepEqual(events.map((event) => event.event_type), ["case_opened", "triaged", "closed"]);
});

test("the accepted path reconciles diagnosis, work package, remedy, verification, and acceptance", async () => {
  const appEnv = env();
  await openServiceCase(appEnv, intake());
  await triaged(appEnv);
  const { diagnosis } = await diagnosed(appEnv);
  assert.equal(diagnosis.work_package_ref, "wp:JOB-0001:service-001");
  assert.equal(diagnosis.warranty_reserve_cents, 120_000);

  await remedyIssued(appEnv);
  const verified = await verifyServiceRemedy(appEnv, {
    tenantId: TENANT,
    serviceCaseId: "svc_case_0001",
    remedyId: "svc_remedy_0001",
    fieldEvidenceDigest: DIGEST_FIELD,
    costActualCents: 96_500,
    verifiedByUserId: SUPERVISOR,
    outcome: "verified",
    now: "2026-08-19T19:30:00.000Z",
  });
  assert.equal(verified.remedy.verification_state, "verified");
  assert.equal(verified.serviceCase.state, "remedy_verified");

  const accepted = await recordCustomerServiceDecision(appEnv, {
    tenantId: TENANT,
    serviceCaseId: "svc_case_0001",
    remedyId: "svc_remedy_0001",
    decision: "accepted",
    acceptanceRef: "ACCEPT-0001",
    evidenceDigest: DIGEST_CUSTOMER,
    actorUserId: OWNER,
    now: "2026-08-20T09:00:00.000Z",
  });
  assert.equal(accepted.remedy.customer_acceptance_state, "accepted");
  assert.equal(accepted.serviceCase.state, "customer_accepted");

  const closed = await closeServiceCase(appEnv, {
    tenantId: TENANT,
    serviceCaseId: "svc_case_0001",
    closureReason: "remedied_accepted",
    evidenceDigest: DIGEST_CUSTOMER,
    actorUserId: OWNER,
    now: "2026-08-20T09:05:00.000Z",
  });
  assert.equal(closed.state, "closed");

  const summary = await summarizeServiceCaseCost(appEnv, {
    tenantId: TENANT,
    serviceCaseId: "svc_case_0001",
  });
  assert.equal(summary.warranty_reserve_cents, 120_000);
  assert.equal(summary.actual_cost_cents, 96_500);
  assert.equal(summary.recovered_cents, 0);
  assert.equal(summary.net_cost_cents, 96_500);

  const events = await listServiceCaseEvents(appEnv, {
    tenantId: TENANT,
    serviceCaseId: "svc_case_0001",
  });
  assert.deepEqual(events.map((event) => event.event_type), [
    "case_opened",
    "triaged",
    "diagnosed",
    "remedy_issued",
    "remedy_verified",
    "customer_accepted",
    "closed",
  ]);
});

test("a failed remedy keeps its failure evidence and returns the case to diagnosis for rework", async () => {
  const appEnv = env();
  await openServiceCase(appEnv, intake());
  await triaged(appEnv);
  await diagnosed(appEnv);
  await remedyIssued(appEnv);

  const failed = await verifyServiceRemedy(appEnv, {
    tenantId: TENANT,
    serviceCaseId: "svc_case_0001",
    remedyId: "svc_remedy_0001",
    fieldEvidenceDigest: DIGEST_FIELD,
    costActualCents: 41_000,
    verifiedByUserId: SUPERVISOR,
    outcome: "failed",
    failureCode: "leak_reproduced_under_test",
    now: "2026-08-19T19:30:00.000Z",
  });
  assert.equal(failed.remedy.verification_state, "failed");
  assert.equal(failed.remedy.failure_code, "leak_reproduced_under_test");
  assert.equal(failed.serviceCase.state, "diagnosed");

  // A failed verification is final on that attempt: it cannot be quietly re-verified.
  await assert.rejects(
    verifyServiceRemedy(appEnv, {
      tenantId: TENANT,
      serviceCaseId: "svc_case_0001",
      remedyId: "svc_remedy_0001",
      fieldEvidenceDigest: DIGEST_FIELD,
      costActualCents: 41_000,
      verifiedByUserId: SUPERVISOR,
      outcome: "verified",
      now: "2026-08-19T20:00:00.000Z",
    }),
    /service_case_remedy_verification_not_recorded/,
  );

  // Rework is a second diagnosis against the same human triage decision.
  const rework = await recordServiceDiagnosis(appEnv, {
    diagnosisId: "svc_diag_0002",
    tenantId: TENANT,
    serviceCaseId: "svc_case_0001",
    triageId: "svc_triage_0001",
    rootCauseCode: "underlayment_termination_short",
    correctiveActionCode: "extend_underlayment",
    recurrenceOfCaseId: null,
    workPackageRef: "wp:JOB-0001:service-002",
    workPackageVersion: 1,
    warrantyReserveCents: 80_000,
    evidenceDigest: DIGEST_DIAGNOSIS,
    diagnosedByUserId: SUPERVISOR,
    now: "2026-08-20T08:00:00.000Z",
  });
  assert.equal(rework.diagnosis.work_package_ref, "wp:JOB-0001:service-002");
  assert.equal(rework.serviceCase.state, "diagnosed");
  // The first diagnosis is superseded, not overwritten.
  const priorDiagnosis = await appEnv.DB.prepare(
    `SELECT work_package_ref FROM service_case_diagnoses WHERE diagnosis_id = ?`,
  ).bind("svc_diag_0001").first<{ work_package_ref: string }>();
  assert.equal(priorDiagnosis?.work_package_ref, "wp:JOB-0001:service-001");

  const events = await listServiceCaseEvents(appEnv, {
    tenantId: TENANT,
    serviceCaseId: "svc_case_0001",
  });
  assert.ok(events.some((event) => event.event_type === "remedy_failed"));
  assert.equal(
    events.find((event) => event.event_type === "remedy_failed")?.detail_code,
    "leak_reproduced_under_test",
  );
});

test("a customer dispute is a first-class outcome that preserves the verification evidence", async () => {
  const appEnv = env();
  await openServiceCase(appEnv, intake());
  await triaged(appEnv);
  await diagnosed(appEnv);
  await remedyIssued(appEnv);
  await verifyServiceRemedy(appEnv, {
    tenantId: TENANT,
    serviceCaseId: "svc_case_0001",
    remedyId: "svc_remedy_0001",
    fieldEvidenceDigest: DIGEST_FIELD,
    costActualCents: 96_500,
    verifiedByUserId: SUPERVISOR,
    outcome: "verified",
    now: "2026-08-19T19:30:00.000Z",
  });

  const disputed = await recordCustomerServiceDecision(appEnv, {
    tenantId: TENANT,
    serviceCaseId: "svc_case_0001",
    remedyId: "svc_remedy_0001",
    decision: "disputed",
    disputeCode: "stain_still_visible",
    evidenceDigest: DIGEST_CUSTOMER,
    actorUserId: OWNER,
    now: "2026-08-20T09:00:00.000Z",
  });
  assert.equal(disputed.serviceCase.state, "disputed");
  assert.equal(disputed.remedy.customer_acceptance_state, "disputed");
  assert.equal(disputed.remedy.dispute_code, "stain_still_visible");
  // The supervisor's verification is not rewritten by the customer's disagreement.
  assert.equal(disputed.remedy.verification_state, "verified");
  assert.equal(disputed.remedy.field_evidence_digest, DIGEST_FIELD);

  // A disputed case can never be closed as remedied-and-accepted.
  await assert.rejects(
    closeServiceCase(appEnv, {
      tenantId: TENANT,
      serviceCaseId: "svc_case_0001",
      closureReason: "remedied_accepted",
      evidenceDigest: DIGEST_CUSTOMER,
      actorUserId: OWNER,
      now: "2026-08-20T10:00:00.000Z",
    }),
    /service_case_closure_reason_not_allowed/,
  );
});

test("a manufacturer claim records a governed pending intent while execution is unconfigured", async () => {
  const appEnv = env();
  await openServiceCase(appEnv, intake());
  await triaged(appEnv, { finalCategory: "material_manufacturer", responsibility: "manufacturer" });
  await diagnosed(appEnv);

  const intent = await openCostRecoveryClaim(appEnv, {
    claimId: "svc_recovery_0001",
    tenantId: TENANT,
    serviceCaseId: "svc_case_0001",
    diagnosisId: "svc_diag_0001",
    counterpartyKind: "manufacturer",
    counterpartyRef: "SUP-SHINGLE-CO",
    claimBasisCode: "material_defect_granule_loss",
    claimedAmountCents: 150_000,
    evidenceDigest: DIGEST_RECOVERY,
    actorUserId: OWNER,
    actorRole: "owner",
    deadlineAt: "2026-09-19T09:10:00.000Z",
    now: "2026-08-20T09:10:00.000Z",
  });
  assert.equal(intent.kind, "opened");
  const claim = intent.claim;
  assert.equal(claim.state, "pending");
  assert.equal(claim.attempt_count, 0);
  assert.equal(claim.attempt_mode, "none");
  // The governance facts IRO-38's `external_effects` demands NOT NULL are captured at creation.
  assert.equal(claim.actor_user_id, OWNER);
  assert.equal(claim.actor_role, "owner");
  assert.equal(claim.authority_ref, "svc_triage_0001");
  assert.equal(claim.correlation_id, "svc-case:svc_case_0001");
  assert.match(claim.request_hash, /^[0-9a-f]{64}$/);
  assert.equal(claim.idempotency_key, `svc-recovery:${claim.request_hash.slice(0, 48)}`);
  assert.equal(claim.deadline_at, "2026-09-19T09:10:00.000Z");

  const events = await appEnv.DB.prepare(
    `SELECT event_type FROM service_cost_recovery_events WHERE claim_id = ? ORDER BY event_id`,
  ).bind("svc_recovery_0001").all<{ event_type: string }>();
  assert.deepEqual(events.results.map((row) => row.event_type), ["intent_recorded"]);
});

test("recovery is refused where triage kept responsibility inside IronWrap's own crews", async () => {
  const appEnv = env();
  await openServiceCase(appEnv, intake());
  await triaged(appEnv);
  await diagnosed(appEnv);

  await assert.rejects(
    openCostRecoveryClaim(appEnv, {
      claimId: "svc_recovery_0002",
      tenantId: TENANT,
      serviceCaseId: "svc_case_0001",
      diagnosisId: "svc_diag_0001",
      counterpartyKind: "manufacturer",
      counterpartyRef: "SUP-SHINGLE-CO",
      claimBasisCode: "material_defect_granule_loss",
      claimedAmountCents: 150_000,
      evidenceDigest: DIGEST_RECOVERY,
      actorUserId: OWNER,
      actorRole: "owner",
      deadlineAt: "2026-09-19T09:10:00.000Z",
      now: "2026-08-20T09:10:00.000Z",
    }),
    /service_cost_recovery_responsibility_required/,
  );
});

test("a legacy uncertain recovery remains safely reconcilable while new execution is disabled", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  await openServiceCase(appEnv, intake());
  await triaged(appEnv, { finalCategory: "material_manufacturer", responsibility: "supplier" });
  await diagnosed(appEnv);
  await openCostRecoveryClaim(appEnv, {
    claimId: "svc_recovery_0003",
    tenantId: TENANT,
    serviceCaseId: "svc_case_0001",
    diagnosisId: "svc_diag_0001",
    counterpartyKind: "supplier",
    counterpartyRef: "SUP-METAL-CO",
    claimBasisCode: "short_shipped_coil",
    claimedAmountCents: 90_000,
    evidenceDigest: DIGEST_RECOVERY,
    actorUserId: OWNER,
    actorRole: "owner",
    deadlineAt: "2026-09-19T09:10:00.000Z",
    now: "2026-08-20T09:10:00.000Z",
  });

  // Preserve a row an older deployment had already leased and classified as unknown. This is
  // historical compatibility setup, not a production execution path in the current source.
  db.raw.prepare(
    `UPDATE service_cost_recovery_claims
     SET state = 'leased', attempt_count = 1, attempt_mode = 'leased',
         lease_ref = idempotency_key, lease_expires_at = ?, attempted_at = ?, updated_at = ?
     WHERE claim_id = ?`,
  ).run(
    "2026-08-20T10:20:00.000Z",
    "2026-08-20T09:20:00.000Z",
    "2026-08-20T09:20:00.000Z",
    "svc_recovery_0003",
  );
  db.raw.prepare(
    `UPDATE service_cost_recovery_claims
     SET state = 'uncertain', lease_expires_at = NULL, result_ref = ?, result_code = ?,
         updated_at = ?
     WHERE claim_id = ?`,
  ).run(
    "supplier-claim:unknown",
    "submission_timeout",
    "2026-08-20T09:21:00.000Z",
    "svc_recovery_0003",
  );

  const reconciled = await reconcileCostRecoveryEffect(appEnv, {
    tenantId: TENANT,
    claimId: "svc_recovery_0003",
    outcome: "executed",
    reconciliationRef: "supplier-statement:2026-08",
    recoveredAmountCents: 75_000,
    now: "2026-08-21T09:00:00.000Z",
  });
  assert.equal(reconciled.state, "reconciled");
  assert.equal(reconciled.reconciliation_outcome, "executed");
  assert.equal(reconciled.recovered_amount_cents, 75_000);

  const replayedReconciliation = await reconcileCostRecoveryEffect(appEnv, {
    tenantId: TENANT,
    claimId: "svc_recovery_0003",
    outcome: "executed",
    reconciliationRef: "supplier-statement:2026-08",
    recoveredAmountCents: 75_000,
    now: "2026-08-21T09:05:00.000Z",
  });
  assert.equal(replayedReconciliation.reconciled_at, reconciled.reconciled_at);

  await assert.rejects(
    reconcileCostRecoveryEffect(appEnv, {
      tenantId: TENANT,
      claimId: "svc_recovery_0003",
      outcome: "not_executed",
      reconciliationRef: "supplier-statement:corrected",
      now: "2026-08-21T09:10:00.000Z",
    }),
    /service_cost_recovery_reconcile_conflict/,
  );

  const summary = await summarizeServiceCaseCost(appEnv, {
    tenantId: TENANT,
    serviceCaseId: "svc_case_0001",
  });
  assert.equal(summary.recovered_cents, 75_000);
});

test("reopening a closed case corrects it forward and never erases the closure history", async () => {
  const appEnv = env();
  await openServiceCase(appEnv, intake());
  await triaged(appEnv, { finalCategory: "unknown", responsibility: "undetermined" });
  await closeServiceCase(appEnv, {
    tenantId: TENANT,
    serviceCaseId: "svc_case_0001",
    closureReason: "no_fault_unknown",
    detailCode: "no_defect_observed",
    evidenceDigest: DIGEST_TRIAGE,
    actorUserId: SUPERVISOR,
    now: "2026-08-18T14:00:00.000Z",
  });

  const reopened = await reopenServiceCase(appEnv, {
    tenantId: TENANT,
    serviceCaseId: "svc_case_0001",
    reopenCode: "leak_returned_after_rain",
    actorUserId: OWNER,
    now: "2026-09-02T08:00:00.000Z",
  });
  assert.equal(reopened.state, "reopened");
  assert.equal(reopened.reopen_count, 1);
  assert.equal(reopened.closure_reason, null);
  assert.equal(reopened.closed_at, null);

  const events = await listServiceCaseEvents(appEnv, {
    tenantId: TENANT,
    serviceCaseId: "svc_case_0001",
  });
  // The closure that came before is still in the ledger, with its own version and evidence.
  assert.deepEqual(events.map((event) => event.event_type), [
    "case_opened",
    "triaged",
    "closed",
    "reopened",
  ]);
  assert.equal(events.find((event) => event.event_type === "closed")?.detail_code, "no_defect_observed");

  // A reopened case re-enters triage under a new human decision.
  const retriaged = await triaged(appEnv, { triageId: "svc_triage_0002", finalCategory: "workmanship" });
  assert.equal(retriaged.serviceCase.state, "triaged");
  assert.equal(retriaged.triage.case_version, reopened.version);
});

test("service history is append-only: no lifecycle row may be deleted or edited after the fact", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  await openServiceCase(appEnv, intake());
  await triaged(appEnv);

  assert.throws(
    () => db.raw.exec("DELETE FROM service_cases WHERE service_case_id = 'svc_case_0001'"),
    /service_cases_append_only/,
  );
  assert.throws(
    () => db.raw.exec("DELETE FROM service_case_events"),
    /service_case_events_append_only/,
  );
  assert.throws(
    () => db.raw.exec("UPDATE service_case_events SET detail_code = 'rewritten'"),
    /service_case_events_immutable/,
  );
  assert.throws(
    () => db.raw.exec("UPDATE service_case_triage SET final_category = 'excluded'"),
    /service_case_triage_immutable/,
  );
  assert.throws(
    () =>
      db.raw.exec(
        "UPDATE service_cases SET roof_job_id = 'JOB-9999', version = version + 1 WHERE service_case_id = 'svc_case_0001'",
      ),
    /service_case_binding_immutable/,
  );
  assert.throws(
    () =>
      db.raw.exec(
        `UPDATE service_cases
         SET state = 'closed', last_event_type = 'closed', closure_reason = 'excluded',
             closed_at = '2026-08-18T15:00:00.000Z', updated_at = '2026-08-18T15:00:00.000Z'
         WHERE service_case_id = 'svc_case_0001'`,
      ),
    /service_case_version_step_required/,
  );

  // An otherwise well-formed step still cannot invent a transition the lifecycle does not allow.
  assert.throws(
    () =>
      db.raw.exec(
        `UPDATE service_cases
         SET state = 'customer_accepted', version = version + 1, last_event_type = 'customer_accepted',
             last_evidence_digest = '${DIGEST_CUSTOMER}', updated_at = '2026-08-18T15:00:00.000Z'
         WHERE service_case_id = 'svc_case_0001'`,
      ),
    /service_case_transition_not_allowed/,
  );
});

test("an emergency case cannot carry a due time beyond its ceiling, whatever minutes it declares", async () => {
  const db = new SqliteD1();
  // The declared SLA is inside the ceiling; the timestamp an SLA sweeper would read is a month out.
  assert.throws(
    () =>
      db.raw.exec(
        `INSERT INTO service_cases (
          service_case_id, tenant_id, customer_id, property_key, roof_job_id, asset_ref,
          warranty_packet_id, origin_work_package_ref, severity, symptom_code, reported_channel,
          consent_ref, intake_evidence_digest, response_sla_minutes, response_due_at, state, version,
          last_event_type, last_transition_code, last_evidence_digest, duplicate_of_case_id,
          closure_reason, closed_at, reopen_count, opened_by_user_id, last_actor_user_id,
          created_at, updated_at
        ) VALUES (
          'svc_case_widened', 'ironwrap', 'CUST-0001', 'PROP-0001', 'JOB-0001', NULL, NULL, NULL,
          'emergency', 'active_leak', 'phone', 'CONSENT-0001', '${DIGEST_INTAKE}', 60,
          '2026-09-17T09:00:00.000Z', 'intake', 1, 'case_opened', NULL, '${DIGEST_INTAKE}', NULL,
          NULL, NULL, 0, '${OWNER}', '${OWNER}', '${OPENED}', '${OPENED}'
        )`,
      ),
    /CHECK constraint failed/,
  );

  // The store derives the due time from the declared window, so the two can never disagree.
  const appEnv = env(db);
  const opened = await openServiceCase(
    appEnv,
    intake({ severity: "emergency", symptomCode: "active_leak", responseSlaMinutes: 240 }),
  );
  assert.equal(opened.kind, "opened");
  assert.equal(opened.serviceCase.response_due_at, "2026-08-18T14:00:00.000Z");
});

test("a duplicate-linked case can never be reopened into a second live lifecycle", async () => {
  const appEnv = env();
  await openServiceCase(appEnv, intake());
  const duplicate = await openServiceCase(
    appEnv,
    intake({ serviceCaseId: "svc_case_0002", now: "2026-08-18T10:30:00.000Z" }),
  );
  assert.equal(duplicate.kind, "duplicate");

  // Reopening would drop the closure reason while the duplicate link stays, which is exactly the
  // second competing lifecycle the design refuses.
  await assert.rejects(
    reopenServiceCase(appEnv, {
      tenantId: TENANT,
      serviceCaseId: "svc_case_0002",
      reopenCode: "customer_called_back",
      actorUserId: OWNER,
      now: "2026-08-21T09:00:00.000Z",
    }),
    /CHECK constraint failed/,
  );

  const stillClosed = await getServiceCase(appEnv, {
    tenantId: TENANT,
    serviceCaseId: "svc_case_0002",
  });
  assert.equal(stillClosed?.state, "closed");
  assert.equal(stillClosed?.closure_reason, "duplicate");
});

/**
 * Two first reports of the same symptom that both pass the read-then-write duplicate check. The
 * partial unique index is the real fence; the loser must surface as a linked duplicate, not as a
 * raw `UNIQUE constraint failed`.
 */
class RacingSqliteD1 extends SqliteD1 {
  raced = false;

  prepare(sql: string) {
    const statement = super.prepare(sql);
    if (!sql.includes("state != 'closed'")) return statement;
    return {
      bind: (...args: unknown[]) => {
        const bound = statement.bind(...args);
        return {
          ...bound,
          first: async <T>(): Promise<T | null> => {
            if (!this.raced) {
              this.raced = true;
              this.raw.exec(
                `INSERT INTO service_cases (
                  service_case_id, tenant_id, customer_id, property_key, roof_job_id, asset_ref,
                  warranty_packet_id, origin_work_package_ref, severity, symptom_code,
                  reported_channel, consent_ref, intake_evidence_digest, response_sla_minutes,
                  response_due_at, state, version, last_event_type, last_transition_code,
                  last_evidence_digest, duplicate_of_case_id, closure_reason, closed_at,
                  reopen_count, opened_by_user_id, last_actor_user_id, created_at, updated_at
                ) VALUES (
                  'svc_case_winner', 'ironwrap', 'CUST-0001', 'PROP-0001', 'JOB-0001', NULL, NULL,
                  NULL, 'standard', 'interior_water_stain', 'phone', 'CONSENT-0001',
                  '${DIGEST_INTAKE}', 1440, '2026-08-19T10:00:00.000Z', 'intake', 1, 'case_opened',
                  NULL, '${DIGEST_INTAKE}', NULL, NULL, NULL, 0, '${OWNER}', '${OWNER}',
                  '${OPENED}', '${OPENED}'
                )`,
              );
              return null;
            }
            return await bound.first<T>();
          },
        };
      },
    };
  }
}

test("a concurrent first report of the same symptom is linked, not surfaced as a constraint failure", async () => {
  const appEnv = env(new RacingSqliteD1());
  const result = await openServiceCase(appEnv, intake());
  assert.equal(result.kind, "duplicate");
  if (result.kind !== "duplicate") return;
  assert.equal(result.original.service_case_id, "svc_case_winner");
  assert.equal(result.serviceCase.service_case_id, "svc_case_0001");
  assert.equal(result.serviceCase.state, "closed");
  assert.equal(result.serviceCase.closure_reason, "duplicate");
  assert.equal(result.serviceCase.duplicate_of_case_id, "svc_case_winner");
});

test("the same cost-recovery claim requested twice records one intent, not two attempts at the same money", async () => {
  const appEnv = env();
  await openServiceCase(appEnv, intake());
  await triaged(appEnv, { finalCategory: "material_manufacturer", responsibility: "manufacturer" });
  await diagnosed(appEnv);

  const request = {
    tenantId: TENANT,
    serviceCaseId: "svc_case_0001",
    diagnosisId: "svc_diag_0001",
    counterpartyKind: "manufacturer" as const,
    counterpartyRef: "SUP-SHINGLE-CO",
    claimBasisCode: "material_defect_granule_loss",
    claimedAmountCents: 150_000,
    evidenceDigest: DIGEST_RECOVERY,
    actorUserId: OWNER,
    actorRole: "owner" as const,
    deadlineAt: "2026-09-19T09:10:00.000Z",
    now: "2026-08-20T09:10:00.000Z",
  };
  const first = await openCostRecoveryClaim(appEnv, { ...request, claimId: "svc_recovery_0001" });
  assert.equal(first.kind, "opened");
  const second = await openCostRecoveryClaim(appEnv, { ...request, claimId: "svc_recovery_0002" });
  assert.equal(second.kind, "already_recorded");
  assert.equal(second.claim.claim_id, "svc_recovery_0001");

  const rows = await appEnv.DB.prepare(
    `SELECT COUNT(*) AS total FROM service_cost_recovery_claims WHERE service_case_id = ?`,
  ).bind("svc_case_0001").first<{ total: number }>();
  assert.equal(Number(rows?.total ?? 0), 1);
});
