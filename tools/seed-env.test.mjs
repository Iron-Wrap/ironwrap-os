// seed-env.test.mjs - the production guard and the fixture-flattening it feeds into the
// synthetic CRM import (IRO-263). No network: the guard is pure, and the flattening is pinned
// against the actual committed fixture generator rather than a hand-written stand-in for it.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  MAX_LEADS,
  SeedGuardError,
  assertEnvelopeReadUsable,
  assertOnlySyntheticEnvelopes,
  assertProductionIdentifiersComplete,
  assertSyntheticRows,
  bootstrapOutcome,
  crmImportOutcome,
  flattenSnapshot,
  intakeOutcome,
  loadWranglerConfig,
  mergeIntakeOutcomes,
  pipelineApplyCommand,
  productionIdentifiers,
  resolveTarget,
  summarize,
  syntheticEstimate,
  syntheticLeads,
} from "./seed-env.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const wranglerConfigPath = join(root, "workers-bus", "wrangler.jsonc");
const config = loadWranglerConfig(wranglerConfigPath);

test("loads the real wrangler.jsonc and derives production identifiers from it", () => {
  const prod = productionIdentifiers(config);
  assert.equal(prod.workerName, "ironwrap-bus");
  assert.equal(prod.databaseId, "a8fd0116-7af6-4788-98bd-083addbe58bc");
  assert.equal(prod.routeHostname, "ironwrap.mindburn.org");
  assert.equal(prod.workersDevHostname, "ironwrap-bus.yellow-rain-7498.workers.dev");
});

test("refuses when no target is selected at all", () => {
  assert.throws(() => resolveTarget({ config, env: undefined, baseUrl: undefined }), SeedGuardError);
});

test("refuses --env production and --env ''", () => {
  assert.throws(() => resolveTarget({ config, env: "production" }), SeedGuardError);
  assert.throws(() => resolveTarget({ config, env: "" }), SeedGuardError);
});

test("refuses --env and --base-url both naming a target, even when --env is '' (R4.5)", () => {
  assert.throws(
    () => resolveTarget({ config, env: "qa", baseUrl: "http://localhost:7100" }),
    /both name a target: pass exactly one/,
  );
  assert.throws(
    () => resolveTarget({ config, env: "", baseUrl: "http://localhost:7100" }),
    /both name a target: pass exactly one/,
  );
});

test("refuses a non-loopback --base-url and names both production hostnames", () => {
  try {
    resolveTarget({ config, baseUrl: "https://ironwrap.mindburn.org" });
    assert.fail("expected a refusal");
  } catch (error) {
    assert.ok(error instanceof SeedGuardError);
    assert.match(error.message, /ironwrap\.mindburn\.org/);
    assert.match(error.message, /ironwrap-bus\.yellow-rain-7498\.workers\.dev/);
  }
});

test("refuses an --env whose D1 database id equals the production database id", () => {
  const poisoned = structuredClone(config);
  poisoned.env.qa.d1_databases[0].database_id = poisoned.d1_databases[0].database_id;
  assert.throws(() => resolveTarget({ config: poisoned, env: "qa" }), SeedGuardError);
});

test("refuses an --env that declares no d1_databases[0].database_id (R2.7): the production-database check cannot run", () => {
  const poisoned = structuredClone(config);
  delete poisoned.env.qa.d1_databases;
  assert.throws(() => resolveTarget({ config: poisoned, env: "qa" }), SeedGuardError);
});

test("assertProductionIdentifiersComplete accepts the real config and refuses each missing field with its own message (R3.3)", () => {
  assert.doesNotThrow(() => assertProductionIdentifiersComplete(productionIdentifiers(config)));

  const noRoutes = structuredClone(config);
  delete noRoutes.routes;
  assert.throws(
    () => resolveTarget({ config: noRoutes, env: "qa" }),
    /routes\[0\]\.pattern/,
  );

  const noWorkersDevOrigin = structuredClone(config);
  // IRO-268: the origin lives in the `CFG_APP` group of each environment's vars.
  for (const envConfig of Object.values(noWorkersDevOrigin.env ?? {})) {
    if (envConfig?.vars?.CFG_APP?.APP_PUBLIC_ORIGIN) envConfig.vars.CFG_APP.APP_PUBLIC_ORIGIN = "https://custom.example.invalid";
    if (envConfig?.vars?.CFG_APP?.APP_ALLOWED_ORIGINS) envConfig.vars.CFG_APP.APP_ALLOWED_ORIGINS = "https://custom.example.invalid";
  }
  assert.throws(
    () => resolveTarget({ config: noWorkersDevOrigin, env: "qa" }),
    /workers\.dev hostname cannot be derived/,
  );
});

test("refuses an --env whose origin resolves to a production hostname", () => {
  const poisoned = structuredClone(config);
  poisoned.env.qa.vars.CFG_APP.APP_PUBLIC_ORIGIN = `https://${productionIdentifiers(config).routeHostname}`;
  assert.throws(() => resolveTarget({ config: poisoned, env: "qa" }), SeedGuardError);
});

test("accepts --env qa and resolves its own origin, tenant id and database name", () => {
  const target = resolveTarget({ config, env: "qa" });
  assert.equal(target.envName, "qa");
  assert.equal(target.baseUrl, "https://qa-iwrap.mindburn.org");
  assert.equal(target.tenantId, "ironwrap");
  assert.equal(target.databaseName, "ironwrap-bus-qa");
});

test("accepts a loopback --base-url and takes its tenant id and database name from env.local", () => {
  const target = resolveTarget({ config, baseUrl: "http://localhost:7100" });
  assert.equal(target.envName, "local");
  assert.equal(target.baseUrl, "http://localhost:7100");
  assert.equal(target.tenantId, config.env.local.vars.CFG_APP.APP_TENANT_ID);
  assert.equal(target.databaseName, "ironwrap-bus");
});

test("refuses an --env that declares d1_databases with no database_name (R3.4): the wrangler command cannot be built", () => {
  const poisoned = structuredClone(config);
  delete poisoned.env.qa.d1_databases[0].database_name;
  assert.throws(() => resolveTarget({ config: poisoned, env: "qa" }), SeedGuardError);
});

test("assertEnvelopeReadUsable refuses a non-200 or an envelopes-less body, and accepts 200 with an envelopes array (R2.1)", () => {
  assert.throws(
    () => assertEnvelopeReadUsable({ status: 401, body: { error: "unauthorized" } }),
    SeedGuardError,
  );
  assert.throws(() => assertEnvelopeReadUsable({ status: 500, body: null }), SeedGuardError);
  assert.throws(() => assertEnvelopeReadUsable({ status: 200, body: {} }), SeedGuardError);
  assert.doesNotThrow(() => assertEnvelopeReadUsable({ status: 200, body: { envelopes: [] } }));
});

test("assertOnlySyntheticEnvelopes passes synthetic/empty emails and refuses anything else", () => {
  assert.doesNotThrow(() =>
    assertOnlySyntheticEnvelopes([
      { envelope_id: "e1", contact_email: "synthetic-001@example.invalid" },
      { envelope_id: "e2", contact_email: null },
      { envelope_id: "e3", contact_email: "" },
    ]),
  );
  assert.throws(
    () => assertOnlySyntheticEnvelopes([{ envelope_id: "e4", contact_email: "real.person@gmail.com" }]),
    SeedGuardError,
  );
});

test("bootstrapOutcome maps only the two flag-gated codes to an owner action, everything else is failed (R2.4, R3.1)", () => {
  assert.deepEqual(bootstrapOutcome({ status: 200, body: {} }), { created: 1, kept: 0, skipped: 0, failed: 0 });
  assert.deepEqual(bootstrapOutcome({ status: 409, body: {} }), { created: 0, kept: 1, skipped: 0, failed: 0 });

  const bootstrapDisabled = bootstrapOutcome({ status: 403, body: { error: "first_owner_bootstrap_disabled" } });
  assert.equal(bootstrapDisabled.skipped, 1);
  assert.equal(bootstrapDisabled.failed, 0);
  assert.match(bootstrapDisabled.reason, /APP_FIRST_OWNER_BOOTSTRAP_ENABLED/);

  const bffDisabled = bootstrapOutcome({ status: 503, body: { error: "app_bff_disabled" } });
  assert.equal(bffDisabled.skipped, 1);
  assert.equal(bffDisabled.failed, 0);
  assert.match(bffDisabled.reason, /APP_BFF_ENABLED/);

  const unauthorized = bootstrapOutcome({ status: 401, body: { error: "unauthorized" } });
  assert.equal(unauthorized.skipped, 0);
  assert.equal(unauthorized.failed, 1);
  assert.doesNotMatch(unauthorized.reason, /owner action/);
});

test("intakeOutcome classifies a non-2xx as failed, and a 2xx by its own replay field (R3.1)", () => {
  assert.deepEqual(intakeOutcome({ status: 200, body: { duplicate: true } }), {
    created: 0,
    kept: 1,
    skipped: 0,
    failed: 0,
  });
  assert.deepEqual(intakeOutcome({ status: 200, body: { duplicate: false } }), {
    created: 1,
    kept: 0,
    skipped: 0,
    failed: 0,
  });
  assert.deepEqual(
    intakeOutcome({ status: 202, body: { ok: true, status: "processing" }, replayField: "idempotent_replay" }),
    { created: 1, kept: 0, skipped: 0, failed: 0 },
  );
  assert.deepEqual(intakeOutcome({ status: 401, body: { error: "unauthorized" } }), {
    created: 0,
    kept: 0,
    skipped: 0,
    failed: 1,
    reason: "401 unauthorized",
  });
});

test("mergeIntakeOutcomes sums buckets and keeps every distinct failure reason once, in first-seen order (R4.4)", () => {
  const outcomes = [
    intakeOutcome({ status: 401, body: { error: "unauthorized" } }),
    intakeOutcome({ status: 413, body: { error: "payload_too_large" } }),
    intakeOutcome({ status: 401, body: { error: "unauthorized" } }),
  ];
  assert.deepEqual(mergeIntakeOutcomes(outcomes), {
    created: 0,
    kept: 0,
    skipped: 0,
    failed: 3,
    reason: "401 unauthorized; 413 payload_too_large",
  });

  const repeated = [
    intakeOutcome({ status: 401, body: { error: "unauthorized" } }),
    intakeOutcome({ status: 401, body: { error: "unauthorized" } }),
    intakeOutcome({ status: 401, body: { error: "unauthorized" } }),
  ];
  assert.equal(mergeIntakeOutcomes(repeated).reason, "401 unauthorized");

  const clean = [
    intakeOutcome({ status: 200, body: { duplicate: false } }),
    intakeOutcome({ status: 200, body: { duplicate: false } }),
    intakeOutcome({ status: 200, body: { duplicate: false } }),
  ];
  assert.deepEqual(mergeIntakeOutcomes(clean), { created: 3, kept: 0, skipped: 0, failed: 0 });
  assert.equal("reason" in mergeIntakeOutcomes(clean), false);
});

test("crmImportOutcome classifies a non-2xx, a malformed 200, a dirty dry-run plan, and an execute report (R4.1)", () => {
  assert.deepEqual(crmImportOutcome({ phase: "dry-run", status: 401, body: { error: "unauthorized" } }), {
    created: 0,
    kept: 0,
    skipped: 0,
    failed: 1,
    reason: "dry-run 401 unauthorized",
  });
  assert.deepEqual(crmImportOutcome({ phase: "dry-run", status: 500, body: null }), {
    created: 0,
    kept: 0,
    skipped: 0,
    failed: 1,
    reason: "dry-run 500 unknown",
  });
  assert.deepEqual(crmImportOutcome({ phase: "dry-run", status: 200, body: {} }), {
    created: 0,
    kept: 0,
    skipped: 0,
    failed: 1,
    reason: "dry-run 200 no_report",
  });
  const dirty = crmImportOutcome({
    phase: "dry-run",
    status: 200,
    body: { report: { reconciliation: { balanced: false }, rowErrors: [] } },
  });
  assert.equal(dirty.failed, 1);
  assert.match(dirty.reason, /dry-run not clean \(balanced=false, rowErrors=0\): execute not attempted/);
  assert.equal(
    crmImportOutcome({
      phase: "dry-run",
      status: 200,
      body: { report: { reconciliation: { balanced: true }, rowErrors: [] } },
    }),
    null,
  );
  assert.deepEqual(
    crmImportOutcome({
      phase: "execute",
      status: 200,
      body: { report: { applied: { created: 12, adopted: 0, failed: 2 } } },
    }),
    { created: 12, kept: 0, skipped: 0, failed: 2 },
  );
});

test("assertSyntheticRows accepts the shipped fixture's flattened rows and refuses a non-synthetic id or email (R2.6)", () => {
  assert.doesNotThrow(() => assertSyntheticRows(flattenSnapshot({ contacts, jobs })));
  assert.throws(
    () => assertSyntheticRows([{ external_id: "jn-1234", email: "synth-x@example.invalid" }]),
    SeedGuardError,
  );
  assert.throws(
    () => assertSyntheticRows([{ external_id: "synth-1234", email: "real@example.com" }]),
    SeedGuardError,
  );
});

test("pipelineApplyCommand resolves from workers-bus for both the local and remote branches (R2.2)", () => {
  const local = pipelineApplyCommand({ envName: "local", databaseName: "ironwrap-bus" });
  assert.match(local, /^\(cd workers-bus &&/);
  assert.match(local, /--file \.\.\/output\/seed-env\/local\/pipelines\.sql\)$/);
  assert.match(local, /--local --persist-to \.\.\/tmp\/seed-d1/);

  const remote = pipelineApplyCommand({ envName: "qa", databaseName: "ironwrap-bus-qa" });
  assert.match(remote, /^\(cd workers-bus &&/);
  assert.match(remote, /--file \.\.\/output\/seed-env\/qa\/pipelines\.sql\)$/);
  assert.match(remote, /--remote/);
});

test("syntheticLeads is deterministic, bounded, and clearly synthetic", () => {
  const leads = syntheticLeads(3);
  assert.equal(leads.length, 3);
  for (const lead of leads) {
    assert.match(lead.email, /^synth-seed-web-\d{3}@example\.invalid$/);
    assert.match(lead.external_id, /^synth-seed-web-\d{3}$/);
    assert.match(lead.phone, /^\+1-780-555-01\d{2}$/);
  }
  assert.notEqual(leads[0].email, leads[1].email);
  assert.ok(MAX_LEADS === 25);
});

test("syntheticEstimate sends services as strings, the only shape the operating core materializes", () => {
  // workers-bus/src/operating-core.ts smallJsonArray answers operating_core_json_invalid (a
  // terminal 422 native_operating_core_rejected) to any non-string item; QA rejected the old
  // object-shaped services, and its spent -001 key must not come back.
  const { idempotencyKey, body } = syntheticEstimate();
  assert.equal(idempotencyKey, "synth-seed-est-002");
  assert.ok(Array.isArray(body.services) && body.services.length > 0);
  assert.ok(body.services.every((service) => typeof service === "string" && service.length <= 200));
  assert.match(body.email, /@example\.invalid$/);
  assert.match(body.phone, /^\+1-780-555-\d{4}$/);
});

test("summarize shapes counts and run blocks, carrying exactly the step keys it was handed (R4.2: no capability_probe)", () => {
  const steps = {
    website_leads: { created: 2, kept: 1 },
    pipeline_board: { skipped: 1, owner_action: "wrangler d1 execute ..." },
  };
  const report = summarize({
    steps,
    run: {
      run_id: "r1",
      started_at: "t0",
      finished_at: "t1",
      target: "http://localhost:7100",
      env: "local",
      ready_status: 200,
      admin_status: 200,
    },
  });
  assert.deepEqual(Object.keys(report.counts).sort(), Object.keys(steps).sort());
  assert.deepEqual(report.counts.website_leads, { created: 2, kept: 1, skipped: 0, failed: 0 });
  assert.equal(report.counts.pipeline_board.owner_action, "wrangler d1 execute ...");
  assert.equal(report.run.ready_status, 200);
  assert.equal(report.run.admin_status, 200);
  assert.equal(report.run.run_id, "r1");
});

// -- flattening, pinned against the actual committed fixture generator --------------------

const snapshotDir = join(root, "output", "jobnimbus-export", "synthetic-fixture");
let contacts;
let jobs;

before(() => {
  execFileSync(
    process.execPath,
    [join(root, "tools", "fixtures", "generate-jobnimbus-synthetic-snapshot.mjs")],
    { stdio: "ignore" },
  );
  contacts = readNdjson(join(snapshotDir, "contacts.ndjson"));
  jobs = readNdjson(join(snapshotDir, "jobs.ndjson"));
});

function readNdjson(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

test("flattening the shipped fixture produces 12 rows, one per job plus one per jobless contact", () => {
  const rows = flattenSnapshot({ contacts, jobs });
  assert.equal(contacts.length, 12);
  assert.equal(jobs.length, 9);
  assert.equal(rows.length, 12);
});

test("every flattened row is unambiguously synthetic", () => {
  const rows = flattenSnapshot({ contacts, jobs });
  for (const row of rows) {
    assert.match(row.external_id, /^synth-/);
    assert.match(row.email, /@example\.invalid$/);
  }
});

test("flattening is stable across re-generating the fixture (deterministic source, deterministic flatten)", () => {
  const first = flattenSnapshot({ contacts, jobs });
  execFileSync(
    process.execPath,
    [join(root, "tools", "fixtures", "generate-jobnimbus-synthetic-snapshot.mjs")],
    { stdio: "ignore" },
  );
  const second = flattenSnapshot({
    contacts: readNdjson(join(snapshotDir, "contacts.ndjson")),
    jobs: readNdjson(join(snapshotDir, "jobs.ndjson")),
  });
  assert.deepEqual(first, second);
});
