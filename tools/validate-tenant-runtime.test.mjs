import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stripJsonComments } from "./generate-tenant-worker-config.mjs";
import { flattenWranglerVars } from "./wrangler-vars.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tool = path.join(root, "tools", "validate-tenant-runtime.mjs");
const wrangler = JSON.parse(stripJsonComments(readFileSync(path.join(root, "workers-bus/wrangler.jsonc"), "utf8")));
const productionEnv = {
  ...flattenWranglerVars(wrangler.vars),
  IRONWRAP_TENANT_CONFIG: "ironwrap",
};
const validEnv = {
  IRONWRAP_TENANT_CONFIG: "ironwrap",
  APP_TENANT_ID: "ironwrap",
  APP_TENANT_NAME: "IronWrap OS",
  APP_TENANT_BRAND: "IronWrap",
  APP_LOCALE: "en-CA",
  APP_TIME_ZONE: "America/Edmonton",
  APP_CURRENCY: "CAD",
  FROM_EMAIL: "sales@ironwrapexteriors.com",
  APP_BFF_ENABLED: "false",
  APP_CUSTOMER_PORTAL_ENABLED: "false",
  APP_PUBLIC_ORIGIN: "",
  APP_ALLOWED_ORIGINS: "",
};

function run(overrides = {}, sourceEnv = validEnv) {
  // Read only the supplied values: a developer's shell must not fill gaps in the source config.
  const env = { ...sourceEnv, ...overrides };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name];
  }
  return spawnSync(process.execPath, [tool], { cwd: root, encoding: "utf8", env });
}

function output(result) {
  return `${result.stdout}${result.stderr}`;
}

test("accepts the actual flattened production configuration", () => {
  const result = run({}, productionEnv);
  assert.equal(result.status, 0, output(result));
  assert.equal(result.stdout, "ok tenant runtime preflight\n");
});

test("production preflight rejects sender and origin drift without example-env fallbacks", () => {
  for (const [overrides, expected] of [
    [{ FROM_EMAIL: "undeclared-sender@example.invalid" }, /FROM_EMAIL/],
    [{ FROM_EMAIL: undefined }, /FROM_EMAIL/],
    [{ APP_ALLOWED_ORIGINS: "https://other.example.invalid" }, /APP_ALLOWED_ORIGINS/],
    [{ APP_TENANT_NAME: undefined }, /APP_TENANT_NAME/],
  ]) {
    const result = run(overrides, productionEnv);
    assert.notEqual(result.status, 0);
    assert.match(output(result), expected);
    assert.doesNotMatch(output(result), /undeclared-sender@example\.invalid/);
  }
});

test("accepts the selected tenant's exact runtime identity", () => {
  for (const overrides of [
    {},
    {
      APP_BFF_ENABLED: "true",
      APP_PUBLIC_ORIGIN: "https://app.example.test",
      APP_ALLOWED_ORIGINS: "https://app.example.test",
    },
  ]) {
    const result = run(overrides);
    assert.equal(result.status, 0, output(result));
    assert.equal(result.stdout, "ok tenant runtime preflight\n");
  }
});

test("fails closed for a cross-tenant app identity", () => {
  const result = run({ APP_TENANT_ID: "demo-exteriors" });
  assert.notEqual(result.status, 0);
  assert.match(output(result), /APP_TENANT_ID/);
});

test("rejects an undeclared sender without echoing its value", () => {
  const sentinel = "sender-sentinel-should-not-echo@example.test";
  const result = run({ FROM_EMAIL: sentinel });
  assert.notEqual(result.status, 0);
  assert.match(output(result), /FROM_EMAIL/);
  assert.doesNotMatch(output(result), new RegExp(sentinel));
});

test("requires a configured BFF origin and exact allowlist entry", () => {
  for (const overrides of [
    { APP_BFF_ENABLED: "true", APP_PUBLIC_ORIGIN: undefined },
    {
      APP_BFF_ENABLED: "true",
      APP_PUBLIC_ORIGIN: "https://origin-sentinel.example.test/",
      APP_ALLOWED_ORIGINS: "https://origin-sentinel.example.test/",
    },
    {
      APP_BFF_ENABLED: "true",
      APP_PUBLIC_ORIGIN: "https://origin-sentinel.example.test",
      APP_ALLOWED_ORIGINS: "https://other.example.test",
    },
  ]) {
    const result = run(overrides);
    assert.notEqual(result.status, 0);
    assert.match(output(result), /APP_PUBLIC_ORIGIN|APP_ALLOWED_ORIGINS/);
    assert.doesNotMatch(output(result), /origin-sentinel\.example\.test/);
  }
});

test("does not allow the customer portal without the BFF", () => {
  const result = run({ APP_CUSTOMER_PORTAL_ENABLED: "true" });
  assert.notEqual(result.status, 0);
  assert.match(output(result), /APP_CUSTOMER_PORTAL_ENABLED requires APP_BFF_ENABLED/);
});
