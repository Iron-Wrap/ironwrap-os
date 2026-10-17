import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  TENANT_ID_PATTERN,
  UNPROVISIONED_DATABASE_ID,
  auditForSourceTenantReferences,
  generateTenantWorkerConfig,
  stripJsonComments,
  tenantResourceName,
} from "./generate-tenant-worker-config.mjs";
import { flattenWranglerVars } from "./wrangler-vars.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const base = JSON.parse(stripJsonComments(readFileSync(join(root, "workers-bus/wrangler.jsonc"), "utf8")));
const tenant = JSON.parse(readFileSync(join(root, "config/tenants/northline-metal.json"), "utf8"));
// wrangler.jsonc groups vars into CFG_* JSON bindings (IRO-268); fixtures below read through
// the flattened view, same as every other reader of this file.
const localVars = flattenWranglerVars(base.env.local.vars);

const RUNTIME = {
  frappeBaseUrl: "http://northline-metal.localhost:8000",
  workerOrigin: "http://localhost:7200",
  identityDomain: "northline-metal.local",
  brokerPorts: { approval: 9201, quoteRevision: 9202, productionSchedule: 9203, proposalPublication: 9204 },
};

test("comments are stripped but comment-like text inside a string survives", () => {
  const source = '{"a": "http://x/y", /* drop */ "b": "// not a comment"} // trailing';
  assert.deepEqual(JSON.parse(stripJsonComments(source)), { a: "http://x/y", b: "// not a comment" });
});

test("the shipped wrangler config clones onto a tenant with no reference left to the source", () => {
  const { config } = generateTenantWorkerConfig({ base, tenant, runtime: RUNTIME });
  const vars = flattenWranglerVars(config.vars);

  assert.equal(config.name, "northline-metal-bus");
  assert.equal(config.d1_databases[0].database_name, "northline-metal-bus");
  assert.equal(config.r2_buckets[0].bucket_name, "northline-metal-bus-raw");
  assert.equal(config.r2_buckets[1].bucket_name, "northline-metal-bus-privacy");
  assert.ok(config.queues.producers.every((producer) => producer.queue.startsWith("northline-metal-")));
  assert.ok(config.queues.consumers.every((consumer) => consumer.queue.startsWith("northline-metal-")));
  assert.ok(
    config.queues.consumers
      .filter((consumer) => consumer.dead_letter_queue)
      .every((consumer) => consumer.dead_letter_queue.startsWith("northline-metal-")),
  );

  assert.equal(vars.APP_TENANT_ID, "northline-metal");
  assert.equal(vars.FROM_EMAIL, tenant.brand.brands[0].sender_mailbox);
  assert.equal(vars.ERPNEXT_BASE_URL, RUNTIME.frappeBaseUrl);
  assert.equal(vars.ERPNEXT_INTEGRATION_USER, "ironwrap-bus@northline-metal.local");
  assert.equal(vars.QB_RECONCILIATION_ISSUER_USER, "ironwrap-quickbooks-issuer@northline-metal.local");
  assert.equal(vars.APP_PUBLIC_ORIGIN, "http://localhost:7200");
  assert.equal(vars.APP_PROPOSAL_PUBLICATION_BROKER_URL, "http://127.0.0.1:9204");
});

test("the cloned config groups vars the same way wrangler.jsonc does", () => {
  // IRO-268: a clone is itself a wrangler config, so it needs the same CFG_* grouping to stay
  // under the Cloudflare variable-count limit, not the flat shape TENANT_SCOPED_VARS works in.
  const { config } = generateTenantWorkerConfig({ base, tenant, runtime: RUNTIME });
  assert.deepEqual(Object.keys(config.vars).sort(), Object.keys(base.env.local.vars).sort());
  for (const groupName of Object.keys(config.vars)) {
    assert.ok(config.vars[groupName] && typeof config.vars[groupName] === "object", `${groupName} is not grouped`);
  }
});

test("a product fact is carried over rather than blanked", () => {
  // The point of deriving instead of hand-listing: flags, timeouts and schema hashes are
  // product facts, and a clone that quietly loses them is a differently-configured Worker.
  const { config } = generateTenantWorkerConfig({ base, tenant, runtime: RUNTIME });
  const vars = flattenWranglerVars(config.vars);
  assert.equal(vars.NEWO_TOOL_SCHEMA_SHA256, localVars.NEWO_TOOL_SCHEMA_SHA256);
  assert.equal(vars.DEDUP_WINDOW_HOURS, localVars.DEDUP_WINDOW_HOURS);
  assert.equal(config.compatibility_date, base.compatibility_date);
  assert.deepEqual(config.triggers, base.triggers);
});

test("nothing an owner must provision is invented", () => {
  const { config, handoff } = generateTenantWorkerConfig({ base, tenant, runtime: RUNTIME });
  const vars = flattenWranglerVars(config.vars);
  assert.equal(config.account_id, undefined, "a clone must never inherit the IronWrap Cloudflare account");
  assert.equal(config.d1_databases[0].database_id, UNPROVISIONED_DATABASE_ID);
  assert.equal(vars.QB_EXPECTED_REALM_ID, "");
  assert.equal(vars.SHARED_DRIVE_ID_JOBS, "");
  assert.equal(vars.FACET_V2_ROUTES_JSON, "[]");
  assert.ok(handoff.some((step) => step.includes("wrangler d1 create northline-metal-bus")));
  assert.ok(handoff.some((step) => step.includes("wrangler r2 bucket create northline-metal-bus-raw")));
  assert.ok(handoff.some((step) => step.includes("wrangler r2 bucket create northline-metal-bus-privacy")));
  assert.ok(handoff.some((step) => step.includes("account_id")));
});

test("a tenant-bearing var nobody re-pointed is caught rather than shipped", () => {
  // The regression this guards: someone adds a var to wrangler.jsonc that names the IronWrap
  // Frappe user or origin and does not add it to TENANT_SCOPED_VARS. It would be carried over
  // verbatim, and the clone would authenticate as the first tenant's identity.
  const leaked = {
    vars: { SOME_NEW_ISSUER: localVars.ERPNEXT_INTEGRATION_USER },
    d1_databases: [{ database_name: "northline-metal-bus" }],
    r2_buckets: [{ bucket_name: "northline-metal-bus-raw" }],
    queues: { producers: [], consumers: [] },
  };
  const leaks = auditForSourceTenantReferences({
    config: leaked,
    sourceTenantId: "ironwrap",
    base,
    sourceEnv: "local",
  });
  assert.deepEqual(leaks, [`SOME_NEW_ISSUER=${localVars.ERPNEXT_INTEGRATION_USER}`]);
});

test("a tenant-bearing var nobody re-pointed is caught even when it rides inside a CFG_* group", () => {
  // Finding 5 (IRO-268 spec): a grouped value is an object, and an audit that only looked at
  // top-level config.vars entries would skip straight over it (it is not itself a string) and
  // never fire. The clone would then carry the source tenant's identity unnoticed.
  const leaked = {
    vars: { CFG_LEAK: { SOME_NEW_ISSUER: localVars.ERPNEXT_INTEGRATION_USER } },
    d1_databases: [{ database_name: "northline-metal-bus" }],
    r2_buckets: [{ bucket_name: "northline-metal-bus-raw" }],
    queues: { producers: [], consumers: [] },
  };
  const leaks = auditForSourceTenantReferences({
    config: leaked,
    sourceTenantId: "ironwrap",
    base,
    sourceEnv: "local",
  });
  assert.deepEqual(leaks, [`SOME_NEW_ISSUER=${localVars.ERPNEXT_INTEGRATION_USER}`]);
});

test("a resource still living in the source tenant's namespace is caught", () => {
  const leaks = auditForSourceTenantReferences({
    config: {
      vars: {},
      d1_databases: [{ database_name: "ironwrap-bus" }],
      r2_buckets: [{ bucket_name: "northline-metal-bus-raw" }],
      queues: { producers: [], consumers: [] },
    },
    sourceTenantId: "ironwrap",
    base,
    sourceEnv: "local",
  });
  assert.deepEqual(leaks, ["resource ironwrap-bus"]);
});

test("cloning the source tenant onto itself is refused", () => {
  const self = { ...tenant, tenant: { ...tenant.tenant, id: localVars.APP_TENANT_ID } };
  assert.throws(
    () => generateTenantWorkerConfig({ base, tenant: self, runtime: RUNTIME }),
    /is the source tenant, not a clone of it/,
  );
});

test("a resource name is moved onto the tenant whether or not it carries the source prefix", () => {
  assert.equal(tenantResourceName("ironwrap-jn-push", "acme", "ironwrap"), "acme-jn-push");
  assert.equal(tenantResourceName("shared-queue", "acme", "ironwrap"), "acme-shared-queue");
});

test("a tenant id this generator would turn into a resource name is validated here, not by its caller", () => {
  // ELEC-143 finding 4: the only reason a malformed id never reached this file was that
  // deploy/clone-tenant.sh happened to check first. That is the caller's property, not this
  // file's, and every one of these ids becomes a Cloudflare resource prefix and a filename.
  for (const id of ["", "../../etc/passwd", "Northline Metal", "-leading-hyphen", "UPPER", "x", "a".repeat(65)]) {
    assert.throws(
      () =>
        generateTenantWorkerConfig({
          base,
          tenant: { ...tenant, tenant: { ...tenant.tenant, id } },
          runtime: RUNTIME,
        }),
      /must be lowercase alphanumeric with hyphens/,
      `tenant id ${JSON.stringify(id)} must be refused`,
    );
  }
  assert.throws(
    () => generateTenantWorkerConfig({ base, tenant: {}, runtime: RUNTIME }),
    /must be lowercase alphanumeric with hyphens/,
    "a config with no tenant block must be refused, not dereferenced",
  );
});

test("the tenant-id shape is the same literal in all three places that enforce it", () => {
  // Independent checks, one agreed shape: a clone whose id passes clone-tenant.sh must not be
  // rejected here, and one this file accepts must not produce a config the others refuse.
  const configGenerator = readFileSync(join(root, "tools/generate-tenant-config.mjs"), "utf8");
  const cloneScript = readFileSync(join(root, "deploy/clone-tenant.sh"), "utf8");
  const shape = TENANT_ID_PATTERN.source;
  assert.equal(shape, "^[a-z0-9][a-z0-9-]{1,63}$");
  assert.ok(configGenerator.includes(shape), "tools/generate-tenant-config.mjs enforces a different shape");
  assert.ok(cloneScript.includes(shape), "deploy/clone-tenant.sh enforces a different shape");
});
