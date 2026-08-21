import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PORT_BEARING_KEYS,
  applyVars,
  brokerPorts,
  portBearingVars,
  scaffoldDevVars,
  setVar,
} from "./dev-vars.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");

function localWranglerVars() {
  const source = readFileSync(resolve(root, "workers-bus/wrangler.jsonc"), "utf8")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  return JSON.parse(source).env.local.vars;
}

function parseDevVars(text) {
  const parsed = new Map();
  for (const line of text.split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) parsed.set(match[1], match[2]);
  }
  return parsed;
}

// ELEC-112 finding 4, reproduced again in ELEC-120: wrangler.jsonc is static JSON, so any
// `local` var pinning a loopback port has to be re-declared into .dev.vars or a second stack
// silently inherits the first one's. ERPNEXT_BASE_URL was the one that got missed - for the
// Worker specifically, because the broker env files had always carried their own copy.
test("every loopback-port-bearing local wrangler var is overridden by predev", () => {
  const missing = Object.entries(localWranglerVars())
    .filter(
      ([, value]) =>
        typeof value === "string" &&
        /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}\b/.test(value),
    )
    .map(([key]) => key)
    .filter((key) => !PORT_BEARING_KEYS.includes(key));
  assert.deepEqual(
    missing,
    [],
    `these wrangler.jsonc local vars carry a host port but predev never overrides them: ${missing.join(", ")}`,
  );
});

test("the Worker's Frappe base URL follows IRONWRAP_LOCAL_FRAPPE_PORT", () => {
  const entries = new Map(
    portBearingVars({ frappePort: "8021", workerPort: "7121", brokerPortBase: "9120" }),
  );
  assert.equal(entries.get("ERPNEXT_BASE_URL"), "http://localhost:8021");
  assert.equal(entries.get("APP_PUBLIC_ORIGIN"), "http://localhost:7121");
  assert.equal(entries.get("APP_ALLOWED_ORIGINS"), "http://localhost:7121");
  assert.equal(entries.get("PUBLIC_ESTIMATE_ALLOWED_ORIGINS"), "http://localhost:7121");
  assert.equal(entries.get("APP_APPROVAL_BROKER_URL"), "http://127.0.0.1:9121");
  assert.equal(entries.get("APP_QUOTE_REVISION_BROKER_URL"), "http://127.0.0.1:9122");
  assert.equal(entries.get("APP_PRODUCTION_SCHEDULE_BROKER_URL"), "http://127.0.0.1:9123");
  assert.equal(entries.get("APP_PROPOSAL_PUBLICATION_BROKER_URL"), "http://127.0.0.1:9124");
});

test("port-bearing entries and the declared key list stay in step", () => {
  const keys = portBearingVars({
    frappePort: "8000",
    workerPort: "7100",
    brokerPortBase: "9100",
  }).map(([key]) => key);
  assert.deepEqual([...keys].sort(), [...PORT_BEARING_KEYS].sort());
});

test("two stacks share no port and no default is changed", () => {
  const first = new Map(
    portBearingVars({ frappePort: "8000", workerPort: "7100", brokerPortBase: "9100" }),
  );
  const second = new Map(
    portBearingVars({ frappePort: "8001", workerPort: "7101", brokerPortBase: "9200" }),
  );
  // The documented single-stack defaults are exactly what wrangler.jsonc already pins.
  const pinned = localWranglerVars();
  for (const key of PORT_BEARING_KEYS) assert.equal(first.get(key), pinned[key]);
  for (const key of PORT_BEARING_KEYS) assert.notEqual(first.get(key), second.get(key));
});

test("a broker port base outside the usable range is refused, not silently coerced", () => {
  for (const base of ["not-a-port", "80", "70000", "9100.5", ""]) {
    assert.throws(() => brokerPorts(base), RangeError, `accepted ${JSON.stringify(base)}`);
  }
});

// ELEC-112 finding 6, reproduced again in ELEC-120: a fresh checkout has no .dev.vars, so
// ADMIN_TOKEN / INGEST_TOKEN / APP_AUTH_PEPPER had to be hand-added before anything worked.
test("a fresh checkout is scaffolded from .dev.vars.example", () => {
  const example = readFileSync(resolve(root, "workers-bus/.dev.vars.example"), "utf8");
  for (const existing of ["", "   \n\n", undefined, null]) {
    const seeded = scaffoldDevVars({ existing, example });
    assert.equal(seeded.scaffolded, true);
    const parsed = parseDevVars(seeded.text);
    for (const key of ["INGEST_TOKEN", "ADMIN_TOKEN", "APP_AUTH_PEPPER"]) {
      assert.ok(parsed.has(key), `${key} missing from the scaffolded .dev.vars`);
      assert.ok(parsed.get(key).replace(/"/g, "").trim(), `${key} scaffolded blank`);
    }
  }
});

test("the example still carries the keys the local stack cannot invent", () => {
  const parsed = parseDevVars(readFileSync(resolve(root, "workers-bus/.dev.vars.example"), "utf8"));
  for (const key of ["INGEST_TOKEN", "ADMIN_TOKEN", "APP_AUTH_PEPPER"]) {
    assert.ok(parsed.has(key), `${key} is no longer in .dev.vars.example`);
  }
});

test("an existing .dev.vars is never rewritten by the scaffold", () => {
  const existing = 'ADMIN_TOKEN="the-operator-chose-this"\n';
  const seeded = scaffoldDevVars({ existing, example: "ADMIN_TOKEN=\"example\"\n" });
  assert.equal(seeded.scaffolded, false);
  assert.equal(seeded.text, existing);
});

test("scaffolding refuses to invent a file when the example is gone", () => {
  assert.throws(() => scaffoldDevVars({ existing: "", example: "" }), /\.dev\.vars\.example/);
  assert.throws(() => scaffoldDevVars({ existing: "", example: undefined }), /\.dev\.vars\.example/);
});

test("generated values overwrite the example placeholders, comments intact", () => {
  const example = readFileSync(resolve(root, "workers-bus/.dev.vars.example"), "utf8");
  const seeded = scaffoldDevVars({ existing: "", example });
  const written = applyVars(seeded.text, [
    ...portBearingVars({ frappePort: "8021", workerPort: "7121", brokerPortBase: "9120" }),
    ["ERPNEXT_API_KEY", "generated-key"],
    ["EFFECT_RUNTIME_TOKEN", "generated-token"],
  ]);
  const parsed = parseDevVars(written);
  assert.equal(parsed.get("ERPNEXT_API_KEY"), "generated-key");
  assert.equal(parsed.get("EFFECT_RUNTIME_TOKEN"), "generated-token");
  assert.equal(parsed.get("ERPNEXT_BASE_URL"), "http://localhost:8021");
  assert.equal(parsed.get("ADMIN_TOKEN"), '"dev-admin-token-change-me"');
  assert.ok(written.includes("# Copy to `.dev.vars` for local `wrangler dev`"));
  // The commented-out override in the example must not shadow the real line predev appends.
  assert.equal(written.match(/^ERPNEXT_BASE_URL=/gm).length, 1);
});

test("setVar replaces in place and appends exactly once", () => {
  assert.equal(setVar("A=1\nB=2\n", "A", "9"), "A=9\nB=2\n");
  assert.equal(setVar("A=1\n", "C", "3"), "A=1\nC=3\n");
  assert.equal(applyVars("A=1\n", [["A", "2"], ["A", "3"]]), "A=3\n");
});
