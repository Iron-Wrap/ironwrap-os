import {
  appBffConfigured,
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
  replaceCustomerPortalLink,
  revokeCustomerPortalLink,
  touchCustomerPortalLink,
  type CustomerPortalLinkRecord,
} from "./customer-portal-store.ts";
import {
  listCustomerPortalFrappeResource,
  type FrappeRow,
} from "./frappe-read.ts";
import type { AppEnv, AuthContext } from "./app-types.ts";

const MAX_PORTAL_BODY_BYTES = 1024;
const PORTAL_ACCESS_WINDOW_MS = 15 * 60 * 1000;
const PORTAL_ACCESS_IP_LIMIT = 120;
const PORTAL_MIN_TTL_MS = 60 * 60 * 1000;
const PORTAL_MAX_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface CustomerPortalReadModel {
  version: 1;
  brand: string;
  source_updated_at: string | null;
  read_model_generated_at: string;
  job: {
    job_number: string | null;
    service_type: string | null;
    status: string | null;
  };
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

/** Optional feature gates must not make the core Worker unready while disabled. */
export function customerPortalConfigured(env: AppEnv): boolean {
  if (!customerPortalEnabled(env)) return true;
  // Keep customer links fail-closed whenever the office control plane that can revoke them is
  // unavailable. appBffConfigured intentionally returns true for a disabled optional BFF, so
  // require the explicit enablement flag here as well.
  return String(env.APP_BFF_ENABLED) === "true" && appBffConfigured(env);
}

/**
 * Resolve a customer capability without accepting office cookies or an arbitrary path token.
 * Every invalid state deliberately produces the same not-found response.
 */
export async function handleCustomerPortalResolve(
  req: Request,
  env: AppEnv,
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
    Object.keys(parsed.value).length !== 1 ||
    typeof parsed.value.token !== "string"
  ) {
    return portalNotFound();
  }
  const rawToken = parsed.value.token;
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
    const model = await buildCustomerPortalReadModel(env, link);
    if (!model) return portalNotFound();
    await touchCustomerPortalLink(env, {
      tenantId,
      linkId: link.link_id,
      now: now.toISOString(),
    });
    return portalJson(model);
  } catch {
    // A Frappe/D1 outage says nothing about whether a supplied capability was valid.
    return portalUnavailable();
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
    if (roofJobId !== null && !validFrappeName(roofJobId))
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
    if (!validFrappeName(roofJobId))
      return portalJson({ error: "invalid_roof_job" }, 400);
    if (!expiresAt) return portalJson({ error: "invalid_expiry" }, 400);
    try {
      const binding = await customerJobBinding(env, roofJobId);
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
 */
export async function buildCustomerPortalReadModel(
  env: AppEnv,
  link: CustomerPortalLinkRecord,
): Promise<CustomerPortalReadModel | null> {
  const jobs = await listCustomerPortalFrappeResource(
    env,
    "Roof Job",
    [["Roof Job", "name", "=", link.roof_job_id]],
    1,
  );
  const job = jobs[0];
  if (
    !job ||
    text(job.name, 140) !== link.roof_job_id ||
    text(job.customer, 140) !== link.customer_id
  )
    return null;

  const [
    quotes,
    proposalPacks,
    clauses,
    evidence,
    completionPackets,
    warrantyPackets,
  ] = await Promise.all([
    listCustomerPortalFrappeResource(
      env,
      "Customer Quote",
      [["Customer Quote", "roof_job", "=", link.roof_job_id]],
      20,
    ),
    listCustomerPortalFrappeResource(
      env,
      "Proposal Evidence Pack",
      [["Proposal Evidence Pack", "roof_job", "=", link.roof_job_id]],
      20,
    ),
    listCustomerPortalFrappeResource(
      env,
      "Scope Clause",
      [["Scope Clause", "roof_job", "=", link.roof_job_id]],
      50,
    ),
    listCustomerPortalFrappeResource(
      env,
      "Evidence Item",
      [["Evidence Item", "roof_job", "=", link.roof_job_id]],
      50,
    ),
    listCustomerPortalFrappeResource(
      env,
      "Completion Packet",
      [["Completion Packet", "roof_job", "=", link.roof_job_id]],
      10,
    ),
    listCustomerPortalFrappeResource(
      env,
      "Warranty Packet",
      [["Warranty Packet", "roof_job", "=", link.roof_job_id]],
      10,
    ),
  ]);

  const quoteName = text(job.quotation, 140);
  const quote = quoteName
    ? quotes.find(
        (row) =>
          text(row.name, 140) === quoteName &&
          text(row.roof_job, 140) === link.roof_job_id &&
          text(row.customer, 140) === link.customer_id &&
          customerQuoteStatus(text(row.status, 80)),
      )
    : undefined;
  // Quote terms are customer-visible only through a separately published, quote-owned proof
  // pack. An approved quote by itself remains office-only: a portal link must not bypass the
  // Owner Operator publication gate.
  const proposal = quote
    ? newest(
        proposalPacks.filter(
          (row) =>
            text(row.roof_job, 140) === link.roof_job_id &&
            text(row.quotation, 140) === quoteName &&
            customerProposalStatus(text(row.status, 80)),
        ),
      )
    : undefined;
  const scopeRows = proposal
    ? clauses.filter(
        (row) =>
          text(row.roof_job, 140) === link.roof_job_id &&
          text(row.status, 80) === "Approved" &&
          truthy(row.customer_visible),
      )
    : [];
  const scope = scopeRows
    .map((row) => ({
      id: text(row.scope_clause_id, 140) ?? text(row.name, 140) ?? "",
      type: text(row.clause_type, 120),
      title: text(row.title, 500),
      text: text(row.clause_text, 8_000),
      version: text(row.version, 120),
    }))
    .filter((row) => row.id)
    .sort((left, right) => (left.title ?? "").localeCompare(right.title ?? ""));
  const progress = evidence
    .filter(
      (row) =>
        text(row.roof_job, 140) === link.roof_job_id &&
        truthy(row.customer_safe) &&
        text(row.sync_state, 80) === "Verified",
    )
    .map((row) => ({
      id: text(row.evidence_id, 140) ?? text(row.name, 140) ?? "",
      type: text(row.evidence_type, 120),
      proof_slot: text(row.proof_slot, 120),
      captured_at: iso(row.captured_at),
      summary: text(row.summary, 600),
    }))
    .filter((row) => row.id)
    .sort((left, right) =>
      (right.captured_at ?? "").localeCompare(left.captured_at ?? ""),
    );
  const completion = newest(
    completionPackets.filter(
      (row) =>
        text(row.roof_job, 140) === link.roof_job_id &&
        text(row.status, 80) === "Approved",
    ),
  );
  const warranty = newest(
    warrantyPackets.filter(
      (row) =>
        text(row.roof_job, 140) === link.roof_job_id &&
        text(row.status, 80) === "Issued",
    ),
  );
  const rowsUsed = [
    job,
    ...(proposal && quote ? [quote] : []),
    ...(proposal ? [proposal] : []),
    ...scopeRows,
    ...evidence,
    ...completionPackets,
    ...warrantyPackets,
  ];

  return {
    version: 1,
    brand: publicTenant(env)?.brand ?? "IronWrap",
    source_updated_at: latestModified(rowsUsed),
    read_model_generated_at: new Date().toISOString(),
    job: {
      job_number: text(job.job_number, 140),
      service_type: text(job.service_type, 120),
      status: text(job.job_status, 120),
    },
    proposal:
      proposal && quote
        ? {
            status: proposal ? text(proposal.status, 80) : null,
            prepared_at: proposal ? iso(proposal.prepared_at) : null,
            approved_at: proposal ? iso(proposal.approved_at) : null,
            signed_at: proposal ? iso(proposal.signed_at) : null,
            quote: quote
              ? {
                  version: number(quote.quote_version),
                  status: text(quote.status, 80),
                  total: number(quote.quote_total),
                  currency: text(quote.currency, 8),
                  deposit_amount: number(quote.deposit_amount),
                  balance_due: number(quote.balance_due),
                  payment_status: text(quote.payment_status, 80),
                  payment_due_date: iso(quote.payment_due_date),
                  valid_until: iso(quote.valid_until),
                  scope_summary: text(quote.scope_summary, 8_000),
                  assumptions: text(quote.assumptions, 8_000),
                  exclusions: text(quote.exclusions, 8_000),
                }
              : null,
          }
        : null,
    scope,
    progress,
    closeout: completion
      ? {
          approved_at: iso(completion.approved_at),
          warranty_ready: truthy(completion.warranty_ready),
        }
      : null,
    warranty: warranty
      ? {
          status: text(warranty.status, 80),
          material_system: text(warranty.material_system, 500),
          terms: text(warranty.warranty_terms, 8_000),
          coverage_start: iso(warranty.coverage_start),
          coverage_years: number(warranty.coverage_years),
          exclusions: text(warranty.exclusions, 8_000),
          issued_at: iso(warranty.issued_at),
        }
      : null,
  };
}

async function customerJobBinding(
  env: AppEnv,
  roofJobId: string,
): Promise<{ roofJobId: string; customerId: string } | null> {
  const rows = await listCustomerPortalFrappeResource(
    env,
    "Roof Job",
    [["Roof Job", "name", "=", roofJobId]],
    1,
  );
  const row = rows[0];
  const name = row ? text(row.name, 140) : null;
  const customer = row ? text(row.customer, 140) : null;
  return name === roofJobId && customer
    ? { roofJobId: name, customerId: customer }
    : null;
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

function customerQuoteStatus(value: string | null): boolean {
  return value === "Approved" || value === "Accepted" || value === "Expired";
}

function customerProposalStatus(value: string | null): boolean {
  return value === "Approved" || value === "Sent" || value === "Signed";
}

function newest(rows: FrappeRow[]): FrappeRow | undefined {
  return [...rows].sort((left, right) =>
    (iso(right.modified) ?? "").localeCompare(iso(left.modified) ?? ""),
  )[0];
}

function latestModified(rows: FrappeRow[]): string | null {
  return rows.reduce<string | null>((latest, row) => {
    const value = iso(row.modified);
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

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function officeRole(auth: AuthContext): boolean {
  return auth.session.role === "owner" || auth.session.role === "ops";
}

function validFrappeName(value: string): boolean {
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
