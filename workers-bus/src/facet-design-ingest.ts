import { sha256Hex } from "./app-auth.ts";
import { FieldActionError, r2ObjectStore } from "./field-actions.ts";

const MAX_BODY_BYTES = 512 * 1024;
const MAX_FROZEN_EVIDENCE_BYTES = 384 * 1024;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const LEGACY_EVENT_TYPE = "facet.design.approved.v1";
const LEGACY_EVENT_SCHEMA_VERSION = 1;
const CUSTOMER_APPROVAL_EVENT_TYPE = "facet.design.customer_approved.v2";
const CUSTOMER_APPROVAL_EVENT_SCHEMA_VERSION = 2;
const LEGACY_EVENT_KEYS = [
  "design_revision",
  "event_id",
  "event_type",
  "frozen_evidence",
  "occurred_at",
  "schema_version",
  "tenant_id",
  "facet_project_id",
] as const;
const CUSTOMER_APPROVAL_EVENT_KEYS = [
  ...LEGACY_EVENT_KEYS,
  "approval_actor_type",
  "brand_id",
  "capability_fingerprint",
] as const;
const CUSTOMER_APPROVAL_EVIDENCE_KEYS = ["approval", "design"] as const;
const CUSTOMER_APPROVAL_KEYS = ["approved_at", "client_revision"] as const;
const CUSTOMER_APPROVAL_FORBIDDEN_KEYS = new Set([
  "address",
  "amount",
  "customeremail",
  "customername",
  "customerphone",
  "estimate",
  "price",
  "projectsharetoken",
  "projectshareurl",
  "propertyaddress",
  "sharetoken",
  "shareurl",
  "subtotal",
  "tax",
  "total",
]);

interface SignedEventHeaders {
  eventId: string;
  timestamp: string;
  nonce: string;
  signature: string;
}

interface FacetDesignEvent {
  kind: "legacy" | "customer_approval";
  eventId: string;
  eventType: typeof LEGACY_EVENT_TYPE | typeof CUSTOMER_APPROVAL_EVENT_TYPE;
  schemaVersion: typeof LEGACY_EVENT_SCHEMA_VERSION | typeof CUSTOMER_APPROVAL_EVENT_SCHEMA_VERSION;
  occurredAt: string;
  sourceTenantId: string;
  facetProjectId: string;
  designRevisionId: string;
  designRevisionSha256: string;
  frozenEvidenceSha256: string;
  brandId: string | null;
  approvalActorType: "customer_capability" | null;
  capabilityFingerprint: string | null;
}

interface FacetDesignReceipt extends Omit<FacetDesignEvent, "sourceTenantId"> {
  tenantId: string;
  rawKey: string;
  rawSha256: string;
  rawContentLength: number;
  receivedAt: string;
}

interface FacetTenantBinding {
  tenantId: string;
  brandIds: ReadonlySet<string>;
}

interface StoredFacetDesignEvent {
  event_id: string;
  event_type: string;
  schema_version: number;
  occurred_at: string;
  tenant_id: string;
  facet_project_id: string;
  design_revision_id: string;
  design_revision_sha256: string;
  frozen_evidence_sha256: string;
  raw_key: string;
  raw_sha256: string;
  raw_content_length: number;
}

interface StoredFacetCustomerApprovalEvent extends StoredFacetDesignEvent {
  brand_id: string;
  approval_actor_type: "customer_capability";
  capability_fingerprint: string;
}

interface FacetDesignAcceptance {
  accepted: true;
  event_id: string;
  status: "received";
  raw_sha256: string;
  frozen_evidence_sha256: string;
  design_revision: {
    id: string;
    sha256: string;
  };
  provenance:
    | { status: "provenance_unknown" }
    | {
      status: "customer_approved";
      brand_id: string;
      approval_actor_type: "customer_capability";
      capability_fingerprint: string;
    };
  idempotent_replay?: true;
}

type ReceiptClaim = "accepted" | "duplicate" | "replay" | "conflict" | "unavailable";

/**
 * Captures an approved Facet design as immutable evidence only. This is deliberately not an
 * estimate, quote, proposal, or contract mutation; the later Frappe projection must consume the
 * anchored D1/R2 receipt rather than the caller's original payload.
 */
export async function handleFacetDesignIngest(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST" || String(env.FACET_DESIGN_INGEST_ENABLED) !== "true") {
    return facetJson({ error: "not_found" }, 404);
  }
  const secret = facetDesignIngestSecret(env);
  const tenantId = configuredTenantId(env);
  const tenantMap = configuredFacetTenantMap(env);
  if (!secret || !tenantId || !tenantMap) return facetJson({ error: "facet_design_ingest_unavailable" }, 503);

  const raw = await readRawJson(req);
  if (!raw.ok) return facetJson({ error: raw.error }, raw.status);

  const headers = signedHeaders(req);
  if (!headers) return facetJson({ error: "invalid_event_headers" }, 400);
  if (!freshTimestamp(headers.timestamp)) return facetJson({ error: "event_timestamp_stale" }, 401);

  const rawSha256 = await sha256Hex(raw.text);
  const expectedSignature = await hmacBase64Url(
    secret,
    `${headers.timestamp}.${headers.nonce}.${rawSha256}`,
  );
  if (!constantTimeEqual(headers.signature, expectedSignature)) {
    return facetJson({ error: "event_signature_invalid" }, 401);
  }

  const event = await parseFacetDesignEvent(raw.text);
  if (!event) return facetJson({ error: "invalid_event_body" }, 400);
  if (event.eventId !== headers.eventId) return facetJson({ error: "event_id_mismatch" }, 400);
  const tenantBinding = tenantMap.get(event.sourceTenantId);
  if (!tenantBinding || tenantBinding.tenantId !== tenantId) {
    return facetJson({ error: "event_tenant_untrusted" }, 403);
  }
  if (event.kind === "customer_approval" && !tenantBinding.brandIds.has(event.brandId!)) {
    return facetJson({ error: "event_brand_untrusted" }, 403);
  }

  const receipt: FacetDesignReceipt = {
    kind: event.kind,
    eventId: event.eventId,
    eventType: event.eventType,
    schemaVersion: event.schemaVersion,
    occurredAt: event.occurredAt,
    tenantId,
    facetProjectId: event.facetProjectId,
    designRevisionId: event.designRevisionId,
    designRevisionSha256: event.designRevisionSha256,
    frozenEvidenceSha256: event.frozenEvidenceSha256,
    brandId: event.brandId,
    approvalActorType: event.approvalActorType,
    capabilityFingerprint: event.capabilityFingerprint,
    rawKey: `facet-design/v${event.schemaVersion}/${event.eventId}.json`,
    rawSha256,
    rawContentLength: raw.bytes,
    receivedAt: new Date().toISOString(),
  };

  // R2 is the first durable write. A failure returns before any D1 receipt/nonce mutation.
  try {
    await r2ObjectStore(env.RAW).ensure(
      receipt.rawKey,
      raw.text,
      "application/json",
      receipt.rawSha256,
    );
  } catch (error) {
    if (error instanceof FieldActionError && error.code === "immutable_object_conflict") {
      return facetJson({ error: "event_id_conflict" }, 409);
    }
    return facetJson({ error: "facet_design_ingest_unavailable" }, 503);
  }

  const claim = event.kind === "legacy"
    ? await claimLegacyReceipt(env, receipt, await sha256Hex(headers.nonce))
    : await claimCustomerApprovalReceipt(env, receipt, await sha256Hex(headers.nonce));
  if (claim === "accepted" || claim === "duplicate") {
    const acceptance = await durableAcceptance(env, receipt, claim === "duplicate");
    if (!acceptance) return facetJson({ error: "facet_design_ingest_unavailable" }, 503);
    return facetJson(acceptance, claim === "accepted" ? 202 : 200);
  }
  if (claim === "replay") return facetJson({ error: "event_replay" }, 409);
  if (claim === "conflict") return facetJson({ error: "event_id_conflict" }, 409);
  return facetJson({ error: "facet_design_ingest_unavailable" }, 503);
}

async function claimLegacyReceipt(env: Env, receipt: FacetDesignReceipt, nonceHash: string): Promise<ReceiptClaim> {
  let existing: StoredFacetDesignEvent | null;
  try {
    if (await getCustomerApprovalReceipt(env, receipt.eventId)) return "conflict";
    existing = await getLegacyReceipt(env, receipt.eventId);
  } catch {
    return "unavailable";
  }
  if (existing) {
    if (!sameLegacyReceipt(existing, receipt)) return "conflict";
    return await claimNonce(env, nonceHash, receipt.eventId, receipt.eventType);
  }

  try {
    const results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO facet_design_events
           (event_id, event_type, schema_version, occurred_at, tenant_id, facet_project_id,
            design_revision_id, design_revision_sha256, frozen_evidence_sha256, raw_key,
            raw_sha256, raw_content_length, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_id) DO NOTHING`,
      ).bind(
        receipt.eventId,
        receipt.eventType,
        receipt.schemaVersion,
        receipt.occurredAt,
        receipt.tenantId,
        receipt.facetProjectId,
        receipt.designRevisionId,
        receipt.designRevisionSha256,
        receipt.frozenEvidenceSha256,
        receipt.rawKey,
        receipt.rawSha256,
        receipt.rawContentLength,
        receipt.receivedAt,
      ),
      env.DB.prepare(
        `INSERT INTO facet_design_ingest_nonce_registry
           (nonce_hash, event_id, event_type, received_at)
         VALUES (?, ?, ?, ?)`,
      ).bind(nonceHash, receipt.eventId, receipt.eventType, receipt.receivedAt),
    ]);
    if (d1Changes(results[0]) === 1) return "accepted";
  } catch {
    try {
      if (await getCustomerApprovalReceipt(env, receipt.eventId)) return "conflict";
      return await getNonce(env, nonceHash) ? "replay" : "unavailable";
    } catch {
      return "unavailable";
    }
  }

  try {
    const concurrent = await getLegacyReceipt(env, receipt.eventId);
    return concurrent && sameLegacyReceipt(concurrent, receipt) ? "duplicate" : "conflict";
  } catch {
    return "unavailable";
  }
}

async function claimCustomerApprovalReceipt(
  env: Env,
  receipt: FacetDesignReceipt,
  nonceHash: string,
): Promise<ReceiptClaim> {
  let existing: StoredFacetCustomerApprovalEvent | null;
  try {
    if (await getLegacyReceipt(env, receipt.eventId)) return "conflict";
    existing = await getCustomerApprovalReceipt(env, receipt.eventId);
  } catch {
    return "unavailable";
  }
  if (existing) {
    if (!sameCustomerApprovalReceipt(existing, receipt)) return "conflict";
    return await claimNonce(env, nonceHash, receipt.eventId, receipt.eventType);
  }

  try {
    const results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO facet_customer_approval_events
           (event_id, event_type, schema_version, occurred_at, tenant_id, brand_id,
            facet_project_id, design_revision_id, design_revision_sha256,
            frozen_evidence_sha256, approval_actor_type, capability_fingerprint, raw_key,
            raw_sha256, raw_content_length, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_id) DO NOTHING`,
      ).bind(
        receipt.eventId,
        receipt.eventType,
        receipt.schemaVersion,
        receipt.occurredAt,
        receipt.tenantId,
        receipt.brandId,
        receipt.facetProjectId,
        receipt.designRevisionId,
        receipt.designRevisionSha256,
        receipt.frozenEvidenceSha256,
        receipt.approvalActorType,
        receipt.capabilityFingerprint,
        receipt.rawKey,
        receipt.rawSha256,
        receipt.rawContentLength,
        receipt.receivedAt,
      ),
      env.DB.prepare(
        `INSERT INTO facet_design_ingest_nonce_registry
           (nonce_hash, event_id, event_type, received_at)
         VALUES (?, ?, ?, ?)`,
      ).bind(nonceHash, receipt.eventId, receipt.eventType, receipt.receivedAt),
    ]);
    if (d1Changes(results[0]) === 1) return "accepted";
  } catch {
    try {
      if (await getLegacyReceipt(env, receipt.eventId)) return "conflict";
      return await getNonce(env, nonceHash) ? "replay" : "unavailable";
    } catch {
      return "unavailable";
    }
  }

  try {
    const concurrent = await getCustomerApprovalReceipt(env, receipt.eventId);
    return concurrent && sameCustomerApprovalReceipt(concurrent, receipt) ? "duplicate" : "conflict";
  } catch {
    return "unavailable";
  }
}

async function claimNonce(
  env: Env,
  nonceHash: string,
  eventId: string,
  eventType: string,
): Promise<"duplicate" | "replay" | "unavailable"> {
  try {
    await env.DB.prepare(
      `INSERT INTO facet_design_ingest_nonce_registry
         (nonce_hash, event_id, event_type, received_at)
       VALUES (?, ?, ?, ?)`,
    ).bind(nonceHash, eventId, eventType, new Date().toISOString()).run();
    return "duplicate";
  } catch {
    try {
      return await getNonce(env, nonceHash) ? "replay" : "unavailable";
    } catch {
      return "unavailable";
    }
  }
}

async function getLegacyReceipt(env: Env, eventId: string): Promise<StoredFacetDesignEvent | null> {
  return await env.DB.prepare(
    `SELECT event_id, event_type, schema_version, occurred_at, tenant_id, facet_project_id,
            design_revision_id, design_revision_sha256, frozen_evidence_sha256, raw_key,
            raw_sha256, raw_content_length
       FROM facet_design_events WHERE event_id = ? LIMIT 1`,
  ).bind(eventId).first<StoredFacetDesignEvent>();
}

async function getCustomerApprovalReceipt(
  env: Env,
  eventId: string,
): Promise<StoredFacetCustomerApprovalEvent | null> {
  return await env.DB.prepare(
    `SELECT event_id, event_type, schema_version, occurred_at, tenant_id, brand_id,
            facet_project_id, design_revision_id, design_revision_sha256,
            frozen_evidence_sha256, approval_actor_type, capability_fingerprint, raw_key,
            raw_sha256, raw_content_length
       FROM facet_customer_approval_events WHERE event_id = ? LIMIT 1`,
  ).bind(eventId).first<StoredFacetCustomerApprovalEvent>();
}

async function getNonce(env: Env, nonceHash: string): Promise<boolean> {
  return !!await env.DB.prepare(
    "SELECT nonce_hash FROM facet_design_ingest_nonce_registry WHERE nonce_hash = ? LIMIT 1",
  ).bind(nonceHash).first<{ nonce_hash: string }>();
}

async function durableAcceptance(
  env: Env,
  receipt: FacetDesignReceipt,
  idempotentReplay: boolean,
): Promise<FacetDesignAcceptance | null> {
  try {
    const stored = receipt.kind === "legacy"
      ? await getLegacyReceipt(env, receipt.eventId)
      : await getCustomerApprovalReceipt(env, receipt.eventId);
    if (!stored) return null;
    return {
      accepted: true,
      event_id: stored.event_id,
      status: "received",
      raw_sha256: stored.raw_sha256,
      frozen_evidence_sha256: stored.frozen_evidence_sha256,
      design_revision: {
        id: stored.design_revision_id,
        sha256: stored.design_revision_sha256,
      },
      provenance: stored.event_type === CUSTOMER_APPROVAL_EVENT_TYPE
        ? {
          status: "customer_approved",
          brand_id: (stored as StoredFacetCustomerApprovalEvent).brand_id,
          approval_actor_type: (stored as StoredFacetCustomerApprovalEvent).approval_actor_type,
          capability_fingerprint: (stored as StoredFacetCustomerApprovalEvent).capability_fingerprint,
        }
        : { status: "provenance_unknown" },
      ...(idempotentReplay ? { idempotent_replay: true } : {}),
    };
  } catch {
    return null;
  }
}

function sameLegacyReceipt(stored: StoredFacetDesignEvent, receipt: FacetDesignReceipt): boolean {
  return stored.event_id === receipt.eventId &&
    stored.event_type === LEGACY_EVENT_TYPE &&
    Number(stored.schema_version) === LEGACY_EVENT_SCHEMA_VERSION &&
    stored.occurred_at === receipt.occurredAt &&
    stored.tenant_id === receipt.tenantId &&
    stored.facet_project_id === receipt.facetProjectId &&
    stored.design_revision_id === receipt.designRevisionId &&
    stored.design_revision_sha256 === receipt.designRevisionSha256 &&
    stored.frozen_evidence_sha256 === receipt.frozenEvidenceSha256 &&
    stored.raw_key === receipt.rawKey &&
    stored.raw_sha256 === receipt.rawSha256 &&
    Number(stored.raw_content_length) === receipt.rawContentLength;
}

function sameCustomerApprovalReceipt(
  stored: StoredFacetCustomerApprovalEvent,
  receipt: FacetDesignReceipt,
): boolean {
  return stored.event_id === receipt.eventId &&
    stored.event_type === CUSTOMER_APPROVAL_EVENT_TYPE &&
    Number(stored.schema_version) === CUSTOMER_APPROVAL_EVENT_SCHEMA_VERSION &&
    stored.occurred_at === receipt.occurredAt &&
    stored.tenant_id === receipt.tenantId &&
    stored.brand_id === receipt.brandId &&
    stored.facet_project_id === receipt.facetProjectId &&
    stored.design_revision_id === receipt.designRevisionId &&
    stored.design_revision_sha256 === receipt.designRevisionSha256 &&
    stored.frozen_evidence_sha256 === receipt.frozenEvidenceSha256 &&
    stored.approval_actor_type === receipt.approvalActorType &&
    stored.capability_fingerprint === receipt.capabilityFingerprint &&
    stored.raw_key === receipt.rawKey &&
    stored.raw_sha256 === receipt.rawSha256 &&
    Number(stored.raw_content_length) === receipt.rawContentLength;
}

async function readRawJson(req: Request): Promise<
  { ok: true; text: string; bytes: number } | { ok: false; error: string; status: number }
> {
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return { ok: false, error: "content_type_required", status: 415 };
  }
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, error: "payload_too_large", status: 413 };
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await req.arrayBuffer());
  } catch {
    return { ok: false, error: "invalid_event_body", status: 400 };
  }
  if (bytes.byteLength > MAX_BODY_BYTES) return { ok: false, error: "payload_too_large", status: 413 };
  try {
    return {
      ok: true,
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
      bytes: bytes.byteLength,
    };
  } catch {
    return { ok: false, error: "invalid_event_body", status: 400 };
  }
}

function signedHeaders(req: Request): SignedEventHeaders | null {
  const eventId = req.headers.get("x-ironwrap-event-id") ?? "";
  const timestamp = req.headers.get("x-ironwrap-event-timestamp") ?? "";
  const nonce = req.headers.get("x-ironwrap-event-nonce") ?? "";
  const signature = req.headers.get("x-ironwrap-event-signature") ?? "";
  if (!validId(eventId) || !/^\d{13}$/.test(timestamp) || !/^[A-Za-z0-9_-]{32,128}$/.test(nonce)) return null;
  return /^[A-Za-z0-9_-]{43}$/.test(signature) ? { eventId, timestamp, nonce, signature } : null;
}

function freshTimestamp(timestamp: string): boolean {
  const milliseconds = Number(timestamp);
  return Number.isSafeInteger(milliseconds) && Math.abs(Date.now() - milliseconds) <= MAX_CLOCK_SKEW_MS;
}

async function parseFacetDesignEvent(raw: string): Promise<FacetDesignEvent | null> {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const legacy = value.event_type === LEGACY_EVENT_TYPE &&
    value.schema_version === LEGACY_EVENT_SCHEMA_VERSION && sameKeys(value, LEGACY_EVENT_KEYS);
  const customerApproval = value.event_type === CUSTOMER_APPROVAL_EVENT_TYPE &&
    value.schema_version === CUSTOMER_APPROVAL_EVENT_SCHEMA_VERSION &&
    sameKeys(value, CUSTOMER_APPROVAL_EVENT_KEYS);
  if (!legacy && !customerApproval) return null;
  const eventId = validId(value.event_id) ? value.event_id : null;
  const occurredAt = validOccurredAt(value.occurred_at) ? value.occurred_at : null;
  const sourceTenantId = validTenantId(value.tenant_id) ? value.tenant_id : null;
  const facetProjectId = validId(value.facet_project_id) ? value.facet_project_id : null;
  const designRevision = parseDesignRevision(value.design_revision);
  if (!eventId || !occurredAt || !sourceTenantId || !facetProjectId || !designRevision || !isRecord(value.frozen_evidence)) {
    return null;
  }
  try {
    const frozenEvidence = canonicalJson(value.frozen_evidence);
    if (!Object.keys(value.frozen_evidence).length || new TextEncoder().encode(frozenEvidence).byteLength > MAX_FROZEN_EVIDENCE_BYTES) {
      return null;
    }
    const design = value.frozen_evidence.design;
    if (!isRecord(design) || !Object.keys(design).length) return null;
    if (customerApproval) {
      if (
        !sameKeys(value.frozen_evidence, CUSTOMER_APPROVAL_EVIDENCE_KEYS) ||
        !isRecord(value.frozen_evidence.approval) ||
        !sameKeys(value.frozen_evidence.approval, CUSTOMER_APPROVAL_KEYS) ||
        value.frozen_evidence.approval.approved_at !== occurredAt ||
        (
          value.frozen_evidence.approval.client_revision !== null &&
          !isRecord(value.frozen_evidence.approval.client_revision)
        ) ||
        containsForbiddenCustomerEvidence(value.frozen_evidence)
      ) return null;
    }
    const designSha256 = await sha256Hex(canonicalJson(design));
    if (
      designRevision.sha256 !== designSha256 ||
      designRevision.id !== `facet-json-v1:${designSha256}`
    ) {
      return null;
    }
    const brandId = customerApproval && validBrandId(value.brand_id) ? value.brand_id : null;
    const approvalActorType = customerApproval && value.approval_actor_type === "customer_capability"
      ? value.approval_actor_type
      : null;
    const capabilityFingerprint = customerApproval && validSha256(value.capability_fingerprint)
      ? value.capability_fingerprint
      : null;
    if (
      customerApproval &&
      (!brandId || design.brandId !== brandId || !approvalActorType || !capabilityFingerprint)
    ) return null;
    return {
      kind: customerApproval ? "customer_approval" : "legacy",
      eventId,
      eventType: customerApproval ? CUSTOMER_APPROVAL_EVENT_TYPE : LEGACY_EVENT_TYPE,
      schemaVersion: customerApproval
        ? CUSTOMER_APPROVAL_EVENT_SCHEMA_VERSION
        : LEGACY_EVENT_SCHEMA_VERSION,
      occurredAt,
      sourceTenantId,
      facetProjectId,
      designRevisionId: designRevision.id,
      designRevisionSha256: designRevision.sha256,
      frozenEvidenceSha256: await sha256Hex(frozenEvidence),
      brandId,
      approvalActorType,
      capabilityFingerprint,
    };
  } catch {
    return null;
  }
}

function parseDesignRevision(value: unknown): { id: string; sha256: string } | null {
  if (!isRecord(value) || !sameKeys(value, ["id", "sha256"])) return null;
  return validId(value.id) && validSha256(value.sha256) ? { id: value.id, sha256: value.sha256 } : null;
}

function facetDesignIngestSecret(env: Env): string | null {
  const secret = env.FACET_DESIGN_INGEST_HMAC_KEY?.trim() ?? "";
  return secret.length >= 32 ? secret : null;
}

function configuredTenantId(env: Env): string | null {
  const tenantId = env.APP_TENANT_ID?.trim() ?? "";
  return validTenantId(tenantId) ? tenantId : null;
}

function configuredFacetTenantMap(env: Env): Map<string, FacetTenantBinding> | null {
  const raw = String(env.FACET_DESIGN_INGEST_TENANT_MAP_JSON ?? "").trim();
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value)) return null;
    const entries = Object.entries(value);
    if (!entries.length) return null;
    const map = new Map<string, FacetTenantBinding>();
    for (const [sourceTenantId, candidate] of entries) {
      if (!validTenantId(sourceTenantId)) return null;
      if (validTenantId(candidate)) {
        map.set(sourceTenantId, { tenantId: candidate, brandIds: new Set() });
        continue;
      }
      if (
        !isRecord(candidate) || !sameKeys(candidate, ["brand_ids", "tenant_id"]) ||
        !validTenantId(candidate.tenant_id) || !Array.isArray(candidate.brand_ids) ||
        !candidate.brand_ids.length || candidate.brand_ids.length > 8
      ) return null;
      const brandIds = new Set<string>();
      for (const brandId of candidate.brand_ids) {
        if (!validBrandId(brandId) || brandIds.has(brandId)) return null;
        brandIds.add(brandId);
      }
      map.set(sourceTenantId, { tenantId: candidate.tenant_id, brandIds });
    }
    return map;
  } catch {
    return null;
  }
}

function containsForbiddenCustomerEvidence(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenCustomerEvidence);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, item]) =>
    CUSTOMER_APPROVAL_FORBIDDEN_KEYS.has(key.replace(/[_-]/g, "").toLowerCase()) ||
    containsForbiddenCustomerEvidence(item)
  );
}

async function hmacBase64Url(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function constantTimeEqual(a: string, b: string): boolean {
  const aa = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (aa.byteLength !== bb.byteLength) return false;
  let diff = 0;
  for (let index = 0; index < aa.length; index += 1) diff |= aa[index]! ^ bb[index]!;
  return diff === 0;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(value);
}

function validTenantId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{1,63}$/.test(value);
}

function validBrandId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{1,31}$/.test(value);
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function validOccurredAt(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("non_finite_json_number");
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("unsupported_json_value");
  return encoded;
}

function d1Changes(result: { meta?: { changes?: number } } | undefined): number {
  return Number(result?.meta?.changes ?? 0);
}

function facetJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
