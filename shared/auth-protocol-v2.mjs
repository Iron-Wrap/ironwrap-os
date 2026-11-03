// This is a new digest domain. Do not substitute either historical canonicalJson codec.
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^[0-9a-f]{64}$/;
const KINDS = new Set([
  "read",
  "discovery",
  "begin_enrollment",
  "magic_consume",
  "pair_consume",
  "recovery",
  "logout",
  "magic_issue",
  "pair_issue",
]);
export const AUTH_CONTEXT_HEADER = "X-IronWrap-Auth-Context";
export const AUTH_EXCHANGE_HEADER = "X-IronWrap-Auth-Exchange";
export const AUTH_RECEIPT_HEADER = "X-IronWrap-Auth-Receipt";
export const AUTH_CONTROL_KEY = "auth-control/head-v2";
export const MAX_COUNTER = Number.MAX_SAFE_INTEGER;

function fail() {
  throw new Error("auth_protocol_v2_invalid");
}
export function safeCounter(value) {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) fail();
  return value;
}
function text(value) {
  if (
    typeof value !== "string" ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      value,
    )
  )
    fail();
  return value;
}
function identifier(value) {
  if (typeof value !== "string" || !ID.test(value)) fail();
  return value;
}
function digest(value) {
  if (typeof value !== "string" || !HASH.test(value)) fail();
  return value;
}
function nullable(check, value) {
  return value === null ? null : check(value);
}
export function exactKeys(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")
  )
    fail();
  return value;
}

export function canonicalV2(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(text(value));
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(safeCounter(value));
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value);
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      keys.length !== value.length + 1 ||
      keys.some((key) => typeof key !== "string")
    )
      fail();
    const items = [];
    for (let index = 0; index < value.length; index += 1) {
      const member = Object.getOwnPropertyDescriptor(value, String(index));
      if (!member || !member.enumerable || !Object.hasOwn(member, "value"))
        fail();
      items.push(canonicalV2(member.value));
    }
    return `[${items.join(",")}]`;
  }
  if (
    !value ||
    typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.getOwnPropertySymbols(value).length
  )
    fail();
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(text(key))}:${canonicalV2(value[key])}`)
    .join(",")}}`;
}

export function parseCanonicalV2(raw, maximum = 65536) {
  if (typeof raw !== "string" || new TextEncoder().encode(raw).length > maximum)
    fail();
  const value = JSON.parse(raw);
  // This also rejects duplicate/escaped-duplicate members, whitespace, lossy numbers and -0.
  if (canonicalV2(value) !== raw) fail();
  return value;
}

export function encodeV2(value) {
  const bytes = new TextEncoder().encode(canonicalV2(value));
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function decodeV2(encoded, maximum = 4096) {
  if (
    typeof encoded !== "string" ||
    !encoded.length ||
    encoded.length > maximum ||
    !/^[A-Za-z0-9_-]+$/.test(encoded)
  )
    fail();
  const bytes = Uint8Array.from(
    atob(encoded.replace(/-/g, "+").replace(/_/g, "/")),
    (character) => character.charCodeAt(0),
  );
  const value = parseCanonicalV2(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    maximum,
  );
  if (encodeV2(value) !== encoded) fail();
  return value;
}

export function validateExchange(value) {
  const v = exactKeys(value, [
    "v",
    "exchangeId",
    "issuer",
    "kind",
    "baseGeneration",
  ]);
  if (v.v !== 2 || !KINDS.has(v.kind)) fail();
  identifier(v.exchangeId);
  nullable(identifier, v.issuer);
  safeCounter(v.baseGeneration);
  if (v.issuer === null && (v.kind !== "discovery" || v.baseGeneration !== 0))
    fail();
  return v;
}

export function validateControlHead(value) {
  const v = exactKeys(value, [
    "format",
    "controlRevision",
    "minProducerProtocol",
    "mode",
    "activationId",
    "issuer",
    "databaseIdentity",
    "allowedProducerBindings",
    "qualificationReceiptHash",
  ]);
  if (
    v.format !== "ironwrap-auth-control-v2" ||
    ![1, 2].includes(v.minProducerProtocol) ||
    !["staged", "closed", "active"].includes(v.mode) ||
    safeCounter(v.controlRevision) === 0
  )
    fail();
  identifier(v.activationId);
  identifier(v.issuer);
  identifier(v.databaseIdentity);
  nullable(digest, v.qualificationReceiptHash);
  if (
    v.mode === "staged" &&
    (v.minProducerProtocol !== 1 || v.qualificationReceiptHash !== null)
  )
    fail();
  if (v.mode === "active" && v.minProducerProtocol !== 2) fail();
  if (v.qualificationReceiptHash !== null && v.minProducerProtocol !== 2)
    fail();
  if (
    !Array.isArray(v.allowedProducerBindings) ||
    !v.allowedProducerBindings.length ||
    v.allowedProducerBindings.length > 16
  )
    fail();
  const versions = new Set();
  for (const binding of v.allowedProducerBindings) {
    exactKeys(binding, [
      "versionId",
      "artifactHash",
      "componentManifestHash",
      "protocol",
      "databaseIdentity",
      "issuer",
    ]);
    identifier(binding.versionId);
    digest(binding.artifactHash);
    digest(binding.componentManifestHash);
    if (
      binding.databaseIdentity !== v.databaseIdentity ||
      binding.issuer !== v.issuer ||
      ![1, 2].includes(binding.protocol) ||
      binding.protocol < v.minProducerProtocol ||
      versions.has(binding.versionId)
    )
      fail();
    versions.add(binding.versionId);
  }
  return v;
}

export function validateReceipt(value) {
  const v = exactKeys(value, [
    "v",
    "actualProducerVersion",
    "controlRevision",
    "activationId",
    "producerQualificationReceiptHashOrNull",
    "actualIssuer",
    "databaseIdentity",
    "kind",
    "status",
    "reason",
    "actualContextIdOrNull",
    "actualGenerationOrNull",
    "authenticatedSubjectDigestOrNull",
    "exchangeId",
    "requestFingerprint",
  ]);
  if (
    v.v !== 2 ||
    !["authenticated", "metadata", "refused"].includes(v.kind) ||
    !/^[a-z][a-z0-9_]{0,63}$/.test(v.status) ||
    !/^[a-z][a-z0-9_]{0,63}$/.test(v.reason)
  )
    fail();
  identifier(v.actualProducerVersion);
  safeCounter(v.controlRevision);
  identifier(v.activationId);
  identifier(v.actualIssuer);
  identifier(v.databaseIdentity);
  identifier(v.exchangeId);
  digest(v.requestFingerprint);
  nullable(digest, v.producerQualificationReceiptHashOrNull);
  nullable(digest, v.actualContextIdOrNull);
  nullable(safeCounter, v.actualGenerationOrNull);
  nullable(digest, v.authenticatedSubjectDigestOrNull);
  if (
    v.kind === "authenticated" &&
    (!v.authenticatedSubjectDigestOrNull ||
      !v.actualContextIdOrNull ||
      v.actualGenerationOrNull === null ||
      v.actualGenerationOrNull === 0)
  )
    fail();
  if (v.kind !== "authenticated" && v.authenticatedSubjectDigestOrNull !== null)
    fail();
  return v;
}

export async function sha256V2(value) {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
export async function requestFingerprintV2(request, exchangeId) {
  identifier(exchangeId);
  const url = new URL(request.url);
  return sha256V2(
    `${request.method.toUpperCase()}\0${url.pathname}${url.search}\0${exchangeId}`,
  );
}
export async function subjectDigestV2(session, verifiedPairedProofHash) {
  if (
    !session ||
    typeof session !== "object" ||
    !session.tenant ||
    !session.user ||
    ![
      "tenant",
      "user",
      "session_expires_at",
      "source_updated_at",
      "permissions",
      "allowed_actions",
      "csrf_token",
    ].every((key) => Object.hasOwn(session, key)) ||
    !Object.hasOwn(session.user, "frappe_user_id")
  )
    fail();
  identifier(session.tenant.id);
  identifier(session.user.id);
  if (
    !["owner", "ops", "sales", "production", "accounting", "field"].includes(
      session.user.role,
    ) ||
    typeof session.session_expires_at !== "string" ||
    !session.session_expires_at.length ||
    (session.source_updated_at !== null &&
      typeof session.source_updated_at !== "string") ||
    (session.user.frappe_user_id !== null &&
      typeof session.user.frappe_user_id !== "string") ||
    typeof session.csrf_token !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(session.csrf_token)
  )
    fail();
  for (const values of [session.permissions, session.allowed_actions]) {
    if (
      !Array.isArray(values) ||
      values.some((value) => typeof value !== "string" || !value.length) ||
      new Set(values).size !== values.length
    )
      fail();
  }
  nullable(digest, verifiedPairedProofHash);
  if ((session.user.role === "field") !== (verifiedPairedProofHash !== null))
    fail();
  const tuple = [
    session.tenant.id,
    session.user.id,
    session.user.role,
    session.user.frappe_user_id,
    session.session_expires_at,
    session.source_updated_at,
    [...session.permissions].sort(),
    [...session.allowed_actions].sort(),
    await sha256V2(session.csrf_token),
    verifiedPairedProofHash,
  ];
  return sha256V2(canonicalV2(tuple));
}
