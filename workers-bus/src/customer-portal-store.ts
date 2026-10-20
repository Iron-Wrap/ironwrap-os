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

/** A live link with the hashes of the device that issued it (0018), for telling staff apart. */
export interface ActiveCustomerPortalLink extends CustomerPortalLinkRecord {
  issued_ip_hash: string;
  issued_user_agent_hash: string;
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
): Promise<ActiveCustomerPortalLink | null> {
  return await env.DB.prepare(
    `SELECT link_id, tenant_id, roof_job_id, customer_id, issued_by_user_id, created_at, expires_at,
            revoked_at, revoked_by_user_id, last_accessed_at, access_count,
            issued_ip_hash, issued_user_agent_hash
     FROM customer_portal_links
     WHERE token_hash = ? AND tenant_id = ? AND revoked_at IS NULL AND expires_at > ?
     LIMIT 1`,
  )
    .bind(tokenHash, tenantId, now)
    .first<ActiveCustomerPortalLink>();
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

/**
 * Keep the first open of one published proposal through one portal link (0163). A later open of
 * the same publication through the same link inserts nothing. D1 refuses a row whose link, job,
 * customer or publication do not match, or whose time is not D1's own.
 */
export async function recordCustomerPortalProposalView(
  env: Env,
  input: {
    viewId: string;
    tenantId: string;
    linkId: string;
    roofJobId: string;
    customerId: string;
    proposalPackId: string;
    proposalRevisionId: string;
    publicationEventId: string;
    viewedAt: string;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO customer_portal_proposal_views
       (view_id, tenant_id, link_id, roof_job_id, customer_id, proposal_pack_id,
        proposal_revision_id, publication_event_id, first_viewed_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
      WHERE NOT EXISTS (
        SELECT 1 FROM customer_portal_proposal_views
         WHERE tenant_id = ?2 AND link_id = ?3 AND publication_event_id = ?8
      )`,
  )
    .bind(
      input.viewId,
      input.tenantId,
      input.linkId,
      input.roofJobId,
      input.customerId,
      input.proposalPackId,
      input.proposalRevisionId,
      input.publicationEventId,
      input.viewedAt,
    )
    .run();
}

/**
 * When someone holding the customer's link first opened this proposal revision (0163), or null.
 * Only the pack's live publication counts: its newest event, which a first-open row can name only
 * while it is `published` for this revision. When the revision has a send attempt (its newest
 * `proposal.publish` effect), only an open at or after that attempt started counts, so an open of
 * an earlier send never answers for a later one.
 */
export async function readProposalFirstViewedAt(
  env: Env,
  input: { tenantId: string; proposalPackId: string; proposalRevisionId: string },
): Promise<string | null> {
  const row = await env.DB.prepare(
    `WITH live AS (
       SELECT publication_event_id
         FROM commercial_proposal_publication_events
        WHERE tenant_id = ?1 AND proposal_pack_id = ?2
        ORDER BY publication_version DESC
        LIMIT 1
     ),
     latest_attempt AS (
       SELECT MIN(attempt.started_at) AS started_at
         FROM external_effect_attempts attempt
        WHERE attempt.effect_id = (
          SELECT effect.effect_id
            FROM external_effects effect
           WHERE effect.tenant_id = ?1 AND effect.action = 'proposal.publish'
             AND effect.aggregate_type = 'proposal_publication'
             AND effect.aggregate_id = ?2 AND effect.intent_id = ?3
           ORDER BY effect.created_at DESC, effect.effect_id DESC
           LIMIT 1
        )
     )
     SELECT MIN(view.first_viewed_at) AS viewed_at
       FROM live
       JOIN customer_portal_proposal_views view
         ON view.tenant_id = ?1 AND view.publication_event_id = live.publication_event_id
      WHERE view.proposal_revision_id = ?3
        AND ((SELECT started_at FROM latest_attempt) IS NULL
             OR julianday(view.first_viewed_at)
                >= julianday((SELECT started_at FROM latest_attempt)))`,
  )
    .bind(input.tenantId, input.proposalPackId, input.proposalRevisionId)
    .first<{ viewed_at: string | null }>();
  return row?.viewed_at ?? null;
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
    // A link that a first-open record names (0163) is kept with that record, which follows the
    // 3-year commercial retention rather than this one-year portal window.
    env.DB.prepare(
      `DELETE FROM customer_portal_links
       WHERE expires_at <= ? AND (revoked_at IS NULL OR revoked_at <= ?)
         AND NOT EXISTS (
           SELECT 1 FROM customer_portal_acceptance_challenges AS challenge
           WHERE challenge.portal_link_id = customer_portal_links.link_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM customer_portal_proposal_views AS view
           WHERE view.tenant_id = customer_portal_links.tenant_id
             AND view.link_id = customer_portal_links.link_id
         )`,
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
