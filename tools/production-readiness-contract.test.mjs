import assert from "node:assert/strict";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createHash, generateKeyPairSync } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  DEFAULT_REPO_ROOT,
  renderHuman,
  validateContract,
  validateLiveEnv,
} from "./production-readiness.mjs";
import {
  TOOL,
  HOST_PREFLIGHT,
  BACKUP,
  RESTORE,
  D1_BACKUP,
  D1_RESTORE,
  BUILD,
  D1_BACKUP_CONTRACT,
  HERMES_DESKTOP_MIGRATION,
  APPROVAL_PUBLIC_KEY,
  validApprovalPublicKeyOptions,
  writeApprovalPublicKeyFixture,
  writeExecutable,
  mockBackupEnvironment,
  mockRestoreEnvironment,
  stageD1Script,
  BASE_REQUIRED_D1_TABLES,
  BASE_REQUIRED_D1_INDEX_BINDINGS,
  BASE_REQUIRED_D1_TRIGGER_BINDINGS,
  d1ContractCsv,
  extendD1Bindings,
  REQUIRED_D1_TABLES,
  REQUIRED_D1_INDEX_BINDINGS,
  REQUIRED_D1_TRIGGER_BINDINGS,
  D1_TRIGGER_VERIFY_QUERY_PREFIX,
  D1_TRIGGER_VERIFY_QUERY_SUFFIX,
  MAX_REMOTE_D1_READ_COMMAND_LENGTH,
  d1TriggerVerificationBatchCount,
  REQUIRED_D1_TRIGGER_QUERY_BATCH_COUNT,
  HERMES_D1_TABLES,
  HERMES_D1_INDEXES,
  HERMES_D1_TRIGGERS,
  hermesTriggerSql,
  hermesMigrationSql,
  hermesIndexSql,
  d1IndexSql,
  d1GenericTableSql,
  HERMES_D1_SEED_SQL,
  d1TriggerSql,
  d1Sql,
  mockD1BackupEnvironment,
  mockD1RestoreEnvironment,
  validLiveEnv,
} from "./production-readiness-test-helpers.mjs";

// Split out of tools/production-readiness.test.mjs (IRO-267).

test("repository deployment contract is complete and Frappe-only", async () => {
  const result = await validateContract();
  assert.equal(result.ok, true, renderHuman(result));
  assert.equal(result.summary.failed, 0);
});

/**
 * Before ELEC-240 the readiness contract covered none of the eight capabilities spec 9.3 names, so
 * a flag flip on QuickBooks, Newo, Postiz, Hermes desktop or the proposal template passed every
 * check. These three prove it no longer does -- in both directions, because a capability quietly
 * becoming available is as much a state change as one quietly switching off.
 */
async function capabilityFixture(t, mutate) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ironwrap-readiness-capability-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "workers-bus"), { recursive: true });
  const wranglerPath = path.join(root, "workers-bus/wrangler.jsonc");
  const source = await readFile(
    path.join(DEFAULT_REPO_ROOT, "workers-bus/wrangler.jsonc"),
    "utf8",
  );
  await writeFile(wranglerPath, mutate(source));
  const result = await validateContract({ repoRoot: root });
  return (id) => result.checks.find((item) => item.id === id);
}

test("contract mode catches a capability flag flipped on without its configuration", async (t) => {
  const checkFor = await capabilityFixture(t, (source) =>
    source.replace('"QB_OAUTH_ENABLED": "false"', '"QB_OAUTH_ENABLED": "true"'),
  );
  const flipped = checkFor("contract.capability.quickbooks_oauth.state");
  assert.equal(flipped?.status, "fail");
  // The message has to name the new state, not just report a mismatch: an operator who flipped the
  // flag needs to learn that what they produced is "on but unconfigured", not "connected".
  assert.match(flipped.message, /quickbooks_oauth is unconfigured .* but off is recorded/);
  assert.equal(checkFor("contract.capability.newo.state")?.status, "pass");
});

test("contract mode catches a capability quietly becoming available", async (t) => {
  const route = {
    version: 1,
    issuer: "facet",
    source_product: "facet",
    source_environment: "production",
    source_tenant_id: "6b0cbf1d-e0a7-4a1f-9b8b-9f2e4a1c77aa",
    destination_tenant_id: "ironwrap",
    destination_url: "https://facet.example.invalid/projects",
  };
  const checkFor = await capabilityFixture(t, (source) =>
    source.replace(
      '"FACET_V2_ROUTES_JSON": "[]"',
      `"FACET_V2_ROUTES_JSON": ${JSON.stringify(JSON.stringify([route]))}`,
    ),
  );
  // Routes configured, key set still a secret this file cannot see: `unknown`, with the readback
  // obligation intact, rather than a confident "ready" the file has not earned.
  const ingest = checkFor("contract.capability.facet_design_ingest.state");
  assert.equal(ingest?.status, "fail");
  assert.match(ingest.message, /facet_design_ingest is unknown .* but unconfigured is recorded/);
  // Its dependent moves with it, so a state change cannot hide one capability behind another.
  assert.equal(checkFor("contract.capability.facet_native_projection.state")?.status, "fail");
});

test("contract mode refuses NEWO_ENABLED=true until the D1 callback record exists", async (t) => {
  const source = await readFile(path.join(DEFAULT_REPO_ROOT, "workers-bus/wrangler.jsonc"), "utf8");
  // How each case switches Newo on. The Worker reads String(NEWO_ENABLED) === "true", so a JSON
  // boolean counts as on: in the CFG_NEWO group, and as a flat var, which wins over the group.
  const enablers = {
    off: (text) => text,
    string: (text) => text.replace('"NEWO_ENABLED": "false"', '"NEWO_ENABLED": "true"'),
    boolean: (text) => text.replace('"NEWO_ENABLED": "false"', '"NEWO_ENABLED": true'),
    flatBoolean: (text) => text.replace('"CFG_NEWO": {', '"NEWO_ENABLED": true,\n    "CFG_NEWO": {'),
  };
  // The marker the callback-record slice adds: only a migration that creates the table counts.
  const markers = {
    none: null,
    selectOne: "SELECT 1;\n",
    commentOnly: "-- CREATE TABLE newo_callback_records (callback_id TEXT);\nSELECT 1;\n",
    createsTable: "CREATE TABLE IF NOT EXISTS newo_callback_records (\n  callback_id TEXT PRIMARY KEY\n);\n",
  };
  const gate = async (enable, marker) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ironwrap-readiness-newo-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, "workers-bus/migrations"), { recursive: true });
    const wrangler = enablers[enable](source);
    if (enable !== "off") assert.notEqual(wrangler, source, `${enable} changed nothing`);
    await writeFile(path.join(root, "workers-bus/wrangler.jsonc"), wrangler);
    if (markers[marker] !== null) {
      await writeFile(path.join(root, "workers-bus/migrations/0999_newo_callback_records.sql"), markers[marker]);
    }
    const result = await validateContract({ repoRoot: root });
    return result.checks.find((item) => item.id === "contract.newo.callback_record_gate");
  };
  assert.equal((await gate("off", "none"))?.status, "pass");
  for (const enable of ["string", "boolean", "flatBoolean"]) {
    for (const marker of ["none", "selectOne", "commentOnly"]) {
      const refused = await gate(enable, marker);
      assert.equal(refused?.status, "fail", `${enable} with ${marker}`);
      assert.match(
        refused.message,
        /NEWO_ENABLED=true \(production\) is refused until the D1 callback record exists .*creates the newo_callback_records table/,
      );
    }
    assert.equal((await gate(enable, "createsTable"))?.status, "pass", enable);
  }
});

test("contract mode rejects a flag literal no Worker gate accepts", async (t) => {
  const checkFor = await capabilityFixture(t, (source) =>
    source.replace('"POSTIZ_ENABLED": "false"', '"POSTIZ_ENABLED": "1"'),
  );
  const flag = checkFor("contract.capability.postiz.flag");
  assert.equal(flag?.status, "fail");
  assert.match(flag.message, /POSTIZ_ENABLED must be exactly "true" or "false"/);
});

test("contract mode rejects a self-consistent D1 allowlist that omits a migration table", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ironwrap-readiness-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.join(DEFAULT_REPO_ROOT, "deploy"), path.join(root, "deploy"), {
    recursive: true,
    preserveTimestamps: true,
  });
  await mkdir(path.join(root, "workers-bus"), { recursive: true });
  await cp(
    path.join(DEFAULT_REPO_ROOT, "workers-bus/migrations"),
    path.join(root, "workers-bus/migrations"),
    { recursive: true, preserveTimestamps: true },
  );
  const backupPath = path.join(root, "deploy/backup-d1-to-r2.sh");
  const backup = await readFile(backupPath, "utf8");
  await writeFile(
    backupPath,
    backup
      .replace(",facet_design_evidence_associations", "")
      .replace(
        `REQUIRED_TABLE_COUNT=${REQUIRED_D1_TABLES.length}`,
        `REQUIRED_TABLE_COUNT=${REQUIRED_D1_TABLES.length - 1}`,
      ),
  );

  const result = await validateContract({ repoRoot: root });
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((item) => item.id === "contract.d1.schema_inventory")?.status, "fail");
});

test("contract mode rejects a floating runtime reference", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ironwrap-readiness-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.join(DEFAULT_REPO_ROOT, "deploy"), path.join(root, "deploy"), { recursive: true, preserveTimestamps: true });
  const lockPath = path.join(root, "deploy/runtime-lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  lock.components.hermes.version = "main";
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

  const result = await validateContract({ repoRoot: root });
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((item) => item.id === "contract.lock.hermes.version")?.status, "fail");
});

test("contract mode rejects a Node.js floor below the PWA requirement", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ironwrap-readiness-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.join(DEFAULT_REPO_ROOT, "deploy"), path.join(root, "deploy"), { recursive: true, preserveTimestamps: true });
  const lockPath = path.join(root, "deploy/runtime-lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  lock.host_requirements.node_version_minimum = "22.11.9";
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

  const result = await validateContract({ repoRoot: root });
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((item) => item.id === "contract.lock.host")?.status, "fail");
});

test("contract mode rejects an overridable container pin", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ironwrap-readiness-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.join(DEFAULT_REPO_ROOT, "deploy"), path.join(root, "deploy"), { recursive: true, preserveTimestamps: true });
  const containerfilePath = path.join(root, "deploy/Containerfile.frappe");
  const containerfile = await readFile(containerfilePath, "utf8");
  await writeFile(containerfilePath, `${containerfile}\nARG FRAPPE_BASE_IMAGE\n`);

  const result = await validateContract({ repoRoot: root });
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((item) => item.id === "contract.container.non_overridable")?.status, "fail");
});

test("contract mode rejects a committed lead-broker secret", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ironwrap-readiness-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.join(DEFAULT_REPO_ROOT, "deploy"), path.join(root, "deploy"), { recursive: true, preserveTimestamps: true });
  const envPath = path.join(root, "deploy/env.example");
  const env = await readFile(envPath, "utf8");
  await writeFile(
    envPath,
    env.replace(
      "APPROVAL_BROKER_SHARED_SECRET=<unique-at-least-32-byte-worker-broker-secret>",
      "APPROVAL_BROKER_SHARED_SECRET=committed-secret-must-never-be-here",
    ),
  );

  const result = await validateContract({ repoRoot: root });
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((item) => item.id === "contract.env.secret.APPROVAL_BROKER_SHARED_SECRET")?.status, "fail");
});

test("contract mode requires the launch-proof Frappe configuration inventory", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ironwrap-readiness-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.join(DEFAULT_REPO_ROOT, "deploy"), path.join(root, "deploy"), { recursive: true, preserveTimestamps: true });
  const envPath = path.join(root, "deploy/env.example");
  const env = await readFile(envPath, "utf8");
  await writeFile(envPath, env.replace(/^FRAPPE_API_SECRET=.*\n/m, ""));

  const result = await validateContract({ repoRoot: root });
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((item) => item.id === "contract.env.FRAPPE_API_SECRET")?.status, "fail");
});

test("contract mode requires a name-only autonomous release credential inventory", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ironwrap-readiness-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.join(DEFAULT_REPO_ROOT, "deploy"), path.join(root, "deploy"), { recursive: true, preserveTimestamps: true });
  const envPath = path.join(root, "deploy/release.env.example");
  const env = await readFile(envPath, "utf8");
  await writeFile(
    envPath,
    env.replace(/^RELEASE_SERVICE_ADAPTER_TOKEN=.*\n/m, ""),
  );

  const missing = await validateContract({ repoRoot: root });
  assert.equal(missing.ok, false);
  assert.equal(missing.checks.find((item) => item.id === "contract.release_env.RELEASE_SERVICE_ADAPTER_TOKEN")?.status, "fail");

  await writeFile(
    envPath,
    env.replace(
      "RELEASE_PERMIT_PRIVATE_KEY=<release-permit-ed25519-private-key-pem>",
      "RELEASE_PERMIT_PRIVATE_KEY=committed-private-key",
    ),
  );
  const committed = await validateContract({ repoRoot: root });
  assert.equal(committed.ok, false);
  assert.equal(committed.checks.find((item) => item.id === "contract.release_env.RELEASE_PERMIT_PRIVATE_KEY")?.status, "fail");
});
