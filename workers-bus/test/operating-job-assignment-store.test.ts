import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import {
  permissionsForRole,
  type AppEnv,
  type AppRole,
  type AuthContext,
} from "../src/app-types.ts";
import {
  getCurrentOperatingJobAssignment,
  listCurrentOperatingJobAssignments,
  OperatingJobAssignmentError,
  recordOperatingJobAssignment,
  type RecordOperatingJobAssignmentInput,
} from "../src/operating-job-assignment-store.ts";
import {
  getCurrentOperatingWorkObjectAssignment,
  listCurrentOperatingWorkObjectAssignments,
  recordOperatingWorkObjectAssignment,
  type RecordOperatingWorkObjectAssignmentInput,
} from "../src/operating-work-object-assignment-store.ts";

const TENANT = "ironwrap";
const NOW = new Date("2026-08-21T08:00:00.000Z");
const JOB_ID = "job:schedule:0001";
const CREW_ID = "crew:schedule:0001";
const OWNER_ID = "appu_owner_schedule";
const PRODUCTION_ID = "appu_production_schedule";

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    const directory = new URL("../migrations/", import.meta.url);
    for (const file of readdirSync(directory)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      this.raw.exec(readFileSync(new URL(file, directory), "utf8"));
    }
    seed(this.raw);
  }

  prepare(sql: string) {
    return new SqliteStatement(this.raw, this.raw.prepare(sql));
  }

  close(): void {
    this.raw.close();
  }
}

class SqliteStatement {
  private readonly database: DatabaseSync;
  private readonly statement: StatementSync;
  private readonly args: unknown[];

  constructor(
    database: DatabaseSync,
    statement: StatementSync,
    args: unknown[] = [],
  ) {
    this.database = database;
    this.statement = statement;
    this.args = args;
  }

  bind(...args: unknown[]) {
    return new SqliteStatement(this.database, this.statement, args);
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.args) ?? null) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.statement.all(...this.args) as T[] };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const result = this.statement.run(...this.args);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

function env(db: SqliteD1): AppEnv {
  return { DB: db as never } as AppEnv;
}

function auth(role: AppRole): AuthContext {
  const userId = role === "field" ? "appu_field_schedule_a" : OWNER_ID;
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: permissionsForRole(role),
    session: {
      session_hash: "a".repeat(64),
      session_created_at: NOW.toISOString(),
      session_expires_at: "2026-08-22T08:00:00.000Z",
      revoked_at: null,
      user_id: userId,
      tenant_id: TENANT,
      email_normalized: `${userId}@example.invalid`,
      display_name: userId,
      role,
      frappe_user_id: role === "field" ? `${userId}@example.invalid` : null,
      active: 1,
      created_by: "test-seed",
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    },
  };
}

function request(
  overrides: Partial<RecordOperatingJobAssignmentInput> = {},
): RecordOperatingJobAssignmentInput {
  return {
    tenantId: TENANT,
    roofJobId: JOB_ID,
    expectedRoofJobVersion: 1,
    crewId: CREW_ID,
    expectedCrewVersion: 1,
    scheduledStart: "2026-08-24T14:00:00.000Z",
    scheduledEnd: "2026-08-24T22:00:00.000Z",
    supersedesAssignmentId: null,
    correctionReason: null,
    actorUserId: OWNER_ID,
    idempotencyKey: "schedule:create:0001",
    ...overrides,
  };
}

function typedRequest(
  overrides: Partial<RecordOperatingWorkObjectAssignmentInput> = {},
): RecordOperatingWorkObjectAssignmentInput {
  return {
    tenantId: TENANT,
    workObjectType: "Shop Order",
    workObjectId: "SHOP-001",
    physicalContextType: "Shop Floor",
    physicalContextId: "SHOP-FLOOR-1",
    assignedUsers: ["appu_field_schedule_a", "appu_field_schedule_b"],
    scheduledStart: "2026-08-24T14:00:00.000Z",
    scheduledEnd: "2026-08-24T22:00:00.000Z",
    authorityUserId: PRODUCTION_ID,
    authorityRole: "production",
    supersedesAssignmentId: null,
    correctionReason: null,
    actorUserId: OWNER_ID,
    idempotencyKey: "typed-assignment:create:0001",
    ...overrides,
  };
}

test("native scheduling creates, replays, supersedes, and reads the frozen crew without Frappe", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  try {
    const firstInput = request();
    const first = await recordOperatingJobAssignment(appEnv, firstInput, NOW);
    assert.equal(first.kind, "created");
    assert.equal(first.assignment.assignment_version, 1);
    assert.deepEqual(first.assignment.assigned_users, [
      "appu_field_schedule_a",
      "appu_field_schedule_b",
    ]);
    assert.deepEqual(
      await recordOperatingJobAssignment(appEnv, firstInput, NOW),
      {
        kind: "replayed",
        assignment: first.assignment,
      },
    );
    await assert.rejects(
      recordOperatingJobAssignment(
        appEnv,
        {
          ...firstInput,
          scheduledStart: "2026-08-25T14:00:00.000Z",
          scheduledEnd: "2026-08-25T22:00:00.000Z",
        },
        NOW,
      ),
      errorCode("operating_job_assignment_idempotency_conflict"),
    );
    await assert.rejects(
      recordOperatingJobAssignment(
        appEnv,
        request({
          idempotencyKey: "schedule:replace:missing-reason",
          supersedesAssignmentId: first.assignment.assignment_id,
        }),
        NOW,
      ),
      errorCode("operating_job_assignment_chain_conflict"),
    );

    const second = await recordOperatingJobAssignment(
      appEnv,
      request({
        idempotencyKey: "schedule:replace:0002",
        scheduledStart: "2026-08-25T14:00:00.000Z",
        scheduledEnd: "2026-08-25T22:00:00.000Z",
        supersedesAssignmentId: first.assignment.assignment_id,
        correctionReason: "Customer moved the confirmed installation date.",
      }),
      new Date("2026-08-21T09:00:00.000Z"),
    );
    assert.equal(second.assignment.assignment_version, 2);
    assert.equal(
      (await getCurrentOperatingJobAssignment(appEnv, TENANT, JOB_ID))
        ?.assignment_id,
      second.assignment.assignment_id,
    );
    assert.deepEqual(
      (
        await listCurrentOperatingJobAssignments(appEnv, TENANT, {
          actorUsers: ["APPU_FIELD_SCHEDULE_A"],
        })
      ).map((row) => row.assignment_id),
      [second.assignment.assignment_id],
    );
    assert.equal(
      (
        await listCurrentOperatingJobAssignments(appEnv, TENANT, {
          actorUsers: ["appu_field_not_assigned"],
        })
      ).length,
      0,
    );
    assert.throws(
      () =>
        db.raw
          .prepare(
            "UPDATE operating_job_assignments SET scheduled_start = ? WHERE assignment_id = ?",
          )
          .run("2026-08-26T14:00:00.000Z", second.assignment.assignment_id),
      /operating_job_assignments_append_only/,
    );
    assert.throws(
      () =>
        db.raw
          .prepare(
            "DELETE FROM operating_job_assignments WHERE assignment_id = ?",
          )
          .run(second.assignment.assignment_id),
      /operating_job_assignments_append_only/,
    );
  } finally {
    db.close();
  }
});

test("native scheduling rejects unsafe gates, stale identities, partial rosters, and chain forks", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  try {
    const first = await recordOperatingJobAssignment(appEnv, request(), NOW);
    assert.throws(
      () =>
        db.raw
          .prepare(
            `INSERT INTO operating_job_assignments (
           assignment_id, tenant_id, roof_job_id, assignment_version, roof_job_version,
           crew_id, crew_version, assigned_users_json, scheduled_start, scheduled_end,
           supersedes_assignment_id, correction_reason, actor_user_id,
           command_fingerprint, idempotency_key_hash, created_at
         ) VALUES (?, ?, ?, 2, 1, ?, 1, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "assignment:malformed-roster",
            TENANT,
            JOB_ID,
            CREW_ID,
            '["appu_field_schedule_a","appu_field_schedule_a"]',
            "2026-08-25T14:00:00.000Z",
            first.assignment.assignment_id,
            "Attempted malformed replacement roster.",
            OWNER_ID,
            "a".repeat(64),
            "b".repeat(64),
            NOW.toISOString(),
          ),
      /operating_job_assignment_roster_invalid/,
    );
    await assert.rejects(
      recordOperatingJobAssignment(
        appEnv,
        request({
          expectedRoofJobVersion: 2,
          idempotencyKey: "schedule:stale-job",
          supersedesAssignmentId: first.assignment.assignment_id,
          correctionReason: "Test a stale job version.",
        }),
        NOW,
      ),
      /operating_job_assignment_job_invalid/,
    );
    await assert.rejects(
      recordOperatingJobAssignment(
        appEnv,
        request({
          expectedCrewVersion: 2,
          idempotencyKey: "schedule:stale-crew",
          supersedesAssignmentId: first.assignment.assignment_id,
          correctionReason: "Test a stale crew version.",
        }),
        NOW,
      ),
      /operating_job_assignment_crew_invalid/,
    );

    db.raw
      .prepare(
        "UPDATE operating_production_gates SET state = 'blocked', version = version + 1 WHERE roof_job_id = ? AND gate = 'Weather'",
      )
      .run(JOB_ID);
    await assert.rejects(
      recordOperatingJobAssignment(
        appEnv,
        request({
          idempotencyKey: "schedule:blocked-gate",
          supersedesAssignmentId: first.assignment.assignment_id,
          correctionReason: "Attempt while the weather gate is blocked.",
        }),
        NOW,
      ),
      /operating_job_assignment_gates_blocked/,
    );
    db.raw
      .prepare(
        "UPDATE operating_production_gates SET state = 'ready', version = version + 1 WHERE roof_job_id = ? AND gate = 'Weather'",
      )
      .run(JOB_ID);

    const second = await recordOperatingJobAssignment(
      appEnv,
      request({
        idempotencyKey: "schedule:replace:valid",
        supersedesAssignmentId: first.assignment.assignment_id,
        correctionReason:
          "Move the crew to the next available production date.",
      }),
      NOW,
    );
    await assert.rejects(
      recordOperatingJobAssignment(
        appEnv,
        request({
          idempotencyKey: "schedule:fork",
          supersedesAssignmentId: first.assignment.assignment_id,
          correctionReason: "Attempt to fork the immutable schedule chain.",
        }),
        NOW,
      ),
      errorCode("operating_job_assignment_chain_conflict"),
    );
    assert.equal(
      second.assignment.supersedes_assignment_id,
      first.assignment.assignment_id,
    );

    db.raw
      .prepare(
        "UPDATE app_users SET active = 0, updated_at = ? WHERE user_id = 'appu_field_schedule_b'",
      )
      .run("2026-08-21T10:00:00.000Z");
    await assert.rejects(
      recordOperatingJobAssignment(
        appEnv,
        request({
          idempotencyKey: "schedule:inactive-roster",
          supersedesAssignmentId: second.assignment.assignment_id,
          correctionReason: "Attempt to schedule an inactive crew member.",
        }),
        NOW,
      ),
      /operating_job_assignment_roster_invalid/,
    );
    await assert.rejects(
      recordOperatingJobAssignment(
        appEnv,
        request({
          tenantId: "iroof",
          idempotencyKey: "schedule:cross-tenant",
        }),
        NOW,
      ),
      /operating_job_assignment_(job_invalid|roster_invalid)/,
    );
  } finally {
    db.close();
  }
});

test("typed physical assignments exist before a Work Package and freeze native authority", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  try {
    const firstInput = typedRequest();
    const first = await recordOperatingWorkObjectAssignment(
      appEnv,
      firstInput,
      NOW,
    );
    assert.equal(first.kind, "created");
    assert.equal(first.assignment.assignment_version, 1);
    assert.equal(first.assignment.authority_user_id, PRODUCTION_ID);
    assert.deepEqual(first.assignment.assigned_users, [
      "appu_field_schedule_a",
      "appu_field_schedule_b",
    ]);
    assert.deepEqual(
      await recordOperatingWorkObjectAssignment(appEnv, firstInput, NOW),
      { kind: "replayed", assignment: first.assignment },
    );
    await assert.rejects(
      recordOperatingWorkObjectAssignment(
        appEnv,
        { ...firstInput, scheduledEnd: "2026-08-24T23:00:00.000Z" },
        NOW,
      ),
      errorCode("operating_work_object_assignment_idempotency_conflict"),
    );

    const second = await recordOperatingWorkObjectAssignment(
      appEnv,
      typedRequest({
        idempotencyKey: "typed-assignment:replace:0002",
        scheduledStart: "2026-08-25T14:00:00.000Z",
        scheduledEnd: "2026-08-25T22:00:00.000Z",
        supersedesAssignmentId: first.assignment.assignment_id,
        correctionReason: "Move fabrication to the next confirmed shop window.",
      }),
      new Date("2026-08-21T09:00:00.000Z"),
    );
    assert.equal(second.assignment.assignment_version, 2);
    assert.equal(
      (
        await getCurrentOperatingWorkObjectAssignment(appEnv, TENANT, {
          workObjectType: "Shop Order",
          workObjectId: "SHOP-001",
          physicalContextType: "Shop Floor",
          physicalContextId: "SHOP-FLOOR-1",
        })
      )?.assignment_id,
      second.assignment.assignment_id,
    );
    assert.deepEqual(
      (
        await listCurrentOperatingWorkObjectAssignments(appEnv, TENANT, {
          actorUsers: ["APPU_FIELD_SCHEDULE_A"],
        })
      ).map((row) => row.assignment_id),
      [second.assignment.assignment_id],
    );
    assert.equal(
      (
        await listCurrentOperatingWorkObjectAssignments(appEnv, TENANT, {
          actorUsers: ["appu_field_not_assigned"],
        })
      ).length,
      0,
    );
    assert.throws(
      () =>
        db.raw
          .prepare(
            "UPDATE operating_work_object_assignments SET scheduled_start = ? WHERE assignment_id = ?",
          )
          .run("2026-08-26T14:00:00.000Z", second.assignment.assignment_id),
      /operating_work_object_assignments_append_only/,
    );
    assert.throws(
      () =>
        db.raw
          .prepare(
            "DELETE FROM operating_work_object_assignments WHERE assignment_id = ?",
          )
          .run(second.assignment.assignment_id),
      /operating_work_object_assignments_append_only/,
    );
  } finally {
    db.close();
  }
});

test("typed assignments reject self-authorized, inactive, duplicate, and forked authority", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  try {
    const first = await recordOperatingWorkObjectAssignment(
      appEnv,
      typedRequest(),
      NOW,
    );
    await assert.rejects(
      recordOperatingWorkObjectAssignment(
        appEnv,
        typedRequest({
          workObjectType: "Roof Job",
          idempotencyKey: "typed-assignment:roof-job",
        }),
        NOW,
      ),
      errorCode("operating_work_object_assignment_scope_invalid"),
    );
    await assert.rejects(
      recordOperatingWorkObjectAssignment(
        appEnv,
        typedRequest({
          assignedUsers: ["appu_field_schedule_a", "APPU_FIELD_SCHEDULE_A"],
          idempotencyKey: "typed-assignment:duplicate-roster",
          supersedesAssignmentId: first.assignment.assignment_id,
          correctionReason: "Attempt a duplicate frozen roster.",
        }),
        NOW,
      ),
      errorCode("operating_work_object_assignment_roster_invalid"),
    );
    await assert.rejects(
      recordOperatingWorkObjectAssignment(
        appEnv,
        typedRequest({
          authorityUserId: OWNER_ID,
          authorityRole: "production",
          idempotencyKey: "typed-assignment:wrong-authority-role",
          supersedesAssignmentId: first.assignment.assignment_id,
          correctionReason: "Attempt a mismatched authority identity.",
        }),
        NOW,
      ),
      /operating_work_object_assignment_authority_invalid/,
    );
    const second = await recordOperatingWorkObjectAssignment(
      appEnv,
      typedRequest({
        idempotencyKey: "typed-assignment:replace:valid",
        supersedesAssignmentId: first.assignment.assignment_id,
        correctionReason: "Move work to the next controlled production window.",
      }),
      NOW,
    );
    await assert.rejects(
      recordOperatingWorkObjectAssignment(
        appEnv,
        typedRequest({
          idempotencyKey: "typed-assignment:fork",
          supersedesAssignmentId: first.assignment.assignment_id,
          correctionReason: "Attempt to fork the immutable assignment chain.",
        }),
        NOW,
      ),
      errorCode("operating_work_object_assignment_chain_conflict"),
    );
    db.raw
      .prepare(
        "UPDATE app_users SET active = 0, updated_at = ? WHERE user_id = ?",
      )
      .run("2026-08-21T10:00:00.000Z", "appu_field_schedule_b");
    await assert.rejects(
      recordOperatingWorkObjectAssignment(
        appEnv,
        typedRequest({
          idempotencyKey: "typed-assignment:inactive-roster",
          supersedesAssignmentId: second.assignment.assignment_id,
          correctionReason: "Attempt to schedule an inactive field worker.",
        }),
        NOW,
      ),
      /operating_work_object_assignment_roster_invalid/,
    );
  } finally {
    db.close();
  }
});

test("authenticated production scheduling writes native authority without Frappe", async () => {
  const db = new SqliteD1();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("Frappe must not be called by native scheduling");
  };
  try {
    const body = JSON.stringify({
      expected_roof_job_version: 1,
      crew_id: CREW_ID,
      expected_crew_version: 1,
      scheduled_start: "2026-08-24T14:00:00.000Z",
      scheduled_end: "2026-08-24T22:00:00.000Z",
      supersedes_assignment_id: null,
      correction_reason: null,
    });
    const makeRequest = (idempotencyKey: string) =>
      new Request(
        `https://app.example.invalid/api/v1/jobs/${encodeURIComponent(JOB_ID)}/schedule`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": "csrf",
            "idempotency-key": idempotencyKey,
          },
          body,
        },
      );
    const created = await handleAuthenticatedRoute(
      makeRequest("schedule:api:create:0001"),
      env(db),
      auth("owner"),
    );
    assert.equal(created.status, 201);
    const createdBody = (await created.json()) as {
      version: number;
      replayed: boolean;
      assignment: {
        id: string;
        assigned_users: string[];
        actor_user_id: string;
      };
    };
    assert.equal(createdBody.version, 1);
    assert.equal(createdBody.replayed, false);
    assert.equal(createdBody.assignment.actor_user_id, OWNER_ID);
    assert.deepEqual(createdBody.assignment.assigned_users, [
      "appu_field_schedule_a",
      "appu_field_schedule_b",
    ]);

    const replay = await handleAuthenticatedRoute(
      makeRequest("schedule:api:create:0001"),
      env(db),
      auth("owner"),
    );
    assert.equal(replay.status, 200);
    assert.equal(
      ((await replay.json()) as { replayed: boolean }).replayed,
      true,
    );

    const denied = await handleAuthenticatedRoute(
      makeRequest("schedule:api:field-denied"),
      env(db),
      auth("field"),
    );
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), {
      error: "production_role_required",
    });
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("authenticated typed scheduling writes native authority without Frappe", async () => {
  const db = new SqliteD1();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("Frappe must not be called by native typed scheduling");
  };
  try {
    const body = JSON.stringify({
      assigned_users: ["appu_field_schedule_a", "appu_field_schedule_b"],
      scheduled_start: "2026-08-24T14:00:00.000Z",
      scheduled_end: "2026-08-24T22:00:00.000Z",
      authority_user_id: PRODUCTION_ID,
      authority_role: "production",
      supersedes_assignment_id: null,
      correction_reason: null,
    });
    const makeRequest = (idempotencyKey: string) =>
      new Request(
        "https://app.example.invalid/api/v1/work-objects/Shop%20Order/SHOP-001/physical-contexts/Shop%20Floor/SHOP-FLOOR-1/assignment",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": "csrf",
            "idempotency-key": idempotencyKey,
          },
          body,
        },
      );

    const created = await handleAuthenticatedRoute(
      makeRequest("typed-assignment:api:create:0001"),
      env(db),
      auth("owner"),
    );
    assert.equal(created.status, 201);
    const createdBody = (await created.json()) as {
      replayed: boolean;
      assignment: {
        work_object_type: string;
        physical_context_type: string;
        authority_user_id: string;
        assigned_users: string[];
      };
    };
    assert.equal(createdBody.replayed, false);
    assert.equal(createdBody.assignment.work_object_type, "Shop Order");
    assert.equal(createdBody.assignment.physical_context_type, "Shop Floor");
    assert.equal(createdBody.assignment.authority_user_id, PRODUCTION_ID);
    assert.deepEqual(createdBody.assignment.assigned_users, [
      "appu_field_schedule_a",
      "appu_field_schedule_b",
    ]);

    const replay = await handleAuthenticatedRoute(
      makeRequest("typed-assignment:api:create:0001"),
      env(db),
      auth("owner"),
    );
    assert.equal(replay.status, 200);
    assert.equal(
      ((await replay.json()) as { replayed: boolean }).replayed,
      true,
    );

    const denied = await handleAuthenticatedRoute(
      makeRequest("typed-assignment:api:field-denied"),
      env(db),
      auth("field"),
    );
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), {
      error: "production_role_required",
    });

    const wrongTenant = await handleAuthenticatedRoute(
      makeRequest("typed-assignment:api:wrong-tenant"),
      { ...env(db), APP_TENANT_ID: "another-tenant" },
      auth("owner"),
    );
    assert.equal(wrongTenant.status, 404);
    assert.deepEqual(await wrongTenant.json(), { error: "not_found" });
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

function seed(db: DatabaseSync): void {
  const now = NOW.toISOString();
  for (const [userId, role, accessRole] of [
    [OWNER_ID, "owner", "owner"],
    [PRODUCTION_ID, "ops", "production"],
    ["appu_field_schedule_a", "field", "field"],
    ["appu_field_schedule_b", "field", "field"],
  ] as const) {
    db.prepare(
      `INSERT INTO app_users
       (user_id, tenant_id, email_normalized, display_name, role, access_role, frappe_user_id,
        active, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'test-seed', ?, ?)`,
    ).run(
      userId,
      TENANT,
      `${userId}@example.invalid`,
      userId,
      role,
      accessRole,
      role === "field" ? `${userId}@example.invalid` : null,
      now,
      now,
    );
  }
  db.prepare(
    `INSERT INTO envelopes
     (envelope_id, source, contact_name, contact_email, payload_json, raw_key, ts,
      status, created_at, updated_at)
     VALUES ('ow_schedule_0001', 'manual', 'Schedule Customer', 'schedule@example.invalid',
             '{}', 'raw/schedule/0001.json', ?, 'reconciled', ?, ?)`,
  ).run(now, now, now);
  db.prepare(
    `INSERT INTO operating_leads
     (lead_id, tenant_id, source_envelope_id, source_raw_key, source, contact_name,
      contact_email, lifecycle_status, version, created_at, updated_at)
     VALUES ('lead:schedule:0001', ?, 'ow_schedule_0001', 'raw/schedule/0001.json',
             'manual', 'Schedule Customer', 'schedule@example.invalid', 'qualified', 1, ?, ?)`,
  ).run(TENANT, now, now);
  db.prepare(
    `INSERT INTO operating_customers
     (customer_id, tenant_id, source_envelope_id, source_raw_key, display_name,
      contact_email, lifecycle_status, version, created_at, updated_at)
     VALUES ('customer:schedule:0001', ?, 'ow_schedule_0001', 'raw/schedule/0001.json',
             'Schedule Customer', 'schedule@example.invalid', 'active', 1, ?, ?)`,
  ).run(TENANT, now, now);
  db.prepare(
    `INSERT INTO operating_roof_jobs
     (roof_job_id, tenant_id, lead_id, customer_id, source_envelope_id, source_raw_key,
      brand, job_number, service_type, job_status, current_gate_state, version,
      created_at, updated_at)
     VALUES (?, ?, 'lead:schedule:0001', 'customer:schedule:0001', 'ow_schedule_0001',
             'raw/schedule/0001.json', 'ironwrap', 'IW-0001', 'roof_replacement',
             'qualified', 'ready', 1, ?, ?)`,
  ).run(JOB_ID, TENANT, now, now);
  for (const gate of [
    "Deposit",
    "Materials",
    "Safety",
    "Access",
    "Weather",
    "Crew",
  ]) {
    db.prepare(
      `INSERT INTO operating_production_gates
       (gate_id, tenant_id, roof_job_id, source_envelope_id, source_raw_key, gate,
        state, owner_user, assigned_at, due_at, blocker_reason, version, created_at, updated_at)
       VALUES (?, ?, ?, 'ow_schedule_0001', 'raw/schedule/0001.json', ?, 'ready', ?, ?, ?,
               'No active blocker', 1, ?, ?)`,
    ).run(
      `gate:schedule:${gate.toLowerCase()}`,
      TENANT,
      JOB_ID,
      gate,
      OWNER_ID,
      now,
      "2026-08-24T12:00:00.000Z",
      now,
      now,
    );
  }
  db.prepare(
    `INSERT INTO fleet_crews
     (crew_id, tenant_id, display_name, status, version, created_at, updated_at)
     VALUES (?, ?, 'Schedule Crew', 'Active', 1, ?, ?)`,
  ).run(CREW_ID, TENANT, now, now);
  for (const [membershipId, userId] of [
    ["membership:schedule:a", "appu_field_schedule_a"],
    ["membership:schedule:b", "appu_field_schedule_b"],
  ] as const) {
    db.prepare(
      `INSERT INTO fleet_crew_members
       (membership_id, tenant_id, crew_id, user_id, active, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 1, ?, ?)`,
    ).run(membershipId, TENANT, CREW_ID, userId, now, now);
  }
}

function errorCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error &&
    (error.message === code ||
      (error instanceof OperatingJobAssignmentError && error.code === code));
}
