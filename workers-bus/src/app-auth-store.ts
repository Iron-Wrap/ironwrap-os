import type {
  AppDeviceRecord,
  AppRole,
  AppSessionRecord,
  AppUserRecord,
  AuthRequestContext,
  ProvisionAppUserInput,
} from "./app-types.ts";

const nowIso = () => new Date().toISOString();

/**
 * The exact actor and target state an authenticated route authorized. Mutation statements prove
 * this snapshot still holds at write time, closing the read/check/write race without duplicating
 * the route's owner/self policy in SQL.
 */
export interface AppUserMutationAuthority {
  actorUserId: string;
  actorRole: AppRole;
  expectedTarget: AppUserRecord | null;
  /** The audit row for this change, committed in the change's own batch (0157). */
  audit?: AccessChangeAudit;
}

export interface AccessChangeAudit {
  event: string;
  outcome: string;
  request: AuthRequestContext;
  /** The row's short text, as each route has always written it. */
  detailCode: string;
}

/** A person's access at one version: their role and whether they can sign in. */
export interface AccessState {
  role: AppRole;
  active: boolean;
}

/**
 * One role or access change as its audit row records it in `access_change` (0157): the access
 * version the change produced, the access before it (none for a new person) and after it, and who
 * decided it.
 */
export interface AccessChange {
  version: number;
  before: AccessState | null;
  after: AccessState;
  actorUserId: string;
}

export function accessStateOf(user: AppUserRecord): AccessState {
  return { role: user.role, active: user.active === 1 };
}

/**
 * The audit row of a role or access change. It sits directly after the change in one batch and is
 * written only when that change itself wrote a row (`changes() = 1`), so a lost race leaves neither
 * the change nor an audit claiming it. `access_change` is JSON the column's json_valid CHECK
 * accepts or the whole batch fails: a change never lands without its record.
 */
export function accessChangeAuditStatement(
  env: Env,
  tenantId: string,
  userId: string,
  audit: AccessChangeAudit,
  change: AccessChange,
) {
  return env.DB.prepare(
    `INSERT INTO app_auth_audit
       (created_at, tenant_id, user_id, event, outcome, ip_hash, user_agent_hash, detail_code,
        access_change)
     SELECT ?,?,?,?,?,?,?,?,?
      WHERE changes() = 1`,
  ).bind(
    nowIso(),
    tenantId,
    userId,
    audit.event.slice(0, 64),
    audit.outcome.slice(0, 64),
    audit.request.ip_hash,
    audit.request.user_agent_hash,
    audit.detailCode.slice(0, 120),
    JSON.stringify({
      v: change.version,
      before: change.before,
      after: change.after,
      actor: change.actorUserId,
    }),
  );
}

/**
 * The role and access changes in one person's audit above `afterVersion` and through the returned
 * person's `throughVersion`, newest first. A concurrent later change must not supply the actor or
 * timestamp for that older snapshot. More than `limit` changes are described from the newest only.
 */
export async function listAccessChangesSince(
  env: Env,
  tenantId: string,
  userId: string,
  afterVersion: number,
  throughVersion: number,
  limit = 50,
): Promise<Array<AccessChange & { recordedAt: string }>> {
  const result = await env.DB.prepare(
    `SELECT created_at,
            json_extract(access_change, '$.v') AS version,
            json_extract(access_change, '$.before.role') AS before_role,
            json_extract(access_change, '$.before.active') AS before_active,
            json_extract(access_change, '$.after.role') AS after_role,
            json_extract(access_change, '$.after.active') AS after_active,
            json_extract(access_change, '$.actor') AS actor
       FROM app_auth_audit
      WHERE tenant_id = ? AND user_id = ? AND access_change IS NOT NULL
        AND json_extract(access_change, '$.v') > ?
        AND json_extract(access_change, '$.v') <= ?
      ORDER BY json_extract(access_change, '$.v') DESC, id DESC
      LIMIT ?`,
  ).bind(tenantId, userId, afterVersion, throughVersion, limit).all<{
    created_at: string;
    version: number;
    before_role: string | null;
    before_active: number | null;
    after_role: string;
    after_active: number;
    actor: string;
  }>();
  return (result.results ?? []).flatMap((row) =>
    isAppRole(row.after_role) && (row.before_role === null || isAppRole(row.before_role))
      ? [{
        version: Number(row.version),
        before: row.before_role === null
          ? null
          : { role: row.before_role, active: row.before_active === 1 },
        after: { role: row.after_role, active: row.after_active === 1 },
        actorUserId: row.actor,
        recordedAt: row.created_at,
      }]
      : []
  );
}

/**
 * The newest change in one person's audit that set their role to `role` from another role, by
 * `actorUserId` when one is named: the access version it produced and who decided it. A new
 * person, a removal and a give-back set no role, so none of them is it.
 */
export async function findNewestRoleSet(
  env: Env,
  tenantId: string,
  userId: string,
  role: AppRole,
  actorUserId: string | null,
): Promise<{ version: number; actorUserId: string } | null> {
  const row = await env.DB.prepare(
    `SELECT json_extract(access_change, '$.v') AS version,
            json_extract(access_change, '$.actor') AS actor
       FROM app_auth_audit
      WHERE tenant_id = ? AND user_id = ? AND access_change IS NOT NULL
        AND json_extract(access_change, '$.after.role') = ?
        AND json_extract(access_change, '$.before.role') <> ?
        AND (? IS NULL OR json_extract(access_change, '$.actor') = ?)
      ORDER BY json_extract(access_change, '$.v') DESC, id DESC
      LIMIT 1`,
  ).bind(tenantId, userId, role, role, actorUserId, actorUserId).first<{
    version: number;
    actor: string;
  }>();
  return row ? { version: Number(row.version), actorUserId: row.actor } : null;
}

/** The access version the route authorized against; the column is NOT NULL DEFAULT 1 (0157). */
function expectedAccessVersion(expected: AppUserRecord): number | null {
  const version = Number(expected.access_version ?? 1);
  return Number.isInteger(version) && version >= 1 ? version : null;
}

export async function findActiveUser(
  env: Env,
  tenantId: string,
  emailNormalized: string,
): Promise<AppUserRecord | null> {
  return await env.DB.prepare(
    `SELECT user_id, tenant_id, email_normalized, display_name,
            access_role AS role, access_version, frappe_user_id,
            active, created_by, created_at, updated_at
     FROM app_users
     WHERE tenant_id = ? AND email_normalized = ? AND active = 1
     LIMIT 1`,
  ).bind(tenantId, emailNormalized).first<AppUserRecord>();
}

export async function findAppUserByEmail(
  env: Env,
  tenantId: string,
  emailNormalized: string,
): Promise<AppUserRecord | null> {
  return await env.DB.prepare(
    `SELECT user_id, tenant_id, email_normalized, display_name,
            access_role AS role, access_version, frappe_user_id,
            active, created_by, created_at, updated_at
     FROM app_users
     WHERE tenant_id = ? AND email_normalized = ?
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
            access_role AS role, access_version, frappe_user_id,
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
 * Every app user in the tenant, active or not — what the people screen lists. Deactivated rows
 * stay visible because "who used to have access" is the question an owner asks when re-hiring,
 * and the grant is keyed on (tenant, email): hiding them would make restoring access look like
 * creating a duplicate.
 */
export async function listAppUsers(
  env: Env,
  tenantId: string,
): Promise<AppUserRecord[]> {
  const result = await env.DB.prepare(
    `SELECT user_id, tenant_id, email_normalized, display_name,
            access_role AS role, access_version, frappe_user_id,
            active, created_by, created_at, updated_at
     FROM app_users
     WHERE tenant_id = ?
     ORDER BY active DESC, display_name COLLATE NOCASE ASC, user_id ASC
     LIMIT 500`,
  ).bind(tenantId).all<AppUserRecord>();
  return result.results ?? [];
}

/**
 * The people whose crew phone a removal of their access unpaired and who have not paired one
 * since, so giving access back needs a phone paired again. Computed, never stored: a device a
 * removal revoked (an office unpair names who revoked it, a removal does not) with no active
 * device paired after that revocation. Only the fact leaves this store, never a device id.
 */
export async function usersWithCrewPhoneUnpairedByRemoval(
  env: Env,
  tenantId: string,
  userId?: string,
): Promise<Set<string>> {
  const result = await env.DB.prepare(
    `SELECT DISTINCT removed.user_id FROM app_devices AS removed
      WHERE removed.tenant_id = ? AND (? IS NULL OR removed.user_id = ?)
        AND removed.revoked_at IS NOT NULL AND removed.revoked_by_user_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM app_devices AS paired
           WHERE paired.tenant_id = removed.tenant_id AND paired.user_id = removed.user_id
             AND paired.revoked_at IS NULL AND paired.paired_at > removed.revoked_at
        )`,
  ).bind(tenantId, userId ?? null, userId ?? null).all<{ user_id: string }>();
  return new Set((result.results ?? []).map((row) => row.user_id));
}

/**
 * One app user by id in whatever access state it is in. `findActiveUserById` deliberately hides
 * deactivated rows because it answers "may this person act"; managing people needs the opposite
 * question, so restoring access can address the row that already exists.
 */
export async function findAppUserById(
  env: Env,
  tenantId: string,
  userId: string,
): Promise<AppUserRecord | null> {
  return await env.DB.prepare(
    `SELECT user_id, tenant_id, email_normalized, display_name,
            access_role AS role, access_version, frappe_user_id,
            active, created_by, created_at, updated_at
     FROM app_users
     WHERE tenant_id = ? AND user_id = ?
     LIMIT 1`,
  ).bind(tenantId, userId).first<AppUserRecord>();
}

/**
 * Change one person's effective role. `access_role` is the sole effective role (migration 0038);
 * the legacy `role` column is a deployed authentication-class constraint that only distinguishes
 * owner from everything else, and it is kept consistent here for the same reason
 * `upsertAppUserWithAuthority` keeps it consistent.
 *
 * A live session picks this up on its next request: `findActiveSession` reads `access_role` from
 * `app_users` every time and permissions are derived per request, so a demotion takes effect
 * without waiting for the session to expire.
 */
export async function setAppUserAccessRole(
  env: Env,
  input: {
    tenantId: string;
    userId: string;
    role: AppRole;
    now: string;
    authority: AppUserMutationAuthority;
  },
): Promise<AppUserRecord | null> {
  const expected = input.authority.expectedTarget;
  if (
    !expected || expected.tenant_id !== input.tenantId || expected.user_id !== input.userId
  ) return null;
  const version = expectedAccessVersion(expected);
  if (version === null) return null;
  const mutation = env.DB.prepare(
    `UPDATE app_users
        SET access_role = ?, role = ?, updated_at = ?, access_version = access_version + 1
      WHERE tenant_id = ? AND user_id = ?
        AND access_role = ? AND active = ? AND updated_at = ? AND access_version = ?
        AND EXISTS (
          SELECT 1 FROM app_users AS actor
           WHERE actor.tenant_id = ? AND actor.user_id = ?
             AND actor.active = 1 AND actor.access_role = ?
        )`,
  ).bind(
    input.role,
    input.role === "owner" ? "owner" : "ops",
    input.now,
    input.tenantId,
    input.userId,
    expected.role,
    expected.active,
    expected.updated_at,
    version,
    input.tenantId,
    input.authority.actorUserId,
    input.authority.actorRole,
  );
  const audit = input.authority.audit;
  const result = audit
    ? (await env.DB.batch([
      mutation,
      accessChangeAuditStatement(env, input.tenantId, input.userId, audit, {
        version: version + 1,
        before: accessStateOf(expected),
        after: { role: input.role, active: expected.active === 1 },
        actorUserId: input.authority.actorUserId,
      }),
    ]))[0]
    : await mutation.run();
  if (d1Changes(result) !== 1) return null;
  return await findAppUserById(env, input.tenantId, input.userId);
}

/**
 * Grant or withdraw the ability to sign in. Withdrawing atomically closes every open invitation,
 * live session, open magic link, and paired device, so "no access" means it now rather than at the
 * next expiry — the same closure the authenticated legacy upsert performs.
 */
export async function setAppUserActive(
  env: Env,
  input: {
    tenantId: string;
    userId: string;
    active: boolean;
    now: string;
    authority: AppUserMutationAuthority;
  },
): Promise<AppUserRecord | null> {
  const expected = input.authority.expectedTarget;
  if (
    !expected || expected.tenant_id !== input.tenantId || expected.user_id !== input.userId
  ) return null;
  const version = expectedAccessVersion(expected);
  if (version === null) return null;
  const mutationUpdatedAt = authorityMutationTimestamp(input.now);
  const mutation = env.DB.prepare(
    `UPDATE app_users SET active = ?, updated_at = ?, access_version = access_version + 1
      WHERE tenant_id = ? AND user_id = ?
        AND access_role = ? AND active = ? AND updated_at = ? AND access_version = ?
        AND EXISTS (
          SELECT 1 FROM app_users AS actor
           WHERE actor.tenant_id = ? AND actor.user_id = ?
             AND actor.active = 1 AND actor.access_role = ?
        )`,
  ).bind(
    input.active ? 1 : 0,
    mutationUpdatedAt,
    input.tenantId,
    input.userId,
    expected.role,
    expected.active,
    expected.updated_at,
    version,
    input.tenantId,
    input.authority.actorUserId,
    input.authority.actorRole,
  );
  const audit = input.authority.audit
    ? [accessChangeAuditStatement(env, input.tenantId, input.userId, input.authority.audit, {
      version: version + 1,
      before: accessStateOf(expected),
      after: { role: expected.role, active: input.active },
      actorUserId: input.authority.actorUserId,
    })]
    : [];
  const result = input.active && audit.length === 0
    ? await mutation.run()
    : (await env.DB.batch([
      mutation,
      ...audit,
      ...(input.active ? [] : deactivationCleanupStatements(env, {
        tenantId: input.tenantId,
        userId: input.userId,
        emailNormalized: expected.email_normalized,
        role: expected.role,
        mutationUpdatedAt,
        revokedAt: input.now,
        revokedByUserId: input.authority.actorUserId,
      })),
    ]))[0];
  if (d1Changes(result) !== 1) return null;
  return await findAppUserById(env, input.tenantId, input.userId);
}

/**
 * The authenticated legacy email-keyed upsert with the same authority CAS as id-addressed
 * mutations. Existing rows must still equal the snapshot the route authorized; new rows require
 * the actor to retain the role carried by the authenticated session and never overwrite a row
 * that appeared after the pre-read. An inactive result and all credential cleanup commit in one
 * D1 batch, exactly as on the id-addressed access route.
 */
export async function upsertAppUserWithAuthority(
  env: Env,
  input: ProvisionAppUserInput,
  authority: AppUserMutationAuthority,
): Promise<AppUserRecord | null> {
  const now = nowIso();
  const mutationUpdatedAt = authorityMutationTimestamp(now);
  const candidateId = `appu_${crypto.randomUUID()}`;
  const storageRole = input.role === "owner" ? "owner" : "ops";
  const expected = authority.expectedTarget;
  let changed = 0;

  if (expected) {
    if (
      expected.tenant_id !== input.tenant_id ||
      expected.email_normalized !== input.email_normalized
    ) return null;
    const version = expectedAccessVersion(expected);
    if (version === null) return null;
    const mutation = env.DB.prepare(
      `UPDATE app_users
          SET display_name = ?, role = ?, access_role = ?, frappe_user_id = ?,
              active = ?, updated_at = ?, access_version = access_version + 1
        WHERE tenant_id = ? AND email_normalized = ? AND user_id = ?
          AND access_role = ? AND active = ? AND updated_at = ? AND access_version = ?
          AND EXISTS (
            SELECT 1 FROM app_users AS actor
             WHERE actor.tenant_id = ? AND actor.user_id = ?
               AND actor.active = 1 AND actor.access_role = ?
          )`,
    ).bind(
      input.display_name,
      storageRole,
      input.role,
      input.frappe_user_id,
      input.active ? 1 : 0,
      mutationUpdatedAt,
      input.tenant_id,
      input.email_normalized,
      expected.user_id,
      expected.role,
      expected.active,
      expected.updated_at,
      version,
      input.tenant_id,
      authority.actorUserId,
      authority.actorRole,
    );
    const audit = authority.audit
      ? [accessChangeAuditStatement(env, input.tenant_id, expected.user_id, authority.audit, {
        version: version + 1,
        before: accessStateOf(expected),
        after: { role: input.role, active: input.active },
        actorUserId: authority.actorUserId,
      })]
      : [];
    const result = input.active && audit.length === 0
      ? await mutation.run()
      : (await env.DB.batch([
        mutation,
        ...audit,
        ...(input.active ? [] : deactivationCleanupStatements(env, {
          tenantId: input.tenant_id,
          userId: expected.user_id,
          emailNormalized: input.email_normalized,
          role: input.role,
          mutationUpdatedAt,
          revokedAt: now,
          revokedByUserId: authority.actorUserId,
        })),
      ]))[0];
    changed = d1Changes(result);
  } else {
    const mutation = env.DB.prepare(
      `INSERT INTO app_users
         (user_id, tenant_id, email_normalized, display_name, role, access_role, frappe_user_id,
          active, created_by, created_at, updated_at)
       SELECT ?,?,?,?,?,?,?,?,?,?,?
        WHERE EXISTS (
          SELECT 1 FROM app_users AS actor
           WHERE actor.tenant_id = ? AND actor.user_id = ?
             AND actor.active = 1 AND actor.access_role = ?
        )
       ON CONFLICT(tenant_id, email_normalized) DO NOTHING`,
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
      mutationUpdatedAt,
      input.tenant_id,
      authority.actorUserId,
      authority.actorRole,
    );
    const audit = authority.audit
      ? [accessChangeAuditStatement(env, input.tenant_id, candidateId, authority.audit, {
        version: 1,
        before: null,
        after: { role: input.role, active: input.active },
        actorUserId: authority.actorUserId,
      })]
      : [];
    const result = input.active && audit.length === 0
      ? await mutation.run()
      : (await env.DB.batch([
        mutation,
        ...audit,
        ...(input.active ? [] : deactivationCleanupStatements(env, {
          tenantId: input.tenant_id,
          userId: candidateId,
          emailNormalized: input.email_normalized,
          role: input.role,
          mutationUpdatedAt,
          revokedAt: now,
          revokedByUserId: authority.actorUserId,
        })),
      ]))[0];
    changed = d1Changes(result);
  }

  let row = changed === 1
    ? await findAppUserByEmail(env, input.tenant_id, input.email_normalized)
    : null;
  // Two identical concurrent creates are one idempotent grant. A changed actor or any different
  // target state still returns the conflict above instead of being treated as a replay.
  if (!row && !expected) {
    row = await env.DB.prepare(
      `SELECT user_id, tenant_id, email_normalized, display_name,
              access_role AS role, access_version, frappe_user_id,
              active, created_by, created_at, updated_at
         FROM app_users AS target
        WHERE target.tenant_id = ? AND target.email_normalized = ?
          AND target.display_name = ? AND target.access_role = ?
          AND target.frappe_user_id IS ? AND target.active = ?
          AND EXISTS (
            SELECT 1 FROM app_users AS actor
             WHERE actor.tenant_id = ? AND actor.user_id = ?
               AND actor.active = 1 AND actor.access_role = ?
          )
        LIMIT 1`,
    ).bind(
      input.tenant_id,
      input.email_normalized,
      input.display_name,
      input.role,
      input.frappe_user_id,
      input.active ? 1 : 0,
      input.tenant_id,
      authority.actorUserId,
      authority.actorRole,
    ).first<AppUserRecord>();
  }
  if (!row) return null;
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
            access_role AS role, access_version, frappe_user_id,
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
    /** This deployment's configured tenant; a pairing issued for any other is never consumed. */
    tenantId: string;
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
       AND p.tenant_id = ?
     LIMIT 1`,
  ).bind(input.tokenHash, input.createdAt, input.tenantId).first<AppUserRecord>();
  if (!candidate) return null;

  // Claim before creating a session. The compare-and-set makes the opaque QR secret
  // single-use even when two scanners submit at the same instant. A later storage
  // failure is fail-closed: the office issues a fresh QR instead of restoring a claim.
  const claim = await env.DB.prepare(
    `UPDATE app_device_pairings SET consumed_at = ?
     WHERE token_hash = ? AND user_id = ? AND consumed_at IS NULL AND revoked_at IS NULL
       AND expires_at > ? AND tenant_id = ?`,
  ).bind(input.createdAt, input.tokenHash, candidate.user_id, input.createdAt, input.tenantId).run();
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

/**
 * The phone on the tenant's saved company profile, exactly as stored, or null when no owner has
 * saved a profile yet (the deployment defaults carry no phone). One primary-key row read only by
 * the routes that answer with a session envelope; `company-setup-store.ts` owns the profile.
 */
export async function findSavedCompanyPhone(env: Env, tenantId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT phone FROM tenant_company_profiles WHERE tenant_id = ? LIMIT 1",
  ).bind(tenantId).first<{ phone: string | null }>();
  return row?.phone ?? null;
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
  const settledInviteCutoff = new Date(now.getTime() - 90 * 24 * 60 * 60_000).toISOString();
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
    // A settled invitation is retained long enough to answer "who let this person in, and when",
    // then dropped; the durable answer lives in app_auth_audit, which keeps a year. An expired
    // invitation is kept for the same window so an owner can still see that it lapsed unused
    // rather than finding the row silently gone.
    env.DB.prepare(
      `DELETE FROM app_user_invites
        WHERE (accepted_at IS NOT NULL AND accepted_at <= ?)
           OR (revoked_at IS NOT NULL AND revoked_at <= ?)
           OR (accepted_at IS NULL AND revoked_at IS NULL AND expires_at <= ?)`,
    ).bind(settledInviteCutoff, settledInviteCutoff, settledInviteCutoff).run(),
  ]);
}

/**
 * Every statement is guarded by the unique post-CAS row marker written by the first statement in
 * the D1 batch. If that authority CAS changes zero rows, none of these statements may close a
 * credential. If it succeeds, D1 commits the access withdrawal and every way back in together.
 */
function deactivationCleanupStatements(
  env: Env,
  input: {
    tenantId: string;
    userId: string;
    emailNormalized: string;
    role: AppRole;
    mutationUpdatedAt: string;
    revokedAt: string;
    revokedByUserId: string;
  },
): D1PreparedStatement[] {
  const appliedMutation = `EXISTS (
    SELECT 1 FROM app_users AS deactivated
     WHERE deactivated.tenant_id = ? AND deactivated.user_id = ?
       AND deactivated.email_normalized = ? AND deactivated.access_role = ?
       AND deactivated.active = 0 AND deactivated.updated_at = ?
  )`;
  const marker = [
    input.tenantId,
    input.userId,
    input.emailNormalized,
    input.role,
    input.mutationUpdatedAt,
  ];
  return [
    env.DB.prepare(
      `UPDATE app_user_invites
          SET revoked_at = ?, revoked_by_user_id = ?, revoked_reason = 'office_revoked'
        WHERE tenant_id = ? AND email_normalized = ?
          AND accepted_at IS NULL AND revoked_at IS NULL
          AND ${appliedMutation}`,
    ).bind(
      input.revokedAt,
      input.revokedByUserId,
      input.tenantId,
      input.emailNormalized,
      ...marker,
    ),
    env.DB.prepare(
      `UPDATE app_sessions SET revoked_at = ?
        WHERE user_id = ? AND tenant_id = ? AND revoked_at IS NULL
          AND ${appliedMutation}`,
    ).bind(input.revokedAt, input.userId, input.tenantId, ...marker),
    env.DB.prepare(
      `UPDATE app_magic_links SET consumed_at = ?
        WHERE user_id = ? AND tenant_id = ? AND consumed_at IS NULL
          AND ${appliedMutation}`,
    ).bind(input.revokedAt, input.userId, input.tenantId, ...marker),
    env.DB.prepare(
      `UPDATE app_devices SET revoked_at = ?
        WHERE user_id = ? AND tenant_id = ? AND revoked_at IS NULL
          AND ${appliedMutation}`,
    ).bind(input.revokedAt, input.userId, input.tenantId, ...marker),
  ];
}

/**
 * RFC 3339 permits additional fractional-second digits. Appending UUID-derived decimal entropy
 * keeps `updated_at` a sortable timestamp while giving this one authority mutation a private
 * marker that a zero-change concurrent CAS cannot accidentally satisfy.
 */
function authorityMutationTimestamp(now: string): string {
  if (!now.endsWith("Z") || now.length > 24) return now;
  const entropy = crypto.randomUUID().replaceAll("-", "").slice(0, 16)
    .split("").map((digit) => String(Number.parseInt(digit, 16) % 10)).join("");
  return `${now.slice(0, -1)}${entropy}Z`;
}

function d1Changes(result: unknown): number {
  return Number((result as { meta?: { changes?: number } }).meta?.changes ?? 0);
}

export function isAppRole(value: unknown): value is AppRole {
  return value === "owner" || value === "ops" || value === "sales" ||
    value === "production" || value === "accounting" || value === "field";
}
