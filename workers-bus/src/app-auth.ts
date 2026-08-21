import { gmailConfigured, sendGmail } from "./google.ts";
import { frappeReadConfigured } from "./frappe-read.ts";
import * as authStore from "./app-auth-store.ts";
import {
  APP_DEVICE_PROOF_HEADER,
  APP_SESSION_COOKIE,
  AUTH_THROTTLE_WINDOW_SECONDS,
  DEVICE_PAIRING_TTL_SECONDS,
  MAGIC_LINK_CONSUME_IP_LIMIT,
  MAGIC_LINK_REQUEST_EMAIL_LIMIT,
  MAGIC_LINK_REQUEST_IP_LIMIT,
  MAGIC_LINK_TTL_SECONDS,
  SESSION_TTL_SECONDS,
  type AppEnv,
  type AppDeviceRecord,
  type AppTenantPublic,
  type AppUserRecord,
  type AuthContext,
  type AuthRequestContext,
  type ProvisionAppUserInput,
  permissionsForRole,
} from "./app-types.ts";

const MAX_AUTH_BODY_BYTES = 4 * 1024;
const GENERIC_LINK_RESPONSE = {
  ok: true,
  message: "If the account is active, a sign-in link will be sent.",
} as const;

export interface AuthDependencies {
  sendMagicLink?: (env: AppEnv, user: AppUserRecord, rawToken: string) => Promise<void>;
  now?: () => Date;
}

export interface DevicePairingDependencies {
  now?: () => Date;
}

export function appBffConfigured(env: AppEnv): boolean {
  if (String(env.APP_BFF_ENABLED) !== "true") return true;
  const tenantId = configuredTenantId(env);
  const origin = appPublicOrigin(env);
  // Email delivery is required in production. In explicit localhost-only mode the
  // dev_outbox capture (migration 0022) substitutes for Gmail so the full product runs
  // against throwaway local state with no external side effects.
  const emailReady = gmailConfigured(env) || String(env.APP_ALLOW_INSECURE_LOCAL) === "true";
  return !!tenantId && !!publicTenant(env) && !!origin &&
    nonEmpty(env.APP_AUTH_PEPPER) && env.APP_AUTH_PEPPER.trim().length >= 32 &&
    frappeReadConfigured(env) &&
    emailReady;
}

export function publicTenant(env: AppEnv): AppTenantPublic | null {
  const id = configuredTenantId(env);
  const name = cleanText(env.APP_TENANT_NAME, 1, 120);
  const brand = cleanText(env.APP_TENANT_BRAND, 1, 80);
  const locale = env.APP_LOCALE?.trim() ?? "";
  const timeZone = env.APP_TIME_ZONE?.trim() ?? "";
  const currency = env.APP_CURRENCY?.trim() ?? "";
  if (!id || !name || !brand || !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(locale) ||
      !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+$/.test(timeZone) || !/^[A-Z]{3}$/.test(currency)) {
    return null;
  }
  return { id, name, brand, locale, time_zone: timeZone, currency };
}

export function configuredTenantId(env: AppEnv): string | null {
  const value = env.APP_TENANT_ID?.trim() ?? "";
  return /^[a-z0-9][a-z0-9-]{1,63}$/.test(value) ? value : null;
}

export function allowedOrigins(env: AppEnv): Set<string> {
  const allowInsecureLocal = String(env.APP_ALLOW_INSECURE_LOCAL) === "true";
  const result = new Set<string>();
  for (const raw of (env.APP_ALLOWED_ORIGINS ?? "").split(",")) {
    const normalized = normalizeConfiguredOrigin(raw, allowInsecureLocal);
    if (normalized) result.add(normalized);
  }
  return result;
}

/**
 * The one canonical public origin for links sent by IronWrap OS. Keeping this separate from
 * request-origin validation lets capability-link issuers fail closed when an operator has not
 * deliberately configured both the public origin and its allowlist entry.
 */
export function appPublicOrigin(env: AppEnv): string | null {
  const origin = normalizeConfiguredOrigin(
    env.APP_PUBLIC_ORIGIN,
    String(env.APP_ALLOW_INSECURE_LOCAL) === "true",
  );
  return origin && allowedOrigins(env).has(origin) ? origin : null;
}

export function validateAppOrigin(
  req: Request,
  env: AppEnv,
  requireOrigin: boolean,
): { ok: true; origin: string | null } | { ok: false } {
  const supplied = req.headers.get("origin");
  if (!supplied) return requireOrigin ? { ok: false } : { ok: true, origin: null };
  const normalized = normalizeConfiguredOrigin(supplied, String(env.APP_ALLOW_INSECURE_LOCAL) === "true");
  return normalized && allowedOrigins(env).has(normalized)
    ? { ok: true, origin: normalized }
    : { ok: false };
}

export function parseProvisionAppUser(
  value: unknown,
  env: AppEnv,
): {
  ok: true;
  value: Omit<ProvisionAppUserInput, "provisioned_by">;
} | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "invalid_body" };
  const allowed = new Set([
    "tenant_id", "email", "display_name", "role", "frappe_user_id", "active",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return { ok: false, error: "unexpected_field" };

  const configuredTenant = configuredTenantId(env);
  const tenantId = cleanText(value.tenant_id, 2, 64);
  const email = normalizeEmail(value.email);
  const displayName = cleanText(value.display_name, 1, 120);
  const role = value.role;
  const active = value.active;
  const frappeUserId = value.frappe_user_id === null || value.frappe_user_id === undefined
    ? null
    : cleanText(value.frappe_user_id, 3, 140);

  if (!configuredTenant || tenantId !== configuredTenant) return { ok: false, error: "invalid_tenant" };
  if (!email) return { ok: false, error: "invalid_email" };
  if (!displayName) return { ok: false, error: "invalid_display_name" };
  if (!authStore.isAppRole(role)) return { ok: false, error: "invalid_role" };
  if (typeof active !== "boolean") return { ok: false, error: "invalid_active" };
  if (value.frappe_user_id !== null && value.frappe_user_id !== undefined && !frappeUserId) {
    return { ok: false, error: "invalid_frappe_user_id" };
  }
  if (role === "field" && !frappeUserId) return { ok: false, error: "field_requires_frappe_user_id" };

  return {
    ok: true,
    value: {
      tenant_id: tenantId,
      email_normalized: email,
      display_name: displayName,
      role,
      frappe_user_id: frappeUserId,
      active,
    },
  };
}

export function parseFirstOwnerBootstrap(
  value: unknown,
  env: AppEnv,
): {
  ok: true;
  value: {
    tenant_id: string;
    email_normalized: string;
    display_name: string;
  };
} | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "invalid_body" };
  const allowed = new Set(["tenant_id", "email", "display_name"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return { ok: false, error: "unexpected_field" };

  const configuredTenant = configuredTenantId(env);
  const tenantId = cleanText(value.tenant_id, 2, 64);
  const email = normalizeEmail(value.email);
  const displayName = cleanText(value.display_name, 1, 120);

  if (!configuredTenant || tenantId !== configuredTenant) return { ok: false, error: "invalid_tenant" };
  if (!email) return { ok: false, error: "invalid_email" };
  if (!displayName) return { ok: false, error: "invalid_display_name" };

  return {
    ok: true,
    value: {
      tenant_id: tenantId,
      email_normalized: email,
      display_name: displayName,
    },
  };
}

export async function provisionAppUser(
  env: AppEnv,
  input: ProvisionAppUserInput,
  req: Request,
): Promise<AppUserRecord> {
  const request = await authRequestContext(req, env);
  const user = await authStore.upsertAppUser(env, input);
  await authStore.recordAuthAudit(env, {
    tenantId: user.tenant_id,
    userId: user.user_id,
    event: "user_provision",
    outcome: input.active ? "active" : "inactive",
    request,
    detailCode: `${input.role}:${input.provisioned_by}`,
  });
  return user;
}

export async function bootstrapFirstOwner(
  env: AppEnv,
  input: {
    tenant_id: string;
    email_normalized: string;
    display_name: string;
  },
  req: Request,
): Promise<AppUserRecord | null> {
  const request = await authRequestContext(req, env);
  const user = await authStore.bootstrapFirstOwnerAppUser(env, {
    ...input,
    provisioned_by: "system:first_owner_bootstrap",
  });
  await authStore.recordAuthAudit(env, {
    tenantId: input.tenant_id,
    userId: user?.user_id ?? null,
    event: "user_bootstrap",
    outcome: user ? "created" : "denied",
    request,
    detailCode: user ? "owner:first_owner_bootstrap" : "first_owner_bootstrap_completed",
  });
  return user;
}

export async function requestMagicLink(
  req: Request,
  env: AppEnv,
  ctx: Pick<ExecutionContext, "waitUntil">,
  deps: AuthDependencies = {},
): Promise<Response> {
  const body = await readJsonObject(req);
  if (!body.ok) return authJson({ error: body.error }, body.status);
  if (Object.keys(body.value).some((key) => key !== "tenant_id" && key !== "email")) {
    return authJson({ error: "unexpected_field" }, 400);
  }

  const configuredTenant = configuredTenantId(env);
  const tenantWasSupplied = body.value.tenant_id !== undefined;
  const requestedTenant = tenantWasSupplied ? cleanText(body.value.tenant_id, 2, 64) : configuredTenant;
  const tenantMatches = !!configuredTenant && requestedTenant === configuredTenant;
  const email = normalizeEmail(body.value.email);
  if (!email) return authJson({ error: "invalid_request" }, 400);

  const request = await authRequestContext(req, env);
  const now = (deps.now ?? (() => new Date()))();
  const windowExpires = new Date(now.getTime() + AUTH_THROTTLE_WINDOW_SECONDS * 1000).toISOString();
  const [emailAllowed, ipAllowed] = await Promise.all([
    authStore.claimThrottle(env, {
      keyHash: await hmacHex(env, `throttle:request_email:${configuredTenant ?? "unconfigured"}:${email}`),
      scope: "request_email",
      now: now.toISOString(),
      windowExpiresAt: windowExpires,
      limit: MAGIC_LINK_REQUEST_EMAIL_LIMIT,
    }),
    authStore.claimThrottle(env, {
      keyHash: await hmacHex(env, `throttle:request_ip:${request.ip_hash}`),
      scope: "request_ip",
      now: now.toISOString(),
      windowExpiresAt: windowExpires,
      limit: MAGIC_LINK_REQUEST_IP_LIMIT,
    }),
  ]);

  const candidate = tenantMatches && emailAllowed && ipAllowed
    ? await authStore.findActiveUser(env, configuredTenant!, email)
    : null;
  // Field crew never receive a passwordless email session. Their session must be
  // created from an office-issued, single-use QR pairing and a device proof.
  const user = candidate?.role === "field" ? null : candidate;

  if (user) {
    const rawToken = randomToken();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + MAGIC_LINK_TTL_SECONDS * 1000).toISOString();
    await authStore.replaceMagicLink(env, {
      tokenHash: await sha256Hex(rawToken),
      user,
      createdAt,
      expiresAt,
      request,
    });
    await authStore.recordAuthAudit(env, {
      tenantId: user.tenant_id,
      userId: user.user_id,
      event: "magic_link_request",
      outcome: "accepted",
      request,
    });

    const sender = deps.sendMagicLink ?? sendMagicLinkEmail;
    const delivery = sender(env, user, rawToken).then(
      () => authStore.recordAuthAudit(env, {
        tenantId: user.tenant_id,
        userId: user.user_id,
        event: "magic_link_delivery",
        outcome: "sent",
        request,
      }),
      () => authStore.recordAuthAudit(env, {
        tenantId: user.tenant_id,
        userId: user.user_id,
        event: "magic_link_delivery",
        outcome: "failed",
        request,
        detailCode: "delivery_failed",
      }),
    ).then(() => undefined);
    ctx.waitUntil(delivery);
  } else {
    await authStore.recordAuthAudit(env, {
      tenantId: tenantMatches ? configuredTenant : null,
      userId: null,
      event: "magic_link_request",
      outcome: emailAllowed && ipAllowed ? "accepted_unknown" : "throttled",
      request,
      ...(candidate?.role === "field" ? { detailCode: "field_pairing_required" } : {}),
    });
  }

  // Deliberately identical for active, inactive, unknown, and throttled identities.
  return authJson(GENERIC_LINK_RESPONSE, 202);
}

export async function consumeMagicLink(
  req: Request,
  env: AppEnv,
  deps: Pick<AuthDependencies, "now"> = {},
): Promise<Response> {
  const body = await readJsonObject(req);
  if (!body.ok) return authJson({ error: body.error }, body.status);
  if (Object.keys(body.value).some((key) => key !== "token")) {
    return authJson({ error: "unexpected_field" }, 400);
  }
  const rawToken = typeof body.value.token === "string" && /^[A-Za-z0-9_-]{43}$/.test(body.value.token)
    ? body.value.token
    : null;
  if (!rawToken) return authJson({ error: "invalid_or_expired_link" }, 401);

  const request = await authRequestContext(req, env);
  const now = (deps.now ?? (() => new Date()))();
  const windowExpires = new Date(now.getTime() + AUTH_THROTTLE_WINDOW_SECONDS * 1000).toISOString();
  const allowed = await authStore.claimThrottle(env, {
    keyHash: await hmacHex(env, `throttle:consume_ip:${request.ip_hash}`),
    scope: "consume_ip",
    now: now.toISOString(),
    windowExpiresAt: windowExpires,
    limit: MAGIC_LINK_CONSUME_IP_LIMIT,
  });
  if (!allowed) return authJson({ error: "invalid_or_expired_link" }, 401);

  const user = await authStore.consumeMagicLink(env, await sha256Hex(rawToken), now.toISOString());
  const tenantId = configuredTenantId(env);
  if (!user || !tenantId || user.tenant_id !== tenantId || user.role === "field") {
    await authStore.recordAuthAudit(env, {
      tenantId: null,
      userId: null,
      event: "magic_link_consume",
      outcome: "rejected",
      request,
      detailCode: user?.role === "field" ? "field_pairing_required" : "invalid_or_expired",
    });
    return authJson({ error: "invalid_or_expired_link" }, 401);
  }

  const rawSessionToken = randomToken();
  const sessionHash = await sessionHashFor(env, rawSessionToken);
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString();
  await authStore.insertSession(env, {
    sessionHash,
    user,
    createdAt: now.toISOString(),
    expiresAt,
    request,
  });
  await authStore.recordAuthAudit(env, {
    tenantId,
    userId: user.user_id,
    event: "magic_link_consume",
    outcome: "session_created",
    request,
  });

  const response = authJson(sessionEnvelopeForUser(
    env,
    user,
    expiresAt,
    await csrfTokenFor(env, rawSessionToken),
  ));
  response.headers.set("set-cookie", sessionCookie(rawSessionToken, expiresAt));
  return response;
}

export async function issueDevicePairing(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  fieldUserId: string,
  deps: DevicePairingDependencies = {},
): Promise<
  | { ok: true; pairing_url: string; expires_at: string; field_user: ReturnType<typeof publicUser> }
  | { ok: false; error: string; status: number }
> {
  if (auth.session.role !== "owner" && auth.session.role !== "ops") {
    return { ok: false, error: "office_role_required", status: 403 };
  }
  if (!validAppCsrf(req, auth)) return { ok: false, error: "csrf_failed", status: 403 };
  if (!/^appu_[0-9a-f-]{36}$/i.test(fieldUserId)) {
    return { ok: false, error: "invalid_field_user", status: 400 };
  }
  const tenantId = configuredTenantId(env);
  const origin = appPublicOrigin(env);
  if (!tenantId || !origin) {
    return { ok: false, error: "app_bff_not_configured", status: 503 };
  }
  const fieldUser = await authStore.findActiveUserById(env, tenantId, fieldUserId);
  if (!fieldUser || fieldUser.role !== "field") {
    return { ok: false, error: "field_user_not_found", status: 404 };
  }
  const now = (deps.now ?? (() => new Date()))();
  const rawToken = randomToken();
  const expiresAt = new Date(now.getTime() + DEVICE_PAIRING_TTL_SECONDS * 1000).toISOString();
  const request = await authRequestContext(req, env);
  await authStore.replaceDevicePairing(env, {
    tokenHash: await sha256Hex(rawToken),
    user: fieldUser,
    issuedByUserId: auth.session.user_id,
    createdAt: now.toISOString(),
    expiresAt,
    request,
  });
  await authStore.recordAuthAudit(env, {
    tenantId,
    userId: fieldUser.user_id,
    event: "device_pairing_issue",
    outcome: "issued",
    request,
    detailCode: `issuer:${auth.session.user_id}`,
  });
  // A fragment is deliberately not transmitted to Worker logs or static-asset routing.
  return {
    ok: true,
    pairing_url: `${origin}/auth/pair#token=${encodeURIComponent(rawToken)}`,
    expires_at: expiresAt,
    field_user: publicUser(fieldUser),
  };
}

export async function consumeDevicePairing(
  req: Request,
  env: AppEnv,
  deps: DevicePairingDependencies = {},
): Promise<Response> {
  const body = await readJsonObject(req);
  if (!body.ok) return authJson({ error: body.error }, body.status);
  if (Object.keys(body.value).some((key) => key !== "token" && key !== "device_proof")) {
    return authJson({ error: "unexpected_field" }, 400);
  }
  const rawToken = typeof body.value.token === "string" && /^[A-Za-z0-9_-]{43}$/.test(body.value.token)
    ? body.value.token
    : null;
  const rawDeviceProof = typeof body.value.device_proof === "string" && /^[A-Za-z0-9_-]{43}$/.test(body.value.device_proof)
    ? body.value.device_proof
    : null;
  if (!rawToken || !rawDeviceProof) return authJson({ error: "invalid_or_expired_pairing" }, 401);

  const request = await authRequestContext(req, env);
  const now = (deps.now ?? (() => new Date()))();
  const windowExpires = new Date(now.getTime() + AUTH_THROTTLE_WINDOW_SECONDS * 1000).toISOString();
  const allowed = await authStore.claimThrottle(env, {
    keyHash: await hmacHex(env, `throttle:pairing_consume_ip:${request.ip_hash}`),
    scope: "consume_ip",
    now: now.toISOString(),
    windowExpiresAt: windowExpires,
    limit: MAGIC_LINK_CONSUME_IP_LIMIT,
  });
  if (!allowed) return authJson({ error: "invalid_or_expired_pairing" }, 401);

  const rawSessionToken = randomToken();
  const sessionHash = await sessionHashFor(env, rawSessionToken);
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString();
  const deviceId = `appd_${crypto.randomUUID()}`;
  let pairing;
  try {
    pairing = await authStore.consumeDevicePairing(env, {
      tokenHash: await sha256Hex(rawToken),
      deviceId,
      deviceProofHash: await sha256Hex(rawDeviceProof),
      sessionHash,
      createdAt: now.toISOString(),
      expiresAt,
      request,
    });
  } catch {
    return authJson({ error: "pairing_unavailable" }, 503);
  }
  if (!pairing) {
    await authStore.recordAuthAudit(env, {
      tenantId: null,
      userId: null,
      event: "device_pairing_consume",
      outcome: "rejected",
      request,
      detailCode: "invalid_or_expired",
    });
    return authJson({ error: "invalid_or_expired_pairing" }, 401);
  }
  await authStore.recordAuthAudit(env, {
    tenantId: pairing.user.tenant_id,
    userId: pairing.user.user_id,
    event: "device_pairing_consume",
    outcome: "session_created",
    request,
    detailCode: `device:${pairing.deviceId}`,
  });
  const response = authJson(sessionEnvelopeForUser(
    env,
    pairing.user,
    expiresAt,
    await csrfTokenFor(env, rawSessionToken),
  ));
  response.headers.set("set-cookie", sessionCookie(rawSessionToken, expiresAt));
  return response;
}

export async function listFieldPairingUsers(
  env: AppEnv,
  auth: AuthContext,
): Promise<Array<{ id: string; display_name: string; email: string; frappe_user_id: string | null }>> {
  if (auth.session.role !== "owner" && auth.session.role !== "ops") return [];
  const users = await authStore.listActiveFieldUsers(env, auth.session.tenant_id);
  return users.map((user) => ({
    id: user.user_id,
    display_name: user.display_name,
    email: user.email_normalized,
    frappe_user_id: user.frappe_user_id,
  }));
}

export async function listDevicePairings(
  env: AppEnv,
  auth: AuthContext,
): Promise<Array<{ id: string; field_user_id: string; field_user_name: string; paired_at: string; last_seen_at: string | null; revoked_at: string | null; revoked_by: string | null }>> {
  if (auth.session.role !== "owner" && auth.session.role !== "ops") return [];
  const devices = await authStore.listDeviceBindings(env, auth.session.tenant_id);
  return devices.map((device: AppDeviceRecord) => ({
    id: device.device_id,
    field_user_id: device.user_id,
    field_user_name: device.field_user_name,
    paired_at: device.paired_at,
    last_seen_at: device.last_seen_at,
    revoked_at: device.revoked_at,
    revoked_by: device.revoked_by_user_id,
  }));
}

export async function revokeDevicePairing(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  deviceId: string,
): Promise<{ ok: true; device_id: string; revoked_at: string } | { ok: false; error: string; status: number }> {
  if (auth.session.role !== "owner" && auth.session.role !== "ops") {
    return { ok: false, error: "office_role_required", status: 403 };
  }
  if (!validAppCsrf(req, auth)) return { ok: false, error: "csrf_failed", status: 403 };
  if (!/^appd_[0-9a-f-]{36}$/i.test(deviceId)) {
    return { ok: false, error: "invalid_device", status: 400 };
  }
  const now = new Date().toISOString();
  const revoked = await authStore.revokeDeviceBinding(env, {
    tenantId: auth.session.tenant_id,
    deviceId,
    revokedByUserId: auth.session.user_id,
    now,
  });
  if (!revoked) return { ok: false, error: "device_not_found_or_revoked", status: 404 };
  const request = await authRequestContext(req, env);
  await authStore.recordAuthAudit(env, {
    tenantId: auth.session.tenant_id,
    userId: auth.session.user_id,
    event: "device_revoke",
    outcome: "revoked",
    request,
    detailCode: `device:${deviceId}`,
  });
  return { ok: true, device_id: deviceId, revoked_at: now };
}

export async function authenticateAppRequest(req: Request, env: AppEnv): Promise<AuthContext | null> {
  const rawSessionToken = cookieValue(req.headers.get("cookie"), APP_SESSION_COOKIE);
  const tenantId = configuredTenantId(env);
  if (!rawSessionToken || !tenantId || !/^[A-Za-z0-9_-]{43}$/.test(rawSessionToken)) return null;
  const sessionHash = await sessionHashFor(env, rawSessionToken);
  const now = new Date().toISOString();
  const session = await authStore.findActiveSession(env, sessionHash, tenantId, now);
  if (!session) return null;
  if (session.role === "field") {
    const rawDeviceProof = req.headers.get(APP_DEVICE_PROOF_HEADER);
    if (!rawDeviceProof || !/^[A-Za-z0-9_-]{43}$/.test(rawDeviceProof) || !session.device_proof_hash) {
      return null;
    }
    if (!constantTimeEqual(await sha256Hex(rawDeviceProof), session.device_proof_hash)) return null;
  }
  await authStore.touchSession(env, sessionHash, now);
  return {
    session,
    rawSessionToken,
    csrfToken: await csrfTokenFor(env, rawSessionToken),
    permissions: permissionsForRole(session.role),
  };
}

export function sessionPayload(auth: AuthContext, env: AppEnv): Record<string, unknown> {
  return sessionEnvelopeForUser(
    env,
    auth.session,
    auth.session.session_expires_at,
    auth.csrfToken,
    auth.session.updated_at,
  );
}

export function unauthenticatedSessionPayload(env: AppEnv): Record<string, unknown> {
  return {
    version: 1,
    authenticated: false,
    user: null,
    tenant: publicTenant(env),
    permissions: [],
    allowed_actions: ["auth.magic_link.request", "auth.magic_link.consume", "auth.device_pairing.consume"],
    csrf_token: null,
    session_expires_at: null,
    source_updated_at: null,
    read_model_generated_at: new Date().toISOString(),
    stale_fields: [],
  };
}

export async function logoutAppSession(req: Request, env: AppEnv, auth: AuthContext): Promise<Response> {
  const suppliedCsrf = req.headers.get("x-csrf-token") ?? "";
  if (!constantTimeEqual(suppliedCsrf, auth.csrfToken)) return authJson({ error: "csrf_failed" }, 403);
  const sessionHash = await sessionHashFor(env, auth.rawSessionToken);
  const now = new Date().toISOString();
  await authStore.revokeSession(env, sessionHash, now);
  const request = await authRequestContext(req, env);
  await authStore.recordAuthAudit(env, {
    tenantId: auth.session.tenant_id,
    userId: auth.session.user_id,
    event: "session_logout",
    outcome: "revoked",
    request,
  });
  const response = authJson({ ok: true });
  response.headers.set("set-cookie", expiredSessionCookie());
  return response;
}

export function validAppCsrf(req: Request, auth: AuthContext): boolean {
  return constantTimeEqual(req.headers.get("x-csrf-token") ?? "", auth.csrfToken);
}

export function expiredSessionCookie(): string {
  return `${APP_SESSION_COOKIE}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; Secure; HttpOnly; SameSite=Strict; Priority=High`;
}

export async function authRequestContext(req: Request, env: AppEnv): Promise<AuthRequestContext> {
  const ip = (req.headers.get("cf-connecting-ip") ?? "unknown").trim().slice(0, 64);
  const userAgent = (req.headers.get("user-agent") ?? "unknown").trim().slice(0, 512);
  return {
    ip_hash: await hmacHex(env, `ip:${ip}`),
    user_agent_hash: await hmacHex(env, `ua:${userAgent}`),
  };
}

export async function sessionHashFor(env: AppEnv, rawSessionToken: string): Promise<string> {
  return await hmacHex(env, `session:${rawSessionToken}`);
}

export async function csrfTokenFor(env: AppEnv, rawSessionToken: string): Promise<string> {
  return await hmacBase64Url(env, `csrf:${rawSessionToken}`);
}

export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return hex(new Uint8Array(digest));
}

function sessionCookie(rawToken: string, expiresAt: string): string {
  return `${APP_SESSION_COOKIE}=${rawToken}; Max-Age=${SESSION_TTL_SECONDS}; Expires=${new Date(expiresAt).toUTCString()}; Path=/; Secure; HttpOnly; SameSite=Strict; Priority=High`;
}

/**
 * Local-only development capture (APP_ALLOW_INSECURE_LOCAL="true"; always false in
 * production). Records a sign-in or contract-acceptance href in dev_outbox so local
 * end-to-end runs can complete the real consume flow without intercepting email.
 * Returns false when the flag is off, which is what makes Gmail the only deployed path.
 */
export async function devOutboxCapture(
  env: AppEnv,
  kind: "magic_link" | "contract_acceptance",
  recipient: string,
  href: string,
): Promise<boolean> {
  if (String(env.APP_ALLOW_INSECURE_LOCAL) !== "true") return false;
  await env.DB.prepare(
    "INSERT INTO dev_outbox (capture_id, kind, recipient, href, created_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(`devcap_${crypto.randomUUID()}`, kind, recipient, href, new Date().toISOString()).run();
  return true;
}

async function sendMagicLinkEmail(env: AppEnv, user: AppUserRecord, rawToken: string): Promise<void> {
  const message = buildMagicLinkEmail(env, user, rawToken);
  const captured = await devOutboxCapture(env, "magic_link", user.email_normalized, message.href);
  if (!gmailConfigured(env)) {
    if (captured) return;
    throw new Error("magic_link_email_not_configured");
  }
  await sendGmail(env, user.email_normalized, message.subject, message.html);
}

export function buildMagicLinkEmail(
  env: AppEnv,
  user: Pick<AppUserRecord, "display_name">,
  rawToken: string,
): { subject: string; html: string; href: string } {
  const origin = appPublicOrigin(env);
  if (!origin) throw new Error("magic_link_origin_not_configured");
  // The token is in a fragment so it is not sent in an HTTP request or server access log. The
  // PWA scrubs the fragment and POSTs it to /api/v1/auth/magic-link/consume.
  const href = `${origin}/auth/verify#token=${encodeURIComponent(rawToken)}`;
  return {
    subject: "Your IronWrap OS sign-in link",
    html: `<p>Hello ${escapeHtml(user.display_name)},</p>` +
      `<p><a href="${escapeHtml(href)}">Sign in to IronWrap OS</a></p>` +
      `<p>This one-time link expires in 15 minutes. If you did not request it, ignore this email.</p>`,
    href,
  };
}

async function hmacHex(env: AppEnv, value: string): Promise<string> {
  return hex(await hmac(env, value));
}

async function hmacBase64Url(env: AppEnv, value: string): Promise<string> {
  return base64Url(await hmac(env, value));
}

async function hmac(env: AppEnv, value: string): Promise<Uint8Array> {
  if (!nonEmpty(env.APP_AUTH_PEPPER) || env.APP_AUTH_PEPPER!.length < 32) {
    throw new Error("app_auth_not_configured");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.APP_AUTH_PEPPER),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

function normalizeConfiguredOrigin(value: string | undefined, allowInsecureLocal: boolean): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(allowInsecureLocal && local && url.protocol === "http:")) return null;
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function publicUser(user: AppUserRecord): Record<string, unknown> {
  return {
    id: user.user_id,
    email: user.email_normalized,
    display_name: user.display_name,
    role: user.role,
    frappe_user_id: user.frappe_user_id,
  };
}

function sessionEnvelopeForUser(
  env: AppEnv,
  user: AppUserRecord,
  expiresAt: string,
  csrfToken: string,
  sourceUpdatedAt: string | null = null,
): Record<string, unknown> {
  const permissions = permissionsForRole(user.role);
  return {
    version: 1,
    authenticated: true,
    user: publicUser(user),
    tenant: publicTenant(env),
    permissions,
    allowed_actions: sessionAllowedActions(user.role),
    csrf_token: csrfToken,
    session_expires_at: expiresAt,
    source_updated_at: sourceUpdatedAt,
    read_model_generated_at: new Date().toISOString(),
    stale_fields: [],
  };
}

function sessionAllowedActions(role: AppUserRecord["role"]): string[] {
  if (role === "field") {
    return [
      "session.logout",
      "today.read",
      "job.read.assigned",
      "field.checkin.create",
      "field.evidence.create",
      "authority.read",
    ];
  }
  if (role === "sales") {
    return [
      "session.logout",
      "now.read",
      "sales.read",
      "estimator.read",
      "approval.read",
      "approval.prepare",
      "quote_revision_approval.read",
      "quote_revision_approval.prepare",
    ];
  }
  if (role === "production") {
    // `production_gate.clear` is deliberately absent here and lives on the
    // production runway read model instead. This list is role-derived, and the
    // clearance also needs a Frappe identity to attribute the decision to; a
    // session-level advertisement would offer a button the route refuses.
    // `production_schedule_approval.prepare` is absent for the same reason.
    return ["session.logout", "now.read", "production.read", "job.read", "authority.read"];
  }
  if (role === "accounting") {
    return [
      "session.logout",
      "now.read",
      "quickbooks.read",
      "quickbooks.review",
      "quickbooks.reconcile",
    ];
  }
  return [
    "session.logout",
    "today.read",
    "job.read",
    "owner.now.read",
    "authority.read",
    "authority.record",
    "authority.verify",
    "authority.renew",
    "authority.revoke",
    "authority.exception",
  ];
}

function cookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    return part.slice(index + 1).trim() || null;
  }
  return null;
}

function constantTimeEqual(a: string, b: string): boolean {
  const aa = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (aa.length !== bb.length) return false;
  let diff = 0;
  for (let index = 0; index < aa.length; index++) diff |= aa[index] ^ bb[index];
  return diff === 0;
}

async function readJsonObject(
  req: Request,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; error: string; status: number }> {
  if (Number(req.headers.get("content-length") ?? "0") > MAX_AUTH_BODY_BYTES) {
    return { ok: false, error: "payload_too_large", status: 413 };
  }
  const text = await req.text();
  if (text.length > MAX_AUTH_BODY_BYTES) return { ok: false, error: "payload_too_large", status: 413 };
  try {
    const value = JSON.parse(text) as unknown;
    return isRecord(value)
      ? { ok: true, value }
      : { ok: false, error: "invalid_json", status: 400 };
  } catch {
    return { ok: false, error: "invalid_json", status: 400 };
  }
}

function authJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function cleanText(value: unknown, min: number, max: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replace(/\s+/g, " ");
  return cleaned.length >= min && cleaned.length <= max && !/[\u0000-\u001F\u007F]/.test(cleaned)
    ? cleaned
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!));
}
