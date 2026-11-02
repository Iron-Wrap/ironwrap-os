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
  "--ai-team-contract",
  "--app-test-output",
  "--architecture",
  "--capability-matrix",
  "--clone-playbook",
  "--evidence",
  "--launch-runbook",
  "--local-readme",
  "--migration-root",
  "--release-control-publication",
  "--worker-readme",
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

  const migrationRoot = resolve(
    options.get("--migration-root") ?? resolve(root, "workers-bus/migrations"),
  );
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
  const recoveryCompanions = new Set([
    "0110_zz_stage_portal_decision_captures.sql",
    "0114_zy_work_package_worker_ack_backfill.sql",
    "0114_zz_restore_portal_decision_captures.sql",
  ]);
  const migrationsByPrefix = new Map();
  for (const migration of migrations) {
    const prefix = migration.slice(0, 4);
    const names = migrationsByPrefix.get(prefix) ?? [];
    names.push(migration);
    migrationsByPrefix.set(prefix, names);
  }
  for (const [prefix, names] of migrationsByPrefix) {
    if (names.length <= 1) continue;
    const ordinary = names.filter((name) => !recoveryCompanions.has(name));
    if (ordinary.length !== 1) {
      fail(`workers-bus/migrations: duplicate migration number ${prefix}`);
    }
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
  const appApi = readFileSync(resolve(sourceRoot, "app-api.ts"), "utf8");
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
  const quoteRevisionRouteReachable =
    appApi.includes('url.pathname === "/api/v1/commercial/quote-revisions"') &&
    appApi.includes("return await createCommercialQuoteRevision(req, env, auth);");
  const proposalRevisionRouteReachable =
    appApi.includes('url.pathname === "/api/v1/commercial/proposal-revisions"') &&
    appApi.includes("return await createCommercialProposalRevision(req, env, auth);");
  const proposalPublicationRouteReachable =
    appApi.includes('url.pathname === "/api/v1/commercial/proposal-publications"') &&
    appApi.includes("return await settleCommercialProposalPublication(req, env, auth);");
  const depositRecoveryRouteReachable =
    appApi.includes('url.pathname === "/api/v1/commercial/deposit-intents/reconcile"') &&
    appApi.includes("beginCommercialDepositDerivationRequest");

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
      lead_job_field_foundation: "strong_with_acceptance_projection",
      safety_evidence_accounting_controls: "unusually_strong_in_source",
      repository_migration_coherence: "mixed",
      configured_capability: "partial",
      end_to_end_commercial_closure: "incomplete",
      production_customer_proof: "not_established",
    },
    commercial_reachability: {
      approved_quote_revision_writer: quoteRevisionRouteReachable
        ? "authenticated_role_api"
        : reachability("recordCommercialQuoteRevision"),
      proposal_revision_writer: proposalRevisionRouteReachable
        ? "authenticated_role_api"
        : reachability("recordCommercialProposalRevision"),
      proposal_publication_settlement_writer: proposalPublicationRouteReachable
        ? "authenticated_role_api_readback_required"
        : reachability("recordCommercialProposalPublication"),
      customer_acceptance_writer:
        /return await commitNativeAcceptance\s*\(/.test(acceptance)
          ? "production"
          : "unreachable",
      acceptance_to_deposit_derivation:
        /ensureCommercialDepositDerivation\s*\(/.test(acceptance) &&
          depositRecoveryRouteReachable
          ? "acceptance_queue_and_authenticated_recovery_api"
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
      `${label}: stale value; expected ${JSON.stringify(expected)}, actual ${JSON.stringify(actual)}`,
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
const facetProjectionDocuments = [
  {
    label: "workers-bus/README.md",
    path: resolve(
      options.get("--worker-readme") ?? resolve(root, "workers-bus/README.md"),
    ),
  },
  {
    label: "docs/LAUNCH-RUNBOOK.md",
    path: resolve(
      options.get("--launch-runbook") ?? resolve(root, "docs/LAUNCH-RUNBOOK.md"),
    ),
  },
  {
    label: "docs/CAPABILITY-MATRIX.md",
    path: capabilityMatrixPath,
  },
  {
    label: "deploy/local/README.md",
    path: resolve(
      options.get("--local-readme") ?? resolve(root, "deploy/local/README.md"),
    ),
  },
];
const facetProjectionRequiredClaims = [
  [
    /FACET_DESIGN_FRAPPE_PROJECTION_ENABLED/,
    "canonical compatibility flag",
  ],
  [
    /default-off\s*\(`false`\)\s*in every checked-in\s+environment/i,
    "default-off checked-in configuration",
  ],
  [
    /blank,\s+non-customer-safe\s+`Draft`\s+Customer Quote/i,
    "blank non-customer-safe Draft mutation",
  ],
  [
    /marks the predecessor projected quote\s+`Rejected`/i,
    "predecessor rejection on chain advance",
  ],
  [
    /supplies no price,\s+line items,\s+taxes,\s+payment schedule,\s+or commercial terms/i,
    "absence of projected commercial terms",
  ],
];
const facetProjectionForbiddenClaims = [
  [/FACET_V2_FRAPPE_PROJECTION_ENABLED/, "stale compatibility flag"],
  [/does not create or update a quote/i, "false no-quote-mutation claim"],
  [
    /leaves the\s+quote,\s+Contract Acceptance/i,
    "ambiguous quote-unchanged projection claim",
  ],
  [
    /Projection remains bounded evidence plus reconciliation only;[\s\S]{0,100}does not\s+directly mutate a quote/i,
    "false evidence-only projection claim",
  ],
];
for (const document of facetProjectionDocuments) {
  const content = readFileSync(document.path, "utf8");
  for (const [pattern, claim] of facetProjectionRequiredClaims) {
    if (!pattern.test(content)) {
      fail(`${document.label}: missing Facet compatibility claim ${claim}`);
    }
  }
  for (const [pattern, claim] of facetProjectionForbiddenClaims) {
    if (pattern.test(content)) {
      fail(`${document.label}: contains ${claim}`);
    }
  }
}
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
// Frappe adapter receipts gate a release exactly when deploy.yml declares an
// in-scope Frappe train; the wheel is digest-bound into the artifact either way.
const workflowPromotesFrappe = /^\s*RELEASE_FRAPPE_SCOPE: in-scope$/m.test(deployWorkflow);
const planRequiresFrappeReceipts = capabilityMatrixContent.includes(
  "required release evidence while the Frappe wheel",
);
if (workflowPromotesFrappe !== planRequiresFrappeReceipts) {
  fail(
    "docs/CAPABILITY-MATRIX.md: Frappe release gate must match deploy.yml RELEASE_FRAPPE_SCOPE",
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
    if (contract.test_observation_policy?.[field] !== "observe_per_receipt") {
      fail(
        `docs/CAPABILITY-MATRIX.md: test_observation_policy.${field} must be observe_per_receipt`,
      );
    }
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

// docs/AI-TEAM-CONTRACT.md embeds the roster, action catalog, watches and receipt schema that the
// agent runtime, the Worker action registry and the specialist evaluations read mechanically.
// Specialist ids are directory names, and the owner's decisions pin the actions and watches below:
// a catalog edit cannot let a consequential action stop asking first, turn live answering on by
// default, slow an owner report, or hand a people-only act to an agent without this gate changing
// too. The prose catalog rows must match the block, so neither drifts alone.
const AI_TEAM_LABEL = "docs/AI-TEAM-CONTRACT.md";
const AI_TEAM_SCHEMA = "ironwrap_ai_team_contract_v1";
const AI_TEAM_KEYS = ["schema", "specialists", "actions", "watches", "receipt"];
const AI_TEAM_SPECIALISTS = [
  "orchestrator",
  "market_analyst",
  "lead_concierge",
  "estimator",
  "measurement_design",
  "proposal_contract",
  "purchasing_inventory",
  "shop_planner",
  "scheduler_dispatcher",
  "field_safety",
  "quality_inspector",
  "billing_reconciliation",
  "compliance",
  "customer_care_warranty",
  "marketing_reputation",
  "independent_auditor",
];
const AI_TEAM_ROLES = new Set(["owner", "ops", "sales", "production", "accounting", "field"]);
const AI_TEAM_CLASSES = new Set(["A0", "A1", "A2", "A3", "H"]);
const AI_TEAM_SIDE_EFFECTS = new Set([
  "none",
  "internal_reversible",
  "external_reversible",
  "external_irreversible",
  "money",
  "legal",
  "safety",
]);
const AI_TEAM_UNDO = new Set(["none", "automatic", "manual"]);
const AI_TEAM_READBACKS = new Set(["none", "owned_store", "provider"]);
const AI_TEAM_START_WORDS = {
  asks_first: "Asks first",
  within_limits: "Acts within your limits",
  off_until_enabled: "Off until you turn it on",
};
const AI_TEAM_AGGREGATES = new Set([
  "any",
  "coordination_run",
  "exception",
  "report",
  "notification",
  "delegation",
  "policy",
  "finding",
  "envelope",
  "inbound",
  "alert",
  "storm_watch",
  "market_watch_item",
  "lead",
  "consent",
  "conversation",
  "appointment",
  "reception_script",
  "portal_link",
  "privacy_case",
  "property",
  "measurement",
  "design_basis",
  "takeoff",
  "quote",
  "proposal",
  "change_order",
  "insurance_supplement",
  "acceptance",
  "terms",
  "job",
  "gate",
  "work_package",
  "evidence",
  "field_record",
  "safety_occurrence",
  "ncr",
  "completion",
  "service_case",
  "crew_assignment",
  "authority_record",
  "user_access",
  "asset",
  "supplier",
  "supplier_quote",
  "catalog_snapshot",
  "purchase_order",
  "payee",
  "inventory_position",
  "shop_order",
  "money_item",
  "tax_snapshot",
  "filing",
  "content",
  "claim",
  "campaign",
  "note",
  "price_book",
  "storm_mode",
  "tax_slip",
  "specialist_hold",
  "field_item",
  "settings",
  "import_run",
  "tenant",
]);
const AI_TEAM_RECEIPT_FIELDS = [
  "specialist_id",
  "run_id",
  "action_id",
  "did",
  "doing",
  "needs_from_you",
  "sources",
  "policy",
  "permit",
  "tool",
  "readback",
  "outcome",
  "undo",
  "do_it_myself",
];
const AI_TEAM_SOURCE_FIELDS = ["fact_id", "version", "hash"];
const AI_TEAM_OUTCOMES = ["succeeded", "failed", "unknown", "abstained"];
// Owner decision IRW-R8: these stay with a person until the owner delegates them.
const AI_TEAM_OWNER_ASKS_FIRST = [
  "customer_message.send",
  "visit.confirm",
  "portal_link.send",
  "change_order.send_for_decision",
  "remedy.offer",
  "campaign.send",
  "privacy_request.answer",
  "proposal.publish",
  "proposal.withdraw",
  "claim.approve",
  "content.publish",
  "review_response.publish",
  "reception_script.publish",
  "crew_date.commit",
  "purchase_order.place",
  "purchase_order.change",
  "shop_order.release",
  "work_package.issue",
  "quote.commit_revision",
  "quote.apply_discount",
  "price_book.propose_change",
  "change_order.commit",
  "insurance_supplement.send",
  "invoice.commit_intent",
  "reconciliation.resolve",
  "supplier_bill.approve",
  "tax_snapshot.record",
  "holdback.release",
  "cost_recovery.claim",
  "supplier_return.request",
  "ad_spend.commit",
  "stock.adjust_count",
  "ncr.disposition",
  "consent.record",
  "cancellation.record",
  "authority.record",
];
// Releasing a protection, approving a control the agents work under, or an owner-only right:
// these ask first whatever the owner delegates elsewhere.
const AI_TEAM_ALWAYS_ASKS_FIRST = [
  "inbound.release",
  "stock.release_quarantine",
  "work_package.release_hold",
  "gate.clear",
  "claim.approve",
  "reception_script.publish",
  "finding.close",
  "supplier.onboard",
  "authority.record",
  "consent.record",
  "holdback.release",
  "privacy_request.answer",
  "price_book.propose_change",
  "storm_mode.propose",
  "shop_order.release_hold",
  "cancellation.release_hold",
  "ncr.verify_close",
  // Capped at asks first by owner ruling D-09: the price and sending a proposal, a change order or
  // an invoice.
  "quote.commit_revision",
  "quote.apply_discount",
  "proposal.publish",
  "change_order.send_for_decision",
  "invoice.commit_intent",
  // Capped because a sent message cannot be undone and reminders go by approval only (D-05, Q4).
  "customer_message.send",
  // Every other send outside IronWrap and every price commitment the owner capped (L04, D-09).
  "visit.confirm",
  "portal_link.send",
  "remedy.offer",
  "campaign.send",
  "review_response.publish",
  "insurance_supplement.send",
  "change_order.commit",
  "rfq.send",
  "purchase_order.place",
  "purchase_order.change",
  "purchase_order.expedite",
  "supplier_message.send",
  "supplier_return.request",
  "document.request",
  "cost_recovery.claim",
  "content.publish",
  // Money committed to an outside party.
  "ad_spend.commit",
  "supplier_bill.approve",
];
// Human-only: never an agent's act, never delegable.
const AI_TEAM_PEOPLE_ONLY = [
  "acceptance.customer_decision",
  "safety_stop.release",
  "gate.waive",
  "refund.issue",
  "write_off.record",
  "terms.legal_signoff",
  "filing.submit",
  "payee.change_details",
  "delegation.set",
  "policy.activate",
  "access.change",
  "payee.unfreeze",
  "settings.apply",
  "completion.accept",
  "hold_point.release",
  "onboarding.go_live",
];
// An agent prepares these people-only acts for the person and never performs them.
const AI_TEAM_PREPARES_PEOPLE_ONLY = ["payee.unfreeze_prepare", "safety_stop.release_prepare", "access.prepare_change"];
const AI_TEAM_CUSTOMER_DISCLOSURE_REQUIRED = [
  "customer_message.send",
  "conversation.answer_live",
  "portal_link.send",
  "change_order.send_for_decision",
  "remedy.offer",
];
// Nothing answers a live conversation before the owner turns it on.
const AI_TEAM_OFF_UNTIL_ENABLED = ["conversation.answer_live"];
// The reviewed A2 actions with an outside effect: a new one fails here until it is reviewed and listed.
const AI_TEAM_EXTERNAL_A2 = [
  "conversation.answer_live",
  "rfq.send",
  "purchase_order.expedite",
  "document.request",
  "privacy_incident.contain",
  "content.stop",
];
// Delegation, policy, settings, the tenant and access change only by people's own acts; no agent
// action may write them.
const AI_TEAM_OWNER_ONLY_AGGREGATES = new Set(["delegation", "policy", "settings", "tenant", "user_access"]);
// Closed reason_code vocabularies: each pair shares one list, and the prose table repeats it.
const AI_TEAM_REASON_CODE_PAIRS = [
  ["stock.quarantine", "stock.release_quarantine"],
  ["inbound.quarantine", "inbound.release"],
  ["crew_date.commit", "crew_slot.hold"],
];
const AI_TEAM_REASON_CODE = /^[a-z][a-z0-9_]*$/;
const AI_TEAM_REASON_TABLE_HEADER = "| Actions | When a reason is required | Reason codes |";
// The owner's report cadence and the detected-storm watch.
const AI_TEAM_REQUIRED_WATCHES = [
  ["new_leads", "lead_concierge", "PT15M"],
  ["pipeline", "orchestrator", "PT1H"],
  ["daily_owner_brief", "orchestrator", "P1D"],
  ["weekly_review", "orchestrator", "P7D"],
  ["storm_events", "market_analyst", null],
  ["working_alone_checkin_missed", "field_safety", null],
  ["page_unacknowledged", "field_safety", null],
  ["page_unacknowledged", "orchestrator", null],
];
const AI_TEAM_ACTION_ID = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
// The words a screen shows for an action ("… finished sending a customer message"): a lower-case
// phrase that starts with a gerund, with no code, id or digit in it. A gerund's stem before "ing"
// has two or more letters and a vowel, so "string" and "ring" are not gerunds.
const AI_TEAM_ACTION_NAME = /^[a-z]+ing(?:[ ,'-]+[a-z]+)*$/;
const AI_TEAM_ACTION_NAME_MAX = 60;
const aiTeamGerundName = (name) => {
  const stem = /^([a-z]+)ing\b/.exec(name)?.[1] ?? "";
  return stem.length >= 2 && /[aeiouy]/.test(stem);
};
const AI_TEAM_WATCH_ID = /^[a-z][a-z0-9_]*$/;
const AI_TEAM_EVENT = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const AI_TEAM_DURATION =
  /^P(?!$)(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/;
const AI_TEAM_CATALOG_GROUP =
  /^#### (?:Catalog: .* \(`([a-z][a-z0-9_]*)`\)|(Shared by every specialist)|(People only, owned by no specialist))$/;
const AI_TEAM_PROSE_OWNERS = /Owners: ((?:`[a-z][a-z0-9_]*`(?:, )?)+)\.$/;

const sameList = (actual, expected) =>
  Array.isArray(actual) &&
  actual.length === expected.length &&
  actual.every((item, index) => item === expected[index]);
const sameSet = (actual, expected) =>
  Array.isArray(actual) && sameList([...actual].sort(), [...expected].sort());

function aiTeamStartStates(action) {
  if (action.autonomy === "A3") return ["asks_first"];
  if (action.autonomy !== "A2") return [null];
  if (action.side_effect_class === "internal_reversible") return ["within_limits"];
  return ["asks_first", "off_until_enabled"];
}

function validateAiTeamAction(action, actionById) {
  const id = action?.action_id;
  if (typeof id !== "string" || !AI_TEAM_ACTION_ID.test(id)) {
    fail(`${AI_TEAM_LABEL}: invalid action_id ${JSON.stringify(id)}`);
    return;
  }
  if (actionById.has(id)) fail(`${AI_TEAM_LABEL}: duplicate action_id ${id}`);
  actionById.set(id, action);
  const where = `${AI_TEAM_LABEL}: ${id}`;
  if (
    typeof action.name !== "string" ||
    action.name.length > AI_TEAM_ACTION_NAME_MAX ||
    !AI_TEAM_ACTION_NAME.test(action.name) ||
    !aiTeamGerundName(action.name)
  ) {
    fail(`${where}: name must be a lower-case phrase of at most ${AI_TEAM_ACTION_NAME_MAX} characters that starts with a gerund and holds no code (no ".", "_" or digit)`);
  }
  const owners = Array.isArray(action.owners) ? action.owners : [];
  if (owners.length === 0 && action.autonomy !== "H") fail(`${where}: owners must be a non-empty array unless the act is H`);
  if (new Set(owners).size !== owners.length) fail(`${where}: duplicate owner`);
  for (const owner of owners) {
    if (!AI_TEAM_SPECIALISTS.includes(owner)) fail(`${where}: owner ${owner} is not a specialist`);
  }
  if (!AI_TEAM_CLASSES.has(action.autonomy)) fail(`${where}: autonomy must be A0, A1, A2, A3 or H`);
  const draftsOnly = ["A0", "A1"].includes(action.autonomy);
  const acts = ["A2", "A3"].includes(action.autonomy);
  if (action.human_only !== (action.autonomy === "H")) {
    fail(`${where}: human_only must be true exactly when the class is H`);
  }
  if (action.requires_citations !== (action.autonomy !== "H")) {
    fail(`${where}: requires_citations must be true for every agent action and false for H`);
  }
  if (!AI_TEAM_SIDE_EFFECTS.has(action.side_effect_class)) fail(`${where}: unknown side_effect_class`);
  if (!AI_TEAM_UNDO.has(action.undo)) fail(`${where}: unknown undo`);
  if (draftsOnly && (action.side_effect_class !== "none" || action.undo !== "none")) {
    fail(`${where}: A0 and A1 actions have no side effect and nothing to undo`);
  }
  if (acts && action.side_effect_class === "none") fail(`${where}: A2 and A3 actions need a side_effect_class`);
  if (["money", "legal", "safety"].includes(action.side_effect_class) && !["A3", "H"].includes(action.autonomy)) {
    fail(`${where}: a ${action.side_effect_class} effect must be class A3 or H`);
  }
  if (!AI_TEAM_AGGREGATES.has(action.aggregate) || (action.aggregate === "any" && action.autonomy !== "A0")) {
    fail(`${where}: aggregate must be a listed aggregate, and any is for A0 reads only`);
  }
  if (acts && AI_TEAM_OWNER_ONLY_AGGREGATES.has(action.aggregate)) {
    fail(`${where}: an A2 or A3 action may not act on ${action.aggregate}`);
  }
  if (action.autonomy === "A2" && /^external_/.test(action.side_effect_class ?? "") && !AI_TEAM_EXTERNAL_A2.includes(id)) {
    fail(`${where}: an A2 action with an outside effect must be on the reviewed list`);
  }
  if (!AI_TEAM_READBACKS.has(action.readback) || (action.readback === "none") !== draftsOnly) {
    fail(`${where}: readback must be none exactly for A0 and A1 actions`);
  }
  const starts = aiTeamStartStates(action);
  if (!starts.includes(action.default_delegation)) {
    fail(`${where}: default_delegation must be ${starts.map((start) => start ?? "null").join(" or ")}`);
  }
  if (typeof action.protective !== "boolean") fail(`${where}: protective must be a boolean`);
  if (action.protective && !(action.autonomy === "A2" && action.side_effect_class === "internal_reversible")) {
    fail(`${where}: protective actions are A2 with an internal_reversible effect`);
  }
  const delegable = acts && !action.protective && !AI_TEAM_ALWAYS_ASKS_FIRST.includes(id);
  if (action.delegable !== delegable) fail(`${where}: delegable must be ${delegable}`);
  if (action.reviewer_role !== null && action.reviewer_role !== undefined) {
    if (!AI_TEAM_ROLES.has(action.reviewer_role) || !acts) {
      fail(`${where}: reviewer_role must be null or a reviewer role on an A2 or A3 action`);
    }
  }
  // Optional keys, present only on the actions they constrain.
  if (Object.hasOwn(action, "reason_codes")) {
    const codes = action.reason_codes;
    if (!Array.isArray(codes) || codes.length === 0 || new Set(codes).size !== codes.length ||
      !codes.every((code) => typeof code === "string" && AI_TEAM_REASON_CODE.test(code))) {
      fail(`${where}: reason_codes must be a non-empty list of distinct snake_case codes`);
    }
  }
  if (Object.hasOwn(action, "never_targets")) {
    const targets = action.never_targets;
    if (!Array.isArray(targets) || targets.length === 0 || !targets.every((target) => AI_TEAM_SPECIALISTS.includes(target))) {
      fail(`${where}: never_targets must be a non-empty list of specialist ids`);
    }
  }
}

function validateAiTeamWatches(watches, actionById, specialistIds) {
  const seen = new Set();
  const byOwner = new Map();
  for (const watch of watches) {
    const watchId = watch?.watch_id;
    const owner = watch?.owner;
    const where = `${AI_TEAM_LABEL}: ${owner}`;
    if (typeof watchId !== "string" || !AI_TEAM_WATCH_ID.test(watchId)) {
      fail(`${where}: invalid watch_id ${JSON.stringify(watchId)}`);
      continue;
    }
    if (!specialistIds.includes(owner)) fail(`${AI_TEAM_LABEL}: watch ${watchId} owner ${owner} is not a specialist`);
    if (seen.has(`${owner}/${watchId}`)) fail(`${where}: duplicate watch_id ${watchId}`);
    seen.add(`${owner}/${watchId}`);
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), watchId]);
    const hasEvery = Object.hasOwn(watch, "every");
    const hasTrigger = Object.hasOwn(watch, "trigger");
    if (hasEvery === hasTrigger) fail(`${where}: watch ${watchId} needs exactly one of every or trigger`);
    if (hasEvery && !AI_TEAM_DURATION.test(watch.every ?? "")) {
      fail(`${where}: watch ${watchId} every must be an ISO 8601 duration`);
    }
    if (hasTrigger && !AI_TEAM_EVENT.test(watch.trigger ?? "")) {
      fail(`${where}: watch ${watchId} trigger must be an event name`);
    }
    if (Object.hasOwn(watch, "after")) {
      if (!hasTrigger || !Array.isArray(watch.after) || watch.after.length === 0 ||
        !watch.after.every((duration) => AI_TEAM_DURATION.test(duration ?? ""))) {
        fail(`${where}: watch ${watchId} after must list ISO 8601 durations after a trigger`);
      }
    }
    const proposes = Array.isArray(watch.proposes) ? watch.proposes : [];
    if (proposes.length === 0) fail(`${where}: watch ${watchId} must propose at least one action`);
    for (const actionId of proposes) {
      const action = actionById.get(actionId);
      if (!action) fail(`${where}: watch ${watchId} proposes unknown action ${actionId}`);
      else if (!action.owners?.includes(owner)) {
        fail(`${where}: watch ${watchId} proposes ${actionId}, which ${owner} does not own`);
      }
    }
  }
  for (const [watchId, owner, every] of AI_TEAM_REQUIRED_WATCHES) {
    const watch = watches.find((item) => item?.watch_id === watchId && item?.owner === owner);
    if (every && watch?.every !== every) {
      fail(`${AI_TEAM_LABEL}: owner report watch ${watchId} for ${owner} must run every ${every}`);
    } else if (!every && !watch?.trigger) {
      fail(`${AI_TEAM_LABEL}: watch ${watchId} for ${owner} must be event-triggered`);
    }
  }
  return byOwner;
}

function validateAiTeamContract(contract, content) {
  if (!sameSet(Object.keys(contract ?? {}), AI_TEAM_KEYS)) {
    fail(`${AI_TEAM_LABEL}: top-level keys must be ${AI_TEAM_KEYS.join(", ")}`);
  }
  if (contract?.schema !== AI_TEAM_SCHEMA) fail(`${AI_TEAM_LABEL}: schema must be ${AI_TEAM_SCHEMA}`);
  const specialists = Array.isArray(contract?.specialists) ? contract.specialists : [];
  const actions = Array.isArray(contract?.actions) ? contract.actions : [];
  const watches = Array.isArray(contract?.watches) ? contract.watches : [];
  const specialistIds = specialists.map((specialist) => specialist?.specialist_id);
  if (!sameSet(specialistIds, AI_TEAM_SPECIALISTS) || new Set(specialistIds).size !== specialistIds.length) {
    fail(`${AI_TEAM_LABEL}: specialists must be exactly ${AI_TEAM_SPECIALISTS.join(", ")}`);
  }

  const actionById = new Map();
  for (const action of actions) validateAiTeamAction(action, actionById);
  const actionByName = new Map();
  for (const action of actions) {
    if (typeof action?.name !== "string") continue;
    if (actionByName.has(action.name)) {
      fail(`${AI_TEAM_LABEL}: ${action.action_id}: name "${action.name}" repeats ${actionByName.get(action.name)}'s; every action needs its own name`);
    } else actionByName.set(action.name, action.action_id);
  }
  const pins = [
    [AI_TEAM_OWNER_ASKS_FIRST, (action) => action.autonomy === "A3", "the owner's launch rule requires class A3"],
    // A send outside the company asks first even at class A2 (rfq.send), so the rule is the start state.
    [AI_TEAM_ALWAYS_ASKS_FIRST, (action) => action.default_delegation === "asks_first", "always asks first, so it must start as asks first"],
    [AI_TEAM_PEOPLE_ONLY, (action) => action.autonomy === "H", "the owner's launch rule requires class H"],
    [
      AI_TEAM_EXTERNAL_A2,
      (action) => action.autonomy === "A2" && /^external_/.test(action.side_effect_class ?? ""),
      "is on the reviewed list of A2 actions with an outside effect, so it must be one",
    ],
    [
      ["specialist.hold"],
      (action) => action.aggregate === "specialist_hold",
      "sets a hold flag on its own aggregate, specialist_hold",
    ],
    [
      ["specialist.hold"],
      (action) => Array.isArray(action.never_targets) && action.never_targets.includes("independent_auditor"),
      "can never be set on the AI auditor, so never_targets must list independent_auditor",
    ],
    [
      AI_TEAM_PREPARES_PEOPLE_ONLY,
      (action) => action.autonomy === "A1",
      "prepares a people-only act and never performs it, so it must be class A1",
    ],
    [
      AI_TEAM_OFF_UNTIL_ENABLED,
      (action) => action.default_delegation === "off_until_enabled",
      "nothing answers live before the owner turns it on, so default_delegation must be off_until_enabled",
    ],
  ];
  for (const [ids, holds, rule] of pins) {
    for (const id of ids) {
      const action = actionById.get(id);
      if (!action) fail(`${AI_TEAM_LABEL}: ${id}: missing from the catalog; an owner decision names it`);
      else if (!holds(action)) fail(`${AI_TEAM_LABEL}: ${id}: ${rule}`);
    }
  }

  const watchesByOwner = validateAiTeamWatches(watches, actionById, specialistIds);
  for (const specialist of specialists) {
    const id = specialist?.specialist_id;
    const where = `${AI_TEAM_LABEL}: ${id}`;
    if (typeof specialist?.display_name !== "string" || !specialist.display_name.trim()) {
      fail(`${where}: display_name is required`);
    }
    if (!AI_TEAM_ROLES.has(specialist?.reviewer_role)) fail(`${where}: reviewer_role is not a reviewer role`);
    if (![1, 2, 3].includes(specialist?.wave)) fail(`${where}: wave must be 1, 2 or 3`);
    // The auditor only audits, and no proposer uses the audit tier. The family behind each tier is
    // gateway configuration; per run, the auditor uses a family other than the one that proposed
    // the work under review.
    const tiers = id === "independent_auditor" ? ["audit"] : ["routine", "hard"];
    if (!sameList(specialist?.tiers, tiers)) fail(`${where}: tiers must be ${tiers.join(", ")}`);
    if (!Array.isArray(specialist?.watches) || specialist.watches.length === 0 ||
      !sameSet(specialist.watches, watchesByOwner.get(id) ?? [])) {
      fail(`${where}: watches must list exactly the top-level watches it owns`);
    }
  }

  const receipt = contract?.receipt ?? {};
  if (!sameList(receipt.fields, AI_TEAM_RECEIPT_FIELDS)) {
    fail(`${AI_TEAM_LABEL}: receipt.fields must be exactly ${AI_TEAM_RECEIPT_FIELDS.join(", ")}`);
  }
  if (!sameList(receipt.nested?.sources, AI_TEAM_SOURCE_FIELDS)) {
    fail(`${AI_TEAM_LABEL}: receipt.nested.sources must be exactly ${AI_TEAM_SOURCE_FIELDS.join(", ")}`);
  }
  for (const key of Object.keys(receipt.nested ?? {})) {
    if (!AI_TEAM_RECEIPT_FIELDS.includes(key)) fail(`${AI_TEAM_LABEL}: receipt.nested.${key} is not a receipt field`);
  }
  if (!sameList(receipt.outcomes, AI_TEAM_OUTCOMES)) {
    fail(`${AI_TEAM_LABEL}: receipt.outcomes must be exactly ${AI_TEAM_OUTCOMES.join(", ")}`);
  }
  // A practice run's receipt carries permit.kind shadow (contract "Delegation", practice runs).
  if (!Array.isArray(receipt.permit_kinds) || !receipt.permit_kinds.includes("shadow")) {
    fail(`${AI_TEAM_LABEL}: receipt.permit_kinds must include shadow, the mark of a practice run`);
  }

  const reviewerOf = new Map(specialists.map((specialist) => [specialist?.specialist_id, specialist?.reviewer_role]));
  const rows = parseAiTeamCatalog(content);
  for (const [id, action] of actionById) {
    const row = rows.get(id);
    if (!row) {
      fail(`${AI_TEAM_LABEL}: ${id} has no prose catalog row`);
      continue;
    }
    if (row.autonomy !== action.autonomy) {
      fail(`${AI_TEAM_LABEL}: ${id}: prose catalog says ${row.autonomy}, contract says ${action.autonomy}`);
    }
    const starts = AI_TEAM_START_WORDS[action.default_delegation] ?? "—";
    if (row.starts !== starts) {
      fail(`${AI_TEAM_LABEL}: ${id}: prose catalog starts "${row.starts}", contract starts "${starts}"`);
    }
    const owners = Array.isArray(action.owners) ? action.owners : [];
    const listed = AI_TEAM_PROSE_OWNERS.exec(row.does)?.[1].match(/[a-z][a-z0-9_]*/g) ?? null;
    const proseOwners =
      row.group === "*" ? AI_TEAM_SPECIALISTS : row.group === "" ? [] : row.group ? listed ?? [row.group] : null;
    const ownersMatch =
      proseOwners !== null &&
      (row.group === "*" ? sameSet(owners, proseOwners) : sameList(owners, proseOwners)) &&
      (!listed || listed[0] === row.group);
    if (!ownersMatch) {
      fail(`${AI_TEAM_LABEL}: ${id}: prose catalog owners ${JSON.stringify(proseOwners)} differ from contract owners ${JSON.stringify(owners)}`);
    }
    if (row.does.startsWith("Protective.") !== (action.protective === true)) {
      fail(`${AI_TEAM_LABEL}: ${id}: prose catalog protective marker differs from the contract`);
    }
    const alwaysAsksFirst = ["A2", "A3"].includes(action.autonomy) && !action.protective && action.delegable === false;
    if (row.does.startsWith("Always asks first.") !== alwaysAsksFirst) {
      fail(`${AI_TEAM_LABEL}: ${id}: prose catalog always-asks-first marker differs from the contract`);
    }
    if (AI_TEAM_CUSTOMER_DISCLOSURE_REQUIRED.includes(id) && !row.checks.includes("disclosure")) {
      fail(`${AI_TEAM_LABEL}: ${id}: customer-facing action must keep the disclosure check`);
    }
    const reviewer = aiTeamReviewerWords(action, reviewerOf);
    if (!(row.reviewer === reviewer || (reviewer.length > 1 && row.reviewer.startsWith(reviewer)))) {
      fail(`${AI_TEAM_LABEL}: ${id}: prose catalog reviewer "${row.reviewer}" does not match contract reviewer "${reviewer}"`);
    }
  }
  for (const id of rows.keys()) {
    if (!actionById.has(id)) fail(`${AI_TEAM_LABEL}: prose catalog row ${id} is not in the contract`);
  }

  for (const pair of AI_TEAM_REASON_CODE_PAIRS) {
    const [first, second] = pair.map((id) => actionById.get(id));
    if (!first || !second) {
      fail(`${AI_TEAM_LABEL}: ${pair.join(" and ")} must both be in the catalog; they share a reason-code vocabulary`);
    } else if (!Array.isArray(first.reason_codes)) {
      fail(`${AI_TEAM_LABEL}: ${pair[0]}: reason_codes is required; its reasons come from a closed vocabulary`);
    } else if (!sameList(second.reason_codes, first.reason_codes)) {
      fail(`${AI_TEAM_LABEL}: ${pair[1]}: reason_codes must equal ${pair[0]}'s`);
    }
  }
  const reasonTable = parseAiTeamReasonTable(content);
  for (const [id, action] of actionById) {
    const listed = reasonTable.get(id);
    if ((listed || Object.hasOwn(action, "reason_codes")) && !(listed && sameList(listed, action.reason_codes ?? []))) {
      fail(`${AI_TEAM_LABEL}: ${id}: the reason-code table differs from the contract's reason_codes`);
    }
  }
  for (const id of reasonTable.keys()) {
    if (!actionById.has(id)) fail(`${AI_TEAM_LABEL}: the reason-code table names ${id}, which is not in the contract`);
  }
}

// The reason-code table under "Argument conventions": | `action`, `action` | when | `code`, `code` |.
function parseAiTeamReasonTable(content) {
  const rows = new Map();
  const lines = content.split("\n");
  const start = lines.indexOf(AI_TEAM_REASON_TABLE_HEADER);
  if (start === -1) return rows;
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    const codes = [...(cells[2] ?? "").matchAll(/`([a-z][a-z0-9_]*)`/g)].map((match) => match[1]);
    for (const [, id] of (cells[0] ?? "").matchAll(/`([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)`/g)) {
      if (rows.has(id)) fail(`${AI_TEAM_LABEL}: the reason-code table lists ${id} twice`);
      rows.set(id, codes);
    }
  }
  return rows;
}

// Each catalog row: | action | class | starts | does | evidence | checks | reviewer | effect | binds |.
// The group heading above a row names its first owner, every specialist, or no specialist.
function parseAiTeamCatalog(content) {
  const rows = new Map();
  let group;
  for (const line of content.split("\n")) {
    if (line.startsWith("#")) {
      const heading = AI_TEAM_CATALOG_GROUP.exec(line);
      group = heading ? heading[1] ?? (heading[2] ? "*" : "") : undefined;
      continue;
    }
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    const id = /^`([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)`$/.exec(cells[0] ?? "")?.[1];
    if (!id || !AI_TEAM_CLASSES.has(cells[1])) continue;
    if (rows.has(id)) fail(`${AI_TEAM_LABEL}: the prose catalog lists ${id} twice`);
    const checks = [...(cells[5] ?? "").matchAll(/`([a-z][a-z0-9_]*)`/g)].map((match) => match[1]);
    rows.set(id, { group, autonomy: cells[1], starts: cells[2], does: cells[3] ?? "", checks, reviewer: cells[6] ?? "" });
  }
  return rows;
}

function aiTeamReviewerWords(action, reviewerOf) {
  if (action.autonomy === "H") return "People only: ";
  if (action.autonomy === "A0" || action.autonomy === "A1") return "—";
  if (action.protective) return "Never asks first";
  if (action.default_delegation === "off_until_enabled") return "The owner turns it on";
  const owners = Array.isArray(action.owners) ? action.owners : [];
  const role = action.reviewer_role ?? (owners.length === 1 ? reviewerOf.get(owners[0]) : null);
  if (!role) return "The proposing specialist's reviewer";
  return role.charAt(0).toUpperCase() + role.slice(1);
}

const aiTeamContractPath = resolve(
  options.get("--ai-team-contract") ?? resolve(root, AI_TEAM_LABEL),
);
const aiTeamContract = loadEmbeddedJsonContract(
  aiTeamContractPath,
  AI_TEAM_LABEL,
  "<!-- ai-team-contract:start -->",
  "<!-- ai-team-contract:end -->",
);
if (aiTeamContract) {
  validateAiTeamContract(aiTeamContract.value, readFileSync(aiTeamContractPath, "utf8"));
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
// Review is event-triggered: the register names its review events and the trigger of the last
// completed review. A calendar due date would fail CI on its own, so one is refused outright.
const requiredReviewEvents = ["provider-terms-change", "provider-added", "production-release"];
const reviewEvents = compliance
  .match(/^Review events:\s+(.+)$/m)?.[1]
  .split(",")
  .map((event) => event.trim())
  .filter(Boolean);
const lastReviewTrigger = compliance.match(/^Last review:\s+([a-z-]+)/m)?.[1];
if (/^Next scheduled review:/m.test(compliance)) {
  fail("docs/COMPLIANCE-REGISTER.md: review is event-triggered; remove the Next scheduled review date");
}
if (!reviewEvents) {
  fail("docs/COMPLIANCE-REGISTER.md: missing Review events");
} else {
  for (const event of requiredReviewEvents) {
    if (!reviewEvents.includes(event)) {
      fail(`docs/COMPLIANCE-REGISTER.md: Review events must include ${event}`);
    }
  }
}
if (!lastReviewTrigger) {
  fail("docs/COMPLIANCE-REGISTER.md: missing Last review trigger");
} else if (reviewEvents && !reviewEvents.includes(lastReviewTrigger)) {
  fail(`docs/COMPLIANCE-REGISTER.md: Last review trigger ${lastReviewTrigger} is not a Review event`);
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
