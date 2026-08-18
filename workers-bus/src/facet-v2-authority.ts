import { sha256Hex } from "./app-auth.ts";
import {
  canonicalJson,
  type FacetV2CustomerDecisionEvent,
} from "./facet-design-v2-protocol.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;
const CUSTOMER_IDENTITY_LINK = /^facet-customer-oidc-v1:[0-9a-f]{64}$/;

export interface FacetV2AuthorityRegistration {
  destinationTenantId: string;
  sourceTenantId: string;
  issuer: string;
  sourceEnvironment: string;
  brandId: string;
  facetProjectId: string;
  producerIdentityProofSha256: string;
  projectClaimSha256: string;
  customerPartyRef: string;
  externalCustomerIdentityLinkId: string;
  roofJobId: string;
  customerQuoteId: string;
  createdByUserId: string;
  createdAt: string;
}

export interface FacetV2LaunchAuthorityRegistration
  extends FacetV2AuthorityRegistration {
  quoteVersion: number;
  quoteApprovedAt: string;
  idempotencyKeySha256: string;
  launchIntentSha256: string;
  launchEnvelopeSha256: string;
  issuedAt: number;
  notBefore: number;
  expiresAt: number;
}

export interface FacetV2AuthorityLink {
  externalProjectLinkId: string;
  producerIdentityLinkId: string;
  associationSha256: string;
  destinationTenantId: string;
  sourceTenantId: string;
  brandId: string;
  facetProjectId: string;
  customerPartyRef: string;
  externalCustomerIdentityLinkId: string;
  roofJobId: string;
  customerQuoteId: string;
}

interface StoredAuthorityLink {
  external_project_link_id: string;
  producer_identity_link_id: string;
  association_sha256: string;
  destination_tenant_id: string;
  source_tenant_id: string;
  brand_id: string;
  facet_project_id: string;
  customer_party_ref: string;
  external_customer_identity_link_id: string;
  roof_job_id: string;
  customer_quote_id: string;
  project_claim_sha256: string;
  issuer: string;
  source_product: string;
  source_environment: string;
  proof_sha256: string;
}

interface StoredLaunchAuthority {
  facet_project_id: string;
  external_project_link_id: string;
  destination_tenant_id: string;
  source_tenant_id: string;
  brand_id: string;
  roof_job_id: string;
  customer_quote_id: string;
  quote_version: number;
  quote_approved_at: string;
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

export interface FacetV2ProducerIdentityLink {
  producerIdentityLinkId: string;
  destinationTenantId: string;
  sourceTenantId: string;
  issuer: string;
  sourceEnvironment: string;
  proofSha256: string;
}

export async function facetV2ExternalLinkIds(input: {
  destinationTenantId: string;
  brandId: string;
  facetProjectId: string;
  projectClaimSha256: string;
  sourceTenantId: string;
  producerIdentityProofSha256: string;
}): Promise<{ externalProjectLinkId: string; producerIdentityLinkId: string }> {
  if (
    !safeIdentifier(input.destinationTenantId) || !safeIdentifier(input.brandId) ||
    !UUID.test(input.facetProjectId) || !UUID.test(input.sourceTenantId) ||
    !SHA256.test(input.projectClaimSha256) ||
    !SHA256.test(input.producerIdentityProofSha256)
  ) throw new Error("facet_v2_authority_input_invalid");
  return {
    externalProjectLinkId: `ironwrap-project-v1:${await sha256Hex([
      input.destinationTenantId,
      input.brandId,
      input.facetProjectId,
      input.projectClaimSha256,
    ].join("\n"))}`,
    producerIdentityLinkId: `ironwrap-identity-v1:${await sha256Hex([
      input.destinationTenantId,
      input.sourceTenantId,
      input.producerIdentityProofSha256,
    ].join("\n"))}`,
  };
}

export async function registerFacetV2AuthorityLink(
  env: Pick<Env, "DB">,
  input: FacetV2AuthorityRegistration,
): Promise<FacetV2AuthorityLink> {
  assertRegistration(input);
  const ids = await facetV2ExternalLinkIds(input);
  const associationSha256 = await sha256Hex(canonicalJson({
    brand_id: input.brandId,
    customer_party_ref: input.customerPartyRef,
    customer_quote_id: input.customerQuoteId,
    destination_tenant_id: input.destinationTenantId,
    external_customer_identity_link_id: input.externalCustomerIdentityLinkId,
    external_project_link_id: ids.externalProjectLinkId,
    facet_project_id: input.facetProjectId,
    producer_identity_link_id: ids.producerIdentityLinkId,
    roof_job_id: input.roofJobId,
    source_tenant_id: input.sourceTenantId,
  }));
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO facet_v2_producer_identity_links
       (producer_identity_link_id, destination_tenant_id, source_tenant_id, issuer,
        source_product, source_environment, proof_sha256,
        created_from_project_id, created_at)
       VALUES (?, ?, ?, ?, 'facet', ?, ?, ?, ?)`,
    ).bind(
      ids.producerIdentityLinkId,
      input.destinationTenantId,
      input.sourceTenantId,
      input.issuer,
      input.sourceEnvironment,
      input.producerIdentityProofSha256,
      input.facetProjectId,
      input.createdAt,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO facet_v2_project_links
       (external_project_link_id, producer_identity_link_id, destination_tenant_id,
        source_tenant_id, brand_id, facet_project_id, customer_party_ref,
        external_customer_identity_link_id, roof_job_id, customer_quote_id,
        project_claim_sha256, association_sha256, created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      ids.externalProjectLinkId,
      ids.producerIdentityLinkId,
      input.destinationTenantId,
      input.sourceTenantId,
      input.brandId,
      input.facetProjectId,
      input.customerPartyRef,
      input.externalCustomerIdentityLinkId,
      input.roofJobId,
      input.customerQuoteId,
      input.projectClaimSha256,
      associationSha256,
      input.createdByUserId,
      input.createdAt,
    ),
  ]);
  const stored = await authorityByProject(env, input.destinationTenantId, input.facetProjectId);
  if (!stored || !sameRegistration(stored, input, ids, associationSha256)) {
    throw new Error("facet_v2_authority_collision");
  }
  return authorityProjection(stored);
}

/**
 * Atomically reserves the replayable signed launch and its exact producer/project authority.
 * The launch FK is deferred so a conflicting idempotency key, identity, or project rolls the
 * whole batch back instead of leaving a partially authorized link.
 */
export async function registerFacetV2LaunchAuthority(
  env: Pick<Env, "DB">,
  input: FacetV2LaunchAuthorityRegistration,
): Promise<FacetV2AuthorityLink> {
  assertRegistration(input);
  assertLaunchRegistration(input);
  const ids = await facetV2ExternalLinkIds(input);
  const associationSha256 = await registrationAssociationSha256(input, ids);
  const exactLaunchPredicate = `facet_project_id = ? AND external_project_link_id = ?
    AND destination_tenant_id = ? AND source_tenant_id = ? AND brand_id = ?
    AND roof_job_id = ? AND customer_quote_id = ? AND quote_version = ?
    AND quote_approved_at = ? AND customer_party_ref = ?
    AND external_customer_identity_link_id = ? AND issued_by_user_id = ?
    AND idempotency_key_sha256 = ? AND launch_intent_sha256 = ?
    AND launch_envelope_sha256 = ? AND issued_at = ? AND not_before = ?
    AND expires_at = ? AND created_at = ?`;
  const launchBindings = [
    input.facetProjectId,
    ids.externalProjectLinkId,
    input.destinationTenantId,
    input.sourceTenantId,
    input.brandId,
    input.roofJobId,
    input.customerQuoteId,
    input.quoteVersion,
    input.quoteApprovedAt,
    input.customerPartyRef,
    input.externalCustomerIdentityLinkId,
    input.createdByUserId,
    input.idempotencyKeySha256,
    input.launchIntentSha256,
    input.launchEnvelopeSha256,
    input.issuedAt,
    input.notBefore,
    input.expiresAt,
    input.createdAt,
  ] as const;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO facet_v2_project_launches
       (facet_project_id, external_project_link_id, destination_tenant_id,
        source_tenant_id, brand_id, roof_job_id, customer_quote_id, quote_version,
        quote_approved_at, customer_party_ref, external_customer_identity_link_id,
        issued_by_user_id, idempotency_key_sha256, launch_intent_sha256,
        launch_envelope_sha256, issued_at, not_before, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(...launchBindings),
    env.DB.prepare(
      `INSERT OR IGNORE INTO facet_v2_producer_identity_links
       (producer_identity_link_id, destination_tenant_id, source_tenant_id, issuer,
        source_product, source_environment, proof_sha256,
        created_from_project_id, created_at)
       SELECT ?, ?, ?, ?, 'facet', ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM facet_v2_project_launches WHERE ${exactLaunchPredicate}
       )`,
    ).bind(
      ids.producerIdentityLinkId,
      input.destinationTenantId,
      input.sourceTenantId,
      input.issuer,
      input.sourceEnvironment,
      input.producerIdentityProofSha256,
      input.facetProjectId,
      input.createdAt,
      ...launchBindings,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO facet_v2_project_links
       (external_project_link_id, producer_identity_link_id, destination_tenant_id,
        source_tenant_id, brand_id, facet_project_id, customer_party_ref,
        external_customer_identity_link_id, roof_job_id, customer_quote_id,
        project_claim_sha256, association_sha256, created_by_user_id, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       FROM facet_v2_producer_identity_links AS identity
       WHERE identity.producer_identity_link_id = ?
         AND identity.destination_tenant_id = ? AND identity.source_tenant_id = ?
         AND identity.issuer = ? AND identity.source_product = 'facet'
         AND identity.source_environment = ?
         AND identity.proof_sha256 = ?
         AND EXISTS (
           SELECT 1 FROM facet_v2_project_launches WHERE ${exactLaunchPredicate}
         )`,
    ).bind(
      ids.externalProjectLinkId,
      ids.producerIdentityLinkId,
      input.destinationTenantId,
      input.sourceTenantId,
      input.brandId,
      input.facetProjectId,
      input.customerPartyRef,
      input.externalCustomerIdentityLinkId,
      input.roofJobId,
      input.customerQuoteId,
      input.projectClaimSha256,
      associationSha256,
      input.createdByUserId,
      input.createdAt,
      ids.producerIdentityLinkId,
      input.destinationTenantId,
      input.sourceTenantId,
      input.issuer,
      input.sourceEnvironment,
      input.producerIdentityProofSha256,
      ...launchBindings,
    ),
  ]);
  const [stored, launch] = await Promise.all([
    authorityByProject(env, input.destinationTenantId, input.facetProjectId),
    launchByProject(env, input.destinationTenantId, input.facetProjectId),
  ]);
  if (
    !stored || !sameRegistration(stored, input, ids, associationSha256) ||
    !launch || !sameLaunchRegistration(launch, input, ids)
  ) throw new Error("facet_v2_authority_collision");
  return authorityProjection(stored);
}

export async function resolveRegisteredFacetV2LaunchAuthority(
  env: Pick<Env, "DB">,
  input: FacetV2LaunchAuthorityRegistration,
): Promise<FacetV2AuthorityLink | null> {
  assertRegistration(input);
  assertLaunchRegistration(input);
  const ids = await facetV2ExternalLinkIds(input);
  const associationSha256 = await registrationAssociationSha256(input, ids);
  const [stored, launch, revoked] = await Promise.all([
    authorityByProject(env, input.destinationTenantId, input.facetProjectId),
    launchByProject(env, input.destinationTenantId, input.facetProjectId),
    env.DB.prepare(
      `SELECT link_id FROM facet_v2_link_revocations
       WHERE (link_kind = 'project' AND link_id = ?)
          OR (link_kind = 'producer_identity' AND link_id = ?)
          OR (link_kind = 'customer_identity' AND link_id = ?)
       LIMIT 1`,
    ).bind(
      ids.externalProjectLinkId,
      ids.producerIdentityLinkId,
      input.externalCustomerIdentityLinkId,
    ).first<{ link_id: string }>(),
  ]);
  return !revoked && stored && launch &&
      sameRegistration(stored, input, ids, associationSha256) &&
      sameLaunchRegistration(launch, input, ids)
    ? authorityProjection(stored)
    : null;
}

export async function facetV2ProducerIdentityLink(
  env: Pick<Env, "DB">,
  input: { destinationTenantId: string; sourceTenantId: string },
): Promise<FacetV2ProducerIdentityLink | null> {
  if (!safeIdentifier(input.destinationTenantId) || !UUID.test(input.sourceTenantId))
    throw new Error("facet_v2_authority_input_invalid");
  const rows = await env.DB.prepare(
    `SELECT producer_identity_link_id, destination_tenant_id, source_tenant_id,
            issuer, source_environment, proof_sha256
       FROM facet_v2_producer_identity_links
       WHERE destination_tenant_id = ? AND source_tenant_id = ?
       LIMIT 2`,
  ).bind(input.destinationTenantId, input.sourceTenantId)
    .all<{
      producer_identity_link_id: string;
      destination_tenant_id: string;
      source_tenant_id: string;
      issuer: string;
      source_environment: string;
      proof_sha256: string;
    }>();
  if ((rows.results ?? []).length !== 1) return null;
  const row = rows.results![0]!;
  return {
    producerIdentityLinkId: row.producer_identity_link_id,
    destinationTenantId: row.destination_tenant_id,
    sourceTenantId: row.source_tenant_id,
    issuer: row.issuer,
    sourceEnvironment: row.source_environment,
    proofSha256: row.proof_sha256,
  };
}

export async function resolveFacetV2AuthorityLink(
  env: Pick<Env, "DB">,
  event: FacetV2CustomerDecisionEvent,
): Promise<FacetV2AuthorityLink | null> {
  const stored = await env.DB.prepare(
    `SELECT project.external_project_link_id, project.producer_identity_link_id,
            project.association_sha256, project.destination_tenant_id,
            project.source_tenant_id, project.brand_id, project.facet_project_id,
            project.customer_party_ref, project.external_customer_identity_link_id,
            project.roof_job_id, project.customer_quote_id, project.project_claim_sha256,
            identity.issuer, identity.source_product, identity.source_environment,
            identity.proof_sha256
       FROM facet_v2_project_links AS project
       JOIN facet_v2_producer_identity_links AS identity
         ON identity.producer_identity_link_id = project.producer_identity_link_id
       WHERE project.external_project_link_id = ?
         AND project.producer_identity_link_id = ?
         AND project.destination_tenant_id = ?
         AND project.source_tenant_id = ?
         AND project.facet_project_id = ?
         AND project.customer_party_ref = ?
         AND project.external_customer_identity_link_id = ?
         AND identity.issuer = ?
         AND identity.source_product = ?
         AND identity.source_environment = ?
         AND NOT EXISTS (
           SELECT 1 FROM facet_v2_link_revocations AS revoked
           WHERE (revoked.link_kind = 'project' AND revoked.link_id = project.external_project_link_id)
              OR (revoked.link_kind = 'producer_identity' AND revoked.link_id = project.producer_identity_link_id)
              OR (revoked.link_kind = 'customer_identity'
                  AND revoked.link_id = project.external_customer_identity_link_id)
         )
       LIMIT 2`,
  ).bind(
    event.project_link.external_project_link_id,
    event.project_link.producer_identity_link_id,
    event.destination.tenant_id,
    event.source.tenant_id,
    event.facet_project_id,
    event.approval.actor.customer_party_ref,
    event.approval.actor.external_identity_link_id,
    event.source.issuer,
    event.source.product,
    event.source.environment,
  ).all<StoredAuthorityLink>();
  if ((stored.results ?? []).length !== 1) return null;
  const link = stored.results![0]!;
  const ids = await facetV2ExternalLinkIds({
    destinationTenantId: link.destination_tenant_id,
    brandId: link.brand_id,
    facetProjectId: link.facet_project_id,
    projectClaimSha256: link.project_claim_sha256,
    sourceTenantId: link.source_tenant_id,
    producerIdentityProofSha256: link.proof_sha256,
  });
  if (
    ids.externalProjectLinkId !== link.external_project_link_id ||
    ids.producerIdentityLinkId !== link.producer_identity_link_id ||
    event.brand_id !== link.brand_id
  ) return null;
  return authorityProjection(link);
}

async function authorityByProject(
  env: Pick<Env, "DB">,
  destinationTenantId: string,
  facetProjectId: string,
): Promise<StoredAuthorityLink | null> {
  return await env.DB.prepare(
    `SELECT project.external_project_link_id, project.producer_identity_link_id,
            project.association_sha256, project.destination_tenant_id,
            project.source_tenant_id, project.brand_id, project.facet_project_id,
            project.customer_party_ref, project.external_customer_identity_link_id,
            project.roof_job_id, project.customer_quote_id, project.project_claim_sha256,
            identity.issuer, identity.source_product, identity.source_environment,
            identity.proof_sha256
       FROM facet_v2_project_links AS project
       JOIN facet_v2_producer_identity_links AS identity
         ON identity.producer_identity_link_id = project.producer_identity_link_id
       WHERE project.destination_tenant_id = ? AND project.facet_project_id = ?
       LIMIT 1`,
  ).bind(destinationTenantId, facetProjectId).first<StoredAuthorityLink>();
}

function sameRegistration(
  stored: StoredAuthorityLink,
  input: FacetV2AuthorityRegistration,
  ids: { externalProjectLinkId: string; producerIdentityLinkId: string },
  associationSha256: string,
): boolean {
  return stored.external_project_link_id === ids.externalProjectLinkId &&
    stored.producer_identity_link_id === ids.producerIdentityLinkId &&
    stored.association_sha256 === associationSha256 &&
    stored.destination_tenant_id === input.destinationTenantId &&
    stored.source_tenant_id === input.sourceTenantId &&
    stored.brand_id === input.brandId && stored.facet_project_id === input.facetProjectId &&
    stored.customer_party_ref === input.customerPartyRef &&
    stored.external_customer_identity_link_id === input.externalCustomerIdentityLinkId &&
    stored.roof_job_id === input.roofJobId &&
    stored.customer_quote_id === input.customerQuoteId &&
    stored.project_claim_sha256 === input.projectClaimSha256 &&
    stored.issuer === input.issuer && stored.source_product === "facet" &&
    stored.source_environment === input.sourceEnvironment &&
    stored.proof_sha256 === input.producerIdentityProofSha256;
}

function authorityProjection(stored: StoredAuthorityLink): FacetV2AuthorityLink {
  return {
    externalProjectLinkId: stored.external_project_link_id,
    producerIdentityLinkId: stored.producer_identity_link_id,
    associationSha256: stored.association_sha256,
    destinationTenantId: stored.destination_tenant_id,
    sourceTenantId: stored.source_tenant_id,
    brandId: stored.brand_id,
    facetProjectId: stored.facet_project_id,
    customerPartyRef: stored.customer_party_ref,
    externalCustomerIdentityLinkId: stored.external_customer_identity_link_id,
    roofJobId: stored.roof_job_id,
    customerQuoteId: stored.customer_quote_id,
  };
}

async function registrationAssociationSha256(
  input: FacetV2AuthorityRegistration,
  ids: { externalProjectLinkId: string; producerIdentityLinkId: string },
): Promise<string> {
  return await sha256Hex(canonicalJson({
    brand_id: input.brandId,
    customer_party_ref: input.customerPartyRef,
    customer_quote_id: input.customerQuoteId,
    destination_tenant_id: input.destinationTenantId,
    external_customer_identity_link_id: input.externalCustomerIdentityLinkId,
    external_project_link_id: ids.externalProjectLinkId,
    facet_project_id: input.facetProjectId,
    producer_identity_link_id: ids.producerIdentityLinkId,
    roof_job_id: input.roofJobId,
    source_tenant_id: input.sourceTenantId,
  }));
}

async function launchByProject(
  env: Pick<Env, "DB">,
  destinationTenantId: string,
  facetProjectId: string,
): Promise<StoredLaunchAuthority | null> {
  return await env.DB.prepare(
    `SELECT * FROM facet_v2_project_launches
     WHERE destination_tenant_id = ? AND facet_project_id = ? LIMIT 1`,
  ).bind(destinationTenantId, facetProjectId).first<StoredLaunchAuthority>();
}

function sameLaunchRegistration(
  stored: StoredLaunchAuthority,
  input: FacetV2LaunchAuthorityRegistration,
  ids: { externalProjectLinkId: string },
): boolean {
  return stored.facet_project_id === input.facetProjectId &&
    stored.external_project_link_id === ids.externalProjectLinkId &&
    stored.destination_tenant_id === input.destinationTenantId &&
    stored.source_tenant_id === input.sourceTenantId &&
    stored.brand_id === input.brandId && stored.roof_job_id === input.roofJobId &&
    stored.customer_quote_id === input.customerQuoteId &&
    stored.quote_version === input.quoteVersion &&
    stored.quote_approved_at === input.quoteApprovedAt &&
    stored.customer_party_ref === input.customerPartyRef &&
    stored.external_customer_identity_link_id === input.externalCustomerIdentityLinkId &&
    stored.issued_by_user_id === input.createdByUserId &&
    stored.idempotency_key_sha256 === input.idempotencyKeySha256 &&
    stored.launch_intent_sha256 === input.launchIntentSha256 &&
    stored.launch_envelope_sha256 === input.launchEnvelopeSha256 &&
    stored.issued_at === input.issuedAt && stored.not_before === input.notBefore &&
    stored.expires_at === input.expiresAt && stored.created_at === input.createdAt;
}

function assertRegistration(input: FacetV2AuthorityRegistration): void {
  if (
    !safeIdentifier(input.destinationTenantId) || !UUID.test(input.sourceTenantId) ||
    !safeIdentifier(input.issuer) || !safeIdentifier(input.sourceEnvironment) ||
    !safeIdentifier(input.brandId) || !UUID.test(input.facetProjectId) ||
    !SHA256.test(input.producerIdentityProofSha256) || !SHA256.test(input.projectClaimSha256) ||
    !SHA256.test(input.customerPartyRef) ||
    !CUSTOMER_IDENTITY_LINK.test(input.externalCustomerIdentityLinkId) ||
    !safeIdentifier(input.roofJobId) || !safeIdentifier(input.customerQuoteId) ||
    !safeIdentifier(input.createdByUserId) || !validIso(input.createdAt)
  ) throw new Error("facet_v2_authority_input_invalid");
}

function assertLaunchRegistration(input: FacetV2LaunchAuthorityRegistration): void {
  if (
    !Number.isSafeInteger(input.quoteVersion) || input.quoteVersion < 1 ||
    !validSourceTimestamp(input.quoteApprovedAt) || !SHA256.test(input.idempotencyKeySha256) ||
    !SHA256.test(input.launchIntentSha256) || !SHA256.test(input.launchEnvelopeSha256) ||
    input.projectClaimSha256 !== input.launchEnvelopeSha256 ||
    !Number.isSafeInteger(input.issuedAt) || !Number.isSafeInteger(input.notBefore) ||
    !Number.isSafeInteger(input.expiresAt) || input.notBefore < input.issuedAt ||
    input.expiresAt <= input.issuedAt || input.expiresAt - input.issuedAt > 1800
  ) throw new Error("facet_v2_authority_input_invalid");
}

function validSourceTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length >= 10 && value.length <= 80 &&
    !/[\u0000-\u001f\u007f]/.test(value) && Number.isFinite(Date.parse(value));
}

function safeIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    new Date(value).toISOString() === value;
}
