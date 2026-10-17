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

// The 17 remote-D1-drill scenarios: the slowest group (measured ~58% of the
// original file's wall time), isolated so the other groups are not stuck behind it.
// Split out of tools/production-readiness.test.mjs (IRO-267).

test("remote D1 drill uses exact generated target config and verifies restored tables, indexes, and triggers", async (t) => {
  const mock = await mockD1RestoreEnvironment(t);
  mock.env.D1_RESTORE_MODE = "remote";
  mock.env.D1_RESTORE_API_TOKEN = "cloudflare_d1_restore_write_91e6a4c8f02b735d";
  mock.env.D1_RESTORE_CONFIRMATION = `RESTORE_D1:${mock.env.D1_RESTORE_TARGET_DATABASE_NAME}@${mock.env.D1_RESTORE_TARGET_DATABASE_ID}`;
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  assert.match(run.stdout, /exact confirmed non-production drill database/);
  const operations = (await readFile(path.join(mock.state, "wrangler.log"), "utf8")).trim().split("\n");
  assert.equal(operations.length, REQUIRED_D1_TABLES.length + REQUIRED_D1_TRIGGER_QUERY_BATCH_COUNT + 4);
  assert.equal(operations.every((line) => line.startsWith(`d1 execute ${mock.env.D1_RESTORE_TARGET_DATABASE_NAME} --remote`)), true);
  assert.equal(operations.join("\n").includes(mock.env.D1_RESTORE_API_TOKEN), false);
  const readOperations = operations.filter((line) => line.includes(" --json"));
  const importOperations = operations.filter((line) => line.includes(" --file "));
  assert.equal(readOperations.length, REQUIRED_D1_TABLES.length + REQUIRED_D1_TRIGGER_QUERY_BATCH_COUNT + 3);
  assert.equal(readOperations.every((line) => line.includes(" --command ") && !line.includes(" --file ")), true);
  assert.equal(importOperations.length, 1);
  assert.equal(importOperations[0].includes(" --json"), false);
  const commandLengths = (await readFile(path.join(mock.state, "command-lengths.log"), "utf8"))
    .trim()
    .split("\n")
    .map(Number);
  assert.equal(commandLengths.length, REQUIRED_D1_TABLES.length + REQUIRED_D1_TRIGGER_QUERY_BATCH_COUNT + 3);
  assert.equal(commandLengths.every((length) => Number.isSafeInteger(length) && length <= 16_384), true);
  assert.equal((await readFile(path.join(mock.state, "imported"), "utf8")), "");
  const config = JSON.parse(await readFile(path.join(mock.state, "target-config.json"), "utf8"));
  assert.equal(config.account_id, mock.env.D1_RESTORE_TARGET_ACCOUNT_ID);
  assert.deepEqual(config.d1_databases, [{
    binding: "RESTORE_TARGET",
    database_name: mock.env.D1_RESTORE_TARGET_DATABASE_NAME,
    database_id: mock.env.D1_RESTORE_TARGET_DATABASE_ID,
  }]);
});

test("remote D1 drill refuses an imported database without the evidence privacy views", async (t) => {
  const mock = await mockD1RestoreEnvironment(t, { privacyViewResponseMode: "missing" });
  mock.env.D1_RESTORE_MODE = "remote";
  mock.env.D1_RESTORE_API_TOKEN = "cloudflare_d1_restore_write_91e6a4c8f02b735d";
  mock.env.D1_RESTORE_CONFIRMATION = `RESTORE_D1:${mock.env.D1_RESTORE_TARGET_DATABASE_NAME}@${mock.env.D1_RESTORE_TARGET_DATABASE_ID}`;
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /remote D1 restore is missing a working evidence privacy view/);
  const operations = (await readFile(path.join(mock.state, "wrangler.log"), "utf8")).trim().split("\n");
  assert.equal(operations.some((line) => line.includes(" AS table_name, COUNT(*) AS row_count FROM ")), false);
});

test("remote D1 drill rejects reused backup, restore, or R2 authority before download", async (t) => {
  const mock = await mockD1RestoreEnvironment(t);
  mock.env.D1_RESTORE_MODE = "remote";
  mock.env.D1_RESTORE_API_TOKEN = mock.env.D1_BACKUP_API_TOKEN;
  mock.env.D1_RESTORE_CONFIRMATION = `RESTORE_D1:${mock.env.D1_RESTORE_TARGET_DATABASE_NAME}@${mock.env.D1_RESTORE_TARGET_DATABASE_ID}`;
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /pairwise distinct/);
  await assert.rejects(readFile(path.join(mock.state, "rclone.log"), "utf8"));
});

test("remote D1 drill rejects production, unconfirmed, and nonempty targets before import", async (t) => {
  const production = await mockD1RestoreEnvironment(t);
  production.env.D1_RESTORE_MODE = "remote";
  production.env.D1_RESTORE_API_TOKEN = "cloudflare_d1_restore_write_91e6a4c8f02b735d";
  production.env.D1_RESTORE_TARGET_DATABASE_NAME = production.env.D1_PRODUCTION_DATABASE_NAME;
  production.env.D1_RESTORE_TARGET_DATABASE_ID = production.env.D1_PRODUCTION_DATABASE_ID;
  production.env.D1_RESTORE_CONFIRMATION = `RESTORE_D1:${production.env.D1_RESTORE_TARGET_DATABASE_NAME}@${production.env.D1_RESTORE_TARGET_DATABASE_ID}`;
  const productionRun = spawnSync("bash", [production.script], { encoding: "utf8", env: production.env });
  assert.notEqual(productionRun.status, 0);
  assert.match(productionRun.stderr, /name or UUID is unsafe|production D1 database can never/);
  await assert.rejects(readFile(path.join(production.state, "rclone.log"), "utf8"));

  const unconfirmed = await mockD1RestoreEnvironment(t);
  unconfirmed.env.D1_RESTORE_MODE = "remote";
  unconfirmed.env.D1_RESTORE_API_TOKEN = "cloudflare_d1_restore_write_91e6a4c8f02b735d";
  unconfirmed.env.D1_RESTORE_CONFIRMATION = "RESTORE_D1:wrong@00000000-0000-4000-8000-000000000000";
  const unconfirmedRun = spawnSync("bash", [unconfirmed.script], { encoding: "utf8", env: unconfirmed.env });
  assert.notEqual(unconfirmedRun.status, 0);
  assert.match(unconfirmedRun.stderr, /confirmation is not bound/);
  await assert.rejects(readFile(path.join(unconfirmed.state, "rclone.log"), "utf8"));

  const nonempty = await mockD1RestoreEnvironment(t, { targetObject: "user_table" });
  nonempty.env.D1_RESTORE_MODE = "remote";
  nonempty.env.D1_RESTORE_API_TOKEN = "cloudflare_d1_restore_write_91e6a4c8f02b735d";
  nonempty.env.D1_RESTORE_CONFIRMATION = `RESTORE_D1:${nonempty.env.D1_RESTORE_TARGET_DATABASE_NAME}@${nonempty.env.D1_RESTORE_TARGET_DATABASE_ID}`;
  const nonemptyRun = spawnSync("bash", [nonempty.script], { encoding: "utf8", env: nonempty.env });
  assert.notEqual(nonemptyRun.status, 0);
  assert.match(nonemptyRun.stderr, /only the exact Cloudflare _cf_KV platform table/);
  const operations = (await readFile(path.join(nonempty.state, "wrangler.log"), "utf8")).trim().split("\n");
  assert.equal(operations.length, 1);
  await assert.rejects(readFile(path.join(nonempty.state, "imported"), "utf8"));
});

test("remote D1 drill rejects user and unexpected Cloudflare sqlite objects before import", async (t) => {
  for (const targetObject of ["user_table", "user_view", "user_trigger", "user_index", "unexpected_cf", "wrong_type_cf_kv"]) {
    await t.test(targetObject, async (t) => {
      const mock = await mockD1RestoreEnvironment(t, { targetObject });
      mock.env.D1_RESTORE_MODE = "remote";
      mock.env.D1_RESTORE_API_TOKEN = "cloudflare_d1_restore_write_91e6a4c8f02b735d";
      mock.env.D1_RESTORE_CONFIRMATION = `RESTORE_D1:${mock.env.D1_RESTORE_TARGET_DATABASE_NAME}@${mock.env.D1_RESTORE_TARGET_DATABASE_ID}`;
      const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
      assert.notEqual(run.status, 0);
      assert.match(run.stderr, /only the exact Cloudflare _cf_KV platform table/);
      const operations = (await readFile(path.join(mock.state, "wrangler.log"), "utf8")).trim().split("\n");
      assert.equal(operations.length, 1);
      assert.equal(operations[0].includes(" --command "), true);
      assert.equal(operations[0].includes(" --file "), false);
      const preflightCommand = await readFile(path.join(mock.state, "preflight-command.sql"), "utf8");
      assert.match(preflightCommand, /type='table' AND name='_cf_KV'/);
      assert.match(preflightCommand, /name NOT LIKE 'sqlite_%'/);
      await assert.rejects(readFile(path.join(mock.state, "imported"), "utf8"));
    });
  }
});

test("remote D1 drill rejects Wrangler progress and bulk response shapes before import", async (t) => {
  for (const preflightResponseMode of ["progress", "bulk"]) {
    await t.test(preflightResponseMode, async (t) => {
      const mock = await mockD1RestoreEnvironment(t, { preflightResponseMode });
      mock.env.D1_RESTORE_MODE = "remote";
      mock.env.D1_RESTORE_API_TOKEN = "cloudflare_d1_restore_write_91e6a4c8f02b735d";
      mock.env.D1_RESTORE_CONFIRMATION = `RESTORE_D1:${mock.env.D1_RESTORE_TARGET_DATABASE_NAME}@${mock.env.D1_RESTORE_TARGET_DATABASE_ID}`;
      const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
      assert.notEqual(run.status, 0);
      assert.match(run.stderr, /only the exact Cloudflare _cf_KV platform table/);
      const operations = (await readFile(path.join(mock.state, "wrangler.log"), "utf8")).trim().split("\n");
      assert.equal(operations.length, 1);
      assert.equal(operations[0].includes(" --command "), true);
      await assert.rejects(readFile(path.join(mock.state, "imported"), "utf8"));
    });
  }
});

// Post-import failures include the privacy-view verification before row/index/trigger checks.
test("remote D1 drill fails when any restored production-table row count differs", async (t) => {
  const mock = await mockD1RestoreEnvironment(t, { rowMismatch: true });
  mock.env.D1_RESTORE_MODE = "remote";
  mock.env.D1_RESTORE_API_TOKEN = "cloudflare_d1_restore_write_91e6a4c8f02b735d";
  mock.env.D1_RESTORE_CONFIRMATION = `RESTORE_D1:${mock.env.D1_RESTORE_TARGET_DATABASE_NAME}@${mock.env.D1_RESTORE_TARGET_DATABASE_ID}`;
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /table row counts differ/);
  const operations = (await readFile(path.join(mock.state, "wrangler.log"), "utf8")).trim().split("\n");
  assert.equal(operations.length, REQUIRED_D1_TABLES.length + 3);
});

test("remote D1 drill rejects missing, duplicate, and error table-count results", async (t) => {
  for (const rowResultMode of ["missing", "duplicate", "error"]) {
    await t.test(rowResultMode, async (t) => {
      const mock = await mockD1RestoreEnvironment(t, { rowResultMode });
      mock.env.D1_RESTORE_MODE = "remote";
      mock.env.D1_RESTORE_API_TOKEN = "cloudflare_d1_restore_write_91e6a4c8f02b735d";
      mock.env.D1_RESTORE_CONFIRMATION = `RESTORE_D1:${mock.env.D1_RESTORE_TARGET_DATABASE_NAME}@${mock.env.D1_RESTORE_TARGET_DATABASE_ID}`;
      const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
      assert.notEqual(run.status, 0);
      assert.match(run.stderr, /table row counts differ/);
      const operations = (await readFile(path.join(mock.state, "wrangler.log"), "utf8")).trim().split("\n");
      assert.equal(operations.length, REQUIRED_D1_TABLES.length + 3);
      assert.equal(operations.at(-1).includes(" --command "), true);
      assert.equal((await readFile(path.join(mock.state, "imported"), "utf8")), "");
    });
  }
});

test("remote D1 drill fails when named invariant-trigger inventory differs", async (t) => {
  const mock = await mockD1RestoreEnvironment(t, { triggerMismatch: true });
  mock.env.D1_RESTORE_MODE = "remote";
  mock.env.D1_RESTORE_API_TOKEN = "cloudflare_d1_restore_write_91e6a4c8f02b735d";
  mock.env.D1_RESTORE_CONFIRMATION = `RESTORE_D1:${mock.env.D1_RESTORE_TARGET_DATABASE_NAME}@${mock.env.D1_RESTORE_TARGET_DATABASE_ID}`;
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /trigger inventory or immutable trigger semantics differ/);
  const operations = (await readFile(path.join(mock.state, "wrangler.log"), "utf8")).trim().split("\n");
  assert.equal(operations.length, REQUIRED_D1_TABLES.length + REQUIRED_D1_TRIGGER_QUERY_BATCH_COUNT + 4);
});

test("remote D1 drill fails when named index inventory differs", async (t) => {
  const mock = await mockD1RestoreEnvironment(t, { indexMismatch: true });
  mock.env.D1_RESTORE_MODE = "remote";
  mock.env.D1_RESTORE_API_TOKEN = "cloudflare_d1_restore_write_91e6a4c8f02b735d";
  mock.env.D1_RESTORE_CONFIRMATION = `RESTORE_D1:${mock.env.D1_RESTORE_TARGET_DATABASE_NAME}@${mock.env.D1_RESTORE_TARGET_DATABASE_ID}`;
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /index inventory or immutable index semantics differ/);
  const operations = (await readFile(path.join(mock.state, "wrangler.log"), "utf8")).trim().split("\n");
  assert.equal(operations.length, REQUIRED_D1_TABLES.length + 4);
});

test("remote D1 drill rejects a non-unique Hermes accepted-handoff index", async (t) => {
  const mock = await mockD1RestoreEnvironment(t, { indexSemanticsMismatch: true });
  mock.env.D1_RESTORE_MODE = "remote";
  mock.env.D1_RESTORE_API_TOKEN = "cloudflare_d1_restore_write_91e6a4c8f02b735d";
  mock.env.D1_RESTORE_CONFIRMATION = `RESTORE_D1:${mock.env.D1_RESTORE_TARGET_DATABASE_NAME}@${mock.env.D1_RESTORE_TARGET_DATABASE_ID}`;
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /index inventory or immutable index semantics differ/);
  const operations = (await readFile(path.join(mock.state, "wrangler.log"), "utf8")).trim().split("\n");
  assert.equal(operations.length, REQUIRED_D1_TABLES.length + 4);
});

test("remote D1 drill rejects a measurement identity index without tenant scope", async (t) => {
  const mock = await mockD1RestoreEnvironment(t, { measurementIndexSemanticsMismatch: true });
  mock.env.D1_RESTORE_MODE = "remote";
  mock.env.D1_RESTORE_API_TOKEN = "cloudflare_d1_restore_write_91e6a4c8f02b735d";
  mock.env.D1_RESTORE_CONFIRMATION = `RESTORE_D1:${mock.env.D1_RESTORE_TARGET_DATABASE_NAME}@${mock.env.D1_RESTORE_TARGET_DATABASE_ID}`;
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /index inventory or immutable index semantics differ/);
  const operations = (await readFile(path.join(mock.state, "wrangler.log"), "utf8")).trim().split("\n");
  assert.equal(operations.length, REQUIRED_D1_TABLES.length + 4);
});

test("remote D1 drill rejects missing, duplicate, and error trigger results", async (t) => {
  for (const triggerResultMode of ["missing", "duplicate", "error"]) {
    await t.test(triggerResultMode, async (t) => {
      const mock = await mockD1RestoreEnvironment(t, { triggerResultMode });
      mock.env.D1_RESTORE_MODE = "remote";
      mock.env.D1_RESTORE_API_TOKEN = "cloudflare_d1_restore_write_91e6a4c8f02b735d";
      mock.env.D1_RESTORE_CONFIRMATION = `RESTORE_D1:${mock.env.D1_RESTORE_TARGET_DATABASE_NAME}@${mock.env.D1_RESTORE_TARGET_DATABASE_ID}`;
      const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
      assert.notEqual(run.status, 0);
      assert.match(run.stderr, /trigger inventory or immutable trigger semantics differ/);
      const operations = (await readFile(path.join(mock.state, "wrangler.log"), "utf8")).trim().split("\n");
      assert.equal(operations.length, REQUIRED_D1_TABLES.length + REQUIRED_D1_TRIGGER_QUERY_BATCH_COUNT + 4);
      assert.equal(operations.at(-1).includes(" --command "), true);
      assert.equal((await readFile(path.join(mock.state, "imported"), "utf8")), "");
    });
  }
});

test("remote D1 drill rejects receipt triggers without immutable update/delete semantics", async (t) => {
  const mock = await mockD1RestoreEnvironment(t, { triggerSemanticsMismatch: true });
  mock.env.D1_RESTORE_MODE = "remote";
  mock.env.D1_RESTORE_API_TOKEN = "cloudflare_d1_restore_write_91e6a4c8f02b735d";
  mock.env.D1_RESTORE_CONFIRMATION = `RESTORE_D1:${mock.env.D1_RESTORE_TARGET_DATABASE_NAME}@${mock.env.D1_RESTORE_TARGET_DATABASE_ID}`;
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /trigger inventory or immutable trigger semantics differ/);
  const operations = (await readFile(path.join(mock.state, "wrangler.log"), "utf8")).trim().split("\n");
  assert.equal(operations.length, REQUIRED_D1_TABLES.length + REQUIRED_D1_TRIGGER_QUERY_BATCH_COUNT + 4);
});

test("remote D1 drill rejects measurement-delta triggers without append-only semantics", async (t) => {
  const mock = await mockD1RestoreEnvironment(t, { measurementTriggerSemanticsMismatch: true });
  mock.env.D1_RESTORE_MODE = "remote";
  mock.env.D1_RESTORE_API_TOKEN = "cloudflare_d1_restore_write_91e6a4c8f02b735d";
  mock.env.D1_RESTORE_CONFIRMATION = `RESTORE_D1:${mock.env.D1_RESTORE_TARGET_DATABASE_NAME}@${mock.env.D1_RESTORE_TARGET_DATABASE_ID}`;
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /trigger inventory or immutable trigger semantics differ/);
  const operations = (await readFile(path.join(mock.state, "wrangler.log"), "utf8")).trim().split("\n");
  assert.equal(operations.length, REQUIRED_D1_TABLES.length + REQUIRED_D1_TRIGGER_QUERY_BATCH_COUNT + 4);
});

test("remote D1 drill rejects quote-revision ledger triggers without immutable semantics", async (t) => {
  const mock = await mockD1RestoreEnvironment(t, { quoteRevisionTriggerSemanticsMismatch: true });
  mock.env.D1_RESTORE_MODE = "remote";
  mock.env.D1_RESTORE_API_TOKEN = "cloudflare_d1_restore_write_91e6a4c8f02b735d";
  mock.env.D1_RESTORE_CONFIRMATION = `RESTORE_D1:${mock.env.D1_RESTORE_TARGET_DATABASE_NAME}@${mock.env.D1_RESTORE_TARGET_DATABASE_ID}`;
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /trigger inventory or immutable trigger semantics differ/);
  const operations = (await readFile(path.join(mock.state, "wrangler.log"), "utf8")).trim().split("\n");
  assert.equal(operations.length, REQUIRED_D1_TABLES.length + REQUIRED_D1_TRIGGER_QUERY_BATCH_COUNT + 4);
});

test("remote D1 drill rejects production-schedule ledger triggers without immutable semantics", async (t) => {
  const mock = await mockD1RestoreEnvironment(t, { productionScheduleTriggerSemanticsMismatch: true });
  mock.env.D1_RESTORE_MODE = "remote";
  mock.env.D1_RESTORE_API_TOKEN = "cloudflare_d1_restore_write_91e6a4c8f02b735d";
  mock.env.D1_RESTORE_CONFIRMATION = `RESTORE_D1:${mock.env.D1_RESTORE_TARGET_DATABASE_NAME}@${mock.env.D1_RESTORE_TARGET_DATABASE_ID}`;
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /trigger inventory or immutable trigger semantics differ/);
  const operations = (await readFile(path.join(mock.state, "wrangler.log"), "utf8")).trim().split("\n");
  assert.equal(operations.length, REQUIRED_D1_TABLES.length + REQUIRED_D1_TRIGGER_QUERY_BATCH_COUNT + 4);
});

test("remote D1 drill rejects governed-transition outbox event triggers without immutable semantics", async (t) => {
  const mock = await mockD1RestoreEnvironment(t, { governedTransitionTriggerSemanticsMismatch: true });
  mock.env.D1_RESTORE_MODE = "remote";
  mock.env.D1_RESTORE_API_TOKEN = "cloudflare_d1_restore_write_91e6a4c8f02b735d";
  mock.env.D1_RESTORE_CONFIRMATION = `RESTORE_D1:${mock.env.D1_RESTORE_TARGET_DATABASE_NAME}@${mock.env.D1_RESTORE_TARGET_DATABASE_ID}`;
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /trigger inventory or immutable trigger semantics differ/);
  const operations = (await readFile(path.join(mock.state, "wrangler.log"), "utf8")).trim().split("\n");
  assert.equal(operations.length, REQUIRED_D1_TABLES.length + REQUIRED_D1_TRIGGER_QUERY_BATCH_COUNT + 4);
});
