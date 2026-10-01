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

test("image build rejects configuration in argv without echoing it", () => {
  const secretValue = "build-argv-secret-that-must-not-be-printed";
  const run = spawnSync("bash", [BUILD, secretValue], { encoding: "utf8" });
  assert.equal(run.status, 64);
  assert.equal(`${run.stdout}${run.stderr}`.includes(secretValue), false);
});

test("host preflight rejects configuration in argv without echoing it", () => {
  const secretValue = "argv-secret-that-must-not-be-printed";
  const run = spawnSync("bash", [HOST_PREFLIGHT, secretValue], { encoding: "utf8" });
  assert.equal(run.status, 64);
  assert.equal(`${run.stdout}${run.stderr}`.includes(secretValue), false);
});
