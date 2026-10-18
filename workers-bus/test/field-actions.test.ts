import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FieldActionError,
  claimFieldUploadWindow,
  listFieldWorkPackageEvidenceFromD1,
  mediaSignatureMatches,
  parseFieldActionRequest,
  processFieldSubmission,
  r2ObjectStore,
  type FieldActionPayload,
  type FieldEvidenceAuthorizer,
  type FieldActionStore,
  type FieldMediaReceipt,
  type FieldSubmission,
  type ImmutableObjectStore,
  type VerifiedFieldActionResponse,
} from "../src/field-actions.ts";
import {
  permissionsForRole,
  type AppEnv,
  type AppRole,
  type AuthContext,
} from "../src/app-types.ts";
import { handleAuthenticatedRoute } from "../src/app-api.ts";

class MemoryFieldStore implements FieldActionStore {
  actions = new Map<
    string,
    {
      tenantId: string;
      userId: string;
      payloadHash: string;
      input: Parameters<FieldActionStore["claim"]>[0];
      response?: VerifiedFieldActionResponse;
      state: "processing" | "retry" | "verified";
    }
  >();
  media = new Map<string, FieldMediaReceipt>();
  completed = 0;
  loseResponseOnce = false;

  async claim(
    input: Parameters<FieldActionStore["claim"]>[0],
  ): ReturnType<FieldActionStore["claim"]> {
    const existing = this.actions.get(input.deviceActionId);
    if (!existing) {
      this.actions.set(input.deviceActionId, {
        tenantId: input.tenantId,
        userId: input.userId,
        payloadHash: input.payloadHash,
        input,
        state: "processing",
      });
      return { state: "acquired" };
    }
    if (
      existing.tenantId !== input.tenantId ||
      existing.userId !== input.userId ||
      existing.payloadHash !== input.payloadHash ||
      existing.input.workPackageId !== input.workPackageId ||
      existing.input.workPackageVersion !== input.workPackageVersion ||
      existing.input.evidenceSlotId !== input.evidenceSlotId ||
      existing.input.evidenceRequirement !== input.evidenceRequirement ||
      existing.input.evidenceDeviceId !== input.evidenceDeviceId ||
      existing.input.workObjectType !== input.workObjectType ||
      existing.input.workObjectId !== input.workObjectId ||
      existing.input.physicalContextType !== input.physicalContextType ||
      existing.input.physicalContextId !== input.physicalContextId
    ) {
      return { state: "conflict" };
    }
    if (existing.state === "verified" && existing.response)
      return { state: "verified", response: existing.response };
    existing.state = "processing";
    return { state: "acquired" };
  }

  async getMedia(
    deviceActionId: string,
    attachmentId: string,
  ): Promise<FieldMediaReceipt | null> {
    return this.media.get(`${deviceActionId}:${attachmentId}`) ?? null;
  }

  async renew(deviceActionId: string): Promise<boolean> {
    return this.actions.get(deviceActionId)?.state !== "verified";
  }

  async recordMedia(
    deviceActionId: string,
    receipt: FieldMediaReceipt,
  ): Promise<FieldMediaReceipt> {
    this.media.set(`${deviceActionId}:${receipt.attachmentId}`, { ...receipt });
    return { ...receipt };
  }

  async markR2Stored(): Promise<void> {}

  async complete(
    deviceActionId: string,
    _token: string,
    response: VerifiedFieldActionResponse,
  ): Promise<void> {
    const action = this.actions.get(deviceActionId);
    if (!action) throw new Error("missing_action");
    action.state = "verified";
    action.response = response;
    this.completed += 1;
    if (this.loseResponseOnce) {
      this.loseResponseOnce = false;
      throw new Error("response_lost_after_commit");
    }
  }

  async fail(deviceActionId: string): Promise<void> {
    const action = this.actions.get(deviceActionId);
    if (action && action.state !== "verified") action.state = "retry";
  }
}

class MemoryObjects implements ImmutableObjectStore {
  objects = new Map<
    string,
    {
      contentType: string;
      checksum: string;
      size: number;
      bodyText: string | null;
    }
  >();
  calls: string[] = [];

  async ensure(
    key: string,
    body: Blob | string,
    contentType: string,
    checksum: string,
  ): Promise<void> {
    this.calls.push(key);
    const size =
      typeof body === "string"
        ? new TextEncoder().encode(body).byteLength
        : body.size;
    const existing = this.objects.get(key);
    if (existing) {
      assert.deepEqual(
        {
          contentType: existing.contentType,
          checksum: existing.checksum,
          size: existing.size,
        },
        { contentType, checksum, size },
      );
      return;
    }
    this.objects.set(key, {
      contentType,
      checksum,
      size,
      bodyText: typeof body === "string" ? body : null,
    });
  }
}

function auth(
  role: AppRole = "field",
  tenant = "ironwrap",
  user = "appu_field",
  frappeUserId: string | null = "crew@example.com",
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
      user_id: user,
      tenant_id: tenant,
      email_normalized: "crew@example.com",
      display_name: "Crew",
      role,
      device_id: "paired-device-1",
      frappe_user_id: frappeUserId,
      active: 1,
      created_by: "owner@example.com",
      created_at: "2026-07-10T10:00:00.000Z",
      updated_at: "2026-07-10T10:00:00.000Z",
    },
  };
}

function payload(
  overrides: Partial<FieldActionPayload> = {},
): FieldActionPayload {
  return {
    assignment_id: "ASSIGN-A",
    proof_slot: "Production",
    capture_started_at: "2026-07-10T10:00:00.000Z",
    capture_completed_at: "2026-07-10T10:05:00.000Z",
    notes: "Deck complete",
    blocker: false,
    blocker_category: null,
    blocker_summary: null,
    latitude: null,
    longitude: null,
    location_accuracy_m: null,
    location_permission_state: "not_requested",
    correction_of: null,
    correction_reason: null,
    evidence_correction_of: null,
    evidence_item_correction_of: null,
    customer_safe_requested: true,
    ...overrides,
  };
}

function submission(
  mediaCount = 2,
  overrides: Partial<FieldSubmission> = {},
): FieldSubmission {
  return {
    deviceActionId: "device-action-123",
    jobId: "JOB-A",
    assignmentId: "ASSIGN-A",
    payload: payload(),
    media: Array.from({ length: mediaCount }, (_, index) => {
      const blob = new Blob([`photo-${index}`], { type: "image/jpeg" });
      return {
        attachmentId: `attachment-${index}`,
        fileName: `roof-${index}.jpg`,
        mimeType: "image/jpeg",
        size: blob.size,
        blob,
      };
    }),
    ...overrides,
  };
}

const authorizeTypedEvidence: FieldEvidenceAuthorizer = async (
  input,
  authContext,
) => {
  const typedScope = input.jobId.startsWith("SHOP")
    ? {
        workObjectType: "Shop Order",
        workObjectId: input.jobId,
        physicalContextType: "Shop Floor",
        physicalContextId: "SHOP-FLOOR-1",
      }
    : {
        workObjectType: "Roof Job",
        workObjectId: input.jobId,
        physicalContextType: "Roof Site",
        physicalContextId: input.jobId,
      };
  return {
    workPackageId: "WORK-PACKAGE-A",
    workPackageVersion: 4,
    releaseAttemptId: "attempt-a",
    scope: typedScope,
    slotId: "step:1",
    requirement: "Anchor inspection photo",
    source: "field-companion",
    deviceId: authContext.session.device_id!,
    freshness: "Current",
    conflictState: "None",
    correctionOf: input.payload.evidence_correction_of,
    itemCorrectionOf: input.payload.evidence_item_correction_of,
  };
};

const authorizeBoundTypedEvidence: FieldEvidenceAuthorizer = async (
  input,
  authContext,
) => {
  if (input.assignmentId !== "ASSIGN-A") {
    throw new FieldActionError(
      "work_package_assignment_mismatch",
      409,
      "The current Work Package assignment is not the saved assignment.",
    );
  }
  if (authContext.session.tenant_id !== "ironwrap") {
    throw new FieldActionError(
      "tenant_mismatch",
      403,
      "The current Work Package tenant is not the field session tenant.",
    );
  }
  if (authContext.session.device_id !== "paired-device-1") {
    throw new FieldActionError(
      "evidence_device_mismatch",
      409,
      "The current Work Package is not paired to this device.",
    );
  }
  if (
    input.payload.evidence_correction_of ||
    input.payload.evidence_item_correction_of
  ) {
    throw new FieldActionError(
      "work_package_evidence_correction_mismatch",
      409,
      "The correction target is not present in the current Work Package ledger.",
    );
  }
  return authorizeTypedEvidence(input, authContext);
};

function typedDependencies(
  store: FieldActionStore,
  objects: ImmutableObjectStore,
): ProcessFieldDependenciesForTest {
  return { store, objects, authorizeTypedEvidence };
}

function boundTypedDependencies(
  store: FieldActionStore,
  objects: ImmutableObjectStore,
): ProcessFieldDependenciesForTest {
  return { store, objects, authorizeTypedEvidence: authorizeBoundTypedEvidence };
}

type ProcessFieldDependenciesForTest = Parameters<
  typeof processFieldSubmission
>[2];

test("12 attachments get unique Evidence device ids, bounded immutable keys, and idempotent reordered replay", async () => {
  const store = new MemoryFieldStore();
  const objects = new MemoryObjects();
  const input = submission(12, {
    deviceActionId: "d".repeat(80),
    jobId: "J".repeat(140),
    media: Array.from({ length: 12 }, (_, index) => {
      const blob = new Blob([`photo-${index}`], { type: "image/jpeg" });
      return {
        attachmentId: `${index}`.padEnd(80, "a"),
        fileName: `${index}`.padEnd(176, "x") + ".jpg",
        mimeType: "image/jpeg",
        size: blob.size,
        blob,
      };
    }),
  });
  const first = await processFieldSubmission(input, auth("field", "ironwrap", "appu_field", null), {
    store,
    objects,
  });
  assert.equal(first.status, "verified");
  assert.equal(first.server_ref, first.checkin_id);
  assert.match(first.server_ref, /^fci_[0-9a-f]{32}$/);
  assert.equal(new Set(first.media.map((item) => item.evidence_id)).size, 12);
  assert.equal(
    [...objects.objects.keys()].every((key) => key.length <= 140),
    true,
  );
  const callCount = objects.calls.length;
  const replay = await processFieldSubmission(
    { ...input, media: [...input.media].reverse() },
    auth("field", "ironwrap", "appu_field", null),
    { store, objects },
  );
  assert.deepEqual(replay, first);
  assert.equal(objects.calls.length, callCount);
  assert.equal(store.completed, 1);
});

test("D1/R2 field completion does not consult Frappe or network and accepts a null Frappe id", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("unexpected_external_call");
  };
  try {
    const response = await processFieldSubmission(
      submission(1, { deviceActionId: "frappe-free-field-action" }),
      auth("field", "ironwrap", "appu_field", null),
      { store: new MemoryFieldStore(), objects: new MemoryObjects() },
    );
    assert.equal(response.status, "verified");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalls, 0);
});

test("a lost D1 response replays exact canonical refs without duplicate R2 or D1 writes", async () => {
  const store = new MemoryFieldStore();
  const objects = new MemoryObjects();
  store.loseResponseOnce = true;
  const input = submission(2);
  await assert.rejects(
    processFieldSubmission(input, auth(), { store, objects }),
    (error: unknown) =>
      error instanceof FieldActionError && error.status === 502,
  );
  assert.equal(store.media.size, 2);
  const firstObjectCalls = objects.calls.length;
  const verified = await processFieldSubmission(input, auth(), {
    store,
    objects,
  });
  assert.equal(verified.status, "verified");
  assert.equal(
    objects.calls.length,
    firstObjectCalls,
    "a committed D1 response is replayed before another R2 operation",
  );
  assert.equal(
    verified.media.every((item) => /^[0-9a-f]{64}$/.test(item.checksum_sha256)),
    true,
  );
});

test("typed Work Package evidence binds the paired device and replays its immutable event after recovery", async () => {
  const store = new MemoryFieldStore();
  const objects = new MemoryObjects();
  const typed = submission(1, {
    deviceActionId: "typed-evidence-action",
    jobId: "SHOP-001",
    scope: {
      workObjectType: "Shop Order",
      workObjectId: "SHOP-001",
      physicalContextType: "Shop Floor",
      physicalContextId: "SHOP-FLOOR-1",
    },
    payload: payload({
      work_package_id: "WORK-PACKAGE-A",
      work_package_version: 4,
      work_package_release_attempt_id: "attempt-a",
      evidence_slot_id: "step:1",
      evidence_requirement: "Anchor inspection photo",
      evidence_source: "field-companion",
      evidence_freshness: "Current",
      evidence_conflict_state: "None",
      evidence_verification: "Verified",
      evidence_disposition: "Open",
    }),
  });

  const first = await processFieldSubmission(typed, auth("field", "ironwrap", "appu_field", null), {
    ...typedDependencies(store, objects),
  });
  const action = store.actions.get(typed.deviceActionId);
  assert.equal(action?.input.workPackageId, "WORK-PACKAGE-A");
  assert.equal(action?.input.workObjectType, "Shop Order");
  assert.equal(action?.input.workObjectId, "SHOP-001");
  assert.equal(action?.input.physicalContextType, "Shop Floor");
  assert.equal(action?.input.physicalContextId, "SHOP-FLOOR-1");
  assert.equal(action?.input.evidenceVerification, "Verified");
  assert.equal(action?.input.evidenceDisposition, "Open");
  assert.equal(first.server_ref, first.checkin_id);
  const objectCalls = objects.calls.length;
  const verified = await processFieldSubmission(typed, auth("field", "ironwrap", "appu_field", null), {
    ...typedDependencies(store, objects),
  });
  assert.equal(verified.status, "verified");
  assert.deepEqual(verified, first);
  assert.equal(objects.calls.length, objectCalls);

  await assert.rejects(
    processFieldSubmission(
      {
        ...typed,
        payload: {
          ...typed.payload,
          evidence_requirement: "Different requirement",
        },
      },
      auth(),
      typedDependencies(store, objects),
    ),
    (error: unknown) =>
      error instanceof FieldActionError &&
      error.code === "work_package_evidence_requirement_conflict",
  );
  await assert.rejects(
    processFieldSubmission(
      {
        ...typed,
        deviceActionId: "typed-device-conflict",
        payload: { ...typed.payload, evidence_device_id: "other-device" },
      },
      auth(),
      { store, objects },
    ),
    (error: unknown) =>
      error instanceof FieldActionError &&
      error.code === "evidence_device_mismatch",
  );
  assert.equal(store.actions.has("typed-device-conflict"), false);
});

test("typed evidence rejects a forged work-object scope before D1 or R2 completion", async () => {
  const store = new MemoryFieldStore();
  const objects = new MemoryObjects();
  await assert.rejects(
    processFieldSubmission(
      submission(1, {
        deviceActionId: "typed-scope-conflict",
        jobId: "SHOP-001",
        scope: {
          workObjectType: "Shop Order",
          workObjectId: "SHOP-OTHER",
          physicalContextType: "Shop Floor",
          physicalContextId: "SHOP-FLOOR-1",
        },
        payload: payload({
          work_package_id: "WORK-PACKAGE-A",
          work_package_version: 4,
          work_package_release_attempt_id: "attempt-a",
          evidence_slot_id: "step:1",
          evidence_requirement: "Anchor inspection photo",
          evidence_source: "field-companion",
          evidence_freshness: "Current",
          evidence_conflict_state: "None",
        }),
      }),
      auth("field", "ironwrap", "appu_field", null),
      typedDependencies(store, objects),
    ),
    (error: unknown) =>
      error instanceof FieldActionError &&
      error.code === "work_object_scope_mismatch",
  );
  assert.equal(store.actions.size, 0);
  assert.equal(objects.calls.length, 0);
});

test("typed evidence rejects stale or cross-bound authority facts before any D1 or R2 effect", async () => {
  const typedFields = {
    work_package_id: "WORK-PACKAGE-A",
    work_package_version: 4,
    work_package_release_attempt_id: "attempt-a",
    evidence_slot_id: "step:1",
    evidence_requirement: "Anchor inspection photo",
    evidence_source: "field-companion",
    evidence_freshness: "Current" as const,
    evidence_conflict_state: "None" as const,
  };
  const cases: Array<{
    name: string;
    input?: Partial<FieldSubmission>;
    auth?: AuthContext;
    fields?: Partial<FieldActionPayload>;
    code: string;
  }> = [
    {
      name: "arbitrary slot",
      fields: { evidence_slot_id: "step:99" },
      code: "work_package_evidence_slot_not_found",
    },
    {
      name: "different package",
      fields: { work_package_id: "WORK-PACKAGE-OTHER" },
      code: "work_package_not_available",
    },
    {
      name: "stale package version",
      fields: { work_package_version: 3 },
      code: "work_package_version_conflict",
    },
    {
      name: "stale release attempt",
      fields: { work_package_release_attempt_id: "attempt-old" },
      code: "work_package_release_attempt_conflict",
    },
    {
      name: "noncanonical source",
      fields: { evidence_source: "field-import" },
      code: "evidence_source_mismatch",
    },
    {
      name: "stale freshness",
      fields: { evidence_freshness: "Stale" },
      code: "evidence_freshness_mismatch",
    },
    {
      name: "detected conflict",
      fields: { evidence_conflict_state: "Detected" },
      code: "evidence_conflict_state_mismatch",
    },
    {
      name: "wrong paired device",
      fields: { evidence_device_id: "other-device" },
      code: "evidence_device_mismatch",
    },
    {
      name: "wrong tenant",
      auth: auth("field", "other-tenant", "appu_other", null),
      code: "tenant_mismatch",
    },
    {
      name: "wrong assignment",
      input: {
        assignmentId: "ASSIGN-OTHER",
        payload: payload({ assignment_id: "ASSIGN-OTHER", ...typedFields }),
      },
      code: "work_package_assignment_mismatch",
    },
    {
      name: "unknown correction target",
      fields: {
        evidence_correction_of: `wpe_${"f".repeat(32)}`,
        evidence_item_correction_of: `evi_${"f".repeat(32)}`,
        correction_reason: "Retake this evidence.",
      },
      code: "work_package_evidence_correction_mismatch",
    },
  ];
  for (const candidate of cases) {
    const store = new MemoryFieldStore();
    const objects = new MemoryObjects();
    const input = submission(1, {
      deviceActionId: `typed-authority-${candidate.name.replaceAll(" ", "-")}`,
      ...candidate.input,
      payload: payload({
        ...typedFields,
        ...candidate.fields,
        ...candidate.input?.payload,
      }),
    });
    await assert.rejects(
      processFieldSubmission(
        input,
        candidate.auth ?? auth("field", "ironwrap", "appu_field", null),
        boundTypedDependencies(store, objects),
      ),
      (error: unknown) =>
        error instanceof FieldActionError && error.code === candidate.code,
      candidate.name,
    );
    assert.equal(store.actions.size, 0, `${candidate.name}: no D1 claim`);
    assert.equal(objects.calls.length, 0, `${candidate.name}: no R2 write`);
  }
});

test("typed Work Package readback is projected from verified D1 receipts", async () => {
  const evidenceId = `evi_${"a".repeat(32)}`;
  const bindings: unknown[][] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        assert.match(sql, /FROM field_actions a/);
        assert.match(sql, /a\.status = 'verified'/);
        return {
          bind(...args: unknown[]) {
            bindings.push(args);
            return {
              async all<T>() {
                return {
                  results: [
                    {
                      device_action_id: "typed-evidence-action",
                      user_id: "appu_field",
                      actor_user: "appu_field",
                      actor_role: "field",
                      created_at: "2026-07-10T10:05:00.000Z",
                      work_package_id: "WORK-PACKAGE-A",
                      work_package_version: 4,
                      evidence_slot_id: "step:1",
                      evidence_requirement: "Anchor inspection photo",
                      evidence_source: "field-companion",
                      evidence_device_id: "paired-device-1",
                      evidence_freshness: "Current",
                      evidence_conflict_state: "None",
                      evidence_verification: "Verified",
                      evidence_disposition: "Open",
                      evidence_correction_of: null,
                      evidence_item_correction_of: null,
                      work_package_release_attempt_id: "attempt-a",
                      correction_reason: null,
                      work_object_type: "Shop Order",
                      work_object_id: "SHOP-001",
                      physical_context_type: "Shop Floor",
                      physical_context_id: "SHOP-FLOOR-1",
                      capture_completed_at: "2026-07-10T10:04:00.000Z",
                      evidence_id: evidenceId,
                    },
                  ] as T[],
                };
              },
            };
          },
        };
      },
    },
  } as unknown as AppEnv;
  const rows = await listFieldWorkPackageEvidenceFromD1(env, {
    tenantId: "ironwrap",
    workPackageId: "WORK-PACKAGE-A",
    jobId: "SHOP-001",
    assignmentId: "ASSIGN-A",
    version: 4,
    releaseAttemptId: "attempt-a",
    scope: {
      workObjectType: "Shop Order",
      workObjectId: "SHOP-001",
      physicalContextType: "Shop Floor",
      physicalContextId: "SHOP-FLOOR-1",
    },
  });
  assert.equal(bindings[0]?.[0], "ironwrap");
  assert.equal(rows?.length, 1);
  assert.equal(rows?.[0]?.evidenceItem, evidenceId);
  assert.match(rows?.[0]?.eventId ?? "", /^wpe_[0-9a-f]{32}$/);
  assert.equal(rows?.[0]?.actorUser, "appu_field");
  assert.equal(rows?.[0]?.verification, "Verified");
  assert.equal(rows?.[0]?.disposition, "Open");
  assert.equal(rows?.[0]?.workObjectId, "SHOP-001");
  assert.equal(rows?.[0]?.capturedAt, "2026-07-10T10:04:00.000Z");
});

test("typed Work Package readback fails closed on an operational D1 error", async () => {
  const env = {
    DB: {
      prepare() {
        return {
          bind() {
            return {
              async all() {
                throw new Error("d1_connection_unavailable");
              },
            };
          },
        };
      },
    },
  } as unknown as AppEnv;
  await assert.rejects(
    listFieldWorkPackageEvidenceFromD1(env, {
      tenantId: "ironwrap",
      workPackageId: "WORK-PACKAGE-A",
      jobId: "SHOP-001",
      assignmentId: "ASSIGN-A",
      version: 4,
      releaseAttemptId: "attempt-a",
      scope: {
        workObjectType: "Shop Order",
        workObjectId: "SHOP-001",
        physicalContextType: "Shop Floor",
        physicalContextId: "SHOP-FLOOR-1",
      },
    }),
    /d1_connection_unavailable/,
  );
});

test("typed field evidence starts Open with server-derived verification and rejects forged lifecycle states", async () => {
  const base = submission(1, {
    deviceActionId: "typed-lifecycle-open",
    payload: payload({
      work_package_id: "WORK-PACKAGE-A",
      work_package_version: 4,
      work_package_release_attempt_id: "attempt-a",
      evidence_slot_id: "step:1",
      evidence_requirement: "Anchor inspection photo",
      evidence_source: "field-companion",
      evidence_freshness: "Current",
      evidence_conflict_state: "None",
      evidence_verification: undefined,
      evidence_disposition: undefined,
    }),
  });
  const store = new MemoryFieldStore();
  await processFieldSubmission(base, auth(), {
    ...typedDependencies(store, new MemoryObjects()),
  });
  const saved = store.actions.get(base.deviceActionId)?.input;
  assert.equal(saved?.evidenceVerification, "Verified");
  assert.equal(saved?.evidenceDisposition, "Open");

  for (const [field, value, code] of [
    ["evidence_verification", "Pending", "evidence_verification_forbidden"],
    ["evidence_disposition", "Accepted", "evidence_disposition_forbidden"],
  ] as const) {
    await assert.rejects(
      processFieldSubmission(
        {
          ...base,
          deviceActionId: `${field}-forged`,
          payload: { ...base.payload, [field]: value },
        },
        auth(),
        typedDependencies(new MemoryFieldStore(), new MemoryObjects()),
      ),
      (error: unknown) =>
        error instanceof FieldActionError && error.code === code,
    );
  }
});

test("directly constructed typed or malformed corrections fail closed like parsed payloads", async () => {
  const base = submission(1);
  await assert.rejects(
    processFieldSubmission(
      {
        ...base,
        deviceActionId: "direct-slot-only",
        payload: { ...base.payload, evidence_slot_id: "step:1" },
      },
      auth(),
      {
        store: new MemoryFieldStore(),
        objects: new MemoryObjects(),
      },
    ),
    (error: unknown) =>
      error instanceof FieldActionError &&
      error.code === "evidence_release_attempt_missing",
  );
  await assert.rejects(
    processFieldSubmission(
      {
        ...base,
        deviceActionId: "direct-orphan-reason",
        payload: { ...base.payload, correction_reason: "orphaned" },
      },
      auth(),
      {
        store: new MemoryFieldStore(),
        objects: new MemoryObjects(),
      },
    ),
    (error: unknown) =>
      error instanceof FieldActionError && error.code === "invalid_metadata",
  );
});

test("generic Field Check-in corrections keep their own identity and reason outside typed evidence", async () => {
  const store = new MemoryFieldStore();
  const objects = new MemoryObjects();
  const original = await processFieldSubmission(
    submission(1, { deviceActionId: "generic-checkin-original" }),
    auth(),
    { store, objects },
  );
  const correction = await processFieldSubmission(
    submission(1, {
      deviceActionId: "generic-checkin-correction",
      payload: payload({
        correction_of: "CHECKIN-ORIGINAL",
        correction_reason:
          "The original field note was corrected after supervisor review.",
      }),
    }),
    auth(),
    { store, objects },
  );
  assert.notEqual(correction.server_ref, original.server_ref);
  assert.equal(store.actions.size, 2);
  const manifest = [...objects.objects.values()]
    .filter((item) => item.contentType === "application/json")
    .map((item) => item.bodyText)
    .find((body) => body?.includes('"correction_of":"CHECKIN-ORIGINAL"'));
  assert.match(manifest ?? "", /"correction_of":"CHECKIN-ORIGINAL"/);
  assert.match(
    manifest ?? "",
    /"correction_reason":"The original field note was corrected after supervisor review\."/,
  );
});

test("a cross-tenant device action collision never returns another tenant's verified response", async () => {
  const store = new MemoryFieldStore();
  const objects = new MemoryObjects();
  const input = submission(1);
  await processFieldSubmission(input, auth(), { store, objects });
  await assert.rejects(
    processFieldSubmission(input, auth("field", "other-tenant", "appu_other"), {
      store,
      objects,
    }),
    (error: unknown) =>
      error instanceof FieldActionError &&
      error.code === "idempotency_conflict",
  );
});

test("location provenance distinguishes denied from not requested and persists coordinates only when granted", async () => {
  const deniedObjects = new MemoryObjects();
  await processFieldSubmission(
    submission(1, {
      deviceActionId: "location-denied",
      payload: payload({ location_permission_state: "denied" }),
    }),
    auth(),
    {
      store: new MemoryFieldStore(),
      objects: deniedObjects,
    },
  );
  const deniedManifest = [...deniedObjects.objects.values()].find(
    (item) => item.contentType === "application/json",
  )?.bodyText;
  assert.match(deniedManifest ?? "", /"location_permission_state":"denied"/);
  const untouchedObjects = new MemoryObjects();
  await processFieldSubmission(
    submission(0, {
      deviceActionId: "location-not-requested",
      payload: payload({ location_permission_state: "not_requested" }),
    }),
    auth(),
    {
      store: new MemoryFieldStore(),
      objects: untouchedObjects,
    },
  );
  const untouchedManifest = [...untouchedObjects.objects.values()].find(
    (item) => item.contentType === "application/json",
  )?.bodyText;
  assert.match(
    untouchedManifest ?? "",
    /"location_permission_state":"not_requested"/,
  );
  const grantedObjects = new MemoryObjects();
  await processFieldSubmission(
    submission(1, {
      deviceActionId: "location-granted",
      payload: payload({
        latitude: 51.0447,
        longitude: -114.0719,
        location_accuracy_m: 7,
        location_permission_state: "granted",
      }),
    }),
    auth(),
    {
      store: new MemoryFieldStore(),
      objects: grantedObjects,
    },
  );
  const grantedManifest = [...grantedObjects.objects.values()].find(
    (item) => item.contentType === "application/json",
  )?.bodyText;
  assert.match(grantedManifest ?? "", /"latitude":51\.0447/);
  assert.match(grantedManifest ?? "", /"location_accuracy_m":7/);
});

test("multipart parsing rejects bad MIME and oversized action batches", async () => {
  const metadataOnly = await parseFieldActionRequest(
    multipartRequest("image/jpeg", 0),
    "JOB-A",
    "ASSIGN-A",
  );
  assert.equal(metadataOnly.media.length, 0);
  const bad = multipartRequest("text/plain", 1);
  await assert.rejects(
    parseFieldActionRequest(bad, "JOB-A", "ASSIGN-A"),
    (error: unknown) =>
      error instanceof FieldActionError && error.status === 415,
  );
  const tooMany = multipartRequest("image/jpeg", 13);
  await assert.rejects(
    parseFieldActionRequest(tooMany, "JOB-A", "ASSIGN-A"),
    (error: unknown) =>
      error instanceof FieldActionError && error.status === 413,
  );
  const spoofed = multipartRequest("image/jpeg", 1);
  await assert.rejects(
    parseFieldActionRequest(spoofed, "JOB-A", "ASSIGN-A"),
    (error: unknown) =>
      error instanceof FieldActionError &&
      error.code === "media_signature_invalid",
  );
});

test("media signatures are validated independently of declared MIME", async () => {
  assert.equal(
    await mediaSignatureMatches(
      new Blob([Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])], {
        type: "image/jpeg",
      }),
      "image/jpeg",
    ),
    true,
  );
  assert.equal(
    await mediaSignatureMatches(
      new Blob(["not-a-jpeg"], { type: "image/jpeg" }),
      "image/jpeg",
    ),
    false,
  );
  assert.equal(
    await mediaSignatureMatches(
      new Blob([Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3])], {
        type: "audio/webm",
      }),
      "audio/webm",
    ),
    true,
  );
});

test("streaming multipart guard preserves a 413 without buffering an oversized body twice", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(25 * 1024 * 1024));
      controller.close();
    },
  });
  const request = new Request(
    "https://app.example.com/api/v1/jobs/JOB-A/check-ins",
    {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=bounded" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" },
  );
  await assert.rejects(
    parseFieldActionRequest(request, "JOB-A", "ASSIGN-A"),
    (error: unknown) =>
      error instanceof FieldActionError && error.status === 413,
  );
});

test("field upload windows fail closed after eight authenticated starts", async () => {
  let attempts = 0;
  const env = {
    DB: {
      prepare(sql: string) {
        assert.match(sql, /INSERT INTO app_action_throttles/);
        return {
          bind() {
            return {
              async first() {
                attempts += 1;
                return {
                  attempts,
                  window_expires_at: "2026-07-10T10:01:00.000Z",
                };
              },
            };
          },
        };
      },
    },
  } as unknown as AppEnv;
  const now = new Date("2026-07-10T10:00:00.000Z");
  for (let index = 0; index < 8; index += 1) {
    assert.equal(
      (await claimFieldUploadWindow(env, auth(), now)).allowed,
      true,
    );
  }
  assert.deepEqual(await claimFieldUploadWindow(env, auth(), now), {
    allowed: false,
    retryAfterSeconds: 60,
  });
});

test("field mutation API rejects office roles, bad CSRF, and an unassigned field session", async () => {
  const request = (csrf: string) =>
    new Request("https://app.example.com/api/v1/jobs/JOB-C/check-ins", {
      method: "POST",
      headers: { "x-csrf-token": csrf },
    });
  const appEnv = {
    ERPNEXT_BASE_URL: "https://frappe.example.com",
    ERPNEXT_API_KEY: "key",
    ERPNEXT_API_SECRET: "secret",
  } as AppEnv;
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
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ data: [] });
  try {
    const denied = await handleAuthenticatedRoute(
      request("csrf"),
      appEnv,
      auth("field"),
    );
    assert.equal(denied.status, 404);
    assert.deepEqual(await denied.json(), { error: "not_found" });
  } finally {
    globalThis.fetch = original;
  }
});

test("R2 PUT success is not accepted when the post-write HEAD checksum is wrong", async () => {
  const right = "a".repeat(64);
  const wrongBuffer = Uint8Array.from({ length: 32 }, () => 0xbb).buffer;
  let heads = 0;
  const bucket = {
    head: async () => {
      heads += 1;
      if (heads === 1) return null;
      return {
        size: 3,
        customMetadata: { sha256: right },
        checksums: { sha256: wrongBuffer },
      };
    },
    put: async () => ({ key: "x" }),
  } as unknown as R2Bucket;
  await assert.rejects(
    r2ObjectStore(bucket).ensure(
      "field/key",
      new Blob(["abc"]),
      "image/jpeg",
      right,
    ),
    (error: unknown) =>
      error instanceof FieldActionError &&
      error.code === "immutable_object_conflict",
  );
  assert.equal(heads, 2);
});

test("R2 create refuses a different object written between HEAD and PUT", async () => {
  const requested = "a".repeat(64);
  const competing = "b".repeat(64);
  let heads = 0;
  let storedChecksum: string | null = null;
  const bucket = {
    head: async () => {
      heads += 1;
      if (heads === 1) return null;
      return {
        size: 3,
        customMetadata: { sha256: storedChecksum },
        checksums: {
          sha256: Uint8Array.from({ length: 32 }, () => 0xbb).buffer,
        },
      };
    },
    put: async (_key: string, _body: Blob, options: { onlyIf: Headers }) => {
      assert.ok(options.onlyIf instanceof Headers);
      assert.equal(options.onlyIf.get("If-None-Match"), "*");
      storedChecksum = competing; // Another writer wins the absent-only create.
      return null;
    },
  } as unknown as R2Bucket;
  await assert.rejects(
    r2ObjectStore(bucket).ensure(
      "field/key",
      new Blob(["abc"]),
      "image/jpeg",
      requested,
    ),
    (error: unknown) =>
      error instanceof FieldActionError &&
      error.code === "immutable_object_conflict",
  );
  assert.equal(storedChecksum, competing);
  assert.equal(heads, 2);
});

function multipartRequest(mimeType: string, count: number): Request {
  const form = new FormData();
  const attachments = Array.from({ length: count }, (_, index) => {
    const blob = new Blob([`x-${index}`], { type: mimeType });
    form.append(
      "attachments",
      blob,
      `file-${index}.${mimeType === "image/jpeg" ? "jpg" : "txt"}`,
    );
    return {
      attachmentId: `attachment-${index}`,
      fileName: `file-${index}.${mimeType === "image/jpeg" ? "jpg" : "txt"}`,
      mimeType,
      size: blob.size,
    };
  });
  form.set(
    "metadata",
    JSON.stringify({
      device_action_id: "device-action-123",
      payload: payload(),
      attachments,
    }),
  );
  return new Request("https://app.example.com/api/v1/jobs/JOB-A/check-ins", {
    method: "POST",
    body: form,
  });
}
