import { vi } from "vitest";

import type { EvidenceScope } from "./evidence-types";

/** Synthetic evidence for tests. Nothing here is a real photo, document, receipt or customer file. */

export function receiptIdFor(index: number): string {
  return `evu_${index.toString(16).padStart(64, "0")}`;
}

const SIGNATURES: Record<string, number[]> = {
  "image/jpeg": [255, 216, 255, 224, 0, 16, 74, 70, 73, 70],
  "image/png": [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13],
  "image/webp": [82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80],
  "application/pdf": [37, 80, 68, 70, 45, 49, 46, 52, 10],
  "image/heic": [0, 0, 0, 24, 102, 116, 121, 112, 104, 101, 105, 99],
};

/** A small file whose first bytes are a real signature for `signatureOf`, whatever its declared type. */
export function evidenceFile(
  name = "synthetic-photo.jpg",
  type = "image/jpeg",
  signatureOf: keyof typeof SIGNATURES = type in SIGNATURES ? type : "image/jpeg",
): File {
  const head = SIGNATURES[signatureOf] ?? [];
  const bytes = new Uint8Array([...head, ...Array.from({ length: 24 }, (_, index) => index)]);
  return new File([bytes], name, { type, lastModified: 1_700_000_000_000 });
}

export interface RecordedUpload {
  key: string;
  csrf: string | null;
  deviceProof: string | null;
  hasContentType: boolean;
  fields: Record<string, string>;
  fileName: string;
  fileType: string;
  fileSize: number;
}

/** An answer for one attempt. Returning `undefined` takes the default: the file is stored. */
export type UploadReply = (
  call: RecordedUpload,
  attempt: number,
) => Response | Promise<Response> | undefined;

export function jsonReply(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** The 201 the Worker returns: a receipt for exactly the scope that was sent. */
export function storedReply(call: RecordedUpload, serial: number, replayed = false): Response {
  return jsonReply(replayed ? 200 : 201, {
    result: replayed ? "replayed" : "stored",
    receipt: {
      receipt_id: receiptIdFor(serial),
      file_name: call.fileName,
      content_type: call.fileType,
      byte_size: call.fileSize,
      purpose: call.fields.purpose,
      target_id: call.fields.target_id,
      action: call.fields.action,
      operation_id: call.fields.operation_id,
    },
  });
}

export function errorReply(status: number, code: string, headers: Record<string, string> = {}) {
  return jsonReply(status, { error: code }, headers);
}

/**
 * Replaces `fetch` with a stand-in for `POST /api/v1/evidence-uploads` and records every attempt.
 * `reply` decides each answer; the default stores the file under a receipt numbered by upload key,
 * so a retry of the same key gets the same receipt, as the Worker's replay does.
 */
export function stubEvidenceUploads(reply?: UploadReply) {
  const calls: RecordedUpload[] = [];
  const serials = new Map<string, number>();
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== "/api/v1/evidence-uploads") return jsonReply(404, { error: "not_found" });
    const headers = new Headers(init?.headers);
    const form = init?.body as FormData;
    const file = form.get("file") as File;
    const fields: Record<string, string> = {};
    for (const [name, value] of form.entries()) {
      if (typeof value === "string") fields[name] = value;
    }
    const call: RecordedUpload = {
      key: headers.get("Idempotency-Key") ?? "",
      csrf: headers.get("X-CSRF-Token"),
      deviceProof: headers.get("X-IronWrap-Device-Proof"),
      hasContentType: headers.has("Content-Type"),
      fields,
      fileName: file.name,
      fileType: file.type,
      fileSize: file.size,
    };
    calls.push(call);
    if (!serials.has(call.key)) serials.set(call.key, serials.size + 1);
    const planned = reply
      ? await reply(call, calls.filter((entry) => entry.key === call.key).length)
      : undefined;
    return planned ?? storedReply(call, serials.get(call.key) ?? 0);
  });
  vi.stubGlobal("fetch", fetcher);
  return { fetcher, calls, serialFor: (key: string) => serials.get(key) };
}

export function scopeFor(overrides: Partial<EvidenceScope> = {}): EvidenceScope {
  return {
    purpose: "corrective_action",
    targetId: "ca_fix",
    action: "submit",
    operationId: "",
    ...overrides,
  };
}
