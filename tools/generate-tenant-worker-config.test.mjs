import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  UNPROVISIONED_DATABASE_ID,
  auditForSourceTenantReferences,
  generateTenantWorkerConfig,
  stripJsonComments,
  tenantResourceName,
} from "./generate-tenant-worker-config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const base = JSON.parse(stripJsonComments(readFileSync(join(root, "workers-bus/wrangler.jsonc"), "utf8")));
const tenant = JSON.parse(readFileSync(join(root, "config/tenants/northline-metal.json"), "utf8"));

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

  assert.equal(config.name, "northline-metal-bus");
  assert.equal(config.d1_databases[0].database_name, "northline-metal-bus");
  assert.equal(config.r2_buckets[0].bucket_name, "northline-metal-bus-raw");
  assert.ok(config.queues.producers.every((producer) => producer.queue.startsWith("northline-metal-")));
  assert.ok(config.queues.consumers.every((consumer) => consumer.queue.startsWith("northline-metal-")));
  assert.ok(
    config.queues.consumers
      .filter((consumer) => consumer.dead_letter_queue)
      .every((consumer) => consumer.dead_letter_queue.startsWith("northline-metal-")),
  );

  assert.equal(config.vars.APP_TENANT_ID, "northline-metal");
  assert.equal(config.vars.FROM_EMAIL, tenant.brand.brands[0].sender_mailbox);
  assert.equal(config.vars.ERPNEXT_BASE_URL, RUNTIME.frappeBaseUrl);
  assert.equal(config.vars.ERPNEXT_INTEGRATION_USER, "ironwrap-bus@northline-metal.local");
  assert.equal(config.vars.QB_RECONCILIATION_ISSUER_USER, "ironwrap-quickbooks-issuer@northline-metal.local");
  assert.equal(config.vars.APP_PUBLIC_ORIGIN, "http://localhost:7200");
  assert.equal(config.vars.APP_PROPOSAL_PUBLICATION_BROKER_URL, "http://127.0.0.1:9204");
});

test("a product fact is carried over rather than blanked", () => {
  // The point of deriving instead of hand-listing: flags, timeouts and schema hashes are
  // product facts, and a clone that quietly loses them is a differently-configured Worker.
  const { config } = generateTenantWorkerConfig({ base, tenant, runtime: RUNTIME });
  assert.equal(config.vars.NEWO_TOOL_SCHEMA_SHA256, base.env.local.vars.NEWO_TOOL_SCHEMA_SHA256);
  assert.equal(config.vars.DEDUP_WINDOW_HOURS, base.env.local.vars.DEDUP_WINDOW_HOURS);
  assert.equal(config.compatibility_date, base.compatibility_date);
  assert.deepEqual(config.triggers, base.triggers);
});

test("nothing an owner must provision is invented", () => {
  const { config, handoff } = generateTenantWorkerConfig({ base, tenant, runtime: RUNTIME });
  assert.equal(config.account_id, undefined, "a clone must never inherit the IronWrap Cloudflare account");
  assert.equal(config.d1_databases[0].database_id, UNPROVISIONED_DATABASE_ID);
  assert.equal(config.vars.QB_EXPECTED_REALM_ID, "");
  assert.equal(config.vars.SHARED_DRIVE_ID_JOBS, "");
  assert.equal(config.vars.FACET_V2_ROUTES_JSON, "[]");
  assert.ok(handoff.some((step) => step.includes("wrangler d1 create northline-metal-bus")));
  assert.ok(handoff.some((step) => step.includes("wrangler r2 bucket create northline-metal-bus-raw")));
  assert.ok(handoff.some((step) => step.includes("account_id")));
});

test("a tenant-bearing var nobody re-pointed is caught rather than shipped", () => {
  // The regression this guards: someone adds a var to wrangler.jsonc that names the IronWrap
  // Frappe user or origin and does not add it to TENANT_SCOPED_VARS. It would be carried over
  // verbatim, and the clone would authenticate as the first tenant's identity.
  const leaked = {
    vars: { SOME_NEW_ISSUER: base.env.local.vars.ERPNEXT_INTEGRATION_USER },
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
  assert.deepEqual(leaks, [`SOME_NEW_ISSUER=${base.env.local.vars.ERPNEXT_INTEGRATION_USER}`]);
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
  const self = { ...tenant, tenant: { ...tenant.tenant, id: base.env.local.vars.APP_TENANT_ID } };
  assert.throws(
    () => generateTenantWorkerConfig({ base, tenant: self, runtime: RUNTIME }),
    /is the source tenant, not a clone of it/,
  );
});

test("a resource name is moved onto the tenant whether or not it carries the source prefix", () => {
  assert.equal(tenantResourceName("ironwrap-jn-push", "acme", "ironwrap"), "acme-jn-push");
  assert.equal(tenantResourceName("shared-queue", "acme", "ironwrap"), "acme-shared-queue");
});
