// IRO-268: workers-bus/wrangler.jsonc groups non-secret vars into CFG_* JSON bindings to stay
// under the Cloudflare Workers per-environment variable limit (64 on Free, 128 on Paid; secrets
// and text/JSON vars share the one budget). This test pins the budget and the shape of the
// grouping so a var added later cannot silently push an environment back over the limit, or
// desync the flattened view flattenEnv() and the repository's tools both depend on.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { stripJsonComments } from "./generate-tenant-worker-config.mjs";
import { flattenWranglerVars } from "./wrangler-vars.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER_CONFIG_LIMIT = 25;
const CLOUDFLARE_FREE_BINDING_LIMIT = 64;
const MAX_VARIABLE_BYTES = 5120;

const wranglerSource = readFileSync(path.join(root, "workers-bus", "wrangler.jsonc"), "utf8");
const config = JSON.parse(stripJsonComments(wranglerSource).replace(/,(\s*[}\]])/g, "$1"));

const secretSource = readFileSync(path.join(root, "workers-bus", "src", "secret-bindings.d.ts"), "utf8");
// Same regex tools/release-permit.mjs uses to read the secret inventory.
const allSecretNames = [...secretSource.matchAll(/^\s{2}([A-Z][A-Z0-9_]+): string;$/gm)].map((match) => match[1]);

const varBindingsSource = readFileSync(path.join(root, "workers-bus", "src", "var-bindings.d.ts"), "utf8");
// Every `interface Env { … }` block, at any indentation: the top-level one and the
// `declare namespace Cloudflare` copy. Reading only the first (column-anchored `^interface Env`)
// left the copy free to drift silently — IRO-268 revision 2.
const envBlocks = [...varBindingsSource.matchAll(/^([ ]*)interface Env \{([\s\S]*?)^\1\}/gm)];
const blockNames = envBlocks.map(([, indent, body]) => new Set(
  [...body.matchAll(new RegExp(`^${indent}  ([A-Z][A-Z0-9_]+): string;$`, "gm"))].map((match) => match[1]),
));
const declaredFlatNames = blockNames[0] ?? new Set();

function environmentVars(environment) {
  return environment === "production" ? config.vars : config.env[environment].vars;
}

const ENVIRONMENTS = ["production", "local", "qa"];

for (const environment of ENVIRONMENTS) {
  test(`${environment}: text + JSON vars plus secrets stay within the Cloudflare Free binding limit`, () => {
    const vars = environmentVars(environment);
    const flat = flattenWranglerVars(vars);
    const secretNames = allSecretNames.filter((name) => !(name in flat));
    const total = Object.keys(vars).length + secretNames.length;
    assert.ok(
      total <= CLOUDFLARE_FREE_BINDING_LIMIT,
      `${environment}: ${Object.keys(vars).length} vars + ${secretNames.length} secrets = ${total}, over the Free limit of ${CLOUDFLARE_FREE_BINDING_LIMIT}`,
    );
  });

  test(`${environment}: top-level var/JSON binding count stays within the repository ceiling`, () => {
    const vars = environmentVars(environment);
    assert.ok(
      Object.keys(vars).length <= WRANGLER_CONFIG_LIMIT,
      `${environment}: ${Object.keys(vars).length} top-level bindings, over the repository ceiling of ${WRANGLER_CONFIG_LIMIT}`,
    );
  });

  test(`${environment}: every var/JSON binding serializes under the 5 KB Cloudflare limit`, () => {
    const vars = environmentVars(environment);
    for (const [name, value] of Object.entries(vars)) {
      const bytes = Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
      assert.ok(bytes < MAX_VARIABLE_BYTES, `${environment}.${name} is ${bytes} bytes, at or over the ${MAX_VARIABLE_BYTES} byte limit`);
    }
  });

  test(`${environment}: no flat var name appears in more than one CFG_* group`, () => {
    const vars = environmentVars(environment);
    const seen = new Map();
    for (const [groupName, groupValue] of Object.entries(vars)) {
      if (!groupName.startsWith("CFG_") || typeof groupValue !== "object" || groupValue === null) continue;
      for (const name of Object.keys(groupValue)) {
        assert.ok(!seen.has(name), `${name} appears in both ${seen.get(name)} and ${groupName}`);
        seen.set(name, groupName);
      }
    }
  });

  test(`${environment}: flattenWranglerVars and the Worker's flattenEnv agree on every flat var`, async () => {
    // flattenEnv (workers-bus/src/env-bindings.ts) returns the whole Env with flat names added
    // alongside the original CFG_*/resource bindings, so it is a superset of
    // flattenWranglerVars's pure flat map, not an equal object; compare the flat values only.
    const { flattenEnv } = await import(path.join(root, "workers-bus", "src", "env-bindings.ts"));
    const vars = environmentVars(environment);
    const viaTool = flattenWranglerVars(vars);
    const viaWorker = flattenEnv(vars);
    for (const [name, value] of Object.entries(viaTool)) {
      assert.strictEqual(viaWorker[name], value, `${environment}.${name}: flattenEnv and flattenWranglerVars disagree`);
    }
  });
}

test("every environment flattens to the same key set", () => {
  const [first, ...rest] = ENVIRONMENTS.map((environment) => Object.keys(flattenWranglerVars(environmentVars(environment))).sort());
  for (const keys of rest) assert.deepEqual(keys, first, "an environment's flattened var set has drifted from the others");
});

test("the flattened key set equals the flat names declared in var-bindings.d.ts", () => {
  const flatKeys = new Set(Object.keys(flattenWranglerVars(config.vars)));
  assert.deepEqual([...flatKeys].sort(), [...declaredFlatNames].sort());
});

test("every interface Env block in var-bindings.d.ts declares the same flat names", () => {
  assert.ok(envBlocks.length >= 1, "var-bindings.d.ts declares no interface Env block");
  for (const [index, names] of blockNames.entries()) {
    assert.deepStrictEqual([...names].sort(), [...declaredFlatNames].sort(),
      `var-bindings.d.ts interface Env block ${index} has drifted from the first`);
  }
});

test("every environment carries the same CFG_* groups with the same keys", () => {
  // The flattened-key-set test above flattens the grouping away. wrangler REPLACES an
  // environment's `vars` wholesale while effectiveEnvironmentConfig (tools/release-permit.mjs:1804)
  // MERGES top-level vars into it per key, so a group present at the top level and missing from an
  // environment is injected into that environment's expected binding manifest and never deployed:
  // version_readback_binding_manifest_drift at the release, having passed CI — IRO-268 revision 4.
  const grouping = (environment) => Object.fromEntries(
    Object.entries(environmentVars(environment))
      .filter(([name, value]) => name.startsWith("CFG_") && typeof value === "object" && value !== null)
      .map(([name, value]) => [name, Object.keys(value).sort()])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const [reference, ...rest] = ENVIRONMENTS.map(grouping);
  for (const [index, groups] of rest.entries()) {
    assert.deepStrictEqual(groups, reference,
      `${ENVIRONMENTS[index + 1]}: CFG_* grouping has drifted from ${ENVIRONMENTS[0]}`);
  }
});
