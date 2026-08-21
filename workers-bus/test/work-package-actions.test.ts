import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { handleAuthenticatedRoute } from "../src/app-api.ts";
import {
  permissionsForRole,
  type AppEnv,
  type AuthContext,
} from "../src/app-types.ts";
import {
  parseWorkPackageActionRequest,
  processWorkPackageAction,
  frappeWorkPackageWriter,
  type PersistWorkPackageActionInput,
  type ProcessWorkPackageActionDependencies,
  type VerifiedWorkPackageActionResponse,
  type WorkPackageActionStore,
  type WorkPackageFrappeWriter,
} from "../src/work-package-actions.ts";

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    this.raw.exec(readFileSync(new URL("../migrations/0042_external_effect_runtime.sql", import.meta.url), "utf8"));
  }

  // The effect runtime claims an attempt through env.DB.batch; a sequential
  // run is equivalent for a synchronous test double.
  async batch(statements: Array<{ run: () => Promise<unknown> }>) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => {
        const statement = this.raw.prepare(sql);
        return {
          first: async <T>() => (statement.get(...args) ?? null) as T | null,
          all: async <T>() => ({ results: statement.all(...args) as T[] }),
          run: async () => {
            const result = statement.run(...args);
            return { success: true, meta: { changes: Number(result.changes) } };
          },
        };
      },
    };
  }
}
import {
  FieldActionError,
  type ImmutableObjectStore,
} from "../src/field-actions.ts";
import {
  fieldWorkPackageProjection,
  hasWorkPackageCompletionAuthority,
  type FieldWorkPackage,
} from "../src/work-package.ts";

class MemoryStore implements WorkPackageActionStore {
  readonly actions = new Map<
    string,
    {
      tenantId: string;
      userId: string;
      jobId: string;
      assignmentId: string;
      workPackageId: string;
      kind: string;
      payloadHash: string;
      response?: VerifiedWorkPackageActionResponse;
      state: "processing" | "retryable_error" | "verified";
    }
  >();
  completed = 0;
  failed = 0;

  async find(
    input: Parameters<WorkPackageActionStore["find"]>[0],
  ): ReturnType<WorkPackageActionStore["find"]> {
    const existing = this.actions.get(input.deviceActionId);
    if (!existing) return null;
    const matches =
      existing.tenantId === input.tenantId &&
      existing.userId === input.userId &&
      existing.jobId === input.jobId &&
      existing.assignmentId === input.assignmentId &&
      existing.workPackageId === input.workPackageId &&
      existing.kind === input.kind &&
      existing.payloadHash === input.payloadHash;
    if (!matches) return { state: "mismatch" };
    return existing.state === "verified" && existing.response
      ? { state: "verified", response: existing.response }
      : { state: "matching" };
  }

  async claim(
    input: Parameters<WorkPackageActionStore["claim"]>[0],
  ): ReturnType<WorkPackageActionStore["claim"]> {
    const existing = this.actions.get(input.deviceActionId);
    if (!existing) {
      this.actions.set(input.deviceActionId, {
        tenantId: input.tenantId,
        userId: input.userId,
        jobId: input.jobId,
        assignmentId: input.assignmentId,
        workPackageId: input.workPackageId,
        kind: input.kind,
        payloadHash: input.payloadHash,
        state: "processing",
      });
      return { state: "acquired" };
    }
    if (
      existing.tenantId !== input.tenantId ||
      existing.userId !== input.userId ||
      existing.jobId !== input.jobId ||
      existing.assignmentId !== input.assignmentId ||
      existing.workPackageId !== input.workPackageId ||
      existing.kind !== input.kind ||
      existing.payloadHash !== input.payloadHash
    )
      return { state: "conflict" };
    if (existing.state === "verified" && existing.response)
      return { state: "verified", response: existing.response };
    existing.state = "processing";
    return { state: "acquired" };
  }

  async renew(deviceActionId: string): Promise<boolean> {
    return this.actions.get(deviceActionId)?.state !== "verified";
  }

  async markR2Stored(): Promise<void> {}

  async complete(
    deviceActionId: string,
    _token: string,
    response: VerifiedWorkPackageActionResponse,
  ): Promise<void> {
    const action = this.actions.get(deviceActionId);
    if (!action) throw new Error("missing_action");
    action.state = "verified";
    action.response = response;
    this.completed += 1;
  }

  async fail(deviceActionId: string): Promise<void> {
    const action = this.actions.get(deviceActionId);
    if (action && action.state !== "verified") action.state = "retryable_error";
    this.failed += 1;
  }
}

class MemoryObjects implements ImmutableObjectStore {
  readonly calls: string[] = [];
  readonly bodies = new Map<string, string>();

  async ensure(key: string, body: Blob | string): Promise<void> {
    this.calls.push(key);
    if (typeof body === "string") this.bodies.set(key, body);
  }
}

class MemoryFrappe implements WorkPackageFrappeWriter {
  readonly calls: PersistWorkPackageActionInput[] = [];
  failOnce = false;

  async persistAction(
    input: PersistWorkPackageActionInput,
  ): Promise<{ workPackageName: string; eventName: string }> {
    this.calls.push(input);
    if (this.failOnce) {
      this.failOnce = false;
      throw new Error("work_package_frappe_network_error");
    }
    return {
      workPackageName: `WP-${input.workPackageId}`,
      eventName: `EVENT-${input.deviceActionId}`,
    };
  }
}

function auth(
  role: "field" | "owner" | "ops" | "production" = "field",
): AuthContext {
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: permissionsForRole(role),
    session: {
      session_hash: "a".repeat(64),
      session_created_at: "2026-07-10T10:00:00.000Z",
      session_expires_at: "2026-07-11T10:00:00.000Z",
      revoked_at: null,
      user_id: `appu_${role}`,
      tenant_id: "ironwrap",
      email_normalized: `${role}@example.com`,
      display_name: role,
      role,
      frappe_user_id:
        role === "field" ? "crew@example.com" : `${role}@example.com`,
      active: 1,
      created_by: "owner@example.com",
      created_at: "2026-07-10T10:00:00.000Z",
      updated_at: "2026-07-10T10:00:00.000Z",
    },
  };
}

function submission(
  kind:
    | "acknowledge"
    | "stop_work"
    | "start_work"
    | "complete_work" = "acknowledge",
) {
  return {
    deviceActionId: "device-action-123",
    jobId: "JOB-A",
    assignmentId: "ASSIGN-A",
    kind,
    payload:
      kind === "stop_work"
        ? {
            work_package_id: "work_package_a",
            work_package_version: 1,
            blocker_reason: "Wind exceeds the released safety limit.",
          }
        : {
            work_package_id: "work_package_a",
            work_package_version: 1,
            release_attempt_id: "attempt-a",
          },
  } as const;
}

function dependencies(
  store = new MemoryStore(),
  objects = new MemoryObjects(),
  frappe = new MemoryFrappe(),
): {
  store: MemoryStore;
  objects: MemoryObjects;
  frappe: MemoryFrappe;
  dependency: ProcessWorkPackageActionDependencies;
} {
  return {
    store,
    objects,
    frappe,
    dependency: {
      store,
      objects,
      frappe,
      now: () => new Date("2026-07-10T10:00:00.000Z"),
      randomId: () => "lease-token",
    },
  };
}

function workPackageForProjectionFixture(): FieldWorkPackage {
  return {
    name: "WORK-PACKAGE-A",
    id: "work_package_a",
    version: 1,
    status: "Acknowledged",
    title: "South roof replacement",
    objective: "Install the released metal system.",
    boundaries: "South roof only.",
    prerequisites: "Verify tie-off and material staging.",
    expectedResult: "Released roof section complete.",
    stopConditions: "Stop for unsafe weather or missing controls.",
    makeSafeProcedure: "Secure the work area.",
    issuedAt: "2026-07-10T07:00:00.000Z",
    expiresAt: "2026-07-11T07:00:00.000Z",
    releasedAt: "2026-07-10T07:05:00.000Z",
    releaseAttemptId: "attempt-a",
    acknowledgedBy: "crew@example.com",
    acknowledgedAt: "2026-07-10T07:10:00.000Z",
    steps: [
      {
        sequence: 1,
        instruction: "Verify the roof zone.",
        requiredEvidence: "Zone photo",
        acceptanceCriteria: "Zone matches package.",
      },
    ],
    holdPoints: [
      {
        sequence: 1,
        holdPoint: "Deck condition",
        releaseAuthority: "Supervisor",
        requiredEvidence: "Deck photo",
        acceptanceCriteria: "Supervisor release.",
        released: false,
      },
    ],
    assignedWorkers: [
      {
        sequence: 1,
        workerUser: "crew@example.com",
        workerRole: "Installer",
        required: true,
      },
    ],
    workerRosterKnown: true,
    acknowledgementLedgerAvailable: true,
    acknowledgements: [
      {
        actorUser: "crew@example.com",
        actorRole: "Installer",
        deviceActionId: "ack-device-123",
        occurredAt: "2026-07-10T07:10:00.000Z",
        releaseAttemptId: "attempt-a",
      },
    ],
    modified: "2026-07-10T07:10:00.000Z",
  };
}

test("work-package action parser accepts only the existing bounded action envelope", async () => {
  const request = new Request(
    "https://app.example.com/api/v1/jobs/JOB-A/work-package/acknowledgements",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-device-action-id": "device-action-123",
        "idempotency-key": "device-action-123",
      },
      body: JSON.stringify({
        device_action_id: "device-action-123",
        payload: {
          work_package_id: "work_package_a",
          work_package_version: 1,
          release_attempt_id: "attempt-a",
        },
      }),
    },
  );
  assert.deepEqual(
    await parseWorkPackageActionRequest(
      request,
      "JOB-A",
      "ASSIGN-A",
      "acknowledge",
    ),
    submission(),
  );

  await assert.rejects(
    parseWorkPackageActionRequest(
      new Request("https://app.example.com", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          device_action_id: "device-action-123",
          payload: {
            work_package_id: "work_package_a",
            work_package_version: 1,
            blocker_reason: "not here",
          },
        }),
      }),
      "JOB-A",
      "ASSIGN-A",
      "acknowledge",
    ),
    (error: unknown) =>
      error instanceof FieldActionError &&
      error.code === "invalid_work_package_action",
  );
});

test("universal work-object action parser requires and binds the complete typed scope", async () => {
  const scope = {
    workObjectType: "Shop Order",
    workObjectId: "SHOP-001",
    physicalContextType: "Shop Floor",
    physicalContextId: "SHOP-FLOOR-1",
  } as const;
  const parsed = await parseWorkPackageActionRequest(
    new Request("https://app.example.com", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-device-action-id": "shop-action-1",
        "idempotency-key": "shop-action-1",
      },
      body: JSON.stringify({
        device_action_id: "shop-action-1",
        payload: {
          work_package_id: "shop_package_1",
          work_package_version: 1,
          release_attempt_id: "shop-attempt-1",
          work_object_type: scope.workObjectType,
          work_object_id: scope.workObjectId,
          physical_context_type: scope.physicalContextType,
          physical_context_id: scope.physicalContextId,
        },
      }),
    }),
    scope.workObjectId,
    "SHOP-ASSIGN-1",
    "acknowledge",
    scope,
  );
  assert.equal(parsed.payload.work_object_type, "Shop Order");
  assert.equal(parsed.payload.physical_context_id, "SHOP-FLOOR-1");
  await assert.rejects(
    parseWorkPackageActionRequest(
      new Request("https://app.example.com", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          device_action_id: "shop-action-2",
          payload: {
            work_package_id: "shop_package_1",
            work_package_version: 1,
            release_attempt_id: "shop-attempt-1",
            work_object_type: scope.workObjectType,
          },
        }),
      }),
      scope.workObjectId,
      "SHOP-ASSIGN-1",
      "acknowledge",
      scope,
    ),
    (error: unknown) =>
      error instanceof FieldActionError &&
      error.code === "invalid_work_package_action",
  );
});

test("work-package capabilities require this actor's acknowledgement and every released hold", () => {
  const workPackage: FieldWorkPackage = {
    name: "WORK-PACKAGE-A",
    id: "work_package_a",
    version: 1,
    status: "Acknowledged",
    title: "South roof replacement",
    objective: "Install the released metal system.",
    boundaries: "South roof only.",
    prerequisites: "Verify tie-off and material staging.",
    expectedResult: "Released roof section complete.",
    stopConditions: "Stop for unsafe weather or missing controls.",
    makeSafeProcedure: "Secure the work area and notify the supervisor.",
    issuedAt: "2026-07-10T07:00:00.000Z",
    expiresAt: "2026-07-11T07:00:00.000Z",
    releasedAt: "2026-07-10T07:05:00.000Z",
    releaseAttemptId: "attempt-a",
    acknowledgedBy: "crew@example.com",
    acknowledgedAt: "2026-07-10T07:10:00.000Z",
    steps: [
      {
        sequence: 1,
        instruction: "Verify the roof zone.",
        requiredEvidence: "Zone photo",
        acceptanceCriteria: "Zone matches package.",
      },
    ],
    holdPoints: [
      {
        sequence: 1,
        holdPoint: "Deck condition",
        releaseAuthority: "Supervisor",
        requiredEvidence: "Deck photo",
        acceptanceCriteria: "Supervisor release.",
        released: false,
      },
    ],
    assignedWorkers: [
      {
        sequence: 1,
        workerUser: "crew@example.com",
        workerRole: "Installer",
        required: true,
      },
    ],
    workerRosterKnown: true,
    acknowledgementLedgerAvailable: true,
    acknowledgements: [
      {
        actorUser: "crew@example.com",
        actorRole: "Installer",
        deviceActionId: "ack-device-123",
        occurredAt: "2026-07-10T07:10:00.000Z",
        releaseAttemptId: "attempt-a",
      },
    ],
    modified: "2026-07-10T07:10:00.000Z",
  };
  const pendingHold = fieldWorkPackageProjection(
    workPackage,
    "crew@example.com",
  );
  assert.deepEqual(pendingHold.allowedActions, ["work_package.stop_work"]);
  assert.equal(pendingHold.work_package?.hold_points[0]?.released, false);

  const acknowledged = fieldWorkPackageProjection(
    {
      ...workPackage,
      holdPoints: workPackage.holdPoints.map((holdPoint) => ({
        ...holdPoint,
        released: true,
      })),
    },
    "crew@example.com",
  );
  assert.deepEqual(acknowledged.allowedActions, [
    "work_package.start",
    "work_package.stop_work",
  ]);
  assert.equal(
    acknowledged.work_package?.acknowledgement.current_user_acknowledged,
    true,
  );
  assert.deepEqual(acknowledged.work_package?.acknowledgement.workers, [
    {
      worker_user: "crew@example.com",
      worker_role: "Installer",
      required: true,
      acknowledged: true,
      acknowledged_at: "2026-07-10T07:10:00.000Z",
    },
  ]);
  assert.equal(acknowledged.work_package?.hold_points[0]?.released, true);
  const anotherActor = fieldWorkPackageProjection(
    workPackage,
    "other@example.com",
  );
  assert.deepEqual(anotherActor.allowedActions, ["work_package.stop_work"]);
  assert.equal(
    anotherActor.work_package?.acknowledgement.acknowledged_at,
    null,
  );
});

test("completion capability is production-authority-only and evidence-gated", () => {
  const completedEvidence = {
    eventId: "evidence-event-1",
    evidenceItem: "evidence-item-1",
    actorUser: "crew@example.com",
    actorRole: "Installer",
    deviceActionId: "evidence-device-1",
    occurredAt: "2026-07-10T07:12:00.000Z",
    slotId: "step:1",
    requirement: "Zone photo",
    source: "worker-camera",
    deviceId: "paired-device-1",
    capturedAt: "2026-07-10T07:12:00.000Z",
    freshness: "Current" as const,
    conflictState: "None" as const,
    correctionOf: null,
    itemCorrectionOf: null,
    verification: "Verified" as const,
    disposition: "Accepted" as const,
    correctionReason: null,
    reviewReason: null,
    releaseAttemptId: "attempt-a",
  };
  const inProgress: FieldWorkPackage = {
    ...workPackageForProjectionFixture(),
    status: "In Progress",
    evidenceLedgerAvailable: true,
    evidence: [
      completedEvidence,
      {
        ...completedEvidence,
        eventId: "evidence-event-2",
        evidenceItem: "evidence-item-2",
        deviceActionId: "evidence-device-2",
        slotId: "hold:1",
        requirement: "Deck photo",
      },
    ],
    holdPoints: [{
      ...workPackageForProjectionFixture().holdPoints[0]!,
      released: true,
    }],
  };
  assert.equal(
    fieldWorkPackageProjection(inProgress, "owner@example.com", {
      completionAuthority: true,
    }).allowedActions.includes("work_package.complete"),
    true,
  );
  assert.equal(
    hasWorkPackageCompletionAuthority(
      { ...inProgress, workObjectType: "Roof Job" },
      {},
      "owner@example.com",
      "owner",
    ),
    true,
    "the Roof Job adapter keeps role-governed independent completion",
  );
  assert.equal(
    fieldWorkPackageProjection(inProgress, "crew@example.com", {
      completionAuthority: true,
    }).allowedActions.includes("work_package.complete"),
    false,
  );
  assert.equal(
    fieldWorkPackageProjection(
      { ...inProgress, evidenceLedgerAvailable: false },
      "owner@example.com",
      { completionAuthority: true },
    ).allowedActions.includes("work_package.complete"),
    false,
  );
});

test("work-package start stays closed until every required worker acknowledges the exact packet", () => {
  const twoWorkers: FieldWorkPackage = {
    ...({
      name: "WORK-PACKAGE-MULTI",
      id: "work_package_multi",
      version: 4,
      status: "Acknowledged",
      title: "North roof replacement",
      objective: "Install the released metal system.",
      boundaries: "North roof only.",
      prerequisites: "Verify tie-off and material staging.",
      expectedResult: "Released roof section complete.",
      stopConditions: "Stop for unsafe weather or missing controls.",
      makeSafeProcedure: "Secure the work area.",
      issuedAt: "2026-07-10T07:00:00.000Z",
      expiresAt: "2026-07-11T07:00:00.000Z",
      releasedAt: "2026-07-10T07:05:00.000Z",
      releaseAttemptId: "attempt-a",
      acknowledgedBy: "crew-a@example.com",
      acknowledgedAt: "2026-07-10T07:10:00.000Z",
      steps: [
        {
          sequence: 1,
          instruction: "Verify the roof zone.",
          requiredEvidence: "Zone photo",
          acceptanceCriteria: "Zone matches package.",
        },
      ],
      holdPoints: [
        {
          sequence: 1,
          holdPoint: "Deck condition",
          releaseAuthority: "Supervisor",
          requiredEvidence: "Deck photo",
          acceptanceCriteria: "Supervisor release.",
          released: true,
        },
      ],
      assignedWorkers: [
        {
          sequence: 1,
          workerUser: "crew-a@example.com",
          workerRole: "Installer",
          required: true,
        },
        {
          sequence: 2,
          workerUser: "crew-b@example.com",
          workerRole: "Spotter",
          required: true,
        },
      ],
      workerRosterKnown: true,
      acknowledgementLedgerAvailable: true,
      acknowledgements: [
        {
          actorUser: "crew-a@example.com",
          actorRole: "Installer",
          deviceActionId: "ack-a",
          occurredAt: "2026-07-10T07:10:00.000Z",
          releaseAttemptId: "attempt-a",
        },
      ],
      evidenceLedgerAvailable: true,
      evidence: [],
      modified: "2026-07-10T07:10:00.000Z",
    } satisfies FieldWorkPackage),
  };

  const pending = fieldWorkPackageProjection(twoWorkers, "crew-a@example.com");
  assert.deepEqual(pending.allowedActions, ["work_package.stop_work"]);
  assert.equal(
    pending.work_package?.acknowledgement.workers[1]?.acknowledged,
    false,
  );

  const complete = fieldWorkPackageProjection(
    {
      ...twoWorkers,
      acknowledgements: [
        ...twoWorkers.acknowledgements!,
        {
          actorUser: "crew-b@example.com",
          actorRole: "Spotter",
          deviceActionId: "ack-b",
          occurredAt: "2026-07-10T07:11:00.000Z",
          releaseAttemptId: "attempt-a",
        },
      ],
    },
    "crew-a@example.com",
  );
  assert.deepEqual(complete.allowedActions, [
    "work_package.start",
    "work_package.stop_work",
  ]);

  const unavailable = fieldWorkPackageProjection(
    { ...twoWorkers, acknowledgementLedgerAvailable: false },
    "crew-a@example.com",
  );
  assert.deepEqual(unavailable.allowedActions, ["work_package.stop_work"]);
});

test("optional roster rows remain visible without invalidating a required worker ledger", () => {
  const projection = fieldWorkPackageProjection(
    {
      ...workPackageForProjectionFixture(),
      assignedWorkers: [
        ...workPackageForProjectionFixture().assignedWorkers!,
        {
          sequence: 2,
          workerUser: "helper@example.com",
          workerRole: "Apprentice",
          required: false,
        },
      ],
    },
    "crew@example.com",
  );
  assert.equal(projection.work_package?.acknowledgement.workers.length, 2);
  assert.equal(projection.work_package?.acknowledgement.workers[1]?.required, false);
  assert.equal(projection.allowedActions.includes("work_package.stop_work"), true);
});

test("work-package action writes immutable raw evidence before one Frappe command and replays exactly", async () => {
  const { store, objects, frappe, dependency } = dependencies();
  const first = await processWorkPackageAction(
    submission(),
    auth(),
    dependency,
  );
  const replay = await processWorkPackageAction(
    submission(),
    auth(),
    dependency,
  );
  assert.deepEqual(replay, first);
  assert.equal(store.completed, 1);
  assert.equal(frappe.calls.length, 1);
  assert.equal(objects.calls.length, 1);
  const manifest = objects.bodies.get(objects.calls[0]!);
  assert.ok(manifest);
  assert.match(manifest!, /"actor_user":"crew@example.com"/);
  assert.match(manifest!, /"action_kind":"acknowledge"/);
  assert.deepEqual(frappe.calls[0], {
    kind: "acknowledge",
    workPackageId: "work_package_a",
    workPackageVersion: 1,
    jobId: "JOB-A",
    assignmentId: "ASSIGN-A",
    actorUser: "crew@example.com",
    deviceActionId: "device-action-123",
    blockerReason: null,
    releaseAttemptId: "attempt-a",
    workObjectType: null,
    workObjectId: null,
    physicalContextType: null,
    physicalContextId: null,
  });
});

test("production completion action uses the bounded online Frappe command and replays", async () => {
  const { store, objects, frappe, dependency } = dependencies();
  const first = await processWorkPackageAction(
    submission("complete_work"),
    auth("owner"),
    dependency,
  );
  const replay = await processWorkPackageAction(
    submission("complete_work"),
    auth("owner"),
    dependency,
  );
  assert.deepEqual(replay, first);
  assert.equal(frappe.calls[0]?.kind, "complete_work");
  assert.equal(objects.calls.length, 1);
  assert.equal(store.completed, 1);
});

test("typed non-roof action persists the exact parent/context envelope", async () => {
  const { frappe, dependency } = dependencies();
  const generic = submission("acknowledge");
  generic.jobId = "SHOP-001";
  generic.assignmentId = "SHOP-ASSIGN-1";
  generic.payload = {
    ...generic.payload,
    work_object_type: "Shop Order",
    work_object_id: "SHOP-001",
    physical_context_type: "Shop Floor",
    physical_context_id: "SHOP-FLOOR-1",
  };
  await processWorkPackageAction(generic, auth(), dependency);
  assert.deepEqual(
    {
      workObjectType: frappe.calls[0]?.workObjectType,
      workObjectId: frappe.calls[0]?.workObjectId,
      physicalContextType: frappe.calls[0]?.physicalContextType,
      physicalContextId: frappe.calls[0]?.physicalContextId,
    },
    {
      workObjectType: "Shop Order",
      workObjectId: "SHOP-001",
      physicalContextType: "Shop Floor",
      physicalContextId: "SHOP-FLOOR-1",
    },
  );
});

test("work-package action rejects a changed duplicate payload and retries an unverified Frappe command", async () => {
  const { store, frappe, dependency } = dependencies();
  frappe.failOnce = true;
  await assert.rejects(
    processWorkPackageAction(submission("stop_work"), auth(), dependency),
    (error: unknown) =>
      error instanceof FieldActionError &&
      error.code === "work_package_frappe_network_error",
  );
  assert.equal(store.failed, 1);
  const verified = await processWorkPackageAction(
    submission("stop_work"),
    auth(),
    dependency,
  );
  assert.equal(verified.status, "verified");
  assert.equal(frappe.calls.length, 2);

  await assert.rejects(
    processWorkPackageAction(submission("acknowledge"), auth(), dependency),
    (error: unknown) =>
      error instanceof FieldActionError &&
      error.code === "idempotency_conflict" &&
      error.status === 409,
  );
});

test("runtime-governed work-package actions read back the immutable event and replay safely", async () => {
  const db = new SqliteD1();
  const env = {
    ERPNEXT_BASE_URL: "https://frappe.example.com",
    ERPNEXT_API_KEY: "key",
    ERPNEXT_API_SECRET: "secret",
    APP_TENANT_ID: "ironwrap",
    EFFECT_RUNTIME_ENABLED: "true",
    DB: db,
  } as unknown as AppEnv;
  const originalFetch = globalThis.fetch;
  const requests: Array<{ method: string; url: string }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = String(init?.method ?? "GET");
    requests.push({ method, url });
    if (method === "GET") {
      const eventName = decodeURIComponent(url.split("/").pop() ?? "");
      return Response.json({ data: {
        name: eventName,
        work_package_event_id: eventName,
        work_package: "WP-work_package_a",
      } });
    }
    const body = JSON.parse(String(init?.body)) as { device_action_id: string };
    const eventName = `wpe_${createHash("sha256").update(body.device_action_id).digest("hex").slice(0, 32)}`;
    return Response.json({ message: {
      work_package: { name: "WP-work_package_a" },
      event: { name: eventName },
    } });
  };
  try {
    const writer = frappeWorkPackageWriter(env);
    const input: PersistWorkPackageActionInput = {
      kind: "acknowledge",
      workPackageId: "work_package_a",
      workPackageVersion: 1,
      jobId: "JOB-A",
      assignmentId: "ASSIGN-A",
      actorUser: "crew@example.com",
      deviceActionId: "device-action-123",
      blockerReason: null,
      releaseAttemptId: null,
      workObjectType: null,
      workObjectId: null,
      physicalContextType: null,
      physicalContextId: null,
    };
    const expected = {
      workPackageName: "WP-work_package_a",
      eventName: `wpe_${createHash("sha256").update(input.deviceActionId).digest("hex").slice(0, 32)}`,
    };
    assert.deepEqual(await writer.persistAction(input), expected);
    assert.deepEqual(await writer.persistAction(input), expected);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(requests.filter((request) => request.method === "POST").length, 1);
  assert.equal(requests.filter((request) => request.method === "GET").length, 2);
  const effect = db.raw.prepare(
    "SELECT state, provider_external_id FROM external_effects WHERE action = 'work_package.mutation'",
  ).get() as { state: string; provider_external_id: string };
  assert.equal(effect.state, "succeeded");
  assert.match(effect.provider_external_id, /^wpe_/);
});

test("all work-package routes fail before mutation for office roles, bad CSRF, or unassigned field users", async () => {
  const appEnv = {
    ERPNEXT_BASE_URL: "https://frappe.example.com",
    ERPNEXT_API_KEY: "key",
    ERPNEXT_API_SECRET: "secret",
  } as AppEnv;
  const paths = [
    "/api/v1/jobs/JOB-C/work-package/acknowledgements",
    "/api/v1/jobs/JOB-C/work-package/stop-work",
    "/api/v1/jobs/JOB-C/work-package/start",
  ];
  for (const path of paths) {
    const request = (csrf: string) =>
      new Request(`https://app.example.com${path}`, {
        method: "POST",
        headers: { "x-csrf-token": csrf, "content-type": "application/json" },
        body: JSON.stringify({
          device_action_id: "device-action-123",
          payload: {
            work_package_id: "work_package_a",
            work_package_version: 1,
          },
        }),
      });
    assert.equal(
      (await handleAuthenticatedRoute(request("csrf"), appEnv, auth("owner")))
        .status,
      403,
    );
    assert.equal(
      (await handleAuthenticatedRoute(request("wrong"), appEnv, auth("field")))
        .status,
      403,
    );
  }
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ data: [] });
  try {
    const denied = await handleAuthenticatedRoute(
      new Request(
        "https://app.example.com/api/v1/jobs/JOB-C/work-package/acknowledgements",
        {
          method: "POST",
          headers: {
            "x-csrf-token": "csrf",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            device_action_id: "device-action-123",
            payload: {
              work_package_id: "work_package_a",
              work_package_version: 1,
            },
          }),
        },
      ),
      appEnv,
      auth("field"),
    );
    assert.equal(denied.status, 404);
    assert.deepEqual(await denied.json(), { error: "not_found" });
  } finally {
    globalThis.fetch = original;
  }
});

test("typed completion route binds exact authority identity and declared role before action processing", async () => {
  let actionStoreTouched = false;
  const appEnv = {
    ERPNEXT_BASE_URL: "https://frappe.example.com",
    ERPNEXT_API_KEY: "key",
    ERPNEXT_API_SECRET: "secret",
    DB: {
      prepare() {
        actionStoreTouched = true;
        throw new Error("action store must not be reached");
      },
    },
  } as AppEnv;
  const original = globalThis.fetch;
  const requests: Request[] = [];
  globalThis.fetch = async (input, init) => {
    const request =
      input instanceof Request ? input : new Request(input.toString(), init);
    requests.push(request);
    return Response.json({
      data: [
        {
          name: "ASSIGN-SHOP-1",
          assignment_id: "assignment_shop_1",
          assignment_type: "Shop",
          status: "In Progress",
          authority_user: "actual-authority@example.com",
          authority_role: "IronWrap Owner",
          assigned_by: "production@example.com",
          work_object_type: "Shop Order",
          work_object_id: "SHOP-001",
          physical_context_type: "Shop Floor",
          physical_context_id: "SHOP-FLOOR-1",
        },
      ],
    });
  };
  const completeRequest = (actionId: string) =>
    new Request(
      "https://app.example.com/api/v1/work-objects/Shop%20Order/SHOP-001/physical-contexts/Shop%20Floor/SHOP-FLOOR-1/work-package/complete",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": "csrf",
          "x-device-action-id": actionId,
          "idempotency-key": actionId,
        },
        body: JSON.stringify({
          device_action_id: actionId,
          payload: {
            work_package_id: "work_package_shop_1",
            work_package_version: 1,
            release_attempt_id: "shop-release-attempt-1",
            work_object_type: "Shop Order",
            work_object_id: "SHOP-001",
            physical_context_type: "Shop Floor",
            physical_context_id: "SHOP-FLOOR-1",
          },
        }),
      },
    );
  try {
    for (const role of ["owner", "ops", "production"] as const) {
      const response = await handleAuthenticatedRoute(
        completeRequest(`unrelated-${role}-action`),
        appEnv,
        auth(role),
      );
      assert.equal(response.status, 403, `${role} must fail at the Worker`);
      assert.deepEqual(await response.json(), {
        error: "work_package_completion_authority_required",
      });
    }
    assert.equal(
      actionStoreTouched,
      false,
      "wrong users and assigned_by-only provenance must fail before D1",
    );

    const wrongRole = auth("production");
    wrongRole.session.frappe_user_id = "actual-authority@example.com";
    const wrongRoleResponse = await handleAuthenticatedRoute(
      completeRequest("wrong-declared-role-action"),
      appEnv,
      wrongRole,
    );
    assert.equal(wrongRoleResponse.status, 403);
    assert.deepEqual(await wrongRoleResponse.json(), {
      error: "work_package_completion_authority_required",
    });
    assert.equal(actionStoreTouched, false);

    const exactAuthority = auth("owner");
    exactAuthority.session.frappe_user_id = "actual-authority@example.com";
    const exactResponse = await handleAuthenticatedRoute(
      completeRequest("exact-authority-action"),
      appEnv,
      exactAuthority,
    );
    assert.equal(
      exactResponse.status,
      502,
      "the exact authority and declared role must pass the pre-action gate",
    );
    assert.equal(actionStoreTouched, true);
    assert.equal(
      requests.every((request) => request.method === "GET"),
      true,
      "an unrelated office session must never reach a Frappe mutation",
    );
  } finally {
    globalThis.fetch = original;
  }
});
