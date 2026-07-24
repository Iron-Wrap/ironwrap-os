import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const script = new URL("./validate-newo-config.mjs", import.meta.url);

test("staging Newo contract is internally consistent", () => {
  const result = spawnSync(process.execPath, [script.pathname], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ok Newo staging config validated: 5 tools, 31 API operations/);
  assert.match(result.stdout, /production blockers/);
});

test("production gate refuses pending provider and owner evidence", () => {
  const result = spawnSync(process.execPath, [script.pathname, "--production"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Newo production gate blocked/);
  assert.match(result.stderr, /release_state/);
  assert.match(result.stderr, /console_proof/);
});
