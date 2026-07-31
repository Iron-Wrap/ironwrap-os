import { randomToken, sha256Hex } from "./app-auth.ts";
import type { AppEnv } from "./app-types.ts";
import { frappeBaseUrl, frappeRequestTimeout } from "./frappe-read.ts";

const MAX_FRAPPE_RESPONSE_BYTES = 64 * 1024;
const PROJECTION_BATCH_SIZE = 25;
// ponytail: D1 allows 100 bindings/query; this CTE uses two per association plus retry clock and
// LIMIT, so keep this config ceiling at 49 (exactly 100 bindings). Chunk only if needed later.
const MAX_PROJECTION_ASSOCIATIONS = 49;
const PROJECTION_METHOD =
  "ironwrap_roofing.facet_design_projection_api.record_facet_design_proposal_evidence";
const PROJECTION_PATH = `/api/method/${PROJECTION_METHOD}`;

interface StoredFacetDesignEvent {
  event_id: string;
  tenant_id: string;
  facet_project_id: string;
  design_revision_id: string;
  design_revision_sha256: string;
  frozen_evidence_sha256: string;
  raw_key: string;
  raw_sha256: string;
  raw_content_length: number;
  occurred_at: string;
  received_at: string;
}

interface FacetProjectionAssociation {
  event_id: string;
  tenant_id: string;
  facet_project_id: string;
  design_revision_id: string;
  design_revision_sha256: string;
  frozen_evidence_sha256: string;
  roof_job_id: string;
  customer_quote_id: string;
}

interface ProjectionSettings {
  hmacKey: string;
  frappeApiKey: string;
  frappeApiSecret: string;
  associations: Map<string, FacetProjectionAssociation>;
  associationSha256: Map<string, string>;
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
 * Sweep only immutable D1 receipts.  The deployment-controlled association allowlist must bind
 * every Facet anchor to one already-existing Frappe Roof Job and Customer Quote; this function
 * never consumes an inbound body, infers identity, creates a quote, changes a price, or publishes
 * a Proposal Evidence Pack.
 */
export async function reconcileFacetDesignFrappeProjections(
  env: Env,
  now = new Date(),
): Promise<void> {
  if (String(env.FACET_DESIGN_FRAPPE_PROJECTION_ENABLED) !== "true") return;
  const settings = await projectionSettings(env);
  if (!settings) throw new Error("facet_design_projection_not_configured");

  const events = await listProjectionCandidates(env, settings, now);
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
  const association = settings.associations.get(event.event_id);
  if (!association) {
    await appendOutcome(env, event, {
      associationSha256: "",
      outcome: "held_missing_association",
      now,
    });
    return;
  }

  const associationSha256 = settings.associationSha256.get(event.event_id);
  if (!associationSha256) throw new Error("facet_design_projection_association_hash_missing");
  if (!associationMatchesEvent(association, event)) {
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
  settings: ProjectionSettings,
  now: Date,
): Promise<StoredFacetDesignEvent[]> {
  const fingerprints = [...settings.associationSha256.entries()];
  const associationRows = fingerprints.length
    ? `VALUES ${fingerprints.map(() => "(?, ?)").join(", ")}`
    : "SELECT NULL, NULL WHERE 0";
  const bindings = fingerprints.flatMap(([eventId, associationSha256]) => [eventId, associationSha256]);
  const result = await env.DB.prepare(
    `WITH configured_associations(event_id, association_sha256) AS (${associationRows}),
     retry_clock(now) AS (VALUES (?)),
     uncertain_attempts AS (
       SELECT event_id, COUNT(*) AS attempt_count, MAX(attempted_at) AS last_attempted_at
       FROM facet_design_projection_attempts
       WHERE outcome = 'uncertain'
       GROUP BY event_id
     )
     SELECT event.event_id, event.tenant_id, event.facet_project_id, event.design_revision_id,
            event.design_revision_sha256,
            frozen_evidence_sha256, raw_key, raw_sha256, raw_content_length, occurred_at, received_at
       FROM facet_design_events AS event
       LEFT JOIN configured_associations AS configured
         ON configured.event_id = event.event_id
       LEFT JOIN uncertain_attempts AS uncertainty
         ON uncertainty.event_id = event.event_id
       WHERE NOT EXISTS (
         SELECT 1
         FROM facet_design_projection_attempts AS attempt
         WHERE attempt.event_id = event.event_id AND attempt.outcome = 'projected'
       )
       AND NOT EXISTS (
         SELECT 1
         FROM facet_design_projection_attempts AS attempt
         WHERE attempt.event_id = event.event_id AND attempt.outcome = 'rejected_frappe'
       )
       AND NOT (
         configured.event_id IS NULL
         AND EXISTS (
           SELECT 1
           FROM facet_design_projection_attempts AS attempt
           WHERE attempt.event_id = event.event_id
             AND attempt.outcome = 'held_missing_association'
         )
       )
       AND NOT (
         configured.event_id IS NOT NULL
         AND EXISTS (
           SELECT 1
           FROM facet_design_projection_attempts AS attempt
           WHERE attempt.event_id = event.event_id
             AND attempt.outcome = 'rejected_association_mismatch'
             AND attempt.association_sha256 = configured.association_sha256
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
  ).bind(...bindings, now.toISOString(), PROJECTION_BATCH_SIZE).all<StoredFacetDesignEvent>();
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
    `INSERT OR IGNORE INTO facet_design_projection_attempts
       (attempt_id, event_id, tenant_id, facet_project_id, design_revision_id,
        design_revision_sha256, frozen_evidence_sha256, raw_key, raw_sha256,
        raw_content_length, occurred_at, received_at, association_sha256, roof_job_id,
        customer_quote_id, outcome, evidence_id, reconciliation_id, error_code, attempted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    `facet-projection-attempt:${crypto.randomUUID()}`,
    event.event_id,
    event.tenant_id,
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
  const claim = {
    event_id: event.event_id,
    tenant_id: event.tenant_id,
    facet_project_id: event.facet_project_id,
    design_revision_id: event.design_revision_id,
    design_revision_sha256: event.design_revision_sha256,
    frozen_evidence_sha256: event.frozen_evidence_sha256,
    raw_key: event.raw_key,
    raw_sha256: event.raw_sha256,
    raw_content_length: Number(event.raw_content_length),
    occurred_at: event.occurred_at,
    received_at: event.received_at,
    roof_job_id: association.roof_job_id,
    customer_quote_id: association.customer_quote_id,
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
    return await validatedProjectionResponse(decoded, event.event_id);
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
  eventId: string,
): Promise<{ evidenceId: string; reconciliationId: string }> {
  if (!isRecord(response) || !isRecord(response.message) || response.message.event_id !== eventId) {
    throw new FrappeProjectionTransportError("frappe_projection_response_invalid_shape");
  }
  const evidenceId = validOpaqueId(response.message.evidence_id) ? response.message.evidence_id : null;
  const reconciliationId = validOpaqueId(response.message.reconciliation_id)
    ? response.message.reconciliation_id
    : null;
  const expectedHash = await sha256Hex(eventId);
  if (
    evidenceId !== `facet-design:${expectedHash}` ||
    reconciliationId !== `facet-design-projection:${expectedHash}`
  ) {
    throw new FrappeProjectionTransportError("frappe_projection_response_anchor_mismatch");
  }
  return { evidenceId, reconciliationId };
}

async function projectionSettings(env: Env): Promise<ProjectionSettings | null> {
  const hmacKey = env.FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY?.trim() ?? "";
  const frappeApiKey = env.FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_KEY?.trim() ?? "";
  const frappeApiSecret = env.FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_SECRET?.trim() ?? "";
  const associations = configuredAssociations(env);
  if (hmacKey.length < 32 || !frappeApiKey || !frappeApiSecret || !associations) return null;
  try {
    frappeBaseUrl(env as AppEnv);
  } catch {
    return null;
  }
  const associationSha256 = new Map<string, string>();
  for (const association of associations.values()) {
    associationSha256.set(association.event_id, await sha256Hex(canonicalJson(association)));
  }
  return { hmacKey, frappeApiKey, frappeApiSecret, associations, associationSha256 };
}

function configuredAssociations(env: Env): Map<string, FacetProjectionAssociation> | null {
  const raw = String(env.FACET_DESIGN_FRAPPE_PROJECTION_ASSOCIATIONS_JSON ?? "").trim();
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || !sameKeys(value, ["schema_version", "associations"])) return null;
    if (
      value.schema_version !== 1 || !Array.isArray(value.associations) ||
      value.associations.length > MAX_PROJECTION_ASSOCIATIONS
    ) return null;
    const associations = new Map<string, FacetProjectionAssociation>();
    for (const candidate of value.associations) {
      const association = parseAssociation(candidate);
      if (!association || associations.has(association.event_id)) return null;
      associations.set(association.event_id, association);
    }
    return associations;
  } catch {
    return null;
  }
}

function parseAssociation(value: unknown): FacetProjectionAssociation | null {
  const keys = [
    "event_id",
    "tenant_id",
    "facet_project_id",
    "design_revision_id",
    "design_revision_sha256",
    "frozen_evidence_sha256",
    "roof_job_id",
    "customer_quote_id",
  ] as const;
  if (!isRecord(value) || !sameKeys(value, keys)) return null;
  const eventId = validEventId(value.event_id) ? value.event_id : null;
  const tenantId = validTenantId(value.tenant_id) ? value.tenant_id : null;
  const facetProjectId = validEventId(value.facet_project_id) ? value.facet_project_id : null;
  const designRevisionId = validEventId(value.design_revision_id) ? value.design_revision_id : null;
  const designRevisionSha256 = validSha256(value.design_revision_sha256)
    ? value.design_revision_sha256
    : null;
  const frozenEvidenceSha256 = validSha256(value.frozen_evidence_sha256)
    ? value.frozen_evidence_sha256
    : null;
  const roofJobId = validOpaqueId(value.roof_job_id) ? value.roof_job_id : null;
  const customerQuoteId = validOpaqueId(value.customer_quote_id) ? value.customer_quote_id : null;
  if (
    !eventId || !tenantId || !facetProjectId || !designRevisionId || !designRevisionSha256 ||
    !frozenEvidenceSha256 || !roofJobId || !customerQuoteId ||
    designRevisionId !== `facet-json-v1:${designRevisionSha256}`
  ) return null;
  return {
    event_id: eventId,
    tenant_id: tenantId,
    facet_project_id: facetProjectId,
    design_revision_id: designRevisionId,
    design_revision_sha256: designRevisionSha256,
    frozen_evidence_sha256: frozenEvidenceSha256,
    roof_job_id: roofJobId,
    customer_quote_id: customerQuoteId,
  };
}

function associationMatchesEvent(
  association: FacetProjectionAssociation,
  event: StoredFacetDesignEvent,
): boolean {
  return association.event_id === event.event_id &&
    association.tenant_id === event.tenant_id &&
    association.facet_project_id === event.facet_project_id &&
    association.design_revision_id === event.design_revision_id &&
    association.design_revision_sha256 === event.design_revision_sha256 &&
    association.frozen_evidence_sha256 === event.frozen_evidence_sha256;
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

function validEventId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(value);
}

function validOpaqueId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,139}$/.test(value);
}

function validTenantId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{1,63}$/.test(value);
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
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
