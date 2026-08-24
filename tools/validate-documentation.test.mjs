#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const validator = resolve(root, "tools/validate-documentation.mjs");
const matrix = resolve(root, "docs/CAPABILITY-MATRIX.md");
const architecture = resolve(root, "docs/AI-NATIVE-ARCHITECTURE.md");
const playbook = resolve(root, "docs/WHITE-LABEL-CLONE-PLAYBOOK.md");
const workerReadme = resolve(root, "workers-bus/README.md");
const localReadme = resolve(root, "deploy/local/README.md");
const releaseControlPublication = resolve(
  root,
  "docs/release-control-publication.json",
);
const migrations = resolve(root, "workers-bus/migrations");

// The gate is exercised against a temporary copy, never the tracked file: a test
// that edits the real runbook leaves the worktree dirty when it crashes, and the
// capability receipt reads worktree cleanliness as a proof state.
function withPlaybookCopy(prefix, rewrite, assertResult) {
  const temp = mkdtempSync(join(tmpdir(), prefix));
  try {
    const current = readFileSync(playbook, "utf8");
    const rewritten = rewrite(current);
    assert.notEqual(rewritten, current, "rewrite must change the playbook");
    const copy = join(temp, "WHITE-LABEL-CLONE-PLAYBOOK.md");
    writeFileSync(copy, rewritten);
    assertResult(
      spawnSync(process.execPath, [validator, "--clone-playbook", copy], {
        cwd: root,
        encoding: "utf8",
      }),
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function withDocumentCopy(prefix, source, name, option, rewrite, assertResult) {
  const temp = mkdtempSync(join(tmpdir(), prefix));
  try {
    const current = readFileSync(source, "utf8");
    const rewritten = rewrite(current);
    assert.notEqual(rewritten, current, `rewrite must change ${name}`);
    const copy = join(temp, name);
    writeFileSync(copy, rewritten);
    assertResult(
      spawnSync(process.execPath, [validator, option, copy], {
        cwd: root,
        encoding: "utf8",
      }),
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

test("documentation gate rejects the stale Facet compatibility flag name", () => {
  withDocumentCopy(
    "ironwrap-facet-flag-stale-",
    localReadme,
    "README.md",
    "--local-readme",
    (content) => content.replace(
      "FACET_DESIGN_FRAPPE_PROJECTION_ENABLED",
      "FACET_V2_FRAPPE_PROJECTION_ENABLED",
    ),
    (result) => {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /deploy\/local\/README\.md: contains stale compatibility flag/);
    },
  );
});

test("documentation gate rejects restoring the false no-quote-mutation contract", () => {
  withDocumentCopy(
    "ironwrap-facet-mutation-stale-",
    workerReadme,
    "README.md",
    "--worker-readme",
    (content) => content.replace(
      /For `approved` and `corrected` events, the endpoint creates a blank, non-customer-safe `Draft`\s+Customer Quote\./,
      "The endpoint does not create or update a quote.",
    ),
    (result) => {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /workers-bus\/README\.md: contains false no-quote-mutation claim/);
    },
  );
});

test("documentation gate rejects a deliberately stale capability count", () => {
  const temp = mkdtempSync(join(tmpdir(), "ironwrap-capability-stale-"));
  try {
    const current = readFileSync(matrix, "utf8");
    // Derive the contract's own DocType total instead of hard-coding it. Every
    // capability lane changes that number, and a hard-coded literal makes this
    // gate fail on the lane rather than on the staleness it is meant to catch.
    const declared = Number(/"total":\s*(\d+)/.exec(current)?.[1]);
    assert.ok(Number.isInteger(declared) && declared > 1, "contract must declare a DocType total");
    const stale = current.replace(
      `"total": ${declared}`,
      `"total": ${declared - 1}`,
    );
    assert.notEqual(stale, current);
    const stalePath = join(temp, "CAPABILITY-MATRIX.md");
    writeFileSync(stalePath, stale);

    const result = spawnSync(
      process.execPath,
      [validator, "--capability-matrix", stalePath],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      new RegExp(
        `Frappe DocTypes total: stale value; expected ${declared - 1}, actual ${declared}`,
      ),
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("documentation gate permits only the exact forward-repair migration companions", () => {
  const accepted = spawnSync(process.execPath, [validator], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(accepted.status, 0, accepted.stderr);

  const temp = mkdtempSync(join(tmpdir(), "ironwrap-migration-duplicate-"));
  try {
    const copy = join(temp, "migrations");
    cpSync(migrations, copy, { recursive: true });
    writeFileSync(
      join(copy, "0114_unapproved_duplicate.sql"),
      "-- Deliberate unapproved duplicate for the documentation gate.\n",
    );
    const rejected = spawnSync(
      process.execPath,
      [validator, "--migration-root", copy],
      { cwd: root, encoding: "utf8" },
    );
    assert.notEqual(rejected.status, 0);
    assert.match(
      rejected.stderr,
      /workers-bus\/migrations: duplicate migration number 0114/,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("documentation gate rejects a third active product lane", () => {
  const temp = mkdtempSync(join(tmpdir(), "ironwrap-topology-stale-"));
  try {
    const current = readFileSync(architecture, "utf8");
    const stale = current.replace(
      '"active_products": [\n      "ironwrap_os",\n      "facet"\n    ]',
      '"active_products": [\n      "ironwrap_os",\n      "facet",\n      "home_config_3d"\n    ]',
    );
    assert.notEqual(stale, current);
    const stalePath = join(temp, "AI-NATIVE-ARCHITECTURE.md");
    writeFileSync(stalePath, stale);

    const result = spawnSync(
      process.execPath,
      [validator, "--architecture", stalePath],
      { cwd: root, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /product_topology\.active_products.*home_config_3d/,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("documentation gate rejects deleting the release-control boundary", () => {
  const temp = mkdtempSync(join(tmpdir(), "ironwrap-release-control-stale-"));
  try {
    const current = readFileSync(matrix, "utf8");
    const stale = current.replace(
      "Iron-Wrap/release-control-plane",
      "Iron-Wrap/unspecified-release-repository",
    );
    assert.notEqual(stale, current);
    const stalePath = join(temp, "CAPABILITY-MATRIX.md");
    writeFileSync(stalePath, stale);

    const result = spawnSync(
      process.execPath,
      [validator, "--capability-matrix", stalePath],
      { cwd: root, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /missing release-control claim Iron-Wrap\/release-control-plane/,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("documentation gate rejects promoting release-control source publication into deployment proof", () => {
  const temp = mkdtempSync(join(tmpdir(), "ironwrap-release-control-proof-stale-"));
  try {
    const current = readFileSync(matrix, "utf8");
    const stale = current.replace(
      "Source publication proves only repository availability",
      "Source publication proves a deployed production service",
    );
    assert.notEqual(stale, current);
    const stalePath = join(temp, "CAPABILITY-MATRIX.md");
    writeFileSync(stalePath, stale);

    const result = spawnSync(
      process.execPath,
      [validator, "--capability-matrix", stalePath],
      { cwd: root, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /missing release-control claim release-control source publication remains non-deployment proof/,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("documentation gate derives the published release-control commit from evidence", () => {
  const temp = mkdtempSync(join(tmpdir(), "ironwrap-release-control-evidence-stale-"));
  try {
    const evidence = JSON.parse(readFileSync(releaseControlPublication, "utf8"));
    evidence.source_commit = "0".repeat(40);
    const stalePath = join(temp, "release-control-publication.json");
    writeFileSync(stalePath, `${JSON.stringify(evidence, null, 2)}\n`);

    const result = spawnSync(
      process.execPath,
      [validator, "--release-control-publication", stalePath],
      { cwd: root, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /missing release-control claim publication source commit/,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("documentation gate rejects breaking the native release-control blocker graph", () => {
  const temp = mkdtempSync(join(tmpdir(), "ironwrap-release-graph-stale-"));
  try {
    const current = readFileSync(matrix, "utf8");
    const stale = current.replace("P --> G", "P -.-> G");
    assert.notEqual(stale, current);
    const stalePath = join(temp, "CAPABILITY-MATRIX.md");
    writeFileSync(stalePath, stale);

    const result = spawnSync(
      process.execPath,
      [validator, "--capability-matrix", stalePath],
      { cwd: root, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing release-control claim IRO-222 -> IRO-41/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("documentation gate rejects making shipped Frappe release proof optional", () => {
  const temp = mkdtempSync(join(tmpdir(), "ironwrap-frappe-release-stale-"));
  try {
    const current = readFileSync(matrix, "utf8");
    const stale = current.replace(
      "signed Frappe\n  adapter promote/readback/rollback receipts are required release evidence while the Frappe wheel",
      "leftover Frappe\n  adapter receipts are optional sentinels, not a release gate while the Frappe wheel",
    );
    assert.notEqual(stale, current);
    const stalePath = join(temp, "CAPABILITY-MATRIX.md");
    writeFileSync(stalePath, stale);

    const result = spawnSync(
      process.execPath,
      [validator, "--capability-matrix", stalePath],
      { cwd: root, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /Frappe release gate must match whether deploy\.yml ships the wheel/,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("documentation gate rejects a count the clone playbook restates staler than the repository", () => {
  // Derive the live numbers rather than hard-coding them, for the same reason the
  // capability test does: a lane that adds a DocType or a migration must fail on
  // its own drift, not on this test.
  const current = readFileSync(playbook, "utf8");
  const doctypes = Number(/\b(\d+)-DocType\s+pack\b/.exec(current)?.[1]);
  const migrations = Number(/\bAll (\d+) D1 migrations\b/.exec(current)?.[1]);
  assert.ok(Number.isInteger(doctypes) && doctypes > 1, "playbook must state a DocType pack size");
  assert.ok(Number.isInteger(migrations) && migrations > 1, "playbook must state a migration count");

  withPlaybookCopy(
    "ironwrap-playbook-stale-",
    (content) =>
      content
        .replace(`${doctypes}-DocType`, `${doctypes - 1}-DocType`)
        .replace(`All ${migrations} D1 migrations`, `All ${migrations - 1} D1 migrations`),
    (result) => {
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        new RegExp(
          `stale DocType pack size; document "${doctypes - 1}", repository "${doctypes}"`,
        ),
      );
      assert.match(
        result.stderr,
        new RegExp(
          `stale migration chain length; document "${migrations - 1}", repository "${migrations}"`,
        ),
      );
    },
  );
});

test("documentation gate rejects deleting a restated count instead of correcting it", () => {
  withPlaybookCopy(
    "ironwrap-playbook-missing-",
    (content) => content.replace(/\b\d+-DocType(\s+)pack\b/, "DocType$1pack"),
    (result) => {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /missing DocType pack size claim/);
    },
  );
});

test("documentation gate separates source from the tested checkout", () => {
  const temp = mkdtempSync(join(tmpdir(), "ironwrap-capability-receipt-"));
  try {
    const appOutput = join(temp, "app.log");
    const workerOutput = join(temp, "worker.tap");
    const evidencePath = join(temp, "evidence.json");
    const contract = JSON.parse(
      /```json\n([\s\S]*?)\n```/.exec(readFileSync(matrix, "utf8"))[1],
    );
    assert.deepEqual(contract.test_observation_policy, {
      pwa: "observe_per_receipt",
      worker: "observe_per_receipt",
    });
    assert.equal(contract.expected.tests, undefined);
    const pwa = 7;
    const worker = 11;
    writeFileSync(appOutput, `Tests ${pwa} passed\n`);
    writeFileSync(
      workerOutput,
      `# tests ${worker}\n# pass ${worker}\n# fail 0\n`,
    );
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const source = "b".repeat(40);
    const base = "a".repeat(40);

    const result = spawnSync(
      process.execPath,
      [
        validator,
        "--app-test-output",
        appOutput,
        "--worker-test-output",
        workerOutput,
        "--evidence",
        evidencePath,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          CAPABILITY_BASE_COMMIT: base,
          CAPABILITY_SOURCE_COMMIT: source,
          GITHUB_ACTIONS: "true",
          GITHUB_BASE_REF: "codex/iro-32-integration",
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_HEAD_REF: "codex/iro-40-capability-matrix",
          GITHUB_JOB: "validate-and-test",
          GITHUB_REPOSITORY: "Iron-Wrap/ironwrap-os",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_RUN_ID: "123456789",
          GITHUB_SHA: head,
          GITHUB_STEP_SUMMARY: "",
          GITHUB_WORKFLOW_REF:
            "Iron-Wrap/ironwrap-os/.github/workflows/ci.yml@refs/pull/40/merge",
          GITHUB_WORKFLOW_SHA: head,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    assert.equal(evidence.schema, "ironwrap_capability_evidence_v1");
    assert.equal(evidence.identity.source_commit, source);
    assert.equal(evidence.identity.base_commit, base);
    assert.equal(evidence.identity.tested_commit, head);
    assert.notEqual(
      evidence.identity.source_commit,
      evidence.identity.tested_commit,
    );
    assert.equal(evidence.identity.ci_check.run_id, "123456789");
    assert.equal(evidence.identity.ci_check.event_name, "pull_request");
    assert.equal(evidence.identity.ci_check.workflow_sha, head);
    assert.deepEqual(evidence.tests, { pwa, worker });
    assert.equal(evidence.proof_states.ci, "evidence_step_passed");
    assert.equal(evidence.proof_states.deploy, false);
    assert.equal(evidence.proof_states.production_proof, false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
