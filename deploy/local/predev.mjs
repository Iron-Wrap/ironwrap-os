#!/usr/bin/env node
/**
 * IronWrap OS local end-to-end preflight (idempotent, fast when warm).
 *
 * `npm run dev` in workers-bus runs this before `wrangler dev --env local`. It guarantees:
 *   1. ../app/dist exists (builds the PWA once when missing)
 *   2. .dev.vars exists at all - scaffolded from .dev.vars.example on a fresh checkout,
 *      so ADMIN_TOKEN/INGEST_TOKEN/APP_AUTH_PEPPER are never a hand-added step - and then
 *      carries the throwaway local keys (customer acceptance, effect runtime, Facet chain)
 *      and every host-port-bearing local value so a second isolated stack never inherits
 *      the first one's ports
 *   3. every D1 migration is applied to the local (Miniflare) database
 *
 * Frappe is decommissioned: there is no local Frappe stack, and `wrangler dev --env local`
 * keeps the Frappe projection off. It never touches production.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyVars, portBearingVars, retiredBrokerVars, scaffoldDevVars } from "./dev-vars.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const workersBus = path.join(repoRoot, "workers-bus");
const devVarsPath = path.join(workersBus, ".dev.vars");
const keysDir = path.join(here, "keys");
// wrangler.jsonc is static JSON and cannot read the environment, so every port-bearing value
// it pins for the `local` env is re-declared into .dev.vars below, which wrangler dev loads
// over the config's `vars`. Without this a second stack's Worker could not bind its own port
// (ELEC-112 process risk 5). IRONWRAP_LOCAL_FRAPPE_PORT still moves the inert
// ERPNEXT_BASE_URL default so the port-bearing list stays one list.
const frappePort = process.env.IRONWRAP_LOCAL_FRAPPE_PORT ?? "8000";
const workerPort = process.env.IRONWRAP_LOCAL_WORKER_PORT ?? "7100";
const workerOrigin = `http://localhost:${workerPort}`;
const log = (msg) => console.log(`[predev] ${msg}`);
const fail = (msg) => {
  console.error(`[predev] ERROR: ${msg}`);
  process.exit(1);
};

// 1. PWA assets ---------------------------------------------------------------
if (!existsSync(path.join(repoRoot, "app/dist/manifest.webmanifest"))) {
  log("app/dist missing - building the PWA (one time per source change)");
  execSync("npm run build", { cwd: path.join(repoRoot, "app"), stdio: "inherit" });
}

// 1b. Compatibility receipt verifier public key (throwaway, gitignored) ---------
// Preserve a configured verifier key. A fresh local stack keeps only the public
// half of an ephemeral pair, so startup supplies no approval signing material.
const publicKeyPath = path.join(keysDir, "hermes-approval-public.pem");
if (!existsSync(publicKeyPath)) {
  log("generating a local compatibility verifier public key into deploy/local/keys/");
  mkdirSync(keysDir, { recursive: true });
  const { publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }), { flag: "wx" });
}

// Facet v2 chain key material (throwaway, gitignored). Three distinct purposes,
// never shared: the launch capability HMAC the Worker signs an "open in Facet"
// URL with, the delivery-verification key Facet signs its customer-decision
// event with, and the projection HMAC the Worker's (locally disabled) Frappe
// projection signs with.
const facetKeyFiles = {
  FACET_LAUNCH_HMAC_KEY: path.join(keysDir, "facet-launch-hmac-key.txt"),
  FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY: path.join(keysDir, "facet-design-projection-hmac-key.txt"),
  FACET_V2_DELIVERY_SECRET: path.join(keysDir, "facet-v2-delivery-secret.txt"),
};
const facetKeys = {};
for (const [name, keyPath] of Object.entries(facetKeyFiles)) {
  if (!existsSync(keyPath)) {
    log(`generating throwaway ${name} into deploy/local/keys/`);
    mkdirSync(keysDir, { recursive: true });
    writeFileSync(keyPath, `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600 });
  }
  const value = readFileSync(keyPath, "utf8").trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    fail(`${name} is invalid; remove ${keyPath} and retry`);
  }
  facetKeys[name] = value;
}

// Retain the token for the surviving local Worker effect ledger.
const effectRuntimeTokenPath = path.join(keysDir, "effect-runtime-token.txt");
if (!existsSync(effectRuntimeTokenPath)) {
  log("generating throwaway effect-runtime token into deploy/local/keys/");
  mkdirSync(keysDir, { recursive: true });
  writeFileSync(effectRuntimeTokenPath, `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600 });
}
const effectRuntimeToken = readFileSync(effectRuntimeTokenPath, "utf8").trim();
if (!/^[A-Za-z0-9_-]{43}$/.test(effectRuntimeToken)) {
  fail("effect-runtime token is invalid; remove deploy/local/keys/effect-runtime-token.txt and retry");
}

const acceptanceHmacPath = path.join(keysDir, "customer-acceptance-hmac-key.txt");
if (!existsSync(acceptanceHmacPath)) {
  log("generating throwaway customer-acceptance HMAC key into deploy/local/keys/");
  mkdirSync(keysDir, { recursive: true });
  writeFileSync(acceptanceHmacPath, `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600 });
}
const acceptanceHmacKey = readFileSync(acceptanceHmacPath, "utf8").trim();
if (!/^[A-Za-z0-9_-]{43}$/.test(acceptanceHmacKey)) {
  fail("customer acceptance HMAC key is invalid; remove deploy/local/keys/customer-acceptance-hmac-key.txt and retry");
}

// 2. .dev.vars -----------------------------------------------------------------
// A fresh checkout has no .dev.vars at all, so ADMIN_TOKEN, INGEST_TOKEN, APP_AUTH_PEPPER and
// the rest of the documented local shape used to be a hand-add step every tester rediscovered
// (ELEC-112 finding 6, reproduced again in ELEC-120). Seed the file from the example first;
// the generated values below then overwrite the placeholders that have real local answers.
// An existing .dev.vars is never rewritten - whatever the operator put there stays.
const devVarsExamplePath = path.join(workersBus, ".dev.vars.example");
if (!existsSync(devVarsExamplePath)) fail("workers-bus/.dev.vars.example is missing");
let vars;
try {
  const seeded = scaffoldDevVars({
    existing: existsSync(devVarsPath) ? readFileSync(devVarsPath, "utf8") : "",
    example: readFileSync(devVarsExamplePath, "utf8"),
  });
  vars = seeded.text;
  if (seeded.scaffolded) {
    log("no .dev.vars - scaffolding it from .dev.vars.example (throwaway local placeholders)");
  }
} catch (error) {
  fail(error.message);
}
const next = applyVars(vars, [
  // Every value below that carries a host port overrides the port wrangler.jsonc's `local` env
  // hard-codes, so one exported IRONWRAP_LOCAL_* variable is enough to move a whole stack.
  // dev-vars.mjs owns that list; its test asserts it covers every loopback var in wrangler.jsonc.
  ...portBearingVars({ frappePort, workerPort }),
  ...retiredBrokerVars,
  ["APP_CUSTOMER_ACCEPTANCE_HMAC_KEY", acceptanceHmacKey],
  ["EFFECT_RUNTIME_TOKEN", effectRuntimeToken],
  ["FACET_LAUNCH_HMAC_KEY", facetKeys.FACET_LAUNCH_HMAC_KEY],
  ["FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY", facetKeys.FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY],
  // The delivery-verification key Facet signs with. wrangler.jsonc's local
  // FACET_V2_ROUTES_JSON declares the matching route; key id/version are pinned
  // so a locally signed event verifies without any shared production secret.
  ["FACET_V2_KEYS_JSON", JSON.stringify([{
    key_id: "local-facet-v2",
    key_version: 1,
    secret: facetKeys.FACET_V2_DELIVERY_SECRET,
    not_before_ms: 0,
    not_after_ms: 4102444800000,
  }])],
]);
if (next !== vars) {
  writeFileSync(devVarsPath, next);
  log(".dev.vars updated with the local keys and ports");
}

// 3. local D1 migrations -------------------------------------------------------
log("applying D1 migrations to the local database");
try {
  execSync("npx wrangler d1 migrations apply ironwrap-bus --local --env local", {
    cwd: workersBus,
    stdio: "inherit",
    env: { ...process.env, CI: "true" },
  });
} catch {
  fail("local D1 migration apply failed");
}

log(`OK - local stack ready. Starting wrangler dev on ${workerOrigin}`);
