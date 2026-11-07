// Per-request tenant resolution for the shared multi-tenant Worker (migration 0209, tenancy.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import worker from "../src/index.ts";
import { sessionHashFor } from "../src/app-auth.ts";
import {
  CLONE_ONLY_VARS,
  WORKER_WIDE_NAMES,
  TENANT_MISS_TTL_MS,
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
                          secrets_key_version, version, write_id, created_at, updated_at)
     VALUES (?, 'Northline Metal', ?, 'synthetic', ?, ?, ?, 1, 'seed-write-b', ?, ?)`,
  ).run(TENANT_B, options.status ?? "active", JSON.stringify(settings), ciphertext, ciphertext ? 1 : null, NOW, NOW);
  db.raw.prepare("INSERT INTO tenant_hosts (host, tenant_id, created_at) VALUES (?, ?, ?)").run(HOST_B, TENANT_B, NOW);
}

function request(host: string, path = "/api/v1/session", init: RequestInit = {}): Request {
  return new Request(`https://${host}${path}`, init);
}

test.beforeEach(() => resetTenantCache());

test("every var a white-label clone rewrites is either a registry setting or a named clone-only var", () => {
  const cloneVars = Object.keys(TENANT_SCOPED_VARS).filter((name) => name !== "APP_TENANT_ID");
  for (const name of cloneVars) {
    assert.ok(
      TENANT_SETTING_KEYS.includes(name) || CLONE_ONLY_VARS.includes(name),
      `${name} is derived for a clone but neither allowed nor refused by name in the shared Worker`,
    );
  }
  for (const name of CLONE_ONLY_VARS) assert.ok(!TENANT_SETTING_KEYS.includes(name), `${name} cannot be both`);
  // A destination a tenant may set must not be reached with a Worker-wide credential: every
  // URL-shaped setting's credentials are sealable per tenant.
  assert.ok(TENANT_SECRET_NAMES.includes("GOOGLE_SERVICE_ACCOUNT_JSON"), "Shared Drive ids need the tenant's own Google account");
  assert.ok(TENANT_SECRET_NAMES.includes("QB_CLIENT_ID") && TENANT_SECRET_NAMES.includes("QB_CLIENT_SECRET"), "a QuickBooks realm needs the tenant's own app");
  for (const name of ["ERPNEXT_BASE_URL", "FACET_V2_ROUTES_JSON"]) assert.ok(CLONE_ONLY_VARS.includes(name), `${name} reaches a Worker-wide credential`);
  // Product configuration is not a tenant fact: one Worker runs one product.
  for (const name of ["APP_MULTI_TENANT_ENABLED", "APP_BFF_ENABLED", "EFFECT_RUNTIME_ENABLED", "NEWO_ENABLED"]) {
    assert.ok(!TENANT_SETTING_KEYS.includes(name), `${name} must not be overridable per tenant`);
  }
});

test("every declared var and secret is classified exactly once: tenant setting, clone-only, tenant secret or Worker-wide", () => {
  const declared = new Set<string>();
  for (const file of ["../src/var-bindings.d.ts", "../src/secret-bindings.d.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const match of source.matchAll(/^\s{2,4}([A-Z][A-Z0-9_]+): string;$/gm)) declared.add(match[1]);
  }
  const lists: Array<[string, readonly string[]]> = [
    ["TENANT_SETTING_KEYS", TENANT_SETTING_KEYS],
    ["CLONE_ONLY_VARS", CLONE_ONLY_VARS],
    ["TENANT_SECRET_NAMES", TENANT_SECRET_NAMES],
    ["WORKER_WIDE_NAMES", WORKER_WIDE_NAMES],
  ];
  for (const name of declared) {
    const homes = lists.filter(([, list]) => list.includes(name)).map(([label]) => label);
    assert.equal(homes.length, 1, `${name} is classified ${homes.length === 0 ? "nowhere" : `twice: ${homes.join(", ")}`}; a tenant-bearing var the overlay does not clear is inherited from the Worker tenant`);
  }
  for (const [label, list] of lists) {
    for (const name of list) {
      // A clone-derived var the generator still rewrites may outlive its binding; nothing else may.
      assert.ok(declared.has(name) || name in TENANT_SCOPED_VARS, `${label} names ${name}, which no binding declares`);
    }
  }
});

test("tenant secrets are declared Worker secrets, never the Worker-wide keys", () => {
  const source = readFileSync(new URL("../src/secret-bindings.d.ts", import.meta.url), "utf8");
  const declared = new Set([...source.matchAll(/^\s{2,4}([A-Z][A-Z0-9_]+): string;$/gm)].map((match) => match[1]));
  for (const name of TENANT_SECRET_NAMES) assert.ok(declared.has(name), `${name} is not a declared secret binding`);
  for (const name of ["TENANT_SECRETS_KEK", "TENANT_PROXY_TOKEN", "QB_TOKEN_ENCRYPTION_KEY", "APP_AUTH_PEPPER", "PUBLIC_ESTIMATE_RATE_LIMIT_PEPPER", "PUBLIC_ESTIMATE_TURNSTILE_SECRET", "ADMIN_TOKEN"]) {
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
  // Through the Worker too: a registered host and row are ignored, and the registry surface is dark.
  const seeded = new SqliteD1();
  await registerTenantB(seeded);
  const off = multiTenantEnv(seeded, { APP_MULTI_TENANT_ENABLED: "false" });
  const session = await worker.fetch(request(HOST_B), off as never, ctx() as never);
  assert.equal(((await session.json()) as { tenant: { id: string } }).tenant.id, TENANT);
  const registry = await worker.fetch(
    request(HOST_A, "/admin/tenants", { headers: { authorization: "Bearer root-admin-token" } }),
    off as never,
    ctx() as never,
  );
  assert.equal(registry.status, 404);
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

test("a registered host lays the tenant's identity, settings and secrets over env, and nothing of the Worker tenant's", async () => {
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
  const env = multiTenantEnv(db, {
    EFFECT_RUNTIME_ENABLED: "false",
    INGEST_TOKEN: "worker-ingest",
    FROM_EMAIL: "ops@a.example.invalid",
    ERPNEXT_BASE_URL: "https://frappe.a.example.invalid",
    NEWO_OWNER_TRANSFER_NUMBER: "+15875550199",
    PROPOSAL_TEMPLATE_DOC_ID: "doc-a",
    NEWO_ENABLED: "true",
  });
  const resolution = await resolveRequestTenant(request(HOST_B), env as never);
  assert.equal(resolution.kind, "tenant");
  if (resolution.kind !== "tenant") return;
  const overlay = resolution.env as unknown as Record<string, unknown>;
  assert.equal(overlay.APP_TENANT_ID, TENANT_B);
  assert.equal(overlay.APP_TENANT_NAME, "Northline Metal");
  assert.equal(overlay.APP_TENANT_BRAND, "Northline Metal");
  assert.equal(overlay.APP_PUBLIC_ORIGIN, `https://${HOST_B}`);
  assert.equal(overlay.APP_TIME_ZONE, "America/Vancouver");
  assert.equal(overlay.APP_LOCALE, undefined, "a setting the tenant did not set is unset, never the Worker tenant's");
  assert.equal(overlay.FROM_EMAIL, undefined, "the Worker tenant's mailbox never sends for another tenant");
  assert.equal(overlay.ERPNEXT_BASE_URL, undefined, "a clone-only bridge var is cleared for a registry tenant");
  assert.equal(overlay.NEWO_OWNER_TRANSFER_NUMBER, undefined, "the Worker tenant's owner phone never takes another tenant's transfers");
  assert.equal(overlay.PROPOSAL_TEMPLATE_DOC_ID, undefined, "the Worker tenant's proposal template is not another tenant's");
  assert.equal(overlay.NEWO_ENABLED, "true", "a product flag stays the Worker's");
  assert.equal(overlay.AGENT_HOST_TOKEN, "tenant-b-agent-token");
  assert.equal(overlay.INGEST_TOKEN, undefined, "a secret the tenant did not seal is unset, so the Worker tenant's token opens nothing here");
  assert.equal(overlay.ADMIN_TOKEN, "root-admin-token", "ADMIN_TOKEN is the hosting operator's on every host");
  assert.equal(overlay.APP_AUTH_PEPPER, PEPPER, "Worker-wide keys stay");
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

test("a trailing-dot host is the same host; a host nobody registered yet is forgotten within seconds", async () => {
  const db = new SqliteD1();
  const env = multiTenantEnv(db);
  let clock = 5_000_000;
  const now = () => clock;
  // Not yet registered: the default tenant answers and the miss is remembered briefly.
  assert.equal((await resolveRequestTenant(request(HOST_B), env as never, now)).kind, "default");
  await registerTenantB(db);
  assert.equal((await resolveRequestTenant(request(HOST_B), env as never, now)).kind, "default", "inside the miss window");
  clock += TENANT_MISS_TTL_MS + 1;
  assert.equal((await resolveRequestTenant(request(HOST_B), env as never, now)).kind, "tenant", "past it the new row is seen");
  const dotted = await resolveRequestTenant(new Request(`https://${HOST_B}./api/v1/session`), env as never, now);
  assert.equal(dotted.kind, "tenant", "b.example.invalid. is b.example.invalid, not the default tenant");
  const upper = await resolveRequestTenant(new Request(`https://${HOST_B.toUpperCase()}:8443/api/v1/session`), env as never, now);
  assert.equal(upper.kind, "tenant");
});

test("a proxy's forwarded host is read only with the proxy's proof; without it the request is refused, not defaulted", async () => {
  const db = new SqliteD1();
  await registerTenantB(db);
  const env = multiTenantEnv(db, { TENANT_PROXY_TOKEN: "proxy-proof-token" });
  const viaProxy = (headers: Record<string, string>) =>
    new Request("https://ironwrap-bus-qa.workers.example.invalid/api/v1/session", { headers });

  const trusted = await resolveRequestTenant(viaProxy({ "x-ironwrap-forwarded-host": HOST_B, "x-ironwrap-proxy-token": "proxy-proof-token" }), env as never);
  assert.equal(trusted.kind, "tenant");
  assert.equal(trusted.tenantId, TENANT_B);
  const withPort = await resolveRequestTenant(viaProxy({ "x-ironwrap-forwarded-host": `${HOST_B.toUpperCase()}:443`, "x-ironwrap-proxy-token": "proxy-proof-token" }), env as never);
  assert.equal(withPort.kind, "tenant", "the forwarded host is normalised like the URL host");
  const defaultHost = await resolveRequestTenant(viaProxy({ "x-ironwrap-forwarded-host": HOST_A, "x-ironwrap-proxy-token": "proxy-proof-token" }), env as never);
  assert.equal(defaultHost.kind, "default");

  for (const headers of [
    { "x-ironwrap-forwarded-host": HOST_B },
    { "x-ironwrap-forwarded-host": HOST_B, "x-ironwrap-proxy-token": "wrong" },
  ]) {
    const refused = await resolveRequestTenant(viaProxy(headers), env as never);
    assert.deepEqual(refused, { kind: "refused", tenantId: null, refusal: { status: 403, error: "tenant_proxy_untrusted" } });
  }
  // No proof configured on the Worker: no forwarded host is ever trusted.
  const unconfigured = await resolveRequestTenant(viaProxy({ "x-ironwrap-forwarded-host": HOST_B, "x-ironwrap-proxy-token": "proxy-proof-token" }), multiTenantEnv(db) as never);
  assert.equal(unconfigured.kind, "refused");
  // The URL host still decides when no forwarded host is present.
  assert.equal((await resolveRequestTenant(request(HOST_B), env as never)).kind, "tenant");

  // Through the Worker: the refusal is a 403, the trusted forward answers as tenant B.
  const forbidden = await worker.fetch(viaProxy({ "x-ironwrap-forwarded-host": HOST_B }), env as never, ctx() as never);
  assert.equal(forbidden.status, 403);
  assert.deepEqual(await forbidden.json(), { error: "tenant_proxy_untrusted" });
  const served = await worker.fetch(viaProxy({ "x-ironwrap-forwarded-host": HOST_B, "x-ironwrap-proxy-token": "proxy-proof-token" }), env as never, ctx() as never);
  assert.equal(((await served.json()) as { tenant: { id: string } }).tenant.id, TENANT_B);
});

test("the secrets envelope opens only under its key, for its tenant and key version, untouched", async () => {
  const sealed = await sealTenantSecrets(KEK, TENANT_B, 1, { INGEST_TOKEN: "ingest-b", EFFECT_RUNTIME_TOKEN: "effects-b" });
  assert.deepEqual(await openTenantSecrets(KEK, TENANT_B, 1, sealed), { EFFECT_RUNTIME_TOKEN: "effects-b", INGEST_TOKEN: "ingest-b" });
  await assert.rejects(openTenantSecrets(OTHER_KEK, TENANT_B, 1, sealed));
  await assert.rejects(openTenantSecrets(KEK, "another-tenant", 1, sealed), "an envelope moved onto another row does not open");
  await assert.rejects(openTenantSecrets(KEK, TENANT_B, 2, sealed));
  const bytes = Uint8Array.from(atob(sealed), (char) => char.charCodeAt(0));
  bytes[bytes.length - 1] ^= 1;
  await assert.rejects(openTenantSecrets(KEK, TENANT_B, 1, btoa(String.fromCharCode(...bytes))));
  // A sealed name outside the allowlist is refused on open, so a row cannot smuggle the KEK itself
  // or an admin token.
  for (const name of ["TENANT_SECRETS_KEK", "ADMIN_TOKEN"]) {
    const smuggled = await sealTenantSecrets(KEK, TENANT_B, 1, { [name]: "x" });
    await assert.rejects(openTenantSecrets(KEK, TENANT_B, 1, smuggled));
  }
  await assert.rejects(sealTenantSecrets("short", TENANT_B, 1, {}), /tenant_secrets_kek_invalid/);
  const base64Key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
  assert.deepEqual(await openTenantSecrets(base64Key, "t", 1, await sealTenantSecrets(base64Key, "t", 1, {})), {});
});

test("a cron pass serves the Worker tenant first, then every active registry tenant once", async () => {
  const db = new SqliteD1();
  await registerTenantB(db);
  db.raw.prepare(
    `INSERT INTO tenants (tenant_id, display_name, status, data_class, settings_json, version, write_id, created_at, updated_at)
     VALUES ('paused-co', 'Paused', 'suspended', 'synthetic', '{}', 1, 'seed-write-p', ?, ?)`,
  ).run(NOW, NOW);
  db.raw.prepare(
    `INSERT INTO tenants (tenant_id, display_name, status, data_class, settings_json, version, write_id, created_at, updated_at)
     VALUES (?, 'Worker tenant hosts', 'active', 'business', '{}', 1, 'seed-write-a', ?, ?)`,
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

  // A tenant that sealed no token of its own has no agent surface at all; the Worker's token does
  // not stand in for it.
  resetTenantCache();
  db.raw.prepare("UPDATE tenants SET secrets_ciphertext = NULL, secrets_key_version = NULL WHERE tenant_id = ?").run(TENANT_B);
  assert.equal((await signals(HOST_B, "worker-agent-token")).status, 404);
  assert.equal((await signals(HOST_B, "tenant-b-agent-token")).status, 404);
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
