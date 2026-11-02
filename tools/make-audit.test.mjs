import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const mcpPackages = ["mcp/erpnext-roofing-mcp", "mcp/ironwrap-bus-mcp", "mcp/newo-mcp"];
const expectedCalls = [
  "audit --prefix app",
  "audit --prefix workers-bus",
  ...[...mcpPackages, "agent-host"].map((prefix) => `audit --omit=dev --prefix ${prefix}`),
];

async function runAudit(t, failCommand = "") {
  const bin = await mkdtemp(path.join(os.tmpdir(), "ironwrap-audit-"));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const log = path.join(bin, "calls.log");
  await writeFile(path.join(bin, "npm"), `#!/bin/sh
printf '%s\\n' "$*" >> "$AUDIT_TEST_LOG"
if [ "$*" = "$AUDIT_TEST_FAIL_COMMAND" ]; then exit 42; fi
exit 0
`, { mode: 0o755 });
  // GNU Make 3.81 ignores .SHELLFLAGS; also exercise this without errexit on newer Make.
  const result = spawnSync("make", ["-f", "Makefile", "-o", "deps", ".SHELLFLAGS=-c", "audit"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, AUDIT_TEST_LOG: log, AUDIT_TEST_FAIL_COMMAND: failCommand },
  });
  assert.ifError(result.error);
  return { ...result, calls: (await readFile(log, "utf8")).trim().split("\n") };
}

for (const command of expectedCalls) {
  test(`audit fails and stops after ${command} fails`, async (t) => {
    const result = await runAudit(t, command);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    const failureIndex = expectedCalls.indexOf(command);
    assert.deepEqual(result.calls, expectedCalls.slice(0, failureIndex + 1));
  });
}

test("audit succeeds only after every package audit succeeds", async (t) => {
  const result = await runAudit(t);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.calls, expectedCalls);
});
