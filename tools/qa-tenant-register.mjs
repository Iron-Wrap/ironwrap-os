#!/usr/bin/env node
// qa-tenant-register.mjs — register one synthetic tenant on a non-production Worker's tenant
// registry (workers-bus/src/tenant-admin.ts), idempotently, from its committed tenant config.
//
// The shared multi-tenant Worker resolves the tenant per request from the hostname; a second
// tenant exists once a `tenants` row and its `tenant_hosts` rows do. This tool derives the row's
// settings from `config/tenants/<tenant>.json` (the same contract a white-label clone is rendered
// from), states the hostnames the operator's proxy will serve for it, and PUTs the row with the
// version it read, so a re-run is a no-op and two operators cannot overwrite each other.
//
// Guards, in the order they run and before any write:
//   1. the target is `--env <non-production>` (resolved from workers-bus/wrangler.jsonc by the
//      same guard tools/seed-env.mjs uses) or a loopback `--base-url`; production is never a
//      selectable target;
//   2. ADMIN_TOKEN comes from the environment only, never an argument, never printed;
//   3. the tenant id names a committed config whose status is not `live`, and is not the Worker's
//      own tenant (that one is configured by vars);
//   4. secret values come from named environment variables (`--secret NAME=ENV_VAR`), so no value
//      is ever an argument; only tenant-scoped names are accepted, by the Worker;
//   5. the row keeps what an operator set by hand: settings the config does not derive stay, a
//      suspension stays unless `--activate` is passed, and sealed secrets stay unless replaced.
//
// Usage:
//   ADMIN_TOKEN=... node tools/qa-tenant-register.mjs --env qa --tenant northline-metal \
//     --host qa-iwrap-northline.mindburn.org [--secret INGEST_TOKEN=QA_NORTHLINE_INGEST_TOKEN] \
//     [--activate] [--dry-run] [--json]
//
// Exit codes: 0 registered or unchanged, 1 refused before any write, 2 usage, 3 the write failed.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { TENANT_ID_PATTERN } from "./generate-tenant-worker-config.mjs";
import { SeedGuardError, loadWranglerConfig, resolveTarget } from "./seed-env.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export class RegisterGuardError extends Error {}

export function parseArgs(argv) {
  const args = { env: undefined, baseUrl: undefined, tenant: undefined, hosts: [], secrets: [], activate: false, dryRun: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new RegisterGuardError(`${arg} needs a value`);
      index += 1;
      return value;
    };
    if (arg === "--env") args.env = next();
    else if (arg === "--base-url") args.baseUrl = next();
    else if (arg === "--tenant") args.tenant = next();
    else if (arg === "--host") args.hosts.push(next());
    else if (arg === "--secret") args.secrets.push(next());
    else if (arg === "--activate") args.activate = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--json") args.json = true;
    else throw new RegisterGuardError(`unknown argument ${JSON.stringify(arg)}`);
  }
  return args;
}

/** The tenant config at config/tenants/<id>.json, refused when it is the live tenant's. */
export function loadTenantConfig(tenantId, configRoot = root) {
  if (typeof tenantId !== "string" || !TENANT_ID_PATTERN.test(tenantId)) {
    throw new RegisterGuardError(`--tenant ${JSON.stringify(tenantId)} is not a tenant id (${TENANT_ID_PATTERN})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(join(configRoot, "config", "tenants", `${tenantId}.json`), "utf8"));
  } catch (error) {
    throw new RegisterGuardError(`config/tenants/${tenantId}.json could not be read: ${error.message}`);
  }
  if (parsed?.tenant?.id !== tenantId) throw new RegisterGuardError(`config/tenants/${tenantId}.json names tenant ${JSON.stringify(parsed?.tenant?.id)}`);
  if (parsed.tenant.status === "live") {
    throw new RegisterGuardError(`${tenantId} is a live tenant; this tool registers synthetic or demo tenants only`);
  }
  return parsed;
}

/**
 * The registry row body: the settings this tool derives from the config laid over the settings
 * the row already holds (an operator's hand-set keys stay), the hosts, the synthetic data class,
 * and the row's current status unless `activate` is asked for.
 */
export function registrationBody(tenant, { hosts, expectedVersion = null, secrets = null, current = null, activate = false }) {
  if (!Array.isArray(hosts) || hosts.length === 0) throw new RegisterGuardError("at least one --host is required: a tenant with no hostname is unreachable");
  for (const host of hosts) {
    if (!HOST_RE.test(host)) throw new RegisterGuardError(`--host ${JSON.stringify(host)} is not a lowercase hostname`);
  }
  const dataClass = "synthetic";
  const brand = tenant.brand?.brands?.[0];
  const origins = hosts.map((host) => `https://${host}`);
  const settings = {
    APP_TENANT_NAME: tenant.runtime?.app_tenant_name,
    APP_TENANT_BRAND: tenant.brand?.name,
    APP_LOCALE: tenant.locale?.language_tag,
    APP_TIME_ZONE: tenant.locale?.timezone,
    APP_CURRENCY: tenant.locale?.currency,
    FROM_EMAIL: brand?.sender_mailbox,
    OWNER_ALERT_EMAIL: brand?.sender_mailbox,
    BACKUP_ALERT_EMAIL: brand?.sender_mailbox,
    APP_PUBLIC_ORIGIN: origins[0],
    APP_ALLOWED_ORIGINS: origins.join(","),
    PUBLIC_ESTIMATE_ALLOWED_ORIGINS: origins.join(","),
    PUBLIC_ESTIMATE_ALLOWED_BRANDS: (tenant.brand?.brands ?? []).map((entry) => entry.key).join(","),
    AGENT_DATA_CLASS: dataClass,
  };
  for (const [name, value] of Object.entries(settings)) {
    if (typeof value !== "string" || value.trim() === "") throw new RegisterGuardError(`config/tenants/${tenant.tenant.id}.json leaves ${name} empty`);
  }
  const body = {
    display_name: tenant.tenant.display_name ?? tenant.runtime?.app_tenant_name,
    status: current && !activate ? current.status : "active",
    data_class: dataClass,
    settings: { ...(current?.settings ?? {}), ...settings },
    hosts,
  };
  if (expectedVersion !== null) body.expected_version = expectedVersion;
  if (secrets !== null) body.secrets = secrets;
  return body;
}

/** `NAME=ENV_VAR` pairs resolved from the environment; a missing variable refuses before any write. */
export function resolveSecrets(pairs, environment) {
  if (pairs.length === 0) return null;
  const secrets = {};
  for (const pair of pairs) {
    const match = pair.match(/^([A-Z][A-Z0-9_]+)=([A-Za-z_][A-Za-z0-9_]*)$/);
    if (!match) throw new RegisterGuardError(`--secret ${JSON.stringify(pair)} is not NAME=ENV_VAR`);
    const value = environment[match[2]];
    if (typeof value !== "string" || value.length === 0) throw new RegisterGuardError(`--secret ${match[1]}: environment variable ${match[2]} is empty`);
    secrets[match[1]] = value;
  }
  return secrets;
}

async function request(baseUrl, path, init, adminToken, fetcher) {
  const response = await fetcher(`${baseUrl}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${adminToken}` },
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

export async function register({ argv, environment, fetcher = fetch, configPath = join(root, "workers-bus", "wrangler.jsonc"), configRoot = root }) {
  const args = parseArgs(argv);
  const config = loadWranglerConfig(configPath);
  const target = resolveTarget({ config, env: args.env, baseUrl: args.baseUrl });
  const adminToken = environment.ADMIN_TOKEN;
  if (typeof adminToken !== "string" || adminToken.length === 0) throw new RegisterGuardError("ADMIN_TOKEN must be set in the environment");
  const tenant = loadTenantConfig(args.tenant, configRoot);
  if (tenant.tenant.id === target.tenantId) {
    throw new RegisterGuardError(`${tenant.tenant.id} is env.${target.envName}'s own tenant, configured by its vars; the registry takes hosts for it only`);
  }
  const secrets = resolveSecrets(args.secrets, environment);

  const existing = await request(target.baseUrl, `/admin/tenants/${tenant.tenant.id}`, { method: "GET" }, adminToken, fetcher);
  if (existing.status === 404 && existing.body?.error === "not_found" && existing.body?.tenant === undefined) {
    // Either the tenant is new or the registry surface is dark (flag off): the write tells which.
  } else if (existing.status === 401) {
    throw new RegisterGuardError("ADMIN_TOKEN was refused by the Worker");
  } else if (existing.status !== 200 && existing.status !== 404) {
    throw new RegisterGuardError(`GET /admin/tenants/${tenant.tenant.id} answered ${existing.status}`);
  }
  const current = existing.status === 200 ? existing.body?.tenant : null;
  const body = registrationBody(tenant, {
    hosts: args.hosts,
    expectedVersion: current ? current.version : null,
    secrets,
    current,
    activate: args.activate,
  });
  const unchanged = current
    && current.display_name === body.display_name
    && current.status === body.status
    && current.data_class === body.data_class
    && JSON.stringify(current.settings) === JSON.stringify(body.settings)
    && JSON.stringify([...current.hosts].sort()) === JSON.stringify([...body.hosts].sort())
    && secrets === null;
  const report = {
    target: { env: target.envName, base_url: target.baseUrl },
    tenant_id: tenant.tenant.id,
    hosts: body.hosts,
    settings: body.settings,
    status: body.status,
    data_class: body.data_class,
    secret_names: secrets ? Object.keys(secrets).sort() : [],
    existing_version: current?.version ?? null,
    outcome: args.dryRun ? "dry_run" : unchanged ? "unchanged" : current ? "updated" : "created",
    version: current?.version ?? null,
  };
  if (args.dryRun || unchanged) return report;

  const written = await request(target.baseUrl, `/admin/tenants/${tenant.tenant.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, adminToken, fetcher);
  if (written.status === 404) {
    throw new RegisterGuardError("the registry surface is dark on this Worker: APP_MULTI_TENANT_ENABLED is not true there");
  }
  if (written.status !== 200 && written.status !== 201) {
    const error = new Error(`PUT /admin/tenants/${tenant.tenant.id} answered ${written.status}: ${JSON.stringify(written.body ?? null)}`);
    error.exitCode = 3;
    throw error;
  }
  report.version = written.body?.tenant?.version ?? null;
  report.secret_names = written.body?.tenant?.secret_names ?? report.secret_names;
  return report;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const json = process.argv.includes("--json");
  try {
    const report = await register({ argv: process.argv.slice(2), environment: process.env });
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`${report.outcome}: tenant ${report.tenant_id} on ${report.target.env ?? report.target.base_url} (version ${report.version ?? "new"})`);
      for (const host of report.hosts) console.log(`  host ${host}`);
      if (report.secret_names.length > 0) console.log(`  secrets ${report.secret_names.join(", ")}`);
    }
    process.exitCode = 0;
  } catch (error) {
    if (error instanceof RegisterGuardError || error instanceof SeedGuardError) {
      console.error(`refused: ${error.message}`);
      process.exitCode = error instanceof RegisterGuardError && /needs a value|unknown argument/.test(error.message) ? 2 : 1;
    } else {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = error?.exitCode ?? 3;
    }
  }
}
