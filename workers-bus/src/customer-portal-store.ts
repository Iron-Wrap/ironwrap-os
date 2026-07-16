import type { AuthRequestContext } from "./app-types.ts";

export interface CustomerPortalLinkRecord {
  link_id: string;
  tenant_id: string;
  roof_job_id: string;
  customer_id: string;
  issued_by_user_id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_by_user_id: string | null;
  last_accessed_at: string | null;
  access_count: number;
}

export interface CreateCustomerPortalLinkInput {
  linkId: string;
  tokenHash: string;
  tenantId: string;
  roofJobId: string;
  customerId: string;
  issuedByUserId: string;
  createdAt: string;
  expiresAt: string;
  request: AuthRequestContext;
}

/**
 * A new link revokes every still-live link for the same tenant/job as one D1 transaction.
 * This prevents two office tabs from leaving multiple customer capabilities active.
 */
export async function replaceCustomerPortalLink(
  env: Env,
  input: CreateCustomerPortalLinkInput,
): Promise<void> {
  const revokeOpen = env.DB.prepare(
    `UPDATE customer_portal_links
     SET revoked_at = ?, revoked_by_user_id = ?
     WHERE tenant_id = ? AND roof_job_id = ? AND revoked_at IS NULL AND expires_at > ?`,
  ).bind(
    input.createdAt,
    input.issuedByUserId,
    input.tenantId,
    input.roofJobId,
    input.createdAt,
  );
  const insert = env.DB.prepare(
    `INSERT INTO customer_portal_links
       (link_id, token_hash, tenant_id, roof_job_id, customer_id, issued_by_user_id,
        created_at, expires_at, revoked_at, revoked_by_user_id, last_accessed_at, access_count,
        issued_ip_hash, issued_user_agent_hash)
     VALUES (?,?,?,?,?,?,?, ?,NULL,NULL,NULL,0,?,?)`,
  ).bind(
    input.linkId,
    input.tokenHash,
    input.tenantId,
    input.roofJobId,
    input.customerId,
    input.issuedByUserId,
    input.createdAt,
    input.expiresAt,
    input.request.ip_hash,
    input.request.user_agent_hash,
  );
  await env.DB.batch([revokeOpen, insert]);
}

export async function findActiveCustomerPortalLink(
  env: Env,
  tokenHash: string,
  tenantId: string,
  now: string,
): Promise<CustomerPortalLinkRecord | null> {
  return await env.DB.prepare(
    `SELECT link_id, tenant_id, roof_job_id, customer_id, issued_by_user_id, created_at, expires_at,
            revoked_at, revoked_by_user_id, last_accessed_at, access_count
     FROM customer_portal_links
     WHERE token_hash = ? AND tenant_id = ? AND revoked_at IS NULL AND expires_at > ?
     LIMIT 1`,
  )
    .bind(tokenHash, tenantId, now)
    .first<CustomerPortalLinkRecord>();
}

export async function listCustomerPortalLinks(
  env: Env,
  tenantId: string,
  roofJobId?: string,
): Promise<CustomerPortalLinkRecord[]> {
  const result = roofJobId
    ? await env.DB.prepare(
        `SELECT link_id, tenant_id, roof_job_id, customer_id, issued_by_user_id, created_at, expires_at,
              revoked_at, revoked_by_user_id, last_accessed_at, access_count
       FROM customer_portal_links
       WHERE tenant_id = ? AND roof_job_id = ?
       ORDER BY created_at DESC LIMIT 100`,
      )
        .bind(tenantId, roofJobId)
        .all<CustomerPortalLinkRecord>()
    : await env.DB.prepare(
        `SELECT link_id, tenant_id, roof_job_id, customer_id, issued_by_user_id, created_at, expires_at,
              revoked_at, revoked_by_user_id, last_accessed_at, access_count
       FROM customer_portal_links
       WHERE tenant_id = ?
       ORDER BY created_at DESC LIMIT 100`,
      )
        .bind(tenantId)
        .all<CustomerPortalLinkRecord>();
  return result.results ?? [];
}

export async function revokeCustomerPortalLink(
  env: Env,
  input: {
    tenantId: string;
    linkId: string;
    revokedByUserId: string;
    now: string;
  },
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE customer_portal_links
     SET revoked_at = ?, revoked_by_user_id = ?
     WHERE tenant_id = ? AND link_id = ? AND revoked_at IS NULL`,
  )
    .bind(input.now, input.revokedByUserId, input.tenantId, input.linkId)
    .run();
  return d1Changes(result) === 1;
}

export async function touchCustomerPortalLink(
  env: Env,
  input: { tenantId: string; linkId: string; now: string },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE customer_portal_links
     SET last_accessed_at = ?, access_count = access_count + 1
     WHERE tenant_id = ? AND link_id = ? AND revoked_at IS NULL AND expires_at > ?`,
  )
    .bind(input.now, input.tenantId, input.linkId, input.now)
    .run();
}

export async function claimCustomerPortalAccessThrottle(
  env: Env,
  input: {
    tenantId: string;
    ipHash: string;
    now: string;
    windowExpiresAt: string;
    limit: number;
  },
): Promise<boolean> {
  const row = await env.DB.prepare(
    `INSERT INTO customer_portal_access_throttles
       (tenant_id, ip_hash, window_started_at, window_expires_at, attempts, updated_at)
     VALUES (?,?,?, ?,1,?)
     ON CONFLICT(tenant_id, ip_hash) DO UPDATE SET
       window_started_at = CASE
         WHEN customer_portal_access_throttles.window_expires_at <= excluded.window_started_at
         THEN excluded.window_started_at ELSE customer_portal_access_throttles.window_started_at END,
       window_expires_at = CASE
         WHEN customer_portal_access_throttles.window_expires_at <= excluded.window_started_at
         THEN excluded.window_expires_at ELSE customer_portal_access_throttles.window_expires_at END,
       attempts = CASE
         WHEN customer_portal_access_throttles.window_expires_at <= excluded.window_started_at
         THEN 1 ELSE customer_portal_access_throttles.attempts + 1 END,
       updated_at = excluded.updated_at
     RETURNING attempts`,
  )
    .bind(
      input.tenantId,
      input.ipHash,
      input.now,
      input.windowExpiresAt,
      input.now,
    )
    .first<{ attempts: number }>();
  return Number(row?.attempts ?? input.limit + 1) <= input.limit;
}

export async function pruneCustomerPortalRecords(
  env: Env,
  now = new Date(),
): Promise<void> {
  const nowValue = now.toISOString();
  const retentionCutoff = new Date(
    now.getTime() - 365 * 24 * 60 * 60_000,
  ).toISOString();
  await Promise.all([
    env.DB.prepare(
      `DELETE FROM customer_portal_links
       WHERE expires_at <= ? AND (revoked_at IS NULL OR revoked_at <= ?)`,
    )
      .bind(retentionCutoff, retentionCutoff)
      .run(),
    env.DB.prepare(
      `DELETE FROM customer_portal_access_throttles WHERE window_expires_at <= ?`,
    )
      .bind(nowValue)
      .run(),
  ]);
}

function d1Changes(result: { meta?: { changes?: number } }): number {
  return Number(result.meta?.changes ?? 0);
}
