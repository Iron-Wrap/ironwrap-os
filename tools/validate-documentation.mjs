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
const forbiddenAuthorityClaims = [
  /Hermes is the operating brain for IronWrap OS/i,
  /Frappe is the operating core/i,
  /Proprietary Frappe operating core/i,
  /Frappe operating core with reads/i,
  /\breliable-agent\b/i,
  /AI agents (?:are assumed to be|that are) 100% reliable/i,
  /Linear [^\n]*source of truth/i,
  /implemented source contract is \*\*131 tools/i,
  /checked-in Worker baseline deliberately leaves `APP_BFF_ENABLED=false`/i,
  /checked-in customer portal is a disabled/i,
  /one tenant \+ one Frappe site \+ one Worker deployment/i,
  /one canonical implementation owner across Facet and Home Config 3D/i,
  /Home Config 3D repository \| Separate predecessor\/lineage product/i,
  /archive\/freeze requires a separate owner decision/i,
  /leftover Frappe\s+adapter receipts are optional sentinels, not a release gate/i,
];
const architectureNavigationDocuments = new Set([
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "app/README.md",
  "workers-bus/README.md",
  "frappe-apps/ironwrap_roofing/README.md",
  "hermes/README.md",
  "mcp/erpnext-roofing-mcp/README.md",
]);
const historicalDesignDocuments = new Set([
  "docs/ACCOUNTING-RECONCILIATION-CONTRACT.md",
  "docs/PRODUCTION-SCHEDULING-CONTRACT.md",
]);

const failures = [];
const fail = (message) => failures.push(message);
const allowedOptions = new Set([
  "--app-test-output",
  "--architecture",
  "--capability-matrix",
  "--clone-playbook",
  "--evidence",
  "--release-control-publication",
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

function loadEmbeddedJsonContract(path, label, startMarker, endMarker) {
  if (!existsSync(path)) {
    fail(`${label} not found: ${path}`);
    return null;
  }
  const content = readFileSync(path, "utf8");
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker);
  if (start === -1 || end === -1 || end <= start) {
    fail(`${label}: missing embedded JSON contract markers`);
    return null;
  }
  const fenced = content.slice(start + startMarker.length, end);
  const json = fenced.match(/```json\s*([\s\S]*?)\s*```/)?.[1];
  if (!json) {
    fail(`${label}: embedded contract must contain one JSON fence`);
    return null;
  }
  try {
    return {
      value: JSON.parse(json),
      sha256: createHash("sha256").update(json).digest("hex"),
    };
  } catch (error) {
    fail(`${label}: invalid embedded JSON: ${error.message}`);
    return null;
  }
}

function loadCapabilityContract(path) {
  return loadEmbeddedJsonContract(
    path,
    "docs/CAPABILITY-MATRIX.md",
    "<!-- capability-evidence-contract:start -->",
    "<!-- capability-evidence-contract:end -->",
  );
}

function loadArchitectureContract(path) {
  return loadEmbeddedJsonContract(
    path,
    "docs/AI-NATIVE-ARCHITECTURE.md",
    "<!-- ai-native-architecture-contract:start -->",
    "<!-- ai-native-architecture-contract:end -->",
  );
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
  // Numbers must start at 0001, be unique, and increase. They deliberately do
  // NOT have to be contiguous: the project's migration rule requires every new
  // migration to take a number above every other open PR head, so a lane whose
  // sibling is abandoned or merged out of order legitimately leaves a gap.
  // Demanding contiguity forces every parallel lane onto the same next number,
  // which is the filename collision the rule exists to prevent. D1 applies
  // migrations in sorted filename order and records them by name, so a gap is
  // inert.
  if (prefixes[0] !== 1) {
    fail("workers-bus/migrations: numbered SQL migrations must start at 0001");
  }
  const duplicate = prefixes.find(
    (prefix, index) => index > 0 && prefix === prefixes[index - 1],
  );
  if (duplicate !== undefined) {
    fail(
      `workers-bus/migrations: duplicate migration number ${String(duplicate).padStart(4, "0")}`,
    );
  }
  if (prefixes.some((prefix, index) => index > 0 && prefix < prefixes[index - 1])) {
    fail(
      "workers-bus/migrations: numbered SQL migrations must increase with filename order",
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

function textFilesUnder(directory, extension) {
  const files = [];
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.name.endsWith(extension)) {
        files.push({ path, content: readFileSync(path, "utf8") });
      }
    }
  }
  return files;
}

function repositoryArchitectureFacts() {
  const sourceRoot = resolve(root, "workers-bus/src");
  const testRoot = resolve(root, "workers-bus/test");
  const sourceFiles = textFilesUnder(sourceRoot, ".ts");
  const testFiles = textFilesUnder(testRoot, ".ts");
  const commercialStorePath = resolve(sourceRoot, "commercial-store.ts");
  const calledOutsideCommercialStore = (symbol) => {
    const pattern = new RegExp(`\\b${symbol}\\s*\\(`);
    return sourceFiles.some(
      (file) => file.path !== commercialStorePath && pattern.test(file.content),
    );
  };
  const calledInTests = (symbol) => {
    const pattern = new RegExp(`\\b${symbol}\\s*\\(`);
    return testFiles.some((file) => pattern.test(file.content));
  };
  const reachability = (symbol) =>
    calledOutsideCommercialStore(symbol)
      ? "production"
      : calledInTests(symbol)
        ? "test_only"
        : "unreachable";

  const acceptance = readFileSync(
    resolve(sourceRoot, "customer-contract-acceptance.ts"),
    "utf8",
  );
  const wrangler = readFileSync(resolve(root, "workers-bus/wrangler.jsonc"), "utf8");
  const configString = (name) => {
    const literal = wrangler.match(
      new RegExp(`"${name}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`),
    )?.[1];
    if (!literal) {
      fail(`workers-bus/wrangler.jsonc: missing top-level ${name}`);
      return "";
    }
    return JSON.parse(literal);
  };
  const configBoolean = (name) => configString(name) === "true";
  let facetRoutesConfigured = false;
  try {
    const routes = JSON.parse(configString("FACET_V2_ROUTES_JSON"));
    facetRoutesConfigured = Array.isArray(routes) && routes.length > 0;
  } catch (error) {
    fail(`workers-bus/wrangler.jsonc: invalid FACET_V2_ROUTES_JSON: ${error.message}`);
  }

  return {
    authority: {
      operating_state: "d1_worker",
      raw_evidence: "r2",
      frappe: "compatibility_projection",
      facet: "design_evidence_producer",
      quickbooks: "posted_accounting_facts",
      ai: "non_authoritative_proposal",
    },
    product_topology: {
      active_products: ["ironwrap_os", "facet"],
      facet_repository: "Iron-Wrap/facet",
      home_config_3d: "retired_draft_lineage_absorbed_into_facet",
      home_config_3d_execution_lane: false,
    },
    maturity: {
      core_technical_design: "strong",
      lead_job_field_foundation: "strong_with_projection_gaps",
      safety_evidence_accounting_controls: "unusually_strong_in_source",
      repository_migration_coherence: "mixed",
      configured_capability: "partial",
      end_to_end_commercial_closure: "incomplete",
      production_customer_proof: "not_established",
    },
    commercial_reachability: {
      approved_quote_revision_writer: reachability("recordCommercialQuoteRevision"),
      proposal_revision_writer: reachability("recordCommercialProposalRevision"),
      proposal_publication_settlement_writer: reachability(
        "recordCommercialProposalPublication",
      ),
      customer_acceptance_writer:
        /return await commitNativeAcceptance\s*\(/.test(acceptance)
          ? "production"
          : "unreachable",
      acceptance_to_deposit_derivation:
        /\bderiveAccountingIntent\s*\(|["']deposit_invoice["']/.test(acceptance)
          ? "wired"
          : "not_wired",
    },
    configuration: {
      effect_runtime_enabled: configBoolean("EFFECT_RUNTIME_ENABLED"),
      quickbooks_oauth_enabled: configBoolean("QB_OAUTH_ENABLED"),
      quickbooks_final_invoice_enabled: configBoolean("QB_FINAL_INVOICE_ENABLED"),
      hermes_desktop_enabled: configBoolean("APP_HERMES_DESKTOP_ENABLED"),
      public_estimator_enabled: configBoolean("PUBLIC_ESTIMATE_ENABLED"),
      newo_enabled: configBoolean("NEWO_ENABLED"),
      postiz_enabled: configBoolean("POSTIZ_ENABLED"),
      facet_routes_configured: facetRoutesConfigured,
      proposal_template_configured:
        configString("PROPOSAL_TEMPLATE_DOC_ID").trim().length > 0,
    },
    proof: {
      repository_verified_for_this_audit: true,
      deployed_exact_source_verified: false,
      provider_readback_journey_verified: false,
      production_reference_journey_verified: false,
      customer_validated: false,
    },
  };
}

function compareCapabilityFact(label, expected, actual) {
  const equal =
    expected !== null && typeof expected === "object"
      ? JSON.stringify(expected) === JSON.stringify(actual)
      : expected === actual;
  if (!equal) {
    fail(
      `docs/CAPABILITY-MATRIX.md: stale ${label}; contract ${JSON.stringify(expected)}, repository ${JSON.stringify(actual)}`,
    );
  }
}

function compareContractSection(label, expected, actual) {
  for (const [field, value] of Object.entries(expected)) {
    compareCapabilityFact(`${label}.${field}`, value, actual?.[field]);
  }
  for (const field of Object.keys(actual ?? {})) {
    if (!(field in expected)) fail(`${label}: unknown field ${field}`);
  }
}

// Repository counts are authored once, in docs/CAPABILITY-MATRIX.md's evidence
// contract, and that contract is gated above. Documents that legitimately restate
// a count in prose were not gated, and every one of them drifted: the clone
// playbook told an operator to stand up a tenant against "the 50-DocType pack"
// (58% under the real total) and "all 31 D1 migrations through 0031" while `main`
// was eighteen shipped migrations further on. Each restatement below is checked
// against the same repository facts, and each must still be present, so the gate
// cannot be silenced by deleting the sentence instead of correcting it.
const restatedCountDocuments = [
  {
    option: "--clone-playbook",
    path: "docs/WHITE-LABEL-CLONE-PLAYBOOK.md",
    claims: [
      {
        label: "DocType pack size",
        shape: "`<total>-DocType pack`",
        // Prose wraps, so every pattern here spans whitespace rather than a
        // literal space: the claims sit mid-paragraph in a hand-edited runbook.
        pattern: /\b(\d+)-DocType\s+pack\b/g,
        expected: (facts) => String(facts.frappe_doctypes.total),
      },
      {
        label: "migration chain length",
        shape: "`All <count> D1 migrations`",
        pattern: /\bAll (\d+) D1 migrations\b/g,
        expected: (facts) => String(facts.d1_migrations.count),
      },
      {
        label: "latest migration filename",
        shape: "``migrations ... through `<latest>.sql` ``",
        pattern: /\bmigrations,? (?:currently )?through\s+`(\d{4}_[a-z0-9_]+\.sql)`/g,
        expected: (facts) => facts.d1_migrations.latest,
      },
    ],
  },
];

function validateRestatedCounts(facts) {
  for (const document of restatedCountDocuments) {
    const path = resolve(root, options.get(document.option) ?? document.path);
    if (!existsSync(path)) {
      fail(`${document.path}: count-gated document not found at ${path}`);
      continue;
    }
    const content = readFileSync(path, "utf8");
    for (const claim of document.claims) {
      const stated = [...content.matchAll(claim.pattern)].map((match) => match[1]);
      if (stated.length === 0) {
        fail(
          `${document.path}: missing ${claim.label} claim; the count gate requires it stated as ${claim.shape}`,
        );
        continue;
      }
      const expected = claim.expected(facts);
      for (const value of stated) {
        if (value !== expected) {
          fail(
            `${document.path}: stale ${claim.label}; document ${JSON.stringify(value)}, repository ${JSON.stringify(expected)}`,
          );
        }
      }
    }
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
const capabilityMatrixContent = readFileSync(capabilityMatrixPath, "utf8");
const releaseControlPublicationPath = resolve(
  options.get("--release-control-publication") ??
    resolve(root, "docs/release-control-publication.json"),
);
const releaseControlPublication = JSON.parse(
  readFileSync(releaseControlPublicationPath, "utf8"),
);
const expectedPublicationKeys = [
  "created_at",
  "default_branch",
  "observed_at",
  "pushed_at",
  "remote_ref",
  "repository",
  "repository_id",
  "repository_workflows",
  "schema",
  "source_commit",
  "visibility",
];
if (
  JSON.stringify(Object.keys(releaseControlPublication).sort()) !==
  JSON.stringify(expectedPublicationKeys)
) {
  fail("docs/release-control-publication.json: evidence shape is invalid");
}
if (
  releaseControlPublication.schema !== "release_control_publication_evidence_v1" ||
  releaseControlPublication.repository !== "Iron-Wrap/release-control-plane" ||
  releaseControlPublication.visibility !== "private" ||
  releaseControlPublication.default_branch !== "main" ||
  releaseControlPublication.remote_ref !== "refs/heads/main" ||
  !Number.isInteger(releaseControlPublication.repository_id) ||
  releaseControlPublication.repository_id <= 0 ||
  !/^[0-9a-f]{40}$/.test(releaseControlPublication.source_commit) ||
  !Array.isArray(releaseControlPublication.repository_workflows) ||
  !releaseControlPublication.repository_workflows.every(
    (workflow) => typeof workflow === "string" && workflow.length > 0,
  ) ||
  !["observed_at", "created_at", "pushed_at"].every(
    (field) => Number.isFinite(Date.parse(releaseControlPublication[field])),
  )
) {
  fail("docs/release-control-publication.json: evidence values are invalid");
}
for (const [pattern, claim] of [
  [/IRO-218/, "IRO-218"],
  [/IRO-219/, "IRO-219"],
  [/IRO-220/, "IRO-220"],
  [/IRO-221/, "IRO-221"],
  [/IRO-222/, "IRO-222"],
  [/IRO-223/, "IRO-223"],
  [/Iron-Wrap\/release-control-plane/, "Iron-Wrap/release-control-plane"],
  [
    /Source publication proves only repository availability/,
    "release-control source publication remains non-deployment proof",
  ],
  [/2-of-3/, "2-of-3"],
  [/required release evidence while the Frappe wheel/, "required Frappe release evidence"],
  [/D --> A/, "IRO-223 -> IRO-218"],
  [/D --> I/, "IRO-223 -> IRO-219"],
  [/D --> C/, "IRO-223 -> IRO-220"],
  [/D --> R/, "IRO-223 -> IRO-221"],
  [/A --> P/, "IRO-218 -> IRO-222"],
  [/I --> P/, "IRO-219 -> IRO-222"],
  [/C --> P/, "IRO-220 -> IRO-222"],
  [/R --> P/, "IRO-221 -> IRO-222"],
  [/P --> G/, "IRO-222 -> IRO-41"],
]) {
  if (!pattern.test(capabilityMatrixContent)) {
    fail(`docs/CAPABILITY-MATRIX.md: missing release-control claim ${claim}`);
  }
}
for (const [value, claim] of [
  [releaseControlPublication.repository, "publication repository"],
  [releaseControlPublication.default_branch, "publication default branch"],
  [releaseControlPublication.source_commit, "publication source commit"],
  [releaseControlPublication.observed_at, "publication observation time"],
]) {
  if (!capabilityMatrixContent.includes(value)) {
    fail(`docs/CAPABILITY-MATRIX.md: missing release-control claim ${claim}`);
  }
}
const publicationHasNoWorkflows =
  releaseControlPublication.repository_workflows.length === 0;
const planSaysSnapshotHasNoWorkflows = capabilityMatrixContent.includes(
  "snapshot records no repository CI workflows",
);
if (publicationHasNoWorkflows !== planSaysSnapshotHasNoWorkflows) {
  fail(
    "docs/CAPABILITY-MATRIX.md: repository CI claim does not match release-control publication evidence",
  );
}
const deployWorkflow = readFileSync(resolve(root, ".github/workflows/deploy.yml"), "utf8");
const workflowBuildsFrappeWheel = deployWorkflow.includes("frappe/ironwrap_roofing.whl");
const planRequiresFrappeReceipts = capabilityMatrixContent.includes(
  "required release evidence while the Frappe wheel",
);
if (workflowBuildsFrappeWheel !== planRequiresFrappeReceipts) {
  fail(
    "docs/CAPABILITY-MATRIX.md: Frappe release gate must match whether deploy.yml ships the wheel",
  );
}
const workflowInvokesServiceAdapter = /\bservice-adapter\b/.test(deployWorkflow);
const planSaysAdapterIsNotInvoked = /does not\s+deliver those bytes to an immutable provider-stage revision or invoke the checked-in\s+`service-adapter` client/.test(
  capabilityMatrixContent,
);
if (workflowInvokesServiceAdapter === planSaysAdapterIsNotInvoked) {
  fail(
    "docs/CAPABILITY-MATRIX.md: service-adapter invocation claim does not match deploy.yml",
  );
}
const capabilityFacts = repositoryCapabilityFacts();
const architectureContract = loadArchitectureContract(
  resolve(
    options.get("--architecture") ??
      resolve(root, "docs/AI-NATIVE-ARCHITECTURE.md"),
  ),
);
const architectureFacts = repositoryArchitectureFacts();
validateRestatedCounts(capabilityFacts);
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
    technical_reference_proof: "never_infer",
    customer_validation: "never_infer",
  };
  for (const [field, value] of Object.entries(proofPolicy)) {
    compareCapabilityFact(
      `proof_state_policy.${field}`,
      value,
      contract.proof_state_policy?.[field],
    );
  }
}

if (architectureContract) {
  const contract = architectureContract.value;
  if (contract.schema !== "ironwrap_ai_native_architecture_contract_v1") {
    fail(
      "docs/AI-NATIVE-ARCHITECTURE.md: architecture schema must be ironwrap_ai_native_architecture_contract_v1",
    );
  }
  for (const section of [
    "authority",
    "product_topology",
    "maturity",
    "commercial_reachability",
    "configuration",
    "proof",
  ]) {
    compareContractSection(
      `docs/AI-NATIVE-ARCHITECTURE.md:${section}`,
      architectureFacts[section],
      contract[section],
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

  for (const pattern of forbiddenAuthorityClaims) {
    if (pattern.test(content)) {
      fail(`${entry.path}: contains forbidden legacy authority claim ${pattern}`);
    }
  }
  if (
    architectureNavigationDocuments.has(entry.path) &&
    !content.includes("AI-NATIVE-ARCHITECTURE.md")
  ) {
    fail(`${entry.path}: must link to docs/AI-NATIVE-ARCHITECTURE.md`);
  }
  if (
    historicalDesignDocuments.has(entry.path) &&
    !/^Status:\s+historical\b/m.test(content)
  ) {
    fail(`${entry.path}: historical design document must declare historical status`);
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
      technical_reference_proof: false,
      customer_validation: false,
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
    `${capabilityFacts.frappe_doctypes.total} DocTypes and ${capabilityFacts.d1_migrations.count} migrations match the capability contract ` +
    `and AI-native authority/reachability/configuration claims match source`,
);
