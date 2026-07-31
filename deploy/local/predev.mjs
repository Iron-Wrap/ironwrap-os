#!/usr/bin/env node
/**
 * IronWrap OS local end-to-end preflight (idempotent, fast when warm).
 *
 * `npm run dev` in workers-bus runs this before `wrangler dev --env local`. It guarantees:
 *   1. ../app/dist exists (builds the PWA once when missing)
 *   2. the deploy/local Frappe stack (mariadb, redis, frappe) is up and answering
 *   3. .dev.vars carries the Frappe integration API key/secret for the local site
 *   4. every D1 migration is applied to the local (Miniflare) database
 *
 * It never touches production: the Frappe stack is the throwaway deploy/local one and
 * `wrangler dev --env local` overrides all bridge vars with local-only values.
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const workersBus = path.join(repoRoot, "workers-bus");
const composeFile = path.join(here, "docker-compose.yml");
const devVarsPath = path.join(workersBus, ".dev.vars");
const keysDir = path.join(here, "keys");

const log = (msg) => console.log(`[predev] ${msg}`);
const fail = (msg) => {
  console.error(`[predev] ERROR: ${msg}`);
  process.exit(1);
};

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"], ...opts })
    ?.toString()
    .trim();
}

// 1. PWA assets ---------------------------------------------------------------
if (!existsSync(path.join(repoRoot, "app/dist/manifest.webmanifest"))) {
  log("app/dist missing - building the PWA (one time per source change)");
  execSync("npm run build", { cwd: path.join(repoRoot, "app"), stdio: "inherit" });
}

// 1b. Hermes approval key material (throwaway, gitignored) ----------------------
// The Frappe app verifies broker-signed approval receipts with the PUBLIC key
// (mounted into the container); brokers hold the private key + dry-run HMAC.
const privateKeyPath = path.join(keysDir, "hermes-approval-private.pem");
const publicKeyPath = path.join(keysDir, "hermes-approval-public.pem");
const dryRunKeyPath = path.join(keysDir, "dry-run-signing-key.txt");
if (!existsSync(privateKeyPath) || !existsSync(publicKeyPath) || !existsSync(dryRunKeyPath)) {
  log("generating throwaway Hermes approval keys into deploy/local/keys/");
  mkdirSync(keysDir, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  writeFileSync(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }));
  writeFileSync(dryRunKeyPath, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
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

// 2. Frappe stack -------------------------------------------------------------
log("ensuring local Frappe stack is up (docker compose)");
try {
  execSync(`docker compose -f "${composeFile}" up -d`, { stdio: "inherit" });
} catch {
  fail("docker compose up failed - is Docker running?");
}

log("waiting for Frappe API (http://localhost:8000/api/method/ping)");
let frappeUp = false;
for (let attempt = 0; attempt < 90; attempt += 1) {
  try {
    const res = execSync("curl -sf --max-time 3 http://localhost:8000/api/method/ping", {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
    if (res.includes("pong")) {
      frappeUp = true;
      break;
    }
  } catch {
    /* still booting */
  }
  execSync("sleep 2");
}
if (!frappeUp) {
  fail(
    "Frappe did not answer in time. Check: docker compose -f deploy/local/docker-compose.yml logs frappe-init frappe",
  );
}

// 3. integration credentials into .dev.vars ------------------------------------
let creds;
try {
  creds = JSON.parse(
    run("docker", [
      "compose", "-f", composeFile, "exec", "-T", "frappe",
      "cat", "/home/frappe/frappe-bench/sites/ironwrap.localhost/.integration_credentials",
    ]),
  );
} catch {
  fail("could not read Frappe integration credentials from the container");
}
if (!creds?.api_key || !creds?.api_secret) fail("integration credentials are empty");

let quickBooksIssuerCreds;
try {
  quickBooksIssuerCreds = JSON.parse(
    run("docker", [
      "compose", "-f", composeFile, "exec", "-T", "frappe",
      "cat", "/home/frappe/frappe-bench/sites/ironwrap.localhost/.quickbooks_reconciliation_issuer_credentials",
    ]),
  );
} catch {
  fail("could not read QuickBooks reconciliation issuer credentials from the container");
}
if (!quickBooksIssuerCreds?.api_key || !quickBooksIssuerCreds?.api_secret) {
  fail("QuickBooks reconciliation issuer credentials are empty");
}

let acceptanceCreds;
try {
  acceptanceCreds = JSON.parse(
    run("docker", [
      "compose", "-f", composeFile, "exec", "-T", "frappe",
      "cat", "/home/frappe/frappe-bench/sites/ironwrap.localhost/.customer_acceptance_credentials",
    ]),
  );
} catch {
  fail("could not read customer acceptance credentials from the container");
}
if (!acceptanceCreds?.api_key || !acceptanceCreds?.api_secret) {
  fail("customer acceptance credentials are empty");
}
try {
  run("docker", [
    "compose", "-f", composeFile, "exec", "-T", "frappe",
    "bench", "--site", "ironwrap.localhost", "set-config",
    "ironwrap_customer_acceptance_hmac_key", acceptanceHmacKey,
  ]);
} catch {
  fail("could not configure the local customer acceptance HMAC key");
}

const vars = existsSync(devVarsPath) ? readFileSync(devVarsPath, "utf8") : "";
const setVar = (src, key, value) => {
  const line = `${key}=${value}`;
  return src.match(new RegExp(`^${key}=`, "m"))
    ? src.replace(new RegExp(`^${key}=.*$`, "m"), line)
    : `${src.trimEnd()}\n${line}\n`;
};
let next = vars;
for (const [key, value] of [
  ["ERPNEXT_API_KEY", creds.api_key],
  ["ERPNEXT_API_SECRET", creds.api_secret],
  ["QB_RECONCILIATION_ISSUER_API_KEY", quickBooksIssuerCreds.api_key],
  ["QB_RECONCILIATION_ISSUER_API_SECRET", quickBooksIssuerCreds.api_secret],
  ["APP_CUSTOMER_ACCEPTANCE_HMAC_KEY", acceptanceHmacKey],
  ["APP_CUSTOMER_ACCEPTANCE_FRAPPE_API_KEY", acceptanceCreds.api_key],
  ["APP_CUSTOMER_ACCEPTANCE_FRAPPE_API_SECRET", acceptanceCreds.api_secret],
]) {
  next = setVar(next, key, value);
}
if (next !== vars) {
  writeFileSync(devVarsPath, next);
  log(".dev.vars updated with local Frappe integration credentials");
}

// 4. local D1 migrations -------------------------------------------------------
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

log("OK - local stack ready. Starting wrangler dev on http://localhost:7100");
