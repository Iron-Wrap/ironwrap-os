// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getDatabase, resetDatabaseForTests } from "./db";
import {
  assertTransition,
  claimNextQueuedAction,
  getOutboxAction,
  getOutboxActionWithBlobs,
  queueOutboxAction,
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
      now: () => 3_000,
    });

    expect(result).toMatchObject({ processed: 1, verified: 1 });
    const saved = await getOutboxAction("stable-action");
    expect(saved).toMatchObject({
      state: "verified",
      verification: { serverRef: "checkin-42", verifiedAt: 3_000 },
    });
    expect(JSON.stringify(saved)).not.toContain("current-csrf-only");
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

  it("recovers an interrupted multipart field check-in and verifies the same stable action", async () => {
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
    const result = await initializeOutbox({
      ...principal,
      fetcher,
      csrfToken: "current-csrf",
      now: () => 3_000,
    });
    expect(result).toMatchObject({ processed: 1, verified: 1 });
    expect(await getOutboxAction("field-recovery-action")).toMatchObject({
      state: "verified",
      attempts: 2,
      verification: { serverRef: "FIELD-CHECKIN-1" },
    });
    expect((await getOutboxActionWithBlobs("field-recovery-action"))?.blobs).toHaveLength(0);
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
