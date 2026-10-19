import type {
  AppRole,
  AppUserRecord,
  AuthRequestContext,
} from "./app-types.ts";

/**
 * One office-issued invitation. The raw invite secret never reaches this record: `token_hash` is
 * the SHA-256 of a 43-character browser secret that was emailed once, exactly as the magic-link
 * and device-pairing ledgers store theirs.
 */
export interface AppUserInviteRecord {
  invite_id: string;
  tenant_id: string;
  email_normalized: string;
  display_name: string;
  access_role: AppRole;
  token_hash: string;
  invited_by_user_id: string;
  created_at: string;
  expires_at: string;
  last_sent_at: string;
  resend_count: number;
  accepted_at: string | null;
  accepted_user_id: string | null;
  revoked_at: string | null;
  revoked_by_user_id: string | null;
  revoked_reason: "office_revoked" | "superseded" | null;
}

const INVITE_COLUMNS = `invite_id, tenant_id, email_normalized, display_name, access_role,
       token_hash, invited_by_user_id, created_at, expires_at, last_sent_at, resend_count,
       accepted_at, accepted_user_id, revoked_at, revoked_by_user_id, revoked_reason`;

const USER_COLUMNS = `user_id, tenant_id, email_normalized, display_name,
       access_role AS role, access_version, frappe_user_id, active, created_by, created_at,
       updated_at`;

/**
 * Issue one invitation, superseding whatever was open for the same mailbox.
 *
 * D1 batches are transactional and sequential, so two office tabs cannot interleave a
 * supersede/insert pair and leave two live secrets for one person: the later completed issuance
 * closes the earlier one as one mutation. `app_user_invites_one_open_uidx` is the storage-level
 * statement of the same rule, so a race that somehow escaped the batch fails closed rather than
 * doubling the usable credentials for a mailbox.
 */
export async function issueUserInvite(
  env: Env,
  input: {
    inviteId: string;
    tenantId: string;
    emailNormalized: string;
    displayName: string;
    role: AppRole;
    tokenHash: string;
    invitedByUserId: string;
    createdAt: string;
    expiresAt: string;
    request: AuthRequestContext;
  },
): Promise<AppUserInviteRecord | null> {
  const supersede = env.DB.prepare(
    `UPDATE app_user_invites
        SET revoked_at = ?, revoked_by_user_id = ?, revoked_reason = 'superseded'
      WHERE tenant_id = ? AND email_normalized = ?
        AND accepted_at IS NULL AND revoked_at IS NULL`,
  ).bind(
    input.createdAt,
    input.invitedByUserId,
    input.tenantId,
    input.emailNormalized,
  );
  const insert = env.DB.prepare(
    `INSERT INTO app_user_invites
       (invite_id, tenant_id, email_normalized, display_name, access_role, token_hash,
        invited_by_user_id, created_at, expires_at, last_sent_at, resend_count,
        accepted_at, accepted_user_id, revoked_at, revoked_by_user_id, revoked_reason,
        issued_ip_hash, issued_user_agent_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?,0,NULL,NULL,NULL,NULL,NULL,?,?)`,
  ).bind(
    input.inviteId,
    input.tenantId,
    input.emailNormalized,
    input.displayName,
    input.role,
    input.tokenHash,
    input.invitedByUserId,
    input.createdAt,
    input.expiresAt,
    input.createdAt,
    input.request.ip_hash,
    input.request.user_agent_hash,
  );
  await env.DB.batch([supersede, insert]);
  return await findUserInviteById(env, input.tenantId, input.inviteId);
}

/**
 * Rotate an open invitation's secret and expiry. An expired-but-open invitation is deliberately
 * resendable: the office's remedy for "the link timed out" is a fresh secret on the same
 * invitation, not a second invitation record for one person.
 */
export async function resendUserInvite(
  env: Env,
  input: {
    tenantId: string;
    inviteId: string;
    tokenHash: string;
    now: string;
    expiresAt: string;
  },
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE app_user_invites
        SET token_hash = ?, expires_at = ?, last_sent_at = ?, resend_count = resend_count + 1
      WHERE invite_id = ? AND tenant_id = ?
        AND accepted_at IS NULL AND revoked_at IS NULL`,
  ).bind(
    input.tokenHash,
    input.expiresAt,
    input.now,
    input.inviteId,
    input.tenantId,
  ).run();
  return d1Changes(result) === 1;
}

export async function revokeUserInvite(
  env: Env,
  input: {
    tenantId: string;
    inviteId: string;
    revokedByUserId: string;
    now: string;
  },
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE app_user_invites
        SET revoked_at = ?, revoked_by_user_id = ?, revoked_reason = 'office_revoked'
      WHERE invite_id = ? AND tenant_id = ?
        AND accepted_at IS NULL AND revoked_at IS NULL`,
  ).bind(input.now, input.revokedByUserId, input.inviteId, input.tenantId).run();
  return d1Changes(result) === 1;
}

export async function listUserInvites(
  env: Env,
  tenantId: string,
  limit = 200,
): Promise<AppUserInviteRecord[]> {
  const result = await env.DB.prepare(
    `SELECT ${INVITE_COLUMNS}
       FROM app_user_invites
      WHERE tenant_id = ?
      ORDER BY created_at DESC, invite_id ASC
      LIMIT ?`,
  ).bind(tenantId, limit).all<AppUserInviteRecord>();
  return result.results ?? [];
}

export async function findUserInviteById(
  env: Env,
  tenantId: string,
  inviteId: string,
): Promise<AppUserInviteRecord | null> {
  return await env.DB.prepare(
    `SELECT ${INVITE_COLUMNS} FROM app_user_invites
      WHERE invite_id = ? AND tenant_id = ? LIMIT 1`,
  ).bind(inviteId, tenantId).first<AppUserInviteRecord>();
}

/**
 * Look one invitation up by the hash of the presented secret, in whatever state it is in.
 *
 * The accept path needs the terminal states — accepted, revoked, expired — to answer with a
 * distinct code instead of a uniform "no". The tenant is deliberately not a filter here: the
 * caller compares it against the Worker's configured tenant and answers `invite_not_found` on a
 * mismatch, so a token minted elsewhere cannot confirm its own existence in this deployment.
 */
export async function findUserInviteByTokenHash(
  env: Env,
  tokenHash: string,
): Promise<AppUserInviteRecord | null> {
  return await env.DB.prepare(
    `SELECT ${INVITE_COLUMNS} FROM app_user_invites WHERE token_hash = ? LIMIT 1`,
  ).bind(tokenHash).first<AppUserInviteRecord>();
}

/**
 * Materialize the grant and claim the invitation as one transaction.
 *
 * Both statements carry the same open-invitation predicate, so an office revoke that lands
 * between the caller's read and this batch leaves the grant unwritten as well as the claim
 * unrecorded. The user id the claim binds is resolved from `app_users` itself rather than passed
 * in, which is what keeps `accepted_user_id` pointing at the row that exists after statement one
 * whether it was inserted here or already present.
 *
 * `storageRole` mirrors `upsertAppUser`: the deployed `app_users.role` CHECK predates the
 * least-privilege vocabulary and `access_role` (migration 0038) is the sole effective role.
 */
export async function claimUserInvite(
  env: Env,
  input: {
    invite: AppUserInviteRecord;
    candidateUserId: string;
    storageRole: "owner" | "ops";
    now: string;
  },
): Promise<{ claimed: boolean; user: AppUserRecord | null }> {
  const openInvite =
    `SELECT 1 FROM app_user_invites
      WHERE invite_id = ? AND tenant_id = ?
        AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`;
  const grant = env.DB.prepare(
    `INSERT INTO app_users
       (user_id, tenant_id, email_normalized, display_name, role, access_role, frappe_user_id,
        active, created_by, created_at, updated_at)
     SELECT ?,?,?,?,?,?,NULL,1,?,?,?
      WHERE EXISTS (${openInvite})
     ON CONFLICT(tenant_id, email_normalized) DO UPDATE SET
       display_name = excluded.display_name,
       role = excluded.role,
       access_role = excluded.access_role,
       active = 1,
       updated_at = excluded.updated_at`,
  ).bind(
    input.candidateUserId,
    input.invite.tenant_id,
    input.invite.email_normalized,
    input.invite.display_name,
    input.storageRole,
    input.invite.access_role,
    `invite:${input.invite.invite_id}`,
    input.now,
    input.now,
    input.invite.invite_id,
    input.invite.tenant_id,
    input.now,
  );
  const claim = env.DB.prepare(
    `UPDATE app_user_invites
        SET accepted_at = ?,
            accepted_user_id = (
              SELECT user_id FROM app_users
               WHERE tenant_id = ? AND email_normalized = ? LIMIT 1
            )
      WHERE invite_id = ? AND tenant_id = ?
        AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
  ).bind(
    input.now,
    input.invite.tenant_id,
    input.invite.email_normalized,
    input.invite.invite_id,
    input.invite.tenant_id,
    input.now,
  );
  const [, claimResult] = await env.DB.batch([grant, claim]);
  if (d1Changes(claimResult) !== 1) return { claimed: false, user: null };
  const user = await env.DB.prepare(
    `SELECT ${USER_COLUMNS} FROM app_users
      WHERE tenant_id = ? AND email_normalized = ? LIMIT 1`,
  ).bind(input.invite.tenant_id, input.invite.email_normalized).first<AppUserRecord>();
  return { claimed: true, user };
}

/**
 * Close an invitation without granting anything, for the one case where the mailbox already has
 * live access. Accepting must not re-grade a live account through an emailed link, so the
 * invitation is simply spent and the account's current role — whatever the role-change route last
 * set — stands.
 */
export async function settleUserInviteWithoutGrant(
  env: Env,
  input: {
    invite: AppUserInviteRecord;
    userId: string;
    now: string;
  },
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE app_user_invites SET accepted_at = ?, accepted_user_id = ?
      WHERE invite_id = ? AND tenant_id = ?
        AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
  ).bind(
    input.now,
    input.userId,
    input.invite.invite_id,
    input.invite.tenant_id,
    input.now,
  ).run();
  return d1Changes(result) === 1;
}

function d1Changes(result: unknown): number {
  return Number((result as { meta?: { changes?: number } }).meta?.changes ?? 0);
}
