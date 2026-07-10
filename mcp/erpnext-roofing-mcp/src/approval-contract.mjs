import {
  createHash,
  createHmac,
  sign as signSignature,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";

const AUTH_FIELDS = new Set([
  "approval_token",
  "approval_receipt",
  "dry_run_receipt",
]);

const VOLATILE_PREVIEW_FIELDS = new Set([
  "acknowledged_at",
  "approved_at",
  "captured_at",
  "completed_at",
  "created_at",
  "prepared_at",
  "requested_at",
  "run_ts",
  "submitted_at",
  "updated_at",
  "verified_at",
]);

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function digest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function approvedArgs(args = {}) {
  return Object.fromEntries(
    Object.entries(args).filter(([key]) => !AUTH_FIELDS.has(key)),
  );
}

export function semanticPreview(value) {
  return stripVolatile(value);
}

export function signDryRunReceipt(signingKey, payload) {
  if (!signingKey || signingKey.length < 32) {
    throw new Error("hermes_dry_run_signing_key_required");
  }
  return signHmac(signingKey, {
    v: 1,
    type: "hermes-dry-run-receipt",
    ...payload,
  });
}

export function verifyDryRunReceipt(signingKey, receipt, expected) {
  const payload = verifyHmac(signingKey, receipt, "hermes_dry_run_receipt_invalid");
  if (payload.v !== 1 || payload.type !== "hermes-dry-run-receipt") {
    throw new Error("hermes_dry_run_receipt_invalid");
  }
  assertNotExpired(payload.expires_at, "hermes_dry_run_receipt_expired");
  for (const [key, value] of Object.entries(expected)) {
    if (payload[key] !== value) throw new Error(`hermes_dry_run_receipt_mismatch:${key}`);
  }
  return payload;
}

export function verifyApprovalReceipt(publicKey, receipt, expected) {
  if (!publicKey) throw new Error("hermes_approval_public_key_required");
  const parts = String(receipt ?? "").split(".");
  if (parts.length !== 2) throw new Error("hermes_approval_receipt_invalid");
  const [encodedPayload, encodedSignature] = parts;
  let payload;
  let signature;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    signature = Buffer.from(encodedSignature, "base64url");
  } catch {
    throw new Error("hermes_approval_receipt_invalid");
  }
  if (!verifySignature(null, Buffer.from(encodedPayload), publicKey, signature)) {
    throw new Error("hermes_approval_receipt_invalid");
  }
  if (payload.v !== 1 || payload.type !== "hermes-human-approval") {
    throw new Error("hermes_approval_receipt_invalid");
  }
  assertNotExpired(payload.expires_at, "hermes_approval_receipt_expired");
  for (const [key, value] of Object.entries(expected)) {
    if (payload[key] !== value) throw new Error(`hermes_approval_receipt_mismatch:${key}`);
  }
  return payload;
}

export function signApprovalReceipt(privateKey, payload) {
  if (!privateKey) throw new Error("hermes_approval_private_key_required");
  const signedPayload = {
    v: 1,
    type: "hermes-human-approval",
    ...payload,
  };
  const encodedPayload = Buffer.from(canonicalJson(signedPayload)).toString("base64url");
  const signature = signSignature(null, Buffer.from(encodedPayload), privateKey).toString("base64url");
  return `${encodedPayload}.${signature}`;
}

export function parseToolPayload(result) {
  const raw = result?.content?.[0]?.text;
  if (typeof raw !== "string") throw new Error("mcp_tool_payload_missing");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("mcp_tool_payload_invalid");
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function stripVolatile(value) {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key, child]) => child !== undefined && !VOLATILE_PREVIEW_FIELDS.has(key))
        .map(([key, child]) => [key, stripVolatile(child)]),
    );
  }
  return value;
}

function signHmac(key, payload) {
  const encodedPayload = Buffer.from(canonicalJson(payload)).toString("base64url");
  const signature = createHmac("sha256", key).update(encodedPayload).digest("base64url");
  return `${encodedPayload}.${signature}`;
}

function verifyHmac(key, receipt, errorCode) {
  const parts = String(receipt ?? "").split(".");
  if (parts.length !== 2) throw new Error(errorCode);
  const [encodedPayload, encodedSignature] = parts;
  const expected = createHmac("sha256", key).update(encodedPayload).digest();
  let actual;
  try {
    actual = Buffer.from(encodedSignature, "base64url");
  } catch {
    throw new Error(errorCode);
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error(errorCode);
  }
  try {
    return JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    throw new Error(errorCode);
  }
}

function assertNotExpired(expiresAt, errorCode) {
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) throw new Error(errorCode);
}
