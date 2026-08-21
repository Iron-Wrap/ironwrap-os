#!/usr/bin/env node

// Secret scan over the tracked tree. CI runs this in `.github/workflows/ci.yml`
// (`secret-scan`); a developer runs the identical command locally, which is the
// point of the script existing at all.
//
// It scans `git archive` output, not the working directory. Pointing gitleaks at
// the checkout would also scan `workers-bus/.wrangler/`, `workers-bus/.dev.vars`,
// `deploy/local/keys/`, and `node_modules/` on any machine that has run the local
// stack - gitignored material that cannot reach a commit but does produce
// findings, which is how a scanner earns the ignore it later gets. Exporting the
// tree first makes the scanned bytes exactly the bytes a reviewer approves, and
// makes a local run and a CI run agree.
//
// Rules and their allowlists live in `.gitleaks.toml`.
//
//   node tools/secret-scan.mjs [--ref <rev>]
//
// Set GITLEAKS_BIN when the binary is not on PATH. Exit 0 clean, 1 on findings or
// on any failure to run the scan; a scan that could not run is never a pass. That
// contract is `tools/secret-scan.test.mjs`, not only this paragraph - it was only
// this paragraph, and the export pipe quietly broke it (ELEC-138).

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const gitleaks = process.env.GITLEAKS_BIN || "gitleaks";

// gitleaks exits with this code when it has findings, so any *other* non-zero
// code is the scanner itself failing rather than the tree being dirty. Both are
// a failed scan; separating them stops "the scan never ran" from being reported
// to a developer as "you committed a secret".
const FINDINGS_EXIT = 2;

const args = process.argv.slice(2);
let ref = "HEAD";
for (let index = 0; index < args.length; index += 2) {
  if (args[index] !== "--ref" || !args[index + 1]) {
    console.error(`usage: node tools/secret-scan.mjs [--ref <rev>]`);
    process.exit(1);
  }
  ref = args[index + 1];
}

const scratch = mkdtempSync(join(tmpdir(), "ironwrap-secret-scan-"));
// `process.exit` does not run `finally`, and every failure path below exits, so
// an exit hook is what actually removes the exported tree in all of them.
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

function fail(message) {
  console.error(`secret scan: ${message}`);
  process.exit(1);
}

// Resolve with how a stage ended, or with why it never started. Watching both
// stages is the entire point: the export used to run as `sh -c 'git archive |
// tar -x'`, whose status is tar's alone, and tar exits 0 on the empty input a
// failed `git archive` hands it. A ref that did not resolve therefore scanned an
// empty directory and printed `ok` (ELEC-138).
function settle(child, label) {
  return new Promise((resolve) => {
    child.once("error", (error) => resolve({ label, error }));
    child.once("close", (status, signal) => resolve({ label, status, signal }));
  });
}

// Stream the archive straight into tar rather than buffering the whole tree.
const archive = spawn("git", ["archive", "--format=tar", ref], {
  cwd: root,
  stdio: ["ignore", "pipe", "inherit"],
});
const extract = spawn("tar", ["-x", "-C", scratch], {
  stdio: ["pipe", "inherit", "inherit"],
});
// A tar that dies mid-stream breaks the pipe. Swallowing the EPIPE that raises
// here leaves the stage which actually failed to be the one reported below.
archive.stdout.on("error", () => {});
extract.stdin.on("error", () => {});
archive.stdout.pipe(extract.stdin);

const stages = await Promise.all([settle(archive, "git archive"), settle(extract, "tar -x")]);
for (const stage of stages) {
  if (stage.error) {
    fail(`could not run ${stage.label} (${stage.error.message}); ${ref} was not scanned`);
  }
  if (stage.signal) {
    fail(`${stage.label} was killed by ${stage.signal} exporting ${ref}; ${ref} was not scanned`);
  }
  if (stage.status !== 0) {
    fail(`${stage.label} exited ${stage.status} exporting ${ref}; ${ref} was not scanned`);
  }
}

const scan = spawnSync(
  gitleaks,
  [
    "dir",
    scratch,
    "--config",
    join(root, ".gitleaks.toml"),
    "--no-banner",
    "--redact",
    "--exit-code",
    String(FINDINGS_EXIT),
  ],
  { stdio: "inherit" },
);
if (scan.error) {
  fail(`could not run ${gitleaks} (${scan.error.message}); set GITLEAKS_BIN or install gitleaks`);
}
if (scan.signal) {
  fail(`${gitleaks} was killed by ${scan.signal} scanning ${ref}; the scan did not complete`);
}
if (scan.status === FINDINGS_EXIT) {
  fail(`findings in the tracked tree at ${ref}`);
}
if (scan.status !== 0) {
  fail(`${gitleaks} exited ${scan.status} scanning ${ref}; the scan did not complete`);
}
console.log(`ok no secrets detected in the tracked tree at ${ref}`);
