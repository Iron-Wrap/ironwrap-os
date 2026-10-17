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

// D1 recovery scenarios that are not one of the 17 remote-D1-drill cases (those
// live in tools/production-readiness-d1-drill.test.mjs).
// Split out of tools/production-readiness.test.mjs (IRO-267).

test("D1 recovery defaults to local cryptographic and SQLite verification without remote mutation", async (t) => {
  const mock = await mockD1RestoreEnvironment(t);
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  assert.equal(run.stderr, "");
  assert.match(run.stdout, /no remote mutation performed/);
  await assert.rejects(readFile(path.join(mock.state, "wrangler.log"), "utf8"));
  assert.equal((await readdir(mock.root)).some((entry) => entry.startsWith("ironwrap-d1-restore.")), false);
});

test("D1 recovery refuses an old or unidentifiable SQLite CLI before download or import", async (t) => {
  for (const version of ["3.45.1", "unidentified"]) {
    const mock = await mockD1RestoreEnvironment(t);
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

test("D1 recovery rejects an export missing a required invariant trigger", async (t) => {
  const mock = await mockD1RestoreEnvironment(t, { missingTrigger: "prevent_lead_ack_receipts_update" });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /missing required invariant trigger: prevent_lead_ack_receipts_update on lead_ack_receipts/);
  await assert.rejects(readFile(path.join(mock.state, "wrangler.log"), "utf8"));
});

test("D1 recovery rejects an export missing a required customer-portal table", async (t) => {
  const mock = await mockD1RestoreEnvironment(t, { missingTable: "customer_portal_access_throttles" });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /missing required production table: customer_portal_access_throttles/);
  await assert.rejects(readFile(path.join(mock.state, "wrangler.log"), "utf8"));
});

test("D1 recovery rejects an export missing the privacy-safe public-estimate rate-limit table", async (t) => {
  const mock = await mockD1RestoreEnvironment(t, { missingTable: "public_estimate_rate_limits" });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /missing required production table: public_estimate_rate_limits/);
  await assert.rejects(readFile(path.join(mock.state, "wrangler.log"), "utf8"));
});

test("D1 recovery rejects an export missing the governed-transition outbox evidence table", async (t) => {
  const mock = await mockD1RestoreEnvironment(t, { missingTable: "governed_transition_outbox_events" });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /missing required production table: governed_transition_outbox_events/);
  await assert.rejects(readFile(path.join(mock.state, "wrangler.log"), "utf8"));
});

test("D1 recovery rejects an export missing the field Work Package action ledger", async (t) => {
  const mock = await mockD1RestoreEnvironment(t, { missingTable: "field_work_package_actions" });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /missing required production table: field_work_package_actions/);
  await assert.rejects(readFile(path.join(mock.state, "wrangler.log"), "utf8"));
});

test("D1 recovery rejects an export missing the durable QuickBooks projection outbox", async (t) => {
  const mock = await mockD1RestoreEnvironment(t, { missingTable: "quickbooks_projection_outbox" });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /missing required production table: quickbooks_projection_outbox/);
  await assert.rejects(readFile(path.join(mock.state, "wrangler.log"), "utf8"));
});

test("D1 recovery rejects an export missing a required production index", async (t) => {
  const mock = await mockD1RestoreEnvironment(t, {
    missingIndex: "idx_qb_projection_outbox_pending",
  });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /missing required index: idx_qb_projection_outbox_pending on quickbooks_projection_outbox/);
  await assert.rejects(readFile(path.join(mock.state, "wrangler.log"), "utf8"));
});

test("D1 recovery rejects a local receipt trigger without immutable update/delete semantics", async (t) => {
  const mock = await mockD1RestoreEnvironment(t, { weakReceiptTrigger: "prevent_lead_ack_receipts_update" });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /does not enforce immutable receipt trigger semantics: prevent_lead_ack_receipts_update/);
  await assert.rejects(readFile(path.join(mock.state, "wrangler.log"), "utf8"));
});

test("D1 recovery rejects a local measurement-delta trigger without append-only semantics", async (t) => {
  const mock = await mockD1RestoreEnvironment(t, {
    weakMeasurementTrigger: "measurement_deltas_append_only_update",
  });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(
    run.stderr,
    /does not enforce immutable measurement-delta trigger semantics: measurement_deltas_append_only_update/,
  );
  await assert.rejects(readFile(path.join(mock.state, "wrangler.log"), "utf8"));
});

test("D1 recovery rejects a local quote-revision ledger trigger without immutable semantics", async (t) => {
  const mock = await mockD1RestoreEnvironment(t, { weakApprovalTrigger: "prevent_quote_revision_approval_event_update" });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /does not enforce immutable approval-ledger trigger semantics: prevent_quote_revision_approval_event_update/);
  await assert.rejects(readFile(path.join(mock.state, "wrangler.log"), "utf8"));
});

test("D1 recovery rejects a local production-schedule ledger trigger without immutable semantics", async (t) => {
  const mock = await mockD1RestoreEnvironment(t, { weakApprovalTrigger: "prevent_production_schedule_approval_event_delete" });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /does not enforce immutable approval-ledger trigger semantics: prevent_production_schedule_approval_event_delete/);
  await assert.rejects(readFile(path.join(mock.state, "wrangler.log"), "utf8"));
});

test("D1 recovery rejects a governed-transition outbox event trigger without immutable semantics", async (t) => {
  const mock = await mockD1RestoreEnvironment(t, { weakApprovalTrigger: "prevent_governed_transition_outbox_event_update" });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /does not enforce immutable approval-ledger trigger semantics: prevent_governed_transition_outbox_event_update/);
  await assert.rejects(readFile(path.join(mock.state, "wrangler.log"), "utf8"));
});

test("D1 recovery rejects Facet authority that falls back to the legacy role", async (t) => {
  const mock = await mockD1RestoreEnvironment(t, { weakAccessRoleTrigger: true });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(
    run.stderr,
    /does not enforce access-role trigger semantics: facet_design_evidence_associations_validate_insert/,
  );
  await assert.rejects(readFile(path.join(mock.state, "wrangler.log"), "utf8"));
});

test("D1 recovery rejects active users without an explicit access role", async (t) => {
  const mock = await mockD1RestoreEnvironment(t, { nullActiveAccessRole: true });
  const run = spawnSync("bash", [mock.script], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /contains active app users without explicit access_role/);
  await assert.rejects(readFile(path.join(mock.state, "wrangler.log"), "utf8"));
});

test("D1 recovery rejects bad ciphertext checksums and signal-cleans decrypted workspace", async (t) => {
  const bad = await mockD1RestoreEnvironment(t, { badChecksum: true });
  const badRun = spawnSync("bash", [bad.script], { encoding: "utf8", env: bad.env });
  assert.notEqual(badRun.status, 0);
  await assert.rejects(readFile(path.join(bad.state, "age.log"), "utf8"));

  const signalled = await mockD1RestoreEnvironment(t, { signalDownload: true });
  const signalRun = spawnSync("bash", [signalled.script], { encoding: "utf8", env: signalled.env });
  assert.equal(signalRun.status, 143, `${signalRun.stdout}${signalRun.stderr}`);
  assert.equal((await readdir(signalled.root)).some((entry) => entry.startsWith("ironwrap-d1-restore.")), false);
});

test("D1 recovery commands reject argv without echoing supplied values", () => {
  const secretValue = "d1-argv-secret-that-must-not-be-printed";
  for (const script of [D1_BACKUP, D1_RESTORE]) {
    const run = spawnSync("bash", [script, secretValue], { encoding: "utf8" });
    assert.equal(run.status, 64);
    assert.equal(`${run.stdout}${run.stderr}`.includes(secretValue), false);
  }
});
