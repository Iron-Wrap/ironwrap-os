import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RegisterGuardError,
  loadTenantConfig,
  parseArgs,
  register,
  registrationBody,
  resolveSecrets,
} from "./qa-tenant-register.mjs";

const WRANGLER = join(process.cwd(), "workers-bus", "wrangler.jsonc");

/** A repo root holding one synthetic tenant config and one live one. */
function configRoot() {
  const root = mkdtempSync(join(tmpdir(), "qa-tenant-register-"));
  mkdirSync(join(root, "config", "tenants"), { recursive: true });
  writeFileSync(join(root, "config", "tenants", "northline-metal.json"), JSON.stringify({
    tenant: { id: "northline-metal", display_name: "Northline Metal Roofing (synthetic)", status: "demo" },
    runtime: { app_tenant_name: "Northline Metal OS" },
    brand: { name: "Northline Metal", brands: [{ key: "northline", sender_mailbox: "hello@northline-metal.example", sender_domain: "northline-metal.example" }] },
    locale: { language_tag: "en-CA", timezone: "America/Edmonton", currency: "CAD" },
  }));
  writeFileSync(join(root, "config", "tenants", "ironwrap.json"), JSON.stringify({
    tenant: { id: "ironwrap", display_name: "IronWrap OS", status: "live" },
    runtime: { app_tenant_name: "IronWrap OS" },
    brand: { name: "IronWrap", brands: [{ key: "ironwrap", sender_mailbox: "sales@example.invalid", sender_domain: "example.invalid" }] },
    locale: { language_tag: "en-CA", timezone: "America/Edmonton", currency: "CAD" },
  }));
  return root;
}

function fakeWorker(initial = null) {
  const calls = [];
  let record = initial;
  const fetcher = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: init.method, auth: init.headers?.authorization, body: init.body ? JSON.parse(init.body) : null });
    if (init.headers?.authorization !== "Bearer qa-admin-token") return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    if (init.method === "GET") {
      return record
        ? new Response(JSON.stringify({ tenant: record }), { status: 200 })
        : new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    }
    const body = JSON.parse(init.body);
    const created = record === null;
    if (record && body.expected_version !== record.version) return new Response(JSON.stringify({ error: "version_conflict", version: record.version }), { status: 409 });
    record = {
      tenant_id: path.split("/").pop(),
      display_name: body.display_name,
      status: body.status,
      data_class: body.data_class,
      settings: body.settings,
      hosts: body.hosts,
      secret_names: body.secrets ? Object.keys(body.secrets).sort() : (record?.secret_names ?? []),
      version: (record?.version ?? 0) + 1,
    };
    return new Response(JSON.stringify({ tenant: record }), { status: created ? 201 : 200 });
  };
  return { fetcher, calls, current: () => record };
}

test("arguments: env or loopback base url, one or more hosts, secrets by environment variable name", () => {
  const args = parseArgs(["--env", "qa", "--tenant", "northline-metal", "--host", "a.example.invalid", "--host", "b.example.invalid", "--secret", "INGEST_TOKEN=QA_T", "--dry-run", "--json"]);
  assert.deepEqual(args, { env: "qa", baseUrl: undefined, tenant: "northline-metal", hosts: ["a.example.invalid", "b.example.invalid"], secrets: ["INGEST_TOKEN=QA_T"], dataClass: "synthetic", dryRun: true, json: true });
  assert.throws(() => parseArgs(["--tenant"]), /needs a value/);
  assert.throws(() => parseArgs(["--token", "x"]), /unknown argument/);
  assert.deepEqual(resolveSecrets(["INGEST_TOKEN=QA_T"], { QA_T: "sealed-value" }), { INGEST_TOKEN: "sealed-value" });
  assert.throws(() => resolveSecrets(["INGEST_TOKEN=QA_T"], {}), /is empty/);
  assert.throws(() => resolveSecrets(["INGEST_TOKEN=secret-value"], {}), /NAME=ENV_VAR/);
  assert.equal(resolveSecrets([], {}), null);
});

test("the live tenant's config, an unknown id and a malformed id are refused", () => {
  const root = configRoot();
  assert.equal(loadTenantConfig("northline-metal", root).tenant.id, "northline-metal");
  assert.throws(() => loadTenantConfig("ironwrap", root), /live tenant/);
  assert.throws(() => loadTenantConfig("no-such-tenant", root), /could not be read/);
  assert.throws(() => loadTenantConfig("Bad Id", root), RegisterGuardError);
});

test("the registry row is derived from the tenant config and the hosts, with tenant-scoped names only", () => {
  const tenant = loadTenantConfig("northline-metal", configRoot());
  const body = registrationBody(tenant, { hosts: ["qa-iwrap-northline.mindburn.org"], dataClass: "synthetic", expectedVersion: 2, secrets: { INGEST_TOKEN: "x" } });
  assert.equal(body.display_name, "Northline Metal Roofing (synthetic)");
  assert.equal(body.status, "active");
  assert.equal(body.data_class, "synthetic");
  assert.equal(body.expected_version, 2);
  assert.deepEqual(body.hosts, ["qa-iwrap-northline.mindburn.org"]);
  assert.deepEqual(body.settings, {
    APP_TENANT_NAME: "Northline Metal OS",
    APP_TENANT_BRAND: "Northline Metal",
    APP_LOCALE: "en-CA",
    APP_TIME_ZONE: "America/Edmonton",
    APP_CURRENCY: "CAD",
    FROM_EMAIL: "hello@northline-metal.example",
    OWNER_ALERT_EMAIL: "hello@northline-metal.example",
    BACKUP_ALERT_EMAIL: "hello@northline-metal.example",
    APP_PUBLIC_ORIGIN: "https://qa-iwrap-northline.mindburn.org",
    APP_ALLOWED_ORIGINS: "https://qa-iwrap-northline.mindburn.org",
    PUBLIC_ESTIMATE_ALLOWED_ORIGINS: "https://qa-iwrap-northline.mindburn.org",
    PUBLIC_ESTIMATE_ALLOWED_BRANDS: "northline",
    AGENT_DATA_CLASS: "synthetic",
  });
  assert.throws(() => registrationBody(tenant, { hosts: [], dataClass: "synthetic" }), /at least one --host/);
  assert.throws(() => registrationBody(tenant, { hosts: ["Has.Upper"], dataClass: "synthetic" }), /not a lowercase hostname/);
  assert.throws(() => registrationBody(tenant, { hosts: ["a.example.invalid"], dataClass: "real" }), /synthetic or business/);
});

test("registration creates, re-runs as a no-op, updates with the version it read, and never prints a secret", async () => {
  const root = configRoot();
  const worker = fakeWorker();
  const environment = { ADMIN_TOKEN: "qa-admin-token", QA_T: "sealed-ingest" };
  const argv = ["--env", "qa", "--tenant", "northline-metal", "--host", "qa-iwrap-northline.mindburn.org"];

  const created = await register({ argv: [...argv, "--secret", "INGEST_TOKEN=QA_T"], environment, fetcher: worker.fetcher, configPath: WRANGLER, configRoot: root });
  assert.equal(created.outcome, "created");
  assert.equal(created.version, 1);
  assert.deepEqual(created.secret_names, ["INGEST_TOKEN"]);
  assert.ok(!JSON.stringify(created).includes("sealed-ingest"), "the report never carries a secret value");
  assert.equal(worker.calls.filter((call) => call.method === "PUT").length, 1);
  assert.equal(worker.calls.find((call) => call.method === "PUT").body.expected_version, undefined);
  assert.equal(created.target.env, "qa");
  assert.match(created.target.base_url, /^https:\/\//);

  const again = await register({ argv, environment, fetcher: worker.fetcher, configPath: WRANGLER, configRoot: root });
  assert.equal(again.outcome, "unchanged");
  assert.equal(worker.calls.filter((call) => call.method === "PUT").length, 1, "a re-run writes nothing");

  const moved = await register({ argv: [...argv, "--host", "qa-iwrap-northline-2.mindburn.org"], environment, fetcher: worker.fetcher, configPath: WRANGLER, configRoot: root });
  assert.equal(moved.outcome, "updated");
  assert.equal(moved.version, 2);
  const update = worker.calls.filter((call) => call.method === "PUT").at(-1);
  assert.equal(update.body.expected_version, 1, "the update states the version it read");
  assert.equal(update.body.secrets, undefined, "a run without --secret keeps the sealed envelope");
  assert.deepEqual(worker.current().hosts, ["qa-iwrap-northline.mindburn.org", "qa-iwrap-northline-2.mindburn.org"]);

  const dry = await register({ argv: [...argv, "--dry-run"], environment, fetcher: worker.fetcher, configPath: WRANGLER, configRoot: root });
  assert.equal(dry.outcome, "dry_run");
  assert.equal(worker.calls.filter((call) => call.method === "PUT").length, 2);
});

test("refusals happen before any write: production, the live tenant, the Worker's own tenant, a missing token, a dark registry", async () => {
  const root = configRoot();
  const worker = fakeWorker();
  const base = { fetcher: worker.fetcher, configPath: WRANGLER, configRoot: root };
  const host = ["--host", "qa-iwrap-northline.mindburn.org"];
  await assert.rejects(register({ argv: ["--env", "production", "--tenant", "northline-metal", ...host], environment: { ADMIN_TOKEN: "x" }, ...base }), /production/);
  await assert.rejects(register({ argv: ["--env", "qa", "--tenant", "ironwrap", ...host], environment: { ADMIN_TOKEN: "x" }, ...base }), /live tenant/);
  await assert.rejects(register({ argv: ["--env", "qa", "--tenant", "northline-metal", ...host], environment: {}, ...base }), /ADMIN_TOKEN must be set/);
  await assert.rejects(register({ argv: ["--env", "qa", "--tenant", "northline-metal", ...host], environment: { ADMIN_TOKEN: "wrong" }, ...base }), /refused by the Worker/);
  assert.equal(worker.calls.filter((call) => call.method === "PUT").length, 0, "nothing was written");

  const dark = async (url, init) => new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
  await assert.rejects(
    register({ argv: ["--env", "qa", "--tenant", "northline-metal", ...host], environment: { ADMIN_TOKEN: "qa-admin-token" }, fetcher: dark, configPath: WRANGLER, configRoot: root }),
    /registry surface is dark/,
  );
});
