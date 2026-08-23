import type {
  AppDeviceRecord,
  AppRole,
  AppSessionRecord,
  AppUserRecord,
  AuthRequestContext,
  ProvisionAppUserInput,
} from "./app-types.ts";

const nowIso = () => new Date().toISOString();

export async function findActiveUser(
  env: Env,
  tenantId: string,
  emailNormalized: string,
): Promise<AppUserRecord | null> {
  return await env.DB.prepare(
    `SELECT user_id, tenant_id, email_normalized, display_name,
            access_role AS role, frappe_user_id,
            active, created_by, created_at, updated_at
     FROM app_users
     WHERE tenant_id = ? AND email_normalized = ? AND active = 1
     LIMIT 1`,
  ).bind(tenantId, emailNormalized).first<AppUserRecord>();
}

export async function findActiveUserById(
  env: Env,
  tenantId: string,
  userId: string,
): Promise<AppUserRecord | null> {
  return await env.DB.prepare(
    `SELECT user_id, tenant_id, email_normalized, display_name,
            access_role AS role, frappe_user_id,
            active, created_by, created_at, updated_at
     FROM app_users
     WHERE tenant_id = ? AND user_id = ? AND active = 1
     LIMIT 1`,
  ).bind(tenantId, userId).first<AppUserRecord>();
}

export async function listActiveFieldUsers(
  env: Env,
  tenantId: string,
): Promise<Array<Pick<AppUserRecord, "user_id" | "display_name" | "email_normalized" | "frappe_user_id">>> {
  const result = await env.DB.prepare(
    `SELECT user_id, display_name, email_normalized, frappe_user_id
     FROM app_users
     WHERE tenant_id = ? AND active = 1 AND access_role = 'field'
     ORDER BY display_name COLLATE NOCASE ASC, user_id ASC
     LIMIT 100`,
  ).bind(tenantId).all<Pick<AppUserRecord, "user_id" | "display_name" | "email_normalized" | "frappe_user_id">>();
  return result.results ?? [];
}

/**
 * Every app user in the tenant, active or not — what the teammates screen lists. Deactivated rows
 * stay visible because "who used to have access" is the question an owner asks when re-hiring, and
 * the provisioning route is an upsert on (tenant, email): hiding them would make re-activating look
 * like creating a duplicate.
 */
export async function listAppUsers(
  env: Env,
  tenantId: string,
): Promise<AppUserRecord[]> {
  const result = await env.DB.prepare(
    `SELECT user_id, tenant_id, email_normalized, display_name,
            access_role AS role, frappe_user_id,
            active, created_by, created_at, updated_at
     FROM app_users
     WHERE tenant_id = ?
     ORDER BY active DESC, display_name COLLATE NOCASE ASC, user_id ASC
     LIMIT 500`,
  ).bind(tenantId).all<AppUserRecord>();
  return result.results ?? [];
}

export async function upsertAppUser(env: Env, input: ProvisionAppUserInput): Promise<AppUserRecord> {
  const now = nowIso();
  const candidateId = `appu_${crypto.randomUUID()}`;
  const storageRole = input.role === "owner" ? "owner" : "ops";
  await env.DB.prepare(
    `INSERT INTO app_users
       (user_id, tenant_id, email_normalized, display_name, role, access_role, frappe_user_id, active,
        created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(tenant_id, email_normalized) DO UPDATE SET
       display_name = excluded.display_name,
       role = excluded.role,
       access_role = excluded.access_role,
       frappe_user_id = excluded.frappe_user_id,
       active = excluded.active,
       updated_at = excluded.updated_at`,
  ).bind(
    candidateId,
    input.tenant_id,
    input.email_normalized,
    input.display_name,
    storageRole,
    input.role,
    input.frappe_user_id,
    input.active ? 1 : 0,
    input.provisioned_by,
    now,
    now,
  ).run();

  const row = await env.DB.prepare(
    `SELECT user_id, tenant_id, email_normalized, display_name,
            access_role AS role, frappe_user_id,
            active, created_by, created_at, updated_at
     FROM app_users WHERE tenant_id = ? AND email_normalized = ? LIMIT 1`,
  ).bind(input.tenant_id, input.email_normalized).first<AppUserRecord>();
  if (!row) throw new Error("app_user_upsert_missing");

  if (!input.active) {
    await Promise.all([
      revokeAllUserSessions(env, row.user_id, now),
      consumeOpenMagicLinks(env, row.user_id, now),
      revokeAllUserDevices(env, row.user_id, now),
    ]);
  }
  return row;
}

export async function bootstrapFirstOwnerAppUser(
  env: Env,
  input: {
    tenant_id: string;
    email_normalized: string;
    display_name: string;
    provisioned_by: string;
  },
): Promise<AppUserRecord | null> {
  const now = nowIso();
  const candidateId = `appu_${crypto.randomUUID()}`;
  const result = await env.DB.prepare(
    `INSERT INTO app_users
       (user_id, tenant_id, email_normalized, display_name, role, access_role, frappe_user_id, active,
        created_by, created_at, updated_at)
     SELECT ?,?,?,?,?,?,?,?,?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM app_users WHERE tenant_id = ? LIMIT 1
     )`,
  ).bind(
    candidateId,
    input.tenant_id,
    input.email_normalized,
    input.display_name,
    "owner",
    "owner",
    null,
    1,
    input.provisioned_by,
    now,
    now,
    input.tenant_id,
  ).run();
  if (d1Changes(result) !== 1) return null;
  return await env.DB.prepare(
    `SELECT user_id, tenant_id, email_normalized, display_name,
            access_role AS role, frappe_user_id,
            active, created_by, created_at, updated_at
     FROM app_users WHERE tenant_id = ? AND email_normalized = ? LIMIT 1`,
  ).bind(input.tenant_id, input.email_normalized).first<AppUserRecord>();
}

export async function replaceMagicLink(
  env: Env,
  input: {
    tokenHash: string;
    user: AppUserRecord;
    createdAt: string;
    expiresAt: string;
    request: AuthRequestContext;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO app_magic_links
       (token_hash, user_id, tenant_id, created_at, expires_at, consumed_at,
        request_ip_hash, request_user_agent_hash)
     VALUES (?,?,?,?,?,NULL,?,?)
     ON CONFLICT(user_id) DO UPDATE SET
       token_hash = excluded.token_hash,
       tenant_id = excluded.tenant_id,
       created_at = excluded.created_at,
       expires_at = excluded.expires_at,
       consumed_at = NULL,
       request_ip_hash = excluded.request_ip_hash,
       request_user_agent_hash = excluded.request_user_agent_hash`,
  ).bind(
    input.tokenHash,
    input.user.user_id,
    input.user.tenant_id,
    input.createdAt,
    input.expiresAt,
    input.request.ip_hash,
    input.request.user_agent_hash,
  ).run();
}

export async function consumeMagicLink(
  env: Env,
  tokenHash: string,
  now: string,
): Promise<AppUserRecord | null> {
  const candidate = await env.DB.prepare(
    `SELECT u.user_id, u.tenant_id, u.email_normalized, u.display_name,
            u.access_role AS role,
            u.frappe_user_id, u.active, u.created_by, u.created_at, u.updated_at
     FROM app_magic_links ml
     INNER JOIN app_users u ON u.user_id = ml.user_id AND u.tenant_id = ml.tenant_id
     WHERE ml.token_hash = ? AND ml.consumed_at IS NULL AND ml.expires_at > ?
       AND u.active = 1
     LIMIT 1`,
  ).bind(tokenHash, now).first<AppUserRecord>();
  if (!candidate) return null;

  const result = await env.DB.prepare(
    `UPDATE app_magic_links SET consumed_at = ?
     WHERE token_hash = ? AND user_id = ? AND consumed_at IS NULL AND expires_at > ?`,
  ).bind(now, tokenHash, candidate.user_id, now).run();
  return d1Changes(result) === 1 ? candidate : null;
}

export async function replaceDevicePairing(
  env: Env,
  input: {
    tokenHash: string;
    user: AppUserRecord;
    issuedByUserId: string;
    createdAt: string;
    expiresAt: string;
    request: AuthRequestContext;
  },
): Promise<void> {
  // D1 batches are transactional and execute the statements sequentially. This means two
  // office tabs cannot interleave a revoke/insert pair and leave two live QR secrets for the
  // same crew user: the later completed issuance revokes the earlier one as one mutation.
  const revokeOpen = env.DB.prepare(
    `UPDATE app_device_pairings
     SET revoked_at = ?
     WHERE tenant_id = ? AND user_id = ? AND consumed_at IS NULL AND revoked_at IS NULL`,
  ).bind(input.createdAt, input.user.tenant_id, input.user.user_id);
  const insertPairing = env.DB.prepare(
    `INSERT INTO app_device_pairings
       (token_hash, tenant_id, user_id, issued_by_user_id, created_at, expires_at,
        consumed_at, revoked_at, issued_ip_hash, issued_user_agent_hash)
     VALUES (?,?,?,?,?,?,NULL,NULL,?,?)`,
  ).bind(
    input.tokenHash,
    input.user.tenant_id,
    input.user.user_id,
    input.issuedByUserId,
    input.createdAt,
    input.expiresAt,
    input.request.ip_hash,
    input.request.user_agent_hash,
  );
  await env.DB.batch([revokeOpen, insertPairing]);
}

export async function consumeDevicePairing(
  env: Env,
  input: {
    tokenHash: string;
    deviceId: string;
    deviceProofHash: string;
    sessionHash: string;
    createdAt: string;
    expiresAt: string;
    request: AuthRequestContext;
  },
): Promise<{ user: AppUserRecord; deviceId: string } | null> {
  const candidate = await env.DB.prepare(
    `SELECT u.user_id, u.tenant_id, u.email_normalized, u.display_name,
            u.access_role AS role,
            u.frappe_user_id, u.active, u.created_by, u.created_at, u.updated_at
     FROM app_device_pairings p
     INNER JOIN app_users u ON u.user_id = p.user_id AND u.tenant_id = p.tenant_id
     WHERE p.token_hash = ? AND p.consumed_at IS NULL AND p.revoked_at IS NULL
       AND p.expires_at > ? AND u.active = 1
       AND u.access_role = 'field'
     LIMIT 1`,
  ).bind(input.tokenHash, input.createdAt).first<AppUserRecord>();
  if (!candidate) return null;

  // Claim before creating a session. The compare-and-set makes the opaque QR secret
  // single-use even when two scanners submit at the same instant. A later storage
  // failure is fail-closed: the office issues a fresh QR instead of restoring a claim.
  const claim = await env.DB.prepare(
    `UPDATE app_device_pairings SET consumed_at = ?
     WHERE token_hash = ? AND user_id = ? AND consumed_at IS NULL AND revoked_at IS NULL
       AND expires_at > ?`,
  ).bind(input.createdAt, input.tokenHash, candidate.user_id, input.createdAt).run();
  if (d1Changes(claim) !== 1) return null;

  try {
    await env.DB.prepare(
      `INSERT INTO app_devices
         (device_id, tenant_id, user_id, device_proof_hash, paired_at, last_seen_at,
          revoked_at, revoked_by_user_id, created_ip_hash, created_user_agent_hash)
       VALUES (?,?,?,?,?,?,NULL,NULL,?,?)`,
    ).bind(
      input.deviceId,
      candidate.tenant_id,
      candidate.user_id,
      input.deviceProofHash,
      input.createdAt,
      input.createdAt,
      input.request.ip_hash,
      input.request.user_agent_hash,
    ).run();
    await insertSession(env, {
      sessionHash: input.sessionHash,
      user: candidate,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      request: input.request,
      deviceId: input.deviceId,
    });
  } catch (error) {
    await env.DB.prepare(`DELETE FROM app_devices WHERE device_id = ?`).bind(input.deviceId).run().catch(() => {});
    throw error;
  }
  return { user: candidate, deviceId: input.deviceId };
}

export async function listDeviceBindings(env: Env, tenantId: string): Promise<AppDeviceRecord[]> {
  const result = await env.DB.prepare(
    `SELECT d.device_id, d.tenant_id, d.user_id, u.display_name AS field_user_name,
            d.paired_at, COALESCE(MAX(s.last_seen_at), d.last_seen_at) AS last_seen_at,
            d.revoked_at, d.revoked_by_user_id
     FROM app_devices d
     INNER JOIN app_users u ON u.user_id = d.user_id AND u.tenant_id = d.tenant_id
     LEFT JOIN app_sessions s ON s.device_id = d.device_id AND s.tenant_id = d.tenant_id
     WHERE d.tenant_id = ?
     GROUP BY d.device_id
     ORDER BY d.revoked_at IS NULL DESC, d.paired_at DESC
     LIMIT 100`,
  ).bind(tenantId).all<AppDeviceRecord>();
  return result.results ?? [];
}

export async function revokeDeviceBinding(
  env: Env,
  input: { tenantId: string; deviceId: string; revokedByUserId: string; now: string },
): Promise<boolean> {
  const revoked = await env.DB.prepare(
    `UPDATE app_devices SET revoked_at = ?, revoked_by_user_id = ?
     WHERE tenant_id = ? AND device_id = ? AND revoked_at IS NULL`,
  ).bind(input.now, input.revokedByUserId, input.tenantId, input.deviceId).run();
  if (d1Changes(revoked) !== 1) return false;
  await env.DB.prepare(
    `UPDATE app_sessions SET revoked_at = ?
     WHERE tenant_id = ? AND device_id = ? AND revoked_at IS NULL`,
  ).bind(input.now, input.tenantId, input.deviceId).run();
  return true;
}

export async function insertSession(
  env: Env,
  input: {
    sessionHash: string;
    user: AppUserRecord;
    createdAt: string;
    expiresAt: string;
    request: AuthRequestContext;
    deviceId?: string;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO app_sessions
       (session_hash, user_id, tenant_id, created_at, expires_at, revoked_at, last_seen_at,
        created_ip_hash, created_user_agent_hash, device_id)
     VALUES (?,?,?,?,?,NULL,?,?,?,?)`,
  ).bind(
    input.sessionHash,
    input.user.user_id,
    input.user.tenant_id,
    input.createdAt,
    input.expiresAt,
    input.createdAt,
    input.request.ip_hash,
    input.request.user_agent_hash,
    input.deviceId ?? null,
  ).run();
}

export async function findActiveSession(
  env: Env,
  sessionHash: string,
  configuredTenantId: string,
  now: string,
): Promise<AppSessionRecord | null> {
  return await env.DB.prepare(
    `SELECT s.session_hash, s.created_at AS session_created_at,
            s.expires_at AS session_expires_at, s.revoked_at, s.device_id,
            d.device_proof_hash,
            u.user_id, u.tenant_id, u.email_normalized, u.display_name,
            u.access_role AS role,
            u.frappe_user_id, u.active, u.created_by, u.created_at, u.updated_at
     FROM app_sessions s
     INNER JOIN app_users u ON u.user_id = s.user_id AND u.tenant_id = s.tenant_id
     LEFT JOIN app_devices d ON d.device_id = s.device_id AND d.tenant_id = s.tenant_id
     WHERE s.session_hash = ? AND s.tenant_id = ? AND s.revoked_at IS NULL
       AND s.expires_at > ? AND u.active = 1 AND u.tenant_id = ?
       AND (u.access_role != 'field'
         OR (s.device_id IS NOT NULL AND d.device_id IS NOT NULL AND d.revoked_at IS NULL))
     LIMIT 1`,
  ).bind(sessionHash, configuredTenantId, now, configuredTenantId).first<AppSessionRecord>();
}

export async function touchSession(env: Env, sessionHash: string, now: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE app_sessions SET last_seen_at = ?
     WHERE session_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
  ).bind(now, sessionHash, now).run();
}

export async function revokeSession(env: Env, sessionHash: string, now: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE app_sessions SET revoked_at = ?
     WHERE session_hash = ? AND revoked_at IS NULL`,
  ).bind(now, sessionHash).run();
}

export async function claimThrottle(
  env: Env,
  input: {
    keyHash: string;
    scope: "request_email" | "request_ip" | "consume_ip";
    now: string;
    windowExpiresAt: string;
    limit: number;
  },
): Promise<boolean> {
  const row = await env.DB.prepare(
    `INSERT INTO app_auth_throttles
       (key_hash, scope, window_started_at, window_expires_at, attempts, updated_at)
     VALUES (?,?,?,?,1,?)
     ON CONFLICT(key_hash) DO UPDATE SET
       scope = excluded.scope,
       window_started_at = CASE
         WHEN app_auth_throttles.window_expires_at <= excluded.window_started_at
         THEN excluded.window_started_at ELSE app_auth_throttles.window_started_at END,
       window_expires_at = CASE
         WHEN app_auth_throttles.window_expires_at <= excluded.window_started_at
         THEN excluded.window_expires_at ELSE app_auth_throttles.window_expires_at END,
       attempts = CASE
         WHEN app_auth_throttles.window_expires_at <= excluded.window_started_at
         THEN 1 ELSE app_auth_throttles.attempts + 1 END,
       updated_at = excluded.updated_at
     RETURNING attempts`,
  ).bind(
    input.keyHash,
    input.scope,
    input.now,
    input.windowExpiresAt,
    input.now,
  ).first<{ attempts: number }>();
  return Number(row?.attempts ?? input.limit + 1) <= input.limit;
}

export async function recordAuthAudit(
  env: Env,
  entry: {
    tenantId: string | null;
    userId: string | null;
    event: string;
    outcome: string;
    request: AuthRequestContext;
    detailCode?: string | null;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO app_auth_audit
       (created_at, tenant_id, user_id, event, outcome, ip_hash, user_agent_hash, detail_code)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).bind(
    nowIso(),
    entry.tenantId,
    entry.userId,
    entry.event.slice(0, 64),
    entry.outcome.slice(0, 64),
    entry.request.ip_hash,
    entry.request.user_agent_hash,
    entry.detailCode?.slice(0, 120) ?? null,
  ).run();
}

export async function pruneAuthRecords(env: Env, now = new Date()): Promise<void> {
  const nowValue = now.toISOString();
  const consumedCutoff = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
  const auditCutoff = new Date(now.getTime() - 365 * 24 * 60 * 60_000).toISOString();
  await Promise.all([
    env.DB.prepare(
      `DELETE FROM app_magic_links
       WHERE expires_at <= ? OR (consumed_at IS NOT NULL AND consumed_at <= ?)`,
    ).bind(nowValue, consumedCutoff).run(),
    env.DB.prepare(`DELETE FROM app_sessions WHERE expires_at <= ?`).bind(nowValue).run(),
    env.DB.prepare(
      `DELETE FROM app_device_pairings
       WHERE expires_at <= ? OR (consumed_at IS NOT NULL AND consumed_at <= ?) OR (revoked_at IS NOT NULL AND revoked_at <= ?)`,
    ).bind(nowValue, consumedCutoff, consumedCutoff).run(),
    env.DB.prepare(`DELETE FROM app_auth_throttles WHERE window_expires_at <= ?`).bind(nowValue).run(),
    env.DB.prepare(`DELETE FROM app_action_throttles WHERE window_expires_at <= ?`).bind(nowValue).run(),
    env.DB.prepare(`DELETE FROM app_auth_audit WHERE created_at <= ?`).bind(auditCutoff).run(),
  ]);
}

async function revokeAllUserSessions(env: Env, userId: string, now: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE app_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`,
  ).bind(now, userId).run();
}

async function consumeOpenMagicLinks(env: Env, userId: string, now: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE app_magic_links SET consumed_at = ?
     WHERE user_id = ? AND consumed_at IS NULL`,
  ).bind(now, userId).run();
}

async function revokeAllUserDevices(env: Env, userId: string, now: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE app_devices SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`,
  ).bind(now, userId).run();
}

function d1Changes(result: unknown): number {
  return Number((result as { meta?: { changes?: number } }).meta?.changes ?? 0);
}

export function isAppRole(value: unknown): value is AppRole {
  return value === "owner" || value === "ops" || value === "sales" ||
    value === "production" || value === "accounting" || value === "field";
}
