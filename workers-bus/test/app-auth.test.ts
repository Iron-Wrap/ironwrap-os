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
  device_id: string | null;
}

interface DevicePairingRow {
  token_hash: string;
  tenant_id: string;
  user_id: string;
  issued_by_user_id: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
  issued_ip_hash: string;
  issued_user_agent_hash: string;
}

interface DeviceRow {
  device_id: string;
  tenant_id: string;
  user_id: string;
  device_proof_hash: string;
  paired_at: string;
  last_seen_at: string;
  revoked_at: string | null;
  revoked_by_user_id: string | null;
  created_ip_hash: string;
  created_user_agent_hash: string;
}

class AuthMemoryDb {
  users = new Map<string, AppUserRecord>();
  magic = new Map<string, MagicRow>();
  sessions = new Map<string, SessionRow>();
  pairings = new Map<string, DevicePairingRow>();
  devices = new Map<string, DeviceRow>();
  throttles = new Map<string, { scope: string; started: string; expires: string; attempts: number }>();
  audits: Array<Record<string, unknown>> = [];

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => ({
        first: async <T>() => this.first(sql, args) as T | null,
        run: async () => this.run(sql, args),
        all: async <T>() => ({ results: this.all(sql, args) as T[] }),
      }),
    };
  }

  async batch(statements: Array<{ run: () => Promise<{ success: true; meta: { changes: number } }> }>) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
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
    if (sql.includes("FROM app_users") && sql.includes("tenant_id = ?") && sql.includes("user_id = ?")) {
      const row = this.users.get(String(args[1]));
      return row && row.tenant_id === String(args[0]) && (!sql.includes("active = 1") || row.active === 1)
        ? { ...row }
        : null;
    }
    if (sql.includes("FROM app_device_pairings p")) {
      const pairing = this.pairings.get(String(args[0]));
      if (!pairing || pairing.consumed_at || pairing.revoked_at || pairing.expires_at <= String(args[1])) return null;
      const user = this.users.get(pairing.user_id);
      return user?.active === 1 && user.tenant_id === pairing.tenant_id && user.role === "field" ? { ...user } : null;
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
      const device = session.device_id ? this.devices.get(session.device_id) : null;
      if (user.role === "field" && (!device || device.revoked_at)) return null;
      return {
        ...user,
        session_hash: session.session_hash,
        session_created_at: session.created_at,
        session_expires_at: session.expires_at,
        revoked_at: session.revoked_at,
        device_id: session.device_id,
        device_proof_hash: device?.device_proof_hash ?? null,
      };
    }
    return null;
  }

  private all(sql: string, args: unknown[]): unknown[] {
    if (sql.includes("FROM app_users") && sql.includes("role = 'field'")) {
      return [...this.users.values()]
        .filter((user) => user.tenant_id === String(args[0]) && user.active === 1 && user.role === "field")
        .sort((a, b) => a.display_name.localeCompare(b.display_name) || a.user_id.localeCompare(b.user_id))
        .map((user) => ({
          user_id: user.user_id,
          display_name: user.display_name,
          email_normalized: user.email_normalized,
          frappe_user_id: user.frappe_user_id,
        }));
    }
    if (sql.includes("FROM app_devices d")) {
      return [...this.devices.values()]
        .filter((device) => device.tenant_id === String(args[0]))
        .map((device) => {
          const user = this.users.get(device.user_id);
          const latest = [...this.sessions.values()]
            .filter((session) => session.device_id === device.device_id)
            .map((session) => session.last_seen_at)
            .sort()
            .at(-1) ?? device.last_seen_at;
          return {
            device_id: device.device_id,
            tenant_id: device.tenant_id,
            user_id: device.user_id,
            field_user_name: user?.display_name ?? "Unknown",
            paired_at: device.paired_at,
            last_seen_at: latest,
            revoked_at: device.revoked_at,
            revoked_by_user_id: device.revoked_by_user_id,
          };
        })
        .sort((a, b) => Number(a.revoked_at !== null) - Number(b.revoked_at !== null) || b.paired_at.localeCompare(a.paired_at));
    }
    return [];
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
    if (sql.includes("UPDATE app_device_pairings") && sql.includes("SET revoked_at") && sql.includes("user_id = ?")) {
      const [now, tenantId, userId] = args;
      let changes = 0;
      for (const pairing of this.pairings.values()) {
        if (pairing.tenant_id === String(tenantId) && pairing.user_id === String(userId) && !pairing.consumed_at && !pairing.revoked_at) {
          pairing.revoked_at = String(now);
          changes++;
        }
      }
      return changed(changes);
    }
    if (sql.includes("INSERT INTO app_device_pairings")) {
      const [tokenHash, tenantId, userId, issuedByUserId, createdAt, expiresAt, ipHash, userAgentHash] = args;
      this.pairings.set(String(tokenHash), {
        token_hash: String(tokenHash),
        tenant_id: String(tenantId),
        user_id: String(userId),
        issued_by_user_id: String(issuedByUserId),
        created_at: String(createdAt),
        expires_at: String(expiresAt),
        consumed_at: null,
        revoked_at: null,
        issued_ip_hash: String(ipHash),
        issued_user_agent_hash: String(userAgentHash),
      });
      return changed(1);
    }
    if (sql.includes("UPDATE app_device_pairings SET consumed_at")) {
      const [now, tokenHash, userId, expiryNow] = args;
      const pairing = this.pairings.get(String(tokenHash));
      if (!pairing || pairing.user_id !== String(userId) || pairing.consumed_at || pairing.revoked_at || pairing.expires_at <= String(expiryNow)) {
        return changed(0);
      }
      pairing.consumed_at = String(now);
      return changed(1);
    }
    if (sql.includes("INSERT INTO app_devices")) {
      const [deviceId, tenantId, userId, proofHash, pairedAt, lastSeenAt, ipHash, userAgentHash] = args;
      if ([...this.devices.values()].some((device) => device.device_proof_hash === String(proofHash))) {
        throw new Error("unique device proof");
      }
      this.devices.set(String(deviceId), {
        device_id: String(deviceId),
        tenant_id: String(tenantId),
        user_id: String(userId),
        device_proof_hash: String(proofHash),
        paired_at: String(pairedAt),
        last_seen_at: String(lastSeenAt),
        revoked_at: null,
        revoked_by_user_id: null,
        created_ip_hash: String(ipHash),
        created_user_agent_hash: String(userAgentHash),
      });
      return changed(1);
    }
    if (sql.includes("DELETE FROM app_devices WHERE device_id = ?")) {
      this.devices.delete(String(args[0]));
      return changed(1);
    }
    if (sql.includes("UPDATE app_devices SET revoked_at") && sql.includes("device_id = ?")) {
      const [now, revokedByUserId, tenantId, deviceId] = args;
      const device = this.devices.get(String(deviceId));
      if (!device || device.tenant_id !== String(tenantId) || device.revoked_at) return changed(0);
      device.revoked_at = String(now);
      device.revoked_by_user_id = String(revokedByUserId);
      return changed(1);
    }
    if (sql.includes("UPDATE app_devices SET revoked_at") && sql.includes("user_id = ?")) {
      const [now, userId] = args;
      let changes = 0;
      for (const device of this.devices.values()) if (device.user_id === String(userId) && !device.revoked_at) {
        device.revoked_at = String(now);
        changes++;
      }
      return changed(changes);
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
      const [sessionHash, userId, tenant, createdAt, expiresAt, lastSeen, ipHash, userAgentHash, deviceId] = args;
      this.sessions.set(String(sessionHash), {
        session_hash: String(sessionHash), user_id: String(userId), tenant_id: String(tenant),
        created_at: String(createdAt), expires_at: String(expiresAt), revoked_at: null,
        last_seen_at: String(lastSeen), created_ip_hash: String(ipHash), created_user_agent_hash: String(userAgentHash),
        device_id: deviceId === null ? null : String(deviceId),
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
    if (sql.includes("UPDATE app_sessions SET revoked_at") && sql.includes("device_id = ?")) {
      const [now, tenantId, deviceId] = args;
      let changes = 0;
      for (const session of this.sessions.values()) if (
        session.tenant_id === String(tenantId) && session.device_id === String(deviceId) && !session.revoked_at
      ) {
        session.revoked_at = String(now);
        changes++;
      }
      return changed(changes);
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

async function addOfficeUser(env: AppEnv, role: "owner" | "ops" = "owner"): Promise<AppUserRecord> {
  return await upsertAppUser(env, {
    tenant_id: "ironwrap",
    email_normalized: "owner@example.com",
    display_name: "Office Owner",
    role,
    frappe_user_id: null,
    active: true,
    provisioned_by: "owner@example.com",
  });
}

async function signInOffice(env: AppEnv): Promise<{
  user: AppUserRecord;
  cookiePair: string;
  csrfToken: string;
}> {
  const user = await addOfficeUser(env);
  let token = "";
  const waiter = waitContext();
  await requestMagicLink(
    jsonRequest("/api/v1/auth/magic-link/request", { tenant_id: "ironwrap", email: user.email_normalized }),
    env,
    waiter.ctx as never,
    { sendMagicLink: async (_env, _user, raw) => { token = raw; } },
  );
  await waiter.flush();
  const consumed = await consumeMagicLink(jsonRequest("/api/v1/auth/magic-link/consume", { token }), env);
  assert.equal(consumed.status, 200);
  const body = await consumed.json() as { csrf_token: string };
  return {
    user,
    cookiePair: (consumed.headers.get("set-cookie") ?? "").split(";")[0],
    csrfToken: body.csrf_token,
  };
}

test("magic-link request is enumeration-resistant and stores only a hash", async () => {
  const db = new AuthMemoryDb();
  const env = baseEnv(db);
  await addOfficeUser(env);
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
    jsonRequest("/api/v1/auth/magic-link/request", { email: "OWNER@example.com" }),
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
  const fieldCtx = waitContext();
  const field = await requestMagicLink(
    jsonRequest("/api/v1/auth/magic-link/request", { tenant_id: "ironwrap", email: "crew@example.com" }),
    env,
    fieldCtx.ctx as never,
    { sendMagicLink: async () => { throw new Error("field users must not receive magic links"); } },
  );
  await fieldCtx.flush();

  assert.equal(active.status, 202);
  assert.equal(unknown.status, 202);
  assert.equal(inactive.status, 202);
  assert.equal(field.status, 202);
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
  assert.equal(JSON.stringify(db.audits).includes("field_pairing_required"), true);
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
  await addOfficeUser(env);
  let token = "";
  const waiter = waitContext();
  await requestMagicLink(
    jsonRequest("/api/v1/auth/magic-link/request", { tenant_id: "ironwrap", email: "owner@example.com" }),
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
  await addOfficeUser(env);
  let token = "";
  const waiter = waitContext();
  await requestMagicLink(
    jsonRequest("/api/v1/auth/magic-link/request", { tenant_id: "ironwrap", email: "owner@example.com" }),
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
  await addOfficeUser(env);
  const tokens: string[] = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    const waiter = waitContext();
    await requestMagicLink(
      jsonRequest("/api/v1/auth/magic-link/request", { tenant_id: "ironwrap", email: "owner@example.com" }),
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
  await addOfficeUser(env);
  let token = "";
  const waiter = waitContext();
  await requestMagicLink(
    jsonRequest("/api/v1/auth/magic-link/request", { tenant_id: "ironwrap", email: "owner@example.com" }),
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
    email: "owner@example.com",
    display_name: "Office Owner",
    role: "owner",
    frappe_user_id: null,
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

test("field bootstrap returns only the unauthenticated session envelope", async () => {
  const env = baseEnv();
  const response = await worker.fetch(new Request(
    "https://worker.example.com/api/v1/field/bootstrap",
    { headers: { origin: "https://app.example.com" } },
  ), env, waitContext().ctx as never);
  const body = await response.json() as {
    version: number;
    session: Record<string, unknown>;
  };

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), "https://app.example.com");
  assert.deepEqual(Object.keys(body).sort(), ["session", "version"]);
  assert.equal(body.version, 1);
  assert.equal(body.session.authenticated, false);
  assert.equal("today" in body, false);
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
  await addOfficeUser(env);
  let token = "";
  const firstWaiter = waitContext();
  await requestMagicLink(
    jsonRequest("/api/v1/auth/magic-link/request", { tenant_id: "ironwrap", email: "owner@example.com" }),
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
    jsonRequest("/api/v1/auth/magic-link/request", { tenant_id: "ironwrap", email: "owner@example.com" }),
    env,
    secondWaiter.ctx as never,
    { sendMagicLink: async () => {} },
  );
  await secondWaiter.flush();
  assert.equal([...db.magic.values()][0].consumed_at, null);

  const deactivated = await worker.fetch(jsonRequest("/admin/app-users", {
    tenant_id: "ironwrap",
    email: "owner@example.com",
    display_name: "Office Owner",
    role: "owner",
    frappe_user_id: null,
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
  await addOfficeUser(env);
  let sends = 0;
  let canonicalResponse = "";
  for (let index = 0; index < 6; index++) {
    const waiter = waitContext();
    const response = await requestMagicLink(
      jsonRequest("/api/v1/auth/magic-link/request", { tenant_id: "ironwrap", email: "owner@example.com" }),
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

test("office-issued QR pairing is fragment-only, proof-bound, and revocable", async () => {
  const db = new AuthMemoryDb();
  const env = baseEnv(db);
  const fieldUser = await addFieldUser(env);
  const office = await signInOffice(env);
  const ctx = waitContext();

  const missingCsrf = await worker.fetch(jsonRequest("/api/v1/device-pairings", {
    field_user_id: fieldUser.user_id,
  }, { cookie: office.cookiePair }), env, ctx.ctx as never);
  assert.equal(missingCsrf.status, 403);

  const wrongRole = await worker.fetch(jsonRequest("/api/v1/device-pairings", {
    field_user_id: office.user.user_id,
  }, { cookie: office.cookiePair, "x-csrf-token": office.csrfToken }), env, ctx.ctx as never);
  assert.equal(wrongRole.status, 404);

  const issuedResponse = await worker.fetch(jsonRequest("/api/v1/device-pairings", {
    field_user_id: fieldUser.user_id,
  }, { cookie: office.cookiePair, "x-csrf-token": office.csrfToken }), env, ctx.ctx as never);
  assert.equal(issuedResponse.status, 200);
  const issued = await issuedResponse.json() as {
    pairing_url: string;
    expires_at: string;
    field_user: { id: string; role: string };
  };
  const pairingUrl = new URL(issued.pairing_url);
  const rawPairingToken = pairingUrl.hash.slice("#token=".length);
  assert.equal(pairingUrl.pathname, "/auth/pair");
  assert.equal(pairingUrl.search, "");
  assert.match(rawPairingToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.field_user.id, fieldUser.user_id);
  assert.equal(issued.field_user.role, "field");
  assert.equal(Date.parse(issued.expires_at) > Date.now(), true);
  assert.equal(db.pairings.size, 1);
  assert.equal(JSON.stringify({ pairings: [...db.pairings.values()], audits: db.audits }).includes(rawPairingToken), false);

  const scanner = await worker.fetch(new Request(
    `https://worker.example.com/api/v1/auth/device-pairing/consume?token=${rawPairingToken}`,
    { headers: { origin: "https://app.example.com" } },
  ), env, ctx.ctx as never);
  assert.equal(scanner.status, 401);
  assert.equal([...db.pairings.values()][0].consumed_at, null);

  const deviceProof = "p".repeat(43);
  const paired = await worker.fetch(jsonRequest("/api/v1/auth/device-pairing/consume", {
    token: rawPairingToken,
    device_proof: deviceProof,
  }), env, ctx.ctx as never);
  assert.equal(paired.status, 200);
  assert.match(paired.headers.get("access-control-allow-headers") ?? "", /X-IronWrap-Device-Proof/);
  const fieldCookie = (paired.headers.get("set-cookie") ?? "").split(";")[0];
  assert.equal(db.devices.size, 1);
  assert.equal([...db.sessions.values()].filter((session) => session.device_id !== null).length, 1);
  assert.equal(JSON.stringify({ devices: [...db.devices.values()], audits: db.audits }).includes(deviceProof), false);

  const withoutProof = await worker.fetch(new Request("https://worker.example.com/api/v1/session", {
    headers: { cookie: fieldCookie, origin: "https://app.example.com" },
  }), env, ctx.ctx as never);
  assert.equal((await withoutProof.json() as { authenticated: boolean }).authenticated, false);

  const bootstrapWithoutProof = await worker.fetch(new Request("https://worker.example.com/api/v1/field/bootstrap", {
    headers: { cookie: fieldCookie, origin: "https://app.example.com" },
  }), env, ctx.ctx as never);
  const bootstrapWithoutProofBody = await bootstrapWithoutProof.json() as {
    version: number;
    session: { authenticated: boolean };
  };
  assert.equal(bootstrapWithoutProof.status, 200);
  assert.deepEqual(Object.keys(bootstrapWithoutProofBody).sort(), ["session", "version"]);
  assert.equal(bootstrapWithoutProofBody.version, 1);
  assert.equal(bootstrapWithoutProofBody.session.authenticated, false);

  const wrongProof = await worker.fetch(new Request("https://worker.example.com/api/v1/session", {
    headers: {
      cookie: fieldCookie,
      origin: "https://app.example.com",
      "x-ironwrap-device-proof": "q".repeat(43),
    },
  }), env, ctx.ctx as never);
  assert.equal((await wrongProof.json() as { authenticated: boolean }).authenticated, false);

  const fieldSession = await worker.fetch(new Request("https://worker.example.com/api/v1/session", {
    headers: {
      cookie: fieldCookie,
      origin: "https://app.example.com",
      "x-ironwrap-device-proof": deviceProof,
    },
  }), env, ctx.ctx as never);
  assert.equal((await fieldSession.json() as { authenticated: boolean; user: { role: string } }).authenticated, true);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ data: [] });
  try {
    const fieldBootstrap = await worker.fetch(new Request("https://worker.example.com/api/v1/field/bootstrap", {
      headers: {
        cookie: fieldCookie,
        origin: "https://app.example.com",
        "x-ironwrap-device-proof": deviceProof,
      },
    }), env, ctx.ctx as never);
    const bootstrap = await fieldBootstrap.json() as {
      version: number;
      session: { authenticated: boolean; user: { role: string } };
      today: { jobs: unknown[] };
    };
    assert.equal(fieldBootstrap.status, 200);
    assert.equal(fieldBootstrap.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(Object.keys(bootstrap).sort(), ["session", "today", "version"]);
    assert.equal(bootstrap.version, 1);
    assert.equal(bootstrap.session.authenticated, true);
    assert.equal(bootstrap.session.user.role, "field");
    assert.deepEqual(bootstrap.today.jobs, []);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const fieldDeviceList = await worker.fetch(new Request("https://worker.example.com/api/v1/device-pairings", {
    headers: {
      cookie: fieldCookie,
      origin: "https://app.example.com",
      "x-ironwrap-device-proof": deviceProof,
    },
  }), env, ctx.ctx as never);
  assert.equal(fieldDeviceList.status, 403);

  const officeDeviceList = await worker.fetch(new Request("https://worker.example.com/api/v1/device-pairings", {
    headers: { cookie: office.cookiePair, origin: "https://app.example.com" },
  }), env, ctx.ctx as never);
  assert.equal(officeDeviceList.status, 200);
  const listed = await officeDeviceList.json() as { devices: Array<Record<string, unknown>> };
  assert.equal(listed.devices.length, 1);
  assert.equal(listed.devices[0].field_user_id, fieldUser.user_id);
  assert.equal("device_proof_hash" in listed.devices[0], false);

  const replay = await worker.fetch(jsonRequest("/api/v1/auth/device-pairing/consume", {
    token: rawPairingToken,
    device_proof: deviceProof,
  }), env, ctx.ctx as never);
  assert.equal(replay.status, 401);

  const deviceId = String(listed.devices[0].id);
  const revokeMissingCsrf = await worker.fetch(jsonRequest(`/api/v1/device-pairings/${deviceId}/revoke`, {}, {
    cookie: office.cookiePair,
  }), env, ctx.ctx as never);
  assert.equal(revokeMissingCsrf.status, 403);

  const revoked = await worker.fetch(jsonRequest(`/api/v1/device-pairings/${deviceId}/revoke`, {}, {
    cookie: office.cookiePair,
    "x-csrf-token": office.csrfToken,
  }), env, ctx.ctx as never);
  assert.equal(revoked.status, 200);
  assert.equal((await revoked.json() as { ok: boolean; device_id: string }).device_id, deviceId);

  const afterRevoke = await worker.fetch(new Request("https://worker.example.com/api/v1/session", {
    headers: {
      cookie: fieldCookie,
      origin: "https://app.example.com",
      "x-ironwrap-device-proof": deviceProof,
    },
  }), env, ctx.ctx as never);
  assert.equal((await afterRevoke.json() as { authenticated: boolean }).authenticated, false);
});
