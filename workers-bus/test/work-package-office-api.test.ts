import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import {
  recordAuthorityReadback,
  type RecordAuthorityReadbackInput,
} from "../src/authority-records.ts";
import {
  permissionsForRole,
  type AppEnv,
  type AppRole,
  type AuthContext,
} from "../src/app-types.ts";
import {
  issueNativeWorkPackage as issueNativeWorkPackageStore,
  nativeWorkPackageAction,
  type NativeWorkPackageDefinition,
} from "../src/work-package-store.ts";
import { handleWorkPackageAction } from "../src/work-package-actions.ts";
import { reportSafetyOccurrence } from "../src/safety-lifecycle.ts";
import {
  currentWorkPackageAuthorityResolution,
  currentWorkPackageAuthorityDenials,
  fieldWorkPackageForAssignment,
  fieldWorkPackageProjection,
} from "../src/work-package.ts";
import {
  getCurrentOperatingJobAssignment,
  recordOperatingJobAssignment,
} from "../src/operating-job-assignment-store.ts";
import { recordOperatingWorkObjectAssignment } from "../src/operating-work-object-assignment-store.ts";

const OFFICE_ASSIGNMENT_ID = (() => {
  const idempotencyHash = sha256("office-native-assignment-0001");
  return `assignment:${sha256(`ironwrap:${idempotencyHash}`).slice(0, 40)}`;
})();
const OFFICE_WORK_PACKAGE_ID = `wp_${sha256(
  `ironwrap:JOB-NATIVE-OFFICE:${OFFICE_ASSIGNMENT_ID}:1`,
).slice(0, 32)}`;
const TYPED_ASSIGNMENT_ID = (() => {
  const idempotencyHash = sha256("office-native-typed-assignment-0001");
  return `assignment:${sha256(`ironwrap:${idempotencyHash}`).slice(0, 40)}`;
})();
const TYPED_WORK_PACKAGE_ID = `wp_${sha256(
  `ironwrap:SHOP-NATIVE-OFFICE:${TYPED_ASSIGNMENT_ID}:1`,
).slice(0, 32)}`;

function authorityRequirements(
  workPackageId = OFFICE_WORK_PACKAGE_ID,
  subjectRef = "crew@example.com",
) {
  return [
    {
      subject_type: "Person" as const,
      subject_role: "Worker" as const,
      subject_ref: subjectRef,
      authority_kind: "Worker Competency" as const,
      authority_scope: "field installation",
      scope_type: "Work Package" as const,
      scope_ref: workPackageId,
      issuer_name: "IronWrap Production",
      issuer_jurisdiction: "AB-CA",
      issuer_reference: `internal:competency:${subjectRef}`,
      source_version: "2026-08-20",
    },
  ];
}

class TestD1 {
  readonly sqlite = new DatabaseSync(":memory:");
  private beforeEventInsert: {
    deviceActionId: string;
    callback: () => Promise<void>;
  } | null = null;

  beforeEventInsertOnce(
    deviceActionId: string,
    callback: () => Promise<void>,
  ): void {
    this.beforeEventInsert = { deviceActionId, callback };
  }

  prepare(sql: string) {
    const sqlite = this.sqlite;
    const database = this;
    return {
      bind(...values: unknown[]) {
        return {
          all<T>() {
            return { results: sqlite.prepare(sql).all(...values) as T[] };
          },
          first<T>() {
            return (
              (sqlite.prepare(sql).get(...values) as T | undefined) ?? null
            );
          },
          run() {
            const execute = () => {
              const result = sqlite.prepare(sql).run(...values);
              return { meta: { changes: Number(result.changes) } };
            };
            const hook = database.beforeEventInsert;
            if (
              hook &&
              /INSERT INTO work_package_events/.test(sql) &&
              values[14] === hook.deviceActionId
            ) {
              database.beforeEventInsert = null;
              return hook.callback().then(execute);
            }
            return execute();
          },
        };
      },
    };
  }

  async batch(statements: Array<{ run(): unknown }>) {
    this.sqlite.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

class MemoryR2 {
  readonly objects = new Map<
    string,
    {
      body: string;
      size: number;
      checksum: string;
      contentType: string;
    }
  >();

  async head(key: string) {
    const value = this.objects.get(key);
    return value
      ? {
          size: value.size,
          customMetadata: { sha256: value.checksum },
          checksums: { sha256: hexBytes(value.checksum).buffer },
          httpMetadata: { contentType: value.contentType },
        }
      : null;
  }

  async put(
    key: string,
    body: Blob | string,
    options: {
      httpMetadata?: { contentType?: string };
      customMetadata?: { sha256?: string };
    },
  ) {
    const text = typeof body === "string" ? body : await body.text();
    this.objects.set(key, {
      body: text,
      size: new TextEncoder().encode(text).byteLength,
      checksum: options.customMetadata?.sha256 ?? "",
      contentType:
        options.httpMetadata?.contentType ?? "application/octet-stream",
    });
    return { key };
  }
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(
    value.match(/.{1,2}/g)?.map((pair) => Number.parseInt(pair, 16)) ?? [],
  );
}

function env(): AppEnv & { DB: TestD1; RAW: MemoryR2 } {
  const DB = new TestD1();
  DB.sqlite.exec("PRAGMA foreign_keys = ON");
  for (const name of readdirSync(new URL("../migrations/", import.meta.url))
    .filter((value) => /^\d{4}_.+\.sql$/.test(value))
    .sort()) {
    DB.sqlite.exec(
      readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"),
    );
  }
  const now = "2026-08-20T08:00:00.000Z";
  DB.sqlite
    .prepare(
      `INSERT INTO app_users
      (user_id, tenant_id, email_normalized, display_name, role, access_role, active, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(
      "appu_owner_native",
      "ironwrap",
      "owner@example.com",
      "Native Owner",
      "owner",
      "owner",
      "owner@example.com",
      now,
      now,
    );
  DB.sqlite
    .prepare(
      `INSERT INTO app_users
      (user_id, tenant_id, email_normalized, display_name, role, access_role, active, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(
      "appu_production_native",
      "ironwrap",
      "production@example.com",
      "Native Production",
      "ops",
      "production",
      "owner@example.com",
      now,
      now,
    );
  DB.sqlite
    .prepare(
      `INSERT INTO app_users
      (user_id, tenant_id, email_normalized, display_name, role, access_role, frappe_user_id, active, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(
      "appu_crew_native",
      "ironwrap",
      "crew@example.com",
      "Native Crew",
      "field",
      "field",
      "crew@example.com",
      "owner@example.com",
      now,
      now,
    );
  return {
    APP_TENANT_ID: "ironwrap",
    DB,
    RAW: new MemoryR2(),
  } as unknown as AppEnv & { DB: TestD1; RAW: MemoryR2 };
}

function auth(role: AppRole): AuthContext {
  const email =
    role === "production"
      ? "production@example.com"
      : role === "field"
        ? "crew@example.com"
        : `${role}@example.com`;
  const userId =
    role === "production"
      ? "appu_production_native"
      : role === "field"
        ? "appu_crew_native"
        : "appu_owner_native";
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: permissionsForRole(role),
    session: {
      session_hash: "a".repeat(64),
      session_created_at: "2026-08-20T08:00:00.000Z",
      session_expires_at: "2026-08-21T08:00:00.000Z",
      revoked_at: null,
      user_id: userId,
      tenant_id: "ironwrap",
      email_normalized: email,
      display_name: role,
      role,
      frappe_user_id: email,
      active: 1,
      created_by: "owner@example.com",
      created_at: "2026-08-20T08:00:00.000Z",
      updated_at: "2026-08-20T08:00:00.000Z",
    },
  };
}

async function seedOperatingAssignment(appEnv: ReturnType<typeof env>) {
  const existing = await getCurrentOperatingJobAssignment(
    appEnv,
    "ironwrap",
    "JOB-NATIVE-OFFICE",
  );
  if (existing) return existing;
  const sqlite = appEnv.DB.sqlite;
  const now = "2026-08-20T07:59:00.000Z";
  sqlite
    .prepare(
      `INSERT INTO envelopes
       (envelope_id, source, contact_name, contact_email, payload_json, raw_key, ts,
        status, created_at, updated_at)
       VALUES ('ow_native_office_0001', 'manual', 'Native Customer',
               'customer@example.com', '{}', 'raw/native-office/0001.json', ?,
               'reconciled', ?, ?)`,
    )
    .run(now, now, now);
  sqlite
    .prepare(
      `INSERT INTO operating_leads
       (lead_id, tenant_id, source_envelope_id, source_raw_key, source, contact_name,
        contact_email, lifecycle_status, version, created_at, updated_at)
       VALUES ('lead:native:office:0001', 'ironwrap', 'ow_native_office_0001',
               'raw/native-office/0001.json', 'manual', 'Native Customer',
               'customer@example.com', 'qualified', 1, ?, ?)`,
    )
    .run(now, now);
  sqlite
    .prepare(
      `INSERT INTO operating_customers
       (customer_id, tenant_id, source_envelope_id, source_raw_key, display_name,
        contact_email, lifecycle_status, version, created_at, updated_at)
       VALUES ('customer:native:office:0001', 'ironwrap', 'ow_native_office_0001',
               'raw/native-office/0001.json', 'Native Customer',
               'customer@example.com', 'active', 1, ?, ?)`,
    )
    .run(now, now);
  sqlite
    .prepare(
      `INSERT INTO operating_roof_jobs
       (roof_job_id, tenant_id, lead_id, customer_id, source_envelope_id,
        source_raw_key, brand, job_number, service_type, job_status,
        current_gate_state, version, created_at, updated_at)
       VALUES ('JOB-NATIVE-OFFICE', 'ironwrap', 'lead:native:office:0001',
               'customer:native:office:0001', 'ow_native_office_0001',
               'raw/native-office/0001.json', 'ironwrap', 'IW-NATIVE-1',
               'roof_replacement', 'qualified', 'ready', 1, ?, ?)`,
    )
    .run(now, now);
  for (const gate of [
    "Deposit",
    "Materials",
    "Safety",
    "Access",
    "Weather",
    "Crew",
  ]) {
    sqlite
      .prepare(
        `INSERT INTO operating_production_gates
         (gate_id, tenant_id, roof_job_id, source_envelope_id, source_raw_key,
          gate, state, owner_user, assigned_at, due_at, blocker_reason, version,
          created_at, updated_at)
         VALUES (?, 'ironwrap', 'JOB-NATIVE-OFFICE', 'ow_native_office_0001',
                 'raw/native-office/0001.json', ?, 'ready', 'appu_owner_native',
                 ?, '2026-08-21T12:00:00.000Z', 'No active blocker', 1, ?, ?)`,
      )
      .run(`gate:native:${gate.toLowerCase()}`, gate, now, now, now);
  }
  sqlite
    .prepare(
      `INSERT INTO fleet_crews
       (crew_id, tenant_id, display_name, status, version, created_at, updated_at)
       VALUES ('crew:native:office', 'ironwrap', 'Native Crew', 'Active', 1, ?, ?)`,
    )
    .run(now, now);
  sqlite
    .prepare(
      `INSERT INTO fleet_crew_members
       (membership_id, tenant_id, crew_id, user_id, active, version, created_at, updated_at)
       VALUES ('membership:native:office', 'ironwrap', 'crew:native:office',
               'appu_crew_native', 1, 1, ?, ?)`,
    )
    .run(now, now);
  return (
    await recordOperatingJobAssignment(
      appEnv,
      {
        tenantId: "ironwrap",
        roofJobId: "JOB-NATIVE-OFFICE",
        expectedRoofJobVersion: 1,
        crewId: "crew:native:office",
        expectedCrewVersion: 1,
        authorityRequirements: authorityRequirements(),
        scheduledStart: "2026-08-20T08:00:00.000Z",
        actorUserId: "appu_owner_native",
        idempotencyKey: "office-native-assignment-0001",
      },
      new Date(now),
    )
  ).assignment;
}

function definition(): NativeWorkPackageDefinition {
  const frozenAuthorityRequirements = authorityRequirements();
  return {
    tenantId: "ironwrap",
    workPackageId: OFFICE_WORK_PACKAGE_ID,
    version: 1,
    deviceActionId: "issue-native-office-api-1",
    manifestKey: "work-packages/issue-native-office-api-1.json",
    jobId: "JOB-NATIVE-OFFICE",
    assignmentId: OFFICE_ASSIGNMENT_ID,
    assignmentVersion: 1,
    assignmentCommandFingerprint: "a".repeat(64),
    assignmentAuthorityRequirementsSha256: sha256(
      canonicalJson(frozenAuthorityRequirements),
    ),
    issueRequestSha256: "b".repeat(64),
    workObjectType: "Roof Job",
    workObjectId: "JOB-NATIVE-OFFICE",
    physicalContextType: "Roof Site",
    physicalContextId: "JOB-NATIVE-OFFICE",
    assignmentAuthorityUser: "owner@example.com",
    assignmentAuthorityRole: "IronWrap Owner",
    title: "Native office package",
    objective: "Complete the roof work safely",
    boundaries: "Only the issued roof scope",
    prerequisites: "Crew and materials are present",
    expectedResult: "Installed roof is ready for review",
    stopConditions: "Stop on unsafe conditions",
    makeSafeProcedure: "Secure the area and notify the owner",
    issuedAt: "2026-08-20T08:00:00.000Z",
    expiresAt: "2026-08-21T08:00:00.000Z",
    releasedAt: "2026-08-20T08:00:00.000Z",
    releaseAttemptId: "attempt-native-office-api",
    authorityRequirements: frozenAuthorityRequirements,
    steps: [
      {
        sequence: 1,
        instruction: "Inspect the roof deck",
        requiredEvidence: "step evidence",
        acceptanceCriteria: "Deck is safe",
      },
    ],
    holdPoints: [
      {
        sequence: 1,
        holdPoint: "Pre-start safety release",
        releasePhase: "Pre-start",
        releaseAuthority: "IronWrap Production",
        requiredEvidence: "hold evidence",
        acceptanceCriteria: "Safety is released",
      },
    ],
    assignedWorkers: [
      {
        sequence: 1,
        workerUser: "crew@example.com",
        workerRole: "Field Worker",
        required: true,
      },
    ],
    issuedByUser: "owner@example.com",
    issuedByRole: "IronWrap Owner",
  } as NativeWorkPackageDefinition;
}

async function issueNativeWorkPackage(
  appEnv: ReturnType<typeof env>,
  packet: NativeWorkPackageDefinition,
) {
  const assignment = await seedOperatingAssignment(appEnv);
  packet.assignmentId = assignment.assignment_id;
  packet.assignmentVersion = assignment.assignment_version;
  packet.assignmentCommandFingerprint = assignment.command_fingerprint;
  packet.assignmentAuthorityRequirementsSha256 =
    assignment.authority_requirements_sha256!;
  packet.authorityRequirements = assignment.authority_requirements!;
  return await issueNativeWorkPackageStore(appEnv, packet);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function recordPacketAuthority(
  appEnv: ReturnType<typeof env>,
  packet: NativeWorkPackageDefinition,
  overrides: Partial<RecordAuthorityReadbackInput> = {},
) {
  return await recordAuthorityReadback(appEnv, {
    readbackId: "Authority-Readback-Work-Package-01",
    tenantId: packet.tenantId,
    authorityRecordId: "Authority-Record-Work-Package-01",
    authorityVersion: 1,
    subjectType: "Person",
    subjectRole: "Worker",
    personUser: "crew@example.com",
    organization: null,
    authorityKind: "Worker Competency",
    authorityScope: "field installation",
    scopeType: "Work Package",
    scopeRef: packet.workPackageId,
    roofJob: packet.jobId,
    scopeJson: "{}",
    issuerName: "IronWrap Production",
    issuerJurisdiction: "AB-CA",
    issuerReference: "internal:competency:crew@example.com",
    issuerSourceVersion: "2026-08-20",
    verificationState: "verified",
    evidenceRefsJson: JSON.stringify([
      {
        ref: "r2://authority/work-package-crew.json",
        sha256: "c".repeat(64),
      },
    ]),
    evidenceSha256: "c".repeat(64),
    authorityStateDigestSha256: "e".repeat(64),
    authorityEffectiveFrom: "2026-08-01",
    authorityExpiresAt: "2027-12-31",
    authorityRevokedAt: null,
    supersedesAuthorityRecordId: null,
    authorityVerificationMethod: "Internal Competency Assessment",
    issuerReceiptSha256: null,
    observedByUserId: "appu_owner_native",
    observedAt: "2026-08-20T08:00:00.000Z",
    actionId: null,
    ...overrides,
  });
}

async function revokePacketAuthority(
  appEnv: ReturnType<typeof env>,
  packet: NativeWorkPackageDefinition,
  suffix: string,
) {
  return await recordPacketAuthority(appEnv, packet, {
    readbackId: `Authority-Readback-Work-Package-Revoked-${suffix}`,
    authorityVersion: 2,
    verificationState: "revoked",
    authorityRevokedAt: "2026-08-21T08:00:00.000Z",
    authorityVerificationMethod: null,
    evidenceRefsJson: JSON.stringify([
      {
        ref: `r2://authority/work-package-crew-revoked-${suffix}.json`,
        sha256: "d".repeat(64),
      },
    ]),
    evidenceSha256: "d".repeat(64),
    authorityStateDigestSha256: "f".repeat(64),
    observedAt: "2026-08-21T08:00:00.000Z",
  });
}

function fieldWorkPackageActionRequest(
  packet: NativeWorkPackageDefinition,
  kind: "acknowledge" | "start_work" | "stop_work",
  deviceActionId: string,
): Request {
  return new Request("https://app.example.com/api/v1/work-package-action", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": deviceActionId,
      "x-device-action-id": deviceActionId,
    },
    body: JSON.stringify({
      device_action_id: deviceActionId,
      payload: {
        work_package_id: packet.workPackageId,
        work_package_version: packet.version,
        release_attempt_id: packet.releaseAttemptId,
        ...(kind === "stop_work"
          ? { blocker_reason: "Authority state requires a safe stop" }
          : {}),
      },
    }),
  });
}

function rewriteAuthorityFixture(
  appEnv: ReturnType<typeof env>,
  packet: NativeWorkPackageDefinition,
  state: "missing" | "corrupt",
): void {
  appEnv.DB.sqlite.exec("DROP TRIGGER work_packages_projection_guard");
  const row = appEnv.DB.sqlite
    .prepare(
      `SELECT definition_json FROM work_packages
        WHERE tenant_id = ? AND work_package_id = ? AND version = ?`,
    )
    .get(packet.tenantId, packet.workPackageId, packet.version) as {
    definition_json: string;
  };
  const definition = JSON.parse(row.definition_json) as Record<string, unknown>;
  if (state === "missing") delete definition.authority_requirements;
  else definition.authority_requirements = { corrupt: true };
  appEnv.DB.sqlite
    .prepare(
      `UPDATE work_packages SET definition_json = ?
        WHERE tenant_id = ? AND work_package_id = ? AND version = ?`,
    )
    .run(
      JSON.stringify(definition),
      packet.tenantId,
      packet.workPackageId,
      packet.version,
    );
}

function authorityReadFailureEnv(
  appEnv: ReturnType<typeof env>,
): ReturnType<typeof env> {
  const source = appEnv.DB;
  const DB = {
    prepare(sql: string) {
      if (sql.includes("FROM authority_record_readbacks")) {
        throw new Error("authority_store_unreadable");
      }
      return source.prepare(sql);
    },
    batch(statements: Array<{ run(): unknown }>) {
      return source.batch(statements);
    },
  };
  return { ...appEnv, DB } as unknown as ReturnType<typeof env>;
}

function insertCapture(
  envValue: ReturnType<typeof env>,
  packet: NativeWorkPackageDefinition,
  slotId = "step:1",
  evidenceId = "evidence_step_native_office_api_1",
) {
  const sqlite = envValue.DB.sqlite;
  const now = "2026-08-20T09:00:00.000Z";
  sqlite
    .prepare(
      `INSERT INTO field_actions (
       device_action_id, tenant_id, user_id, job_id, assignment_id, action_kind,
       payload_hash, status, checkin_id, manifest_key, response_json,
       created_at, updated_at, verified_at, work_package_id, work_package_version,
       evidence_slot_id, evidence_requirement, evidence_source, evidence_device_id,
       evidence_freshness, evidence_conflict_state, evidence_verification,
       evidence_disposition, evidence_correction_of, evidence_item_correction_of,
       work_package_release_attempt_id, correction_reason, work_object_type,
       work_object_id, physical_context_type, physical_context_id,
       capture_started_at, capture_completed_at
     ) VALUES (?, ?, ?, ?, ?, 'field_checkin', ?, 'verified', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "capture-native-office-api-1",
      packet.tenantId,
      "appu_crew_native",
      packet.jobId,
      packet.assignmentId,
      "a".repeat(64),
      "checkin_native_office_api_1",
      "evidence/native-office-api-1.json",
      JSON.stringify({ status: "verified" }),
      now,
      now,
      now,
      packet.workPackageId,
      packet.version,
      slotId,
      slotId === "step:1"
        ? packet.steps[0]!.requiredEvidence
        : packet.holdPoints[0]!.requiredEvidence,
      "photo",
      "device-native-office-api",
      "Current",
      "None",
      "Verified",
      "Open",
      null,
      null,
      packet.releaseAttemptId,
      null,
      packet.workObjectType,
      packet.workObjectId,
      packet.physicalContextType,
      packet.physicalContextId,
      now,
      now,
    );
  sqlite
    .prepare(
      `INSERT INTO field_action_media (
       device_action_id, attachment_id, evidence_id, r2_key, checksum_sha256,
       content_type, content_length, r2_stored_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "capture-native-office-api-1",
      "attachment-native-office-api-1",
      evidenceId,
      "evidence/raw/native-office-api-1.jpg",
      "b".repeat(64),
      "image/jpeg",
      128,
      now,
    );
}

test("office issue freezes governed assignment authority and exact replay survives assignment drift", async () => {
  const appEnv = env();
  const assignment = await seedOperatingAssignment(appEnv);
  const issuedAt = new Date().toISOString();
  const body = {
    assignment_id: assignment.assignment_id,
    assignment_modified: assignment.created_at,
    version: 1,
    issued_at: issuedAt,
    expires_at: new Date(
      Date.parse(issuedAt) + 8 * 60 * 60 * 1_000,
    ).toISOString(),
    title: "Native office package",
    objective: "Complete the roof work safely",
    boundaries: "Only the issued roof scope",
    prerequisites: "Crew and materials are present",
    expected_result: "Installed roof is ready for review",
    stop_conditions: "Stop on unsafe conditions",
    make_safe_procedure: "Secure the area and notify the owner",
    correction_reason: null,
    steps: [
      {
        instruction: "Inspect the roof deck",
        required_evidence: "Current deck photographs",
        acceptance_criteria: "Deck is safe",
      },
    ],
    hold_points: [
      {
        hold_point: "Pre-start safety release",
        release_phase: "Pre-start",
        release_authority: "IronWrap Production",
        required_evidence: "Safety inspection evidence",
        acceptance_criteria: "Safety is released",
      },
    ],
  };
  const request = (
    value: Record<string, unknown>,
    deviceActionId = "office-work-package-issue-1",
  ) =>
    new Request(
      "https://app.example.com/api/v1/jobs/JOB-NATIVE-OFFICE/work-package",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": "csrf",
          "idempotency-key": deviceActionId,
          "x-device-action-id": deviceActionId,
        },
        body: JSON.stringify(value),
      },
    );
  const first = await handleAuthenticatedRoute(
    request(body),
    appEnv,
    auth("owner"),
  );
  const firstBody = (await first.json()) as Record<string, unknown>;
  assert.equal(first.status, 200, JSON.stringify(firstBody));
  assert.equal(firstBody.status, "verified");
  assert.equal(firstBody.server_ref, OFFICE_WORK_PACKAGE_ID);
  assert.equal(
    appEnv.DB.sqlite
      .prepare("SELECT COUNT(*) AS count FROM work_packages")
      .get().count,
    1,
  );
  assert.equal(
    appEnv.DB.sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM work_package_events WHERE event_kind = 'issued'",
      )
      .get().count,
    1,
  );
  const frozen = appEnv.DB.sqlite
    .prepare(
      "SELECT definition_json FROM work_packages WHERE work_package_id = ?",
    )
    .get(OFFICE_WORK_PACKAGE_ID) as { definition_json: string };
  assert.deepEqual(
    JSON.parse(frozen.definition_json).authority_requirements,
    authorityRequirements(),
  );

  const replay = await handleAuthenticatedRoute(
    request(body),
    appEnv,
    auth("owner"),
  );
  assert.equal(replay.status, 200, await replay.clone().text());
  assert.deepEqual(await replay.json(), firstBody);
  assert.equal(
    appEnv.DB.sqlite
      .prepare("SELECT COUNT(*) AS count FROM work_packages")
      .get().count,
    1,
  );
  assert.equal(
    appEnv.DB.sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM work_package_events WHERE event_kind = 'issued'",
      )
      .get().count,
    1,
  );
  assert.equal(
    appEnv.RAW.objects.has(
      "work-packages/office-actions/ironwrap/office-work-package-issue-1.json",
    ),
    true,
  );

  const browserAuthority = await handleAuthenticatedRoute(
    request({
      ...body,
      authority_requirements: definition().authorityRequirements,
    }),
    appEnv,
    auth("owner"),
  );
  assert.equal(browserAuthority.status, 400);
  assert.deepEqual(await browserAuthority.json(), {
    error: "invalid_work_package_issue",
  });

  const browserRoster = await handleAuthenticatedRoute(
    request({ ...body, assigned_workers: [] }),
    appEnv,
    auth("owner"),
  );
  assert.equal(browserRoster.status, 400);
  assert.deepEqual(await browserRoster.json(), {
    error: "invalid_work_package_issue",
  });

  const staleAssignment = await handleAuthenticatedRoute(
    request(
      {
        ...body,
        assignment_modified: "2026-08-20T07:58:00.000Z",
      },
      "office-work-package-issue-stale",
    ),
    appEnv,
    auth("owner"),
  );
  assert.equal(staleAssignment.status, 409);
  assert.deepEqual(await staleAssignment.json(), {
    error: "work_package_assignment_changed",
  });

  const issuedRow = appEnv.DB.sqlite
    .prepare("SELECT release_attempt_id FROM work_packages WHERE work_package_id = ?")
    .get(OFFICE_WORK_PACKAGE_ID) as { release_attempt_id: string };
  const stopped = await handleWorkPackageAction(
    fieldWorkPackageActionRequest(
      { ...definition(), releaseAttemptId: issuedRow.release_attempt_id },
      "stop_work",
      "field-stop-before-office-reissue",
    ),
    appEnv,
    auth("field"),
    "JOB-NATIVE-OFFICE",
    { name: assignment.assignment_id },
    "stop_work",
  );
  assert.equal(stopped.status, 200, await stopped.clone().text());
  const reissue = await handleAuthenticatedRoute(
    request(
      { ...body, version: 2, correction_reason: "The stop was investigated" },
      "office-work-package-issue-after-stop",
    ),
    appEnv,
    auth("owner"),
  );
  assert.equal(reissue.status, 409);
  assert.deepEqual(await reissue.json(), {
    error: "work_package_stop_release_required",
  });
  assert.equal(reissue.headers.get("cache-control"), "private, no-store");
  assert.equal(
    appEnv.DB.sqlite.prepare("SELECT COUNT(*) AS count FROM work_packages").get().count,
    1,
  );
  assert.equal(
    appEnv.DB.sqlite.prepare("SELECT COUNT(*) AS count FROM work_package_supersessions").get().count,
    0,
  );

  appEnv.DB.sqlite.exec(
    "DROP TRIGGER operating_job_assignments_append_only_update",
  );
  appEnv.DB.sqlite
    .prepare(
      `UPDATE operating_job_assignments
          SET authority_requirements_json = NULL,
              authority_requirements_sha256 = NULL
        WHERE tenant_id = 'ironwrap' AND assignment_id = ?`,
    )
    .run(assignment.assignment_id);
  const exactAfterDrift = await handleAuthenticatedRoute(
    request(body),
    appEnv,
    auth("owner"),
  );
  assert.equal(
    exactAfterDrift.status,
    200,
    await exactAfterDrift.clone().text(),
  );
  assert.deepEqual(await exactAfterDrift.json(), firstBody);

  const missingRequirements = await handleAuthenticatedRoute(
    request(body, "office-work-package-issue-missing-authority"),
    appEnv,
    auth("owner"),
  );
  assert.equal(missingRequirements.status, 409);
  assert.deepEqual(await missingRequirements.json(), {
    error: "work_package_authority_requirements_invalid",
  });
});

test("typed office issue freezes the governed physical assignment authority", async () => {
  const appEnv = env();
  const requirements = authorityRequirements(
    TYPED_WORK_PACKAGE_ID,
    "appu_crew_native",
  );
  const assignment = (
    await recordOperatingWorkObjectAssignment(
      appEnv,
      {
        tenantId: "ironwrap",
        workObjectType: "Shop Order",
        workObjectId: "SHOP-NATIVE-OFFICE",
        physicalContextType: "Shop Floor",
        physicalContextId: "SHOP-FLOOR-NATIVE-OFFICE",
        assignedUsers: ["appu_crew_native"],
        authorityRequirements: requirements,
        scheduledStart: "2026-08-20T08:00:00.000Z",
        authorityUserId: "appu_owner_native",
        authorityRole: "owner",
        actorUserId: "appu_production_native",
        idempotencyKey: "office-native-typed-assignment-0001",
      },
      new Date("2026-08-20T07:59:00.000Z"),
    )
  ).assignment;
  assert.equal(assignment.assignment_id, TYPED_ASSIGNMENT_ID);
  const issuedAt = new Date().toISOString();
  const response = await handleAuthenticatedRoute(
    new Request(
      "https://app.example.com/api/v1/work-objects/Shop%20Order/SHOP-NATIVE-OFFICE/physical-contexts/Shop%20Floor/SHOP-FLOOR-NATIVE-OFFICE/work-package",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": "csrf",
          "idempotency-key": "office-typed-work-package-issue-1",
          "x-device-action-id": "office-typed-work-package-issue-1",
        },
        body: JSON.stringify({
          assignment_id: assignment.assignment_id,
          assignment_modified: assignment.created_at,
          version: 1,
          issued_at: issuedAt,
          expires_at: new Date(
            Date.parse(issuedAt) + 8 * 60 * 60 * 1_000,
          ).toISOString(),
          title: "Native typed office package",
          objective: "Complete the released shop scope safely",
          boundaries: "Only the issued shop order scope",
          prerequisites: "Crew and materials are present",
          expected_result: "Shop order is ready for review",
          stop_conditions: "Stop on unsafe conditions",
          make_safe_procedure: "Secure the area and notify production",
          correction_reason: null,
          steps: [
            {
              instruction: "Inspect the shop work area",
              required_evidence: "Current work-area photographs",
              acceptance_criteria: "Work area is safe",
            },
          ],
          hold_points: [
            {
              hold_point: "Pre-start safety release",
              release_phase: "Pre-start",
              release_authority: "IronWrap Production",
              required_evidence: "Safety inspection evidence",
              acceptance_criteria: "Safety is released",
            },
          ],
        }),
      },
    ),
    appEnv,
    auth("owner"),
  );
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.server_ref, TYPED_WORK_PACKAGE_ID);
  const row = appEnv.DB.sqlite
    .prepare(
      `SELECT work_object_type, work_object_id, physical_context_type,
              physical_context_id, definition_json
         FROM work_packages WHERE work_package_id = ?`,
    )
    .get(TYPED_WORK_PACKAGE_ID) as Record<string, unknown>;
  assert.deepEqual(
    {
      work_object_type: row.work_object_type,
      work_object_id: row.work_object_id,
      physical_context_type: row.physical_context_type,
      physical_context_id: row.physical_context_id,
    },
    {
      work_object_type: "Shop Order",
      work_object_id: "SHOP-NATIVE-OFFICE",
      physical_context_type: "Shop Floor",
      physical_context_id: "SHOP-FLOOR-NATIVE-OFFICE",
    },
  );
  assert.deepEqual(
    JSON.parse(String(row.definition_json)).authority_requirements,
    requirements,
  );
  assert.equal(
    appEnv.DB.sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM work_package_events WHERE event_kind = 'issued'",
      )
      .get().count,
    1,
  );
});

/** An active safety stop the crew member raised on `scope`. */
async function raiseSafetyStop(
  appEnv: ReturnType<typeof env>,
  occurrenceId: string,
  scope: { type: "roof_job" | "work_package" | "tenant"; id: string },
  reportedAt: string,
) {
  await reportSafetyOccurrence(appEnv, {
    occurrenceId,
    tenantId: "ironwrap",
    occurrenceKind: "hazard",
    severity: "high",
    scope,
    reportedByUserId: "appu_crew_native",
    reportedAt,
    summary: "Ice on the north slope.",
    rescueRequired: false,
    evidence: null,
    capturedOffline: false,
    deviceActionId: null,
    now: reportedAt,
  });
}

test("an active safety stop that holds the job refuses acknowledge with the stop's facts; stopping stays open", async () => {
  const appEnv = env();
  const packet = definition();
  await issueNativeWorkPackage(appEnv, packet);
  await recordPacketAuthority(appEnv, packet);
  const assignment = { name: packet.assignmentId };
  // A stop on a job this tenant does not have holds every job, this one included.
  const reportedAt = new Date(Date.now() - 60_000).toISOString();
  await raiseSafetyStop(appEnv, "so_office_hold_typo_0001", { type: "roof_job", id: "JOB-TYPO" }, reportedAt);
  const refused = await handleWorkPackageAction(
    fieldWorkPackageActionRequest(packet, "acknowledge", "field-hold-ack-0001"),
    appEnv,
    auth("field"),
    packet.jobId,
    assignment,
    "acknowledge",
  );
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), {
    error: "safety_stop_active",
    message: "A safety stop holds this job. Work stays stopped until a person releases it.",
    safety_stops: [
      {
        occurrence_id: "so_office_hold_typo_0001",
        scope: "tenant",
        reported_at: reportedAt,
        summary: "Ice on the north slope.",
        raiser_display_name: "Native Crew",
      },
    ],
  });
  assert.equal(
    appEnv.DB.sqlite
      .prepare("SELECT COUNT(*) AS count FROM work_package_events WHERE event_kind = 'acknowledged'")
      .get().count,
    0,
  );
  // A person may always stop work.
  const stopped = await handleWorkPackageAction(
    fieldWorkPackageActionRequest(packet, "stop_work", "field-hold-stop-0001"),
    appEnv,
    auth("field"),
    packet.jobId,
    assignment,
    "stop_work",
  );
  assert.equal(stopped.status, 200, await stopped.clone().text());
});

test("a stop raised after the Worker's gate passed meets the same named refusal from D1", async () => {
  const appEnv = env();
  const packet = definition();
  await issueNativeWorkPackage(appEnv, packet);
  await recordPacketAuthority(appEnv, packet);
  const reportedAt = new Date(Date.now() - 60_000).toISOString();
  // Raised on this very job between the Worker's readiness gate and its event write.
  appEnv.DB.beforeEventInsertOnce("field-hold-ack-0002", async () => {
    await raiseSafetyStop(appEnv, "so_office_hold_race_0001", { type: "roof_job", id: packet.jobId }, reportedAt);
  });
  const refused = await handleWorkPackageAction(
    fieldWorkPackageActionRequest(packet, "acknowledge", "field-hold-ack-0002"),
    appEnv,
    auth("field"),
    packet.jobId,
    { name: packet.assignmentId },
    "acknowledge",
  );
  assert.equal(refused.status, 409);
  const body = (await refused.json()) as { error: string; safety_stops: Array<{ occurrence_id: string; scope: string }> };
  assert.equal(body.error, "safety_stop_active");
  assert.deepEqual(body.safety_stops.map((stop) => [stop.occurrence_id, stop.scope]),
    [["so_office_hold_race_0001", "job"]]);
});

test("native field actions re-evaluate current authority while exact replay and stop stay safe", async () => {
  const appEnv = env();
  const packet = definition();
  await issueNativeWorkPackage(appEnv, packet);
  await recordPacketAuthority(appEnv, packet);
  const assignment = { name: packet.assignmentId };

  const acknowledged = await handleWorkPackageAction(
    fieldWorkPackageActionRequest(
      packet,
      "acknowledge",
      "field-authority-ack-01",
    ),
    appEnv,
    auth("field"),
    packet.jobId,
    assignment,
    "acknowledge",
  );
  assert.equal(acknowledged.status, 200, await acknowledged.clone().text());

  await revokePacketAuthority(appEnv, packet, "02");

  const replay = await handleWorkPackageAction(
    fieldWorkPackageActionRequest(
      packet,
      "acknowledge",
      "field-authority-ack-01",
    ),
    appEnv,
    auth("field"),
    packet.jobId,
    assignment,
    "acknowledge",
  );
  assert.equal(replay.status, 200, await replay.clone().text());
  assert.deepEqual(await replay.json(), await acknowledged.json());

  const start = await handleWorkPackageAction(
    fieldWorkPackageActionRequest(
      packet,
      "start_work",
      "field-authority-start-01",
    ),
    appEnv,
    auth("field"),
    packet.jobId,
    assignment,
    "start_work",
  );
  assert.equal(start.status, 409);
  assert.deepEqual(await start.json(), {
    error: "authority_release_blocked",
    message: "Authority readiness blocks this action: authority_revoked.",
  });

  const stopped = await handleWorkPackageAction(
    fieldWorkPackageActionRequest(
      packet,
      "stop_work",
      "field-authority-stop-01",
    ),
    appEnv,
    auth("field"),
    packet.jobId,
    assignment,
    "stop_work",
  );
  assert.equal(stopped.status, 200, await stopped.clone().text());
  const stopReplay = await handleWorkPackageAction(
    fieldWorkPackageActionRequest(
      packet,
      "stop_work",
      "field-authority-stop-01",
    ),
    appEnv,
    auth("field"),
    packet.jobId,
    assignment,
    "stop_work",
  );
  assert.equal(stopReplay.status, 200, await stopReplay.clone().text());
  assert.deepEqual(await stopReplay.json(), await stopped.json());
});

test("retryable action without a native event re-runs current authority before reclaim", async () => {
  const appEnv = env();
  const packet = definition();
  const deviceActionId = "field-authority-retry-pre-native";
  await issueNativeWorkPackage(appEnv, packet);
  await recordPacketAuthority(appEnv, packet);
  appEnv.DB.sqlite.exec(`
    CREATE TRIGGER test_fail_native_work_package_event
    BEFORE INSERT ON work_package_events
    WHEN NEW.device_action_id = '${deviceActionId}'
    BEGIN
      SELECT RAISE(ABORT, 'test_native_event_failure');
    END
  `);

  const first = await handleWorkPackageAction(
    fieldWorkPackageActionRequest(packet, "acknowledge", deviceActionId),
    appEnv,
    auth("field"),
    packet.jobId,
    { name: packet.assignmentId },
    "acknowledge",
  );
  assert.equal(first.status, 502, await first.clone().text());
  assert.equal(
    appEnv.DB.sqlite
      .prepare(
        "SELECT status FROM field_work_package_actions WHERE device_action_id = ?",
      )
      .get(deviceActionId).status,
    "retryable_error",
  );
  assert.equal(
    appEnv.DB.sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM work_package_events WHERE device_action_id = ?",
      )
      .get(deviceActionId).count,
    0,
  );
  appEnv.DB.sqlite.exec("DROP TRIGGER test_fail_native_work_package_event");
  await revokePacketAuthority(appEnv, packet, "retry-pre-native");

  const retry = await handleWorkPackageAction(
    fieldWorkPackageActionRequest(packet, "acknowledge", deviceActionId),
    appEnv,
    auth("field"),
    packet.jobId,
    { name: packet.assignmentId },
    "acknowledge",
  );
  assert.equal(retry.status, 409, await retry.clone().text());
  assert.deepEqual(await retry.json(), {
    error: "authority_release_blocked",
    message: "Authority readiness blocks this action: authority_revoked.",
  });
  assert.equal(
    appEnv.DB.sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM work_package_events WHERE device_action_id = ?",
      )
      .get(deviceActionId).count,
    0,
  );
});

test("authority revoked after the command gate aborts the native event append", async () => {
  const appEnv = env();
  const packet = definition();
  const deviceActionId = "field-authority-toctou-revoked";
  await issueNativeWorkPackage(appEnv, packet);
  await recordPacketAuthority(appEnv, packet);
  appEnv.DB.beforeEventInsertOnce(deviceActionId, async () => {
    await revokePacketAuthority(appEnv, packet, "between-gate-and-append");
  });

  const response = await handleWorkPackageAction(
    fieldWorkPackageActionRequest(packet, "acknowledge", deviceActionId),
    appEnv,
    auth("field"),
    packet.jobId,
    { name: packet.assignmentId },
    "acknowledge",
  );

  assert.equal(response.status, 409, await response.clone().text());
  assert.deepEqual(await response.json(), {
    error: "authority_release_blocked",
    message:
      "Authority readiness changed before this action could be committed.",
  });
  assert.equal(
    appEnv.DB.sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM work_package_events WHERE device_action_id = ?",
      )
      .get(deviceActionId).count,
    0,
  );
  assert.equal(
    appEnv.DB.sqlite
      .prepare(
        "SELECT status FROM work_packages WHERE tenant_id = ? AND work_package_id = ?",
      )
      .get(packet.tenantId, packet.workPackageId).status,
    "Released",
  );
});

test("retry reconciles a committed native event before current authority denial", async () => {
  const appEnv = env();
  const packet = definition();
  const deviceActionId = "field-authority-retry-post-native";
  await issueNativeWorkPackage(appEnv, packet);
  await recordPacketAuthority(appEnv, packet);
  appEnv.DB.sqlite.exec(`
    CREATE TRIGGER test_fail_native_work_package_event
    BEFORE INSERT ON work_package_events
    WHEN NEW.device_action_id = '${deviceActionId}'
    BEGIN
      SELECT RAISE(ABORT, 'test_native_event_failure');
    END
  `);

  const first = await handleWorkPackageAction(
    fieldWorkPackageActionRequest(packet, "acknowledge", deviceActionId),
    appEnv,
    auth("field"),
    packet.jobId,
    { name: packet.assignmentId },
    "acknowledge",
  );
  assert.equal(first.status, 502, await first.clone().text());
  appEnv.DB.sqlite.exec("DROP TRIGGER test_fail_native_work_package_event");
  const receipt = appEnv.DB.sqlite
    .prepare(
      `SELECT manifest_key FROM field_work_package_actions
        WHERE device_action_id = ?`,
    )
    .get(deviceActionId) as { manifest_key: string };
  const workPackage = await fieldWorkPackageForAssignment(
    appEnv,
    packet.jobId,
    packet.assignmentId,
    packet.tenantId,
  );
  assert.ok(workPackage);
  const authority = await currentWorkPackageAuthorityResolution(
    appEnv,
    packet.tenantId,
    workPackage,
    "2026-08-20T08:00:00.000Z",
  );
  assert.deepEqual(authority.denials, []);
  const native = await nativeWorkPackageAction(appEnv, {
    kind: "acknowledge",
    workPackageId: packet.workPackageId,
    workPackageVersion: packet.version,
    jobId: packet.jobId,
    assignmentId: packet.assignmentId,
    actorUser: "appu_crew_native",
    actorRole: "field",
    deviceActionId,
    blockerReason: null,
    releaseAttemptId: packet.releaseAttemptId,
    workObjectType: null,
    workObjectId: null,
    physicalContextType: null,
    physicalContextId: null,
    manifestKey: receipt.manifest_key,
    authorityPreconditions: authority.preconditions,
  });
  assert.match(native.eventName, /^wpe_[0-9a-f]{32}$/);
  assert.equal(
    appEnv.DB.sqlite
      .prepare(
        "SELECT status FROM field_work_package_actions WHERE device_action_id = ?",
      )
      .get(deviceActionId).status,
    "retryable_error",
  );
  await revokePacketAuthority(appEnv, packet, "retry-post-native");

  const replay = await handleWorkPackageAction(
    fieldWorkPackageActionRequest(packet, "acknowledge", deviceActionId),
    appEnv,
    auth("field"),
    packet.jobId,
    { name: packet.assignmentId },
    "acknowledge",
  );
  assert.equal(replay.status, 200, await replay.clone().text());
  assert.deepEqual(await replay.json(), {
    device_action_id: deviceActionId,
    status: "verified",
    server_ref: packet.workPackageId,
    cursor: native.eventName,
  });
  assert.equal(
    appEnv.DB.sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM work_package_events WHERE device_action_id = ?",
      )
      .get(deviceActionId).count,
    1,
  );
});

test("field projection suppresses non-stop actions on current authority denial", async () => {
  const appEnv = env();
  const packet = definition();
  await issueNativeWorkPackage(appEnv, packet);
  await recordPacketAuthority(appEnv, packet);
  const workPackage = await fieldWorkPackageForAssignment(
    appEnv,
    packet.jobId,
    packet.assignmentId,
    packet.tenantId,
  );
  assert.ok(workPackage);
  const actor = ["appu_crew_native", "crew@example.com"];
  const currentDenials = await currentWorkPackageAuthorityDenials(
    appEnv,
    packet.tenantId,
    workPackage,
    new Date().toISOString(),
  );
  assert.deepEqual(currentDenials, []);
  assert.ok(
    fieldWorkPackageProjection(workPackage, actor, {
      authorityDenials: currentDenials,
    }).allowedActions.includes("work_package.acknowledge"),
  );

  await revokePacketAuthority(appEnv, packet, "projection");
  const revokedDenials = await currentWorkPackageAuthorityDenials(
    appEnv,
    packet.tenantId,
    workPackage,
    new Date().toISOString(),
  );
  assert.deepEqual(revokedDenials, ["authority_revoked"]);
  const projection = fieldWorkPackageProjection(workPackage, actor, {
    authorityDenials: revokedDenials,
  });
  assert.deepEqual(projection.allowedActions, ["work_package.stop_work"]);
  assert.deepEqual(projection.work_package?.authority_denials, [
    "authority_revoked",
  ]);

  const unavailable = await currentWorkPackageAuthorityDenials(
    authorityReadFailureEnv(appEnv),
    packet.tenantId,
    workPackage,
    new Date().toISOString(),
  );
  assert.deepEqual(unavailable, ["authority_unavailable"]);
  assert.deepEqual(
    fieldWorkPackageProjection(workPackage, actor, {
      authorityDenials: unavailable,
    }).allowedActions,
    ["work_package.stop_work"],
  );
});

test("legacy, corrupt, and unreadable authority fail closed without blocking stop work", async (t) => {
  for (const state of ["missing", "corrupt"] as const) {
    await t.test(state, async () => {
      const appEnv = env();
      const packet = definition();
      await issueNativeWorkPackage(appEnv, packet);
      rewriteAuthorityFixture(appEnv, packet, state);
      const assignment = { name: packet.assignmentId };
      const blocked = await handleWorkPackageAction(
        fieldWorkPackageActionRequest(
          packet,
          "acknowledge",
          `field-authority-${state}-ack-01`,
        ),
        appEnv,
        auth("field"),
        packet.jobId,
        assignment,
        "acknowledge",
      );
      assert.equal(blocked.status, 409);
      assert.deepEqual(await blocked.json(), {
        error: "authority_release_blocked",
        message: `Authority readiness blocks this action: ${
          state === "missing" ? "authority_missing" : "authority_unverifiable"
        }.`,
      });
      assert.equal(appEnv.RAW.objects.size, 0);

      const stopped = await handleWorkPackageAction(
        fieldWorkPackageActionRequest(
          packet,
          "stop_work",
          `field-authority-${state}-stop-01`,
        ),
        appEnv,
        auth("field"),
        packet.jobId,
        assignment,
        "stop_work",
      );
      assert.equal(stopped.status, 200, await stopped.clone().text());
    });
  }

  await t.test("store read failure", async () => {
    const appEnv = env();
    const packet = definition();
    await issueNativeWorkPackage(appEnv, packet);
    await recordPacketAuthority(appEnv, packet);
    const failingEnv = authorityReadFailureEnv(appEnv);
    const assignment = { name: packet.assignmentId };
    const blocked = await handleWorkPackageAction(
      fieldWorkPackageActionRequest(
        packet,
        "acknowledge",
        "field-authority-read-failure-ack-01",
      ),
      failingEnv,
      auth("field"),
      packet.jobId,
      assignment,
      "acknowledge",
    );
    assert.equal(blocked.status, 503);
    assert.equal(blocked.headers.get("retry-after"), "5");
    assert.deepEqual(await blocked.json(), {
      error: "authority_release_blocked",
      message: "Authority readiness blocks this action: authority_unavailable.",
    });
    assert.equal(appEnv.RAW.objects.size, 0);

    const stopped = await handleWorkPackageAction(
      fieldWorkPackageActionRequest(
        packet,
        "stop_work",
        "field-authority-read-failure-stop-01",
      ),
      failingEnv,
      auth("field"),
      packet.jobId,
      assignment,
      "stop_work",
    );
    assert.equal(stopped.status, 200, await stopped.clone().text());
  });
});

test("office hold-release route appends a native event and stores an immutable manifest", async () => {
  const appEnv = env();
  const packet = definition();
  await issueNativeWorkPackage(appEnv, packet);
  insertCapture(appEnv, packet, "hold:1", "evidence_hold_native_office_api_1");

  const response = await handleAuthenticatedRoute(
    new Request(
      "https://app.example.com/api/v1/jobs/JOB-NATIVE-OFFICE/work-package/holds/1/release",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": "csrf",
          "idempotency-key": "office-hold-release-1",
          "x-device-action-id": "office-hold-release-1",
        },
        body: JSON.stringify({
          assignment_id: packet.assignmentId,
          work_package_id: packet.workPackageId,
          work_package_version: packet.version,
        }),
      },
    ),
    appEnv,
    auth("production"),
  );
  const body = (await response.json()) as {
    device_action_id: string;
    status: string;
    server_ref: string;
    cursor: string;
    error?: string;
  };
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.device_action_id, "office-hold-release-1");
  assert.equal(body.status, "verified");
  assert.equal(body.server_ref, packet.workPackageId);
  assert.match(body.cursor, /^wpe_[0-9a-f]{32}$/);
  const manifest = appEnv.RAW.objects.get(
    "work-packages/office-actions/ironwrap/office-hold-release-1.json",
  );
  assert.ok(manifest);
  assert.match(manifest.body, /"kind":"hold_release"/);
  assert.match(manifest.body, /"hold_point_sequence":1/);
  assert.match(
    manifest.body,
    /"evidence_item":"evidence_hold_native_office_api_1"/,
  );
});

test("office evidence-review route rejects an invalid correction contract before mutation", async () => {
  const appEnv = env();
  const packet = definition();
  await issueNativeWorkPackage(appEnv, packet);
  insertCapture(appEnv, packet);

  const response = await handleAuthenticatedRoute(
    new Request(
      "https://app.example.com/api/v1/jobs/JOB-NATIVE-OFFICE/work-package/evidence/evidence_step_native_office_api_1/review",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": "csrf",
          "idempotency-key": "office-evidence-review-1",
          "x-device-action-id": "office-evidence-review-1",
        },
        body: JSON.stringify({
          assignment_id: packet.assignmentId,
          work_package_id: packet.workPackageId,
          work_package_version: packet.version,
          disposition: "Accepted",
          correction_reason: "should not be here",
        }),
      },
    ),
    appEnv,
    auth("production"),
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "invalid_work_package_evidence_review",
  });
  assert.equal(
    appEnv.RAW.objects.has(
      "work-packages/office-actions/ironwrap/office-evidence-review-1.json",
    ),
    false,
  );
});

test("office work-package mutations fail closed outside the configured tenant", async () => {
  const appEnv = env();
  appEnv.APP_TENANT_ID = "another-tenant";
  const response = await handleAuthenticatedRoute(
    new Request(
      "https://app.example.com/api/v1/jobs/JOB-NATIVE-OFFICE/work-package/holds/1/release",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": "csrf",
          "idempotency-key": "office-cross-tenant-1",
          "x-device-action-id": "office-cross-tenant-1",
        },
        body: JSON.stringify({
          assignment_id: "ASSIGN-NATIVE-OFFICE",
          work_package_id: "wp_native_office_api",
          work_package_version: 1,
        }),
      },
    ),
    appEnv,
    auth("owner"),
  );
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not_found" });
  assert.equal(appEnv.RAW.objects.size, 0);
});

test("office evidence review binds one immutable manifest and exact native event", async () => {
  const appEnv = env();
  const packet = definition();
  await issueNativeWorkPackage(appEnv, packet);
  insertCapture(appEnv, packet);
  const path =
    "/api/v1/jobs/JOB-NATIVE-OFFICE/work-package/evidence/wpe_evidence_step_native_office_api_1/review";
  const request = (body: Record<string, unknown>) =>
    new Request(`https://app.example.com${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": "csrf",
        "idempotency-key": "office-evidence-review-exact-1",
        "x-device-action-id": "office-evidence-review-exact-1",
      },
      body: JSON.stringify(body),
    });
  const accepted = {
    assignment_id: packet.assignmentId,
    work_package_id: packet.workPackageId,
    work_package_version: packet.version,
    disposition: "Accepted",
    correction_reason: null,
  };
  const first = await handleAuthenticatedRoute(
    request(accepted),
    appEnv,
    auth("owner"),
  );
  assert.equal(first.status, 200, await first.clone().text());
  const replay = await handleAuthenticatedRoute(
    request(accepted),
    appEnv,
    auth("owner"),
  );
  assert.equal(replay.status, 200, await replay.clone().text());
  assert.equal(
    appEnv.DB.sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM work_package_events WHERE event_kind = 'evidence_reviewed'",
      )
      .get().count,
    1,
  );
  const manifest = appEnv.RAW.objects.get(
    "work-packages/office-actions/ironwrap/office-evidence-review-exact-1.json",
  );
  assert.ok(manifest);
  assert.match(
    manifest.body,
    /"evidence_event_id":"wpe_evidence_step_native_office_api_1"/,
  );
  const conflict = await handleAuthenticatedRoute(
    request({
      ...accepted,
      disposition: "Needs Correction",
      correction_reason: "Retake the photo",
    }),
    appEnv,
    auth("owner"),
  );
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), {
    error: "immutable_object_conflict",
  });
});
