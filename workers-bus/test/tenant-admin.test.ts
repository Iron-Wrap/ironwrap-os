// The tenant registry's operator surface (/admin/tenants, tenant-admin.ts).
import { test } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.ts";
import { openTenantSecrets, resetTenantCache, resolveRequestTenant } from "../src/tenancy.ts";
import { NOW, SqliteD1, TENANT, env as baseEnv } from "./company-setup-fixture.ts";
import { loadTenantConfig, registrationBody } from "../../tools/qa-tenant-register.mjs";

const KEK = "c".repeat(64);
const ROOT_ADMIN = "root-admin-token";
const TENANT_B = "northline-metal";
const HOST_B = "b.example.invalid";

function ctx() {
  return { waitUntil(): void {}, passThroughOnException(): void {} };
}

function rootEnv(db: SqliteD1, overrides: Record<string, unknown> = {}) {
  return baseEnv(db, {
    APP_MULTI_TENANT_ENABLED: "true",
    TENANT_SECRETS_KEK: KEK,
    ADMIN_TOKEN: ROOT_ADMIN,
    APP_PUBLIC_ORIGIN: "https://a.example.invalid",
    APP_ALLOWED_ORIGINS: "https://a.example.invalid",
    ...overrides,
  } as never);
}

async function admin(
  env: unknown,
  method: string,
  path: string,
  body?: unknown,
  token: string | null = ROOT_ADMIN,
  host = "a.example.invalid",
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await worker.fetch(
    new Request(`https://${host}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
    env as never,
    ctx() as never,
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const tenantB = {
  display_name: "Northline Metal",
  status: "active",
  data_class: "synthetic",
  settings: { APP_PUBLIC_ORIGIN: `https://${HOST_B}`, APP_ALLOWED_ORIGINS: `https://${HOST_B}` },
  hosts: [HOST_B],
  secrets: { AGENT_HOST_TOKEN: "tenant-b-agent-token", INGEST_TOKEN: "tenant-b-ingest-token" },
};

test.beforeEach(() => resetTenantCache());

test("the registry is read and written only with the Worker's own ADMIN_TOKEN", async () => {
  const db = new SqliteD1();
  const env = rootEnv(db);
  assert.equal((await admin(env, "GET", "/admin/tenants", undefined, null)).status, 401);
  assert.equal((await admin(env, "GET", "/admin/tenants", undefined, "wrong")).status, 401);
  assert.equal((await admin(env, "PUT", `/admin/tenants/${TENANT_B}`, tenantB, "wrong")).status, 401);
  assert.deepEqual((await admin(env, "GET", "/admin/tenants")).body, { tenants: [] });
  // Without a root token the surface is closed, whatever a row might say.
  assert.equal((await admin(rootEnv(db, { ADMIN_TOKEN: "" }), "GET", "/admin/tenants")).status, 401);
});

test("a tenant is created with its hosts, settings and sealed secrets, and read back without secret values", async () => {
  const db = new SqliteD1();
  const env = rootEnv(db);
  const created = await admin(env, "PUT", `/admin/tenants/${TENANT_B}`, tenantB);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const record = created.body.tenant as Record<string, unknown>;
  assert.equal(record.tenant_id, TENANT_B);
  assert.equal(record.version, 1);
  assert.deepEqual(record.hosts, [HOST_B]);
  assert.deepEqual(record.settings, tenantB.settings);
  assert.deepEqual(record.secret_names, ["AGENT_HOST_TOKEN", "INGEST_TOKEN"]);
  assert.ok(!JSON.stringify(created.body).includes("tenant-b-agent-token"), "secret values never leave the Worker");

  const row = db.raw.prepare("SELECT settings_json, secrets_ciphertext, secrets_key_version FROM tenants WHERE tenant_id = ?")
    .get(TENANT_B) as { settings_json: string; secrets_ciphertext: string; secrets_key_version: number };
  assert.ok(!row.secrets_ciphertext.includes("tenant-b-agent-token"), "secrets are sealed at rest");
  assert.ok(!row.settings_json.includes("tenant-b-agent-token"));
  assert.equal(row.secrets_key_version, 1);
  assert.deepEqual(await openTenantSecrets(KEK, TENANT_B, 1, row.secrets_ciphertext), tenantB.secrets);

  const listed = await admin(env, "GET", "/admin/tenants");
  assert.equal((listed.body.tenants as unknown[]).length, 1);
  const one = await admin(env, "GET", `/admin/tenants/${TENANT_B}`);
  assert.equal(one.status, 200);
  assert.deepEqual((one.body.tenant as Record<string, unknown>).secret_names, ["AGENT_HOST_TOKEN", "INGEST_TOKEN"]);
  assert.equal((await admin(env, "GET", "/admin/tenants/no-such-tenant")).status, 404);

  // The write is live in this isolate at once: the host now resolves to the new tenant.
  const resolution = await resolveRequestTenant(new Request(`https://${HOST_B}/api/v1/session`), env as never);
  assert.equal(resolution.kind, "tenant");
  assert.equal((resolution as { env: Record<string, unknown> }).env.AGENT_HOST_TOKEN, "tenant-b-agent-token");
});

test("an update states the version it read; secrets are kept unless replaced, and emptied explicitly", async () => {
  const db = new SqliteD1();
  const env = rootEnv(db);
  assert.equal((await admin(env, "PUT", `/admin/tenants/${TENANT_B}`, tenantB)).status, 201);
  const { secrets: _secrets, ...withoutSecrets } = tenantB;

  const blind = await admin(env, "PUT", `/admin/tenants/${TENANT_B}`, withoutSecrets);
  assert.equal(blind.status, 409);
  assert.deepEqual(blind.body, { error: "expected_version_required", version: 1 });
  const stale = await admin(env, "PUT", `/admin/tenants/${TENANT_B}`, { ...withoutSecrets, expected_version: 7 });
  assert.deepEqual([stale.status, stale.body], [409, { error: "version_conflict", version: 1 }]);
  const fresh = await admin(env, "PUT", `/admin/tenants/${TENANT_B}`, { ...withoutSecrets, display_name: "Northline Metal Ltd", expected_version: 1 });
  assert.equal(fresh.status, 200);
  const record = fresh.body.tenant as Record<string, unknown>;
  assert.equal(record.version, 2);
  assert.equal(record.display_name, "Northline Metal Ltd");
  assert.deepEqual(record.secret_names, ["AGENT_HOST_TOKEN", "INGEST_TOKEN"], "an update without `secrets` keeps the envelope");
  assert.deepEqual(record.hosts, [HOST_B], "an update without `hosts` keeps the hosts");
  assert.deepEqual(record.settings, tenantB.settings, "an update without `settings` keeps the settings");

  const emptied = await admin(env, "PUT", `/admin/tenants/${TENANT_B}`, { ...withoutSecrets, secrets: {}, expected_version: 2 });
  assert.deepEqual((emptied.body.tenant as Record<string, unknown>).secret_names, []);
  const row = db.raw.prepare("SELECT secrets_ciphertext FROM tenants WHERE tenant_id = ?").get(TENANT_B) as { secrets_ciphertext: string | null };
  assert.equal(row.secrets_ciphertext, null);

  // A version on a row that does not exist is a conflict too, not a create.
  const phantom = await admin(env, "PUT", "/admin/tenants/phantom-co", { ...withoutSecrets, hosts: [], expected_version: 1 });
  assert.deepEqual([phantom.status, phantom.body], [409, { error: "version_conflict", version: null }]);
});

test("writes are validated: tenant-scoped names only, well-formed hosts, one owner per host", async () => {
  const db = new SqliteD1();
  const env = rootEnv(db);
  const base = { display_name: "X", status: "active", data_class: "synthetic" };
  const cases: Array<[string, unknown, string]> = [
    ["/admin/tenants/Bad_Tenant", base, "invalid_tenant_id"],
    [`/admin/tenants/${TENANT_B}`, { ...base, display_name: "" }, "invalid_display_name"],
    [`/admin/tenants/${TENANT_B}`, { ...base, status: "deleted" }, "invalid_status"],
    [`/admin/tenants/${TENANT_B}`, { ...base, data_class: "real" }, "invalid_data_class"],
    [`/admin/tenants/${TENANT_B}`, { ...base, settings: { EFFECT_RUNTIME_ENABLED: "true" } }, "setting_not_tenant_scoped"],
    [`/admin/tenants/${TENANT_B}`, { ...base, settings: { APP_LOCALE: 5 } }, "invalid_setting_value"],
    [`/admin/tenants/${TENANT_B}`, { ...base, secrets: { TENANT_SECRETS_KEK: "x" } }, "secret_not_tenant_scoped"],
    [`/admin/tenants/${TENANT_B}`, { ...base, secrets: { ADMIN_TOKEN: "x" } }, "secret_not_tenant_scoped"],
    [`/admin/tenants/${TENANT_B}`, { ...base, secrets: { QB_RECONCILIATION_ISSUER_API_KEY: "x" } }, "secret_not_tenant_scoped"],
    [`/admin/tenants/${TENANT_B}`, { ...base, settings: { NEWO_ENABLED: "true" } }, "setting_not_tenant_scoped"],
    [`/admin/tenants/${TENANT_B}`, { ...base, secrets: { INGEST_TOKEN: "" } }, "invalid_secret_value"],
    [`/admin/tenants/${TENANT_B}`, { ...base, hosts: ["Has.Upper.Case"] }, "invalid_host"],
    [`/admin/tenants/${TENANT_B}`, { ...base, hosts: ["b.example.invalid:8443"] }, "invalid_host"],
    [`/admin/tenants/${TENANT_B}`, { ...base, hosts: "b.example.invalid" }, "invalid_hosts"],
    [`/admin/tenants/${TENANT_B}`, { ...base, extra: true }, "invalid_body"],
    [`/admin/tenants/${TENANT_B}`, { ...base, expected_version: 0 }, "invalid_expected_version"],
  ];
  for (const [path, body, error] of cases) {
    const result = await admin(env, "PUT", path, body);
    assert.equal(result.status, 400, `${error}: ${JSON.stringify(result.body)}`);
    assert.equal(result.body.error, error);
  }
  assert.equal((await admin(env, "PUT", `/admin/tenants/${TENANT_B}`, "not an object")).status, 400);
  assert.equal((await admin(env, "POST", `/admin/tenants/${TENANT_B}`, base)).status, 405);
  assert.equal((await admin(env, "GET", `/admin/tenants/${TENANT_B}/hosts`)).status, 404);

  assert.equal((await admin(env, "PUT", `/admin/tenants/${TENANT_B}`, { ...base, hosts: [HOST_B] })).status, 201);
  const taken = await admin(env, "PUT", "/admin/tenants/other-co", { ...base, hosts: [HOST_B] });
  assert.deepEqual([taken.status, taken.body], [409, { error: "host_taken", host: HOST_B, tenant_id: TENANT_B }]);
  assert.equal(db.raw.prepare("SELECT count(*) AS n FROM tenants").get()!.n, 1, "a refused write creates nothing");
  // Re-stating the same host for its owner is fine; dropping it frees it.
  assert.equal((await admin(env, "PUT", `/admin/tenants/${TENANT_B}`, { ...base, hosts: [HOST_B, "b2.example.invalid"], expected_version: 1 })).status, 200);
  assert.equal((await admin(env, "PUT", `/admin/tenants/${TENANT_B}`, { ...base, hosts: [], expected_version: 2 })).status, 200);
  assert.equal((await admin(env, "PUT", "/admin/tenants/other-co", { ...base, hosts: [HOST_B] })).status, 201);
});

test("the Worker's own tenant takes hosts from the registry and nothing else", async () => {
  const db = new SqliteD1();
  const env = rootEnv(db);
  const base = { display_name: "IronWrap OS", status: "active", data_class: "business" };
  const settings = await admin(env, "PUT", `/admin/tenants/${TENANT}`, { ...base, settings: { APP_LOCALE: "fr-CA" } });
  assert.deepEqual([settings.status, settings.body.error], [400, "default_tenant_uses_worker_vars"]);
  const secrets = await admin(env, "PUT", `/admin/tenants/${TENANT}`, { ...base, secrets: { INGEST_TOKEN: "other" } });
  assert.deepEqual([secrets.status, secrets.body.error], [400, "default_tenant_uses_worker_vars"]);
  const suspended = await admin(env, "PUT", `/admin/tenants/${TENANT}`, { ...base, status: "suspended" });
  assert.deepEqual([suspended.status, suspended.body.error], [400, "default_tenant_always_active"]);
  const hosts = await admin(env, "PUT", `/admin/tenants/${TENANT}`, { ...base, hosts: ["a.example.invalid", "www.a.example.invalid"] });
  assert.equal(hosts.status, 201);
  const resolution = await resolveRequestTenant(new Request("https://www.a.example.invalid/api/v1/session"), env as never);
  assert.equal(resolution.kind, "default");
});

test("sealing secrets needs the Worker key; the registry itself does not", async () => {
  const db = new SqliteD1();
  const noKey = rootEnv(db, { TENANT_SECRETS_KEK: "" });
  const withSecrets = await admin(noKey, "PUT", `/admin/tenants/${TENANT_B}`, tenantB);
  assert.deepEqual([withSecrets.status, withSecrets.body], [503, { error: "tenant_secrets_kek_missing" }]);
  const { secrets: _secrets, ...withoutSecrets } = tenantB;
  assert.equal((await admin(noKey, "PUT", `/admin/tenants/${TENANT_B}`, withoutSecrets)).status, 201);
  const badKey = rootEnv(db, { TENANT_SECRETS_KEK: "not-a-key" });
  const sealed = await admin(badKey, "PUT", `/admin/tenants/${TENANT_B}`, { ...tenantB, expected_version: 1 });
  assert.deepEqual([sealed.status, sealed.body], [503, { error: "tenant_secrets_kek_invalid" }]);
});

test("ADMIN_TOKEN is the hosting operator's on every host; the registry is dark with the flag off", async () => {
  const db = new SqliteD1();
  const env = rootEnv(db);
  assert.equal((await admin(env, "PUT", `/admin/tenants/${TENANT_B}`, tenantB)).status, 201);
  // On tenant B's host the Worker's own ADMIN_TOKEN still opens /admin/*: those routes read
  // tables that carry no tenant column, so they belong to the operator, never to a tenant.
  const envelopes = await worker.fetch(
    new Request(`https://${HOST_B}/admin/envelopes?limit=1`, { headers: { authorization: `Bearer ${ROOT_ADMIN}` } }),
    env as never,
    ctx() as never,
  );
  assert.equal(envelopes.status, 200);
  assert.equal((await admin(env, "GET", "/admin/tenants", undefined, ROOT_ADMIN, HOST_B)).status, 200);
  assert.equal((await admin(env, "GET", "/admin/tenants", undefined, "tenant-b-ingest-token", HOST_B)).status, 401);

  const off = rootEnv(db, { APP_MULTI_TENANT_ENABLED: "false" });
  assert.equal((await admin(off, "GET", "/admin/tenants")).status, 404);
  assert.equal((await admin(off, "PUT", "/admin/tenants/other-co", { display_name: "X", status: "active", data_class: "synthetic" })).status, 404);
  assert.equal(db.raw.prepare("SELECT count(*) AS n FROM tenants").get()!.n, 1);
});

test("a write that lost the race is refused whole: no mixed row, no host change", async () => {
  const db = new SqliteD1();
  // Another operator commits version 2 between this handler's read and its batch.
  let raced = false;
  const racing = {
    prepare: (sql: string) => db.prepare(sql),
    async batch(statements: unknown[]) {
      if (!raced) {
        raced = true;
        db.raw.prepare("UPDATE tenants SET display_name = 'Other operator', version = 2, write_id = 'other-operator-write' WHERE tenant_id = ?").run(TENANT_B);
      }
      return await db.batch(statements as never);
    },
  };
  const env = rootEnv(racing as never);
  assert.equal((await admin(rootEnv(db), "PUT", `/admin/tenants/${TENANT_B}`, { ...tenantB, secrets: undefined })).status, 201);
  const lost = await admin(env, "PUT", `/admin/tenants/${TENANT_B}`, {
    display_name: "Mine",
    status: "active",
    data_class: "synthetic",
    hosts: ["evil.example.invalid"],
    expected_version: 1,
  });
  assert.deepEqual([lost.status, lost.body], [409, { error: "version_conflict", version: 2 }]);
  const row = db.raw.prepare("SELECT display_name, version FROM tenants WHERE tenant_id = ?").get(TENANT_B) as { display_name: string; version: number };
  assert.deepEqual({ ...row }, { display_name: "Other operator", version: 2 });
  const hosts = (db.raw.prepare("SELECT host FROM tenant_hosts WHERE tenant_id = ? ORDER BY host").all(TENANT_B) as Array<{ host: string }>).map((h) => h.host);
  assert.deepEqual(hosts, [HOST_B], "the loser's hosts never landed");
});

test("the row tools/qa-tenant-register.mjs derives from a committed tenant config is accepted by the registry", async () => {
  const db = new SqliteD1();
  const env = rootEnv(db);
  const tenant = loadTenantConfig("northline-metal");
  const body = registrationBody(tenant, { hosts: ["qa-iwrap-northline.mindburn.org"] });
  const created = await admin(env, "PUT", `/admin/tenants/${tenant.tenant.id}`, body);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const record = created.body.tenant as Record<string, unknown>;
  assert.deepEqual(record.hosts, ["qa-iwrap-northline.mindburn.org"]);
  assert.equal(record.data_class, "synthetic");
  assert.deepEqual(Object.keys(record.settings as Record<string, string>).sort(), Object.keys(body.settings).sort(), "every derived setting is a tenant-scoped name");
  // The host then answers as that tenant.
  const resolution = await resolveRequestTenant(new Request("https://qa-iwrap-northline.mindburn.org/api/v1/session"), env as never);
  assert.equal(resolution.kind, "tenant");
  assert.equal((resolution as { env: Record<string, unknown> }).env.APP_TENANT_NAME, "Northline Metal OS");
});

test("a D1 failure during the write is the registry being unavailable, not another writer's conflict", async () => {
  const db = new SqliteD1();
  const failing = (error: Error) => ({
    prepare: (sql: string) => db.prepare(sql),
    async batch(): Promise<never> {
      throw error;
    },
  });
  const body = { ...tenantB, secrets: undefined };
  // The account's D1 quota, an outage or a network failure: 503, so the operator retries later.
  const quota = await admin(rootEnv(failing(new Error("D1_ERROR: Your account has exceeded D1's free tier daily row read limit. [code: 7500]")) as never), "PUT", `/admin/tenants/${TENANT_B}`, body);
  assert.deepEqual([quota.status, quota.body], [503, { error: "tenant_registry_unavailable" }]);
  const network = await admin(rootEnv(failing(new TypeError("fetch failed")) as never), "PUT", `/admin/tenants/${TENANT_B}`, body);
  assert.equal(network.status, 503);
  // A constraint the row failed, or a concurrent create's primary-key clash: this write's conflict.
  const clash = await admin(rootEnv(failing(new Error("D1_ERROR: UNIQUE constraint failed: tenants.tenant_id: SQLITE_CONSTRAINT")) as never), "PUT", `/admin/tenants/${TENANT_B}`, body);
  assert.deepEqual([clash.status, clash.body], [409, { error: "tenant_write_conflict" }]);
  assert.equal(db.raw.prepare("SELECT count(*) AS n FROM tenants WHERE tenant_id = ?").get(TENANT_B)!.n, 0, "nothing was written");
});
