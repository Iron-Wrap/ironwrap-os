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

test("backup commits its completion marker only after upload verification", async (t) => {
  const mock = await mockBackupEnvironment(t);
  const run = spawnSync("bash", [BACKUP], { encoding: "utf8", env: mock.env });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  const operations = (await readFile(path.join(mock.state, "rclone.log"), "utf8")).trim().split("\n");
  assert.deepEqual(operations.slice(0, 3), ["copy", "check", "copyto"]);
  assert.deepEqual(operations.slice(3), ["delete", "delete", "rmdirs"]);
  assert.equal(operations.includes("purge"), false);
  assert.match(run.stdout, /restore-ready Frappe backup committed and verified/);
  assert.equal((await readdir(mock.root)).some((entry) => entry.startsWith("ironwrap-backup.")), false);
});

test("backup purges an incomplete remote prefix and local plaintext on failure", async (t) => {
  const mock = await mockBackupEnvironment(t, { failCopy: true });
  const run = spawnSync("bash", [BACKUP], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  const output = `${run.stdout}${run.stderr}`;
  for (const name of ["RCLONE_CONFIG_R2_ACCESS_KEY_ID", "RCLONE_CONFIG_R2_SECRET_ACCESS_KEY"]) {
    assert.equal(output.includes(mock.env[name]), false, name);
  }
  const operations = (await readFile(path.join(mock.state, "rclone.log"), "utf8")).trim().split("\n");
  assert.deepEqual(operations, ["copy", "purge"]);
  assert.equal((await readdir(mock.root)).some((entry) => entry.startsWith("ironwrap-backup.")), false);
});

test("backup signal traps exit and purge the incomplete remote prefix", async (t) => {
  const mock = await mockBackupEnvironment(t, { signalCopy: true });
  const run = spawnSync("bash", [BACKUP], { encoding: "utf8", env: mock.env });
  assert.equal(run.status, 143, `${run.stdout}${run.stderr}`);
  const operations = (await readFile(path.join(mock.state, "rclone.log"), "utf8")).trim().split("\n");
  assert.deepEqual(operations, ["copy", "purge"]);
  assert.equal((await readdir(mock.root)).some((entry) => entry.startsWith("ironwrap-backup.")), false);
});

test("backup rejects configuration in argv without echoing it", () => {
  const secretValue = "backup-argv-secret-that-must-not-be-printed";
  const run = spawnSync("bash", [BACKUP, secretValue], { encoding: "utf8" });
  assert.equal(run.status, 64);
  assert.equal(`${run.stdout}${run.stderr}`.includes(secretValue), false);
});

test("restore verification validates a completed encrypted package without mutation", async (t) => {
  const mock = await mockRestoreEnvironment(t);
  const run = spawnSync("bash", [RESTORE], { encoding: "utf8", env: mock.env });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  assert.match(run.stdout, /cryptographically verified.*no restore mutation performed/);
  const dockerOperations = (await readFile(path.join(mock.state, "docker.log"), "utf8")).trim().split("\n");
  assert.equal(dockerOperations.some((line) => line.startsWith("cp ") || / exec .* (?:mktemp|bench|rm -rf)(?: |$)/.test(` ${line}`)), false, dockerOperations.join("\n"));
  assert.deepEqual((await readFile(path.join(mock.state, "rclone.log"), "utf8")).trim().split("\n"), ["cat", "copyto", "copyto"]);
  assert.equal((await readdir(mock.root)).some((entry) => entry.startsWith("ironwrap-restore.")), false);
});

test("restore mode targets only an isolated site, merges only the source encryption key, migrates, and cleans staging", async (t) => {
  const mock = await mockRestoreEnvironment(t);
  mock.env.RESTORE_CONFIRMATION = `RESTORE:${mock.env.RESTORE_TARGET_SITE}@${mock.env.RESTORE_TARGET_CONTAINER}`;
  const run = spawnSync("bash", [RESTORE, "--restore"], { encoding: "utf8", env: mock.env });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  assert.match(run.stdout, /isolated restore and migration completed/);
  const dockerOperations = (await readFile(path.join(mock.state, "docker.log"), "utf8")).trim().split("\n");
  assert.equal(dockerOperations.filter((line) => line.startsWith("cp ")).length, 4);
  assert.equal(dockerOperations.some((line) => line.startsWith("cp ") && line.includes("site_config_backup")), false);
  assert.equal(dockerOperations.some((line) => line.startsWith("cp ") && line.includes("IRONWRAP-RESTORE-ENCRYPTION-KEY.json")), true);
  assert.equal(dockerOperations.some((line) => line.includes(`bench --site ${mock.env.RESTORE_TARGET_SITE} restore `)), true);
  assert.equal(dockerOperations.some((line) => line.includes("python3 -c") && line.includes("encryption_key") && line.includes("site_config.json")), true);
  assert.equal(dockerOperations.some((line) => line.includes(`bench --site ${mock.env.RESTORE_TARGET_SITE} migrate`)), true);
  assert.equal(dockerOperations.at(-1)?.includes("rm -rf -- /tmp/ironwrap-restore.Mock1234"), true);
  assert.equal((await readdir(mock.root)).some((entry) => entry.startsWith("ironwrap-restore.")), false);
});

test("restore mode rejects a target-unbound confirmation before package download", async (t) => {
  const mock = await mockRestoreEnvironment(t);
  mock.env.RESTORE_CONFIRMATION = "RESTORE:wrong.example@wrong-container";
  const run = spawnSync("bash", [RESTORE, "--restore"], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /confirmation.*not bound/);
  await assert.rejects(readFile(path.join(mock.state, "rclone.log"), "utf8"));
});

test("restore can never target the recorded production site or container", async (t) => {
  const mock = await mockRestoreEnvironment(t);
  mock.env.RESTORE_TARGET_SITE = mock.env.FRAPPE_SITE;
  const run = spawnSync("bash", [RESTORE], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /production site can never be a restore target/);
  await assert.rejects(readFile(path.join(mock.state, "docker.log"), "utf8"));
});

test("restore rejects an unpinned target image and a target without non-interactive database authority", async (t) => {
  const wrongImage = await mockRestoreEnvironment(t, { targetImageMismatch: true });
  const imageRun = spawnSync("bash", [RESTORE], { encoding: "utf8", env: wrongImage.env });
  assert.notEqual(imageRun.status, 0);
  assert.match(imageRun.stderr, /target container image does not match/);

  const missingRoot = await mockRestoreEnvironment(t, { targetRootReady: false });
  const rootRun = spawnSync("bash", [RESTORE], { encoding: "utf8", env: missingRoot.env });
  assert.notEqual(rootRun.status, 0);
  assert.match(rootRun.stderr, /non-interactive target-only root credential/);
  await assert.rejects(readFile(path.join(missingRoot.state, "rclone.log"), "utf8"));
});

test("restore rejects targets with an external Docker network or published host ports", async (t) => {
  const externalNetwork = await mockRestoreEnvironment(t, { targetNetworkInternal: false });
  const networkRun = spawnSync("bash", [RESTORE], { encoding: "utf8", env: externalNetwork.env });
  assert.notEqual(networkRun.status, 0);
  assert.match(networkRun.stderr, /Docker network must be internal/);
  await assert.rejects(readFile(path.join(externalNetwork.state, "rclone.log"), "utf8"));

  const publishedPorts = await mockRestoreEnvironment(t, { targetPortsPublished: true });
  const portRun = spawnSync("bash", [RESTORE], { encoding: "utf8", env: publishedPorts.env });
  assert.notEqual(portRun.status, 0);
  assert.match(portRun.stderr, /must not publish host ports/);
  await assert.rejects(readFile(path.join(publishedPorts.state, "rclone.log"), "utf8"));
});

test("restore rejects a bad remote checksum before decryption and mutation", async (t) => {
  const mock = await mockRestoreEnvironment(t, { badChecksum: true });
  const run = spawnSync("bash", [RESTORE], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  await assert.rejects(readFile(path.join(mock.state, "age.log"), "utf8"));
  const dockerOperations = (await readFile(path.join(mock.state, "docker.log"), "utf8")).trim().split("\n");
  assert.equal(dockerOperations.some((line) => line.startsWith("cp ") || / exec .* bench(?: |$)/.test(` ${line}`)), false);
});

test("restore rejects manifest source-site mismatch without mutation", async (t) => {
  const mock = await mockRestoreEnvironment(t, { manifestSite: "other.example.com" });
  const run = spawnSync("bash", [RESTORE], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /manifest schema, source site, timestamp, format, or image does not match/);
  const dockerOperations = (await readFile(path.join(mock.state, "docker.log"), "utf8")).trim().split("\n");
  assert.equal(dockerOperations.some((line) => line.startsWith("cp ") || / exec .* bench(?: |$)/.test(` ${line}`)), false);
});

test("restore rejects archive links and unexpected files before extraction", async (t) => {
  const mock = await mockRestoreEnvironment(t, { archiveLink: true });
  const run = spawnSync("bash", [RESTORE], { encoding: "utf8", env: mock.env });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /links, directories, and non-regular entries are forbidden/);
  const dockerOperations = (await readFile(path.join(mock.state, "docker.log"), "utf8")).trim().split("\n");
  assert.equal(dockerOperations.some((line) => line.startsWith("cp ") || / exec .* bench(?: |$)/.test(` ${line}`)), false);
});

test("failed bench restore cleans container and host plaintext", async (t) => {
  const mock = await mockRestoreEnvironment(t, { failRestore: true });
  mock.env.RESTORE_CONFIRMATION = `RESTORE:${mock.env.RESTORE_TARGET_SITE}@${mock.env.RESTORE_TARGET_CONTAINER}`;
  const run = spawnSync("bash", [RESTORE, "--restore"], { encoding: "utf8", env: mock.env });
  assert.equal(run.status, 19, `${run.stdout}${run.stderr}`);
  const dockerOperations = (await readFile(path.join(mock.state, "docker.log"), "utf8")).trim().split("\n");
  assert.equal(dockerOperations.some((line) => line.includes(" bench ") && line.includes(" restore ")), true);
  assert.equal(dockerOperations.at(-1)?.includes("rm -rf -- /tmp/ironwrap-restore.Mock1234"), true);
  assert.equal((await readdir(mock.root)).some((entry) => entry.startsWith("ironwrap-restore.")), false);
});

test("restore rejects missing completion markers and configuration in argv", async (t) => {
  const mock = await mockRestoreEnvironment(t, { markerPresent: false });
  const missing = spawnSync("bash", [RESTORE], { encoding: "utf8", env: mock.env });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /no readable completion marker/);

  const secretValue = "restore-argv-secret-that-must-not-be-printed";
  const argv = spawnSync("bash", [RESTORE, "--restore", secretValue], { encoding: "utf8", env: mock.env });
  assert.equal(argv.status, 64);
  assert.equal(`${argv.stdout}${argv.stderr}`.includes(secretValue), false);
});
