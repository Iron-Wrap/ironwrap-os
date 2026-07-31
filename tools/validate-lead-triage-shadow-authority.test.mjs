import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { validateLeadTriageShadowAuthorityConfig } from "./validate-lead-triage-shadow-authority.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const policy = readJson("config/authority/lead-triage-shadow-policy.v1.json");
const cases = readJson("config/authority/lead-triage-shadow-policy.cases.v1.json");

test("checked-in lead-triage shadow policy config is valid", () => {
  const script = new URL("./validate-lead-triage-shadow-authority.mjs", import.meta.url);
  const result = spawnSync(process.execPath, [script.pathname], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ok lead-triage shadow authority config validated: 12 adversarial cases/);
});

test("validator rejects policy schema drift before an evaluator can consume it", () => {
  const invalidPolicy = { ...policy, unexpected: true };
  assert.throws(
    () => validateLeadTriageShadowAuthorityConfig(invalidPolicy, cases),
    /policy fields/,
  );
});

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(root, relativePath), "utf8"));
}
