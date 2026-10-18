import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Which ci.yml jobs a pull request has anything new to prove for. CI cost (IRW-R8): most of a
 * run is the Playwright and Lighthouse legs, which measure nothing but the `app/` bundle, and a
 * markdown-only change moves no test input at all.
 *
 * Two scopes, each fail-safe toward running:
 *   app   the PWA bundle and its Playwright and Lighthouse harness. Everything they read lives
 *         under `app/` (no import leaves it), plus the Node pin, the Makefile recipes that build
 *         and run them, ci.yml, which pins the runner and installs the browsers, and this file.
 *   code  every test suite: any change except markdown. docs/CAPABILITY-MATRIX.md is not
 *         exempt, because the Worker suite and the capability evidence receipt both read it.
 *
 * Only a pull request is scoped. A push to main, a merge group and a manual run prove
 * everything, so the commit Deploy promotes always carries the full gate, and a scope this
 * file got wrong can at worst turn main red before qa, never ship untested bytes.
 */
export const APP_INPUTS = Object.freeze([
  ".nvmrc",
  "Makefile",
  ".github/workflows/ci.yml",
  // A change to the scoping itself proves everything once.
  "tools/ci-scope.mjs",
]);

const ALWAYS_TESTED_DOCS = new Set(["docs/CAPABILITY-MATRIX.md"]);

export function isMarkdownOnly(file) {
  return file.endsWith(".md") && !ALWAYS_TESTED_DOCS.has(file);
}

export function ciScope({ event, changedFiles }) {
  if (event !== "pull_request") {
    return { app: true, code: true, reason: `${event} proves everything` };
  }
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
    return { app: true, code: true, reason: "no readable diff against the base, so everything runs" };
  }
  const tested = changedFiles.filter((file) => !isMarkdownOnly(file));
  const app = tested.some((file) => file.startsWith("app/") || APP_INPUTS.includes(file));
  return {
    app,
    code: tested.length > 0,
    reason:
      `${changedFiles.length} changed file(s), ${tested.length} outside markdown; ` +
      (app ? "the PWA bundle or its harness changed" : "nothing the PWA bundle or its harness reads changed"),
  };
}

/**
 * `actions/checkout` gives a pull request the merge commit, whose first parent is the base
 * branch tip, so `HEAD^..HEAD` is exactly what the pull request changes on top of its base.
 */
export function changedFilesAgainstFirstParent({ git = gitOutput } = {}) {
  try {
    // -z: without it git quotes and escapes unusual path names, and a quoted
    // "app/..." would no longer start with app/.
    return git(["diff", "--name-only", "--no-renames", "-z", "HEAD^", "HEAD"])
      .split("\0")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function gitOutput(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const event = process.env.GITHUB_EVENT_NAME ?? "";
  const changedFiles = event === "pull_request" ? changedFilesAgainstFirstParent() : [];
  const scope = ciScope({ event, changedFiles });
  process.stdout.write(`app=${scope.app} code=${scope.code}: ${scope.reason}\n`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `app=${scope.app}\ncode=${scope.code}\n`);
  }
}
