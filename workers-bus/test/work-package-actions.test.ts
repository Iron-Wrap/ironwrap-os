import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAuthenticatedRoute } from "../src/app-api.ts";
import { canonicalJson, sha256Hex } from "../src/newo-hash.ts";
import {
  appUserIdentities,
  permissionsForRole,
  type AppEnv,
  type AuthContext,
} from "../src/app-types.ts";
import {
  parseWorkPackageActionRequest,
  processWorkPackageAction,
  type PersistWorkPackageActionInput,
  type ProcessWorkPackageActionDependencies,
  type VerifiedWorkPackageActionResponse,
  type WorkPackageCommandWriter,
  type WorkPackageActionStore,
} from "../src/work-package-actions.ts";
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

class MemoryWriter implements WorkPackageCommandWriter {
  readonly calls: PersistWorkPackageActionInput[] = [];
  failOnce = false;

  async persistAction(
    input: PersistWorkPackageActionInput,
  ): Promise<{ workPackageName: string; eventName: string }> {
    this.calls.push(input);
    if (this.failOnce) {
      this.failOnce = false;
      throw new Error("work_package_native_write_failed");
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
  native = new MemoryWriter(),
): {
  store: MemoryStore;
  objects: MemoryObjects;
  native: MemoryWriter;
  dependency: ProcessWorkPackageActionDependencies;
} {
  return {
    store,
    objects,
    native,
    dependency: {
      store,
      objects,
      native,
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

test("native field identity retains Work Package capability without a Frappe link", () => {
  const nativeAuth = auth("field");
  nativeAuth.session.frappe_user_id = null;
  nativeAuth.session.email_normalized = "crew@example.com";
  const workPackage = {
    ...workPackageForProjectionFixture(),
    status: "Released" as const,
    acknowledgedBy: null,
    acknowledgedAt: null,
    acknowledgements: [],
  };
  const projection = fieldWorkPackageProjection(
    workPackage,
    appUserIdentities(nativeAuth.session),
  );
  assert.deepEqual(appUserIdentities(nativeAuth.session), [
    "crew@example.com",
    "appu_field",
  ]);
  assert.equal(
    projection.allowedActions.includes("work_package.acknowledge"),
    true,
  );
});

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

test("two workers may each keep a current evidence instance; a shared slot stays conflicted", () => {
  const base = workPackageForProjectionFixture();
  const shared = {
    eventId: "evidence-event-a",
    evidenceItem: "evidence-item-a",
    actorUser: "crew-a@example.com",
    actorRole: "Installer",
    deviceActionId: "evidence-device-a",
    occurredAt: "2026-07-10T07:12:00.000Z",
    slotId: "step:1",
    requirement: "Zone photo",
    source: "worker-camera",
    deviceId: "paired-device-a",
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
  const projection = fieldWorkPackageProjection(
    {
      ...base,
      status: "In Progress",
      evidenceLedgerAvailable: true,
      assignedWorkers: [
        { sequence: 1, workerUser: "crew-a@example.com", workerRole: "Installer", required: true },
        { sequence: 2, workerUser: "crew-b@example.com", workerRole: "Spotter", required: true },
      ],
      evidence: [
        shared,
        {
          ...shared,
          eventId: "evidence-event-b",
          evidenceItem: "evidence-item-b",
          actorUser: "crew-b@example.com",
          actorRole: "Spotter",
          deviceActionId: "evidence-device-b",
          deviceId: "paired-device-b",
        },
        {
          ...shared,
          eventId: "evidence-event-hold",
          evidenceItem: "evidence-item-hold",
          slotId: "hold:1",
          requirement: "Deck photo",
          deviceActionId: "evidence-device-hold",
        },
      ],
      holdPoints: [{ ...base.holdPoints[0]!, released: true }],
    },
    "owner@example.com",
    { completionAuthority: true },
  );
  assert.equal(projection.work_package?.evidence_slots.length, 3);
  assert.equal(
    projection.work_package?.evidence_slots.filter((slot) => slot.slot_id === "step:1")
      .every((slot) => slot.conflict_state === "Detected"),
    true,
  );
  assert.equal(projection.allowedActions.includes("work_package.complete"), false);
});

test("sibling corrections by one worker keep a shared slot conflicted", () => {
  const base = workPackageForProjectionFixture();
  const original = {
    eventId: "evidence-event-original",
    evidenceItem: "evidence-item-original",
    actorUser: "crew-a@example.com",
    actorRole: "Installer",
    deviceActionId: "evidence-device-original",
    occurredAt: "2026-07-10T07:12:00.000Z",
    slotId: "step:1",
    requirement: "Zone photo",
    source: "worker-camera",
    deviceId: "paired-device-a",
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
  const projection = fieldWorkPackageProjection(
    {
      ...base,
      status: "In Progress",
      evidenceLedgerAvailable: true,
      assignedWorkers: [
        { sequence: 1, workerUser: "crew-a@example.com", workerRole: "Installer", required: true },
      ],
      evidence: [
        original,
        {
          ...original,
          eventId: "evidence-event-correction-a",
          evidenceItem: "evidence-item-correction-a",
          deviceActionId: "evidence-device-correction-a",
          correctionOf: original.eventId,
          itemCorrectionOf: original.evidenceItem,
          correctionReason: "Retake from the west edge",
        },
        {
          ...original,
          eventId: "evidence-event-correction-b",
          evidenceItem: "evidence-item-correction-b",
          deviceActionId: "evidence-device-correction-b",
          correctionOf: original.eventId,
          itemCorrectionOf: original.evidenceItem,
          correctionReason: "Retake with the full roof plane",
        },
        {
          ...original,
          eventId: "evidence-event-hold",
          evidenceItem: "evidence-item-hold",
          slotId: "hold:1",
          requirement: "Deck photo",
          deviceActionId: "evidence-device-hold",
        },
      ],
      holdPoints: [{ ...base.holdPoints[0]!, released: true }],
    },
    "owner@example.com",
    { completionAuthority: true },
  );
  assert.equal(
    projection.work_package?.evidence_slots
      .filter((slot) => slot.slot_id === "step:1")
      .every((slot) => slot.conflict_state === "Detected"),
    true,
  );
  assert.equal(projection.allowedActions.includes("work_package.complete"), false);
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

test("work-package action writes immutable raw evidence before one native command and replays exactly", async () => {
  const { store, objects, native, dependency } = dependencies();
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
  assert.equal(native.calls.length, 1);
  assert.equal(objects.calls.length, 1);
  const manifest = objects.bodies.get(objects.calls[0]!);
  assert.ok(manifest);
  assert.match(manifest!, /"actor_user":"appu_field"/);
  assert.match(manifest!, /"action_kind":"acknowledge"/);
  const manifestKey = objects.calls[0];
  assert.ok(manifestKey);
  assert.deepEqual(native.calls[0], {
    kind: "acknowledge",
    workPackageId: "work_package_a",
    workPackageVersion: 1,
    jobId: "JOB-A",
    assignmentId: "ASSIGN-A",
    actorUser: "appu_field",
    actorRole: "field",
    deviceActionId: "device-action-123",
    blockerReason: null,
    releaseAttemptId: "attempt-a",
    workObjectType: null,
    workObjectId: null,
    physicalContextType: null,
    physicalContextId: null,
    manifestKey,
    authorityPreconditions: [],
  });
});

test("a stop without typed words preserves the attempt and records that no reason was provided", async () => {
  const raw = {
    device_action_id: "stop-no-reason-123",
    payload: {
      work_package_id: "work_package_a",
      work_package_version: 1,
      blocker_reason: "",
    },
  };
  const request = new Request(
    "https://app.example.com/api/v1/jobs/JOB-A/work-package/stop-work",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-device-action-id": raw.device_action_id,
        "idempotency-key": raw.device_action_id,
      },
      body: JSON.stringify(raw),
    },
  );
  const parsed = await parseWorkPackageActionRequest(
    request,
    "JOB-A",
    "ASSIGN-A",
    "stop_work",
  );
  assert.equal(parsed.payload.blocker_reason, "");

  const { store, objects, native, dependency } = dependencies();
  const first = await processWorkPackageAction(parsed, auth(), dependency);
  assert.deepEqual(
    await processWorkPackageAction(parsed, auth(), dependency),
    first,
  );
  assert.equal(native.calls.length, 1);
  assert.equal(native.calls[0]?.blockerReason, null);
  assert.equal(store.completed, 1);
  assert.equal(objects.calls.length, 1);
  const manifest = objects.bodies.get(objects.calls[0]!);
  assert.ok(manifest);
  assert.equal(JSON.parse(manifest).payload.blocker_reason, "");

  await assert.rejects(
    processWorkPackageAction(
      {
        ...parsed,
        payload: { ...parsed.payload, blocker_reason: "Ice on the roof" },
      },
      auth(),
      dependency,
    ),
    (error: unknown) =>
      error instanceof FieldActionError &&
      error.code === "idempotency_conflict",
  );
});

test("a stop accepts an absent, null, or longer explanation without changing its words", async () => {
  for (const [suffix, reason] of [
    ["absent", undefined],
    ["null", null],
    ["long", "A".repeat(1_201)],
  ] as const) {
    const deviceActionId = `stop-reason-${suffix}-123`;
    const payload = {
      work_package_id: "work_package_a",
      work_package_version: 1,
      ...(reason === undefined ? {} : { blocker_reason: reason }),
    };
    const request = new Request(
      "https://app.example.com/api/v1/jobs/JOB-A/work-package/stop-work",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-device-action-id": deviceActionId,
          "idempotency-key": deviceActionId,
        },
        body: JSON.stringify({ device_action_id: deviceActionId, payload }),
      },
    );
    const parsed = await parseWorkPackageActionRequest(request, "JOB-A", "ASSIGN-A", "stop_work");
    assert.deepEqual(parsed.payload, payload);
    const { objects, native, dependency } = dependencies();
    await processWorkPackageAction(parsed, auth(), dependency);
    assert.equal(native.calls[0]?.blockerReason, typeof reason === "string" ? reason : null);
    assert.deepEqual(JSON.parse(objects.bodies.get(objects.calls[0]!)!).payload, payload);
  }
});

test("a stop refuses an overlong explanation before any command is written", async () => {
  const deviceActionId = "stop-overlong-123";
  const request = new Request(
    "https://app.example.com/api/v1/jobs/JOB-A/work-package/stop-work",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-device-action-id": deviceActionId,
        "idempotency-key": deviceActionId,
      },
      body: JSON.stringify({
        device_action_id: deviceActionId,
        payload: {
          work_package_id: "work_package_a",
          work_package_version: 1,
          blocker_reason: "A".repeat(4_001),
        },
      }),
    },
  );
  await assert.rejects(
    parseWorkPackageActionRequest(request, "JOB-A", "ASSIGN-A", "stop_work"),
    (error: unknown) => error instanceof FieldActionError && error.status === 400,
  );
});

test("production completion action uses the bounded native command and replays", async () => {
  const { store, objects, native, dependency } = dependencies();
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
  assert.equal(native.calls[0]?.kind, "complete_work");
  assert.equal(objects.calls.length, 1);
  assert.equal(store.completed, 1);
});

test("typed non-roof action persists the exact parent/context envelope", async () => {
  const { native, dependency } = dependencies();
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
      workObjectType: native.calls[0]?.workObjectType,
      workObjectId: native.calls[0]?.workObjectId,
      physicalContextType: native.calls[0]?.physicalContextType,
      physicalContextId: native.calls[0]?.physicalContextId,
    },
    {
      workObjectType: "Shop Order",
      workObjectId: "SHOP-001",
      physicalContextType: "Shop Floor",
      physicalContextId: "SHOP-FLOOR-1",
    },
  );
});

test("work-package action rejects a changed duplicate payload and retries an unverified native command", async () => {
  const { store, native, dependency } = dependencies();
  native.failOnce = true;
  await assert.rejects(
    processWorkPackageAction(submission("stop_work"), auth(), dependency),
    (error: unknown) =>
      error instanceof FieldActionError &&
      error.code === "work_package_native_write_failed",
  );
  assert.equal(store.failed, 1);
  const verified = await processWorkPackageAction(
    submission("stop_work"),
    auth(),
    dependency,
  );
  assert.equal(verified.status, "verified");
  assert.equal(native.calls.length, 2);

  await assert.rejects(
    processWorkPackageAction(submission("acknowledge"), auth(), dependency),
    (error: unknown) =>
      error instanceof FieldActionError &&
      error.code === "idempotency_conflict" &&
      error.status === 409,
  );
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
      prepare(sql: string) {
        if (sql.includes("FROM operating_work_object_assignments current")) {
          return {
            bind() {
              return {
                async all() {
                  return {
                    results: [
                      {
                        assignment_id: "ASSIGN-SHOP-1",
                        tenant_id: "ironwrap",
                        work_object_type: "Shop Order",
                        work_object_id: "SHOP-001",
                        physical_context_type: "Shop Floor",
                        physical_context_id: "SHOP-FLOOR-1",
                        assignment_version: 1,
                        assigned_users_json: JSON.stringify(["appu_field"]),
                        scheduled_start: "2026-07-10T08:00:00.000Z",
                        scheduled_end: null,
                        authority_user_id: "appu_actual_authority",
                        authority_role: "owner",
                        supersedes_assignment_id: null,
                        correction_reason: null,
                        actor_user_id: "appu_production",
                        command_fingerprint: "c".repeat(64),
                        idempotency_key_hash: "d".repeat(64),
                        created_at: "2026-07-10T08:00:00.000Z",
                      },
                    ],
                  };
                },
              };
            },
          };
        }
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
    throw new Error(`Frappe must not be called: ${request.url}`);
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
    wrongRole.session.user_id = "appu_actual_authority";
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
    exactAuthority.session.user_id = "appu_actual_authority";
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
    assert.deepEqual(
      requests,
      [],
      "native typed authority must not call Frappe",
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("typed terminal action replays before current-assignment lookup and rejects payload drift", async () => {
  const actionId = "terminal-complete-action-1";
  const payload = {
    work_package_id: "work_package_shop_terminal",
    work_package_version: 1,
    release_attempt_id: "shop-release-terminal-1",
    work_object_type: "Shop Order",
    work_object_id: "SHOP-TERMINAL-1",
    physical_context_type: "Shop Floor",
    physical_context_id: "SHOP-FLOOR-1",
  };
  const payloadHash = await sha256Hex(
    canonicalJson({
      action_kind: "complete_work",
      assignment_id: "ASSIGN-TERMINAL-1",
      job_id: "SHOP-TERMINAL-1",
      payload,
    }),
  );
  const response = {
    device_action_id: actionId,
    status: "verified",
    server_ref: payload.work_package_id,
    cursor: "wpe_terminal_complete_1",
  } as const;
  let assignmentLookupTouched = false;
  const appEnv = {
    APP_TENANT_ID: "ironwrap",
    DB: {
      prepare(sql: string) {
        if (!sql.includes("FROM field_work_package_actions")) {
          assignmentLookupTouched = true;
          throw new Error("current assignment must not be read for a durable replay");
        }
        return {
          bind() {
            return {
              async first() {
                return {
                  device_action_id: actionId,
                  tenant_id: "ironwrap",
                  user_id: "appu_owner",
                  job_id: "SHOP-TERMINAL-1",
                  assignment_id: "ASSIGN-TERMINAL-1",
                  work_package_id: payload.work_package_id,
                  action_kind: "complete_work",
                  payload_hash: payloadHash,
                  status: "verified",
                  processing_token: null,
                  lease_expires_at: null,
                  response_json: JSON.stringify(response),
                };
              },
            };
          },
        };
      },
    },
  } as unknown as AppEnv;
  const request = (workPackageVersion: number) =>
    new Request(
      "https://app.example.com/api/v1/work-objects/Shop%20Order/SHOP-TERMINAL-1/physical-contexts/Shop%20Floor/SHOP-FLOOR-1/work-package/complete",
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
          payload: { ...payload, work_package_version: workPackageVersion },
        }),
      },
    );
  const replay = await handleAuthenticatedRoute(request(1), appEnv, auth("owner"));
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), response);
  assert.equal(assignmentLookupTouched, false);

  const conflict = await handleAuthenticatedRoute(request(2), appEnv, auth("owner"));
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json() as { error: string }).error, "idempotency_conflict");
  assert.equal(assignmentLookupTouched, false);
});

test("roof-job terminal action replays before current-assignment lookup and rejects payload drift", async () => {
  const actionId = "terminal-roof-complete-action-1";
  const payload = {
    work_package_id: "work_package_roof_terminal",
    work_package_version: 1,
    release_attempt_id: "roof-release-terminal-1",
  };
  const payloadHash = await sha256Hex(
    canonicalJson({
      action_kind: "complete_work",
      assignment_id: "ASSIGN-ROOF-TERMINAL-1",
      job_id: "JOB-ROOF-TERMINAL-1",
      payload,
    }),
  );
  const response = {
    device_action_id: actionId,
    status: "verified",
    server_ref: payload.work_package_id,
    cursor: "wpe_terminal_roof_complete_1",
  } as const;
  let assignmentLookupTouched = false;
  const appEnv = {
    APP_TENANT_ID: "ironwrap",
    DB: {
      prepare(sql: string) {
        if (!sql.includes("FROM field_work_package_actions")) {
          assignmentLookupTouched = true;
          throw new Error("current assignment must not be read for a durable replay");
        }
        return {
          bind() {
            return {
              async first() {
                return {
                  device_action_id: actionId,
                  tenant_id: "ironwrap",
                  user_id: "appu_owner",
                  job_id: "JOB-ROOF-TERMINAL-1",
                  assignment_id: "ASSIGN-ROOF-TERMINAL-1",
                  work_package_id: payload.work_package_id,
                  action_kind: "complete_work",
                  payload_hash: payloadHash,
                  status: "verified",
                  processing_token: null,
                  lease_expires_at: null,
                  response_json: JSON.stringify(response),
                };
              },
            };
          },
        };
      },
    },
  } as unknown as AppEnv;
  const request = (workPackageVersion: number) =>
    new Request(
      "https://app.example.com/api/v1/jobs/JOB-ROOF-TERMINAL-1/work-package/complete",
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
          payload: { ...payload, work_package_version: workPackageVersion },
        }),
      },
    );
  const replay = await handleAuthenticatedRoute(request(1), appEnv, auth("owner"));
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), response);
  assert.equal(assignmentLookupTouched, false);

  const conflict = await handleAuthenticatedRoute(request(2), appEnv, auth("owner"));
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json() as { error: string }).error, "idempotency_conflict");
  assert.equal(assignmentLookupTouched, false);
});
