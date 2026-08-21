#!/usr/bin/env node
// Render a tenant-owned Worker config from workers-bus/wrangler.jsonc.
//
// Playbook step 2 is "duplicate wrangler.jsonc and re-point every binding at NEW tenant-owned
// resources". Done by hand that is a 128-var copy in which the bindings that matter (D1, R2,
// queues) are three lines and the ones that leak are scattered through the vars: an
// ERPNEXT_BASE_URL still naming the first tenant's Frappe, an ERPNEXT_INTEGRATION_USER still
// naming its bus identity, a FROM_EMAIL still on its domain. Every one of those is a silent
// cross-tenant reference that boots green.
//
// So the tenant config is DERIVED rather than copied: the whole `local` environment is carried
// over (feature flags, timeouts, schema hashes - things that are product facts, not tenant
// facts), and every value this file knows to be tenant-scoped is replaced. A var that names
// the source tenant and is not in TENANT_SCOPED_VARS below fails the audit at the bottom, so a
// new tenant-bearing var added to wrangler.jsonc cannot silently ride along into a clone.
//
// It provisions NOTHING. Real Cloudflare resources (account, D1, R2, queues, routes, secrets)
// are an owner action; this emits the exact commands and returns them as a hand-off list.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Placeholder D1 id: shaped like a real one so wrangler parses it, obviously not a real one. */
export const UNPROVISIONED_DATABASE_ID = "00000000-0000-0000-0000-000000000000";

/**
 * A tenant id is also a Cloudflare resource prefix (`<id>-bus`, `<id>-bus-raw`), a Frappe site
 * prefix and a config filename, so the same shape is required in three places:
 * `deploy/clone-tenant.sh`, `tools/generate-tenant-config.mjs`, and here.
 *
 * Checked again here on purpose rather than imported from one of the others (ELEC-143 finding
 * 4): this generator was safe only because its single caller happened to validate first, which
 * is a property of the caller, not of this file. A test asserts all three literals still agree.
 */
export const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

/** Strip `//` and block comments from JSONC without touching comment-like text inside strings. */
export function stripJsonComments(source) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      out += "\n";
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }
    out += char;
  }
  return out;
}

/** Rename a shared resource onto the tenant's own namespace. */
export function tenantResourceName(name, tenantId, sourceTenantId) {
  if (name.startsWith(`${sourceTenantId}-`)) return `${tenantId}-${name.slice(sourceTenantId.length + 1)}`;
  return `${tenantId}-${name}`;
}

/**
 * Every `local` var whose value belongs to one tenant. `derive` gets the tenant config, the
 * runtime ports and the source value; returning undefined drops the var.
 */
export const TENANT_SCOPED_VARS = Object.freeze({
  APP_TENANT_ID: ({ tenant }) => tenant.tenant.id,
  APP_TENANT_NAME: ({ tenant }) => tenant.runtime.app_tenant_name,
  APP_TENANT_BRAND: ({ tenant }) => tenant.brand.name,
  APP_LOCALE: ({ tenant }) => tenant.locale.language_tag,
  APP_TIME_ZONE: ({ tenant }) => tenant.locale.timezone,
  APP_CURRENCY: ({ tenant }) => tenant.locale.currency,
  FROM_EMAIL: ({ tenant }) => tenant.brand.brands[0].sender_mailbox,
  OWNER_ALERT_EMAIL: ({ tenant }) => tenant.brand.brands[0].sender_mailbox,
  BACKUP_ALERT_EMAIL: ({ tenant }) => tenant.brand.brands[0].sender_mailbox,
  ERPNEXT_BASE_URL: ({ runtime }) => runtime.frappeBaseUrl,
  ERPNEXT_INTEGRATION_USER: ({ runtime }) => `ironwrap-bus@${runtime.identityDomain}`,
  QB_RECONCILIATION_ISSUER_USER: ({ runtime }) => `ironwrap-quickbooks-issuer@${runtime.identityDomain}`,
  APP_APPROVAL_APPROVER_ID: ({ runtime }) => `owner@${runtime.identityDomain}`,
  APP_PRODUCTION_SCHEDULE_APPROVER_ID: ({ runtime }) => `owner@${runtime.identityDomain}`,
  APP_PUBLIC_ORIGIN: ({ runtime }) => runtime.workerOrigin,
  APP_ALLOWED_ORIGINS: ({ runtime }) => runtime.workerOrigin,
  PUBLIC_ESTIMATE_ALLOWED_ORIGINS: ({ runtime }) => runtime.workerOrigin,
  PUBLIC_ESTIMATE_ALLOWED_BRANDS: ({ tenant }) => tenant.brand.brands.map((brand) => brand.key).join(","),
  APP_APPROVAL_BROKER_URL: ({ runtime }) => `http://127.0.0.1:${runtime.brokerPorts.approval}`,
  APP_QUOTE_REVISION_BROKER_URL: ({ runtime }) => `http://127.0.0.1:${runtime.brokerPorts.quoteRevision}`,
  APP_PRODUCTION_SCHEDULE_BROKER_URL: ({ runtime }) => `http://127.0.0.1:${runtime.brokerPorts.productionSchedule}`,
  APP_PROPOSAL_PUBLICATION_BROKER_URL: ({ runtime }) => `http://127.0.0.1:${runtime.brokerPorts.proposalPublication}`,
  // Facet v2 routes bind a signed delivery to one destination tenant and one public https
  // origin, so a copied route would deliver another tenant's design events here. The rail
  // stays off until the owner registers this tenant's own route (hand-off below).
  FACET_V2_ROUTES_JSON: () => "[]",
  FACET_V2_INGEST_ENABLED: () => "false",
  FACET_V2_FRAPPE_PROJECTION_ENABLED: () => "false",
  APP_FACET_LAUNCH_ENABLED: () => "false",
  APP_FACET_LAUNCH_SOURCE_TENANT_ID: () => "",
  // The tenant's own Shared Drives are created in the tenant's own Google workspace.
  SHARED_DRIVE_ID_JOBS: () => "",
  SHARED_DRIVE_ID_RESTRICTED: () => "",
  SHARED_DRIVE_ID_ARCHIVE: () => "",
  // One approved QuickBooks company per tenant; never inherited.
  QB_EXPECTED_REALM_ID: () => "",
});

/**
 * Which slice of wrangler.jsonc a clone is derived from. `default` is the top level, which is
 * the deployed shape a real tenant wants; `local` is the dev environment, which is what a
 * local isolation proof wants. wrangler does not inherit `vars` into an environment, so these
 * genuinely differ, and picking the wrong one silently ships dev flags to a tenant.
 */
export function sourceEnvironment(base, sourceEnv) {
  if (!sourceEnv || sourceEnv === "default") {
    return {
      workers_dev: base.workers_dev,
      d1_databases: base.d1_databases,
      r2_buckets: base.r2_buckets,
      queues: base.queues,
      vars: base.vars,
    };
  }
  const environment = base.env?.[sourceEnv];
  if (!environment) throw new Error(`wrangler config has no env.${sourceEnv} to derive from`);
  return environment;
}

export function generateTenantWorkerConfig({ base, sourceEnv = "local", tenant, runtime }) {
  const environment = sourceEnvironment(base, sourceEnv);
  const sourceTenantId = environment.vars?.APP_TENANT_ID;
  if (!sourceTenantId) throw new Error(`source environment ${sourceEnv} declares no APP_TENANT_ID`);
  const tenantId = tenant?.tenant?.id;
  if (typeof tenantId !== "string" || !TENANT_ID_PATTERN.test(tenantId)) {
    // An unchecked id reaches wrangler as a resource name and this repo as a filename. `../x`
    // or an empty string would produce a config naming resources nobody meant to create.
    throw new Error(
      `tenant id ${JSON.stringify(tenantId)} must be lowercase alphanumeric with hyphens (${TENANT_ID_PATTERN}): it is also a Cloudflare resource prefix and a site prefix`,
    );
  }
  if (tenantId === sourceTenantId) throw new Error(`tenant ${tenantId} is the source tenant, not a clone of it`);

  const vars = {};
  for (const [name, value] of Object.entries(environment.vars)) {
    const derive = TENANT_SCOPED_VARS[name];
    vars[name] = derive ? derive({ tenant, runtime, value }) : value;
  }

  const config = {
    $schema: base.$schema,
    name: `${tenantId}-bus`,
    main: base.main,
    compatibility_date: base.compatibility_date,
    compatibility_flags: base.compatibility_flags,
    observability: base.observability,
    assets: base.assets,
    triggers: base.triggers,
    workers_dev: environment.workers_dev,
    d1_databases: environment.d1_databases.map((database) => ({
      ...database,
      database_name: tenantResourceName(database.database_name, tenantId, sourceTenantId),
      database_id: UNPROVISIONED_DATABASE_ID,
    })),
    r2_buckets: environment.r2_buckets.map((bucket) => ({
      ...bucket,
      bucket_name: tenantResourceName(bucket.bucket_name, tenantId, sourceTenantId),
    })),
    queues: {
      producers: environment.queues.producers.map((producer) => ({
        ...producer,
        queue: tenantResourceName(producer.queue, tenantId, sourceTenantId),
      })),
      consumers: environment.queues.consumers.map((consumer) => ({
        ...consumer,
        queue: tenantResourceName(consumer.queue, tenantId, sourceTenantId),
        ...(consumer.dead_letter_queue
          ? { dead_letter_queue: tenantResourceName(consumer.dead_letter_queue, tenantId, sourceTenantId) }
          : {}),
      })),
    },
    vars,
  };

  // account_id is deliberately absent: the tenant Worker is deployed into the TENANT's
  // Cloudflare account, and inheriting this repo's would deploy the clone into IronWrap's.
  const leaks = auditForSourceTenantReferences({ config, sourceTenantId, base, sourceEnv });

  if (leaks.length > 0) {
    throw new Error(
      `tenant Worker config still references the source tenant: ${leaks.join("; ")}. ` +
        "Add the var to TENANT_SCOPED_VARS in tools/generate-tenant-worker-config.mjs.",
    );
  }

  return { config, handoff: handoffSteps({ tenantId, config }) };
}

/**
 * A clone is only isolated if nothing in it still names the source tenant. Comparing against
 * the source ENVIRONMENT's own values (rather than grepping for a word) keeps product facts
 * such as a schema hash out of the finding while catching a var that was carried over
 * unchanged and happens to carry the first tenant's identity.
 */
export function auditForSourceTenantReferences({ config, sourceTenantId, base, sourceEnv }) {
  const sourceVars = sourceEnvironment(base, sourceEnv).vars;
  const sourceIdentities = new Set(
    [
      sourceVars.ERPNEXT_INTEGRATION_USER,
      sourceVars.QB_RECONCILIATION_ISSUER_USER,
      sourceVars.FROM_EMAIL,
      sourceVars.OWNER_ALERT_EMAIL,
      sourceVars.BACKUP_ALERT_EMAIL,
      sourceVars.ERPNEXT_BASE_URL,
      sourceVars.APP_PUBLIC_ORIGIN,
      sourceTenantId,
    ].filter(Boolean),
  );

  const leaks = [];
  for (const [name, value] of Object.entries(config.vars)) {
    if (typeof value !== "string" || value === "") continue;
    for (const identity of sourceIdentities) {
      if (value === identity || value.includes(`"${identity}"`)) {
        leaks.push(`${name}=${value}`);
        break;
      }
    }
  }
  for (const resource of [
    ...config.d1_databases.map((database) => database.database_name),
    ...config.r2_buckets.map((bucket) => bucket.bucket_name),
    ...config.queues.producers.map((producer) => producer.queue),
    ...config.queues.consumers.map((consumer) => consumer.queue),
  ]) {
    if (resource.startsWith(`${sourceTenantId}-`)) leaks.push(`resource ${resource}`);
  }
  return leaks;
}

/** The owner/infra steps this generator deliberately does not perform. */
export function handoffSteps({ tenantId, config }) {
  return [
    `set account_id to the TENANT's Cloudflare account (absent on purpose; never inherit IronWrap's)`,
    `wrangler d1 create ${config.d1_databases[0].database_name} and paste database_id (currently ${UNPROVISIONED_DATABASE_ID})`,
    `wrangler r2 bucket create ${config.r2_buckets[0].bucket_name}`,
    ...config.queues.producers.map((producer) => `wrangler queues create ${producer.queue}`),
    ...config.queues.consumers
      .map((consumer) => consumer.dead_letter_queue)
      .filter((queue, index, all) => queue && all.indexOf(queue) === index)
      .map((queue) => `wrangler queues create ${queue}`),
    `wrangler d1 migrations apply ${config.d1_databases[0].database_name} --remote --config <this file>`,
    `wrangler secret put <NAME> --config <this file> for each secret in workers-bus/.dev.vars.example (NEW values, never reused)`,
    `register this tenant's QuickBooks app webhook and set QB_EXPECTED_REALM_ID + QB_WEBHOOK_TOKEN`,
    `create the tenant's three Google Shared Drives and set SHARED_DRIVE_ID_JOBS/RESTRICTED/ARCHIVE`,
    `register the tenant's own FACET_V2_ROUTES_JSON route and re-enable the Facet rails`,
    `${tenantId} DNS/route and a live GET /health check in the tenant account`,
  ];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = process.argv.slice(2);
    const read = (flag, fallback) => {
      const index = args.indexOf(flag);
      return index === -1 ? fallback : args[index + 1];
    };
    const tenantId = read("--tenant");
    if (!tenantId) throw new Error("--tenant <id> is required");
    // Validated before it is used to build a path: `--tenant ../../something` would otherwise
    // read and write outside config/tenants and workers-bus.
    if (!TENANT_ID_PATTERN.test(tenantId)) {
      throw new Error(`--tenant ${JSON.stringify(tenantId)} must match ${TENANT_ID_PATTERN}`);
    }
    const out = read("--out", join(root, "workers-bus", `wrangler.${tenantId}.jsonc`));
    const tenant = JSON.parse(readFileSync(join(root, "config", "tenants", `${tenantId}.json`), "utf8"));
    const base = JSON.parse(stripJsonComments(readFileSync(join(root, "workers-bus", "wrangler.jsonc"), "utf8")));
    const brokerPortBase = Number(read("--broker-port-base", "9200"));
    const sourceEnv = read("--source-env", "local");
    const runtime = {
      frappeBaseUrl: read("--frappe-base-url", `http://${tenantId}.localhost:8000`),
      workerOrigin: read("--worker-origin", `http://localhost:${read("--worker-port", "7200")}`),
      identityDomain: read("--identity-domain", `${tenantId}.local`),
      brokerPorts: {
        approval: brokerPortBase + 1,
        quoteRevision: brokerPortBase + 2,
        productionSchedule: brokerPortBase + 3,
        proposalPublication: brokerPortBase + 4,
      },
    };
    const { config, handoff } = generateTenantWorkerConfig({ base, tenant, runtime, sourceEnv });
    writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`ok wrote ${out} for Worker ${config.name}`);
    console.log("OWNER/INFRA HAND-OFF (this tool provisions nothing):");
    for (const step of handoff) console.log(`  - ${step}`);
  } catch (error) {
    console.error(`generate-tenant-worker-config failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
