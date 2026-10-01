import assert from "node:assert/strict";
import { generateKeyPairSync, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  admitReleasePermit,
  advanceReleaseGeneration,
  computeMigrationSet,
  computeSupplyChainEvidence,
  computeEnvironmentConfigDigest,
  computeReleaseConfigDigest,
  computeSourceEvidence,
  createCloudflareD1ReplayBoundary,
  MAX_PERMIT_LIFETIME_MS,
  MEASUREMENT_OCR_MODELS,
  parseWranglerVersionId,
  persistRecoveryRequiredOutcome,
  persistRollbackOutcome,
  releasePermitDigest,
  releaseVersionMessage,
  signReleasePermit,
  signReviewGoReceipt,
  signExternalReleaseEvidence,
  signServiceAdapterReceipt,
  validateReleasePermitPayload,
  validateDomainReadbackReceipt,
  validateProductionPromotionReceipt,
  validateSecretInventoryReadback,
  validateProviderTargetPolicy,
  validateReleaseEnvironmentPreflight,
  validateSourceMergeReceipt,
  validateWorkerVersionReadback,
  verifyReviewGoReceipt,
  verifyExternalReleaseEvidence,
  verifyServiceAdapterReceipt,
  verifyReleasePermit,
} from "./release-permit.mjs";
import { canonicalJson } from "../mcp/erpnext-roofing-mcp/src/approval-contract.mjs";

const run = promisify(execFile);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const CAPABILITY_CONTRACT_START = "<!-- capability-evidence-contract:start -->";
const CAPABILITY_CONTRACT_END = "<!-- capability-evidence-contract:end -->";
const COMMIT = "a".repeat(40);
const BASE = "b".repeat(40);
const GIT_TREE = "c".repeat(40);
const HEAD = "d".repeat(40);
const MERGE_COMMIT = "e".repeat(40);
const TREE = sha("tree");
const DIFF = sha("diff");
const QA_CONFIG = sha("qa-config");
const PRODUCTION_CONFIG = sha("production-config");
const QA_SECRET_INVENTORY = sha("qa-secret-inventory");
const PRODUCTION_SECRET_INVENTORY = sha("production-secret-inventory");
const CONFIG = computeReleaseConfigDigest({ qa: QA_CONFIG, production: PRODUCTION_CONFIG });
const POLICY = sha("policy");
const PREVIOUS_POLICY = sha("previous-policy");
const ARTIFACT = sha("worker-artifact");
const VERSION_DIGEST = sha("worker-version");
const UPLOAD = sha("upload-receipt");
const FINDINGS = sha("review-findings");
const EVIDENCE = sha("evidence");
const QA_VERSION = "11111111-1111-4111-8111-111111111111";
const WORKER_VERSION = "22222222-2222-4222-8222-222222222222";
const PREVIOUS_VERSION = "33333333-3333-4333-8333-333333333333";
const ISSUED_AT = "2026-08-16T20:00:00.000Z";
const EXPIRES_AT = "2026-08-16T20:10:00.000Z";
const NOW = Date.parse("2026-08-16T20:01:00.000Z");
const DOMAIN_HOSTNAME = "os.ironwrapexteriors.com";
const DOMAIN_SERVICE = "ironwrap-bus";
const DOMAIN_ZONE_ID = "a".repeat(32);
const DOMAIN_PROVIDER_RESULT = [{
  id: "domain-1",
  hostname: "OS.IRONWRAPEXTERIORS.COM.",
  service: DOMAIN_SERVICE,
  zone_id: DOMAIN_ZONE_ID,
  environment: "production",
}];
const DOMAIN_PROVIDER_READBACK_DIGEST = sha(canonicalJson(DOMAIN_PROVIDER_RESULT));

function affectedScopes() {
  return ["agent", "customer", "facet", "field", "finance", "production", "provider", "reception", "sales", "shop"].map((scope) => ({
    scope,
    status: "passed",
    authenticated: true,
    evidence_ref: `evidence:${scope}:synthetic`,
    evidence_digest: sha(`scope:${scope}`),
    non_applicability_policy_digest: null,
    reason_digest: null,
  }));
}

async function loadCapabilityContract(repoRoot) {
  const matrixPath = path.join(repoRoot, "docs", "CAPABILITY-MATRIX.md");
  const content = await readFile(matrixPath, "utf8");
  const start = content.indexOf(CAPABILITY_CONTRACT_START);
  const end = content.indexOf(CAPABILITY_CONTRACT_END);
  assert.notEqual(start, -1, "docs/CAPABILITY-MATRIX.md must embed capability contract start marker");
  assert.notEqual(end, -1, "docs/CAPABILITY-MATRIX.md must embed capability contract end marker");
  assert.ok(end > start, "docs/CAPABILITY-MATRIX.md capability contract markers must be ordered");
  const between = content.slice(start + CAPABILITY_CONTRACT_START.length, end);
  const fence = between.match(/```json\s*([\s\S]*?)```/);
  assert.ok(fence, "docs/CAPABILITY-MATRIX.md capability contract must contain one json fence");
  return JSON.parse(fence[1]);
}

function productionRecovery() {
  return {
    schema: "ironwrap_d1_recovery_point_v1",
    environment: "production",
    database_id: "f0674848-13df-4422-9896-8ba2719663b8",
    bookmark: "bookmark-20260816-production-0001",
    provider_readback_digest: sha("production-d1-bookmark-readback"),
    status: "matched",
    captured_at: "2026-08-16T20:03:30.000Z",
  };
}

function releaseManifest() {
  const mergePolicyFields = {
    schema: "ironwrap_github_merge_policy_v1",
    method: "squash",
    repository_settings: { default_branch: "main", allow_merge_commit: false, allow_squash_merge: true, allow_rebase_merge: true },
    ruleset: { id: 20652124, target: "branch", enforcement: "active", allowed_merge_methods: ["rebase", "squash"] },
  };
  const fields = {
    schema: "ironwrap_release_manifest_v2",
    frappe_scope: "in-scope",
    pr: {
      number: 43,
      base_ref: "main",
      base_commit: BASE,
      head_ref: "codex/iro-41-release-permit",
      head_commit: HEAD,
      ci_run_id: "31970000001",
      ci_merge_commit: COMMIT,
      ci_merge_tree: GIT_TREE,
      merge_method: "squash",
      merge_policy: { ...mergePolicyFields, readback_digest: sha(canonicalJson(mergePolicyFields)) },
      provider_readback_digest: sha("pr-readback"),
      status: "open",
    },
    source: {
      commit: COMMIT,
      git_tree: GIT_TREE,
      tree_manifest_sha256: TREE,
      diff_sha256: DIFF,
      component_digests: {
        worker: sha("worker-source"),
        pwa: sha("pwa-source"),
        frappe: sha("frappe-source"),
        mcp: sha("mcp-source"),
        hermes: sha("hermes-source"),
        tenant_config: sha("tenant-source"),
      },
    },
    supply_chain: {
      lockfiles_digest: sha("lockfiles"),
      sbom_digest: sha("sbom"),
      license_manifest_digest: sha("licenses"),
      license_policy_digest: sha("license-policy"),
      audit_receipt_digest: sha("audit"),
      result: "passed",
    },
    artifacts: {
      aggregate_digest: ARTIFACT,
      worker_digest: sha("worker-bundle"),
      pwa_digest: sha("pwa-dist"),
      frappe_wheel_digest: sha("frappe-wheel"),
      frappe_site_schema_digest: sha("frappe-site-schema"),
      mcp_digest: sha("mcp-source"),
      hermes_digest: sha("hermes-source"),
    },
    configuration: {
      aggregate_digest: CONFIG,
      tenant_digest: sha("tenant-source"),
      mcp_digest: sha("mcp-source"),
      hermes_digest: sha("hermes-source"),
      bindings_digest: sha("bindings"),
      queues_digest: sha("queues"),
      buckets_digest: sha("buckets"),
      routes_digest: sha("routes"),
      secret_names_digest: sha("secret-names"),
    },
    migrations: {
      d1_set_digest: sha(JSON.stringify(["0001_initial.sql", "0002_envelopes.sql", "0042_external_effect_runtime.sql"])),
      frappe_schema_digest: sha("frappe-schema"),
      frappe_migration_digest: sha("frappe-migrations"),
      compatibility: "expand-contract",
    },
    qa: {
      worker_revision: QA_VERSION,
      worker_readback_digest: VERSION_DIGEST,
      pwa_revision: QA_VERSION,
      pwa_readback_digest: sha("pwa-qa-readback"),
      frappe_revision: "frappe-qa-20260816",
      frappe_readback_digest: sha("frappe-qa-readback"),
      status: "matched",
    },
    production_candidates: {
      pwa_revision: WORKER_VERSION,
      pwa_readback_digest: VERSION_DIGEST,
      frappe_revision: "frappe-production-candidate-20260816",
      frappe_readback_digest: sha("frappe-production-candidate-readback"),
      domain_hostname: DOMAIN_HOSTNAME,
      domain_service: DOMAIN_SERVICE,
      domain_zone_id: DOMAIN_ZONE_ID,
      status: "prepared",
    },
    recovery: {
      qa_backup_restore_digest: sha(JSON.stringify({ export_digest: sha("qa-export"), manifest_digest: sha("qa-manifest"), restore_evidence_digest: EVIDENCE })),
      qa_rollback_digest: EVIDENCE,
      production_d1_recovery_digest: sha(canonicalJson(productionRecovery())),
      prior_worker_revision: PREVIOUS_VERSION,
      prior_worker_readback_digest: sha("worker-previous-readback"),
      prior_pwa_revision: "pwa-production-previous",
      prior_pwa_readback_digest: sha("pwa-previous-readback"),
      prior_frappe_revision: "frappe-production-previous",
      prior_frappe_readback_digest: sha("frappe-previous-readback"),
      prior_frappe_backup_digest: sha("frappe-backup"),
      status: "passed",
    },
    provider_reconciliation: {
      receipt_ref: "provider-reconciliation:IROP-20260816",
      receipt_digest: sha("provider-reconciliation"),
      provider_identity_digest: sha("provider-identity"),
      status: "matched",
    },
  };
  return { ...fields, evidence_digest: sha(canonicalJson(fields)) };
}

function externalEvidence(overrides = {}) {
  const manifest = releaseManifest();
  return {
    schema: "ironwrap_release_external_evidence_v1",
    type: "ironwrap-release-external-evidence",
    repository: "Iron-Wrap/ironwrap-os",
    pr_number: manifest.pr.number,
    source_commit: COMMIT,
    source_git_tree: GIT_TREE,
    artifact_digest: ARTIFACT,
    supply_chain: manifest.supply_chain,
    service_identities: {
      pwa: {
        artifact_digest: manifest.artifacts.pwa_digest,
        qa_revision: manifest.qa.pwa_revision,
        qa_readback_digest: manifest.qa.pwa_readback_digest,
        production_candidate_revision:
          manifest.production_candidates.pwa_revision,
        production_candidate_readback_digest:
          manifest.production_candidates.pwa_readback_digest,
      },
      frappe: {
        artifact_digest: manifest.artifacts.frappe_wheel_digest,
        site_schema_digest: manifest.artifacts.frappe_site_schema_digest,
        qa_revision: manifest.qa.frappe_revision,
        qa_readback_digest: manifest.qa.frappe_readback_digest,
        production_candidate_revision:
          manifest.production_candidates.frappe_revision,
        production_candidate_readback_digest:
          manifest.production_candidates.frappe_readback_digest,
      },
      facet: {
        artifact_digest: sha("facet-artifact"),
        integration_receipt_digest: sha("facet-integration"),
      },
    },
    affected_scopes: affectedScopes(),
    recovery: {
      prior_worker_readback_digest:
        manifest.recovery.prior_worker_readback_digest,
      prior_pwa_revision: manifest.recovery.prior_pwa_revision,
      prior_pwa_readback_digest:
        manifest.recovery.prior_pwa_readback_digest,
      prior_frappe_revision: manifest.recovery.prior_frappe_revision,
      prior_frappe_readback_digest:
        manifest.recovery.prior_frappe_readback_digest,
      prior_frappe_backup_digest: manifest.recovery.prior_frappe_backup_digest,
    },
    provider_reconciliation: manifest.provider_reconciliation,
    business_evidence: {
      issue_id: "IRO-7",
      actor_receipt_ref: "linear:IRO-7:actor-receipt",
      actor_receipt_digest: sha("actor-receipt"),
      business_receipt_ref: "linear:IRO-7:business-receipt",
      business_receipt_digest: sha("business-receipt"),
      result: "passed",
    },
    records: {
      authority_issue: "IRO-12",
      implementation_issue: "IRO-41",
      business_issue: "IRO-7",
      release_record_ref: "release:Iron-Wrap/ironwrap-os:5",
      release_record_digest: sha("release-record"),
    },
    issuer_principal: "evidence-reviewer@ironwrapexteriors.com",
    issuer_task_id: "iro7-evidence-task",
    issuer_run_id: "iro7-evidence-run",
    key_version: "review-key-2026-08",
    issued_at: ISSUED_AT,
    expires_at: "2026-08-17T01:00:00.000Z",
    nonce: "evidence0123456789abcdef0123456789abcdef0123456789abcdef",
    ...overrides,
  };
}

function sourceMergeReceipt(permit) {
  const manifest = releaseManifest();
  const fields = {
    schema: "ironwrap_source_admission_merge_v1",
    repository: "Iron-Wrap/ironwrap-os",
    pr_number: 43,
    head_commit: HEAD,
    base_commit: BASE,
    ci_merge_commit: COMMIT,
    expected_tree: GIT_TREE,
    merge_method: "squash",
    provider_settings_digest: manifest.pr.merge_policy.readback_digest,
    merge_commit: MERGE_COMMIT,
    merge_tree: GIT_TREE,
    main_commit: MERGE_COMMIT,
    permit_digest: releasePermitDigest(permit),
    admission_digest: sha("admission"),
    status: "merged",
  };
  return {
    ...fields,
    evidence_digest: sha(canonicalJson(fields)),
    observed_at: "2026-08-16T20:00:20.000Z",
  };
}

function serviceAdapterPayload(operation = "promote", overrides = {}) {
  const manifest = releaseManifest();
  return {
    schema: "ironwrap_service_adapter_receipt_v1",
    type: "ironwrap-service-adapter-receipt",
    operation,
    repository: "Iron-Wrap/ironwrap-os",
    source_commit: COMMIT,
    source_git_tree: GIT_TREE,
    aggregate_artifact_digest: ARTIFACT,
    merge_commit: MERGE_COMMIT,
    frappe: {
      artifact_digest: manifest.artifacts.frappe_wheel_digest,
      site_schema_digest: manifest.artifacts.frappe_site_schema_digest,
      previous_revision: manifest.recovery.prior_frappe_revision,
      candidate_revision: manifest.production_candidates.frappe_revision,
      active_revision:
        operation === "rollback"
          ? manifest.recovery.prior_frappe_revision
          : manifest.production_candidates.frappe_revision,
      backup_digest: manifest.recovery.prior_frappe_backup_digest,
      provider_readback_digest:
        operation === "rollback"
          ? manifest.recovery.prior_frappe_readback_digest
          : manifest.production_candidates.frappe_readback_digest,
      status: "matched",
    },
    provider_reconciliation_digest:
      manifest.provider_reconciliation.receipt_digest,
    result: "passed",
    issuer_principal: "service-release@ironwrapexteriors.com",
    issuer_task_id: "frappe-release-adapter",
    issuer_run_id: `service-${operation}-run`,
    key_version: "service-key-2026-08",
    issued_at: ISSUED_AT,
    expires_at: "2026-08-16T20:25:00.000Z",
    nonce: `service${operation}0123456789abcdef0123456789abcdef0123456789`,
    ...overrides,
  };
}

function payload(overrides = {}) {
  return {
    schema: "ironwrap_release_permit_v2",
    type: "ironwrap-release-permit",
    permit_id: "release:Iron-Wrap/ironwrap-os:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    repository: "Iron-Wrap/ironwrap-os",
    source_commit: COMMIT,
    base_commit: BASE,
    source_git_tree: GIT_TREE,
    source_tree_sha256: TREE,
    diff_sha256: DIFF,
    ci_checks: [
      { check_id: "ci-validation", run_id: "31970000001", job_name: "validate-and-test", conclusion: "success", repository: "Iron-Wrap/ironwrap-os", head_sha: COMMIT, workflow_id: 123456, workflow_path: ".github/workflows/ci.yml", event: "pull_request", status: "completed", run_attempt: 1 },
      { check_id: "ci-release-readiness", run_id: "31970000001", job_name: "release-readiness", conclusion: "success", repository: "Iron-Wrap/ironwrap-os", head_sha: COMMIT, workflow_id: 123456, workflow_path: ".github/workflows/ci.yml", event: "pull_request", status: "completed", run_attempt: 1 },
    ],
    previous_generation: { generation: 4, policy_hash: PREVIOUS_POLICY },
    generation: 5,
    policy_hash: POLICY,
    config_digest: CONFIG,
    migrations: {
      ordered: ["0001_initial.sql", "0002_envelopes.sql", "0042_external_effect_runtime.sql"],
      set_digest: sha(JSON.stringify(["0001_initial.sql", "0002_envelopes.sql", "0042_external_effect_runtime.sql"])),
      compatibility: "expand-contract",
      no_down_migrations: true,
    },
    build_once: {
      source_commit: COMMIT,
      source_tree_sha256: TREE,
      artifact_digest: ARTIFACT,
      uploaded_once: true,
      upload_receipt_digest: UPLOAD,
    },
    worker: {
      artifact_digest: ARTIFACT,
      qa_version_id: QA_VERSION,
      qa_version_digest: VERSION_DIGEST,
      qa_config_digest: QA_CONFIG,
      qa_secret_inventory_digest: QA_SECRET_INVENTORY,
      production_version_id: WORKER_VERSION,
      production_version_digest: VERSION_DIGEST,
      production_config_digest: PRODUCTION_CONFIG,
      production_secret_inventory_digest: PRODUCTION_SECRET_INVENTORY,
    },
    qa: {
      environment: "qa",
      revision: QA_VERSION,
      source_commit: COMMIT,
      source_tree_sha256: TREE,
      artifact_digest: ARTIFACT,
      config_digest: QA_CONFIG,
      readback: {
        status: "matched",
        source_commit: COMMIT,
        source_tree_sha256: TREE,
        artifact_digest: ARTIFACT,
        config_digest: QA_CONFIG,
        secret_inventory_digest: QA_SECRET_INVENTORY,
      },
    },
    production: {
      environment: "production",
      revision: WORKER_VERSION,
      source_commit: COMMIT,
      source_tree_sha256: TREE,
      artifact_digest: ARTIFACT,
      config_digest: PRODUCTION_CONFIG,
      readback: {
        status: "matched",
        source_commit: COMMIT,
        source_tree_sha256: TREE,
        artifact_digest: ARTIFACT,
        config_digest: PRODUCTION_CONFIG,
        secret_inventory_digest: PRODUCTION_SECRET_INVENTORY,
      },
    },
    smoke: {
      receipt_id: "smoke-qa-20260816-01",
      workflow: "affected-workflow:authenticated-core",
      authenticated: true,
      result: "passed",
      affected_workflow_ids: ["admin_envelopes", "admin_reconcile", "admin_status", "d1_lead", "health", "ingest_estimate", "ingest_estimate_replay", "ingest_website", "ingest_website_replay", "ready"],
      source_commit: COMMIT,
      revision: QA_VERSION,
      evidence_digest: EVIDENCE,
      observed_at: "2026-08-16T20:02:00.000Z",
    },
    backup_restore: {
      backup_id: "backup-qa-20260816-01",
      environment: "qa",
      isolated_target: "ironwrap-restore-drill-20260816",
      source_generation: 4,
      source_commit: COMMIT,
      artifact_digest: ARTIFACT,
      result: "passed",
      restored: true,
      readback: "matched",
      export_digest: sha("qa-export"),
      manifest_digest: sha("qa-manifest"),
      restore_evidence_digest: EVIDENCE,
      evidence_digest: sha(JSON.stringify({ export_digest: sha("qa-export"), manifest_digest: sha("qa-manifest"), restore_evidence_digest: EVIDENCE })),
      observed_at: "2026-08-16T20:03:00.000Z",
    },
    production_recovery: productionRecovery(),
    rollback: {
      drill_id: "rollback-qa-20260816-01",
      previous_revision: PREVIOUS_VERSION,
      candidate_revision: QA_VERSION,
      restored_revision: PREVIOUS_VERSION,
      re_promoted_revision: QA_VERSION,
      result: "passed",
      readback: "matched",
      health_digest: sha("rollback-health"),
      readiness_digest: sha("rollback-ready"),
      smoke_evidence_digest: sha("rollback-smoke"),
      smoke_result: "passed",
      source_commit: COMMIT,
      evidence_digest: EVIDENCE,
      observed_at: "2026-08-16T20:04:00.000Z",
    },
    release_manifest: releaseManifest(),
    issuer_identity: "release-admission@ironwrapexteriors.com",
    issued_at: ISSUED_AT,
    expires_at: EXPIRES_AT,
    nonce: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    ...overrides,
  };
}

function keyPair() {
  return generateKeyPairSync("ed25519");
}

test("validates, signs, and verifies the complete source-to-recovery permit", () => {
  const { privateKey, publicKey } = keyPair();
  const permit = signReleasePermit(privateKey, payload(), { now: NOW });
  const verified = verifyReleasePermit(publicKey, permit, {
    repository: "Iron-Wrap/ironwrap-os",
    source_commit: COMMIT,
    source_tree_sha256: TREE,
    diff_sha256: DIFF,
    current_generation: 4,
    current_policy_hash: PREVIOUS_POLICY,
    required_check_ids: ["ci-validation", "ci-release-readiness"],
  }, { now: NOW });
  assert.equal(verified.worker.artifact_digest, ARTIFACT);
  assert.equal(verified.release_manifest.frappe_scope, "in-scope");
  assert.equal(verified.qa.readback.status, "matched");
  assert.equal(verified.production.readback.status, "matched");
});

test("the signed manifest owns the exact Frappe release scope", () => {
  const { privateKey, publicKey } = keyPair();
  const manifest = releaseManifest();
  const { evidence_digest: _replaced, ...fields } = manifest;
  const outOfScopeFields = { ...fields, frappe_scope: "out-of-scope" };
  const outOfScope = {
    ...outOfScopeFields,
    evidence_digest: sha(canonicalJson(outOfScopeFields)),
  };
  assert.equal(
    validateReleasePermitPayload(
      payload({ release_manifest: outOfScope }),
      { now: NOW },
    ).release_manifest.frappe_scope,
    "out-of-scope",
  );
  const outOfScopePermit = signReleasePermit(
    privateKey,
    payload({ release_manifest: outOfScope }),
    { now: NOW },
  );
  assert.throws(
    () =>
      verifyReleasePermit(
        publicKey,
        outOfScopePermit,
        { frappe_scope: "in-scope" },
        { now: NOW },
      ),
    /release_permit_expected_frappe_scope_mismatch/,
  );

  for (const frappeScope of [undefined, "optional", "in-scope "]) {
    const invalidFields = { ...fields, frappe_scope: frappeScope };
    const invalid = {
      ...invalidFields,
      evidence_digest: sha(canonicalJson(invalidFields)),
    };
    assert.throws(
      () =>
        validateReleasePermitPayload(payload({ release_manifest: invalid }), {
          now: NOW,
        }),
      /release_permit_release_manifest_frappe_scope_invalid/,
    );
  }
});

test("admits an open or merged source state and no other PR status", () => {
  const { privateKey, publicKey } = keyPair();
  const withStatus = (status) => {
    const { evidence_digest: _replaced, ...fields } = releaseManifest();
    const restated = { ...fields, pr: { ...fields.pr, status } };
    return { ...restated, evidence_digest: sha(canonicalJson(restated)) };
  };
  // A pull_request-sourced release is admitted before its merge; a push-sourced
  // one after it. Both are exact, readback-verified states.
  const permit = signReleasePermit(privateKey, payload({ release_manifest: withStatus("merged") }), { now: NOW });
  assert.equal(
    verifyReleasePermit(publicKey, permit, {}, { now: NOW }).release_manifest.pr.status,
    "merged",
  );
  for (const status of ["closed", "draft", "open ", ""]) {
    assert.throws(
      () => validateReleasePermitPayload(payload({ release_manifest: withStatus(status) }), { now: NOW }),
      /release_permit_release_manifest_pr_status_invalid/,
      status,
    );
  }
});

test("rejects payload and signature tampering", () => {
  const { privateKey, publicKey } = keyPair();
  const permit = signReleasePermit(privateKey, payload(), { now: NOW });
  const [encoded, signature] = permit.split(".");
  const changed = `${Buffer.from(JSON.stringify({ ...payload(), config_digest: sha("changed") })).toString("base64url")}.${signature}`;
  assert.throws(() => verifyReleasePermit(publicKey, changed, {}, { now: NOW }), /release_permit_signature_invalid/);
  const changedSignature = `${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
  assert.throws(() => verifyReleasePermit(publicKey, `${encoded}.${changedSignature}`, {}, { now: NOW }), /release_permit_signature_invalid/);
});

test("rejects expiry, overlong windows, future permits, and an external reviewer block", () => {
  assert.throws(() => validateReleasePermitPayload(payload({ expires_at: "2026-08-16T20:16:00.000Z" }), { now: NOW }), /release_permit_window_invalid/);
  assert.throws(() => validateReleasePermitPayload(payload({ expires_at: "2026-08-16T20:00:30.000Z" }), { now: NOW }), /release_permit_expired/);
  assert.throws(() => validateReleasePermitPayload(payload({ issued_at: "2026-08-16T20:02:01.000Z" }), { now: NOW }), /release_permit_issued_in_future/);
  // Releases are admitted by automated checks alone; a reviewer GO block is not
  // part of the permit, so one cannot be smuggled in as optional evidence.
  assert.throws(() => validateReleasePermitPayload(payload({ reviewer: { principal: "reviewer@ironwrapexteriors.com", decision: "GO" } }), { now: NOW }), /release_permit_payload_shape_invalid/);
});

test("rejects unknown fields, weak CI, and migration rollback paths", () => {
  assert.throws(() => validateReleasePermitPayload({ ...payload(), unexpected: true }, { now: NOW }), /release_permit_payload_shape_invalid/);
  assert.throws(() => validateReleasePermitPayload(payload({ ci_checks: [{ ...payload().ci_checks[0], conclusion: "neutral" }] }), { now: NOW }), /release_permit_ci_check_not_success/);
  assert.throws(() => validateReleasePermitPayload(payload({ migrations: { ...payload().migrations, ordered: ["0001_initial.sql", "0002_down.sql"], set_digest: sha(JSON.stringify(["0001_initial.sql", "0002_down.sql"])) } }), { now: NOW }), /release_permit_migration_invalid/);
});

test("generation and every readback bind to the exact candidate", () => {
  const { privateKey, publicKey } = keyPair();
  const permit = signReleasePermit(privateKey, payload(), { now: NOW });
  assert.throws(() => verifyReleasePermit(publicKey, permit, { current_generation: 3 }, { now: NOW }), /release_permit_generation_gate_mismatch/);
  const drifted = payload({
    qa: {
      ...payload().qa,
      readback: { ...payload().qa.readback, artifact_digest: sha("drift") },
    },
  });
  assert.throws(() => validateReleasePermitPayload(drifted, { now: NOW }), /release_permit_qa_readback_artifact_drift/);
  assert.throws(() => validateReleasePermitPayload(payload({ rollback: { ...payload().rollback, restored_revision: "44444444-4444-4444-8444-444444444444" } }), { now: NOW }), /release_permit_rollback_restored_revision_drift/);
});

test("admission consumes a permit once through a durable boundary", async () => {
  const { privateKey, publicKey } = keyPair();
  const permit = signReleasePermit(privateKey, payload(), { now: NOW });
  const durableRows = new Map();
  const boundary = {
    async claim(input) {
      const prior = durableRows.get(input.key);
      if (prior && prior !== input.permitDigest) return { status: "conflict" };
      if (prior) return { status: "replayed" };
      durableRows.set(input.key, input.permitDigest);
      return { status: "claimed" };
    },
  };
  const admitted = await admitReleasePermit(publicKey, permit, { boundary, now: NOW, expected: { current_generation: 4, current_policy_hash: PREVIOUS_POLICY } });
  assert.equal(admitted.claim.status, "claimed");
  await assert.rejects(() => admitReleasePermit(publicKey, permit, { boundary, now: NOW }), /release_permit_replayed/);
});

test("Cloudflare D1 boundary uses the existing atomic dedup ledger and never logs the token", async () => {
  const calls = [];
  const token = "cloudflare-token-that-must-not-leak-0123456789";
  const boundary = createCloudflareD1ReplayBoundary({
    accountId: "7ee5775bc1ba46f05c5a65235b60e939",
    databaseId: "f0674848-13df-4422-9896-8ba2719663b8",
    apiToken: token,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify({ success: true, result: [{ results: body.sql.includes("RETURNING") ? [{ dedup_key: body.params[0] }] : [] }] }), { status: 200 });
    },
  });
  const result = await boundary.claim({ key: "release-permit:Iron-Wrap/ironwrap-os:nonce", permitDigest: sha("permit"), now: ISSUED_AT });
  assert.equal(result.status, "claimed");
  assert.equal(calls.length, 1);
  assert.match(calls[0].init.body, /dedup_claims/);
  assert.equal(calls[0].init.headers.authorization, `Bearer ${token}`);
  assert.equal(JSON.stringify(result).includes(token), false);
});

test("Cloudflare D1 policy state advances only from the exact durable predecessor", async () => {
  const rows = new Map([["release-policy:Iron-Wrap/ironwrap-os", JSON.stringify({ generation: 4, policy_hash: PREVIOUS_POLICY })]]);
  const boundary = createCloudflareD1ReplayBoundary({
    accountId: "7ee5775bc1ba46f05c5a65235b60e939",
    databaseId: "f0674848-13df-4422-9896-8ba2719663b8",
    apiToken: "cloudflare-token-that-must-not-leak-0123456789",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.sql.startsWith("SELECT")) {
        return new Response(JSON.stringify({ success: true, result: [{ results: rows.has(body.params[0]) ? [{ first_envelope_id: rows.get(body.params[0]) }] : [] }] }), { status: 200 });
      }
      if (body.sql.startsWith("UPDATE")) {
        const [next, _updatedAt, key, current] = body.params;
        if (rows.get(key) !== current) return new Response(JSON.stringify({ success: true, result: [{ results: [] }] }), { status: 200 });
        rows.set(key, next);
        return new Response(JSON.stringify({ success: true, result: [{ results: [{ dedup_key: key }] }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true, result: [{ results: [{ dedup_key: body.params[0] }] }] }), { status: 200 });
    },
  });
  assert.deepEqual(await boundary.readPolicy({ key: "release-policy:Iron-Wrap/ironwrap-os" }), { generation: 4, policy_hash: PREVIOUS_POLICY });
  const advanced = await boundary.advancePolicy({
    key: "release-policy:Iron-Wrap/ironwrap-os",
    currentGeneration: 4,
    currentPolicyHash: PREVIOUS_POLICY,
    nextGeneration: 5,
    nextPolicyHash: POLICY,
    now: ISSUED_AT,
  });
  assert.equal(advanced.state.generation, 5);
  await assert.rejects(() => boundary.advancePolicy({
    key: "release-policy:Iron-Wrap/ironwrap-os",
    currentGeneration: 4,
    currentPolicyHash: PREVIOUS_POLICY,
    nextGeneration: 5,
    nextPolicyHash: POLICY,
    now: ISSUED_AT,
  }), /release_permit_policy_state_conflict/);
});

test("Cloudflare D1 policy genesis is atomic, deterministic, and fail-closed on drift", async () => {
  const rows = new Map();
  const key = "release-policy:Iron-Wrap/ironwrap-os";
  const genesis = { generation: 0, policy_hash: POLICY };
  const boundary = createCloudflareD1ReplayBoundary({
    accountId: "7ee5775bc1ba46f05c5a65235b60e939",
    databaseId: "f0674848-13df-4422-9896-8ba2719663b8",
    apiToken: "cloudflare-token-that-must-not-leak-0123456789",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.sql.startsWith("INSERT OR IGNORE")) {
        if (!rows.has(body.params[0])) rows.set(body.params[0], body.params[1]);
        return new Response(JSON.stringify({ success: true, result: [{ results: [] }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true, result: [{ results: rows.has(body.params[0]) ? [{ first_envelope_id: rows.get(body.params[0]) }] : [] }] }), { status: 200 });
    },
  });
  const concurrent = await Promise.all([
    boundary.ensurePolicy({ key, genesis, now: ISSUED_AT }),
    boundary.ensurePolicy({ key, genesis, now: ISSUED_AT }),
  ]);
  assert.deepEqual(concurrent[0], genesis);
  assert.deepEqual(concurrent[1], genesis);
  rows.set(key, JSON.stringify({ generation: 0, policy_hash: sha("different") }));
  await assert.rejects(() => boundary.ensurePolicy({ key, genesis, now: ISSUED_AT }), /release_permit_policy_genesis_drift/);
  rows.set(key, JSON.stringify({ generation: 2, policy_hash: sha("later") }));
  assert.deepEqual(await boundary.ensurePolicy({ key, genesis, now: ISSUED_AT }), { generation: 2, policy_hash: sha("later") });
});

test("Cloudflare D1 outcome receipts are immutable, source-addressed, and read back exactly", async () => {
  const rows = new Map();
  const boundary = createCloudflareD1ReplayBoundary({
    accountId: "7ee5775bc1ba46f05c5a65235b60e939",
    databaseId: "f0674848-13df-4422-9896-8ba2719663b8",
    apiToken: "cloudflare-token-that-must-not-leak-0123456789",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.sql.startsWith("INSERT OR IGNORE")) {
        const inserted = !rows.has(body.params[0]);
        if (inserted) rows.set(body.params[0], body.params[1]);
        return new Response(JSON.stringify({ success: true, result: [{ results: inserted ? [{ dedup_key: body.params[0] }] : [] }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true, result: [{ results: rows.has(body.params[0]) ? [{ first_envelope_id: rows.get(body.params[0]) }] : [] }] }), { status: 200 });
    },
  });
  const receipt = {
    schema: "ironwrap_release_outcome_v1",
    kind: "production_success",
    repository: "Iron-Wrap/ironwrap-os",
    source_commit: COMMIT,
    generation: 5,
    permit_digest: sha("permit"),
    merge_receipt_digest: sha("merge"),
    outcome_digest: sha("outcome"),
    recorded_at: ISSUED_AT,
  };
  const key = "release-outcome:Iron-Wrap/ironwrap-os:5:production_success";
  assert.equal((await boundary.persistReceipt({ key, receipt, now: ISSUED_AT })).status, "persisted");
  assert.equal((await boundary.persistReceipt({ key, receipt, now: ISSUED_AT })).status, "matched");
  assert.deepEqual(await boundary.readReceipt({ key }), receipt);
  await assert.rejects(() => boundary.persistReceipt({ key, receipt: { ...receipt, outcome_digest: sha("changed") }, now: ISSUED_AT }), /release_permit_release_outcome_conflict/);
});

test("generation advance requires the same durable permit claim", async () => {
  const rows = new Map();
  const boundary = createCloudflareD1ReplayBoundary({
    accountId: "7ee5775bc1ba46f05c5a65235b60e939",
    databaseId: "f0674848-13df-4422-9896-8ba2719663b8",
    apiToken: "cloudflare-token-that-must-not-leak-0123456789",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.sql.startsWith("INSERT")) {
        rows.set(body.params[0], body.params[1]);
        return new Response(JSON.stringify({ success: true, result: [{ results: [{ dedup_key: body.params[0] }] }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true, result: [{ results: rows.has(body.params[0]) ? [{ first_envelope_id: rows.get(body.params[0]) }] : [] }] }), { status: 200 });
    },
  });
  const digest = sha("permit");
  const key = "release-permit:Iron-Wrap/ironwrap-os:nonce";
  await boundary.claim({ key, permitDigest: digest, now: ISSUED_AT });
  assert.deepEqual(await boundary.readClaim({ key, permitDigest: digest }), { status: "claimed", key });
  await assert.rejects(() => boundary.readClaim({ key, permitDigest: sha("other") }), /release_permit_d1_replay_claim_missing/);
});

test("domain readback receipt binds the exact hostname, service, zone, and digest", () => {
  const receipt = {
    schema: "ironwrap_cloudflare_workers_domain_readback_v1",
    type: "ironwrap-cloudflare-workers-domain-readback",
    hostname: DOMAIN_HOSTNAME,
    service: DOMAIN_SERVICE,
    zone_id: DOMAIN_ZONE_ID,
    provider_readback_digest: DOMAIN_PROVIDER_READBACK_DIGEST,
    status: "matched",
  };
  assert.equal(
    validateDomainReadbackReceipt(receipt, {
      hostname: DOMAIN_HOSTNAME,
      service: DOMAIN_SERVICE,
      zoneId: DOMAIN_ZONE_ID,
      providerReadbackDigest: DOMAIN_PROVIDER_READBACK_DIGEST,
      providerResult: DOMAIN_PROVIDER_RESULT,
    }).status,
    "matched",
  );
  assert.throws(
    () => validateDomainReadbackReceipt({ ...receipt, provider_readback_digest: sha("wrong") }, {
      providerResult: DOMAIN_PROVIDER_RESULT,
    }),
    /release_permit_domain_readback_digest_mismatch/,
  );
  assert.throws(
    () => validateDomainReadbackReceipt({ ...receipt, zone_id: "z".repeat(32) }),
    /release_permit_domain_readback_zone_invalid/,
  );
  const otherHostname = "other.ironwrapexteriors.com";
  assert.throws(
    () => validateDomainReadbackReceipt({
      ...receipt,
      hostname: otherHostname,
    }, { hostname: DOMAIN_HOSTNAME }),
    /release_permit_domain_readback_hostname_drift/,
  );
});

test("generation advance requires an immutable production receipt for the exact provider version", async () => {
  const { privateKey, publicKey } = keyPair();
  const permit = signReleasePermit(privateKey, payload(), { now: NOW });
  const mergeReceipt = sourceMergeReceipt(permit);
  const fields = {
    source_commit: COMMIT,
    source_tree_sha256: TREE,
    artifact_digest: ARTIFACT,
    config_digest: PRODUCTION_CONFIG,
    revision: WORKER_VERSION,
    version_digest: VERSION_DIGEST,
    merge_commit: MERGE_COMMIT,
    merge_receipt_digest: sha(canonicalJson(mergeReceipt)),
    pwa_revision: WORKER_VERSION,
    pwa_readback_digest: VERSION_DIGEST,
    frappe_revision: "frappe-production-candidate-20260816",
    frappe_readback_digest: sha("frappe-production-candidate-readback"),
    service_promotion_digest: sha("service-promotion-receipt"),
    service_readback_digest: sha("service-readback-receipt"),
    domain_hostname: DOMAIN_HOSTNAME,
    domain_service: DOMAIN_SERVICE,
    domain_zone_id: DOMAIN_ZONE_ID,
    domain_provider_readback_digest: DOMAIN_PROVIDER_READBACK_DIGEST,
    frappe_scope: "in-scope",
    smoke_evidence_digest: sha("production-smoke"),
    smoke_result: "passed",
    smoke_step_names: ["admin_envelopes", "admin_reconcile", "admin_status", "d1_lead", "health", "ingest_estimate", "ingest_estimate_replay", "ingest_website", "ingest_website_replay", "ready"],
    health_digest: sha("production-health"),
    readiness_digest: sha("production-ready"),
  };
  const receipt = {
    schema: "ironwrap_production_promotion_v1",
    type: "ironwrap-production-promotion",
    ...fields,
    active_revision: WORKER_VERSION,
    active_readback: "matched",
    evidence_digest: sha(canonicalJson(fields)),
    observed_at: "2026-08-16T20:00:30.000Z",
  };
  assert.equal(validateProductionPromotionReceipt(receipt, {
    sourceCommit: COMMIT,
    sourceTreeSha256: TREE,
    artifactDigest: ARTIFACT,
    configDigest: PRODUCTION_CONFIG,
    revision: WORKER_VERSION,
    versionDigest: VERSION_DIGEST,
    mergeCommit: MERGE_COMMIT,
    mergeReceiptDigest: sha(canonicalJson(mergeReceipt)),
    frappeReadbackDigest: sha("frappe-production-candidate-readback"),
    domainHostname: DOMAIN_HOSTNAME,
    domainService: DOMAIN_SERVICE,
    domainZoneId: DOMAIN_ZONE_ID,
    domainProviderReadbackDigest: DOMAIN_PROVIDER_READBACK_DIGEST,
  }, { now: NOW }).revision, WORKER_VERSION);
  const boundary = {
    async readClaim() { return { status: "claimed" }; },
    async persistReceipt(input) { return { status: "persisted", key: input.key, receipt: input.receipt }; },
    async advancePolicy(input) { return { status: "advanced", key: input.key, state: { generation: input.nextGeneration, policy_hash: input.nextPolicyHash } }; },
  };
  const advanced = await advanceReleaseGeneration(publicKey, permit, {
    boundary,
    policyKey: "release-policy:Iron-Wrap/ironwrap-os",
    productionReceipt: receipt,
    mergeReceipt,
    now: NOW,
  });
  assert.equal(advanced.state.generation, 5);
  assert.equal(advanced.outcome.kind, "production_success");
  await assert.rejects(() => advanceReleaseGeneration(publicKey, permit, {
    boundary,
    policyKey: "release-policy:Iron-Wrap/ironwrap-os",
    productionReceipt: { ...receipt, version_digest: sha("different-version") },
    mergeReceipt,
    now: NOW,
  }), /release_permit_production_promotion_version_digest_drift/);
  const alteredDomainHostname = "other.ironwrapexteriors.com";
  const alteredDomainFields = {
    ...fields,
    domain_hostname: alteredDomainHostname,
    domain_provider_readback_digest: sha(canonicalJson([{
      id: "domain-other",
      hostname: alteredDomainHostname,
      service: DOMAIN_SERVICE,
      zone_id: DOMAIN_ZONE_ID,
    }])),
  };
  await assert.rejects(() => advanceReleaseGeneration(publicKey, permit, {
    boundary,
    policyKey: "release-policy:Iron-Wrap/ironwrap-os",
    productionReceipt: {
      ...receipt,
      ...alteredDomainFields,
      evidence_digest: sha(canonicalJson(alteredDomainFields)),
    },
    mergeReceipt,
    now: NOW,
  }), /release_permit_production_promotion_domain_hostname_drift/);
});

test("an expired permit can record rollback only through its durable admitted claim", async () => {
  const { privateKey, publicKey } = keyPair();
  const permitPayload = payload();
  const permit = signReleasePermit(privateKey, permitPayload, { now: NOW });
  const mergeReceipt = sourceMergeReceipt(permit);
  const rollbackFields = {
    schema: "ironwrap_production_rollback_v3",
    source_commit: COMMIT,
    previous_revision: PREVIOUS_VERSION,
    candidate_revision: WORKER_VERSION,
    restored_revision: PREVIOUS_VERSION,
    frappe_scope: "in-scope",
    result: "passed",
    readback: "matched",
    provider_readback_digest:
      permitPayload.release_manifest.recovery.prior_worker_readback_digest,
    pwa_previous_revision:
      permitPayload.release_manifest.recovery.prior_pwa_revision,
    pwa_candidate_revision:
      permitPayload.release_manifest.production_candidates.pwa_revision,
    pwa_restored_revision:
      permitPayload.release_manifest.recovery.prior_pwa_revision,
    pwa_provider_readback_digest:
      permitPayload.release_manifest.recovery.prior_pwa_readback_digest,
    frappe_previous_revision:
      permitPayload.release_manifest.recovery.prior_frappe_revision,
    frappe_candidate_revision:
      permitPayload.release_manifest.production_candidates.frappe_revision,
    frappe_restored_revision:
      permitPayload.release_manifest.recovery.prior_frappe_revision,
    frappe_provider_readback_digest:
      permitPayload.release_manifest.recovery.prior_frappe_readback_digest,
    service_rollback_digest: sha("service-rollback"),
    health_digest: sha("rollback-health"),
    readiness_digest: sha("rollback-readiness"),
  };
  const rollbackReceipt = {
    ...rollbackFields,
    evidence_digest: sha(canonicalJson(rollbackFields)),
    observed_at: "2026-08-16T20:20:00.000Z",
  };
  let claimRead = false;
  const boundary = {
    async readClaim(input) {
      claimRead = true;
      assert.equal(input.permitDigest, releasePermitDigest(permit));
      return { status: "claimed" };
    },
    async persistReceipt(input) {
      return { status: "persisted", key: input.key, receipt: input.receipt };
    },
  };
  const result = await persistRollbackOutcome(publicKey, permit, {
    boundary,
    mergeReceipt,
    rollbackReceipt,
    now: Date.parse("2026-08-16T20:20:00.000Z"),
  });
  assert.equal(claimRead, true);
  assert.equal(result.receipt.kind, "production_rollback");
  await assert.rejects(
    () =>
      persistRollbackOutcome(publicKey, permit, {
        boundary: {
          ...boundary,
          async readClaim() {
            throw new Error("release_permit_d1_replay_claim_missing");
          },
        },
        mergeReceipt,
        rollbackReceipt,
        now: Date.parse("2026-08-16T20:20:00.000Z"),
      }),
    /release_permit_d1_replay_claim_missing/,
  );
});

test("an admitted migration failure persists an immutable recovery-required outcome without pretending rollback", async () => {
  const { privateKey, publicKey } = keyPair();
  const permitPayload = payload();
  const permit = signReleasePermit(privateKey, permitPayload, { now: NOW });
  const mergeReceipt = sourceMergeReceipt(permit);
  let claimRead = false;
  const boundary = {
    async readClaim(input) {
      claimRead = true;
      assert.equal(input.permitDigest, releasePermitDigest(permit));
      return { status: "claimed" };
    },
    async persistReceipt(input) {
      return { status: "persisted", key: input.key, receipt: input.receipt };
    },
  };
  const result = await persistRecoveryRequiredOutcome(publicKey, permit, {
    boundary,
    mergeReceipt,
    failureStage: "d1_migration_failed",
    now: Date.parse("2026-08-16T20:20:00.000Z"),
  });
  assert.equal(claimRead, true);
  assert.equal(result.receipt.kind, "production_recovery_required");
  assert.equal(result.recovery.migration_state, "unknown_or_partial");
  assert.equal(result.recovery.provider_promotion, "not_started");
  assert.equal(result.recovery.production_d1_recovery_digest, permitPayload.release_manifest.recovery.production_d1_recovery_digest);
  assert.equal(result.recovery.prior_frappe_revision, permitPayload.release_manifest.recovery.prior_frappe_revision);
  const rollbackIncomplete = await persistRecoveryRequiredOutcome(publicKey, permit, {
    boundary,
    mergeReceipt,
    failureStage: "automatic_rollback_incomplete",
    now: Date.parse("2026-08-16T20:20:00.000Z"),
  });
  assert.equal(rollbackIncomplete.recovery.migration_state, "applied");
  assert.equal(rollbackIncomplete.recovery.provider_promotion, "attempted");
  await assert.rejects(() => persistRecoveryRequiredOutcome(publicKey, permit, {
    boundary,
    mergeReceipt,
    failureStage: "rolled_back",
    now: Date.parse("2026-08-16T20:20:00.000Z"),
  }), /release_permit_production_recovery_required_stage_invalid/);
  await assert.rejects(() => persistRecoveryRequiredOutcome(publicKey, permit, {
    boundary: { ...boundary, async readClaim() { throw new Error("release_permit_d1_replay_claim_missing"); } },
    mergeReceipt,
    failureStage: "d1_migration_failed",
    now: Date.parse("2026-08-16T20:20:00.000Z"),
  }), /release_permit_d1_replay_claim_missing/);
});

test("provider version identity is bound to the upload message and full readback", () => {
  const message = releaseVersionMessage({ sourceCommit: COMMIT, sourceTreeSha256: TREE, artifactDigest: ARTIFACT, configDigest: QA_CONFIG });
  assert.equal(parseWranglerVersionId(`Uploaded ironwrap-bus\nWorker Version ID: ${QA_VERSION}\n`), QA_VERSION);
  assert.throws(() => parseWranglerVersionId(`Worker Version ID: ${QA_VERSION}\nWorker Version ID: ${WORKER_VERSION}`), /release_permit_version_id_ambiguous/);
  const expectedManifest = [
    { name: "ASSETS", type: "assets" },
    { name: "CFG_APP", type: "json", value_digest: sha(canonicalJson({ APP_LOCALE: "en-US", APP_TENANT_ID: "ironwrap" })) },
    { name: "DB", type: "d1", resource_id: "f0674848-13df-4422-9896-8ba2719663b8" },
    { name: "FEATURE_ENABLED", type: "plain_text", value_digest: sha("true") },
    { name: "INGEST_TOKEN", type: "secret_text" },
    { name: "JN_QUEUE", type: "queue", resource_name: "ironwrap-jn-push" },
    { name: "RAW", type: "r2_bucket", resource_name: "ironwrap-bus-raw" },
    { name: "SERVICE_ENDPOINT", type: "plain_text", value_digest: sha("https://api.example.invalid") },
  ].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  const runtimeManifest = { compatibility_date: "2026-06-28", compatibility_flags: ["nodejs_compat"] };
  const raw = {
    id: QA_VERSION,
    metadata: { created_on: ISSUED_AT, author_email: "release@example.invalid", source: "wrangler" },
    annotations: { "workers/message": message },
    resources: {
      script: { handlers: ["fetch"] },
      script_runtime: runtimeManifest,
      bindings: [
        { name: "ASSETS", type: "assets" },
        { name: "CFG_APP", type: "json", json: { APP_TENANT_ID: "ironwrap", APP_LOCALE: "en-US" } },
        { name: "DB", type: "d1", id: "f0674848-13df-4422-9896-8ba2719663b8" },
        { name: "FEATURE_ENABLED", type: "plain_text", text: "true" },
        { name: "INGEST_TOKEN", type: "secret_text" },
        { name: "JN_QUEUE", type: "queue", queue_name: "ironwrap-jn-push" },
        { name: "RAW", type: "r2_bucket", bucket_name: "ironwrap-bus-raw" },
        { name: "SERVICE_ENDPOINT", type: "plain_text", text: "https://api.example.invalid" },
      ],
    },
  };
  const receipt = validateWorkerVersionReadback(raw, {
    versionId: QA_VERSION,
    sourceCommit: COMMIT,
    sourceTreeSha256: TREE,
    artifactDigest: ARTIFACT,
    configDigest: QA_CONFIG,
    secretNames: ["INGEST_TOKEN"],
    bindingManifest: expectedManifest,
    runtimeManifest,
  });
  assert.equal(receipt.version_id, QA_VERSION);
  assert.equal(receipt.secret_names[0], "INGEST_TOKEN");
  assert.match(receipt.version_digest, /^[0-9a-f]{64}$/);
  const expected = { versionId: QA_VERSION, sourceCommit: COMMIT, sourceTreeSha256: TREE, artifactDigest: ARTIFACT, configDigest: QA_CONFIG, secretNames: ["INGEST_TOKEN"], bindingManifest: expectedManifest, runtimeManifest };
  const mutateBinding = (name, replacement) => ({ ...raw, resources: { ...raw.resources, bindings: raw.resources.bindings.map((binding) => binding.name === name ? { ...binding, ...replacement } : binding) } });
  assert.throws(() => validateWorkerVersionReadback(mutateBinding("FEATURE_ENABLED", { text: "false" }), expected), /release_permit_version_readback_binding_value_digest_drift/);
  assert.throws(() => validateWorkerVersionReadback(mutateBinding("SERVICE_ENDPOINT", { text: "https://wrong.example.invalid" }), expected), /release_permit_version_readback_binding_value_digest_drift/);
  assert.throws(() => validateWorkerVersionReadback(mutateBinding("DB", { id: undefined }), expected), /release_permit_version_readback_binding_resource_id_missing/);
  assert.throws(() => validateWorkerVersionReadback(mutateBinding("DB", { id: "00000000-0000-4000-8000-000000000000" }), expected), /release_permit_version_readback_binding_resource_id_drift/);
  assert.throws(() => validateWorkerVersionReadback(mutateBinding("RAW", { type: "r2" }), expected), /release_permit_version_readback_binding_manifest_drift/);
  assert.throws(() => validateWorkerVersionReadback(mutateBinding("JN_QUEUE", { queue_name: "wrong-queue" }), expected), /release_permit_version_readback_binding_resource_name_drift/);
  assert.throws(() => validateWorkerVersionReadback(mutateBinding("CFG_APP", { json: { APP_TENANT_ID: "ironwrap", APP_LOCALE: "en-GB" } }), expected), /release_permit_version_readback_binding_value_digest_drift/);
  assert.throws(() => validateWorkerVersionReadback(mutateBinding("CFG_APP", { type: "plain_text", text: JSON.stringify({ APP_TENANT_ID: "ironwrap", APP_LOCALE: "en-US" }) }), expected), /release_permit_version_readback_binding_manifest_drift/);
  assert.throws(() => validateWorkerVersionReadback({ ...raw, resources: { ...raw.resources, bindings: raw.resources.bindings.map((binding) => binding.name === "CFG_APP" ? { name: binding.name, type: binding.type } : binding) } }, expected), /release_permit_version_readback_binding_value_missing/);
  assert.throws(() => validateWorkerVersionReadback({ ...raw, resources: { ...raw.resources, bindings: raw.resources.bindings.filter((binding) => binding.name !== "ASSETS") } }, expected), /release_permit_version_readback_binding_manifest_drift/);
  assert.throws(() => validateWorkerVersionReadback({ ...raw, resources: { ...raw.resources, script_runtime: { ...runtimeManifest, compatibility_flags: [] } } }, expected), /release_permit_version_readback_runtime_drift/);
});

test("secret inventory readback binds names but never accepts secret values", () => {
  const inventory = validateSecretInventoryReadback([
    { name: "ADMIN_TOKEN", type: "secret_text" },
    { name: "INGEST_TOKEN", type: "secret_text" },
  ], ["INGEST_TOKEN", "ADMIN_TOKEN"]);
  assert.equal(inventory.status, "matched");
  assert.match(inventory.secret_inventory_digest, /^[0-9a-f]{64}$/);
  assert.throws(() => validateSecretInventoryReadback([{ name: "ADMIN_TOKEN", value: "secret" }], ["ADMIN_TOKEN"]), /release_permit_secret_inventory_value_exposed/);
  assert.throws(() => validateSecretInventoryReadback([{ name: "ADMIN_TOKEN" }], ["INGEST_TOKEN"]), /release_permit_secret_inventory_drift/);
});

test("independent reviewer GO receipt is signed, source-bound, and independently bounded", () => {
  const { privateKey, publicKey } = keyPair();
  const receipt = signReviewGoReceipt(privateKey, {
    schema: "ironwrap_release_review_v1",
    type: "ironwrap-release-review",
    repository: "Iron-Wrap/ironwrap-os",
    source_commit: COMMIT,
    source_tree_sha256: TREE,
    diff_sha256: DIFF,
    reviewer_principal: "independent-reviewer@example.invalid",
    reviewer_task_id: "codex-review-iro41",
    reviewer_run_id: "review-run-31970000001",
    review_key_version: "review-key-2026-08",
    decision: "GO",
    findings_digest: FINDINGS,
    unresolved_p0: 0,
    unresolved_p1: 0,
    issued_at: ISSUED_AT,
    expires_at: "2026-08-16T21:30:00.000Z",
    nonce: "review0123456789abcdef0123456789abcdef0123456789abcdef",
  }, { now: NOW });
  const verified = verifyReviewGoReceipt(publicKey, receipt, {
    repository: "Iron-Wrap/ironwrap-os",
    source_commit: COMMIT,
    source_tree_sha256: TREE,
    diff_sha256: DIFF,
  }, { now: NOW });
  assert.equal(verified.reviewer_principal, "independent-reviewer@example.invalid");
  assert.throws(() => verifyReviewGoReceipt(publicKey, receipt, { source_commit: BASE }, { now: NOW }), /release_permit_review_source_commit_drift/);
  assert.throws(() => signReviewGoReceipt(privateKey, {
    ...verified,
    expires_at: "2026-08-16T22:00:01.000Z",
  }, { now: NOW }), /release_permit_review_window_invalid/);
});

test("external release evidence is signed, source-addressed, scope-complete, and non-synthetic", () => {
  const { privateKey, publicKey } = keyPair();
  const receipt = signExternalReleaseEvidence(privateKey, externalEvidence(), { now: NOW });
  const verified = verifyExternalReleaseEvidence(publicKey, receipt, {
    repository: "Iron-Wrap/ironwrap-os",
    pr_number: 43,
    source_commit: COMMIT,
    source_git_tree: GIT_TREE,
    artifact_digest: ARTIFACT,
  }, { now: NOW });
  assert.equal(verified.business_evidence.issue_id, "IRO-7");
  assert.equal(verified.affected_scopes.length, 10);
  assert.throws(() => signExternalReleaseEvidence(privateKey, externalEvidence({ business_evidence: { ...externalEvidence().business_evidence, actor_receipt_ref: "" } }), { now: NOW }), /release_permit_release_evidence_actor_receipt_ref_invalid/);
  assert.throws(() => signExternalReleaseEvidence(privateKey, externalEvidence({ affected_scopes: externalEvidence().affected_scopes.filter((scope) => scope.scope !== "shop") }), { now: NOW }), /release_permit_release_evidence_scopes_invalid/);
  const skipped = externalEvidence().affected_scopes.map((scope) => scope.scope === "facet" ? { ...scope, status: "not_applicable", authenticated: false } : scope);
  assert.throws(() => signExternalReleaseEvidence(privateKey, externalEvidence({ affected_scopes: skipped }), { now: NOW }), /release_permit_release_evidence_scope_non_applicability_invalid/);
  const providerSkipped = externalEvidence().affected_scopes.map((scope) => scope.scope === "provider" ? {
    ...scope,
    status: "not_applicable",
    authenticated: false,
    non_applicability_policy_digest: sha("provider-policy"),
    reason_digest: sha("provider-reason"),
  } : scope);
  assert.throws(() => signExternalReleaseEvidence(privateKey, externalEvidence({ affected_scopes: providerSkipped }), { now: NOW }), /release_permit_release_evidence_provider_scope_not_proven/);
});

test("service adapter receipts bind exact Frappe promotion, post-smoke readback, and rollback", () => {
  const { privateKey, publicKey } = keyPair();
  for (const operation of ["promote", "readback", "rollback"]) {
    const payload = serviceAdapterPayload(operation);
    const receipt = signServiceAdapterReceipt(privateKey, payload, {
      now: NOW,
    });
    const verified = verifyServiceAdapterReceipt(
      publicKey,
      receipt,
      {
        operation,
        repository: payload.repository,
        source_commit: payload.source_commit,
        source_git_tree: payload.source_git_tree,
        aggregate_artifact_digest: payload.aggregate_artifact_digest,
        merge_commit: payload.merge_commit,
        "frappe.previous_revision": payload.frappe.previous_revision,
        "frappe.candidate_revision": payload.frappe.candidate_revision,
        "frappe.provider_readback_digest":
          payload.frappe.provider_readback_digest,
        provider_reconciliation_digest: payload.provider_reconciliation_digest,
        issuer_principal: payload.issuer_principal,
        issuer_task_id: payload.issuer_task_id,
        issuer_run_id: payload.issuer_run_id,
        key_version: payload.key_version,
      },
      { now: NOW },
    );
    assert.equal(
      verified.frappe.active_revision,
      operation === "rollback"
        ? payload.frappe.previous_revision
        : payload.frappe.candidate_revision,
    );
  }
  const wrongActive = serviceAdapterPayload("rollback", {
    frappe: {
      ...serviceAdapterPayload("rollback").frappe,
      active_revision:
        serviceAdapterPayload("rollback").frappe.candidate_revision,
    },
  });
  assert.throws(
    () => signServiceAdapterReceipt(privateKey, wrongActive, { now: NOW }),
    /release_permit_service_adapter_frappe_active_drift/,
  );
  const receipt = signServiceAdapterReceipt(
    privateKey,
    serviceAdapterPayload("promote"),
    { now: NOW },
  );
  assert.throws(
    () =>
      verifyServiceAdapterReceipt(
        publicKey,
        receipt,
        { "frappe.candidate_revision": "different-candidate" },
        { now: NOW },
      ),
    /release_permit_service_adapter_frappe_candidate_revision_drift/,
  );
});

test("full release manifest rejects missing component, recovery, and provider identities", () => {
  const manifest = releaseManifest();
  assert.equal(validateReleasePermitPayload(payload(), { now: NOW }).release_manifest.pr.number, 43);
  assert.throws(() => validateReleasePermitPayload(payload({ release_manifest: { ...manifest, artifacts: { ...manifest.artifacts, pwa_digest: undefined } } }), { now: NOW }), /release_permit_release_manifest_artifact_digest_invalid/);
  assert.throws(() => validateReleasePermitPayload(payload({ release_manifest: { ...manifest, recovery: { ...manifest.recovery, prior_frappe_revision: "" } } }), { now: NOW }), /release_permit_release_manifest_prior_frappe_invalid/);
  assert.throws(() => validateReleasePermitPayload(payload({ release_manifest: { ...manifest, provider_reconciliation: { ...manifest.provider_reconciliation, status: "pending" } } }), { now: NOW }), /release_permit_release_manifest_provider_not_matched/);
  assert.throws(() => validateReleasePermitPayload(payload({ release_manifest: {
    ...manifest,
    production_candidates: {
      ...manifest.production_candidates,
      domain_zone_id: "z".repeat(32),
    },
  } }), { now: NOW }), /release_permit_release_manifest_production_domain_zone_invalid/);
});

test("source admission merge receipt binds the exact PR, permit, and tested tree", () => {
  const { privateKey } = keyPair();
  const permit = signReleasePermit(privateKey, payload(), { now: NOW });
  const receipt = sourceMergeReceipt(permit);
  assert.equal(validateSourceMergeReceipt(receipt, payload(), { now: NOW, permitDigest: releasePermitDigest(permit) }).merge_tree, GIT_TREE);
  assert.throws(() => validateSourceMergeReceipt({ ...receipt, merge_tree: BASE }, payload(), { now: NOW, permitDigest: releasePermitDigest(permit) }), /release_permit_source_merge_tree_drift/);
  assert.throws(() => validateSourceMergeReceipt({ ...receipt, permit_digest: sha("other") }, payload(), { now: NOW, permitDigest: releasePermitDigest(permit) }), /release_permit_source_merge_permit_digest_drift/);
});

test("environment config digests include distinct environment and secret-name contracts", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const qa = await computeEnvironmentConfigDigest({ repoRoot: root, environment: "qa" });
  const production = await computeEnvironmentConfigDigest({ repoRoot: root, environment: "production" });
  assert.notEqual(qa.digest, production.digest);
  assert.deepEqual(qa.secret_names, production.secret_names);
  assert.ok(qa.secret_names.includes("GOOGLE_SERVICE_ACCOUNT_JSON"));
  assert.ok(qa.secret_names.includes("POSTIZ_API_KEY"));
  assert.match(qa.secret_inventory_digest, /^[0-9a-f]{64}$/);
  assert.ok(qa.binding_manifest.some((entry) => entry.name === "RAW" && entry.type === "r2_bucket" && entry.resource_name === "ironwrap-bus-qa-raw"));
  // IRO-268: workers-bus/wrangler.jsonc groups every non-secret var into a CFG_* JSON binding, so
  // the real binding manifest carries "json" entries here, not "plain_text" ones.
  assert.ok(qa.binding_manifest.some((entry) => entry.type === "json" && entry.name.startsWith("CFG_") && /^[0-9a-f]{64}$/.test(entry.value_digest)));
  assert.equal(qa.runtime_manifest.compatibility_date, "2026-06-28");
});

test("environment-specific vars do not erase a secret from the other environment inventory", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ironwrap-release-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "workers-bus", "src"), { recursive: true });
  await writeFile(path.join(root, "workers-bus", "wrangler.jsonc"), JSON.stringify({
    compatibility_date: "2026-06-28",
    compatibility_flags: [],
    vars: { ALWAYS_PLAIN: "base" },
    env: { qa: { vars: { QA_PLAIN: "qa" } }, production: { vars: { PRODUCTION_PLAIN: "production" } } },
  }));
  await writeFile(path.join(root, "workers-bus", "src", "secret-bindings.d.ts"), "interface Env {\n  ALWAYS_PLAIN: string;\n  QA_PLAIN: string;\n  PRODUCTION_PLAIN: string;\n  REAL_SECRET: string;\n}\n");
  const qa = await computeEnvironmentConfigDigest({ repoRoot: root, environment: "qa" });
  const production = await computeEnvironmentConfigDigest({ repoRoot: root, environment: "production" });
  assert.ok(!qa.secret_names.includes("QA_PLAIN"));
  assert.ok(qa.secret_names.includes("PRODUCTION_PLAIN"));
  assert.ok(production.secret_names.includes("QA_PLAIN"));
  assert.ok(!production.secret_names.includes("PRODUCTION_PLAIN"));
  assert.ok(qa.binding_manifest.some((entry) => entry.name === "QA_PLAIN" && entry.type === "plain_text"));
});

test("environment config digests read a CFG_* grouped config the same as a flat one (IRO-268)", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ironwrap-release-config-grouped-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "workers-bus", "src"), { recursive: true });
  await writeFile(path.join(root, "workers-bus", "wrangler.jsonc"), JSON.stringify({
    compatibility_date: "2026-06-28",
    compatibility_flags: [],
    vars: { CFG_CORE: { ALWAYS_PLAIN: "base" } },
    env: {
      qa: { vars: { CFG_CORE: { ALWAYS_PLAIN: "base" }, QA_PLAIN: "qa" } },
      production: { vars: { CFG_CORE: { ALWAYS_PLAIN: "base" }, PRODUCTION_PLAIN: "production" } },
    },
  }));
  await writeFile(path.join(root, "workers-bus", "src", "secret-bindings.d.ts"), "interface Env {\n  ALWAYS_PLAIN: string;\n  QA_PLAIN: string;\n  PRODUCTION_PLAIN: string;\n  REAL_SECRET: string;\n}\n");
  const qa = await computeEnvironmentConfigDigest({ repoRoot: root, environment: "qa" });
  const production = await computeEnvironmentConfigDigest({ repoRoot: root, environment: "production" });
  // Finding 1 (secret-inventory drift): a var that only exists inside a CFG_* group must still
  // be excluded from the secret inventory, exactly like a flat one.
  assert.ok(!qa.secret_names.includes("ALWAYS_PLAIN"));
  assert.ok(!qa.secret_names.includes("QA_PLAIN"));
  assert.ok(qa.secret_names.includes("PRODUCTION_PLAIN"));
  // Finding 2 (digest collapse): the vars digest must see the real string value, never the
  // "[object Object]" that String() on the CFG_CORE group itself would produce.
  const groupedEntry = qa.binding_manifest.find((entry) => entry.name === "CFG_CORE");
  assert.ok(groupedEntry, "the CFG_CORE binding must appear in the binding manifest");
  assert.equal(groupedEntry.type, "json");
  assert.notEqual(qa.digest, production.digest);
});

test("release environment preflight fails before mutation on var, notification, OCR, or secret drift", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ironwrap-release-preflight-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "workers-bus", "src"), { recursive: true });
  const vars = {
    ADMIN_LABEL: "configured",
    BACKUP_ALERT_EMAIL: "backup@example.invalid",
    FROM_EMAIL: "sender@example.invalid",
    MEASUREMENT_OCR_ENABLED: "true",
    MEASUREMENT_OCR_MODEL: "claude-opus-5-5",
    OWNER_ALERT_EMAIL: "owner@example.invalid",
  };
  const writeConfig = async (environmentVars) => writeFile(path.join(root, "workers-bus", "wrangler.jsonc"), JSON.stringify({
    compatibility_date: "2026-06-28",
    compatibility_flags: ["nodejs_compat"],
    vars,
    env: { qa: { vars: environmentVars } },
  }));
  await writeFile(path.join(root, "workers-bus", "src", "secret-bindings.d.ts"), "interface Env {\n  ADMIN_TOKEN: string;\n  GOOGLE_SERVICE_ACCOUNT_JSON: string;\n  INGEST_TOKEN: string;\n  MEASUREMENT_OCR_API_KEY: string;\n}\n");
  await writeConfig({ ...vars });
  const names = ["ADMIN_TOKEN", "GOOGLE_SERVICE_ACCOUNT_JSON", "INGEST_TOKEN", "MEASUREMENT_OCR_API_KEY"];
  assert.equal((await validateReleaseEnvironmentPreflight({ repoRoot: root, environment: "qa", secretNames: names })).status, "matched");
  const missingVar = { ...vars };
  delete missingVar.ADMIN_LABEL;
  await writeConfig(missingVar);
  await assert.rejects(() => validateReleaseEnvironmentPreflight({ repoRoot: root, environment: "qa", secretNames: names }), /release_permit_environment_preflight_var_inventory_drift/);
  await writeConfig({ ...vars, FROM_EMAIL: "" });
  await assert.rejects(() => validateReleaseEnvironmentPreflight({ repoRoot: root, environment: "qa", secretNames: names }), /release_permit_environment_preflight_notification_config_missing/);
  await writeConfig({ ...vars, MEASUREMENT_OCR_MODEL: "unreviewed-model" });
  await assert.rejects(() => validateReleaseEnvironmentPreflight({ repoRoot: root, environment: "qa", secretNames: names }), /release_permit_environment_preflight_ocr_model_invalid/);
  await writeConfig({ ...vars });
  await assert.rejects(() => validateReleaseEnvironmentPreflight({ repoRoot: root, environment: "qa", secretNames: names.filter((name) => name !== "MEASUREMENT_OCR_API_KEY") }), /release_permit_environment_preflight_required_secret_missing/);
});

test("release environment preflight reads a CFG_* grouped config the same as a flat one (IRO-268 R1.1)", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ironwrap-release-preflight-grouped-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "workers-bus", "src"), { recursive: true });
  const groupedVars = {
    CFG_CORE: {
      ADMIN_LABEL: "configured",
      BACKUP_ALERT_EMAIL: "backup@example.invalid",
      FROM_EMAIL: "sender@example.invalid",
      OWNER_ALERT_EMAIL: "owner@example.invalid",
    },
    CFG_MEASUREMENT: {
      MEASUREMENT_OCR_ENABLED: "true",
      MEASUREMENT_OCR_MODEL: "claude-opus-5-5",
    },
  };
  const writeConfig = async (environmentVars) => writeFile(path.join(root, "workers-bus", "wrangler.jsonc"), JSON.stringify({
    compatibility_date: "2026-06-28",
    compatibility_flags: ["nodejs_compat"],
    vars: groupedVars,
    env: { qa: { vars: environmentVars } },
  }));
  await writeFile(path.join(root, "workers-bus", "src", "secret-bindings.d.ts"), "interface Env {\n  ADMIN_TOKEN: string;\n  GOOGLE_SERVICE_ACCOUNT_JSON: string;\n  INGEST_TOKEN: string;\n  MEASUREMENT_OCR_API_KEY: string;\n}\n");
  await writeConfig(structuredClone(groupedVars));
  const names = ["ADMIN_TOKEN", "GOOGLE_SERVICE_ACCOUNT_JSON", "INGEST_TOKEN", "MEASUREMENT_OCR_API_KEY"];
  assert.equal((await validateReleaseEnvironmentPreflight({ repoRoot: root, environment: "qa", secretNames: names })).status, "matched");
  // Drift from inside a group: the top-level and env.qa group-name sets stay equal
  // (both have CFG_CORE, CFG_MEASUREMENT), which is exactly the merge-vs-replace disagreement
  // between effectiveEnvironmentConfig (merges) and wrangler (replaces) the check must catch.
  const missingVar = structuredClone(groupedVars);
  delete missingVar.CFG_CORE.ADMIN_LABEL;
  await writeConfig(missingVar);
  await assert.rejects(() => validateReleaseEnvironmentPreflight({ repoRoot: root, environment: "qa", secretNames: names }), /release_permit_environment_preflight_var_inventory_drift/);
  const blankFromEmail = structuredClone(groupedVars);
  blankFromEmail.CFG_CORE.FROM_EMAIL = "";
  await writeConfig(blankFromEmail);
  await assert.rejects(() => validateReleaseEnvironmentPreflight({ repoRoot: root, environment: "qa", secretNames: names }), /release_permit_environment_preflight_notification_config_missing/);
  // The silent half: a bad OCR model inside CFG_MEASUREMENT must still be caught, not disappear
  // behind String(group) === "[object Object]".
  const badOcrModel = structuredClone(groupedVars);
  badOcrModel.CFG_MEASUREMENT.MEASUREMENT_OCR_MODEL = "unreviewed-model";
  await writeConfig(badOcrModel);
  await assert.rejects(() => validateReleaseEnvironmentPreflight({ repoRoot: root, environment: "qa", secretNames: names }), /release_permit_environment_preflight_ocr_model_invalid/);
  await writeConfig(structuredClone(groupedVars));
  await assert.rejects(() => validateReleaseEnvironmentPreflight({ repoRoot: root, environment: "qa", secretNames: names.filter((name) => name !== "MEASUREMENT_OCR_API_KEY") }), /release_permit_environment_preflight_required_secret_missing/);
});

test("the OCR model allowlist is one list shared by the Worker, its config, and the preflight", async () => {
  const worker = await readFile(new URL("../workers-bus/src/measurements.ts", import.meta.url), "utf8");
  const literal = /ALLOWED_MEASUREMENT_OCR_MODELS = new Set\(\[([^\]]*)\]\)/.exec(worker);
  assert.ok(literal, "workers-bus/src/measurements.ts must declare ALLOWED_MEASUREMENT_OCR_MODELS");
  const workerModels = [...literal[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...workerModels].sort(), [...MEASUREMENT_OCR_MODELS].sort());
  assert.ok(MEASUREMENT_OCR_MODELS.includes("claude-opus-5-5"));
  const wrangler = await readFile(new URL("../workers-bus/wrangler.jsonc", import.meta.url), "utf8");
  const pinned = [...wrangler.matchAll(/"MEASUREMENT_OCR_MODEL":\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(pinned.length > 0, "wrangler.jsonc must pin MEASUREMENT_OCR_MODEL");
  for (const model of pinned) assert.ok(MEASUREMENT_OCR_MODELS.includes(model), `${model} is not an allowed OCR model`);
});

test("generation-N provider policy rejects candidate account and resource substitution", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ironwrap-provider-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidateRoot = path.join(root, "candidate");
  const policyRoot = path.join(root, "policy");
  await mkdir(path.join(candidateRoot, "workers-bus"), { recursive: true });
  await mkdir(path.join(policyRoot, "deploy"), { recursive: true });
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const config = await readFile(path.join(repoRoot, "workers-bus", "wrangler.jsonc"), "utf8");
  const policy = await readFile(path.join(repoRoot, "deploy", "release-provider-policy.json"), "utf8");
  await writeFile(path.join(candidateRoot, "workers-bus", "wrangler.jsonc"), config);
  await writeFile(path.join(policyRoot, "deploy", "release-provider-policy.json"), policy);
  assert.equal((await validateProviderTargetPolicy({ candidateRoot, policyRoot, environment: "qa" })).status, "matched");
  assert.equal((await validateProviderTargetPolicy({ candidateRoot, policyRoot, environment: "production" })).status, "matched");
  await writeFile(path.join(candidateRoot, "workers-bus", "wrangler.jsonc"), config.replace('  "workers_dev": false,\n', ""));
  await assert.rejects(() => validateProviderTargetPolicy({ candidateRoot, policyRoot, environment: "production" }), /release_permit_provider_target_policy_drift/);
  await writeFile(path.join(candidateRoot, "workers-bus", "wrangler.jsonc"), config.replace("ironwrap-bus.ironwrapexteriors.com", "unreviewed.ironwrapexteriors.com"));
  await assert.rejects(() => validateProviderTargetPolicy({ candidateRoot, policyRoot, environment: "production" }), /release_permit_provider_target_policy_drift/);
  await writeFile(path.join(candidateRoot, "workers-bus", "wrangler.jsonc"), config.replace('"compatibility_date": "2026-06-28"', '"build": { "command": "node malicious.js" },\n  "compatibility_date": "2026-06-28"'));
  await assert.rejects(() => validateProviderTargetPolicy({ candidateRoot, policyRoot, environment: "production" }), /release_permit_provider_target_custom_build_forbidden/);
  await writeFile(path.join(candidateRoot, "workers-bus", "wrangler.jsonc"), config.replace('"qa": {', '"qa": { "build": { "command": "node env-malicious.js" },'));
  await assert.rejects(() => validateProviderTargetPolicy({ candidateRoot, policyRoot, environment: "qa" }), /release_permit_provider_target_custom_build_forbidden/);
  for (const directive of [
    '"base_dir": "/",',
    '"data_blobs": { "LEAK": "/proc/self/environ" },',
    '"find_additional_modules": true,',
    '"pages_build_output_dir": "/",',
    '"python_modules": { "LEAK": "/proc/self/environ" },',
    '"rules": [{ "type": "Text", "globs": ["**/*"] }],',
    '"site": { "bucket": "/" },',
    '"text_blobs": { "LEAK": "/proc/self/environ" },',
    '"wasm_modules": { "LEAK": "/proc/self/environ" },',
  ]) {
    await writeFile(path.join(candidateRoot, "workers-bus", "wrangler.jsonc"), config.replace('"compatibility_date": "2026-06-28"', `${directive}\n  "compatibility_date": "2026-06-28"`));
    await assert.rejects(() => validateProviderTargetPolicy({ candidateRoot, policyRoot, environment: "production" }), /release_permit_provider_target_local_input_forbidden/);
  }
  for (const binding of [
    '"browser": { "binding": "BROWSER" },',
    '"services": [{ "binding": "ESCAPE", "service": "unreviewed-worker" }],',
  ]) {
    await writeFile(path.join(candidateRoot, "workers-bus", "wrangler.jsonc"), config.replace('"compatibility_date": "2026-06-28"', `${binding}\n  "compatibility_date": "2026-06-28"`));
    await assert.rejects(() => validateProviderTargetPolicy({ candidateRoot, policyRoot, environment: "production" }), /release_permit_provider_target_unallowlisted_config/);
  }
  await writeFile(path.join(candidateRoot, "workers-bus", "wrangler.jsonc"), config.replace("0339cebc-d252-4d67-b78b-58c8b4703c6e", "f0674848-13df-4422-9896-8ba2719663b8"));
  await assert.rejects(() => validateProviderTargetPolicy({ candidateRoot, policyRoot, environment: "qa" }), /release_permit_provider_target_policy_drift/);
  await writeFile(path.join(candidateRoot, "workers-bus", "wrangler.jsonc"), config.replace('"account_id": "7ee5775bc1ba46f05c5a65235b60e939"', '"account_id": "00000000000000000000000000000000"'));
  await assert.rejects(() => validateProviderTargetPolicy({ candidateRoot, policyRoot, environment: "production" }), /release_permit_provider_target_policy_drift/);
});

test("source evidence binds a pristine checkout's commit, tree, and binary diff", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ironwrap-release-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "nested"), { recursive: true });
  await run("git", ["-C", root, "init", "-q"]);
  await run("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  await run("git", ["-C", root, "config", "user.name", "Release Test"]);
  await writeFile(path.join(root, "nested", "source.bin"), Buffer.from([0, 1, 2]));
  await run("git", ["-C", root, "add", "."]);
  await run("git", ["-C", root, "commit", "-qm", "base"]);
  const base = (await run("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
  await writeFile(path.join(root, "nested", "source.bin"), Buffer.from([0, 1, 3]));
  await writeFile(path.join(root, "new.txt"), "new\n");
  await run("git", ["-C", root, "add", "."]);
  await run("git", ["-C", root, "commit", "-qm", "candidate"]);
  const evidence = await computeSourceEvidence({ repoRoot: root, sourceCommit: "HEAD", baseCommit: base });
  assert.match(evidence.source_commit, /^[0-9a-f]{40}$/);
  assert.match(evidence.base_commit, /^[0-9a-f]{40}$/);
  assert.match(evidence.source_git_tree, /^[0-9a-f]{40}$/);
  assert.match(evidence.source_tree_sha256, /^[0-9a-f]{64}$/);
  assert.match(evidence.diff_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(evidence.component_digests).sort(), ["frappe", "hermes", "mcp", "pwa", "tenant_config", "worker"]);
  assert.equal(evidence.worktree_clean, true);
});

test("supply-chain evidence is deterministic and bound to exact release-source CI", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ironwrap-release-supply-chain-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "app"), { recursive: true });
  await mkdir(path.join(root, "frappe"), { recursive: true });
  await run("git", ["-C", root, "init", "-q"]);
  await run("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  await run("git", ["-C", root, "config", "user.name", "Release Test"]);
  await writeFile(path.join(root, "app", "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "app", version: "1.0.0", license: "MIT" }, "node_modules/a": { name: "a", version: "1.0.0", integrity: "sha512-test", license: "Apache-2.0" } } }));
  await writeFile(path.join(root, "frappe", "pyproject.toml"), "[project]\nname='frappe-test'\nversion='1.0.0'\n");
  await run("git", ["-C", root, "add", "."]);
  await run("git", ["-C", root, "commit", "-qm", "source"]);
  const source = (await run("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
  const checks = [{ check_id: "check-1", run_id: "run-2", job_name: "validate-and-test", conclusion: "success", repository: "Iron-Wrap/ironwrap-os", head_sha: source, workflow_id: 3, workflow_path: ".github/workflows/ci.yml", event: "pull_request", status: "completed", run_attempt: 1 }];
  const first = await computeSupplyChainEvidence({ repoRoot: root, sourceCommit: source, ciChecks: checks });
  assert.deepEqual(await computeSupplyChainEvidence({ repoRoot: root, sourceCommit: source, ciChecks: checks }), first);
  assert.equal(first.result, "passed");
  // Both release sources are admissible: the PR's own CI run, and the
  // push-to-main run that validated the merged tree.
  assert.equal((await computeSupplyChainEvidence({ repoRoot: root, sourceCommit: source, ciChecks: [{ ...checks[0], event: "push" }] })).result, "passed");
  for (const event of ["workflow_dispatch", "schedule", "workflow_run", ""]) {
    await assert.rejects(() => computeSupplyChainEvidence({ repoRoot: root, sourceCommit: source, ciChecks: [{ ...checks[0], event }] }), /release_permit_ci_event_invalid/, event);
  }
});

test("migration inventory is ordered and expand-contract only", async () => {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const migrations = await computeMigrationSet({ repoRoot });
  const contract = await loadCapabilityContract(repoRoot);
  assert.equal(migrations.compatibility, "expand-contract");
  assert.equal(migrations.no_down_migrations, true);
  assert.deepEqual(migrations.ordered, [...migrations.ordered].sort());
  assert.equal(migrations.ordered.length, contract.expected.d1_migrations.count);
  assert.equal(migrations.ordered.at(-1), contract.expected.d1_migrations.latest);
});

test("the permit lifetime remains bounded by the source contract", () => {
  assert.equal(MAX_PERMIT_LIFETIME_MS, 900_000);
});
