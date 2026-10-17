import type { AppEnv } from "./app-types.ts";
import type { EvidenceUploadReceipt } from "./evidence-uploads.ts";

/** This bucket is outside D1 and RAW restore scope. Markers are never deleted by the Worker. */
export interface EvidencePrivacyMarker {
  version: 1;
  tenant_id: string;
  receipt_id: string;
  receipt_sha256: string;
  r2_key: string;
  decision_id: string;
  decision_sha256: string;
}

export interface EvidencePrivacyMarkerIssue {
  receipt_id: string | null;
  marker_key_sha256: string;
  reason: "invalid_key" | "invalid_marker" | "missing_marker";
}

type EvidenceDecision = {
  decision_id: string;
  basis: string;
  authority_ref: string;
  policy_version: string;
  reason: string;
  requested_by: string;
};

export class EvidencePrivacyLedgerUnavailable extends Error {
  constructor() { super("evidence_privacy_ledger_unavailable"); }
}

function markerKey(tenantId: string, receiptId: string): string {
  return `evidence-dispositions/v1/${encodeURIComponent(tenantId)}/${receiptId}.json`;
}

async function markerKeySha256(key: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Enumerate the independent ledger, including markers whose D1 receipt was lost on restore. */
export async function listExternalEvidenceMarkers(
  env: AppEnv, tenantId: string, limit: number, cursor?: string,
): Promise<{ markers: EvidencePrivacyMarker[]; issues: EvidencePrivacyMarkerIssue[];
  nextCursor: string | null }> {
  const prefix = `evidence-dispositions/v1/${encodeURIComponent(tenantId)}/`;
  let page: R2Objects;
  try {
    page = await bucket(env).list({ prefix, limit, ...(cursor ? { cursor } : {}) });
  } catch {
    throw new EvidencePrivacyLedgerUnavailable();
  }
  if (!Array.isArray(page.objects) || typeof page.truncated !== "boolean" ||
      (page.truncated && (!page.cursor || page.cursor === cursor)) || page.objects.length > limit) {
    throw new EvidencePrivacyLedgerUnavailable();
  }
  const markers: EvidencePrivacyMarker[] = [];
  const issues: EvidencePrivacyMarkerIssue[] = [];
  for (const object of page.objects) {
    if (typeof object.key !== "string") throw new EvidencePrivacyLedgerUnavailable();
    const receiptId = object.key.startsWith(prefix)
      ? object.key.slice(prefix.length, -5) : "";
    if (!/^evu_[0-9a-f]{64}$/.test(receiptId) || object.key !== markerKey(tenantId, receiptId)) {
      issues.push({ receipt_id: null, marker_key_sha256: await markerKeySha256(object.key), reason: "invalid_key" });
      continue;
    }
    try {
      const marker = await readExternalEvidenceMarker(env, tenantId, receiptId);
      if (!marker) {
        issues.push({ receipt_id: receiptId, marker_key_sha256: await markerKeySha256(object.key), reason: "missing_marker" });
      } else {
        markers.push(marker);
      }
    } catch (error) {
      if (!(error instanceof EvidencePrivacyMarkerConflict)) throw error;
      issues.push({ receipt_id: receiptId, marker_key_sha256: await markerKeySha256(object.key), reason: "invalid_marker" });
    }
  }
  return { markers, issues, nextCursor: page.truncated ? page.cursor! : null };
}

function bucket(env: AppEnv): R2Bucket {
  if (!env.PRIVACY_LEDGER) throw new EvidencePrivacyLedgerUnavailable();
  return env.PRIVACY_LEDGER;
}

/** A failed lookup blocks evidence use; a missing marker is the only available result. */
export async function externalEvidenceMarkerPresent(env: AppEnv, tenantId: string, receiptId: string): Promise<boolean> {
  try {
    return !!await bucket(env).head(markerKey(tenantId, receiptId));
  } catch {
    throw new EvidencePrivacyLedgerUnavailable();
  }
}

export async function readExternalEvidenceMarker(
  env: AppEnv, tenantId: string, receiptId: string,
): Promise<EvidencePrivacyMarker | null> {
  let object: R2ObjectBody | null;
  try {
    object = await bucket(env).get(markerKey(tenantId, receiptId));
  } catch {
    throw new EvidencePrivacyLedgerUnavailable();
  }
  if (!object) return null;
  if (object.size > 4096) throw new EvidencePrivacyMarkerConflict();
  let bytes: ArrayBuffer;
  try {
    bytes = await object.arrayBuffer();
  } catch {
    throw new EvidencePrivacyLedgerUnavailable();
  }
  if (bytes.byteLength !== object.size || bytes.byteLength > 4096) throw new EvidencePrivacyMarkerConflict();
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new EvidencePrivacyMarkerConflict();
  }
  const fields = ["version", "tenant_id", "receipt_id", "receipt_sha256", "r2_key",
    "decision_id", "decision_sha256"];
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      Object.keys(parsed).length !== fields.length || fields.some((field) => !Object.hasOwn(parsed, field))) {
    throw new EvidencePrivacyMarkerConflict();
  }
  const marker = parsed as EvidencePrivacyMarker;
  if (marker.version !== 1 || marker.tenant_id !== tenantId || marker.receipt_id !== receiptId ||
      fields.slice(1).some((field) => typeof marker[field as keyof EvidencePrivacyMarker] !== "string") ||
      marker.r2_key !== `evidence/v1/${receiptId.slice(4)}.bin` ||
      !/^[0-9a-f]{64}$/.test(marker.receipt_sha256) || !/^[0-9a-f]{64}$/.test(marker.decision_sha256)) {
    throw new EvidencePrivacyMarkerConflict();
  }
  return marker;
}

async function expectedMarker(receipt: EvidenceUploadReceipt, decision: EvidenceDecision): Promise<EvidencePrivacyMarker> {
  // A stable field order makes the digest an exact decision commitment without
  // permanently copying a free-text reason, authority reference or actor to R2.
  const decisionBytes = new TextEncoder().encode(JSON.stringify([
    receipt.tenant_id, receipt.receipt_id, receipt.sha256, receipt.r2_key,
    decision.decision_id, decision.basis, decision.authority_ref,
    decision.policy_version, decision.reason, decision.requested_by,
  ]));
  const digest = await crypto.subtle.digest("SHA-256", decisionBytes);
  return {
    version: 1,
    tenant_id: receipt.tenant_id,
    receipt_id: receipt.receipt_id,
    receipt_sha256: receipt.sha256,
    r2_key: receipt.r2_key,
    decision_id: decision.decision_id,
    decision_sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
  };
}

function matches(actual: EvidencePrivacyMarker, expected: EvidencePrivacyMarker): boolean {
  return Object.entries(expected).every(([field, value]) => actual[field as keyof EvidencePrivacyMarker] === value);
}

/** Check a surviving marker before an older D1 snapshot can accept a different decision. */
export async function assertExternalEvidenceMarkerCompatible(
  env: AppEnv, receipt: EvidenceUploadReceipt, decision: EvidenceDecision,
): Promise<void> {
  const actual = await readExternalEvidenceMarker(env, receipt.tenant_id, receipt.receipt_id);
  if (actual && !matches(actual, await expectedMarker(receipt, decision))) {
    throw new EvidencePrivacyMarkerConflict();
  }
}

/** Reconciliation never rewrites the surviving original decision marker. */
export async function assertExternalEvidenceMarkerUnchanged(
  env: AppEnv, receipt: EvidenceUploadReceipt, expected: EvidencePrivacyMarker,
): Promise<void> {
  const actual = await readExternalEvidenceMarker(env, receipt.tenant_id, receipt.receipt_id);
  if (!actual) throw new EvidencePrivacyLedgerUnavailable();
  if (!matches(actual, expected) || actual.receipt_sha256 !== receipt.sha256 ||
      actual.r2_key !== receipt.r2_key) throw new EvidencePrivacyMarkerConflict();
}

/** D1 first blocks new manifests; this marker must exist before RAW deletion. */
export async function ensureExternalEvidenceMarker(
  env: AppEnv,
  receipt: EvidenceUploadReceipt,
  decision: EvidenceDecision,
): Promise<void> {
  const expected = await expectedMarker(receipt, decision);
  const key = markerKey(receipt.tenant_id, receipt.receipt_id);
  let store: R2Bucket;
  try {
    store = bucket(env);
    await store.put(key, JSON.stringify(expected), {
      onlyIf: new Headers({ "If-None-Match": "*" }),
      httpMetadata: { contentType: "application/json" },
    });
  } catch {
    // A lost PUT response may have created the marker. The exact retry reads it back.
    throw new EvidencePrivacyLedgerUnavailable();
  }
  const actual = await readExternalEvidenceMarker(env, receipt.tenant_id, receipt.receipt_id);
  if (!actual || !matches(actual, expected)) {
    throw new EvidencePrivacyMarkerConflict();
  }
}

export class EvidencePrivacyMarkerConflict extends Error {
  constructor() { super("evidence_destruction_conflict"); }
}
