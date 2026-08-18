import { sha256Hex } from "./app-auth.ts";
import type { AppEnv, AppRole } from "./app-types.ts";
import { facetV2StaticRoutes } from "./facet-design-ingest.ts";
import { canonicalJson } from "./facet-design-v2-protocol.ts";
import {
  facetV2ProducerIdentityLink,
  registerFacetV2LaunchAuthority,
  resolveRegisteredFacetV2LaunchAuthority,
  type FacetV2LaunchAuthorityRegistration,
  type FacetV2ProducerIdentityLink,
} from "./facet-v2-authority.ts";
import { listFacetLaunchFrappeResource } from "./frappe-read.ts";

const HEADER = Object.freeze({
  alg: "HS256",
  kid: "ironwrap-facet-launch-v1",
  typ: "JWT",
});
const LAUNCH_TTL_SECONDS = 10 * 60;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CUSTOMER_PARTY_CONTEXT = "ironwrap.customer-party.email.v1";
const CUSTOMER_IDENTITY_CONTEXT = "facet.customer-oidc-email.v1";

interface FacetLaunchConfig {
  baseUrl: string;
  key: Uint8Array;
  destinationTenantId: string;
  sourceTenantId: string;
  issuer: string;
  sourceEnvironment: string;
}

interface FacetLaunchTarget {
  brandId: string;
  roofJobId: string;
  customerQuoteId: string;
  quoteVersion: number;
  quoteApprovedAt: string;
  customerPartyRef: string;
  externalCustomerIdentityLinkId: string;
}

interface StoredFacetLaunch {
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

export type FacetLaunchIssueResult =
  | {
      kind: "created" | "replayed";
      launch: {
        facet_project_id: string;
        launch_url: string;
        expires_at: string;
        state: "issued";
      };
    }
  | {
      kind: "rejected";
      code:
        | "facet_launch_not_configured"
        | "facet_launch_owner_required"
        | "facet_launch_idempotency_conflict"
        | "facet_launch_authority_collision"
        | "facet_design_roof_job_not_found"
        | "facet_design_current_approved_quote_required"
        | "facet_launch_customer_identity_required";
      status: 403 | 404 | 409 | 503;
    };

export function facetLaunchConfigured(
  env: AppEnv,
  destinationTenantId: string,
): boolean {
  return launchConfig(env, destinationTenantId) !== null;
}

export async function issueFacetLaunch(
  env: AppEnv,
  input: {
    tenantId: string;
    jobName: string;
    actorUserId: string;
    actorRole: AppRole;
    idempotencyKey: string;
    now?: Date;
    projectId?: string;
  },
): Promise<FacetLaunchIssueResult> {
  if (input.actorRole !== "owner")
    return rejected("facet_launch_owner_required", 403);
  const config = launchConfig(env, input.tenantId);
  if (!config) return rejected("facet_launch_not_configured", 503);
  if (!/^[A-Za-z0-9._:-]{8,140}$/.test(input.idempotencyKey))
    return rejected("facet_launch_idempotency_conflict", 409);

  const target = await resolveFacetLaunchTarget(env, input.jobName);
  if (!target.ok) return rejected(target.code, target.status);
  const idempotencyKeySha256 = await sha256Hex(
    `${input.tenantId}\n${input.idempotencyKey}`,
  );
  const launchIntentSha256 = await sha256Hex(
    canonicalJson({
      brand_id: target.value.brandId,
      customer_party_ref: target.value.customerPartyRef,
      customer_quote_id: target.value.customerQuoteId,
      destination_tenant_id: input.tenantId,
      external_customer_identity_link_id:
        target.value.externalCustomerIdentityLinkId,
      issued_by_user_id: input.actorUserId,
      quote_approved_at: target.value.quoteApprovedAt,
      quote_version: target.value.quoteVersion,
      roof_job_id: target.value.roofJobId,
      source_tenant_id: config.sourceTenantId,
    }),
  );
  const existing = await launchByIdempotency(env, idempotencyKeySha256);
  if (existing) {
    return await replayLaunch(
      env,
      config,
      target.value,
      existing,
      launchIntentSha256,
    );
  }

  const issuedAt = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const facetProjectId = input.projectId ?? crypto.randomUUID();
  if (!Number.isSafeInteger(issuedAt) || !UUID_V4.test(facetProjectId))
    return rejected("facet_launch_authority_collision", 409);
  const launchTimes = {
    issuedAt,
    notBefore: issuedAt,
    expiresAt: issuedAt + LAUNCH_TTL_SECONDS,
  };
  const token = await signedLaunchToken(config.key, {
    ...target.value,
    facetProjectId,
    destinationTenantId: input.tenantId,
    sourceTenantId: config.sourceTenantId,
    ...launchTimes,
  });
  const launchEnvelopeSha256 = await sha256Hex(token);
  let identity = await facetV2ProducerIdentityLink(env, {
    destinationTenantId: input.tenantId,
    sourceTenantId: config.sourceTenantId,
  });
  if (
    identity &&
    !identityMatchesConfig(identity, config)
  )
    return rejected("facet_launch_authority_collision", 409);

  const registration = launchRegistration({
    config,
    target: target.value,
    actorUserId: input.actorUserId,
    facetProjectId,
    idempotencyKeySha256,
    launchIntentSha256,
    launchEnvelopeSha256,
    producerIdentityProofSha256: identity?.proofSha256 ?? launchEnvelopeSha256,
    ...launchTimes,
  });
  try {
    await registerFacetV2LaunchAuthority(env, registration);
  } catch {
    const raced = await launchByIdempotency(env, idempotencyKeySha256);
    if (raced)
      return await replayLaunch(
        env,
        config,
        target.value,
        raced,
        launchIntentSha256,
      );
    identity = await facetV2ProducerIdentityLink(env, {
      destinationTenantId: input.tenantId,
      sourceTenantId: config.sourceTenantId,
    });
    if (
      !identity ||
      !identityMatchesConfig(identity, config)
    )
      return rejected("facet_launch_authority_collision", 409);
    try {
      await registerFacetV2LaunchAuthority(env, {
        ...registration,
        producerIdentityProofSha256: identity.proofSha256,
      });
    } catch {
      const secondRace = await launchByIdempotency(env, idempotencyKeySha256);
      return secondRace
        ? await replayLaunch(
            env,
            config,
            target.value,
            secondRace,
            launchIntentSha256,
          )
        : rejected("facet_launch_authority_collision", 409);
    }
  }
  return launchProjection(
    config,
    facetProjectId,
    token,
    launchTimes.expiresAt,
    false,
  );
}

async function replayLaunch(
  env: AppEnv,
  config: FacetLaunchConfig,
  target: FacetLaunchTarget,
  stored: StoredFacetLaunch,
  launchIntentSha256: string,
): Promise<FacetLaunchIssueResult> {
  if (
    stored.launch_intent_sha256 !== launchIntentSha256 ||
    stored.destination_tenant_id !== config.destinationTenantId ||
    stored.source_tenant_id !== config.sourceTenantId ||
    stored.brand_id !== target.brandId ||
    stored.roof_job_id !== target.roofJobId ||
    stored.customer_quote_id !== target.customerQuoteId ||
    stored.quote_version !== target.quoteVersion ||
    stored.quote_approved_at !== target.quoteApprovedAt ||
    stored.customer_party_ref !== target.customerPartyRef ||
    stored.external_customer_identity_link_id !==
      target.externalCustomerIdentityLinkId
  )
    return rejected("facet_launch_idempotency_conflict", 409);
  const identity = await facetV2ProducerIdentityLink(env, {
    destinationTenantId: config.destinationTenantId,
    sourceTenantId: config.sourceTenantId,
  });
  if (!identity || !identityMatchesConfig(identity, config))
    return rejected("facet_launch_authority_collision", 409);
  const token = await signedLaunchToken(config.key, {
    ...target,
    facetProjectId: stored.facet_project_id,
    destinationTenantId: stored.destination_tenant_id,
    sourceTenantId: stored.source_tenant_id,
    issuedAt: stored.issued_at,
    notBefore: stored.not_before,
    expiresAt: stored.expires_at,
  });
  if ((await sha256Hex(token)) !== stored.launch_envelope_sha256)
    return rejected("facet_launch_authority_collision", 409);
  const registration = launchRegistration({
    config,
    target,
    actorUserId: stored.issued_by_user_id,
    facetProjectId: stored.facet_project_id,
    idempotencyKeySha256: stored.idempotency_key_sha256,
    launchIntentSha256: stored.launch_intent_sha256,
    launchEnvelopeSha256: stored.launch_envelope_sha256,
    producerIdentityProofSha256: identity.proofSha256,
    issuedAt: stored.issued_at,
    notBefore: stored.not_before,
    expiresAt: stored.expires_at,
    createdAt: stored.created_at,
  });
  if (!(await resolveRegisteredFacetV2LaunchAuthority(env, registration)))
    return rejected("facet_launch_authority_collision", 409);
  return launchProjection(
    config,
    stored.facet_project_id,
    token,
    stored.expires_at,
    true,
  );
}

function launchRegistration(input: {
  config: FacetLaunchConfig;
  target: FacetLaunchTarget;
  actorUserId: string;
  facetProjectId: string;
  idempotencyKeySha256: string;
  launchIntentSha256: string;
  launchEnvelopeSha256: string;
  producerIdentityProofSha256: string;
  issuedAt: number;
  notBefore: number;
  expiresAt: number;
  createdAt?: string;
}): FacetV2LaunchAuthorityRegistration {
  return {
    destinationTenantId: input.config.destinationTenantId,
    sourceTenantId: input.config.sourceTenantId,
    issuer: input.config.issuer,
    sourceEnvironment: input.config.sourceEnvironment,
    brandId: input.target.brandId,
    facetProjectId: input.facetProjectId,
    producerIdentityProofSha256: input.producerIdentityProofSha256,
    projectClaimSha256: input.launchEnvelopeSha256,
    customerPartyRef: input.target.customerPartyRef,
    externalCustomerIdentityLinkId: input.target.externalCustomerIdentityLinkId,
    roofJobId: input.target.roofJobId,
    customerQuoteId: input.target.customerQuoteId,
    createdByUserId: input.actorUserId,
    createdAt: input.createdAt ?? new Date(input.issuedAt * 1000).toISOString(),
    quoteVersion: input.target.quoteVersion,
    quoteApprovedAt: input.target.quoteApprovedAt,
    idempotencyKeySha256: input.idempotencyKeySha256,
    launchIntentSha256: input.launchIntentSha256,
    launchEnvelopeSha256: input.launchEnvelopeSha256,
    issuedAt: input.issuedAt,
    notBefore: input.notBefore,
    expiresAt: input.expiresAt,
  };
}

function identityMatchesConfig(
  identity: FacetV2ProducerIdentityLink,
  config: FacetLaunchConfig,
): boolean {
  return (
    identity.destinationTenantId === config.destinationTenantId &&
    identity.sourceTenantId === config.sourceTenantId &&
    identity.issuer === config.issuer &&
    identity.sourceEnvironment === config.sourceEnvironment
  );
}

async function resolveFacetLaunchTarget(
  env: AppEnv,
  jobName: string,
): Promise<
  | { ok: true; value: FacetLaunchTarget }
  | {
      ok: false;
      code:
        | "facet_design_roof_job_not_found"
        | "facet_design_current_approved_quote_required"
        | "facet_launch_customer_identity_required";
      status: 404 | 409;
    }
> {
  const jobs = await listFacetLaunchFrappeResource(
    env,
    "Roof Job",
    [["Roof Job", "name", "=", jobName]],
    2,
  );
  if (jobs.length !== 1 || text(jobs[0]?.name) !== jobName)
    return { ok: false, code: "facet_design_roof_job_not_found", status: 404 };
  const job = jobs[0]!;
  const roofJobId = text(job.roof_job_id);
  const brandId = text(job.brand);
  const customerId = text(job.customer);
  const quoteName = text(job.quotation);
  if (!roofJobId || !brandId || !customerId || !quoteName)
    return {
      ok: false,
      code: "facet_design_current_approved_quote_required",
      status: 409,
    };
  const quotes = await listFacetLaunchFrappeResource(
    env,
    "Customer Quote",
    [["Customer Quote", "roof_job", "=", jobName]],
    100,
  );
  const current = quotes.filter((quote) => text(quote.name) === quoteName);
  const quote = current.length === 1 ? current[0]! : null;
  const customerQuoteId = text(quote?.customer_quote_id);
  const quoteVersion = positiveInteger(quote?.quote_version);
  const quoteApprovedAt = text(quote?.approved_at);
  if (
    !quote ||
    text(quote.roof_job) !== jobName ||
    text(quote.customer) !== customerId ||
    text(quote.status) !== "Approved" ||
    !customerQuoteId ||
    quoteVersion === null ||
    !quoteApprovedAt
  )
    return {
      ok: false,
      code: "facet_design_current_approved_quote_required",
      status: 409,
    };
  const customers = await listFacetLaunchFrappeResource(
    env,
    "Roofing Customer",
    [["Roofing Customer", "name", "=", customerId]],
    2,
  );
  const email =
    customers.length === 1 && text(customers[0]?.name) === customerId
      ? normalizedEmail(customers[0]?.email)
      : null;
  if (!email)
    return {
      ok: false,
      code: "facet_launch_customer_identity_required",
      status: 409,
    };
  return {
    ok: true,
    value: {
      brandId,
      roofJobId,
      customerQuoteId,
      quoteVersion,
      quoteApprovedAt,
      customerPartyRef: await sha256Hex(`${CUSTOMER_PARTY_CONTEXT}\n${email}`),
      externalCustomerIdentityLinkId: `facet-customer-oidc-v1:${await sha256Hex(
        `${CUSTOMER_IDENTITY_CONTEXT}\n${email}`,
      )}`,
    },
  };
}

async function signedLaunchToken(
  key: Uint8Array,
  input: FacetLaunchTarget & {
    facetProjectId: string;
    destinationTenantId: string;
    sourceTenantId: string;
    issuedAt: number;
    notBefore: number;
    expiresAt: number;
  },
): Promise<string> {
  const payload = {
    aud: "facet-project-create",
    brand_id: input.brandId,
    customer_party_ref: input.customerPartyRef,
    exp: input.expiresAt,
    external_customer_identity_link_id: input.externalCustomerIdentityLinkId,
    iat: input.issuedAt,
    ironwrap_tenant_id: input.destinationTenantId,
    iss: "ironwrap-os",
    jti: input.facetProjectId,
    nbf: input.notBefore,
    sub: input.sourceTenantId,
    v: 1,
  };
  const signingInput = `${base64UrlText(canonicalJson(HEADER))}.${base64UrlText(
    canonicalJson(payload),
  )}`;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      cryptoKey,
      new TextEncoder().encode(signingInput),
    ),
  );
  return `${signingInput}.${base64Url(signature)}`;
}

function launchProjection(
  config: FacetLaunchConfig,
  facetProjectId: string,
  token: string,
  expiresAt: number,
  replayed: boolean,
): Extract<FacetLaunchIssueResult, { kind: "created" | "replayed" }> {
  return {
    kind: replayed ? "replayed" : "created",
    launch: {
      facet_project_id: facetProjectId,
      launch_url: `${config.baseUrl}#iwlaunch=${token}`,
      expires_at: new Date(expiresAt * 1000).toISOString(),
      state: "issued",
    },
  };
}

function launchConfig(
  env: AppEnv,
  destinationTenantId: string,
): FacetLaunchConfig | null {
  if (String(env.APP_FACET_LAUNCH_ENABLED ?? "").trim() !== "true") return null;
  const sourceTenantId =
    env.APP_FACET_LAUNCH_SOURCE_TENANT_ID?.trim().toLowerCase() ?? "";
  const key = decodeKey(env.FACET_LAUNCH_HMAC_KEY?.trim() ?? "");
  const routes = facetV2StaticRoutes(env);
  if (!UUID_V4.test(sourceTenantId) || !key || !routes) return null;
  const matchingRoutes = routes.filter(
    (route) =>
      route.destinationTenantId === destinationTenantId &&
      route.sourceTenantId === sourceTenantId,
  );
  if (matchingRoutes.length !== 1) return null;
  const route = matchingRoutes[0]!;
  try {
    const url = new URL(env.APP_FACET_LAUNCH_BASE_URL?.trim() ?? "");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !publicHostname(url.hostname)
    )
      return null;
    return {
      baseUrl: url.toString(),
      key,
      destinationTenantId,
      sourceTenantId,
      issuer: route.issuer,
      sourceEnvironment: route.sourceEnvironment,
    };
  } catch {
    return null;
  }
}

async function launchByIdempotency(
  env: AppEnv,
  idempotencyKeySha256: string,
): Promise<StoredFacetLaunch | null> {
  return await env.DB.prepare(
    `SELECT * FROM facet_v2_project_launches WHERE idempotency_key_sha256 = ? LIMIT 1`,
  )
    .bind(idempotencyKeySha256)
    .first<StoredFacetLaunch>();
}

function decodeKey(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(
      normalized + "=".repeat((4 - (normalized.length % 4)) % 4),
    );
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return bytes.length >= 32 && base64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function base64UrlText(value: string): string {
  return base64Url(new TextEncoder().encode(value));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function normalizedEmail(value: unknown): string | null {
  const email = text(value)?.toLowerCase() ?? "";
  return email && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : null;
}

function publicHostname(hostname: string): boolean {
  const value = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    Boolean(value) &&
    value !== "localhost" &&
    !value.endsWith(".localhost") &&
    !value.endsWith(".local") &&
    !/^\d+\.\d+\.\d+\.\d+$/.test(value) &&
    !value.includes(":")
  );
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function rejected(
  code: Extract<FacetLaunchIssueResult, { kind: "rejected" }>["code"],
  status: 403 | 404 | 409 | 503,
): Extract<FacetLaunchIssueResult, { kind: "rejected" }> {
  return { kind: "rejected", code, status };
}
