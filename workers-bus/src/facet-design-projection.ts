import { randomToken, sha256Hex } from "./app-auth.ts";
import type { AppEnv } from "./app-types.ts";
import {
  facetDesignAssociationAnchorSha256,
  type FacetDesignAssociationAnchor,
} from "./facet-design-association.ts";
import { frappeBaseUrl, frappeRequestTimeout } from "./frappe-read.ts";

const MAX_FRAPPE_RESPONSE_BYTES = 64 * 1024;
const PROJECTION_BATCH_SIZE = 25;
const PROJECTION_METHOD =
  "ironwrap_roofing.facet_design_projection_api.record_facet_design_proposal_evidence";
const PROJECTION_PATH = `/api/method/${PROJECTION_METHOD}`;
const RECEIPT_SCHEMA = "ironwrap.facet-design-projection-receipt.v1";
const RECEIPT_SIGNATURE_CONTEXT = "ironwrap.facet-design-projection.receipt.v1";
const PROJECTION_RESPONSE_KEYS = [
  "event_id",
  "evidence_id",
  "idempotent_replay",
  "receipt",
  "receipt_sha256",
  "receipt_signature",
  "receipt_signature_algorithm",
  "reconciliation_id",
] as const;
const PROJECTION_RECEIPT_KEYS = [
  "claim_sha256",
  "commercial_state",
  "customer_quote",
  "customer_quote_id",
  "customer_quote_status",
  "customer_safe",
  "design_revision_id",
  "design_revision_sha256",
  "event_id",
  "event_type",
  "evidence_id",
  "facet_project_id",
  "frozen_evidence_sha256",
  "idempotent_replay",
  "local_payload_hash",
  "occurred_at",
  "provenance",
  "raw_content_length",
  "raw_key",
  "raw_sha256",
  "received_at",
  "reconciliation_id",
  "roof_job",
  "roof_job_brand",
  "roof_job_current_quote",
  "roof_job_id",
  "schema",
  "schema_version",
  "tenant_id",
] as const;
const RECEIPT_CLAIM_ANCHOR_KEYS = [
  "customer_quote_id",
  "design_revision_id",
  "design_revision_sha256",
  "event_id",
  "event_type",
  "facet_project_id",
  "frozen_evidence_sha256",
  "occurred_at",
  "raw_content_length",
  "raw_key",
  "raw_sha256",
  "received_at",
  "roof_job_id",
  "schema_version",
  "tenant_id",
] as const;

interface StoredFacetDesignEvent {
  event_id: string;
  event_type: "facet.design.customer_approved.v2";
  schema_version: 2;
  tenant_id: string;
  brand_id: string;
  approval_actor_type: "customer_capability";
  capability_fingerprint: string;
  identity_assurance: "bearer_capability_only";
  facet_project_id: string;
  design_revision_id: string;
  design_revision_sha256: string;
  frozen_evidence_sha256: string;
  raw_key: string;
  raw_sha256: string;
  raw_content_length: number;
  occurred_at: string;
  received_at: string;
  association_event_id: string | null;
  association_tenant_id: string | null;
  association_brand_id: string | null;
  association_facet_project_id: string | null;
  association_design_revision_id: string | null;
  association_design_revision_sha256: string | null;
  association_frozen_evidence_sha256: string | null;
  roof_job_id: string | null;
  customer_quote_id: string | null;
  association_anchor_sha256: string | null;
}

type FacetProjectionAssociation = FacetDesignAssociationAnchor;

interface ProjectionSettings {
  hmacKey: string;
  frappeApiKey: string;
  frappeApiSecret: string;
}

interface FacetProjectionClaim {
  approval_actor_type: "customer_capability";
  brand_id: string;
  capability_fingerprint: string;
  customer_quote_id: string;
  design_revision_id: string;
  design_revision_sha256: string;
  event_id: string;
  event_type: "facet.design.customer_approved.v2";
  facet_project_id: string;
  frozen_evidence_sha256: string;
  identity_assurance: "bearer_capability_only";
  occurred_at: string;
  raw_content_length: number;
  raw_key: string;
  raw_sha256: string;
  received_at: string;
  roof_job_id: string;
  schema_version: 2;
  tenant_id: string;
}

type ProjectionOutcome =
  | "held_missing_association"
  | "rejected_association_mismatch"
  | "projected"
  | "rejected_frappe"
  | "uncertain";

class FrappeProjectionHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`facet_design_projection_frappe_http_${status}`);
    this.status = status;
  }
}

class FrappeProjectionTransportError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/**
 * Sweep only provenance-bearing customer approvals and their immutable D1 operator associations.
 * This function never consumes an inbound body, infers identity, creates a quote, changes a price,
 * or publishes a Proposal Evidence Pack.
 */
export async function reconcileFacetDesignFrappeProjections(
  env: Env,
  now = new Date(),
): Promise<void> {
  if (String(env.FACET_DESIGN_FRAPPE_PROJECTION_ENABLED) !== "true") return;
  const settings = await projectionSettings(env);
  if (!settings) throw new Error("facet_design_projection_not_configured");

  const events = await listProjectionCandidates(env, now);
  for (const event of events) {
    await reconcileOneProjection(env, settings, event, now);
  }
}

async function reconcileOneProjection(
  env: Env,
  settings: ProjectionSettings,
  event: StoredFacetDesignEvent,
  now: Date,
): Promise<void> {
  const association = associationForEvent(event);
  if (!association) {
    await appendOutcome(env, event, {
      associationSha256: "",
      outcome: "held_missing_association",
      now,
    });
    return;
  }

  const associationSha256 = event.association_anchor_sha256;
  if (!associationSha256) throw new Error("facet_design_projection_association_hash_missing");
  if (
    !associationMatchesEvent(association, event) ||
    await facetDesignAssociationAnchorSha256(association) !== associationSha256
  ) {
    await appendOutcome(env, event, {
      association,
      associationSha256,
      outcome: "rejected_association_mismatch",
      errorCode: "association_anchor_mismatch",
      now,
    });
    return;
  }

  try {
    const projected = await projectToFrappe(env, settings, association, event);
    await appendOutcome(env, event, {
      association,
      associationSha256,
      outcome: "projected",
      evidenceId: projected.evidenceId,
      reconciliationId: projected.reconciliationId,
      now,
    });
  } catch (error) {
    await appendOutcome(env, event, {
      association,
      associationSha256,
      outcome: projectionFailureOutcome(error),
      errorCode: errorCode(error),
      now,
    });
  }
}

async function listProjectionCandidates(
  env: Env,
  now: Date,
): Promise<StoredFacetDesignEvent[]> {
  const result = await env.DB.prepare(
    `WITH retry_clock(now) AS (VALUES (?)),
     uncertain_attempts AS (
       SELECT event_id, COUNT(*) AS attempt_count, MAX(attempted_at) AS last_attempted_at
       FROM facet_customer_approval_projection_attempts
       WHERE outcome = 'uncertain'
       GROUP BY event_id
     )
     SELECT event.event_id, event.event_type, event.schema_version, event.tenant_id,
            event.brand_id, event.approval_actor_type, event.capability_fingerprint,
            event.identity_assurance, event.facet_project_id,
            event.design_revision_id, event.design_revision_sha256,
            event.frozen_evidence_sha256, event.raw_key, event.raw_sha256,
            event.raw_content_length, event.occurred_at, event.received_at,
            association.event_id AS association_event_id,
            association.tenant_id AS association_tenant_id,
            association.brand_id AS association_brand_id,
            association.facet_project_id AS association_facet_project_id,
            association.design_revision_id AS association_design_revision_id,
            association.design_revision_sha256 AS association_design_revision_sha256,
            association.frozen_evidence_sha256 AS association_frozen_evidence_sha256,
            association.roof_job_id, association.customer_quote_id,
            association.association_anchor_sha256
       FROM facet_customer_approval_events AS event
       LEFT JOIN facet_design_evidence_associations AS association
         ON association.event_id = event.event_id
       LEFT JOIN uncertain_attempts AS uncertainty
         ON uncertainty.event_id = event.event_id
       WHERE NOT EXISTS (
         SELECT 1
         FROM facet_customer_approval_projection_attempts AS attempt
         WHERE attempt.event_id = event.event_id AND attempt.outcome = 'projected'
       )
       AND NOT EXISTS (
         SELECT 1
         FROM facet_customer_approval_projection_attempts AS attempt
         WHERE attempt.event_id = event.event_id AND attempt.outcome = 'rejected_frappe'
       )
       AND NOT (
         association.event_id IS NULL
         AND EXISTS (
           SELECT 1
           FROM facet_customer_approval_projection_attempts AS attempt
           WHERE attempt.event_id = event.event_id
             AND attempt.outcome = 'held_missing_association'
         )
       )
       AND NOT (
         association.event_id IS NOT NULL
         AND EXISTS (
           SELECT 1
           FROM facet_customer_approval_projection_attempts AS attempt
           WHERE attempt.event_id = event.event_id
             AND attempt.outcome = 'rejected_association_mismatch'
             AND attempt.association_sha256 = association.association_anchor_sha256
         )
       )
       AND (
         uncertainty.event_id IS NULL
         OR julianday(uncertainty.last_attempted_at) + (
           CASE
             WHEN uncertainty.attempt_count <= 1 THEN 60
             WHEN uncertainty.attempt_count = 2 THEN 300
             WHEN uncertainty.attempt_count = 3 THEN 900
             ELSE 3600
           END / 86400.0
         ) <= julianday((SELECT now FROM retry_clock))
       )
       ORDER BY CASE WHEN uncertainty.event_id IS NULL THEN 0 ELSE 1 END,
                event.occurred_at ASC, event.event_id ASC
       LIMIT ?`,
  ).bind(now.toISOString(), PROJECTION_BATCH_SIZE).all<StoredFacetDesignEvent>();
  return result.results ?? [];
}

function projectionFailureOutcome(error: unknown): "rejected_frappe" | "uncertain" {
  // Only the bounded command's immutable-association conflict is terminal.
  // Auth, role, endpoint, and deployment drift must retry after repair.
  if (error instanceof FrappeProjectionHttpError && error.status === 409)
    return "rejected_frappe";
  return "uncertain";
}

async function appendOutcome(
  env: Env,
  event: StoredFacetDesignEvent,
  input: {
    association?: FacetProjectionAssociation;
    associationSha256: string;
    outcome: ProjectionOutcome;
    evidenceId?: string;
    reconciliationId?: string;
    errorCode?: string;
    now: Date;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO facet_customer_approval_projection_attempts
       (attempt_id, event_id, tenant_id, brand_id, facet_project_id, design_revision_id,
        design_revision_sha256, frozen_evidence_sha256, raw_key, raw_sha256,
        raw_content_length, occurred_at, received_at, association_sha256, roof_job_id,
        customer_quote_id, outcome, evidence_id, reconciliation_id, error_code, attempted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    `facet-projection-attempt:${crypto.randomUUID()}`,
    event.event_id,
    event.tenant_id,
    event.brand_id,
    event.facet_project_id,
    event.design_revision_id,
    event.design_revision_sha256,
    event.frozen_evidence_sha256,
    event.raw_key,
    event.raw_sha256,
    event.raw_content_length,
    event.occurred_at,
    event.received_at,
    input.associationSha256,
    input.association?.roof_job_id ?? null,
    input.association?.customer_quote_id ?? null,
    input.outcome,
    input.evidenceId ?? null,
    input.reconciliationId ?? null,
    input.errorCode ?? null,
    input.now.toISOString(),
  ).run();
}

async function projectToFrappe(
  env: Env,
  settings: ProjectionSettings,
  association: FacetProjectionAssociation,
  event: StoredFacetDesignEvent,
): Promise<{ evidenceId: string; reconciliationId: string }> {
  const claim: FacetProjectionClaim = {
    approval_actor_type: event.approval_actor_type,
    brand_id: event.brand_id,
    capability_fingerprint: event.capability_fingerprint,
    customer_quote_id: association.customer_quote_id,
    design_revision_id: event.design_revision_id,
    design_revision_sha256: event.design_revision_sha256,
    event_id: event.event_id,
    event_type: event.event_type,
    facet_project_id: event.facet_project_id,
    frozen_evidence_sha256: event.frozen_evidence_sha256,
    identity_assurance: event.identity_assurance,
    occurred_at: event.occurred_at,
    raw_content_length: Number(event.raw_content_length),
    raw_key: event.raw_key,
    raw_sha256: event.raw_sha256,
    received_at: event.received_at,
    roof_job_id: association.roof_job_id,
    schema_version: event.schema_version,
    tenant_id: event.tenant_id,
  };
  const claimJson = canonicalJson(claim);
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const nonce = randomToken();
  const signature = await hmacBase64Url(
    settings.hmacKey,
    `POST\n${PROJECTION_PATH}\n${timestamp}\n${nonce}\n${await sha256Hex(claimJson)}`,
  );
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    frappeRequestTimeout((env as AppEnv).APP_FRAPPE_REQUEST_TIMEOUT_MS),
  );
  try {
    const response = await fetch(`${frappeBaseUrl(env as AppEnv)}${PROJECTION_PATH}`, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        authorization: `token ${settings.frappeApiKey}:${settings.frappeApiSecret}`,
        "content-type": "application/json",
        "user-agent": "ironwrap-facet-design-projection/1.0",
        "x-ironwrap-facet-projection-timestamp": timestamp,
        "x-ironwrap-facet-projection-nonce": nonce,
        "x-ironwrap-facet-projection-signature": signature,
      },
      body: JSON.stringify({ facet_claim_json: claimJson }),
    });
    if (!response.ok) throw new FrappeProjectionHttpError(response.status);
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_FRAPPE_RESPONSE_BYTES) {
      throw new FrappeProjectionTransportError("frappe_projection_response_too_large");
    }
    const raw = await response.text();
    if (raw.length > MAX_FRAPPE_RESPONSE_BYTES) {
      throw new FrappeProjectionTransportError("frappe_projection_response_too_large");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw) as unknown;
    } catch {
      throw new FrappeProjectionTransportError("frappe_projection_response_invalid_json");
    }
    return await validatedProjectionResponse(
      decoded,
      claim,
      claimJson,
      settings.hmacKey,
    );
  } catch (error) {
    if (error instanceof FrappeProjectionHttpError || error instanceof FrappeProjectionTransportError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new FrappeProjectionTransportError("frappe_projection_request_timeout");
    }
    throw new FrappeProjectionTransportError("frappe_projection_request_network_error");
  } finally {
    clearTimeout(timer);
  }
}

async function validatedProjectionResponse(
  response: unknown,
  claim: FacetProjectionClaim,
  claimJson: string,
  hmacKey: string,
): Promise<{ evidenceId: string; reconciliationId: string }> {
  if (
    !isRecord(response) || !isRecord(response.message) ||
    !sameKeys(response.message, PROJECTION_RESPONSE_KEYS)
  ) {
    throw new FrappeProjectionTransportError("frappe_projection_response_invalid_shape");
  }
  const message = response.message;
  const evidenceId = validOpaqueId(message.evidence_id) ? message.evidence_id : null;
  const reconciliationId = validOpaqueId(response.message.reconciliation_id)
    ? response.message.reconciliation_id
    : null;
  const expectedHash = await sha256Hex(claim.event_id);
  if (
    message.event_id !== claim.event_id ||
    evidenceId !== `facet-design:${expectedHash}` ||
    reconciliationId !== `facet-design-projection:${expectedHash}`
  ) {
    throw new FrappeProjectionTransportError("frappe_projection_response_anchor_mismatch");
  }
  if (
    typeof message.idempotent_replay !== "boolean" ||
    message.receipt_signature_algorithm !== "HMAC-SHA256" ||
    !validSha256(message.receipt_sha256) ||
    !validSignature(message.receipt_signature) ||
    !isRecord(message.receipt) ||
    !sameKeys(message.receipt, PROJECTION_RECEIPT_KEYS)
  ) {
    throw new FrappeProjectionTransportError("frappe_projection_response_invalid_receipt");
  }
  const receipt = message.receipt;
  const receiptSha256 = await sha256Hex(canonicalJson(receipt));
  const expectedSignature = await hmacBase64Url(
    hmacKey,
    `${RECEIPT_SIGNATURE_CONTEXT}\n${receiptSha256}`,
  );
  if (
    !constantTimeEqual(message.receipt_sha256, receiptSha256) ||
    !constantTimeEqual(message.receipt_signature, expectedSignature)
  ) {
    throw new FrappeProjectionTransportError("frappe_projection_response_signature_mismatch");
  }
  if (
    receipt.schema !== RECEIPT_SCHEMA ||
    receipt.claim_sha256 !== await sha256Hex(claimJson) ||
    receipt.evidence_id !== evidenceId ||
    receipt.reconciliation_id !== reconciliationId ||
    receipt.idempotent_replay !== message.idempotent_replay ||
    receipt.commercial_state !== "none" ||
    receipt.customer_safe !== false ||
    !validOpaqueId(receipt.roof_job) ||
    !validOpaqueId(receipt.customer_quote) ||
    receipt.roof_job_brand !== claim.brand_id ||
    receipt.roof_job_current_quote !== receipt.customer_quote ||
    receipt.customer_quote_status !== "Approved" ||
    !validSha256(receipt.local_payload_hash)
  ) {
    throw new FrappeProjectionTransportError("frappe_projection_response_receipt_mismatch");
  }
  for (const key of RECEIPT_CLAIM_ANCHOR_KEYS) {
    if (receipt[key] !== claim[key]) {
      throw new FrappeProjectionTransportError("frappe_projection_response_receipt_mismatch");
    }
  }
  if (
    !isRecord(receipt.provenance) ||
    !sameKeys(receipt.provenance, [
      "approval_actor_type",
      "brand_id",
      "capability_fingerprint",
      "identity_assurance",
      "status",
    ]) ||
    receipt.provenance.status !== "customer_approved" ||
    receipt.provenance.brand_id !== claim.brand_id ||
    receipt.provenance.approval_actor_type !== claim.approval_actor_type ||
    receipt.provenance.capability_fingerprint !== claim.capability_fingerprint ||
    receipt.provenance.identity_assurance !== claim.identity_assurance
  ) {
    throw new FrappeProjectionTransportError("frappe_projection_response_provenance_mismatch");
  }
  return { evidenceId, reconciliationId };
}

async function projectionSettings(env: Env): Promise<ProjectionSettings | null> {
  const hmacKey = env.FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY?.trim() ?? "";
  const frappeApiKey = env.FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_KEY?.trim() ?? "";
  const frappeApiSecret = env.FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_SECRET?.trim() ?? "";
  if (hmacKey.length < 32 || !frappeApiKey || !frappeApiSecret) return null;
  try {
    frappeBaseUrl(env as AppEnv);
  } catch {
    return null;
  }
  return { hmacKey, frappeApiKey, frappeApiSecret };
}

function associationMatchesEvent(
  association: FacetProjectionAssociation,
  event: StoredFacetDesignEvent,
): boolean {
  return association.event_id === event.event_id &&
    association.tenant_id === event.tenant_id &&
    association.brand_id === event.brand_id &&
    association.facet_project_id === event.facet_project_id &&
    association.design_revision_id === event.design_revision_id &&
    association.design_revision_sha256 === event.design_revision_sha256 &&
    association.frozen_evidence_sha256 === event.frozen_evidence_sha256;
}

function associationForEvent(
  event: StoredFacetDesignEvent,
): FacetProjectionAssociation | null {
  if (
    !event.association_event_id || !event.association_tenant_id ||
    !event.association_brand_id || !event.association_facet_project_id ||
    !event.association_design_revision_id ||
    !event.association_design_revision_sha256 ||
    !event.association_frozen_evidence_sha256 || !event.roof_job_id ||
    !event.customer_quote_id
  ) return null;
  return {
    event_id: event.association_event_id,
    tenant_id: event.association_tenant_id,
    brand_id: event.association_brand_id,
    facet_project_id: event.association_facet_project_id,
    design_revision_id: event.association_design_revision_id,
    design_revision_sha256: event.association_design_revision_sha256,
    frozen_evidence_sha256: event.association_frozen_evidence_sha256,
    roof_job_id: event.roof_job_id,
    customer_quote_id: event.customer_quote_id,
  };
}

async function hmacBase64Url(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64Url(new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  )));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function errorCode(error: unknown): string {
  if (error instanceof FrappeProjectionHttpError) return `frappe_http_${error.status}`;
  if (error instanceof FrappeProjectionTransportError) return error.code;
  return "facet_design_projection_unexpected_error";
}

function validOpaqueId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,139}$/.test(value);
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function validSignature(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index]! ^ b[index]!;
  return difference === 0;
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
