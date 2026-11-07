// Per-request tenant resolution for the shared multi-tenant Worker (migration 0209, tenancy.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import worker from "../src/index.ts";
import { sessionHashFor } from "../src/app-auth.ts";
import {
  TENANT_SECRET_NAMES,
  TENANT_SETTING_KEYS,
  TENANT_CACHE_TTL_MS,
  listActiveTenantIds,
  openTenantSecrets,
  resetTenantCache,
  resolveRequestTenant,
  sealTenantSecrets,
  tenantEnvFor,
} from "../src/tenancy.ts";
import { TENANT_SCOPED_VARS } from "../../tools/generate-tenant-worker-config.mjs";
import { NOW, SqliteD1, TENANT, USERS, env as baseEnv } from "./company-setup-fixture.ts";

const KEK = "a".repeat(64);
const OTHER_KEK = "b".repeat(64);
const PEPPER = "pepper-pepper-pepper-pepper-pepper-32";
const TENANT_B = "northline-metal";
const HOST_A = "a.example.invalid";
const HOST_B = "b.example.invalid";

function ctx() {
  return { waitUntil(): void {}, passThroughOnException(): void {} };
}

/** The Worker's own env with the shared runtime on; the Worker tenant answers on HOST_A. */
function multiTenantEnv(db: SqliteD1, overrides: Record<string, unknown> = {}) {
  return baseEnv(db, {
    APP_MULTI_TENANT_ENABLED: "true",
    TENANT_SECRETS_KEK: KEK,
    APP_PUBLIC_ORIGIN: `https://${HOST_A}`,
    APP_ALLOWED_ORIGINS: `https://${HOST_A}`,
    APP_ALLOW_INSECURE_LOCAL: "true",
    APP_AUTH_PEPPER: PEPPER,
    AGENT_HOST_TOKEN: "worker-agent-token",
    ADMIN_TOKEN: "root-admin-token",
    AGENT_DATA_CLASS: "business",
    ...overrides,
  } as never);
}

async function registerTenantB(
  db: SqliteD1,
  options: { status?: "active" | "suspended"; secrets?: Record<string, string> | null; kek?: string; settings?: Record<string, unknown> } = {},
): Promise<void> {
  const settings = options.settings ?? {
    APP_PUBLIC_ORIGIN: `https://${HOST_B}`,
    APP_ALLOWED_ORIGINS: `https://${HOST_B}`,
    APP_LOCALE: "en-CA",
    APP_TIME_ZONE: "America/Vancouver",
    APP_CURRENCY: "CAD",
  };
  const secrets = options.secrets === undefined ? { AGENT_HOST_TOKEN: "tenant-b-agent-token" } : options.secrets;
  const ciphertext = secrets ? await sealTenantSecrets(options.kek ?? KEK, TENANT_B, 1, secrets) : null;
  db.raw.prepare(
    `INSERT INTO tenants (tenant_id, display_name, status, data_class, settings_json, secrets_ciphertext,
                          secrets_key_version, version, created_at, updated_at)
     VALUES (?, 'Northline Metal', ?, 'synthetic', ?, ?, ?, 1, ?, ?)`,
  ).run(TENANT_B, options.status ?? "active", JSON.stringify(settings), ciphertext, ciphertext ? 1 : null, NOW, NOW);
  db.raw.prepare("INSERT INTO tenant_hosts (host, tenant_id, created_at) VALUES (?, ?, ?)").run(HOST_B, TENANT_B, NOW);
}

function request(host: string, path = "/api/v1/session", init: RequestInit = {}): Request {
  return new Request(`https://${host}${path}`, init);
}

test.beforeEach(() => resetTenantCache());

test("every var a white-label clone rewrites is a setting a registry tenant may hold", () => {
  const cloneVars = Object.keys(TENANT_SCOPED_VARS).filter((name) => name !== "APP_TENANT_ID");
  for (const name of cloneVars) {
    assert.ok(TENANT_SETTING_KEYS.includes(name), `${name} is derived for a clone but not allowed in the shared Worker`);
  }
  // Product configuration is not a tenant fact: one Worker runs one product.
  for (const name of ["APP_MULTI_TENANT_ENABLED", "APP_BFF_ENABLED", "EFFECT_RUNTIME_ENABLED", "NEWO_ENABLED"]) {
    assert.ok(!TENANT_SETTING_KEYS.includes(name), `${name} must not be overridable per tenant`);
  }
});

test("tenant secrets are declared Worker secrets, never the Worker-wide keys", () => {
  const source = readFileSync(new URL("../src/secret-bindings.d.ts", import.meta.url), "utf8");
  const declared = new Set([...source.matchAll(/^\s{2,4}([A-Z][A-Z0-9_]+): string;$/gm)].map((match) => match[1]));
  for (const name of TENANT_SECRET_NAMES) assert.ok(declared.has(name), `${name} is not a declared secret binding`);
  for (const name of ["TENANT_SECRETS_KEK", "QB_TOKEN_ENCRYPTION_KEY", "APP_AUTH_PEPPER", "PUBLIC_ESTIMATE_RATE_LIMIT_PEPPER", "PUBLIC_ESTIMATE_TURNSTILE_SECRET"]) {
    assert.ok(!TENANT_SECRET_NAMES.includes(name), `${name} is Worker-wide and must not be sealed per tenant`);
  }
});

test("with the flag off the env is returned as bound and the registry is never read", async () => {
  const db = { prepare(): never { throw new Error("registry must not be read"); } };
  const env = baseEnv(db as never, { APP_MULTI_TENANT_ENABLED: "false" } as never);
  const resolution = await resolveRequestTenant(request(HOST_B), env as never);
  assert.equal(resolution.kind, "legacy");
  assert.equal(resolution.tenantId, TENANT);
  assert.ok(resolution.kind === "legacy" && resolution.env === env);
  const byId = await tenantEnvFor(env as never, TENANT_B);
  assert.equal(byId.kind, "legacy");
});

test("an unregistered host and the Worker's own id resolve to the Worker tenant unchanged", async () => {
  const db = new SqliteD1();
  const env = multiTenantEnv(db);
  const byHost = await resolveRequestTenant(request("unknown.example.invalid"), env as never);
  assert.equal(byHost.kind, "default");
  assert.ok(byHost.kind === "default" && byHost.env === env && byHost.tenantId === TENANT);
  const byId = await tenantEnvFor(env as never, TENANT);
  assert.equal(byId.kind, "default");
});

test("a registered host lays the tenant's identity, settings and secrets over env", async () => {
  const db = new SqliteD1();
  await registerTenantB(db, {
    settings: {
      APP_PUBLIC_ORIGIN: `https://${HOST_B}`,
      APP_ALLOWED_ORIGINS: `https://${HOST_B}`,
      APP_TIME_ZONE: "America/Vancouver",
      // A key outside the allowlist in a hand-written row is ignored, not applied.
      EFFECT_RUNTIME_ENABLED: "true",
      __secret_names: ["AGENT_HOST_TOKEN"],
    },
  });
  const env = multiTenantEnv(db, { EFFECT_RUNTIME_ENABLED: "false" });
  const resolution = await resolveRequestTenant(request(HOST_B), env as never);
  assert.equal(resolution.kind, "tenant");
  if (resolution.kind !== "tenant") return;
  const overlay = resolution.env as unknown as Record<string, unknown>;
  assert.equal(overlay.APP_TENANT_ID, TENANT_B);
  assert.equal(overlay.APP_TENANT_NAME, "Northline Metal");
  assert.equal(overlay.APP_TENANT_BRAND, "Northline Metal");
  assert.equal(overlay.APP_PUBLIC_ORIGIN, `https://${HOST_B}`);
  assert.equal(overlay.APP_TIME_ZONE, "America/Vancouver");
  assert.equal(overlay.APP_LOCALE, "en-CA", "a setting the tenant did not set keeps the Worker value");
  assert.equal(overlay.AGENT_HOST_TOKEN, "tenant-b-agent-token");
  assert.equal(overlay.ADMIN_TOKEN, "root-admin-token", "a secret the tenant did not seal keeps the Worker value");
  assert.equal(overlay.AGENT_DATA_CLASS, "synthetic", "the row's data class wins");
  assert.equal(overlay.EFFECT_RUNTIME_ENABLED, "false", "a product flag in settings_json is not applied");
  assert.equal(overlay.DB, db, "bindings pass through the overlay");
  assert.equal((env as unknown as Record<string, unknown>).APP_TENANT_ID, TENANT, "the bound env is not mutated");
});

test("a suspended tenant, a vanished row and a sealed envelope that will not open are refused, never defaulted", async () => {
  const db = new SqliteD1();
  await registerTenantB(db, { status: "suspended" });
  const env = multiTenantEnv(db);
  const suspended = await resolveRequestTenant(request(HOST_B), env as never);
  assert.deepEqual(suspended, { kind: "refused", tenantId: TENANT_B, refusal: { status: 503, error: "tenant_suspended" } });

  resetTenantCache();
  db.raw.prepare("UPDATE tenants SET status = 'active' WHERE tenant_id = ?").run(TENANT_B);
  const wrongKey = await resolveRequestTenant(request(HOST_B), multiTenantEnv(db, { TENANT_SECRETS_KEK: OTHER_KEK }) as never);
  assert.deepEqual(wrongKey, { kind: "refused", tenantId: TENANT_B, refusal: { status: 503, error: "tenant_secrets_unavailable" } });

  resetTenantCache();
  const missingKey = await resolveRequestTenant(request(HOST_B), multiTenantEnv(db, { TENANT_SECRETS_KEK: "" }) as never);
  assert.equal(missingKey.kind, "refused");

  const vanished = await tenantEnvFor(env as never, "no-such-tenant");
  assert.deepEqual(vanished, { kind: "refused", tenantId: "no-such-tenant", refusal: { status: 503, error: "tenant_unavailable" } });

  const malformed = await tenantEnvFor(env as never, "Not A Tenant");
  assert.equal(malformed.kind, "refused");
});

test("a registry read failure refuses the request rather than serving the Worker tenant", async () => {
  const db = { prepare(): never { throw new Error("d1 down"); } };
  const env = baseEnv(db as never, { APP_MULTI_TENANT_ENABLED: "true" } as never);
  const resolution = await resolveRequestTenant(request(HOST_B), env as never);
  assert.deepEqual(resolution, { kind: "refused", tenantId: null, refusal: { status: 503, error: "tenant_unavailable" } });
});

test("one isolate trusts a registry read for the cache window, then asks D1 again", async () => {
  const db = new SqliteD1();
  await registerTenantB(db);
  let reads = 0;
  const counting = {
    prepare(sql: string) {
      reads += 1;
      return db.prepare(sql);
    },
  };
  const env = multiTenantEnv(counting as never);
  let clock = 1_000_000;
  const now = () => clock;
  assert.equal((await resolveRequestTenant(request(HOST_B), env as never, now)).kind, "tenant");
  const afterFirst = reads;
  assert.equal((await resolveRequestTenant(request(HOST_B), env as never, now)).kind, "tenant");
  assert.equal(reads, afterFirst, "a second request inside the window reads nothing");
  clock += TENANT_CACHE_TTL_MS + 1;
  assert.equal((await resolveRequestTenant(request(HOST_B), env as never, now)).kind, "tenant");
  assert.ok(reads > afterFirst, "past the window the registry is read again");
  const afterExpiry = reads;
  resetTenantCache();
  assert.equal((await resolveRequestTenant(request(HOST_B), env as never, now)).kind, "tenant");
  assert.ok(reads > afterExpiry, "a reset forgets the read");
});

test("the secrets envelope opens only under its key, for its tenant and key version, untouched", async () => {
  const sealed = await sealTenantSecrets(KEK, TENANT_B, 1, { INGEST_TOKEN: "ingest-b", ADMIN_TOKEN: "admin-b" });
  assert.deepEqual(await openTenantSecrets(KEK, TENANT_B, 1, sealed), { ADMIN_TOKEN: "admin-b", INGEST_TOKEN: "ingest-b" });
  await assert.rejects(openTenantSecrets(OTHER_KEK, TENANT_B, 1, sealed));
  await assert.rejects(openTenantSecrets(KEK, "another-tenant", 1, sealed), "an envelope moved onto another row does not open");
  await assert.rejects(openTenantSecrets(KEK, TENANT_B, 2, sealed));
  const bytes = Uint8Array.from(atob(sealed), (char) => char.charCodeAt(0));
  bytes[bytes.length - 1] ^= 1;
  await assert.rejects(openTenantSecrets(KEK, TENANT_B, 1, btoa(String.fromCharCode(...bytes))));
  // A sealed name outside the allowlist is refused on open, so a row cannot smuggle the KEK itself.
  const smuggled = await sealTenantSecrets(KEK, TENANT_B, 1, { TENANT_SECRETS_KEK: "x" });
  await assert.rejects(openTenantSecrets(KEK, TENANT_B, 1, smuggled));
  await assert.rejects(sealTenantSecrets("short", TENANT_B, 1, {}), /tenant_secrets_kek_invalid/);
  const base64Key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
  assert.deepEqual(await openTenantSecrets(base64Key, "t", 1, await sealTenantSecrets(base64Key, "t", 1, {})), {});
});

test("a cron pass serves the Worker tenant first, then every active registry tenant once", async () => {
  const db = new SqliteD1();
  await registerTenantB(db);
  db.raw.prepare(
    `INSERT INTO tenants (tenant_id, display_name, status, data_class, settings_json, version, created_at, updated_at)
     VALUES ('paused-co', 'Paused', 'suspended', 'synthetic', '{}', 1, ?, ?)`,
  ).run(NOW, NOW);
  db.raw.prepare(
    `INSERT INTO tenants (tenant_id, display_name, status, data_class, settings_json, version, created_at, updated_at)
     VALUES (?, 'Worker tenant hosts', 'active', 'business', '{}', 1, ?, ?)`,
  ).run(TENANT, NOW, NOW);
  assert.deepEqual(await listActiveTenantIds(multiTenantEnv(db) as never), [TENANT, TENANT_B]);
  assert.deepEqual(await listActiveTenantIds(baseEnv(db) as never), [TENANT]);
});

test("through the Worker: each host answers with its own tenant and a session binds to the host it was issued on", async () => {
  const db = new SqliteD1();
  db.addUser("ops", TENANT_B, "appu_ops_northline1");
  await registerTenantB(db);
  const env = multiTenantEnv(db);

  const signedOutA = await worker.fetch(request(HOST_A), env as never, ctx() as never);
  assert.equal(signedOutA.status, 200);
  const payloadA = await signedOutA.json() as { authenticated: boolean; tenant: { id: string; name: string } };
  assert.equal(payloadA.tenant.id, TENANT);
  assert.equal(payloadA.tenant.name, "IronWrap OS");

  const signedOutB = await worker.fetch(request(HOST_B), env as never, ctx() as never);
  assert.equal(signedOutB.status, 200);
  const payloadB = await signedOutB.json() as { authenticated: boolean; tenant: { id: string; name: string; time_zone: string } };
  assert.equal(payloadB.tenant.id, TENANT_B);
  assert.equal(payloadB.tenant.name, "Northline Metal");
  assert.equal(payloadB.tenant.time_zone, "America/Vancouver");

  // A live session of tenant B's user, exactly as the Worker would have written it.
  const rawToken = "B".repeat(43);
  const sessionHash = await sessionHashFor(env, rawToken);
  db.raw.prepare(
    `INSERT INTO app_sessions (session_hash, user_id, tenant_id, created_at, expires_at, revoked_at, last_seen_at,
                               created_ip_hash, created_user_agent_hash, device_id)
     VALUES (?, 'appu_ops_northline1', ?, ?, '2999-01-01T00:00:00.000Z', NULL, ?, ?, ?, NULL)`,
  ).run(sessionHash, TENANT_B, NOW, NOW, "c".repeat(64), "d".repeat(64));
  const cookie = `__Host-ironwrap_session=${rawToken}`;

  const onB = await worker.fetch(request(HOST_B, "/api/v1/session", { headers: { cookie } }), env as never, ctx() as never);
  const onBPayload = await onB.json() as { authenticated: boolean; tenant: { id: string }; user: Record<string, unknown> | null };
  assert.equal(onBPayload.authenticated, true);
  assert.equal(onBPayload.tenant.id, TENANT_B);
  assert.ok(onBPayload.user && JSON.stringify(onBPayload.user).includes("appu_ops_northline1"));

  const onA = await worker.fetch(request(HOST_A, "/api/v1/session", { headers: { cookie } }), env as never, ctx() as never);
  const onAPayload = await onA.json() as { authenticated: boolean; tenant: { id: string } };
  assert.equal(onAPayload.authenticated, false, "tenant B's session is nobody on tenant A's host");
  assert.equal(onAPayload.tenant.id, TENANT);

  // The Worker tenant's own owner session, in turn, is nobody on tenant B's host.
  const ownerToken = "A".repeat(43);
  db.raw.prepare(
    `INSERT INTO app_sessions (session_hash, user_id, tenant_id, created_at, expires_at, revoked_at, last_seen_at,
                               created_ip_hash, created_user_agent_hash, device_id)
     VALUES (?, ?, ?, ?, '2999-01-01T00:00:00.000Z', NULL, ?, ?, ?, NULL)`,
  ).run(await sessionHashFor(env, ownerToken), USERS.owner, TENANT, NOW, NOW, "c".repeat(64), "d".repeat(64));
  const ownerOnB = await worker.fetch(
    request(HOST_B, "/api/v1/session", { headers: { cookie: `__Host-ironwrap_session=${ownerToken}` } }),
    env as never,
    ctx() as never,
  );
  assert.equal(((await ownerOnB.json()) as { authenticated: boolean }).authenticated, false);
});

test("through the Worker: the agent host token of one tenant is refused on the other tenant's host", async () => {
  const db = new SqliteD1();
  await registerTenantB(db);
  const env = multiTenantEnv(db);
  const signals = (host: string, token: string) =>
    worker.fetch(request(host, "/api/v1/agents/signals", { headers: { authorization: `Bearer ${token}` } }), env as never, ctx() as never);
  assert.equal((await signals(HOST_B, "tenant-b-agent-token")).status, 200);
  assert.equal((await signals(HOST_B, "worker-agent-token")).status, 401);
  assert.equal((await signals(HOST_A, "worker-agent-token")).status, 200);
  assert.equal((await signals(HOST_A, "tenant-b-agent-token")).status, 401);
});

test("through the Worker: a suspended tenant's host answers 503 and liveness never waits on the registry", async () => {
  const db = new SqliteD1();
  await registerTenantB(db, { status: "suspended" });
  const env = multiTenantEnv(db);
  const refused = await worker.fetch(request(HOST_B), env as never, ctx() as never);
  assert.equal(refused.status, 503);
  assert.deepEqual(await refused.json(), { error: "tenant_suspended" });

  // The registry cache is per isolate, not per database: forget this test's reads first.
  resetTenantCache();
  const down = baseEnv({ prepare(): never { throw new Error("d1 down"); } } as never, { APP_MULTI_TENANT_ENABLED: "true" } as never);
  const health = await worker.fetch(request(HOST_B, "/health"), down as never, ctx() as never);
  assert.equal(health.status, 200);
  const other = await worker.fetch(request(HOST_B, "/ready"), down as never, ctx() as never);
  assert.equal(other.status, 503);
  assert.deepEqual(await other.json(), { error: "tenant_unavailable" });
});
