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
// on any failure to run the scan; a scan that could not run is never a pass.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const gitleaks = process.env.GITLEAKS_BIN || "gitleaks";

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
try {
  // Stream the archive straight into tar rather than buffering the whole tree.
  const exported = spawnSync(
    "sh",
    ["-c", `git archive --format=tar ${JSON.stringify(ref)} | tar -x -C ${JSON.stringify(scratch)}`],
    { cwd: root, stdio: "inherit" },
  );
  if (exported.status !== 0) {
    console.error(`secret scan: could not export ${ref}`);
    process.exit(1);
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
      "1",
    ],
    { stdio: "inherit" },
  );
  if (scan.error) {
    console.error(
      `secret scan: could not run ${gitleaks} (${scan.error.message}); set GITLEAKS_BIN or install gitleaks`,
    );
    process.exit(1);
  }
  if (scan.status !== 0) {
    console.error(`secret scan: findings in the tracked tree at ${ref}`);
    process.exit(1);
  }
  console.log(`ok no secrets detected in the tracked tree at ${ref}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
