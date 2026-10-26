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

test("live-env mode accepts a complete locked production environment", async () => {
  const result = await validateLiveEnv({ env: validLiveEnv(), ...validApprovalPublicKeyOptions() });
  assert.equal(result.ok, true, renderHuman(result));
  assert.equal(result.summary.failed, 0);
});

test("live-env mode binds ERPNEXT_ENABLED to the committed production Worker value", async () => {
  for (const value of ["true", "", "yes"]) {
    const env = validLiveEnv();
    env.ERPNEXT_ENABLED = value;
    const result = await validateLiveEnv({ env, ...validApprovalPublicKeyOptions() });
    assert.equal(result.ok, false, value);
    assert.equal(result.checks.find((item) => item.id === "live.gate.integration")?.status, "fail", value);
  }
});

test("live-env mode requires a concrete realm and dedicated QuickBooks issuer", async () => {
  const env = validLiveEnv();
  env.QB_EXPECTED_REALM_ID = "not-a-realm";
  env.QB_RECONCILIATION_ISSUER_USER = env.ERPNEXT_INTEGRATION_USER;
  env.IRONWRAP_QUICKBOOKS_RECONCILIATION_ISSUER_USER = env.ERPNEXT_INTEGRATION_USER;
  env.QB_RECONCILIATION_ISSUER_API_KEY = env.ERPNEXT_API_KEY;

  const result = await validateLiveEnv({ env, ...validApprovalPublicKeyOptions() });
  assert.equal(result.ok, false);
  for (const id of ["live.quickbooks.realm", "live.quickbooks.issuer", "live.secret.separation"]) {
    assert.equal(result.checks.find((item) => item.id === id)?.status, "fail", id);
  }
});

test("live-env mode requires dedicated bounded launch-proof credentials", async () => {
  const env = validLiveEnv();
  env.FRAPPE_BASE_URL = "https://other.ironwrapexteriors.com";
  env.FRAPPE_API_SECRET = env.ERPNEXT_API_SECRET;
  env.FRAPPE_PROOF_POLL_ATTEMPTS = "6";
  env.FRAPPE_PROOF_POLL_INTERVAL_MS = "5001";

  const result = await validateLiveEnv({ env, ...validApprovalPublicKeyOptions() });
  assert.equal(result.ok, false);
  for (const id of [
    "live.launch_proof.base_url_consistency",
    "live.secret.separation",
    "live.launch_proof.poll_attempts",
    "live.launch_proof.poll_interval",
  ]) {
    assert.equal(result.checks.find((item) => item.id === id)?.status, "fail");
  }
});

test("live-env mode accepts an explicitly disabled public estimator without its enable-time secrets", async () => {
  const env = validLiveEnv();
  env.PUBLIC_ESTIMATE_ENABLED = "false";
  for (const name of [
    "ERPNEXT_INTEGRATION_USER",
    "PUBLIC_ESTIMATE_ALLOWED_ORIGINS",
    "PUBLIC_ESTIMATE_ALLOWED_BRANDS",
    "PUBLIC_ESTIMATE_CONSENT_JURISDICTION",
    "PUBLIC_ESTIMATE_TURNSTILE_SITE_KEY",
    "PUBLIC_ESTIMATE_TURNSTILE_SECRET",
    "PUBLIC_ESTIMATE_RATE_LIMIT_PEPPER",
    "PUBLIC_ESTIMATE_RATE_LIMIT_WINDOW_SECONDS",
    "PUBLIC_ESTIMATE_RATE_LIMIT_IP_MAX",
    "PUBLIC_ESTIMATE_RATE_LIMIT_CLIENT_MAX",
    "PUBLIC_ESTIMATE_RANGE_RULES_JSON",
  ]) delete env[name];

  const result = await validateLiveEnv({ env, ...validApprovalPublicKeyOptions() });
  assert.equal(result.ok, true, renderHuman(result));
  assert.equal(result.checks.find((item) => item.id === "live.gate.public_estimate")?.status, "pass");
  assert.equal(result.checks.find((item) => item.id === "live.secret.PUBLIC_ESTIMATE_TURNSTILE_SECRET"), undefined);
});

test("live-env mode validates every enabled Facet integration rail", async () => {
  const env = validLiveEnv();
  Object.assign(env, {
    FACET_DESIGN_INGEST_ENABLED: "true",
    FACET_DESIGN_INGEST_SOURCE_TENANT_ID: "facet-production",
    FACET_DESIGN_INGEST_TENANT_MAP_JSON: JSON.stringify({
      "facet-production": { tenant_id: "ironwrap", brand_ids: ["ironwrap", "iroof"] },
    }),
    FACET_DESIGN_INGEST_HMAC_KEY: "facet_ingest_hmac_4c1b9e2f8a7d6c5b4a392817",
    FACET_DESIGN_FRAPPE_PROJECTION_ENABLED: "true",
    FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY: "facet_projection_hmac_7d6c5b4a3928171615141312",
    FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_KEY: "facet_projection_key_8c921",
    FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_SECRET: "facet_projection_secret_d1a9f80c42",
    APP_FACET_QUOTE_REVISION_PREPARE_ENABLED: "true",
    APP_QUOTE_REVISION_BROKER_URL: "https://quote-revision-broker.ironwrapexteriors.com",
    APP_QUOTE_REVISION_BROKER_KEY_ID: "quote-revision-v1",
    APP_QUOTE_REVISION_BROKER_TIMEOUT_MS: "15000",
    APP_QUOTE_REVISION_EXECUTION_LEASE_SECONDS: "45",
    QUOTE_REVISION_BROKER_SHARED_SECRET: "quote_revision_broker_9f1a4c27d8e6b5a493827161",
  });

  const enabled = await validateLiveEnv({ env, ...validApprovalPublicKeyOptions() });
  assert.equal(enabled.ok, true, renderHuman(enabled));

  env.FACET_DESIGN_INGEST_TENANT_MAP_JSON = JSON.stringify({
    "facet-staging": { tenant_id: "ironwrap", brand_ids: ["ironwrap"] },
  });
  env.FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY = env.FACET_DESIGN_INGEST_HMAC_KEY;
  env.APP_QUOTE_REVISION_BROKER_URL = "http://quote-revision-broker.ironwrapexteriors.com";
  env.APP_QUOTE_REVISION_BROKER_TIMEOUT_MS = "999";
  const invalid = await validateLiveEnv({ env, ...validApprovalPublicKeyOptions() });
  assert.equal(invalid.ok, false);
  for (const id of [
    "live.facet.ingest_tenant_map",
    "live.secret.separation",
    "live.facet.quote_revision_broker_url",
    "live.facet.quote_revision_broker_bounds",
  ]) {
    assert.equal(invalid.checks.find((item) => item.id === id)?.status, "fail", id);
  }
});

test("live-env mode fails closed when public-estimator controls drift from the tenant contract", async () => {
  const env = validLiveEnv();
  env.PUBLIC_ESTIMATE_ALLOWED_ORIGINS = "https://marketing.ironwrapexteriors.com";
  env.PUBLIC_ESTIMATE_ALLOWED_BRANDS = "ironwrap,other";
  env.PUBLIC_ESTIMATE_CONSENT_JURISDICTION = "Unspecified";
  env.PUBLIC_ESTIMATE_RATE_LIMIT_IP_MAX = "101";
  env.PUBLIC_ESTIMATE_RANGE_RULES_JSON = JSON.stringify([{
    rule_id: "otherwise-valid-rule-v1",
    brand: "ironwrap",
    service: "metal_roofing",
    province: "AB",
    min_cad: 18_000,
    max_cad: 32_000,
  }]);

  const result = await validateLiveEnv({ env, ...validApprovalPublicKeyOptions() });
  assert.equal(result.ok, false);
  for (const id of [
    "live.public_estimate.origin",
    "live.public_estimate.brands",
    "live.public_estimate.jurisdiction",
    "live.public_estimate.rate_limits",
    "live.public_estimate.rules",
  ]) {
    assert.equal(result.checks.find((item) => item.id === id)?.status, "fail", id);
  }
});

test("live-env mode requires a readable Ed25519 approval public key", async () => {
  const env = validLiveEnv();
  const malformed = await validateLiveEnv({
    env,
    statApprovalPublicKey: async () => ({ isFile: () => true }),
    readApprovalPublicKey: async () => "not a PEM public key",
  });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.checks.find((item) => item.id === "live.hermes.approval_public_key")?.status, "fail");

  const rsaPublicKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({
    type: "spki",
    format: "pem",
  });
  const wrongType = await validateLiveEnv({
    env,
    statApprovalPublicKey: async () => ({ isFile: () => true }),
    readApprovalPublicKey: async () => rsaPublicKey,
  });
  assert.equal(wrongType.ok, false);
  assert.equal(wrongType.checks.find((item) => item.id === "live.hermes.approval_public_key")?.status, "fail");
});

test("live-env mode refuses to trust an invalid repository contract", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ironwrap-readiness-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.join(DEFAULT_REPO_ROOT, "deploy"), path.join(root, "deploy"), { recursive: true, preserveTimestamps: true });
  const lockPath = path.join(root, "deploy/runtime-lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  lock.policy.erpnext = "allowed";
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

  const result = await validateLiveEnv({ env: validLiveEnv(), repoRoot: root, ...validApprovalPublicKeyOptions() });
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((item) => item.id === "live.contract")?.status, "fail");
});

test("live-env mode fails closed on placeholders, HTTP URLs, and implicit gates", async () => {
  const env = validLiveEnv();
  env.ERPNEXT_API_SECRET = "<frappe-api-secret>";
  env.ERPNEXT_BASE_URL = "http://os.ironwrapexteriors.com";
  env.ERPNEXT_WRITE_ENABLED = "yes";
  env.IRONWRAP_BUS_REQUEST_TIMEOUT_MS = "0";
  env.BACKUP_AGE_RECIPIENT = "<age-recipient>";

  const result = await validateLiveEnv({ env, ...validApprovalPublicKeyOptions() });
  assert.equal(result.ok, false);
  for (const id of [
    "live.env.ERPNEXT_API_SECRET",
    "live.url.ERPNEXT_BASE_URL",
    "live.gate.ERPNEXT_WRITE_ENABLED",
    "live.timeout.IRONWRAP_BUS_REQUEST_TIMEOUT_MS",
    "live.backup.encryption",
  ]) {
    assert.equal(result.checks.find((item) => item.id === id)?.status, "fail", id);
  }
});

test("live-env mode binds Frappe receipt verification to a safe public key path and matching site URL", async () => {
  const env = validLiveEnv();
  env.IRONWRAP_HERMES_APPROVAL_PUBLIC_KEY_FILE = "/run/secrets/../approval-public.pem";
  env.IRONWRAP_HERMES_SITE_BASE_URL = "https://other.ironwrapexteriors.com";

  const result = await validateLiveEnv({ env, ...validApprovalPublicKeyOptions() });
  assert.equal(result.ok, false);
  for (const id of [
    "live.frappe.approval_public_key_path",
    "live.frappe.site_base_url_consistency",
  ]) {
    assert.equal(result.checks.find((item) => item.id === id)?.status, "fail", id);
  }
});

test("live-env mode rejects a fleet or work-package rail wearing the shared bus credential", async () => {
  // The ELEC-48 arrangement expressed through the new binding names: the rail LOOKS isolated,
  // the identity behind it is still the broad bus pair, and the blast radius is unchanged.
  for (const binding of [
    "FLEET_CAPTURE_FRAPPE_API_KEY",
    "FLEET_CAPTURE_FRAPPE_API_SECRET",
    "WORK_PACKAGE_FRAPPE_API_KEY",
    "WORK_PACKAGE_FRAPPE_API_SECRET",
  ]) {
    const env = validLiveEnv();
    env[binding] = binding.endsWith("_SECRET") ? env.ERPNEXT_API_SECRET : env.ERPNEXT_API_KEY;

    const result = await validateLiveEnv({ env, ...validApprovalPublicKeyOptions() });
    assert.equal(result.ok, false, binding);
    assert.equal(
      result.checks.find((item) => item.id === "live.secret.separation")?.status,
      "fail",
      binding,
    );
  }
});

test("live-env mode does not require leftover Frappe fleet or work-package issuer pairs", async () => {
  for (const binding of [
    "FLEET_CAPTURE_FRAPPE_API_KEY",
    "WORK_PACKAGE_FRAPPE_API_SECRET",
  ]) {
    const env = validLiveEnv();
    delete env[binding];

    const result = await validateLiveEnv({ env, ...validApprovalPublicKeyOptions() });
    assert.equal(result.ok, true, binding);
    assert.notEqual(
      result.checks.find((item) => item.id === `live.env.${binding}`)?.status,
      "fail",
      binding,
    );
  }
});

test("live-env mode aligns backup inputs with the executable backup contract", async () => {
  const env = validLiveEnv();
  env.RCLONE_CONFIG_R2_ENDPOINT = "https://a1b2c3d4.r2.cloudflarestorage.com/unexpected";
  env.BACKUP_RETENTION_DAYS = "30.0";
  env.FRAPPE_SITE = "other.ironwrapexteriors.com";
  env.HERMES_WRITE_TOKEN = env.ERPNEXT_API_SECRET;

  const result = await validateLiveEnv({ env, ...validApprovalPublicKeyOptions() });
  assert.equal(result.ok, false);
  for (const id of [
    "live.backup.endpoint",
    "live.backup.retention",
    "live.url.site_consistency",
    "live.secret.separation",
  ]) {
    assert.equal(result.checks.find((item) => item.id === id)?.status, "fail", id);
  }
});

test("live-env mode binds D1 recovery to exact source, separated authority, and non-production defaults", async () => {
  const env = validLiveEnv();
  env.D1_PRODUCTION_DATABASE_ID = env.D1_RESTORE_TARGET_DATABASE_ID;
  env.D1_BACKUP_API_TOKEN = env.RCLONE_CONFIG_R2_SECRET_ACCESS_KEY;
  env.D1_RESTORE_API_TOKEN = env.RCLONE_CONFIG_R2_ACCESS_KEY_ID;
  env.D1_RESTORE_R2_COMPLETED_PREFIX = "d1/other/latest";
  env.D1_RESTORE_MODE = "remote";
  env.D1_RESTORE_TARGET_DATABASE_ID = "8aa15acc-e8e6-4ca9-87c2-fc481ad0df7d";
  env.D1_RESTORE_CONFIRMATION = "RESTORE_D1:unsafe";

  const result = await validateLiveEnv({ env, ...validApprovalPublicKeyOptions() });
  assert.equal(result.ok, false);
  for (const id of [
    "live.d1.source.id",
    "live.secret.separation",
    "live.secret.d1_restore_ephemeral",
    "live.d1.restore_prefix",
    "live.d1.restore_mode",
    "live.d1.target_id",
    "live.d1.confirmation",
  ]) {
    assert.equal(result.checks.find((item) => item.id === id)?.status, "fail", id);
  }
});

test("validator output never includes supplied secret values", async () => {
  const env = validLiveEnv();
  const secretValue = "do-not-print-this-sensitive-value";
  env.ADMIN_TOKEN = secretValue;
  env.IRONWRAP_ADMIN_TOKEN = secretValue;
  env.D1_BACKUP_API_TOKEN = secretValue;
  env.RCLONE_CONFIG_R2_SECRET_ACCESS_KEY = secretValue;
  env.ERPNEXT_BASE_URL = `https://${secretValue}@os.ironwrapexteriors.com`;

  const result = await validateLiveEnv({ env, ...validApprovalPublicKeyOptions() });
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes(secretValue), false);
  assert.equal(renderHuman(result).includes(secretValue), false);
});

test("CLI emits machine-readable JSON and an accurate exit code", () => {
  const run = spawnSync(process.execPath, [TOOL, "contract", "--json"], {
    cwd: DEFAULT_REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.mode, "contract");
  assert.equal(result.ok, true);
  assert.equal(result.summary.failed, 0);
});

test("live-env CLI supports JSON and human output modes", async (t) => {
  const approvalPublicKeyFile = await writeApprovalPublicKeyFixture(t);
  const env = { ...process.env, ...validLiveEnv(), HERMES_APPROVAL_PUBLIC_KEY_FILE: approvalPublicKeyFile };
  const jsonRun = spawnSync(process.execPath, [TOOL, "live-env", "--json"], {
    cwd: DEFAULT_REPO_ROOT,
    encoding: "utf8",
    env,
  });
  assert.equal(jsonRun.status, 0, jsonRun.stderr);
  const result = JSON.parse(jsonRun.stdout);
  assert.equal(result.mode, "live-env");
  assert.equal(result.ok, true);

  const humanRun = spawnSync(process.execPath, [TOOL, "live-env"], {
    cwd: DEFAULT_REPO_ROOT,
    encoding: "utf8",
    env,
  });
  assert.equal(humanRun.status, 0, humanRun.stderr);
  assert.match(humanRun.stdout, /READY: \d+ passed, 0 failed/);
});

test("live-env CLI fails closed without printing a supplied secret", async (t) => {
  const secretValue = "cli-secret-that-must-never-be-printed";
  const approvalPublicKeyFile = await writeApprovalPublicKeyFixture(t);
  const env = {
    ...process.env,
    ...validLiveEnv(),
    HERMES_APPROVAL_PUBLIC_KEY_FILE: approvalPublicKeyFile,
    ERPNEXT_API_SECRET: secretValue,
    ERPNEXT_BASE_URL: `https://${secretValue}@os.ironwrapexteriors.com`,
  };
  const run = spawnSync(process.execPath, [TOOL, "live-env", "--json"], {
    cwd: DEFAULT_REPO_ROOT,
    encoding: "utf8",
    env,
  });
  assert.equal(run.status, 1);
  assert.equal(`${run.stdout}${run.stderr}`.includes(secretValue), false);
  assert.equal(JSON.parse(run.stdout).ok, false);
});
