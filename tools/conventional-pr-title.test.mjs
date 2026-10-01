import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CONVENTIONAL_TYPES,
  subjectFindings,
  titleFindings,
} from "./conventional-pr-title.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "tools", "conventional-pr-title.mjs");

function run(environment) {
  return spawnSync(process.execPath, [script], {
    encoding: "utf8",
    // A bare env keeps a developer's own PR_TITLE out of the assertion.
    env: { PATH: process.env.PATH, ...environment },
  });
}

test("accepts every conventional type release-please sections on", () => {
  for (const type of CONVENTIONAL_TYPES) {
    assert.deepEqual(subjectFindings(`${type}: add a thing`, "subject"), []);
  }
});

test("accepts optional scope and breaking marker", () => {
  for (const subject of [
    "feat: add the production release workflow",
    "feat(deploy): add the production release workflow",
    "fix(workers-bus)!: reject an unsigned permit",
    "feat!: drop the staging environment",
    "chore(deps): bump wrangler",
  ]) {
    assert.deepEqual(subjectFindings(subject, "subject"), [], subject);
  }
});

test("rejects an unparseable type, a trailing period, and an empty subject", () => {
  // release-please silently drops each of these, so the release PR would omit
  // the change and the version would not move.
  for (const subject of [
    "add the production release workflow",
    "feature: add the production release workflow",
    "Feat: add the production release workflow",
    "feat add the production release workflow",
    "feat:add the production release workflow",
    "feat: add the production release workflow.",
    "feat: ",
    "feat(): add a thing",
    "feat(scope) add a thing",
    "",
    "   ",
  ]) {
    assert.notDeepEqual(subjectFindings(subject, "subject"), [], subject);
  }
});

test("rejects a multi-line subject and untrimmed whitespace", () => {
  assert.notDeepEqual(subjectFindings("feat: a thing\nbody", "subject"), []);
  assert.notDeepEqual(subjectFindings(" feat: a thing", "subject"), []);
  assert.notDeepEqual(subjectFindings("feat: a thing ", "subject"), []);
});

test("validates the PR title whatever the commit count is", () => {
  assert.notDeepEqual(titleFindings({ PR_TITLE: "nope" }), []);
  assert.notDeepEqual(
    titleFindings({ PR_TITLE: "nope", PR_COMMIT_COUNT: "3" }),
    [],
  );
  assert.deepEqual(
    titleFindings({ PR_TITLE: "feat: a thing", PR_COMMIT_COUNT: "3" }),
    [],
  );
});

test("validates the commit subject too when the squash lands it", () => {
  // squash_merge_commit_title is COMMIT_OR_PR_TITLE: with exactly one commit
  // GitHub uses the COMMIT subject, so a good PR title does not save it.
  assert.notDeepEqual(
    titleFindings({
      PR_TITLE: "feat: a thing",
      PR_COMMIT_COUNT: "1",
      HEAD_COMMIT_SUBJECT: "wip",
    }),
    [],
  );
  assert.deepEqual(
    titleFindings({
      PR_TITLE: "feat: a thing",
      PR_COMMIT_COUNT: "1",
      HEAD_COMMIT_SUBJECT: "feat: a thing",
    }),
    [],
  );
});

test("ignores the commit subject when the PR title is what lands", () => {
  // More than one commit: GitHub squashes under the PR title, so an unparseable
  // intermediate commit subject is not a release problem.
  assert.deepEqual(
    titleFindings({
      PR_TITLE: "feat: a thing",
      PR_COMMIT_COUNT: "2",
      HEAD_COMMIT_SUBJECT: "wip",
    }),
    [],
  );
});

test("rejects a commit count that is not a count", () => {
  assert.notDeepEqual(
    titleFindings({ PR_TITLE: "feat: a thing", PR_COMMIT_COUNT: "many" }),
    [],
  );
});

test("exits nonzero on a bad title and zero on a good one", () => {
  const bad = run({ PR_TITLE: "nope", PR_COMMIT_COUNT: "2" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /conventional commit title check FAILED/);

  const good = run({ PR_TITLE: "feat(deploy): tag production releases", PR_COMMIT_COUNT: "2" });
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /^ok /);
});

test("reads its inputs from the environment, never a shell string", () => {
  // A PR title is attacker-controlled text. It must never reach a shell, and the
  // script must not spawn one.
  const source = readFileSync(script, "utf8");
  assert.doesNotMatch(source, /child_process|execSync|spawnSync|\bexecFile/);
  assert.match(source, /env\.PR_TITLE|environment\.PR_TITLE/);

  // A title full of shell metacharacters is just an invalid subject.
  const injected = run({
    PR_TITLE: '"; rm -rf / #$(whoami)`id`',
    PR_COMMIT_COUNT: "2",
  });
  assert.equal(injected.status, 1);
  assert.match(injected.stderr, /not a conventional commit/);
});
