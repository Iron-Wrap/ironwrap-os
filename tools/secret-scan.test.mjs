// The fail-closed contract of `tools/secret-scan.mjs`: a scan that could not run
// is never a pass. That sentence was in the script's header from the day it
// shipped and the `--ref` interface still violated it - `git archive <bad-ref> |
// tar -x` under `sh -c` reports tar's status alone, tar exits 0 on the empty
// input it is handed, and the scan printed `ok` over an empty tree (ELEC-138).
// The interface is documented and was used in ELEC-54's own evidence, so it is
// tested here rather than left to the CI job, which only ever scans `HEAD`.
//
// Most cases drive the script with a stub scanner, so they assert what the script
// controls - which tree it exports and how it maps a scanner's exit status - on a
// machine with no gitleaks. The real scanner cases need the pinned binary and
// skip without it; CI runs this file inside the `secret-scan` job, where it is
// installed, so they do run on every push.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "tools", "secret-scan.mjs");

const workspace = mkdtempSync(join(tmpdir(), "ironwrap-secret-scan-test-"));
process.on("exit", () => rmSync(workspace, { recursive: true, force: true }));

// Stands in for gitleaks. Records the tree it was pointed at so a test can prove
// the export actually happened, and exits with whatever code the case is about.
function stubScanner({ exitCode }) {
  const receipt = join(workspace, `receipt-${exitCode}.json`);
  const bin = join(workspace, `stub-gitleaks-${exitCode}`);
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      'import { readdirSync, writeFileSync } from "node:fs";',
      "const dir = process.argv[3];",
      `writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ dir, entries: readdirSync(dir) }));`,
      `process.exit(${exitCode});`,
    ].join("\n"),
    { mode: 0o755 },
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    // Absent receipt means the scanner was never reached, which is the important
    // half of the bad-ref case: it did not "scan" an empty directory either.
    receipt: () => {
      try {
        return JSON.parse(readFileSync(receipt, "utf8"));
      } catch {
        return null;
      }
    },
  };
}

function runScan({ ref, bin }) {
  const result = spawnSync(process.execPath, [script, "--ref", ref], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GITLEAKS_BIN: bin },
  });
  assert.equal(result.error, undefined, String(result.error));
  return result;
}

test("a ref that does not resolve fails the scan instead of passing an empty tree", () => {
  const stub = stubScanner({ exitCode: 0 });
  const result = runScan({ ref: "no-such-ref-ba5eba11", bin: stub.bin });

  assert.equal(result.status, 1, `expected a failed scan, got ${result.status}: ${result.stdout}`);
  assert.doesNotMatch(result.stdout, /^ok /m);
  assert.match(result.stderr, /git archive exited 128 exporting no-such-ref-ba5eba11/);
  // The regression in one assertion: gitleaks used to be handed the empty
  // scratch directory and report it clean.
  assert.equal(stub.receipt(), null);
});

test("a resolvable ref is exported in full and passes when the scanner reports clean", () => {
  const stub = stubScanner({ exitCode: 0 });
  const result = runScan({ ref: "HEAD", bin: stub.bin });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ok no secrets detected in the tracked tree at HEAD$/m);
  const receipt = stub.receipt();
  assert.ok(receipt, "the scanner was never invoked");
  // Not merely non-empty: the tracked tree, at the top level the repository has.
  assert.ok(receipt.entries.includes("tools"), receipt.entries.join(","));
  assert.ok(receipt.entries.includes("workers-bus"), receipt.entries.join(","));
});

test("findings fail the scan and say so", () => {
  const stub = stubScanner({ exitCode: 2 });
  const result = runScan({ ref: "HEAD", bin: stub.bin });

  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /^ok /m);
  assert.match(result.stderr, /findings in the tracked tree at HEAD/);
});

test("a scanner that fails for its own reasons is not reported as findings, and never as clean", () => {
  const stub = stubScanner({ exitCode: 3 });
  const result = runScan({ ref: "HEAD", bin: stub.bin });

  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /^ok /m);
  assert.match(result.stderr, /exited 3 scanning HEAD; the scan did not complete/);
  assert.doesNotMatch(result.stderr, /findings/);
});

test("a scanner that cannot be executed fails the scan", () => {
  const result = runScan({ ref: "HEAD", bin: join(workspace, "gitleaks-that-is-not-installed") });

  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /^ok /m);
  assert.match(result.stderr, /could not run .*gitleaks-that-is-not-installed/);
  assert.match(result.stderr, /set GITLEAKS_BIN or install gitleaks/);
});

// The scratch-tree pattern from ELEC-54's bite proof: write blobs and a tree
// into the object store and scan that tree by sha. Nothing is committed, no
// branch moves, and the worktree stays clean - which the capability receipt
// reads as a proof state.
function scratchTree(files) {
  const entries = files.map(({ name, content }) => {
    const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: root,
      encoding: "utf8",
      input: content,
    });
    assert.equal(blob.status, 0, blob.stderr);
    return `100644 blob ${blob.stdout.trim()}\t${name}`;
  });
  const tree = spawnSync("git", ["mktree"], {
    cwd: root,
    encoding: "utf8",
    input: `${entries.join("\n")}\n`,
  });
  assert.equal(tree.status, 0, tree.stderr);
  return tree.stdout.trim();
}

function realGitleaks() {
  const bin = process.env.GITLEAKS_BIN || "gitleaks";
  const probe = spawnSync(bin, ["version"], { encoding: "utf8" });
  return probe.error || probe.status !== 0 ? null : bin;
}

const gitleaks = realGitleaks();
const needsGitleaks = gitleaks ? false : "gitleaks is not installed (set GITLEAKS_BIN)";

test("the real scanner bites on a provider token in the scanned ref", { skip: needsGitleaks }, () => {
  // Split so the literal never exists in this file's bytes: `github-pat` stays
  // armed everywhere by contract, and this file is itself in the tracked tree
  // the `secret-scan` job scans. Joining it back up turns CI red.
  const synthetic = `ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`;
  const ref = scratchTree([{ name: "leaked-token.env", content: `GITHUB_TOKEN=${synthetic}\n` }]);
  const result = runScan({ ref, bin: gitleaks });

  assert.equal(result.status, 1, result.stdout);
  assert.doesNotMatch(result.stdout, /^ok /m);
  assert.match(result.stderr, new RegExp(`findings in the tracked tree at ${ref}`));
});

test("the real scanner passes a clean ref", { skip: needsGitleaks }, () => {
  const ref = scratchTree([{ name: "notes.md", content: "No credentials in this tree.\n" }]);
  const result = runScan({ ref, bin: gitleaks });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^ok no secrets detected in the tracked tree at ${ref}$`, "m"));
});

test(
  "auth resource identifiers are scoped exactly; new values, other fields/files and vendor tokens still bite",
  { skip: needsGitleaks },
  () => {
    const source = readFileSync(
      join(root, "workers-bus", "wrangler.jsonc"),
      "utf8",
    );
    const config = JSON.parse(source.replace(/^\s*\/\/.*$/gm, ""));
    const known = [
      ["AUTH_CONTROL_ACCOUNT_ID", config.account_id],
      ["AUTH_CONTROL_ACCOUNT_ID", config.env.qa.account_id],
      ["AUTH_DATABASE_IDENTITY", config.d1_databases[0].database_id],
      ["AUTH_DATABASE_IDENTITY", config.env.qa.d1_databases[0].database_id],
    ];
    const configTree = (content) => {
      const child = scratchTree([{ name: "wrangler.jsonc", content }]);
      const result = spawnSync("git", ["mktree"], {
        cwd: root,
        encoding: "utf8",
        input: `040000 tree ${child}\tworkers-bus\n`,
      });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    const body = (field, value) =>
      `${JSON.stringify({ [field]: value }, null, 2)}\n`;
    for (const [field, value] of known) {
      const result = runScan({
        ref: configTree(body(field, value)),
        bin: gitleaks,
      });
      assert.equal(
        result.status,
        0,
        "reviewed public resource identity must not be a credential finding",
      );
    }
    // Generated deterministic fixtures are not credentials and are never sent to a provider.
    const generic = createHash("sha256")
      .update("scanner-only deterministic fixture, never a credential")
      .digest("base64url");
    const provider = `ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`;
    const rejected = [
      {
        name: "new account value",
        ref: configTree(body("AUTH_CONTROL_ACCOUNT_ID", generic)),
      },
      {
        name: "new database value",
        ref: configTree(body("AUTH_DATABASE_IDENTITY", generic)),
      },
      {
        name: "other field",
        ref: configTree(
          body("AUTH_CONTROL_READ_SECRET_ACCESS_KEY", known[0][1]),
        ),
      },
      {
        name: "other file",
        ref: scratchTree([
          {
            name: "other-config.json",
            content: body(known[0][0], known[0][1]),
          },
        ]),
      },
      {
        name: "provider token",
        ref: configTree(body("AUTH_CONTROL_ACCOUNT_ID", provider)),
      },
    ];
    for (const { name, ref } of rejected) {
      const result = runScan({ ref, bin: gitleaks });
      assert.equal(
        result.status,
        1,
        `a value outside the exact resource identity exception must be refused: ${name}`,
      );
      assert.match(result.stderr, /findings in the tracked tree/);
    }
  },
);
