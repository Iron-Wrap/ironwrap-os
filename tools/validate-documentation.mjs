#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifestPath = resolve(root, "docs/manifest.json");
const allowedClasses = new Set(["canonical", "runbook", "component", "runtime", "developer"]);
const documentExtensions = new Set([
  ".md",
  ".mdx",
  ".pdf",
  ".doc",
  ".docx",
  ".odt",
  ".rtf",
  ".ppt",
  ".pptx",
  ".xls",
  ".xlsx",
]);
const forbiddenBinaryExtensions = new Set(
  [...documentExtensions].filter((extension) => ![".md", ".mdx"].includes(extension)),
);
const forbiddenPaths = [
  /^docs\/archive\//,
  /^final-spec-pack\//,
  /^task1-spec\//,
  /^output\//,
  /^samples\//,
  /(^|\/)(DELIVERY-PLAN|PRODUCT|SETUP-CHECKLIST)\.md$/,
  /(^|\/)PRODUCTION-READINESS-(AUDIT|RESOLUTION)-\d{4}-\d{2}-\d{2}\.md$/,
];
const absoluteWorkstationPath =
  /(?:file:\/\/\/|\/Users\/[^/\s]+\/|[A-Za-z]:\\Users\\)/;

const failures = [];
const fail = (message) => failures.push(message);
const allowedOptions = new Set([
  "--app-test-output",
  "--capability-matrix",
  "--evidence",
  "--worker-test-output",
]);
const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (!allowedOptions.has(name) || !value) {
    fail(`unknown or incomplete option ${JSON.stringify(name)}`);
    continue;
  }
  if (options.has(name)) fail(`duplicate option ${name}`);
  options.set(name, value);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const entries = manifest.documents ?? [];
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root })
  .toString()
  .split("\0")
  .filter(Boolean);
const trackedSet = new Set(tracked);
const trackedDocuments = tracked.filter((path) => documentExtensions.has(extname(path).toLowerCase()));

function loadCapabilityContract(path) {
  if (!existsSync(path)) {
    fail(`capability matrix not found: ${path}`);
    return null;
  }
  const content = readFileSync(path, "utf8");
  const startMarker = "<!-- capability-evidence-contract:start -->";
  const endMarker = "<!-- capability-evidence-contract:end -->";
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker);
  if (start === -1 || end === -1 || end <= start) {
    fail(
      "docs/CAPABILITY-MATRIX.md: missing capability evidence contract markers",
    );
    return null;
  }
  const fenced = content.slice(start + startMarker.length, end);
  const json = fenced.match(/```json\s*([\s\S]*?)\s*```/)?.[1];
  if (!json) {
    fail(
      "docs/CAPABILITY-MATRIX.md: capability evidence contract must contain one JSON fence",
    );
    return null;
  }
  try {
    return {
      value: JSON.parse(json),
      sha256: createHash("sha256").update(json).digest("hex"),
    };
  } catch (error) {
    fail(
      `docs/CAPABILITY-MATRIX.md: invalid capability evidence JSON: ${error.message}`,
    );
    return null;
  }
}

function repositoryCapabilityFacts() {
  const doctypeRoot = resolve(
    root,
    "frappe-apps/ironwrap_roofing/ironwrap_roofing/ironwrap_roofing/doctype",
  );
  const doctypes = readdirSync(doctypeRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(doctypeRoot, entry.name, `${entry.name}.json`))
    .filter(existsSync)
    .map((path) => JSON.parse(readFileSync(path, "utf8")));
  const child = doctypes.filter((doctype) => Boolean(doctype.istable)).length;

  const migrationRoot = resolve(root, "workers-bus/migrations");
  const migrations = readdirSync(migrationRoot)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  const prefixes = migrations.map((name) =>
    Number.parseInt(name.slice(0, 4), 10),
  );
  if (prefixes.some((prefix, index) => prefix !== index + 1)) {
    fail(
      "workers-bus/migrations: numbered SQL migrations must be contiguous from 0001",
    );
  }

  return {
    frappe_doctypes: {
      total: doctypes.length,
      top_level: doctypes.length - child,
      child,
    },
    d1_migrations: {
      count: migrations.length,
      latest: migrations.at(-1) ?? null,
    },
  };
}

function compareCapabilityFact(label, expected, actual) {
  if (expected !== actual) {
    fail(
      `docs/CAPABILITY-MATRIX.md: stale ${label}; contract ${JSON.stringify(expected)}, repository ${JSON.stringify(actual)}`,
    );
  }
}

function cleanTestOutput(path) {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    fail(`test output not found: ${resolved}`);
    return "";
  }
  return readFileSync(resolved, "utf8").replace(/\u001b\[[0-9;]*m/g, "");
}

function appTestCount(path) {
  if (!path) return null;
  const count = cleanTestOutput(path).match(/\bTests\s+(\d+)\s+passed\b/)?.[1];
  if (!count) fail("PWA test output: passing test total not found");
  return count ? Number.parseInt(count, 10) : null;
}

function workerTestCount(path) {
  if (!path) return null;
  const output = cleanTestOutput(path);
  const tests = output.match(/^# tests (\d+)$/m)?.[1];
  const passed = output.match(/^# pass (\d+)$/m)?.[1];
  const failed = output.match(/^# fail (\d+)$/m)?.[1];
  if (!tests || !passed || failed !== "0" || tests !== passed) {
    fail("Worker test output: complete passing TAP totals not found");
    return null;
  }
  return Number.parseInt(tests, 10);
}

function gitIdentity() {
  const testedCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root })
    .toString()
    .trim();
  const testedTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
    cwd: root,
  })
    .toString()
    .trim();
  const sourceCommit = process.env.CAPABILITY_SOURCE_COMMIT || testedCommit;
  const baseCommit = process.env.CAPABILITY_BASE_COMMIT || null;
  for (const [name, value] of [
    ["source commit", sourceCommit],
    ["base commit", baseCommit],
  ]) {
    if (value && !/^[0-9a-f]{40}$/.test(value)) {
      fail(`Capability evidence: ${name} must be a full commit SHA`);
    }
  }
  const worktreeClean =
    execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: root,
    })
      .toString()
      .trim() === "";
  return {
    source_commit: sourceCommit,
    base_commit: baseCommit,
    tested_commit: testedCommit,
    tested_tree: testedTree,
    worktree_clean: worktreeClean,
  };
}

function ciCheckIdentity(identity) {
  if (process.env.GITHUB_ACTIONS !== "true") return null;
  const required = [
    "CAPABILITY_SOURCE_COMMIT",
    "GITHUB_EVENT_NAME",
    "GITHUB_REPOSITORY",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "GITHUB_JOB",
    "GITHUB_SHA",
    "GITHUB_WORKFLOW_REF",
    "GITHUB_WORKFLOW_SHA",
  ];
  for (const name of required) {
    if (!process.env[name]) fail(`CI capability evidence: ${name} is required`);
  }
  if (
    process.env.GITHUB_SHA &&
    process.env.GITHUB_SHA !== identity.tested_commit
  ) {
    fail(
      `CI capability evidence: tested checkout ${identity.tested_commit} differs from GITHUB_SHA ${process.env.GITHUB_SHA}`,
    );
  }
  if (
    process.env.GITHUB_EVENT_NAME === "pull_request" &&
    !identity.base_commit
  ) {
    fail("CI capability evidence: pull request base commit is required");
  }
  if (
    process.env.GITHUB_WORKFLOW_SHA &&
    !/^[0-9a-f]{40}$/.test(process.env.GITHUB_WORKFLOW_SHA)
  ) {
    fail(
      "CI capability evidence: GITHUB_WORKFLOW_SHA must be a full commit SHA",
    );
  }
  return {
    repository: process.env.GITHUB_REPOSITORY ?? null,
    event_name: process.env.GITHUB_EVENT_NAME ?? null,
    head_ref: process.env.GITHUB_HEAD_REF || null,
    base_ref: process.env.GITHUB_BASE_REF || null,
    workflow_ref: process.env.GITHUB_WORKFLOW_REF ?? null,
    workflow_sha: process.env.GITHUB_WORKFLOW_SHA ?? null,
    run_id: process.env.GITHUB_RUN_ID ?? null,
    run_attempt:
      Number.parseInt(process.env.GITHUB_RUN_ATTEMPT ?? "", 10) || null,
    job: process.env.GITHUB_JOB ?? null,
  };
}

const capabilityMatrixPath = resolve(
  options.get("--capability-matrix") ??
    resolve(root, "docs/CAPABILITY-MATRIX.md"),
);
const capabilityContract = loadCapabilityContract(capabilityMatrixPath);
const capabilityFacts = repositoryCapabilityFacts();
const observedAppTests = appTestCount(options.get("--app-test-output"));
const observedWorkerTests = workerTestCount(
  options.get("--worker-test-output"),
);

if (capabilityContract) {
  const contract = capabilityContract.value;
  if (contract.schema !== "ironwrap_capability_contract_v1") {
    fail(
      "docs/CAPABILITY-MATRIX.md: capability evidence schema must be ironwrap_capability_contract_v1",
    );
  }
  const expected = contract.expected ?? {};
  for (const field of ["total", "top_level", "child"]) {
    compareCapabilityFact(
      `Frappe DocTypes ${field}`,
      expected.frappe_doctypes?.[field],
      capabilityFacts.frappe_doctypes[field],
    );
  }
  for (const field of ["count", "latest"]) {
    compareCapabilityFact(
      `D1 migrations ${field}`,
      expected.d1_migrations?.[field],
      capabilityFacts.d1_migrations[field],
    );
  }
  for (const field of ["pwa", "worker"]) {
    if (
      !Number.isInteger(expected.tests?.[field]) ||
      expected.tests[field] < 1
    ) {
      fail(
        `docs/CAPABILITY-MATRIX.md: expected.tests.${field} must be a positive integer`,
      );
    }
  }
  if (observedAppTests !== null) {
    compareCapabilityFact("PWA tests", expected.tests?.pwa, observedAppTests);
  }
  if (observedWorkerTests !== null) {
    compareCapabilityFact(
      "Worker tests",
      expected.tests?.worker,
      observedWorkerTests,
    );
  }
  const proofPolicy = {
    source: "derive_per_receipt",
    local_tests: "observe_separately",
    ci: "observe_separately",
    merge: "never_infer",
    deploy: "never_infer",
    runtime: "never_infer",
    business_acceptance: "never_infer",
    production_proof: "never_infer",
  };
  for (const [field, value] of Object.entries(proofPolicy)) {
    compareCapabilityFact(
      `proof_state_policy.${field}`,
      value,
      contract.proof_state_policy?.[field],
    );
  }
}

const evidencePath = options.get("--evidence");
if (
  evidencePath &&
  (observedAppTests === null || observedWorkerTests === null)
) {
  fail("capability evidence requires both PWA and Worker test outputs");
}

if (manifest.schema_version !== 1) fail("docs/manifest.json: schema_version must be 1");
if (!Array.isArray(manifest.documents)) fail("docs/manifest.json: documents must be an array");

const paths = entries.map((entry) => entry.path);
const pathSet = new Set(paths);
if (pathSet.size !== paths.length) fail("docs/manifest.json: document paths must be unique");
if (paths.join("\n") !== [...paths].sort().join("\n")) {
  fail("docs/manifest.json: document entries must be sorted by path");
}

for (const entry of entries) {
  if (!entry || typeof entry.path !== "string") {
    fail("docs/manifest.json: every entry needs a path");
    continue;
  }
  if (!allowedClasses.has(entry.class)) {
    fail(`${entry.path}: unknown document class ${JSON.stringify(entry.class)}`);
  }
  if (!trackedSet.has(entry.path)) fail(`${entry.path}: manifest entry is not a tracked file`);
  if (!Array.isArray(entry.authority)) fail(`${entry.path}: authority must be an array`);
}

for (const path of trackedDocuments) {
  if (!pathSet.has(path)) fail(`${path}: tracked document is missing from docs/manifest.json`);
  if (forbiddenBinaryExtensions.has(extname(path).toLowerCase())) {
    fail(`${path}: binary office/PDF documents may not be tracked`);
  }
  if (forbiddenPaths.some((pattern) => pattern.test(path))) {
    fail(`${path}: forbidden legacy, generated, archive, or customer-evidence path`);
  }
}

for (const path of paths) {
  if (!trackedDocuments.includes(path)) fail(`${path}: manifest path is not a tracked document`);
}

const canonicalPaths = new Set(
  entries.filter((entry) => entry.class === "canonical").map((entry) => entry.path),
);
for (const entry of entries) {
  if (entry.class === "canonical") {
    if (entry.authority.length !== 0) fail(`${entry.path}: canonical authority must be empty`);
    continue;
  }
  if (entry.authority.length === 0) fail(`${entry.path}: non-canonical document needs authority`);
  for (const authority of entry.authority) {
    if (!canonicalPaths.has(authority)) {
      fail(`${entry.path}: authority ${authority} is not a registered canonical document`);
    }
  }
}

for (const entry of entries) {
  if (!existsSync(resolve(root, entry.path))) continue;
  const content = readFileSync(resolve(root, entry.path), "utf8");

  if (absoluteWorkstationPath.test(content)) {
    fail(`${entry.path}: contains an absolute workstation path`);
  }

  if (entry.class === "canonical") {
    if (!/^Status:\s+\S+/m.test(content)) fail(`${entry.path}: missing Status metadata`);
    if (!/^Owner:\s+\S+/m.test(content)) fail(`${entry.path}: missing Owner metadata`);
    if (!/^Last (?:verified|source verification):\s+\d{4}-\d{2}-\d{2}/m.test(content)) {
      fail(`${entry.path}: missing dated verification metadata`);
    }
    if (!/^(?:Review trigger|Immediate review trigger):\s+\S+/m.test(content)) {
      fail(`${entry.path}: missing review-trigger metadata`);
    }
  }

  const links = content.matchAll(/!?\[[^\]]*]\(([^)]+)\)/g);
  for (const match of links) {
    let destination = match[1].trim();
    if (destination.startsWith("<") && destination.endsWith(">")) {
      destination = destination.slice(1, -1);
    } else {
      destination = destination.split(/\s+["']/)[0];
    }
    if (
      !destination ||
      destination.startsWith("#") ||
      destination.startsWith("/") ||
      /^(?:https?:|mailto:|tel:|data:)/i.test(destination)
    ) {
      continue;
    }
    destination = destination.split("#", 1)[0].split("?", 1)[0];
    try {
      destination = decodeURIComponent(destination);
    } catch {
      fail(`${entry.path}: invalid URL encoding in link ${match[1]}`);
      continue;
    }
    const target = resolve(root, dirname(entry.path), destination);
    if (!existsSync(target)) {
      fail(`${entry.path}: broken internal link ${match[1]}`);
    } else if (!statSync(target).isFile() && !statSync(target).isDirectory()) {
      fail(`${entry.path}: internal link is not a file or directory ${match[1]}`);
    }
  }
}

const compliance = readFileSync(resolve(root, "docs/COMPLIANCE-REGISTER.md"), "utf8");
const nextReview = compliance.match(/^Next scheduled review:\s+(\d{4}-\d{2}-\d{2})/m)?.[1];
if (!nextReview) {
  fail("docs/COMPLIANCE-REGISTER.md: missing Next scheduled review");
} else if (nextReview < new Date().toISOString().slice(0, 10)) {
  fail(`docs/COMPLIANCE-REGISTER.md: scheduled review expired on ${nextReview}`);
}

if (failures.length) {
  console.error(`documentation validation failed (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

if (evidencePath) {
  const identity = gitIdentity();
  const check = ciCheckIdentity(identity);
  if (failures.length) {
    console.error(`documentation validation failed (${failures.length})`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  const evidence = {
    schema: "ironwrap_capability_evidence_v1",
    generated_at: new Date().toISOString(),
    contract_sha256: capabilityContract.sha256,
    identity: { ...identity, ci_check: check },
    repository: capabilityFacts,
    tests: { pwa: observedAppTests, worker: observedWorkerTests },
    proof_states: {
      source: identity.worktree_clean
        ? "repository_verified_tested_checkout"
        : "working_tree_not_release_eligible",
      local_tests: check ? "not_claimed" : "provided_outputs_verified",
      ci: check ? "evidence_step_passed" : "not_claimed",
      merge: false,
      deploy: false,
      runtime: false,
      business_acceptance: false,
      production_proof: false,
    },
  };
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  writeFileSync(resolve(evidencePath), serialized);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `\n## Exact-head capability evidence\n\n\u0060\u0060\u0060json\n${serialized}\u0060\u0060\u0060\n`,
    );
  }
  console.log(serialized.trim());
}

console.log(
  `ok ${trackedDocuments.length} registered documents validated; ` +
    `${capabilityFacts.frappe_doctypes.total} DocTypes and ${capabilityFacts.d1_migrations.count} migrations match the capability contract`,
);
