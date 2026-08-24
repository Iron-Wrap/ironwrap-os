import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  assertMergePolicyUnchanged,
  collectCiChecks,
  computeReleasePolicyHash,
  main,
  RELEASE_POLICY_FILES,
  requestIndependentIssuer,
  requestServiceAdapter,
  validateIndependentIssuerRequest,
} from "./release-promotion.mjs";
import {
  signServiceAdapterReceipt,
  verifyReviewGoReceipt,
  verifyServiceAdapterReceipt,
} from "./release-permit.mjs";
import { canonicalJson } from "../mcp/erpnext-roofing-mcp/src/approval-contract.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const COMMIT = "a".repeat(40);
const BASE = "e".repeat(40);
const HEAD = "f".repeat(40);
const GIT_TREE = "1".repeat(40);
const MERGE_COMMIT = "2".repeat(40);
const TREE = "b".repeat(64);
const ARTIFACT = "c".repeat(64);
const CONFIG = "d".repeat(64);
const STAGING = "11111111-1111-4111-8111-111111111111";
const PRODUCTION = "22222222-2222-4222-8222-222222222222";
const ISSUER_NOW = Date.parse("2026-08-23T00:00:00.000Z");
const ISSUER_REQUESTED_AT = "2026-08-22T23:59:00.000Z";
const ISSUER_EXPIRES_AT = "2026-08-23T00:04:00.000Z";
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const V4_SMOKE_STEPS = [
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
];
function v4SmokeEvidence(overrides = {}) {
  return {
    proof: "ironwrap-launch-proof-v4",
    operating_authority: "d1",
    fixture: { envelope_id: "env-123" },
    bridge_keep_enabled: true,
    frappe_projection: { state: "out_of_scope" },
    d1_lead: { state: "matched", envelope_id: "env-123", tenant_id: "ironwrap" },
    steps: Object.fromEntries(
      V4_SMOKE_STEPS.map((name) => [name, { http_status: 200, request_id: `req-${name}` }]),
    ),
    ...overrides,
  };
}
function mergePolicyFixture() {
  const fields = {
    schema: "ironwrap_github_merge_policy_v1",
    method: "squash",
    repository_settings: { default_branch: "main", allow_merge_commit: false, allow_squash_merge: true, allow_rebase_merge: true },
    ruleset: { id: 20652124, target: "branch", enforcement: "active", allowed_merge_methods: ["rebase", "squash"] },
  };
  return { ...fields, readback_digest: sha(canonicalJson(fields)) };
}
const FRAPPE_ARTIFACT = sha("frappe-wheel");
const FRAPPE_SCHEMA = sha("frappe-site-schema");
const FRAPPE_PREVIOUS = "frappe-production-previous";
const FRAPPE_CANDIDATE = "frappe-production-candidate";
const FRAPPE_BACKUP = sha("frappe-backup");
const WORKER_PREVIOUS_READBACK = sha("worker-previous-readback");
const FRAPPE_PREVIOUS_READBACK = sha("frappe-previous-readback");
const FRAPPE_CANDIDATE_READBACK = sha("frappe-candidate-readback");
const PROVIDER_RECONCILIATION = sha("provider-reconciliation");
const run = promisify(execFile);

async function tempRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ironwrap-release-promotion-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function minimalPermitPayload({
  previous = STAGING,
  candidate = PRODUCTION,
} = {}) {
  return {
    repository: "Iron-Wrap/ironwrap-os",
    base_commit: BASE,
    source_commit: COMMIT,
    source_git_tree: GIT_TREE,
    source_tree_sha256: TREE,
    worker: {
      artifact_digest: ARTIFACT,
      production_config_digest: CONFIG,
      production_version_id: candidate,
      production_version_digest: sha("version"),
    },
    release_manifest: {
      pr: { number: 43, head_commit: HEAD, merge_policy: mergePolicyFixture() },
      artifacts: {
        frappe_wheel_digest: FRAPPE_ARTIFACT,
        frappe_site_schema_digest: FRAPPE_SCHEMA,
      },
      recovery: {
        prior_worker_revision: previous,
        prior_worker_readback_digest: WORKER_PREVIOUS_READBACK,
        prior_pwa_revision: previous,
        prior_pwa_readback_digest: WORKER_PREVIOUS_READBACK,
        prior_frappe_revision: FRAPPE_PREVIOUS,
        prior_frappe_readback_digest: FRAPPE_PREVIOUS_READBACK,
        prior_frappe_backup_digest: FRAPPE_BACKUP,
      },
      production_candidates: {
        pwa_revision: candidate,
        pwa_readback_digest: sha("version"),
        frappe_revision: FRAPPE_CANDIDATE,
        frappe_readback_digest: FRAPPE_CANDIDATE_READBACK,
      },
      provider_reconciliation: { receipt_digest: PROVIDER_RECONCILIATION },
    },
  };
}

function serviceReceiptFields(operation, now = Date.now()) {
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
      artifact_digest: FRAPPE_ARTIFACT,
      site_schema_digest: FRAPPE_SCHEMA,
      previous_revision: FRAPPE_PREVIOUS,
      candidate_revision: FRAPPE_CANDIDATE,
      active_revision:
        operation === "rollback" ? FRAPPE_PREVIOUS : FRAPPE_CANDIDATE,
      backup_digest: FRAPPE_BACKUP,
      provider_readback_digest:
        operation === "rollback"
          ? FRAPPE_PREVIOUS_READBACK
          : FRAPPE_CANDIDATE_READBACK,
      status: "matched",
    },
    provider_reconciliation_digest: PROVIDER_RECONCILIATION,
    result: "passed",
    issuer_principal: "service-release@ironwrapexteriors.com",
    issuer_task_id: "frappe-release-adapter",
    issuer_run_id: "github:31970000001:1",
    key_version: "service-key-2026-08",
    issued_at: new Date(now - 1_000).toISOString(),
    expires_at: new Date(now + 20 * 60_000).toISOString(),
    nonce: `service${operation}0123456789abcdef0123456789abcdef0123456789`,
  };
}

function signedServiceReceipt(privateKey, { operation, now = Date.now() }) {
  return signServiceAdapterReceipt(
    privateKey,
    serviceReceiptFields(operation, now),
    { now },
  );
}

test("CLI parses exactly one pinned Wrangler version identity", async (t) => {
  const root = await tempRoot(t);
  const input = path.join(root, "upload.log");
  const output = path.join(root, "version.id");
  await writeFile(input, "\u001b[32mUploaded ironwrap-bus\u001b[0m\nWorker Version ID: 11111111-1111-4111-8111-111111111111\n");
  await main(["parse-version", "--input", input, "--output", output]);
  assert.equal((await readFile(output, "utf8")).trim(), STAGING);
  await writeFile(input, `Worker Version ID: ${STAGING}\nWorker Version ID: ${PRODUCTION}\n`);
  await assert.rejects(() => main(["parse-version", "--input", input, "--output", output]), /release_permit_version_id_ambiguous/);
});

test("machine service-adapter signer emits a bounded exact provider receipt", async (t) => {
  const root = await tempRoot(t);
  const input = path.join(root, "service-input.json");
  const privateKeyFile = path.join(root, "service.key");
  const output = path.join(root, "service.receipt");
  const keys = generateKeyPairSync("ed25519");
  await writeFile(input, JSON.stringify(serviceReceiptFields("promote")));
  await writeFile(
    privateKeyFile,
    keys.privateKey.export({ type: "pkcs8", format: "pem" }),
  );
  await main([
    "service-adapter-sign",
    "--input",
    input,
    "--adapter-private-key",
    privateKeyFile,
    "--output",
    output,
  ]);
  const verified = verifyServiceAdapterReceipt(
    keys.publicKey,
    (await readFile(output, "utf8")).trim(),
    {
      operation: "promote",
      "frappe.candidate_revision": FRAPPE_CANDIDATE,
      "frappe.active_revision": FRAPPE_CANDIDATE,
    },
  );
  assert.equal(verified.result, "passed");
});

test("service adapter client posts an exact authenticated request and rejects drift", async () => {
  const keys = generateKeyPairSync("ed25519");
  const receipt = signedServiceReceipt(keys.privateKey, {
    operation: "promote",
  });
  const request = {
    schema: "ironwrap_service_adapter_request_v1",
    operation: "promote",
    release_permit: "signed-permit.payload",
    source_merge_receipt: {
      schema: "ironwrap_source_admission_merge_v1",
      merge_commit: MERGE_COMMIT,
    },
    expected: {
      repository: "Iron-Wrap/ironwrap-os",
      source_commit: COMMIT,
      issuer: {
        principal: "service-release@ironwrapexteriors.com",
        task_id: "frappe-release-adapter",
        run_id: "github:31970000001:1",
        key_version: "service-key-2026-08",
      },
    },
  };
  const expected = {
    operation: "promote",
    repository: "Iron-Wrap/ironwrap-os",
    source_commit: COMMIT,
    source_git_tree: GIT_TREE,
    aggregate_artifact_digest: ARTIFACT,
    merge_commit: MERGE_COMMIT,
    "frappe.candidate_revision": FRAPPE_CANDIDATE,
    "frappe.provider_readback_digest": FRAPPE_CANDIDATE_READBACK,
    issuer_principal: "service-release@ironwrapexteriors.com",
    issuer_task_id: "frappe-release-adapter",
    issuer_run_id: "github:31970000001:1",
    key_version: "service-key-2026-08",
  };
  let observed;
  const fetchImpl = async (url, init) => {
    observed = { url: String(url), init };
    return new Response(JSON.stringify({ receipt }), { status: 200 });
  };
  const result = await requestServiceAdapter({
    url: "https://release-adapter.example.invalid/v1/promote",
    apiToken: "adapter-token-value",
    request,
    publicKey: keys.publicKey,
    expected,
    fetchImpl,
  });
  assert.equal(result.payload.frappe.active_revision, FRAPPE_CANDIDATE);
  assert.equal(
    observed.url,
    "https://release-adapter.example.invalid/v1/promote",
  );
  assert.equal(
    observed.init.headers.authorization,
    "Bearer adapter-token-value",
  );
  assert.equal(observed.init.body, canonicalJson(request));
  await assert.rejects(
    () =>
      requestServiceAdapter({
        url: "http://release-adapter.example.invalid",
        apiToken: "token",
        request,
        publicKey: keys.publicKey,
        expected,
        fetchImpl,
      }),
    /release_promotion_service_adapter_url_invalid/,
  );
  await assert.rejects(
    () =>
      requestServiceAdapter({
        url: "https://release-adapter.example.invalid",
        apiToken: "token",
        request: { ...request, ignored: true },
        publicKey: keys.publicKey,
        expected,
        fetchImpl,
      }),
    /release_promotion_service_adapter_request_shape_invalid/,
  );
  await assert.rejects(
    () =>
      requestServiceAdapter({
        url: "https://release-adapter.example.invalid",
        apiToken: "token",
        request,
        publicKey: keys.publicKey,
        expected: { ...expected, "frappe.candidate_revision": "wrong" },
        fetchImpl,
      }),
    /release_permit_service_adapter_frappe_candidate_revision_drift/,
  );
});

function independentIssuerRequestFixture(overrides = {}) {
  return {
    schema: "ironwrap_independent_issuer_request_v2",
    phase: "review",
    repository: "Iron-Wrap/ironwrap-os",
    pr_number: 43,
    base_commit: BASE,
    head_commit: HEAD,
    source_commit: COMMIT,
    source_git_tree: GIT_TREE,
    source_tree_sha256: TREE,
    diff_sha256: sha("diff"),
    ci_run_id: "31970000001",
    candidate_artifact: {
      actions_run_id: "31970000002",
      actions_run_attempt: "1",
      name: "iro41-review-candidate",
      content_digest: ARTIFACT,
    },
    publication: {
      ref: `release-review/${COMMIT}`,
      path: `.release/reviews/${COMMIT}.json`,
    },
    receipt_key: {
      public_key_sha256: sha("issuer-public-key"),
      key_version: "review-key-2026-08",
    },
    requested_at: ISSUER_REQUESTED_AT,
    expires_at: ISSUER_EXPIRES_AT,
    requested_by: "release-admission@ironwrapexteriors.com",
    expected_issuer: {
      principal: "independent-reviewer@ironwrapexteriors.com",
      task_id: "independent-source-review",
    },
    ...overrides,
  };
}

test("independent issuer trigger binds exact artifact, principal, and eventual receipt run", async () => {
  const request = independentIssuerRequestFixture();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ acknowledgement: {
      schema: "ironwrap_independent_issuer_ack_v1",
      status: "accepted",
      phase: request.phase,
      repository: request.repository,
      source_commit: request.source_commit,
      request_digest: sha(init.body),
      issuer_principal: request.expected_issuer.principal,
      issuer_task_id: request.expected_issuer.task_id,
      issuer_run_id: "issuer-run-31970000003",
      key_version: request.receipt_key.key_version,
      accepted_at: "2026-08-17T08:00:00.000Z",
    } }), { status: 202 });
  };
  const ack = await requestIndependentIssuer({ url: "https://issuer.example.invalid/v2/independent-issuer", apiToken: "issuer-trigger-token", request, fetchImpl, now: () => ISSUER_NOW });
  assert.equal(ack.status, "accepted");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, "Bearer issuer-trigger-token");
  assert.equal(calls[0].init.body, canonicalJson(request));
  await assert.rejects(() => requestIndependentIssuer({ url: "https://issuer.example.invalid/v2/independent-issuer", apiToken: "token", request: { ...request, requested_by: request.expected_issuer.principal }, fetchImpl, now: () => ISSUER_NOW }), /release_promotion_issuer_request_identity_invalid/);
  await assert.rejects(() => requestIndependentIssuer({ url: "https://issuer.example.invalid/v1/independent-issuer", apiToken: "token", request, fetchImpl, now: () => ISSUER_NOW }), /release_promotion_issuer_url_invalid/);
  await assert.rejects(() => requestIndependentIssuer({ url: "http://issuer.example.invalid/v2/independent-issuer", apiToken: "token", request, fetchImpl, now: () => ISSUER_NOW }), /release_promotion_issuer_url_invalid/);
  const tamperedFetch = async () => new Response(JSON.stringify({ acknowledgement: {
    schema: "ironwrap_independent_issuer_ack_v1",
    status: "accepted",
    phase: request.phase,
    repository: request.repository,
    source_commit: request.source_commit,
    request_digest: "0".repeat(64),
    issuer_principal: request.expected_issuer.principal,
    issuer_task_id: request.expected_issuer.task_id,
    issuer_run_id: "issuer-run-31970000004",
    key_version: request.receipt_key.key_version,
    accepted_at: "2026-08-17T08:00:00.000Z",
  } }), { status: 202 });
  await assert.rejects(
    () => requestIndependentIssuer({ url: "https://issuer.example.invalid/v2/independent-issuer", apiToken: "token", request, fetchImpl: tamperedFetch, now: () => ISSUER_NOW }),
    /release_promotion_issuer_ack_request_digest_drift/,
  );
});

test("independent issuer client rejects stale or unsafe freshness windows before transport", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response("{}", { status: 202 });
  };
  const url = "https://issuer.example.invalid/v2/independent-issuer";
  const valid = independentIssuerRequestFixture();
  assert.equal(validateIndependentIssuerRequest(valid, () => ISSUER_NOW), valid);
  const invoke = (request) => requestIndependentIssuer({
    url,
    apiToken: "issuer-trigger-token",
    request,
    fetchImpl,
    now: () => ISSUER_NOW,
  });

  await assert.rejects(
    () => invoke({ ...valid, schema: "ironwrap_independent_issuer_request_v1" }),
    /release_promotion_issuer_request_invalid/,
  );
  await assert.rejects(
    () => invoke({ ...valid, requested_at: "2026-08-22T23:59:00Z" }),
    /release_promotion_issuer_requested_at_invalid/,
  );
  await assert.rejects(
    () => invoke({ ...valid, expires_at: "2026-08-23T00:04:00Z" }),
    /release_promotion_issuer_expires_at_invalid/,
  );
  await assert.rejects(
    () => invoke({
      ...valid,
      requested_at: "2026-08-22T23:50:00.000Z",
      expires_at: "2026-08-22T23:59:59.999Z",
    }),
    /release_promotion_issuer_request_expired/,
  );
  await assert.rejects(
    () => invoke({ ...valid, expires_at: "2026-08-23T00:10:00.001Z" }),
    /release_promotion_issuer_request_lifetime_invalid/,
  );
  await assert.rejects(
    () => invoke({
      ...valid,
      requested_at: "2026-08-23T00:02:00.000Z",
      expires_at: "2026-08-23T00:01:00.000Z",
    }),
    /release_promotion_issuer_request_time_order_invalid/,
  );
  await assert.rejects(
    () => invoke({
      ...valid,
      requested_at: "2026-08-23T00:01:00.001Z",
      expires_at: "2026-08-23T00:05:00.001Z",
    }),
    /release_promotion_issuer_request_future_invalid/,
  );
  assert.equal(calls, 0);
});

test("issuer-request emits canonical five-minute v2 freshness windows for both phases", async (t) => {
  const root = await tempRoot(t);
  const sourceFile = path.join(root, "source.json");
  const prFile = path.join(root, "pr.json");
  const publicKeyFile = path.join(root, "issuer.pub");
  await writeFile(sourceFile, JSON.stringify({
    repository: "Iron-Wrap/ironwrap-os",
    source_commit: COMMIT,
    source_git_tree: GIT_TREE,
    source_tree_sha256: TREE,
    diff_sha256: sha("diff"),
    base_commit: BASE,
  }));
  await writeFile(prFile, JSON.stringify({
    repository: "Iron-Wrap/ironwrap-os",
    number: 43,
    ci_merge_commit: COMMIT,
    ci_merge_tree: GIT_TREE,
    base_commit: BASE,
    head_commit: HEAD,
    ci_run_id: "31970000001",
  }));
  await writeFile(publicKeyFile, "synthetic issuer public key");
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.RELEASE_INDEPENDENT_ISSUER_TOKEN;
  process.env.RELEASE_INDEPENDENT_ISSUER_TOKEN = "issuer-trigger-token";
  let observed;
  globalThis.fetch = async (url, init) => {
    observed = { url: String(url), init };
    const request = JSON.parse(init.body);
    return new Response(JSON.stringify({ acknowledgement: {
      schema: "ironwrap_independent_issuer_ack_v1",
      status: "accepted",
      phase: request.phase,
      repository: request.repository,
      source_commit: request.source_commit,
      request_digest: sha(canonicalJson(request)),
      issuer_principal: request.expected_issuer.principal,
      issuer_task_id: request.expected_issuer.task_id,
      issuer_run_id: "issuer-run-31970000003",
      key_version: request.receipt_key.key_version,
      accepted_at: new Date().toISOString(),
    } }), { status: 202 });
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.RELEASE_INDEPENDENT_ISSUER_TOKEN;
    else process.env.RELEASE_INDEPENDENT_ISSUER_TOKEN = previousToken;
  });

  for (const phase of ["review", "release-evidence"]) {
    const output = path.join(root, `${phase}-issuer-ack.json`);
    await main([
      "issuer-request",
      "--phase", phase,
      "--url", "https://issuer.example.invalid/v2/independent-issuer",
      "--repository", "Iron-Wrap/ironwrap-os",
      "--source", sourceFile,
      "--pr-context", prFile,
      "--artifact-name", `iro219-${phase}-candidate`,
      "--artifact-digest", ARTIFACT,
      "--actions-run-id", "31970000002",
      "--actions-run-attempt", "1",
      "--issuer-public-key", publicKeyFile,
      "--issuer-identity", "independent-reviewer@ironwrapexteriors.com",
      "--issuer-task-id", phase === "review" ? "independent-source-review" : "independent-release-evidence",
      "--issuer-key-version", "review-key-2026-08",
      "--requester-identity", "release-admission@ironwrapexteriors.com",
      "--output", output,
    ]);

    const request = JSON.parse(observed.init.body);
    assert.equal(observed.url, "https://issuer.example.invalid/v2/independent-issuer");
    assert.equal(request.schema, "ironwrap_independent_issuer_request_v2");
    assert.equal(request.phase, phase);
    assert.match(request.requested_at, ISO_TIMESTAMP_RE);
    assert.match(request.expires_at, ISO_TIMESTAMP_RE);
    assert.equal(
      Date.parse(request.expires_at) - Date.parse(request.requested_at),
      5 * 60_000,
    );
    assert.equal(
      request.publication.ref,
      `${phase === "review" ? "release-review" : "release-evidence"}/${COMMIT}`,
    );
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")).status, "accepted");
  }
});

test("CLI retrieves source-addressed review evidence without a per-release secret", async (t) => {
  const root = await tempRoot(t);
  const output = path.join(root, "review.receipt");
  const source = "a".repeat(40);
  const receipt = "review-payload.signature";
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "github-read-token";
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), new RegExp(`contents/\\.release/reviews/${source}\\.json\\?ref=release-review%2F${source}`));
    assert.equal(init.headers.authorization, "Bearer github-read-token");
    return new Response(JSON.stringify({
      path: `.release/reviews/${source}.json`,
      name: `${source}.json`,
      encoding: "base64",
      content: Buffer.from(receipt).toString("base64"),
    }), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousToken;
  });
  await main(["review-receipt", "--repository", "Iron-Wrap/ironwrap-os", "--source-commit", source, "--output", output]);
  assert.equal((await readFile(output, "utf8")).trim(), receipt);
});

test("independent reviewer CLI signs, atomically publishes, and bounded-waits for exact source evidence", async (t) => {
  const root = await tempRoot(t);
  const outputRoot = await tempRoot(t);
  await run("git", ["-C", root, "init", "-q"]);
  await run("git", ["-C", root, "config", "user.email", "reviewer@example.invalid"]);
  await run("git", ["-C", root, "config", "user.name", "Independent Review"]);
  await writeFile(path.join(root, "source.txt"), "base\n");
  await run("git", ["-C", root, "add", "."]);
  await run("git", ["-C", root, "commit", "-qm", "base"]);
  const base = (await run("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
  await writeFile(path.join(root, "source.txt"), "candidate\n");
  await run("git", ["-C", root, "add", "."]);
  await run("git", ["-C", root, "commit", "-qm", "candidate"]);
  const sourceCommit = (await run("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
  const sourceFile = path.join(outputRoot, "source.json");
  await main(["source-evidence", "--repo-root", root, "--source-commit", sourceCommit, "--base-commit", base, "--output", sourceFile]);
  const source = JSON.parse(await readFile(sourceFile, "utf8"));
  const findingsFile = path.join(outputRoot, "findings.json");
  await writeFile(findingsFile, JSON.stringify({
    schema: "ironwrap_release_review_findings_v1",
    repository: "Iron-Wrap/ironwrap-os",
    source_commit: source.source_commit,
    source_tree_sha256: source.source_tree_sha256,
    diff_sha256: source.diff_sha256,
    reviewer_principal: "independent-reviewer@example.invalid",
    reviewer_task_id: "codex-review-iro41",
    reviewer_run_id: "review-run-31970000001",
    review_key_version: "review-key-2026-08",
    decision: "GO",
    unresolved_p0: 0,
    unresolved_p1: 0,
    findings: [{ priority: "P2", status: "resolved", digest: sha("review-note") }],
  }));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyFile = path.join(outputRoot, "review.key");
  const publicKeyFile = path.join(outputRoot, "review.pub");
  const receiptFile = path.join(outputRoot, "review.receipt");
  const issuerAckFile = path.join(outputRoot, "issuer-ack.json");
  await writeFile(privateKeyFile, privateKey.export({ type: "pkcs8", format: "pem" }));
  await writeFile(publicKeyFile, publicKey.export({ type: "spki", format: "pem" }));
  await main(["review-sign", "--repo-root", root, "--repository", "Iron-Wrap/ironwrap-os", "--source-commit", sourceCommit, "--base-commit", base, "--findings", findingsFile, "--review-private-key", privateKeyFile, "--issuer-identity", "release-admission@example.invalid", "--output", receiptFile]);
  const receipt = (await readFile(receiptFile, "utf8")).trim();
  const verified = verifyReviewGoReceipt(publicKey, receipt, { repository: "Iron-Wrap/ironwrap-os", source_commit: sourceCommit, source_tree_sha256: source.source_tree_sha256, diff_sha256: source.diff_sha256 });
  assert.equal(verified.reviewer_task_id, "codex-review-iro41");
  assert.equal(verified.review_key_version, "review-key-2026-08");
  await writeFile(issuerAckFile, JSON.stringify({
    schema: "ironwrap_independent_issuer_ack_v1",
    status: "accepted",
    phase: "review",
    repository: "Iron-Wrap/ironwrap-os",
    source_commit: sourceCommit,
    request_digest: sha("review-request"),
    issuer_principal: verified.reviewer_principal,
    issuer_task_id: verified.reviewer_task_id,
    issuer_run_id: verified.reviewer_run_id,
    key_version: verified.review_key_version,
    accepted_at: "2026-08-17T08:00:00.000Z",
  }));

  const previousFetch = globalThis.fetch;
  const previousToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "independent-reviewer-github-token";
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET" });
    if (String(url).includes("/git/ref/heads/")) return new Response("{}", { status: 404 });
    if (String(url).endsWith("/git/refs")) return new Response(JSON.stringify({ ref: `refs/heads/release-review/${sourceCommit}`, object: { sha: sourceCommit } }), { status: 201 });
    if (init.method === "PUT") return new Response(JSON.stringify({ content: { path: `.release/reviews/${sourceCommit}.json` } }), { status: 201 });
    return new Response(JSON.stringify({ path: `.release/reviews/${sourceCommit}.json`, name: `${sourceCommit}.json`, encoding: "base64", content: Buffer.from(receipt).toString("base64") }), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousToken;
  });
  const publishOutput = path.join(outputRoot, "publish.json");
  await main(["review-publish", "--repository", "Iron-Wrap/ironwrap-os", "--source-commit", sourceCommit, "--receipt", receiptFile, "--review-public-key", publicKeyFile, "--output", publishOutput]);
  assert.equal(JSON.parse(await readFile(publishOutput, "utf8")).status, "published");
  assert.ok(calls.some((call) => call.method === "POST") && calls.some((call) => call.method === "PUT"));

  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts < 3) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify({ path: `.release/reviews/${sourceCommit}.json`, name: `${sourceCommit}.json`, encoding: "base64", content: Buffer.from(receipt).toString("base64") }), { status: 200 });
  };
  const waitedReceipt = path.join(outputRoot, "waited.receipt");
  await main(["review-wait", "--repository", "Iron-Wrap/ironwrap-os", "--source-commit", sourceCommit, "--source", sourceFile, "--issuer-ack", issuerAckFile, "--review-public-key", publicKeyFile, "--attempts", "3", "--interval-ms", "0", "--output", waitedReceipt]);
  assert.equal((await readFile(waitedReceipt, "utf8")).trim(), receipt);
  globalThis.fetch = async () => new Response("{}", { status: 404 });
  await assert.rejects(() => main(["review-wait", "--repository", "Iron-Wrap/ironwrap-os", "--source-commit", sourceCommit, "--source", sourceFile, "--issuer-ack", issuerAckFile, "--review-public-key", publicKeyFile, "--attempts", "2", "--interval-ms", "0", "--output", waitedReceipt]), /release_promotion_review_receipt_wait_exhausted/);
});

test("CI receipt binds the completed pull-request run identity as well as its job", async (t) => {
  const root = await tempRoot(t);
  const output = path.join(root, "checks.json");
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "github-read-token";
  const stableFetch = async (url) => {
    if (String(url).endsWith("/actions/runs/99")) return new Response(JSON.stringify({
      id: 99,
      repository: { full_name: "Iron-Wrap/ironwrap-os" },
      head_repository: { full_name: "Iron-Wrap/ironwrap-os" },
      head_sha: COMMIT,
      path: ".github/workflows/ci.yml",
      event: "pull_request",
      status: "completed",
      conclusion: "success",
      workflow_id: 456,
      run_attempt: 2,
    }), { status: 200 });
    return new Response(JSON.stringify({ jobs: [{ id: 123, run_id: 99, name: "validate-and-test", conclusion: "success" }] }), { status: 200 });
  };
  globalThis.fetch = stableFetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousToken;
  });
  await collectCiChecks(new Map([
    ["repository", "Iron-Wrap/ironwrap-os"],
    ["run-id", "99"],
    ["job-names", "validate-and-test"],
    ["output", output],
  ]));
  const checks = JSON.parse(await readFile(output, "utf8"));
  assert.equal(checks[0].workflow_path, ".github/workflows/ci.yml");
  assert.equal(checks[0].run_attempt, 2);
  assert.equal(checks[0].head_sha, COMMIT);
  assert.equal(checks[0].event, "pull_request");

  const invoke = () => collectCiChecks(new Map([
    ["repository", "Iron-Wrap/ironwrap-os"],
    ["run-id", "99"],
    ["job-names", "validate-and-test"],
    ["output", output],
  ]));
  const withRun = (overrides) => async (url) => (String(url).endsWith("/actions/runs/99")
    ? new Response(JSON.stringify({
      id: 99,
      repository: { full_name: "Iron-Wrap/ironwrap-os" },
      head_repository: { full_name: "Iron-Wrap/ironwrap-os" },
      head_sha: COMMIT,
      path: ".github/workflows/ci.yml",
      status: "completed",
      conclusion: "success",
      workflow_id: 456,
      run_attempt: 2,
      ...overrides,
    }), { status: 200 })
    : stableFetch(url));

  // The push-to-main run that validated the merged tree is an equally exact
  // release source, and its event is recorded rather than assumed.
  globalThis.fetch = withRun({ event: "push", head_branch: "main" });
  await invoke();
  assert.equal(JSON.parse(await readFile(output, "utf8"))[0].event, "push");

  // Nothing else is: a push to another branch, or a non-source event.
  globalThis.fetch = withRun({ event: "push", head_branch: "release/candidate" });
  await assert.rejects(() => invoke(), /release_promotion_ci_run_contract_invalid/);
  globalThis.fetch = withRun({ event: "workflow_dispatch", head_branch: "main" });
  await assert.rejects(() => invoke(), /release_promotion_ci_run_contract_invalid/);
});

test("PR context binds current base, source head, tested merge commit, and exact tree", async (t) => {
  const root = await tempRoot(t);
  const output = path.join(root, "pr.json");
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "github-read-token";
  const stableFetch = async (url) => {
    const value = String(url);
    if (value.endsWith("/actions/runs/99")) return new Response(JSON.stringify({
      id: 99,
      event: "pull_request",
      path: ".github/workflows/ci.yml",
      status: "completed",
      conclusion: "success",
      repository: { full_name: "Iron-Wrap/ironwrap-os" },
      head_repository: { full_name: "Iron-Wrap/ironwrap-os" },
      head_sha: COMMIT,
      run_attempt: 1,
      pull_requests: [{ number: 43 }],
    }), { status: 200 });
    if (value.endsWith("/pulls/43")) return new Response(JSON.stringify({
      number: 43,
      state: "open",
      base: { ref: "main", sha: BASE, repo: { full_name: "Iron-Wrap/ironwrap-os" } },
      head: { ref: "codex/iro-41-release-permit", sha: HEAD, repo: { full_name: "Iron-Wrap/ironwrap-os" } },
      merge_commit_sha: COMMIT,
      mergeable: true,
      mergeable_state: "clean",
    }), { status: 200 });
    if (value.endsWith(`/git/commits/${COMMIT}`)) return new Response(JSON.stringify({ sha: COMMIT, tree: { sha: GIT_TREE } }), { status: 200 });
    if (value.endsWith("/commits/main")) return new Response(JSON.stringify({ sha: BASE }), { status: 200 });
    if (value.endsWith("/rulesets/20652124")) return new Response(JSON.stringify({ id: 20652124, target: "branch", enforcement: "active", rules: [{ type: "pull_request", parameters: { allowed_merge_methods: ["squash", "rebase"] } }] }), { status: 200 });
    if (value.endsWith("/repos/Iron-Wrap/ironwrap-os")) return new Response(JSON.stringify({ full_name: "Iron-Wrap/ironwrap-os", default_branch: "main", allow_merge_commit: false, allow_squash_merge: true, allow_rebase_merge: true }), { status: 200 });
    return new Response("{}", { status: 404 });
  };
  globalThis.fetch = stableFetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousToken;
  });
  await main(["pr-context", "--repository", "Iron-Wrap/ironwrap-os", "--run-id", "99", "--ruleset-id", "20652124", "--output", output]);
  const context = JSON.parse(await readFile(output, "utf8"));
  assert.equal(context.ci_merge_commit, COMMIT);
  assert.equal(context.ci_merge_tree, GIT_TREE);
  assert.equal(context.base_commit, BASE);
  assert.equal(context.merge_method, "squash");
  assert.equal(context.merge_policy.repository_settings.allow_merge_commit, false);
  assert.deepEqual(context.merge_policy.ruleset.allowed_merge_methods, ["rebase", "squash"]);
  globalThis.fetch = async (url) => String(url).endsWith("/commits/main")
    ? new Response(JSON.stringify({ sha: "9".repeat(40) }), { status: 200 })
    : stableFetch(url);
  await assert.rejects(() => main(["pr-context", "--repository", "Iron-Wrap/ironwrap-os", "--run-id", "99", "--ruleset-id", "20652124", "--output", output]), /release_promotion_pr_base_or_tree_drift/);
  globalThis.fetch = async (url) => String(url).endsWith("/repos/Iron-Wrap/ironwrap-os")
    ? new Response(JSON.stringify({ full_name: "Iron-Wrap/ironwrap-os", default_branch: "main", allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: true }), { status: 200 })
    : stableFetch(url);
  await assert.rejects(() => main(["pr-context", "--repository", "Iron-Wrap/ironwrap-os", "--run-id", "99", "--ruleset-id", "20652124", "--output", output]), /release_promotion_merge_policy_invalid/);
});

test("push context admits the merged squash commit that is still main's tip", async (t) => {
  const root = await tempRoot(t);
  const output = path.join(root, "push.json");
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "github-read-token";
  const pushRun = {
    id: 101,
    event: "push",
    head_branch: "main",
    path: ".github/workflows/ci.yml",
    status: "completed",
    conclusion: "success",
    repository: { full_name: "Iron-Wrap/ironwrap-os" },
    head_repository: { full_name: "Iron-Wrap/ironwrap-os" },
    head_sha: COMMIT,
    run_attempt: 1,
    pull_requests: [],
  };
  const mergedPr = {
    number: 43,
    state: "closed",
    merged: true,
    base: { ref: "main", sha: BASE, repo: { full_name: "Iron-Wrap/ironwrap-os" } },
    head: { ref: "codex/iro-41-release-permit", sha: HEAD, repo: { full_name: "Iron-Wrap/ironwrap-os" } },
    merge_commit_sha: COMMIT,
  };
  const respond = ({ run = pushRun, commit = { sha: COMMIT, tree: { sha: GIT_TREE }, parents: [{ sha: BASE }] }, main: mainCommit = { sha: COMMIT }, associated = [{ number: 43, merge_commit_sha: COMMIT }], pr = mergedPr } = {}) => async (url) => {
    const value = String(url);
    if (value.endsWith("/actions/runs/101")) return new Response(JSON.stringify(run), { status: 200 });
    if (value.endsWith(`/commits/${COMMIT}/pulls`)) return new Response(JSON.stringify(associated), { status: 200 });
    if (value.endsWith(`/git/commits/${COMMIT}`)) return new Response(JSON.stringify(commit), { status: 200 });
    if (value.endsWith("/commits/main")) return new Response(JSON.stringify(mainCommit), { status: 200 });
    if (value.endsWith("/pulls/43")) return new Response(JSON.stringify(pr), { status: 200 });
    if (value.endsWith("/rulesets/20652124")) return new Response(JSON.stringify({ id: 20652124, target: "branch", enforcement: "active", rules: [{ type: "pull_request", parameters: { allowed_merge_methods: ["squash", "rebase"] } }] }), { status: 200 });
    if (value.endsWith("/repos/Iron-Wrap/ironwrap-os")) return new Response(JSON.stringify({ full_name: "Iron-Wrap/ironwrap-os", default_branch: "main", allow_merge_commit: false, allow_squash_merge: true, allow_rebase_merge: true }), { status: 200 });
    return new Response("{}", { status: 404 });
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousToken;
  });
  const invoke = (base = BASE) => main(["push-context", "--repository", "Iron-Wrap/ironwrap-os", "--run-id", "101", "--ruleset-id", "20652124", "--head-commit", COMMIT, "--base-commit", base, "--output", output]);

  globalThis.fetch = respond();
  await invoke();
  const context = JSON.parse(await readFile(output, "utf8"));
  assert.equal(context.schema, "ironwrap_pr_admission_v1");
  assert.equal(context.status, "merged");
  assert.equal(context.number, 43);
  assert.equal(context.base_commit, BASE);
  assert.equal(context.head_commit, HEAD);
  assert.equal(context.ci_merge_commit, COMMIT);
  assert.equal(context.ci_merge_tree, GIT_TREE);
  assert.equal(context.merge_method, "squash");
  assert.equal(context.base_ref, "main");

  // Another release landed while this one was being promoted: fail closed
  // instead of promoting a tree production has already moved past.
  globalThis.fetch = respond({ main: { sha: MERGE_COMMIT } });
  await assert.rejects(() => invoke(), /release_promotion_push_source_superseded/);

  // Generation N must be the squash commit's one parent, and the workflow's
  // git-derived base must be the same commit the provider reports.
  globalThis.fetch = respond({ commit: { sha: COMMIT, tree: { sha: GIT_TREE }, parents: [{ sha: BASE }, { sha: MERGE_COMMIT }] } });
  await assert.rejects(() => invoke(), /release_promotion_push_commit_not_linear_squash/);
  globalThis.fetch = respond();
  await assert.rejects(() => invoke(HEAD), /release_promotion_push_commit_not_linear_squash/);

  // Only a push that CI validated on main is admissible.
  globalThis.fetch = respond({ run: { ...pushRun, head_branch: "release/candidate" } });
  await assert.rejects(() => invoke(), /release_promotion_push_run_identity_invalid/);
  globalThis.fetch = respond({ run: { ...pushRun, event: "pull_request" } });
  await assert.rejects(() => invoke(), /release_promotion_push_run_identity_invalid/);
  globalThis.fetch = respond({ run: { ...pushRun, head_repository: { full_name: "fork/ironwrap-os" } } });
  await assert.rejects(() => invoke(), /release_promotion_push_run_identity_invalid/);

  // The source must be exactly one merged, same-repository PR.
  globalThis.fetch = respond({ associated: [] });
  await assert.rejects(() => invoke(), /release_promotion_push_pr_association_invalid/);
  globalThis.fetch = respond({ associated: [{ number: 43, merge_commit_sha: COMMIT }, { number: 44, merge_commit_sha: COMMIT }] });
  await assert.rejects(() => invoke(), /release_promotion_push_pr_association_invalid/);
  globalThis.fetch = respond({ pr: { ...mergedPr, merged: false } });
  await assert.rejects(() => invoke(), /release_promotion_push_pr_contract_invalid/);
  globalThis.fetch = respond({ pr: { ...mergedPr, head: { ...mergedPr.head, repo: { full_name: "fork/ironwrap-os" } } } });
  await assert.rejects(() => invoke(), /release_promotion_push_pr_contract_invalid/);

  // The pre-merge derivation cannot be pointed at a push-sourced run.
  globalThis.fetch = respond();
  await assert.rejects(
    () => main(["pr-context", "--repository", "Iron-Wrap/ironwrap-os", "--run-id", "101", "--ruleset-id", "20652124", "--output", output]),
    /release_promotion_pr_run_identity_invalid/,
  );
});

test("pre-merge and post-merge source admission reject each other's context", async (t) => {
  const root = await tempRoot(t);
  const contextFile = path.join(root, "pr-context.json");
  const output = path.join(root, "source-merge-receipt.json");
  const context = {
    schema: "ironwrap_pr_admission_v1",
    repository: "Iron-Wrap/ironwrap-os",
    number: 43,
    base_ref: "main",
    base_commit: BASE,
    head_ref: "codex/iro-41-release-permit",
    head_commit: HEAD,
    ci_run_id: "101",
    ci_merge_commit: COMMIT,
    ci_merge_tree: GIT_TREE,
    merge_method: "squash",
    merge_policy: mergePolicyFixture(),
    provider_readback_digest: sha("push-readback"),
    status: "merged",
  };
  // Both commands settle the source contract before reading the permit, so an
  // unreadable permit path proves the rejection happens first.
  const permit = path.join(root, "absent-permit.txt");
  const invoke = (command) => main([command, "--pr-context", contextFile, "--permit", permit, "--permit-public-key", permit, "--admission", permit, "--output", output]);

  await writeFile(contextFile, JSON.stringify(context));
  await assert.rejects(() => invoke("merge-pr"), /release_promotion_pr_context_contract_invalid/);
  await writeFile(contextFile, JSON.stringify({ ...context, status: "open" }));
  await assert.rejects(() => invoke("merged-source"), /release_promotion_pr_context_contract_invalid/);
  await writeFile(contextFile, JSON.stringify({ ...context, status: "closed" }));
  await assert.rejects(() => invoke("merge-pr"), /release_promotion_pr_context_contract_invalid/);
  await assert.rejects(() => invoke("merged-source"), /release_promotion_pr_context_contract_invalid/);
});

test("merge-time provider policy drift fails before any mutation", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET" });
    if (String(url).endsWith("/rulesets/20652124")) return new Response(JSON.stringify({ id: 20652124, target: "branch", enforcement: "active", rules: [{ type: "pull_request", parameters: { allowed_merge_methods: ["squash", "rebase"] } }] }), { status: 200 });
    return new Response(JSON.stringify({ full_name: "Iron-Wrap/ironwrap-os", default_branch: "main", allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: true }), { status: 200 });
  };
  await assert.rejects(() => assertMergePolicyUnchanged({ repository: "Iron-Wrap/ironwrap-os", expected: mergePolicyFixture(), token: "github-token", fetchImpl }), /release_promotion_merge_policy_invalid/);
  assert.ok(calls.length >= 1 && calls.every((call) => call.method === "GET"));
});

test("CI receipt rejects a jobs response from a different run", async (t) => {
  const root = await tempRoot(t);
  const output = path.join(root, "checks.json");
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "github-read-token";
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/actions/runs/99")) return new Response(JSON.stringify({
      id: 98,
      repository: { full_name: "Iron-Wrap/ironwrap-os" },
      head_repository: { full_name: "Iron-Wrap/ironwrap-os" },
      head_sha: COMMIT,
      path: ".github/workflows/ci.yml",
      event: "push",
      status: "completed",
      conclusion: "success",
      workflow_id: 456,
      run_attempt: 1,
    }), { status: 200 });
    return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousToken;
  });
  await assert.rejects(() => collectCiChecks(new Map([
    ["repository", "Iron-Wrap/ironwrap-os"],
    ["run-id", "99"],
    ["job-names", "validate-and-test"],
    ["output", output],
  ])), /release_promotion_ci_run_identity_invalid/);
});

test("CLI creates only redacted provider, smoke, backup, and rollback receipts", async (t) => {
  const root = await tempRoot(t);
  const versionInput = path.join(root, "version.json");
  const versionOutput = path.join(root, "version.receipt.json");
  const inventoryInput = path.join(root, "inventory.json");
  const inventoryOutput = path.join(root, "inventory.receipt.json");
  await writeFile(inventoryInput, JSON.stringify([{ name: "INGEST_TOKEN", type: "secret_text" }]));
  const contextFile = path.join(root, "context.json");
  await writeFile(contextFile, JSON.stringify({
    staging_secret_names: ["INGEST_TOKEN"],
    staging_binding_manifest: [
      { name: "DB", type: "d1", resource_id: "f0674848-13df-4422-9896-8ba2719663b8" },
      { name: "INGEST_TOKEN", type: "secret_text" },
    ],
    staging_runtime_manifest: { compatibility_date: "2026-06-28", compatibility_flags: [] },
  }));
  await main(["secret-readback", "--input", inventoryInput, "--output", inventoryOutput, "--context", contextFile, "--environment", "staging"]);
  const inventory = JSON.parse(await readFile(inventoryOutput, "utf8"));
  assert.equal(inventory.status, "matched");
  await writeFile(versionInput, JSON.stringify({
    id: STAGING,
    metadata: { created_on: "2026-08-16T20:00:00.000Z", author_email: "release@example.invalid", source: "wrangler" },
    annotations: { "workers/message": `ironwrap-release-version-v1|source=${COMMIT}|tree=${TREE}|artifact=${ARTIFACT}|config=${CONFIG}` },
    resources: {
      script: { handlers: ["fetch"] },
      script_runtime: { compatibility_date: "2026-06-28" },
      bindings: [{ name: "DB", type: "d1", id: "f0674848-13df-4422-9896-8ba2719663b8" }, { name: "INGEST_TOKEN", type: "secret_text" }],
    },
  }));
  await main(["version-readback", "--input", versionInput, "--output", versionOutput, "--environment", "staging", "--version-id", STAGING, "--source-commit", COMMIT, "--source-tree", TREE, "--artifact-digest", ARTIFACT, "--config-digest", CONFIG, "--secret-inventory", inventoryOutput, "--context", contextFile]);
  const version = JSON.parse(await readFile(versionOutput, "utf8"));
  assert.equal(version.revision, STAGING);
  assert.equal(version.readback.status, "matched");
  assert.match(version.readback.secret_inventory_digest, /^[0-9a-f]{64}$/);

  const evidence = path.join(root, "smoke.json");
  const smokeOutput = path.join(root, "smoke.receipt.json");
  await writeFile(evidence, JSON.stringify(v4SmokeEvidence()));
  await main(["smoke-receipt", "--evidence", evidence, "--output", smokeOutput, "--source-commit", COMMIT, "--revision", STAGING]);
  const smoke = JSON.parse(await readFile(smokeOutput, "utf8"));
  assert.equal(smoke.authenticated, true);
  assert.equal(smoke.result, "passed");

  const exportFile = path.join(root, "staging.sql");
  const sourceQuery = path.join(root, "source-query.json");
  const restoredQuery = path.join(root, "restored-query.json");
  const readbackFile = path.join(root, "restore.readback.json");
  const backupOutput = path.join(root, "backup.receipt.json");
  await writeFile(exportFile, "CREATE TABLE dedup_claims (dedup_key TEXT);\nINSERT INTO dedup_claims VALUES ('release-policy');\n");
  const manifestRows = [
    { kind: "schema", object_type: "table", object_name: "dedup_claims", definition: "CREATE TABLE dedup_claims (dedup_key TEXT)", row_count: null },
    { kind: "row_count", object_type: "table", object_name: "dedup_claims", definition: "", row_count: 1 },
  ];
  const contentRows = [{ __ironwrap_restore_table_iro41: "dedup_claims", dedup_key: "release-policy" }];
  await writeFile(sourceQuery, JSON.stringify([{ success: true, results: manifestRows }, { success: true, results: contentRows }]));
  await writeFile(restoredQuery, JSON.stringify([{ success: true, results: manifestRows }, { success: true, results: contentRows }]));
  await main(["restore-readback", "--export", exportFile, "--source", sourceQuery, "--restored", restoredQuery, "--output", readbackFile]);
  await main(["backup-receipt", "--export", exportFile, "--readback", readbackFile, "--output", backupOutput, "--source-commit", COMMIT, "--source-generation", "4", "--artifact-digest", ARTIFACT, "--target", "ironwrap-restore-drill"]);
  assert.equal(JSON.parse(await readFile(backupOutput, "utf8")).restored, true);

  const recoveryInput = path.join(root, "production-recovery.provider.json");
  const recoveryOutput = path.join(root, "production-recovery.json");
  await writeFile(recoveryInput, JSON.stringify({ bookmark: "bookmark-20260816-production-0001" }));
  await main(["d1-recovery-point", "--input", recoveryInput, "--database-id", "f0674848-13df-4422-9896-8ba2719663b8", "--output", recoveryOutput]);
  assert.equal(JSON.parse(await readFile(recoveryOutput, "utf8")).status, "matched");
  await writeFile(recoveryInput, JSON.stringify({ bookmark: "bookmark-20260816-production-0001", ignored: true }));
  await assert.rejects(() => main(["d1-recovery-point", "--input", recoveryInput, "--database-id", "f0674848-13df-4422-9896-8ba2719663b8", "--output", recoveryOutput]), /release_promotion_d1_recovery_readback_shape_invalid/);

  const rollbackReadback = path.join(root, "rollback.readback");
  const rollbackOutput = path.join(root, "rollback.receipt.json");
  const rollbackHealth = path.join(root, "rollback-health.json");
  const rollbackReady = path.join(root, "rollback-ready.json");
  const rollbackSmoke = path.join(root, "rollback-smoke.json");
  const rollbackRepromoted = path.join(root, "rollback-repromoted.readback");
  await writeFile(rollbackReadback, "33333333-3333-4333-8333-333333333333\n");
  await writeFile(rollbackHealth, JSON.stringify({ ok: true }));
  await writeFile(rollbackReady, JSON.stringify({ ok: true }));
  await writeFile(rollbackRepromoted, `${STAGING}\n`);
  await writeFile(rollbackSmoke, JSON.stringify(v4SmokeEvidence()));
  await main(["rollback-receipt", "--readback", rollbackReadback, "--re-promoted", rollbackRepromoted, "--health", rollbackHealth, "--ready", rollbackReady, "--smoke", rollbackSmoke, "--output", rollbackOutput, "--source-commit", COMMIT, "--candidate", STAGING, "--previous", "33333333-3333-4333-8333-333333333333"]);
  assert.equal(JSON.parse(await readFile(rollbackOutput, "utf8")).readback, "matched");
});

test("restore readback rejects free text, malformed JSON, empty state, and schema/row mismatches", async (t) => {
  const root = await tempRoot(t);
  const exportFile = path.join(root, "export.sql");
  const source = path.join(root, "source.json");
  const restored = path.join(root, "restored.json");
  const output = path.join(root, "restore.json");
  await writeFile(exportFile, "CREATE TABLE dedup_claims (dedup_key TEXT);\nINSERT INTO dedup_claims VALUES ('x');\n");
  const rows = [
    { kind: "schema", object_type: "table", object_name: "dedup_claims", definition: "CREATE TABLE dedup_claims (dedup_key TEXT)", row_count: null },
    { kind: "row_count", object_type: "table", object_name: "dedup_claims", definition: "", row_count: 1 },
  ];
  const queryResult = (manifestRows, values = ["x"]) => JSON.stringify([
    { success: true, results: manifestRows },
    { success: true, results: values.map((value) => ({ __ironwrap_restore_table_iro41: "dedup_claims", dedup_key: value })) },
  ]);
  await writeFile(source, queryResult(rows));
  await writeFile(restored, queryResult(rows));
  const invoke = () => main(["restore-readback", "--export", exportFile, "--source", source, "--restored", restored, "--output", output]);
  await writeFile(source, "not ok\n");
  await assert.rejects(invoke, /release_promotion_restore_json_invalid/);
  await writeFile(source, "{malformed");
  await assert.rejects(invoke, /release_promotion_restore_json_invalid/);
  await writeFile(source, queryResult(rows));
  await writeFile(exportFile, "");
  await assert.rejects(invoke, /release_promotion_restore_export_empty/);
  await writeFile(exportFile, "CREATE TABLE dedup_claims (dedup_key TEXT);\nINSERT INTO dedup_claims VALUES ('x');\n");
  await writeFile(source, queryResult([{ ...rows[0] }, { ...rows[1], row_count: 0 }]));
  await assert.rejects(invoke, /release_promotion_restore_source_manifest_invalid/);
  await writeFile(source, queryResult(rows));
  await writeFile(restored, queryResult([{ ...rows[0] }, { ...rows[1], row_count: 2 }], ["x", "y"]));
  await assert.rejects(invoke, /release_promotion_restore_manifest_mismatch/);
  await writeFile(restored, queryResult(rows, ["different-content"]));
  await assert.rejects(invoke, /release_promotion_restore_manifest_mismatch/);
});

test("production receipt binds active revision, config, readiness, and exact smoke evidence", async (t) => {
  const root = await tempRoot(t);
  const active = path.join(root, "active.id");
  const smoke = path.join(root, "smoke.json");
  const health = path.join(root, "health.json");
  const ready = path.join(root, "ready.json");
  const output = path.join(root, "production.json");
  const permitPayload = path.join(root, "permit.json");
  const mergeReceiptFile = path.join(root, "merge.json");
  const servicePromotionReceiptFile = path.join(
    root,
    "service-promotion.receipt",
  );
  const serviceReadbackReceiptFile = path.join(
    root,
    "service-readback.receipt",
  );
  const servicePublicKeyFile = path.join(root, "service.pub");
  const serviceKeys = generateKeyPairSync("ed25519");
  const mergeFields = {
    schema: "ironwrap_source_admission_merge_v1",
    repository: "Iron-Wrap/ironwrap-os",
    pr_number: 43,
    head_commit: HEAD,
    base_commit: BASE,
    ci_merge_commit: COMMIT,
    expected_tree: GIT_TREE,
    merge_method: "squash",
    provider_settings_digest: mergePolicyFixture().readback_digest,
    merge_commit: MERGE_COMMIT,
    merge_tree: GIT_TREE,
    main_commit: MERGE_COMMIT,
    permit_digest: sha("permit"),
    admission_digest: sha("admission"),
    status: "merged",
  };
  await writeFile(permitPayload, JSON.stringify(minimalPermitPayload()));
  await writeFile(mergeReceiptFile, JSON.stringify({ ...mergeFields, evidence_digest: sha(canonicalJson(mergeFields)), observed_at: "2026-08-16T20:00:00.000Z" }));
  const serviceNow = Date.now();
  await writeFile(
    servicePromotionReceiptFile,
    `${signedServiceReceipt(serviceKeys.privateKey, { operation: "promote", now: serviceNow })}\n`,
  );
  await writeFile(
    serviceReadbackReceiptFile,
    `${signedServiceReceipt(serviceKeys.privateKey, { operation: "readback", now: serviceNow + 1_000 })}\n`,
  );
  await writeFile(
    servicePublicKeyFile,
    serviceKeys.publicKey.export({ type: "spki", format: "pem" }),
  );
  await writeFile(active, `${PRODUCTION}\n`);
  await writeFile(health, JSON.stringify({ ok: true }));
  await writeFile(ready, JSON.stringify({ ok: true }));
  await writeFile(smoke, JSON.stringify(v4SmokeEvidence()));
  const receiptArgs = [
    "production-receipt",
    "--active",
    active,
    "--smoke",
    smoke,
    "--health",
    health,
    "--ready",
    ready,
    "--source-commit",
    COMMIT,
    "--source-tree",
    TREE,
    "--artifact-digest",
    ARTIFACT,
    "--config-digest",
    CONFIG,
    "--version-id",
    PRODUCTION,
    "--version-digest",
    sha("version"),
    "--permit-payload",
    permitPayload,
    "--merge-receipt",
    mergeReceiptFile,
    "--service-promotion-receipt",
    servicePromotionReceiptFile,
    "--service-readback-receipt",
    serviceReadbackReceiptFile,
    "--service-public-key",
    servicePublicKeyFile,
    "--service-issuer-identity",
    "service-release@ironwrapexteriors.com",
    "--service-issuer-task-id",
    "frappe-release-adapter",
    "--service-issuer-run-id",
    "github:31970000001:1",
    "--service-key-version",
    "service-key-2026-08",
    "--output",
    output,
  ];
  await main(receiptArgs);
  const receipt = JSON.parse(await readFile(output, "utf8"));
  assert.equal(receipt.active_readback, "matched");
  assert.equal(receipt.revision, PRODUCTION);
  await writeFile(active, `${STAGING}\n`);
  await assert.rejects(() => main(receiptArgs), /release_promotion_production_active_revision_drift/);
  await writeFile(active, `${PRODUCTION}\n`);
  await writeFile(smoke, JSON.stringify(v4SmokeEvidence({ steps: { health: { http_status: 200, request_id: "only-one" } } })));
  await assert.rejects(() => main(receiptArgs), /release_promotion_smoke_step_set_invalid/);
});

test("CLI config digest is deterministic and environment-specific", async (t) => {
  const root = await tempRoot(t);
  const staging = path.join(root, "staging.json");
  const production = path.join(root, "production.json");
  await main(["config-digest", "--repo-root", ROOT, "--environment", "staging", "--output", staging]);
  await main(["config-digest", "--repo-root", ROOT, "--environment", "production", "--output", production]);
  const stagingResult = JSON.parse(await readFile(staging, "utf8"));
  const productionResult = JSON.parse(await readFile(production, "utf8"));
  assert.notEqual(stagingResult.digest, productionResult.digest);
  assert.equal(stagingResult.secret_names.includes("GOOGLE_SERVICE_ACCOUNT_JSON"), true);
});

test("release policy hash deterministically covers executable admission enforcement", async (t) => {
  const root = await tempRoot(t);
  for (const relative of RELEASE_POLICY_FILES) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), `policy-source:${relative}\n`);
  }
  const first = await computeReleasePolicyHash(root);
  assert.equal(await computeReleasePolicyHash(root), first);
  for (const relative of [".github/workflows/deploy.yml", ".github/workflows/ci.yml", "tools/release-permit.mjs", "tools/release-promotion.mjs"]) {
    await writeFile(path.join(root, relative), `weakened:${relative}\n`);
    assert.notEqual(await computeReleasePolicyHash(root), first, relative);
    await writeFile(path.join(root, relative), `policy-source:${relative}\n`);
  }
});

test("CLI owns deployment/readiness/receipt parsing instead of workflow heredocs", async (t) => {
  const root = await tempRoot(t);
  const context = path.join(root, "context.json");
  await writeFile(context, JSON.stringify({ source_commit: COMMIT, source_tree_sha256: TREE, artifact_digest: ARTIFACT, staging_config_digest: CONFIG, generation: 4 }));
  const field = path.join(root, "field.txt");
  await main(["context-field", "--context", context, "--field", "source_commit", "--output", field]);
  assert.equal((await readFile(field, "utf8")).trim(), COMMIT);

  const deployments = path.join(root, "deployments.json");
  const deploymentHistory = [
    { created_on: "2026-08-16T20:02:00.000Z", versions: [{ version_id: STAGING, percentage: 100 }] },
    { created_on: "2026-08-16T20:01:00.000Z", versions: [{ version_id: PRODUCTION, percentage: 100 }] },
  ];
  await writeFile(deployments, JSON.stringify(deploymentHistory));
  const revision = path.join(root, "revision.txt");
  await main(["deployment-revision", "--input", deployments, "--output", revision]);
  assert.equal((await readFile(revision, "utf8")).trim(), STAGING);
  await assert.rejects(() => main(["deployment-revision", "--input", deployments, "--output", revision, "--expected", PRODUCTION]), /release_promotion_deployment_active_revision_drift/);
  const providerReversed = path.join(root, "deployments-provider-order.json");
  await writeFile(providerReversed, JSON.stringify([
    { created_on: "2026-08-16T20:01:00.000Z", versions: [{ version_id: PRODUCTION, percentage: 100 }] },
    { created_on: "2026-08-16T20:02:00.000Z", versions: [{ version_id: STAGING, percentage: 100 }] },
  ]));
  await main(["deployment-revision", "--input", providerReversed, "--output", revision]);
  assert.equal((await readFile(revision, "utf8")).trim(), STAGING);

  const cleanupReceipt = path.join(root, "staging-cleanup.json");
  const cleanupArgs = [
    "staging-cleanup-receipt",
    "--input",
    deployments,
    "--previous",
    STAGING,
    "--candidate",
    PRODUCTION,
    "--command-result",
    "nonzero_reconciled",
    "--output",
    cleanupReceipt,
  ];
  await main(cleanupArgs);
  const cleanup = JSON.parse(await readFile(cleanupReceipt, "utf8"));
  assert.equal(cleanup.schema, "ironwrap_staging_cleanup_v1");
  assert.equal(cleanup.previous_revision, STAGING);
  assert.equal(cleanup.candidate_revision, PRODUCTION);
  assert.equal(cleanup.restored_revision, STAGING);
  assert.equal(cleanup.restore_command_result, "nonzero_reconciled");
  assert.equal(cleanup.result, "passed");
  assert.equal(cleanup.readback, "matched");
  assert.match(cleanup.provider_readback_digest, /^[0-9a-f]{64}$/);
  assert.match(cleanup.evidence_digest, /^[0-9a-f]{64}$/);
  await writeFile(
    deployments,
    JSON.stringify([
      {
        created_on: "2026-08-16T20:03:00.000Z",
        versions: [{ version_id: PRODUCTION, percentage: 100 }],
      },
      ...deploymentHistory,
    ]),
  );
  await assert.rejects(
    () => main(cleanupArgs),
    /release_promotion_deployment_active_revision_drift/,
  );
  await writeFile(deployments, JSON.stringify(deploymentHistory));

  const versionReadback = path.join(root, "version-readback.json");
  const versionSnapshot = path.join(root, "version-snapshot.json");
  const versionProviderBody = {
    id: STAGING,
    metadata: { created_on: "2026-08-16T20:01:00.000Z" },
    resources: { bindings: [] },
  };
  await writeFile(versionReadback, JSON.stringify(versionProviderBody));
  await main([
    "version-snapshot",
    "--input",
    versionReadback,
    "--expected",
    STAGING,
    "--output",
    versionSnapshot,
  ]);
  assert.deepEqual(JSON.parse(await readFile(versionSnapshot, "utf8")), {
    schema: "ironwrap_provider_version_snapshot_v1",
    revision: STAGING,
    provider_readback_digest: sha(canonicalJson(versionProviderBody)),
    status: "matched",
  });
  await assert.rejects(
    () =>
      main([
        "version-snapshot",
        "--input",
        versionReadback,
        "--expected",
        PRODUCTION,
        "--output",
        versionSnapshot,
      ]),
    /release_promotion_version_snapshot_revision_drift/,
  );

  const health = path.join(root, "health.json");
  const ready = path.join(root, "ready.json");
  await writeFile(health, JSON.stringify({ ok: true }));
  await writeFile(ready, JSON.stringify({ ok: true }));
  await main(["readiness", "--health", health, "--ready", ready]);
  await writeFile(ready, JSON.stringify({ ok: false }));
  await assert.rejects(() => main(["readiness", "--health", health, "--ready", ready]), /release_promotion_readiness_not_proven/);

  const rollbackOutput = path.join(root, "rollback.json");
  const rollbackHealth = path.join(root, "production-rollback-health.json");
  const rollbackReady = path.join(root, "production-rollback-ready.json");
  const rollbackPermit = path.join(root, "production-rollback-permit.json");
  const rollbackVersionReadback = path.join(
    root,
    "production-rollback-version.json",
  );
  const rollbackServiceReceipt = path.join(root, "service-rollback.receipt");
  const rollbackServicePublicKey = path.join(root, "service-rollback.pub");
  const rollbackServiceKeys = generateKeyPairSync("ed25519");
  await writeFile(rollbackHealth, JSON.stringify({ ok: true }));
  await writeFile(rollbackReady, JSON.stringify({ ok: true }));
  await writeFile(rollbackPermit, JSON.stringify(minimalPermitPayload()));
  await writeFile(
    rollbackVersionReadback,
    JSON.stringify({
      schema: "ironwrap_provider_version_snapshot_v1",
      revision: STAGING,
      provider_readback_digest: WORKER_PREVIOUS_READBACK,
      status: "matched",
    }),
  );
  await writeFile(
    rollbackServiceReceipt,
    `${signedServiceReceipt(rollbackServiceKeys.privateKey, { operation: "rollback" })}\n`,
  );
  await writeFile(
    rollbackServicePublicKey,
    rollbackServiceKeys.publicKey.export({ type: "spki", format: "pem" }),
  );
  const productionRollbackArgs = [
    "production-rollback-receipt",
    "--input",
    deployments,
    "--previous",
    STAGING,
    "--candidate",
    PRODUCTION,
    "--source-commit",
    COMMIT,
    "--permit-payload",
    rollbackPermit,
    "--version-readback",
    rollbackVersionReadback,
    "--merge-commit",
    MERGE_COMMIT,
    "--service-receipt",
    rollbackServiceReceipt,
    "--service-public-key",
    rollbackServicePublicKey,
    "--service-issuer-identity",
    "service-release@ironwrapexteriors.com",
    "--service-issuer-task-id",
    "frappe-release-adapter",
    "--service-issuer-run-id",
    "github:31970000001:1",
    "--service-key-version",
    "service-key-2026-08",
    "--health",
    rollbackHealth,
    "--ready",
    rollbackReady,
    "--output",
    rollbackOutput,
  ];
  await main(productionRollbackArgs);
  assert.equal(JSON.parse(await readFile(rollbackOutput, "utf8")).restored_revision, STAGING);
  const leftoverRollbackOutput = path.join(root, "rollback-leftover.json");
  const leftoverRollbackArgs = productionRollbackArgs.filter((_, index, list) => {
    const flag = list[index - 1];
    return ![
      "--service-receipt",
      "--service-public-key",
      "--service-issuer-identity",
      "--service-issuer-task-id",
      "--service-issuer-run-id",
      "--service-key-version",
    ].includes(flag) && !["--service-receipt", "--service-public-key", "--service-issuer-identity", "--service-issuer-task-id", "--service-issuer-run-id", "--service-key-version"].includes(_);
  }).map((value) => (value === rollbackOutput ? leftoverRollbackOutput : value));
  await main(leftoverRollbackArgs);
  const leftoverRollback = JSON.parse(await readFile(leftoverRollbackOutput, "utf8"));
  assert.equal(leftoverRollback.restored_revision, STAGING);
  assert.equal(leftoverRollback.frappe_restored_revision, "leftover-not-promoted");
  await writeFile(
    deployments,
    JSON.stringify([
      {
        created_on: "2026-08-16T20:03:00.000Z",
        versions: [{ version_id: PRODUCTION, percentage: 100 }],
      },
      ...deploymentHistory,
    ]),
  );
  await assert.rejects(
    () => main(productionRollbackArgs),
    /release_promotion_deployment_active_revision_drift/,
  );
});
