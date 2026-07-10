import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import {
  buildMagicLinkEmail,
  consumeMagicLink,
  requestMagicLink,
  sessionHashFor,
} from "../src/app-auth.ts";
import { upsertAppUser } from "../src/app-auth-store.ts";
import type { AppEnv, AppRole, AppUserRecord } from "../src/app-types.ts";

interface MagicRow {
  token_hash: string;
  user_id: string;
  tenant_id: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  request_ip_hash: string;
  request_user_agent_hash: string;
}

interface SessionRow {
  session_hash: string;
  user_id: string;
  tenant_id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_seen_at: string;
  created_ip_hash: string;
  created_user_agent_hash: string;
}

class AuthMemoryDb {
  users = new Map<string, AppUserRecord>();
  magic = new Map<string, MagicRow>();
  sessions = new Map<string, SessionRow>();
  throttles = new Map<string, { scope: string; started: string; expires: string; attempts: number }>();
  audits: Array<Record<string, unknown>> = [];

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => ({
        first: async <T>() => this.first(sql, args) as T | null,
        run: async () => this.run(sql, args),
        all: async <T>() => ({ results: [] as T[] }),
      }),
    };
  }

  private userByTenantEmail(tenant: string, email: string): AppUserRecord | null {
    return [...this.users.values()].find((user) =>
      user.tenant_id === tenant && user.email_normalized === email) ?? null;
  }

  private first(sql: string, args: unknown[]): unknown {
    if (sql.includes("INSERT INTO app_auth_throttles")) {
      const [key, scope, now, expires] = args.map(String);
      const previous = this.throttles.get(key);
      const row = !previous || previous.expires <= now
        ? { scope, started: now, expires, attempts: 1 }
        : { ...previous, attempts: previous.attempts + 1 };
      this.throttles.set(key, row);
      return { attempts: row.attempts };
    }
    if (sql.includes("FROM app_users") && sql.includes("tenant_id = ?") && sql.includes("email_normalized = ?")) {
      const row = this.userByTenantEmail(String(args[0]), String(args[1]));
      return row && (!sql.includes("active = 1") || row.active === 1) ? { ...row } : null;
    }
    if (sql.includes("FROM app_magic_links ml")) {
      const magic = this.magic.get(String(args[0]));
      if (!magic || magic.consumed_at || magic.expires_at <= String(args[1])) return null;
      const user = this.users.get(magic.user_id);
      return user?.active === 1 && user.tenant_id === magic.tenant_id ? { ...user } : null;
    }
    if (sql.includes("FROM app_sessions s")) {
      const session = this.sessions.get(String(args[0]));
      const tenant = String(args[1]);
      const now = String(args[2]);
      if (!session || session.tenant_id !== tenant || session.revoked_at || session.expires_at <= now) return null;
      const user = this.users.get(session.user_id);
      if (!user || user.active !== 1 || user.tenant_id !== tenant) return null;
      return {
        ...user,
        session_hash: session.session_hash,
        session_created_at: session.created_at,
        session_expires_at: session.expires_at,
        revoked_at: session.revoked_at,
      };
    }
    return null;
  }

  private run(sql: string, args: unknown[]): { success: true; meta: { changes: number } } {
    if (sql.includes("INSERT INTO app_users")) {
      const [candidateId, tenant, email, displayName, role, frappeUser, active, createdBy, createdAt, updatedAt] = args;
      const existing = this.userByTenantEmail(String(tenant), String(email));
      const user: AppUserRecord = existing ? {
        ...existing,
        display_name: String(displayName),
        role: String(role) as AppRole,
        frappe_user_id: frappeUser === null ? null : String(frappeUser),
        active: Number(active),
        updated_at: String(updatedAt),
      } : {
        user_id: String(candidateId),
        tenant_id: String(tenant),
        email_normalized: String(email),
        display_name: String(displayName),
        role: String(role) as AppRole,
        frappe_user_id: frappeUser === null ? null : String(frappeUser),
        active: Number(active),
        created_by: String(createdBy),
        created_at: String(createdAt),
        updated_at: String(updatedAt),
      };
      this.users.set(user.user_id, user);
      return changed(1);
    }
    if (sql.includes("INSERT INTO app_magic_links")) {
      const [tokenHash, userId, tenant, createdAt, expiresAt, ipHash, userAgentHash] = args;
      for (const [existingHash, row] of this.magic) {
        if (row.user_id === String(userId)) this.magic.delete(existingHash);
      }
      this.magic.set(String(tokenHash), {
        token_hash: String(tokenHash), user_id: String(userId), tenant_id: String(tenant),
        created_at: String(createdAt), expires_at: String(expiresAt), consumed_at: null,
        request_ip_hash: String(ipHash), request_user_agent_hash: String(userAgentHash),
      });
      return changed(1);
    }
    if (sql.includes("UPDATE app_magic_links SET consumed_at") && sql.includes("token_hash = ?")) {
      const [now, tokenHash, userId, expiryNow] = args;
      const row = this.magic.get(String(tokenHash));
      if (!row || row.user_id !== String(userId) || row.consumed_at || row.expires_at <= String(expiryNow)) return changed(0);
      row.consumed_at = String(now);
      return changed(1);
    }
    if (sql.includes("UPDATE app_magic_links SET consumed_at") && sql.includes("user_id = ?")) {
      const [now, userId] = args;
      let changes = 0;
      for (const row of this.magic.values()) {
        if (row.user_id === String(userId) && !row.consumed_at) {
          row.consumed_at = String(now);
          changes++;
        }
      }
      return changed(changes);
    }
    if (sql.includes("INSERT INTO app_sessions")) {
      const [sessionHash, userId, tenant, createdAt, expiresAt, lastSeen, ipHash, userAgentHash] = args;
      this.sessions.set(String(sessionHash), {
        session_hash: String(sessionHash), user_id: String(userId), tenant_id: String(tenant),
        created_at: String(createdAt), expires_at: String(expiresAt), revoked_at: null,
        last_seen_at: String(lastSeen), created_ip_hash: String(ipHash), created_user_agent_hash: String(userAgentHash),
      });
      return changed(1);
    }
    if (sql.includes("UPDATE app_sessions SET last_seen_at")) {
      const [now, hash, expiryNow] = args;
      const row = this.sessions.get(String(hash));
      if (!row || row.revoked_at || row.expires_at <= String(expiryNow)) return changed(0);
      row.last_seen_at = String(now);
      return changed(1);
    }
    if (sql.includes("UPDATE app_sessions SET revoked_at") && sql.includes("session_hash = ?")) {
      const [now, hash] = args;
      const row = this.sessions.get(String(hash));
      if (!row || row.revoked_at) return changed(0);
      row.revoked_at = String(now);
      return changed(1);
    }
    if (sql.includes("UPDATE app_sessions SET revoked_at") && sql.includes("user_id = ?")) {
      const [now, userId] = args;
      let changes = 0;
      for (const row of this.sessions.values()) if (row.user_id === String(userId) && !row.revoked_at) {
        row.revoked_at = String(now);
        changes++;
      }
      return changed(changes);
    }
    if (sql.includes("INSERT INTO app_auth_audit")) {
      this.audits.push({ args: [...args] });
      return changed(1);
    }
    if (sql.startsWith("DELETE FROM app_")) return changed(0);
    throw new Error(`unhandled fake SQL: ${sql}`);
  }
}

function changed(changes: number) {
  return { success: true as const, meta: { changes } };
}

function baseEnv(db = new AuthMemoryDb()): AppEnv {
  return {
    APP_BFF_ENABLED: "true",
    APP_TENANT_ID: "ironwrap",
    APP_TENANT_NAME: "IronWrap OS",
    APP_TENANT_BRAND: "IronWrap",
    APP_LOCALE: "en-CA",
    APP_TIME_ZONE: "America/Edmonton",
    APP_CURRENCY: "CAD",
    APP_PUBLIC_ORIGIN: "https://app.example.com",
    APP_ALLOWED_ORIGINS: "https://app.example.com",
    APP_ALLOW_INSECURE_LOCAL: "false",
    APP_AUTH_PEPPER: "test-only-pepper-which-is-longer-than-thirty-two-characters",
    ERPNEXT_BASE_URL: "https://frappe.example.com",
    ERPNEXT_API_KEY: "frappe-key",
    ERPNEXT_API_SECRET: "frappe-secret",
    FROM_EMAIL: "sales@example.com",
    GOOGLE_SERVICE_ACCOUNT_JSON: "{}",
    ADMIN_TOKEN: "admin-token",
    DB: db,
  } as never;
}

function jsonRequest(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://worker.example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://app.example.com", ...headers },
    body: JSON.stringify(body),
  });
}

function waitContext() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil(promise: Promise<unknown>) { pending.push(promise); } },
    flush: async () => { await Promise.all(pending); },
  };
}

async function addFieldUser(env: AppEnv): Promise<AppUserRecord> {
  return await upsertAppUser(env, {
    tenant_id: "ironwrap",
    email_normalized: "crew@example.com",
    display_name: "Crew Member",
    role: "field",
    frappe_user_id: "crew@example.com",
    active: true,
    provisioned_by: "owner@example.com",
  });
}

test("magic-link request is enumeration-resistant and stores only a hash", async () => {
  const db = new AuthMemoryDb();
  const env = baseEnv(db);
  await addFieldUser(env);
  await upsertAppUser(env, {
    tenant_id: "ironwrap",
    email_normalized: "inactive@example.com",
    display_name: "Inactive User",
    role: "ops",
    frappe_user_id: null,
    active: false,
    provisioned_by: "owner@example.com",
  });
  const delivered: string[] = [];

  const activeCtx = waitContext();
  const active = await requestMagicLink(
    jsonRequest("/api/v1/auth/magic-link/request", { email: "CREW@example.com" }),
    env,
    activeCtx.ctx as never,
    { sendMagicLink: async (_env, _user, token) => { delivered.push(token); } },
  );
  await activeCtx.flush();
  const unknownCtx = waitContext();
  const unknown = await requestMagicLink(
    jsonRequest("/api/v1/auth/magic-link/request", { tenant_id: "ironwrap", email: "unknown@example.com" }),
    env,
    unknownCtx.ctx as never,
    { sendMagicLink: async () => { throw new Error("should_not_send"); } },
  );
  await unknownCtx.flush();
  const inactiveCtx = waitContext();
  const inactive = await requestMagicLink(
    jsonRequest("/api/v1/auth/magic-link/request", { tenant_id: "ironwrap", email: "inactive@example.com" }),
    env,
    inactiveCtx.ctx as never,
    { sendMagicLink: async () => { throw new Error("should_not_send"); } },
  );
  await inactiveCtx.flush();

  assert.equal(active.status, 202);
  assert.equal(unknown.status, 202);
  assert.equal(inactive.status, 202);
  assert.equal(await active.text(), await unknown.text());
  assert.equal(await inactive.text(), JSON.stringify({
    ok: true,
    message: "If the account is active, a sign-in link will be sent.",
  }));
  assert.equal(delivered.length, 1);
  assert.match(delivered[0], /^[A-Za-z0-9_-]{43}$/);
  assert.equal([...db.magic.keys()].length, 1);
  assert.notEqual([...db.magic.keys()][0], delivered[0]);
  assert.equal(JSON.stringify({ magic: [...db.magic.values()], audits: db.audits }).includes(delivered[0]), false);
});

test("magic-link email targets the canonical verifier and keeps the token out of the query", () => {
  const token = "a".repeat(43);
  const message = buildMagicLinkEmail(baseEnv(), { display_name: "Crew <Member>" }, token);
  const href = new URL(message.href);

  assert.equal(href.pathname, "/auth/verify");
  assert.equal(href.search, "");
  assert.equal(href.hash, `#token=${token}`);
  assert.match(message.html, new RegExp(`href="https://app\\.example\\.com/auth/verify#token=${token}"`));
  assert.doesNotMatch(message.html, /[?&]token=/);
  assert.match(message.html, /Crew &lt;Member&gt;/);
});

test("magic links are one-time and create only a hashed fixed-TTL session", async () => {
  const db = new AuthMemoryDb();
  const env = baseEnv(db);
  await addFieldUser(env);
  let token = "";
  const waiter = waitContext();
  await requestMagicLink(
    jsonRequest("/api/v1/auth/magic-link/request", { tenant_id: "ironwrap", email: "crew@example.com" }),
    env,
    waiter.ctx as never,
    { sendMagicLink: async (_env, _user, raw) => { token = raw; } },
  );
  await waiter.flush();

  const consumed = await consumeMagicLink(
    jsonRequest("/api/v1/auth/magic-link/consume", { token }),
    env,
  );
  const body = await consumed.json() as Record<string, unknown>;
  const cookie = consumed.headers.get("set-cookie") ?? "";
  const rawSession = cookie.match(/__Host-ironwrap_session=([^;]+)/)?.[1] ?? "";
  assert.equal(consumed.status, 200);
  assert.equal(body.authenticated, true);
  assert.match(cookie, /Secure; HttpOnly; SameSite=Strict/);
  assert.doesNotMatch(cookie, /Domain=/i);
  assert.match(rawSession, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(db.sessions.has(rawSession), false);
  assert.equal(db.sessions.has(await sessionHashFor(env, rawSession)), true);
  const session = [...db.sessions.values()][0];
  assert.equal((Date.parse(session.expires_at) - Date.parse(session.created_at)) / 1000, 12 * 60 * 60);

  const replay = await consumeMagicLink(jsonRequest("/api/v1/auth/magic-link/consume", { token }), env);
  assert.equal(replay.status, 401);
  assert.deepEqual(await replay.json(), { error: "invalid_or_expired_link" });
});

test("a scanner GET cannot consume a magic link", async () => {
  const db = new AuthMemoryDb();
  const env = baseEnv(db);
  await addFieldUser(env);
  let token = "";
  const waiter = waitContext();
  await requestMagicLink(
    jsonRequest("/api/v1/auth/magic-link/request", { tenant_id: "ironwrap", email: "crew@example.com" }),
    env,
    waiter.ctx as never,
    { sendMagicLink: async (_env, _user, raw) => { token = raw; } },
  );
  await waiter.flush();

  const scanner = await worker.fetch(new Request(
    `https://worker.example.com/api/v1/auth/magic-link/consume?token=${token}`,
    { headers: { origin: "https://app.example.com" } },
  ), env, waiter.ctx as never);
  assert.equal(scanner.status, 401);
  assert.equal([...db.magic.values()][0].consumed_at, null);

  const consumed = await consumeMagicLink(
    jsonRequest("/api/v1/auth/magic-link/consume", { token }),
    env,
  );
  assert.equal(consumed.status, 200);
});

test("a new magic-link request atomically replaces the prior link for that user", async () => {
  const db = new AuthMemoryDb();
  const env = baseEnv(db);
  await addFieldUser(env);
  const tokens: string[] = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    const waiter = waitContext();
    await requestMagicLink(
      jsonRequest("/api/v1/auth/magic-link/request", { tenant_id: "ironwrap", email: "crew@example.com" }),
      env,
      waiter.ctx as never,
      { sendMagicLink: async (_env, _user, token) => { tokens.push(token); } },
    );
    await waiter.flush();
  }

  assert.equal(db.magic.size, 1);
  assert.equal((await consumeMagicLink(
    jsonRequest("/api/v1/auth/magic-link/consume", { token: tokens[0] }),
    env,
  )).status, 401);
  assert.equal((await consumeMagicLink(
    jsonRequest("/api/v1/auth/magic-link/consume", { token: tokens[1] }),
    env,
  )).status, 200);
});

test("session envelope is exact, unauthenticated session is 200, and logout requires CSRF", async () => {
  const db = new AuthMemoryDb();
  const env = baseEnv(db);
  await addFieldUser(env);
  let token = "";
  const waiter = waitContext();
  await requestMagicLink(
    jsonRequest("/api/v1/auth/magic-link/request", { tenant_id: "ironwrap", email: "crew@example.com" }),
    env,
    waiter.ctx as never,
    { sendMagicLink: async (_env, _user, raw) => { token = raw; } },
  );
  await waiter.flush();
  const consumed = await consumeMagicLink(jsonRequest("/api/v1/auth/magic-link/consume", { token }), env);
  const consumeBody = await consumed.json() as { csrf_token: string };
  const cookiePair = (consumed.headers.get("set-cookie") ?? "").split(";")[0];

  const session = await worker.fetch(new Request("https://worker.example.com/api/v1/session", {
    headers: { cookie: cookiePair, origin: "https://app.example.com" },
  }), env, waiter.ctx as never);
  const body = await session.json() as Record<string, unknown>;
  assert.equal(session.status, 200);
  assert.equal(session.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Object.keys(body).sort(), [
    "allowed_actions", "authenticated", "csrf_token", "permissions", "read_model_generated_at",
    "session_expires_at", "source_updated_at", "stale_fields", "tenant", "user", "version",
  ].sort());
  assert.deepEqual(body.tenant, {
    id: "ironwrap", name: "IronWrap OS", brand: "IronWrap", locale: "en-CA",
    time_zone: "America/Edmonton", currency: "CAD",
  });
  assert.deepEqual(body.user, {
    id: [...db.users.values()][0].user_id,
    email: "crew@example.com",
    display_name: "Crew Member",
    role: "field",
    frappe_user_id: "crew@example.com",
  });

  const badLogout = await worker.fetch(jsonRequest(
    "/api/v1/auth/logout",
    {},
    { cookie: cookiePair, "x-csrf-token": "wrong" },
  ), env, waiter.ctx as never);
  assert.equal(badLogout.status, 403);

  const logout = await worker.fetch(jsonRequest(
    "/api/v1/auth/logout",
    {},
    { cookie: cookiePair, "x-csrf-token": consumeBody.csrf_token },
  ), env, waiter.ctx as never);
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/);

  const after = await worker.fetch(new Request("https://worker.example.com/api/v1/session", {
    headers: { cookie: cookiePair },
  }), env, waiter.ctx as never);
  const afterBody = await after.json() as Record<string, unknown>;
  assert.equal(after.status, 200);
  assert.equal(afterBody.authenticated, false);
  assert.equal(afterBody.user, null);
  assert.equal(afterBody.csrf_token, null);
});

test("auth mutations reject missing/unlisted origins and never emit wildcard CORS", async () => {
  const env = baseEnv();
  const missing = await worker.fetch(new Request("https://worker.example.com/api/v1/auth/magic-link/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenant_id: "ironwrap", email: "crew@example.com" }),
  }), env, waitContext().ctx as never);
  assert.equal(missing.status, 403);

  const evil = await worker.fetch(jsonRequest(
    "/api/v1/auth/magic-link/request",
    { tenant_id: "ironwrap", email: "crew@example.com" },
    { origin: "https://evil.example" },
  ), env, waitContext().ctx as never);
  assert.equal(evil.status, 403);
  assert.notEqual(evil.headers.get("access-control-allow-origin"), "*");
});

test("admin-token provisioning is tenant-bound, strict, and requires a Frappe assignee for field users", async () => {
  const db = new AuthMemoryDb();
  const env = baseEnv(db);
  const payload = {
    tenant_id: "ironwrap",
    email: "crew@example.com",
    display_name: "Crew Member",
    role: "field",
    frappe_user_id: "crew@example.com",
    active: true,
    provisioned_by: "owner@example.com",
  };
  const provisioned = await worker.fetch(jsonRequest("/admin/app-users", payload, {
    authorization: "Bearer admin-token",
  }), env, waitContext().ctx as never);
  assert.equal(provisioned.status, 200);
  const result = await provisioned.json() as { user: { role: string; active: boolean } };
  assert.deepEqual(result.user, { ...result.user, role: "field", active: true });
  assert.equal(db.users.size, 1);

  const noAssignee = await worker.fetch(jsonRequest("/admin/app-users", {
    ...payload,
    email: "other@example.com",
    frappe_user_id: null,
  }, { authorization: "Bearer admin-token" }), env, waitContext().ctx as never);
  assert.equal(noAssignee.status, 400);
  assert.deepEqual(await noAssignee.json(), { error: "field_requires_frappe_user_id" });

  const otherTenant = await worker.fetch(jsonRequest("/admin/app-users", {
    ...payload,
    tenant_id: "another-tenant",
  }, { authorization: "Bearer admin-token" }), env, waitContext().ctx as never);
  assert.equal(otherTenant.status, 400);
  assert.deepEqual(await otherTenant.json(), { error: "invalid_tenant" });

  const unauthorized = await worker.fetch(jsonRequest("/admin/app-users", payload), env, waitContext().ctx as never);
  assert.equal(unauthorized.status, 401);
});

test("admin deactivation revokes existing sessions and consumes open links", async () => {
  const db = new AuthMemoryDb();
  const env = baseEnv(db);
  await addFieldUser(env);
  let token = "";
  const firstWaiter = waitContext();
  await requestMagicLink(
    jsonRequest("/api/v1/auth/magic-link/request", { tenant_id: "ironwrap", email: "crew@example.com" }),
    env,
    firstWaiter.ctx as never,
    { sendMagicLink: async (_env, _user, raw) => { token = raw; } },
  );
  await firstWaiter.flush();
  const consumed = await consumeMagicLink(
    jsonRequest("/api/v1/auth/magic-link/consume", { token }),
    env,
  );
  const cookiePair = (consumed.headers.get("set-cookie") ?? "").split(";")[0];

  const secondWaiter = waitContext();
  await requestMagicLink(
    jsonRequest("/api/v1/auth/magic-link/request", { tenant_id: "ironwrap", email: "crew@example.com" }),
    env,
    secondWaiter.ctx as never,
    { sendMagicLink: async () => {} },
  );
  await secondWaiter.flush();
  assert.equal([...db.magic.values()][0].consumed_at, null);

  const deactivated = await worker.fetch(jsonRequest("/admin/app-users", {
    tenant_id: "ironwrap",
    email: "crew@example.com",
    display_name: "Crew Member",
    role: "field",
    frappe_user_id: "crew@example.com",
    active: false,
    provisioned_by: "owner@example.com",
  }, { authorization: "Bearer admin-token" }), env, secondWaiter.ctx as never);
  assert.equal(deactivated.status, 200);
  assert.equal([...db.sessions.values()][0].revoked_at !== null, true);
  assert.equal([...db.magic.values()][0].consumed_at !== null, true);

  const after = await worker.fetch(new Request("https://worker.example.com/api/v1/session", {
    headers: { cookie: cookiePair },
  }), env, secondWaiter.ctx as never);
  assert.equal(after.status, 200);
  assert.equal((await after.json() as { authenticated: boolean }).authenticated, false);
});

test("per-email request throttling keeps the same 202 response and stops issuing links", async () => {
  const db = new AuthMemoryDb();
  const env = baseEnv(db);
  await addFieldUser(env);
  let sends = 0;
  let canonicalResponse = "";
  for (let index = 0; index < 6; index++) {
    const waiter = waitContext();
    const response = await requestMagicLink(
      jsonRequest("/api/v1/auth/magic-link/request", { tenant_id: "ironwrap", email: "crew@example.com" }),
      env,
      waiter.ctx as never,
      { sendMagicLink: async () => { sends++; } },
    );
    await waiter.flush();
    const text = await response.text();
    canonicalResponse ||= text;
    assert.equal(response.status, 202);
    assert.equal(text, canonicalResponse);
  }
  assert.equal(sends, 5);
});
