// app-user-invites.ts — office user invitations, and the two ways an existing office user's
// access changes.
//
// An invitation is a credential, not a session. It is one high-entropy secret, emailed once,
// stored only as a SHA-256 hash, bound to one tenant, one normalized mailbox and one access role,
// expiring, single-use, revocable and supersedable — the same shape the Field Companion device
// pairing (0014) already uses for the same reasons. Accepting it materializes the `app_users`
// grant and then hands the person to the product's existing sign-in path; it never mints a
// session of its own and there is no password anywhere in this file.
//
// Two rules in here are worth reading before changing anything:
//
//  1. Nothing an office user can call reveals whether a mailbox already has access. Issuing,
//     re-sending and revoking answer with the invitation's own state and nothing else, so the
//     invite surface can never be used as an account-existence oracle.
//  2. The server decides authority. The browser sends an email, a role, or an id; every "may
//     this happen" question — office role, owner-only operations, self-service lockout, the last
//     owner — is answered here against D1, never by what the caller claims.

import * as authStore from "./app-auth-store.ts";
import {
  appPublicOrigin,
  authRequestContext,
  cleanText,
  configuredTenantId,
  deliverMagicLink,
  devOutboxCapture,
  escapeHtml,
  normalizeEmail,
  randomToken,
  sha256Hex,
  validAppCsrf,
  type AuthDependencies,
} from "./app-auth.ts";
import {
  claimUserInvite,
  findUserInviteById,
  findUserInviteByTokenHash,
  issueUserInvite,
  listUserInvites,
  resendUserInvite,
  revokeUserInvite,
  settleUserInviteWithoutGrant,
  type AppUserInviteRecord,
} from "./app-user-invite-store.ts";
import {
  APP_API_VERSION,
  AUTH_THROTTLE_WINDOW_SECONDS,
  MAGIC_LINK_CONSUME_IP_LIMIT,
  type AppEnv,
  type AppRole,
  type AppUserRecord,
  type AuthContext,
  type AuthRequestContext,
} from "./app-types.ts";
import { gmailConfigured, sendGmail } from "./google.ts";

/**
 * Seven days. Long enough that an invitation survives a week off and a mailbox that is only read
 * on a laptop; short enough that a forgotten invitation is not a standing key to the company. A
 * lapsed invitation is re-sendable, so the expiry costs the office one tap, not a re-invitation.
 */
export const USER_INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;

const MAX_INVITE_BODY_BYTES = 4 * 1024;
const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const INVITE_ID_PATTERN = /^appi_[0-9a-f-]{36}$/i;
const APP_USER_ID_PATTERN = /^appu_[0-9a-f-]{36}$/i;

export type UserInviteState = "pending" | "accepted" | "revoked" | "expired";

export interface UserInviteDependencies extends AuthDependencies {
  sendInvite?: (
    env: AppEnv,
    invite: AppUserInviteRecord,
    rawToken: string,
  ) => Promise<void>;
}

interface RouteFailure {
  ok: false;
  error: string;
  status: number;
  /** Present on `access_version_conflict`: what moved since the refused change was decided. */
  conflict?: AccessConflict | null;
}

/**
 * The body of a 409 `access_version_conflict` past `error`, so the refused screen can say who
 * changed the person's access, what is different now and which version to decide on next.
 */
export interface AccessConflict {
  user_id: string;
  /** The version the person's access carries now. */
  access_version: number;
  /** When the newest change since the refused change's version was recorded. */
  changed_at: string | null;
  changed_by: {
    user_id: string;
    display_name: string | null;
    /** The person whose change was refused made that change too (another tab or device). */
    is_self_actor: boolean;
  } | null;
  change: {
    /** The access at the version the refused change was decided on, when the audit can say. */
    before: authStore.AccessState | null;
    after: authStore.AccessState;
  };
}

/**
 * One semantic authority policy for both id-addressed changes and the legacy email-keyed upsert.
 * Every caller passes this exact actor/target snapshot to the mutation store, which proves it is
 * still current in the write statement; that CAS is what keeps these rules true under races.
 */
export function authorizeAppUserMutation(
  auth: AuthContext,
  target: AppUserRecord | null,
  requestedRole: AppRole,
): RouteFailure | null {
  if (target?.user_id === auth.session.user_id) {
    return { ok: false, error: "self_change_forbidden", status: 409 };
  }
  return (target?.role === "owner" || requestedRole === "owner") &&
      auth.session.role !== "owner"
    ? { ok: false, error: "owner_role_required", status: 403 }
    : null;
}

// --------------------------------------------------------------------------- projections

/**
 * What an invitation looks like to the office. It deliberately carries no token, no token hash,
 * and no hint about the invited mailbox's account: an owner reading this list learns the state of
 * the invitations they issued, and reads who has access from the people list instead.
 */
export function userInviteProjection(
  invite: AppUserInviteRecord,
  now: string,
): Record<string, unknown> {
  return {
    invite_id: invite.invite_id,
    email: invite.email_normalized,
    display_name: invite.display_name,
    role: invite.access_role,
    state: userInviteState(invite, now),
    invited_by_user_id: invite.invited_by_user_id,
    invited_at: invite.created_at,
    expires_at: invite.expires_at,
    last_sent_at: invite.last_sent_at,
    resend_count: invite.resend_count,
    accepted_at: invite.accepted_at,
    revoked_at: invite.revoked_at,
    revoked_reason: invite.revoked_reason,
  };
}

/**
 * Terminal states are read before expiry, because an invitation that was accepted on Monday did
 * not become "expired" on Friday. Expiry is the only state derived from the clock.
 */
export function userInviteState(
  invite: AppUserInviteRecord,
  now: string,
): UserInviteState {
  if (invite.accepted_at) return "accepted";
  if (invite.revoked_at) return "revoked";
  return invite.expires_at > now ? "pending" : "expired";
}

function appUserProjection(
  user: AppUserRecord,
  auth: AuthContext,
  crewPhoneUnpaired: boolean,
): Record<string, unknown> {
  return {
    user_id: user.user_id,
    email: user.email_normalized,
    display_name: user.display_name,
    role: user.role,
    active: user.active === 1,
    access_version: Number(user.access_version ?? 1),
    updated_at: user.updated_at,
    /** The signed-in owner must not be able to lock themselves out of their own tenant. */
    is_self: user.user_id === auth.session.user_id,
    /** Removing their access unpaired a crew phone, which giving it back does not re-pair. */
    crew_phone_unpaired: crewPhoneUnpaired,
  };
}

/** One person's projection, with whether a removal unpaired their crew phone. */
async function projectAppUser(
  env: AppEnv,
  user: AppUserRecord,
  auth: AuthContext,
): Promise<Record<string, unknown>> {
  const unpaired = await authStore.usersWithCrewPhoneUnpairedByRemoval(
    env,
    auth.session.tenant_id,
    user.user_id,
  );
  return appUserProjection(user, auth, unpaired.has(user.user_id));
}

// --------------------------------------------------------------------------- input parsing

export function parseUserInviteInput(
  value: unknown,
): { ok: true; value: { email: string; displayName: string; role: AppRole } } | {
  ok: false;
  error: string;
} {
  if (!isRecord(value)) return { ok: false, error: "invalid_body" };
  const allowed = new Set(["email", "display_name", "role"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    return { ok: false, error: "unexpected_field" };
  }
  const email = normalizeEmail(value.email);
  const displayName = cleanText(value.display_name, 1, 120);
  if (!email) return { ok: false, error: "invalid_email" };
  if (!displayName) return { ok: false, error: "invalid_display_name" };
  if (!authStore.isAppRole(value.role)) return { ok: false, error: "invalid_role" };
  return { ok: true, value: { email, displayName, role: value.role } };
}

/**
 * The access version a person's change was decided on (0157). Required on every change to an
 * existing person; a stale one is refused rather than applied over someone else's decision.
 */
export function parseExpectedAccessVersion(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) < 1_000_000_000
    ? (value as number)
    : null;
}

export function parseRoleChange(
  value: unknown,
):
  | { ok: true; value: { role: AppRole; expectedAccessVersion: number } }
  | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "invalid_body" };
  if (Object.keys(value).some((key) => key !== "role" && key !== "expected_access_version")) {
    return { ok: false, error: "unexpected_field" };
  }
  if (!authStore.isAppRole(value.role)) return { ok: false, error: "invalid_role" };
  const expectedAccessVersion = parseExpectedAccessVersion(value.expected_access_version);
  if (expectedAccessVersion === null) {
    return { ok: false, error: "expected_access_version_required" };
  }
  return { ok: true, value: { role: value.role, expectedAccessVersion } };
}

export function parseAccessChange(
  value: unknown,
):
  | { ok: true; value: { active: boolean; expectedAccessVersion: number } }
  | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "invalid_body" };
  if (Object.keys(value).some((key) => key !== "active" && key !== "expected_access_version")) {
    return { ok: false, error: "unexpected_field" };
  }
  if (typeof value.active !== "boolean") return { ok: false, error: "invalid_active" };
  const expectedAccessVersion = parseExpectedAccessVersion(value.expected_access_version);
  if (expectedAccessVersion === null) {
    return { ok: false, error: "expected_access_version_required" };
  }
  return { ok: true, value: { active: value.active, expectedAccessVersion } };
}

/**
 * What moved since `expectedAccessVersion`, read from the person's versioned access audit: the
 * newest change names the actor and when, the first change after that version names the access
 * before it, and the person's row is the access now. `changed_by` and `change.before` are null
 * when the audit cannot say (history from before 0157, or more changes since than it reads).
 *
 * There is deliberately no device: the audit keeps only keyed hashes of the network address and
 * browser, and no session, so it cannot tell "your phone" from another tab on this computer.
 */
export async function accessConflictBody(
  env: AppEnv,
  auth: AuthContext,
  current: AppUserRecord | null,
  expectedAccessVersion: number,
): Promise<AccessConflict | null> {
  if (!current) return null;
  const changes = await authStore.listAccessChangesSince(
    env,
    auth.session.tenant_id,
    current.user_id,
    expectedAccessVersion,
  );
  const newest = changes[0];
  const first = changes.at(-1);
  const actor = newest
    ? await authStore.findAppUserById(env, auth.session.tenant_id, newest.actorUserId)
    : null;
  return {
    user_id: current.user_id,
    access_version: Number(current.access_version ?? 1),
    changed_at: newest?.recordedAt ?? null,
    changed_by: newest
      ? {
        user_id: newest.actorUserId,
        display_name: actor?.display_name ?? null,
        is_self_actor: newest.actorUserId === auth.session.user_id,
      }
      : null,
    change: {
      before: first?.version === expectedAccessVersion + 1 ? first.before : null,
      after: { role: current.role, active: current.active === 1 },
    },
  };
}

/** A change decided on an older access version than the person now carries. */
async function accessVersionConflict(
  env: AppEnv,
  auth: AuthContext,
  current: AppUserRecord,
  expectedAccessVersion: number,
): Promise<RouteFailure> {
  return {
    ok: false,
    error: "access_version_conflict",
    status: 409,
    conflict: await accessConflictBody(env, auth, current, expectedAccessVersion),
  };
}

/** After a refused write: a moved access version is the conflict, anything else a state change. */
async function accessWriteFailure(
  env: AppEnv,
  auth: AuthContext,
  userId: string,
  expectedAccessVersion: number,
): Promise<RouteFailure> {
  const current = await authStore.findAppUserById(env, auth.session.tenant_id, userId);
  return current && Number(current.access_version ?? 1) !== expectedAccessVersion
    ? await accessVersionConflict(env, auth, current, expectedAccessVersion)
    : { ok: false, error: "app_user_state_changed", status: 409 };
}

export function parseInviteAcceptance(
  value: unknown,
): { ok: true; value: { token: string } } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "invalid_body" };
  if (Object.keys(value).some((key) => key !== "token")) {
    return { ok: false, error: "unexpected_field" };
  }
  return typeof value.token === "string" && INVITE_TOKEN_PATTERN.test(value.token)
    ? { ok: true, value: { token: value.token } }
    : { ok: false, error: "invalid_request" };
}

// --------------------------------------------------------------------------- office surface

export async function listUserInvitesForOffice(
  env: AppEnv,
  auth: AuthContext,
): Promise<{ ok: true; body: Record<string, unknown> } | RouteFailure> {
  const guard = officeGuard(auth);
  if (guard) return guard;
  const now = new Date().toISOString();
  const invites = await listUserInvites(env, auth.session.tenant_id);
  return {
    ok: true,
    body: {
      version: APP_API_VERSION,
      invites: invites.map((invite) => userInviteProjection(invite, now)),
    },
  };
}

/**
 * Issue an invitation.
 *
 * The response is the invitation, always, and only the invitation. It is byte-shape identical
 * whether the mailbox is unknown to this tenant, already has an active account, or has a
 * deactivated one — which is the whole privacy rule: an office user who does not already have
 * the people list cannot turn this route into a "does <email> work here" probe, and neither can
 * anyone who steals one office session.
 */
export async function createUserInvite(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  deps: UserInviteDependencies = {},
): Promise<
  | { ok: true; body: Record<string, unknown>; status: number }
  | RouteFailure
> {
  const guard = officeMutationGuard(req, auth);
  if (guard) return guard;
  const tenantId = configuredTenantId(env);
  if (!tenantId || tenantId !== auth.session.tenant_id) {
    return { ok: false, error: "app_bff_not_configured", status: 503 };
  }
  const parsed = await readInviteJson(req);
  if (!parsed.ok) return { ok: false, error: parsed.error, status: parsed.status };
  const input = parseUserInviteInput(parsed.value);
  if (!input.ok) return { ok: false, error: input.error, status: 400 };
  // Only an owner hands out ownership. An operations account runs the day; letting it mint a
  // second owner would let it grant itself everything an owner has through one mailbox it
  // controls, which is the escalation the separation-of-duties rule exists to stop.
  if (input.value.role === "owner" && auth.session.role !== "owner") {
    return { ok: false, error: "owner_role_required", status: 403 };
  }

  const now = (deps.now ?? (() => new Date()))();
  const rawToken = randomToken();
  const invite = await issueUserInvite(env, {
    inviteId: `appi_${crypto.randomUUID()}`,
    tenantId,
    emailNormalized: input.value.email,
    displayName: input.value.displayName,
    role: input.value.role,
    tokenHash: await sha256Hex(rawToken),
    invitedByUserId: auth.session.user_id,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + USER_INVITE_TTL_SECONDS * 1000).toISOString(),
    request: await authRequestContext(req, env),
  });
  if (!invite) return { ok: false, error: "invite_unavailable", status: 503 };

  await recordInviteAudit(env, req, auth, invite, "user_invite_create", "issued");
  await deliverUserInvite(env, req, invite, rawToken, deps);
  return {
    ok: true,
    status: 201,
    body: {
      version: APP_API_VERSION,
      invite: userInviteProjection(invite, now.toISOString()),
    },
  };
}

/**
 * Re-send an open invitation with a fresh secret. The previous secret stops working at the same
 * instant: "send it again" must not leave two usable keys in two mailboxes.
 */
export async function resendUserInviteForOffice(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  inviteId: string,
  deps: UserInviteDependencies = {},
): Promise<{ ok: true; body: Record<string, unknown> } | RouteFailure> {
  const guard = officeMutationGuard(req, auth);
  if (guard) return guard;
  if (!INVITE_ID_PATTERN.test(inviteId)) {
    return { ok: false, error: "invite_not_found", status: 404 };
  }
  const existing = await findUserInviteById(env, auth.session.tenant_id, inviteId);
  if (!existing) return { ok: false, error: "invite_not_found", status: 404 };
  const ownerGuard = ownerOnlyInviteGuard(existing, auth);
  if (ownerGuard) return ownerGuard;

  const now = (deps.now ?? (() => new Date()))();
  const rawToken = randomToken();
  const rotated = await resendUserInvite(env, {
    tenantId: auth.session.tenant_id,
    inviteId,
    tokenHash: await sha256Hex(rawToken),
    now: now.toISOString(),
    expiresAt: new Date(now.getTime() + USER_INVITE_TTL_SECONDS * 1000).toISOString(),
  });
  if (!rotated) {
    return settledInviteFailure(existing, now.toISOString());
  }
  const invite = await findUserInviteById(env, auth.session.tenant_id, inviteId);
  if (!invite) return { ok: false, error: "invite_unavailable", status: 503 };

  await recordInviteAudit(env, req, auth, invite, "user_invite_resend", "issued");
  await deliverUserInvite(env, req, invite, rawToken, deps);
  return {
    ok: true,
    body: {
      version: APP_API_VERSION,
      invite: userInviteProjection(invite, now.toISOString()),
    },
  };
}

export async function revokeUserInviteForOffice(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  inviteId: string,
): Promise<{ ok: true; body: Record<string, unknown> } | RouteFailure> {
  const guard = officeMutationGuard(req, auth);
  if (guard) return guard;
  if (!INVITE_ID_PATTERN.test(inviteId)) {
    return { ok: false, error: "invite_not_found", status: 404 };
  }
  const existing = await findUserInviteById(env, auth.session.tenant_id, inviteId);
  if (!existing) return { ok: false, error: "invite_not_found", status: 404 };
  const ownerGuard = ownerOnlyInviteGuard(existing, auth);
  if (ownerGuard) return ownerGuard;

  const now = new Date().toISOString();
  const revoked = await revokeUserInvite(env, {
    tenantId: auth.session.tenant_id,
    inviteId,
    revokedByUserId: auth.session.user_id,
    now,
  });
  if (!revoked) return settledInviteFailure(existing, now);
  const invite = await findUserInviteById(env, auth.session.tenant_id, inviteId);
  if (!invite) return { ok: false, error: "invite_unavailable", status: 503 };

  await recordInviteAudit(env, req, auth, invite, "user_invite_revoke", "revoked");
  return {
    ok: true,
    body: { version: APP_API_VERSION, invite: userInviteProjection(invite, now) },
  };
}

// --------------------------------------------------------------------------- accept surface

export interface InviteAcceptance {
  result: "accepted" | "already_active";
  email: string;
  display_name: string;
  role: AppRole;
  /** How this person signs in from here. Crew never receive an email session. */
  next: "magic_link" | "device_pairing";
  sign_in_link_sent: boolean;
}

/**
 * Consume an invitation.
 *
 * Unauthenticated by construction: the token is the authority, exactly as it is for a magic link
 * or a pairing QR. What it produces is a grant, never a session — the invitee is then delivered
 * the product's ordinary sign-in link, or told their phone needs pairing if they are crew.
 *
 * Idempotence is structural. Every terminal state is read before anything is written, and the
 * grant and the claim are one D1 batch under one open-invitation predicate, so a replay cannot
 * re-grade an account, resurrect a withdrawn one, or write a second row. A replay is refused
 * with `invite_already_accepted` rather than quietly re-running: after the first acceptance the
 * secret is spent, and saying so is the honest answer to whoever is holding it.
 */
export async function acceptUserInvite(
  req: Request,
  env: AppEnv,
  ctx: Pick<ExecutionContext, "waitUntil">,
  deps: UserInviteDependencies = {},
): Promise<{ ok: true; body: InviteAcceptance } | RouteFailure> {
  const parsedBody = await readInviteJson(req);
  if (!parsedBody.ok) {
    return { ok: false, error: parsedBody.error, status: parsedBody.status };
  }
  const parsed = parseInviteAcceptance(parsedBody.value);
  if (!parsed.ok) return { ok: false, error: parsed.error, status: 400 };

  const request = await authRequestContext(req, env);
  const now = (deps.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  const allowed = await authStore.claimThrottle(env, {
    keyHash: await sha256Hex(`invite_accept_ip:${request.ip_hash}`),
    scope: "consume_ip",
    now: nowIso,
    windowExpiresAt: new Date(
      now.getTime() + AUTH_THROTTLE_WINDOW_SECONDS * 1000,
    ).toISOString(),
    limit: MAGIC_LINK_CONSUME_IP_LIMIT,
  });
  if (!allowed) return { ok: false, error: "invite_not_found", status: 404 };

  const tenantId = configuredTenantId(env);
  const invite = await findUserInviteByTokenHash(env, await sha256Hex(parsed.value.token));
  // A token minted against another tenant's database, or before this deployment's tenant was
  // changed, is answered exactly like a token that never existed. Cross-tenant existence is not
  // this endpoint's to confirm.
  if (!invite || !tenantId || invite.tenant_id !== tenantId) {
    await authStore.recordAuthAudit(env, {
      tenantId: null,
      userId: null,
      event: "user_invite_accept",
      outcome: "rejected",
      request,
      detailCode: invite ? "tenant_mismatch" : "unknown_token",
    });
    return { ok: false, error: "invite_not_found", status: 404 };
  }
  const state = userInviteState(invite, nowIso);
  if (state !== "pending") {
    await authStore.recordAuthAudit(env, {
      tenantId: invite.tenant_id,
      userId: invite.accepted_user_id,
      event: "user_invite_accept",
      outcome: "rejected",
      request,
      detailCode: `invite_${state}`,
    });
    return settledInviteFailure(invite, nowIso);
  }

  // An account that can already sign in keeps the role it has. Re-grading a live account through
  // a link in a mailbox would let an issued-then-superseded invitation quietly undo a role change
  // the office made deliberately; role changes have their own authenticated route and their own
  // rules. The invitation is still spent, so the secret cannot be used twice.
  const account = await authStore.findAppUserByEmail(
    env,
    invite.tenant_id,
    invite.email_normalized,
  );
  const existing = account?.active === 1 ? account : null;
  if (existing) {
    const settled = await settleUserInviteWithoutGrant(env, {
      invite,
      userId: existing.user_id,
      now: nowIso,
    });
    if (!settled) {
      const current = await findUserInviteById(env, invite.tenant_id, invite.invite_id);
      return settledInviteFailure(current ?? invite, nowIso);
    }
    await authStore.recordAuthAudit(env, {
      tenantId: invite.tenant_id,
      userId: existing.user_id,
      event: "user_invite_accept",
      outcome: "already_active",
      request,
      detailCode: `${existing.role}:${invite.invite_id}`,
    });
    return {
      ok: true,
      body: await acceptanceBody(
        env,
        existing,
        "already_active",
        request,
        now,
        ctx,
        deps,
      ),
    };
  }

  // A removed account gets access back only against the access version read here; its granted
  // audit row, with the change in access_change, commits in the claim's own batch (0157).
  const claim = await claimUserInvite(env, {
    invite,
    candidateUserId: `appu_${crypto.randomUUID()}`,
    // Mirrors `upsertAppUserWithAuthority`: `app_users.role` is a deployed authentication-class
    // CHECK that predates the least-privilege vocabulary, and `access_role` (0038) is the effective
    // role.
    storageRole: invite.access_role === "owner" ? "owner" : "ops",
    now: nowIso,
    expected: account,
    request,
  });
  if (!claim.claimed || !claim.user) {
    const current = await findUserInviteById(env, invite.tenant_id, invite.invite_id);
    return settledInviteFailure(current ?? invite, nowIso);
  }
  return {
    ok: true,
    body: await acceptanceBody(env, claim.user, "accepted", request, now, ctx, deps),
  };
}

async function acceptanceBody(
  env: AppEnv,
  user: AppUserRecord,
  result: InviteAcceptance["result"],
  request: AuthRequestContext,
  now: Date,
  ctx: Pick<ExecutionContext, "waitUntil">,
  deps: UserInviteDependencies,
): Promise<InviteAcceptance> {
  // Crew never receive a passwordless email session; their session comes from an office-issued
  // QR pairing plus a device proof. Sending them a sign-in link would be an offer the sign-in
  // route refuses, so the acceptance says what actually happens next instead.
  if (user.role === "field") {
    return {
      result,
      email: user.email_normalized,
      display_name: user.display_name,
      role: user.role,
      next: "device_pairing",
      sign_in_link_sent: false,
    };
  }
  const deliverable = gmailConfigured(env) ||
    String(env.APP_ALLOW_INSECURE_LOCAL) === "true";
  if (deliverable) {
    await deliverMagicLink(env, user, request, now, ctx, deps, "invite_accept");
  }
  return {
    result,
    email: user.email_normalized,
    display_name: user.display_name,
    role: user.role,
    next: "magic_link",
    sign_in_link_sent: deliverable,
  };
}

// --------------------------------------------------------------------------- people surface

export async function listAppUsersForOffice(
  env: AppEnv,
  auth: AuthContext,
): Promise<{ ok: true; body: Record<string, unknown> } | RouteFailure> {
  const guard = officeGuard(auth);
  if (guard) return guard;
  const users = await authStore.listAppUsers(env, auth.session.tenant_id);
  const unpaired = await authStore.usersWithCrewPhoneUnpairedByRemoval(
    env,
    auth.session.tenant_id,
  );
  return {
    ok: true,
    body: {
      version: APP_API_VERSION,
      users: users.map((user) => appUserProjection(user, auth, unpaired.has(user.user_id))),
    },
  };
}

/**
 * Change one person's role.
 *
 * Two refusals are the point of this route existing separately from the provisioning upsert:
 * nobody re-grades themselves, and ownership is only handed out or taken back by an owner. Those
 * two together make a tenant impossible to lock out of itself: the actor must still be an active
 * owner at write time to touch an owner and cannot be the target, so there is deliberately no
 * separate "last owner" count to keep in step with them.
 */
export async function changeAppUserRole(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  userId: string,
): Promise<{ ok: true; body: Record<string, unknown> } | RouteFailure> {
  const guard = officeMutationGuard(req, auth);
  if (guard) return guard;
  const parsedBody = await readInviteJson(req);
  if (!parsedBody.ok) {
    return { ok: false, error: parsedBody.error, status: parsedBody.status };
  }
  const parsed = parseRoleChange(parsedBody.value);
  if (!parsed.ok) return { ok: false, error: parsed.error, status: 400 };

  const target = await loadTarget(env, auth, userId);
  if (!target.ok) return target;
  const user = target.user;
  const authority = authorizeAppUserMutation(auth, user, parsed.value.role);
  if (authority) return authority;
  if (Number(user.access_version ?? 1) !== parsed.value.expectedAccessVersion) {
    return await accessVersionConflict(env, auth, user, parsed.value.expectedAccessVersion);
  }
  if (user.role === parsed.value.role) {
    return {
      ok: true,
      body: { version: APP_API_VERSION, user: await projectAppUser(env, user, auth) },
    };
  }

  const updated = await authStore.setAppUserAccessRole(env, {
    tenantId: auth.session.tenant_id,
    userId: user.user_id,
    role: parsed.value.role,
    now: new Date().toISOString(),
    authority: {
      actorUserId: auth.session.user_id,
      actorRole: auth.session.role,
      expectedTarget: user,
      audit: {
        event: "user_role_change",
        outcome: "changed",
        request: await authRequestContext(req, env),
        detailCode: `${user.role}->${parsed.value.role}:${auth.session.user_id}`,
      },
    },
  });
  if (!updated) {
    return await accessWriteFailure(env, auth, user.user_id, parsed.value.expectedAccessVersion);
  }
  return {
    ok: true,
    body: { version: APP_API_VERSION, user: await projectAppUser(env, updated, auth) },
  };
}

/**
 * Withdraw or restore one person's access. Withdrawing closes their live sessions, open sign-in
 * link, paired devices and any open invitation in the same act, so "removed" is true immediately
 * and there is no way back in that outlives the decision.
 *
 * The same two refusals as the role route hold the lockout invariant: only an owner may withdraw
 * an owner's access, and nobody may withdraw their own.
 */
export async function changeAppUserAccess(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  userId: string,
): Promise<{ ok: true; body: Record<string, unknown> } | RouteFailure> {
  const guard = officeMutationGuard(req, auth);
  if (guard) return guard;
  const parsedBody = await readInviteJson(req);
  if (!parsedBody.ok) {
    return { ok: false, error: parsedBody.error, status: parsedBody.status };
  }
  const parsed = parseAccessChange(parsedBody.value);
  if (!parsed.ok) return { ok: false, error: parsed.error, status: 400 };

  const target = await loadTarget(env, auth, userId);
  if (!target.ok) return target;
  const user = target.user;
  const authority = authorizeAppUserMutation(auth, user, user.role);
  if (authority) return authority;
  if (Number(user.access_version ?? 1) !== parsed.value.expectedAccessVersion) {
    return await accessVersionConflict(env, auth, user, parsed.value.expectedAccessVersion);
  }
  if ((user.active === 1) === parsed.value.active) {
    return {
      ok: true,
      body: { version: APP_API_VERSION, user: await projectAppUser(env, user, auth) },
    };
  }

  const now = new Date().toISOString();
  const updated = await authStore.setAppUserActive(env, {
    tenantId: auth.session.tenant_id,
    userId: user.user_id,
    active: parsed.value.active,
    now,
    authority: {
      actorUserId: auth.session.user_id,
      actorRole: auth.session.role,
      expectedTarget: user,
      audit: {
        event: "user_access_change",
        outcome: parsed.value.active ? "restored" : "removed",
        request: await authRequestContext(req, env),
        detailCode: `${user.role}:${auth.session.user_id}`,
      },
    },
  });
  if (!updated) {
    return await accessWriteFailure(env, auth, user.user_id, parsed.value.expectedAccessVersion);
  }
  return {
    ok: true,
    body: { version: APP_API_VERSION, user: await projectAppUser(env, updated, auth) },
  };
}

// --------------------------------------------------------------------------- email

export function buildUserInviteEmail(
  env: AppEnv,
  invite: Pick<AppUserInviteRecord, "display_name" | "access_role">,
  rawToken: string,
): { subject: string; html: string; href: string } {
  const origin = appPublicOrigin(env);
  if (!origin) throw new Error("user_invite_origin_not_configured");
  const company = cleanText(env.APP_TENANT_NAME, 1, 120) ?? "IronWrap OS";
  // The secret sits in a fragment, so it never reaches an HTTP request line, a Worker log, or a
  // static-asset route — the same reason the magic link and the pairing QR carry theirs there.
  const href = `${origin}/auth/invite#token=${encodeURIComponent(rawToken)}`;
  const days = Math.round(USER_INVITE_TTL_SECONDS / 86_400);
  return {
    subject: `You have been added to ${company}`,
    html: `<p>Hello ${escapeHtml(invite.display_name)},</p>` +
      `<p>${escapeHtml(company)} has given you access to IronWrap OS.</p>` +
      `<p><a href="${escapeHtml(href)}">Accept your invitation</a></p>` +
      `<p>This one-time invitation expires in ${days} days. There is no password: ` +
      `you sign in with a link sent to this address. ` +
      `If you were not expecting this, ignore this email and tell the sender.</p>`,
    href,
  };
}

async function deliverUserInvite(
  env: AppEnv,
  req: Request,
  invite: AppUserInviteRecord,
  rawToken: string,
  deps: UserInviteDependencies,
): Promise<void> {
  const send = deps.sendInvite ?? sendUserInviteEmail;
  // Delivery never fails the issuance. The invitation is already recorded and revocable, and an
  // office told "not issued" for a mail outage would re-issue and orphan a live secret. The
  // audit carries which of the two happened; the office's remedy is re-send either way.
  let outcome = "sent";
  try {
    await send(env, invite, rawToken);
  } catch {
    outcome = "failed";
  }
  await authStore.recordAuthAudit(env, {
    tenantId: invite.tenant_id,
    userId: invite.invited_by_user_id,
    event: "user_invite_delivery",
    outcome,
    request: await authRequestContext(req, env),
    detailCode: `${invite.access_role}:${invite.invite_id}`,
  });
}

async function sendUserInviteEmail(
  env: AppEnv,
  invite: AppUserInviteRecord,
  rawToken: string,
): Promise<void> {
  const message = buildUserInviteEmail(env, invite, rawToken);
  const captured = await devOutboxCapture(
    env,
    "user_invite",
    invite.email_normalized,
    message.href,
  );
  if (!gmailConfigured(env)) {
    if (captured) return;
    throw new Error("user_invite_email_not_configured");
  }
  await sendGmail(env, invite.email_normalized, message.subject, message.html);
}

// --------------------------------------------------------------------------- guards

function officeGuard(auth: AuthContext): RouteFailure | null {
  return auth.session.role === "owner" || auth.session.role === "ops"
    ? null
    : { ok: false, error: "office_role_required", status: 403 };
}

function officeMutationGuard(req: Request, auth: AuthContext): RouteFailure | null {
  const office = officeGuard(auth);
  if (office) return office;
  return validAppCsrf(req, auth)
    ? null
    : { ok: false, error: "csrf_failed", status: 403 };
}

/** Only an owner may re-send or withdraw an invitation that hands out ownership. */
function ownerOnlyInviteGuard(
  invite: AppUserInviteRecord,
  auth: AuthContext,
): RouteFailure | null {
  return invite.access_role === "owner" && auth.session.role !== "owner"
    ? { ok: false, error: "owner_role_required", status: 403 }
    : null;
}

async function loadTarget(
  env: AppEnv,
  auth: AuthContext,
  userId: string,
): Promise<{ ok: true; user: AppUserRecord } | RouteFailure> {
  if (!APP_USER_ID_PATTERN.test(userId)) {
    return { ok: false, error: "user_not_found", status: 404 };
  }
  const user = await authStore.findAppUserById(env, auth.session.tenant_id, userId);
  return user
    ? { ok: true, user }
    : { ok: false, error: "user_not_found", status: 404 };
}

/**
 * The one place a settled invitation is turned into a refusal, so every caller says the same
 * distinct, honest thing about the same state and the UI has exactly four codes to render.
 */
function settledInviteFailure(
  invite: AppUserInviteRecord,
  now: string,
): RouteFailure {
  const state = userInviteState(invite, now);
  if (state === "accepted") {
    return { ok: false, error: "invite_already_accepted", status: 409 };
  }
  if (state === "revoked") return { ok: false, error: "invite_revoked", status: 409 };
  if (state === "expired") return { ok: false, error: "invite_expired", status: 410 };
  return { ok: false, error: "invite_unavailable", status: 503 };
}

async function recordInviteAudit(
  env: AppEnv,
  req: Request,
  auth: AuthContext,
  invite: AppUserInviteRecord,
  event: string,
  outcome: string,
): Promise<void> {
  await authStore.recordAuthAudit(env, {
    tenantId: invite.tenant_id,
    userId: auth.session.user_id,
    event,
    outcome,
    request: await authRequestContext(req, env),
    detailCode: `${invite.access_role}:${invite.invite_id}`,
  });
}

async function readInviteJson(
  req: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string; status: number }> {
  if (Number(req.headers.get("content-length") ?? "0") > MAX_INVITE_BODY_BYTES) {
    return { ok: false, error: "payload_too_large", status: 413 };
  }
  const text = await req.text();
  if (text.length > MAX_INVITE_BODY_BYTES) {
    return { ok: false, error: "payload_too_large", status: 413 };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: "invalid_json", status: 400 };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
