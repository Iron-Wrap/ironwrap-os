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
  failDelete = false;
  async put(key: string, bytes: ArrayBuffer, options: { onlyIf: Headers; httpMetadata: { contentType: string }; customMetadata: Record<string, string> }) {
    if (this.failPut) throw new Error("synthetic R2 unavailable");
    this.puts++;
    assert.equal(options.onlyIf.get("If-None-Match"), "*");
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
  async head(key: string) {
    if (this.failGet) throw new Error("synthetic R2 unavailable");
    const row = this.rows.get(key);
    return row ? { ...row, size: row.bytes.byteLength } : null;
  }
  async delete(key: string) {
    if (this.failDelete) throw new Error("synthetic R2 delete unavailable");
    this.rows.delete(key);
  }
}
export class PrivacyLedgerR2 {
  rows = new Map<string, Uint8Array>();
  failRead = false;
  failPut = false;
  puts = 0;
  async put(key: string, value: string, options: { onlyIf: Headers }) {
    if (this.failPut) throw new Error("synthetic privacy ledger unavailable");
    assert.equal(options.onlyIf.get("If-None-Match"), "*");
    this.puts++;
    if (this.rows.has(key)) return null;
    this.rows.set(key, new TextEncoder().encode(value));
    return {};
  }
  async get(key: string) {
    if (this.failRead) throw new Error("synthetic privacy ledger unavailable");
    const bytes = this.rows.get(key);
    return bytes ? { size: bytes.byteLength, async arrayBuffer() { return bytes.slice().buffer; } } : null;
  }
  async head(key: string) {
    if (this.failRead) throw new Error("synthetic privacy ledger unavailable");
    const bytes = this.rows.get(key);
    return bytes ? { size: bytes.byteLength } : null;
  }
  async list(options: { prefix: string; limit: number; cursor?: string }) {
    if (this.failRead) throw new Error("synthetic privacy ledger unavailable");
    const keys = [...this.rows.keys()].filter((key) => key.startsWith(options.prefix) &&
      (!options.cursor || key > options.cursor)).sort();
    const objects = keys.slice(0, options.limit).map((key) => ({ key }));
    const truncated = keys.length > objects.length;
    return { objects, truncated, cursor: truncated ? objects.at(-1)?.key : undefined };
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
