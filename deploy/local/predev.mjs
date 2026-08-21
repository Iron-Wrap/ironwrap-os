#!/usr/bin/env node
/**
 * IronWrap OS local end-to-end preflight (idempotent, fast when warm).
 *
 * `npm run dev` in workers-bus runs this before `wrangler dev --env local`. It guarantees:
 *   1. ../app/dist exists (builds the PWA once when missing)
 *   2. the deploy/local Frappe stack (mariadb, redis, frappe) is up and answering
 *   3. .dev.vars exists at all - scaffolded from .dev.vars.example on a fresh checkout,
 *      so ADMIN_TOKEN/INGEST_TOKEN/APP_AUTH_PEPPER are never a hand-added step - and then
 *      carries the Frappe integration, customer-acceptance and Facet design-projection API
 *      key/secret pairs, the throwaway Facet chain keys, and every host-port-bearing local
 *      value (Frappe base URL, Worker origin, broker URLs) so a second isolated stack never
 *      inherits the first one's ports
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
import { applyVars, brokerPorts, portBearingVars, scaffoldDevVars } from "./dev-vars.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const workersBus = path.join(repoRoot, "workers-bus");
const composeFile = path.join(here, "docker-compose.yml");
const devVarsPath = path.join(workersBus, ".dev.vars");
const keysDir = path.join(here, "keys");
// Defaults to the single documented local stack. A second stack (another agent on
// the same machine, or a throwaway volume for a resync proof) sets both this and
// COMPOSE_PROJECT_NAME so it never touches the first one's containers or volumes.
const frappePort = process.env.IRONWRAP_LOCAL_FRAPPE_PORT ?? "8000";
const frappeUrl = `http://localhost:${frappePort}`;
// The same treatment for the two host ports the Worker side owns. wrangler.jsonc is static JSON
// and cannot read the environment, so every port-bearing value it pins for the `local` env is
// re-declared into .dev.vars below, which wrangler dev loads over the config's `vars`. Without
// this a second stack's Worker silently talked to the FIRST stack's Frappe (ELEC-112 process risk
// 4) and could not bind its own port at all (risk 5).
const workerPort = process.env.IRONWRAP_LOCAL_WORKER_PORT ?? "7100";
const workerOrigin = `http://localhost:${workerPort}`;
// One base for the four approval brokers, keeping their existing 9101-9104 layout.
const brokerPortBase = process.env.IRONWRAP_LOCAL_BROKER_PORT_BASE ?? "9100";
let brokerPort;
try {
  brokerPort = brokerPorts(brokerPortBase);
} catch (error) {
  console.error(`[predev] ERROR: ${error.message}`);
  process.exit(1);
}

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

// Facet v2 chain key material (throwaway, gitignored). Three distinct purposes,
// never shared: the launch capability HMAC the Worker signs an "open in Facet"
// URL with, the delivery-verification key Facet signs its customer-decision
// event with, and the projection HMAC the Worker and the Frappe app both hold
// for facet_design_projection_api.
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

// The Worker-to-broker secret for the proposal-publication approval rail. It is
// generated here for the same reason the Facet keys are: without it the local
// stack cannot traverse step 5 at all, and a hand-invented value is one more
// undocumented manual step between a fresh checkout and a working chain.
const proposalPublicationSecretPath = path.join(keysDir, "proposal-publication-broker-secret.txt");
if (!existsSync(proposalPublicationSecretPath)) {
  log("generating throwaway proposal-publication broker secret into deploy/local/keys/");
  mkdirSync(keysDir, { recursive: true });
  writeFileSync(proposalPublicationSecretPath, `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600 });
}
const proposalPublicationBrokerSecret = readFileSync(proposalPublicationSecretPath, "utf8").trim();
if (!/^[A-Za-z0-9_-]{43}$/.test(proposalPublicationBrokerSecret)) {
  fail(
    "proposal-publication broker secret is invalid; remove deploy/local/keys/proposal-publication-broker-secret.txt and retry",
  );
}

// The production-schedule broker is the step-6 half of the same story: without
// its own Worker-to-broker secret the scheduling rail cannot be reached locally
// at all, and every broker authority keeps a distinct secret.
const productionScheduleSecretPath = path.join(keysDir, "production-schedule-broker-secret.txt");
if (!existsSync(productionScheduleSecretPath)) {
  log("generating throwaway production-schedule broker secret into deploy/local/keys/");
  mkdirSync(keysDir, { recursive: true });
  writeFileSync(productionScheduleSecretPath, `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600 });
}
const productionScheduleBrokerSecret = readFileSync(productionScheduleSecretPath, "utf8").trim();
if (!/^[A-Za-z0-9_-]{43}$/.test(productionScheduleBrokerSecret)) {
  fail(
    "production-schedule broker secret is invalid; remove deploy/local/keys/production-schedule-broker-secret.txt and retry",
  );
}

// The Worker authenticates /admin/effects/* with EFFECT_RUNTIME_TOKEN, not
// ADMIN_TOKEN (index.ts:606). It is not in .dev.vars.example, so a local stack
// had no value for it and every broker write that goes through the effect ledger
// answered 401 - which the broker then reports as broker_mcp_call_ambiguous.
// Generating it here is what makes an approved write reach Frappe locally.
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

const decisionHmacPath = path.join(keysDir, "customer-decision-hmac-key.txt");
if (!existsSync(decisionHmacPath)) {
  log("generating throwaway customer-decision HMAC key into deploy/local/keys/");
  mkdirSync(keysDir, { recursive: true });
  writeFileSync(decisionHmacPath, `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600 });
}
const decisionHmacKey = readFileSync(decisionHmacPath, "utf8").trim();
if (!/^[A-Za-z0-9_-]{43}$/.test(decisionHmacKey)) {
  fail("customer decision HMAC key is invalid; remove deploy/local/keys/customer-decision-hmac-key.txt and retry");
}

// 2. Frappe stack -------------------------------------------------------------
log("ensuring local Frappe stack is up (docker compose)");
try {
  execSync(`docker compose -f "${composeFile}" up -d`, { stdio: "inherit" });
} catch {
  fail(
    "docker compose up failed - is Docker running? A frappe-init exit 1 with a STALE VOLUME banner " +
      "means IRONWRAP_LOCAL_APP_RESYNC=off refused a drifted bench; re-run without it to resync.",
  );
}

// The bench serves a COPY of the app, so a resync that happened inside the
// init container is not live until the already-running bench reloads it.
// frappe-init leaves a marker in the volume precisely because the restart has
// to happen out here, where compose is.
const resyncMarker = "/home/frappe/frappe-bench/sites/.ironwrap_app_resync_pending";
let resynced = false;
try {
  execFileSync("docker", ["compose", "-f", composeFile, "exec", "-T", "frappe", "test", "-f", resyncMarker], {
    stdio: "ignore",
  });
  resynced = true;
} catch {
  /* no resync happened on this boot */
}
if (resynced) {
  log("frappe-init resynced a stale bench - restarting frappe so it serves the new app code");
  try {
    execFileSync("docker", ["compose", "-f", composeFile, "exec", "-T", "frappe", "rm", "-f", resyncMarker], {
      stdio: "ignore",
    });
    execSync(`docker compose -f "${composeFile}" restart frappe`, { stdio: "inherit" });
  } catch {
    fail("could not restart the frappe container after an app resync");
  }
}

log(`waiting for Frappe API (${frappeUrl}/api/method/ping)`);
let frappeUp = false;
for (let attempt = 0; attempt < 90; attempt += 1) {
  try {
    const res = execSync(`curl -sf --max-time 3 ${frappeUrl}/api/method/ping`, {
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
    "bench", "--site", "ironwrap.localhost", "set-config", "--",
    "ironwrap_customer_acceptance_hmac_key", acceptanceHmacKey,
  ]);
} catch {
  fail("could not configure the local customer acceptance HMAC key");
}

let decisionCreds;
try {
  decisionCreds = JSON.parse(
    run("docker", [
      "compose", "-f", composeFile, "exec", "-T", "frappe",
      "cat", "/home/frappe/frappe-bench/sites/ironwrap.localhost/.customer_decision_credentials",
    ]),
  );
} catch {
  fail("could not read customer decision credentials from the container");
}
if (!decisionCreds?.api_key || !decisionCreds?.api_secret) {
  fail("customer decision credentials are empty");
}
try {
  run("docker", [
    "compose", "-f", composeFile, "exec", "-T", "frappe",
    "bench", "--site", "ironwrap.localhost", "set-config", "--",
    "ironwrap_customer_decision_hmac_key", decisionHmacKey,
  ]);
} catch {
  fail("could not configure the local customer decision HMAC key");
}

let facetProjectionCreds;
try {
  facetProjectionCreds = JSON.parse(
    run("docker", [
      "compose", "-f", composeFile, "exec", "-T", "frappe",
      "cat", "/home/frappe/frappe-bench/sites/ironwrap.localhost/.facet_design_projection_credentials",
    ]),
  );
} catch {
  fail("could not read Facet design projection credentials from the container");
}
if (!facetProjectionCreds?.api_key || !facetProjectionCreds?.api_secret) {
  fail("Facet design projection credentials are empty");
}
try {
  run("docker", [
    "compose", "-f", composeFile, "exec", "-T", "frappe",
    "bench", "--site", "ironwrap.localhost", "set-config", "--",
    "ironwrap_facet_design_projection_hmac_key",
    facetKeys.FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY,
  ]);
} catch {
  fail("could not configure the local Facet design projection HMAC key");
}

// Dedicated per-rail Frappe issuers (ELEC-56). `containerCredentials` is declared just
// below and hoisted, so these two reads sit here beside the other service identities.
const fleetCaptureIssuerCreds = containerCredentials(
  ".fleet_capture_issuer_credentials",
  "fleet-capture issuer",
);
const workPackageIssuerCreds = containerCredentials(
  ".work_package_issuer_credentials",
  "work-package issuer",
);

// Broker actor credentials. Each broker process authenticates to Frappe as its
// own operator identity and refuses to start if the token resolves to anyone
// else, so these pairs are what make the approval rails bootable by script
// instead of by hand (ELEC-95 process risk 3).
function containerCredentials(file, label) {
  let parsed;
  try {
    parsed = JSON.parse(
      run("docker", [
        "compose", "-f", composeFile, "exec", "-T", "frappe",
        "cat", `/home/frappe/frappe-bench/sites/ironwrap.localhost/${file}`,
      ]),
    );
  } catch {
    fail(`could not read ${label} credentials from the container`);
  }
  if (!parsed?.api_key || !parsed?.api_secret) fail(`${label} credentials are empty`);
  return parsed;
}

const proposalPublicationActorCreds = containerCredentials(
  ".proposal_publication_broker_credentials",
  "proposal-publication broker actor",
);
const productionScheduleActorCreds = containerCredentials(
  ".production_schedule_broker_credentials",
  "production-schedule broker actor",
);

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
  ...portBearingVars({ frappePort, workerPort, brokerPortBase }),
  ["ERPNEXT_API_KEY", creds.api_key],
  ["ERPNEXT_API_SECRET", creds.api_secret],
  ["QB_RECONCILIATION_ISSUER_API_KEY", quickBooksIssuerCreds.api_key],
  ["QB_RECONCILIATION_ISSUER_API_SECRET", quickBooksIssuerCreds.api_secret],
  // Never `creds.*`: the point of the split is that a leaked bus pair cannot issue these
  // two rails, and the Frappe site config now pins them to their own users anyway.
  ["FLEET_CAPTURE_FRAPPE_API_KEY", fleetCaptureIssuerCreds.api_key],
  ["FLEET_CAPTURE_FRAPPE_API_SECRET", fleetCaptureIssuerCreds.api_secret],
  ["WORK_PACKAGE_FRAPPE_API_KEY", workPackageIssuerCreds.api_key],
  ["WORK_PACKAGE_FRAPPE_API_SECRET", workPackageIssuerCreds.api_secret],
  ["APP_CUSTOMER_ACCEPTANCE_HMAC_KEY", acceptanceHmacKey],
  ["APP_CUSTOMER_ACCEPTANCE_FRAPPE_API_KEY", acceptanceCreds.api_key],
  ["APP_CUSTOMER_ACCEPTANCE_FRAPPE_API_SECRET", acceptanceCreds.api_secret],
  ["APP_CUSTOMER_DECISION_HMAC_KEY", decisionHmacKey],
  ["APP_CUSTOMER_DECISION_FRAPPE_API_KEY", decisionCreds.api_key],
  ["APP_CUSTOMER_DECISION_FRAPPE_API_SECRET", decisionCreds.api_secret],
  ["EFFECT_RUNTIME_TOKEN", effectRuntimeToken],
  ["PROPOSAL_PUBLICATION_BROKER_SHARED_SECRET", proposalPublicationBrokerSecret],
  ["PRODUCTION_SCHEDULE_BROKER_SHARED_SECRET", productionScheduleBrokerSecret],
  ["FACET_LAUNCH_HMAC_KEY", facetKeys.FACET_LAUNCH_HMAC_KEY],
  ["FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY", facetKeys.FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY],
  ["FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_KEY", facetProjectionCreds.api_key],
  ["FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_SECRET", facetProjectionCreds.api_secret],
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
  log(".dev.vars updated with local Frappe integration credentials");
}

// 3b. broker env files ---------------------------------------------------------
// Steps 5 and 6 of the six-step workflow run through the proposal-publication and
// production-schedule approval brokers. Before this, nothing scripted started
// them: `deploy/*.env.example` describes a production systemd unit, and standing
// the pair up locally meant hand-writing two env files and hand-creating a Frappe
// user (ELEC-95). These generated files hold only throwaway local values and live
// in the already-gitignored keys directory; `start-approval-brokers.sh` sources
// them verbatim.

const brokerCommonEnv = [
  "# Generated by deploy/local/predev.mjs for the local stack only. Throwaway values.",
  "# Never copy into a deployed environment; deploy/*.env.example is the production shape.",
  `ERPNEXT_BASE_URL=${frappeUrl}`,
  "ERPNEXT_ALLOW_INSECURE_LOCAL=true",
  "ERPNEXT_TENANT_ID=ironwrap",
  "ERPNEXT_REQUEST_TIMEOUT_MS=10000",
  "ERPNEXT_WRITE_ENABLED=true",
  "IRONWRAP_EFFECT_RUNTIME_ENABLED=true",
  `IRONWRAP_EFFECT_RUNTIME_URL=${workerOrigin}`,
  `IRONWRAP_EFFECT_RUNTIME_TOKEN=${effectRuntimeToken}`,
  `HERMES_ROLE_POLICY_PATH=${path.join(repoRoot, "hermes/agents/roles.json")}`,
  `HERMES_DRY_RUN_SIGNING_KEY=${readFileSync(dryRunKeyPath, "utf8").trim()}`,
  `HERMES_APPROVAL_PUBLIC_KEY_FILE=${publicKeyPath}`,
  `HERMES_APPROVAL_PRIVATE_KEY_FILE=${privateKeyPath}`,
  "HERMES_APPROVER_ID=owner@ironwrap.local",
];
const brokerEnvFiles = [
  {
    file: "proposal-publication-broker.env",
    lines: [
      "HERMES_AGENT_ROLE=owner-operator",
      "HERMES_ACTOR_USER=owner-operator@ironwrap.local",
      `ERPNEXT_API_KEY=${proposalPublicationActorCreds.api_key}`,
      `ERPNEXT_API_SECRET=${proposalPublicationActorCreds.api_secret}`,
      "PROPOSAL_PUBLICATION_BROKER_TENANT_ID=ironwrap",
      // Must match APP_PROPOSAL_PUBLICATION_BROKER_KEY_ID/URL in wrangler.jsonc's local env.
      "PROPOSAL_PUBLICATION_BROKER_KEY_ID=local-proposal-publication-broker",
      `PROPOSAL_PUBLICATION_BROKER_SHARED_SECRET=${proposalPublicationBrokerSecret}`,
      "PROPOSAL_PUBLICATION_BROKER_LISTEN_HOST=127.0.0.1",
      `PROPOSAL_PUBLICATION_BROKER_PORT=${brokerPort.proposalPublication}`,
    ],
  },
  {
    file: "production-schedule-broker.env",
    lines: [
      "HERMES_AGENT_ROLE=production-controller",
      "HERMES_ACTOR_USER=production-controller@ironwrap.local",
      `ERPNEXT_API_KEY=${productionScheduleActorCreds.api_key}`,
      `ERPNEXT_API_SECRET=${productionScheduleActorCreds.api_secret}`,
      "PRODUCTION_SCHEDULE_BROKER_TENANT_ID=ironwrap",
      "PRODUCTION_SCHEDULE_BROKER_KEY_ID=local-production-schedule-broker",
      `PRODUCTION_SCHEDULE_BROKER_SHARED_SECRET=${productionScheduleBrokerSecret}`,
      "PRODUCTION_SCHEDULE_BROKER_LISTEN_HOST=127.0.0.1",
      `PRODUCTION_SCHEDULE_BROKER_PORT=${brokerPort.productionSchedule}`,
    ],
  },
];
for (const { file, lines } of brokerEnvFiles) {
  const target = path.join(keysDir, file);
  const body = `${[...brokerCommonEnv, ...lines].join("\n")}\n`;
  if (!existsSync(target) || readFileSync(target, "utf8") !== body) {
    writeFileSync(target, body, { mode: 0o600 });
    log(`wrote deploy/local/keys/${file}`);
  }
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

// Seeding a Verified Authority Record - which every #105 release gate requires - has to
// be done as a holder of `IronWrap Owner`, and the Worker's own integration identity
// deliberately is not one. The keys now exist; saying where stops the next tester
// minting one by hand in a bench console (ELEC-128 run notes).
log(
  "owner (IronWrap Owner) REST keys for fixture seeding: " +
    "docker compose -f deploy/local/docker-compose.yml exec frappe " +
    "cat sites/ironwrap.localhost/.owner_operator_credentials",
);

log(`OK - local stack ready (Frappe ${frappeUrl}). Starting wrangler dev on ${workerOrigin}`);
