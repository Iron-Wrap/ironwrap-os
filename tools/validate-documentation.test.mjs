#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const validator = resolve(root, "tools/validate-documentation.mjs");
const matrix = resolve(root, "docs/CAPABILITY-MATRIX.md");

test("documentation gate rejects a deliberately stale capability count", () => {
  const temp = mkdtempSync(join(tmpdir(), "ironwrap-capability-stale-"));
  try {
    const current = readFileSync(matrix, "utf8");
    const stale = current.replace('"total": 68', '"total": 67');
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
      /stale Frappe DocTypes total; contract 67, repository 68/,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("documentation gate separates source from the tested checkout", () => {
  const temp = mkdtempSync(join(tmpdir(), "ironwrap-capability-receipt-"));
  try {
    const appOutput = join(temp, "app.log");
    const workerOutput = join(temp, "worker.tap");
    const evidencePath = join(temp, "evidence.json");
    writeFileSync(appOutput, "Tests 363 passed\n");
    writeFileSync(workerOutput, "# tests 579\n# pass 579\n# fail 0\n");
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
    assert.deepEqual(evidence.tests, { pwa: 363, worker: 579 });
    assert.equal(evidence.proof_states.ci, "evidence_step_passed");
    assert.equal(evidence.proof_states.deploy, false);
    assert.equal(evidence.proof_states.production_proof, false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
