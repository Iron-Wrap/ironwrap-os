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
  storageRoles = new Map<string, {
    role: Extract<AppRole, "owner" | "ops" | "field">;
    access_role: AppRole;
  }>();
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
    if (sql.includes("FROM app_users") && sql.includes("= 'field'")) {
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

  private lastChanges = 0;

  private run(sql: string, args: unknown[]): { success: true; meta: { changes: number } } {
    const result = this.runStatement(sql, args);
    if (!sql.includes("INSERT INTO app_auth_audit")) this.lastChanges = result.meta.changes;
    return result;
  }

  private runStatement(sql: string, args: unknown[]): { success: true; meta: { changes: number } } {
    if (
      sql.includes("UPDATE app_users") && sql.includes("display_name = ?") &&
      sql.includes("actor.access_role = ?")
    ) {
      const [
        displayName,
        storageRole,
        accessRole,
        frappeUser,
        active,
        updatedAt,
        tenant,
        email,
        userId,
        expectedRole,
        expectedActive,
        expectedUpdatedAt,
        expectedVersion,
        actorTenant,
        actorUserId,
        actorRole,
      ] = args;
      const user = this.users.get(String(userId));
      const actor = this.users.get(String(actorUserId));
      if (
        !user || user.tenant_id !== String(tenant) ||
        user.email_normalized !== String(email) || user.role !== String(expectedRole) ||
        user.active !== Number(expectedActive) || user.updated_at !== String(expectedUpdatedAt) ||
        (user.access_version ?? 1) !== Number(expectedVersion) ||
        !actor || actor.tenant_id !== String(actorTenant) || actor.active !== 1 ||
        actor.role !== String(actorRole)
      ) return changed(0);
      Object.assign(user, {
        display_name: String(displayName),
        role: String(accessRole) as AppRole,
        frappe_user_id: frappeUser === null ? null : String(frappeUser),
        active: Number(active),
        updated_at: String(updatedAt),
        access_version: (user.access_version ?? 1) + 1,
      });
      this.storageRoles.set(user.user_id, {
        role: String(storageRole) as Extract<AppRole, "owner" | "ops" | "field">,
        access_role: String(accessRole) as AppRole,
      });
      return changed(1);
    }
    if (sql.includes("INSERT INTO app_users")) {
      if (sql.includes("WHERE NOT EXISTS")) {
        const [candidateId, tenant, email, displayName, storageRole, accessRole, frappeUser, active, createdBy, createdAt, updatedAt] = args;
        if ([...this.users.values()].some((user) => user.tenant_id === String(tenant))) {
          return changed(0);
        }
        const user: AppUserRecord = {
          user_id: String(candidateId),
          tenant_id: String(tenant),
          email_normalized: String(email),
          display_name: String(displayName),
          role: String(accessRole) as AppRole,
          frappe_user_id: frappeUser === null ? null : String(frappeUser),
          active: Number(active),
          created_by: String(createdBy),
          created_at: String(createdAt),
          updated_at: String(updatedAt),
        };
        this.users.set(user.user_id, user);
        this.storageRoles.set(user.user_id, {
          role: String(storageRole) as Extract<AppRole, "owner" | "ops" | "field">,
          access_role: String(accessRole) as AppRole,
        });
        return changed(1);
      }
      const [candidateId, tenant, email, displayName, storageRole, accessRole, frappeUser, active, createdBy, createdAt, updatedAt] = args;
      if (sql.includes("actor.access_role = ?")) {
        const actor = this.users.get(String(args[12]));
        if (
          !actor || actor.tenant_id !== String(args[11]) || actor.active !== 1 ||
          actor.role !== String(args[13]) || this.userByTenantEmail(String(tenant), String(email))
        ) return changed(0);
      }
      const existing = this.userByTenantEmail(String(tenant), String(email));
      const user: AppUserRecord = existing ? {
        ...existing,
        display_name: String(displayName),
        role: String(accessRole) as AppRole,
        frappe_user_id: frappeUser === null ? null : String(frappeUser),
        active: Number(active),
        updated_at: String(updatedAt),
      } : {
        user_id: String(candidateId),
        tenant_id: String(tenant),
        email_normalized: String(email),
        display_name: String(displayName),
        role: String(accessRole) as AppRole,
        frappe_user_id: frappeUser === null ? null : String(frappeUser),
        active: Number(active),
        created_by: String(createdBy),
        created_at: String(createdAt),
        updated_at: String(updatedAt),
      };
      this.users.set(user.user_id, user);
      this.storageRoles.set(user.user_id, {
        role: String(storageRole) as Extract<AppRole, "owner" | "ops" | "field">,
        access_role: String(accessRole) as AppRole,
      });
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
      // An access change's audit row is written only after that change wrote a row (0157).
      if (sql.includes("changes() = 1") && this.lastChanges !== 1) return changed(0);
      this.audits.push({ args: [...args] });
      return changed(1);
    }
    if (sql.includes("UPDATE app_user_invites")) return changed(0);
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
    APP_FIRST_OWNER_BOOTSTRAP_ENABLED: "false",
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

async function addOfficeUser(
  env: AppEnv,
  role: Exclude<AppRole, "field"> = "owner",
): Promise<AppUserRecord> {
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

async function signInOffice(
  env: AppEnv,
  role: Exclude<AppRole, "field"> = "owner",
): Promise<{
  user: AppUserRecord;
  cookiePair: string;
  csrfToken: string;
}> {
  const user = await addOfficeUser(env, role);
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

test("sales sessions receive only their bounded desk and preparation capabilities", async () => {
  const db = new AuthMemoryDb();
  const env = baseEnv(db);
  await addOfficeUser(env, "sales");
  let token = "";
  const waiter = waitContext();
  await requestMagicLink(
    jsonRequest("/api/v1/auth/magic-link/request", {
      tenant_id: "ironwrap",
      email: "owner@example.com",
    }),
    env,
    waiter.ctx as never,
    { sendMagicLink: async (_env, _user, raw) => { token = raw; } },
  );
  await waiter.flush();

  const response = await consumeMagicLink(
    jsonRequest("/api/v1/auth/magic-link/consume", { token }),
    env,
  );
  const body = await response.json() as {
    user: { role: string };
    permissions: string[];
    allowed_actions: string[];
  };

  assert.equal(response.status, 200);
  assert.equal(body.user.role, "sales");
  assert.deepEqual(body.permissions, [
    "session:read",
    "now:read",
    "sales:read",
    "sales:lead_create",
    "estimator:read",
    "approvals:read",
    "approvals:prepare",
  ]);
  assert.equal(body.permissions.includes("owner:read"), false);
  assert.equal(body.permissions.includes("jobs:read:any"), false);
  assert.equal(body.permissions.includes("approvals:decide"), false);
  assert.equal(body.allowed_actions.includes("approval.prepare"), true);
  assert.equal(body.allowed_actions.includes("approval.approve"), false);
});

test("production sessions can read jobs and runway without commercial or owner authority", async () => {
  const db = new AuthMemoryDb();
  const env = baseEnv(db);
  await addOfficeUser(env, "production");
  let token = "";
  const waiter = waitContext();
  await requestMagicLink(
    jsonRequest("/api/v1/auth/magic-link/request", {
      tenant_id: "ironwrap",
      email: "owner@example.com",
    }),
    env,
    waiter.ctx as never,
    { sendMagicLink: async (_env, _user, raw) => { token = raw; } },
  );
  await waiter.flush();

  const response = await consumeMagicLink(
    jsonRequest("/api/v1/auth/magic-link/consume", { token }),
    env,
  );
  const body = await response.json() as {
    user: { role: string };
    permissions: string[];
    allowed_actions: string[];
  };

  assert.equal(response.status, 200);
  assert.equal(body.user.role, "production");
  assert.deepEqual(body.permissions, [
    "session:read",
    "now:read",
    "jobs:read:any",
    "production:read",
    // ELEC-122: clearing a scheduling gate is the one write this role has, and it
    // matches the gate authority `access_control` already grants IronWrap
    // Production in Frappe. Everything commercial below is still refused.
    "production:clear_gate",
    "authority:read",
    // Production is the reviewer that approves an internal worker competency command.
    "authority:approve",
  ]);
  // `production_gate.clear` is not advertised here: it needs a Frappe identity
  // this session may not carry, so the runway read model is where the surface
  // learns whether it may offer it.
  assert.deepEqual(body.allowed_actions, [
    "session.logout",
    "now.read",
    "production.read",
    "job.read",
    "authority.read",
  ]);
  for (const forbidden of [
    "owner:read",
    "sales:read",
    "estimator:read",
    "approvals:read",
    "approvals:prepare",
    "approvals:decide",
  ]) {
    assert.equal(body.permissions.includes(forbidden), false, forbidden);
  }
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

test("auth bootstrap stays available without Frappe when app auth itself is configured", async () => {
  const env = baseEnv();
  delete (env as { ERPNEXT_BASE_URL?: string }).ERPNEXT_BASE_URL;
  delete (env as { ERPNEXT_API_KEY?: string }).ERPNEXT_API_KEY;
  delete (env as { ERPNEXT_API_SECRET?: string }).ERPNEXT_API_SECRET;
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
  assert.equal(body.version, 1);
  assert.equal(body.session.authenticated, false);
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

test("first-owner bootstrap is default-off, zero-user-only, and server-attributed", async () => {
  const db = new AuthMemoryDb();
  const env = baseEnv(db);
  const payload = {
    tenant_id: "ironwrap",
    email: "owner@example.com",
    display_name: "Office Owner",
  };

  const disabled = await worker.fetch(jsonRequest("/admin/app-users/bootstrap", payload, {
    authorization: "Bearer admin-token",
  }), env, waitContext().ctx as never);
  assert.equal(disabled.status, 403);
  assert.deepEqual(await disabled.json(), { error: "first_owner_bootstrap_disabled" });

  env.APP_FIRST_OWNER_BOOTSTRAP_ENABLED = "true";
  const unauthorized = await worker.fetch(jsonRequest("/admin/app-users/bootstrap", payload), env, waitContext().ctx as never);
  assert.equal(unauthorized.status, 401);

  const strictBody = await worker.fetch(jsonRequest("/admin/app-users/bootstrap", {
    ...payload,
    role: "owner",
  }, {
    authorization: "Bearer admin-token",
  }), env, waitContext().ctx as never);
  assert.equal(strictBody.status, 400);
  assert.deepEqual(await strictBody.json(), { error: "unexpected_field" });

  const created = await worker.fetch(jsonRequest("/admin/app-users/bootstrap", payload, {
    authorization: "Bearer admin-token",
  }), env, waitContext().ctx as never);
  assert.equal(created.status, 200);
  const body = await created.json() as {
    user: { role: string; active: boolean; frappe_user_id: string | null };
  };
  assert.deepEqual(body.user, {
    ...body.user,
    role: "owner",
    active: true,
    frappe_user_id: null,
  });
  assert.equal(db.users.size, 1);
  const owner = [...db.users.values()][0];
  assert.equal(owner.created_by, "system:first_owner_bootstrap");
  let audit = db.audits.at(-1)?.args as unknown[] | undefined;
  assert.equal(audit?.[3], "user_bootstrap");
  assert.equal(audit?.[4], "created");
  assert.equal(audit?.[7], "owner:first_owner_bootstrap");

  const replay = await worker.fetch(jsonRequest("/admin/app-users/bootstrap", payload, {
    authorization: "Bearer admin-token",
  }), env, waitContext().ctx as never);
  assert.equal(replay.status, 409);
  assert.deepEqual(await replay.json(), { error: "first_owner_bootstrap_completed" });
  assert.equal(db.users.size, 1);
  audit = db.audits.at(-1)?.args as unknown[] | undefined;
  assert.equal(audit?.[3], "user_bootstrap");
  assert.equal(audit?.[4], "denied");
  assert.equal(audit?.[7], "first_owner_bootstrap_completed");
});

test("app-session provisioning is tenant-bound, strict, CSRF-gated, and server-attributed", async () => {
  const db = new AuthMemoryDb();
  const env = baseEnv(db);
  const office = await signInOffice(env);
  const payload = {
    tenant_id: "ironwrap",
    email: "crew@example.com",
    display_name: "Crew Member",
    role: "field",
    frappe_user_id: "crew@example.com",
    active: true,
  };

  const bearerRoute = await worker.fetch(jsonRequest("/admin/app-users", payload, {
    authorization: "Bearer admin-token",
  }), env, waitContext().ctx as never);
  assert.equal(bearerRoute.status, 404);

  const missingCsrf = await worker.fetch(jsonRequest("/api/v1/admin/app-users", payload, {
    cookie: office.cookiePair,
  }), env, waitContext().ctx as never);
  assert.equal(missingCsrf.status, 403);
  assert.deepEqual(await missingCsrf.json(), { error: "csrf_failed" });

  const forgedActor = await worker.fetch(jsonRequest("/api/v1/admin/app-users", {
    ...payload,
    provisioned_by: "forged@example.com",
  }, {
    cookie: office.cookiePair,
    "x-csrf-token": office.csrfToken,
  }), env, waitContext().ctx as never);
  assert.equal(forgedActor.status, 400);
  assert.deepEqual(await forgedActor.json(), { error: "unexpected_field" });

  const provisioned = await worker.fetch(jsonRequest("/api/v1/admin/app-users", payload, {
    cookie: office.cookiePair,
    "x-csrf-token": office.csrfToken,
  }), env, waitContext().ctx as never);
  assert.equal(provisioned.status, 200);
  const result = await provisioned.json() as { user: { role: string; active: boolean } };
  assert.deepEqual(result.user, { ...result.user, role: "field", active: true });
  assert.equal(db.users.size, 2);
  const crew = [...db.users.values()].find((user) => user.email_normalized === "crew@example.com");
  assert.equal(crew?.created_by, "owner@example.com");
  const provisionAudit = db.audits.at(-1)?.args as unknown[] | undefined;
  assert.equal(provisionAudit?.[3], "user_provision");
  assert.equal(provisionAudit?.[7], "field:owner@example.com");
  // The grant as a structured change: the version it produced, no earlier access, the access
  // granted, and the signed-in actor the server attributes it to (0157).
  assert.deepEqual(JSON.parse(String(provisionAudit?.[8])), {
    v: 1,
    before: null,
    after: { role: "field", active: true },
    actor: office.user.user_id,
  });

  const salesResponse = await worker.fetch(jsonRequest("/api/v1/admin/app-users", {
    ...payload,
    email: "sales@example.com",
    display_name: "Sales Desk",
    role: "sales",
    frappe_user_id: "sales@example.com",
  }, {
    cookie: office.cookiePair,
    "x-csrf-token": office.csrfToken,
  }), env, waitContext().ctx as never);
  assert.equal(salesResponse.status, 200);
  assert.equal(
    (await salesResponse.json() as { user: { role: string } }).user.role,
    "sales",
  );
  assert.equal(
    [...db.users.values()].find((user) => user.email_normalized === "sales@example.com")?.role,
    "sales",
  );
  const salesUser = [...db.users.values()].find((user) =>
    user.email_normalized === "sales@example.com"
  );
  assert.deepEqual(db.storageRoles.get(salesUser!.user_id), {
    role: "ops",
    access_role: "sales",
  });

  const productionResponse = await worker.fetch(jsonRequest("/api/v1/admin/app-users", {
    ...payload,
    email: "production@example.com",
    display_name: "Production Manager",
    role: "production",
    frappe_user_id: "production@example.com",
  }, {
    cookie: office.cookiePair,
    "x-csrf-token": office.csrfToken,
  }), env, waitContext().ctx as never);
  assert.equal(productionResponse.status, 200);
  assert.equal(
    (await productionResponse.json() as { user: { role: string } }).user.role,
    "production",
  );
  const productionUser = [...db.users.values()].find((user) =>
    user.email_normalized === "production@example.com"
  );
  assert.deepEqual(db.storageRoles.get(productionUser!.user_id), {
    role: "ops",
    access_role: "production",
  });

  const nativeField = await worker.fetch(jsonRequest("/api/v1/admin/app-users", {
    ...payload,
    email: "other@example.com",
    frappe_user_id: null,
  }, {
    cookie: office.cookiePair,
    "x-csrf-token": office.csrfToken,
  }), env, waitContext().ctx as never);
  assert.equal(nativeField.status, 200);
  const nativeFieldResponse = await nativeField.json() as {
    user: { email: string; role: string; frappe_user_id: string | null };
  };
  assert.equal(nativeFieldResponse.user.email, "other@example.com");
  assert.equal(nativeFieldResponse.user.role, "field");
  assert.equal(nativeFieldResponse.user.frappe_user_id, null);
  const nativeFieldUser = [...db.users.values()].find((user) =>
    user.email_normalized === "other@example.com"
  );
  assert.deepEqual(db.storageRoles.get(nativeFieldUser!.user_id), {
    role: "ops",
    access_role: "field",
  });

  const otherTenant = await worker.fetch(jsonRequest("/api/v1/admin/app-users", {
    ...payload,
    tenant_id: "another-tenant",
  }, {
    cookie: office.cookiePair,
    "x-csrf-token": office.csrfToken,
  }), env, waitContext().ctx as never);
  assert.equal(otherTenant.status, 400);
  assert.deepEqual(await otherTenant.json(), { error: "invalid_tenant" });

  const unauthorized = await worker.fetch(jsonRequest("/api/v1/admin/app-users", payload), env, waitContext().ctx as never);
  assert.equal(unauthorized.status, 401);
});

test("legacy app-user provisioning cannot bypass owner and self-change authority", async () => {
  const opsDb = new AuthMemoryDb();
  const opsEnv = baseEnv(opsDb);
  const ops = await signInOffice(opsEnv, "ops");

  const selfPromote = await worker.fetch(jsonRequest("/api/v1/admin/app-users", {
    tenant_id: "ironwrap",
    email: ops.user.email_normalized,
    display_name: ops.user.display_name,
    role: "owner",
    frappe_user_id: null,
    active: true,
  }, {
    cookie: ops.cookiePair,
    "x-csrf-token": ops.csrfToken,
  }), opsEnv, waitContext().ctx as never);
  assert.equal(selfPromote.status, 409);
  assert.deepEqual(await selfPromote.json(), { error: "self_change_forbidden" });
  assert.equal(opsDb.users.get(ops.user.user_id)?.role, "ops");

  const grantOwner = await worker.fetch(jsonRequest("/api/v1/admin/app-users", {
    tenant_id: "ironwrap",
    email: "new-owner@example.com",
    display_name: "New Owner",
    role: "owner",
    frappe_user_id: null,
    active: true,
  }, {
    cookie: ops.cookiePair,
    "x-csrf-token": ops.csrfToken,
  }), opsEnv, waitContext().ctx as never);
  assert.equal(grantOwner.status, 403);
  assert.deepEqual(await grantOwner.json(), { error: "owner_role_required" });
  assert.equal(
    [...opsDb.users.values()].some((user) => user.email_normalized === "new-owner@example.com"),
    false,
  );

  const teammate = await worker.fetch(jsonRequest("/api/v1/admin/app-users", {
    tenant_id: "ironwrap",
    email: "teammate@example.com",
    display_name: "Teammate",
    role: "sales",
    frappe_user_id: null,
    active: true,
  }, {
    cookie: ops.cookiePair,
    "x-csrf-token": ops.csrfToken,
  }), opsEnv, waitContext().ctx as never);
  assert.equal(teammate.status, 200, "operations keeps non-owner provisioning authority");
  const teammateId = (await teammate.json() as { user: { user_id: string } }).user.user_id;
  const replay = await worker.fetch(jsonRequest("/api/v1/admin/app-users", {
    tenant_id: "ironwrap",
    email: "teammate@example.com",
    display_name: "Teammate",
    role: "sales",
    frappe_user_id: null,
    active: true,
    expected_access_version: 1,
  }, {
    cookie: ops.cookiePair,
    "x-csrf-token": ops.csrfToken,
  }), opsEnv, waitContext().ctx as never);
  assert.equal(replay.status, 200);
  assert.equal(
    (await replay.json() as { user: { user_id: string } }).user.user_id,
    teammateId,
    "an exact retry remains one grant",
  );

  const protectedOwner = await upsertAppUser(opsEnv, {
    tenant_id: "ironwrap",
    email_normalized: "protected-owner@example.com",
    display_name: "Protected Owner",
    role: "owner",
    frappe_user_id: null,
    active: true,
    provisioned_by: "system:test",
  });
  const demoteOwner = await worker.fetch(jsonRequest("/api/v1/admin/app-users", {
    tenant_id: "ironwrap",
    email: protectedOwner.email_normalized,
    display_name: protectedOwner.display_name,
    role: "ops",
    frappe_user_id: null,
    active: true,
  }, {
    cookie: ops.cookiePair,
    "x-csrf-token": ops.csrfToken,
  }), opsEnv, waitContext().ctx as never);
  assert.equal(demoteOwner.status, 403);
  assert.deepEqual(await demoteOwner.json(), { error: "owner_role_required" });
  assert.equal(opsDb.users.get(protectedOwner.user_id)?.role, "owner");

  const ownerDb = new AuthMemoryDb();
  const ownerEnv = baseEnv(ownerDb);
  const owner = await signInOffice(ownerEnv);
  for (const mutation of [
    { role: "sales", active: true },
    { role: "owner", active: false },
  ] as const) {
    const refused = await worker.fetch(jsonRequest("/api/v1/admin/app-users", {
      tenant_id: "ironwrap",
      email: owner.user.email_normalized,
      display_name: owner.user.display_name,
      role: mutation.role,
      frappe_user_id: null,
      active: mutation.active,
    }, {
      cookie: owner.cookiePair,
      "x-csrf-token": owner.csrfToken,
    }), ownerEnv, waitContext().ctx as never);
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), { error: "self_change_forbidden" });
  }
  assert.equal(ownerDb.users.get(owner.user.user_id)?.role, "owner");
  assert.equal(ownerDb.users.get(owner.user.user_id)?.active, 1);
});

test("admin deactivation revokes existing sessions and consumes open links", async () => {
  const db = new AuthMemoryDb();
  const env = baseEnv(db);
  const office = await signInOffice(env);
  const target = await upsertAppUser(env, {
    tenant_id: "ironwrap",
    email_normalized: "departing@example.com",
    display_name: "Departing Teammate",
    role: "ops",
    frappe_user_id: null,
    active: true,
    provisioned_by: office.user.email_normalized,
  });
  let token = "";
  const firstWaiter = waitContext();
  await requestMagicLink(
    jsonRequest("/api/v1/auth/magic-link/request", {
      tenant_id: "ironwrap",
      email: target.email_normalized,
    }),
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
    jsonRequest("/api/v1/auth/magic-link/request", {
      tenant_id: "ironwrap",
      email: target.email_normalized,
    }),
    env,
    secondWaiter.ctx as never,
    { sendMagicLink: async () => {} },
  );
  await secondWaiter.flush();
  assert.equal(
    [...db.magic.values()].find((link) => link.user_id === target.user_id)?.consumed_at,
    null,
  );

  const deactivated = await worker.fetch(jsonRequest("/api/v1/admin/app-users", {
    tenant_id: "ironwrap",
    email: target.email_normalized,
    display_name: target.display_name,
    role: target.role,
    frappe_user_id: null,
    active: false,
    expected_access_version: 1,
  }, {
    cookie: office.cookiePair,
    "x-csrf-token": office.csrfToken,
  }), env, secondWaiter.ctx as never);
  assert.equal(deactivated.status, 200);
  assert.equal(
    [...db.sessions.values()].find((session) => session.user_id === target.user_id)?.revoked_at !== null,
    true,
  );
  assert.equal(
    [...db.sessions.values()].find((session) => session.user_id === office.user.user_id)?.revoked_at,
    null,
  );
  assert.equal(
    [...db.magic.values()].find((link) => link.user_id === target.user_id)?.consumed_at !== null,
    true,
  );

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

  // A proof problem is refused, never answered with the signed-out payload: reading
  // `authenticated: false` is what makes the PWA drop its device secret.
  const withoutProof = await worker.fetch(new Request("https://worker.example.com/api/v1/session", {
    headers: { cookie: fieldCookie, origin: "https://app.example.com" },
  }), env, ctx.ctx as never);
  assert.equal(withoutProof.status, 401);
  assert.deepEqual(await withoutProof.json(), { error: "device_proof_required" });
  assert.equal(withoutProof.headers.get("set-cookie"), null);

  const bootstrapWithoutProof = await worker.fetch(new Request("https://worker.example.com/api/v1/field/bootstrap", {
    headers: { cookie: fieldCookie, origin: "https://app.example.com" },
  }), env, ctx.ctx as never);
  assert.equal(bootstrapWithoutProof.status, 401);
  assert.deepEqual(await bootstrapWithoutProof.json(), { error: "device_proof_required" });
  assert.equal(bootstrapWithoutProof.headers.get("set-cookie"), null);

  // Every new upload passes the global paired-device gate before multipart parsing or storage.
  for (const proof of [undefined, "q".repeat(43)]) {
    const refused = await worker.fetch(new Request("https://worker.example.com/api/v1/evidence-uploads", {
      method: "POST", headers: { cookie: fieldCookie, origin: "https://app.example.com",
        ...(proof ? { "x-ironwrap-device-proof": proof } : {}) },
    }), env, ctx.ctx as never);
    assert.equal(refused.status, 401);
    assert.deepEqual(await refused.json(), { error: "device_proof_required" });
    assert.equal(refused.headers.get("set-cookie"), null);
  }

  const wrongProof = await worker.fetch(new Request("https://worker.example.com/api/v1/session", {
    headers: {
      cookie: fieldCookie,
      origin: "https://app.example.com",
      "x-ironwrap-device-proof": "q".repeat(43),
    },
  }), env, ctx.ctx as never);
  assert.equal(wrongProof.status, 401);
  assert.deepEqual(await wrongProof.json(), { error: "device_proof_required" });
  assert.equal(wrongProof.headers.get("set-cookie"), null);

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
      capabilities: { projection: string; proof_claimed: boolean };
    };
    assert.equal(fieldBootstrap.status, 200);
    assert.equal(fieldBootstrap.headers.get("cache-control"), "private, no-store");
    // Exact keys on purpose: this payload reaches a paired field device, so a key arriving here
    // unnoticed is exactly what this assertion exists to catch. `capabilities` is the deliberate
    // ELEC-240 addition -- the role-scoped capability signal, so an offline device needs one call
    // rather than two on a bad connection -- and it carries the non-office projection, never the
    // office one.
    assert.deepEqual(
      Object.keys(bootstrap).sort(),
      ["capabilities", "session", "today", "version"],
    );
    assert.equal(bootstrap.capabilities.projection, "scoped");
    assert.equal(bootstrap.capabilities.proof_claimed, false);
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

/**
 * ELEC-167 item 18. The router used to expire the session cookie on EVERY unauthenticated
 * request, so a live field session that simply did not carry its device proof - an
 * office-shaped call from a field surface, or a cold load where reading the proof out of
 * IndexedDB lost the race - was answered exactly like having no session at all. The browser
 * dropped the cookie, the next load reported a signed-out session, the PWA cleared the device
 * secret, and the crew phone demanded re-pairing. One proofless request un-paired a phone.
 *
 * The rule this pins: the cookie is expired only when the cookie itself names nothing live.
 */
test("a proofless field request is refused without expiring a live session cookie", async () => {
  const db = new AuthMemoryDb();
  const env = baseEnv(db);
  const fieldUser = await addFieldUser(env);
  const office = await signInOffice(env);
  const ctx = waitContext();

  const issued = await (await worker.fetch(jsonRequest("/api/v1/device-pairings", {
    field_user_id: fieldUser.user_id,
  }, { cookie: office.cookiePair, "x-csrf-token": office.csrfToken }), env, ctx.ctx as never))
    .json() as { pairing_url: string };
  const deviceProof = "p".repeat(43);
  const paired = await worker.fetch(jsonRequest("/api/v1/auth/device-pairing/consume", {
    token: new URL(issued.pairing_url).hash.slice("#token=".length),
    device_proof: deviceProof,
  }), env, ctx.ctx as never);
  assert.equal(paired.status, 200);
  const fieldCookie = (paired.headers.get("set-cookie") ?? "").split(";")[0];

  // An office-shaped read from a field surface: the session is live, the header is simply
  // not on the request. It is refused, and the cookie is left alone.
  const proofless = await worker.fetch(new Request("https://worker.example.com/api/v1/device-pairings", {
    headers: { cookie: fieldCookie, origin: "https://app.example.com" },
  }), env, ctx.ctx as never);
  assert.equal(proofless.status, 401);
  assert.deepEqual(await proofless.json(), { error: "device_proof_required" });
  assert.equal(proofless.headers.get("set-cookie"), null);

  // The point of not expiring it: the very same cookie still works once the proof is present,
  // so the phone never has to be re-paired over a request that forgot its header.
  const stillPaired = await worker.fetch(new Request("https://worker.example.com/api/v1/session", {
    headers: {
      cookie: fieldCookie,
      origin: "https://app.example.com",
      "x-ironwrap-device-proof": deviceProof,
    },
  }), env, ctx.ctx as never);
  assert.equal(stillPaired.status, 200);
  const stillPairedBody = await stillPaired.json() as {
    authenticated: boolean;
    user: { role: string };
  };
  assert.equal(stillPairedBody.authenticated, true);
  assert.equal(stillPairedBody.user.role, "field");
  assert.equal(db.devices.size, 1);
  assert.equal([...db.devices.values()][0].revoked_at, null);

  // Having no session at all is still a dead cookie, and still gets the expiry.
  const noSession = await worker.fetch(new Request("https://worker.example.com/api/v1/device-pairings", {
    headers: { origin: "https://app.example.com" },
  }), env, ctx.ctx as never);
  assert.equal(noSession.status, 401);
  assert.deepEqual(await noSession.json(), { error: "unauthorized" });
  assert.match(noSession.headers.get("set-cookie") ?? "", /Max-Age=0/);

  // So is a cookie whose session row is gone, expired or revoked.
  const staleSession = await worker.fetch(new Request("https://worker.example.com/api/v1/device-pairings", {
    headers: {
      cookie: `__Host-ironwrap_session=${"z".repeat(43)}`,
      origin: "https://app.example.com",
    },
  }), env, ctx.ctx as never);
  assert.equal(staleSession.status, 401);
  assert.match(staleSession.headers.get("set-cookie") ?? "", /Max-Age=0/);

  // A signed-out browser still gets the friendly payload it needs to paint a sign-in screen.
  const signedOutSession = await worker.fetch(new Request("https://worker.example.com/api/v1/session", {
    headers: { origin: "https://app.example.com" },
  }), env, ctx.ctx as never);
  assert.equal(signedOutSession.status, 200);
  assert.equal((await signedOutSession.json() as { authenticated: boolean }).authenticated, false);
  assert.match(signedOutSession.headers.get("set-cookie") ?? "", /Max-Age=0/);
});
