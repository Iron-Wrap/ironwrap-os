import { sha256Hex } from "./app-auth.ts";
import {
  AUTHORITY_VERIFICATION_METHODS,
  claimAuthorityRecordAction,
  completeAuthorityRecordAction,
  EXTERNAL_ISSUER_AUTHORITY_KINDS,
  EXTERNAL_ISSUER_VERIFICATION_METHODS,
  getAuthorityRecordAction,
  recordAuthorityReadback,
  type AuthorityRecordOperation,
  type AuthorityRecordTerminalReceipt,
} from "./authority-records.ts";
import type { AppEnv } from "./app-types.ts";

const MAX_BODY_BYTES = 256 * 1024;
const EXECUTOR_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;
const TENANT_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,139}$/;
const USER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{2,139}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const ACTION_OPERATIONS = new Set<AuthorityRecordOperation>([
  "record",
  "verify",
  "renew",
  "supersede",
  "revoke",
  "resolve_exception",
]);
const VERIFIED_OPERATIONS = new Set<AuthorityRecordOperation>([
  "verify",
  "renew",
  "supersede",
  "resolve_exception",
]);
const D1_TO_FRAPPE_BUSINESS_ROLE = {
  owner: "IronWrap Owner",
  ops: "IronWrap Production",
} as const;
const MATERIAL_FIELDS = [
  "authority_record_id",
  "tenant",
  "subject_type",
  "subject_role",
  "person_user",
  "organization",
  "authority_kind",
  "authority_scope",
  "scope_type",
  "scope_ref",
  "roof_job",
  "scope_json",
  "issuer_name",
  "issuer_jurisdiction",
  "issuer_reference",
  "source_version",
  "evidence_refs_json",
  "evidence_sha256",
  "effective_from",
  "expires_at",
  "version",
  "status",
  "verification_method",
  "verified_at",
  "verification_reference",
  "verified_by",
  "revoked_at",
  "revocation_reference",
  "revoked_by",
  "supersedes",
  "correction_reason",
  "exception_status",
  "exception_reason",
  "issuer_readback_json",
] as const;
type JsonRecord = Record<string, unknown>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function text(value: unknown, min = 1, max = 20_000): value is string {
  return typeof value === "string" && value.trim().length >= min && value.trim().length <= max &&
    !/[\u0000-\u001f]/.test(value);
}

function equalConstantTime(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) diff |= a[index] ^ b[index];
  return diff === 0;
}

async function hmacHex(keyText: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(keyText),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function boundedBody(req: Request): Promise<{ raw: string; value: JsonRecord } | Response> {
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);
  try {
    const value = JSON.parse(raw) as unknown;
    return isRecord(value) ? { raw, value } : json({ error: "invalid_json" }, 400);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
}

async function authenticateExecutor(req: Request, env: AppEnv, rawBody: string): Promise<Response | null> {
  const secret = env.AUTHORITY_RECORD_EXECUTOR_HMAC_KEY?.trim() ?? "";
  if (secret.length < 32) return json({ error: "authority_executor_not_configured" }, 503);
  const timestamp = req.headers.get("x-ironwrap-authority-executor-timestamp") ?? "";
  const signature = req.headers.get("x-ironwrap-authority-executor-signature") ?? "";
  const timestampMs = Number(timestamp);
  if (!/^\d{13}$/.test(timestamp) || !Number.isFinite(timestampMs) ||
      Math.abs(Date.now() - timestampMs) > EXECUTOR_TIMESTAMP_WINDOW_MS || !SHA256.test(signature)) {
    return json({ error: "authority_executor_unauthorized" }, 401);
  }
  const path = new URL(req.url).pathname;
  const expected = await hmacHex(secret, `${timestamp}\n${req.method}\n${path}\n${rawBody}`);
  return equalConstantTime(signature, expected)
    ? null
    : json({ error: "authority_executor_unauthorized" }, 401);
}

function exactKeys(value: JsonRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  return actual.length === required.length && actual.every((key, index) => key === required[index]);
}

function parseJsonText(value: unknown, allowNull = false): JsonRecord | null {
  if (allowNull && value === null) return null;
  if (!text(value)) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function field(record: JsonRecord, name: string): unknown {
  return record[name] ?? "";
}

function optionalField(record: JsonRecord, name: string): string | null {
  const value = field(record, name);
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function authorityStateDigestAsync(record: JsonRecord): Promise<string> {
  const payload = Object.fromEntries(MATERIAL_FIELDS
    .filter((name) => name !== "issuer_readback_json")
    .map((name) => [name, field(record, name)]));
  return await sha256Hex(canonicalJson(payload));
}

function expectedStatus(operation: AuthorityRecordOperation): string {
  if (operation === "record") return "Unverified";
  if (operation === "revoke") return "Revoked";
  return "Verified";
}

function authorityReadbackState(status: string): "verified" | "revoked" | "contradictory" | "unavailable" {
  if (status === "Verified") return "verified";
  if (status === "Revoked") return "revoked";
  if (status === "Contradictory") return "contradictory";
  return "unavailable";
}

function compareMaterialToCommand(command: JsonRecord, material: JsonRecord): string | null {
  for (const name of MATERIAL_FIELDS) {
    if (name === "issuer_readback_json") continue;
    const expected = field(command, name);
    const actual = field(material, name);
    if (canonicalJson(expected) !== canonicalJson(actual)) return name;
  }
  return null;
}

function issuerReceiptMatches(material: JsonRecord, receipt: JsonRecord): boolean {
  const expected = {
    tenant: field(material, "tenant"),
    authority_record_id: field(material, "authority_record_id"),
    authority_version: Number(field(material, "version")),
    issuer_name: field(material, "issuer_name"),
    issuer_jurisdiction: field(material, "issuer_jurisdiction"),
    issuer_reference: field(material, "issuer_reference"),
    issuer_source_version: field(material, "source_version"),
    evidence_sha256: String(field(material, "evidence_sha256")).toLowerCase(),
    state_digest_sha256: field(material, "state_digest_sha256"),
    verification_state: authorityReadbackState(String(field(material, "status"))),
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    const observed = key === "issuer_source_version"
      ? receipt.issuer_source_version
      : receipt[key];
    if (key === "authority_version") {
      if (Number(observed) !== expectedValue) return false;
    } else if (key === "evidence_sha256") {
      if (String(observed ?? "").toLowerCase() !== expectedValue) return false;
    } else if (observed !== expectedValue) return false;
  }
  return text(receipt.evidence_refs_json, 2, 20_000) &&
    canonicalJson(jsonValue(receipt.evidence_refs_json)) === canonicalJson(jsonValue(material.evidence_refs_json));
}

async function actorBinding(
  env: AppEnv,
  tenantId: string,
  actorUserId: string,
  frappeActorUserId: string,
  businessRole: string,
): Promise<boolean> {
  if (!TENANT_ID.test(tenantId) || !USER_ID.test(actorUserId) || !USER_ID.test(frappeActorUserId)) return false;
  const actor = await env.DB.prepare(
    `SELECT user_id, role, frappe_user_id
       FROM app_users
      WHERE tenant_id = ? AND user_id = ? AND active = 1 AND role IN ('owner', 'ops')
      LIMIT 1`,
  ).bind(tenantId, actorUserId).first<{ user_id: string; role: string; frappe_user_id: string | null }>();
  return !!actor && actor.frappe_user_id === frappeActorUserId &&
    D1_TO_FRAPPE_BUSINESS_ROLE[actor.role as keyof typeof D1_TO_FRAPPE_BUSINESS_ROLE] === businessRole;
}

async function completeReconciliation(
  env: AppEnv,
  actionId: string,
  action: { tenant_id: string; authority_record_id: string; actor_user_id: string },
  reason: string,
): Promise<Response> {
  const receiptHash = await sha256Hex(JSON.stringify({
    action_id: actionId,
    authority_record_id: action.authority_record_id,
    reason,
  }));
  const terminal: AuthorityRecordTerminalReceipt = {
    kind: "reconciliation_required",
    actionId,
    authorityRecordId: action.authority_record_id,
    reason,
    reconciliationReceiptSha256: receiptHash,
  };
  const completed = await completeAuthorityRecordAction(env, {
    tenantId: action.tenant_id,
    actionId,
    actorUserId: action.actor_user_id,
    terminal,
    now: new Date().toISOString(),
  });
  return completed ? json({ version: 1, action: completed }) : json({ error: "not_found" }, 404);
}

export async function handleAuthorityRecordExecutorRoute(
  req: Request,
  env: AppEnv,
): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/internal/v1/authority-records/")) return null;
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const parsed = await boundedBody(req);
  if (parsed instanceof Response) return parsed;
  const authError = await authenticateExecutor(req, env, parsed.raw);
  if (authError) return authError;

  if (url.pathname === "/internal/v1/authority-records/actions") {
    const expected = [
      "action_id", "authority_record_id", "expected_version", "idempotency_key", "operation",
      "request_fingerprint_sha256", "tenant_id", "actor_user_id", "frappe_actor_user_id",
      "business_role", "command_json", "issuer_receipt_json",
    ] as const;
    if (!exactKeys(parsed.value, expected)) return json({ error: "invalid_authority_executor_claim" }, 400);
    const command = parseJsonText(parsed.value.command_json);
    const issuerReceipt = parseJsonText(parsed.value.issuer_receipt_json, true);
    const expectedVersion = parsed.value.expected_version === null
      ? null
      : Number.isInteger(parsed.value.expected_version) ? Number(parsed.value.expected_version) : undefined;
    const tenantId = parsed.value.tenant_id;
    const actionId = parsed.value.action_id;
    const recordId = parsed.value.authority_record_id;
    const actorUserId = parsed.value.actor_user_id;
    const frappeActorUserId = parsed.value.frappe_actor_user_id;
    const businessRole = parsed.value.business_role;
    const operation = parsed.value.operation;
    if (!text(tenantId, 2, 64) || !TENANT_ID.test(tenantId) || !text(actionId, 12, 160) ||
        !OPAQUE_ID.test(actionId) || !text(recordId, 3, 140) || !OPAQUE_ID.test(recordId) ||
        expectedVersion === undefined || !text(parsed.value.idempotency_key, 8, 256) ||
        !text(parsed.value.request_fingerprint_sha256, 64, 64) ||
        !SHA256.test(parsed.value.request_fingerprint_sha256) ||
        !ACTION_OPERATIONS.has(operation as AuthorityRecordOperation) || !text(actorUserId, 3, 140) ||
        !USER_ID.test(actorUserId) || !text(frappeActorUserId, 3, 140) || !USER_ID.test(frappeActorUserId) ||
        !text(businessRole, 3, 80) || !Object.values(D1_TO_FRAPPE_BUSINESS_ROLE).includes(businessRole as typeof D1_TO_FRAPPE_BUSINESS_ROLE[keyof typeof D1_TO_FRAPPE_BUSINESS_ROLE]) ||
        !command || command.tenant !== tenantId || command.authority_record_id !== recordId ||
        (expectedVersion !== null && Number(command.version) !== expectedVersion) ||
        parsed.value.issuer_receipt_json !== null && !issuerReceipt) {
      return json({ error: "invalid_authority_executor_claim" }, 400);
    }
    const fingerprint = await sha256Hex(canonicalJson({ command, issuer_receipt: issuerReceipt }));
    if (fingerprint !== parsed.value.request_fingerprint_sha256) {
      return json({ error: "authority_executor_command_mismatch" }, 409);
    }
    if (!(await actorBinding(env, tenantId, actorUserId, frappeActorUserId, businessRole))) {
      return json({ error: "authority_executor_actor_mismatch" }, 403);
    }
    try {
      const result = await claimAuthorityRecordAction(env, {
        actionId,
        tenantId,
        authorityRecordId: recordId,
        operation: operation as AuthorityRecordOperation,
        expectedVersion,
        idempotencyKey: parsed.value.idempotency_key,
        requestFingerprintSha256: parsed.value.request_fingerprint_sha256,
        actorUserId,
        now: new Date().toISOString(),
      });
      return json({ version: 1, ...result }, result.kind === "claimed" ? 201 : result.kind === "conflict" ? 409 : 200);
    } catch {
      return json({ error: "authority_record_store_unavailable" }, 502);
    }
  }

  const terminalPath = url.pathname.match(/^\/internal\/v1\/authority-records\/actions\/([^/]+)\/terminal$/);
  if (!terminalPath) return json({ error: "not_found" }, 404);
  let actionId = "";
  try {
    actionId = decodeURIComponent(terminalPath[1] ?? "");
  } catch {
    return json({ error: "invalid_authority_executor_terminal" }, 400);
  }
  if (!OPAQUE_ID.test(actionId) || !exactKeys(parsed.value, [
    "action_id", "command_json", "issuer_receipt_json", "material_readback_json", "reconciliation_reason",
  ])) return json({ error: "invalid_authority_executor_terminal" }, 400);
  if (parsed.value.action_id !== actionId) return json({ error: "authority_executor_action_mismatch" }, 409);
  const command = parseJsonText(parsed.value.command_json);
  const issuerReceipt = parseJsonText(parsed.value.issuer_receipt_json, true);
  const material = parseJsonText(parsed.value.material_readback_json, true);
  const reason = parsed.value.reconciliation_reason;
  if (!command || (parsed.value.issuer_receipt_json !== null && !issuerReceipt) ||
      (parsed.value.material_readback_json !== null && !material) ||
      (material && reason !== null) || (!material && !text(reason, 3, 2000))) {
    return json({ error: "invalid_authority_executor_terminal" }, 400);
  }
  const tenantId = command.tenant;
  if (!text(tenantId, 2, 64) || !TENANT_ID.test(tenantId)) return json({ error: "invalid_authority_executor_terminal" }, 400);
  const action = await getAuthorityRecordAction(env, tenantId, actionId);
  if (!action) return json({ error: "not_found" }, 404);
  const fingerprint = await sha256Hex(canonicalJson({ command, issuer_receipt: issuerReceipt }));
  if (fingerprint !== action.request_fingerprint_sha256 || command.authority_record_id !== action.authority_record_id) {
    return json({ error: "authority_executor_command_mismatch" }, 409);
  }
  if (action.status !== "pending") return json({ version: 1, action }, 200);
  if (!material) return await completeReconciliation(env, actionId, action, reason as string);

  if (material.tenant !== tenantId || material.authority_record_id !== action.authority_record_id ||
      Number(material.version) !== action.expected_version ||
      material.status !== expectedStatus(action.operation) ||
      compareMaterialToCommand(command, material)) {
    return await completeReconciliation(env, actionId, action, "material_frappe_readback_mismatch");
  }
  const stateDigest = await authorityStateDigestAsync(material);
  if (!SHA256.test(String(material.state_digest_sha256 ?? "")) || material.state_digest_sha256 !== stateDigest) {
    return await completeReconciliation(env, actionId, action, "material_frappe_state_digest_mismatch");
  }
  const authorityVerificationMethod = optionalField(material, "verification_method");
  if (VERIFIED_OPERATIONS.has(action.operation) &&
      (!authorityVerificationMethod || !AUTHORITY_VERIFICATION_METHODS.has(authorityVerificationMethod))) {
    return await completeReconciliation(env, actionId, action, "authority_verification_method_required");
  }
  if (authorityVerificationMethod &&
      !AUTHORITY_VERIFICATION_METHODS.has(authorityVerificationMethod)) {
    return await completeReconciliation(env, actionId, action, "authority_verification_method_invalid");
  }
  if (VERIFIED_OPERATIONS.has(action.operation) &&
      EXTERNAL_ISSUER_AUTHORITY_KINDS.has(String(material.authority_kind)) &&
      !EXTERNAL_ISSUER_VERIFICATION_METHODS.has(authorityVerificationMethod ?? "")) {
    return await completeReconciliation(env, actionId, action, "authority_external_issuer_readback_required");
  }
  let issuerReadbackId = `${actionId}.authority-readback`;
  if (issuerReceipt) {
    if (!issuerReceiptMatches(material, issuerReceipt)) {
      return await completeReconciliation(env, actionId, action, "issuer_receipt_material_mismatch");
    }
    const readbackId = issuerReceipt.receipt_id;
    if (!text(readbackId, 12, 160) || !OPAQUE_ID.test(readbackId) ||
        material.issuer_readback_json !== JSON.stringify(issuerReceipt)) {
      return await completeReconciliation(env, actionId, action, "issuer_receipt_material_binding_mismatch");
    }
    issuerReadbackId = readbackId;
  } else if (EXTERNAL_ISSUER_AUTHORITY_KINDS.has(String(material.authority_kind)) &&
      material.status !== "Unverified") {
    return await completeReconciliation(env, actionId, action, "issuer_receipt_required");
  }
  const readback = await recordAuthorityReadback(env, {
    readbackId: issuerReadbackId,
    tenantId,
    authorityRecordId: action.authority_record_id,
    authorityVersion: Number(material.version),
    subjectType: String(field(material, "subject_type")),
    subjectRole: String(field(material, "subject_role")),
    personUser: optionalField(material, "person_user"),
    organization: optionalField(material, "organization"),
    authorityKind: String(field(material, "authority_kind")),
    authorityScope: String(field(material, "authority_scope")),
    scopeType: String(field(material, "scope_type")),
    scopeRef: String(field(material, "scope_ref")),
    roofJob: optionalField(material, "roof_job"),
    scopeJson: String(field(material, "scope_json")),
    issuerName: String(material.issuer_name),
    issuerJurisdiction: String(material.issuer_jurisdiction),
    issuerReference: String(material.issuer_reference),
    issuerSourceVersion: String(material.source_version),
    verificationState: authorityReadbackState(String(material.status)),
    evidenceRefsJson: String(material.evidence_refs_json),
    evidenceSha256: String(material.evidence_sha256).toLowerCase(),
    authorityStateDigestSha256: stateDigest,
    authorityEffectiveFrom: optionalField(material, "effective_from"),
    authorityExpiresAt: optionalField(material, "expires_at"),
    authorityRevokedAt: optionalField(material, "revoked_at"),
    supersedesAuthorityRecordId: optionalField(material, "supersedes"),
    authorityVerificationMethod,
    issuerReceiptSha256: issuerReceipt ? await sha256Hex(canonicalJson(issuerReceipt)) : null,
    observedByUserId: action.actor_user_id,
    observedAt: new Date().toISOString(),
    actionId,
  });
  if (readback.kind === "conflict") {
    return await completeReconciliation(env, actionId, action, "issuer_readback_identity_conflict");
  }
  issuerReadbackId = readback.readback.readback_id;
  const materialReadbackSha256 = await sha256Hex(canonicalJson(material));
  const terminal: AuthorityRecordTerminalReceipt = {
    kind: "material_applied",
    actionId,
    authorityRecordId: action.authority_record_id,
    authorityVersion: Number(material.version),
    authorityStateDigestSha256: stateDigest,
    materialReadbackSha256,
    issuerReadbackId,
  };
  try {
    const completed = await completeAuthorityRecordAction(env, {
      tenantId,
      actionId,
      actorUserId: action.actor_user_id,
      terminal,
      now: new Date().toISOString(),
    });
    return completed ? json({ version: 1, action: completed }) : json({ error: "not_found" }, 404);
  } catch {
    return json({ error: "authority_record_store_unavailable" }, 502);
  }
}
