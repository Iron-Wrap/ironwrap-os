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

test("D1 backup exports through locked Wrangler, validates SQL, and commits its marker last", async (t) => {
  const mock = await mockD1BackupEnvironment(t);
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  assert.equal(run.stderr, "");
  assert.match(run.stdout, /exact production D1 export validated, encrypted, committed/);
  const wrangler = await readFile(path.join(mock.state, "wrangler.log"), "utf8");
  assert.match(wrangler, /^d1 export ironwrap-bus --remote --config .* --output /m);
  assert.equal(wrangler.includes(mock.env.D1_BACKUP_API_TOKEN), false);
  const config = JSON.parse(await readFile(path.join(mock.state, "source-config.json"), "utf8"));
  assert.equal(config.account_id, mock.env.D1_PRODUCTION_ACCOUNT_ID);
  assert.deepEqual(config.d1_databases, [{
    binding: "BACKUP_SOURCE",
    database_name: mock.env.D1_PRODUCTION_DATABASE_NAME,
    database_id: mock.env.D1_PRODUCTION_DATABASE_ID,
  }]);
  const operations = (await readFile(path.join(mock.state, "rclone.log"), "utf8")).trim().split("\n");
  assert.deepEqual(operations.slice(0, 3), ["copy", "check", "copyto"]);
  assert.equal(operations.indexOf("delete") > operations.indexOf("copyto"), true);
  assert.equal((await readdir(mock.root)).some((entry) => entry.startsWith("ironwrap-d1-backup.") && entry !== "ironwrap-d1-backup.lock"), false);
});

test("D1 backup refuses an old or unidentifiable SQLite CLI before export or upload", async (t) => {
  for (const version of ["3.45.1", "unidentified"]) {
    const mock = await mockD1BackupEnvironment(t);
    await writeExecutable(path.join(mock.root, "bin", "sqlite3"), `#!/usr/bin/env bash
[[ "\${1:-}" == '--version' ]] || exit 91
printf '%s\\n' '${version}'
`);
    const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /requires SQLite CLI 3\.46\.0 or newer for complete schema validation/);
    await assert.rejects(readFile(path.join(mock.state, "wrangler.log"), "utf8"));
    await assert.rejects(readFile(path.join(mock.state, "rclone.log"), "utf8"));
  }
});

test("D1 backup fails before upload when a required customer-portal table is missing", async (t) => {
  const mock = await mockD1BackupEnvironment(t, { missingTable: "customer_portal_links" });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /missing required production table: customer_portal_links/);
  await assert.rejects(readFile(path.join(mock.state, "rclone.log"), "utf8"));
  assert.equal((await readdir(mock.root)).some((entry) => entry.startsWith("ironwrap-d1-backup.") && entry !== "ironwrap-d1-backup.lock"), false);
});

test("D1 backup fails before upload when a production-schedule ledger table is missing", async (t) => {
  const mock = await mockD1BackupEnvironment(t, { missingTable: "production_schedule_approval_request_events" });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /missing required production table: production_schedule_approval_request_events/);
  await assert.rejects(readFile(path.join(mock.state, "rclone.log"), "utf8"));
});

test("D1 backup fails before upload when the privacy-safe public-estimate rate-limit table is missing", async (t) => {
  const mock = await mockD1BackupEnvironment(t, { missingTable: "public_estimate_rate_limits" });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /missing required production table: public_estimate_rate_limits/);
  await assert.rejects(readFile(path.join(mock.state, "rclone.log"), "utf8"));
});

test("D1 backup fails before upload when the governed-transition outbox evidence table is missing", async (t) => {
  const mock = await mockD1BackupEnvironment(t, { missingTable: "governed_transition_outbox_events" });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /missing required production table: governed_transition_outbox_events/);
  await assert.rejects(readFile(path.join(mock.state, "rclone.log"), "utf8"));
});

test("D1 backup fails before upload when the field Work Package action ledger is missing", async (t) => {
  const mock = await mockD1BackupEnvironment(t, { missingTable: "field_work_package_actions" });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /missing required production table: field_work_package_actions/);
  await assert.rejects(readFile(path.join(mock.state, "rclone.log"), "utf8"));
});

test("D1 backup fails before upload when the durable QuickBooks projection outbox is missing", async (t) => {
  const mock = await mockD1BackupEnvironment(t, { missingTable: "quickbooks_projection_outbox" });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /missing required production table: quickbooks_projection_outbox/);
  await assert.rejects(readFile(path.join(mock.state, "rclone.log"), "utf8"));
});

test("D1 backup fails before upload when a required production index is missing", async (t) => {
  const mock = await mockD1BackupEnvironment(t, {
    missingIndex: "idx_qb_projection_outbox_pending",
  });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /missing required index: idx_qb_projection_outbox_pending on quickbooks_projection_outbox/);
  await assert.rejects(readFile(path.join(mock.state, "rclone.log"), "utf8"));
});

test("D1 backup fails before upload when an invariant trigger is missing", async (t) => {
  const mock = await mockD1BackupEnvironment(t, { missingTrigger: "prevent_lead_ack_receipts_delete" });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /missing required invariant trigger: prevent_lead_ack_receipts_delete on lead_ack_receipts/);
  await assert.rejects(readFile(path.join(mock.state, "rclone.log"), "utf8"));
  assert.equal((await readdir(mock.root)).some((entry) => entry.startsWith("ironwrap-d1-backup.") && entry !== "ironwrap-d1-backup.lock"), false);
});

test("D1 backup rejects a named receipt trigger without immutable update/delete semantics", async (t) => {
  const mock = await mockD1BackupEnvironment(t, { weakReceiptTrigger: "prevent_lead_ack_receipts_delete" });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /does not enforce immutable receipt trigger semantics: prevent_lead_ack_receipts_delete/);
  await assert.rejects(readFile(path.join(mock.state, "rclone.log"), "utf8"));
});

test("D1 backup rejects a measurement-delta trigger without append-only semantics", async (t) => {
  const mock = await mockD1BackupEnvironment(t, {
    weakMeasurementTrigger: "measurement_deltas_append_only_delete",
  });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(
    run.stderr,
    /does not enforce immutable measurement-delta trigger semantics: measurement_deltas_append_only_delete/,
  );
  await assert.rejects(readFile(path.join(mock.state, "rclone.log"), "utf8"));
});

test("D1 backup rejects a quote-revision ledger trigger without immutable semantics", async (t) => {
  const mock = await mockD1BackupEnvironment(t, { weakApprovalTrigger: "prevent_quote_revision_approval_event_delete" });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /does not enforce immutable approval-ledger trigger semantics: prevent_quote_revision_approval_event_delete/);
  await assert.rejects(readFile(path.join(mock.state, "rclone.log"), "utf8"));
});

test("D1 backup rejects a governed-transition event trigger without immutable semantics", async (t) => {
  const mock = await mockD1BackupEnvironment(t, { weakApprovalTrigger: "prevent_governed_transition_outbox_event_delete" });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /does not enforce immutable approval-ledger trigger semantics: prevent_governed_transition_outbox_event_delete/);
  await assert.rejects(readFile(path.join(mock.state, "rclone.log"), "utf8"));
});

test("D1 backup rejects Facet authority that falls back to the legacy role", async (t) => {
  const mock = await mockD1BackupEnvironment(t, { weakAccessRoleTrigger: true });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(
    run.stderr,
    /does not enforce access-role trigger semantics: facet_design_evidence_associations_validate_insert/,
  );
  await assert.rejects(readFile(path.join(mock.state, "rclone.log"), "utf8"));
});

test("D1 backup rejects active users without an explicit access role", async (t) => {
  const mock = await mockD1BackupEnvironment(t, { nullActiveAccessRole: true });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /contains active app users without explicit access_role/);
  await assert.rejects(readFile(path.join(mock.state, "rclone.log"), "utf8"));
});

test("D1 backup purges incomplete remote state and plaintext on upload failure", async (t) => {
  const mock = await mockD1BackupEnvironment(t, { failCopy: true });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.equal(run.status, 9, `${run.stdout}${run.stderr}`);
  const operations = (await readFile(path.join(mock.state, "rclone.log"), "utf8")).trim().split("\n");
  assert.deepEqual(operations, ["copy", "purge"]);
  assert.equal((await readdir(mock.root)).some((entry) => entry.startsWith("ironwrap-d1-backup.") && entry !== "ironwrap-d1-backup.lock"), false);
});

test("D1 backup signal trap exits, purges incomplete objects, and removes plaintext", async (t) => {
  const mock = await mockD1BackupEnvironment(t, { signalCopy: true });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.equal(run.status, 143, `${run.stdout}${run.stderr}`);
  const operations = (await readFile(path.join(mock.state, "rclone.log"), "utf8")).trim().split("\n");
  assert.deepEqual(operations, ["copy", "purge"]);
  assert.equal((await readdir(mock.root)).some((entry) => entry.startsWith("ironwrap-d1-backup.") && entry !== "ironwrap-d1-backup.lock"), false);
});
