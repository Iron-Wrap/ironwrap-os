import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sessionFor } from "../admin/admin-test-harness";
import { storeDeviceSecret } from "../auth/device-credential";
import { ApiError } from "../lib/api";
import { resetDatabaseForTests } from "../storage/db";
import {
  EVIDENCE_DEFAULT_WAIT_MS,
  EVIDENCE_MAX_ATTEMPTS,
  EVIDENCE_MAX_RATE_LIMIT_WAITS,
  evidenceTransferTimeoutMs,
  uploadEvidenceFile,
  uploadEvidenceWithRetry,
  type EvidenceUploadRequest,
  type EvidenceWait,
} from "./evidence-upload";
import {
  errorReply,
  evidenceFile,
  receiptIdFor,
  scopeFor,
  storedReply,
  stubEvidenceUploads,
} from "./evidence-test-harness";

const DEVICE_PROOF = "p".repeat(43);

async function requestFor(overrides: Partial<EvidenceUploadRequest> = {}) {
  const file = evidenceFile("south-eave.jpg", "image/jpeg");
  return {
    session: sessionFor("owner"),
    scope: scopeFor(),
    key: "evidence-key-0001",
    file: { name: file.name, blob: new Blob([await file.arrayBuffer()], { type: "image/jpeg" }) },
    ...overrides,
  } satisfies EvidenceUploadRequest;
}

beforeEach(async () => {
  await resetDatabaseForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("uploadEvidenceFile", () => {
  it("sends exactly the five fields, the upload key, CSRF and no hand-set content type", async () => {
    const { calls } = stubEvidenceUploads();
    const result = await uploadEvidenceFile(await requestFor());
    expect(result).toEqual({ receiptId: receiptIdFor(1), replayed: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      key: "evidence-key-0001",
      csrf: "csrf",
      deviceProof: null,
      // The browser writes the multipart boundary; setting the type by hand would break it.
      hasContentType: false,
      fields: {
        purpose: "corrective_action",
        target_id: "ca_fix",
        action: "submit",
        operation_id: "",
      },
      fileName: "south-eave.jpg",
      fileType: "image/jpeg",
    });
    expect(Object.keys(calls[0]?.fields ?? {}).sort()).toEqual([
      "action",
      "operation_id",
      "purpose",
      "target_id",
    ]);
  });

  it("adds the device proof for a field session and none for an office one", async () => {
    await storeDeviceSecret(DEVICE_PROOF);
    const { calls } = stubEvidenceUploads();
    await uploadEvidenceFile(await requestFor({ session: sessionFor("field") }));
    await uploadEvidenceFile(
      await requestFor({ session: sessionFor("ops"), key: "evidence-key-0002" }),
    );
    expect(calls.map((call) => call.deviceProof)).toEqual([DEVICE_PROOF, null]);
  });

  it("reads an exact replay as the same receipt", async () => {
    stubEvidenceUploads((call) => storedReply(call, 7, true));
    expect(await uploadEvidenceFile(await requestFor())).toEqual({
      receiptId: receiptIdFor(7),
      replayed: true,
    });
  });

  it("refuses a receipt that was issued for a different scope", async () => {
    stubEvidenceUploads((call) =>
      storedReply({ ...call, fields: { ...call.fields, target_id: "ca_other" } }, 1),
    );
    await expect(uploadEvidenceFile(await requestFor())).rejects.toMatchObject({
      code: "evidence_receipt_mismatch",
    });
  });
});

describe("uploadEvidenceWithRetry", () => {
  const instantSleep = () => vi.fn(async () => {});

  it("retries a busy store with the same key, name, type and bytes", async () => {
    const { calls } = stubEvidenceUploads((call, attempt) =>
      attempt === 1 ? errorReply(502, "evidence_store_unavailable") : storedReply(call, 3),
    );
    const waits: Array<EvidenceWait | null> = [];
    const result = await uploadEvidenceWithRetry(await requestFor(), {
      sleep: instantSleep(),
      now: () => 1_000,
      onWait: (wait) => waits.push(wait),
    });
    expect(result.receiptId).toBe(receiptIdFor(3));
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(waits).toEqual([{ reason: "retry", until: 2_000, ms: 1_000 }, null]);
  });

  it("retries a lost connection with the same key", async () => {
    let attempts = 0;
    const { fetcher } = stubEvidenceUploads();
    const real = fetcher.getMockImplementation();
    fetcher.mockImplementation(async (input, init) => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("Failed to fetch");
      return (await real?.(input, init)) as Response;
    });
    const result = await uploadEvidenceWithRetry(await requestFor(), { sleep: instantSleep() });
    expect(result.receiptId).toBe(receiptIdFor(1));
    expect(attempts).toBe(2);
  });

  it.each([
    ["cut off", () => new Response('{"result":"stor', { status: 201 })],
    [
      "stalled",
      (init?: RequestInit) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener(
                "abort",
                () => controller.error(new DOMException("aborted", "AbortError")),
                { once: true },
              );
            },
          }),
          { status: 201 },
        ),
    ],
  ])(
    "sends the same key again when a stored file's answer is %s on the way back",
    async (_label, lostAnswer) => {
      const { fetcher, calls } = stubEvidenceUploads((call) => storedReply(call, 5));
      const real = fetcher.getMockImplementation()!;
      let first = true;
      fetcher.mockImplementation(async (input, init) => {
        const reply = await real(input, init);
        if (!first) return reply;
        first = false;
        return lostAnswer(init);
      });
      const result = await uploadEvidenceWithRetry(await requestFor({ timeoutMs: 20 }), {
        sleep: instantSleep(),
      });
      expect(result.receiptId).toBe(receiptIdFor(5));
      expect(calls).toHaveLength(2);
      expect(calls[1]).toEqual(calls[0]);
    },
  );

  it("gives up on a store that stays unavailable after a bounded number of tries", async () => {
    const { calls } = stubEvidenceUploads(() => errorReply(502, "evidence_store_unavailable"));
    await expect(
      uploadEvidenceWithRetry(await requestFor(), { sleep: instantSleep() }),
    ).rejects.toMatchObject({ status: 502 });
    expect(calls).toHaveLength(EVIDENCE_MAX_ATTEMPTS);
    expect(new Set(calls.map((call) => call.key))).toEqual(new Set(["evidence-key-0001"]));
  });

  it("waits exactly as long as Retry-After says and shows the wait", async () => {
    const { calls } = stubEvidenceUploads((call, attempt) =>
      attempt === 1
        ? errorReply(429, "evidence_upload_rate_limited", { "Retry-After": "20" })
        : storedReply(call, 4),
    );
    const sleep = instantSleep();
    const waits: Array<EvidenceWait | null> = [];
    const result = await uploadEvidenceWithRetry(await requestFor(), {
      sleep,
      now: () => 5_000,
      onWait: (wait) => waits.push(wait),
    });
    expect(result.receiptId).toBe(receiptIdFor(4));
    expect(sleep).toHaveBeenCalledWith(20_000, undefined);
    expect(waits).toEqual([{ reason: "rate_limit", until: 25_000, ms: 20_000 }, null]);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.key).toBe(calls[0]?.key);
  });

  it("falls back to a short wait when a limit comes without Retry-After", async () => {
    stubEvidenceUploads((call, attempt) =>
      attempt === 1 ? errorReply(429, "evidence_upload_rate_limited") : storedReply(call, 1),
    );
    const sleep = instantSleep();
    await uploadEvidenceWithRetry(await requestFor(), { sleep });
    expect(sleep).toHaveBeenCalledWith(EVIDENCE_DEFAULT_WAIT_MS, undefined);
  });

  it("stops waiting when the limit never lifts and reports it as a limit", async () => {
    const { calls } = stubEvidenceUploads(() =>
      errorReply(429, "evidence_upload_rate_limited", { "Retry-After": "1" }),
    );
    await expect(
      uploadEvidenceWithRetry(await requestFor(), { sleep: instantSleep() }),
    ).rejects.toMatchObject({ status: 429, code: "evidence_upload_rate_limited" });
    expect(calls).toHaveLength(EVIDENCE_MAX_RATE_LIMIT_WAITS + 1);
  });

  it.each([
    [409, "evidence_upload_conflict"],
    [403, "evidence_actor_role_changed"],
    [415, "evidence_type_mismatch"],
    [413, "evidence_file_size_invalid"],
    [404, "evidence_target_not_found"],
    [400, "evidence_scope_invalid"],
  ])("does not retry a %s %s refusal", async (status, code) => {
    const { calls } = stubEvidenceUploads(() => errorReply(status, code));
    const sleep = instantSleep();
    await expect(uploadEvidenceWithRetry(await requestFor(), { sleep })).rejects.toMatchObject({
      status,
      code,
    });
    expect(calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not send the same file again after it ran out of time", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            calls.push("sent");
            init?.signal?.addEventListener("abort", () =>
              reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            );
          }),
      ),
    );
    const sleep = instantSleep();
    await expect(
      uploadEvidenceWithRetry(await requestFor({ timeoutMs: 20 }), { sleep }),
    ).rejects.toMatchObject({ status: 0, code: "timeout" });
    // A generous wait was already spent. Sending up to 8 MB again and again is the person's call.
    expect(calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops at once when the person removes the file while it waits", async () => {
    stubEvidenceUploads(() =>
      errorReply(429, "evidence_upload_rate_limited", { "Retry-After": "30" }),
    );
    const controller = new AbortController();
    const waiting = uploadEvidenceWithRetry(await requestFor({ signal: controller.signal }), {
      sleep: async () => {
        controller.abort();
        throw new ApiError({ status: 0, code: "aborted", message: "cancelled" });
      },
    });
    await expect(waiting).rejects.toMatchObject({ code: "aborted" });
  });
});

describe("evidenceTransferTimeoutMs", () => {
  it("gives a small file the minimum wait and grows with the file, up to a ceiling", () => {
    expect(evidenceTransferTimeoutMs(16)).toBe(120_000);
    expect(evidenceTransferTimeoutMs(1024 * 1024)).toBe(120_000);
    // 8 MB at no less than about 256 kbit/s, plus a fixed allowance for the connection to open.
    expect(evidenceTransferTimeoutMs(8 * 1024 * 1024)).toBe(286_000);
    expect(evidenceTransferTimeoutMs(4 * 1024 * 1024)).toBeLessThan(
      evidenceTransferTimeoutMs(8 * 1024 * 1024),
    );
    expect(evidenceTransferTimeoutMs(1024 ** 4)).toBe(600_000);
    expect(evidenceTransferTimeoutMs(-5)).toBe(120_000);
  });

  it("is what an upload waits for, unless a test says otherwise", async () => {
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    stubEvidenceUploads();
    const big = new Blob([new Uint8Array(8 * 1024 * 1024)], { type: "image/jpeg" });
    await uploadEvidenceFile(await requestFor({ file: { name: "big.jpg", blob: big } }));
    expect(setTimeoutSpy.mock.calls.map((call) => call[1])).toContain(286_000);
    setTimeoutSpy.mockRestore();
  });
});
