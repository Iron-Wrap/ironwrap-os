// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getDatabase, resetDatabaseForTests } from "./db";
import { getDeviceSecret, storeDeviceSecret } from "../auth/device-credential";
import { receiptIdFor } from "../evidence/evidence-test-harness";
import {
  assertTransition,
  claimNextQueuedAction,
  getOutboxAction,
  getOutboxActionsNeedingAttention,
  getOutboxActionWithBlobs,
  isOutboxActionSafeToRetry,
  markOutboxNeedsAttention,
  markOutboxVerified,
  OUTBOX_UPLOAD_LEASE_MS,
  queueOutboxAction,
  recoverResumableOutboxActions,
  renewOutboxUploadLease,
  requeueOutboxAction,
  retryOutboxAction,
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
        kind: "field_checkin",
        endpoint: "/api/v1/jobs/job-1/check-ins",
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
      kind: "work_package_acknowledgement",
      endpoint: "/api/v1/jobs/job-1/work-package/acknowledgements",
      payload: {
        work_package_id: "WP-1",
        work_package_version: 1,
        release_attempt_id: "attempt-1",
      },
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
        payload: {
          work_package_id: "WP-1",
          work_package_version: 1,
          release_attempt_id: "attempt-1",
        },
      });
      return Response.json({
        device_action_id: "stable-action",
        status: "verified",
        server_ref: "work-package-42",
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
      verification: { serverRef: "work-package-42", verifiedAt: 3_000 },
    });
    expect(JSON.stringify(saved)).not.toContain("current-csrf-only");
    expect(JSON.stringify(saved)).not.toContain("current-device-proof");
  });

  it("keeps that a safety stop's job was not found, so the phone can say it holds every job", async () => {
    await saveOutboxAction({
      ...principal,
      deviceActionId: "stop-action-1",
      kind: "safety_action",
      endpoint: "/api/v1/safety/actions",
      payload: {
        kind: "report_occurrence",
        scope_type: "roof_job",
        scope_id: "JOB-GONE",
        captured_at: "2026-08-17T12:00:00.000Z",
        detail: "Work stopped on J-GONE",
        occurrence_kind: "hazard",
        severity: "high",
      },
    });
    await queueOutboxAction("stop-action-1", 2_000);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          device_action_id: "stop-action-1",
          status: "verified",
          server_ref: "so_0001",
          scope_unresolved: true,
        },
        { status: 201 },
      ),
    );
    await flushOutbox({ ...principal, fetcher, csrfToken: "csrf", now: () => 3_000 });
    expect(await getOutboxAction("stop-action-1")).toMatchObject({
      state: "verified",
      verification: { serverRef: "so_0001", scopeUnresolved: true },
    });
  });

  it("replays inventory intent and scan bodies unchanged with durable identities", async () => {
    await saveOutboxAction({
      ...principal,
      deviceActionId: "inventory-command-action",
      kind: "inventory_command",
      endpoint: "/api/v1/inventory/commands",
      payload: {
        command_id: "inventory-command-1",
        idempotency_key: "inventory-command-action",
        transition: "issue_use",
        authority_ref: "authority-readback-1",
        policy_ref: "policy:inventory-command",
        policy_version: "1",
      },
      evidence: {
        scope: {
          purpose: "stock",
          targetId: "lot-1",
          action: "issue_use",
          operationId: "inventory-command-1",
        },
        files: [
          {
            uploadKey: "evidence-key-0001",
            fileName: "issue.jpg",
            mimeType: "image/jpeg",
            size: 12,
            receiptId: receiptIdFor(1),
            blob: new Blob([new Uint8Array(12)], { type: "image/jpeg" }),
          },
        ],
      },
    });
    await queueOutboxAction("inventory-command-action", 2_000);
    await saveOutboxAction({
      ...principal,
      deviceActionId: "inventory-scan-action",
      kind: "inventory_scan",
      endpoint: "/api/v1/inventory/scans",
      payload: {
        scan_id: "inventory-scan-1",
        device_id: "device-1",
        device_action_id: "inventory-scan-action",
        barcode: "LOT-1",
        scan_intent: "lookup",
        observed_at: "2026-08-20T09:00:00.000Z",
        captured_offline: true,
        request_fingerprint_sha256: "b".repeat(64),
        payload: {},
      },
    });
    await queueOutboxAction("inventory-scan-action", 2_000);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      const actionId = new Headers(init?.headers).get("X-Device-Action-Id");
      const sent = JSON.parse(String(init?.body));
      expect(sent).toMatchObject(
        actionId === "inventory-command-action"
          ? {
              command_id: "inventory-command-1",
              transition: "issue_use",
              evidence_receipt_ids: [receiptIdFor(1)],
            }
          : { scan_id: "inventory-scan-1", device_action_id: "inventory-scan-action" },
      );
      // The files travel as confirmed receipts; no typed reference or digest rides along.
      expect(sent).not.toHaveProperty("evidence_refs");
      return Response.json({ device_action_id: actionId, status: "verified" });
    });
    const result = await flushOutbox({
      ...principal,
      fetcher,
      csrfToken: "current-csrf-only",
      now: () => 2_000,
    });
    expect(result.verified).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("caches and replays a typed Shop Order acknowledgement without a Roof Job endpoint", async () => {
    const payload = {
      work_package_id: "WP-SHOP-1",
      work_package_version: 4,
      release_attempt_id: "attempt-shop-1",
      work_object_type: "Shop Order",
      work_object_id: "SHOP-001",
      physical_context_type: "Shop Floor",
      physical_context_id: "SHOP-FLOOR-1",
    };
    await saveOutboxAction({
      ...principal,
      deviceActionId: "typed-shop-ack",
      kind: "work_package_acknowledgement",
      endpoint:
        "/api/v1/work-objects/Shop%20Order/SHOP-001/physical-contexts/Shop%20Floor/SHOP-FLOOR-1/work-package/acknowledgements",
      payload,
    });
    await queueOutboxAction("typed-shop-ack", 2_000);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      expect(String(input)).toContain("/work-objects/Shop%20Order/SHOP-001/");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        device_action_id: "typed-shop-ack",
        payload,
      });
      return Response.json({
        device_action_id: "typed-shop-ack",
        status: "verified",
        server_ref: "EVENT-SHOP-ACK",
      });
    });
    await expect(
      flushOutbox({
        ...principal,
        fetcher,
        csrfToken: "current-csrf",
        now: () => 3_000,
      }),
    ).resolves.toMatchObject({ processed: 1, verified: 1 });
    expect(await getOutboxAction("typed-shop-ack")).toMatchObject({
      state: "verified",
      verification: { serverRef: "EVENT-SHOP-ACK" },
    });
  });

  it("replays a typed evidence correction through the universal check-in endpoint", async () => {
    const blob = new Blob(["replacement-photo"], { type: "image/jpeg" });
    await saveOutboxAction({
      ...principal,
      deviceActionId: "typed-shop-correction",
      kind: "field_checkin",
      endpoint:
        "/api/v1/work-objects/Shop%20Order/SHOP-001/physical-contexts/Shop%20Floor/SHOP-FLOOR-1/check-ins",
      payload: {
        assignment_id: "ASSIGN-SHOP-1",
        proof_slot: "Production",
        work_package_id: "WP-SHOP-1",
        work_package_version: 4,
        work_package_release_attempt_id: "attempt-shop-1",
        evidence_slot_id: "step:1",
        evidence_requirement: "Anchor inspection photo",
        evidence_source: "field-companion",
        evidence_correction_of: "EVENT-SHOP-OLD",
        evidence_item_correction_of: "EVIDENCE-SHOP-OLD",
        correction_reason: "The first photo missed the guard latch.",
      },
      attachments: [{ blob, fileName: "replacement.jpg" }],
    });
    await queueOutboxAction("typed-shop-correction", 2_000);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      expect(String(input)).toContain("/work-objects/Shop%20Order/SHOP-001/");
      const form = init?.body as FormData;
      const metadata = JSON.parse(String(form.get("metadata"))) as {
        payload: Record<string, unknown>;
      };
      expect(metadata.payload.evidence_correction_of).toBe("EVENT-SHOP-OLD");
      expect(metadata.payload.evidence_item_correction_of).toBe("EVIDENCE-SHOP-OLD");
      expect(form.getAll("attachments")).toHaveLength(1);
      return Response.json({
        device_action_id: "typed-shop-correction",
        status: "verified",
        server_ref: "FIELD-EVENT-SHOP-CORRECTION",
      });
    });
    await expect(
      flushOutbox({
        ...principal,
        fetcher,
        csrfToken: "current-csrf",
        now: () => 3_000,
      }),
    ).resolves.toMatchObject({ processed: 1, verified: 1 });
    expect(await getOutboxAction("typed-shop-correction")).toMatchObject({
      state: "verified",
      verification: { serverRef: "FIELD-EVENT-SHOP-CORRECTION" },
    });
  });

  it("does not upload until a current CSRF token is available", async () => {
    await saveOutboxAction({
      ...principal,
      deviceActionId: "waiting-action",
      kind: "work_package_stop",
      endpoint: "/api/v1/jobs/job-1/work-package/stop-work",
      payload: {
        work_package_id: "WP-1",
        work_package_version: 1,
        blocker_reason: "Flashing missing",
      },
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
      kind: "work_package_stop",
      endpoint: "/api/v1/jobs/job-1/work-package/stop-work",
      payload: {
        work_package_id: "WP-1",
        work_package_version: 1,
        blocker_reason: "Weather delay",
      },
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

  it("preserves an exact structured measurement and tape photo when its assignment correction is refused", async () => {
    const measurement = { feet: 42, inches: 7, eighths: 3, area_label: "Synthetic south eave" };
    const payload = {
      assignment_id: "ASSIGN-MEASUREMENT",
      proof_slot: "Measurement",
      measurement,
      evidence_correction_of: `wpe_${"a".repeat(32)}`,
      evidence_item_correction_of: `evi_${"a".repeat(32)}`,
      correction_reason: "Read the tape again",
      work_package_id: "WP-MEASUREMENT",
      work_package_version: 3,
      work_package_release_attempt_id: "release-exact",
      evidence_slot_id: "step:1",
      evidence_requirement: "Synthetic tape reading and photo",
      evidence_source: "field-companion",
    };
    await saveOutboxAction({
      ...principal,
      deviceActionId: "measurement-assignment-refused",
      kind: "field_checkin",
      endpoint: "/api/v1/jobs/JOB-MEASUREMENT/check-ins",
      payload,
      attachments: [
        {
          attachmentId: "measurement-tape",
          blob: new Blob(["synthetic tape photo"], { type: "image/jpeg" }),
          fileName: "tape.jpg",
        },
      ],
    });
    await queueOutboxAction("measurement-assignment-refused", 2_000);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("Idempotency-Key")).toBe("measurement-assignment-refused");
      expect(headers.get("X-CSRF-Token")).toBe("current-csrf");
      expect(JSON.parse(String((init?.body as FormData).get("metadata"))).payload).toEqual(payload);
      return Response.json(
        { error: "field_measurement_correction_invalid", retryable: false },
        { status: 409 },
      );
    });
    expect(
      await flushOutbox({ ...principal, fetcher, csrfToken: "current-csrf", now: () => 3_000 }),
    ).toMatchObject({ verified: 0, needsAttention: 1, requeued: 0 });
    const saved = await getOutboxActionWithBlobs("measurement-assignment-refused");
    expect(saved?.action).toMatchObject({ state: "needs_attention", payload });
    expect(saved?.blobs).toHaveLength(1);
    expect(isOutboxActionSafeToRetry(saved!.action)).toBe(false);
    await expect(retryOutboxAction("measurement-assignment-refused")).rejects.toThrow(
      "cannot be retried safely",
    );
    await flushOutbox({ ...principal, fetcher, csrfToken: "current-csrf", now: () => 4_000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retains action and Blob evidence when the server reports a conflict", async () => {
    const blob = new Blob(["new photo"], { type: "image/jpeg" });
    await saveOutboxAction({
      ...principal,
      deviceActionId: "conflict-action",
      kind: "field_checkin",
      endpoint: "/api/v1/jobs/job-1/check-ins",
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

  it("surfaces only this user's attention items and permits retry only for transient non-conflicts", async () => {
    await saveOutboxAction({
      ...principal,
      deviceActionId: "safe-retry-action",
      kind: "field_checkin",
      endpoint: "/api/v1/jobs/JOB-SAFE/check-ins",
      payload: {},
    });
    await queueOutboxAction("safe-retry-action", 1_000);
    await markOutboxNeedsAttention(
      "safe-retry-action",
      {
        error: {
          code: "http_503",
          message: "The server was temporarily unavailable.",
          status: 503,
          occurredAt: 2_000,
        },
      },
      2_000,
    );

    await saveOutboxAction({
      ...principal,
      deviceActionId: "conflict-recovery-action",
      kind: "field_checkin",
      endpoint: "/api/v1/jobs/JOB-CONFLICT/check-ins",
      payload: {},
    });
    await queueOutboxAction("conflict-recovery-action", 1_000);
    await markOutboxNeedsAttention(
      "conflict-recovery-action",
      {
        error: {
          code: "assignment_changed",
          message: "The office assignment changed.",
          status: 409,
          occurredAt: 3_000,
        },
        conflict: {
          status: 409,
          code: "assignment_changed",
          message: "The office assignment changed.",
          detectedAt: 3_000,
        },
      },
      3_000,
    );

    await saveOutboxAction({
      tenantId: principal.tenantId,
      userId: "another-field-user",
      deviceActionId: "other-user-action",
      kind: "field_checkin",
      endpoint: "/api/v1/jobs/JOB-OTHER/check-ins",
      payload: {},
    });
    await queueOutboxAction("other-user-action", 1_000);
    await markOutboxNeedsAttention(
      "other-user-action",
      {
        error: {
          code: "http_503",
          message: "The server was temporarily unavailable.",
          status: 503,
          occurredAt: 4_000,
        },
      },
      4_000,
    );

    const attention = await getOutboxActionsNeedingAttention(principal);
    expect(attention.map((action) => action.deviceActionId)).toEqual([
      "conflict-recovery-action",
      "safe-retry-action",
    ]);
    expect(isOutboxActionSafeToRetry(attention[0]!)).toBe(false);
    expect(isOutboxActionSafeToRetry(attention[1]!)).toBe(true);
    await expect(retryOutboxAction("conflict-recovery-action")).rejects.toThrow(
      "cannot be retried safely",
    );
    await retryOutboxAction("safe-retry-action", 5_000);
    expect((await getOutboxAction("safe-retry-action"))?.state).toBe("queued");
  });

  /**
   * ELEC-213: the plain, unbound capture path. `processFieldSubmission` refuses a submission only
   * when it *asserts* a Work Package binding without a package
   * (`workers-bus/src/field-actions.ts` `carriesEvidenceBinding`), and `0044`'s trigger is a no-op
   * when none of its 13 columns are set. So a photo check-in on a job production has not planned
   * yet is a legal send, and the multipart body must carry the file with no binding column in it.
   */
  it("uploads a photo check-in that asserts no work package binding", async () => {
    const photo = new Blob(["north slope bytes"], { type: "image/jpeg" });
    await saveOutboxAction({
      ...principal,
      deviceActionId: "unplanned-photo-action",
      kind: "field_checkin",
      endpoint: "/api/v1/jobs/JOB-NO-PLAN/check-ins",
      payload: {
        assignment_id: "ASSIGN-1",
        proof_slot: "Production",
        notes: null,
        blocker: false,
        work_package_release_attempt_id: null,
        evidence_correction_of: null,
        evidence_item_correction_of: null,
      },
      attachments: [{ blob: photo, fileName: "north-slope.jpg", attachmentId: "attachment-1" }],
    });
    await queueOutboxAction("unplanned-photo-action", 2_000);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ device_action_id: "unplanned-photo-action", status: "verified" }),
      );

    const result = await flushOutbox({
      ...principal,
      fetcher,
      csrfToken: "csrf",
      now: () => 3_000,
    });

    expect(result).toMatchObject({ verified: 1, needsAttention: 0, requeued: 0 });
    expect((await getOutboxAction("unplanned-photo-action"))?.state).toBe("verified");
    const body = fetcher.mock.calls[0]?.[1]?.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    const files = body.getAll("attachments");
    expect(files).toHaveLength(1);
    expect((files[0] as File).name).toBe("north-slope.jpg");
    const metadata = JSON.parse(String(body.get("metadata")));
    for (const column of [
      "work_package_id",
      "work_package_version",
      "evidence_slot_id",
      "evidence_requirement",
      "evidence_source",
      "evidence_device_id",
      "evidence_freshness",
      "evidence_conflict_state",
      "evidence_verification",
      "evidence_disposition",
    ])
      expect(metadata.payload[column]).toBeUndefined();
    expect(metadata.payload.work_package_release_attempt_id).toBeNull();
    expect(metadata.payload.evidence_correction_of).toBeNull();
    expect(metadata.payload.evidence_item_correction_of).toBeNull();
  });

  /**
   * ELEC-211: a constraint the server can never satisfy on replay must leave the retry loop, keep
   * its evidence, and stop offering a retry — whatever status carried it. A 502 here is the exact
   * shape `processFieldSubmission` returns today for the work-package binding trigger.
   */
  it("stops retrying a terminal refusal that arrives with a retryable status", async () => {
    const photo = new Blob(["roof photo bytes"], { type: "image/jpeg" });
    await saveOutboxAction({
      ...principal,
      deviceActionId: "terminal-binding-action",
      kind: "field_checkin",
      endpoint: "/api/v1/jobs/JOB-NO-PLAN/check-ins",
      payload: { proof_slot: "Production" },
      attachments: [{ blob: photo, fileName: "north-slope.jpg", attachmentId: "attachment-9" }],
    });
    await queueOutboxAction("terminal-binding-action", 2_000);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          code: "field_action_work_package_binding_invalid",
          message: "The submission has no released work package to bind to.",
        },
        { status: 502 },
      ),
    );

    const result = await flushOutbox({
      ...principal,
      fetcher,
      csrfToken: "csrf",
      now: () => 3_000,
    });

    expect(result).toMatchObject({ requeued: 0, needsAttention: 1 });
    const stopped = await getOutboxAction("terminal-binding-action");
    expect(stopped).toMatchObject({
      state: "needs_attention",
      lastError: { code: "field_action_work_package_binding_invalid", status: 502 },
    });
    expect(isOutboxActionSafeToRetry(stopped!)).toBe(false);
    await expect(retryOutboxAction("terminal-binding-action")).rejects.toThrow(
      "cannot be retried safely",
    );
    // The photo is the crew member's evidence: a refusal never deletes it.
    expect(
      (await getOutboxActionWithBlobs("terminal-binding-action"))?.blobs.map(
        (record) => record.attachmentId,
      ),
    ).toEqual(["attachment-9"]);
  });

  it("stops a terminal 4xx refusal and keeps a transient 5xx retrying", async () => {
    for (const deviceActionId of ["terminal-4xx-action", "transient-5xx-action"]) {
      await saveOutboxAction({
        ...principal,
        deviceActionId,
        kind: "field_checkin",
        endpoint: `/api/v1/jobs/${deviceActionId}/check-ins`,
        payload: { proof_slot: "Production" },
      });
      await queueOutboxAction(deviceActionId, 2_000);
    }
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          {
            code: "field_action_evidence_requires_work_package",
            message: "This job has no released work package.",
          },
          { status: 422 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ code: "busy" }, { status: 503 }));

    const result = await flushOutbox({
      ...principal,
      fetcher,
      csrfToken: "csrf",
      now: () => 3_000,
      random: () => 0,
    });

    expect(result).toMatchObject({ processed: 2, requeued: 1, needsAttention: 1 });
    expect(await getOutboxAction("terminal-4xx-action")).toMatchObject({
      state: "needs_attention",
      lastError: { code: "field_action_evidence_requires_work_package", status: 422 },
    });
    expect(await getOutboxAction("transient-5xx-action")).toMatchObject({
      state: "queued",
      attempts: 1,
      nextAttemptAt: 8_000,
    });
  });

  it("requeues transient failures with bounded backoff", async () => {
    await saveOutboxAction({
      ...principal,
      deviceActionId: "retry-action",
      kind: "work_package_stop",
      endpoint: "/api/v1/jobs/job-1/work-package/stop-work",
      payload: {
        work_package_id: "WP-1",
        work_package_version: 1,
        blocker_reason: "Weather delay",
      },
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
      kind: "work_package_stop",
      endpoint: "/api/v1/jobs/JOB-A/work-package/stop-work",
      payload: { work_package_id: "WP-1", work_package_version: 1, blocker_reason: "Wind delay" },
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
      kind: "field_checkin",
      endpoint: "/api/v1/jobs/JOB-A/check-ins",
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

  it("accepts only field check-ins and immutable Work Package acknowledgement or Stop Work intents", async () => {
    await expect(
      saveOutboxAction({
        ...principal,
        kind: "work_package_start" as never,
        endpoint: "/api/v1/jobs/JOB-A/work-package/start",
        payload: { work_package_id: "WP-1" },
      }),
    ).rejects.toThrow("cannot be queued for offline replay");
    await expect(
      saveOutboxAction({
        ...principal,
        kind: "field_checkin",
        endpoint: "/api/v1/jobs/JOB-A/work-package/start",
        payload: {},
      }),
    ).rejects.toThrow("cannot be queued for offline replay");
    await expect(
      saveOutboxAction({
        ...principal,
        kind: "work_package_acknowledgement",
        endpoint: "/api/v1/jobs/JOB-A/work-package/acknowledgements",
        payload: { work_package_id: "WP-1", resume: true },
      }),
    ).rejects.toThrow("acknowledgement payload is invalid");
    await expect(
      saveOutboxAction({
        ...principal,
        kind: "work_package_stop",
        endpoint: "/api/v1/jobs/JOB-A/work-package/stop-work",
        payload: { work_package_id: "WP-1", blocker_reason: "Wind." },
        attachments: [{ blob: new Blob(["not allowed"]), fileName: "extra.txt" }],
      }),
    ).rejects.toThrow("Only field check-ins can include attachments.");
  });

  it("keeps a Stop Work attempt without a reason and preserves a longer reason", async () => {
    for (const [suffix, extra] of [
      ["absent", {}],
      ["null", { blocker_reason: null }],
      ["long", { blocker_reason: "A".repeat(1_201) }],
    ] as const) {
      const payload = { work_package_id: "WP-1", work_package_version: 1, ...extra };
      const saved = await saveOutboxAction({
        ...principal,
        deviceActionId: `stop-${suffix}-123`,
        kind: "work_package_stop",
        endpoint: "/api/v1/jobs/JOB-A/work-package/stop-work",
        payload,
      });
      expect(saved.payload).toEqual(payload);
    }
    await expect(
      saveOutboxAction({
        ...principal,
        deviceActionId: "stop-too-long-123",
        kind: "work_package_stop",
        endpoint: "/api/v1/jobs/JOB-A/work-package/stop-work",
        payload: {
          work_package_id: "WP-1",
          work_package_version: 1,
          blocker_reason: "A".repeat(4_001),
        },
      }),
    ).rejects.toThrow("Stop Work reason is too long");
  });

  it("accepts a configured-field value only on the governed record-value route", async () => {
    const value = {
      field_definition_revision_id: "rev_permit_number_1",
      expected_version: 1,
      value: "CAL-2026-8891",
      based_on_value_revision_id: null,
      correction_reason: null,
    };
    await expect(
      saveOutboxAction({
        ...principal,
        kind: "schema_field_value",
        endpoint: "/api/v1/schema-fields/job/JOB-A",
        payload: value,
      }),
    ).rejects.toThrow("cannot be queued for offline replay");
    await expect(
      saveOutboxAction({
        ...principal,
        kind: "schema_field_value",
        endpoint: "/api/v1/schema-fields/job/JOB-A/fld_permit/values",
        payload: { ...value, expected_version: "1" },
      }),
    ).rejects.toThrow("version is required");
    await expect(
      saveOutboxAction({
        ...principal,
        kind: "schema_field_value",
        endpoint: "/api/v1/schema-fields/job/JOB-A/fld_permit/values",
        payload: { ...value, tenant_hint: "tenant-a" },
      }),
    ).rejects.toThrow("payload is invalid");
    // A correction without its reason is refused by the server too. Catching it here keeps a
    // half-formed one from waiting in the queue for a network only to be rejected on arrival.
    await expect(
      saveOutboxAction({
        ...principal,
        kind: "schema_field_value",
        endpoint: "/api/v1/schema-fields/job/JOB-A/fld_permit/values",
        payload: { ...value, based_on_value_revision_id: "val_1" },
      }),
    ).rejects.toThrow("both the value it replaces and a reason");
    await expect(
      saveOutboxAction({
        ...principal,
        kind: "schema_field_value",
        endpoint: "/api/v1/schema-fields/job/JOB-A/fld_permit/values",
        payload: value,
        attachments: [{ blob: new Blob(["photo"]), fileName: "roof.jpg" }],
      }),
    ).rejects.toThrow("Only field check-ins can include attachments.");
  });

  it("rejects invalid state jumps and payload secrets", async () => {
    expect(() => assertTransition("saved_locally", "verified")).toThrow(
      "Invalid outbox transition",
    );
    await expect(
      saveOutboxAction({
        ...principal,
        kind: "field_checkin",
        endpoint: "/api/v1/jobs/job-1/check-ins",
        payload: { nested: { csrf_token: "must-not-persist" } },
      }),
    ).rejects.toThrow("Session secrets cannot be saved");
    await expect(
      saveOutboxAction({
        ...principal,
        kind: "field_checkin",
        endpoint: "/api/v1/jobs/job-1/check-ins",
        payload: { device_proof: "must-not-persist" },
      }),
    ).rejects.toThrow("Session secrets cannot be saved");

    await saveOutboxAction({
      ...principal,
      deviceActionId: "state-action",
      kind: "field_checkin",
      endpoint: "/api/v1/jobs/job-1/check-ins",
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

  it.each([
    ["matches", (refs: string[]) => refs, undefined],
    [
      "has an extra file",
      (refs: string[]) => [...refs, `evidence-upload://${receiptIdFor(99)}`],
      undefined,
    ],
    ["is missing a file", (refs: string[]) => refs.slice(1), undefined],
    [
      "lists a different file",
      (refs: string[]) => [`evidence-upload://${receiptIdFor(98)}`, ...refs.slice(1)],
      undefined,
    ],
    ["was captured by someone else", (refs: string[]) => refs, "another-user"],
  ])(
    "reads the corrective evidence back before clearing the outbox (the record %s)",
    async (label, listRefs, capturedBy) => {
      const payload = { detail: "Tie-off installed and checked." };
      const receipts = [receiptIdFor(1), receiptIdFor(2)];
      const saved = await saveOutboxAction({
        ...principal,
        kind: "safety_corrective_evidence",
        endpoint: "/api/v1/safety/corrective-actions/ca_test/evidence",
        payload,
        evidence: {
          scope: {
            purpose: "corrective_action",
            targetId: "ca_test",
            action: "submit",
            operationId: "",
          },
          files: receipts.map((receiptId, index) => ({
            uploadKey: `evidence-key-000${index}`,
            fileName: `fix-${index}.jpg`,
            mimeType: "image/jpeg",
            size: 10,
            receiptId,
            blob: new Blob([new Uint8Array(10)], { type: "image/jpeg" }),
          })),
        },
      });
      await queueOutboxAction(saved.deviceActionId);
      const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body))).toEqual({
          detail: payload.detail,
          evidence_receipt_ids: receipts,
        });
        expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(saved.deviceActionId);
        const refs = listRefs(receipts.map((id) => `evidence-upload://${id}`));
        return Response.json({
          version: 1,
          corrective_action: {
            corrective_action_id: "ca_test",
            occurrence_id: "so_test",
            version: 4,
            state: "closed",
            risk_level: "high",
            owner_user_id: principal.userId,
            description: "Install a tie-off.",
            due_at: "2026-09-01T00:00:00.000Z",
            evidence_refs_json: JSON.stringify(
              refs.map((ref) => ({ ref, sha256: "a".repeat(64) })),
            ),
            evidence_sha256: "b".repeat(64),
            evidence_captured_by_user_id: capturedBy ?? principal.userId,
            evidence_submitted_at: "2026-09-01T00:00:00.000Z",
            verified_by_user_id: "appu_independent",
            verified_at: "2026-09-01T01:00:00.000Z",
            closed_at: "2026-09-01T02:00:00.000Z",
          },
        });
      });
      await flushOutbox({ ...principal, csrfToken: "csrf", fetcher });
      const read = await getOutboxAction(saved.deviceActionId);
      expect(read?.state, label).toBe(label === "matches" ? "verified" : "needs_attention");
      if (label !== "matches") expect(read?.payload).toEqual(payload);
    },
  );

  it.each([false, true])(
    "reads a typed corrective reference back before clearing the outbox (mismatch: %s)",
    async (mismatch) => {
      const payload = {
        detail: "Tie-off installed and checked.",
        evidence_refs_json: JSON.stringify([
          { ref: "r2://safety/inspection.pdf", sha256: "a".repeat(64) },
        ]),
        evidence_sha256: "b".repeat(64),
      };
      const saved = await saveOutboxAction({
        ...principal,
        kind: "safety_corrective_evidence",
        endpoint: "/api/v1/safety/corrective-actions/ca_test/evidence",
        payload,
      });
      await queueOutboxAction(saved.deviceActionId);
      const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body))).toEqual(payload);
        expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(saved.deviceActionId);
        return Response.json({
          version: 1,
          corrective_action: {
            corrective_action_id: "ca_test",
            occurrence_id: "so_test",
            version: 4,
            state: "closed",
            risk_level: "high",
            owner_user_id: principal.userId,
            description: "Install a tie-off.",
            due_at: "2026-09-01T00:00:00.000Z",
            ...payload,
            evidence_captured_by_user_id: mismatch ? "another-user" : principal.userId,
            evidence_submitted_at: "2026-09-01T00:00:00.000Z",
            verified_by_user_id: "appu_independent",
            verified_at: "2026-09-01T01:00:00.000Z",
            closed_at: "2026-09-01T02:00:00.000Z",
          },
        });
      });
      await flushOutbox({ ...principal, csrfToken: "csrf", fetcher });
      const read = await getOutboxAction(saved.deviceActionId);
      expect(read?.state).toBe(mismatch ? "needs_attention" : "verified");
      if (mismatch) expect(read?.payload).toEqual(payload);
    },
  );

  it("never queues corrective verification or closure as evidence", async () => {
    await expect(
      saveOutboxAction({
        ...principal,
        kind: "safety_corrective_evidence",
        endpoint: "/api/v1/safety/corrective-actions/ca_test/closure",
        payload: { detail: "Close it." },
      }),
    ).rejects.toThrow("cannot be queued");
  });
});
