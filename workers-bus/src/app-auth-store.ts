import type {
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
    `SELECT user_id, tenant_id, email_normalized, display_name, role, frappe_user_id,
            active, created_by, created_at, updated_at
     FROM app_users
     WHERE tenant_id = ? AND email_normalized = ? AND active = 1
     LIMIT 1`,
  ).bind(tenantId, emailNormalized).first<AppUserRecord>();
}

export async function upsertAppUser(env: Env, input: ProvisionAppUserInput): Promise<AppUserRecord> {
  const now = nowIso();
  const candidateId = `appu_${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO app_users
       (user_id, tenant_id, email_normalized, display_name, role, frappe_user_id, active,
        created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(tenant_id, email_normalized) DO UPDATE SET
       display_name = excluded.display_name,
       role = excluded.role,
       frappe_user_id = excluded.frappe_user_id,
       active = excluded.active,
       updated_at = excluded.updated_at`,
  ).bind(
    candidateId,
    input.tenant_id,
    input.email_normalized,
    input.display_name,
    input.role,
    input.frappe_user_id,
    input.active ? 1 : 0,
    input.provisioned_by,
    now,
    now,
  ).run();

  const row = await env.DB.prepare(
    `SELECT user_id, tenant_id, email_normalized, display_name, role, frappe_user_id,
            active, created_by, created_at, updated_at
     FROM app_users WHERE tenant_id = ? AND email_normalized = ? LIMIT 1`,
  ).bind(input.tenant_id, input.email_normalized).first<AppUserRecord>();
  if (!row) throw new Error("app_user_upsert_missing");

  if (!input.active) {
    await Promise.all([
      revokeAllUserSessions(env, row.user_id, now),
      consumeOpenMagicLinks(env, row.user_id, now),
    ]);
  }
  return row;
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
    `SELECT u.user_id, u.tenant_id, u.email_normalized, u.display_name, u.role,
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

export async function insertSession(
  env: Env,
  input: {
    sessionHash: string;
    user: AppUserRecord;
    createdAt: string;
    expiresAt: string;
    request: AuthRequestContext;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO app_sessions
       (session_hash, user_id, tenant_id, created_at, expires_at, revoked_at, last_seen_at,
        created_ip_hash, created_user_agent_hash)
     VALUES (?,?,?,?,?,NULL,?,?,?)`,
  ).bind(
    input.sessionHash,
    input.user.user_id,
    input.user.tenant_id,
    input.createdAt,
    input.expiresAt,
    input.createdAt,
    input.request.ip_hash,
    input.request.user_agent_hash,
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
            s.expires_at AS session_expires_at, s.revoked_at,
            u.user_id, u.tenant_id, u.email_normalized, u.display_name, u.role,
            u.frappe_user_id, u.active, u.created_by, u.created_at, u.updated_at
     FROM app_sessions s
     INNER JOIN app_users u ON u.user_id = s.user_id AND u.tenant_id = s.tenant_id
     WHERE s.session_hash = ? AND s.tenant_id = ? AND s.revoked_at IS NULL
       AND s.expires_at > ? AND u.active = 1 AND u.tenant_id = ?
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

function d1Changes(result: unknown): number {
  return Number((result as { meta?: { changes?: number } }).meta?.changes ?? 0);
}

export function isAppRole(value: unknown): value is AppRole {
  return value === "owner" || value === "ops" || value === "field";
}
