import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FieldActionError,
  claimFieldUploadWindow,
  mediaSignatureMatches,
  parseFieldActionRequest,
  processFieldSubmission,
  r2ObjectStore,
  type FieldActionPayload,
  type FieldActionStore,
  type FieldMediaReceipt,
  type FieldSubmission,
  type ImmutableObjectStore,
  type VerifiedFieldActionResponse,
} from "../src/field-actions.ts";
import type { AppRole, AuthContext } from "../src/app-types.ts";
import type { AppEnv } from "../src/app-types.ts";
import { handleAuthenticatedRoute } from "../src/app-api.ts";
import type { FieldFrappeWriter, PersistFieldCheckInInput, PersistFieldMediaInput } from "../src/frappe-field.ts";

class MemoryFieldStore implements FieldActionStore {
  actions = new Map<
    string,
    {
      tenantId: string;
      userId: string;
      payloadHash: string;
      response?: VerifiedFieldActionResponse;
      state: "processing" | "retry" | "verified";
    }
  >();
  media = new Map<string, FieldMediaReceipt>();
  completed = 0;

  async claim(input: Parameters<FieldActionStore["claim"]>[0]): ReturnType<FieldActionStore["claim"]> {
    const existing = this.actions.get(input.deviceActionId);
    if (!existing) {
      this.actions.set(input.deviceActionId, {
        tenantId: input.tenantId,
        userId: input.userId,
        payloadHash: input.payloadHash,
        state: "processing",
      });
      return { state: "acquired" };
    }
    if (existing.tenantId !== input.tenantId || existing.userId !== input.userId || existing.payloadHash !== input.payloadHash) {
      return { state: "conflict" };
    }
    if (existing.state === "verified" && existing.response) return { state: "verified", response: existing.response };
    existing.state = "processing";
    return { state: "acquired" };
  }

  async getMedia(deviceActionId: string, attachmentId: string): Promise<FieldMediaReceipt | null> {
    return this.media.get(`${deviceActionId}:${attachmentId}`) ?? null;
  }

  async renew(deviceActionId: string): Promise<boolean> {
    return this.actions.get(deviceActionId)?.state !== "verified";
  }

  async recordMedia(deviceActionId: string, receipt: FieldMediaReceipt): Promise<FieldMediaReceipt> {
    this.media.set(`${deviceActionId}:${receipt.attachmentId}`, { ...receipt });
    return { ...receipt };
  }

  async markMediaPersisted(deviceActionId: string, attachmentId: string, frappeName: string): Promise<void> {
    const key = `${deviceActionId}:${attachmentId}`;
    const receipt = this.media.get(key);
    if (!receipt) throw new Error("missing_receipt");
    this.media.set(key, { ...receipt, frappeEvidenceName: frappeName });
  }

  async markR2Stored(): Promise<void> {}

  async complete(deviceActionId: string, _token: string, response: VerifiedFieldActionResponse): Promise<void> {
    const action = this.actions.get(deviceActionId);
    if (!action) throw new Error("missing_action");
    action.state = "verified";
    action.response = response;
    this.completed += 1;
  }

  async fail(deviceActionId: string): Promise<void> {
    const action = this.actions.get(deviceActionId);
    if (action && action.state !== "verified") action.state = "retry";
  }
}

class MemoryObjects implements ImmutableObjectStore {
  objects = new Map<string, { contentType: string; checksum: string; size: number; bodyText: string | null }>();
  calls: string[] = [];

  async ensure(key: string, body: Blob | string, contentType: string, checksum: string): Promise<void> {
    this.calls.push(key);
    const size = typeof body === "string" ? new TextEncoder().encode(body).byteLength : body.size;
    const existing = this.objects.get(key);
    if (existing) {
      assert.deepEqual(
        { contentType: existing.contentType, checksum: existing.checksum, size: existing.size },
        { contentType, checksum, size },
      );
      return;
    }
    this.objects.set(key, { contentType, checksum, size, bodyText: typeof body === "string" ? body : null });
  }
}

class MemoryFrappe implements FieldFrappeWriter {
  evidence: PersistFieldMediaInput[] = [];
  checkins: PersistFieldCheckInInput[] = [];
  failCheckInOnce = false;

  async persistEvidence(input: PersistFieldMediaInput): Promise<{ name: string }> {
    this.evidence.push(input);
    return { name: `FRAPPE-${input.evidenceId}` };
  }

  async persistCheckIn(input: PersistFieldCheckInInput): Promise<{ name: string }> {
    this.checkins.push(input);
    if (this.failCheckInOnce) {
      this.failCheckInOnce = false;
      throw new Error("frappe_field_network_error");
    }
    return { name: `FRAPPE-${input.checkinId}` };
  }
}

function auth(role: AppRole = "field", tenant = "ironwrap", user = "appu_field"): AuthContext {
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: ["field:write:assigned"],
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
      frappe_user_id: "crew@example.com",
      active: 1,
      created_by: "owner@example.com",
      created_at: "2026-07-10T10:00:00.000Z",
      updated_at: "2026-07-10T10:00:00.000Z",
    },
  };
}

function payload(overrides: Partial<FieldActionPayload> = {}): FieldActionPayload {
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
    customer_safe_requested: true,
    ...overrides,
  };
}

function submission(mediaCount = 2, overrides: Partial<FieldSubmission> = {}): FieldSubmission {
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

test("12 attachments get unique Evidence device ids, bounded immutable keys, and idempotent reordered replay", async () => {
  const store = new MemoryFieldStore();
  const objects = new MemoryObjects();
  const frappe = new MemoryFrappe();
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
  const first = await processFieldSubmission(input, auth(), { store, objects, frappe });
  assert.equal(first.status, "verified");
  assert.equal(frappe.evidence.length, 12);
  assert.equal(new Set(frappe.evidence.map((item) => item.deviceActionId)).size, 12);
  assert.equal(
    frappe.evidence.every((item) => item.deviceActionId.length <= 140),
    true,
  );
  assert.equal(
    frappe.evidence.every((item) => item.r2Key.length <= 140),
    true,
  );
  assert.equal(
    frappe.evidence.every((item) => item.customerSafe === false),
    true,
  );
  assert.equal(
    [...objects.objects.keys()].every((key) => key.length <= 140),
    true,
  );
  const callCount = objects.calls.length;
  const replay = await processFieldSubmission({ ...input, media: [...input.media].reverse() }, auth(), { store, objects, frappe });
  assert.deepEqual(replay, first);
  assert.equal(objects.calls.length, callCount);
  assert.equal(frappe.evidence.length, 12);
  assert.equal(store.completed, 1);
});

test("a failed Frappe check-in resumes from checksum receipts without re-uploading or duplicating Evidence", async () => {
  const store = new MemoryFieldStore();
  const objects = new MemoryObjects();
  const frappe = new MemoryFrappe();
  frappe.failCheckInOnce = true;
  const input = submission(2);
  await assert.rejects(
    processFieldSubmission(input, auth(), { store, objects, frappe }),
    (error: unknown) => error instanceof FieldActionError && error.status === 502,
  );
  assert.equal(store.media.size, 2);
  assert.equal(frappe.evidence.length, 2);
  const firstObjectCalls = objects.calls.length;
  const verified = await processFieldSubmission(input, auth(), { store, objects, frappe });
  assert.equal(verified.status, "verified");
  assert.equal(frappe.evidence.length, 2);
  assert.equal(frappe.checkins.length, 2);
  assert.equal(objects.calls.length, firstObjectCalls + 1, "only the immutable manifest is rechecked");
  assert.equal(
    verified.media.every((item) => /^[0-9a-f]{64}$/.test(item.checksum_sha256)),
    true,
  );
});

test("a cross-tenant device action collision never returns another tenant's verified response", async () => {
  const store = new MemoryFieldStore();
  const objects = new MemoryObjects();
  const frappe = new MemoryFrappe();
  const input = submission(1);
  await processFieldSubmission(input, auth(), { store, objects, frappe });
  await assert.rejects(
    processFieldSubmission(input, auth("field", "other-tenant", "appu_other"), { store, objects, frappe }),
    (error: unknown) => error instanceof FieldActionError && error.code === "idempotency_conflict",
  );
});

test("location provenance distinguishes denied from not requested and persists coordinates only when granted", async () => {
  const deniedFrappe = new MemoryFrappe();
  const deniedObjects = new MemoryObjects();
  await processFieldSubmission(
    submission(1, { deviceActionId: "location-denied", payload: payload({ location_permission_state: "denied" }) }),
    auth(),
    {
      store: new MemoryFieldStore(),
      objects: deniedObjects,
      frappe: deniedFrappe,
    },
  );
  assert.deepEqual(
    { latitude: deniedFrappe.evidence[0]?.latitude, longitude: deniedFrappe.evidence[0]?.longitude },
    { latitude: null, longitude: null },
  );
  const deniedManifest = [...deniedObjects.objects.values()].find((item) => item.contentType === "application/json")?.bodyText;
  assert.match(deniedManifest ?? "", /"location_permission_state":"denied"/);
  const untouchedObjects = new MemoryObjects();
  await processFieldSubmission(
    submission(0, { deviceActionId: "location-not-requested", payload: payload({ location_permission_state: "not_requested" }) }),
    auth(),
    {
      store: new MemoryFieldStore(),
      objects: untouchedObjects,
      frappe: new MemoryFrappe(),
    },
  );
  const untouchedManifest = [...untouchedObjects.objects.values()].find((item) => item.contentType === "application/json")?.bodyText;
  assert.match(untouchedManifest ?? "", /"location_permission_state":"not_requested"/);
  const grantedFrappe = new MemoryFrappe();
  await processFieldSubmission(
    submission(1, {
      deviceActionId: "location-granted",
      payload: payload({ latitude: 51.0447, longitude: -114.0719, location_accuracy_m: 7, location_permission_state: "granted" }),
    }),
    auth(),
    { store: new MemoryFieldStore(), objects: new MemoryObjects(), frappe: grantedFrappe },
  );
  assert.equal(grantedFrappe.evidence[0]?.latitude, 51.0447);
  assert.equal(grantedFrappe.evidence[0]?.locationAccuracyM, 7);
});

test("multipart parsing rejects bad MIME and oversized action batches", async () => {
  const metadataOnly = await parseFieldActionRequest(multipartRequest("image/jpeg", 0), "JOB-A", "ASSIGN-A");
  assert.equal(metadataOnly.media.length, 0);
  const bad = multipartRequest("text/plain", 1);
  await assert.rejects(
    parseFieldActionRequest(bad, "JOB-A", "ASSIGN-A"),
    (error: unknown) => error instanceof FieldActionError && error.status === 415,
  );
  const tooMany = multipartRequest("image/jpeg", 13);
  await assert.rejects(
    parseFieldActionRequest(tooMany, "JOB-A", "ASSIGN-A"),
    (error: unknown) => error instanceof FieldActionError && error.status === 413,
  );
  const spoofed = multipartRequest("image/jpeg", 1);
  await assert.rejects(
    parseFieldActionRequest(spoofed, "JOB-A", "ASSIGN-A"),
    (error: unknown) => error instanceof FieldActionError && error.code === "media_signature_invalid",
  );
});

test("media signatures are validated independently of declared MIME", async () => {
  assert.equal(
    await mediaSignatureMatches(new Blob([Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])], { type: "image/jpeg" }), "image/jpeg"),
    true,
  );
  assert.equal(await mediaSignatureMatches(new Blob(["not-a-jpeg"], { type: "image/jpeg" }), "image/jpeg"), false);
  assert.equal(
    await mediaSignatureMatches(new Blob([Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3])], { type: "audio/webm" }), "audio/webm"),
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
  const request = new Request("https://app.example.com/api/v1/jobs/JOB-A/check-ins", {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=bounded" },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  await assert.rejects(
    parseFieldActionRequest(request, "JOB-A", "ASSIGN-A"),
    (error: unknown) => error instanceof FieldActionError && error.status === 413,
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
                return { attempts, window_expires_at: "2026-07-10T10:01:00.000Z" };
              },
            };
          },
        };
      },
    },
  } as unknown as AppEnv;
  const now = new Date("2026-07-10T10:00:00.000Z");
  for (let index = 0; index < 8; index += 1) {
    assert.equal((await claimFieldUploadWindow(env, auth(), now)).allowed, true);
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
  assert.equal((await handleAuthenticatedRoute(request("csrf"), appEnv, auth("owner"))).status, 403);
  assert.equal((await handleAuthenticatedRoute(request("wrong"), appEnv, auth("field"))).status, 403);
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ data: [] });
  try {
    const denied = await handleAuthenticatedRoute(request("csrf"), appEnv, auth("field"));
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
      return { size: 3, customMetadata: { sha256: right }, checksums: { sha256: wrongBuffer } };
    },
    put: async () => ({ key: "x" }),
  } as unknown as R2Bucket;
  await assert.rejects(
    r2ObjectStore(bucket).ensure("field/key", new Blob(["abc"]), "image/jpeg", right),
    (error: unknown) => error instanceof FieldActionError && error.code === "immutable_object_conflict",
  );
  assert.equal(heads, 2);
});

function multipartRequest(mimeType: string, count: number): Request {
  const form = new FormData();
  const attachments = Array.from({ length: count }, (_, index) => {
    const blob = new Blob([`x-${index}`], { type: mimeType });
    form.append("attachments", blob, `file-${index}.${mimeType === "image/jpeg" ? "jpg" : "txt"}`);
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
  return new Request("https://app.example.com/api/v1/jobs/JOB-A/check-ins", { method: "POST", body: form });
}
