import assert from "node:assert/strict";
import { handleEvidenceUpload, type EvidenceScope } from "../src/evidence-uploads.ts";
import type { AppEnv, AuthContext } from "../src/app-types.ts";

// Synthetic PNG signature followed by invalid UTF-8: text re-encoding changes its hash.
export const EVIDENCE_BYTES = new Uint8Array([137,80,78,71,13,10,26,10,0,255,254,128,196,0,100]);
export class EvidenceR2 {
  rows = new Map<string, { bytes: Uint8Array; httpMetadata: { contentType: string }; customMetadata: Record<string, string> }>();
  puts = 0;
  failPut = false;
  failGet = false;
  async put(key: string, bytes: ArrayBuffer, options: { onlyIf: { etagDoesNotMatch: string }; httpMetadata: { contentType: string }; customMetadata: Record<string, string> }) {
    if (this.failPut) throw new Error("synthetic R2 unavailable");
    this.puts++;
    assert.equal(options.onlyIf.etagDoesNotMatch, "*");
    if (this.rows.has(key)) return null;
    this.rows.set(key, { bytes: new Uint8Array(bytes), httpMetadata: options.httpMetadata, customMetadata: options.customMetadata });
    return {};
  }
  async get(key: string) {
    if (this.failGet) throw new Error("synthetic R2 unavailable");
    const row = this.rows.get(key);
    return row ? { ...row, size: row.bytes.byteLength,
      async arrayBuffer() { return row.bytes.slice().buffer; },
      async text() { throw new Error("binary evidence must never use text()"); },
    } : null;
  }
}
export function evidenceUploadRequest(scope: EvidenceScope, key = crypto.randomUUID(), options: {
  bytes?: Uint8Array; type?: string; name?: string; csrf?: boolean; extra?: [string, string];
} = {}): Request {
  const form = new FormData();
  form.set("purpose", scope.purpose); form.set("target_id", scope.targetId);
  form.set("action", scope.action); form.set("operation_id", scope.operationId);
  form.set("file", new Blob([options.bytes ?? EVIDENCE_BYTES], { type: options.type ?? "image/png" }), options.name ?? "synthetic-proof.png");
  if (options.extra) form.append(...options.extra);
  return new Request("https://app.example.invalid/api/v1/evidence-uploads", { method: "POST",
    headers: { "idempotency-key": key, ...(options.csrf === false ? {} : { "x-csrf-token": "csrf" }) }, body: form });
}
export async function uploadedEvidence(env: AppEnv, auth: AuthContext, scope: EvidenceScope, key = crypto.randomUUID()): Promise<string> {
  const response = await handleEvidenceUpload(evidenceUploadRequest(scope, key), env, auth);
  const body = await response.json() as { error?: string; receipt?: { receipt_id: string } };
  assert.ok(response.status === 200 || response.status === 201, `${response.status}: ${body.error}`);
  return body.receipt!.receipt_id;
}
