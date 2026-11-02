import {
  appPublicOrigin,
  authRequestContext,
  configuredTenantId,
  publicTenant,
  randomToken,
  sha256Hex,
  validAppCsrf,
  validateAppOrigin,
} from "./app-auth.ts";
import * as authStore from "./app-auth-store.ts";
import {
  claimCustomerPortalAccessThrottle,
  findActiveCustomerPortalLink,
  listCustomerPortalLinks,
  recordCustomerPortalProposalView,
  replaceCustomerPortalLink,
  revokeCustomerPortalLink,
  touchCustomerPortalLink,
  type ActiveCustomerPortalLink,
  type CustomerPortalLinkRecord,
} from "./customer-portal-store.ts";
import { gmailConfigured } from "./google.ts";
import {
  readNativeCommercialJobPacket,
  readNativeJobCore,
  type NativeCommercialJobPacket,
  type NativeJobCoreRecord,
} from "./native-job-packet-read.ts";
import type { AppEnv, AuthContext, AuthRequestContext } from "./app-types.ts";
import { customerContractAcceptanceAvailable } from "./customer-contract-acceptance.ts";
import { customerDecisionBackendEnabled } from "./customer-decision-config.ts";
import { getCompanyProfile } from "./company-setup-store.ts";
import { publicCompanyContact } from "./company-profile.ts";
import { getCurrentOperatingJobAssignment } from "./operating-job-assignment-store.ts";

const MAX_PORTAL_BODY_BYTES = 1024;
const PORTAL_ACCESS_WINDOW_MS = 15 * 60 * 1000;
const PORTAL_ACCESS_IP_LIMIT = 120;
const PORTAL_MIN_TTL_MS = 60 * 60 * 1000;
const PORTAL_MAX_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface CustomerPortalReadModel {
  version: 1;
  brand: string;
  /** Owner-saved customer-facing company contact; never a staff identity or a default. */
  company_contact?: { phone: string | null; email: string | null };
  contract_acceptance_available: boolean;
  material_decision_available: boolean;
  source_updated_at: string | null;
  read_model_generated_at: string;
  job: {
    job_number: string | null;
    service_type: string | null;
    status: string | null;
  };
  install_window: {
    scheduled_start: string;
    scheduled_end: string | null;
    /** The office saved this assignment; this does not assert customer consent. */
    confirmed: true;
    confirmation_basis: "office_committed_assignment";
  } | null;
  proposal: {
    status: string | null;
    prepared_at: string | null;
    approved_at: string | null;
    signed_at: string | null;
    quote: {
      version: number | null;
      status: string | null;
      total: number | null;
      currency: string | null;
      deposit_amount: number | null;
      balance_due: number | null;
      payment_status: string | null;
      payment_due_date: string | null;
      valid_until: string | null;
      scope_summary: string | null;
      assumptions: string | null;
      exclusions: string | null;
    } | null;
  } | null;
  scope: Array<{
    id: string;
    type: string | null;
    title: string | null;
    text: string | null;
    version: string | null;
  }>;
  option_packages: Array<{
    id: string;
    package_name: string | null;
    tier: string | null;
    material_system: string | null;
    price_delta: number | null;
    currency: string | null;
    options: Record<string, unknown> | null;
    warranty_summary: string | null;
  }>;
  progress: Array<{
    id: string;
    type: string | null;
    proof_slot: string | null;
    captured_at: string | null;
    summary: string | null;
  }>;
  closeout: {
    approved_at: string | null;
    warranty_ready: boolean;
  } | null;
  warranty: {
    status: string | null;
    material_system: string | null;
    terms: string | null;
    coverage_start: string | null;
    coverage_years: number | null;
    exclusions: string | null;
    issued_at: string | null;
  } | null;
}

export function customerPortalEnabled(env: AppEnv): boolean {
  return String(env.APP_CUSTOMER_PORTAL_ENABLED) === "true";
}

/**
 * Recording the first open of a proposal (0163) stays off until the owner approves the portal
 * privacy notice that says the first open is recorded and kept for at most 3 years.
 */
export function customerPortalProposalViewsEnabled(env: AppEnv): boolean {
  return String(env.APP_CUSTOMER_PORTAL_PROPOSAL_VIEWS_ENABLED) === "true";
}

const log = (o: Record<string, unknown>) => console.log(JSON.stringify(o));

/** Optional feature gates must not make the core Worker unready while disabled. */
export function customerPortalConfigured(env: AppEnv): boolean {
  if (!customerPortalEnabled(env)) return true;
  // Link revocation belongs to the authenticated office control plane, but portal reads no longer
  // depend on the separate Frappe adapter used by other office surfaces.
  const emailReady =
    gmailConfigured(env) || String(env.APP_ALLOW_INSECURE_LOCAL) === "true";
  return (
    String(env.APP_BFF_ENABLED) === "true" &&
    !!env.DB &&
    !!configuredTenantId(env) &&
    !!publicTenant(env) &&
    !!appPublicOrigin(env) &&
    (env.APP_AUTH_PEPPER?.trim().length ?? 0) >= 32 &&
    emailReady
  );
}

/**
 * Resolve a customer capability without accepting office cookies or an arbitrary path token.
 * Every invalid state deliberately produces the same not-found response. The app adds
 * `staff_preview: true` while an office sign-in is live in that browser; it only ever stops a
 * first-open record, so a forged flag can under-record and never over-record.
 */
export async function handleCustomerPortalResolve(
  req: Request,
  env: AppEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  if (req.method !== "POST" || !customerPortalEnabled(env))
    return portalNotFound();
  if (!customerPortalConfigured(env)) return portalUnavailable();

  const configuredOrigin = appPublicOrigin(env);
  const origin = validateAppOrigin(req, env, true);
  if (!origin.ok || origin.origin !== configuredOrigin) return portalNotFound();

  const parsed = await readPortalBody(req);
  if (
    !parsed.ok ||
    typeof parsed.value.token !== "string" ||
    Object.keys(parsed.value).some((key) => key !== "token" && key !== "staff_preview") ||
    (parsed.value.staff_preview !== undefined && parsed.value.staff_preview !== true)
  ) {
    return portalNotFound();
  }
  const rawToken = parsed.value.token;
  const staffPreview = parsed.value.staff_preview === true;
  if (!/^[A-Za-z0-9_-]{43}$/.test(rawToken)) return portalNotFound();

  const tenantId = configuredTenantId(env);
  if (!tenantId) return portalUnavailable();
  const now = new Date();
  try {
    const request = await authRequestContext(req, env);
    const throttled = await claimCustomerPortalAccessThrottle(env, {
      tenantId,
      ipHash: request.ip_hash,
      now: now.toISOString(),
      windowExpiresAt: new Date(
        now.getTime() + PORTAL_ACCESS_WINDOW_MS,
      ).toISOString(),
      limit: PORTAL_ACCESS_IP_LIMIT,
    });
    if (!throttled) return portalNotFound();

    const link = await findActiveCustomerPortalLink(
      env,
      await sha256Hex(rawToken),
      tenantId,
      now.toISOString(),
    );
    if (!link) return portalNotFound();
    const portal = await buildCustomerPortalReadModel(env, link);
    if (!portal) return portalNotFound();
    await touchCustomerPortalLink(env, {
      tenantId,
      linkId: link.link_id,
      now: now.toISOString(),
    });
    // The record is written after the response, so it can neither slow nor break the page.
    const waitUntil = (ctx as Partial<ExecutionContext> | undefined)?.waitUntil;
    if (portal.publication && customerPortalProposalViewsEnabled(env) && typeof waitUntil === "function") {
      waitUntil.call(ctx, recordFirstProposalOpen(env, link, request, staffPreview, portal.publication, now));
    }
    return portalJson(portal.model);
  } catch {
    // A D1 outage says nothing about whether a supplied capability was valid.
    return portalUnavailable();
  }
}

/**
 * Record the first time someone holding the customer's link opened the proposal publication this
 * page shows (0163): ids and this request's time, nothing about the device. Staff are skipped: a
 * request the app marks as a staff preview, or one from the device that issued the link. A failure
 * is logged; the page was already served.
 */
async function recordFirstProposalOpen(
  env: AppEnv,
  link: ActiveCustomerPortalLink,
  request: AuthRequestContext,
  staffPreview: boolean,
  publication: PublishedCommercial["publication"],
  now: Date,
): Promise<void> {
  if (staffPreview) return;
  if (
    request.ip_hash === link.issued_ip_hash &&
    request.user_agent_hash === link.issued_user_agent_hash
  ) {
    return;
  }
  try {
    await recordCustomerPortalProposalView(env, {
      viewId: `portal-view:${await sha256Hex(
        `${link.tenant_id}|${link.link_id}|${publication.publication_event_id}`,
      )}`,
      tenantId: link.tenant_id,
      linkId: link.link_id,
      roofJobId: link.roof_job_id,
      customerId: link.customer_id,
      proposalPackId: publication.proposal_pack_id,
      proposalRevisionId: publication.proposal_revision_id,
      publicationEventId: publication.publication_event_id,
      viewedAt: now.toISOString(),
    });
  } catch (error) {
    log({ at: "customer_portal_proposal_view", error: String(error) });
  }
}

/**
 * The office BFF may issue, inspect, and revoke links, but never retrieve a raw token after
 * issuance. The only bearer copy is the single response that the office explicitly shares.
 */
export async function handleCustomerPortalLinks(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
): Promise<Response> {
  if (!officeRole(auth))
    return portalJson({ error: "office_role_required" }, 403);
  if (!customerPortalEnabled(env))
    return portalJson({ error: "customer_portal_disabled" }, 503);
  if (!customerPortalConfigured(env))
    return portalJson({ error: "customer_portal_not_configured" }, 503);

  const tenantId = configuredTenantId(env);
  const origin = appPublicOrigin(env);
  if (!tenantId || !origin || auth.session.tenant_id !== tenantId) {
    return portalJson({ error: "customer_portal_not_configured" }, 503);
  }
  const url = new URL(req.url);
  if (
    req.method === "GET" &&
    url.pathname === "/api/v1/customer-portal/links"
  ) {
    const roofJobId = url.searchParams.get("roof_job_id");
    if (roofJobId !== null && !validResourceId(roofJobId))
      return portalJson({ error: "invalid_roof_job" }, 400);
    try {
      const links = await listCustomerPortalLinks(
        env,
        tenantId,
        roofJobId ?? undefined,
      );
      return portalJson({ links: links.map(publicLink) });
    } catch {
      return portalJson({ error: "customer_portal_store_unavailable" }, 502);
    }
  }
  if (
    req.method === "POST" &&
    url.pathname === "/api/v1/customer-portal/links"
  ) {
    if (!validAppCsrf(req, auth))
      return portalJson({ error: "csrf_failed" }, 403);
    const parsed = await readPortalBody(req);
    if (!parsed.ok) return portalJson({ error: parsed.error }, parsed.status);
    if (
      Object.keys(parsed.value).some(
        (key) => key !== "roof_job_id" && key !== "expires_at",
      )
    ) {
      return portalJson({ error: "unexpected_field" }, 400);
    }
    const roofJobId =
      typeof parsed.value.roof_job_id === "string"
        ? parsed.value.roof_job_id.trim()
        : "";
    const now = new Date();
    const expiresAt = parsedExpiry(parsed.value.expires_at, now);
    if (!validResourceId(roofJobId))
      return portalJson({ error: "invalid_roof_job" }, 400);
    if (!expiresAt) return portalJson({ error: "invalid_expiry" }, 400);
    try {
      const binding = await customerJobBinding(env, tenantId, roofJobId);
      if (!binding) return portalJson({ error: "customer_job_not_found" }, 404);
      const rawToken = randomToken();
      const createdAt = now.toISOString();
      const link: CustomerPortalLinkRecord = {
        link_id: `portal_${crypto.randomUUID()}`,
        tenant_id: tenantId,
        roof_job_id: binding.roofJobId,
        customer_id: binding.customerId,
        issued_by_user_id: auth.session.user_id,
        created_at: createdAt,
        expires_at: expiresAt,
        revoked_at: null,
        revoked_by_user_id: null,
        last_accessed_at: null,
        access_count: 0,
      };
      const request = await authRequestContext(req, env);
      await replaceCustomerPortalLink(env, {
        linkId: link.link_id,
        tokenHash: await sha256Hex(rawToken),
        tenantId,
        roofJobId: link.roof_job_id,
        customerId: link.customer_id,
        issuedByUserId: link.issued_by_user_id,
        createdAt,
        expiresAt,
        request,
      });
      await authStore.recordAuthAudit(env, {
        tenantId,
        userId: auth.session.user_id,
        event: "customer_portal_issue",
        outcome: "issued",
        request,
        detailCode: link.link_id,
      });
      // The fragment keeps the bearer out of HTTP access logs and referrer headers. The portal
      // immediately scrubs it before its fixed-path POST resolver request.
      return portalJson({
        link: publicLink(link),
        portal_url: `${origin}/portal#token=${encodeURIComponent(rawToken)}`,
      });
    } catch {
      return portalJson({ error: "customer_portal_issue_unavailable" }, 502);
    }
  }
  const revoke = url.pathname.match(
    /^\/api\/v1\/customer-portal\/links\/(portal_[0-9a-f-]{36})\/revoke$/i,
  );
  if (req.method === "POST" && revoke) {
    if (!validAppCsrf(req, auth))
      return portalJson({ error: "csrf_failed" }, 403);
    const now = new Date().toISOString();
    try {
      const revoked = await revokeCustomerPortalLink(env, {
        tenantId,
        linkId: revoke[1],
        revokedByUserId: auth.session.user_id,
        now,
      });
      if (!revoked) return portalJson({ error: "not_found" }, 404);
      const request = await authRequestContext(req, env);
      await authStore.recordAuthAudit(env, {
        tenantId,
        userId: auth.session.user_id,
        event: "customer_portal_revoke",
        outcome: "revoked",
        request,
        detailCode: revoke[1],
      });
      return portalJson({ ok: true, link_id: revoke[1], revoked_at: now });
    } catch {
      return portalJson({ error: "customer_portal_revoke_unavailable" }, 502);
    }
  }
  return portalJson({ error: "not_found" }, 404);
}

/**
 * Re-read the bound job on every customer request. A capability therefore stops working if the
 * job is later reassigned to a different customer, even before an office user manually revokes it.
 * Beside the model it returns the publication the page shows, if any; that stays in the Worker.
 */
export async function buildCustomerPortalReadModel(
  env: AppEnv,
  link: CustomerPortalLinkRecord,
): Promise<{
  model: CustomerPortalReadModel;
  publication: PublishedCommercial["publication"] | null;
} | null> {
  const core = await readNativeJobCore(env, link.tenant_id, link.roof_job_id);
  const job = core?.job;
  if (
    !job ||
    job.roof_job_id !== link.roof_job_id ||
    job.customer_id !== link.customer_id
  )
    return null;

  const commercial = await readNativeCommercialJobPacket(
    env,
    link.tenant_id,
    link.roof_job_id,
    50,
  );
  const published =
    commercial?.partial_sources.length === 0
      ? currentPublishedCommercial(commercial, link)
      : null;
  const sourceTimestamps = [job.updated_at];
  if (published) {
    sourceTimestamps.push(
      published.quote.created_at,
      published.proposal.created_at,
      published.publication.occurred_at,
    );
    if (published.acceptance)
      sourceTimestamps.push(published.acceptance.accepted_at);
  }
  const [contractAcceptanceAvailable, optionPackages, assignment, companyProfile] = await Promise.all([
    customerContractAcceptanceAvailable(env, {
      tenant_id: link.tenant_id,
      roof_job_id: link.roof_job_id,
      customer_id: link.customer_id,
    }),
    listNativeOptionPackages(env, link.tenant_id, link.roof_job_id),
    job.job_status === "cancelled"
      ? Promise.resolve(null)
      : currentNativePortalAssignment(env, link),
    getCompanyProfile(env, link.tenant_id),
  ]);
  if (assignment) sourceTimestamps.push(assignment.created_at);
  if (companyProfile.updated_at) sourceTimestamps.push(companyProfile.updated_at);
  const companyContact = publicCompanyContact(companyProfile);

  const model: CustomerPortalReadModel = {
    version: 1,
    brand: customerPortalBrand(job, env),
    ...(companyContact ? { company_contact: companyContact } : {}),
    contract_acceptance_available: contractAcceptanceAvailable,
    material_decision_available: customerDecisionBackendEnabled(env) &&
      optionPackages.length > 0,
    option_packages: optionPackages,
    source_updated_at: latestTimestamp(sourceTimestamps),
    read_model_generated_at: new Date().toISOString(),
    job: {
      job_number: text(job.job_number, 140),
      service_type: text(job.service_type, 120),
      status: text(job.job_status, 120),
    },
    // The native assignment is the office's committed schedule. Private approval proposals and
    // legacy assignments have no native commitment here and must never become customer promises.
    install_window: assignment
      ? {
          scheduled_start: assignment.scheduled_start,
          scheduled_end: assignment.scheduled_end,
          confirmed: true,
          confirmation_basis: "office_committed_assignment",
        }
      : null,
    proposal: published
      ? {
          status: published.acceptance ? "Signed" : "Sent",
          prepared_at: iso(published.proposal.created_at),
          approved_at: null,
          signed_at: iso(published.acceptance?.accepted_at),
          quote: {
            version: published.quote.revision_number,
            status: published.acceptance
              ? "Accepted"
              : published.quote.status === "expired"
                ? "Expired"
                : "Approved",
            total: moneyFromCents(published.quote.total_cents),
            currency: text(published.quote.currency, 8),
            deposit_amount: null,
            balance_due: null,
            payment_status: null,
            payment_due_date: null,
            valid_until: iso(published.quote.valid_until),
            scope_summary: null,
            assumptions: null,
            exclusions: null,
          },
        }
      : null,
    // Native work evidence has no customer-safe publication fact yet. Never infer one from
    // verification alone; the UI renders an explicit "not published yet" state for an empty list.
    scope: [],
    progress: [],
    closeout: null,
    warranty: null,
  };
  return { model, publication: published?.publication ?? null };
}

async function currentNativePortalAssignment(
  env: AppEnv,
  link: CustomerPortalLinkRecord,
) {
  try {
    return await getCurrentOperatingJobAssignment(env, link.tenant_id, link.roof_job_id);
  } catch (error) {
    // A pre-cutover database has no native schedule to share. Other read failures must still
    // reach the portal's unavailable response instead of presenting a false missing schedule.
    if (String(error).includes("no such table: operating_job_assignments")) return null;
    throw error;
  }
}

async function listNativeOptionPackages(
  env: AppEnv,
  tenantId: string,
  roofJobId: string,
): Promise<CustomerPortalReadModel["option_packages"]> {
  if (!env.DB) return [];
  try {
    const result = await env.DB.prepare(
      `SELECT option_id, title, tier, material_system, options_json, price_delta_cents,
              currency, warranty_summary
         FROM operating_option_packages
        WHERE tenant_id = ? AND job_id = ? AND status = 'approved'
        ORDER BY option_id`,
    ).bind(tenantId, roofJobId).all<{
      option_id: string;
      title: string;
      tier: string | null;
      material_system: string | null;
      options_json: string | null;
      price_delta_cents: number | null;
      currency: string | null;
      warranty_summary: string | null;
    }>();
    return (result.results ?? []).map((row) => mapOptionPackage(row));
  } catch (error) {
    const detail = String(error);
    if (detail.includes("no such table")) return [];
    if (detail.includes("no such column")) {
      return await listNativeOptionPackagesLegacy(env, tenantId, roofJobId);
    }
    throw error;
  }
}

async function listNativeOptionPackagesLegacy(
  env: AppEnv,
  tenantId: string,
  roofJobId: string,
): Promise<CustomerPortalReadModel["option_packages"]> {
  const result = await env.DB.prepare(
    `SELECT option_id, title, tier, material_system
       FROM operating_option_packages
      WHERE tenant_id = ? AND job_id = ? AND status = 'approved'
      ORDER BY option_id`,
  ).bind(tenantId, roofJobId).all<{
    option_id: string;
    title: string;
    tier: string | null;
    material_system: string | null;
  }>();
  return (result.results ?? []).map((row) => mapOptionPackage(row));
}

function mapOptionPackage(row: {
  option_id: string;
  title: string;
  tier: string | null;
  material_system: string | null;
  options_json?: string | null;
  price_delta_cents?: number | null;
  currency?: string | null;
  warranty_summary?: string | null;
}): CustomerPortalReadModel["option_packages"][number] {
  return {
    id: row.option_id,
    package_name: text(row.title, 200),
    tier: text(row.tier, 40),
    material_system: text(row.material_system, 200),
    price_delta: Number.isFinite(row.price_delta_cents)
      ? Number(row.price_delta_cents) / 100
      : null,
    currency: text(row.currency, 8),
    options: parseOptionJson(row.options_json),
    warranty_summary: text(row.warranty_summary, 2000),
  };
}

function parseOptionJson(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function customerJobBinding(
  env: AppEnv,
  tenantId: string,
  roofJobId: string,
): Promise<{ roofJobId: string; customerId: string } | null> {
  const core = await readNativeJobCore(env, tenantId, roofJobId);
  return core?.job.roof_job_id === roofJobId && core.job.customer_id
    ? { roofJobId: core.job.roof_job_id, customerId: core.job.customer_id }
    : null;
}

function customerPortalBrand(job: NativeJobCoreRecord, env: AppEnv): string {
  const brand = text(job.brand, 80)?.toLowerCase();
  if (brand === "ironwrap") return "IronWrap Exteriors";
  if (brand === "iroof") return "iRoof Alberta";
  return publicTenant(env)?.brand ?? "IronWrap";
}

function publicLink(link: CustomerPortalLinkRecord): Record<string, unknown> {
  return {
    id: link.link_id,
    roof_job_id: link.roof_job_id,
    created_at: link.created_at,
    expires_at: link.expires_at,
    revoked_at: link.revoked_at,
    last_accessed_at: link.last_accessed_at,
    access_count: Number(link.access_count),
  };
}

function parsedExpiry(value: unknown, now: Date): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  if (
    time < now.getTime() + PORTAL_MIN_TTL_MS ||
    time > now.getTime() + PORTAL_MAX_TTL_MS
  )
    return null;
  return new Date(time).toISOString();
}

type PublishedCommercial = {
  quote: NativeCommercialJobPacket["quotes"][number];
  proposal: NativeCommercialJobPacket["proposals"][number];
  publication: NativeCommercialJobPacket["publications"][number];
  acceptance: NativeCommercialJobPacket["acceptances"][number] | null;
};

function currentPublishedCommercial(
  packet: NativeCommercialJobPacket,
  link: CustomerPortalLinkRecord,
): PublishedCommercial | null {
  const latestByPack = new Map<
    string,
    NativeCommercialJobPacket["publications"][number]
  >();
  for (const publication of packet.publications) {
    const current = latestByPack.get(publication.proposal_pack_id);
    if (
      !current ||
      publication.publication_version > current.publication_version ||
      (publication.publication_version === current.publication_version &&
        publication.occurred_at > current.occurred_at)
    ) {
      latestByPack.set(publication.proposal_pack_id, publication);
    }
  }

  const candidates: PublishedCommercial[] = [];
  for (const publication of latestByPack.values()) {
    if (
      publication.tenant_id !== link.tenant_id ||
      publication.state !== "published"
    )
      continue;
    const proposal = packet.proposals.find(
      (row) =>
        row.tenant_id === link.tenant_id &&
        row.proposal_revision_id === publication.proposal_revision_id &&
        row.proposal_pack_id === publication.proposal_pack_id &&
        row.roof_job_id === link.roof_job_id &&
        row.customer_id === link.customer_id,
    );
    if (!proposal) continue;
    const quote = packet.quotes.find(
      (row) =>
        row.tenant_id === link.tenant_id &&
        row.quote_revision_id === proposal.quote_revision_id &&
        row.roof_job_id === link.roof_job_id &&
        row.customer_id === link.customer_id &&
        row.terms_hash === proposal.terms_hash &&
        (row.status === "approved" || row.status === "expired"),
    );
    if (!quote) continue;
    const acceptance =
      packet.acceptances
        .filter(
          (row) =>
            row.tenant_id === link.tenant_id &&
            row.quote_revision_id === quote.quote_revision_id &&
            row.proposal_revision_id === proposal.proposal_revision_id &&
            row.roof_job_id === link.roof_job_id &&
            row.customer_id === link.customer_id &&
            row.terms_hash === proposal.terms_hash,
        )
        .sort((left, right) =>
          right.accepted_at.localeCompare(left.accepted_at),
        )[0] ?? null;
    candidates.push({ quote, proposal, publication, acceptance });
  }
  return candidates.length === 1 ? candidates[0]! : null;
}

function latestTimestamp(values: string[]): string | null {
  return values.reduce<string | null>((latest, raw) => {
    const value = iso(raw);
    return value && (!latest || value > latest) ? value : latest;
  }, null);
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result && result.length <= max ? result : null;
}

function iso(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function moneyFromCents(value: number): number | null {
  return Number.isSafeInteger(value) ? value / 100 : null;
}

function officeRole(auth: AuthContext): boolean {
  return auth.session.role === "owner" || auth.session.role === "ops";
}

function validResourceId(value: string): boolean {
  return /^[A-Za-z0-9._:-]{3,140}$/.test(value);
}

async function readPortalBody(
  req: Request,
): Promise<
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string; status: number }
> {
  if (
    Number(req.headers.get("content-length") ?? "0") > MAX_PORTAL_BODY_BYTES
  ) {
    return { ok: false, error: "payload_too_large", status: 413 };
  }
  const raw = await req.text();
  if (raw.length > MAX_PORTAL_BODY_BYTES)
    return { ok: false, error: "payload_too_large", status: 413 };
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? { ok: true, value: value as Record<string, unknown> }
      : { ok: false, error: "invalid_body", status: 400 };
  } catch {
    return { ok: false, error: "invalid_json", status: 400 };
  }
}

function portalNotFound(): Response {
  return portalJson({ error: "not_found" }, 404);
}

function portalUnavailable(): Response {
  return portalJson({ error: "portal_unavailable" }, 503);
}

function portalJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
    },
  });
}
