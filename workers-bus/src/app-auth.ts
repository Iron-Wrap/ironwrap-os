import { gmailConfigured, sendGmail } from "./google.ts";
import { frappeReadConfigured } from "./frappe-read.ts";
import * as authStore from "./app-auth-store.ts";
import {
  APP_SESSION_COOKIE,
  AUTH_THROTTLE_WINDOW_SECONDS,
  MAGIC_LINK_CONSUME_IP_LIMIT,
  MAGIC_LINK_REQUEST_EMAIL_LIMIT,
  MAGIC_LINK_REQUEST_IP_LIMIT,
  MAGIC_LINK_TTL_SECONDS,
  SESSION_TTL_SECONDS,
  type AppEnv,
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

export function appBffConfigured(env: AppEnv): boolean {
  if (String(env.APP_BFF_ENABLED) !== "true") return true;
  const tenantId = configuredTenantId(env);
  const publicOrigin = normalizeConfiguredOrigin(env.APP_PUBLIC_ORIGIN, String(env.APP_ALLOW_INSECURE_LOCAL) === "true");
  const allowed = allowedOrigins(env);
  return !!tenantId && !!publicTenant(env) && !!publicOrigin && allowed.has(publicOrigin) &&
    nonEmpty(env.APP_AUTH_PEPPER) && env.APP_AUTH_PEPPER.trim().length >= 32 &&
    frappeReadConfigured(env) &&
    gmailConfigured(env);
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
): { ok: true; value: ProvisionAppUserInput } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "invalid_body" };
  const allowed = new Set([
    "tenant_id", "email", "display_name", "role", "frappe_user_id", "active", "provisioned_by",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return { ok: false, error: "unexpected_field" };

  const configuredTenant = configuredTenantId(env);
  const tenantId = cleanText(value.tenant_id, 2, 64);
  const email = normalizeEmail(value.email);
  const displayName = cleanText(value.display_name, 1, 120);
  const role = value.role;
  const active = value.active;
  const provisionedBy = cleanText(value.provisioned_by, 3, 128);
  const frappeUserId = value.frappe_user_id === null || value.frappe_user_id === undefined
    ? null
    : cleanText(value.frappe_user_id, 3, 140);

  if (!configuredTenant || tenantId !== configuredTenant) return { ok: false, error: "invalid_tenant" };
  if (!email) return { ok: false, error: "invalid_email" };
  if (!displayName) return { ok: false, error: "invalid_display_name" };
  if (role !== "owner" && role !== "ops" && role !== "field") return { ok: false, error: "invalid_role" };
  if (typeof active !== "boolean") return { ok: false, error: "invalid_active" };
  if (!provisionedBy) return { ok: false, error: "invalid_provisioned_by" };
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
      provisioned_by: provisionedBy,
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

  const user = tenantMatches && emailAllowed && ipAllowed
    ? await authStore.findActiveUser(env, configuredTenant!, email)
    : null;

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
  if (!user || !tenantId || user.tenant_id !== tenantId) {
    await authStore.recordAuthAudit(env, {
      tenantId: null,
      userId: null,
      event: "magic_link_consume",
      outcome: "rejected",
      request,
      detailCode: "invalid_or_expired",
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

export async function authenticateAppRequest(req: Request, env: AppEnv): Promise<AuthContext | null> {
  const rawSessionToken = cookieValue(req.headers.get("cookie"), APP_SESSION_COOKIE);
  const tenantId = configuredTenantId(env);
  if (!rawSessionToken || !tenantId || !/^[A-Za-z0-9_-]{43}$/.test(rawSessionToken)) return null;
  const sessionHash = await sessionHashFor(env, rawSessionToken);
  const now = new Date().toISOString();
  const session = await authStore.findActiveSession(env, sessionHash, tenantId, now);
  if (!session) return null;
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
    allowed_actions: ["auth.magic_link.request", "auth.magic_link.consume"],
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

async function sendMagicLinkEmail(env: AppEnv, user: AppUserRecord, rawToken: string): Promise<void> {
  if (!gmailConfigured(env)) throw new Error("magic_link_email_not_configured");
  const message = buildMagicLinkEmail(env, user, rawToken);
  await sendGmail(env, user.email_normalized, message.subject, message.html);
}

export function buildMagicLinkEmail(
  env: AppEnv,
  user: Pick<AppUserRecord, "display_name">,
  rawToken: string,
): { subject: string; html: string; href: string } {
  const origin = normalizeConfiguredOrigin(env.APP_PUBLIC_ORIGIN, String(env.APP_ALLOW_INSECURE_LOCAL) === "true");
  if (!origin || !allowedOrigins(env).has(origin)) throw new Error("magic_link_origin_not_configured");
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
    allowed_actions: user.role === "field"
      ? ["session.logout", "today.read", "job.read.assigned", "field.checkin.create", "field.evidence.create"]
      : ["session.logout", "today.read", "job.read", "owner.now.read"],
    csrf_token: csrfToken,
    session_expires_at: expiresAt,
    source_updated_at: sourceUpdatedAt,
    read_model_generated_at: new Date().toISOString(),
    stale_fields: [],
  };
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
