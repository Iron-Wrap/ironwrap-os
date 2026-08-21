import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import {
  permissionsForRole,
  type AppEnv,
  type AppRole,
  type AuthContext,
} from "../src/app-types.ts";
import {
  issueNativeWorkPackage,
  type NativeWorkPackageDefinition,
} from "../src/work-package-store.ts";
import { recordOperatingJobAssignment } from "../src/operating-job-assignment-store.ts";

class TestD1 {
  readonly sqlite = new DatabaseSync(":memory:");

  prepare(sql: string) {
    const sqlite = this.sqlite;
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
            const result = sqlite.prepare(sql).run(...values);
            return { meta: { changes: Number(result.changes) } };
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
        scheduledStart: "2026-08-20T08:00:00.000Z",
        actorUserId: "appu_owner_native",
        idempotencyKey: "office-native-assignment-0001",
      },
      new Date(now),
    )
  ).assignment;
}

function definition(): NativeWorkPackageDefinition {
  return {
    tenantId: "ironwrap",
    workPackageId: "wp_native_office_api",
    version: 1,
    deviceActionId: "issue-native-office-api-1",
    manifestKey: "work-packages/issue-native-office-api-1.json",
    jobId: "JOB-NATIVE-OFFICE",
    assignmentId: "ASSIGN-NATIVE-OFFICE",
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

test("office issue route derives authority and roster, then replays one immutable package", async () => {
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
  const request = (value: Record<string, unknown>) =>
    new Request(
      "https://app.example.com/api/v1/jobs/JOB-NATIVE-OFFICE/work-package",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": "csrf",
          "idempotency-key": "office-work-package-issue-1",
          "x-device-action-id": "office-work-package-issue-1",
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
  assert.match(String(firstBody.server_ref), /^wp_[0-9a-f]{32}$/);

  const replay = await handleAuthenticatedRoute(
    request(body),
    appEnv,
    auth("owner"),
  );
  assert.equal(replay.status, 200, await replay.clone().text());
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
  const stored = appEnv.DB.sqlite
    .prepare("SELECT definition_json FROM work_packages")
    .get() as { definition_json: string };
  const definition = JSON.parse(stored.definition_json) as {
    assigned_workers: Array<{ worker_user: string; worker_role: string }>;
  };
  assert.deepEqual(definition.assigned_workers, [
    {
      sequence: 1,
      worker_user: "appu_crew_native",
      worker_role: "Field Worker",
      required: true,
    },
  ]);
  assert.ok(
    appEnv.RAW.objects.has(
      "work-packages/office-actions/ironwrap/office-work-package-issue-1.json",
    ),
  );

  const drift = await handleAuthenticatedRoute(
    request({ ...body, objective: "A different immutable objective" }),
    appEnv,
    auth("owner"),
  );
  assert.equal(drift.status, 409);

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
    request({
      ...body,
      assignment_modified: "2026-08-20T07:58:00.000Z",
    }),
    appEnv,
    auth("owner"),
  );
  assert.equal(staleAssignment.status, 409);
  assert.deepEqual(await staleAssignment.json(), {
    error: "work_package_assignment_changed",
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
