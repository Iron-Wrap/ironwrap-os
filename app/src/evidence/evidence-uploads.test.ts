import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sessionFor } from "../admin/admin-test-harness";
import { ApiError } from "../lib/api";
import type { PreparedEvidenceFile } from "./evidence-file";
import { receiptIdFor, scopeFor } from "./evidence-test-harness";
import { evidenceScopeKey } from "./evidence-types";
import type { EvidenceRetryOptions, EvidenceUploadRequest } from "./evidence-upload";
import {
  EvidenceUploads,
  evidenceReady,
  evidenceReceiptIds,
  freezeEvidence,
  type EvidenceContext,
} from "./evidence-uploads";

const session = sessionFor("owner");

function prepared(name: string): PreparedEvidenceFile {
  const bytes = new Uint8Array([255, 216, 255, name.length]);
  return {
    name,
    size: bytes.length,
    mime: "image/jpeg",
    blob: new Blob([bytes], { type: "image/jpeg" }),
  };
}

/** An upload the test settles by hand, so ordering and timing are the test's to decide. */
function controlledUploads() {
  const pending: Array<{
    request: EvidenceUploadRequest;
    options: EvidenceRetryOptions;
    resolve: (receiptId: string) => void;
    reject: (error: unknown) => void;
  }> = [];
  const upload = (request: EvidenceUploadRequest, options: EvidenceRetryOptions) =>
    new Promise<{ receiptId: string; replayed: boolean }>((resolve, reject) => {
      request.signal?.addEventListener("abort", () =>
        reject(new ApiError({ status: 0, code: "aborted", message: "cancelled" })),
      );
      pending.push({
        request,
        options,
        resolve: (receiptId) => resolve({ receiptId, replayed: false }),
        reject,
      });
    });
  return { pending, upload };
}

const online = (overrides: Partial<EvidenceContext> = {}): EvidenceContext => ({
  session,
  scope: scopeFor(),
  online: true,
  ...overrides,
});

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("EvidenceUploads", () => {
  it("sends one file at a time, in the order chosen, each under its own key", async () => {
    const { pending, upload } = controlledUploads();
    const uploads = new EvidenceUploads({ upload });
    uploads.setContext(online());
    uploads.add([prepared("a.jpg"), prepared("b.jpg")]);
    await flush();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.request.file.name).toBe("a.jpg");
    expect(uploads.getSnapshot().items.map((item) => item.status)).toEqual(["uploading", "held"]);

    pending[0]?.resolve(receiptIdFor(1));
    await flush();
    expect(pending).toHaveLength(2);
    expect(pending[1]?.request.file.name).toBe("b.jpg");
    pending[1]?.resolve(receiptIdFor(2));
    await flush();

    const items = uploads.getSnapshot().items;
    expect(items.map((item) => item.status)).toEqual(["uploaded", "uploaded"]);
    expect(evidenceReceiptIds(items)).toEqual([receiptIdFor(1), receiptIdFor(2)]);
    expect(new Set(items.map((item) => item.key)).size).toBe(2);
    for (const item of items) expect(item.key).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,119}$/);
  });

  it("holds files while offline and sends them when signal returns", async () => {
    const { pending, upload } = controlledUploads();
    const uploads = new EvidenceUploads({ upload });
    uploads.setContext(online({ online: false }));
    uploads.add([prepared("a.jpg")]);
    await flush();
    expect(pending).toHaveLength(0);
    expect(uploads.getSnapshot().items[0]?.status).toBe("held");

    uploads.setContext(online());
    await flush();
    expect(pending).toHaveLength(1);
  });

  it("does not send until the scope is complete", async () => {
    const { pending, upload } = controlledUploads();
    const uploads = new EvidenceUploads({ upload });
    uploads.setContext(online({ scope: null }));
    uploads.add([prepared("a.jpg")]);
    await flush();
    expect(pending).toHaveLength(0);
    uploads.setContext(online({ scope: scopeFor({ targetId: "not valid!" }) }));
    await flush();
    expect(pending).toHaveLength(0);
    uploads.setContext(online());
    await flush();
    // A scope that has only just become valid may still be mid-edit, so the upload waits a moment.
    expect(pending).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(600);
    expect(pending).toHaveLength(1);
  });

  it("keeps the same key when a failed file is tried again", async () => {
    const { pending, upload } = controlledUploads();
    const uploads = new EvidenceUploads({ upload });
    uploads.setContext(online());
    uploads.add([prepared("a.jpg")]);
    await flush();
    const firstKey = pending[0]?.request.key;
    pending[0]?.reject(
      new ApiError({ status: 502, code: "evidence_store_unavailable", message: "x" }),
    );
    await flush();
    const failed = uploads.getSnapshot().items[0];
    expect(failed).toMatchObject({
      status: "failed",
      problem: { next: "retry", code: "evidence_store_unavailable" },
    });

    uploads.retry(failed?.id ?? "");
    await flush();
    expect(pending).toHaveLength(2);
    expect(pending[1]?.request.key).toBe(firstKey);
    pending[1]?.resolve(receiptIdFor(9));
    await flush();
    expect(uploads.getSnapshot().items[0]).toMatchObject({ status: "uploaded", key: firstKey });
  });

  it("will not retry a conflict with the same key; removing and choosing again gets a new one", async () => {
    const { pending, upload } = controlledUploads();
    const uploads = new EvidenceUploads({ upload });
    uploads.setContext(online());
    uploads.add([prepared("a.jpg")]);
    await flush();
    const key = pending[0]?.request.key;
    pending[0]?.reject(
      new ApiError({ status: 409, code: "evidence_upload_conflict", message: "x" }),
    );
    await flush();
    const failed = uploads.getSnapshot().items[0];
    expect(failed?.problem?.next).toBe("readd");

    uploads.retry(failed?.id ?? "");
    await flush();
    expect(pending).toHaveLength(1);

    uploads.remove(failed?.id ?? "");
    uploads.add([prepared("a.jpg")]);
    await flush();
    expect(pending).toHaveLength(2);
    expect(pending[1]?.request.key).not.toBe(key);
  });

  it("shows a wait while the upload waits out a limit, then goes on", async () => {
    const { pending, upload } = controlledUploads();
    const uploads = new EvidenceUploads({ upload });
    uploads.setContext(online());
    uploads.add([prepared("a.jpg")]);
    await flush();
    pending[0]?.options.onWait?.({ reason: "rate_limit", until: 20_000, ms: 20_000 });
    expect(uploads.getSnapshot().items[0]).toMatchObject({
      status: "waiting",
      wait: { reason: "rate_limit", until: 20_000, ms: 20_000 },
    });
    pending[0]?.options.onWait?.(null);
    expect(uploads.getSnapshot().items[0]?.status).toBe("uploading");
    pending[0]?.resolve(receiptIdFor(1));
    await flush();
    expect(uploads.getSnapshot().items[0]?.status).toBe("uploaded");
  });

  it("starts over with new keys once a changed scope holds still", async () => {
    const { pending, upload } = controlledUploads();
    const uploads = new EvidenceUploads({ upload, settleMs: 600 });
    uploads.setContext(
      online({
        scope: scopeFor({
          purpose: "service_intake",
          targetId: "JOB-1",
          action: "open",
          operationId: "intake-key-0001",
        }),
      }),
    );
    uploads.add([prepared("a.jpg")]);
    await flush();
    const firstKey = pending[0]?.request.key;
    pending[0]?.resolve(receiptIdFor(1));
    await flush();
    expect(evidenceReceiptIds(uploads.getSnapshot().items)).toEqual([receiptIdFor(1)]);

    // The job ID is edited: the old receipt no longer fits and must not be offered for submit.
    uploads.setContext(
      online({
        scope: scopeFor({
          purpose: "service_intake",
          targetId: "JOB-12",
          action: "open",
          operationId: "intake-key-0001",
        }),
      }),
    );
    expect(evidenceReceiptIds(uploads.getSnapshot().items)).toEqual([]);
    expect(uploads.getSnapshot().items[0]?.status).toBe("held");
    await vi.advanceTimersByTimeAsync(300);
    expect(pending).toHaveLength(1);

    // More typing keeps pushing the new upload back.
    uploads.setContext(
      online({
        scope: scopeFor({
          purpose: "service_intake",
          targetId: "JOB-123",
          action: "open",
          operationId: "intake-key-0001",
        }),
      }),
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(pending).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(pending).toHaveLength(2);
    expect(pending[1]?.request.scope.targetId).toBe("JOB-123");
    expect(pending[1]?.request.key).not.toBe(firstKey);
  });

  it("stops an upload in flight when its file is removed", async () => {
    const { pending, upload } = controlledUploads();
    const uploads = new EvidenceUploads({ upload });
    uploads.setContext(online());
    uploads.add([prepared("a.jpg")]);
    await flush();
    uploads.remove(uploads.getSnapshot().items[0]?.id ?? "");
    await flush();
    expect(pending[0]?.request.signal?.aborted).toBe(true);
    expect(uploads.getSnapshot().items).toEqual([]);
  });

  it("puts an upload back to waiting when signal is lost, and resumes with the same key", async () => {
    const { pending, upload } = controlledUploads();
    const uploads = new EvidenceUploads({ upload });
    uploads.setContext(online());
    uploads.add([prepared("a.jpg")]);
    await flush();
    const key = pending[0]?.request.key;
    uploads.setContext(online({ online: false }));
    await flush();
    expect(uploads.getSnapshot().items[0]?.status).toBe("held");
    uploads.setContext(online());
    await flush();
    expect(pending).toHaveLength(2);
    expect(pending[1]?.request.key).toBe(key);
  });

  it("takes at most four files and reports the rest as left out", () => {
    const uploads = new EvidenceUploads({ upload: controlledUploads().upload });
    const result = uploads.add(["a", "b", "c", "d", "e"].map((name) => prepared(`${name}.jpg`)));
    expect(result).toEqual({ added: 4, skipped: 1 });
    expect(uploads.add([prepared("f.jpg")])).toEqual({ added: 0, skipped: 1 });
    expect(uploads.getSnapshot().items).toHaveLength(4);
  });

  it("reports a plain problem and never an upload code to show", async () => {
    const { pending, upload } = controlledUploads();
    const uploads = new EvidenceUploads({ upload });
    uploads.setContext(online());
    uploads.add([prepared("a.jpg")]);
    await flush();
    pending[0]?.reject(
      new ApiError({ status: 403, code: "evidence_actor_role_changed", message: "x" }),
    );
    await flush();
    expect(uploads.getSnapshot().items[0]?.problem).toMatchObject({
      message: "Your access changed. Sign in again to attach files.",
      next: "signin",
    });
    // A sign-in problem is not a retry.
    uploads.retry(uploads.getSnapshot().items[0]?.id ?? "");
    await flush();
    expect(pending).toHaveLength(1);
  });

  it("clears everything on reset", async () => {
    const { pending, upload } = controlledUploads();
    const uploads = new EvidenceUploads({ upload });
    uploads.setContext(online());
    uploads.add([prepared("a.jpg")]);
    await flush();
    uploads.reset();
    expect(pending[0]?.request.signal?.aborted).toBe(true);
    expect(uploads.getSnapshot().items).toEqual([]);
  });

  it("stops for good when the form goes away: nothing restarts, nothing new is taken", async () => {
    const { pending, upload } = controlledUploads();
    const uploads = new EvidenceUploads({ upload });
    uploads.setContext(online());
    uploads.add([prepared("a.jpg"), prepared("b.jpg"), prepared("c.jpg")]);
    await flush();
    expect(pending).toHaveLength(1);

    uploads.dispose();
    expect(pending[0]?.request.signal?.aborted).toBe(true);
    // The aborted upload settles and the queue would normally move to the next file. Nobody is
    // looking at this form any more, so no file may start, however long it is left.
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pending).toHaveLength(1);
    expect(uploads.getSnapshot().items.map((item) => item.status)).toEqual([
      "held",
      "held",
      "held",
    ]);

    // Files that finished being read after the form was left are not taken either.
    expect(uploads.add([prepared("d.jpg")])).toEqual({ added: 0, skipped: 0 });
    uploads.setContext(online({ online: false }));
    uploads.setContext(online());
    await flush();
    // ...but a form that mounts again (React's development double mount) gets its store back.
    expect(pending).toHaveLength(2);
    expect(pending[1]?.request.file.name).toBe("a.jpg");
  });

  it("says which scope its files are keyed to, so a form never pairs them with another one", async () => {
    const { upload } = controlledUploads();
    const uploads = new EvidenceUploads({ upload });
    expect(uploads.getSnapshot().scopeKey).toBe("");
    uploads.setContext(online());
    expect(uploads.getSnapshot().scopeKey).toBe(evidenceScopeKey(scopeFor()));
    uploads.setContext(online({ scope: scopeFor({ targetId: "not valid!" }) }));
    expect(uploads.getSnapshot().scopeKey).toBe("");
    uploads.setContext(online({ scope: scopeFor({ operationId: "command-0002" }) }));
    expect(uploads.getSnapshot().scopeKey).toBe(
      evidenceScopeKey(scopeFor({ operationId: "command-0002" })),
    );
  });
});

describe("evidenceReady", () => {
  const item = (status: "held" | "uploaded" | "failed" | "uploading") =>
    ({
      id: status,
      name: "a",
      size: 1,
      mime: "image/jpeg",
      blob: new Blob(),
      key: "k",
      status,
    }) as const;

  it("needs every file uploaded when online", () => {
    expect(evidenceReady([item("uploaded")], { min: 1, queue: false })).toBe(true);
    expect(evidenceReady([item("uploaded"), item("uploading")], { min: 1, queue: false })).toBe(
      false,
    );
    expect(evidenceReady([item("uploaded"), item("failed")], { min: 1, queue: false })).toBe(false);
    expect(evidenceReady([item("held")], { min: 1, queue: false })).toBe(false);
  });

  it("needs the minimum number of files", () => {
    expect(evidenceReady([], { min: 1, queue: false })).toBe(false);
    expect(evidenceReady([], { min: 0, queue: false })).toBe(true);
  });

  it("lets a form that can save offline keep files that are only waiting for signal", () => {
    expect(evidenceReady([item("held")], { min: 1, queue: true })).toBe(true);
    expect(evidenceReady([item("failed")], { min: 1, queue: true })).toBe(false);
  });
});

describe("freezeEvidence", () => {
  it("keeps every file's bytes, and the receipt of the files that are confirmed", async () => {
    const { pending, upload } = controlledUploads();
    vi.useFakeTimers();
    const uploads = new EvidenceUploads({ upload });
    uploads.setContext(online());
    uploads.add([prepared("a.jpg"), prepared("b.jpg")]);
    await flush();
    pending[0]?.resolve(receiptIdFor(1));
    await flush();
    const frozen = freezeEvidence(scopeFor(), uploads.getSnapshot().items);
    expect(frozen.scope).toEqual(scopeFor());
    expect(frozen.files).toHaveLength(2);
    expect(frozen.files[0]).toMatchObject({ fileName: "a.jpg", receiptId: receiptIdFor(1) });
    expect(frozen.files[1]).toMatchObject({ fileName: "b.jpg" });
    expect(frozen.files[1]?.receiptId).toBeUndefined();
    // A saved action keeps its files until the Worker confirms it, so a refusal loses nothing.
    expect(frozen.files[0]?.blob).toBeInstanceOf(Blob);
    expect(frozen.files[1]?.blob).toBeInstanceOf(Blob);
  });
});
