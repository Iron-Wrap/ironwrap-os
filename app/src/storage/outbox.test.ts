// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getDatabase, resetDatabaseForTests } from "./db";
import { getDeviceSecret, storeDeviceSecret } from "../auth/device-credential";
import {
  assertTransition,
  claimNextQueuedAction,
  getOutboxAction,
  getOutboxActionWithBlobs,
  markOutboxVerified,
  OUTBOX_UPLOAD_LEASE_MS,
  queueOutboxAction,
  recoverResumableOutboxActions,
  renewOutboxUploadLease,
  requeueOutboxAction,
  saveOutboxAction,
  transitionOutboxAction,
} from "./outbox";
import { flushOutbox, initializeOutbox, retryDelayMilliseconds } from "./outbox-processor";
import { getOutboxSummary } from "./outbox-store";

const clock = {
  now: () => 1_000,
  randomId: vi.fn().mockReturnValueOnce("device-action-1").mockReturnValueOnce("attachment-1"),
};
const principal = { tenantId: "tenant-a", userId: "field-user-a" };

describe("offline outbox", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  });

  afterEach(async () => {
    await resetDatabaseForTests();
    vi.restoreAllMocks();
  });

  it("saves Blob evidence locally before queueing", async () => {
    const blob = new Blob(["roof photo bytes"], { type: "image/jpeg" });
    const action = await saveOutboxAction(
      {
        ...principal,
        kind: "evidence_upload",
        endpoint: "/api/v1/jobs/job-1/evidence",
        payload: { proof_slot: "arrival" },
        attachments: [{ blob, fileName: "arrival.jpg" }],
      },
      clock,
    );

    expect(action).toMatchObject({
      deviceActionId: "device-action-1",
      ...principal,
      state: "saved_locally",
      attachments: [{ attachmentId: "attachment-1", size: blob.size }],
    });
    const saved = await getOutboxActionWithBlobs("device-action-1");
    expect(saved?.blobs).toHaveLength(1);
    expect(saved?.blobs[0]?.blob.size).toBe(blob.size);
  });

  it("sends stable idempotency and CSRF headers, then keeps only verified audit metadata", async () => {
    await saveOutboxAction({
      ...principal,
      deviceActionId: "stable-action",
      kind: "check_in",
      endpoint: "/api/v1/jobs/job-1/check-ins",
      payload: { blocker: false },
    });
    await queueOutboxAction("stable-action", 2_000);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("Idempotency-Key")).toBe("stable-action");
      expect(headers.get("X-Device-Action-Id")).toBe("stable-action");
      expect(headers.get("X-CSRF-Token")).toBe("current-csrf-only");
      expect(headers.get("X-IronWrap-Device-Proof")).toBe("current-device-proof");
      expect(JSON.parse(String(init?.body))).toEqual({
        device_action_id: "stable-action",
        payload: { blocker: false },
      });
      return Response.json({
        device_action_id: "stable-action",
        status: "verified",
        server_ref: "checkin-42",
      });
    });

    const result = await flushOutbox({
      ...principal,
      fetcher,
      csrfToken: "current-csrf-only",
      deviceProof: async () => "current-device-proof",
      now: () => 3_000,
    });

    expect(result).toMatchObject({ processed: 1, verified: 1 });
    const saved = await getOutboxAction("stable-action");
    expect(saved).toMatchObject({
      state: "verified",
      verification: { serverRef: "checkin-42", verifiedAt: 3_000 },
    });
    expect(JSON.stringify(saved)).not.toContain("current-csrf-only");
    expect(JSON.stringify(saved)).not.toContain("current-device-proof");
  });

  it("does not upload until a current CSRF token is available", async () => {
    await saveOutboxAction({
      ...principal,
      deviceActionId: "waiting-action",
      kind: "field_note",
      endpoint: "/api/v1/jobs/job-1/notes",
      payload: { note: "Flashing missing" },
    });
    await queueOutboxAction("waiting-action", 2_000);
    const fetcher = vi.fn<typeof fetch>();

    expect(await flushOutbox({ ...principal, fetcher, now: () => 3_000 })).toEqual({
      processed: 0,
      verified: 0,
      requeued: 0,
      needsAttention: 0,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect((await getOutboxAction("waiting-action"))?.state).toBe("queued");
  });

  it("clears a rejected device proof while retaining the local action for later review", async () => {
    await storeDeviceSecret("d".repeat(43));
    await saveOutboxAction({
      ...principal,
      deviceActionId: "revoked-device-action",
      kind: "field_note",
      endpoint: "/api/v1/jobs/job-1/notes",
      payload: { note: "Weather delay" },
    });
    await queueOutboxAction("revoked-device-action", 2_000);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: "unauthorized" }, { status: 401 }));

    await flushOutbox({
      ...principal,
      fetcher,
      csrfToken: "csrf",
      deviceProof: getDeviceSecret,
      now: () => 3_000,
    });

    expect(await getDeviceSecret()).toBeUndefined();
    expect(await getOutboxAction("revoked-device-action")).toMatchObject({
      state: "needs_attention",
    });
  });

  it("sends a metadata-only field check-in as multipart", async () => {
    await saveOutboxAction({
      ...principal,
      deviceActionId: "metadata-only-field-action",
      kind: "field_checkin",
      endpoint: "/api/v1/jobs/JOB-A/check-ins",
      payload: { assignment_id: "ASSIGN-A", blocker: true },
    });
    await queueOutboxAction("metadata-only-field-action", 2_000);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      expect(init?.body).toBeInstanceOf(FormData);
      const form = init?.body as FormData;
      const metadata = JSON.parse(String(form.get("metadata"))) as Record<string, unknown>;
      expect(metadata).toMatchObject({
        device_action_id: "metadata-only-field-action",
        attachments: [],
      });
      expect(form.getAll("attachments")).toHaveLength(0);
      return Response.json({
        device_action_id: "metadata-only-field-action",
        status: "verified",
      });
    });

    expect(
      await flushOutbox({ ...principal, fetcher, csrfToken: "csrf", now: () => 3_000 }),
    ).toMatchObject({ processed: 1, verified: 1 });
  });

  it("retains action and Blob evidence when the server reports a conflict", async () => {
    const blob = new Blob(["new photo"], { type: "image/jpeg" });
    await saveOutboxAction({
      ...principal,
      deviceActionId: "conflict-action",
      kind: "evidence_upload",
      endpoint: "/api/v1/jobs/job-1/evidence",
      payload: { proof_slot: "deck" },
      attachments: [{ attachmentId: "photo-1", blob, fileName: "deck.jpg" }],
    });
    await queueOutboxAction("conflict-action", 2_000);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { code: "proof_slot_changed", message: "Office changed the required proof slot." },
          { status: 409 },
        ),
      );

    const result = await flushOutbox({
      ...principal,
      fetcher,
      csrfToken: "csrf",
      now: () => 3_000,
    });

    expect(result.needsAttention).toBe(1);
    const saved = await getOutboxActionWithBlobs("conflict-action");
    expect(saved?.action).toMatchObject({
      state: "needs_attention",
      conflict: { status: 409, code: "proof_slot_changed" },
    });
    expect(saved?.blobs[0]?.blob.size).toBe(blob.size);
  });

  it("requeues transient failures with bounded backoff", async () => {
    await saveOutboxAction({
      ...principal,
      deviceActionId: "retry-action",
      kind: "field_note",
      endpoint: "/api/v1/jobs/job-1/notes",
      payload: { note: "Weather delay" },
    });
    await queueOutboxAction("retry-action", 2_000);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ code: "busy" }, { status: 503, headers: { "Retry-After": "7" } }),
      );

    const result = await flushOutbox({
      ...principal,
      fetcher,
      csrfToken: "csrf",
      now: () => 3_000,
    });

    expect(result.requeued).toBe(1);
    expect(await getOutboxAction("retry-action")).toMatchObject({
      state: "queued",
      attempts: 1,
      nextAttemptAt: 10_000,
    });
    expect(retryDelayMilliseconds(20, () => 0)).toBe(300_000);
  });

  it("recovers an expired multipart field check-in during a direct flush", async () => {
    const photos = [
      new Blob(["photo one"], { type: "image/jpeg" }),
      new Blob(["photo two"], { type: "image/jpeg" }),
    ];
    await saveOutboxAction({
      ...principal,
      deviceActionId: "field-recovery-action",
      kind: "field_checkin",
      endpoint: "/api/v1/jobs/JOB-A/check-ins",
      payload: {
        assignment_id: "ASSIGN-A",
        proof_slot: "Production",
        location_permission_state: "not_requested",
      },
      attachments: photos.map((blob, index) => ({
        attachmentId: `photo-${index}`,
        blob,
        fileName: `roof-${index}.jpg`,
      })),
    });
    await queueOutboxAction("field-recovery-action", 2_000);
    expect((await claimNextQueuedAction(principal, 2_100))?.state).toBe("uploading");

    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      const form = init?.body as FormData;
      const metadata = JSON.parse(String(form.get("metadata"))) as Record<string, unknown>;
      expect(metadata.device_action_id).toBe("field-recovery-action");
      expect(form.getAll("attachments")).toHaveLength(2);
      return Response.json({
        device_action_id: "field-recovery-action",
        status: "verified",
        server_ref: "FIELD-CHECKIN-1",
      });
    });
    const result = await flushOutbox({
      ...principal,
      fetcher,
      csrfToken: "current-csrf",
      now: () => 2_100 + OUTBOX_UPLOAD_LEASE_MS,
    });
    expect(result).toMatchObject({ processed: 1, verified: 1 });
    expect(await getOutboxAction("field-recovery-action")).toMatchObject({
      state: "verified",
      attempts: 2,
      verification: { serverRef: "FIELD-CHECKIN-1" },
    });
    expect((await getOutboxActionWithBlobs("field-recovery-action"))?.blobs).toHaveLength(0);
  });

  it("does not requeue a live upload during second-tab recovery", async () => {
    await saveOutboxAction({
      ...principal,
      deviceActionId: "live-cross-tab-action",
      kind: "field_checkin",
      endpoint: "/api/v1/jobs/JOB-A/check-ins",
      payload: { assignment_id: "ASSIGN-A" },
    });
    await queueOutboxAction("live-cross-tab-action", 1_000);

    let beginUpload!: () => void;
    const uploadStarted = new Promise<void>((resolve) => {
      beginUpload = resolve;
    });
    let finishUpload!: (response: Response) => void;
    const uploadResponse = new Promise<Response>((resolve) => {
      finishUpload = resolve;
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      beginUpload();
      return uploadResponse;
    });

    const firstTab = flushOutbox({
      ...principal,
      fetcher,
      csrfToken: "csrf",
      now: () => 1_000,
    });
    await uploadStarted;

    // A second browser context has its own in-memory flush lock, but shares
    // IndexedDB. Recovery must leave the first tab's fresh persisted lease alone.
    expect(await recoverResumableOutboxActions(principal, 1_001)).toBe(0);
    expect(await getOutboxAction("live-cross-tab-action")).toMatchObject({
      state: "uploading",
      uploadLeaseExpiresAt: 1_000 + OUTBOX_UPLOAD_LEASE_MS,
    });

    finishUpload(Response.json({ device_action_id: "live-cross-tab-action", status: "verified" }));
    await expect(firstTab).resolves.toMatchObject({ processed: 1, verified: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("renews only the current upload lease", async () => {
    await saveOutboxAction({
      ...principal,
      deviceActionId: "lease-renewal-action",
      kind: "field_note",
      endpoint: "/api/v1/jobs/JOB-A/notes",
      payload: { note: "Wind delay" },
    });
    await queueOutboxAction("lease-renewal-action", 1_000);
    const claim = await claimNextQueuedAction(principal, 1_000);
    expect(claim).toBeDefined();
    if (!claim) throw new Error("Expected queued action to be claimed.");

    expect(await renewOutboxUploadLease(claim.deviceActionId, claim.uploadLeaseId, 4_000)).toBe(
      true,
    );
    expect(await renewOutboxUploadLease(claim.deviceActionId, "stale-lease", 5_000)).toBe(false);
    expect(await getOutboxAction("lease-renewal-action")).toMatchObject({
      state: "uploading",
      uploadLeaseId: claim.uploadLeaseId,
      uploadLeaseExpiresAt: 4_000 + OUTBOX_UPLOAD_LEASE_MS,
    });
  });

  it("fences a stale upload owner from verifying or requeueing a newer lease", async () => {
    const blob = new Blob(["roof evidence"], { type: "image/jpeg" });
    await saveOutboxAction({
      ...principal,
      deviceActionId: "fenced-upload-action",
      kind: "evidence_upload",
      endpoint: "/api/v1/jobs/JOB-A/evidence",
      payload: { proof_slot: "arrival" },
      attachments: [{ attachmentId: "fenced-photo", blob, fileName: "arrival.jpg" }],
    });
    await queueOutboxAction("fenced-upload-action", 1_000);
    const staleClaim = await claimNextQueuedAction(principal, 1_000);
    expect(staleClaim).toBeDefined();
    if (!staleClaim) throw new Error("Expected first upload lease.");

    const expiration = 1_000 + OUTBOX_UPLOAD_LEASE_MS;
    expect(await recoverResumableOutboxActions(principal, expiration)).toBe(1);
    const currentClaim = await claimNextQueuedAction(principal, expiration);
    expect(currentClaim).toBeDefined();
    if (!currentClaim) throw new Error("Expected replacement upload lease.");
    expect(currentClaim.uploadLeaseId).not.toBe(staleClaim.uploadLeaseId);

    await expect(
      markOutboxVerified(
        staleClaim.deviceActionId,
        { verifiedAt: expiration + 1 },
        expiration + 1,
        staleClaim.uploadLeaseId,
      ),
    ).resolves.toBeUndefined();
    await expect(
      requeueOutboxAction(
        staleClaim.deviceActionId,
        {
          error: {
            code: "network_error",
            message: "Old tab lost its request.",
            occurredAt: expiration + 1,
          },
          nextAttemptAt: expiration + 2,
        },
        expiration + 1,
        staleClaim.uploadLeaseId,
      ),
    ).resolves.toBeUndefined();

    const stored = await getOutboxActionWithBlobs("fenced-upload-action");
    expect(stored).toMatchObject({
      action: {
        state: "uploading",
        uploadLeaseId: currentClaim.uploadLeaseId,
      },
      blobs: [{ blobKey: "fenced-upload-action:fenced-photo" }],
    });
  });

  it("recovers Blob-backed local field work interrupted before queueing for its own principal only", async () => {
    const blob = new Blob(["saved before queueing"], { type: "image/jpeg" });
    await saveOutboxAction({
      ...principal,
      deviceActionId: "saved-local-recovery-action",
      kind: "field_checkin",
      endpoint: "/api/v1/jobs/JOB-A/check-ins",
      payload: { assignment_id: "ASSIGN-A", proof_slot: "Production" },
      attachments: [{ attachmentId: "saved-local-photo", blob, fileName: "roof.jpg" }],
    });

    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("Idempotency-Key")).toBe("saved-local-recovery-action");
      const form = init?.body as FormData;
      const metadata = JSON.parse(String(form.get("metadata"))) as Record<string, unknown>;
      expect(metadata.device_action_id).toBe("saved-local-recovery-action");
      expect(form.getAll("attachments")).toHaveLength(1);
      return Response.json({
        device_action_id: "saved-local-recovery-action",
        status: "verified",
      });
    });

    const wrongUser = await initializeOutbox({
      tenantId: principal.tenantId,
      userId: "field-user-b",
      csrfToken: "other-user-csrf",
      fetcher,
      now: () => 2_000,
    });
    expect(wrongUser).toEqual({ processed: 0, verified: 0, requeued: 0, needsAttention: 0 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await getOutboxActionWithBlobs("saved-local-recovery-action")).toMatchObject({
      action: { state: "saved_locally" },
      blobs: [{ blobKey: "saved-local-recovery-action:saved-local-photo" }],
    });

    const result = await initializeOutbox({
      ...principal,
      csrfToken: "current-user-csrf",
      fetcher,
      now: () => 3_000,
    });
    expect(result).toEqual({ processed: 1, verified: 1, requeued: 0, needsAttention: 0 });
    expect(await getOutboxAction("saved-local-recovery-action")).toMatchObject({
      state: "verified",
      attempts: 1,
    });
    expect((await getOutboxActionWithBlobs("saved-local-recovery-action"))?.blobs).toHaveLength(0);
    await expect(queueOutboxAction("saved-local-recovery-action", 3_100)).resolves.toMatchObject({
      state: "verified",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("allows the save flow to queue an action already promoted by startup recovery", async () => {
    await saveOutboxAction({
      ...principal,
      deviceActionId: "recovery-queue-race-action",
      kind: "field_checkin",
      endpoint: "/api/v1/jobs/JOB-A/check-ins",
      payload: { assignment_id: "ASSIGN-A" },
    });

    expect(await recoverResumableOutboxActions(principal, 2_000)).toBe(1);
    await expect(queueOutboxAction("recovery-queue-race-action", 2_100)).resolves.toMatchObject({
      state: "queued",
      nextAttemptAt: 2_000,
      lastError: { code: "queue_interrupted" },
    });
  });

  it("rejects invalid state jumps and payload secrets", async () => {
    expect(() => assertTransition("saved_locally", "verified")).toThrow(
      "Invalid outbox transition",
    );
    await expect(
      saveOutboxAction({
        ...principal,
        kind: "unsafe",
        endpoint: "/api/v1/jobs/job-1/notes",
        payload: { nested: { csrf_token: "must-not-persist" } },
      }),
    ).rejects.toThrow("Session secrets cannot be saved");
    await expect(
      saveOutboxAction({
        ...principal,
        kind: "unsafe-device-proof",
        endpoint: "/api/v1/jobs/job-1/notes",
        payload: { device_proof: "must-not-persist" },
      }),
    ).rejects.toThrow("Session secrets cannot be saved");

    await saveOutboxAction({
      ...principal,
      deviceActionId: "state-action",
      kind: "field_note",
      endpoint: "/api/v1/jobs/job-1/notes",
      payload: {},
    });
    await expect(transitionOutboxAction("state-action", "verified")).rejects.toThrow(
      "Invalid outbox transition",
    );
    expect(await (await getDatabase()).count("outbox_actions")).toBe(1);
  });

  it("never flushes another tenant or user's saved field work on a shared device", async () => {
    await saveOutboxAction({
      ...principal,
      deviceActionId: "user-a-action",
      kind: "field_checkin",
      endpoint: "/api/v1/jobs/JOB-A/check-ins",
      payload: { assignment_id: "ASSIGN-A" },
    });
    await queueOutboxAction("user-a-action", 2_000);
    const fetcher = vi.fn<typeof fetch>();

    const wrongUser = await flushOutbox({
      tenantId: principal.tenantId,
      userId: "field-user-b",
      csrfToken: "user-b-csrf",
      fetcher,
      now: () => 3_000,
    });

    expect(wrongUser).toEqual({
      processed: 0,
      verified: 0,
      requeued: 0,
      needsAttention: 0,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect((await getOutboxAction("user-a-action"))?.state).toBe("queued");
    expect(
      await getOutboxSummary({ tenantId: principal.tenantId, userId: "field-user-b" }),
    ).toMatchObject({ pending: 0, needsAttention: 0, unclaimed: 0 });
    expect(await getOutboxSummary(principal)).toMatchObject({ pending: 1, unclaimed: 0 });

    expect((await claimNextQueuedAction(principal, 3_100))?.state).toBe("uploading");
    await initializeOutbox({
      tenantId: principal.tenantId,
      userId: "field-user-b",
      csrfToken: "user-b-csrf",
      fetcher,
      now: () => 3_200,
    });
    expect((await getOutboxAction("user-a-action"))?.state).toBe("uploading");
  });

  it("quarantines legacy actions without silently assigning them to the current user", async () => {
    await (
      await getDatabase()
    ).put("outbox_actions", {
      deviceActionId: "legacy-action",
      kind: "field_checkin",
      endpoint: "/api/v1/jobs/JOB-A/check-ins",
      method: "POST",
      payload: {},
      attachments: [],
      state: "queued",
      attempts: 0,
      nextAttemptAt: 1_000,
      createdAt: 1_000,
      updatedAt: 1_000,
      version: 1,
    } as never);

    expect(await getOutboxSummary(principal)).toMatchObject({ pending: 0, unclaimed: 1 });
    expect(await claimNextQueuedAction(principal, 2_000)).toBeUndefined();
  });
});
