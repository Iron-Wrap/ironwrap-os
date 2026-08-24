#!/usr/bin/env node

/**
 * Zero-dependency release orchestration helpers.
 *
 * The workflow supplies provider credentials and ephemeral evidence paths; this
 * module owns parsing, digesting, receipt assembly, and permit admission. It
 * never prints credential values or raw provider responses.
 */
import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  admitReleasePermit,
  advanceReleaseGeneration,
  computeEnvironmentConfigDigest,
  computeMigrationSet,
  computeReleaseConfigDigest,
  computeSourceEvidence,
  computeSupplyChainEvidence,
  validateProviderTargetPolicy,
  validateReleaseEnvironmentPreflight,
  createCloudflareD1ReplayBoundary,
  CI_WORKFLOW_PATH,
  LAUNCH_PROOF_STEP_NAMES,
  PRODUCTION_PROMOTION_SCHEMA,
  PRODUCTION_PROMOTION_TYPE,
  RELEASE_EVIDENCE_PATH_PREFIX,
  RELEASE_EVIDENCE_REF_PREFIX,
  RELEASE_MANIFEST_SCHEMA,
  REVIEW_FINDINGS_SCHEMA,
  REVIEW_RECEIPT_PATH_PREFIX,
  REVIEW_RECEIPT_REF_PREFIX,
  parseWranglerVersionId,
  persistRecoveryRequiredOutcome,
  persistRollbackOutcome,
  releasePermitDigest,
  releaseVersionMessage,
  signReviewGoReceipt,
  signReleasePermit,
  signExternalReleaseEvidence,
  signServiceAdapterReceipt,
  validateSecretInventoryReadback,
  validateProductionPromotionReceipt,
  validateSourceMergeReceipt,
  validateWorkerVersionReadback,
  verifyReviewGoReceipt,
  verifyExternalReleaseEvidence,
  verifyServiceAdapterReceipt,
  verifyReleasePermit,
} from "./release-permit.mjs";

import { canonicalJson } from "../mcp/erpnext-roofing-mcp/src/approval-contract.mjs";

const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTITY_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ACCOUNT_RE = /^[0-9a-f]{32}$/;
const INDEPENDENT_ISSUER_ROUTE = "/v2/independent-issuer";
const INDEPENDENT_ISSUER_REQUEST_SCHEMA =
  "ironwrap_independent_issuer_request_v2";
const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const INDEPENDENT_ISSUER_MAX_LIFETIME_MS = 10 * 60_000;
const INDEPENDENT_ISSUER_MAX_FUTURE_SKEW_MS = 60_000;
const INDEPENDENT_ISSUER_REQUEST_LIFETIME_MS = 5 * 60_000;

function fail(code) {
  throw new Error(`release_promotion_${code}`);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireString(value, code) {
  if (typeof value !== "string" || value.trim() === "") fail(code);
  return value.trim();
}

function requireHash(value, code) {
  if (!SHA256_RE.test(value)) fail(code);
  return value;
}

function requireCommit(value, code) {
  if (!COMMIT_RE.test(value)) fail(code);
  return value;
}

function requireUuid(value, code) {
  if (!UUID_RE.test(value)) fail(code);
  return value;
}

function requireCanonicalTimestamp(value, code) {
  if (typeof value !== "string" || !ISO_TIMESTAMP_RE.test(value)) fail(code);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail(code);
  }
  return milliseconds;
}

function validateIndependentIssuerFreshness(request, now = Date.now) {
  const requestedAt = requireCanonicalTimestamp(
    request.requested_at,
    "issuer_requested_at_invalid",
  );
  const expiresAt = requireCanonicalTimestamp(
    request.expires_at,
    "issuer_expires_at_invalid",
  );
  const currentTime = now();
  if (!Number.isFinite(currentTime)) fail("issuer_clock_invalid");
  if (expiresAt <= requestedAt) fail("issuer_request_time_order_invalid");
  if (expiresAt - requestedAt > INDEPENDENT_ISSUER_MAX_LIFETIME_MS) {
    fail("issuer_request_lifetime_invalid");
  }
  if (requestedAt > currentTime + INDEPENDENT_ISSUER_MAX_FUTURE_SKEW_MS) {
    fail("issuer_request_future_invalid");
  }
  if (expiresAt <= currentTime) fail("issuer_request_expired");
}

function json(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value;
}

function exactObjectKeys(value, expected, code) {
  json(value, code);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) fail(code);
  return value;
}

async function readJson(file, code = "json_invalid") {
  try {
    return json(JSON.parse(await readFile(file, "utf8")), code);
  } catch (error) {
    if (error?.message?.startsWith("release_promotion_")) throw error;
    fail(code);
  }
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function env(name) {
  return requireString(process.env[name], `${name.toLowerCase()}_missing`);
}

function argsFrom(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key.startsWith("--")) fail("cli_usage");
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`cli_${key.slice(2)}_required`);
    args.set(key.slice(2), value);
  }
  return args;
}

function arg(args, name) {
  return requireString(args.get(name), `cli_${name}_required`);
}

function hasArg(args, name) {
  const value = args.get(name);
  return typeof value === "string" && value.trim().length > 0;
}

async function collectCiChecks(args) {
  const repository = arg(args, "repository");
  if (!REPOSITORY_RE.test(repository)) fail("repository_invalid");
  const runId = arg(args, "run-id");
  const token = env("GH_TOKEN");
  const expectedNames = arg(args, "job-names").split(",").map((name) => requireString(name, "ci_job_name_invalid")).sort();
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
  };
  const runResponse = await fetch(`https://api.github.com/repos/${repository}/actions/runs/${encodeURIComponent(runId)}`, {
    headers,
  }).catch(() => null);
  if (!runResponse?.ok) fail("ci_run_readback_unavailable");
  const run = await runResponse.json().catch(() => null);
  if (!run || String(run.id) !== runId || !isRecord(run.repository) || run.repository.full_name !== repository || run.head_repository?.full_name !== repository) fail("ci_run_identity_invalid");
  // The same two source events admission accepts, and no others: a
  // pull_request-sourced CI run, or a push-sourced one pinned to main. Any other
  // push - a release branch, a tag build - is not a release source.
  const sourceEventAdmissible = run.event === "pull_request" || (run.event === "push" && run.head_branch === "main");
  if (!COMMIT_RE.test(run.head_sha) || run.path !== CI_WORKFLOW_PATH || !sourceEventAdmissible || run.status !== "completed" || run.conclusion !== "success" || !Number.isSafeInteger(run.workflow_id) || run.workflow_id < 1 || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) fail("ci_run_contract_invalid");
  const response = await fetch(`https://api.github.com/repos/${repository}/actions/runs/${encodeURIComponent(runId)}/jobs?per_page=100`, {
    headers,
  }).catch(() => null);
  if (!response?.ok) fail("ci_readback_unavailable");
  const body = await response.json().catch(() => null);
  if (!body || !Array.isArray(body.jobs)) fail("ci_readback_invalid");
  const checks = expectedNames.map((jobName) => {
    const matches = body.jobs.filter((job) => job.name === jobName && String(job.run_id) === runId);
    if (matches.length !== 1 || matches[0].conclusion !== "success" || !Number.isSafeInteger(matches[0].id)) fail("ci_check_not_success");
    return {
      check_id: String(matches[0].id),
      run_id: runId,
      job_name: jobName,
      conclusion: "success",
      repository,
      head_sha: run.head_sha,
      workflow_id: run.workflow_id,
      workflow_path: run.path,
      event: run.event,
      status: run.status,
      run_attempt: run.run_attempt,
    };
  });
  await writeJson(arg(args, "output"), checks);
}

async function githubJson(url, headers, code, fetchImpl = fetch) {
  const response = await fetchImpl(url, { headers }).catch(() => null);
  if (!response?.ok) fail(code);
  const body = await response.json().catch(() => null);
  if (!isRecord(body)) fail(code);
  return body;
}

async function githubList(url, headers, code, fetchImpl = fetch) {
  const response = await fetchImpl(url, { headers }).catch(() => null);
  if (!response?.ok) fail(code);
  const body = await response.json().catch(() => null);
  if (!Array.isArray(body)) fail(code);
  return body;
}

function validateMergePolicy(policy, code = "merge_policy_invalid") {
  exactObjectKeys(policy, ["schema", "method", "repository_settings", "ruleset", "readback_digest"], code);
  exactObjectKeys(policy.repository_settings, ["default_branch", "allow_merge_commit", "allow_squash_merge", "allow_rebase_merge"], code);
  exactObjectKeys(policy.ruleset, ["id", "target", "enforcement", "allowed_merge_methods"], code);
  if (policy.schema !== "ironwrap_github_merge_policy_v1"
    || policy.method !== "squash"
    || policy.repository_settings.default_branch !== "main"
    || policy.repository_settings.allow_merge_commit !== false
    || policy.repository_settings.allow_squash_merge !== true
    || policy.repository_settings.allow_rebase_merge !== true
    || !Number.isSafeInteger(policy.ruleset.id)
    || policy.ruleset.id < 1
    || policy.ruleset.target !== "branch"
    || policy.ruleset.enforcement !== "active"
    || canonicalJson(policy.ruleset.allowed_merge_methods) !== canonicalJson(["rebase", "squash"])
    || !SHA256_RE.test(policy.readback_digest)) fail(code);
  const fields = { ...policy };
  delete fields.readback_digest;
  if (sha256(canonicalJson(fields)) !== policy.readback_digest) fail(code);
  return policy;
}

async function readMergePolicy(repository, headers, rulesetId, fetchImpl = fetch) {
  const id = boundedInteger(String(rulesetId), { minimum: 1, maximum: Number.MAX_SAFE_INTEGER, code: "merge_ruleset_id_invalid" });
  const repo = await githubJson(`https://api.github.com/repos/${repository}`, headers, "merge_repository_settings_unavailable", fetchImpl);
  const ruleset = await githubJson(`https://api.github.com/repos/${repository}/rulesets/${id}`, headers, "merge_ruleset_unavailable", fetchImpl);
  const pullRequestRules = Array.isArray(ruleset.rules) ? ruleset.rules.filter((rule) => rule?.type === "pull_request") : [];
  if (repo.full_name !== repository
    || ruleset.id !== id
    || pullRequestRules.length !== 1
    || !Array.isArray(pullRequestRules[0]?.parameters?.allowed_merge_methods)) fail("merge_provider_policy_invalid");
  const fields = {
    schema: "ironwrap_github_merge_policy_v1",
    method: "squash",
    repository_settings: {
      default_branch: repo.default_branch,
      allow_merge_commit: repo.allow_merge_commit,
      allow_squash_merge: repo.allow_squash_merge,
      allow_rebase_merge: repo.allow_rebase_merge,
    },
    ruleset: {
      id: ruleset.id,
      target: ruleset.target,
      enforcement: ruleset.enforcement,
      allowed_merge_methods: [...pullRequestRules[0].parameters.allowed_merge_methods].sort(),
    },
  };
  return validateMergePolicy({ ...fields, readback_digest: sha256(canonicalJson(fields)) });
}

export async function assertMergePolicyUnchanged({ repository, expected, token, fetchImpl = fetch } = {}) {
  if (!REPOSITORY_RE.test(repository)) fail("repository_invalid");
  const validated = validateMergePolicy(expected, "merge_expected_policy_invalid");
  const live = await readMergePolicy(repository, reviewHeaders(requireString(token, "merge_token_missing")), validated.ruleset.id, fetchImpl);
  if (canonicalJson(live) !== canonicalJson(validated)) fail("merge_provider_policy_drift");
  return live;
}

async function prContext(args) {
  const repository = arg(args, "repository");
  const runId = arg(args, "run-id");
  if (!REPOSITORY_RE.test(repository)) fail("repository_invalid");
  const headers = reviewHeaders(env("GH_TOKEN"));
  const run = await githubJson(`https://api.github.com/repos/${repository}/actions/runs/${encodeURIComponent(runId)}`, headers, "pr_run_readback_unavailable");
  if (String(run.id) !== runId
    || run.event !== "pull_request"
    || run.path !== CI_WORKFLOW_PATH
    || run.status !== "completed"
    || run.conclusion !== "success"
    || run.repository?.full_name !== repository
    || run.head_repository?.full_name !== repository
    || !Array.isArray(run.pull_requests)
    || run.pull_requests.length !== 1
    || !Number.isSafeInteger(run.pull_requests[0]?.number)) fail("pr_run_identity_invalid");
  const number = run.pull_requests[0].number;
  const pr = await githubJson(`https://api.github.com/repos/${repository}/pulls/${number}`, headers, "pr_readback_unavailable");
  if (pr.number !== number
    || pr.state !== "open"
    || pr.base?.ref !== "main"
    || pr.base?.repo?.full_name !== repository
    || pr.head?.repo?.full_name !== repository
    || !COMMIT_RE.test(pr.base?.sha)
    || !COMMIT_RE.test(pr.head?.sha)
    || typeof pr.head?.ref !== "string"
    || !COMMIT_RE.test(pr.merge_commit_sha)
    || pr.merge_commit_sha !== run.head_sha
    || pr.mergeable !== true
    || pr.mergeable_state !== "clean") fail("pr_contract_invalid");
  const mergeCommit = await githubJson(`https://api.github.com/repos/${repository}/git/commits/${run.head_sha}`, headers, "pr_merge_commit_unavailable");
  const currentMain = await githubJson(`https://api.github.com/repos/${repository}/commits/main`, headers, "pr_main_readback_unavailable");
  if (mergeCommit.sha !== run.head_sha || !COMMIT_RE.test(mergeCommit.tree?.sha) || currentMain.sha !== pr.base.sha) fail("pr_base_or_tree_drift");
  const mergePolicy = await readMergePolicy(repository, headers, arg(args, "ruleset-id"));
  const fields = {
    schema: "ironwrap_pr_admission_v1",
    repository,
    number,
    base_ref: "main",
    base_commit: pr.base.sha,
    head_ref: pr.head.ref,
    head_commit: pr.head.sha,
    ci_run_id: runId,
    ci_merge_commit: run.head_sha,
    ci_merge_tree: mergeCommit.tree.sha,
    merge_method: "squash",
    merge_policy: mergePolicy,
    provider_readback_digest: sha256(canonicalJson({
      run: { id: String(run.id), event: run.event, path: run.path, status: run.status, conclusion: run.conclusion, head_sha: run.head_sha, run_attempt: run.run_attempt },
      pr: { number: pr.number, state: pr.state, base: { ref: pr.base.ref, sha: pr.base.sha }, head: { ref: pr.head.ref, sha: pr.head.sha }, merge_commit_sha: pr.merge_commit_sha, mergeable: pr.mergeable, mergeable_state: pr.mergeable_state },
      merge: { sha: mergeCommit.sha, tree: mergeCommit.tree.sha },
      main: { sha: currentMain.sha },
      merge_policy: mergePolicy,
    })),
    status: "open",
  };
  await writeJson(arg(args, "output"), fields);
}

/**
 * Push-sourced admission context.
 *
 * `prContext` above admits a release *before* its merge: the pipeline is the
 * thing that merges the PR. This one admits the same release *after* the merge,
 * from the push-triggered CI run that validated `main`. Every field the release
 * manifest binds is still read back exactly from the provider; only where three
 * of them come from changes:
 *
 *   base_commit      the squash commit's single parent — i.e. `main` immediately
 *                    before this release — not `pr.base.sha`, which lags whenever
 *                    another PR landed while this one was open.
 *   ci_merge_commit  `run.head_sha`, the squash commit itself.
 *   status           "merged" rather than "open".
 *
 * The staleness guard changes shape but not strength. The pull_request path
 * requires `main` to still sit at the PR base (nothing landed since CI); this
 * one requires `main` to still sit at the pushed commit (nothing landed since
 * the merge). A superseded push fails closed rather than promoting a tree that
 * production has already moved past.
 */
async function pushContext(args) {
  const repository = arg(args, "repository");
  const runId = arg(args, "run-id");
  if (!REPOSITORY_RE.test(repository)) fail("repository_invalid");
  const headCommit = requireCommit(arg(args, "head-commit"), "push_head_commit_invalid");
  const claimedBase = requireCommit(arg(args, "base-commit"), "push_base_commit_invalid");
  const headers = reviewHeaders(env("GH_TOKEN"));
  const run = await githubJson(`https://api.github.com/repos/${repository}/actions/runs/${encodeURIComponent(runId)}`, headers, "push_run_readback_unavailable");
  if (String(run.id) !== runId
    || run.event !== "push"
    || run.head_branch !== "main"
    || run.path !== CI_WORKFLOW_PATH
    || run.status !== "completed"
    || run.conclusion !== "success"
    || run.repository?.full_name !== repository
    || run.head_repository?.full_name !== repository
    || run.head_sha !== headCommit) fail("push_run_identity_invalid");
  const mergeCommit = await githubJson(`https://api.github.com/repos/${repository}/git/commits/${headCommit}`, headers, "push_commit_readback_unavailable");
  if (mergeCommit.sha !== headCommit
    || !COMMIT_RE.test(mergeCommit.tree?.sha)
    || !Array.isArray(mergeCommit.parents)
    || mergeCommit.parents.length !== 1
    || mergeCommit.parents[0]?.sha !== claimedBase) fail("push_commit_not_linear_squash");
  const currentMain = await githubJson(`https://api.github.com/repos/${repository}/commits/main`, headers, "push_main_readback_unavailable");
  if (currentMain.sha !== headCommit) fail("push_source_superseded");
  const associated = await githubList(`https://api.github.com/repos/${repository}/commits/${headCommit}/pulls`, headers, "push_pr_association_unavailable");
  const sourcePrs = associated.filter((entry) => isRecord(entry) && entry.merge_commit_sha === headCommit);
  if (sourcePrs.length !== 1 || !Number.isSafeInteger(sourcePrs[0]?.number)) fail("push_pr_association_invalid");
  const number = sourcePrs[0].number;
  const pr = await githubJson(`https://api.github.com/repos/${repository}/pulls/${number}`, headers, "push_pr_readback_unavailable");
  if (pr.number !== number
    || pr.state !== "closed"
    || pr.merged !== true
    || pr.base?.ref !== "main"
    || pr.base?.repo?.full_name !== repository
    || pr.head?.repo?.full_name !== repository
    || !COMMIT_RE.test(pr.base?.sha)
    || !COMMIT_RE.test(pr.head?.sha)
    || typeof pr.head?.ref !== "string"
    || pr.merge_commit_sha !== headCommit) fail("push_pr_contract_invalid");
  const mergePolicy = await readMergePolicy(repository, headers, arg(args, "ruleset-id"));
  const fields = {
    schema: "ironwrap_pr_admission_v1",
    repository,
    number,
    base_ref: "main",
    base_commit: claimedBase,
    head_ref: pr.head.ref,
    head_commit: pr.head.sha,
    ci_run_id: runId,
    ci_merge_commit: headCommit,
    ci_merge_tree: mergeCommit.tree.sha,
    merge_method: "squash",
    merge_policy: mergePolicy,
    provider_readback_digest: sha256(canonicalJson({
      run: { id: String(run.id), event: run.event, path: run.path, status: run.status, conclusion: run.conclusion, head_branch: run.head_branch, head_sha: run.head_sha, run_attempt: run.run_attempt },
      pr: { number: pr.number, state: pr.state, merged: pr.merged, base: { ref: pr.base.ref, sha: pr.base.sha }, head: { ref: pr.head.ref, sha: pr.head.sha }, merge_commit_sha: pr.merge_commit_sha },
      merge: { sha: mergeCommit.sha, tree: mergeCommit.tree.sha, parent: claimedBase },
      main: { sha: currentMain.sha },
      merge_policy: mergePolicy,
    })),
    status: "merged",
  };
  await writeJson(arg(args, "output"), fields);
}

async function configDigest(args) {
  const result = await computeEnvironmentConfigDigest({ repoRoot: arg(args, "repo-root"), environment: arg(args, "environment") });
  await writeJson(arg(args, "output"), result);
}

async function providerTargets(args) {
  const receipt = await validateProviderTargetPolicy({
    candidateRoot: arg(args, "candidate-root"),
    policyRoot: arg(args, "policy-root"),
    environment: arg(args, "environment"),
  });
  await writeJson(arg(args, "output"), receipt);
}

async function sourceEvidence(args) {
  const evidence = await computeSourceEvidence({
    repoRoot: arg(args, "repo-root"),
    sourceCommit: arg(args, "source-commit"),
    baseCommit: arg(args, "base-commit"),
  });
  await writeJson(arg(args, "output"), evidence);
}

function reviewHeaders(token) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
  };
}

async function fetchReviewReceipt(repository, sourceCommit, token) {
  const ref = `${REVIEW_RECEIPT_REF_PREFIX}${sourceCommit}`;
  const relativePath = `${REVIEW_RECEIPT_PATH_PREFIX}${sourceCommit}.json`;
  const response = await fetch(`https://api.github.com/repos/${repository}/contents/${relativePath}?ref=${encodeURIComponent(ref)}`, {
    headers: reviewHeaders(token),
  }).catch(() => null);
  if (response?.status === 404) return null;
  if (!response?.ok) fail("review_receipt_unavailable");
  const body = await response.json().catch(() => null);
  if (!isRecord(body) || body.path !== relativePath || body.name !== `${sourceCommit}.json` || body.encoding !== "base64" || typeof body.content !== "string") fail("review_receipt_readback_invalid");
  const encoded = body.content.replace(/\s+/g, "");
  if (!encoded || !/^[A-Za-z0-9+/]+=*$/.test(encoded) || encoded.length % 4 !== 0) fail("review_receipt_encoding_invalid");
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  if (!decoded.trim()) fail("review_receipt_empty");
  return decoded.trim();
}

async function reviewReceipt(args) {
  const repository = arg(args, "repository");
  const sourceCommit = requireCommit(arg(args, "source-commit"), "source_commit_invalid");
  if (!REPOSITORY_RE.test(repository)) fail("repository_invalid");
  const decoded = await fetchReviewReceipt(repository, sourceCommit, env("GH_TOKEN"));
  if (decoded === null) fail("review_receipt_unavailable");
  await writeFile(arg(args, "output"), `${decoded}\n`, { mode: 0o600 });
}

function boundedInteger(value, { minimum, maximum, code }) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) fail(code);
  return parsed;
}

function validateIssuerAcknowledgement(acknowledgement, expected = {}) {
  exactObjectKeys(acknowledgement, ["schema", "status", "phase", "repository", "source_commit", "request_digest", "issuer_principal", "issuer_task_id", "issuer_run_id", "key_version", "accepted_at"], "issuer_ack_shape_invalid");
  if (acknowledgement.schema !== "ironwrap_independent_issuer_ack_v1" || acknowledgement.status !== "accepted" || !/^(?:review|release-evidence)$/.test(acknowledgement.phase)) fail("issuer_ack_invalid");
  if (!REPOSITORY_RE.test(acknowledgement.repository) || !COMMIT_RE.test(acknowledgement.source_commit) || !SHA256_RE.test(acknowledgement.request_digest) || !IDENTITY_RE.test(acknowledgement.issuer_principal)) fail("issuer_ack_identity_invalid");
  for (const value of [acknowledgement.issuer_task_id, acknowledgement.issuer_run_id, acknowledgement.key_version]) if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/.test(value)) fail("issuer_ack_execution_invalid");
  if (!Number.isFinite(Date.parse(acknowledgement.accepted_at))) fail("issuer_ack_time_invalid");
  for (const field of ["phase", "repository", "source_commit", "issuer_principal", "issuer_task_id", "key_version", "request_digest"]) if (expected[field] !== undefined && acknowledgement[field] !== expected[field]) fail(`issuer_ack_${field}_drift`);
  return acknowledgement;
}

export function validateIndependentIssuerRequest(request, now = Date.now) {
  exactObjectKeys(request, ["schema", "phase", "repository", "pr_number", "base_commit", "head_commit", "source_commit", "source_git_tree", "source_tree_sha256", "diff_sha256", "ci_run_id", "candidate_artifact", "publication", "receipt_key", "requested_at", "expires_at", "requested_by", "expected_issuer"], "issuer_request_shape_invalid");
  exactObjectKeys(request.candidate_artifact, ["actions_run_id", "actions_run_attempt", "name", "content_digest"], "issuer_request_artifact_invalid");
  exactObjectKeys(request.publication, ["ref", "path"], "issuer_request_publication_invalid");
  exactObjectKeys(request.receipt_key, ["public_key_sha256", "key_version"], "issuer_request_key_invalid");
  exactObjectKeys(request.expected_issuer, ["principal", "task_id"], "issuer_request_expected_invalid");
  if (request.schema !== INDEPENDENT_ISSUER_REQUEST_SCHEMA || !/^(?:review|release-evidence)$/.test(request.phase) || !REPOSITORY_RE.test(request.repository) || !Number.isSafeInteger(request.pr_number) || request.pr_number < 1) fail("issuer_request_invalid");
  for (const value of [request.base_commit, request.head_commit, request.source_commit, request.source_git_tree]) requireCommit(value, "issuer_request_commit_invalid");
  const expectedPublicationRef = request.phase === "review" ? `${REVIEW_RECEIPT_REF_PREFIX}${request.source_commit}` : `${RELEASE_EVIDENCE_REF_PREFIX}${request.source_commit}`;
  const expectedPublicationPath = request.phase === "review" ? `${REVIEW_RECEIPT_PATH_PREFIX}${request.source_commit}.json` : `${RELEASE_EVIDENCE_PATH_PREFIX}${request.source_commit}.json`;
  if (request.publication.ref !== expectedPublicationRef || request.publication.path !== expectedPublicationPath) fail("issuer_request_publication_invalid");
  for (const value of [request.source_tree_sha256, request.diff_sha256, request.candidate_artifact.content_digest, request.receipt_key.public_key_sha256]) requireHash(value, "issuer_request_digest_invalid");
  for (const value of [request.ci_run_id, request.candidate_artifact.actions_run_id, request.candidate_artifact.actions_run_attempt]) if (!/^[1-9][0-9]*$/.test(String(value))) fail("issuer_request_run_invalid");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,255}$/.test(request.candidate_artifact.name) || !IDENTITY_RE.test(request.requested_by) || !IDENTITY_RE.test(request.expected_issuer.principal) || request.requested_by === request.expected_issuer.principal) fail("issuer_request_identity_invalid");
  for (const value of [request.expected_issuer.task_id, request.receipt_key.key_version]) if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/.test(value)) fail("issuer_request_execution_invalid");
  validateIndependentIssuerFreshness(request, now);
  return request;
}

export async function requestIndependentIssuer({
  url,
  apiToken,
  request,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  let issuerUrl;
  try { issuerUrl = new URL(requireString(url, "issuer_url_invalid")); } catch { fail("issuer_url_invalid"); }
  if (issuerUrl.protocol !== "https:"
    || issuerUrl.pathname !== INDEPENDENT_ISSUER_ROUTE
    || issuerUrl.search
    || issuerUrl.username
    || issuerUrl.password
    || issuerUrl.hash) fail("issuer_url_invalid");
  requireString(apiToken, "issuer_token_missing");
  validateIndependentIssuerRequest(request, now);
  const requestBody = canonicalJson(request);
  const requestDigest = sha256(requestBody);
  const response = await fetchImpl(issuerUrl, {
    method: "POST",
    headers: { accept: "application/json", authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
    body: requestBody,
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null);
  if (!response?.ok) fail("issuer_unavailable");
  const body = await response.json().catch(() => null);
  exactObjectKeys(body, ["acknowledgement"], "issuer_response_invalid");
  return validateIssuerAcknowledgement(body.acknowledgement, {
    phase: request.phase,
    repository: request.repository,
    source_commit: request.source_commit,
    issuer_principal: request.expected_issuer.principal,
    issuer_task_id: request.expected_issuer.task_id,
    key_version: request.receipt_key.key_version,
    request_digest: requestDigest,
  });
}

async function issuerRequest(args) {
  const phase = arg(args, "phase");
  if (!/^(?:review|release-evidence)$/.test(phase)) fail("issuer_phase_invalid");
  const source = await readJson(arg(args, "source"), "issuer_source_invalid");
  const pr = await readJson(arg(args, "pr-context"), "issuer_pr_invalid");
  const repository = arg(args, "repository");
  if ((source.repository !== undefined && source.repository !== repository) || pr.repository !== repository || source.source_commit !== pr.ci_merge_commit || source.source_git_tree !== pr.ci_merge_tree || source.base_commit !== pr.base_commit) fail("issuer_source_drift");
  const publicKey = await readFile(arg(args, "issuer-public-key"), "utf8");
  const artifactName = arg(args, "artifact-name");
  const contentDigest = requireHash(arg(args, "artifact-digest"), "issuer_artifact_digest_invalid");
  const requestedAt = Date.now();
  const receiptRef = phase === "review" ? `${REVIEW_RECEIPT_REF_PREFIX}${source.source_commit}` : `${RELEASE_EVIDENCE_REF_PREFIX}${source.source_commit}`;
  const receiptPath = phase === "review" ? `${REVIEW_RECEIPT_PATH_PREFIX}${source.source_commit}.json` : `${RELEASE_EVIDENCE_PATH_PREFIX}${source.source_commit}.json`;
  const request = {
    schema: INDEPENDENT_ISSUER_REQUEST_SCHEMA,
    phase,
    repository,
    pr_number: pr.number,
    base_commit: source.base_commit,
    head_commit: pr.head_commit,
    source_commit: source.source_commit,
    source_git_tree: source.source_git_tree,
    source_tree_sha256: source.source_tree_sha256,
    diff_sha256: source.diff_sha256,
    ci_run_id: pr.ci_run_id,
    candidate_artifact: {
      actions_run_id: arg(args, "actions-run-id"),
      actions_run_attempt: arg(args, "actions-run-attempt"),
      name: artifactName,
      content_digest: contentDigest,
    },
    publication: { ref: receiptRef, path: receiptPath },
    receipt_key: { public_key_sha256: sha256(publicKey), key_version: arg(args, "issuer-key-version") },
    requested_at: new Date(requestedAt).toISOString(),
    expires_at: new Date(requestedAt + INDEPENDENT_ISSUER_REQUEST_LIFETIME_MS).toISOString(),
    requested_by: arg(args, "requester-identity"),
    expected_issuer: { principal: arg(args, "issuer-identity"), task_id: arg(args, "issuer-task-id") },
  };
  const acknowledgement = await requestIndependentIssuer({ url: arg(args, "url"), apiToken: env("RELEASE_INDEPENDENT_ISSUER_TOKEN"), request });
  await writeJson(arg(args, "output"), acknowledgement);
}

async function reviewWait(args) {
  const repository = arg(args, "repository");
  const sourceCommit = requireCommit(arg(args, "source-commit"), "source_commit_invalid");
  if (!REPOSITORY_RE.test(repository)) fail("repository_invalid");
  const attempts = boundedInteger(arg(args, "attempts"), { minimum: 1, maximum: 60, code: "review_wait_attempts_invalid" });
  const intervalMs = boundedInteger(arg(args, "interval-ms"), { minimum: 0, maximum: 30_000, code: "review_wait_interval_invalid" });
  if ((attempts - 1) * intervalMs > 10 * 60_000) fail("review_wait_window_invalid");
  const source = await readJson(arg(args, "source"), "review_source_invalid");
  if (source.source_commit !== sourceCommit) fail("review_source_commit_drift");
  const issuerAck = validateIssuerAcknowledgement(await readJson(arg(args, "issuer-ack"), "review_issuer_ack_invalid"), { phase: "review", repository, source_commit: sourceCommit });
  const publicKey = await readFile(arg(args, "review-public-key"), "utf8");
  const token = env("GH_TOKEN");
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const receipt = await fetchReviewReceipt(repository, sourceCommit, token);
    if (receipt !== null) {
      const payload = verifyReviewGoReceipt(publicKey, receipt, {
        repository,
        source_commit: sourceCommit,
        source_tree_sha256: requireHash(source.source_tree_sha256, "review_source_tree_invalid"),
        diff_sha256: requireHash(source.diff_sha256, "review_diff_invalid"),
      });
      if (payload.reviewer_principal !== issuerAck.issuer_principal || payload.reviewer_task_id !== issuerAck.issuer_task_id || payload.reviewer_run_id !== issuerAck.issuer_run_id || payload.review_key_version !== issuerAck.key_version) fail("review_issuer_ack_drift");
      await writeFile(arg(args, "output"), `${receipt}\n`, { mode: 0o600 });
      return;
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  fail("review_receipt_wait_exhausted");
}

async function reviewSign(args) {
  const repository = arg(args, "repository");
  if (!REPOSITORY_RE.test(repository)) fail("repository_invalid");
  const source = await computeSourceEvidence({
    repoRoot: arg(args, "repo-root"),
    sourceCommit: arg(args, "source-commit"),
    baseCommit: arg(args, "base-commit"),
  });
  const findings = exactObjectKeys(await readJson(arg(args, "findings"), "review_findings_invalid"), [
    "schema", "repository", "source_commit", "source_tree_sha256", "diff_sha256",
    "reviewer_principal", "reviewer_task_id", "reviewer_run_id", "review_key_version",
    "decision", "unresolved_p0", "unresolved_p1", "findings",
  ], "review_findings_shape_invalid");
  if (findings.schema !== REVIEW_FINDINGS_SCHEMA
    || findings.repository !== repository
    || findings.source_commit !== source.source_commit
    || findings.source_tree_sha256 !== source.source_tree_sha256
    || findings.diff_sha256 !== source.diff_sha256) fail("review_findings_source_drift");
  if (!IDENTITY_RE.test(findings.reviewer_principal) || findings.reviewer_principal === arg(args, "issuer-identity")) fail("reviewer_principal_invalid");
  for (const value of [findings.reviewer_task_id, findings.reviewer_run_id, findings.review_key_version]) {
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/.test(value)) fail("reviewer_execution_identity_invalid");
  }
  if (findings.decision !== "GO" || findings.unresolved_p0 !== 0 || findings.unresolved_p1 !== 0 || !Array.isArray(findings.findings)) fail("review_findings_not_go");
  const now = Date.now();
  const payload = {
    schema: "ironwrap_release_review_v1",
    type: "ironwrap-release-review",
    repository,
    source_commit: source.source_commit,
    source_tree_sha256: source.source_tree_sha256,
    diff_sha256: source.diff_sha256,
    reviewer_principal: findings.reviewer_principal,
    reviewer_task_id: findings.reviewer_task_id,
    reviewer_run_id: findings.reviewer_run_id,
    review_key_version: findings.review_key_version,
    decision: findings.decision,
    findings_digest: sha256(canonicalJson(findings)),
    unresolved_p0: findings.unresolved_p0,
    unresolved_p1: findings.unresolved_p1,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 110 * 60_000).toISOString(),
    nonce: randomBytes(48).toString("base64url"),
  };
  const receipt = signReviewGoReceipt(await readFile(arg(args, "review-private-key"), "utf8"), payload, { now });
  await writeFile(arg(args, "output"), `${receipt}\n`, { mode: 0o600 });
}

async function reviewPublish(args) {
  const repository = arg(args, "repository");
  const sourceCommit = requireCommit(arg(args, "source-commit"), "source_commit_invalid");
  if (!REPOSITORY_RE.test(repository)) fail("repository_invalid");
  const receipt = (await readFile(arg(args, "receipt"), "utf8")).trim();
  verifyReviewGoReceipt(await readFile(arg(args, "review-public-key"), "utf8"), receipt, { repository, source_commit: sourceCommit });
  const token = env("GH_TOKEN");
  const headers = reviewHeaders(token);
  const ref = `${REVIEW_RECEIPT_REF_PREFIX}${sourceCommit}`;
  const relativePath = `${REVIEW_RECEIPT_PATH_PREFIX}${sourceCommit}.json`;
  const refUrl = `https://api.github.com/repos/${repository}/git/ref/heads/${encodeURIComponent(ref)}`;
  const existingRef = await fetch(refUrl, { headers }).catch(() => null);
  if (!existingRef) fail("review_publish_unavailable");
  if (existingRef.ok) {
    const existing = await fetchReviewReceipt(repository, sourceCommit, token);
    if (existing !== receipt) fail("review_publish_conflict");
    await writeJson(arg(args, "output"), { status: "matched", repository, source_commit: sourceCommit, ref, path: relativePath, receipt_digest: sha256(receipt) });
    return;
  }
  if (existingRef.status !== 404) fail("review_publish_unavailable");
  const createdRef = await fetch(`https://api.github.com/repos/${repository}/git/refs`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ ref: `refs/heads/${ref}`, sha: sourceCommit }),
  }).catch(() => null);
  const createdRefBody = await createdRef?.json().catch(() => null);
  if (!createdRef?.ok || createdRefBody?.ref !== `refs/heads/${ref}` || createdRefBody?.object?.sha !== sourceCommit) fail("review_publish_ref_failed");
  const published = await fetch(`https://api.github.com/repos/${repository}/contents/${relativePath}`, {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ message: `review: publish independent GO for ${sourceCommit}`, content: Buffer.from(`${receipt}\n`).toString("base64"), branch: ref }),
  }).catch(() => null);
  if (!published?.ok) fail("review_publish_write_failed");
  const readback = await fetchReviewReceipt(repository, sourceCommit, token);
  if (readback !== receipt) fail("review_publish_readback_drift");
  await writeJson(arg(args, "output"), { status: "published", repository, source_commit: sourceCommit, ref, path: relativePath, receipt_digest: sha256(receipt) });
}

async function fetchReleaseEvidence(repository, sourceCommit, token) {
  const ref = `${RELEASE_EVIDENCE_REF_PREFIX}${sourceCommit}`;
  const relativePath = `${RELEASE_EVIDENCE_PATH_PREFIX}${sourceCommit}.json`;
  const response = await fetch(`https://api.github.com/repos/${repository}/contents/${relativePath}?ref=${encodeURIComponent(ref)}`, {
    headers: reviewHeaders(token),
  }).catch(() => null);
  if (response?.status === 404) return null;
  if (!response?.ok) fail("release_evidence_unavailable");
  const body = await response.json().catch(() => null);
  if (!isRecord(body) || body.path !== relativePath || body.name !== `${sourceCommit}.json` || body.encoding !== "base64" || typeof body.content !== "string") fail("release_evidence_readback_invalid");
  const encoded = body.content.replace(/\s+/g, "");
  if (!encoded || !/^[A-Za-z0-9+/]+=*$/.test(encoded) || encoded.length % 4 !== 0) fail("release_evidence_encoding_invalid");
  const decoded = Buffer.from(encoded, "base64").toString("utf8").trim();
  if (!decoded) fail("release_evidence_empty");
  return decoded;
}

async function releaseEvidenceWait(args) {
  const repository = arg(args, "repository");
  const sourceCommit = requireCommit(arg(args, "source-commit"), "source_commit_invalid");
  const sourceGitTree = requireCommit(arg(args, "source-git-tree"), "source_git_tree_invalid");
  const artifactDigest = requireHash(arg(args, "artifact-digest"), "artifact_digest_invalid");
  const prNumber = boundedInteger(arg(args, "pr-number"), { minimum: 1, maximum: 2_147_483_647, code: "pr_number_invalid" });
  if (!REPOSITORY_RE.test(repository)) fail("repository_invalid");
  const attempts = boundedInteger(arg(args, "attempts"), { minimum: 1, maximum: 120, code: "release_evidence_wait_attempts_invalid" });
  const intervalMs = boundedInteger(arg(args, "interval-ms"), { minimum: 0, maximum: 30_000, code: "release_evidence_wait_interval_invalid" });
  if ((attempts - 1) * intervalMs > 30 * 60_000) fail("release_evidence_wait_window_invalid");
  const publicKey = await readFile(arg(args, "evidence-public-key"), "utf8");
  const issuerIdentity = arg(args, "issuer-identity");
  const issuerAck = validateIssuerAcknowledgement(await readJson(arg(args, "issuer-ack"), "release_evidence_issuer_ack_invalid"), { phase: "release-evidence", repository, source_commit: sourceCommit });
  const token = env("GH_TOKEN");
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const receipt = await fetchReleaseEvidence(repository, sourceCommit, token);
    if (receipt !== null) {
      const payload = verifyExternalReleaseEvidence(publicKey, receipt, {
        repository,
        pr_number: prNumber,
        source_commit: sourceCommit,
        source_git_tree: sourceGitTree,
        artifact_digest: artifactDigest,
      });
      if (payload.issuer_principal === issuerIdentity) fail("release_evidence_not_independent");
      if (payload.issuer_principal !== issuerAck.issuer_principal || payload.issuer_task_id !== issuerAck.issuer_task_id || payload.issuer_run_id !== issuerAck.issuer_run_id || payload.key_version !== issuerAck.key_version) fail("release_evidence_issuer_ack_drift");
      await writeFile(arg(args, "output"), `${receipt}\n`, { mode: 0o600 });
      return;
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  fail("release_evidence_wait_exhausted");
}

async function releaseEvidenceSign(args) {
  const body = exactObjectKeys(await readJson(arg(args, "input"), "release_evidence_input_invalid"), [
    "schema",
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
  ], "release_evidence_input_shape_invalid");
  if (body.schema !== "ironwrap_release_external_evidence_input_v1") fail("release_evidence_input_schema_invalid");
  const source = await computeSourceEvidence({
    repoRoot: arg(args, "repo-root"),
    sourceCommit: arg(args, "source-commit"),
    baseCommit: arg(args, "base-commit"),
  });
  if (body.repository !== arg(args, "repository")
    || body.source_commit !== source.source_commit
    || body.source_git_tree !== source.source_git_tree
    || body.artifact_digest !== requireHash(arg(args, "artifact-digest"), "artifact_digest_invalid")
    || body.issuer_principal === arg(args, "issuer-identity")) fail("release_evidence_input_identity_drift");
  const checks = await readJson(arg(args, "checks"), "release_evidence_checks_invalid");
  const supplyChain = await computeSupplyChainEvidence({ repoRoot: arg(args, "repo-root"), sourceCommit: source.source_commit, ciChecks: checks });
  if (canonicalJson(body.supply_chain) !== canonicalJson(supplyChain)) fail("release_evidence_supply_chain_drift");
  const now = Date.now();
  const payload = {
    schema: "ironwrap_release_external_evidence_v1",
    type: "ironwrap-release-external-evidence",
    ...Object.fromEntries(Object.entries(body).filter(([key]) => key !== "schema")),
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 5.5 * 60 * 60_000).toISOString(),
    nonce: randomBytes(48).toString("base64url"),
  };
  const receipt = signExternalReleaseEvidence(await readFile(arg(args, "evidence-private-key"), "utf8"), payload, { now });
  await writeFile(arg(args, "output"), `${receipt}\n`, { mode: 0o600 });
}

async function releaseEvidencePublish(args) {
  const repository = arg(args, "repository");
  const sourceCommit = requireCommit(arg(args, "source-commit"), "source_commit_invalid");
  if (!REPOSITORY_RE.test(repository)) fail("repository_invalid");
  const receipt = (await readFile(arg(args, "receipt"), "utf8")).trim();
  verifyExternalReleaseEvidence(await readFile(arg(args, "evidence-public-key"), "utf8"), receipt, { repository, source_commit: sourceCommit });
  const token = env("GH_TOKEN");
  const headers = reviewHeaders(token);
  const ref = `${RELEASE_EVIDENCE_REF_PREFIX}${sourceCommit}`;
  const relativePath = `${RELEASE_EVIDENCE_PATH_PREFIX}${sourceCommit}.json`;
  const refUrl = `https://api.github.com/repos/${repository}/git/ref/heads/${encodeURIComponent(ref)}`;
  const existingRef = await fetch(refUrl, { headers }).catch(() => null);
  if (!existingRef) fail("release_evidence_publish_unavailable");
  if (existingRef.ok) {
    const existing = await fetchReleaseEvidence(repository, sourceCommit, token);
    if (existing !== receipt) fail("release_evidence_publish_conflict");
    await writeJson(arg(args, "output"), { status: "matched", repository, source_commit: sourceCommit, ref, path: relativePath, receipt_digest: sha256(receipt) });
    return;
  }
  if (existingRef.status !== 404) fail("release_evidence_publish_unavailable");
  const createdRef = await fetch(`https://api.github.com/repos/${repository}/git/refs`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ ref: `refs/heads/${ref}`, sha: sourceCommit }),
  }).catch(() => null);
  const createdRefBody = await createdRef?.json().catch(() => null);
  if (!createdRef?.ok || createdRefBody?.ref !== `refs/heads/${ref}` || createdRefBody?.object?.sha !== sourceCommit) fail("release_evidence_publish_ref_failed");
  const published = await fetch(`https://api.github.com/repos/${repository}/contents/${relativePath}`, {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ message: `release: publish external evidence for ${sourceCommit}`, content: Buffer.from(`${receipt}\n`).toString("base64"), branch: ref }),
  }).catch(() => null);
  if (!published?.ok) fail("release_evidence_publish_write_failed");
  const readback = await fetchReleaseEvidence(repository, sourceCommit, token);
  if (readback !== receipt) fail("release_evidence_publish_readback_drift");
  await writeJson(arg(args, "output"), { status: "published", repository, source_commit: sourceCommit, ref, path: relativePath, receipt_digest: sha256(receipt) });
}

async function serviceAdapterSign(args) {
  const input = await readJson(
    arg(args, "input"),
    "service_adapter_input_invalid",
  );
  const now = Date.now();
  const payload = {
    ...input,
    schema: "ironwrap_service_adapter_receipt_v1",
    type: "ironwrap-service-adapter-receipt",
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 25 * 60_000).toISOString(),
    nonce: randomBytes(48).toString("base64url"),
  };
  const receipt = signServiceAdapterReceipt(
    await readFile(arg(args, "adapter-private-key"), "utf8"),
    payload,
    { now },
  );
  await writeFile(arg(args, "output"), `${receipt}\n`, { mode: 0o600 });
}

export async function requestServiceAdapter({
  url,
  apiToken,
  request,
  publicKey,
  expected,
  fetchImpl = fetch,
}) {
  let adapterUrl;
  try {
    adapterUrl = new URL(requireString(url, "service_adapter_url_invalid"));
  } catch {
    fail("service_adapter_url_invalid");
  }
  if (
    adapterUrl.protocol !== "https:" ||
    adapterUrl.username ||
    adapterUrl.password ||
    adapterUrl.hash
  )
    fail("service_adapter_url_invalid");
  requireString(apiToken, "release_service_adapter_token_missing");
  exactObjectKeys(
    request,
    [
      "schema",
      "operation",
      "release_permit",
      "source_merge_receipt",
      "expected",
    ],
    "service_adapter_request_shape_invalid",
  );
  if (
    request.schema !== "ironwrap_service_adapter_request_v1" ||
    !/^(?:promote|readback|rollback)$/.test(request.operation)
  )
    fail("service_adapter_request_invalid");
  const response = await fetchImpl(adapterUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
    },
    body: canonicalJson(request),
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null);
  if (!response?.ok) fail("service_adapter_unavailable");
  const body = await response.json().catch(() => null);
  exactObjectKeys(body, ["receipt"], "service_adapter_response_invalid");
  const receipt = requireString(
    body.receipt,
    "service_adapter_receipt_invalid",
  );
  const payload = verifyServiceAdapterReceipt(publicKey, receipt, expected);
  return { receipt, payload };
}

async function serviceAdapter(args) {
  const operation = arg(args, "operation");
  if (!/^(?:promote|readback|rollback)$/.test(operation))
    fail("service_adapter_operation_invalid");
  const permitToken = (await readFile(arg(args, "permit"), "utf8")).trim();
  const permitPublicKey = await readFile(
    arg(args, "permit-public-key"),
    "utf8",
  );
  let permit;
  if (operation === "rollback") {
    const admittedPayload = await readJson(
      arg(args, "permit-payload"),
      "service_adapter_permit_payload_invalid",
    );
    const issuedAt = Date.parse(admittedPayload.issued_at);
    if (!Number.isFinite(issuedAt))
      fail("service_adapter_permit_payload_invalid");
    permit = verifyReleasePermit(
      permitPublicKey,
      permitToken,
      {},
      { now: issuedAt + 1 },
    );
    if (canonicalJson(permit) !== canonicalJson(admittedPayload))
      fail("service_adapter_permit_payload_drift");
  } else {
    permit = verifyReleasePermit(permitPublicKey, permitToken);
  }
  const mergeReceipt = await readJson(
    arg(args, "merge-receipt"),
    "service_adapter_merge_receipt_invalid",
  );
  validateSourceMergeReceipt(mergeReceipt, permit, {
    permitDigest: releasePermitDigest(permitToken),
  });
  const expected = {
    operation,
    repository: permit.repository,
    source_commit: permit.source_commit,
    source_git_tree: permit.source_git_tree,
    aggregate_artifact_digest: permit.worker.artifact_digest,
    merge_commit: mergeReceipt.merge_commit,
    "frappe.artifact_digest":
      permit.release_manifest.artifacts.frappe_wheel_digest,
    "frappe.site_schema_digest":
      permit.release_manifest.artifacts.frappe_site_schema_digest,
    "frappe.previous_revision":
      permit.release_manifest.recovery.prior_frappe_revision,
    "frappe.candidate_revision":
      permit.release_manifest.production_candidates.frappe_revision,
    "frappe.backup_digest":
      permit.release_manifest.recovery.prior_frappe_backup_digest,
    "frappe.provider_readback_digest":
      operation === "rollback"
        ? permit.release_manifest.recovery.prior_frappe_readback_digest
        : permit.release_manifest.production_candidates.frappe_readback_digest,
    provider_reconciliation_digest:
      permit.release_manifest.provider_reconciliation.receipt_digest,
    issuer_principal: arg(args, "issuer-identity"),
    issuer_task_id: arg(args, "issuer-task-id"),
    issuer_run_id: arg(args, "issuer-run-id"),
    key_version: arg(args, "key-version"),
  };
  const request = {
    schema: "ironwrap_service_adapter_request_v1",
    operation,
    release_permit: permitToken,
    source_merge_receipt: mergeReceipt,
    expected: {
      repository: expected.repository,
      source_commit: expected.source_commit,
      source_git_tree: expected.source_git_tree,
      aggregate_artifact_digest: expected.aggregate_artifact_digest,
      merge_commit: expected.merge_commit,
      frappe: {
        artifact_digest: expected["frappe.artifact_digest"],
        site_schema_digest: expected["frappe.site_schema_digest"],
        previous_revision: expected["frappe.previous_revision"],
        candidate_revision: expected["frappe.candidate_revision"],
        backup_digest: expected["frappe.backup_digest"],
        provider_readback_digest:
          expected["frappe.provider_readback_digest"],
      },
      provider_reconciliation_digest: expected.provider_reconciliation_digest,
      issuer: {
        principal: expected.issuer_principal,
        task_id: expected.issuer_task_id,
        run_id: expected.issuer_run_id,
        key_version: expected.key_version,
      },
    },
  };
  const { receipt } = await requestServiceAdapter({
    url: arg(args, "url"),
    apiToken: env("RELEASE_SERVICE_ADAPTER_TOKEN"),
    request,
    publicKey: await readFile(arg(args, "adapter-public-key"), "utf8"),
    expected,
  });
  await writeFile(arg(args, "output"), `${receipt}\n`, { mode: 0o600 });
}

async function admissionContext(args) {
  const source = await readJson(arg(args, "source"));
  const pr = exactObjectKeys(await readJson(arg(args, "pr-context"), "pr_context_invalid"), [
    "schema", "repository", "number", "base_ref", "base_commit", "head_ref", "head_commit", "ci_run_id", "ci_merge_commit", "ci_merge_tree", "merge_method", "merge_policy", "provider_readback_digest", "status",
  ], "pr_context_shape_invalid");
  const ciChecks = await readJson(arg(args, "checks"));
  const policy = await readJson(arg(args, "policy"));
  const staging = await readJson(arg(args, "staging"));
  const production = await readJson(arg(args, "production"));
  const repository = arg(args, "repository");
  if (!REPOSITORY_RE.test(repository)
    || pr.schema !== "ironwrap_pr_admission_v1"
    || pr.repository !== repository
    || pr.ci_merge_commit !== source.source_commit
    || pr.ci_merge_tree !== source.source_git_tree
    || pr.base_commit !== source.base_commit
    || !Number.isSafeInteger(policy.generation)
    || policy.generation < 0
    || !SHA256_RE.test(policy.policy_hash)) fail("admission_context_invalid");
  const migrations = await computeMigrationSet({ repoRoot: arg(args, "repo-root") });
  const supplyChain = await computeSupplyChainEvidence({
    repoRoot: arg(args, "repo-root"),
    sourceCommit: source.source_commit,
    ciChecks,
  });
  for (const key of ["frappe_schema_digest", "frappe_migration_digest", "routes_source_digest"]) {
    if (!SHA256_RE.test(source[key]) || source[key] === sha256("")) fail(`source_${key}_missing`);
  }
  await writeJson(arg(args, "output"), {
    repository,
    ...source,
    pr: Object.fromEntries(Object.entries(pr).filter(([key]) => key !== "schema" && key !== "repository")),
    ci_checks: ciChecks,
    supply_chain: supplyChain,
    migrations,
    config_digest: computeReleaseConfigDigest({ staging: staging.digest, production: production.digest }),
    staging_config_digest: staging.digest,
    production_config_digest: production.digest,
    staging_secret_names: staging.secret_names,
    production_secret_names: production.secret_names,
    staging_secret_inventory_digest: staging.secret_inventory_digest,
    production_secret_inventory_digest: production.secret_inventory_digest,
    staging_binding_manifest: staging.binding_manifest,
    production_binding_manifest: production.binding_manifest,
    staging_binding_manifest_digest: staging.binding_manifest_digest,
    production_binding_manifest_digest: production.binding_manifest_digest,
    staging_runtime_manifest: staging.runtime_manifest,
    production_runtime_manifest: production.runtime_manifest,
    staging_runtime_manifest_digest: staging.runtime_manifest_digest,
    production_runtime_manifest_digest: production.runtime_manifest_digest,
    staging_vars_digest: staging.vars_digest,
    production_vars_digest: production.vars_digest,
    staging_queues_digest: staging.queues_digest,
    production_queues_digest: production.queues_digest,
    staging_buckets_digest: staging.buckets_digest,
    production_buckets_digest: production.buckets_digest,
    staging_routes_digest: staging.routes_digest,
    production_routes_digest: production.routes_digest,
  });
}

async function directoryDigest(root) {
  const resolved = path.resolve(root);
  const files = [];
  async function visit(directory, prefix = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.posix.join(prefix, entry.name);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) fail("artifact_symlink_forbidden");
      if (metadata.isDirectory()) await visit(absolute, relative);
      else if (metadata.isFile()) {
        const bytes = await readFile(absolute);
        files.push({ path: relative, size: bytes.length, sha256: sha256(bytes) });
      } else fail("artifact_entry_invalid");
    }
  }
  await visit(resolved);
  if (files.length === 0) fail("artifact_directory_empty");
  return sha256(canonicalJson(files));
}

async function artifactManifest(args) {
  const workerBytes = await readFile(arg(args, "worker"));
  const frappeBytes = await readFile(arg(args, "frappe-wheel"));
  if (workerBytes.length === 0 || frappeBytes.length === 0) fail("artifact_component_empty");
  const manifest = {
    worker_digest: sha256(workerBytes),
    pwa_digest: await directoryDigest(arg(args, "pwa")),
    frappe_wheel_digest: sha256(frappeBytes),
  };
  await writeJson(arg(args, "output"), {
    ...manifest,
    artifact_manifest_digest: sha256(canonicalJson(manifest)),
  });
}

async function bindArtifact(args) {
  const file = arg(args, "context");
  const artifactDigest = requireHash(arg(args, "artifact-digest"), "artifact_digest_invalid");
  const artifactId = arg(args, "artifact-id");
  const uploadedDigest = requireHash(arg(args, "uploaded-digest"), "uploaded_digest_invalid");
  const context = await readJson(file);
  context.artifact_digest = artifactDigest;
  context.upload_receipt_digest = sha256(JSON.stringify({ artifact_id: artifactId, artifact_digest: artifactDigest, uploaded_digest: uploadedDigest }));
  if (args.has("component-manifest")) {
    const manifest = exactObjectKeys(await readJson(arg(args, "component-manifest"), "artifact_manifest_invalid"), ["worker_digest", "pwa_digest", "frappe_wheel_digest", "artifact_manifest_digest"], "artifact_manifest_shape_invalid");
    for (const key of ["worker_digest", "pwa_digest", "frappe_wheel_digest", "artifact_manifest_digest"]) requireHash(manifest[key], `artifact_${key}_invalid`);
    const fields = { worker_digest: manifest.worker_digest, pwa_digest: manifest.pwa_digest, frappe_wheel_digest: manifest.frappe_wheel_digest };
    if (sha256(canonicalJson(fields)) !== manifest.artifact_manifest_digest) fail("artifact_manifest_digest_mismatch");
    context.artifacts = manifest;
  }
  await writeJson(file, context);
}

async function contextField(args) {
  const context = await readJson(arg(args, "context"));
  const field = arg(args, "field");
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(field) || !(field in context)) fail("context_field_missing");
  const value = context[field];
  let rendered;
  if (args.get("format") === "csv") {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.includes(","))) fail("context_field_array_invalid");
    rendered = value.join(",");
  } else {
    if ((typeof value !== "string" && typeof value !== "number") || String(value).includes("\n")) fail("context_field_invalid");
    rendered = String(value);
  }
  if (args.has("output")) await writeFile(arg(args, "output"), `${rendered}\n`, { mode: 0o600 });
  else process.stdout.write(rendered);
}

async function versionMessage(args) {
  const context = await readJson(arg(args, "context"));
  const environment = arg(args, "environment");
  if (!/^(?:staging|production)$/.test(environment)) fail("environment_invalid");
  process.stdout.write(releaseVersionMessage({
    sourceCommit: context.source_commit,
    sourceTreeSha256: context.source_tree_sha256,
    artifactDigest: context.artifact_digest,
    configDigest: context[`${environment}_config_digest`],
  }));
}

async function readDeploymentJson(file) {
  let value;
  try { value = JSON.parse(await readFile(file, "utf8")); } catch { fail("deployment_json_invalid"); }
  if (!Array.isArray(value)) fail("deployment_json_invalid");
  return value;
}

function activeDeploymentVersion(deployments, expected) {
  if (!Array.isArray(deployments) || deployments.length === 0) fail("deployment_list_empty");
  const timestampKey = ["created_on", "created_at", "modified_on", "modified_at"].find((key) => deployments.some((deployment) => deployment?.[key] !== undefined));
  let ordered = deployments;
  if (timestampKey) {
    const timestamps = deployments.map((deployment) => {
      const value = deployment?.[timestampKey];
      if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) fail("deployment_timestamp_invalid");
      return Date.parse(value);
    });
    if (new Set(timestamps).size !== timestamps.length) fail("deployment_order_ambiguous");
    ordered = deployments
      .map((deployment, index) => ({ deployment, timestamp: timestamps[index] }))
      .sort((left, right) => right.timestamp - left.timestamp)
      .map(({ deployment }) => deployment);
  }
  // Wrangler's fetchLatestDeployment contract uses index 0. When the provider
  // supplies timestamps, sort explicitly so API and CLI list orderings agree.
  const latest = ordered[0];
  const active = latest?.versions?.filter((version) => version.percentage === 100) ?? [];
  if (active.length !== 1 || typeof active[0].version_id !== "string" || !UUID_RE.test(active[0].version_id)) fail("deployment_active_revision_invalid");
  if (expected !== undefined && active[0].version_id !== expected) fail("deployment_active_revision_drift");
  return active[0].version_id;
}

async function deploymentRevision(args) {
  const expected = args.has("expected") ? requireUuid(arg(args, "expected"), "expected_revision_invalid") : undefined;
  const revision = activeDeploymentVersion(await readDeploymentJson(arg(args, "input")), expected);
  await writeFile(arg(args, "output"), `${revision}\n`, { mode: 0o600 });
}

async function versionSnapshot(args) {
  const readback = await readJson(arg(args, "input"), "version_snapshot_invalid");
  if (!isRecord(readback)) fail("version_snapshot_invalid");
  const revision = requireUuid(readback.id, "version_snapshot_revision_invalid");
  if (
    args.has("expected") &&
    requireUuid(arg(args, "expected"), "expected_revision_invalid") !== revision
  )
    fail("version_snapshot_revision_drift");
  await writeJson(arg(args, "output"), {
    schema: "ironwrap_provider_version_snapshot_v1",
    revision,
    provider_readback_digest: sha256(canonicalJson(readback)),
    status: "matched",
  });
}

async function readiness(args) {
  const health = await readJson(arg(args, "health"));
  const ready = await readJson(arg(args, "ready"));
  if (health.ok !== true || ready.ok !== true) fail("readiness_not_proven");
}

function quoteSqlIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function exportedTableNames(sql) {
  const names = [];
  const pattern = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))/gi;
  for (const match of sql.matchAll(pattern)) {
    const name = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (name && !name.startsWith("sqlite_")) names.push(name);
  }
  const unique = [...new Set(names)].sort();
  if (unique.length === 0 || !unique.includes("dedup_claims")) fail("restore_schema_missing");
  return unique;
}

async function restoreQuery(args) {
  const exportBytes = await readFile(arg(args, "export"));
  const sql = exportBytes.toString("utf8");
  if (exportBytes.length < 32 || !/\bCREATE\s+TABLE\b/i.test(sql)) fail("restore_export_empty");
  const tables = exportedTableNames(sql);
  const schema = "SELECT 'schema' AS kind, type AS object_type, name AS object_name, COALESCE(sql, '') AS definition, CAST(NULL AS INTEGER) AS row_count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND type IN ('table','index','trigger')";
  const counts = tables.map((table) => `SELECT 'row_count' AS kind, 'table' AS object_type, '${table.replaceAll("'", "''")}' AS object_name, '' AS definition, COUNT(*) AS row_count FROM ${quoteSqlIdentifier(table)}`);
  const content = tables.map((table) => `SELECT '${table.replaceAll("'", "''")}' AS __ironwrap_restore_table_iro41, * FROM ${quoteSqlIdentifier(table)}`);
  await writeFile(arg(args, "output"), `${[`${[schema, ...counts].join(" UNION ALL ")} ORDER BY kind, object_type, object_name`, ...content].join(";\n")};\n`, { mode: 0o600 });
}

function parseD1QueryResults(value, tables, code) {
  if (!Array.isArray(value) || value.length !== tables.length + 1 || value.some((result) => !isRecord(result) || result.success !== true || !Array.isArray(result.results))) fail(code);
  return { manifestRows: value[0].results, contentResults: value.slice(1).map((result) => result.results) };
}

function restoreManifest({ manifestRows, contentResults }, tables, code) {
  const schema = [];
  const rowCounts = [];
  for (const row of manifestRows) {
    if (!isRecord(row) || JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(["definition", "kind", "object_name", "object_type", "row_count"]) || typeof row.kind !== "string" || typeof row.object_type !== "string" || typeof row.object_name !== "string" || typeof row.definition !== "string" || !(row.row_count === null || Number.isSafeInteger(row.row_count))) fail(code);
    if (row.kind === "schema") {
      if (row.row_count !== null) fail(code);
      schema.push({ object_type: row.object_type, object_name: row.object_name, definition: row.definition });
    } else if (row.kind === "row_count") {
      if (row.object_type !== "table" || row.definition !== "" || !Number.isSafeInteger(row.row_count) || row.row_count < 0) fail(code);
      rowCounts.push({ object_name: row.object_name, row_count: row.row_count });
    } else fail(code);
  }
  schema.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  rowCounts.sort((left, right) => left.object_name.localeCompare(right.object_name));
  if (schema.length === 0 || !schema.some((row) => row.object_type === "table" && row.object_name === "dedup_claims")) fail(code);
  if (rowCounts.length === 0 || !rowCounts.some((row) => row.row_count > 0)) fail(code);
  const dataContent = tables.map((table, index) => {
    const rows = contentResults[index];
    const digests = rows.map((row) => {
      if (!isRecord(row) || row.__ironwrap_restore_table_iro41 !== table) fail(code);
      const content = { ...row };
      delete content.__ironwrap_restore_table_iro41;
      return sha256(canonicalJson(content));
    }).sort();
    const expectedCount = rowCounts.find((row) => row.object_name === table)?.row_count;
    if (expectedCount === undefined || expectedCount !== rows.length) fail(code);
    return { object_name: table, row_count: rows.length, content_digest: sha256(canonicalJson(digests)) };
  });
  return {
    schema,
    row_counts: rowCounts,
    data_content: dataContent,
    sentinel: rowCounts.find((row) => row.object_name === "dedup_claims") ?? null,
    manifest_digest: sha256(canonicalJson({ schema, row_counts: rowCounts, data_content: dataContent })),
  };
}

async function restoreReadback(args) {
  const exportBytes = await readFile(arg(args, "export"));
  const exportSql = exportBytes.toString("utf8");
  if (exportBytes.length < 32 || !/\bCREATE\s+TABLE\b/i.test(exportSql) || !/\bINSERT\s+INTO\b/i.test(exportSql)) fail("restore_export_empty");
  const exportedTables = exportedTableNames(exportSql);
  let source;
  let restored;
  try {
    source = JSON.parse(await readFile(arg(args, "source"), "utf8"));
    restored = JSON.parse(await readFile(arg(args, "restored"), "utf8"));
  } catch {
    fail("restore_json_invalid");
  }
  const sourceManifest = restoreManifest(parseD1QueryResults(source, exportedTables, "restore_source_result_invalid"), exportedTables, "restore_source_manifest_invalid");
  const restoredManifest = restoreManifest(parseD1QueryResults(restored, exportedTables, "restore_restored_result_invalid"), exportedTables, "restore_restored_manifest_invalid");
  const sourceTableNames = sourceManifest.schema.filter((row) => row.object_type === "table").map((row) => row.object_name).sort();
  const restoredTableNames = restoredManifest.schema.filter((row) => row.object_type === "table").map((row) => row.object_name).sort();
  if (JSON.stringify(sourceTableNames) !== JSON.stringify(exportedTables) || JSON.stringify(restoredTableNames) !== JSON.stringify(exportedTables)) fail("restore_schema_export_mismatch");
  if (sourceManifest.manifest_digest !== restoredManifest.manifest_digest) fail("restore_manifest_mismatch");
  await writeJson(arg(args, "output"), {
    status: "matched",
    result: "passed",
    restored: true,
    export_digest: sha256(exportBytes),
    manifest_digest: sourceManifest.manifest_digest,
    source_manifest: sourceManifest,
    restored_manifest: restoredManifest,
    evidence_digest: sha256(canonicalJson({ export_digest: sha256(exportBytes), manifest_digest: sourceManifest.manifest_digest })),
    observed_at: new Date().toISOString(),
  });
}

async function d1RecoveryPoint(args) {
  const readback = exactObjectKeys(await readJson(arg(args, "input"), "d1_recovery_readback_invalid"), ["bookmark"], "d1_recovery_readback_shape_invalid");
  const bookmark = requireString(readback.bookmark, "d1_recovery_bookmark_invalid");
  if (!/^[A-Za-z0-9._~:/+-]{8,512}$/.test(bookmark)) fail("d1_recovery_bookmark_invalid");
  await writeJson(arg(args, "output"), {
    schema: "ironwrap_d1_recovery_point_v1",
    environment: "production",
    database_id: requireUuid(arg(args, "database-id"), "d1_recovery_database_invalid"),
    bookmark,
    provider_readback_digest: sha256(canonicalJson(readback)),
    status: "matched",
    captured_at: new Date().toISOString(),
  });
}

async function deploymentRollbackReadback(args) {
  const expected = requireUuid(arg(args, "expected"), "expected_revision_invalid");
  const revision = activeDeploymentVersion(await readDeploymentJson(arg(args, "input")), expected);
  await writeFile(arg(args, "output"), `${revision}\n`, { mode: 0o600 });
}

async function stagingCleanupReceipt(args) {
  const previous = requireUuid(arg(args, "previous"), "previous_revision_invalid");
  const candidate = requireUuid(arg(args, "candidate"), "candidate_revision_invalid");
  if (previous === candidate) fail("staging_cleanup_candidate_not_new");
  const commandResult = arg(args, "command-result");
  if (!/^(?:succeeded|nonzero_reconciled)$/.test(commandResult))
    fail("staging_cleanup_command_result_invalid");
  const providerRaw = await readFile(arg(args, "input"));
  let deployments;
  try {
    deployments = JSON.parse(providerRaw);
  } catch {
    fail("staging_cleanup_provider_invalid");
  }
  const restored = activeDeploymentVersion(deployments, previous);
  const fields = {
    schema: "ironwrap_staging_cleanup_v1",
    previous_revision: previous,
    candidate_revision: candidate,
    restored_revision: restored,
    restore_command_result: commandResult,
    result: "passed",
    readback: "matched",
    provider_readback_digest: sha256(providerRaw),
  };
  await writeJson(arg(args, "output"), {
    ...fields,
    evidence_digest: sha256(canonicalJson(fields)),
    observed_at: new Date().toISOString(),
  });
}

async function productionRollbackReceipt(args) {
  const previous = requireUuid(arg(args, "previous"), "previous_revision_invalid");
  const candidate = requireUuid(arg(args, "candidate"), "candidate_revision_invalid");
  if (previous === candidate) fail("rollback_candidate_not_new");
  const permitPayload = await readJson(
    arg(args, "permit-payload"),
    "permit_payload_invalid",
  );
  if (
    permitPayload.release_manifest?.recovery?.prior_worker_revision !==
      previous ||
    permitPayload.worker?.production_version_id !== candidate ||
    permitPayload.release_manifest?.recovery?.prior_pwa_revision !== previous ||
    permitPayload.release_manifest?.production_candidates?.pwa_revision !==
      candidate
  )
    fail("production_rollback_permit_drift");
  const leftoverFrappeDigest = sha256("frappe-not-required");
  let frappePreviousRevision = "leftover-not-promoted";
  let frappeCandidateRevision = "leftover-not-promoted";
  let frappeRestoredRevision = "leftover-not-promoted";
  let frappeReadbackDigest = leftoverFrappeDigest;
  let serviceRollbackDigest = leftoverFrappeDigest;
  if (hasArg(args, "service-receipt")) {
    const serviceReceiptToken = (
      await readFile(arg(args, "service-receipt"), "utf8")
    ).trim();
    const serviceReceipt = verifyServiceAdapterReceipt(
      await readFile(arg(args, "service-public-key"), "utf8"),
      serviceReceiptToken,
      {
        operation: "rollback",
        repository: permitPayload.repository,
        source_commit: permitPayload.source_commit,
        source_git_tree: permitPayload.source_git_tree,
        aggregate_artifact_digest: permitPayload.worker.artifact_digest,
        merge_commit: requireCommit(
          arg(args, "merge-commit"),
          "merge_commit_invalid",
        ),
        "frappe.artifact_digest":
          permitPayload.release_manifest.artifacts.frappe_wheel_digest,
        "frappe.site_schema_digest":
          permitPayload.release_manifest.artifacts.frappe_site_schema_digest,
        "frappe.previous_revision":
          permitPayload.release_manifest.recovery.prior_frappe_revision,
        "frappe.candidate_revision":
          permitPayload.release_manifest.production_candidates.frappe_revision,
        "frappe.provider_readback_digest":
          permitPayload.release_manifest.recovery.prior_frappe_readback_digest,
        provider_reconciliation_digest:
          permitPayload.release_manifest.provider_reconciliation.receipt_digest,
        issuer_principal: arg(args, "service-issuer-identity"),
        issuer_task_id: arg(args, "service-issuer-task-id"),
        issuer_run_id: arg(args, "service-issuer-run-id"),
        key_version: arg(args, "service-key-version"),
      },
    );
    frappePreviousRevision = serviceReceipt.frappe.previous_revision;
    frappeCandidateRevision = serviceReceipt.frappe.candidate_revision;
    frappeRestoredRevision = serviceReceipt.frappe.active_revision;
    frappeReadbackDigest = serviceReceipt.frappe.provider_readback_digest;
    serviceRollbackDigest = sha256(serviceReceiptToken);
  }
  const providerRaw = await readFile(arg(args, "input"));
  let deployments;
  try { deployments = JSON.parse(providerRaw); } catch { fail("production_rollback_provider_invalid"); }
  const restored = activeDeploymentVersion(deployments, previous);
  const versionSnapshot = exactObjectKeys(
    await readJson(arg(args, "version-readback"), "rollback_version_readback_invalid"),
    ["schema", "revision", "provider_readback_digest", "status"],
    "rollback_version_readback_shape_invalid",
  );
  if (
    versionSnapshot.schema !== "ironwrap_provider_version_snapshot_v1" ||
    versionSnapshot.revision !== previous ||
    versionSnapshot.provider_readback_digest !==
      permitPayload.release_manifest.recovery.prior_worker_readback_digest ||
    versionSnapshot.status !== "matched"
  )
    fail("rollback_version_readback_drift");
  const sourceCommit = requireCommit(arg(args, "source-commit"), "source_commit_invalid");
  if (permitPayload.source_commit !== sourceCommit)
    fail("production_rollback_source_drift");
  const healthRaw = await readFile(arg(args, "health"));
  const readyRaw = await readFile(arg(args, "ready"));
  const health = json(JSON.parse(healthRaw), "production_rollback_health_invalid");
  const ready = json(JSON.parse(readyRaw), "production_rollback_ready_invalid");
  if (health.ok !== true || ready.ok !== true) fail("production_rollback_readiness_not_proven");
  const fields = {
    schema: "ironwrap_production_rollback_v3",
    source_commit: sourceCommit,
    previous_revision: previous,
    candidate_revision: candidate,
    restored_revision: restored,
    result: "passed",
    readback: "matched",
    provider_readback_digest: versionSnapshot.provider_readback_digest,
    pwa_previous_revision: previous,
    pwa_candidate_revision: candidate,
    pwa_restored_revision: restored,
    pwa_provider_readback_digest: versionSnapshot.provider_readback_digest,
    frappe_previous_revision: frappePreviousRevision,
    frappe_candidate_revision: frappeCandidateRevision,
    frappe_restored_revision: frappeRestoredRevision,
    frappe_provider_readback_digest: frappeReadbackDigest,
    service_rollback_digest: serviceRollbackDigest,
    health_digest: sha256(healthRaw),
    readiness_digest: sha256(readyRaw),
  };
  await writeJson(arg(args, "output"), {
    ...fields,
    evidence_digest: sha256(canonicalJson(fields)),
    observed_at: new Date().toISOString(),
  });
}

async function parseVersion(args) {
  const output = await readFile(arg(args, "input"), "utf8");
  await writeFile(arg(args, "output"), `${parseWranglerVersionId(output)}\n`, { mode: 0o600 });
}

async function versionReadback(args) {
  const readback = await readJson(arg(args, "input"));
  const environment = arg(args, "environment");
  if (!/^(?:staging|production)$/.test(environment)) fail("environment_invalid");
  const inventory = await readJson(arg(args, "secret-inventory"));
  if (inventory.status !== "matched" || typeof inventory.secret_inventory_digest !== "string" || !Array.isArray(inventory.secret_names)) fail("secret_inventory_receipt_invalid");
  const context = await readJson(arg(args, "context"));
  const expectedSecretNames = context[`${environment}_secret_names`];
  const expectedBindingManifest = context[`${environment}_binding_manifest`];
  const expectedRuntimeManifest = context[`${environment}_runtime_manifest`];
  if (!Array.isArray(expectedSecretNames) || !Array.isArray(expectedBindingManifest) || !isRecord(expectedRuntimeManifest)) fail("provider_config_context_invalid");
  if (JSON.stringify([...inventory.secret_names].sort()) !== JSON.stringify([...expectedSecretNames].sort())) fail("secret_inventory_context_drift");
  const receipt = validateWorkerVersionReadback(readback, {
    versionId: requireUuid(arg(args, "version-id"), "version_id_invalid"),
    sourceCommit: requireCommit(arg(args, "source-commit"), "source_commit_invalid"),
    sourceTreeSha256: requireHash(arg(args, "source-tree"), "source_tree_invalid"),
    artifactDigest: requireHash(arg(args, "artifact-digest"), "artifact_digest_invalid"),
    configDigest: requireHash(arg(args, "config-digest"), "config_digest_invalid"),
    secretNames: expectedSecretNames,
    bindingManifest: expectedBindingManifest,
    runtimeManifest: expectedRuntimeManifest,
  });
  if (inventory.secret_inventory_digest !== sha256(canonicalJson([...receipt.secret_names].sort()))) fail("secret_inventory_provider_digest_invalid");
  if (receipt.binding_manifest_digest !== sha256(canonicalJson(expectedBindingManifest))) fail("binding_manifest_provider_digest_invalid");
  if (receipt.runtime_manifest_digest !== sha256(canonicalJson(expectedRuntimeManifest))) fail("runtime_manifest_provider_digest_invalid");
  await writeJson(arg(args, "output"), {
    environment,
    revision: receipt.version_id,
    version_digest: receipt.version_digest,
    source_commit: receipt.source_commit,
    source_tree_sha256: receipt.source_tree_sha256,
    artifact_digest: receipt.artifact_digest,
    config_digest: receipt.config_digest,
    secret_names: receipt.secret_names,
    binding_manifest_digest: sha256(canonicalJson(expectedBindingManifest)),
    runtime_manifest_digest: receipt.runtime_manifest_digest,
    readback: {
      status: "matched",
      source_commit: receipt.source_commit,
      source_tree_sha256: receipt.source_tree_sha256,
      artifact_digest: receipt.artifact_digest,
      config_digest: receipt.config_digest,
      secret_inventory_digest: inventory.secret_inventory_digest,
    },
  });
}

async function secretReadback(args) {
  let readback;
  try {
    readback = JSON.parse(await readFile(arg(args, "input"), "utf8"));
  } catch {
    fail("secret_inventory_json_invalid");
  }
  const context = await readJson(arg(args, "context"));
  const environment = arg(args, "environment");
  if (!/^(?:staging|production)$/.test(environment)) fail("environment_invalid");
  const names = context[`${environment}_secret_names`];
  if (!Array.isArray(names) || names.length === 0 || names.some((name) => typeof name !== "string")) fail("secret_inventory_expected_invalid");
  await writeJson(arg(args, "output"), validateSecretInventoryReadback(readback, names));
}

async function environmentPreflight(args) {
  const inventory = await readJson(arg(args, "secret-inventory"), "environment_preflight_secret_inventory_invalid");
  const receipt = await validateReleaseEnvironmentPreflight({
    repoRoot: arg(args, "repo-root"),
    environment: arg(args, "environment"),
    secretNames: inventory.secret_names,
  });
  if (inventory.status !== "matched" || inventory.secret_inventory_digest !== receipt.secret_inventory_digest) fail("environment_preflight_secret_inventory_drift");
  await writeJson(arg(args, "output"), receipt);
}

function parseLaunchProofEvidence(rawEvidence) {
  let evidence;
  try { evidence = json(JSON.parse(rawEvidence), "smoke_evidence_invalid"); } catch (error) {
    if (error?.message?.startsWith("release_promotion_")) throw error;
    fail("smoke_evidence_invalid");
  }
  if (
    evidence.proof !== "ironwrap-launch-proof-v4" ||
    evidence.operating_authority !== "d1" ||
    evidence.d1_lead?.state !== "matched" ||
    evidence.frappe_projection?.state !== "out_of_scope" ||
    evidence.bridge_keep_enabled !== true
  ) fail("smoke_not_proven");
  const steps = json(evidence.steps, "smoke_steps_invalid");
  const stepNames = Object.keys(steps).sort();
  if (JSON.stringify(stepNames) !== JSON.stringify([...LAUNCH_PROOF_STEP_NAMES].sort())) fail("smoke_step_set_invalid");
  if (Object.values(steps).some((step) => step?.http_status !== 200 || typeof step.request_id !== "string" || step.request_id.trim() === "")) fail("smoke_step_failed");
  return { evidence, steps, stepNames };
}

async function smokeReceipt(args) {
  const evidenceFile = arg(args, "evidence");
  const rawEvidence = await readFile(evidenceFile, "utf8");
  const { evidence, stepNames } = parseLaunchProofEvidence(rawEvidence);
  const sourceCommit = requireCommit(arg(args, "source-commit"), "source_commit_invalid");
  const revision = requireUuid(arg(args, "revision"), "revision_invalid");
  await writeJson(arg(args, "output"), {
    receipt_id: `launch-proof:${String(evidence.fixture?.envelope_id ?? "receipt").replace(/[^A-Za-z0-9._:/-]/g, "-")}`,
    workflow: "affected-workflow:authenticated-launch-proof",
    authenticated: true,
    result: "passed",
    affected_workflow_ids: stepNames,
    source_commit: sourceCommit,
    revision,
    evidence_digest: sha256(rawEvidence),
    observed_at: new Date().toISOString(),
  });
}

async function productionReceipt(args) {
  const sourceCommit = requireCommit(arg(args, "source-commit"), "source_commit_invalid");
  const sourceTreeSha256 = requireHash(arg(args, "source-tree"), "source_tree_invalid");
  const artifactDigest = requireHash(arg(args, "artifact-digest"), "artifact_digest_invalid");
  const configDigest = requireHash(arg(args, "config-digest"), "config_digest_invalid");
  const revision = requireUuid(arg(args, "version-id"), "version_id_invalid");
  const versionDigest = requireHash(arg(args, "version-digest"), "version_digest_invalid");
  const permitPayload = await readJson(arg(args, "permit-payload"), "permit_payload_invalid");
  if (
    permitPayload.source_commit !== sourceCommit ||
    permitPayload.source_tree_sha256 !== sourceTreeSha256 ||
    permitPayload.worker?.artifact_digest !== artifactDigest ||
    permitPayload.worker?.production_config_digest !== configDigest ||
    permitPayload.worker?.production_version_id !== revision ||
    permitPayload.worker?.production_version_digest !== versionDigest
  )
    fail("production_receipt_permit_drift");
  const mergeReceipt = await readJson(arg(args, "merge-receipt"), "merge_receipt_invalid");
  validateSourceMergeReceipt(mergeReceipt, permitPayload);
  const mergeReceiptDigest = sha256(canonicalJson(mergeReceipt));
  const leftoverFrappeDigest = sha256("frappe-not-required");
  let frappeRevision = "leftover-not-promoted";
  let frappeReadbackDigest = leftoverFrappeDigest;
  let servicePromotionDigest = leftoverFrappeDigest;
  let serviceReadbackDigest = leftoverFrappeDigest;
  if (hasArg(args, "service-promotion-receipt")) {
    const servicePublicKey = await readFile(
      arg(args, "service-public-key"),
      "utf8",
    );
    const serviceExpected = {
      repository: permitPayload.repository,
      source_commit: permitPayload.source_commit,
      source_git_tree: permitPayload.source_git_tree,
      aggregate_artifact_digest: permitPayload.worker.artifact_digest,
      merge_commit: mergeReceipt.merge_commit,
      "frappe.artifact_digest":
        permitPayload.release_manifest.artifacts.frappe_wheel_digest,
      "frappe.site_schema_digest":
        permitPayload.release_manifest.artifacts.frappe_site_schema_digest,
      "frappe.previous_revision":
        permitPayload.release_manifest.recovery.prior_frappe_revision,
      "frappe.candidate_revision":
        permitPayload.release_manifest.production_candidates.frappe_revision,
      "frappe.provider_readback_digest":
        permitPayload.release_manifest.production_candidates
          .frappe_readback_digest,
      provider_reconciliation_digest:
        permitPayload.release_manifest.provider_reconciliation.receipt_digest,
      issuer_principal: arg(args, "service-issuer-identity"),
      issuer_task_id: arg(args, "service-issuer-task-id"),
      issuer_run_id: arg(args, "service-issuer-run-id"),
      key_version: arg(args, "service-key-version"),
    };
    const servicePromotionToken = (
      await readFile(arg(args, "service-promotion-receipt"), "utf8")
    ).trim();
    const servicePromotion = verifyServiceAdapterReceipt(
      servicePublicKey,
      servicePromotionToken,
      { ...serviceExpected, operation: "promote" },
    );
    const serviceReadbackToken = (
      await readFile(arg(args, "service-readback-receipt"), "utf8")
    ).trim();
    const serviceReadback = verifyServiceAdapterReceipt(
      servicePublicKey,
      serviceReadbackToken,
      { ...serviceExpected, operation: "readback" },
    );
    if (
      Date.parse(serviceReadback.issued_at) <
      Date.parse(servicePromotion.issued_at)
    )
      fail("production_service_readback_stale");
    frappeRevision = serviceReadback.frappe.active_revision;
    frappeReadbackDigest = serviceReadback.frappe.provider_readback_digest;
    servicePromotionDigest = sha256(servicePromotionToken);
    serviceReadbackDigest = sha256(serviceReadbackToken);
  }
  const activeRevision = (await readFile(arg(args, "active"), "utf8")).trim();
  if (activeRevision !== revision) fail("production_active_revision_drift");
  const rawEvidence = await readFile(arg(args, "smoke"), "utf8");
  const { stepNames } = parseLaunchProofEvidence(rawEvidence);
  const healthRaw = await readFile(arg(args, "health"));
  const readyRaw = await readFile(arg(args, "ready"));
  let health;
  let ready;
  try {
    health = json(JSON.parse(healthRaw), "production_health_invalid");
    ready = json(JSON.parse(readyRaw), "production_ready_invalid");
  } catch (error) {
    if (error?.message?.startsWith("release_promotion_")) throw error;
    fail("production_readiness_json_invalid");
  }
  if (health.ok !== true || ready.ok !== true) fail("production_readiness_not_proven");
  const smokeEvidenceDigest = sha256(rawEvidence);
  const healthDigest = sha256(healthRaw);
  const readinessDigest = sha256(readyRaw);
  const fields = {
    source_commit: sourceCommit,
    source_tree_sha256: sourceTreeSha256,
    artifact_digest: artifactDigest,
    config_digest: configDigest,
    revision,
    version_digest: versionDigest,
    merge_commit: mergeReceipt.merge_commit,
    merge_receipt_digest: mergeReceiptDigest,
    pwa_revision: revision,
    pwa_readback_digest: versionDigest,
    frappe_revision: frappeRevision,
    frappe_readback_digest: frappeReadbackDigest,
    service_promotion_digest: servicePromotionDigest,
    service_readback_digest: serviceReadbackDigest,
    smoke_evidence_digest: smokeEvidenceDigest,
    smoke_result: "passed",
    smoke_step_names: stepNames,
    health_digest: healthDigest,
    readiness_digest: readinessDigest,
  };
  await writeJson(arg(args, "output"), validateProductionPromotionReceipt({
    schema: PRODUCTION_PROMOTION_SCHEMA,
    type: PRODUCTION_PROMOTION_TYPE,
    ...fields,
    active_revision: activeRevision,
    active_readback: "matched",
    evidence_digest: sha256(canonicalJson(fields)),
    observed_at: new Date().toISOString(),
  }));
}

async function backupReceipt(args) {
  const exportFile = arg(args, "export");
  const readbackFile = arg(args, "readback");
  const readback = await readJson(readbackFile, "backup_readback_invalid");
  if (readback.status !== "matched" || readback.result !== "passed" || readback.restored !== true || typeof readback.evidence_digest !== "string") fail("backup_readback_not_matched");
  const sourceCommit = requireCommit(arg(args, "source-commit"), "source_commit_invalid");
  const artifactDigest = requireHash(arg(args, "artifact-digest"), "artifact_digest_invalid");
  const generation = Number(arg(args, "source-generation"));
  if (!Number.isSafeInteger(generation) || generation < 0) fail("backup_generation_invalid");
  const exportBytes = await readFile(exportFile);
  if (exportBytes.length === 0 || readback.export_digest !== sha256(exportBytes)) fail("backup_export_drift");
  const evidenceDigest = sha256(canonicalJson({ export_digest: readback.export_digest, manifest_digest: readback.manifest_digest, restore_evidence_digest: readback.evidence_digest }));
  await writeJson(arg(args, "output"), {
    backup_id: `backup-staging:${sha256(exportBytes).slice(0, 24)}`,
    environment: "staging",
    isolated_target: arg(args, "target"),
    source_generation: generation,
    source_commit: sourceCommit,
    artifact_digest: artifactDigest,
    result: "passed",
    restored: true,
    readback: "matched",
    export_digest: readback.export_digest,
    manifest_digest: readback.manifest_digest,
    restore_evidence_digest: readback.evidence_digest,
    evidence_digest: evidenceDigest,
    observed_at: new Date().toISOString(),
  });
}

async function rollbackReceipt(args) {
  const sourceCommit = requireCommit(arg(args, "source-commit"), "source_commit_invalid");
  const candidate = requireUuid(arg(args, "candidate"), "candidate_revision_invalid");
  const previous = requireUuid(arg(args, "previous"), "previous_revision_invalid");
  const readback = (await readFile(arg(args, "readback"), "utf8")).trim();
  if (readback !== previous || previous === candidate) fail("rollback_readback_not_matched");
  const rePromoted = (await readFile(arg(args, "re-promoted"), "utf8")).trim();
  if (rePromoted !== candidate) fail("rollback_re_promote_not_matched");
  const healthRaw = await readFile(arg(args, "health"));
  const readyRaw = await readFile(arg(args, "ready"));
  const health = json(JSON.parse(healthRaw), "rollback_health_invalid");
  const ready = json(JSON.parse(readyRaw), "rollback_ready_invalid");
  if (health.ok !== true || ready.ok !== true) fail("rollback_readiness_not_proven");
  const smokeRaw = await readFile(arg(args, "smoke"), "utf8");
  const { evidence } = parseLaunchProofEvidence(smokeRaw);
  const smokeEvidenceDigest = sha256(smokeRaw);
  const fields = {
    drill_id: `rollback-staging:${candidate.slice(0, 24)}`,
    previous_revision: previous,
    candidate_revision: candidate,
    restored_revision: readback,
    re_promoted_revision: rePromoted,
    result: "passed",
    readback: "matched",
    health_digest: sha256(healthRaw),
    readiness_digest: sha256(readyRaw),
    smoke_evidence_digest: smokeEvidenceDigest,
    smoke_result: evidence.d1_lead?.state === "matched" && evidence.operating_authority === "d1" ? "passed" : "failed",
    source_commit: sourceCommit,
  };
  if (fields.smoke_result !== "passed") fail("rollback_smoke_not_passed");
  await writeJson(arg(args, "output"), {
    ...fields,
    evidence_digest: sha256(canonicalJson(fields)),
    observed_at: new Date().toISOString(),
  });
}

async function policyBoundary(args) {
  const boundary = createCloudflareD1ReplayBoundary({
    accountId: arg(args, "account-id"),
    databaseId: arg(args, "database-id"),
    apiToken: env("CLOUDFLARE_API_TOKEN"),
  });
  const state = await boundary.readPolicy({ key: arg(args, "key") });
  await writeJson(arg(args, "output"), state);
}

export const RELEASE_POLICY_FILES = [
  ".github/workflows/ci.yml",
  ".github/workflows/deploy.yml",
  "deploy/release-provider-policy.json",
  "docs/AUTHORITY-AND-EVIDENCE-CONTRACT.md",
  "docs/DOCUMENTATION-CONTRACT.md",
  "docs/COMPLIANCE-REGISTER.md",
  "tools/deploy-workflow.test.mjs",
  "tools/release-permit.mjs",
  "tools/release-permit.test.mjs",
  "tools/release-promotion.mjs",
  "tools/release-promotion.test.mjs",
];

export async function computeReleasePolicyHash(repoRoot) {
  const source = await Promise.all(RELEASE_POLICY_FILES.map(async (relative) => ({
    path: relative,
    sha256: sha256(await readFile(path.join(path.resolve(repoRoot), relative))),
  })));
  return sha256(canonicalJson(source));
}

async function policyGenesis(args) {
  const repository = arg(args, "repository");
  if (!REPOSITORY_RE.test(repository)) fail("repository_invalid");
  const key = arg(args, "key");
  if (key !== `release-policy:${repository}`) fail("policy_genesis_key_invalid");
  const boundary = createCloudflareD1ReplayBoundary({
    accountId: arg(args, "account-id"),
    databaseId: arg(args, "database-id"),
    apiToken: env("CLOUDFLARE_API_TOKEN"),
  });
  if (typeof boundary.ensurePolicy !== "function") fail("policy_genesis_boundary_required");
  const policyHash = await computeReleasePolicyHash(arg(args, "repo-root"));
  const state = await boundary.ensurePolicy({
    key,
    genesis: { generation: 0, policy_hash: policyHash },
  });
  await writeJson(arg(args, "output"), state);
}

async function assemblePermit(args) {
  const context = await readJson(arg(args, "context"));
  const repoRoot = arg(args, "repo-root");
  const sourceCommit = requireCommit(context.source_commit, "source_commit_invalid");
  const baseCommit = requireCommit(context.base_commit, "base_commit_invalid");
  const sourceTree = requireHash(context.source_tree_sha256, "source_tree_invalid");
  const sourceGitTree = requireCommit(context.source_git_tree, "source_git_tree_invalid");
  const diff = requireHash(context.diff_sha256, "diff_invalid");
  const repository = requireString(context.repository, "repository_invalid");
  if (!REPOSITORY_RE.test(repository)) fail("repository_invalid");
  const sourceEvidence = await computeSourceEvidence({ repoRoot, sourceCommit, baseCommit });
  for (const [key, expected] of [["source_commit", sourceCommit], ["base_commit", baseCommit], ["source_git_tree", sourceGitTree], ["source_tree_sha256", sourceTree], ["diff_sha256", diff]]) {
    if (sourceEvidence[key] !== expected) fail(`source_${key}_drift`);
  }
  const reviewerReceipt = await readFile(arg(args, "review-receipt"), "utf8");
  const reviewer = verifyReviewGoReceipt(await readFile(arg(args, "review-public-key"), "utf8"), reviewerReceipt, {
    repository,
    source_commit: sourceCommit,
    source_tree_sha256: sourceTree,
    diff_sha256: diff,
  });
  const staging = await readJson(arg(args, "staging"));
  const production = await readJson(arg(args, "production"));
  const smoke = await readJson(arg(args, "smoke"));
  const backupRestore = await readJson(arg(args, "backup-restore"));
  const productionRecovery = await readJson(arg(args, "production-recovery"));
  const rollback = await readJson(arg(args, "rollback"));
  const artifactComponents = exactObjectKeys(await readJson(arg(args, "artifact-manifest"), "artifact_manifest_invalid"), ["worker_digest", "pwa_digest", "frappe_wheel_digest", "artifact_manifest_digest"], "artifact_manifest_shape_invalid");
  const externalReceipt = (await readFile(arg(args, "release-evidence"), "utf8")).trim();
  const externalEvidence = verifyExternalReleaseEvidence(await readFile(arg(args, "evidence-public-key"), "utf8"), externalReceipt, {
    repository,
    pr_number: context.pr?.number,
    source_commit: sourceCommit,
    source_git_tree: sourceGitTree,
    artifact_digest: context.artifact_digest,
  });
  if (externalEvidence.issuer_principal === arg(args, "issuer-identity")) fail("release_evidence_not_independent");
  const stagingConfig = await computeEnvironmentConfigDigest({ repoRoot, environment: "staging" });
  const productionConfig = await computeEnvironmentConfigDigest({ repoRoot, environment: "production" });
  const configDigest = computeReleaseConfigDigest({ staging: stagingConfig.digest, production: productionConfig.digest });
  if (context.config_digest !== configDigest
    || staging.config_digest !== stagingConfig.digest
    || production.config_digest !== productionConfig.digest
    || staging.readback.secret_inventory_digest !== stagingConfig.secret_inventory_digest
    || production.readback.secret_inventory_digest !== productionConfig.secret_inventory_digest
    || staging.binding_manifest_digest !== stagingConfig.binding_manifest_digest
    || production.binding_manifest_digest !== productionConfig.binding_manifest_digest
    || staging.runtime_manifest_digest !== stagingConfig.runtime_manifest_digest
    || production.runtime_manifest_digest !== productionConfig.runtime_manifest_digest) fail("config_digest_drift");
  const migrations = await computeMigrationSet({ repoRoot });
  if (JSON.stringify(context.migrations) !== JSON.stringify(migrations)) fail("migration_set_drift");
  const computedSupplyChain = await computeSupplyChainEvidence({ repoRoot, sourceCommit, ciChecks: context.ci_checks });
  if (canonicalJson(context.supply_chain) !== canonicalJson(computedSupplyChain)
    || canonicalJson(externalEvidence.supply_chain) !== canonicalJson(computedSupplyChain)) fail("supply_chain_drift");
  const artifactManifestFields = {
    worker_digest: requireHash(artifactComponents.worker_digest, "worker_artifact_invalid"),
    pwa_digest: requireHash(artifactComponents.pwa_digest, "pwa_artifact_invalid"),
    frappe_wheel_digest: requireHash(artifactComponents.frappe_wheel_digest, "frappe_artifact_invalid"),
  };
  if (
    sha256(canonicalJson(artifactManifestFields)) !==
      artifactComponents.artifact_manifest_digest ||
    canonicalJson(context.artifacts) !== canonicalJson(artifactComponents) ||
    externalEvidence.service_identities.pwa.artifact_digest !==
      artifactManifestFields.pwa_digest ||
    externalEvidence.service_identities.frappe.artifact_digest !==
      artifactManifestFields.frappe_wheel_digest ||
    externalEvidence.service_identities.frappe.site_schema_digest !==
      context.frappe_schema_digest ||
    externalEvidence.service_identities.pwa.staging_revision !==
      staging.revision ||
    externalEvidence.service_identities.pwa.production_candidate_revision !==
      production.revision ||
    externalEvidence.service_identities.pwa
      .production_candidate_readback_digest !== production.version_digest
  )
    fail("artifact_manifest_drift");
  const previousGeneration = await readJson(arg(args, "policy"));
  if (!Number.isSafeInteger(previousGeneration.generation) || !SHA256_RE.test(previousGeneration.policy_hash)) fail("policy_state_invalid");
  const policyHash = await computeReleasePolicyHash(repoRoot);
  const now = Date.now();
  const issuerIdentity = requireString(args.get("issuer-identity"), "issuer_identity_invalid");
  if (!IDENTITY_RE.test(issuerIdentity) || issuerIdentity === reviewer.reviewer_principal) fail("issuer_identity_invalid");
  const nonce = randomBytes(48).toString("base64url");
  const providerIdentityDigest = sha256(canonicalJson({
    staging: {
      revision: staging.revision,
      version_digest: staging.version_digest,
      config_digest: staging.config_digest,
      binding_manifest_digest: staging.binding_manifest_digest,
      runtime_manifest_digest: staging.runtime_manifest_digest,
    },
    production: {
      revision: production.revision,
      version_digest: production.version_digest,
      config_digest: production.config_digest,
      binding_manifest_digest: production.binding_manifest_digest,
      runtime_manifest_digest: production.runtime_manifest_digest,
    },
  }));
  if (externalEvidence.provider_reconciliation.provider_identity_digest !== providerIdentityDigest) fail("provider_reconciliation_identity_drift");
  const previousProduction = exactObjectKeys(
    await readJson(
      arg(args, "production-previous-readback"),
      "production_previous_readback_invalid",
    ),
    ["schema", "revision", "provider_readback_digest", "status"],
    "production_previous_readback_shape_invalid",
  );
  if (
    previousProduction.schema !== "ironwrap_provider_version_snapshot_v1" ||
    previousProduction.status !== "matched"
  )
    fail("production_previous_readback_invalid");
  const previousProductionRevision = requireUuid(
    previousProduction.revision,
    "production_previous_revision_invalid",
  );
  const previousProductionReadback = requireHash(
    previousProduction.provider_readback_digest,
    "production_previous_readback_digest_invalid",
  );
  if (
    externalEvidence.recovery.prior_pwa_revision !==
      previousProductionRevision ||
    externalEvidence.recovery.prior_worker_readback_digest !==
      previousProductionReadback ||
    externalEvidence.recovery.prior_pwa_readback_digest !==
      previousProductionReadback
  )
    fail("production_previous_identity_drift");
  const configuration = {
    aggregate_digest: configDigest,
    tenant_digest: requireHash(context.component_digests?.tenant_config, "tenant_source_digest_invalid"),
    mcp_digest: requireHash(context.component_digests?.mcp, "mcp_source_digest_invalid"),
    hermes_digest: requireHash(context.component_digests?.hermes, "hermes_source_digest_invalid"),
    bindings_digest: sha256(canonicalJson({ production: context.production_binding_manifest_digest, staging: context.staging_binding_manifest_digest })),
    queues_digest: sha256(canonicalJson({ production: context.production_queues_digest, staging: context.staging_queues_digest })),
    buckets_digest: sha256(canonicalJson({ production: context.production_buckets_digest, staging: context.staging_buckets_digest })),
    routes_digest: sha256(canonicalJson({ production: context.production_routes_digest, source: context.routes_source_digest, staging: context.staging_routes_digest })),
    secret_names_digest: sha256(canonicalJson({ production: context.production_secret_inventory_digest, staging: context.staging_secret_inventory_digest })),
  };
  const manifestFields = {
    schema: RELEASE_MANIFEST_SCHEMA,
    pr: context.pr,
    source: {
      commit: sourceCommit,
      git_tree: sourceGitTree,
      tree_manifest_sha256: sourceTree,
      diff_sha256: diff,
      component_digests: context.component_digests,
    },
    supply_chain: computedSupplyChain,
    artifacts: {
      aggregate_digest: context.artifact_digest,
      ...artifactManifestFields,
      frappe_site_schema_digest: externalEvidence.service_identities.frappe.site_schema_digest,
      mcp_digest: context.component_digests.mcp,
      hermes_digest: context.component_digests.hermes,
      facet_digest: externalEvidence.service_identities.facet.artifact_digest,
      facet_integration_receipt_digest: externalEvidence.service_identities.facet.integration_receipt_digest,
    },
    configuration,
    migrations: {
      d1_set_digest: migrations.set_digest,
      frappe_schema_digest: context.frappe_schema_digest,
      frappe_migration_digest: context.frappe_migration_digest,
      compatibility: "expand-contract",
    },
    staging: {
      worker_revision: staging.revision,
      worker_readback_digest: staging.version_digest,
      pwa_revision: externalEvidence.service_identities.pwa.staging_revision,
      pwa_readback_digest: externalEvidence.service_identities.pwa.staging_readback_digest,
      frappe_revision: externalEvidence.service_identities.frappe.staging_revision,
      frappe_readback_digest: externalEvidence.service_identities.frappe.staging_readback_digest,
      affected_scope_evidence_digest: sha256(canonicalJson(externalEvidence.affected_scopes)),
      status: "matched",
    },
    production_candidates: {
      pwa_revision:
        externalEvidence.service_identities.pwa.production_candidate_revision,
      pwa_readback_digest:
        externalEvidence.service_identities.pwa
          .production_candidate_readback_digest,
      frappe_revision:
        externalEvidence.service_identities.frappe
          .production_candidate_revision,
      frappe_readback_digest:
        externalEvidence.service_identities.frappe
          .production_candidate_readback_digest,
      status: "prepared",
    },
    affected_scopes: externalEvidence.affected_scopes,
    recovery: {
      staging_backup_restore_digest: backupRestore.evidence_digest,
      staging_rollback_digest: rollback.evidence_digest,
      production_d1_recovery_digest: sha256(canonicalJson(productionRecovery)),
      prior_worker_revision: previousProductionRevision,
      prior_worker_readback_digest: previousProductionReadback,
      prior_pwa_revision: externalEvidence.recovery.prior_pwa_revision,
      prior_pwa_readback_digest:
        externalEvidence.recovery.prior_pwa_readback_digest,
      prior_frappe_revision: externalEvidence.recovery.prior_frappe_revision,
      prior_frappe_readback_digest:
        externalEvidence.recovery.prior_frappe_readback_digest,
      prior_frappe_backup_digest: externalEvidence.recovery.prior_frappe_backup_digest,
      status: "passed",
    },
    provider_reconciliation: externalEvidence.provider_reconciliation,
    business_evidence: externalEvidence.business_evidence,
    records: externalEvidence.records,
    external_evidence: {
      issuer_principal: externalEvidence.issuer_principal,
      issuer_task_id: externalEvidence.issuer_task_id,
      issuer_run_id: externalEvidence.issuer_run_id,
      key_version: externalEvidence.key_version,
      receipt_digest: sha256(externalReceipt),
    },
  };
  const releaseManifest = { ...manifestFields, evidence_digest: sha256(canonicalJson(manifestFields)) };
  const payload = {
    schema: "ironwrap_release_permit_v1",
    type: "ironwrap-release-permit",
    permit_id: `release:${repository}:${sourceCommit}:${nonce.slice(0, 16)}`,
    repository,
    source_commit: sourceCommit,
    base_commit: baseCommit,
    source_git_tree: sourceGitTree,
    source_tree_sha256: sourceTree,
    diff_sha256: diff,
    ci_checks: context.ci_checks,
    reviewer: {
      principal: reviewer.reviewer_principal,
      task_id: reviewer.reviewer_task_id,
      run_id: reviewer.reviewer_run_id,
      key_version: reviewer.review_key_version,
      decision: reviewer.decision,
      findings_digest: reviewer.findings_digest,
      unresolved_p0: reviewer.unresolved_p0,
      unresolved_p1: reviewer.unresolved_p1,
    },
    previous_generation: previousGeneration,
    generation: previousGeneration.generation + 1,
    policy_hash: policyHash,
    config_digest: configDigest,
    migrations,
    build_once: {
      source_commit: sourceCommit,
      source_tree_sha256: sourceTree,
      artifact_digest: requireHash(context.artifact_digest, "artifact_digest_invalid"),
      uploaded_once: true,
      upload_receipt_digest: requireHash(context.upload_receipt_digest, "upload_receipt_digest_invalid"),
    },
    worker: {
      artifact_digest: context.artifact_digest,
      staging_version_id: staging.revision,
      staging_version_digest: staging.version_digest,
      staging_config_digest: staging.config_digest,
      staging_secret_inventory_digest: staging.readback.secret_inventory_digest,
      production_version_id: production.revision,
      production_version_digest: production.version_digest,
      production_config_digest: production.config_digest,
      production_secret_inventory_digest: production.readback.secret_inventory_digest,
    },
    staging: {
      environment: "staging",
      revision: staging.revision,
      source_commit: sourceCommit,
      source_tree_sha256: sourceTree,
      artifact_digest: context.artifact_digest,
      config_digest: staging.config_digest,
      readback: staging.readback,
    },
    production: {
      environment: "production",
      revision: production.revision,
      source_commit: sourceCommit,
      source_tree_sha256: sourceTree,
      artifact_digest: context.artifact_digest,
      config_digest: production.config_digest,
      readback: production.readback,
    },
    smoke,
    backup_restore: backupRestore,
    production_recovery: productionRecovery,
    rollback,
    release_manifest: releaseManifest,
    issuer_identity: issuerIdentity,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 10 * 60_000).toISOString(),
    nonce,
  };
  const permit = signReleasePermit(await readFile(arg(args, "permit-private-key"), "utf8"), payload, { now });
  await writeFile(arg(args, "output"), `${permit}\n`, { mode: 0o600 });
  await writeJson(arg(args, "permit-payload"), payload);
}

async function mergePr(args) {
  const context = exactObjectKeys(await readJson(arg(args, "pr-context"), "pr_context_invalid"), [
    "schema",
    "repository",
    "number",
    "base_ref",
    "base_commit",
    "head_ref",
    "head_commit",
    "ci_run_id",
    "ci_merge_commit",
    "ci_merge_tree",
    "merge_method",
    "merge_policy",
    "provider_readback_digest",
    "status",
  ], "pr_context_shape_invalid");
  if (context.schema !== "ironwrap_pr_admission_v1" || context.status !== "open" || context.merge_method !== "squash") fail("pr_context_contract_invalid");
  validateMergePolicy(context.merge_policy, "pr_context_merge_policy_invalid");
  const permit = (await readFile(arg(args, "permit"), "utf8")).trim();
  const permitDigest = releasePermitDigest(permit);
  const payload = verifyReleasePermit(await readFile(arg(args, "permit-public-key"), "utf8"), permit, {
    repository: context.repository,
    source_commit: context.ci_merge_commit,
    base_commit: context.base_commit,
    source_git_tree: context.ci_merge_tree,
  });
  if (payload.release_manifest.pr.number !== context.number || payload.release_manifest.pr.head_commit !== context.head_commit) fail("pr_context_permit_drift");
  const admission = exactObjectKeys(await readJson(arg(args, "admission"), "admission_receipt_invalid"), ["ok", "status", "permit_digest", "generation"], "admission_receipt_shape_invalid");
  if (admission.ok !== true || admission.status !== "claimed" || admission.permit_digest !== permitDigest || admission.generation !== payload.generation) fail("admission_receipt_drift");
  const token = env("GH_TOKEN");
  const headers = reviewHeaders(token);
  await assertMergePolicyUnchanged({ repository: context.repository, expected: context.merge_policy, token });
  const prUrl = `https://api.github.com/repos/${context.repository}/pulls/${context.number}`;
  const pr = await githubJson(prUrl, headers, "merge_pr_readback_unavailable");
  const currentMain = await githubJson(`https://api.github.com/repos/${context.repository}/commits/main`, headers, "merge_main_readback_unavailable");
  if (pr.state !== "open"
    || pr.base?.sha !== context.base_commit
    || pr.head?.sha !== context.head_commit
    || pr.merge_commit_sha !== context.ci_merge_commit
    || pr.mergeable !== true
    || pr.mergeable_state !== "clean"
    || currentMain.sha !== context.base_commit) fail("merge_pr_drift");
  const response = await fetch(`https://api.github.com/repos/${context.repository}/pulls/${context.number}/merge`, {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ sha: context.head_commit, merge_method: "squash", commit_title: `Governed release PR #${context.number}` }),
  }).catch(() => null);
  const merged = await response?.json().catch(() => null);
  if (!response?.ok || !isRecord(merged) || merged.merged !== true || !COMMIT_RE.test(merged.sha)) fail("merge_pr_failed");
  const mergeCommit = await githubJson(`https://api.github.com/repos/${context.repository}/git/commits/${merged.sha}`, headers, "merge_commit_readback_unavailable");
  const mainReadback = await githubJson(`https://api.github.com/repos/${context.repository}/commits/main`, headers, "merge_main_readback_unavailable");
  const prReadback = await githubJson(prUrl, headers, "merge_pr_readback_unavailable");
  if (mergeCommit.sha !== merged.sha
    || mergeCommit.tree?.sha !== context.ci_merge_tree
    || mainReadback.sha !== merged.sha
    || prReadback.state !== "closed"
    || prReadback.merged !== true
    || prReadback.merge_commit_sha !== merged.sha) fail("merge_readback_drift");
  const fields = {
    schema: "ironwrap_source_admission_merge_v1",
    repository: context.repository,
    pr_number: context.number,
    head_commit: context.head_commit,
    base_commit: context.base_commit,
    ci_merge_commit: context.ci_merge_commit,
    expected_tree: context.ci_merge_tree,
    merge_method: context.merge_method,
    provider_settings_digest: context.merge_policy.readback_digest,
    merge_commit: merged.sha,
    merge_tree: mergeCommit.tree.sha,
    main_commit: mainReadback.sha,
    permit_digest: permitDigest,
    admission_digest: sha256(canonicalJson(admission)),
    status: "merged",
  };
  const receipt = validateSourceMergeReceipt({
    ...fields,
    evidence_digest: sha256(canonicalJson(fields)),
    observed_at: new Date().toISOString(),
  }, payload, { permitDigest });
  await writeJson(arg(args, "output"), receipt);
}

/**
 * Post-merge counterpart to `mergePr`.
 *
 * A push-sourced release is admitted once its squash commit is already `main`'s
 * tip, so there is nothing left to merge — this reads the same source-merge
 * receipt back out of the provider instead of producing it by mutation. Every
 * field the permit, service adapter, rollback, and recovery receipts consume is
 * identical in shape and meaning; only the `PUT .../merge` call is absent, and
 * the readbacks that `mergePr` performs *after* merging are performed here as
 * the admission itself.
 */
async function mergedSource(args) {
  const context = exactObjectKeys(await readJson(arg(args, "pr-context"), "pr_context_invalid"), [
    "schema",
    "repository",
    "number",
    "base_ref",
    "base_commit",
    "head_ref",
    "head_commit",
    "ci_run_id",
    "ci_merge_commit",
    "ci_merge_tree",
    "merge_method",
    "merge_policy",
    "provider_readback_digest",
    "status",
  ], "pr_context_shape_invalid");
  if (context.schema !== "ironwrap_pr_admission_v1" || context.status !== "merged" || context.merge_method !== "squash") fail("pr_context_contract_invalid");
  validateMergePolicy(context.merge_policy, "pr_context_merge_policy_invalid");
  const permit = (await readFile(arg(args, "permit"), "utf8")).trim();
  const permitDigest = releasePermitDigest(permit);
  const payload = verifyReleasePermit(await readFile(arg(args, "permit-public-key"), "utf8"), permit, {
    repository: context.repository,
    source_commit: context.ci_merge_commit,
    base_commit: context.base_commit,
    source_git_tree: context.ci_merge_tree,
  });
  if (payload.release_manifest.pr.number !== context.number || payload.release_manifest.pr.head_commit !== context.head_commit) fail("pr_context_permit_drift");
  const admission = exactObjectKeys(await readJson(arg(args, "admission"), "admission_receipt_invalid"), ["ok", "status", "permit_digest", "generation"], "admission_receipt_shape_invalid");
  if (admission.ok !== true || admission.status !== "claimed" || admission.permit_digest !== permitDigest || admission.generation !== payload.generation) fail("admission_receipt_drift");
  const token = env("GH_TOKEN");
  const headers = reviewHeaders(token);
  await assertMergePolicyUnchanged({ repository: context.repository, expected: context.merge_policy, token });
  const pr = await githubJson(`https://api.github.com/repos/${context.repository}/pulls/${context.number}`, headers, "merged_source_pr_readback_unavailable");
  const mergeCommit = await githubJson(`https://api.github.com/repos/${context.repository}/git/commits/${context.ci_merge_commit}`, headers, "merged_source_commit_readback_unavailable");
  const mainReadback = await githubJson(`https://api.github.com/repos/${context.repository}/commits/main`, headers, "merged_source_main_readback_unavailable");
  if (pr.state !== "closed"
    || pr.merged !== true
    || pr.base?.ref !== "main"
    || pr.head?.sha !== context.head_commit
    || pr.merge_commit_sha !== context.ci_merge_commit
    || mergeCommit.sha !== context.ci_merge_commit
    || mergeCommit.tree?.sha !== context.ci_merge_tree
    || !Array.isArray(mergeCommit.parents)
    || mergeCommit.parents.length !== 1
    || mergeCommit.parents[0]?.sha !== context.base_commit
    || mainReadback.sha !== context.ci_merge_commit) fail("merged_source_drift");
  const fields = {
    schema: "ironwrap_source_admission_merge_v1",
    repository: context.repository,
    pr_number: context.number,
    head_commit: context.head_commit,
    base_commit: context.base_commit,
    ci_merge_commit: context.ci_merge_commit,
    expected_tree: context.ci_merge_tree,
    merge_method: context.merge_method,
    provider_settings_digest: context.merge_policy.readback_digest,
    merge_commit: context.ci_merge_commit,
    merge_tree: mergeCommit.tree.sha,
    main_commit: mainReadback.sha,
    permit_digest: permitDigest,
    admission_digest: sha256(canonicalJson(admission)),
    status: "merged",
  };
  const receipt = validateSourceMergeReceipt({
    ...fields,
    evidence_digest: sha256(canonicalJson(fields)),
    observed_at: new Date().toISOString(),
  }, payload, { permitDigest });
  await writeJson(arg(args, "output"), receipt);
}

async function admit(args, advance = false) {
  const boundary = createCloudflareD1ReplayBoundary({
    accountId: arg(args, "account-id"),
    databaseId: arg(args, "database-id"),
    apiToken: env("CLOUDFLARE_API_TOKEN"),
  });
  const permit = (await readFile(arg(args, "permit"), "utf8")).trim();
  const publicKey = await readFile(arg(args, "permit-public-key"), "utf8");
  const productionReceipt = advance ? await readJson(arg(args, "production-receipt"), "production_receipt_invalid") : undefined;
  const mergeReceipt = advance ? await readJson(arg(args, "merge-receipt"), "merge_receipt_invalid") : undefined;
  const result = advance
    ? await advanceReleaseGeneration(publicKey, permit, { boundary, policyKey: arg(args, "policy-key"), productionReceipt, mergeReceipt })
    : await admitReleasePermit(publicKey, permit, { boundary, policyKey: arg(args, "policy-key") });
  await writeJson(arg(args, "output"), advance
    ? result
    : { ok: true, status: result.claim.status, permit_digest: releasePermitDigest(permit), generation: result.payload.generation });
}

async function persistRollback(args) {
  const boundary = createCloudflareD1ReplayBoundary({
    accountId: arg(args, "account-id"),
    databaseId: arg(args, "database-id"),
    apiToken: env("CLOUDFLARE_API_TOKEN"),
  });
  const permit = (await readFile(arg(args, "permit"), "utf8")).trim();
  const result = await persistRollbackOutcome(await readFile(arg(args, "permit-public-key"), "utf8"), permit, {
    boundary,
    mergeReceipt: await readJson(arg(args, "merge-receipt"), "merge_receipt_invalid"),
    rollbackReceipt: await readJson(arg(args, "rollback-receipt"), "rollback_receipt_invalid"),
  });
  await writeJson(arg(args, "output"), result);
}

async function persistRecoveryRequired(args) {
  const boundary = createCloudflareD1ReplayBoundary({
    accountId: arg(args, "account-id"),
    databaseId: arg(args, "database-id"),
    apiToken: env("CLOUDFLARE_API_TOKEN"),
  });
  const permit = (await readFile(arg(args, "permit"), "utf8")).trim();
  const result = await persistRecoveryRequiredOutcome(await readFile(arg(args, "permit-public-key"), "utf8"), permit, {
    boundary,
    mergeReceipt: await readJson(arg(args, "merge-receipt"), "merge_receipt_invalid"),
    failureStage: arg(args, "failure-stage"),
  });
  await writeJson(arg(args, "output"), result);
}

async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const args = argsFrom(rest);
  if (command === "pr-context") return prContext(args);
  if (command === "push-context") return pushContext(args);
  if (command === "source-evidence") return sourceEvidence(args);
  if (command === "issuer-request") return issuerRequest(args);
  if (command === "review-receipt") return reviewReceipt(args);
  if (command === "review-wait") return reviewWait(args);
  if (command === "review-sign") return reviewSign(args);
  if (command === "review-publish") return reviewPublish(args);
  if (command === "release-evidence-wait") return releaseEvidenceWait(args);
  if (command === "release-evidence-sign") return releaseEvidenceSign(args);
  if (command === "release-evidence-publish") return releaseEvidencePublish(args);
  if (command === "service-adapter-sign") return serviceAdapterSign(args);
  if (command === "service-adapter") return serviceAdapter(args);
  if (command === "admission-context") return admissionContext(args);
  if (command === "artifact-manifest") return artifactManifest(args);
  if (command === "bind-artifact") return bindArtifact(args);
  if (command === "context-field") return contextField(args);
  if (command === "version-message") return versionMessage(args);
  if (command === "deployment-revision") return deploymentRevision(args);
  if (command === "version-snapshot") return versionSnapshot(args);
  if (command === "deployment-rollback-readback") return deploymentRollbackReadback(args);
  if (command === "staging-cleanup-receipt") return stagingCleanupReceipt(args);
  if (command === "readiness") return readiness(args);
  if (command === "restore-query") return restoreQuery(args);
  if (command === "restore-readback") return restoreReadback(args);
  if (command === "d1-recovery-point") return d1RecoveryPoint(args);
  if (command === "production-rollback-receipt") return productionRollbackReceipt(args);
  if (command === "production-receipt") return productionReceipt(args);
  if (command === "ci-checks") return collectCiChecks(args);
  if (command === "config-digest") return configDigest(args);
  if (command === "provider-targets") return providerTargets(args);
  if (command === "parse-version") return parseVersion(args);
  if (command === "version-readback") return versionReadback(args);
  if (command === "secret-readback") return secretReadback(args);
  if (command === "environment-preflight") return environmentPreflight(args);
  if (command === "smoke-receipt") return smokeReceipt(args);
  if (command === "backup-receipt") return backupReceipt(args);
  if (command === "rollback-receipt") return rollbackReceipt(args);
  if (command === "policy") return policyBoundary(args);
  if (command === "policy-genesis") return policyGenesis(args);
  if (command === "assemble") return assemblePermit(args);
  if (command === "admit") return admit(args, false);
  if (command === "merge-pr") return mergePr(args);
  if (command === "merged-source") return mergedSource(args);
  if (command === "advance") return admit(args, true);
  if (command === "persist-rollback") return persistRollback(args);
  if (command === "persist-recovery-required") return persistRecoveryRequired(args);
  fail("cli_usage");
}

if (import.meta.url === `file://${process.argv[1]}`) await main();

export {
  assemblePermit,
  collectCiChecks,
  configDigest,
  main,
};
