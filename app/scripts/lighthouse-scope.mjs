import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The paired-device budget is a product rule, but the reading it is asserted against is a
 * timing measurement taken on a shared runner, and `total-blocking-time` is the one audit
 * in the profile that turns a small difference between runners into a large difference in
 * the number.
 *
 * Measured over 58 consecutive `paired-device-lighthouse` jobs (2026-08-20, ELEC-106):
 * across jobs whose `app/` tree was byte-identical, `first-contentful-paint` varied by 0.7%
 * and `largest-contentful-paint` by 1.2%, while the total-blocking-time median varied by a
 * factor of 6.4 (33.6 ms to 214.2 ms). TBT sums `duration - 50 ms` over each task longer
 * than 50 ms, so a runner a couple of percent slower does not move the number a couple of
 * percent: it pushes whole tasks across the 50 ms line and lengthens every task already
 * over it. `/today`'s tasks sit either side of that line, which is what makes the reading
 * swing while every other audit in the same run holds still.
 *
 * Every one of the nine budget failures in that window was on a commit that changed nothing
 * under `app/` — the bundle under measurement was byte-identical to the one its parent had
 * already measured green. None of the twenty commits that did change `app/` failed. So the
 * gate was spending its false-positive budget entirely on re-measuring bytes it had already
 * measured, and re-measuring identical bytes cannot produce information: it can only roll
 * the dice again.
 *
 * This decides whether there is anything new to measure. The built artifact and the harness
 * that measures it are both functions of the `app/` tree — sources, `public/`, the Vite and
 * TypeScript configuration, `package-lock.json`, `lighthouserc.cjs` and `scripts/` all live
 * there — and of this workflow file, which pins the Node and Chromium the reading is taken
 * with. When neither changed against the commit the head is being compared to, the previous
 * commit already carries a verdict for these exact bytes and this job has no new question to
 * ask.
 *
 * What this deliberately does NOT do is skip a commit that touches `app/`. Every change to
 * the PWA is still measured, once, on the commit that makes it.
 */
export function measurementScope({ head, base }) {
  const differences = [];
  if (head.appTree !== base.appTree) differences.push("app/");
  if (head.workflowBlob !== base.workflowBlob) differences.push(".github/workflows/ci.yml");

  if (differences.length === 0) {
    return {
      measure: false,
      changed: differences,
      reason:
        `app/ (${short(head.appTree)}) and the workflow that pins the measurement are ` +
        "unchanged against the base commit, so the bundle under measurement is byte-identical " +
        "to one already measured; re-reading it can only re-roll runner noise",
    };
  }

  return {
    measure: true,
    changed: differences,
    reason: `${differences.join(" and ")} changed against the base commit, so the paired-device budget has something new to measure`,
  };
}

function short(tree) {
  return typeof tree === "string" ? tree.slice(0, 12) : String(tree);
}

/**
 * `actions/checkout` gives a pull request the merge commit, whose first parent is the base
 * branch tip, and gives a push the pushed commit, whose first parent is the previous commit
 * on the branch. So `HEAD^` is the right comparison point in both cases and needs no event
 * payload. A commit with no parent (the first on a fresh history) has nothing to compare
 * against and is measured.
 */
export function readTreeState(ref, { git = gitShow } = {}) {
  return {
    appTree: git(["rev-parse", `${ref}:app`]),
    workflowBlob: git(["rev-parse", `${ref}:.github/workflows/ci.yml`]),
  };
}

function gitShow(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function hasParent() {
  try {
    gitShow(["rev-parse", "--verify", "HEAD^"]);
    return true;
  } catch {
    return false;
  }
}

export function decide() {
  if (!hasParent()) {
    return {
      measure: true,
      changed: ["HEAD has no parent"],
      reason: "the head commit has no parent to compare against, so the bundle is measured",
    };
  }
  return measurementScope({ head: readTreeState("HEAD"), base: readTreeState("HEAD^") });
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const decision = decide();
  process.stdout.write(`${decision.measure ? "measuring" : "skipping"}: ${decision.reason}\n`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `measure=${decision.measure}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `reason=${decision.reason}\n`);
  }
}
