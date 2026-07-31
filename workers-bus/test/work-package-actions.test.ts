import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAuthenticatedRoute } from "../src/app-api.ts";
import type { AppEnv, AuthContext } from "../src/app-types.ts";
import {
  parseWorkPackageActionRequest,
  processWorkPackageAction,
  type PersistWorkPackageActionInput,
  type ProcessWorkPackageActionDependencies,
  type VerifiedWorkPackageActionResponse,
  type WorkPackageActionStore,
  type WorkPackageFrappeWriter,
} from "../src/work-package-actions.ts";
import {
  FieldActionError,
  type ImmutableObjectStore,
} from "../src/field-actions.ts";
import {
  fieldWorkPackageProjection,
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

function auth(role: "field" | "owner" = "field"): AuthContext {
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: [],
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
        role === "field" ? "crew@example.com" : "owner@example.com",
      active: 1,
      created_by: "owner@example.com",
      created_at: "2026-07-10T10:00:00.000Z",
      updated_at: "2026-07-10T10:00:00.000Z",
    },
  };
}

function submission(
  kind: "acknowledge" | "stop_work" | "start_work" = "acknowledge",
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
            blocker_reason: "Wind exceeds the released safety limit.",
          }
        : { work_package_id: "work_package_a" },
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
        payload: { work_package_id: "work_package_a" },
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
    jobId: "JOB-A",
    assignmentId: "ASSIGN-A",
    actorUser: "crew@example.com",
    deviceActionId: "device-action-123",
    blockerReason: null,
  });
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
          payload: { work_package_id: "work_package_a" },
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
            payload: { work_package_id: "work_package_a" },
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
