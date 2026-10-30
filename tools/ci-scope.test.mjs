import assert from "node:assert/strict";
import test from "node:test";

import { APP_INPUTS, changedFilesAgainstFirstParent, ciScope, isMarkdownOnly } from "./ci-scope.mjs";

test("anything but a pull request proves everything", () => {
  for (const event of ["push", "merge_group", "workflow_dispatch", ""]) {
    const scope = ciScope({ event, changedFiles: ["docs/README.md"] });
    assert.equal(scope.app, true, event);
    assert.equal(scope.code, true, event);
  }
});

test("a pull request with no readable diff proves everything", () => {
  for (const changedFiles of [[], undefined]) {
    const scope = ciScope({ event: "pull_request", changedFiles });
    assert.equal(scope.app, true);
    assert.equal(scope.code, true);
  }
});

test("prose-only pull requests skip the scoped product suites", () => {
  const scope = ciScope({
    event: "pull_request",
    changedFiles: ["docs/OPERATIONS-RUNBOOK.md", "app/README.md", "AGENTS.md"],
  });
  assert.equal(scope.app, false);
  assert.equal(scope.code, false);
});

test("markdown read by product tests runs those suites without rebuilding browser legs", () => {
  for (const file of [
    "docs/CAPABILITY-MATRIX.md",
    "docs/AI-TEAM-CONTRACT.md",
    "design/system-v2/TEMPLATES.md",
  ]) {
    assert.equal(isMarkdownOnly(file), false, file);
    const scope = ciScope({ event: "pull_request", changedFiles: [file] });
    assert.equal(scope.code, true, file);
    assert.equal(scope.app, false, file);
  }
});

test("a Worker-only pull request runs the suites but not the PWA bundle legs", () => {
  const scope = ciScope({
    event: "pull_request",
    changedFiles: ["workers-bus/src/index.ts", "workers-bus/migrations/0145_example.sql", "docs/manifest.json"],
  });
  assert.equal(scope.code, true);
  assert.equal(scope.app, false);
});

test("any non-markdown change under app/ runs the PWA bundle legs", () => {
  const scope = ciScope({ event: "pull_request", changedFiles: ["app/src/main.tsx"] });
  assert.equal(scope.app, true);
  assert.equal(scope.code, true);
});

test("the Node pin, the Makefile, ci.yml and the scoping itself run everything", () => {
  assert.deepEqual([...APP_INPUTS].sort(), [".github/workflows/ci.yml", ".nvmrc", "Makefile", "tools/ci-scope.mjs"]);
  for (const file of APP_INPUTS) {
    const scope = ciScope({ event: "pull_request", changedFiles: [file] });
    assert.equal(scope.app, true, file);
    assert.equal(scope.code, true, file);
  }
});

test("the changed-file read compares the merge commit with its first parent and fails open", () => {
  const calls = [];
  const files = changedFilesAgainstFirstParent({
    git: (args) => {
      calls.push(args);
      return "app/src/r\u00e9sum\u00e9.ts\0workers-bus/src/b.ts\0";
    },
  });
  assert.deepEqual(calls, [["diff", "--name-only", "--no-renames", "-z", "HEAD^", "HEAD"]]);
  assert.deepEqual(files, ["app/src/r\u00e9sum\u00e9.ts", "workers-bus/src/b.ts"]);
  assert.equal(ciScope({ event: "pull_request", changedFiles: files }).app, true);

  const unreadable = changedFilesAgainstFirstParent({
    git: () => {
      throw new Error("HEAD^ missing");
    },
  });
  assert.deepEqual(unreadable, []);
  assert.equal(ciScope({ event: "pull_request", changedFiles: unreadable }).app, true);
});
