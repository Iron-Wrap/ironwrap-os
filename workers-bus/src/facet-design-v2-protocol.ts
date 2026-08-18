import { sha256Hex } from "./app-auth.ts";

export const FACET_V2_EVENT_TYPE = "facet.design.customer_approved.v2" as const;
export const FACET_V2_EVENT_SCHEMA_VERSION = 2 as const;
export const FACET_V2_DELIVERY_CONTEXT = "facet.design.delivery.v2" as const;
export const FACET_V2_RECEIPT_CONTEXT = "ironwrap.facet-design.receipt.v2" as const;
export const FACET_V2_RECEIPT_SCHEMA = "ironwrap.facet-design-receipt.v2" as const;
export const FACET_V2_MAX_BODY_BYTES = 512 * 1024;
export const FACET_V2_MAX_DELIVERY_TTL_MS = 5 * 60 * 1_000;
export const FACET_V2_MAX_CLOCK_SKEW_MS = 60 * 1_000;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NONCE = /^[A-Za-z0-9_-]{32,128}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;
const MILLISECONDS = /^\d{13}$/;
const IRONWRAP_PROJECT_LINK = /^ironwrap-project-v1:[0-9a-f]{64}$/;
const IRONWRAP_IDENTITY_LINK = /^ironwrap-identity-v1:[0-9a-f]{64}$/;
const CUSTOMER_IDENTITY_LINK = /^facet-customer-oidc-v1:[0-9a-f]{64}$/;
const DECISIONS = new Set<string>([
  "approved", "corrected", "superseded", "withdrawn",
]);
const OIDC_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const DESIGN_KEYS = [
  "brandId", "catalogRevision", "facetOverrides", "layers", "roof", "schema",
  "trimAccents", "uniformFinish", "wall",
] as const;
const CLIENT_REVISION_KEYS = ["roofColorId", "wallColorId"] as const;
const CATALOG_KEYS = ["schema", "sha256"] as const;
const LAYER_KEYS = ["id", "visible", "xmlSha256", "xmlUtf8Bytes"] as const;
const SURFACE_KEYS = ["colorId", "productId"] as const;
const OVERRIDE_KEYS = ["colorId", "faceId", "layerId", "productId"] as const;
const TRIM_KEYS = [
  "canonicalUnit", "colorId", "id", "kind", "productId", "quantity",
] as const;
const TRIM_KINDS = new Set([
  "soffit", "fascia", "gutters", "downspouts", "garage_doors", "other_trims",
]);
const CANONICAL_UNITS = new Set(["square_feet", "linear_feet"]);

const HEADER_NAMES = Object.freeze({
  bodySha256: "x-ironwrap-event-body-sha256",
  destinationTenantId: "x-ironwrap-event-destination-tenant-id",
  environment: "x-ironwrap-event-environment",
  eventId: "x-ironwrap-event-id",
  expiresAt: "x-ironwrap-event-expires-at",
  issuer: "x-ironwrap-event-issuer",
  issuedAt: "x-ironwrap-event-issued-at",
  keyId: "x-ironwrap-event-key-id",
  keyVersion: "x-ironwrap-event-key-version",
  nonce: "x-ironwrap-event-nonce",
  product: "x-ironwrap-event-product",
  signature: "x-ironwrap-event-signature",
} as const);

export interface FacetV2StaticRoute {
  version: 1;
  issuer: string;
  sourceProduct: "facet";
  sourceEnvironment: string;
  sourceTenantId: string;
  destinationTenantId: string;
  destinationUrl: string;
}

export interface FacetV2VerificationKey {
  keyId: string;
  keyVersion: number;
  secret: string;
  notBeforeMs: number;
  notAfterMs: number;
}

export interface FacetV2SignedHeaders {
  bodySha256: string;
  destinationTenantId: string;
  environment: string;
  eventId: string;
  expiresAt: string;
  issuer: string;
  issuedAt: string;
  keyId: string;
  keyVersion: number;
  nonce: string;
  product: string;
  signature: string;
}

export interface VerifiedFacetV2Delivery {
  bodySha256: string;
  event: Record<string, unknown>;
  headers: FacetV2SignedHeaders;
  route: FacetV2StaticRoute;
}

export type FacetV2DecisionKind = "approved" | "corrected" | "superseded" | "withdrawn";

export interface FacetV2CustomerDecisionEvent {
  approval: {
    actor: {
      customer_party_ref: string;
      external_identity_link_id: string;
      identity_assurance: "oidc";
      oidc_issuer: "https://accounts.google.com" | "accounts.google.com";
      oidc_subject_sha256: string;
    };
    attestation_version: "facet-customer-approval-v1";
    decision: FacetV2DecisionKind;
    manifest_sha256: string;
    previous_event_id: string | null;
    reason_sha256: string | null;
    receipt_id: string;
    receipt_sha256: string;
  };
  brand_id: string;
  design_revision: { id: string; sha256: string };
  destination: { tenant_id: string };
  event_id: string;
  event_type: typeof FACET_V2_EVENT_TYPE;
  facet_project_id: string;
  frozen_evidence: Record<string, unknown>;
  occurred_at: string;
  project_link: {
    external_project_link_id: string;
    producer_identity_link_id: string;
  };
  schema_version: typeof FACET_V2_EVENT_SCHEMA_VERSION;
  source: {
    environment: string;
    issuer: string;
    product: "facet";
    tenant_id: string;
  };
}

export type FacetV2DeliveryVerification =
  | { ok: true; value: VerifiedFacetV2Delivery }
  | {
    ok: false;
    code:
      | "content_type_required"
      | "payload_too_large"
      | "invalid_event_headers"
      | "event_timestamp_invalid"
      | "event_timestamp_stale"
      | "event_key_unknown"
      | "event_key_inactive"
      | "event_route_untrusted"
      | "event_signature_invalid"
      | "invalid_event_body"
      | "event_id_mismatch"
      | "event_route_mismatch";
    status: 400 | 401 | 403 | 413 | 415;
  };

export interface FacetV2Receipt {
  schema: typeof FACET_V2_RECEIPT_SCHEMA;
  receipt_id: string;
  event_id: string;
  event_body_sha256: string;
  frozen_evidence_sha256: string;
  design_revision: {
    id: string;
    sha256: string;
  };
  decision_kind: "approved" | "corrected" | "superseded" | "withdrawn";
  approval_receipt_sha256: string;
  actor_identity_assurance: "oidc";
  destination_tenant_id: string;
  result:
    | "accepted_unassociated"
    | "accepted_associated"
    | "rejected"
    | "reconciled"
    | "duplicate";
  policy_version: string;
  occurred_at: string;
  detail_code: string;
  idempotent_replay: boolean;
}

export interface SignedFacetV2Receipt {
  receipt: FacetV2Receipt;
  receipt_sha256: string;
  signature: {
    algorithm: "HMAC-SHA256";
    key_id: string;
    key_version: number;
    value: string;
  };
}

export function facetV2DeliverySigningInput(input: {
  destinationOrigin: string;
  destinationPath: string;
  issuer: string;
  product: string;
  environment: string;
  destinationTenantId: string;
  keyId: string;
  keyVersion: number;
  eventId: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  bodySha256: string;
}): string {
  return [
    FACET_V2_DELIVERY_CONTEXT,
    "POST",
    input.destinationOrigin,
    input.destinationPath,
    input.issuer,
    input.product,
    input.environment,
    input.destinationTenantId,
    input.keyId,
    String(input.keyVersion),
    input.eventId,
    input.issuedAt,
    input.expiresAt,
    input.nonce,
    input.bodySha256,
  ].join("\n");
}

export async function verifyFacetV2Delivery(
  request: Request,
  rawBody: string,
  input: {
    routes: readonly FacetV2StaticRoute[];
    keys: readonly FacetV2VerificationKey[];
    nowMs?: number;
  },
): Promise<FacetV2DeliveryVerification> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return failure("content_type_required", 415);
  }
  const bodyBytes = new TextEncoder().encode(rawBody).byteLength;
  if (bodyBytes > FACET_V2_MAX_BODY_BYTES) return failure("payload_too_large", 413);

  const headers = signedHeaders(request.headers);
  if (!headers) return failure("invalid_event_headers", 400);
  const issuedAt = Number(headers.issuedAt);
  const expiresAt = Number(headers.expiresAt);
  const nowMs = input.nowMs ?? Date.now();
  if (
    !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) ||
    expiresAt <= issuedAt || expiresAt - issuedAt > FACET_V2_MAX_DELIVERY_TTL_MS
  ) return failure("event_timestamp_invalid", 401);
  if (
    issuedAt > nowMs + FACET_V2_MAX_CLOCK_SKEW_MS ||
    expiresAt < nowMs - FACET_V2_MAX_CLOCK_SKEW_MS
  ) return failure("event_timestamp_stale", 401);

  const key = input.keys.find((candidate) =>
    candidate.keyId === headers.keyId && candidate.keyVersion === headers.keyVersion
  );
  if (!key) return failure("event_key_unknown", 401);
  if (
    key.secret.length < 32 || !Number.isSafeInteger(key.notBeforeMs) ||
    !Number.isSafeInteger(key.notAfterMs) || key.notAfterMs <= key.notBeforeMs ||
    issuedAt < key.notBeforeMs || issuedAt >= key.notAfterMs
  ) return failure("event_key_inactive", 401);

  const route = input.routes.find((candidate) => routeMatchesHeaders(candidate, headers, request.url));
  if (!route) return failure("event_route_untrusted", 403);
  const bodySha256 = await sha256Hex(rawBody);
  if (bodySha256 !== headers.bodySha256) return failure("event_signature_invalid", 401);
  const destination = new URL(route.destinationUrl);
  const signingInput = facetV2DeliverySigningInput({
    destinationOrigin: destination.origin,
    destinationPath: destination.pathname,
    issuer: headers.issuer,
    product: headers.product,
    environment: headers.environment,
    destinationTenantId: headers.destinationTenantId,
    keyId: headers.keyId,
    keyVersion: headers.keyVersion,
    eventId: headers.eventId,
    issuedAt: headers.issuedAt,
    expiresAt: headers.expiresAt,
    nonce: headers.nonce,
    bodySha256,
  });
  if (!await verifyHmac(key.secret, signingInput, headers.signature)) {
    return failure("event_signature_invalid", 401);
  }

  let event: unknown;
  try {
    event = JSON.parse(rawBody) as unknown;
  } catch {
    return failure("invalid_event_body", 400);
  }
  if (!isRecord(event) || canonicalJson(event) !== rawBody) {
    return failure("invalid_event_body", 400);
  }
  if (event.event_id !== headers.eventId) return failure("event_id_mismatch", 400);
  if (!eventMatchesRoute(event, route)) return failure("event_route_mismatch", 403);
  return { ok: true, value: { bodySha256, event, headers, route } };
}

/**
 * Parse only the minimized, OIDC-assured v2 customer-decision schema.  This is
 * deliberately separate from transport verification: callers authenticate
 * the bounded raw bytes in memory, validate this minimized schema, and only
 * then preserve the exact canonical body as durable evidence.
 */
export async function parseFacetV2CustomerDecisionEvent(
  value: unknown,
): Promise<FacetV2CustomerDecisionEvent | null> {
  if (!isRecord(value) || !sameKeys(value, [
    "approval",
    "brand_id",
    "design_revision",
    "destination",
    "event_id",
    "event_type",
    "facet_project_id",
    "frozen_evidence",
    "occurred_at",
    "project_link",
    "schema_version",
    "source",
  ])) return null;
  if (
    value.event_type !== FACET_V2_EVENT_TYPE ||
    value.schema_version !== FACET_V2_EVENT_SCHEMA_VERSION ||
    !UUID.test(String(value.event_id ?? "")) || !UUID.test(String(value.facet_project_id ?? "")) ||
    !validIsoTimestamp(String(value.occurred_at ?? "")) || !validBrand(value.brand_id) ||
    !isRecord(value.source) || !sameKeys(value.source, [
      "environment", "issuer", "product", "tenant_id",
    ]) ||
    !IDENTIFIER.test(String(value.source.issuer ?? "")) ||
    value.source.product !== "facet" ||
    !IDENTIFIER.test(String(value.source.environment ?? "")) ||
    !UUID.test(String(value.source.tenant_id ?? "")) ||
    !isRecord(value.destination) ||
    !sameKeys(value.destination, ["tenant_id"]) ||
    !IDENTIFIER.test(String(value.destination.tenant_id ?? "")) ||
    !isRecord(value.project_link) ||
    !sameKeys(value.project_link, [
      "external_project_link_id", "producer_identity_link_id",
    ]) ||
    !IRONWRAP_PROJECT_LINK.test(String(value.project_link.external_project_link_id ?? "")) ||
    !IRONWRAP_IDENTITY_LINK.test(String(value.project_link.producer_identity_link_id ?? "")) ||
    !isRecord(value.design_revision) ||
    !sameKeys(value.design_revision, ["id", "sha256"]) ||
    !SHA256.test(String(value.design_revision.sha256 ?? "")) ||
    value.design_revision.id !== `facet-json-v1:${value.design_revision.sha256}` ||
    !isRecord(value.frozen_evidence) ||
    !sameKeys(value.frozen_evidence, ["approval", "design"]) ||
    !isRecord(value.frozen_evidence.approval) ||
    !sameKeys(value.frozen_evidence.approval, ["approved_at", "client_revision"]) ||
    value.frozen_evidence.approval.approved_at !== value.occurred_at ||
    !isRecord(value.frozen_evidence.design) ||
    !validFrozenEvidence(value.frozen_evidence, String(value.brand_id ?? ""))
  ) return null;

  const designSha256 = await sha256Hex(canonicalJson(value.frozen_evidence.design));
  const frozenEvidenceSha256 = await sha256Hex(canonicalJson(value.frozen_evidence));
  if (
    value.design_revision.sha256 !== designSha256 ||
    !isRecord(value.approval) ||
    !sameKeys(value.approval, [
      "actor",
      "attestation_version",
      "decision",
      "manifest_sha256",
      "previous_event_id",
      "reason_sha256",
      "receipt_id",
      "receipt_sha256",
    ]) ||
    value.approval.attestation_version !== "facet-customer-approval-v1" ||
    !DECISIONS.has(String(value.approval.decision ?? "")) ||
    value.approval.manifest_sha256 !== frozenEvidenceSha256 ||
    !UUID.test(String(value.approval.receipt_id ?? "")) ||
    !SHA256.test(String(value.approval.receipt_sha256 ?? "")) ||
    !isRecord(value.approval.actor) ||
    !sameKeys(value.approval.actor, [
      "customer_party_ref",
      "external_identity_link_id",
      "identity_assurance",
      "oidc_issuer",
      "oidc_subject_sha256",
    ]) ||
    !SHA256.test(String(value.approval.actor.customer_party_ref ?? "")) ||
    value.approval.actor.identity_assurance !== "oidc" ||
    !OIDC_ISSUERS.has(String(value.approval.actor.oidc_issuer ?? "")) ||
    !SHA256.test(String(value.approval.actor.oidc_subject_sha256 ?? "")) ||
    !CUSTOMER_IDENTITY_LINK.test(
      String(value.approval.actor.external_identity_link_id ?? ""),
    )
  ) return null;

  const decision = value.approval.decision as FacetV2DecisionKind;
  const previousEventId = value.approval.previous_event_id;
  const reasonSha256 = value.approval.reason_sha256;
  if (
    (decision === "approved" && (previousEventId !== null || reasonSha256 !== null)) ||
    (decision !== "approved" && (!UUID.test(String(previousEventId ?? "")) || !SHA256.test(String(reasonSha256 ?? ""))))
  ) return null;

  return value as unknown as FacetV2CustomerDecisionEvent;
}

export async function signFacetV2Receipt(
  receipt: FacetV2Receipt,
  key: Pick<FacetV2VerificationKey, "keyId" | "keyVersion" | "secret">,
): Promise<SignedFacetV2Receipt> {
  assertReceipt(receipt);
  if (!validKey(key) || key.secret.length < 32) throw new Error("facet_v2_receipt_key_invalid");
  const receiptSha256 = await sha256Hex(canonicalJson(receipt));
  return {
    receipt,
    receipt_sha256: receiptSha256,
    signature: {
      algorithm: "HMAC-SHA256",
      key_id: key.keyId,
      key_version: key.keyVersion,
      value: await hmacBase64Url(key.secret, facetV2ReceiptSigningInput(receiptSha256)),
    },
  };
}

export function facetV2ReceiptSigningInput(receiptSha256: string): string {
  if (!SHA256.test(receiptSha256)) throw new Error("facet_v2_receipt_sha256_invalid");
  return `${FACET_V2_RECEIPT_CONTEXT}\n${receiptSha256}`;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("non_finite_json_number");
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("unsupported_json_value");
  return encoded;
}

function signedHeaders(headers: Headers): FacetV2SignedHeaders | null {
  const values = Object.fromEntries(
    Object.entries(HEADER_NAMES).map(([name, header]) => [name, headers.get(header) ?? ""]),
  ) as Record<keyof typeof HEADER_NAMES, string>;
  const keyVersion = Number(values.keyVersion);
  if (
    !IDENTIFIER.test(values.eventId) || !MILLISECONDS.test(values.issuedAt) ||
    !MILLISECONDS.test(values.expiresAt) || !NONCE.test(values.nonce) ||
    !SIGNATURE.test(values.signature) || !SHA256.test(values.bodySha256) ||
    !KEY_ID.test(values.keyId) || !Number.isSafeInteger(keyVersion) || keyVersion < 1 ||
    !IDENTIFIER.test(values.issuer) || !IDENTIFIER.test(values.product) ||
    !IDENTIFIER.test(values.environment) || !IDENTIFIER.test(values.destinationTenantId)
  ) return null;
  return {
    bodySha256: values.bodySha256,
    destinationTenantId: values.destinationTenantId,
    environment: values.environment,
    eventId: values.eventId,
    expiresAt: values.expiresAt,
    issuer: values.issuer,
    issuedAt: values.issuedAt,
    keyId: values.keyId,
    keyVersion,
    nonce: values.nonce,
    product: values.product,
    signature: values.signature,
  };
}

function routeMatchesHeaders(
  route: FacetV2StaticRoute,
  headers: FacetV2SignedHeaders,
  requestUrl: string,
): boolean {
  let destination: URL;
  let actual: URL;
  try {
    destination = new URL(route.destinationUrl);
    actual = new URL(requestUrl);
  } catch {
    return false;
  }
  return route.version === 1 && route.sourceProduct === "facet" &&
    route.issuer === headers.issuer && route.sourceProduct === headers.product &&
    route.sourceEnvironment === headers.environment &&
    route.destinationTenantId === headers.destinationTenantId &&
    destination.protocol === "https:" && destination.username === "" &&
    destination.password === "" && destination.search === "" && destination.hash === "" &&
    destination.origin === actual.origin && destination.pathname === actual.pathname;
}

function eventMatchesRoute(event: Record<string, unknown>, route: FacetV2StaticRoute): boolean {
  if (
    event.event_type !== FACET_V2_EVENT_TYPE ||
    event.schema_version !== FACET_V2_EVENT_SCHEMA_VERSION ||
    !isRecord(event.source) || !isRecord(event.destination)
  ) return false;
  return event.source.issuer === route.issuer &&
    event.source.product === route.sourceProduct &&
    event.source.environment === route.sourceEnvironment &&
    event.source.tenant_id === route.sourceTenantId &&
    event.destination.tenant_id === route.destinationTenantId;
}

function assertReceipt(receipt: FacetV2Receipt): void {
  if (
    receipt.schema !== FACET_V2_RECEIPT_SCHEMA || !IDENTIFIER.test(receipt.receipt_id) ||
    !IDENTIFIER.test(receipt.event_id) || !SHA256.test(receipt.event_body_sha256) ||
    !SHA256.test(receipt.frozen_evidence_sha256) ||
    !isRecord(receipt.design_revision) || !IDENTIFIER.test(receipt.design_revision.id) ||
    !SHA256.test(receipt.design_revision.sha256) ||
    !SHA256.test(receipt.approval_receipt_sha256) ||
    receipt.actor_identity_assurance !== "oidc" ||
    !IDENTIFIER.test(receipt.destination_tenant_id) || !IDENTIFIER.test(receipt.policy_version) ||
    !IDENTIFIER.test(receipt.detail_code) || !validIsoTimestamp(receipt.occurred_at) ||
    typeof receipt.idempotent_replay !== "boolean"
  ) throw new Error("facet_v2_receipt_invalid");
}

function validKey(key: Pick<FacetV2VerificationKey, "keyId" | "keyVersion">): boolean {
  return KEY_ID.test(key.keyId) && Number.isSafeInteger(key.keyVersion) && key.keyVersion > 0;
}

function validIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

async function verifyHmac(secret: string, value: string, signature: string): Promise<boolean> {
  let decoded: Uint8Array;
  try {
    decoded = base64UrlDecode(signature);
  } catch {
    return false;
  }
  const key = await importHmacKey(secret, ["verify"]);
  return await crypto.subtle.verify(
    "HMAC",
    key,
    decoded,
    new TextEncoder().encode(value),
  );
}

async function hmacBase64Url(secret: string, value: string): Promise<string> {
  const key = await importHmacKey(secret, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64Url(new Uint8Array(signature));
}

async function importHmacKey(secret: string, usages: Array<"sign" | "verify">): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sameKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

function validBrand(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{1,63}$/.test(value);
}

function validFrozenEvidence(value: Record<string, unknown>, brandId: string): boolean {
  const approval = value.approval;
  const design = value.design;
  if (
    !isRecord(approval) || !sameKeys(approval, ["approved_at", "client_revision"]) ||
    !isRecord(approval.client_revision) ||
    !sameKeys(approval.client_revision, CLIENT_REVISION_KEYS) ||
    !isRecord(design) || !sameKeys(design, DESIGN_KEYS) ||
    design.schema !== "facet.selection-evidence.v2" || design.brandId !== brandId ||
    !isRecord(design.catalogRevision) || !sameKeys(design.catalogRevision, CATALOG_KEYS) ||
    design.catalogRevision.schema !== "facet.catalog-selection-identities.v1" ||
    !SHA256.test(String(design.catalogRevision.sha256 ?? "")) ||
    !Array.isArray(design.layers) || design.layers.length < 1 || design.layers.length > 64 ||
    !Array.isArray(design.facetOverrides) || design.facetOverrides.length > 2_048 ||
    !Array.isArray(design.trimAccents) || design.trimAccents.length > 64 ||
    typeof design.uniformFinish !== "boolean"
  ) return false;

  const layerIds = new Set<string>();
  let totalXmlBytes = 0;
  for (const layer of design.layers) {
    if (
      !isRecord(layer) || !sameKeys(layer, LAYER_KEYS) ||
      !validLayerId(layer.id) || layerIds.has(layer.id) ||
      typeof layer.visible !== "boolean" ||
      !Number.isSafeInteger(layer.xmlUtf8Bytes) || Number(layer.xmlUtf8Bytes) < 1 ||
      Number(layer.xmlUtf8Bytes) > 16 * 1_024 * 1_024 ||
      !SHA256.test(String(layer.xmlSha256 ?? ""))
    ) return false;
    layerIds.add(layer.id);
    totalXmlBytes += Number(layer.xmlUtf8Bytes);
    if (totalXmlBytes > 64 * 1_024 * 1_024) return false;
  }
  const roof = validSurface(design.roof);
  const wall = validSurface(design.wall);
  if (!roof || !wall || (design.uniformFinish && design.facetOverrides.length !== 0)) return false;
  const overrideIds = new Set<string>();
  for (const override of design.facetOverrides) {
    if (
      !isRecord(override) || !sameKeys(override, OVERRIDE_KEYS) ||
      !validLayerId(override.layerId) || !layerIds.has(override.layerId) ||
      !validLayerId(override.faceId) || !nullableSelection(override.productId) ||
      !nullableSelection(override.colorId) ||
      (override.productId === null && override.colorId === null)
    ) return false;
    const identity = `${override.layerId}:${override.faceId}`;
    if (overrideIds.has(identity)) return false;
    overrideIds.add(identity);
  }
  const trimIds = new Set<string>();
  for (const trim of design.trimAccents) {
    if (
      !isRecord(trim) || !sameKeys(trim, TRIM_KEYS) || !validSelection(trim.id) ||
      trimIds.has(trim.id) || !TRIM_KINDS.has(String(trim.kind ?? "")) ||
      !validSelection(trim.productId) || !validSelection(trim.colorId) ||
      !validQuantity(trim.quantity) || !CANONICAL_UNITS.has(String(trim.canonicalUnit ?? ""))
    ) return false;
    trimIds.add(trim.id);
  }
  const revision = approval.client_revision;
  return validColorRevision(revision.roofColorId, roof) &&
    validColorRevision(revision.wallColorId, wall);
}

function validSurface(value: unknown): { enabled: boolean; colorId: string | null } | null {
  if (!isRecord(value) || !sameKeys(value, SURFACE_KEYS)) return null;
  if (value.productId === null && value.colorId === null) return { enabled: false, colorId: null };
  return validSelection(value.productId) && validSelection(value.colorId)
    ? { enabled: true, colorId: value.colorId }
    : null;
}

function validColorRevision(
  value: unknown,
  surface: { enabled: boolean; colorId: string | null },
): boolean {
  return surface.enabled
    ? value === null || (validSelection(value) && value === surface.colorId)
    : value === null;
}

function validSelection(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function nullableSelection(value: unknown): boolean {
  return value === null || validSelection(value);
}

function validLayerId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function validQuantity(value: unknown): value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 10_000_000)
    return false;
  return /^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/.test(JSON.stringify(value));
}

function failure(
  code: Extract<FacetV2DeliveryVerification, { ok: false }>["code"],
  status: 400 | 401 | 403 | 413 | 415,
): FacetV2DeliveryVerification {
  return { ok: false, code, status };
}
