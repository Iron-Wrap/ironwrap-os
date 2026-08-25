import { sha256Hex } from "./app-auth.ts";
import type { AppEnv, AppRole } from "./app-types.ts";
import { r2ObjectStore } from "./field-actions.ts";
import {
  facetLaunchConfigForTenant,
  facetLaunchIntentSha256,
  resolveFacetLaunchTarget,
  signFacetLaunchV1Token,
  type FacetLaunchConfig,
} from "./facet-launch.ts";
import {
  facetV2ExternalLinkIds,
  facetV2ProducerIdentityLink,
  registerFacetV2LaunchAuthority,
  type FacetV2LaunchAuthorityRegistration,
  type FacetV2ProducerIdentityLink,
} from "./facet-v2-authority.ts";
import {
  facetV2ConsumerConfig,
  facetV2StaticRoutes,
} from "./facet-design-ingest.ts";
import {
  FACET_ESTIMATOR_READY_EVENT_SCHEMA_VERSION,
  FACET_ESTIMATOR_READY_EVENT_TYPE,
  canonicalJson,
  parseFacetEstimatorReadyEvent,
  signFacetEstimatorReadyReceipt,
  verifyFacetV2Delivery,
  type FacetEstimatorReadyEvent,
  type FacetEstimatorReadyReceipt,
  type FacetV2StaticRoute,
  type FacetV2VerificationKey,
  type SignedFacetEstimatorReadyReceipt,
} from "./facet-design-v2-protocol.ts";
import {
  readNativeJobCore,
} from "./native-job-packet-read.ts";

const READY_MAX_BODY_BYTES = 512 * 1024;
const READY_POLICY_VERSION = "ironwrap-facet-estimator-consumer-v1";
const CUSTOMER_PARTY_CONTEXT = "ironwrap.customer-party.email.v1";
const CUSTOMER_IDENTITY_CONTEXT = "facet.customer-oidc-email.v1";
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;
const RAW_IDEMPOTENCY = /^[A-Za-z0-9._:-]{8,140}$/;

export class FacetPrequoteError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status = 409) {
    super(code);
    this.name = "FacetPrequoteError";
    this.code = code;
    this.status = status;
  }
}

export interface FacetPrequoteLaunchInput {
  tenantId: string;
  jobName: string;
  actorUserId: string;
  actorRole: AppRole;
  idempotencyKey: string;
  now?: Date;
  projectId?: string;
}

export type FacetPrequoteLaunchResult =
  | {
      kind: "created" | "replayed";
      launch: {
        facet_project_id: string;
        launch_url: string;
        expires_at: string;
        state: "issued";
        commercial_quote_revision_id: null;
      };
    }
  | {
      kind: "rejected";
      code: string;
      status: 403 | 404 | 409 | 503;
    };

export interface FacetEstimatorReadyAnchor {
  event_id: string;
  event_body_sha256: string;
  event_type: typeof FACET_ESTIMATOR_READY_EVENT_TYPE;
  schema_version: typeof FACET_ESTIMATOR_READY_EVENT_SCHEMA_VERSION;
  issuer: string;
  source_product: "facet";
  source_environment: string;
  source_tenant_id: string;
  destination_tenant_id: string;
  brand_id: string;
  facet_project_id: string;
  external_project_link_id: string;
  producer_identity_link_id: string;
  roof_job_id: string;
  customer_id: string;
  actor_identity_ref: string;
  actor_type: "owner" | "expert";
  oidc_issuer: string;
  oidc_subject_sha256: string;
  previous_event_id: string | null;
  design_revision_id: string;
  design_revision_sha256: string;
  frozen_evidence_sha256: string;
  raw_key: string;
  raw_content_length: number;
  occurred_at: string;
  received_at: string;
  customer_party_ref: string;
  external_customer_identity_link_id: string;
  association_sha256: string;
  project_claim_sha256: string;
  producer_identity_proof_sha256: string;
  issued_by_user_id: string;
  launch_intent_sha256: string;
  launch_envelope_sha256: string;
  launch_idempotency_key_sha256: string;
  launch_issued_at: number;
  launch_not_before: number;
  launch_expires_at: number;
  launch_created_at: string;
}

export interface FacetEstimatorPromotionInput {
  tenantId: string;
  roofJobId: string;
  estimatorReadyEventId: string;
  estimatorRevisionId: string;
  commercialQuoteRevisionId: string;
  actorUserId: string;
  actorRole: AppRole;
  idempotencyKey: string;
  now?: Date;
}

export type FacetEstimatorPromotionResult =
  | {
      kind: "created" | "replayed";
      promotion: {
        promotion_id: string;
        event_id: string;
        estimator_revision_id: string;
        facet_project_id: string;
        external_project_link_id: string;
        commercial_quote_revision_id: string;
        promoted_at: string;
      };
    }
  | { kind: "rejected"; code: string; status: 403 | 404 | 409 | 503 };

interface PrequoteTarget {
  brandId: string;
  roofJobId: string;
  customerId: string;
  customerPartyRef: string;
  externalCustomerIdentityLinkId: string;
}

interface StoredPrequoteLaunch {
  facet_project_id: string;
  external_project_link_id: string;
  destination_tenant_id: string;
  source_tenant_id: string;
  brand_id: string;
  roof_job_id: string;
  customer_id: string;
  customer_party_ref: string;
  external_customer_identity_link_id: string;
  issued_by_user_id: string;
  idempotency_key_sha256: string;
  launch_intent_sha256: string;
  launch_envelope_sha256: string;
  issued_at: number;
  not_before: number;
  expires_at: number;
  created_at: string;
}

interface StoredPrequoteLink extends StoredPrequoteLaunch {
  producer_identity_link_id: string;
  project_claim_sha256: string;
  association_sha256: string;
}

interface StoredReadyReceiptEnvelope {
  receipt_json: string;
  receipt_sha256: string;
  signature_algorithm: "HMAC-SHA256";
  signature_key_id: string;
  signature_key_version: number;
  signature_value: string;
}

interface StoredPromotion {
  promotion_id: string;
  event_id: string;
  estimator_revision_id: string;
  facet_project_id: string;
  external_project_link_id: string;
  destination_tenant_id: string;
  roof_job_id: string;
  customer_id: string;
  customer_quote_id: string;
  quote_revision_id: string;
  quote_version: number;
  quote_approved_at: string;
  proposal_revision_id: string;
  proposal_pack_id: string;
  publication_event_id: string;
  acceptance_binding_id: string;
  acceptance_id: string;
  acceptance_receipt_hash: string;
  accepted_at: string;
  promoted_by_user_id: string;
  idempotency_key_sha256: string;
  promotion_intent_sha256: string;
  promotion_anchor_sha256: string;
  promoted_at: string;
}

/**
 * Issue the existing Facet launch v1 envelope against a quote-free, append-only authority.
 * The JWT remains the minimal project-create envelope; commercial quote facts never enter it.
 */
export async function issueFacetPrequoteLaunch(
  env: AppEnv,
  input: FacetPrequoteLaunchInput,
): Promise<FacetPrequoteLaunchResult> {
  if (input.actorRole !== "owner") return rejected("facet_prequote_owner_required", 403);
  const config = facetLaunchConfigForTenant(env, input.tenantId);
  if (!config) return rejected("facet_launch_not_configured", 503);
  if (!RAW_IDEMPOTENCY.test(input.idempotencyKey)) {
    return rejected("facet_prequote_idempotency_conflict", 409);
  }
  const target = await readPrequoteTarget(env, input.tenantId, input.jobName);
  if (!target.ok) return rejected(target.code, target.status);
  const idempotencyKeySha256 = await sha256Hex(
    `${input.tenantId}\nfacet-prequote\n${input.idempotencyKey}`,
  );
  const existing = await first<StoredPrequoteLaunch>(
    env,
    `SELECT * FROM facet_v2_prequote_project_launches
      WHERE idempotency_key_sha256 = ? LIMIT 1`,
    idempotencyKeySha256,
  );
  if (existing) {
    return await replayPrequoteLaunch(
      env,
      config,
      target.value,
      existing,
      input.actorUserId,
      input.projectId,
    );
  }

  const issuedAt = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const facetProjectId = input.projectId ?? crypto.randomUUID();
  if (!Number.isSafeInteger(issuedAt) || !UUID_V4.test(facetProjectId)) {
    return rejected("facet_prequote_authority_collision", 409);
  }
  const times = {
    issuedAt,
    notBefore: issuedAt,
    expiresAt: issuedAt + 10 * 60,
  };
  const identity = await facetV2ProducerIdentityLink(env, {
    destinationTenantId: input.tenantId,
    sourceTenantId: config.sourceTenantId,
  });
  if (identity && !identityMatchesConfig(identity, config)) {
    return rejected("facet_prequote_authority_collision", 409);
  }
  const token = await signFacetLaunchV1Token(config.key, {
    brandId: target.value.brandId,
    customerPartyRef: target.value.customerPartyRef,
    expiresAt: times.expiresAt,
    externalCustomerIdentityLinkId: target.value.externalCustomerIdentityLinkId,
    issuedAt: times.issuedAt,
    destinationTenantId: input.tenantId,
    facetProjectId,
    notBefore: times.notBefore,
    sourceTenantId: config.sourceTenantId,
  });
  const launchEnvelopeSha256 = await sha256Hex(token);
  const producerIdentityProofSha256 = identity?.proofSha256 ?? launchEnvelopeSha256;
  const ids = await facetV2ExternalLinkIds({
    destinationTenantId: input.tenantId,
    brandId: target.value.brandId,
    facetProjectId,
    projectClaimSha256: launchEnvelopeSha256,
    sourceTenantId: config.sourceTenantId,
    producerIdentityProofSha256,
  });
  const launchIntentSha256 = await sha256Hex(canonicalJson({
    brand_id: target.value.brandId,
    customer_id: target.value.customerId,
    customer_party_ref: target.value.customerPartyRef,
    destination_tenant_id: input.tenantId,
    external_customer_identity_link_id: target.value.externalCustomerIdentityLinkId,
    facet_project_id: facetProjectId,
    issued_by_user_id: input.actorUserId,
    roof_job_id: target.value.roofJobId,
    source_tenant_id: config.sourceTenantId,
  }));
  const createdAt = new Date(issuedAt * 1000).toISOString();
  const associationSha256 = await prequoteAssociationSha256({
    destinationTenantId: input.tenantId,
    sourceTenantId: config.sourceTenantId,
    brandId: target.value.brandId,
    facetProjectId,
    customerId: target.value.customerId,
    customerPartyRef: target.value.customerPartyRef,
    externalCustomerIdentityLinkId: target.value.externalCustomerIdentityLinkId,
    roofJobId: target.value.roofJobId,
    externalProjectLinkId: ids.externalProjectLinkId,
    producerIdentityLinkId: ids.producerIdentityLinkId,
  });
  const launchBindings = [
    facetProjectId,
    ids.externalProjectLinkId,
    input.tenantId,
    config.sourceTenantId,
    target.value.brandId,
    target.value.roofJobId,
    target.value.customerId,
    target.value.customerPartyRef,
    target.value.externalCustomerIdentityLinkId,
    input.actorUserId,
    idempotencyKeySha256,
    launchIntentSha256,
    launchEnvelopeSha256,
    times.issuedAt,
    times.notBefore,
    times.expiresAt,
    createdAt,
  ] as const;
  const exactLaunchPredicate = `facet_project_id = ? AND external_project_link_id = ?
    AND destination_tenant_id = ? AND source_tenant_id = ? AND brand_id = ?
    AND roof_job_id = ? AND customer_id = ? AND customer_party_ref = ?
    AND external_customer_identity_link_id = ? AND issued_by_user_id = ?
    AND idempotency_key_sha256 = ? AND launch_intent_sha256 = ?
    AND launch_envelope_sha256 = ? AND issued_at = ? AND not_before = ?
    AND expires_at = ? AND created_at = ?`;
  let batchResult: D1Result[];
  try {
    batchResult = await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO facet_v2_prequote_project_launches
         (facet_project_id, external_project_link_id, destination_tenant_id, source_tenant_id,
          brand_id, roof_job_id, customer_id, customer_party_ref,
          external_customer_identity_link_id, issued_by_user_id, idempotency_key_sha256,
          launch_intent_sha256, launch_envelope_sha256, issued_at, not_before, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(...launchBindings),
      env.DB.prepare(
        `INSERT OR IGNORE INTO facet_v2_producer_identity_links
         (producer_identity_link_id, destination_tenant_id, source_tenant_id, issuer,
          source_product, source_environment, proof_sha256, created_from_project_id, created_at)
         SELECT ?, ?, ?, ?, 'facet', ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM facet_v2_prequote_project_launches WHERE ${exactLaunchPredicate}
          )`,
      ).bind(
        ids.producerIdentityLinkId,
        input.tenantId,
        config.sourceTenantId,
        config.issuer,
        config.sourceEnvironment,
        producerIdentityProofSha256,
        facetProjectId,
        createdAt,
        ...launchBindings,
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO facet_v2_prequote_project_links
         (external_project_link_id, producer_identity_link_id, destination_tenant_id,
          source_tenant_id, brand_id, facet_project_id, customer_id, customer_party_ref,
          external_customer_identity_link_id, roof_job_id, project_claim_sha256,
          association_sha256, created_by_user_id, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           FROM facet_v2_producer_identity_links AS identity
          WHERE identity.producer_identity_link_id = ?
            AND identity.destination_tenant_id = ?
            AND identity.source_tenant_id = ?
            AND identity.issuer = ?
            AND identity.source_product = 'facet'
            AND identity.source_environment = ?
            AND identity.proof_sha256 = ?
            AND EXISTS (
              SELECT 1 FROM facet_v2_prequote_project_launches WHERE ${exactLaunchPredicate}
            )`,
      ).bind(
        ids.externalProjectLinkId,
        ids.producerIdentityLinkId,
        input.tenantId,
        config.sourceTenantId,
        target.value.brandId,
        facetProjectId,
        target.value.customerId,
        target.value.customerPartyRef,
        target.value.externalCustomerIdentityLinkId,
        target.value.roofJobId,
        launchEnvelopeSha256,
        associationSha256,
        input.actorUserId,
        createdAt,
        ids.producerIdentityLinkId,
        input.tenantId,
        config.sourceTenantId,
        config.issuer,
        config.sourceEnvironment,
        producerIdentityProofSha256,
        ...launchBindings,
      ),
    ]);
  } catch {
    const raced = await first<StoredPrequoteLaunch>(
      env,
      `SELECT * FROM facet_v2_prequote_project_launches
        WHERE idempotency_key_sha256 = ? LIMIT 1`,
      idempotencyKeySha256,
    );
    if (raced) {
      return await replayPrequoteLaunch(
        env,
        config,
        target.value,
        raced,
        input.actorUserId,
        input.projectId,
      );
    }
    return rejected("facet_prequote_authority_collision", 409);
  }
  const stored = await first<StoredPrequoteLaunch>(
    env,
    `SELECT * FROM facet_v2_prequote_project_launches
      WHERE idempotency_key_sha256 = ? LIMIT 1`,
    idempotencyKeySha256,
  );
  if (!stored) return rejected("facet_prequote_authority_write_failed", 503);
  if (Number(batchResult[0]?.meta?.changes ?? 0) !== 1) {
    return await replayPrequoteLaunch(
      env,
      config,
      target.value,
      stored,
      input.actorUserId,
      input.projectId,
    );
  }
  if (!await prequoteAuthorityMatches(env, config, target.value, {
    stored,
    actorUserId: input.actorUserId,
    facetProjectId,
    externalProjectLinkId: ids.externalProjectLinkId,
    producerIdentityLinkId: ids.producerIdentityLinkId,
    producerIdentityProofSha256,
    idempotencyKeySha256,
    launchIntentSha256,
    launchEnvelopeSha256,
    issuedAt: times.issuedAt,
    notBefore: times.notBefore,
    expiresAt: times.expiresAt,
    createdAt,
  })) return rejected("facet_prequote_authority_collision", 409);
  return prequoteProjection(config, stored.facet_project_id, token, stored.expires_at, false);
}

async function replayPrequoteLaunch(
  env: AppEnv,
  config: FacetLaunchConfig,
  target: PrequoteTarget,
  stored: StoredPrequoteLaunch,
  actorUserId: string,
  requestedProjectId?: string,
): Promise<FacetPrequoteLaunchResult> {
  if (
    stored.destination_tenant_id !== config.destinationTenantId ||
    stored.source_tenant_id !== config.sourceTenantId ||
    stored.brand_id !== target.brandId || stored.roof_job_id !== target.roofJobId ||
    stored.customer_id !== target.customerId ||
    stored.customer_party_ref !== target.customerPartyRef ||
    stored.external_customer_identity_link_id !== target.externalCustomerIdentityLinkId ||
    stored.issued_by_user_id !== actorUserId ||
    (requestedProjectId !== undefined && stored.facet_project_id !== requestedProjectId)
  ) return rejected("facet_prequote_idempotency_conflict", 409);
  const identity = await facetV2ProducerIdentityLink(env, {
    destinationTenantId: config.destinationTenantId,
    sourceTenantId: config.sourceTenantId,
  });
  if (!identity || !identityMatchesConfig(identity, config)) {
    return rejected("facet_prequote_authority_collision", 409);
  }
  const token = await signFacetLaunchV1Token(config.key, {
    brandId: target.brandId,
    customerPartyRef: target.customerPartyRef,
    expiresAt: stored.expires_at,
    externalCustomerIdentityLinkId: target.externalCustomerIdentityLinkId,
    issuedAt: stored.issued_at,
    destinationTenantId: stored.destination_tenant_id,
    facetProjectId: stored.facet_project_id,
    notBefore: stored.not_before,
    sourceTenantId: stored.source_tenant_id,
  });
  if ((await sha256Hex(token)) !== stored.launch_envelope_sha256) {
    return rejected("facet_prequote_authority_collision", 409);
  }
  const ids = await facetV2ExternalLinkIds({
    destinationTenantId: stored.destination_tenant_id,
    brandId: stored.brand_id,
    facetProjectId: stored.facet_project_id,
    projectClaimSha256: stored.launch_envelope_sha256,
    sourceTenantId: stored.source_tenant_id,
    producerIdentityProofSha256: identity.proofSha256,
  });
  if (!await prequoteAuthorityMatches(env, config, target, {
    stored,
    actorUserId: stored.issued_by_user_id,
    facetProjectId: stored.facet_project_id,
    externalProjectLinkId: ids.externalProjectLinkId,
    producerIdentityLinkId: ids.producerIdentityLinkId,
    producerIdentityProofSha256: identity.proofSha256,
    idempotencyKeySha256: stored.idempotency_key_sha256,
    launchIntentSha256: stored.launch_intent_sha256,
    launchEnvelopeSha256: stored.launch_envelope_sha256,
    issuedAt: stored.issued_at,
    notBefore: stored.not_before,
    expiresAt: stored.expires_at,
    createdAt: stored.created_at,
  })) return rejected("facet_prequote_authority_collision", 409);
  return prequoteProjection(config, stored.facet_project_id, token, stored.expires_at, true);
}

async function prequoteAuthorityMatches(
  env: AppEnv,
  config: FacetLaunchConfig,
  target: PrequoteTarget,
  input: {
    stored: StoredPrequoteLaunch;
    actorUserId: string;
    facetProjectId: string;
    externalProjectLinkId: string;
    producerIdentityLinkId: string;
    producerIdentityProofSha256: string;
    idempotencyKeySha256: string;
    launchIntentSha256: string;
    launchEnvelopeSha256: string;
    issuedAt: number;
    notBefore: number;
    expiresAt: number;
    createdAt: string;
  },
): Promise<boolean> {
  const stored = input.stored;
  if (
    stored.facet_project_id !== input.facetProjectId ||
    stored.external_project_link_id !== input.externalProjectLinkId ||
    stored.destination_tenant_id !== config.destinationTenantId ||
    stored.source_tenant_id !== config.sourceTenantId ||
    stored.brand_id !== target.brandId ||
    stored.roof_job_id !== target.roofJobId ||
    stored.customer_id !== target.customerId ||
    stored.customer_party_ref !== target.customerPartyRef ||
    stored.external_customer_identity_link_id !== target.externalCustomerIdentityLinkId ||
    stored.issued_by_user_id !== input.actorUserId ||
    stored.idempotency_key_sha256 !== input.idempotencyKeySha256 ||
    stored.launch_intent_sha256 !== input.launchIntentSha256 ||
    stored.launch_envelope_sha256 !== input.launchEnvelopeSha256 ||
    Number(stored.issued_at) !== input.issuedAt ||
    Number(stored.not_before) !== input.notBefore ||
    Number(stored.expires_at) !== input.expiresAt ||
    stored.created_at !== input.createdAt
  ) return false;
  const link = await first<StoredPrequoteLink & {
    created_by_user_id: string;
    identity_issuer: string;
    identity_source_product: string;
    identity_source_environment: string;
    identity_source_tenant_id: string;
    identity_destination_tenant_id: string;
    identity_proof_sha256: string;
  }>(
    env,
    `SELECT link.*, identity.issuer AS identity_issuer,
            identity.source_product AS identity_source_product,
            identity.source_environment AS identity_source_environment,
            identity.source_tenant_id AS identity_source_tenant_id,
            identity.destination_tenant_id AS identity_destination_tenant_id,
            identity.proof_sha256 AS identity_proof_sha256
       FROM facet_v2_prequote_project_links AS link
       JOIN facet_v2_producer_identity_links AS identity
         ON identity.producer_identity_link_id = link.producer_identity_link_id
      WHERE link.external_project_link_id = ? LIMIT 1`,
    input.externalProjectLinkId,
  );
  if (!link) return false;
  const associationSha256 = await prequoteAssociationSha256({
    destinationTenantId: config.destinationTenantId,
    sourceTenantId: config.sourceTenantId,
    brandId: target.brandId,
    facetProjectId: input.facetProjectId,
    customerId: target.customerId,
    customerPartyRef: target.customerPartyRef,
    externalCustomerIdentityLinkId: target.externalCustomerIdentityLinkId,
    roofJobId: target.roofJobId,
    externalProjectLinkId: input.externalProjectLinkId,
    producerIdentityLinkId: input.producerIdentityLinkId,
  });
  return (
    link.producer_identity_link_id === input.producerIdentityLinkId &&
    link.destination_tenant_id === config.destinationTenantId &&
    link.source_tenant_id === config.sourceTenantId &&
    link.brand_id === target.brandId &&
    link.facet_project_id === input.facetProjectId &&
    link.customer_id === target.customerId &&
    link.customer_party_ref === target.customerPartyRef &&
    link.external_customer_identity_link_id === target.externalCustomerIdentityLinkId &&
    link.roof_job_id === target.roofJobId &&
    link.project_claim_sha256 === input.launchEnvelopeSha256 &&
    link.association_sha256 === associationSha256 &&
    link.created_by_user_id === input.actorUserId &&
    link.identity_issuer === config.issuer &&
    link.identity_source_product === "facet" &&
    link.identity_source_environment === config.sourceEnvironment &&
    link.identity_source_tenant_id === config.sourceTenantId &&
    link.identity_destination_tenant_id === config.destinationTenantId &&
    link.identity_proof_sha256 === input.producerIdentityProofSha256
  );
}

function prequoteProjection(
  config: FacetLaunchConfig,
  facetProjectId: string,
  token: string,
  expiresAt: number,
  replayed: boolean,
): Extract<FacetPrequoteLaunchResult, { kind: "created" | "replayed" }> {
  return {
    kind: replayed ? "replayed" : "created",
    launch: {
      facet_project_id: facetProjectId,
      launch_url: `${config.baseUrl}#iwlaunch=${token}`,
      expires_at: new Date(expiresAt * 1000).toISOString(),
      state: "issued",
      commercial_quote_revision_id: null,
    },
  };
}

/** Resolve only an accepted, current estimator-ready event and its quote-free authority. */
export async function resolveFacetEstimatorReadyAnchor(
  env: AppEnv,
  tenantId: string,
  roofJobId: string,
  eventId: string,
): Promise<FacetEstimatorReadyAnchor | null> {
  if (!env.DB || !IDENTIFIER.test(eventId)) return null;
  const row = await first<FacetEstimatorReadyAnchor>(
    env,
    `SELECT event.event_id, event.event_body_sha256, event.event_type,
            event.schema_version, event.issuer, event.source_product,
            event.source_environment, event.source_tenant_id,
            event.destination_tenant_id, event.brand_id, event.facet_project_id,
            event.external_project_link_id, event.producer_identity_link_id,
            event.roof_job_id, event.customer_id, event.actor_identity_ref,
            event.actor_type, event.oidc_issuer, event.oidc_subject_sha256,
            event.previous_event_id, event.design_revision_id,
            event.design_revision_sha256, event.frozen_evidence_sha256,
            event.raw_key, event.raw_content_length, event.occurred_at,
            event.received_at, link.customer_party_ref,
            link.external_customer_identity_link_id, link.association_sha256,
            link.project_claim_sha256, identity.proof_sha256 AS producer_identity_proof_sha256,
            launch.issued_by_user_id, launch.launch_intent_sha256,
            launch.launch_envelope_sha256,
            launch.idempotency_key_sha256 AS launch_idempotency_key_sha256,
            launch.issued_at AS launch_issued_at, launch.not_before AS launch_not_before,
            launch.expires_at AS launch_expires_at, launch.created_at AS launch_created_at
       FROM facet_v2_estimator_ready_events AS event
       JOIN facet_v2_prequote_project_links AS link
         ON link.destination_tenant_id = event.destination_tenant_id
        AND link.facet_project_id = event.facet_project_id
        AND link.external_project_link_id = event.external_project_link_id
        AND link.producer_identity_link_id = event.producer_identity_link_id
        AND link.brand_id = event.brand_id
        AND link.roof_job_id = event.roof_job_id
        AND link.customer_id = event.customer_id
       JOIN facet_v2_producer_identity_links AS identity
         ON identity.producer_identity_link_id = link.producer_identity_link_id
        AND identity.destination_tenant_id = link.destination_tenant_id
        AND identity.source_tenant_id = link.source_tenant_id
        AND identity.issuer = event.issuer
        AND identity.source_product = event.source_product
        AND identity.source_environment = event.source_environment
        AND identity.source_tenant_id = event.source_tenant_id
       JOIN facet_v2_prequote_project_launches AS launch
         ON launch.facet_project_id = link.facet_project_id
        AND launch.external_project_link_id = link.external_project_link_id
      WHERE event.event_id = ? AND event.destination_tenant_id = ?
        AND event.roof_job_id = ? AND event.result = 'accepted'
        AND NOT EXISTS (
          SELECT 1 FROM facet_v2_estimator_ready_events AS successor
           WHERE successor.result = 'accepted'
             AND successor.destination_tenant_id = event.destination_tenant_id
             AND successor.facet_project_id = event.facet_project_id
             AND successor.previous_event_id = event.event_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM facet_v2_link_revocations AS revoked
           WHERE (revoked.link_kind = 'project' AND revoked.link_id = event.external_project_link_id)
              OR (revoked.link_kind = 'producer_identity' AND revoked.link_id = event.producer_identity_link_id)
              OR (revoked.link_kind = 'customer_identity'
                  AND revoked.link_id = link.external_customer_identity_link_id)
        )
      LIMIT 1`,
    eventId,
    tenantId,
    roofJobId,
  );
  return row ?? null;
}

export async function loadFacetEstimatorReadyEvent(
  env: AppEnv,
  anchor: FacetEstimatorReadyAnchor,
): Promise<FacetEstimatorReadyEvent | null> {
  if (!env.RAW) return null;
  const object = await env.RAW.get(anchor.raw_key);
  if (!object) return null;
  const raw = await object.text();
  if (new TextEncoder().encode(raw).byteLength !== Number(anchor.raw_content_length)) return null;
  if (await sha256Hex(raw) !== anchor.event_body_sha256) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  const event = await parseFacetEstimatorReadyEvent(parsed);
  if (!event || canonicalJson(event) !== raw || event.event_id !== anchor.event_id) return null;
  return event;
}

/** Consume the separate estimator-ready contract without entering customer or money projections. */
export async function handleFacetEstimatorReadyIngest(
  req: Request,
  env: AppEnv,
): Promise<Response> {
  if (req.method !== "POST" || String(env.FACET_V2_INGEST_ENABLED) !== "true") {
    return readyJson({ error: "not_found" }, 404);
  }
  const config = estimatorReadyConsumerConfig(env);
  if (!config) return readyJson({ error: "facet_estimator_ready_unavailable" }, 503);
  const raw = await readRawJson(req);
  if (!raw.ok) return readyJson({ error: raw.error }, raw.status);
  const verified = await verifyFacetV2Delivery(req, raw.text, {
    ...config,
    expectedEventType: FACET_ESTIMATOR_READY_EVENT_TYPE,
    expectedSchemaVersion: FACET_ESTIMATOR_READY_EVENT_SCHEMA_VERSION,
  });
  if (!verified.ok) return readyJson({ error: verified.code }, verified.status);
  const key = config.keys.find((candidate) =>
    candidate.keyId === verified.value.headers.keyId &&
    candidate.keyVersion === verified.value.headers.keyVersion,
  );
  if (!key) return readyJson({ error: "event_key_unknown" }, 401);
  const event = await parseFacetEstimatorReadyEvent(verified.value.event);
  if (!event) return readyJson({ error: "invalid_event_body" }, 400);
  const bodySha256 = verified.value.bodySha256;
  const nonceSha256 = await sha256Hex([
    FACET_ESTIMATOR_READY_EVENT_TYPE,
    verified.value.headers.issuer,
    verified.value.headers.keyId,
    String(verified.value.headers.keyVersion),
    verified.value.headers.nonce,
  ].join("\n"));
  const existingNonce = await first<{ event_id: string; event_body_sha256: string }>(
    env,
    `SELECT event_id, event_body_sha256 FROM facet_v2_estimator_ready_nonces
      WHERE nonce_sha256 = ? LIMIT 1`,
    nonceSha256,
  );
  if (existingNonce) {
    if (existingNonce.event_id !== event.event_id || existingNonce.event_body_sha256 !== bodySha256) {
      return readyJson({ error: "event_nonce_conflict" }, 409);
    }
    const receipt = await storedReadyReceipt(env, event.event_id, bodySha256, config.keys);
    return receipt
      ? readyJson(receipt, readyReceiptStatus(receipt))
      : readyJson({ error: "facet_estimator_ready_receipt_integrity_unavailable" }, 503);
  }
  const existingEvent = await first<{
    event_body_sha256: string;
  }>(
    env,
    `SELECT event_body_sha256 FROM facet_v2_estimator_ready_events
      WHERE event_id = ? LIMIT 1`,
    event.event_id,
  );
  if (existingEvent) {
    if (existingEvent.event_body_sha256 !== bodySha256) {
      return readyJson({ error: "event_id_body_conflict" }, 409);
    }
    try {
      await env.DB.prepare(
        `INSERT INTO facet_v2_estimator_ready_nonces
         (nonce_sha256, event_id, event_body_sha256, received_at)
         VALUES (?, ?, ?, ?)`,
      ).bind(nonceSha256, event.event_id, bodySha256, new Date().toISOString()).run();
    } catch {
      const nonce = await first<{ event_id: string; event_body_sha256: string }>(
        env,
        `SELECT event_id, event_body_sha256 FROM facet_v2_estimator_ready_nonces
          WHERE nonce_sha256 = ? LIMIT 1`,
        nonceSha256,
      );
      if (!nonce || nonce.event_id !== event.event_id || nonce.event_body_sha256 !== bodySha256) {
        return readyJson({ error: "event_nonce_conflict" }, 409);
      }
    }
    const receipt = await storedReadyReceipt(env, event.event_id, bodySha256, config.keys);
    return receipt
      ? readyJson(receipt, readyReceiptStatus(receipt))
      : readyJson({ error: "facet_estimator_ready_receipt_integrity_unavailable" }, 503);
  }

  // Deterministic nonce and event/body conflicts must not create an orphaned raw object.
  // Only a genuinely new event reaches the immutable R2 write below.
  const rawKey = `facet-estimator-ready/v1/raw/${bodySha256}.json`;
  try {
    await r2ObjectStore(env.RAW).ensure(rawKey, raw.text, "application/json", bodySha256);
  } catch {
    return readyJson({ error: "facet_estimator_ready_raw_store_unavailable" }, 503);
  }

  const now = new Date().toISOString();
  const association = await readyAssociation(env, event);
  const head = await acceptedReadyHead(env, event);
  let result: "accepted" | "rejected" = "accepted";
  let detailCode = "exact_prequote_project_association_verified";
  if (!association) {
    result = "rejected";
    detailCode = "estimator_ready_association_mismatch";
  } else if (association.revoked) {
    result = "rejected";
    detailCode = "estimator_ready_association_revoked";
  } else if (!association.operatorAuthorized) {
    result = "rejected";
    detailCode = "estimator_ready_operator_attestation_mismatch";
  } else if (event.previous_event_id !== head.eventId) {
    result = "rejected";
    detailCode = event.previous_event_id
      ? "estimator_ready_predecessor_mismatch"
      : "estimator_ready_event_superseded";
  } else if (
    event.previous_event_id !== null && head.occurredAt !== null &&
    Date.parse(event.occurred_at) <= Date.parse(head.occurredAt)
  ) {
    result = "rejected";
    detailCode = "estimator_ready_time_not_monotonic";
  }
  const receiptKey = activeReadyReceiptKey(config.keys, Date.now());
  if (!receiptKey) return readyJson({ error: "facet_estimator_ready_receipt_key_unavailable" }, 503);
  const frozenEvidenceSha256 = await sha256Hex(canonicalJson(event.frozen_evidence));
  const signed = await signFacetEstimatorReadyReceipt({
    schema: "ironwrap.facet-estimator-ready-receipt.v1",
    receipt_id: crypto.randomUUID(),
    event_id: event.event_id,
    event_body_sha256: bodySha256,
    frozen_evidence_sha256: frozenEvidenceSha256,
    design_revision: event.design_revision,
    operator_attestation: {
      actor_type: event.operator_attestation.actor.actor_type,
      identity_assurance: event.operator_attestation.actor.identity_assurance,
      oidc_issuer: event.operator_attestation.actor.oidc_issuer,
      oidc_subject_sha256: event.operator_attestation.actor.oidc_subject_sha256,
    },
    destination_tenant_id: event.destination.tenant_id,
    result,
    policy_version: READY_POLICY_VERSION,
    occurred_at: now,
    detail_code: detailCode,
    idempotent_replay: false,
  }, receiptKey);
  const eventRow = await readyEventInsert(env, event, {
    bodySha256,
    rawKey,
    rawBytes: raw.bytes,
    receivedAt: now,
    result,
    detailCode,
    roofJobId: association?.roofJobId ?? null,
    customerId: association?.customerId ?? null,
  });
  try {
    await env.DB.batch([
      eventRow,
      env.DB.prepare(
        `INSERT INTO facet_v2_estimator_ready_nonces
         (nonce_sha256, event_id, event_body_sha256, received_at)
         VALUES (?, ?, ?, ?)`,
      ).bind(nonceSha256, event.event_id, bodySha256, now),
      readyReceiptInsert(env, event.event_id, bodySha256, signed),
    ]);
  } catch {
    // rawKey is content-addressed by the verified body hash. Never delete it here: a
    // concurrent accepted event may already reference the same immutable object. A failed
    // D1 batch can leave only a reusable immutable orphan, never a conflicting raw body.
    const replay = await first<{ event_id: string; event_body_sha256: string }>(
      env,
      `SELECT event_id, event_body_sha256 FROM facet_v2_estimator_ready_nonces
        WHERE nonce_sha256 = ? LIMIT 1`,
      nonceSha256,
    );
    if (replay?.event_id === event.event_id && replay.event_body_sha256 === bodySha256) {
      const stored = await storedReadyReceipt(env, event.event_id, bodySha256, config.keys);
      if (stored) return readyJson(stored, readyReceiptStatus(stored));
    }
    return readyJson({ error: "facet_estimator_ready_intake_conflict" }, 409);
  }
  return readyJson(signed, readyReceiptStatus(signed));
}

/** Bind the accepted ready event into the existing quote-bound Facet authority. */
export async function promoteFacetEstimatorReady(
  env: AppEnv,
  input: FacetEstimatorPromotionInput,
): Promise<FacetEstimatorPromotionResult> {
  if (input.actorRole !== "owner") return rejectedPromotion("facet_promotion_owner_required", 403);
  if (!RAW_IDEMPOTENCY.test(input.idempotencyKey)) {
    return rejectedPromotion("facet_promotion_idempotency_conflict", 409);
  }
  const idempotencyKeySha256 = await sha256Hex(
    `${input.tenantId}\nfacet-estimator-promotion\n${input.idempotencyKey}`,
  );
  const existingByIdempotency = await first<StoredPromotion>(
    env,
    `SELECT promotion.*, event.facet_project_id
       FROM facet_v2_estimator_ready_promotions AS promotion
       JOIN facet_v2_estimator_ready_events AS event ON event.event_id = promotion.event_id
      WHERE idempotency_key_sha256 = ? LIMIT 1`,
    idempotencyKeySha256,
  );
  if (existingByIdempotency) {
    const intent = await promotionIntentSha256(input);
    if (existingByIdempotency.promotion_intent_sha256 !== intent) {
      return rejectedPromotion("facet_promotion_idempotency_conflict", 409);
    }
    return promotionProjection(existingByIdempotency, true);
  }
  const anchor = await resolveFacetEstimatorReadyAnchor(
    env,
    input.tenantId,
    input.roofJobId,
    input.estimatorReadyEventId,
  );
  if (!anchor) return rejectedPromotion("facet_estimator_ready_head_mismatch", 409);
  const existingByEvent = await first<StoredPromotion>(
    env,
    `SELECT promotion.*, event.facet_project_id
       FROM facet_v2_estimator_ready_promotions AS promotion
       JOIN facet_v2_estimator_ready_events AS event ON event.event_id = promotion.event_id
      WHERE promotion.event_id = ? LIMIT 1`,
    anchor.event_id,
  );
  if (existingByEvent) {
    return existingByEvent.idempotency_key_sha256 === idempotencyKeySha256
      ? promotionProjection(existingByEvent, true)
      : rejectedPromotion("facet_promotion_event_already_bound", 409);
  }
  const estimatorHead = await currentEstimatorReadyRevision(
    env,
    input.tenantId,
    input.roofJobId,
    anchor.event_id,
    input.estimatorRevisionId,
  );
  if (estimatorHead === "ambiguous") {
    return rejectedPromotion("facet_promotion_estimator_head_ambiguous", 409);
  }
  if (!estimatorHead) {
    return rejectedPromotion("facet_promotion_estimator_revision_mismatch", 409);
  }
  const current = await resolveFacetLaunchTarget(env, input.tenantId, input.roofJobId);
  if (!current.ok) return rejectedPromotion(current.code, current.status);
  if (current.value.quoteRevisionId !== input.commercialQuoteRevisionId) {
    return rejectedPromotion("facet_promotion_quote_head_mismatch", 409);
  }
  if (
    current.value.brandId !== anchor.brand_id ||
    current.value.roofJobId !== anchor.roof_job_id ||
    current.value.customerId !== anchor.customer_id ||
    current.value.customerPartyRef !== anchor.customer_party_ref ||
    current.value.externalCustomerIdentityLinkId !== anchor.external_customer_identity_link_id
  ) return rejectedPromotion("facet_promotion_binding_mismatch", 409);
  const intent = await promotionIntentSha256(input);
  const config = facetLaunchConfigForTenant(env, input.tenantId);
  if (!config) return rejectedPromotion("facet_launch_not_configured", 503);
  const promotedAt = validTimestamp(input.now ?? new Date());
  const chronologyFloor = Math.max(
    Date.parse(anchor.occurred_at),
    Date.parse(anchor.received_at),
    Date.parse(current.value.acceptedAt),
  );
  if (!Number.isFinite(chronologyFloor) || Date.parse(promotedAt) < chronologyFloor) {
    return rejectedPromotion("facet_promotion_time_not_monotonic", 409);
  }
  const launchIntent = await facetLaunchIntentSha256({
    target: current.value,
    destinationTenantId: input.tenantId,
    sourceTenantId: anchor.source_tenant_id,
    issuedByUserId: anchor.issued_by_user_id,
  });
  // The quote-bound launch table records the original v1 JWT claims so Facet sees the same
  // project/launch identity after promotion.  Commercial admission is a separate fact: the
  // append-only promotion row below carries the actual binding timestamp (`promoted_at`).
  const registration: FacetV2LaunchAuthorityRegistration = {
    destinationTenantId: input.tenantId,
    sourceTenantId: anchor.source_tenant_id,
    issuer: config.issuer,
    sourceEnvironment: config.sourceEnvironment,
    brandId: current.value.brandId,
    facetProjectId: anchor.facet_project_id,
    producerIdentityProofSha256: anchor.producer_identity_proof_sha256,
    projectClaimSha256: anchor.launch_envelope_sha256,
    customerPartyRef: current.value.customerPartyRef,
    externalCustomerIdentityLinkId: current.value.externalCustomerIdentityLinkId,
    roofJobId: current.value.roofJobId,
    customerQuoteId: current.value.customerQuoteId,
    createdByUserId: anchor.issued_by_user_id,
    createdAt: anchor.launch_created_at,
    quoteVersion: current.value.quoteVersion,
    quoteApprovedAt: current.value.quoteApprovedAt,
    idempotencyKeySha256: anchor.launch_idempotency_key_sha256,
    launchIntentSha256: launchIntent,
    launchEnvelopeSha256: anchor.launch_envelope_sha256,
    issuedAt: anchor.launch_issued_at,
    notBefore: anchor.launch_not_before,
    expiresAt: anchor.launch_expires_at,
  };
  const promotionAnchorSha256 = await sha256Hex(canonicalJson({
    acceptance_binding_id: current.value.acceptanceBindingId,
    acceptance_id: current.value.acceptanceId,
    acceptance_receipt_hash: current.value.acceptanceReceiptHash,
    accepted_at: current.value.acceptedAt,
    event_body_sha256: anchor.event_body_sha256,
    event_id: anchor.event_id,
    estimator_revision_id: estimatorHead.estimator_revision_id,
    external_project_link_id: anchor.external_project_link_id,
    facet_project_id: anchor.facet_project_id,
    quote_revision_id: current.value.quoteRevisionId,
    quote_version: current.value.quoteVersion,
  }));
  const promotion: StoredPromotion = {
    promotion_id: `facet-estimator-promotion:${crypto.randomUUID()}`,
    event_id: anchor.event_id,
    estimator_revision_id: estimatorHead.estimator_revision_id,
    facet_project_id: anchor.facet_project_id,
    external_project_link_id: anchor.external_project_link_id,
    destination_tenant_id: input.tenantId,
    roof_job_id: input.roofJobId,
    customer_id: anchor.customer_id,
    customer_quote_id: current.value.customerQuoteId,
    quote_revision_id: current.value.quoteRevisionId,
    quote_version: current.value.quoteVersion,
    quote_approved_at: current.value.quoteApprovedAt,
    proposal_revision_id: current.value.proposalRevisionId,
    proposal_pack_id: current.value.proposalPackId,
    publication_event_id: current.value.publicationEventId,
    acceptance_binding_id: current.value.acceptanceBindingId,
    acceptance_id: current.value.acceptanceId,
    acceptance_receipt_hash: current.value.acceptanceReceiptHash,
    accepted_at: current.value.acceptedAt,
    promoted_by_user_id: input.actorUserId,
    idempotency_key_sha256: idempotencyKeySha256,
    promotion_intent_sha256: intent,
    promotion_anchor_sha256: promotionAnchorSha256,
    promoted_at: promotedAt,
  };
  const promotionInsert = env.DB.prepare(
    `INSERT INTO facet_v2_estimator_ready_promotions
     (promotion_id, event_id, estimator_revision_id, external_project_link_id, destination_tenant_id,
      roof_job_id, customer_id, customer_quote_id, quote_revision_id, quote_version,
      quote_approved_at, proposal_revision_id, proposal_pack_id, publication_event_id,
      acceptance_binding_id, acceptance_id, acceptance_receipt_hash, accepted_at,
      promoted_by_user_id, idempotency_key_sha256, promotion_intent_sha256,
      promotion_anchor_sha256, promoted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    promotion.promotion_id,
    promotion.event_id,
    promotion.estimator_revision_id,
    promotion.external_project_link_id,
    promotion.destination_tenant_id,
    promotion.roof_job_id,
    promotion.customer_id,
    promotion.customer_quote_id,
    promotion.quote_revision_id,
    promotion.quote_version,
    promotion.quote_approved_at,
    promotion.proposal_revision_id,
    promotion.proposal_pack_id,
    promotion.publication_event_id,
    promotion.acceptance_binding_id,
    promotion.acceptance_id,
    promotion.acceptance_receipt_hash,
    promotion.accepted_at,
    promotion.promoted_by_user_id,
    promotion.idempotency_key_sha256,
    promotion.promotion_intent_sha256,
    promotionAnchorSha256,
    promotion.promoted_at,
  );
  try {
    await registerFacetV2LaunchAuthority(env, registration, {
      additionalStatements: [promotionInsert],
      projectLinkProvenance: {
        createdByUserId: input.actorUserId,
        createdAt: promotedAt,
      },
    });
  } catch {
    const raced = await first<StoredPromotion>(
      env,
      `SELECT promotion.*, event.facet_project_id
         FROM facet_v2_estimator_ready_promotions AS promotion
         JOIN facet_v2_estimator_ready_events AS event ON event.event_id = promotion.event_id
        WHERE promotion.event_id = ? LIMIT 1`,
      anchor.event_id,
    );
    if (raced && samePromotionRecord(raced, promotion)) {
      return promotionProjection(raced, true);
    }
    return rejectedPromotion("facet_promotion_commercial_authority_collision", 409);
  }
  const persisted = await first<StoredPromotion>(
    env,
    `SELECT promotion.*, event.facet_project_id
       FROM facet_v2_estimator_ready_promotions AS promotion
       JOIN facet_v2_estimator_ready_events AS event ON event.event_id = promotion.event_id
      WHERE promotion.promotion_id = ? LIMIT 1`,
    promotion.promotion_id,
  );
  if (!persisted || !samePromotionRecord(persisted, promotion)) {
    return rejectedPromotion("facet_promotion_write_failed", 503);
  }
  return promotionProjection(persisted, false);
}

function samePromotionRecord(stored: StoredPromotion, expected: StoredPromotion): boolean {
  return stored.promotion_id === expected.promotion_id &&
    stored.event_id === expected.event_id &&
    stored.estimator_revision_id === expected.estimator_revision_id &&
    stored.facet_project_id === expected.facet_project_id &&
    stored.external_project_link_id === expected.external_project_link_id &&
    stored.destination_tenant_id === expected.destination_tenant_id &&
    stored.roof_job_id === expected.roof_job_id &&
    stored.customer_id === expected.customer_id &&
    stored.customer_quote_id === expected.customer_quote_id &&
    stored.quote_revision_id === expected.quote_revision_id &&
    Number(stored.quote_version) === expected.quote_version &&
    stored.quote_approved_at === expected.quote_approved_at &&
    stored.proposal_revision_id === expected.proposal_revision_id &&
    stored.proposal_pack_id === expected.proposal_pack_id &&
    stored.publication_event_id === expected.publication_event_id &&
    stored.acceptance_binding_id === expected.acceptance_binding_id &&
    stored.acceptance_id === expected.acceptance_id &&
    stored.acceptance_receipt_hash === expected.acceptance_receipt_hash &&
    stored.accepted_at === expected.accepted_at &&
    stored.promoted_by_user_id === expected.promoted_by_user_id &&
    stored.idempotency_key_sha256 === expected.idempotency_key_sha256 &&
    stored.promotion_intent_sha256 === expected.promotion_intent_sha256 &&
    stored.promotion_anchor_sha256 === expected.promotion_anchor_sha256 &&
    stored.promoted_at === expected.promoted_at;
}

function promotionProjection(
  row: StoredPromotion,
  replayed: boolean,
): Extract<FacetEstimatorPromotionResult, { kind: "created" | "replayed" }> {
  return {
    kind: replayed ? "replayed" : "created",
    promotion: {
      promotion_id: row.promotion_id,
      event_id: row.event_id,
      estimator_revision_id: row.estimator_revision_id,
      facet_project_id: row.facet_project_id,
      external_project_link_id: row.external_project_link_id,
      commercial_quote_revision_id: row.quote_revision_id,
      promoted_at: row.promoted_at,
    },
  };
}

async function promotionIntentSha256(input: FacetEstimatorPromotionInput): Promise<string> {
  return await sha256Hex(canonicalJson({
    actor_user_id: input.actorUserId,
    commercial_quote_revision_id: input.commercialQuoteRevisionId,
    estimator_ready_event_id: input.estimatorReadyEventId,
    estimator_revision_id: input.estimatorRevisionId,
    roof_job_id: input.roofJobId,
    tenant_id: input.tenantId,
  }));
}

interface CurrentEstimatorReadyRevision {
  estimator_revision_id: string;
  tenant_id: string;
  roof_job_id: string;
  estimator_ready_event_id: string | null;
  commercial_quote_revision_id: string | null;
}

async function currentEstimatorReadyRevision(
  env: AppEnv,
  tenantId: string,
  roofJobId: string,
  eventId: string,
  revisionId: string,
): Promise<CurrentEstimatorReadyRevision | "ambiguous" | null> {
  if (!IDENTIFIER.test(revisionId)) return null;
  const rows = await all<CurrentEstimatorReadyRevision>(
    env,
    `SELECT revision.estimator_revision_id, revision.tenant_id, revision.roof_job_id,
            revision.commercial_quote_revision_id, anchor.estimator_ready_event_id
       FROM estimator_evidence_revisions AS revision
       LEFT JOIN estimator_evidence_facet_ready_anchors AS anchor
         ON anchor.estimator_revision_id = revision.estimator_revision_id
      WHERE revision.tenant_id = ? AND revision.roof_job_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM estimator_evidence_revisions AS successor
           WHERE successor.tenant_id = revision.tenant_id
             AND successor.supersedes_estimator_revision_id = revision.estimator_revision_id
        )
      ORDER BY revision.revision_number DESC, revision.estimator_revision_id ASC
      LIMIT 2`,
    tenantId,
    roofJobId,
  );
  if (rows.length > 1) return "ambiguous";
  const row = rows[0];
  if (
    !row || row.estimator_revision_id !== revisionId ||
    row.tenant_id !== tenantId || row.roof_job_id !== roofJobId ||
    row.estimator_ready_event_id !== eventId ||
    row.commercial_quote_revision_id !== null
  ) return null;
  return row;
}

async function readPrequoteTarget(
  env: AppEnv,
  tenantId: string,
  roofJobId: string,
): Promise<{ ok: true; value: PrequoteTarget } | { ok: false; code: string; status: 404 | 409 }> {
  const core = await readNativeJobCore(env, tenantId, roofJobId);
  if (!core || core.job.roof_job_id !== roofJobId) {
    return { ok: false, code: "facet_design_roof_job_not_found", status: 404 };
  }
  const brandId = text(core.job.brand);
  const customerId = text(core.job.customer_id);
  const email = core.customer?.customer_id === customerId
    ? normalizedEmail(core.customer.contact_email)
    : null;
  if (!brandId || !customerId) {
    return { ok: false, code: "facet_prequote_job_binding_required", status: 409 };
  }
  if (!email) return { ok: false, code: "facet_launch_customer_identity_required", status: 409 };
  return {
    ok: true,
    value: {
      brandId,
      roofJobId,
      customerId,
      customerPartyRef: await sha256Hex(`${CUSTOMER_PARTY_CONTEXT}\n${email}`),
      externalCustomerIdentityLinkId: `facet-customer-oidc-v1:${await sha256Hex(
        `${CUSTOMER_IDENTITY_CONTEXT}\n${email}`,
      )}`,
    },
  };
}

async function prequoteAssociationSha256(input: {
  destinationTenantId: string;
  sourceTenantId: string;
  brandId: string;
  facetProjectId: string;
  customerId: string;
  customerPartyRef: string;
  externalCustomerIdentityLinkId: string;
  roofJobId: string;
  externalProjectLinkId: string;
  producerIdentityLinkId: string;
}): Promise<string> {
  return await sha256Hex(canonicalJson({
    brand_id: input.brandId,
    customer_id: input.customerId,
    customer_party_ref: input.customerPartyRef,
    destination_tenant_id: input.destinationTenantId,
    external_customer_identity_link_id: input.externalCustomerIdentityLinkId,
    external_project_link_id: input.externalProjectLinkId,
    facet_project_id: input.facetProjectId,
    producer_identity_link_id: input.producerIdentityLinkId,
    roof_job_id: input.roofJobId,
    source_tenant_id: input.sourceTenantId,
  }));
}

async function readyAssociation(
  env: AppEnv,
  event: FacetEstimatorReadyEvent,
): Promise<{
  revoked: boolean;
  operatorAuthorized: boolean;
  roofJobId: string;
  customerId: string;
} | null> {
  const link = await first<{
    destination_tenant_id: string;
    source_tenant_id: string;
    brand_id: string;
    facet_project_id: string;
    customer_id: string;
    roof_job_id: string;
    external_project_link_id: string;
    producer_identity_link_id: string;
    customer_party_ref: string;
    external_customer_identity_link_id: string;
    association_sha256: string;
    created_by_user_id: string;
    issuer: string;
    source_product: string;
    source_environment: string;
    identity_source_tenant_id: string;
    identity_destination_tenant_id: string;
  }>(
    env,
    `SELECT link.*, identity.issuer, identity.source_product, identity.source_environment,
            identity.source_tenant_id AS identity_source_tenant_id,
            identity.destination_tenant_id AS identity_destination_tenant_id
       FROM facet_v2_prequote_project_links AS link
       JOIN facet_v2_producer_identity_links AS identity
         ON identity.producer_identity_link_id = link.producer_identity_link_id
      WHERE link.destination_tenant_id = ? AND link.facet_project_id = ?
        AND link.external_project_link_id = ? AND link.producer_identity_link_id = ?
      LIMIT 1`,
    event.destination.tenant_id,
    event.facet_project_id,
    event.project_link.external_project_link_id,
    event.project_link.producer_identity_link_id,
  );
  if (
    !link || link.source_tenant_id !== event.source.tenant_id ||
    link.identity_source_tenant_id !== event.source.tenant_id ||
    link.identity_destination_tenant_id !== event.destination.tenant_id ||
    link.brand_id !== event.brand_id ||
    link.issuer !== event.source.issuer ||
    link.source_product !== event.source.product ||
    link.source_environment !== event.source.environment
  ) return null;
  const revoked = await first<{ link_id: string }>(
    env,
    `SELECT link_id FROM facet_v2_link_revocations
      WHERE (link_kind = 'project' AND link_id = ?)
         OR (link_kind = 'producer_identity' AND link_id = ?)
         OR (link_kind = 'customer_identity' AND link_id = ?)
      LIMIT 1`,
    link.external_project_link_id,
    link.producer_identity_link_id,
    link.external_customer_identity_link_id,
  );
  const expectedAssociation = await prequoteAssociationSha256({
    destinationTenantId: link.destination_tenant_id,
    sourceTenantId: link.source_tenant_id,
    brandId: link.brand_id,
    facetProjectId: link.facet_project_id,
    customerId: link.customer_id,
    customerPartyRef: link.customer_party_ref,
    externalCustomerIdentityLinkId: link.external_customer_identity_link_id,
    roofJobId: link.roof_job_id,
    externalProjectLinkId: link.external_project_link_id,
    producerIdentityLinkId: link.producer_identity_link_id,
  });
  return {
    revoked: Boolean(revoked) || expectedAssociation !== link.association_sha256,
    // The operator/expert role and OIDC subject are producer-side authority facts signed by
    // Facet. They are not relabeled as an IronWrap app user or inferred from customer approval.
    operatorAuthorized: ["owner", "expert"].includes(
      event.operator_attestation.actor.actor_type,
    ),
    roofJobId: link.roof_job_id,
    customerId: link.customer_id,
  };
}

async function acceptedReadyHead(
  env: AppEnv,
  event: FacetEstimatorReadyEvent,
): Promise<{ eventId: string | null; occurredAt: string | null }> {
  const rows = await all<{ event_id: string; occurred_at: string }>(
    env,
    `SELECT head.event_id, head.occurred_at
       FROM facet_v2_estimator_ready_events AS head
      WHERE head.destination_tenant_id = ? AND head.facet_project_id = ?
        AND head.result = 'accepted'
        AND NOT EXISTS (
          SELECT 1 FROM facet_v2_estimator_ready_events AS child
           WHERE child.result = 'accepted' AND child.previous_event_id = head.event_id
        )
      LIMIT 2`,
    event.destination.tenant_id,
    event.facet_project_id,
  );
  return rows.length === 1
    ? { eventId: rows[0]!.event_id, occurredAt: rows[0]!.occurred_at }
    : { eventId: null, occurredAt: null };
}

async function readyEventInsert(
  env: AppEnv,
  event: FacetEstimatorReadyEvent,
  input: {
    bodySha256: string;
    rawKey: string;
    rawBytes: number;
    receivedAt: string;
    result: "accepted" | "rejected";
    detailCode: string;
    roofJobId: string | null;
    customerId: string | null;
  },
): Promise<D1PreparedStatement> {
  return env.DB.prepare(
    `INSERT INTO facet_v2_estimator_ready_events
     (event_id, event_type, schema_version, event_body_sha256, issuer, source_product,
      source_environment, source_tenant_id, destination_tenant_id, brand_id,
      facet_project_id, external_project_link_id, producer_identity_link_id,
      roof_job_id, customer_id, actor_identity_ref, actor_type, oidc_issuer,
      oidc_subject_sha256, previous_event_id, design_revision_id, design_revision_sha256,
      frozen_evidence_sha256, raw_key, raw_content_length, occurred_at, received_at,
      result, detail_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    event.event_id,
    event.event_type,
    event.schema_version,
    input.bodySha256,
    event.source.issuer,
    event.source.product,
    event.source.environment,
    event.source.tenant_id,
    event.destination.tenant_id,
    event.brand_id,
    event.facet_project_id,
    event.project_link.external_project_link_id,
    event.project_link.producer_identity_link_id,
    input.roofJobId,
    input.customerId,
    `facet-actor-oidc-v1:${await sha256Hex(
      `${event.operator_attestation.actor.oidc_issuer}\n${event.operator_attestation.actor.oidc_subject_sha256}`,
    )}`,
    event.operator_attestation.actor.actor_type,
    event.operator_attestation.actor.oidc_issuer,
    event.operator_attestation.actor.oidc_subject_sha256,
    event.previous_event_id,
    event.design_revision.id,
    event.design_revision.sha256,
    await sha256Hex(canonicalJson(event.frozen_evidence)),
    input.rawKey,
    input.rawBytes,
    event.occurred_at,
    input.receivedAt,
    input.result,
    input.detailCode,
  );
}

function readyReceiptInsert(
  env: AppEnv,
  eventId: string,
  bodySha256: string,
  signed: SignedFacetEstimatorReadyReceipt,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO facet_v2_estimator_ready_receipts
     (receipt_id, event_id, event_body_sha256, result, detail_code, receipt_json,
      receipt_sha256, signature_algorithm, signature_key_id, signature_key_version,
      signature_value, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    signed.receipt.receipt_id,
    eventId,
    bodySha256,
    signed.receipt.result,
    signed.receipt.detail_code,
    canonicalJson(signed.receipt),
    signed.receipt_sha256,
    signed.signature.algorithm,
    signed.signature.key_id,
    signed.signature.key_version,
    signed.signature.value,
    signed.receipt.occurred_at,
  );
}

async function storedReadyReceipt(
  env: AppEnv,
  eventId: string,
  bodySha256: string,
  keys: readonly FacetV2VerificationKey[],
): Promise<SignedFacetEstimatorReadyReceipt | null> {
  const stored = await first<StoredReadyReceiptEnvelope>(
    env,
    `SELECT receipt_json, receipt_sha256, signature_algorithm,
            signature_key_id, signature_key_version, signature_value
       FROM facet_v2_estimator_ready_receipts
      WHERE event_id = ? AND event_body_sha256 = ?
      ORDER BY created_at ASC LIMIT 1`,
    eventId,
    bodySha256,
  );
  if (!stored || stored.signature_algorithm !== "HMAC-SHA256") return null;
  const key = keys.find((candidate) =>
    candidate.keyId === stored.signature_key_id &&
    candidate.keyVersion === Number(stored.signature_key_version),
  );
  if (!key) return null;
  try {
    const receipt = JSON.parse(stored.receipt_json) as FacetEstimatorReadyReceipt;
    const expected = await signFacetEstimatorReadyReceipt(receipt, key);
    if (
      receipt.event_id !== eventId || receipt.event_body_sha256 !== bodySha256 ||
      expected.receipt_sha256 !== stored.receipt_sha256 ||
      expected.signature.value !== stored.signature_value
    ) return null;
    return {
      receipt,
      receipt_sha256: stored.receipt_sha256,
      signature: {
        algorithm: stored.signature_algorithm,
        key_id: stored.signature_key_id,
        key_version: Number(stored.signature_key_version),
        value: stored.signature_value,
      },
    };
  } catch {
    return null;
  }
}

function estimatorReadyConsumerConfig(env: AppEnv): {
  routes: readonly FacetV2StaticRoute[];
  keys: readonly FacetV2VerificationKey[];
} | null {
  const keysOverride = String(env.FACET_ESTIMATOR_READY_KEYS_JSON ?? "").trim();
  const overriddenEnv = keysOverride
    ? ({ ...env, FACET_V2_KEYS_JSON: keysOverride } as unknown as Env)
    : env;
  const base = keysOverride
    ? facetV2ConsumerConfig(overriddenEnv)
    : facetV2ConsumerConfig(env);
  if (!base) return null;
  const routesRaw = String(env.FACET_ESTIMATOR_READY_ROUTES_JSON ?? "").trim();
  if (routesRaw) {
    const routes = facetV2StaticRoutes(
      { FACET_V2_ROUTES_JSON: routesRaw } as unknown as Pick<Env, "FACET_V2_ROUTES_JSON">,
    );
    return routes ? { routes, keys: base.keys } : null;
  }
  const routes = base.routes.map((route) => {
    try {
      const destination = new URL(route.destinationUrl);
      destination.pathname = "/ingest/facet-estimator-ready";
      destination.search = "";
      destination.hash = "";
      return { ...route, destinationUrl: destination.toString() };
    } catch {
      return null;
    }
  });
  return routes.every(Boolean)
    ? { routes: routes as FacetV2StaticRoute[], keys: base.keys }
    : null;
}

function activeReadyReceiptKey(
  keys: readonly FacetV2VerificationKey[],
  nowMs: number,
): FacetV2VerificationKey | null {
  return [...keys]
    .filter((key) => key.notBeforeMs <= nowMs && key.notAfterMs >= nowMs)
    .sort((left, right) =>
      right.notBeforeMs - left.notBeforeMs || right.keyVersion - left.keyVersion ||
      right.keyId.localeCompare(left.keyId),
    )[0] ?? null;
}

function readyReceiptStatus(receipt: SignedFacetEstimatorReadyReceipt): number {
  return receipt.receipt.result === "rejected" ? 409 :
    receipt.receipt.result === "accepted" ? 202 : 200;
}

function readyJson(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function readRawJson(req: Request): Promise<
  { ok: true; text: string; bytes: number } |
  { ok: false; error: "content_type_required" | "payload_too_large" | "invalid_event_body"; status: 400 | 413 | 415 }
> {
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return { ok: false, error: "content_type_required", status: 415 };
  }
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > READY_MAX_BODY_BYTES) {
    return { ok: false, error: "payload_too_large", status: 413 };
  }
  try {
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.byteLength > READY_MAX_BODY_BYTES) {
      return { ok: false, error: "payload_too_large", status: 413 };
    }
    return {
      ok: true,
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
      bytes: bytes.byteLength,
    };
  } catch {
    return { ok: false, error: "invalid_event_body", status: 400 };
  }
}

function normalizedEmail(value: string | null | undefined): string | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized && normalized.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)
    ? normalized
    : null;
}

function identityMatchesConfig(
  identity: FacetV2ProducerIdentityLink,
  config: FacetLaunchConfig,
): boolean {
  return identity.destinationTenantId === config.destinationTenantId &&
    identity.sourceTenantId === config.sourceTenantId &&
    identity.issuer === config.issuer &&
    identity.sourceEnvironment === config.sourceEnvironment;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function validTimestamp(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new FacetPrequoteError("facet_promotion_timestamp_invalid", 400);
  return now.toISOString();
}

async function first<T>(env: Pick<AppEnv, "DB">, sql: string, ...args: unknown[]): Promise<T | null> {
  const statement = env.DB.prepare(sql).bind(...args) as {
    first?: <U>() => Promise<U | null>;
    all?: <U>() => Promise<{ results?: U[] }>;
  };
  if (typeof statement.first === "function") return await statement.first<T>();
  if (typeof statement.all === "function") return (await statement.all<T>()).results?.[0] ?? null;
  return null;
}

async function all<T>(env: Pick<AppEnv, "DB">, sql: string, ...args: unknown[]): Promise<T[]> {
  const result = await env.DB.prepare(sql).bind(...args).all<T>();
  return result.results ?? [];
}

function rejected(code: string, status: 403 | 404 | 409 | 503): FacetPrequoteLaunchResult {
  return { kind: "rejected", code, status };
}

function rejectedPromotion(code: string, status: 403 | 404 | 409 | 503): FacetEstimatorPromotionResult {
  return { kind: "rejected", code, status };
}
