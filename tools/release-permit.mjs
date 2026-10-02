#!/usr/bin/env node

/**
 * Source-side release admission contract.
 *
 * The permit is deliberately independent of a particular CI provider. The
 * release workflow builds the evidence object from its own automated checks
 * (CI, qa deploy, smoke, restore and rollback drills), and this module
 * signs/verifies the canonical envelope. No human or external reviewer signs
 * it. Production admission must consume the permit through a durable replay
 * boundary; a process-local Map is never a valid production implementation.
 */
import {
  createHash,
  sign as signSignature,
  verify as verifySignature,
} from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { canonicalJson } from "../mcp/erpnext-roofing-mcp/src/approval-contract.mjs";
import { flattenWranglerVars } from "./wrangler-vars.mjs";

const execFile = promisify(execFileCallback);

export const RELEASE_PERMIT_SCHEMA = "ironwrap_release_permit_v2";
export const RELEASE_PERMIT_TYPE = "ironwrap-release-permit";
export const MAX_PERMIT_LIFETIME_MS = 15 * 60_000;
export const MAX_FUTURE_ISSUED_MS = 60_000;
export const RELEASE_REPLAY_PREFIX = "release-permit:";
export const DEFAULT_D1_API_BASE = "https://api.cloudflare.com/client/v4";
export const REVIEW_RECEIPT_SCHEMA = "ironwrap_release_review_v1";
export const REVIEW_RECEIPT_TYPE = "ironwrap-release-review";
export const REVIEW_FINDINGS_SCHEMA = "ironwrap_release_review_findings_v1";
export const MAX_REVIEW_RECEIPT_LIFETIME_MS = 2 * 60 * 60_000;
export const VERSION_MESSAGE_SCHEMA = "ironwrap-release-version-v1";
export const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";
export const REVIEW_RECEIPT_PATH_PREFIX = ".release/reviews/";
export const REVIEW_RECEIPT_REF_PREFIX = "release-review/";
export const RELEASE_EVIDENCE_SCHEMA = "ironwrap_release_external_evidence_v1";
export const RELEASE_EVIDENCE_TYPE = "ironwrap-release-external-evidence";
export const RELEASE_EVIDENCE_PATH_PREFIX = ".release/evidence/";
export const RELEASE_EVIDENCE_REF_PREFIX = "release-evidence/";
export const MAX_RELEASE_EVIDENCE_LIFETIME_MS = 6 * 60 * 60_000;
export const RELEASE_MANIFEST_SCHEMA = "ironwrap_release_manifest_v2";
export const SOURCE_MERGE_SCHEMA = "ironwrap_source_admission_merge_v1";
export const RELEASE_OUTCOME_SCHEMA = "ironwrap_release_outcome_v1";
export const RELEASE_OUTCOME_PREFIX = "release-outcome:";
export const PRODUCTION_RECOVERY_REQUIRED_SCHEMA =
  "ironwrap_production_recovery_required_v1";
export const PRODUCTION_PROMOTION_SCHEMA = "ironwrap_production_promotion_v1";
export const PRODUCTION_PROMOTION_TYPE = "ironwrap-production-promotion";
export const DOMAIN_READBACK_SCHEMA =
  "ironwrap_cloudflare_workers_domain_readback_v1";
export const DOMAIN_READBACK_TYPE =
  "ironwrap-cloudflare-workers-domain-readback";
export const SERVICE_ADAPTER_RECEIPT_SCHEMA =
  "ironwrap_service_adapter_receipt_v1";
export const SERVICE_ADAPTER_RECEIPT_TYPE = "ironwrap-service-adapter-receipt";
export const MAX_SERVICE_ADAPTER_RECEIPT_LIFETIME_MS = 30 * 60_000;
export const LAUNCH_PROOF_STEP_NAMES = Object.freeze([
  "admin_envelopes",
  "admin_reconcile",
  "admin_status",
  "d1_lead",
  "health",
  "ingest_estimate",
  "ingest_estimate_replay",
  "ingest_website",
  "ingest_website_replay",
  "ready",
]);
export const RELEASE_SCOPE_NAMES = Object.freeze([
  "agent",
  "customer",
  "facet",
  "field",
  "finance",
  "production",
  "provider",
  "reception",
  "sales",
  "shop",
]);
export const RELEASE_LICENSE_POLICY = Object.freeze({
  schema: "ironwrap_release_license_policy_v1",
  source: "locked dependency manifests plus independent release evidence",
  unknown_or_unreviewed: "fail",
});

/**
 * Claude model IDs the Worker may use for measurement-report OCR. The Worker
 * keeps the same list in `workers-bus/src/measurements.ts`; the environment
 * preflight rejects any other `MEASUREMENT_OCR_MODEL` before a release mutates
 * anything.
 */
export const MEASUREMENT_OCR_MODELS = Object.freeze([
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-sonnet-5",
]);
const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{32,128}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/;
const IDENTITY_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FRAPPE_SCOPE_RE = /^(?:in-scope|out-of-scope)$/;
const DOMAIN_HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DOMAIN_ZONE_RE = /^[0-9a-f]{32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MIGRATION_RE = /^\d{4}_[a-z0-9][a-z0-9_-]*\.sql$/;
const VERSION_MESSAGE_RE = new RegExp(
  `^${VERSION_MESSAGE_SCHEMA}\\|source=([0-9a-f]{40})\\|tree=([0-9a-f]{64})\\|artifact=([0-9a-f]{64})\\|config=([0-9a-f]{64})$`,
);
const RECOVERY_REQUIRED_STATES = Object.freeze({
  d1_migration_failed: Object.freeze({
    migration_state: "unknown_or_partial",
    provider_promotion: "not_started",
  }),
  automatic_rollback_incomplete: Object.freeze({
    migration_state: "applied",
    provider_promotion: "attempted",
  }),
});

const PERMIT_KEYS = [
  "schema",
  "type",
  "permit_id",
  "repository",
  "source_commit",
  "base_commit",
  "source_git_tree",
  "source_tree_sha256",
  "diff_sha256",
  "ci_checks",
  "previous_generation",
  "generation",
  "policy_hash",
  "config_digest",
  "migrations",
  "build_once",
  "worker",
  "qa",
  "production",
  "smoke",
  "backup_restore",
  "production_recovery",
  "rollback",
  "release_manifest",
  "issuer_identity",
  "issued_at",
  "expires_at",
  "nonce",
];

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fail(code) {
  throw new Error(`release_permit_${code}`);
}

function exactKeys(value, expected, code) {
  if (!isRecord(value)) fail(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail(code);
}

function text(value, code, pattern = SAFE_ID_RE) {
  if (typeof value !== "string" || !pattern.test(value)) fail(code);
  return value;
}

function hash(value, code = "hash_invalid") {
  return text(value, code, SHA256_RE);
}

function commit(value, code = "commit_invalid") {
  return text(value, code, COMMIT_RE);
}

function iso(value, code) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) fail(code);
  const normalized = new Date(value).toISOString();
  if (normalized !== value) fail(code);
  return value;
}

// A timestamp the provider wrote. Cloudflare reports `created_on` with microseconds
// (`2026-10-02T10:31:33.532153Z`), which `iso` rejects because it demands the exact
// `toISOString()` form of our own receipts.
const PROVIDER_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
function providerTimestamp(value, code) {
  if (typeof value !== "string" || !PROVIDER_TIMESTAMP_RE.test(value) || !Number.isFinite(Date.parse(value))) fail(code);
  return value;
}

function nonNegativeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 1) fail(code);
  return value;
}

function equal(expected, actual, code) {
  if (expected !== actual) fail(code);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function permitDigest(permit) {
  return sha256(String(permit));
}

function encode(value) {
  return Buffer.from(value).toString("base64url");
}

function decode(value, code) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) fail(code);
  try {
    return Buffer.from(value, "base64url");
  } catch {
    fail(code);
  }
}

function assertNoDownMigration(name) {
  if (!MIGRATION_RE.test(name) || /(?:^|[_-])(down|rollback|revert)(?:[_-]|\.)/i.test(name)) {
    fail("migration_invalid");
  }
}

function validateChecks(checks, { repository, sourceCommit } = {}) {
  if (!Array.isArray(checks) || checks.length === 0) fail("ci_checks_invalid");
  const seen = new Set();
  const runIds = new Set();
  for (const check of checks) {
    exactKeys(check, [
      "check_id",
      "run_id",
      "job_name",
      "conclusion",
      "repository",
      "head_sha",
      "workflow_id",
      "workflow_path",
      "event",
      "status",
      "run_attempt",
    ], "ci_check_shape_invalid");
    const checkId = text(check.check_id, "ci_check_id_invalid");
    const runId = text(check.run_id, "ci_run_id_invalid");
    text(check.job_name, "ci_job_name_invalid");
    equal("success", check.conclusion, "ci_check_not_success");
    text(check.repository, "ci_repository_invalid", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
    commit(check.head_sha, "ci_head_sha_invalid");
    positiveInteger(check.workflow_id, "ci_workflow_id_invalid");
    equal(CI_WORKFLOW_PATH, check.workflow_path, "ci_workflow_path_invalid");
    // A release is validated either by the PR's own CI run or by the push-to-main
    // run that validated the merged tree; the surrounding manifest binds which
    // commit that was, so both events carry the same exact-source guarantee.
    if (check.event !== "pull_request" && check.event !== "push") fail("ci_event_invalid");
    equal("completed", check.status, "ci_status_invalid");
    positiveInteger(check.run_attempt, "ci_run_attempt_invalid");
    if (repository !== undefined) equal(repository, check.repository, "ci_repository_drift");
    if (sourceCommit !== undefined) equal(sourceCommit, check.head_sha, "ci_head_sha_drift");
    if (seen.has(checkId)) fail("ci_check_duplicate");
    seen.add(checkId);
    runIds.add(runId);
  }
  if (runIds.size !== 1) fail("ci_run_mismatch");
}

function validateMigrations(migrations) {
  exactKeys(migrations, ["ordered", "set_digest", "compatibility", "no_down_migrations"], "migration_contract_shape_invalid");
  if (!Array.isArray(migrations.ordered) || migrations.ordered.length === 0) fail("migration_order_invalid");
  const sorted = [...migrations.ordered].sort();
  if (JSON.stringify(sorted) !== JSON.stringify(migrations.ordered)) fail("migration_order_invalid");
  const seen = new Set();
  for (const name of migrations.ordered) {
    assertNoDownMigration(text(name, "migration_name_invalid", /^[0-9]{4}_[a-z0-9][a-z0-9_-]*\.sql$/));
    if (seen.has(name)) fail("migration_duplicate");
    seen.add(name);
  }
  hash(migrations.set_digest, "migration_set_digest_invalid");
  equal("expand-contract", migrations.compatibility, "migration_compatibility_invalid");
  equal(true, migrations.no_down_migrations, "migration_down_path_present");
  equal(sha256(canonicalJson(migrations.ordered)), migrations.set_digest, "migration_set_digest_mismatch");
}

function validateBuild(build) {
  exactKeys(build, ["source_commit", "source_tree_sha256", "artifact_digest", "uploaded_once", "upload_receipt_digest"], "build_shape_invalid");
  commit(build.source_commit);
  hash(build.source_tree_sha256);
  hash(build.artifact_digest, "artifact_digest_invalid");
  equal(true, build.uploaded_once, "build_not_single_upload");
  hash(build.upload_receipt_digest, "build_receipt_digest_invalid");
}

function validateWorker(worker) {
  exactKeys(worker, [
    "artifact_digest",
    "qa_version_id",
    "qa_version_digest",
    "qa_config_digest",
    "qa_secret_inventory_digest",
    "production_version_id",
    "production_version_digest",
    "production_config_digest",
    "production_secret_inventory_digest",
  ], "worker_shape_invalid");
  hash(worker.artifact_digest, "worker_artifact_digest_invalid");
  text(worker.qa_version_id, "worker_qa_version_id_invalid", UUID_RE);
  hash(worker.qa_version_digest, "worker_qa_version_digest_invalid");
  hash(worker.qa_config_digest, "worker_qa_config_digest_invalid");
  hash(worker.qa_secret_inventory_digest, "worker_qa_secret_inventory_digest_invalid");
  text(worker.production_version_id, "worker_production_version_id_invalid", UUID_RE);
  hash(worker.production_version_digest, "worker_production_version_digest_invalid");
  hash(worker.production_config_digest, "worker_production_config_digest_invalid");
  hash(worker.production_secret_inventory_digest, "worker_production_secret_inventory_digest_invalid");
}

function validatePolicyState(state, code = "policy_state_invalid") {
  exactKeys(state, ["generation", "policy_hash"], `${code}_shape`);
  nonNegativeInteger(state.generation, `${code}_generation`);
  hash(state.policy_hash, `${code}_hash`);
  return state;
}

function validateReadback(readback, expected, code) {
  exactKeys(readback, ["status", "source_commit", "source_tree_sha256", "artifact_digest", "config_digest", "secret_inventory_digest"], `${code}_shape_invalid`);
  equal("matched", readback.status, `${code}_not_matched`);
  equal(expected.source_commit, readback.source_commit, `${code}_source_drift`);
  equal(expected.source_tree_sha256, readback.source_tree_sha256, `${code}_tree_drift`);
  equal(expected.artifact_digest, readback.artifact_digest, `${code}_artifact_drift`);
  equal(expected.config_digest, readback.config_digest, `${code}_config_drift`);
  equal(expected.secret_inventory_digest, readback.secret_inventory_digest, `${code}_secret_inventory_drift`);
}

function validateQa(qa, permit) {
  exactKeys(qa, ["environment", "revision", "source_commit", "source_tree_sha256", "artifact_digest", "config_digest", "readback"], "qa_shape_invalid");
  equal("qa", qa.environment, "qa_environment_invalid");
  text(qa.revision, "qa_revision_invalid", UUID_RE);
  equal(permit.worker.qa_version_id, qa.revision, "qa_revision_drift");
  validateReadback(qa.readback, {
    source_commit: permit.source_commit,
    source_tree_sha256: permit.source_tree_sha256,
    artifact_digest: qa.artifact_digest,
    config_digest: permit.worker.qa_config_digest,
    secret_inventory_digest: permit.worker.qa_secret_inventory_digest,
  }, "qa_readback");
  equal(permit.source_commit, qa.source_commit, "qa_source_drift");
  equal(permit.source_tree_sha256, qa.source_tree_sha256, "qa_tree_drift");
  equal(permit.worker.artifact_digest, qa.artifact_digest, "qa_artifact_drift");
  equal(permit.worker.qa_config_digest, qa.config_digest, "qa_config_drift");
}

function validateProduction(production, permit) {
  exactKeys(production, ["environment", "revision", "source_commit", "source_tree_sha256", "artifact_digest", "config_digest", "readback"], "production_shape_invalid");
  equal("production", production.environment, "production_environment_invalid");
  text(production.revision, "production_revision_invalid", UUID_RE);
  equal(permit.worker.production_version_id, production.revision, "production_revision_drift");
  validateReadback(production.readback, {
    source_commit: permit.source_commit,
    source_tree_sha256: permit.source_tree_sha256,
    artifact_digest: permit.worker.artifact_digest,
    config_digest: permit.worker.production_config_digest,
    secret_inventory_digest: permit.worker.production_secret_inventory_digest,
  }, "production_readback");
  equal(permit.source_commit, production.source_commit, "production_source_drift");
  equal(permit.source_tree_sha256, production.source_tree_sha256, "production_tree_drift");
  equal(permit.worker.artifact_digest, production.artifact_digest, "production_artifact_drift");
  equal(permit.worker.production_config_digest, production.config_digest, "production_config_drift");
}

function validateSmoke(smoke, permit) {
  exactKeys(smoke, ["receipt_id", "workflow", "authenticated", "result", "affected_workflow_ids", "source_commit", "revision", "evidence_digest", "observed_at"], "smoke_shape_invalid");
  text(smoke.receipt_id, "smoke_receipt_id_invalid");
  text(smoke.workflow, "smoke_workflow_invalid");
  equal(true, smoke.authenticated, "smoke_not_authenticated");
  equal("passed", smoke.result, "smoke_not_passed");
  if (!Array.isArray(smoke.affected_workflow_ids) || JSON.stringify([...smoke.affected_workflow_ids].sort()) !== JSON.stringify([...LAUNCH_PROOF_STEP_NAMES].sort())) fail("smoke_workflows_invalid");
  equal(permit.source_commit, smoke.source_commit, "smoke_source_drift");
  equal(permit.qa.revision, smoke.revision, "smoke_revision_drift");
  hash(smoke.evidence_digest, "smoke_evidence_digest_invalid");
  iso(smoke.observed_at, "smoke_observed_at_invalid");
}

function validateBackupRestore(backup, permit) {
  exactKeys(backup, ["backup_id", "environment", "isolated_target", "source_generation", "source_commit", "artifact_digest", "result", "restored", "readback", "export_digest", "manifest_digest", "restore_evidence_digest", "evidence_digest", "observed_at"], "backup_restore_shape_invalid");
  text(backup.backup_id, "backup_id_invalid");
  equal("qa", backup.environment, "backup_environment_invalid");
  text(backup.isolated_target, "backup_target_invalid");
  // Not bound to the permit's generation: qa's backup/restore drill hard-codes
  // --source-generation 0 and reads no policy ledger by design, so once the
  // first production release advances the ledger this binding would fail every
  // later release (IRO-264). The value stays shape-checked only.
  nonNegativeInteger(backup.source_generation, "backup_generation_invalid");
  equal(permit.source_commit, backup.source_commit, "backup_source_drift");
  equal(permit.worker.artifact_digest, backup.artifact_digest, "backup_artifact_drift");
  equal("passed", backup.result, "backup_not_passed");
  equal(true, backup.restored, "backup_not_restored");
  equal("matched", backup.readback, "backup_readback_not_matched");
  hash(backup.export_digest, "backup_export_digest_invalid");
  hash(backup.manifest_digest, "backup_manifest_digest_invalid");
  hash(backup.restore_evidence_digest, "backup_restore_evidence_digest_invalid");
  hash(backup.evidence_digest, "backup_evidence_digest_invalid");
  equal(
    sha256(canonicalJson({ export_digest: backup.export_digest, manifest_digest: backup.manifest_digest, restore_evidence_digest: backup.restore_evidence_digest })),
    backup.evidence_digest,
    "backup_evidence_digest_mismatch",
  );
  iso(backup.observed_at, "backup_observed_at_invalid");
}

function validateProductionRecovery(recovery) {
  exactKeys(recovery, ["schema", "environment", "database_id", "bookmark", "provider_readback_digest", "status", "captured_at"], "production_recovery_shape_invalid");
  equal("ironwrap_d1_recovery_point_v1", recovery.schema, "production_recovery_schema_invalid");
  equal("production", recovery.environment, "production_recovery_environment_invalid");
  text(recovery.database_id, "production_recovery_database_invalid", UUID_RE);
  text(recovery.bookmark, "production_recovery_bookmark_invalid", /^[A-Za-z0-9._~:/+-]{8,512}$/);
  hash(recovery.provider_readback_digest, "production_recovery_readback_digest_invalid");
  equal("matched", recovery.status, "production_recovery_not_matched");
  iso(recovery.captured_at, "production_recovery_captured_at_invalid");
}

function validateRollback(rollback, permit) {
  exactKeys(rollback, ["drill_id", "previous_revision", "candidate_revision", "restored_revision", "re_promoted_revision", "result", "readback", "health_digest", "readiness_digest", "smoke_evidence_digest", "smoke_result", "source_commit", "evidence_digest", "observed_at"], "rollback_shape_invalid");
  text(rollback.drill_id, "rollback_drill_id_invalid");
  text(rollback.previous_revision, "rollback_previous_revision_invalid", UUID_RE);
  equal(permit.worker.qa_version_id, rollback.candidate_revision, "rollback_candidate_drift");
  text(rollback.restored_revision, "rollback_restored_revision_invalid", UUID_RE);
  equal(rollback.previous_revision, rollback.restored_revision, "rollback_restored_revision_drift");
  text(rollback.re_promoted_revision, "rollback_re_promoted_revision_invalid", UUID_RE);
  if (rollback.previous_revision === rollback.candidate_revision) fail("rollback_candidate_not_new");
  equal(rollback.candidate_revision, rollback.re_promoted_revision, "rollback_re_promote_drift");
  equal("passed", rollback.result, "rollback_not_passed");
  equal("matched", rollback.readback, "rollback_readback_not_matched");
  hash(rollback.health_digest, "rollback_health_digest_invalid");
  hash(rollback.readiness_digest, "rollback_readiness_digest_invalid");
  hash(rollback.smoke_evidence_digest, "rollback_smoke_evidence_digest_invalid");
  equal("passed", rollback.smoke_result, "rollback_smoke_not_passed");
  equal(permit.source_commit, rollback.source_commit, "rollback_source_drift");
  hash(rollback.evidence_digest, "rollback_evidence_digest_invalid");
  iso(rollback.observed_at, "rollback_observed_at_invalid");
}

function validateAffectedScopes(scopes, codePrefix = "release_manifest") {
  if (!Array.isArray(scopes) || scopes.length !== RELEASE_SCOPE_NAMES.length) fail(`${codePrefix}_scopes_invalid`);
  const names = [];
  for (const scope of scopes) {
    exactKeys(scope, [
      "scope",
      "status",
      "authenticated",
      "evidence_ref",
      "evidence_digest",
      "non_applicability_policy_digest",
      "reason_digest",
    ], `${codePrefix}_scope_shape_invalid`);
    const name = text(scope.scope, `${codePrefix}_scope_name_invalid`, /^[a-z][a-z0-9_-]{1,63}$/);
    names.push(name);
    text(scope.evidence_ref, `${codePrefix}_scope_evidence_ref_invalid`);
    hash(scope.evidence_digest, `${codePrefix}_scope_evidence_digest_invalid`);
    if (scope.status === "passed") {
      equal(true, scope.authenticated, `${codePrefix}_scope_not_authenticated`);
      equal(null, scope.non_applicability_policy_digest, `${codePrefix}_scope_non_applicability_invalid`);
      equal(null, scope.reason_digest, `${codePrefix}_scope_reason_invalid`);
    } else if (scope.status === "not_applicable") {
      equal(false, scope.authenticated, `${codePrefix}_scope_authentication_invalid`);
      hash(scope.non_applicability_policy_digest, `${codePrefix}_scope_non_applicability_invalid`);
      hash(scope.reason_digest, `${codePrefix}_scope_reason_invalid`);
    } else {
      fail(`${codePrefix}_scope_status_invalid`);
    }
  }
  names.sort();
  if (JSON.stringify(names) !== JSON.stringify([...RELEASE_SCOPE_NAMES])) fail(`${codePrefix}_scope_set_invalid`);
  const provider = scopes.find((scope) => scope.scope === "provider");
  if (provider?.status !== "passed" || provider.authenticated !== true) fail(`${codePrefix}_provider_scope_not_proven`);
  return scopes;
}

function validateServiceIdentities(services, codePrefix) {
  exactKeys(services, ["pwa", "frappe", "facet"], `${codePrefix}_services_shape_invalid`);
  exactKeys(
    services.pwa,
    [
      "artifact_digest",
      "qa_revision",
      "qa_readback_digest",
      "production_candidate_revision",
      "production_candidate_readback_digest",
    ],
    `${codePrefix}_pwa_shape_invalid`,
  );
  hash(services.pwa.artifact_digest, `${codePrefix}_pwa_artifact_invalid`);
  text(services.pwa.qa_revision, `${codePrefix}_pwa_revision_invalid`);
  hash(services.pwa.qa_readback_digest, `${codePrefix}_pwa_readback_invalid`);
  text(
    services.pwa.production_candidate_revision,
    `${codePrefix}_pwa_production_candidate_invalid`,
  );
  hash(
    services.pwa.production_candidate_readback_digest,
    `${codePrefix}_pwa_production_readback_invalid`,
  );
  exactKeys(
    services.frappe,
    [
      "artifact_digest",
      "site_schema_digest",
      "qa_revision",
      "qa_readback_digest",
      "production_candidate_revision",
      "production_candidate_readback_digest",
    ],
    `${codePrefix}_frappe_shape_invalid`,
  );
  hash(services.frappe.artifact_digest, `${codePrefix}_frappe_artifact_invalid`);
  hash(services.frappe.site_schema_digest, `${codePrefix}_frappe_schema_invalid`);
  text(services.frappe.qa_revision, `${codePrefix}_frappe_revision_invalid`);
  hash(services.frappe.qa_readback_digest, `${codePrefix}_frappe_readback_invalid`);
  text(
    services.frappe.production_candidate_revision,
    `${codePrefix}_frappe_production_candidate_invalid`,
  );
  hash(
    services.frappe.production_candidate_readback_digest,
    `${codePrefix}_frappe_production_readback_invalid`,
  );
  exactKeys(services.facet, ["artifact_digest", "integration_receipt_digest"], `${codePrefix}_facet_shape_invalid`);
  hash(services.facet.artifact_digest, `${codePrefix}_facet_artifact_invalid`);
  hash(services.facet.integration_receipt_digest, `${codePrefix}_facet_receipt_invalid`);
}

function validateProviderReconciliation(provider, codePrefix) {
  exactKeys(provider, ["receipt_ref", "receipt_digest", "provider_identity_digest", "status"], `${codePrefix}_provider_shape_invalid`);
  text(provider.receipt_ref, `${codePrefix}_provider_ref_invalid`);
  hash(provider.receipt_digest, `${codePrefix}_provider_digest_invalid`);
  hash(provider.provider_identity_digest, `${codePrefix}_provider_identity_invalid`);
  equal("matched", provider.status, `${codePrefix}_provider_not_matched`);
}

function validateBusinessEvidence(business, codePrefix) {
  exactKeys(business, ["issue_id", "actor_receipt_ref", "actor_receipt_digest", "business_receipt_ref", "business_receipt_digest", "result"], `${codePrefix}_business_shape_invalid`);
  equal("IRO-7", business.issue_id, `${codePrefix}_business_issue_invalid`);
  text(business.actor_receipt_ref, `${codePrefix}_actor_receipt_ref_invalid`);
  hash(business.actor_receipt_digest, `${codePrefix}_actor_receipt_digest_invalid`);
  text(business.business_receipt_ref, `${codePrefix}_business_receipt_ref_invalid`);
  hash(business.business_receipt_digest, `${codePrefix}_business_receipt_digest_invalid`);
  equal("passed", business.result, `${codePrefix}_business_not_passed`);
}

function validateReleaseRecords(records, codePrefix) {
  exactKeys(records, ["authority_issue", "implementation_issue", "business_issue", "release_record_ref", "release_record_digest"], `${codePrefix}_records_shape_invalid`);
  equal("IRO-12", records.authority_issue, `${codePrefix}_authority_issue_invalid`);
  equal("IRO-41", records.implementation_issue, `${codePrefix}_implementation_issue_invalid`);
  equal("IRO-7", records.business_issue, `${codePrefix}_business_issue_invalid`);
  text(records.release_record_ref, `${codePrefix}_release_record_ref_invalid`);
  hash(records.release_record_digest, `${codePrefix}_release_record_digest_invalid`);
}

function validateExternalRecovery(recovery, codePrefix) {
  exactKeys(recovery, [
    "prior_worker_readback_digest",
    "prior_pwa_revision",
    "prior_pwa_readback_digest",
    "prior_frappe_revision",
    "prior_frappe_readback_digest",
    "prior_frappe_backup_digest",
  ], `${codePrefix}_recovery_shape_invalid`);
  hash(recovery.prior_worker_readback_digest, `${codePrefix}_prior_worker_readback_invalid`);
  text(recovery.prior_pwa_revision, `${codePrefix}_prior_pwa_invalid`);
  hash(recovery.prior_pwa_readback_digest, `${codePrefix}_prior_pwa_readback_invalid`);
  text(recovery.prior_frappe_revision, `${codePrefix}_prior_frappe_invalid`);
  hash(recovery.prior_frappe_readback_digest, `${codePrefix}_prior_frappe_readback_invalid`);
  hash(recovery.prior_frappe_backup_digest, `${codePrefix}_prior_frappe_backup_invalid`);
}

function validateSupplyChainEvidence(supplyChain, codePrefix) {
  exactKeys(supplyChain, ["lockfiles_digest", "sbom_digest", "license_manifest_digest", "license_policy_digest", "audit_receipt_digest", "result"], `${codePrefix}_supply_chain_shape_invalid`);
  for (const key of ["lockfiles_digest", "sbom_digest", "license_manifest_digest", "license_policy_digest", "audit_receipt_digest"]) hash(supplyChain[key], `${codePrefix}_${key}_invalid`);
  equal("passed", supplyChain.result, `${codePrefix}_supply_chain_not_passed`);
}

function validateExternalReleaseEvidencePayload(payload, { now = Date.now() } = {}) {
  exactKeys(payload, [
    "schema",
    "type",
    "repository",
    "pr_number",
    "source_commit",
    "source_git_tree",
    "artifact_digest",
    "supply_chain",
    "service_identities",
    "affected_scopes",
    "recovery",
    "provider_reconciliation",
    "business_evidence",
    "records",
    "issuer_principal",
    "issuer_task_id",
    "issuer_run_id",
    "key_version",
    "issued_at",
    "expires_at",
    "nonce",
  ], "release_evidence_shape_invalid");
  equal(RELEASE_EVIDENCE_SCHEMA, payload.schema, "release_evidence_schema_invalid");
  equal(RELEASE_EVIDENCE_TYPE, payload.type, "release_evidence_type_invalid");
  text(payload.repository, "release_evidence_repository_invalid", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  positiveInteger(payload.pr_number, "release_evidence_pr_invalid");
  commit(payload.source_commit, "release_evidence_source_invalid");
  commit(payload.source_git_tree, "release_evidence_tree_invalid");
  hash(payload.artifact_digest, "release_evidence_artifact_invalid");
  validateSupplyChainEvidence(payload.supply_chain, "release_evidence");
  validateServiceIdentities(payload.service_identities, "release_evidence");
  validateAffectedScopes(payload.affected_scopes, "release_evidence");
  validateExternalRecovery(payload.recovery, "release_evidence");
  validateProviderReconciliation(payload.provider_reconciliation, "release_evidence");
  validateBusinessEvidence(payload.business_evidence, "release_evidence");
  validateReleaseRecords(payload.records, "release_evidence");
  text(payload.issuer_principal, "release_evidence_issuer_invalid", IDENTITY_RE);
  text(payload.issuer_task_id, "release_evidence_task_invalid");
  text(payload.issuer_run_id, "release_evidence_run_invalid");
  text(payload.key_version, "release_evidence_key_version_invalid");
  iso(payload.issued_at, "release_evidence_issued_invalid");
  iso(payload.expires_at, "release_evidence_expires_invalid");
  const issuedMs = Date.parse(payload.issued_at);
  const expiresMs = Date.parse(payload.expires_at);
  if (issuedMs > now + MAX_FUTURE_ISSUED_MS) fail("release_evidence_issued_in_future");
  if (expiresMs <= now || expiresMs <= issuedMs || expiresMs - issuedMs > MAX_RELEASE_EVIDENCE_LIFETIME_MS) fail("release_evidence_window_invalid");
  text(payload.nonce, "release_evidence_nonce_invalid", NONCE_RE);
  return payload;
}

export function signExternalReleaseEvidence(privateKey, payload, options = {}) {
  if (!privateKey) fail("release_evidence_private_key_required");
  const normalized = validateExternalReleaseEvidencePayload(payload, options);
  const encodedPayload = encode(canonicalJson(normalized));
  const signature = signSignature(null, Buffer.from(encodedPayload), privateKey).toString("base64url");
  return `${encodedPayload}.${signature}`;
}

export function verifyExternalReleaseEvidence(publicKey, receipt, expected = {}, options = {}) {
  if (!publicKey) fail("release_evidence_public_key_required");
  const parts = String(receipt ?? "").split(".");
  if (parts.length !== 2) fail("release_evidence_receipt_invalid");
  const [encodedPayload, encodedSignature] = parts;
  const payloadBytes = decode(encodedPayload, "release_evidence_receipt_invalid");
  const signature = decode(encodedSignature, "release_evidence_receipt_invalid");
  if (!verifySignature(null, Buffer.from(encodedPayload), publicKey, signature)) fail("release_evidence_signature_invalid");
  let payload;
  try { payload = JSON.parse(payloadBytes.toString("utf8")); } catch { fail("release_evidence_receipt_invalid"); }
  validateExternalReleaseEvidencePayload(payload, options);
  for (const field of ["repository", "pr_number", "source_commit", "source_git_tree", "artifact_digest"]) {
    if (expected[field] !== undefined) equal(expected[field], payload[field], `release_evidence_${field}_drift`);
  }
  return payload;
}

function validateServiceAdapterReceiptPayload(
  payload,
  expected = {},
  { now = Date.now() } = {},
) {
  exactKeys(
    payload,
    [
      "schema",
      "type",
      "operation",
      "repository",
      "source_commit",
      "source_git_tree",
      "aggregate_artifact_digest",
      "merge_commit",
      "frappe",
      "provider_reconciliation_digest",
      "result",
      "issuer_principal",
      "issuer_task_id",
      "issuer_run_id",
      "key_version",
      "issued_at",
      "expires_at",
      "nonce",
    ],
    "service_adapter_shape_invalid",
  );
  equal(
    SERVICE_ADAPTER_RECEIPT_SCHEMA,
    payload.schema,
    "service_adapter_schema_invalid",
  );
  equal(
    SERVICE_ADAPTER_RECEIPT_TYPE,
    payload.type,
    "service_adapter_type_invalid",
  );
  if (!/^(?:promote|readback|rollback)$/.test(payload.operation))
    fail("service_adapter_operation_invalid");
  text(
    payload.repository,
    "service_adapter_repository_invalid",
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
  );
  commit(payload.source_commit, "service_adapter_source_invalid");
  commit(payload.source_git_tree, "service_adapter_tree_invalid");
  hash(payload.aggregate_artifact_digest, "service_adapter_artifact_invalid");
  commit(payload.merge_commit, "service_adapter_merge_invalid");
  exactKeys(
    payload.frappe,
    [
      "artifact_digest",
      "site_schema_digest",
      "previous_revision",
      "candidate_revision",
      "active_revision",
      "backup_digest",
      "provider_readback_digest",
      "status",
    ],
    "service_adapter_frappe_shape_invalid",
  );
  hash(
    payload.frappe.artifact_digest,
    "service_adapter_frappe_artifact_invalid",
  );
  hash(
    payload.frappe.site_schema_digest,
    "service_adapter_frappe_schema_invalid",
  );
  text(
    payload.frappe.previous_revision,
    "service_adapter_frappe_previous_invalid",
  );
  text(
    payload.frappe.candidate_revision,
    "service_adapter_frappe_candidate_invalid",
  );
  text(payload.frappe.active_revision, "service_adapter_frappe_active_invalid");
  if (payload.frappe.previous_revision === payload.frappe.candidate_revision)
    fail("service_adapter_frappe_candidate_not_new");
  equal(
    payload.operation === "rollback"
      ? payload.frappe.previous_revision
      : payload.frappe.candidate_revision,
    payload.frappe.active_revision,
    "service_adapter_frappe_active_drift",
  );
  hash(payload.frappe.backup_digest, "service_adapter_frappe_backup_invalid");
  hash(
    payload.frappe.provider_readback_digest,
    "service_adapter_frappe_readback_invalid",
  );
  equal("matched", payload.frappe.status, "service_adapter_frappe_not_matched");
  hash(
    payload.provider_reconciliation_digest,
    "service_adapter_provider_reconciliation_invalid",
  );
  equal("passed", payload.result, "service_adapter_not_passed");
  text(payload.issuer_principal, "service_adapter_issuer_invalid", IDENTITY_RE);
  text(payload.issuer_task_id, "service_adapter_task_invalid");
  text(payload.issuer_run_id, "service_adapter_run_invalid");
  text(payload.key_version, "service_adapter_key_invalid");
  iso(payload.issued_at, "service_adapter_issued_invalid");
  iso(payload.expires_at, "service_adapter_expires_invalid");
  const issuedMs = Date.parse(payload.issued_at);
  const expiresMs = Date.parse(payload.expires_at);
  if (issuedMs > now + MAX_FUTURE_ISSUED_MS)
    fail("service_adapter_issued_in_future");
  if (
    expiresMs <= now ||
    expiresMs <= issuedMs ||
    expiresMs - issuedMs > MAX_SERVICE_ADAPTER_RECEIPT_LIFETIME_MS
  )
    fail("service_adapter_window_invalid");
  text(payload.nonce, "service_adapter_nonce_invalid", NONCE_RE);
  for (const [key, value] of Object.entries(expected)) {
    if (value !== undefined)
      equal(
        value,
        key.includes(".")
          ? key.split(".").reduce((current, part) => current?.[part], payload)
          : payload[key],
        `service_adapter_${key.replaceAll(".", "_")}_drift`,
      );
  }
  return payload;
}

export function signServiceAdapterReceipt(privateKey, payload, options = {}) {
  if (!privateKey) fail("service_adapter_private_key_required");
  const normalized = validateServiceAdapterReceiptPayload(payload, {}, options);
  const encodedPayload = encode(canonicalJson(normalized));
  const signature = signSignature(
    null,
    Buffer.from(encodedPayload),
    privateKey,
  ).toString("base64url");
  return `${encodedPayload}.${signature}`;
}

export function verifyServiceAdapterReceipt(
  publicKey,
  receipt,
  expected = {},
  options = {},
) {
  if (!publicKey) fail("service_adapter_public_key_required");
  const parts = String(receipt ?? "").split(".");
  if (parts.length !== 2) fail("service_adapter_receipt_invalid");
  const [encodedPayload, encodedSignature] = parts;
  const payloadBytes = decode(
    encodedPayload,
    "service_adapter_receipt_invalid",
  );
  const signature = decode(encodedSignature, "service_adapter_receipt_invalid");
  if (!verifySignature(null, Buffer.from(encodedPayload), publicKey, signature))
    fail("service_adapter_signature_invalid");
  let payload;
  try {
    payload = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    fail("service_adapter_receipt_invalid");
  }
  return validateServiceAdapterReceiptPayload(payload, expected, options);
}

function validateReleaseManifest(manifest, permit) {
  exactKeys(
    manifest,
    [
      "schema",
      "frappe_scope",
      "pr",
      "source",
      "supply_chain",
      "artifacts",
      "configuration",
      "migrations",
      "qa",
      "production_candidates",
      "recovery",
      "provider_reconciliation",
      "evidence_digest",
    ],
    "release_manifest_shape_invalid",
  );
  equal(RELEASE_MANIFEST_SCHEMA, manifest.schema, "release_manifest_schema_invalid");
  text(
    manifest.frappe_scope,
    "release_manifest_frappe_scope_invalid",
    FRAPPE_SCOPE_RE,
  );
  exactKeys(manifest.pr, ["number", "base_ref", "base_commit", "head_ref", "head_commit", "ci_run_id", "ci_merge_commit", "ci_merge_tree", "merge_method", "merge_policy", "provider_readback_digest", "status"], "release_manifest_pr_shape_invalid");
  positiveInteger(manifest.pr.number, "release_manifest_pr_number_invalid");
  equal("main", manifest.pr.base_ref, "release_manifest_pr_base_ref_invalid");
  equal(permit.base_commit, manifest.pr.base_commit, "release_manifest_pr_base_drift");
  text(manifest.pr.head_ref, "release_manifest_pr_head_ref_invalid");
  commit(manifest.pr.head_commit, "release_manifest_pr_head_invalid");
  text(manifest.pr.ci_run_id, "release_manifest_pr_ci_run_invalid");
  equal(permit.source_commit, manifest.pr.ci_merge_commit, "release_manifest_pr_merge_drift");
  equal(permit.source_git_tree, manifest.pr.ci_merge_tree, "release_manifest_pr_tree_drift");
  equal("squash", manifest.pr.merge_method, "release_manifest_pr_merge_method_invalid");
  exactKeys(manifest.pr.merge_policy, ["schema", "method", "repository_settings", "ruleset", "readback_digest"], "release_manifest_pr_merge_policy_shape_invalid");
  equal("ironwrap_github_merge_policy_v1", manifest.pr.merge_policy.schema, "release_manifest_pr_merge_policy_schema_invalid");
  equal("squash", manifest.pr.merge_policy.method, "release_manifest_pr_merge_policy_method_invalid");
  exactKeys(manifest.pr.merge_policy.repository_settings, ["default_branch", "allow_merge_commit", "allow_squash_merge", "allow_rebase_merge"], "release_manifest_pr_repository_settings_shape_invalid");
  equal("main", manifest.pr.merge_policy.repository_settings.default_branch, "release_manifest_pr_default_branch_invalid");
  equal(false, manifest.pr.merge_policy.repository_settings.allow_merge_commit, "release_manifest_pr_merge_commit_must_be_disabled");
  equal(true, manifest.pr.merge_policy.repository_settings.allow_squash_merge, "release_manifest_pr_squash_must_be_enabled");
  equal(true, manifest.pr.merge_policy.repository_settings.allow_rebase_merge, "release_manifest_pr_rebase_must_be_enabled");
  exactKeys(manifest.pr.merge_policy.ruleset, ["id", "target", "enforcement", "allowed_merge_methods"], "release_manifest_pr_ruleset_shape_invalid");
  positiveInteger(manifest.pr.merge_policy.ruleset.id, "release_manifest_pr_ruleset_id_invalid");
  equal("branch", manifest.pr.merge_policy.ruleset.target, "release_manifest_pr_ruleset_target_invalid");
  equal("active", manifest.pr.merge_policy.ruleset.enforcement, "release_manifest_pr_ruleset_enforcement_invalid");
  equal(canonicalJson(["rebase", "squash"]), canonicalJson(manifest.pr.merge_policy.ruleset.allowed_merge_methods), "release_manifest_pr_ruleset_methods_invalid");
  hash(manifest.pr.merge_policy.readback_digest, "release_manifest_pr_merge_policy_digest_invalid");
  const mergePolicyFields = { ...manifest.pr.merge_policy };
  delete mergePolicyFields.readback_digest;
  equal(sha256(canonicalJson(mergePolicyFields)), manifest.pr.merge_policy.readback_digest, "release_manifest_pr_merge_policy_digest_mismatch");
  hash(manifest.pr.provider_readback_digest, "release_manifest_pr_readback_invalid");
  // A release is admitted either before its merge (the pull_request-sourced
  // train merges the PR itself, status "open") or after it (a push-sourced run
  // on main, where the squash commit is already the tip, status "merged").
  // Both are exact, readback-verified source states; no other PR state is.
  if (manifest.pr.status !== "open" && manifest.pr.status !== "merged") fail("release_manifest_pr_status_invalid");
  exactKeys(manifest.source, ["commit", "git_tree", "tree_manifest_sha256", "diff_sha256", "component_digests"], "release_manifest_source_shape_invalid");
  equal(permit.source_commit, manifest.source.commit, "release_manifest_source_commit_drift");
  equal(permit.source_git_tree, manifest.source.git_tree, "release_manifest_source_tree_drift");
  equal(permit.source_tree_sha256, manifest.source.tree_manifest_sha256, "release_manifest_source_manifest_drift");
  equal(permit.diff_sha256, manifest.source.diff_sha256, "release_manifest_source_diff_drift");
  exactKeys(manifest.source.component_digests, ["worker", "pwa", "frappe", "mcp", "hermes", "tenant_config"], "release_manifest_component_shape_invalid");
  for (const value of Object.values(manifest.source.component_digests)) hash(value, "release_manifest_component_digest_invalid");
  validateSupplyChainEvidence(manifest.supply_chain, "release_manifest");
  exactKeys(manifest.artifacts, ["aggregate_digest", "worker_digest", "pwa_digest", "frappe_wheel_digest", "frappe_site_schema_digest", "mcp_digest", "hermes_digest"], "release_manifest_artifacts_shape_invalid");
  for (const value of Object.values(manifest.artifacts)) hash(value, "release_manifest_artifact_digest_invalid");
  equal(permit.worker.artifact_digest, manifest.artifacts.aggregate_digest, "release_manifest_aggregate_artifact_drift");
  exactKeys(manifest.configuration, ["aggregate_digest", "tenant_digest", "mcp_digest", "hermes_digest", "bindings_digest", "queues_digest", "buckets_digest", "routes_digest", "secret_names_digest"], "release_manifest_configuration_shape_invalid");
  for (const value of Object.values(manifest.configuration)) hash(value, "release_manifest_configuration_digest_invalid");
  equal(permit.config_digest, manifest.configuration.aggregate_digest, "release_manifest_config_drift");
  exactKeys(manifest.migrations, ["d1_set_digest", "frappe_schema_digest", "frappe_migration_digest", "compatibility"], "release_manifest_migrations_shape_invalid");
  equal(permit.migrations.set_digest, manifest.migrations.d1_set_digest, "release_manifest_d1_migration_drift");
  hash(manifest.migrations.frappe_schema_digest, "release_manifest_frappe_schema_invalid");
  hash(manifest.migrations.frappe_migration_digest, "release_manifest_frappe_migration_invalid");
  equal("expand-contract", manifest.migrations.compatibility, "release_manifest_migration_compatibility_invalid");
  exactKeys(manifest.qa, ["worker_revision", "worker_readback_digest", "pwa_revision", "pwa_readback_digest", "frappe_revision", "frappe_readback_digest", "status"], "release_manifest_qa_shape_invalid");
  equal(permit.qa.revision, manifest.qa.worker_revision, "release_manifest_qa_worker_drift");
  equal(permit.worker.qa_version_digest, manifest.qa.worker_readback_digest, "release_manifest_qa_worker_readback_drift");
  text(manifest.qa.pwa_revision, "release_manifest_qa_pwa_invalid");
  equal(permit.qa.revision, manifest.qa.pwa_revision, "release_manifest_qa_pwa_drift");
  hash(manifest.qa.pwa_readback_digest, "release_manifest_qa_pwa_readback_invalid");
  text(manifest.qa.frappe_revision, "release_manifest_qa_frappe_invalid");
  hash(manifest.qa.frappe_readback_digest, "release_manifest_qa_frappe_readback_invalid");
  equal("matched", manifest.qa.status, "release_manifest_qa_not_matched");
  exactKeys(
    manifest.production_candidates,
    [
      "pwa_revision",
      "pwa_readback_digest",
      "frappe_revision",
      "frappe_readback_digest",
      "domain_hostname",
      "domain_service",
      "domain_zone_id",
      "status",
    ],
    "release_manifest_production_candidates_shape_invalid",
  );
  equal(
    permit.production.revision,
    manifest.production_candidates.pwa_revision,
    "release_manifest_production_pwa_drift",
  );
  equal(
    permit.worker.production_version_digest,
    manifest.production_candidates.pwa_readback_digest,
    "release_manifest_production_pwa_readback_drift",
  );
  text(
    manifest.production_candidates.frappe_revision,
    "release_manifest_production_frappe_invalid",
  );
  hash(
    manifest.production_candidates.frappe_readback_digest,
    "release_manifest_production_frappe_readback_invalid",
  );
  equal(
    "prepared",
    manifest.production_candidates.status,
    "release_manifest_production_candidates_not_prepared",
  );
  text(
    manifest.production_candidates.domain_hostname,
    "release_manifest_production_domain_hostname_invalid",
    DOMAIN_HOSTNAME_RE,
  );
  text(
    manifest.production_candidates.domain_service,
    "release_manifest_production_domain_service_invalid",
  );
  text(
    manifest.production_candidates.domain_zone_id,
    "release_manifest_production_domain_zone_invalid",
    DOMAIN_ZONE_RE,
  );
  exactKeys(manifest.recovery, [
    "qa_backup_restore_digest",
    "qa_rollback_digest",
    "production_d1_recovery_digest",
    "prior_worker_revision",
    "prior_worker_readback_digest",
    "prior_pwa_revision",
    "prior_pwa_readback_digest",
    "prior_frappe_revision",
    "prior_frappe_readback_digest",
    "prior_frappe_backup_digest",
    "status",
  ], "release_manifest_recovery_shape_invalid");
  hash(manifest.recovery.qa_backup_restore_digest, "release_manifest_backup_digest_invalid");
  equal(permit.backup_restore.evidence_digest, manifest.recovery.qa_backup_restore_digest, "release_manifest_backup_drift");
  hash(manifest.recovery.qa_rollback_digest, "release_manifest_rollback_digest_invalid");
  equal(permit.rollback.evidence_digest, manifest.recovery.qa_rollback_digest, "release_manifest_rollback_drift");
  hash(manifest.recovery.production_d1_recovery_digest, "release_manifest_d1_recovery_digest_invalid");
  equal(sha256(canonicalJson(permit.production_recovery)), manifest.recovery.production_d1_recovery_digest, "release_manifest_d1_recovery_drift");
  text(manifest.recovery.prior_worker_revision, "release_manifest_prior_worker_invalid", UUID_RE);
  hash(manifest.recovery.prior_worker_readback_digest, "release_manifest_prior_worker_readback_invalid");
  text(manifest.recovery.prior_pwa_revision, "release_manifest_prior_pwa_invalid");
  hash(manifest.recovery.prior_pwa_readback_digest, "release_manifest_prior_pwa_readback_invalid");
  text(manifest.recovery.prior_frappe_revision, "release_manifest_prior_frappe_invalid");
  hash(manifest.recovery.prior_frappe_readback_digest, "release_manifest_prior_frappe_readback_invalid");
  hash(manifest.recovery.prior_frappe_backup_digest, "release_manifest_prior_frappe_backup_invalid");
  equal("passed", manifest.recovery.status, "release_manifest_recovery_not_passed");
  validateProviderReconciliation(manifest.provider_reconciliation, "release_manifest");
  const digestFields = { ...manifest };
  delete digestFields.evidence_digest;
  hash(manifest.evidence_digest, "release_manifest_evidence_digest_invalid");
  equal(sha256(canonicalJson(digestFields)), manifest.evidence_digest, "release_manifest_evidence_digest_mismatch");
}

export function validateSourceMergeReceipt(receipt, permit, { now = Date.now(), permitDigest: expectedPermitDigest } = {}) {
  // IRO-264: a tag-triggered production release admits a commit that main may
  // have already moved past, so the `reachable` source policy replaces the tip
  // equality below with a provider reachability readback. The policy declares
  // itself in the receipt and is OPTIONAL: a receipt without these two keys is
  // read as the strict tip policy, so dropping them tightens the check rather
  // than relaxing it, and every pre-IRO-264 receipt stays valid unchanged.
  const reachable = receipt?.source_policy === "reachable";
  if (isRecord(receipt) && receipt.source_policy !== undefined && !reachable) {
    fail("source_merge_policy_invalid");
  }
  exactKeys(receipt, [
    "schema",
    "repository",
    "pr_number",
    "head_commit",
    "base_commit",
    "ci_merge_commit",
    "expected_tree",
    "merge_method",
    "provider_settings_digest",
    "merge_commit",
    "merge_tree",
    "main_commit",
    ...(reachable ? ["source_policy", "main_reachability"] : []),
    "permit_digest",
    "admission_digest",
    "status",
    "evidence_digest",
    "observed_at",
  ], "source_merge_shape_invalid");
  equal(SOURCE_MERGE_SCHEMA, receipt.schema, "source_merge_schema_invalid");
  equal(permit.repository, receipt.repository, "source_merge_repository_drift");
  equal(permit.release_manifest.pr.number, receipt.pr_number, "source_merge_pr_drift");
  equal(permit.release_manifest.pr.head_commit, receipt.head_commit, "source_merge_head_drift");
  equal(permit.base_commit, receipt.base_commit, "source_merge_base_drift");
  equal(permit.source_commit, receipt.ci_merge_commit, "source_merge_ci_merge_drift");
  equal(permit.source_git_tree, receipt.expected_tree, "source_merge_expected_tree_drift");
  equal("squash", receipt.merge_method, "source_merge_method_invalid");
  equal(permit.release_manifest.pr.merge_policy.readback_digest, receipt.provider_settings_digest, "source_merge_provider_settings_drift");
  commit(receipt.merge_commit, "source_merge_commit_invalid");
  if (reachable) {
    // main may legitimately have advanced past the tagged commit; it may not
    // have dropped it. `ahead` means main moved on, `identical` means the
    // commit is still the tip. Anything else never reaches here.
    commit(receipt.main_commit, "source_merge_main_invalid");
    if (receipt.main_reachability !== "ahead" && receipt.main_reachability !== "identical") {
      fail("source_merge_main_not_reachable");
    }
  } else {
    equal(receipt.merge_commit, receipt.main_commit, "source_merge_main_drift");
  }
  equal(permit.source_git_tree, receipt.merge_tree, "source_merge_tree_drift");
  hash(receipt.permit_digest, "source_merge_permit_digest_invalid");
  if (expectedPermitDigest !== undefined) equal(expectedPermitDigest, receipt.permit_digest, "source_merge_permit_digest_drift");
  hash(receipt.admission_digest, "source_merge_admission_digest_invalid");
  equal("merged", receipt.status, "source_merge_not_merged");
  hash(receipt.evidence_digest, "source_merge_evidence_digest_invalid");
  iso(receipt.observed_at, "source_merge_observed_at_invalid");
  const fields = { ...receipt };
  delete fields.evidence_digest;
  delete fields.observed_at;
  equal(sha256(canonicalJson(fields)), receipt.evidence_digest, "source_merge_evidence_digest_mismatch");
  if (Date.parse(receipt.observed_at) > now + MAX_FUTURE_ISSUED_MS) fail("source_merge_observed_in_future");
  return receipt;
}

export function validateProductionRollbackReceipt(
  receipt,
  permit,
  { now = Date.now() } = {},
) {
  exactKeys(
    receipt,
    [
      "schema",
      "source_commit",
      "frappe_scope",
      "previous_revision",
      "candidate_revision",
      "restored_revision",
      "result",
      "readback",
      "provider_readback_digest",
      "pwa_previous_revision",
      "pwa_candidate_revision",
      "pwa_restored_revision",
      "pwa_provider_readback_digest",
      "frappe_previous_revision",
      "frappe_candidate_revision",
      "frappe_restored_revision",
      "frappe_provider_readback_digest",
      "service_rollback_digest",
      "health_digest",
      "readiness_digest",
      "evidence_digest",
      "observed_at",
    ],
    "production_rollback_shape_invalid",
  );
  equal("ironwrap_production_rollback_v3", receipt.schema, "production_rollback_schema_invalid");
  equal(permit.source_commit, receipt.source_commit, "production_rollback_source_drift");
  text(receipt.frappe_scope, "production_rollback_frappe_scope_invalid", FRAPPE_SCOPE_RE);
  equal(
    permit.release_manifest.frappe_scope,
    receipt.frappe_scope,
    "production_rollback_frappe_scope_drift",
  );
  text(receipt.previous_revision, "production_rollback_previous_invalid", UUID_RE);
  equal(permit.worker.production_version_id, receipt.candidate_revision, "production_rollback_candidate_drift");
  equal(receipt.previous_revision, receipt.restored_revision, "production_rollback_restored_drift");
  equal(
    permit.release_manifest.recovery.prior_worker_revision,
    receipt.previous_revision,
    "production_rollback_previous_drift",
  );
  if (receipt.previous_revision === receipt.candidate_revision) fail("production_rollback_candidate_not_new");
  equal("passed", receipt.result, "production_rollback_not_passed");
  equal("matched", receipt.readback, "production_rollback_readback_invalid");
  hash(receipt.provider_readback_digest, "production_rollback_provider_readback_invalid");
  equal(
    permit.release_manifest.recovery.prior_worker_readback_digest,
    receipt.provider_readback_digest,
    "production_rollback_provider_readback_drift",
  );
  equal(
    permit.release_manifest.recovery.prior_pwa_revision,
    receipt.pwa_previous_revision,
    "production_rollback_pwa_previous_drift",
  );
  equal(
    permit.release_manifest.production_candidates.pwa_revision,
    receipt.pwa_candidate_revision,
    "production_rollback_pwa_candidate_drift",
  );
  equal(
    receipt.pwa_previous_revision,
    receipt.pwa_restored_revision,
    "production_rollback_pwa_restored_drift",
  );
  hash(
    receipt.pwa_provider_readback_digest,
    "production_rollback_pwa_readback_invalid",
  );
  equal(
    permit.release_manifest.recovery.prior_pwa_readback_digest,
    receipt.pwa_provider_readback_digest,
    "production_rollback_pwa_readback_drift",
  );
  const leftoverFrappeDigest = sha256("frappe-not-required");
  if (receipt.frappe_scope === "in-scope") {
    equal(
      permit.release_manifest.recovery.prior_frappe_revision,
      receipt.frappe_previous_revision,
      "production_rollback_frappe_previous_drift",
    );
    equal(
      permit.release_manifest.production_candidates.frappe_revision,
      receipt.frappe_candidate_revision,
      "production_rollback_frappe_candidate_drift",
    );
    equal(
      receipt.frappe_previous_revision,
      receipt.frappe_restored_revision,
      "production_rollback_frappe_restored_drift",
    );
    equal(
      permit.release_manifest.recovery.prior_frappe_readback_digest,
      receipt.frappe_provider_readback_digest,
      "production_rollback_frappe_readback_drift",
    );
    if (receipt.service_rollback_digest === leftoverFrappeDigest) {
      fail("production_rollback_frappe_receipt_missing");
    }
  } else {
    for (const value of [
      receipt.frappe_previous_revision,
      receipt.frappe_candidate_revision,
      receipt.frappe_restored_revision,
    ]) {
      equal(
        "leftover-not-promoted",
        value,
        "production_rollback_frappe_scope_drift",
      );
    }
    equal(
      leftoverFrappeDigest,
      receipt.frappe_provider_readback_digest,
      "production_rollback_frappe_scope_drift",
    );
    equal(
      leftoverFrappeDigest,
      receipt.service_rollback_digest,
      "production_rollback_frappe_scope_drift",
    );
  }
  hash(
    receipt.frappe_provider_readback_digest,
    "production_rollback_frappe_readback_invalid",
  );
  hash(receipt.service_rollback_digest, "production_rollback_service_digest_invalid");
  hash(receipt.health_digest, "production_rollback_health_invalid");
  hash(receipt.readiness_digest, "production_rollback_readiness_invalid");
  hash(receipt.evidence_digest, "production_rollback_evidence_invalid");
  iso(receipt.observed_at, "production_rollback_observed_at_invalid");
  const fields = { ...receipt };
  delete fields.evidence_digest;
  delete fields.observed_at;
  equal(sha256(canonicalJson(fields)), receipt.evidence_digest, "production_rollback_evidence_mismatch");
  if (Date.parse(receipt.observed_at) > now + MAX_FUTURE_ISSUED_MS) fail("production_rollback_observed_in_future");
  return receipt;
}

function validateOutcomeReceipt(receipt) {
  exactKeys(receipt, ["schema", "kind", "repository", "source_commit", "generation", "permit_digest", "merge_receipt_digest", "outcome_digest", "recorded_at"], "release_outcome_shape_invalid");
  equal(RELEASE_OUTCOME_SCHEMA, receipt.schema, "release_outcome_schema_invalid");
  if (!/^(?:production_success|production_rollback|production_recovery_required)$/.test(receipt.kind)) fail("release_outcome_kind_invalid");
  text(receipt.repository, "release_outcome_repository_invalid", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  commit(receipt.source_commit, "release_outcome_source_invalid");
  positiveInteger(receipt.generation, "release_outcome_generation_invalid");
  hash(receipt.permit_digest, "release_outcome_permit_invalid");
  hash(receipt.merge_receipt_digest, "release_outcome_merge_invalid");
  hash(receipt.outcome_digest, "release_outcome_digest_invalid");
  iso(receipt.recorded_at, "release_outcome_recorded_invalid");
  return receipt;
}

export function validateProductionRecoveryRequiredReceipt(
  receipt,
  permit,
  { now = Date.now(), permitDigest: expectedPermitDigest } = {},
) {
  exactKeys(receipt, [
    "schema", "repository", "source_commit", "generation", "permit_digest",
    "merge_receipt_digest", "merge_commit", "failure_stage", "migration_state",
    "provider_promotion", "production_d1_recovery_digest", "prior_worker_revision",
    "prior_worker_readback_digest", "prior_pwa_revision", "prior_pwa_readback_digest",
    "prior_frappe_revision", "prior_frappe_readback_digest", "prior_frappe_backup_digest",
    "result", "evidence_digest", "observed_at",
  ], "production_recovery_required_shape_invalid");
  equal(PRODUCTION_RECOVERY_REQUIRED_SCHEMA, receipt.schema, "production_recovery_required_schema_invalid");
  equal(permit.repository, receipt.repository, "production_recovery_required_repository_drift");
  equal(permit.source_commit, receipt.source_commit, "production_recovery_required_source_drift");
  equal(permit.generation, receipt.generation, "production_recovery_required_generation_drift");
  hash(receipt.permit_digest, "production_recovery_required_permit_invalid");
  if (expectedPermitDigest !== undefined) equal(expectedPermitDigest, receipt.permit_digest, "production_recovery_required_permit_drift");
  hash(receipt.merge_receipt_digest, "production_recovery_required_merge_invalid");
  commit(receipt.merge_commit, "production_recovery_required_merge_commit_invalid");
  const recoveryState = RECOVERY_REQUIRED_STATES[receipt.failure_stage];
  if (!recoveryState) fail("production_recovery_required_stage_invalid");
  equal(
    recoveryState.migration_state,
    receipt.migration_state,
    "production_recovery_required_migration_state_invalid",
  );
  equal(
    recoveryState.provider_promotion,
    receipt.provider_promotion,
    "production_recovery_required_provider_state_invalid",
  );
  equal(permit.release_manifest.recovery.production_d1_recovery_digest, receipt.production_d1_recovery_digest, "production_recovery_required_d1_recovery_drift");
  equal(permit.release_manifest.recovery.prior_worker_revision, receipt.prior_worker_revision, "production_recovery_required_worker_drift");
  equal(permit.release_manifest.recovery.prior_worker_readback_digest, receipt.prior_worker_readback_digest, "production_recovery_required_worker_readback_drift");
  equal(permit.release_manifest.recovery.prior_pwa_revision, receipt.prior_pwa_revision, "production_recovery_required_pwa_drift");
  equal(permit.release_manifest.recovery.prior_pwa_readback_digest, receipt.prior_pwa_readback_digest, "production_recovery_required_pwa_readback_drift");
  equal(permit.release_manifest.recovery.prior_frappe_revision, receipt.prior_frappe_revision, "production_recovery_required_frappe_drift");
  equal(permit.release_manifest.recovery.prior_frappe_readback_digest, receipt.prior_frappe_readback_digest, "production_recovery_required_frappe_readback_drift");
  equal(permit.release_manifest.recovery.prior_frappe_backup_digest, receipt.prior_frappe_backup_digest, "production_recovery_required_frappe_backup_drift");
  equal("recovery_required", receipt.result, "production_recovery_required_result_invalid");
  hash(receipt.evidence_digest, "production_recovery_required_evidence_invalid");
  iso(receipt.observed_at, "production_recovery_required_observed_at_invalid");
  const fields = { ...receipt };
  delete fields.evidence_digest;
  delete fields.observed_at;
  equal(sha256(canonicalJson(fields)), receipt.evidence_digest, "production_recovery_required_evidence_mismatch");
  if (Date.parse(receipt.observed_at) > now + MAX_FUTURE_ISSUED_MS) fail("production_recovery_required_observed_in_future");
  return receipt;
}

/** Validate the redacted, exact Cloudflare Workers custom-domain readback. */
export function validateDomainReadbackReceipt(receipt, expected = {}) {
  exactKeys(
    receipt,
    [
      "schema",
      "type",
      "hostname",
      "service",
      "zone_id",
      "provider_readback_digest",
      "status",
    ],
    "domain_readback_shape_invalid",
  );
  equal(DOMAIN_READBACK_SCHEMA, receipt.schema, "domain_readback_schema_invalid");
  equal(DOMAIN_READBACK_TYPE, receipt.type, "domain_readback_type_invalid");
  text(receipt.hostname, "domain_readback_hostname_invalid", DOMAIN_HOSTNAME_RE);
  text(receipt.service, "domain_readback_service_invalid");
  text(receipt.zone_id, "domain_readback_zone_invalid", DOMAIN_ZONE_RE);
  hash(receipt.provider_readback_digest, "domain_readback_digest_invalid");
  equal("matched", receipt.status, "domain_readback_status_invalid");
  if (expected.providerResult !== undefined) {
    equal(
      sha256(canonicalJson(expected.providerResult)),
      receipt.provider_readback_digest,
      "domain_readback_digest_mismatch",
    );
  }
  for (const [key, value] of Object.entries({
    hostname: expected.hostname,
    service: expected.service,
    zone_id: expected.zoneId,
    provider_readback_digest: expected.providerReadbackDigest,
  })) {
    if (value !== undefined) equal(value, receipt[key], `domain_readback_${key}_drift`);
  }
  return receipt;
}

/** Validate the immutable post-promotion proof required before generation advance. */
export function validateProductionPromotionReceipt(
  receipt,
  expected = {},
  { now = Date.now() } = {},
) {
  exactKeys(
    receipt,
    [
      "schema",
      "type",
      "source_commit",
      "source_tree_sha256",
      "artifact_digest",
      "config_digest",
      "frappe_scope",
      "revision",
      "version_digest",
      "merge_commit",
      "merge_receipt_digest",
      "active_revision",
      "active_readback",
      "pwa_revision",
      "pwa_readback_digest",
      "frappe_revision",
      "frappe_readback_digest",
      "service_promotion_digest",
      "service_readback_digest",
      "domain_hostname",
      "domain_service",
      "domain_zone_id",
      "domain_provider_readback_digest",
      "smoke_evidence_digest",
      "smoke_result",
      "smoke_step_names",
      "health_digest",
      "readiness_digest",
      "evidence_digest",
      "observed_at",
    ],
    "production_promotion_shape_invalid",
  );
  equal(PRODUCTION_PROMOTION_SCHEMA, receipt.schema, "production_promotion_schema_invalid");
  equal(PRODUCTION_PROMOTION_TYPE, receipt.type, "production_promotion_type_invalid");
  commit(receipt.source_commit, "production_promotion_source_invalid");
  hash(receipt.source_tree_sha256, "production_promotion_tree_invalid");
  hash(receipt.artifact_digest, "production_promotion_artifact_invalid");
  hash(receipt.config_digest, "production_promotion_config_invalid");
  text(receipt.frappe_scope, "production_promotion_frappe_scope_invalid", FRAPPE_SCOPE_RE);
  text(receipt.revision, "production_promotion_revision_invalid", UUID_RE);
  hash(receipt.version_digest, "production_promotion_version_digest_invalid");
  commit(receipt.merge_commit, "production_promotion_merge_commit_invalid");
  hash(receipt.merge_receipt_digest, "production_promotion_merge_receipt_invalid");
  text(receipt.active_revision, "production_promotion_active_revision_invalid", UUID_RE);
  equal(receipt.revision, receipt.active_revision, "production_promotion_active_revision_drift");
  equal("matched", receipt.active_readback, "production_promotion_active_readback_invalid");
  text(receipt.pwa_revision, "production_promotion_pwa_revision_invalid");
  equal(
    receipt.revision,
    receipt.pwa_revision,
    "production_promotion_pwa_revision_drift",
  );
  hash(
    receipt.pwa_readback_digest,
    "production_promotion_pwa_readback_invalid",
  );
  text(receipt.frappe_revision, "production_promotion_frappe_revision_invalid");
  hash(
    receipt.frappe_readback_digest,
    "production_promotion_frappe_readback_invalid",
  );
  hash(
    receipt.service_promotion_digest,
    "production_promotion_service_digest_invalid",
  );
  hash(
    receipt.service_readback_digest,
    "production_promotion_service_readback_digest_invalid",
  );
  text(
    receipt.domain_hostname,
    "production_promotion_domain_hostname_invalid",
    DOMAIN_HOSTNAME_RE,
  );
  text(receipt.domain_service, "production_promotion_domain_service_invalid");
  text(
    receipt.domain_zone_id,
    "production_promotion_domain_zone_invalid",
    DOMAIN_ZONE_RE,
  );
  hash(
    receipt.domain_provider_readback_digest,
    "production_promotion_domain_readback_digest_invalid",
  );
  const leftoverFrappeDigest = sha256("frappe-not-required");
  if (receipt.frappe_scope === "in-scope" &&
      (receipt.frappe_revision === "leftover-not-promoted" ||
       receipt.frappe_readback_digest === leftoverFrappeDigest ||
       receipt.service_promotion_digest === leftoverFrappeDigest ||
       receipt.service_readback_digest === leftoverFrappeDigest)) {
    fail("production_promotion_frappe_receipt_missing");
  }
  if (receipt.frappe_scope === "out-of-scope" &&
      (receipt.frappe_revision !== "leftover-not-promoted" ||
       receipt.frappe_readback_digest !== leftoverFrappeDigest ||
       receipt.service_promotion_digest !== leftoverFrappeDigest ||
       receipt.service_readback_digest !== leftoverFrappeDigest)) {
    fail("production_promotion_frappe_scope_drift");
  }
  hash(receipt.smoke_evidence_digest, "production_promotion_smoke_digest_invalid");
  equal("passed", receipt.smoke_result, "production_promotion_smoke_invalid");
  if (!Array.isArray(receipt.smoke_step_names) || JSON.stringify([...receipt.smoke_step_names].sort()) !== JSON.stringify([...LAUNCH_PROOF_STEP_NAMES].sort())) fail("production_promotion_smoke_steps_invalid");
  hash(receipt.health_digest, "production_promotion_health_digest_invalid");
  hash(receipt.readiness_digest, "production_promotion_readiness_digest_invalid");
  hash(receipt.evidence_digest, "production_promotion_evidence_digest_invalid");
  iso(receipt.observed_at, "production_promotion_observed_at_invalid");
  for (const [key, value] of Object.entries({
    source_commit: expected.sourceCommit,
    source_tree_sha256: expected.sourceTreeSha256,
    artifact_digest: expected.artifactDigest,
    config_digest: expected.configDigest,
    revision: expected.revision,
    version_digest: expected.versionDigest,
    merge_commit: expected.mergeCommit,
    merge_receipt_digest: expected.mergeReceiptDigest,
    pwa_revision: expected.pwaRevision,
    pwa_readback_digest: expected.pwaReadbackDigest,
    frappe_revision: expected.frappeRevision,
    frappe_readback_digest: expected.frappeReadbackDigest,
    frappe_scope: expected.frappeScope,
    domain_hostname: expected.domainHostname,
    domain_service: expected.domainService,
    domain_zone_id: expected.domainZoneId,
    domain_provider_readback_digest: expected.domainProviderReadbackDigest,
  }))
    if (value !== undefined) equal(value, receipt[key], `production_promotion_${key}_drift`);
  const digest = sha256(
    canonicalJson({
      source_commit: receipt.source_commit,
      source_tree_sha256: receipt.source_tree_sha256,
      artifact_digest: receipt.artifact_digest,
      config_digest: receipt.config_digest,
      frappe_scope: receipt.frappe_scope,
      revision: receipt.revision,
      version_digest: receipt.version_digest,
      merge_commit: receipt.merge_commit,
      merge_receipt_digest: receipt.merge_receipt_digest,
      pwa_revision: receipt.pwa_revision,
      pwa_readback_digest: receipt.pwa_readback_digest,
      frappe_revision: receipt.frappe_revision,
      frappe_readback_digest: receipt.frappe_readback_digest,
      service_promotion_digest: receipt.service_promotion_digest,
      service_readback_digest: receipt.service_readback_digest,
      domain_hostname: receipt.domain_hostname,
      domain_service: receipt.domain_service,
      domain_zone_id: receipt.domain_zone_id,
      domain_provider_readback_digest: receipt.domain_provider_readback_digest,
      smoke_evidence_digest: receipt.smoke_evidence_digest,
      smoke_result: receipt.smoke_result,
      smoke_step_names: receipt.smoke_step_names,
      health_digest: receipt.health_digest,
      readiness_digest: receipt.readiness_digest,
    }),
  );
  equal(digest, receipt.evidence_digest, "production_promotion_evidence_digest_mismatch");
  if (Date.parse(receipt.observed_at) > now + MAX_FUTURE_ISSUED_MS) fail("production_promotion_observed_in_future");
  return receipt;
}

/** Validate the unsigned canonical payload, rejecting unknown or incomplete proof fields. */
export function validateReleasePermitPayload(payload, { now = Date.now() } = {}) {
  exactKeys(payload, PERMIT_KEYS, "payload_shape_invalid");
  equal(RELEASE_PERMIT_SCHEMA, payload.schema, "schema_invalid");
  equal(RELEASE_PERMIT_TYPE, payload.type, "type_invalid");
  text(payload.permit_id, "permit_id_invalid");
  text(payload.repository, "repository_invalid", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  commit(payload.source_commit);
  commit(payload.base_commit, "base_commit_invalid");
  commit(payload.source_git_tree, "source_git_tree_invalid");
  hash(payload.source_tree_sha256, "source_tree_digest_invalid");
  hash(payload.diff_sha256, "diff_digest_invalid");
  validateChecks(payload.ci_checks, { repository: payload.repository, sourceCommit: payload.source_commit });
  exactKeys(payload.previous_generation, ["generation", "policy_hash"], "previous_generation_shape_invalid");
  nonNegativeInteger(payload.previous_generation.generation, "previous_generation_invalid");
  hash(payload.previous_generation.policy_hash, "previous_policy_hash_invalid");
  positiveInteger(payload.generation, "generation_invalid");
  equal(payload.previous_generation.generation + 1, payload.generation, "generation_not_sequential");
  hash(payload.policy_hash, "policy_hash_invalid");
  hash(payload.config_digest, "config_digest_invalid");
  validateMigrations(payload.migrations);
  validateBuild(payload.build_once);
  equal(payload.source_commit, payload.build_once.source_commit, "build_source_drift");
  equal(payload.source_tree_sha256, payload.build_once.source_tree_sha256, "build_tree_drift");
  validateWorker(payload.worker);
  equal(payload.build_once.artifact_digest, payload.worker.artifact_digest, "worker_artifact_drift");
  equal(
    sha256(canonicalJson({
      production: payload.worker.production_config_digest,
      qa: payload.worker.qa_config_digest,
    })),
    payload.config_digest,
    "config_manifest_digest_mismatch",
  );
  validateQa(payload.qa, payload);
  validateProduction(payload.production, payload);
  validateSmoke(payload.smoke, payload);
  validateBackupRestore(payload.backup_restore, payload);
  validateProductionRecovery(payload.production_recovery);
  validateRollback(payload.rollback, payload);
  validateReleaseManifest(payload.release_manifest, payload);
  text(payload.issuer_identity, "issuer_identity_invalid", IDENTITY_RE);
  iso(payload.issued_at, "issued_at_invalid");
  iso(payload.expires_at, "expires_at_invalid");
  const issuedMs = Date.parse(payload.issued_at);
  const expiresMs = Date.parse(payload.expires_at);
  if (issuedMs > now + MAX_FUTURE_ISSUED_MS) fail("issued_in_future");
  if (expiresMs <= now) fail("expired");
  if (expiresMs <= issuedMs || expiresMs - issuedMs > MAX_PERMIT_LIFETIME_MS) fail("window_invalid");
  text(payload.nonce, "nonce_invalid", NONCE_RE);
  return payload;
}

/** Sign a canonical payload with Ed25519. The token contains no secret material. */
export function signReleasePermit(privateKey, payload, options = {}) {
  if (!privateKey) fail("private_key_required");
  const normalized = validateReleasePermitPayload(payload, options);
  const encodedPayload = encode(canonicalJson(normalized));
  const signature = signSignature(null, Buffer.from(encodedPayload), privateKey).toString("base64url");
  return `${encodedPayload}.${signature}`;
}

/** Verify signature, schema, proof bindings, time window, and optional live expectations. */
export function verifyReleasePermit(publicKey, permit, expected = {}, options = {}) {
  if (!publicKey) fail("public_key_required");
  const parts = String(permit ?? "").split(".");
  if (parts.length !== 2) fail("token_invalid");
  const [encodedPayload, encodedSignature] = parts;
  const signature = decode(encodedSignature, "token_invalid");
  const payloadBytes = decode(encodedPayload, "token_invalid");
  if (!verifySignature(null, Buffer.from(encodedPayload), publicKey, signature)) fail("signature_invalid");
  let payload;
  try {
    payload = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    fail("payload_invalid");
  }
  validateReleasePermitPayload(payload, options);
  const fields = [
    "repository",
    "source_commit",
    "base_commit",
    "source_git_tree",
    "source_tree_sha256",
    "diff_sha256",
    "config_digest",
    "policy_hash",
  ];
  for (const field of fields) if (expected[field] !== undefined) equal(expected[field], payload[field], `expected_${field}_mismatch`);
  if (expected.frappe_scope !== undefined) {
    equal(
      expected.frappe_scope,
      payload.release_manifest.frappe_scope,
      "expected_frappe_scope_mismatch",
    );
  }
  if (expected.current_generation !== undefined) equal(expected.current_generation + 1, payload.generation, "generation_gate_mismatch");
  if (expected.current_policy_hash !== undefined) equal(expected.current_policy_hash, payload.previous_generation.policy_hash, "previous_policy_gate_mismatch");
  if (expected.required_check_ids !== undefined) {
    const ids = new Set(payload.ci_checks.map((check) => check.check_id));
    for (const id of expected.required_check_ids) if (!ids.has(id)) fail("required_ci_check_missing");
  }
  return payload;
}

function verifyAdmittedReleasePermit(publicKey, permit) {
  const parts = String(permit ?? "").split(".");
  if (parts.length !== 2) fail("token_invalid");
  let unsigned;
  try {
    unsigned = JSON.parse(decode(parts[0], "token_invalid").toString("utf8"));
  } catch {
    fail("payload_invalid");
  }
  const issuedMs = Date.parse(unsigned?.issued_at);
  if (!Number.isFinite(issuedMs)) fail("issued_at_invalid");
  return verifyReleasePermit(publicKey, permit, {}, { now: issuedMs + 1 });
}

/** Create the exact message bound into a provider Worker Version. */
export function releaseVersionMessage({ sourceCommit, sourceTreeSha256, artifactDigest, configDigest } = {}) {
  commit(sourceCommit, "version_source_commit_invalid");
  hash(sourceTreeSha256, "version_source_tree_invalid");
  hash(artifactDigest, "version_artifact_digest_invalid");
  hash(configDigest, "version_config_digest_invalid");
  return `${VERSION_MESSAGE_SCHEMA}|source=${sourceCommit}|tree=${sourceTreeSha256}|artifact=${artifactDigest}|config=${configDigest}`;
}

/** Parse exactly one pinned Wrangler 4 upload identity; ambiguous output fails closed. */
export function parseWranglerVersionId(output) {
  const normalized = String(output ?? "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  const matches = [...normalized.matchAll(/^\s*Worker Version ID:\s*([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\s*$/gim)];
  if (matches.length !== 1) fail("version_id_ambiguous");
  return matches[0][1];
}

/**
 * Validate a `wrangler versions view --json` response without retaining secret
 * values. The upload message carries source/config identity; the full response
 * digest becomes the immutable provider-version receipt.
 */
export function validateWorkerVersionReadback(readback, expected = {}) {
  if (!isRecord(readback)) fail("version_readback_invalid");
  text(readback.id, "version_readback_id_invalid", UUID_RE);
  if (expected.versionId !== undefined) equal(expected.versionId, readback.id, "version_readback_id_drift");
  if (!isRecord(readback.metadata) || !isRecord(readback.annotations) || !isRecord(readback.resources)) fail("version_readback_shape_invalid");
  providerTimestamp(readback.metadata.created_on, "version_readback_created_invalid");
  const message = readback.annotations["workers/message"];
  text(message, "version_readback_message_invalid", /^[A-Za-z0-9|=_-]{120,320}$/);
  const parsed = VERSION_MESSAGE_RE.exec(message);
  if (!parsed) fail("version_readback_message_invalid");
  const [, sourceCommit, sourceTreeSha256, artifactDigest, configDigest] = parsed;
  const expectedFields = { sourceCommit: expected.sourceCommit, sourceTreeSha256: expected.sourceTreeSha256, artifactDigest: expected.artifactDigest, configDigest: expected.configDigest };
  for (const [key, value] of Object.entries(expectedFields)) if (value !== undefined) equal(value, { sourceCommit, sourceTreeSha256, artifactDigest, configDigest }[key], `version_readback_${key}_drift`);
  if (!Array.isArray(readback.resources.bindings)) fail("version_readback_bindings_invalid");
  const bindingNames = readback.resources.bindings.map((binding) => {
    if (!isRecord(binding)) fail("version_readback_binding_invalid");
    return text(binding.name, "version_readback_binding_name_invalid", /^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
  });
  const secretNames = readback.resources.bindings
    .filter((binding) => binding.type === "secret_text")
    .map((binding) => binding.name)
    .sort();
  if (new Set(bindingNames).size !== bindingNames.length || new Set(secretNames).size !== secretNames.length) fail("version_readback_binding_duplicate");
  if (expected.secretNames !== undefined && JSON.stringify(secretNames) !== JSON.stringify([...expected.secretNames].sort())) fail("version_readback_secret_inventory_drift");
  if (expected.bindingManifest !== undefined) {
    if (!Array.isArray(expected.bindingManifest) || expected.bindingManifest.some((entry) => !isRecord(entry) || typeof entry.name !== "string" || typeof entry.type !== "string")) fail("version_readback_binding_manifest_invalid");
    const actualManifest = providerBindingManifest(readback.resources.bindings);
    const expectedManifest = expected.bindingManifest.map((entry) => ({ ...entry })).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
    const expectedNamesOnly = expectedManifest.map(({ name, type }) => `${name}:${type}`);
    const actualNamesOnly = actualManifest.map(({ name, type }) => `${name}:${type}`);
    if (JSON.stringify(actualNamesOnly) !== JSON.stringify(expectedNamesOnly)) fail("version_readback_binding_manifest_drift");
    for (const expectedEntry of expectedManifest) {
      const actualEntry = actualManifest.find((entry) => entry.name === expectedEntry.name && entry.type === expectedEntry.type);
      for (const field of ["resource_id", "resource_name", "resource_environment", "resource_entrypoint", "resource_jurisdiction", "value_digest"]) {
        if (!(field in expectedEntry)) continue;
        if (!(field in actualEntry)) fail(`version_readback_binding_${field}_missing`);
        if (expectedEntry[field] !== actualEntry[field]) fail(`version_readback_binding_${field}_drift`);
      }
    }
    if (canonicalJson(actualManifest) !== canonicalJson(expectedManifest)) fail("version_readback_binding_manifest_drift");
  }
  const runtimeManifest = providerRuntimeManifest(readback.resources.script_runtime);
  if (expected.runtimeManifest !== undefined && canonicalJson(runtimeManifest) !== canonicalJson(expected.runtimeManifest)) fail("version_readback_runtime_drift");
  return {
    version_id: readback.id,
    version_digest: sha256(canonicalJson(readback)),
    source_commit: sourceCommit,
    source_tree_sha256: sourceTreeSha256,
    artifact_digest: artifactDigest,
    config_digest: configDigest,
    secret_names: secretNames,
    binding_manifest_digest: sha256(canonicalJson(providerBindingManifest(readback.resources.bindings))),
    runtime_manifest_digest: sha256(canonicalJson(runtimeManifest)),
  };
}

function optionalProviderText(value, code) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 512 || /[\r\n]/.test(value)) fail(code);
  return value;
}

function providerBindingManifest(bindings) {
  const manifest = bindings.map((binding) => {
    if (!isRecord(binding)) fail("version_readback_binding_invalid");
    const name = text(binding.name, "version_readback_binding_name_invalid", /^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
    const type = text(binding.type, "version_readback_binding_type_invalid", /^[a-z][a-z0-9_]{0,63}$/);
    const entry = { name, type };
    if (type === "plain_text") {
      if (typeof binding.text !== "string") fail("version_readback_binding_value_missing");
      entry.value_digest = sha256(binding.text);
    } else if (type === "json") {
      if (!("json" in binding)) fail("version_readback_binding_value_missing");
      entry.value_digest = sha256(canonicalJson(binding.json));
    } else if (type === "d1") {
      entry.resource_id = optionalProviderText(binding.id, "version_readback_binding_id_invalid");
    } else if (type === "kv_namespace") {
      entry.resource_id = optionalProviderText(binding.namespace_id, "version_readback_binding_id_invalid");
    } else if (type === "r2_bucket") {
      entry.resource_name = optionalProviderText(binding.bucket_name, "version_readback_binding_resource_invalid");
      entry.resource_jurisdiction = optionalProviderText(binding.jurisdiction, "version_readback_binding_resource_invalid");
    } else if (type === "queue") {
      entry.resource_name = optionalProviderText(binding.queue_name, "version_readback_binding_resource_invalid");
    } else if (type === "service") {
      entry.resource_name = optionalProviderText(binding.service, "version_readback_binding_resource_invalid");
      entry.resource_environment = optionalProviderText(binding.environment, "version_readback_binding_resource_invalid");
      entry.resource_entrypoint = optionalProviderText(binding.entrypoint, "version_readback_binding_resource_invalid");
    } else if (type === "durable_object_namespace") {
      entry.resource_name = optionalProviderText(binding.class_name, "version_readback_binding_resource_invalid");
      entry.resource_id = optionalProviderText(binding.script_name, "version_readback_binding_id_invalid");
      entry.resource_environment = optionalProviderText(binding.environment, "version_readback_binding_resource_invalid");
    }
    return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined));
  }).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  if (new Set(manifest.map((entry) => entry.name)).size !== manifest.length) fail("version_readback_binding_duplicate");
  return manifest;
}

function providerRuntimeManifest(runtime) {
  if (!isRecord(runtime)) fail("version_readback_runtime_invalid");
  const compatibilityDate = text(runtime.compatibility_date, "version_readback_compatibility_date_invalid", /^\d{4}-\d{2}-\d{2}$/);
  const flags = runtime.compatibility_flags ?? [];
  if (!Array.isArray(flags) || flags.some((flag) => typeof flag !== "string" || !/^[a-z0-9_]{1,96}$/.test(flag))) fail("version_readback_compatibility_flags_invalid");
  const sortedFlags = [...flags].sort();
  if (new Set(sortedFlags).size !== sortedFlags.length) fail("version_readback_compatibility_flags_invalid");
  return { compatibility_date: compatibilityDate, compatibility_flags: sortedFlags };
}

/** Validate a provider secret-name inventory without retaining or accepting values. */
export function validateSecretInventoryReadback(readback, expectedNames = []) {
  const rows = Array.isArray(readback)
    ? readback
    : isRecord(readback) && Array.isArray(readback.secrets)
      ? readback.secrets
      : null;
  if (!rows) fail("secret_inventory_readback_invalid");
  const names = rows.map((entry) => {
    if (!isRecord(entry) || "value" in entry || "secret" in entry) fail("secret_inventory_value_exposed");
    return text(entry.name, "secret_inventory_name_invalid", /^[A-Z][A-Z0-9_]{0,127}$/);
  }).sort();
  if (new Set(names).size !== names.length) fail("secret_inventory_duplicate");
  const expected = [...expectedNames].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) fail("secret_inventory_drift");
  return {
    status: "matched",
    secret_names: names,
    secret_inventory_digest: sha256(canonicalJson(names)),
    readback_digest: sha256(canonicalJson(rows.map((entry) => ({ name: entry.name, type: entry.type ?? null })).sort((left, right) => left.name.localeCompare(right.name)))),
  };
}

function parseJsonc(source, code = "config_json_invalid") {
  let output = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (current === "\n") {
        lineComment = false;
        output += current;
      }
      continue;
    }
    if (blockComment) {
      if (current === "*" && next === "/") {
        blockComment = false;
        index += 1;
      } else if (current === "\n") {
        output += current;
      }
      continue;
    }
    if (inString) {
      output += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === '"') inString = false;
      continue;
    }
    if (current === '"') {
      inString = true;
      output += current;
    } else if (current === "/" && next === "/") {
      lineComment = true;
      index += 1;
    } else if (current === "/" && next === "*") {
      blockComment = true;
      index += 1;
    } else {
      output += current;
    }
  }
  try {
    return JSON.parse(output);
  } catch {
    fail(code);
  }
}

function effectiveEnvironmentConfig(config, environment) {
  const selected = config.env?.[environment];
  if (selected !== undefined && !isRecord(selected)) fail("config_environment_shape_invalid");
  return {
    ...config,
    ...selected,
    vars: { ...(isRecord(config.vars) ? config.vars : {}), ...(isRecord(selected?.vars) ? selected.vars : {}) },
  };
}

function appendBinding(manifest, binding, type, resource = {}) {
  if (!isRecord(binding) || typeof binding.binding !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(binding.binding)) fail("config_binding_invalid");
  manifest.push({ name: binding.binding, type, ...Object.fromEntries(Object.entries(resource).filter(([, value]) => typeof value === "string" && value.length > 0)) });
}

function environmentBindingManifest(config) {
  const manifest = [];
  for (const binding of config.d1_databases ?? []) appendBinding(manifest, binding, "d1", { resource_id: binding.database_id });
  for (const binding of config.r2_buckets ?? []) appendBinding(manifest, binding, "r2_bucket", { resource_name: binding.bucket_name, resource_jurisdiction: binding.jurisdiction });
  for (const binding of config.kv_namespaces ?? []) appendBinding(manifest, binding, "kv_namespace", { resource_id: binding.id });
  for (const binding of config.services ?? []) appendBinding(manifest, binding, "service", { resource_name: binding.service, resource_environment: binding.environment, resource_entrypoint: binding.entrypoint });
  for (const binding of config.durable_objects?.bindings ?? []) appendBinding(manifest, binding, "durable_object_namespace", { resource_name: binding.class_name, resource_id: binding.script_name, resource_environment: binding.environment });
  for (const binding of config.queues?.producers ?? []) appendBinding(manifest, binding, "queue", { resource_name: binding.queue });
  if (isRecord(config.assets) && typeof config.assets.binding === "string") manifest.push({ name: config.assets.binding, type: "assets" });
  const sorted = manifest.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  if (new Set(sorted.map((entry) => entry.name)).size !== sorted.length) fail("config_binding_duplicate");
  return sorted;
}

/** Compute a checked-in, environment-resolved config/binding and secret inventory digest. */
export async function computeEnvironmentConfigDigest({ repoRoot, environment } = {}) {
  text(environment, "config_environment_invalid", /^(?:qa|production)$/);
  const root = path.resolve(repoRoot);
  const wranglerSource = await readFile(path.join(root, "workers-bus", "wrangler.jsonc"), "utf8");
  const secretSource = await readFile(path.join(root, "workers-bus", "src", "secret-bindings.d.ts"), "utf8");
  const parsed = parseJsonc(wranglerSource);
  const resolved = effectiveEnvironmentConfig(parsed, environment);
  const flatVars = flattenWranglerVars(resolved.vars ?? {});
  const configuredVars = new Set(Object.keys(flatVars).filter((name) => /^[A-Z][A-Z0-9_]{0,127}$/.test(name)));
  const secretNames = [...new Set([...secretSource.matchAll(/^\s{2}([A-Z][A-Z0-9_]+): string;$/gm)]
    .map((match) => match[1])
    .filter((name) => !configuredVars.has(name)))].sort();
  if (secretNames.length === 0) fail("config_secret_inventory_invalid");
  const bindingManifest = [
    ...environmentBindingManifest(resolved),
    ...secretNames.map((name) => ({ name, type: "secret_text" })),
    ...Object.entries(resolved.vars ?? {}).filter(([name]) => /^[A-Z][A-Z0-9_]{0,127}$/.test(name)).map(([name, value]) => typeof value === "string"
      ? { name, type: "plain_text", value_digest: sha256(value) }
      : { name, type: "json", value_digest: sha256(canonicalJson(value)) }),
  ]
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  if (new Set(bindingManifest.map((entry) => entry.name)).size !== bindingManifest.length) fail("config_binding_duplicate");
  const vars = Object.entries(flatVars)
    .filter(([name]) => /^[A-Z][A-Z0-9_]{0,127}$/.test(name))
    .map(([name, value]) => ({ name, value: String(value) }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const varsDigest = sha256(canonicalJson(vars));
  const bindingManifestDigest = sha256(canonicalJson(bindingManifest));
  const secretInventoryDigest = sha256(canonicalJson(secretNames));
  const queueManifest = bindingManifest.filter((entry) => entry.type === "queue");
  const bucketManifest = bindingManifest.filter((entry) => entry.type === "r2_bucket");
  const routesManifest = [...(Array.isArray(resolved.routes) ? resolved.routes : []), ...(resolved.route === undefined ? [] : [resolved.route])]
    .map((route) => typeof route === "string" ? { pattern: route } : route)
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  if (routesManifest.some((route) => !isRecord(route))) fail("config_route_invalid");
  const runtimeManifest = {
    compatibility_date: text(resolved.compatibility_date, "config_compatibility_date_invalid", /^\d{4}-\d{2}-\d{2}$/),
    compatibility_flags: [...(resolved.compatibility_flags ?? [])].sort(),
  };
  if (!Array.isArray(resolved.compatibility_flags ?? []) || runtimeManifest.compatibility_flags.some((flag) => typeof flag !== "string" || !/^[a-z0-9_]{1,96}$/.test(flag)) || new Set(runtimeManifest.compatibility_flags).size !== runtimeManifest.compatibility_flags.length) fail("config_compatibility_flags_invalid");
  const runtimeManifestDigest = sha256(canonicalJson(runtimeManifest));
  return {
    digest: sha256(canonicalJson({
      environment,
      wrangler_source_sha256: sha256(wranglerSource),
      vars_digest: varsDigest,
      binding_manifest_digest: bindingManifestDigest,
      runtime_manifest_digest: runtimeManifestDigest,
      secret_names: secretNames,
    })),
    secret_names: secretNames,
    secret_inventory_digest: secretInventoryDigest,
    binding_manifest: bindingManifest,
    binding_manifest_digest: bindingManifestDigest,
    runtime_manifest: runtimeManifest,
    runtime_manifest_digest: runtimeManifestDigest,
    vars_digest: varsDigest,
    queues_digest: sha256(canonicalJson(queueManifest)),
    buckets_digest: sha256(canonicalJson(bucketManifest)),
    routes_digest: sha256(canonicalJson(routesManifest)),
  };
}

/** Expected cron schedules for an environment, straight from wrangler.jsonc. */
export async function expectedCrons({ repoRoot, environment } = {}) {
  text(environment, "expected_crons_environment_invalid", /^(?:qa|production)$/);
  const root = path.resolve(repoRoot);
  const config = parseJsonc(await readFile(path.join(root, "workers-bus", "wrangler.jsonc"), "utf8"));
  const resolved = effectiveEnvironmentConfig(config, environment);
  const triggers = resolved.triggers;
  if (!isRecord(triggers) || !Array.isArray(triggers.crons) || triggers.crons.some((cron) => typeof cron !== "string" || cron.trim() === "")) {
    fail("expected_crons_triggers_invalid");
  }
  return [...triggers.crons].sort();
}

function providerTargetManifest(config, environment) {
  const selected = config.env?.[environment];
  const resolved = effectiveEnvironmentConfig(config, environment);
  if (resolved.build !== undefined) fail("provider_target_custom_build_forbidden");
  for (const field of ["alias", "base_dir", "data_blobs", "define", "find_additional_modules", "jsx_factory", "jsx_fragment", "minify", "no_bundle", "pages_build_output_dir", "preserve_file_names", "python_modules", "rules", "site", "text_blobs", "tsconfig", "upload_source_maps", "wasm_modules"]) {
    if (resolved[field] !== undefined) fail("provider_target_local_input_forbidden");
  }
  const allowedFields = new Set(["$schema", "account_id", "assets", "compatibility_date", "compatibility_flags", "d1_databases", "env", "main", "name", "observability", "queues", "r2_buckets", "route", "routes", "triggers", "vars", "workers_dev"]);
  if (Object.keys(resolved).some((field) => !allowedFields.has(field))) fail("provider_target_unallowlisted_config");
  const allowedEntry = (entry, fields, code) => {
    if (!isRecord(entry) || Object.keys(entry).some((field) => !fields.includes(field))) fail(code);
    return entry;
  };
  const baseName = text(config.name, "provider_target_worker_invalid", /^[a-z0-9][a-z0-9-]{0,62}$/);
  const workerName = text(selected?.name ?? (environment === "production" ? baseName : `${baseName}-${environment}`), "provider_target_worker_invalid", /^[a-z0-9][a-z0-9-]{0,62}$/);
  const normalize = (rows) => rows.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  const d1Databases = normalize((resolved.d1_databases ?? []).map((raw) => {
    const entry = allowedEntry(raw, ["binding", "database_name", "database_id", "migrations_dir"], "provider_target_d1_invalid");
    return {
    binding: text(entry?.binding, "provider_target_d1_invalid", /^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
    database_name: text(entry?.database_name, "provider_target_d1_invalid"),
    database_id: text(entry?.database_id, "provider_target_d1_invalid", UUID_RE),
    migrations_dir: text(entry?.migrations_dir, "provider_target_d1_invalid", /^[A-Za-z0-9_./-]+$/),
    };
  }));
  const r2Buckets = normalize((resolved.r2_buckets ?? []).map((raw) => {
    const entry = allowedEntry(raw, ["binding", "bucket_name"], "provider_target_r2_invalid");
    return {
    binding: text(entry?.binding, "provider_target_r2_invalid", /^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
    bucket_name: text(entry?.bucket_name, "provider_target_r2_invalid", /^[a-z0-9][a-z0-9-]{0,62}$/),
    };
  }));
  allowedEntry(resolved.queues ?? {}, ["producers", "consumers"], "provider_target_queue_invalid");
  const queueProducers = normalize((resolved.queues?.producers ?? []).map((raw) => {
    const entry = allowedEntry(raw, ["binding", "queue"], "provider_target_queue_invalid");
    return {
    binding: text(entry?.binding, "provider_target_queue_invalid", /^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
    queue: text(entry?.queue, "provider_target_queue_invalid", /^[a-z0-9][a-z0-9-]{0,62}$/),
    };
  }));
  const queueConsumers = normalize((resolved.queues?.consumers ?? []).map((raw) => {
    const entry = allowedEntry(raw, ["queue", "dead_letter_queue", "max_retries", "max_batch_size", "max_batch_timeout"], "provider_target_queue_invalid");
    return {
      queue: text(entry?.queue, "provider_target_queue_invalid", /^[a-z0-9][a-z0-9-]{0,62}$/),
      dead_letter_queue: entry?.dead_letter_queue === undefined ? null : text(entry.dead_letter_queue, "provider_target_queue_invalid", /^[a-z0-9][a-z0-9-]{0,62}$/),
      max_retries: entry?.max_retries === undefined ? null : nonNegativeInteger(entry.max_retries, "provider_target_queue_invalid"),
      max_batch_size: entry?.max_batch_size === undefined ? null : positiveInteger(entry.max_batch_size, "provider_target_queue_invalid"),
      max_batch_timeout: entry?.max_batch_timeout === undefined ? null : nonNegativeInteger(entry.max_batch_timeout, "provider_target_queue_invalid"),
    };
  }));
  const assets = allowedEntry(resolved.assets, ["directory", "binding", "not_found_handling", "run_worker_first"], "provider_target_assets_invalid");
  const assetManifest = {
    directory: text(assets.directory, "provider_target_assets_invalid", /^(?:\.\.\/app\/dist|(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_./-]+)$/),
    binding: text(assets.binding, "provider_target_assets_invalid", /^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
    not_found_handling: text(assets.not_found_handling, "provider_target_assets_invalid", /^(?:none|404-page|single-page-application)$/),
    run_worker_first: [...(assets.run_worker_first ?? [])].sort(),
  };
  if (!Array.isArray(assets.run_worker_first) || assetManifest.run_worker_first.some((route) => typeof route !== "string" || !route.startsWith("/"))) fail("provider_target_assets_invalid");
  const observability = allowedEntry(resolved.observability, ["enabled", "head_sampling_rate"], "provider_target_observability_invalid");
  if (typeof observability.enabled !== "boolean" || typeof observability.head_sampling_rate !== "number" || observability.head_sampling_rate < 0 || observability.head_sampling_rate > 1) fail("provider_target_observability_invalid");
  const triggers = allowedEntry(resolved.triggers, ["crons"], "provider_target_triggers_invalid");
  const cronManifest = [...(triggers.crons ?? [])].sort();
  if (!Array.isArray(triggers.crons) || cronManifest.some((cron) => typeof cron !== "string" || cron.trim() === "")) fail("provider_target_triggers_invalid");
  const compatibilityFlags = [...(resolved.compatibility_flags ?? [])].sort();
  if (!Array.isArray(resolved.compatibility_flags) || compatibilityFlags.some((flag) => typeof flag !== "string" || !/^[a-z0-9_]{1,96}$/.test(flag))) fail("provider_target_runtime_invalid");
  if (resolved.workers_dev !== undefined && typeof resolved.workers_dev !== "boolean") fail("provider_target_runtime_invalid");
  const routes = normalize([...(Array.isArray(resolved.routes) ? resolved.routes : []), ...(resolved.route === undefined ? [] : [resolved.route])]
    .map((route) => typeof route === "string" ? { pattern: route } : route));
  if (routes.some((route) => !isRecord(route))) fail("provider_target_route_invalid");
  for (const key of ["kv_namespaces", "services", "analytics_engine_datasets", "hyperdrive", "vectorize", "dispatch_namespaces", "mtls_certificates"]) {
    if (Array.isArray(resolved[key]) && resolved[key].length > 0) fail("provider_target_unallowlisted_binding");
  }
  if (Array.isArray(resolved.durable_objects?.bindings) && resolved.durable_objects.bindings.length > 0) fail("provider_target_unallowlisted_binding");
  return {
    account_id: text(resolved.account_id, "provider_target_account_invalid", /^[0-9a-f]{32}$/),
    worker_name: workerName,
    workers_dev: resolved.workers_dev === undefined ? true : resolved.workers_dev,
    compatibility_date: text(resolved.compatibility_date, "provider_target_runtime_invalid", /^\d{4}-\d{2}-\d{2}$/),
    compatibility_flags: compatibilityFlags,
    observability: { enabled: observability.enabled, head_sampling_rate: observability.head_sampling_rate },
    assets: assetManifest,
    crons: cronManifest,
    d1_databases: d1Databases,
    r2_buckets: r2Buckets,
    queue_producers: queueProducers,
    queue_consumers: queueConsumers,
    routes,
  };
}

/** Resolve candidate Cloudflare coordinates and compare them to generation-N policy. */
export async function validateProviderTargetPolicy({ candidateRoot, policyRoot, environment } = {}) {
  text(environment, "provider_target_environment_invalid", /^(?:qa|production)$/);
  const candidateSource = await readFile(path.join(path.resolve(candidateRoot), "workers-bus", "wrangler.jsonc"), "utf8");
  const policySource = await readFile(path.join(path.resolve(policyRoot), "deploy", "release-provider-policy.json"), "utf8");
  const candidate = providerTargetManifest(parseJsonc(candidateSource), environment);
  let policy;
  try { policy = JSON.parse(policySource); } catch { fail("provider_target_policy_invalid"); }
  exactKeys(policy, ["schema", "account_id", "environments"], "provider_target_policy_shape_invalid");
  equal("ironwrap_release_provider_policy_v1", policy.schema, "provider_target_policy_schema_invalid");
  text(policy.account_id, "provider_target_policy_account_invalid", /^[0-9a-f]{32}$/);
  exactKeys(policy.environments, ["qa", "production"], "provider_target_policy_environment_shape_invalid");
  const expected = policy.environments[environment];
  exactKeys(expected, ["credential_secret", "worker_name", "workers_dev", "compatibility_date", "compatibility_flags", "observability", "assets", "crons", "d1_databases", "r2_buckets", "queue_producers", "queue_consumers", "routes"], "provider_target_policy_environment_invalid");
  const expectedCredential = environment === "qa" ? "RELEASE_QA_CLOUDFLARE_API_TOKEN" : "RELEASE_PRODUCTION_CLOUDFLARE_API_TOKEN";
  equal(expectedCredential, expected.credential_secret, "provider_target_credential_scope_invalid");
  const expectedManifest = { account_id: policy.account_id, ...Object.fromEntries(Object.entries(expected).filter(([key]) => key !== "credential_secret")) };
  for (const key of ["compatibility_flags", "crons", "d1_databases", "r2_buckets", "queue_producers", "queue_consumers", "routes"]) {
    if (!Array.isArray(expectedManifest[key])) fail("provider_target_policy_environment_invalid");
    expectedManifest[key] = [...expectedManifest[key]].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  }
  equal(canonicalJson(expectedManifest), canonicalJson(candidate), "provider_target_policy_drift");
  const fields = {
    schema: "ironwrap_release_provider_target_receipt_v1",
    environment,
    credential_secret: expectedCredential,
    policy_digest: sha256(canonicalJson(policy)),
    target_manifest_digest: sha256(canonicalJson(candidate)),
    status: "matched",
  };
  return { ...fields, evidence_digest: sha256(canonicalJson(fields)) };
}

export async function validateReleaseEnvironmentPreflight({ repoRoot, environment, secretNames } = {}) {
  text(environment, "environment_preflight_environment_invalid", /^(?:qa|production)$/);
  if (!Array.isArray(secretNames) || secretNames.some((name) => typeof name !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(name)) || new Set(secretNames).size !== secretNames.length) fail("environment_preflight_secret_inventory_invalid");
  const root = path.resolve(repoRoot);
  const config = parseJsonc(await readFile(path.join(root, "workers-bus", "wrangler.jsonc"), "utf8"));
  const selected = config.env?.[environment];
  if (selected !== undefined && !isRecord(selected)) fail("environment_preflight_environment_invalid");
  if (selected !== undefined) {
    const inheritedNames = Object.keys(flattenWranglerVars(isRecord(config.vars) ? config.vars : {})).sort();
    const environmentNames = Object.keys(flattenWranglerVars(isRecord(selected.vars) ? selected.vars : {})).sort();
    if (canonicalJson(inheritedNames) !== canonicalJson(environmentNames)) fail("environment_preflight_var_inventory_drift");
  }
  const resolved = effectiveEnvironmentConfig(config, environment);
  const vars = flattenWranglerVars(isRecord(resolved.vars) ? resolved.vars : {});
  for (const name of ["BACKUP_ALERT_EMAIL", "FROM_EMAIL", "OWNER_ALERT_EMAIL"]) {
    if (typeof vars[name] !== "string" || vars[name].trim() === "") fail("environment_preflight_notification_config_missing");
  }
  const availableSecrets = [...secretNames].sort();
  const requiredSecrets = ["ADMIN_TOKEN", "GOOGLE_SERVICE_ACCOUNT_JSON", "INGEST_TOKEN"];
  if (vars.MEASUREMENT_OCR_ENABLED === "true") {
    requiredSecrets.push("MEASUREMENT_OCR_API_KEY");
    if (!MEASUREMENT_OCR_MODELS.includes(vars.MEASUREMENT_OCR_MODEL)) fail("environment_preflight_ocr_model_invalid");
  }
  if (requiredSecrets.some((name) => !availableSecrets.includes(name))) fail("environment_preflight_required_secret_missing");
  const configReceipt = await computeEnvironmentConfigDigest({ repoRoot: root, environment });
  if (canonicalJson(availableSecrets) !== canonicalJson(configReceipt.secret_names)) fail("environment_preflight_secret_inventory_drift");
  const fields = {
    schema: "ironwrap_release_environment_preflight_v1",
    environment,
    config_digest: configReceipt.digest,
    vars_inventory_digest: sha256(canonicalJson(Object.keys(vars).sort())),
    secret_inventory_digest: sha256(canonicalJson(availableSecrets)),
    required_secret_names_digest: sha256(canonicalJson(requiredSecrets.sort())),
    status: "matched",
  };
  return { ...fields, evidence_digest: sha256(canonicalJson(fields)) };
}

/** Sign the independent reviewer GO receipt used by the release issuer. */
export function signReviewGoReceipt(privateKey, payload, options = {}) {
  if (!privateKey) fail("review_private_key_required");
  const normalized = validateReviewGoReceipt(payload, options);
  const encodedPayload = encode(canonicalJson(normalized));
  const signature = signSignature(null, Buffer.from(encodedPayload), privateKey).toString("base64url");
  return `${encodedPayload}.${signature}`;
}

/** Verify the independent reviewer receipt and its source/finding bindings. */
export function verifyReviewGoReceipt(publicKey, receipt, expected = {}, options = {}) {
  if (!publicKey) fail("review_public_key_required");
  const parts = String(receipt ?? "").split(".");
  if (parts.length !== 2) fail("review_receipt_invalid");
  const [encodedPayload, encodedSignature] = parts;
  const payloadBytes = decode(encodedPayload, "review_receipt_invalid");
  const signature = decode(encodedSignature, "review_receipt_invalid");
  if (!verifySignature(null, Buffer.from(encodedPayload), publicKey, signature)) fail("review_signature_invalid");
  let payload;
  try { payload = JSON.parse(payloadBytes.toString("utf8")); } catch { fail("review_receipt_invalid"); }
  validateReviewGoReceipt(payload, options);
  for (const field of ["repository", "source_commit", "source_tree_sha256", "diff_sha256"]) {
    if (expected[field] !== undefined) equal(expected[field], payload[field], `review_${field}_drift`);
  }
  return payload;
}

function validateReviewGoReceipt(payload, { now = Date.now() } = {}) {
  exactKeys(payload, ["schema", "type", "repository", "source_commit", "source_tree_sha256", "diff_sha256", "reviewer_principal", "reviewer_task_id", "reviewer_run_id", "review_key_version", "decision", "findings_digest", "unresolved_p0", "unresolved_p1", "issued_at", "expires_at", "nonce"], "review_receipt_shape_invalid");
  equal(REVIEW_RECEIPT_SCHEMA, payload.schema, "review_schema_invalid");
  equal(REVIEW_RECEIPT_TYPE, payload.type, "review_type_invalid");
  text(payload.repository, "review_repository_invalid", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  commit(payload.source_commit, "review_source_commit_invalid");
  hash(payload.source_tree_sha256, "review_source_tree_invalid");
  hash(payload.diff_sha256, "review_diff_invalid");
  text(payload.reviewer_principal, "review_identity_invalid", IDENTITY_RE);
  text(payload.reviewer_task_id, "review_task_id_invalid");
  text(payload.reviewer_run_id, "review_run_id_invalid");
  text(payload.review_key_version, "review_key_version_invalid");
  equal("GO", payload.decision, "review_not_go");
  hash(payload.findings_digest, "review_findings_digest_invalid");
  equal(0, payload.unresolved_p0, "review_p0_unresolved");
  equal(0, payload.unresolved_p1, "review_p1_unresolved");
  iso(payload.issued_at, "review_issued_invalid");
  iso(payload.expires_at, "review_expires_invalid");
  const issuedMs = Date.parse(payload.issued_at);
  const expiresMs = Date.parse(payload.expires_at);
  if (issuedMs > now + MAX_FUTURE_ISSUED_MS) fail("review_issued_in_future");
  if (expiresMs <= now || expiresMs <= issuedMs || expiresMs - issuedMs > MAX_REVIEW_RECEIPT_LIFETIME_MS) fail("review_window_invalid");
  text(payload.nonce, "review_nonce_invalid", NONCE_RE);
  return payload;
}

export function releasePermitDigest(permit) {
  return permitDigest(permit);
}

/** Bind the two provider environment configuration/binding digests together. */
export function computeReleaseConfigDigest({ qa, production } = {}) {
  hash(qa, "qa_config_digest_invalid");
  hash(production, "production_config_digest_invalid");
  return sha256(canonicalJson({ production, qa }));
}

/**
 * Compute exact source/tree/diff evidence from a pristine checkout. Git's
 * binary diff output is hashed, so the permit binds binary and text changes.
 */
export async function computeSourceEvidence({ repoRoot, sourceCommit = "HEAD", baseCommit }) {
  const root = path.resolve(repoRoot);
  const clean = await git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (clean.stdout !== "") fail("worktree_dirty");
  const source = (await git(root, ["rev-parse", "--verify", `${sourceCommit}^{commit}`])).stdout.trim();
  const base = (await git(root, ["rev-parse", "--verify", `${baseCommit}^{commit}`])).stdout.trim();
  const sourceGitTree = (await git(root, ["rev-parse", "--verify", `${source}^{tree}`])).stdout.trim();
  const tree = await git(root, ["ls-tree", "-r", "--full-tree", source]);
  const diff = await git(root, ["diff", "--binary", "--no-ext-diff", "--no-renames", base, source]);
  const componentEntries = await Promise.all(Object.entries({
    worker: "workers-bus",
    pwa: "app",
    frappe: "frappe-apps/ironwrap_roofing",
    mcp: "mcp",
    hermes: "hermes",
    tenant_config: "config/tenants",
  }).map(async ([name, prefix]) => {
    const listing = await git(root, ["ls-tree", "-r", "--full-tree", source, "--", prefix]);
    return [name, sha256(listing.stdout)];
  }));
  const frappeListing = (await git(root, ["ls-tree", "-r", "--full-tree", source, "--", "frappe-apps/ironwrap_roofing"])).stdout.split("\n");
  const frappeSchema = frappeListing.filter((line) => /\/doctype\/[^/]+\/[^/]+\.json$/.test(line)).sort().join("\n");
  const frappeMigrations = frappeListing.filter((line) => /(?:migration|patch|\/hooks\.py$)/.test(line)).sort().join("\n");
  const routesSource = (await git(root, ["ls-tree", "-r", "--full-tree", source, "--", "workers-bus/wrangler.jsonc"])).stdout;
  return {
    source_commit: commit(source),
    base_commit: commit(base, "base_commit_invalid"),
    source_git_tree: commit(sourceGitTree, "source_git_tree_invalid"),
    source_tree_sha256: sha256(tree.stdout),
    diff_sha256: sha256(diff.stdout),
    component_digests: Object.fromEntries(componentEntries),
    frappe_schema_digest: sha256(frappeSchema),
    frappe_migration_digest: sha256(frappeMigrations),
    routes_source_digest: sha256(routesSource),
    worktree_clean: true,
  };
}

export async function computeSupplyChainEvidence({ repoRoot, sourceCommit, ciChecks } = {}) {
  const root = path.resolve(repoRoot);
  const source = commit((await git(root, ["rev-parse", "--verify", `${sourceCommit}^{commit}`])).stdout.trim());
  validateChecks(ciChecks, { sourceCommit: source });
  const paths = (await git(root, ["ls-tree", "-r", "--name-only", source])).stdout
    .split("\n")
    .filter((relative) => /(?:^|\/)package-lock\.json$/.test(relative) || /(?:^|\/)pyproject\.toml$/.test(relative))
    .sort();
  if (paths.length === 0) fail("supply_chain_manifests_missing");
  const manifests = [];
  const packages = [];
  const licenses = [];
  for (const relative of paths) {
    const raw = (await git(root, ["show", `${source}:${relative}`])).stdout;
    manifests.push({ path: relative, sha256: sha256(raw) });
    if (!relative.endsWith("package-lock.json")) {
      packages.push({ manifest: relative, sha256: sha256(raw), type: "python-project" });
      continue;
    }
    let lock;
    try { lock = JSON.parse(raw); } catch { fail("supply_chain_lock_invalid"); }
    if (!isRecord(lock) || !isRecord(lock.packages)) fail("supply_chain_lock_invalid");
    for (const [packagePath, value] of Object.entries(lock.packages)) {
      if (!isRecord(value)) fail("supply_chain_package_invalid");
      const entry = {
        manifest: relative,
        package_path: packagePath,
        name: typeof value.name === "string" ? value.name : null,
        version: typeof value.version === "string" ? value.version : null,
        integrity: typeof value.integrity === "string" ? value.integrity : null,
      };
      packages.push(entry);
      licenses.push({
        manifest: relative,
        package_path: packagePath,
        name: entry.name,
        version: entry.version,
        license: typeof value.license === "string" ? value.license : null,
      });
    }
  }
  packages.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  licenses.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  return {
    lockfiles_digest: sha256(canonicalJson(manifests)),
    sbom_digest: sha256(canonicalJson(packages)),
    license_manifest_digest: sha256(canonicalJson(licenses)),
    license_policy_digest: sha256(canonicalJson(RELEASE_LICENSE_POLICY)),
    audit_receipt_digest: sha256(canonicalJson(ciChecks)),
    result: "passed",
  };
}

export async function computeMigrationSet({ repoRoot }) {
  const migrationRoot = path.join(path.resolve(repoRoot), "workers-bus", "migrations");
  const names = (await readdir(migrationRoot)).filter((name) => MIGRATION_RE.test(name)).sort();
  if (names.length === 0 || names.some((name) => /(?:^|[_-])(down|rollback|revert)(?:[_-]|\.)/i.test(name))) fail("migration_invalid");
  return {
    ordered: names,
    set_digest: sha256(canonicalJson(names)),
    compatibility: "expand-contract",
    no_down_migrations: true,
  };
}

async function git(root, args) {
  try {
    const result = await execFile("git", ["-C", root, ...args], { maxBuffer: 64 * 1024 * 1024 });
    return { stdout: result.stdout.replace(/\r\n/g, "\n"), stderr: result.stderr };
  } catch {
    fail("git_evidence_unavailable");
  }
}

function validateD1Coordinates(value, code) {
  text(value.accountId, `${code}_account_invalid`, /^[0-9a-f]{32}$/);
  text(value.databaseId, `${code}_database_invalid`, UUID_RE);
}

/**
 * Durable Cloudflare D1 replay claim backed by the existing dedup_claims
 * primary key. This intentionally does not create a release-specific
 * migration: the claim is an atomic replay boundary, not business state.
 */
export function createCloudflareD1ReplayBoundary({
  accountId,
  databaseId,
  apiToken,
  apiBase = DEFAULT_D1_API_BASE,
  fetchImpl = globalThis.fetch,
} = {}) {
  validateD1Coordinates({ accountId, databaseId }, "d1_replay");
  if (typeof apiToken !== "string" || apiToken.length < 24 || /[\r\n]/.test(apiToken)) fail("d1_replay_token_invalid");
  if (typeof fetchImpl !== "function") fail("d1_replay_fetch_invalid");
  const endpoint = `${String(apiBase).replace(/\/+$/, "")}/accounts/${accountId}/d1/database/${databaseId}/query`;
  async function query(sql, params) {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
        body: JSON.stringify({ sql, params }),
      });
    } catch {
      fail("d1_replay_unavailable");
    }
    let body;
    try { body = await response.json(); } catch { fail("d1_replay_unavailable"); }
    if (!response.ok || body?.success !== true) fail("d1_replay_unavailable");
    return body.result?.[0]?.results ?? [];
  }
  async function readPolicy({ key }) {
    text(key, "policy_key_invalid");
    const rows = await query("SELECT first_envelope_id FROM dedup_claims WHERE dedup_key = ?", [key]);
    const raw = rows[0]?.first_envelope_id;
    if (typeof raw !== "string") fail("policy_state_missing");
    let state;
    try { state = JSON.parse(raw); } catch { fail("policy_state_invalid"); }
    return validatePolicyState(state);
  }
  return {
    async ensurePolicy({ key, genesis, now = new Date().toISOString() }) {
      text(key, "policy_key_invalid");
      validatePolicyState(genesis, "policy_genesis");
      equal(0, genesis.generation, "policy_genesis_generation_invalid");
      iso(now, "policy_time_invalid");
      const serialized = canonicalJson(genesis);
      await query(
        "INSERT OR IGNORE INTO dedup_claims (dedup_key, first_envelope_id, first_seen_at, updated_at) VALUES (?, ?, ?, ?)",
        [key, serialized, now, now],
      );
      const state = await readPolicy({ key });
      if (state.generation === 0 && state.policy_hash !== genesis.policy_hash) fail("policy_genesis_drift");
      return state;
    },
    async claim({ key, permitDigest: digestValue, now = new Date().toISOString() }) {
      text(key, "replay_key_invalid");
      hash(digestValue, "replay_digest_invalid");
      iso(now, "replay_time_invalid");
      const storedValue = `${RELEASE_REPLAY_PREFIX}${digestValue}`;
      const inserted = await query(
        "INSERT OR IGNORE INTO dedup_claims (dedup_key, first_envelope_id, first_seen_at, updated_at) VALUES (?, ?, ?, ?) RETURNING dedup_key",
        [key, storedValue, now, now],
      );
      if (inserted.length > 0) return { status: "claimed", key };
      const rows = await query("SELECT first_envelope_id FROM dedup_claims WHERE dedup_key = ?", [key]);
      const existing = rows[0]?.first_envelope_id;
      if (existing === undefined) fail("d1_replay_readback_missing");
      if (existing !== storedValue) return { status: "conflict", key };
      return { status: "replayed", key };
    },
    async readClaim({ key, permitDigest: digestValue }) {
      text(key, "replay_key_invalid");
      hash(digestValue, "replay_digest_invalid");
      const rows = await query("SELECT first_envelope_id FROM dedup_claims WHERE dedup_key = ?", [key]);
      if (rows[0]?.first_envelope_id !== `${RELEASE_REPLAY_PREFIX}${digestValue}`) fail("d1_replay_claim_missing");
      return { status: "claimed", key };
    },
    async persistReceipt({ key, receipt, now = new Date().toISOString() }) {
      text(key, "release_outcome_key_invalid");
      validateOutcomeReceipt(receipt);
      iso(now, "release_outcome_time_invalid");
      const storedValue = `${RELEASE_OUTCOME_PREFIX}${canonicalJson(receipt)}`;
      const inserted = await query(
        "INSERT OR IGNORE INTO dedup_claims (dedup_key, first_envelope_id, first_seen_at, updated_at) VALUES (?, ?, ?, ?) RETURNING dedup_key",
        [key, storedValue, now, now],
      );
      const rows = await query("SELECT first_envelope_id FROM dedup_claims WHERE dedup_key = ?", [key]);
      if (rows[0]?.first_envelope_id !== storedValue) fail("release_outcome_conflict");
      return { status: inserted.length > 0 ? "persisted" : "matched", key, receipt };
    },
    async readReceipt({ key }) {
      text(key, "release_outcome_key_invalid");
      const rows = await query("SELECT first_envelope_id FROM dedup_claims WHERE dedup_key = ?", [key]);
      const stored = rows[0]?.first_envelope_id;
      if (typeof stored !== "string" || !stored.startsWith(RELEASE_OUTCOME_PREFIX)) fail("release_outcome_missing");
      let receipt;
      try { receipt = JSON.parse(stored.slice(RELEASE_OUTCOME_PREFIX.length)); } catch { fail("release_outcome_invalid"); }
      return validateOutcomeReceipt(receipt);
    },
    readPolicy,
    async advancePolicy({ key, currentGeneration, currentPolicyHash, nextGeneration, nextPolicyHash, now = new Date().toISOString() }) {
      text(key, "policy_key_invalid");
      nonNegativeInteger(currentGeneration, "policy_current_generation_invalid");
      hash(currentPolicyHash, "policy_current_hash_invalid");
      positiveInteger(nextGeneration, "policy_next_generation_invalid");
      hash(nextPolicyHash, "policy_next_hash_invalid");
      equal(currentGeneration + 1, nextGeneration, "policy_generation_not_sequential");
      iso(now, "policy_time_invalid");
      const current = canonicalJson({ generation: currentGeneration, policy_hash: currentPolicyHash });
      const next = canonicalJson({ generation: nextGeneration, policy_hash: nextPolicyHash });
      const updated = await query(
        "UPDATE dedup_claims SET first_envelope_id = ?, updated_at = ? WHERE dedup_key = ? AND first_envelope_id = ? RETURNING dedup_key",
        [next, now, key, current],
      );
      if (updated.length === 0) fail("policy_state_conflict");
      const readback = await readPolicy({ key });
      if (readback.generation !== nextGeneration || readback.policy_hash !== nextPolicyHash) fail("policy_state_readback_drift");
      return { status: "advanced", key, state: readback };
    },
  };
}

/** Verify then atomically consume a permit through a durable replay boundary. */
export async function admitReleasePermit(publicKey, permit, {
  boundary,
  expected = {},
  now = Date.now(),
  policyKey,
} = {}) {
  if (!boundary || typeof boundary.claim !== "function") fail("replay_boundary_required");
  const unsigned = verifyReleasePermit(publicKey, permit, {}, { now });
  const durablePolicy = typeof boundary.readPolicy === "function"
    ? await boundary.readPolicy({ key: policyKey ?? `release-policy:${unsigned.repository}` })
    : null;
  const policyExpected = durablePolicy
    ? { ...expected, current_generation: durablePolicy.generation, current_policy_hash: durablePolicy.policy_hash }
    : expected;
  const payload = verifyReleasePermit(publicKey, permit, policyExpected, { now });
  const result = await boundary.claim({
    key: `${RELEASE_REPLAY_PREFIX}${payload.repository}:${payload.nonce}`,
    permitDigest: permitDigest(permit),
    now: new Date(now).toISOString(),
  });
  if (result?.status === "replayed") fail("replayed");
  if (result?.status === "conflict") fail("replay_conflict");
  if (result?.status !== "claimed") fail("replay_boundary_invalid");
  return { payload, claim: result, policy: durablePolicy };
}

/** Advance the durable generation only after the immutable promotion succeeds. */
export async function advanceReleaseGeneration(
  publicKey,
  permit,
  { boundary, policyKey, productionReceipt, mergeReceipt, now = Date.now() } = {},
) {
  if (!boundary || typeof boundary.advancePolicy !== "function" || typeof boundary.readClaim !== "function" || typeof boundary.persistReceipt !== "function") fail("policy_boundary_required");
  const payload = verifyReleasePermit(publicKey, permit, {}, { now });
  validateSourceMergeReceipt(mergeReceipt, payload, { now, permitDigest: permitDigest(permit) });
  const mergeReceiptDigest = sha256(canonicalJson(mergeReceipt));
  validateProductionPromotionReceipt(
    productionReceipt,
    {
      sourceCommit: payload.source_commit,
      sourceTreeSha256: payload.source_tree_sha256,
      artifactDigest: payload.worker.artifact_digest,
      configDigest: payload.worker.production_config_digest,
      revision: payload.worker.production_version_id,
      versionDigest: payload.worker.production_version_digest,
      mergeCommit: mergeReceipt.merge_commit,
      mergeReceiptDigest,
      pwaRevision: payload.release_manifest.production_candidates.pwa_revision,
      pwaReadbackDigest: payload.worker.production_version_digest,
      frappeScope: payload.release_manifest.frappe_scope,
      domainHostname: payload.release_manifest.production_candidates.domain_hostname,
      domainService: payload.release_manifest.production_candidates.domain_service,
      domainZoneId: payload.release_manifest.production_candidates.domain_zone_id,
      ...(payload.release_manifest.frappe_scope === "in-scope"
        ? {
            frappeRevision:
              payload.release_manifest.production_candidates.frappe_revision,
            frappeReadbackDigest:
              payload.release_manifest.production_candidates
                .frappe_readback_digest,
          }
        : {}),
    },
    { now },
  );
  await boundary.readClaim({
    key: `${RELEASE_REPLAY_PREFIX}${payload.repository}:${payload.nonce}`,
    permitDigest: permitDigest(permit),
  });
  const recordedAt = new Date(now).toISOString();
  const outcomeReceipt = validateOutcomeReceipt({
    schema: RELEASE_OUTCOME_SCHEMA,
    kind: "production_success",
    repository: payload.repository,
    source_commit: payload.source_commit,
    generation: payload.generation,
    permit_digest: permitDigest(permit),
    merge_receipt_digest: mergeReceiptDigest,
    outcome_digest: sha256(canonicalJson(productionReceipt)),
    recorded_at: recordedAt,
  });
  const persisted = await boundary.persistReceipt({
    key: `${RELEASE_OUTCOME_PREFIX}${payload.repository}:${payload.generation}:production_success`,
    receipt: outcomeReceipt,
    now: recordedAt,
  });
  const key = policyKey ?? `release-policy:${payload.repository}`;
  const advanced = await boundary.advancePolicy({
    key,
    currentGeneration: payload.previous_generation.generation,
    currentPolicyHash: payload.previous_generation.policy_hash,
    nextGeneration: payload.generation,
    nextPolicyHash: payload.policy_hash,
    now: recordedAt,
  });
  return { ...advanced, outcome: persisted.receipt };
}

export async function persistRollbackOutcome(publicKey, permit, { boundary, mergeReceipt, rollbackReceipt, now = Date.now() } = {}) {
  if (!boundary || typeof boundary.persistReceipt !== "function" || typeof boundary.readClaim !== "function") fail("policy_boundary_required");
  const payload = verifyAdmittedReleasePermit(publicKey, permit);
  await boundary.readClaim({
    key: `${RELEASE_REPLAY_PREFIX}${payload.repository}:${payload.nonce}`,
    permitDigest: permitDigest(permit),
  });
  validateSourceMergeReceipt(mergeReceipt, payload, { now, permitDigest: permitDigest(permit) });
  validateProductionRollbackReceipt(rollbackReceipt, payload, { now });
  const recordedAt = new Date(now).toISOString();
  const receipt = validateOutcomeReceipt({
    schema: RELEASE_OUTCOME_SCHEMA,
    kind: "production_rollback",
    repository: payload.repository,
    source_commit: payload.source_commit,
    generation: payload.generation,
    permit_digest: permitDigest(permit),
    merge_receipt_digest: sha256(canonicalJson(mergeReceipt)),
    outcome_digest: sha256(canonicalJson(rollbackReceipt)),
    recorded_at: recordedAt,
  });
  return boundary.persistReceipt({
    key: `${RELEASE_OUTCOME_PREFIX}${payload.repository}:${payload.generation}:production_rollback`,
    receipt,
    now: recordedAt,
  });
}

export async function persistRecoveryRequiredOutcome(publicKey, permit, { boundary, mergeReceipt, failureStage, now = Date.now() } = {}) {
  if (!boundary || typeof boundary.persistReceipt !== "function" || typeof boundary.readClaim !== "function") fail("policy_boundary_required");
  const payload = verifyAdmittedReleasePermit(publicKey, permit);
  const digest = permitDigest(permit);
  await boundary.readClaim({
    key: `${RELEASE_REPLAY_PREFIX}${payload.repository}:${payload.nonce}`,
    permitDigest: digest,
  });
  validateSourceMergeReceipt(mergeReceipt, payload, { now, permitDigest: digest });
  const observedAt = new Date(now).toISOString();
  const recoveryState = RECOVERY_REQUIRED_STATES[failureStage];
  if (!recoveryState) fail("production_recovery_required_stage_invalid");
  const fields = {
    schema: PRODUCTION_RECOVERY_REQUIRED_SCHEMA,
    repository: payload.repository,
    source_commit: payload.source_commit,
    generation: payload.generation,
    permit_digest: digest,
    merge_receipt_digest: sha256(canonicalJson(mergeReceipt)),
    merge_commit: mergeReceipt.merge_commit,
    failure_stage: failureStage,
    ...recoveryState,
    production_d1_recovery_digest: payload.release_manifest.recovery.production_d1_recovery_digest,
    prior_worker_revision: payload.release_manifest.recovery.prior_worker_revision,
    prior_worker_readback_digest: payload.release_manifest.recovery.prior_worker_readback_digest,
    prior_pwa_revision: payload.release_manifest.recovery.prior_pwa_revision,
    prior_pwa_readback_digest: payload.release_manifest.recovery.prior_pwa_readback_digest,
    prior_frappe_revision: payload.release_manifest.recovery.prior_frappe_revision,
    prior_frappe_readback_digest: payload.release_manifest.recovery.prior_frappe_readback_digest,
    prior_frappe_backup_digest: payload.release_manifest.recovery.prior_frappe_backup_digest,
    result: "recovery_required",
  };
  const recoveryReceipt = validateProductionRecoveryRequiredReceipt({
    ...fields,
    evidence_digest: sha256(canonicalJson(fields)),
    observed_at: observedAt,
  }, payload, { now, permitDigest: digest });
  const outcomeReceipt = validateOutcomeReceipt({
    schema: RELEASE_OUTCOME_SCHEMA,
    kind: "production_recovery_required",
    repository: payload.repository,
    source_commit: payload.source_commit,
    generation: payload.generation,
    permit_digest: digest,
    merge_receipt_digest: recoveryReceipt.merge_receipt_digest,
    outcome_digest: sha256(canonicalJson(recoveryReceipt)),
    recorded_at: observedAt,
  });
  const persisted = await boundary.persistReceipt({
    key: `${RELEASE_OUTCOME_PREFIX}${payload.repository}:${payload.generation}:production_recovery_required`,
    receipt: outcomeReceipt,
    now: observedAt,
  });
  return { ...persisted, recovery: recoveryReceipt };
}

function readArg(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) fail(`cli_${name.slice(2)}_required`);
  return args[index + 1];
}

async function cli(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (!command || (command !== "sign" && command !== "verify")) fail("cli_usage");
  const input = readArg(args, "--input");
  const output = args.includes("--output") ? readArg(args, "--output") : null;
  if (command === "sign") {
    const privateKeyFile = readArg(args, "--private-key-file");
    const payload = JSON.parse(await readFile(input, "utf8"));
    const permit = signReleasePermit(readFileSync(privateKeyFile, "utf8"), payload);
    if (output) await (await import("node:fs/promises")).writeFile(output, `${permit}\n`, { mode: 0o600 });
    else process.stdout.write(`${permit}\n`);
    return;
  }
  const publicKeyFile = readArg(args, "--public-key-file");
  const permit = (await readFile(input, "utf8")).trim();
  const payload = verifyReleasePermit(readFileSync(publicKeyFile, "utf8"), permit);
  process.stdout.write(`${JSON.stringify({ ok: true, permit_digest: permitDigest(permit), payload }, null, 2)}\n`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(new URL(import.meta.url).pathname)
) {
  await cli();
}
