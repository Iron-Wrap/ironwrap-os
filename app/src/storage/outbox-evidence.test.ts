// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { receiptIdFor } from "../evidence/evidence-test-harness";
import type { EvidenceScope } from "../evidence/evidence-types";
import { getDatabase, resetDatabaseForTests } from "./db";
import {
  claimNextQueuedAction,
  getOutboxAction,
  getOutboxActionWithBlobs,
  isOutboxActionSafeToRetry,
  queueOutboxAction,
  recordOutboxEvidenceReceipt,
  saveOutboxAction,
} from "./outbox";
import { outboxFailureGuidance } from "./outbox-failure";
import { flushOutbox } from "./outbox-processor";
import type { JsonValue, OutboxEvidenceInput } from "./outbox-types";

const principal = { tenantId: "tenant-a", userId: "field-user-a" };
const endpoint = "/api/v1/safety/corrective-actions/ca_test/evidence";
const correctiveScope: EvidenceScope = {
  purpose: "corrective_action",
  targetId: "ca_test",
  action: "submit",
  operationId: "",
};
const detail = "Tie-off installed and checked.";

function filesWithBytes(count = 2): OutboxEvidenceInput["files"] {
  return Array.from({ length: count }, (_, index) => {
    const blob = new Blob([`synthetic-bytes-${index}`], { type: "image/jpeg" });
    return {
      uploadKey: `evidence-key-000${index}`,
      fileName: `fix-${index}.jpg`,
      mimeType: "image/jpeg",
      size: blob.size,
      blob,
    };
  });
}

async function saveCorrective(files = filesWithBytes()) {
  const saved = await saveOutboxAction({
    ...principal,
    kind: "safety_corrective_evidence",
    endpoint,
    payload: { detail },
    evidence: { scope: correctiveScope, files },
  });
  await queueOutboxAction(saved.deviceActionId, 1_000);
  return saved;
}

interface UploadCall {
  kind: "upload";
  key: string;
  headers: Headers;
  fields: Record<string, string>;
  fileName: string;
  fileType: string;
  bytes: string;
}
interface SubmitCall {
  kind: "submit";
  key: string;
  headers: Headers;
  body: Record<string, unknown>;
}

/**
 * A stand-in for the Worker's two routes. Uploads are replay-safe by key and submissions by
 * idempotency key, so `applied` counts real effects however many times a request is repeated.
 */
function fakeWorker(
  behaviour: {
    upload?: (call: UploadCall, attemptForKey: number) => Response | Error | undefined;
    submit?: (
      call: SubmitCall,
      attempt: number,
    ) => Response | Error | "apply-then-lose" | undefined;
  } = {},
) {
  const log: Array<UploadCall | SubmitCall> = [];
  const receipts = new Map<string, string>();
  const applied = new Map<string, string[]>();
  const attempts = new Map<string, number>();
  const fetcher = vi.fn(async function (
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    // A browser's fetch throws "Illegal invocation" under any other receiver than the window.
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    const headers = new Headers(init?.headers);
    const key = headers.get("Idempotency-Key") ?? "";
    const attempt = (attempts.get(`${String(input)}|${key}`) ?? 0) + 1;
    attempts.set(`${String(input)}|${key}`, attempt);
    if (String(input) === "/api/v1/evidence-uploads") {
      const form = init?.body as FormData;
      const file = form.get("file") as File;
      const fields: Record<string, string> = {};
      for (const [name, value] of form.entries())
        if (typeof value === "string") fields[name] = value;
      const call: UploadCall = {
        kind: "upload",
        key,
        headers,
        fields,
        fileName: file.name,
        fileType: file.type,
        bytes: await file.text(),
      };
      log.push(call);
      const planned = behaviour.upload?.(call, attempt);
      if (planned instanceof Error) throw planned;
      if (planned) return planned;
      if (!receipts.has(key)) receipts.set(key, receiptIdFor(receipts.size + 1));
      return Response.json(
        {
          result: attempt > 1 ? "replayed" : "stored",
          receipt: {
            receipt_id: receipts.get(key),
            file_name: file.name,
            content_type: file.type,
            byte_size: file.size,
            purpose: fields.purpose,
            target_id: fields.target_id,
            action: fields.action,
            operation_id: fields.operation_id,
          },
        },
        { status: attempt > 1 ? 200 : 201 },
      );
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const call: SubmitCall = { kind: "submit", key, headers, body };
    log.push(call);
    const planned = behaviour.submit?.(call, attempt);
    if (planned instanceof Error) throw planned;
    if (planned && planned !== "apply-then-lose") return planned;
    const ids = (body.evidence_receipt_ids as string[]) ?? [];
    if (!applied.has(key)) applied.set(key, ids);
    if (planned === "apply-then-lose") throw new TypeError("Failed to fetch");
    if (String(input).endsWith("/evidence")) return correctiveRecord(applied.get(key) ?? []);
    return Response.json({ device_action_id: key, status: "verified" });
  });
  return {
    fetcher,
    log,
    applied,
    uploads: () => log.filter((c): c is UploadCall => c.kind === "upload"),
  };
}

function correctiveRecord(receiptIds: string[]) {
  return Response.json({
    version: 1,
    corrective_action: {
      corrective_action_id: "ca_test",
      occurrence_id: "so_test",
      version: 2,
      state: "evidence_submitted",
      risk_level: "high",
      owner_user_id: "appu_owner",
      description: "Install a tie-off.",
      due_at: "2026-09-01T00:00:00.000Z",
      evidence_refs_json: JSON.stringify(
        [...receiptIds]
          .sort()
          .map((id) => ({ ref: `evidence-upload://${id}`, sha256: "a".repeat(64) })),
      ),
      evidence_sha256: "b".repeat(64),
      evidence_captured_by_user_id: principal.userId,
      evidence_submitted_at: "2026-09-01T00:00:00.000Z",
      verified_by_user_id: null,
      verified_at: null,
      closed_at: null,
    },
  });
}

const flush = (fetcher: typeof fetch, now: number, extra: Record<string, unknown> = {}) =>
  flushOutbox({
    ...principal,
    csrfToken: "csrf-current",
    deviceProof: async () => "device-proof-current",
    fetcher,
    now: () => now,
    random: () => 0,
    ...extra,
  });

beforeEach(() => {
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
});
afterEach(async () => {
  await resetDatabaseForTests();
  vi.restoreAllMocks();
});

describe("evidence saved offline", () => {
  it("keeps the files, their keys and their scope, and nothing a digest could stand in for", async () => {
    const saved = await saveCorrective();
    expect(saved.payload).toEqual({ detail });
    expect(saved.attachments).toEqual([]);
    expect(saved.evidence?.scope).toEqual(correctiveScope);
    expect(saved.evidence?.files.map((file) => file.uploadKey)).toEqual([
      "evidence-key-0000",
      "evidence-key-0001",
    ]);
    expect(saved.evidence?.files.every((file) => file.attachmentId && !file.receiptId)).toBe(true);
    const stored = await getOutboxActionWithBlobs(saved.deviceActionId);
    expect(stored?.blobs).toHaveLength(2);
    // The blob store is keyed by random ids, so match the bytes without assuming an order.
    expect(
      (await Promise.all((stored?.blobs ?? []).map((record) => record.blob.text()))).sort(),
    ).toEqual(["synthetic-bytes-0", "synthetic-bytes-1"]);
    expect(JSON.stringify(stored?.action)).not.toMatch(/csrf|proof|sha256|digest/i);
  });

  it("on reconnect uploads every file first under its own key, then submits with the receipts", async () => {
    const saved = await saveCorrective();
    const worker = fakeWorker();
    const result = await flush(worker.fetcher, 2_000);
    expect(result).toMatchObject({ processed: 1, verified: 1 });

    expect(worker.log.map((call) => call.kind)).toEqual(["upload", "upload", "submit"]);
    const [first, second] = worker.uploads();
    expect(first).toMatchObject({
      key: "evidence-key-0000",
      fields: {
        purpose: "corrective_action",
        target_id: "ca_test",
        action: "submit",
        operation_id: "",
      },
      fileName: "fix-0.jpg",
      fileType: "image/jpeg",
      bytes: "synthetic-bytes-0",
    });
    expect(second).toMatchObject({ key: "evidence-key-0001", bytes: "synthetic-bytes-1" });
    expect(first?.headers.get("X-CSRF-Token")).toBe("csrf-current");
    expect(first?.headers.get("X-IronWrap-Device-Proof")).toBe("device-proof-current");
    // An upload is identified by its own key, never by the action's.
    expect(first?.headers.has("X-Device-Action-Id")).toBe(false);

    const submit = worker.log[2] as SubmitCall;
    expect(submit.body).toEqual({
      detail,
      evidence_receipt_ids: [receiptIdFor(1), receiptIdFor(2)],
    });
    expect(submit.key).toBe(saved.deviceActionId);

    const done = await getOutboxActionWithBlobs(saved.deviceActionId);
    expect(done?.action.state).toBe("verified");
    expect(done?.blobs).toEqual([]);
    expect(JSON.stringify(done?.action)).not.toMatch(/csrf-current|device-proof-current/);
  });

  it("does not make a second effect when the response to the submission is lost", async () => {
    const saved = await saveCorrective();
    const worker = fakeWorker({
      submit: (_call, attempt) => (attempt === 1 ? "apply-then-lose" : undefined),
    });
    // First tap: both files up, the submission applied, the answer lost.
    const lost = await flush(worker.fetcher, 2_000);
    expect(lost).toMatchObject({ processed: 1, requeued: 1 });
    const waiting = await getOutboxAction(saved.deviceActionId);
    expect(waiting).toMatchObject({ state: "queued", lastError: { code: "network_error" } });
    // The files are confirmed, so they are never uploaded again, but their bytes stay on the phone
    // until the Worker has confirmed the action itself.
    expect(waiting?.evidence?.files.map((file) => file.receiptId)).toEqual([
      receiptIdFor(1),
      receiptIdFor(2),
    ]);
    expect((await getOutboxActionWithBlobs(saved.deviceActionId))?.blobs).toHaveLength(2);

    // The retry sends the same submission again, and uploads nothing a second time.
    const retried = await flush(worker.fetcher, 30_000);
    expect(retried).toMatchObject({ processed: 1, verified: 1 });
    expect(worker.uploads()).toHaveLength(2);
    expect(worker.log.filter((call) => call.kind === "submit")).toHaveLength(2);
    expect(worker.applied.size).toBe(1);
    const [a, b] = worker.log.filter((call): call is SubmitCall => call.kind === "submit");
    expect(b?.body).toEqual(a?.body);
    expect(b?.key).toBe(a?.key);
    expect((await getOutboxAction(saved.deviceActionId))?.state).toBe("verified");
    // Confirmed: now, and only now, the bytes go.
    expect((await getOutboxActionWithBlobs(saved.deviceActionId))?.blobs).toEqual([]);
  });

  it("resumes with the file that was not confirmed, under the same key, when an upload response is lost", async () => {
    const saved = await saveCorrective();
    const worker = fakeWorker({
      upload: (call, attempt) =>
        call.key === "evidence-key-0001" && attempt === 1
          ? new TypeError("Failed to fetch")
          : undefined,
    });
    const lost = await flush(worker.fetcher, 2_000);
    expect(lost).toMatchObject({ processed: 1, requeued: 1 });
    const partial = await getOutboxActionWithBlobs(saved.deviceActionId);
    expect(partial?.action.evidence?.files[0]?.receiptId).toBe(receiptIdFor(1));
    expect(partial?.action.evidence?.files[1]?.receiptId).toBeUndefined();
    // Every file's bytes are still held: the confirmed one is not sent again, but nothing is let
    // go before the action itself is confirmed.
    expect(partial?.blobs).toHaveLength(2);
    expect(
      (await Promise.all((partial?.blobs ?? []).map((record) => record.blob.text()))).sort(),
    ).toEqual(["synthetic-bytes-0", "synthetic-bytes-1"]);
    expect(worker.log.some((call) => call.kind === "submit")).toBe(false);

    const resumed = await flush(worker.fetcher, 30_000);
    expect(resumed).toMatchObject({ processed: 1, verified: 1 });
    expect(worker.uploads().map((call) => call.key)).toEqual([
      "evidence-key-0000",
      "evidence-key-0001",
      "evidence-key-0001",
    ]);
    expect(worker.applied.size).toBe(1);
  });

  it("does not hang on an upload answer whose body stalls, and resumes under the same key", async () => {
    const saved = await saveCorrective();
    const worker = fakeWorker();
    const workerFetch = worker.fetcher;
    let stalled = false;
    // The Worker stores the file and sends its headers, then the body never arrives.
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = new Headers(init?.headers).get("Idempotency-Key");
      if (String(input) === "/api/v1/evidence-uploads" && key === "evidence-key-0001" && !stalled) {
        stalled = true;
        await workerFetch(input, init);
        return new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener(
                "abort",
                () => controller.error(new DOMException("aborted", "AbortError")),
                { once: true },
              );
            },
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      return workerFetch(input, init);
    });

    const lost = await flush(fetcher as typeof fetch, 2_000, { evidenceTimeoutMs: 20 });
    expect(lost).toMatchObject({ processed: 1, requeued: 1 });
    const partial = await getOutboxActionWithBlobs(saved.deviceActionId);
    expect(partial?.action.evidence?.files[1]?.receiptId).toBeUndefined();
    expect(partial?.action.lastError?.code).toBe("response_lost");
    expect(worker.log.some((call) => call.kind === "submit")).toBe(false);

    const resumed = await flush(fetcher as typeof fetch, 30_000, { evidenceTimeoutMs: 20 });
    expect(resumed).toMatchObject({ processed: 1, verified: 1 });
    // The same bytes went again under the same key; the Worker answered with the receipt it held.
    expect(worker.uploads().map((call) => call.key)).toEqual([
      "evidence-key-0000",
      "evidence-key-0001",
      "evidence-key-0001",
    ]);
    expect(worker.applied.size).toBe(1);
  });

  it("a duplicate flush shares the one in progress and makes no second upload or submission", async () => {
    await saveCorrective();
    const worker = fakeWorker();
    await Promise.all([flush(worker.fetcher, 2_000), flush(worker.fetcher, 2_000)]);
    expect(worker.uploads()).toHaveLength(2);
    expect(worker.log.filter((call) => call.kind === "submit")).toHaveLength(1);
    expect(worker.applied.size).toBe(1);
  });

  it("waits out a limit for as long as Retry-After says and keeps every file meanwhile", async () => {
    const saved = await saveCorrective();
    const worker = fakeWorker({
      upload: (call, attempt) =>
        call.key === "evidence-key-0000" && attempt === 1
          ? Response.json(
              { error: "evidence_upload_rate_limited" },
              { status: 429, headers: { "Retry-After": "20" } },
            )
          : undefined,
    });
    const limited = await flush(worker.fetcher, 10_000);
    expect(limited).toMatchObject({ processed: 1, requeued: 1 });
    const waiting = await getOutboxAction(saved.deviceActionId);
    expect(waiting).toMatchObject({
      state: "queued",
      nextAttemptAt: 30_000,
      lastError: {
        code: "evidence_upload_rate_limited",
        status: 429,
        message: "Too many uploads right now. This saved item will try again by itself.",
      },
    });
    expect((await getOutboxActionWithBlobs(saved.deviceActionId))?.blobs).toHaveLength(2);
    expect(worker.log.some((call) => call.kind === "submit")).toBe(false);

    expect(await flush(worker.fetcher, 29_999)).toMatchObject({ processed: 0 });
    const resumed = await flush(worker.fetcher, 30_000);
    expect(resumed).toMatchObject({ processed: 1, verified: 1 });
    // The limited file went up again under its own key, then the second one: nothing twice over.
    expect(worker.uploads().map((call) => call.key)).toEqual([
      "evidence-key-0000",
      "evidence-key-0000",
      "evidence-key-0001",
    ]);
    expect(worker.applied.size).toBe(1);
  });

  it("does not let a stalled upload hold the saved item for ever, and says it is slow", async () => {
    const saved = await saveCorrective();
    const stalled = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const result = await flush(stalled as unknown as typeof fetch, 2_000, {
      evidenceTimeoutMs: 20,
    });
    expect(result).toMatchObject({ processed: 1, requeued: 1 });
    expect(await getOutboxAction(saved.deviceActionId)).toMatchObject({
      state: "queued",
      lastError: {
        code: "upload_timeout",
        message: "The upload is slow. The saved item will try again by itself.",
      },
    });
    // Nothing was lost: both files are still held, ready for the next try under the same keys.
    expect((await getOutboxActionWithBlobs(saved.deviceActionId))?.blobs).toHaveLength(2);
    expect(stalled).toHaveBeenCalledTimes(1);
  });

  it("stops sending a file that keeps timing out, and lets the person try again from a better signal", async () => {
    const saved = await saveCorrective();
    const stalled = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const slow = { evidenceTimeoutMs: 10 };
    expect(await flush(stalled as unknown as typeof fetch, 2_000, slow)).toMatchObject({
      requeued: 1,
    });
    expect(await flush(stalled as unknown as typeof fetch, 60_000, slow)).toMatchObject({
      requeued: 1,
    });
    // The third timeout in a row is not queued for a fourth 8 MB send: it waits for the person.
    expect(await flush(stalled as unknown as typeof fetch, 600_000, slow)).toMatchObject({
      needsAttention: 1,
    });
    const stopped = await getOutboxAction(saved.deviceActionId);
    expect(stopped).toMatchObject({
      state: "needs_attention",
      lastError: { code: "upload_too_slow", status: 408 },
    });
    expect(outboxFailureGuidance(stopped!)).toEqual({
      reason: "A file is taking too long to upload on this connection.",
      nextStep: "Move to a place with better signal, then try again. Nothing was lost.",
      retryable: true,
      notSent: false,
      officeConfirmed: false,
    });
    expect(isOutboxActionSafeToRetry(stopped!)).toBe(true);
    expect((await getOutboxActionWithBlobs(saved.deviceActionId))?.blobs).toHaveLength(2);
    expect(stalled).toHaveBeenCalledTimes(3);
  });

  it("stops at once, with a sign-in step, when access changed after sign-in", async () => {
    const saved = await saveCorrective();
    const worker = fakeWorker({
      upload: () => Response.json({ error: "evidence_actor_role_changed" }, { status: 403 }),
    });
    const result = await flush(worker.fetcher, 2_000);
    expect(result).toMatchObject({ processed: 1, needsAttention: 1 });
    const stopped = await getOutboxAction(saved.deviceActionId);
    expect(stopped).toMatchObject({
      state: "needs_attention",
      lastError: {
        code: "evidence_actor_role_changed",
        status: 403,
        message: "Your access changed. Sign in again to attach files.",
      },
    });
    expect(isOutboxActionSafeToRetry(stopped!)).toBe(false);
    expect(outboxFailureGuidance(stopped!)).toMatchObject({
      nextStep: "Sign in again, then open the action and add the files again.",
      retryable: false,
      notSent: true,
      officeConfirmed: false,
    });
    // Nothing is thrown away, and nothing was submitted.
    expect((await getOutboxActionWithBlobs(saved.deviceActionId))?.blobs).toHaveLength(2);
    expect(worker.log.some((call) => call.kind === "submit")).toBe(false);
  });

  it("says the same in plain words when the submission itself is refused for it", async () => {
    const saved = await saveCorrective();
    const worker = fakeWorker({
      submit: () => Response.json({ error: "evidence_actor_role_changed" }, { status: 403 }),
    });
    expect(await flush(worker.fetcher, 2_000)).toMatchObject({ needsAttention: 1 });
    expect((await getOutboxAction(saved.deviceActionId))?.lastError).toMatchObject({
      code: "evidence_actor_role_changed",
      message: "Your access changed. Sign in again to attach files.",
    });
  });

  it("keeps a refused file instead of dropping it, and does not call it a changed office copy", async () => {
    const saved = await saveCorrective();
    const worker = fakeWorker({
      upload: () => Response.json({ error: "evidence_upload_conflict" }, { status: 409 }),
    });
    expect(await flush(worker.fetcher, 2_000)).toMatchObject({ needsAttention: 1 });
    const stopped = await getOutboxAction(saved.deviceActionId);
    expect(stopped?.conflict).toBeUndefined();
    expect(stopped?.lastError?.message).toBe(
      "This file was already used for something else. Remove it and add it again.",
    );
    expect((await getOutboxActionWithBlobs(saved.deviceActionId))?.blobs).toHaveLength(2);
  });

  it("sends an item saved by an older version exactly as it was saved, and reads it back as before", async () => {
    const legacy = {
      detail,
      evidence_sha256: "b".repeat(64),
      evidence_refs_json: JSON.stringify([{ ref: "r2://x/y.pdf", sha256: "a".repeat(64) }]),
    };
    await (
      await getDatabase()
    ).put("outbox_actions", {
      deviceActionId: "legacy-evidence",
      ...principal,
      kind: "safety_corrective_evidence",
      endpoint,
      method: "POST",
      payload: legacy,
      attachments: [],
      state: "queued",
      attempts: 0,
      nextAttemptAt: 1_000,
      createdAt: 1_000,
      updatedAt: 1_000,
      version: 2,
    });
    const sent: unknown[] = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      const record = (await correctiveRecord([]).json()) as {
        corrective_action: Record<string, unknown>;
      };
      return Response.json({
        ...record,
        corrective_action: {
          ...record.corrective_action,
          evidence_refs_json: legacy.evidence_refs_json,
          evidence_sha256: legacy.evidence_sha256,
        },
      });
    });
    expect(await flush(fetcher as unknown as typeof fetch, 2_000)).toMatchObject({ verified: 1 });
    // No upload, and no receipt ids beside the typed reference it already carries.
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([legacy]);
    expect((await getOutboxAction("legacy-evidence"))?.state).toBe("verified");
  });

  it("does not clear an older item the Worker's read-back does not confirm", async () => {
    await (
      await getDatabase()
    ).put("outbox_actions", {
      deviceActionId: "legacy-evidence",
      ...principal,
      kind: "safety_corrective_evidence",
      endpoint,
      method: "POST",
      payload: {
        detail,
        evidence_sha256: "b".repeat(64),
        evidence_refs_json: JSON.stringify([{ ref: "r2://x/y.pdf", sha256: "a".repeat(64) }]),
      },
      attachments: [],
      state: "queued",
      attempts: 0,
      nextAttemptAt: 1_000,
      createdAt: 1_000,
      updatedAt: 1_000,
      version: 2,
    });
    // The record lists other evidence than the one this item sent.
    const worker = fakeWorker();
    expect(await flush(worker.fetcher, 2_000)).toMatchObject({ needsAttention: 1 });
    expect((await getOutboxAction("legacy-evidence"))?.lastError).toMatchObject({
      code: "verification_mismatch",
    });
  });

  it("sends a stock action saved by an older version unchanged, with no upload", async () => {
    const payload = {
      command_id: "inventory:command:legacy",
      idempotency_key: "inventory:action:legacy",
      transition: "issue_use",
      evidence_refs: [{ ref: "r2://inventory-evidence/t/o", sha256: "a".repeat(64) }],
    };
    await (
      await getDatabase()
    ).put("outbox_actions", {
      deviceActionId: "inventory:action:legacy",
      ...principal,
      kind: "inventory_command",
      endpoint: "/api/v1/inventory/commands",
      method: "POST",
      payload,
      attachments: [],
      state: "queued",
      attempts: 0,
      nextAttemptAt: 1_000,
      createdAt: 1_000,
      updatedAt: 1_000,
      version: 2,
    });
    const worker = fakeWorker();
    expect(await flush(worker.fetcher, 2_000)).toMatchObject({ verified: 1 });
    expect(worker.log.map((call) => call.kind)).toEqual(["submit"]);
    expect((worker.log[0] as SubmitCall).body).toEqual(payload);
    // The command id is what makes a repeat of it safe, so it travels as saved.
    expect((worker.log[0] as SubmitCall).key).toBe("inventory:action:legacy");
  });

  it("keeps an older item and says what to do when the Worker now wants real files", async () => {
    await (
      await getDatabase()
    ).put("outbox_actions", {
      deviceActionId: "inventory:action:legacy",
      ...principal,
      kind: "inventory_command",
      endpoint: "/api/v1/inventory/commands",
      method: "POST",
      payload: {
        command_id: "inventory:command:legacy",
        transition: "issue_use",
        evidence_refs: [{ ref: "r2://inventory-evidence/t/o", sha256: "a".repeat(64) }],
      },
      attachments: [],
      state: "queued",
      attempts: 0,
      nextAttemptAt: 1_000,
      createdAt: 1_000,
      updatedAt: 1_000,
      version: 2,
    });
    const worker = fakeWorker({
      submit: () => Response.json({ error: "evidence_receipts_required" }, { status: 400 }),
    });
    expect(await flush(worker.fetcher, 2_000)).toMatchObject({ needsAttention: 1 });
    const stopped = await getOutboxAction("inventory:action:legacy");
    expect(stopped?.state).toBe("needs_attention");
    expect(outboxFailureGuidance(stopped!)).toEqual({
      reason: "This step needs a photo or PDF.",
      nextStep:
        "Nothing was recorded. Record the action again on the stock desk and add the files again.",
      retryable: false,
      notSent: true,
      officeConfirmed: false,
    });
  });

  it("keeps every file on the phone when the Worker refuses the submission after the files went up", async () => {
    const saved = await saveCorrective();
    const worker = fakeWorker({
      submit: () => Response.json({ error: "evidence_actor_role_changed" }, { status: 403 }),
    });
    expect(await flush(worker.fetcher, 2_000)).toMatchObject({ needsAttention: 1 });
    expect(worker.uploads()).toHaveLength(2);
    const kept = await getOutboxActionWithBlobs(saved.deviceActionId);
    expect(kept?.action.state).toBe("needs_attention");
    expect(kept?.action.evidence?.files.map((file) => file.receiptId)).toEqual([
      receiptIdFor(1),
      receiptIdFor(2),
    ]);
    // The files are still on the phone, so "your files stay on this phone" is true.
    expect(
      (await Promise.all((kept?.blobs ?? []).map((record) => record.blob.text()))).sort(),
    ).toEqual(["synthetic-bytes-0", "synthetic-bytes-1"]);
  });

  it("does not call an unconfirmed file a changed office copy when the submission answers 409", async () => {
    const saved = await saveCorrective();
    const worker = fakeWorker({
      submit: () => Response.json({ error: "evidence_object_missing" }, { status: 409 }),
    });
    expect(await flush(worker.fetcher, 2_000)).toMatchObject({ needsAttention: 1 });
    const stopped = await getOutboxAction(saved.deviceActionId);
    expect(stopped?.conflict).toBeUndefined();
    expect(outboxFailureGuidance(stopped!)).toEqual({
      reason: "We couldn't confirm that a file was saved.",
      nextStep: "Nothing was submitted. Open the action and add the files again.",
      retryable: false,
      notSent: true,
      officeConfirmed: false,
    });
  });
});

describe("stock actions saved offline", () => {
  const stockScope: EvidenceScope = {
    purpose: "stock",
    targetId: "lot-1",
    action: "issue_use",
    operationId: "inventory:command:0001",
  };
  const stockPayload = {
    command_id: "inventory:command:0001",
    idempotency_key: "inventory:action:0001",
    transition: "issue_use",
    authority_ref: "authority-readback-1",
    policy_ref: "policy:inventory-command",
    policy_version: "1",
    lot_id: "lot-1",
    quantity_scaled: 5,
  };

  it("uploads the files for the exact stock action first, then sends the intent with the receipts", async () => {
    const saved = await saveOutboxAction({
      ...principal,
      deviceActionId: "inventory:action:0001",
      kind: "inventory_command",
      endpoint: "/api/v1/inventory/commands",
      payload: stockPayload,
      evidence: { scope: stockScope, files: filesWithBytes(1) },
    });
    await queueOutboxAction(saved.deviceActionId, 1_000);
    const worker = fakeWorker();
    expect(await flush(worker.fetcher, 2_000)).toMatchObject({ verified: 1 });
    expect(worker.log.map((call) => call.kind)).toEqual(["upload", "submit"]);
    expect(worker.uploads()[0]?.fields).toEqual({
      purpose: "stock",
      target_id: "lot-1",
      action: "issue_use",
      operation_id: "inventory:command:0001",
    });
    const submit = worker.log[1] as SubmitCall;
    expect(submit.body).toEqual({ ...stockPayload, evidence_receipt_ids: [receiptIdFor(1)] });
    expect(submit.body).not.toHaveProperty("evidence_refs");
    expect(submit.body).not.toHaveProperty("request_fingerprint_sha256");
    expect(submit.key).toBe("inventory:action:0001");
  });
});

describe("what the outbox will accept to save", () => {
  const save = (overrides: Record<string, unknown>) =>
    saveOutboxAction({
      ...principal,
      kind: "safety_corrective_evidence",
      endpoint,
      payload: { detail },
      evidence: { scope: correctiveScope, files: filesWithBytes(1) },
      ...overrides,
    } as never);

  it("needs evidence files for an action that carries them, and only for those", async () => {
    await expect(save({ evidence: undefined })).rejects.toThrow("needs its evidence files");
    await expect(
      saveOutboxAction({
        ...principal,
        kind: "inventory_scan",
        endpoint: "/api/v1/inventory/scans",
        payload: {},
        evidence: { scope: { ...correctiveScope, purpose: "stock" }, files: filesWithBytes(1) },
      }),
    ).rejects.toThrow("cannot carry evidence files");
  });

  it("refuses files scoped to another action", async () => {
    await expect(
      save({
        evidence: { scope: { ...correctiveScope, targetId: "ca_other" }, files: filesWithBytes(1) },
      }),
    ).rejects.toThrow("do not belong to this corrective action");
    await expect(
      save({
        evidence: { scope: { ...correctiveScope, action: "close" }, files: filesWithBytes(1) },
      }),
    ).rejects.toThrow("do not belong to this corrective action");
    const stock = (scope: Partial<EvidenceScope>) =>
      saveOutboxAction({
        ...principal,
        kind: "inventory_command",
        endpoint: "/api/v1/inventory/commands",
        payload: { command_id: "inventory:command:0001", transition: "issue_use" },
        evidence: {
          scope: {
            purpose: "stock",
            targetId: "lot-1",
            action: "issue_use",
            operationId: "inventory:command:0001",
            ...scope,
          },
          files: filesWithBytes(1),
        },
      });
    await expect(stock({ operationId: "inventory:command:other" })).rejects.toThrow(
      "do not belong to this stock action",
    );
    await expect(stock({ action: "receive" })).rejects.toThrow(
      "do not belong to this stock action",
    );
    await expect(stock({ purpose: "corrective_action" })).rejects.toThrow(
      "missing what they belong to",
    );
  });

  it("keeps a typed reference a desk still sends in place of files, never beside them", async () => {
    const typed = {
      detail,
      evidence_sha256: "b".repeat(64),
      evidence_refs_json: JSON.stringify([{ ref: "r2://x/y.pdf", sha256: "a".repeat(64) }]),
    };
    await expect(save({ payload: typed, evidence: undefined })).resolves.toMatchObject({
      state: "saved_locally",
    });
    await expect(save({ payload: typed })).rejects.toThrow("carries its files separately");
    // Half a reference is not a reference.
    await expect(
      save({ payload: { detail, evidence_sha256: "b".repeat(64) }, evidence: undefined }),
    ).rejects.toThrow();
    await expect(
      saveOutboxAction({
        ...principal,
        kind: "inventory_command",
        endpoint: "/api/v1/inventory/commands",
        payload: {
          command_id: "inventory:command:0002",
          transition: "issue_use",
          evidence_refs: [{ ref: "r2://inventory-evidence/t/o", sha256: "a".repeat(64) }],
        },
      }),
    ).resolves.toMatchObject({ state: "saved_locally" });
  });

  it("refuses a stock request that already carries a typed reference or a receipt", async () => {
    for (const extra of [{ evidence_refs: [] }, { evidence_receipt_ids: ["x"] }] as Array<
      Record<string, JsonValue>
    >) {
      await expect(
        saveOutboxAction({
          ...principal,
          kind: "inventory_command",
          endpoint: "/api/v1/inventory/commands",
          payload: { command_id: "inventory:command:0001", transition: "issue_use", ...extra },
          evidence: {
            scope: {
              purpose: "stock",
              targetId: "lot-1",
              action: "issue_use",
              operationId: "inventory:command:0001",
            },
            files: filesWithBytes(1),
          },
        }),
      ).rejects.toThrow("carries its files separately");
    }
  });

  it("holds between one and four valid, distinct files", async () => {
    await expect(save({ evidence: { scope: correctiveScope, files: [] } })).rejects.toThrow(
      "between 1 and 4",
    );
    await expect(
      save({ evidence: { scope: correctiveScope, files: filesWithBytes(5) } }),
    ).rejects.toThrow("between 1 and 4");
    const [file] = filesWithBytes(1);
    const bad = (override: Record<string, unknown>) =>
      save({ evidence: { scope: correctiveScope, files: [{ ...file, ...override }] } });
    await expect(bad({ uploadKey: "short" })).rejects.toThrow("not valid");
    await expect(bad({ fileName: "a/b.jpg" })).rejects.toThrow("not valid");
    await expect(bad({ mimeType: "image/gif" })).rejects.toThrow("not valid");
    await expect(bad({ size: 0 })).rejects.toThrow("not valid");
    await expect(bad({ size: 9 * 1024 * 1024 })).rejects.toThrow("not valid");
    await expect(bad({ blob: undefined })).rejects.toThrow("not valid");
    // A confirmed file keeps its bytes too, until the action is confirmed.
    await expect(bad({ receiptId: receiptIdFor(1) })).resolves.toMatchObject({
      evidence: { files: [{ receiptId: receiptIdFor(1), attachmentId: expect.any(String) }] },
    });
    await expect(bad({ receiptId: "evu_nope" })).rejects.toThrow("not valid");
    await expect(bad({ blob: undefined, receiptId: receiptIdFor(1) })).rejects.toThrow("not valid");
    await expect(
      bad({ blob: new Blob(["different length"], { type: "image/jpeg" }) }),
    ).rejects.toThrow("changed while it was being saved");
    await expect(
      save({
        evidence: {
          scope: correctiveScope,
          files: [file, { ...filesWithBytes(2)[1], uploadKey: file?.uploadKey }],
        },
      }),
    ).rejects.toThrow("not valid");
  });
});

describe("recordOutboxEvidenceReceipt", () => {
  it("only records for the holder of the upload lease, and keeps the bytes", async () => {
    const saved = await saveCorrective();
    const claimed = await claimNextQueuedAction(principal, 2_000);
    expect(claimed?.uploadLeaseId).toBeTruthy();

    expect(
      await recordOutboxEvidenceReceipt(
        saved.deviceActionId,
        "evidence-key-0000",
        receiptIdFor(1),
        2_000,
        "someone-else",
      ),
    ).toBeUndefined();
    expect((await getOutboxActionWithBlobs(saved.deviceActionId))?.blobs).toHaveLength(2);

    const recorded = await recordOutboxEvidenceReceipt(
      saved.deviceActionId,
      "evidence-key-0000",
      receiptIdFor(1),
      2_000,
      claimed?.uploadLeaseId,
    );
    expect(recorded?.evidence?.files[0]).toMatchObject({ receiptId: receiptIdFor(1) });
    // Confirmed is not the same as accepted: the bytes stay until the action itself is confirmed.
    expect(recorded?.evidence?.files[0]?.attachmentId).toBeTruthy();
    expect((await getOutboxActionWithBlobs(saved.deviceActionId))?.blobs).toHaveLength(2);

    // Recording the same file again changes nothing.
    const again = await recordOutboxEvidenceReceipt(
      saved.deviceActionId,
      "evidence-key-0000",
      receiptIdFor(7),
      2_500,
      claimed?.uploadLeaseId,
    );
    expect(again?.evidence?.files[0]?.receiptId).toBe(receiptIdFor(1));
  });
});
