#!/usr/bin/env node
import { createPublicKey } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stripJsonComments } from "./generate-tenant-worker-config.mjs";
import { flattenWranglerVars } from "./wrangler-vars.mjs";
// The capability registry and its evaluator are imported, not restated. G1.3 found this verifier
// covered none of the eight capabilities spec 9.3 names, so a flag flip on QuickBooks, Newo,
// Postiz, Hermes desktop or the proposal template was caught by nothing. Restating the rules here
// would have produced a second, silently diverging answer; importing the module the Worker itself
// serves means the contract gate and the runtime signal cannot disagree (ELEC-240).
import {
  CAPABILITY_SIGNAL_IDS,
  CAPABILITY_SIGNAL_REGISTRY,
  NAMED_REFERENCE_CAPABILITY_IDS,
  capabilitySecretBindings,
  evaluateCapabilitySignals,
} from "../workers-bus/src/capability-signal.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO_ROOT = path.resolve(HERE, "..");

const REQUIRED_DEPLOY_FILES = [
  "deploy/runtime-lock.json",
  "deploy/Containerfile.frappe",
  "deploy/apps.example.json",
  "deploy/env.example",
  "deploy/release.env.example",
  "deploy/cloudflared-config.example.yml",
  "deploy/approval-broker.service.example",
  "deploy/approval-broker.env.example",
  "deploy/quote-revision-approval-broker.service.example",
  "deploy/quote-revision-approval-broker.env.example",
  "deploy/production-schedule-approval-broker.service.example",
  "deploy/production-schedule-approval-broker.env.example",
  "deploy/backup-to-r2.sh",
  "deploy/restore-from-r2.sh",
  "deploy/backup-d1-to-r2.sh",
  "deploy/restore-d1-from-r2.sh",
  "deploy/build-production-image.sh",
  "deploy/frappe-compose.override.yml",
  "deploy/validate-frappe-compose.sh",
  "deploy/host-preflight.sh",
  "deploy/split-app-repo.sh",
];

const REQUIRED_ENV_NAMES = [
  "FRAPPE_VERSION",
  "FRAPPE_COMMIT",
  "FRAPPE_DOCKER_VERSION",
  "FRAPPE_DOCKER_COMMIT",
  "HERMES_VERSION",
  "HERMES_COMMIT",
  "IRONWRAP_OS_IMAGE",
  "ERPNEXT_ENABLED",
  "ERPNEXT_BASE_URL",
  "ERPNEXT_API_KEY",
  "ERPNEXT_API_SECRET",
  "ERPNEXT_INTEGRATION_USER",
  "QB_WEBHOOK_TOKEN",
  "QB_EXPECTED_REALM_ID",
  "QB_RECONCILIATION_ISSUER_USER",
  "QB_RECONCILIATION_ISSUER_API_KEY",
  "QB_RECONCILIATION_ISSUER_API_SECRET",
  "IRONWRAP_QUICKBOOKS_RECONCILIATION_ISSUER_USER",
  "PUBLIC_ESTIMATE_ENABLED",
  "PUBLIC_ESTIMATE_ALLOWED_ORIGINS",
  "PUBLIC_ESTIMATE_ALLOWED_BRANDS",
  "PUBLIC_ESTIMATE_CONSENT_JURISDICTION",
  "PUBLIC_ESTIMATE_TURNSTILE_SITE_KEY",
  "PUBLIC_ESTIMATE_TURNSTILE_SECRET",
  "PUBLIC_ESTIMATE_RATE_LIMIT_PEPPER",
  "PUBLIC_ESTIMATE_RATE_LIMIT_WINDOW_SECONDS",
  "PUBLIC_ESTIMATE_RATE_LIMIT_IP_MAX",
  "PUBLIC_ESTIMATE_RATE_LIMIT_CLIENT_MAX",
  "PUBLIC_ESTIMATE_RANGE_RULES_JSON",
  "FACET_DESIGN_INGEST_ENABLED",
  "FACET_DESIGN_INGEST_SOURCE_TENANT_ID",
  "FACET_DESIGN_INGEST_TENANT_MAP_JSON",
  "FACET_DESIGN_INGEST_HMAC_KEY",
  "FACET_DESIGN_FRAPPE_PROJECTION_ENABLED",
  "FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY",
  "FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_KEY",
  "FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_SECRET",
  "APP_FACET_QUOTE_REVISION_PREPARE_ENABLED",
  "APP_QUOTE_REVISION_BROKER_URL",
  "APP_QUOTE_REVISION_BROKER_KEY_ID",
  "APP_QUOTE_REVISION_BROKER_TIMEOUT_MS",
  "APP_QUOTE_REVISION_EXECUTION_LEASE_SECONDS",
  "QUOTE_REVISION_BROKER_SHARED_SECRET",
  "EFFECT_RUNTIME_TOKEN",
  "IRONWRAP_BUS_BASE_URL",
  "IRONWRAP_ADMIN_TOKEN",
  "IRONWRAP_EFFECT_RUNTIME_ENABLED",
  "IRONWRAP_EFFECT_RUNTIME_URL",
  "IRONWRAP_EFFECT_RUNTIME_TOKEN",
  "IRONWRAP_BUS_WRITE_ENABLED",
  "ERPNEXT_WRITE_ENABLED",
  "HERMES_WRITE_TOKEN",
  "HERMES_AGENT_ROLE",
  "HERMES_ACTOR_USER",
  "HERMES_APPROVER_ID",
  "HERMES_DRY_RUN_SIGNING_KEY",
  "APPROVAL_BROKER_SHARED_SECRET",
  "HERMES_APPROVAL_PUBLIC_KEY_FILE",
  "IRONWRAP_HERMES_APPROVAL_PUBLIC_KEY_FILE",
  "IRONWRAP_HERMES_SITE_BASE_URL",
  "IRONWRAP_BUS_REQUEST_TIMEOUT_MS",
  "ERPNEXT_REQUEST_TIMEOUT_MS",
  "BUS_BASE_URL",
  "INGEST_TOKEN",
  "ADMIN_TOKEN",
  "FRAPPE_BASE_URL",
  "FRAPPE_API_KEY",
  "FRAPPE_API_SECRET",
  "FRAPPE_PROOF_POLL_ATTEMPTS",
  "FRAPPE_PROOF_POLL_INTERVAL_MS",
  "FRAPPE_SITE",
  "BACKEND_CONTAINER",
  "RCLONE_CONFIG_R2_TYPE",
  "RCLONE_CONFIG_R2_PROVIDER",
  "RCLONE_CONFIG_R2_ACCESS_KEY_ID",
  "RCLONE_CONFIG_R2_SECRET_ACCESS_KEY",
  "RCLONE_CONFIG_R2_ENDPOINT",
  "R2_BACKUP_BUCKET",
  "BACKUP_RETENTION_DAYS",
  "BACKUP_AGE_RECIPIENT",
  "D1_BACKUP_API_TOKEN",
  "D1_RESTORE_API_TOKEN",
  "D1_PRODUCTION_ACCOUNT_ID",
  "D1_PRODUCTION_DATABASE_NAME",
  "D1_PRODUCTION_DATABASE_ID",
  "D1_R2_BACKUP_BUCKET",
  "D1_BACKUP_RETENTION_DAYS",
  "D1_RESTORE_R2_COMPLETED_PREFIX",
  "D1_RESTORE_AGE_IDENTITY_FILE",
  "D1_RESTORE_MODE",
  "D1_RESTORE_TARGET_ACCOUNT_ID",
  "D1_RESTORE_TARGET_DATABASE_NAME",
  "D1_RESTORE_TARGET_DATABASE_ID",
  "D1_RESTORE_CONFIRMATION",
  "RESTORE_R2_COMPLETED_PREFIX",
  "RESTORE_AGE_IDENTITY_FILE",
  "RESTORE_TARGET_SITE",
  "RESTORE_TARGET_CONTAINER",
  "RESTORE_CONFIRMATION",
];

const PUBLIC_ESTIMATE_ENABLE_TIME_ENV_NAMES = new Set([
  "ERPNEXT_INTEGRATION_USER",
  "PUBLIC_ESTIMATE_ALLOWED_ORIGINS",
  "PUBLIC_ESTIMATE_ALLOWED_BRANDS",
  "PUBLIC_ESTIMATE_CONSENT_JURISDICTION",
  "PUBLIC_ESTIMATE_TURNSTILE_SITE_KEY",
  "PUBLIC_ESTIMATE_TURNSTILE_SECRET",
  "PUBLIC_ESTIMATE_RATE_LIMIT_PEPPER",
  "PUBLIC_ESTIMATE_RATE_LIMIT_WINDOW_SECONDS",
  "PUBLIC_ESTIMATE_RATE_LIMIT_IP_MAX",
  "PUBLIC_ESTIMATE_RATE_LIMIT_CLIENT_MAX",
  "PUBLIC_ESTIMATE_RANGE_RULES_JSON",
]);

const FACET_ENABLE_TIME_ENV_NAMES = new Set([
  "FACET_DESIGN_INGEST_SOURCE_TENANT_ID",
  "FACET_DESIGN_INGEST_TENANT_MAP_JSON",
  "FACET_DESIGN_INGEST_HMAC_KEY",
  "FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY",
  "FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_KEY",
  "FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_SECRET",
  "APP_QUOTE_REVISION_BROKER_URL",
  "APP_QUOTE_REVISION_BROKER_KEY_ID",
  "APP_QUOTE_REVISION_BROKER_TIMEOUT_MS",
  "APP_QUOTE_REVISION_EXECUTION_LEASE_SECONDS",
  "QUOTE_REVISION_BROKER_SHARED_SECRET",
]);

const LIVE_REQUIRED_ENV_NAMES = REQUIRED_ENV_NAMES.filter(
  (name) => name !== "RESTORE_CONFIRMATION" && name !== "D1_RESTORE_CONFIRMATION" &&
    name !== "D1_RESTORE_API_TOKEN" && !PUBLIC_ESTIMATE_ENABLE_TIME_ENV_NAMES.has(name) &&
    !FACET_ENABLE_TIME_ENV_NAMES.has(name),
);

const LEFTOVER_FRAPPE_RAIL_SECRETS = [
  ["FLEET_CAPTURE_FRAPPE_API_KEY", 10],
  ["FLEET_CAPTURE_FRAPPE_API_SECRET", 16],
  ["WORK_PACKAGE_FRAPPE_API_KEY", 10],
  ["WORK_PACKAGE_FRAPPE_API_SECRET", 16],
];

const SECRET_ENV_NAMES = [
  "ERPNEXT_API_KEY",
  "ERPNEXT_API_SECRET",
  ...LEFTOVER_FRAPPE_RAIL_SECRETS.map(([name]) => name),
  "QB_WEBHOOK_TOKEN",
  "QB_RECONCILIATION_ISSUER_API_KEY",
  "QB_RECONCILIATION_ISSUER_API_SECRET",
  "PUBLIC_ESTIMATE_TURNSTILE_SECRET",
  "PUBLIC_ESTIMATE_RATE_LIMIT_PEPPER",
  "FACET_DESIGN_INGEST_HMAC_KEY",
  "FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY",
  "FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_KEY",
  "FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_SECRET",
  "QUOTE_REVISION_BROKER_SHARED_SECRET",
  "EFFECT_RUNTIME_TOKEN",
  "IRONWRAP_EFFECT_RUNTIME_TOKEN",
  "IRONWRAP_ADMIN_TOKEN",
  "HERMES_WRITE_TOKEN",
  "HERMES_DRY_RUN_SIGNING_KEY",
  "APPROVAL_BROKER_SHARED_SECRET",
  "INGEST_TOKEN",
  "ADMIN_TOKEN",
  "FRAPPE_API_KEY",
  "FRAPPE_API_SECRET",
  "D1_BACKUP_API_TOKEN",
  "D1_RESTORE_API_TOKEN",
  "RCLONE_CONFIG_R2_ACCESS_KEY_ID",
  "RCLONE_CONFIG_R2_SECRET_ACCESS_KEY",
];

const RELEASE_AUTOMATION_ENV_NAMES = [
  "RELEASE_POLICY_LEDGER_API_TOKEN",
  "RELEASE_QA_CLOUDFLARE_API_TOKEN",
  "RELEASE_PRODUCTION_CLOUDFLARE_API_TOKEN",
  "RELEASE_PERMIT_PRIVATE_KEY",
  "RELEASE_PERMIT_PUBLIC_KEY",
  "RELEASE_QA_INGEST_TOKEN",
  "RELEASE_QA_ADMIN_TOKEN",
  "RELEASE_QA_FRAPPE_BASE_URL",
  "RELEASE_QA_FRAPPE_API_KEY",
  "RELEASE_QA_FRAPPE_API_SECRET",
  "RELEASE_PRODUCTION_INGEST_TOKEN",
  "RELEASE_PRODUCTION_ADMIN_TOKEN",
  "RELEASE_PRODUCTION_FRAPPE_BASE_URL",
  "RELEASE_PRODUCTION_FRAPPE_API_KEY",
  "RELEASE_PRODUCTION_FRAPPE_API_SECRET",
  "RELEASE_SERVICE_ADAPTER_URL",
  "RELEASE_SERVICE_ADAPTER_TOKEN",
  "RELEASE_SERVICE_ADAPTER_PUBLIC_KEY",
  "RELEASE_SERVICE_ADAPTER_IDENTITY",
  "RELEASE_SERVICE_ADAPTER_TASK_ID",
  "RELEASE_SERVICE_ADAPTER_RUN_ID",
  "RELEASE_SERVICE_ADAPTER_KEY_VERSION",
  "RELEASE_SERVICE_ADAPTER_PRIVATE_KEY",
];

const EXPECTED_SOURCES = {
  frappe: "https://github.com/frappe/frappe.git",
  frappe_docker: "https://github.com/frappe/frappe_docker.git",
  hermes: "https://github.com/NousResearch/hermes-agent.git",
};

/**
 * The capability state the committed reference configuration is in, recorded rather than frozen.
 *
 * This is not a ban on changing a flag. It is the requirement that changing one is a visible,
 * reviewed act: turn `QB_OAUTH_ENABLED` on and this gate fails until the new state is recorded
 * here, in `docs/CAPABILITY-MATRIX.md`, and in the AI-native configuration contract. That is the
 * same discipline `workers-bus/test/app-migration.test.ts` applies to the raw defaults, raised to
 * the state a user is actually shown -- and it is what makes "on but unconfigured" a state the
 * readiness contract can hold, instead of one it cannot express.
 *
 * Values come from `evaluateCapabilitySignals` over `wrangler.jsonc`'s top-level (production)
 * `vars`, with every secret binding opaque, because a static file genuinely cannot see one.
 */
const CAPABILITY_REFERENCE_STATE = {
  document_generation: "off",
  effect_runtime: "available",
  facet_design_ingest: "unconfigured",
  facet_design_ingest_v1: "absent",
  facet_frappe_projection: "off",
  facet_launch: "unconfigured",
  facet_native_projection: "dependency_blocked",
  facet_quote_revision_prepare: "absent",
  hermes_desktop: "off",
  hermes_hosted_reference: "off",
  newo: "off",
  postiz: "off",
  proposal_publication: "off",
  proposal_template: "unconfigured",
  public_estimator: "off",
  quickbooks_final_invoice: "off",
  quickbooks_oauth: "off",
};

function check(id, ok, passMessage, failMessage = passMessage) {
  return { id, status: ok ? "pass" : "fail", message: ok ? passMessage : failMessage };
}

function finish(mode, checks) {
  const passed = checks.filter((item) => item.status === "pass").length;
  const failed = checks.length - passed;
  return { mode, ok: failed === 0, summary: { passed, failed, total: checks.length }, checks };
}

async function readText(root, relative) {
  try {
    return await readFile(path.join(root, relative), "utf8");
  } catch {
    return null;
  }
}

function shellCsvAssignment(script, name) {
  const match = script.match(new RegExp(`^${name}="([^"]*)"$`, "m"));
  const additions = [...script.matchAll(new RegExp(`^${name}\\+="([^"]*)"$`, "gm"))]
    .map((item) => item[1]);
  const value = [match?.[1] ?? "", ...additions].join("");
  return value ? value.split(",").filter(Boolean).sort() : [];
}

function shellIntegerAssignment(script, name) {
  const match = script.match(new RegExp(`^${name}=([0-9]+)$`, "m"));
  return match ? Number(match[1]) : null;
}

async function d1MigrationInventory(repoRoot) {
  const migrationsRoot = path.join(repoRoot, "workers-bus/migrations");
  let database;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const files = (await readdir(migrationsRoot)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
    database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    for (const file of files) {
      database.exec(await readFile(path.join(migrationsRoot, file), "utf8"));
    }
    const schemaRows = (type) => database.prepare(
      `SELECT name, tbl_name
         FROM sqlite_master
        WHERE type = ? AND name NOT LIKE 'sqlite_%'
        ORDER BY name`,
    ).all(type);
    const tables = schemaRows("table").map(({ name }) => String(name));
    const indexBindings = schemaRows("index")
      .map(({ name, tbl_name: table }) => `${String(name)}=${String(table)}`);
    const triggerBindings = schemaRows("trigger")
      .map(({ name, tbl_name: table }) => `${String(name)}=${String(table)}`);
    return {
      ok: files.length > 0 && tables.length > 0 && indexBindings.length > 0 &&
        triggerBindings.length > 0,
      tables,
      indexBindings,
      triggerBindings,
    };
  } catch {
    return { ok: false, tables: [], indexBindings: [], triggerBindings: [] };
  } finally {
    database?.close();
  }
}

function parseEnvTemplate(text) {
  const values = new Map();
  const duplicates = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (!line || /^\s*#/.test(line)) continue;
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    if (values.has(match[1])) duplicates.add(match[1]);
    values.set(match[1], match[2]);
  }
  return { values, duplicates };
}

function validSafeAbsolutePath(value) {
  return typeof value === "string" &&
    /^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(value) &&
    !/(?:^|\/)\.\.?($|\/)/.test(value);
}

function normalizedProductionUrl(value) {
  if (!isHttpsProductionUrl(value)) return null;
  try {
    const parsed = new URL(value);
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return parsed.toString();
  } catch {
    return null;
  }
}

function privateBrokerEnvTemplate(text, {
  role,
  actor,
  publicKeyPath,
  privateKeyPath,
  prefix,
  keyId,
  port,
}) {
  const parsed = parseEnvTemplate(text);
  const { values } = parsed;
  const expected = {
    ERPNEXT_REQUEST_TIMEOUT_MS: "10000",
    ERPNEXT_WRITE_ENABLED: "true",
    HERMES_AGENT_ROLE: role,
    HERMES_ACTOR_USER: actor,
    HERMES_APPROVER_ID: "owner@ironwrapexteriors.com",
    HERMES_ROLE_POLICY_PATH: "/srv/ironwrap/hermes/agents/roles.json",
    HERMES_APPROVAL_PUBLIC_KEY_FILE: publicKeyPath,
    HERMES_APPROVAL_PRIVATE_KEY_FILE: privateKeyPath,
    [`${prefix}_TENANT_ID`]: "ironwrap",
    [`${prefix}_KEY_ID`]: keyId,
    [`${prefix}_LISTEN_HOST`]: "127.0.0.1",
    [`${prefix}_PORT`]: port,
    [`${prefix}_MAX_CLOCK_SKEW_MS`]: "60000",
    [`${prefix}_MAX_APPROVAL_LIFETIME_MS`]: "300000",
  };
  const placeholderKeys = [
    "ERPNEXT_BASE_URL",
    "ERPNEXT_API_KEY",
    "ERPNEXT_API_SECRET",
    "HERMES_DRY_RUN_SIGNING_KEY",
    `${prefix}_SHARED_SECRET`,
  ];
  return {
    values,
    ok: parsed.duplicates.size === 0 &&
      Object.entries(expected).every(([name, value]) => values.get(name) === value) &&
      placeholderKeys.every((name) => isPlaceholder(values.get(name))) &&
      values.get(`${prefix}_SHARED_SECRET`) !== values.get("HERMES_DRY_RUN_SIGNING_KEY"),
  };
}

export function isPlaceholder(value) {
  if (typeof value !== "string" || value.trim() === "") return true;
  const normalized = value.trim().toLowerCase();
  return (
    /[<>]/.test(value) ||
    /\$\{[^}]*\}/.test(value) ||
    /(^|[^a-z])(change[-_ ]?me|replace[-_ ]?me|placeholder|todo|tbd|xxx)([^a-z]|$)/i.test(value) ||
    normalized === "example" ||
    normalized.includes("example.com") ||
    normalized.includes("your-token") ||
    normalized.includes("your-secret")
  );
}

function isHttpsProductionUrl(value, { r2 = false } = {}) {
  if (isPlaceholder(value)) return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || parsed.search) return false;
    const host = parsed.hostname.toLowerCase();
    if (!host || host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local")) return false;
    if (r2) {
      if (!/^[a-z0-9-]+\.r2\.cloudflarestorage\.com$/.test(host)) return false;
      if (parsed.port || (parsed.pathname !== "/" && parsed.pathname !== "") || parsed.search) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function exactHttpsOrigin(value) {
  if (isPlaceholder(value)) return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port ||
      parsed.pathname !== "/" || parsed.search || parsed.hash ||
      parsed.hostname === "localhost" || parsed.hostname.endsWith(".local")
    ) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function validPositiveInteger(value, minimum, maximum) {
  return typeof value === "string" && /^(?:[1-9][0-9]*)$/.test(value) &&
    Number(value) >= minimum && Number(value) <= maximum;
}

function publicEstimateRangesDisabled(value) {
  try {
    const rules = JSON.parse(value);
    return Array.isArray(rules) && rules.length === 0;
  } catch {
    return false;
  }
}

function validFacetTenantMap(value, expectedSourceTenantId) {
  try {
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(expectedSourceTenantId)) return false;
    const bindings = JSON.parse(value);
    if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) return false;
    const entries = Object.entries(bindings);
    const allowedBrands = new Set(["ironwrap", "iroof"]);
    return entries.length === 1 && entries.every(([sourceTenantId, binding]) => {
      if (sourceTenantId !== expectedSourceTenantId || !binding ||
          typeof binding !== "object" || Array.isArray(binding)) return false;
      const keys = Object.keys(binding).sort();
      if (keys.length !== 2 || keys[0] !== "brand_ids" || keys[1] !== "tenant_id" ||
          binding.tenant_id !== "ironwrap" || !Array.isArray(binding.brand_ids) ||
          binding.brand_ids.length < 1 || binding.brand_ids.length > allowedBrands.size) return false;
      const brandIds = new Set(binding.brand_ids);
      return brandIds.size === binding.brand_ids.length &&
        [...brandIds].every((brandId) => typeof brandId === "string" && allowedBrands.has(brandId));
    });
  } catch {
    return false;
  }
}

function validImageDigestRef(value) {
  return typeof value === "string" &&
    /^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$/.test(value) &&
    !value.includes("//") &&
    !value.includes("..") &&
    !/:latest@/.test(value);
}

function validDomain(value) {
  if (isPlaceholder(value) || value.length > 253 || value !== value.toLowerCase()) return false;
  const labels = value.split(".");
  return labels.length >= 2 && labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function validRestorePrefix(value, sourceSite) {
  if (typeof value !== "string" || typeof sourceSite !== "string") return false;
  if (value.startsWith("/") || value.endsWith("/") || value.includes("..") || value.includes("//")) return false;
  const separator = value.indexOf("/");
  return separator > 0 && value.indexOf("/", separator + 1) === -1 && value.slice(0, separator) === sourceSite &&
    /^\d{8}T\d{6}Z-\d+-\d+$/.test(value.slice(separator + 1));
}

function validIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function validMinimumNodeVersion(value) {
  const match = typeof value === "string" && value.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 22 || (major === 22 && (minor > 12 || (minor === 12 && patch >= 0)));
}

function hostnameOf(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function validSecret(env, name, minimumLength) {
  const value = env[name];
  return typeof value === "string" && !isPlaceholder(value) && value.length >= minimumLength && !/[\r\n]/.test(value);
}

async function loadLock(repoRoot) {
  const text = await readText(repoRoot, "deploy/runtime-lock.json");
  if (text === null) return { text: null, value: null };
  try {
    return { text, value: JSON.parse(text) };
  } catch {
    return { text, value: null };
  }
}

/**
 * Evaluate every registry capability against the deployed reference configuration.
 *
 * Only `wrangler.jsonc`'s top-level `vars` -- the production block -- is read. Secrets are opaque
 * on purpose: this verifier must never report a secret-backed capability as ready from a file that
 * cannot contain the secret, and G1.3 listed "whether any Worker secret is actually set" as one of
 * the four unknowns that need a named-environment readback rather than another assumption.
 */
/** One top-level (production) Worker var from the committed wrangler.jsonc, or null. */
async function committedProductionVar(repoRoot, name) {
  const source = await readText(repoRoot, "workers-bus/wrangler.jsonc");
  try {
    const vars = flattenWranglerVars(JSON.parse(stripJsonComments(source ?? ""))?.vars ?? {});
    const value = vars[name];
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function evaluateReferenceCapabilities(wranglerSource) {
  let vars;
  try {
    const rawVars = JSON.parse(stripJsonComments(wranglerSource))?.vars;
    if (!rawVars || typeof rawVars !== "object" || Array.isArray(rawVars)) {
      return { ok: false, error: "workers-bus/wrangler.jsonc has no top-level vars block", signals: null };
    }
    vars = flattenWranglerVars(rawVars);
  } catch {
    return { ok: false, error: "workers-bus/wrangler.jsonc is not parseable", signals: null };
  }
  return {
    ok: true,
    error: null,
    signals: evaluateCapabilitySignals({
      read: (name) => (typeof vars[name] === "string" ? vars[name] : undefined),
      opaque: capabilitySecretBindings(),
    }),
  };
}

export async function validateContract({ repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const checks = [];
  const contents = new Map();

  for (const relative of REQUIRED_DEPLOY_FILES) {
    const text = await readText(repoRoot, relative);
    contents.set(relative, text);
    checks.push(check(`contract.file.${relative}`, text !== null && text.length > 0, `${relative} is present`, `${relative} is missing or empty`));
  }

  const lockState = await loadLock(repoRoot);
  const lock = lockState.value;
  checks.push(check("contract.lock.json", lock !== null, "runtime lock is valid JSON", "runtime lock is missing or invalid JSON"));
  if (lock) {
    checks.push(check("contract.lock.schema", lock.schema_version === 1, "runtime lock schema is supported", "runtime lock schema must equal 1"));
    checks.push(check("contract.lock.date", validIsoDate(lock.locked_at), "runtime lock carries an ISO lock date", "runtime lock must carry a valid ISO lock date"));
    checks.push(check("contract.lock.frappe_only", lock.policy?.architecture === "d1-worker" && lock.policy?.erpnext === "forbidden", "runtime policy is D1/Worker and forbids ERPNext", "runtime policy must be D1/Worker and forbid ERPNext"));
    checks.push(check("contract.lock.no_floating", lock.policy?.floating_references === "forbidden", "floating runtime references are forbidden", "runtime policy must forbid floating references"));

    const componentNames = Object.keys(lock.components ?? {}).sort();
    checks.push(check("contract.lock.components", JSON.stringify(componentNames) === JSON.stringify(["frappe", "frappe_docker", "hermes"]), "runtime lock contains exactly Frappe, frappe_docker, and Hermes", "runtime lock has a missing, extra, or forbidden component"));
    for (const [name, source] of Object.entries(EXPECTED_SOURCES)) {
      const component = lock.components?.[name];
      const version = component?.version;
      checks.push(check(`contract.lock.${name}.source`, component?.source === source, `${name} uses its canonical source`, `${name} source is not canonical`));
      checks.push(check(`contract.lock.${name}.version`, typeof version === "string" && /^v\d+(?:\.\d+){2,3}$/.test(version) && !/latest|main|master|develop/i.test(version), `${name} uses an immutable release tag`, `${name} version must be an immutable release tag`));
      checks.push(check(`contract.lock.${name}.commit`, /^[0-9a-f]{40}$/.test(component?.git_commit ?? ""), `${name} has an exact git commit`, `${name} must have a lowercase 40-character git commit`));
    }
    checks.push(check("contract.lock.frappe_major", /^v15\./.test(lock.components?.frappe?.version ?? ""), "Frappe is locked to the supported v15 line", "Frappe must remain on the supported v15 line"));

    const containerBaseNames = Object.keys(lock.container_bases ?? {}).sort();
    checks.push(check("contract.lock.image.keys", JSON.stringify(containerBaseNames) === JSON.stringify(["frappe_base", "frappe_build"]), "runtime lock contains exactly the Frappe build and base images", "runtime lock has a missing, extra, or forbidden container image"));
    for (const name of ["frappe_build", "frappe_base"]) {
      const image = lock.container_bases?.[name];
      const repository = name === "frappe_build" ? "build" : "base";
      checks.push(check(`contract.lock.image.${name}`, typeof image === "string" && new RegExp(`^docker\\.io/frappe/${repository}:version-15@sha256:[0-9a-f]{64}$`).test(image), `${name} is digest pinned`, `${name} must be the matching version-15 image pinned by sha256 digest`));
    }
    const host = lock.host_requirements ?? {};
    const integerAtLeast = (value, minimum) => Number.isInteger(value) && value >= minimum;
    checks.push(check("contract.lock.host", host.ubuntu_minimum === "22.04" && integerAtLeast(host.cpu_cores_minimum, 2) && integerAtLeast(host.memory_gib_minimum, 8) && integerAtLeast(host.disk_gib_minimum, 80) && validMinimumNodeVersion(host.node_version_minimum) && JSON.stringify([...(host.architectures ?? [])].sort()) === JSON.stringify(["x86_64"]), "host minimums are production-safe and complete", "host minimums are incomplete, malformed, or below the production floor"));
  }

  const containerfile = contents.get("deploy/Containerfile.frappe") ?? "";
  const buildImage = lock?.container_bases?.frappe_build ?? "__missing__";
  const baseImage = lock?.container_bases?.frappe_base ?? "__missing__";
  const frappeVersion = lock?.components?.frappe?.version ?? "__missing__";
  const frappeCommit = lock?.components?.frappe?.git_commit ?? "__missing__";
  checks.push(check("contract.container.pins", containerfile.includes(`FROM ${buildImage} AS builder`) && containerfile.includes(`FROM ${baseImage} AS backend`) && containerfile.includes(`--frappe-branch=${frappeVersion}`) && containerfile.includes(frappeCommit), "Containerfile consumes locked Frappe sources and image digests", "Containerfile does not consume every locked Frappe source and image digest"));
  checks.push(check("contract.container.non_overridable", !/^ARG\s+FRAPPE_/m.test(containerfile) && !/FROM\s+\$\{/.test(containerfile), "locked Frappe sources cannot be overridden with build arguments", "locked Frappe sources or images must not be overridable build arguments"));
  checks.push(check("contract.container.secrets", /mount=type=secret,id=apps_json/.test(containerfile) && !/APPS_JSON_BASE64|ARG\s+.*(?:TOKEN|SECRET|PASSWORD)/i.test(containerfile), "Containerfile uses secret mounts instead of secret build args", "Containerfile must not carry secrets in build arguments"));
  checks.push(check("contract.container.app_commit", containerfile.includes("IRONWRAP_APP_COMMIT") && containerfile.includes("git -C apps/ironwrap_roofing rev-parse HEAD"), "Containerfile verifies the proprietary app commit", "Containerfile must verify the proprietary app commit"));
  checks.push(check("contract.container.no_erpnext", !/(?:bench\s+(?:get-app|install-app)|FROM\s+[^\n]*|git\s+clone[^\n]*|COPY\s+[^\n]*)erpnext/i.test(containerfile) && containerfile.includes("test ! -e apps/erpnext"), "Containerfile excludes and explicitly rejects ERPNext", "Containerfile can install, inherit, or silently include ERPNext"));

  const appsText = contents.get("deploy/apps.example.json") ?? "";
  let apps = null;
  try { apps = JSON.parse(appsText); } catch { /* reported below */ }
  checks.push(check("contract.apps.json", Array.isArray(apps) && apps.length === 1, "apps template contains exactly the IronWrap app", "apps template must be valid JSON with exactly one app"));
  if (Array.isArray(apps) && apps.length === 1) {
    const app = apps[0] ?? {};
    let credentialFreeUrl = false;
    try {
      const parsed = new URL(app.url);
      credentialFreeUrl = parsed.href === "https://github.com/ironwrap/ironwrap_roofing.git" && !parsed.username && !parsed.password;
    } catch { /* fail below */ }
    checks.push(check("contract.apps.url", credentialFreeUrl, "app source URL is HTTPS and credential-free", "app source URL must be HTTPS, credential-free, and target ironwrap_roofing"));
    checks.push(check("contract.apps.release", app.branch === "<IRONWRAP_APP_RELEASE_TAG>", "app template requires an explicit release tag", "app template must require IRONWRAP_APP_RELEASE_TAG instead of a floating branch"));
    checks.push(check("contract.apps.shape", JSON.stringify(Object.keys(app).sort()) === JSON.stringify(["branch", "url"]), "app template exposes only source and release fields", "app template contains unexpected dependency or configuration fields"));
    checks.push(check("contract.apps.no_erpnext", !/erpnext/i.test(JSON.stringify(apps)), "apps template excludes ERPNext", "apps template must exclude ERPNext"));
  }

  const envText = contents.get("deploy/env.example") ?? "";
  const envTemplate = parseEnvTemplate(envText);
  checks.push(check("contract.env.duplicates", envTemplate.duplicates.size === 0, "environment template has no duplicate keys", "environment template has duplicate keys"));
  for (const name of REQUIRED_ENV_NAMES) {
    checks.push(check(`contract.env.${name}`, envTemplate.values.has(name), `${name} is declared`, `${name} is missing from deploy/env.example`));
  }
  for (const name of SECRET_ENV_NAMES) {
    const value = envTemplate.values.get(name) ?? "";
    checks.push(check(`contract.env.secret.${name}`, /^<[^>]+>$/.test(value), `${name} is represented by a name-only placeholder`, `${name} must not contain a committed secret value`));
  }
  checks.push(check(
    "contract.env.launch_proof_reader",
    envText.includes("ironwrap_launch_proof_reader_user") &&
      envText.includes("IronWrap Launch Proof Reader"),
    "launch-proof reader provisioning is documented",
    "deploy/env.example must document the exact Frappe launch-proof reader config and role",
  ));
  checks.push(check("contract.env.secret.no_generic_cloudflare", !envTemplate.values.has("CLOUDFLARE_API_TOKEN"), "environment inventory has no reusable generic Cloudflare API token", "CLOUDFLARE_API_TOKEN must be split into D1_BACKUP_API_TOKEN and ephemeral D1_RESTORE_API_TOKEN"));
  const releaseEnvText = contents.get("deploy/release.env.example") ?? "";
  const releaseEnvTemplate = parseEnvTemplate(releaseEnvText);
  checks.push(check("contract.release_env.duplicates", releaseEnvTemplate.duplicates.size === 0, "release environment template has no duplicate keys", "release environment template has duplicate keys"));
  for (const name of RELEASE_AUTOMATION_ENV_NAMES) {
    const value = releaseEnvTemplate.values.get(name) ?? "";
    checks.push(check(`contract.release_env.${name}`, /^<[^>]+>$/.test(value), `${name} is declared as a name-only release placeholder`, `${name} is missing or contains a committed release value`));
  }
  const d1SourceTemplate = {
    D1_PRODUCTION_ACCOUNT_ID: "7ee5775bc1ba46f05c5a65235b60e939",
    D1_PRODUCTION_DATABASE_NAME: "ironwrap-bus",
    D1_PRODUCTION_DATABASE_ID: "f0674848-13df-4422-9896-8ba2719663b8",
    D1_RESTORE_TARGET_ACCOUNT_ID: "7ee5775bc1ba46f05c5a65235b60e939",
  };
  for (const [name, expected] of Object.entries(d1SourceTemplate)) {
    checks.push(check(`contract.env.d1.${name}`, envTemplate.values.get(name) === expected, `${name} is pinned to the committed Cloudflare resource`, `${name} must match the committed Cloudflare account/database coordinate`));
  }
  if (lock) {
    const exactTemplateValues = {
      FRAPPE_VERSION: lock.components?.frappe?.version,
      FRAPPE_COMMIT: lock.components?.frappe?.git_commit,
      FRAPPE_DOCKER_VERSION: lock.components?.frappe_docker?.version,
      FRAPPE_DOCKER_COMMIT: lock.components?.frappe_docker?.git_commit,
      HERMES_VERSION: lock.components?.hermes?.version,
      HERMES_COMMIT: lock.components?.hermes?.git_commit,
    };
    for (const [name, expected] of Object.entries(exactTemplateValues)) {
      checks.push(check(`contract.env.pin.${name}`, envTemplate.values.get(name) === expected, `${name} matches the runtime lock`, `${name} does not match the runtime lock`));
    }
  }

  const cloudflared = contents.get("deploy/cloudflared-config.example.yml") ?? "";
  checks.push(check("contract.tunnel.fallback", /- service:\s*http_status:404\s*$/m.test(cloudflared), "Tunnel template has a fail-closed 404 fallback", "Tunnel template must end with an HTTP 404 fallback"));
  checks.push(check("contract.tunnel.local_origin", /service:\s*http:\/\/(?:127\.0\.0\.1|localhost):8080/.test(cloudflared), "Tunnel origin stays on the local host", "Tunnel origin must target localhost port 8080"));
  const approvalBrokerService = contents.get("deploy/approval-broker.service.example") ?? "";
  checks.push(check("contract.approval_broker.service", approvalBrokerService.includes("User=ironwrap-broker") && approvalBrokerService.includes("EnvironmentFile=/etc/ironwrap/approval-broker.env") && approvalBrokerService.includes("approval-broker.mjs") && approvalBrokerService.includes("NoNewPrivileges=true") && approvalBrokerService.includes("ProtectSystem=strict") && approvalBrokerService.includes("UMask=0077"), "approval broker service is least-privilege and environment-file scoped", "approval broker service must run under a dedicated account with no-new-privileges, strict filesystem protection, and a root-owned environment file"));
  const quoteRevisionApprovalBrokerService = contents.get("deploy/quote-revision-approval-broker.service.example") ?? "";
  checks.push(check("contract.quote_revision_approval_broker.service", quoteRevisionApprovalBrokerService.includes("User=ironwrap-broker") && quoteRevisionApprovalBrokerService.includes("EnvironmentFile=/etc/ironwrap/quote-revision-approval-broker.env") && quoteRevisionApprovalBrokerService.includes("quote-revision-approval-broker.mjs") && !quoteRevisionApprovalBrokerService.includes("EnvironmentFile=/etc/ironwrap/approval-broker.env") && !quoteRevisionApprovalBrokerService.includes("ExecStart=/usr/bin/node /srv/ironwrap/mcp/erpnext-roofing-mcp/src/approval-broker.mjs") && quoteRevisionApprovalBrokerService.includes("NoNewPrivileges=true") && quoteRevisionApprovalBrokerService.includes("ProtectSystem=strict") && quoteRevisionApprovalBrokerService.includes("UMask=0077"), "quote-revision approval broker has an isolated least-privilege process and environment file", "quote-revision approval broker must stay a distinct least-privilege process with its own environment file and command"));
  const productionScheduleApprovalBrokerService = contents.get("deploy/production-schedule-approval-broker.service.example") ?? "";
  checks.push(check("contract.production_schedule_approval_broker.service", productionScheduleApprovalBrokerService.includes("User=ironwrap-broker") && productionScheduleApprovalBrokerService.includes("EnvironmentFile=/etc/ironwrap/production-schedule-approval-broker.env") && productionScheduleApprovalBrokerService.includes("production-schedule-approval-broker.mjs") && !productionScheduleApprovalBrokerService.includes("ExecStart=/usr/bin/node /srv/ironwrap/mcp/erpnext-roofing-mcp/src/approval-broker.mjs") && productionScheduleApprovalBrokerService.includes("NoNewPrivileges=true") && productionScheduleApprovalBrokerService.includes("ProtectSystem=strict") && productionScheduleApprovalBrokerService.includes("UMask=0077"), "production-schedule approval broker has an isolated least-privilege process and environment file", "production-schedule approval broker must stay a distinct least-privilege process with its own environment file and command"));

  const approvalBrokerEnv = privateBrokerEnvTemplate(contents.get("deploy/approval-broker.env.example") ?? "", {
    role: "lead-concierge",
    actor: "lead-concierge@ironwrapexteriors.com",
    publicKeyPath: "/run/secrets/hermes-approval-public.pem",
    privateKeyPath: "/run/secrets/hermes-approval-private.pem",
    prefix: "APPROVAL_BROKER",
    keyId: "approval-v1",
    port: "8788",
  });
  const quoteRevisionBrokerEnv = privateBrokerEnvTemplate(contents.get("deploy/quote-revision-approval-broker.env.example") ?? "", {
    role: "estimator-assistant",
    actor: "estimator@ironwrapexteriors.com",
    publicKeyPath: "/run/secrets/hermes-approval-public.pem",
    privateKeyPath: "/run/secrets/hermes-approval-private.pem",
    prefix: "QUOTE_REVISION_BROKER",
    keyId: "quote-revision-v1",
    port: "8789",
  });
  const productionScheduleBrokerEnv = privateBrokerEnvTemplate(contents.get("deploy/production-schedule-approval-broker.env.example") ?? "", {
    role: "production-controller",
    actor: "production-controller@ironwrapexteriors.com",
    publicKeyPath: "/run/secrets/hermes-production-schedule-approval-public.pem",
    privateKeyPath: "/run/secrets/hermes-production-schedule-approval-private.pem",
    prefix: "PRODUCTION_SCHEDULE_BROKER",
    keyId: "production-schedule-v1",
    port: "8790",
  });
  checks.push(check("contract.approval_broker.env", approvalBrokerEnv.ok, "lead-triage broker environment is complete and placeholder-only", "lead-triage broker environment must be complete, role-bound, and placeholder-only"));
  checks.push(check("contract.quote_revision_approval_broker.env", quoteRevisionBrokerEnv.ok, "quote-revision broker environment is complete and placeholder-only", "quote-revision broker environment must be complete, role-bound, and placeholder-only"));
  checks.push(check("contract.production_schedule_approval_broker.env", productionScheduleBrokerEnv.ok, "production-schedule broker environment is complete and placeholder-only", "production-schedule broker environment must be complete, role-bound, and placeholder-only"));
  checks.push(check(
    "contract.approval_brokers.isolation",
    new Set([
      approvalBrokerEnv.values.get("APPROVAL_BROKER_KEY_ID"),
      quoteRevisionBrokerEnv.values.get("QUOTE_REVISION_BROKER_KEY_ID"),
      productionScheduleBrokerEnv.values.get("PRODUCTION_SCHEDULE_BROKER_KEY_ID"),
    ]).size === 3 && new Set([
      approvalBrokerEnv.values.get("APPROVAL_BROKER_PORT"),
      quoteRevisionBrokerEnv.values.get("QUOTE_REVISION_BROKER_PORT"),
      productionScheduleBrokerEnv.values.get("PRODUCTION_SCHEDULE_BROKER_PORT"),
    ]).size === 3,
    "approval broker templates use distinct key IDs and loopback ports",
    "approval broker templates must keep their key IDs and loopback ports distinct",
  ));

  const backup = contents.get("deploy/backup-to-r2.sh") ?? "";
  checks.push(check("contract.backup.safety", backup.includes("set -euo pipefail") && backup.includes("set +x") && backup.includes("umask 077") && backup.includes("this command accepts no arguments") && backup.includes("mktemp -d") && backup.includes("trap cleanup EXIT") && backup.includes("flock -n"), "backup script uses fail-closed input, temporary-file, and concurrency controls", "backup script lacks fail-closed input, temporary-file, or concurrency controls"));
  checks.push(check("contract.backup.encryption", backup.includes("age --encrypt") && backup.includes("BACKUP_AGE_RECIPIENT"), "backup script encrypts before upload", "backup script must encrypt before upload"));
  checks.push(check("contract.backup.verification", backup.includes("rclone check") && backup.indexOf("rclone check") < backup.indexOf("rclone delete"), "backup upload verifies before retention deletion", "backup upload must verify before retention deletion"));
  checks.push(check("contract.backup.atomic", backup.includes("IRONWRAP-BACKUP-COMPLETE") && backup.indexOf("rclone check") < backup.indexOf("rclone copyto") && backup.includes("remote_complete=1"), "backup publishes a completion marker only after verification", "backup must publish an atomic completion marker after verification"));
  checks.push(check("contract.backup.retention_atomic", backup.includes("MARKER_RETENTION_HOURS") && backup.includes("DATA_RETENTION_HOURS=$((MARKER_RETENTION_HOURS + 1))") && backup.indexOf("**/IRONWRAP-BACKUP-COMPLETE") < backup.indexOf("**/*.age"), "retention hides completion markers before deleting encrypted data", "retention must remove completion markers before encrypted data with a safety window"));
  checks.push(check("contract.backup.cleanup", backup.includes("remote_started == 1 && remote_complete == 0") && backup.includes("rclone purge") && /trap 'exit 1(?:29|30|43)' (?:HUP|INT|TERM)/.test(backup), "failed and interrupted uploads clean incomplete remote prefixes", "backup must clean incomplete remote prefixes on failure and signals"));
  checks.push(check("contract.backup.restore", backup.includes("format=frappe-v15-bench-backup") && backup.includes("database_file=") && backup.includes("site_config_file=") && backup.includes("public_files_file=") && backup.includes("private_files_file=") && backup.includes("image=%s") && backup.includes("IRONWRAP_OS_IMAGE"), "encrypted archive carries a complete restore manifest and image digest", "backup archive must identify every restore artifact and the deployed image digest"));

  const restore = contents.get("deploy/restore-from-r2.sh") ?? "";
  checks.push(check("contract.restore.safety", restore.includes("set -euo pipefail") && restore.includes("set +x") && restore.includes("umask 077") && restore.includes('mode="verify"') && restore.includes("only the fixed --verify or --restore mode flag is accepted") && restore.includes("mktemp -d") && restore.includes("trap cleanup EXIT") && restore.includes("flock -n"), "restore defaults to verification and uses strict input, temporary-file, cleanup, and concurrency controls", "restore must default to verification and fail closed around input, plaintext, signals, and concurrency"));
  checks.push(check("contract.restore.selection", restore.includes("RESTORE_R2_COMPLETED_PREFIX") && restore.includes("IRONWRAP-BACKUP-COMPLETE") && !/rclone\s+ls[fdj]?\b/.test(restore), "restore requires one explicit completion-marker prefix without latest-backup discovery", "restore must require one explicit completed prefix and never discover latest"));
  checks.push(check("contract.restore.crypto_order", restore.includes("sha256sum --check") && restore.includes("age --decrypt") && restore.indexOf("sha256sum --check") < restore.indexOf("age --decrypt"), "restore verifies the downloaded ciphertext checksum before decryption", "restore must verify ciphertext before decrypting it"));
  checks.push(check("contract.restore.package", restore.includes("archive contains traversal, duplicate, or unsafe paths") && restore.includes("archive links, directories, and non-regular entries are forbidden") && restore.includes("restore manifest contains an unexpected field") && restore.includes("manifest_image") && restore.includes("manifest_site"), "restore rejects unsafe archive objects, unexpected files, and manifest site/image mismatches", "restore package validation must reject traversal, links, unexpected files, and manifest mismatches"));
  checks.push(check("contract.restore.isolation", restore.includes("com.ironwrap.restore-target") && restore.includes('RESTORE:$RESTORE_TARGET_SITE@$RESTORE_TARGET_CONTAINER') && restore.includes('RESTORE_TARGET_SITE" == "$FRAPPE_SITE') && restore.includes('RESTORE_TARGET_CONTAINER" == "$BACKEND_CONTAINER') && restore.includes('source_db_name" == "$target_db_name') && restore.includes('docker network inspect') && restore.includes('docker port') && restore.includes('root_password') && restore.includes('root-ready'), "restore requires a labelled, target-confirmed, internal-network, unexposed, database-isolated target with non-interactive target-only authority", "restore must enforce a labelled, target-bound, internal-network, unexposed, database-isolated target with safe non-interactive authority"));
  checks.push(check("contract.restore.execution", restore.includes('IRONWRAP-RESTORE-ENCRYPTION-KEY.json') && restore.includes('for filename in "$database_file" "$public_files_file" "$private_files_file" "$(basename "$sanitized_key_file")"') && !/docker cp[^\n]*site_config_backup/.test(restore) && restore.includes('json.dumps({"encryption_key":key}') && restore.includes('json.dumps({**current,"encryption_key":key}') && restore.includes('bench --site "$RESTORE_TARGET_SITE" restore') && restore.includes('bench --site "$RESTORE_TARGET_SITE" migrate'), "restore sends only backup artifacts plus a sanitized encryption key, preserves target-owned configuration, and migrates", "restore must exclude the source site configuration, merge only its encryption key into target-owned configuration, and run bench restore plus migrate"));
  checks.push(check("contract.restore.cleanup", restore.includes('docker exec "$RESTORE_TARGET_CONTAINER" rm -rf') && restore.includes('rm -rf -- "$WORK_DIR"') && /trap 'exit 1(?:29|30|43)' (?:HUP|INT|TERM)/.test(restore), "restore cleans host and container plaintext on exit and signals", "restore must clean every plaintext staging location on success, failure, and signals"));

  const d1Backup = contents.get("deploy/backup-d1-to-r2.sh") ?? "";
  const d1Restore = contents.get("deploy/restore-d1-from-r2.sh") ?? "";
  const migrationInventory = await d1MigrationInventory(repoRoot);
  const backupTables = shellCsvAssignment(d1Backup, "REQUIRED_TABLES");
  const restoreTables = shellCsvAssignment(d1Restore, "REQUIRED_TABLES");
  const backupIndexes = shellCsvAssignment(d1Backup, "REQUIRED_INDEX_BINDINGS");
  const restoreIndexes = shellCsvAssignment(d1Restore, "REQUIRED_INDEX_BINDINGS");
  const backupTriggers = shellCsvAssignment(d1Backup, "REQUIRED_TRIGGER_BINDINGS");
  const restoreTriggers = shellCsvAssignment(d1Restore, "REQUIRED_TRIGGER_BINDINGS");
  const migrationTableCount = migrationInventory.tables.length;
  const migrationIndexCount = migrationInventory.indexBindings.length;
  const migrationTriggerCount = migrationInventory.triggerBindings.length;
  const migrationSchemaSummary = `${migrationTableCount} migration-defined tables, ${migrationIndexCount} indexes, and ${migrationTriggerCount} triggers`;
  checks.push(check(
    "contract.d1.schema_inventory",
    migrationInventory.ok &&
      backupTables.length === shellIntegerAssignment(d1Backup, "REQUIRED_TABLE_COUNT") &&
      restoreTables.length === shellIntegerAssignment(d1Restore, "REQUIRED_TABLE_COUNT") &&
      backupIndexes.length === shellIntegerAssignment(d1Backup, "REQUIRED_INDEX_COUNT") &&
      restoreIndexes.length === shellIntegerAssignment(d1Restore, "REQUIRED_INDEX_COUNT") &&
      backupTriggers.length === shellIntegerAssignment(d1Backup, "REQUIRED_TRIGGER_COUNT") &&
      restoreTriggers.length === shellIntegerAssignment(d1Restore, "REQUIRED_TRIGGER_COUNT") &&
      JSON.stringify(backupTables) === JSON.stringify(migrationInventory.tables) &&
      JSON.stringify(restoreTables) === JSON.stringify(migrationInventory.tables) &&
      JSON.stringify(backupIndexes) === JSON.stringify(migrationInventory.indexBindings) &&
      JSON.stringify(restoreIndexes) === JSON.stringify(migrationInventory.indexBindings) &&
      JSON.stringify(backupTriggers) === JSON.stringify(migrationInventory.triggerBindings) &&
      JSON.stringify(restoreTriggers) === JSON.stringify(migrationInventory.triggerBindings),
    `D1 backup and restore inventories match all ${migrationSchemaSummary}`,
    "D1 backup and restore inventories must exactly match the migration-defined table, index, and trigger schema",
  ));
  checks.push(check("contract.d1_backup.safety", d1Backup.includes("set -euo pipefail") && d1Backup.includes("set +x") && d1Backup.includes("umask 077") && d1Backup.includes("this command accepts no arguments") && d1Backup.includes("mktemp -d") && d1Backup.includes("flock -n") && /trap 'exit 1(?:29|30|43)' (?:HUP|INT|TERM)/.test(d1Backup), "D1 backup uses strict no-argv, no-tracing, private-temp, locking, and signal controls", "D1 backup lacks strict no-argv, no-tracing, private-temp, locking, or signal controls"));
  checks.push(check("contract.d1_backup.source", d1Backup.includes('EXPECTED_ACCOUNT_ID="7ee5775bc1ba46f05c5a65235b60e939"') && d1Backup.includes('EXPECTED_DATABASE_NAME="ironwrap-bus"') && d1Backup.includes('EXPECTED_DATABASE_ID="f0674848-13df-4422-9896-8ba2719663b8"') && d1Backup.includes('"account_id": "$D1_PRODUCTION_ACCOUNT_ID"') && d1Backup.includes('"database_id": "$D1_PRODUCTION_DATABASE_ID"'), "D1 backup is bound to the exact production account, name, UUID, and generated config", "D1 backup must bind an exact generated config to the committed production D1 coordinates"));
  checks.push(check("contract.d1_backup.wrangler", d1Backup.includes('workers-bus/node_modules/.bin/wrangler') && d1Backup.includes('workers-bus/package-lock.json') && d1Backup.includes('CLOUDFLARE_API_TOKEN="$d1_backup_api_token" "$WRANGLER" d1 export') && d1Backup.includes("--remote --config") && d1Backup.includes("exact Wrangler 4 version") && d1Backup.includes("unset CLOUDFLARE_API_TOKEN D1_BACKUP_API_TOKEN"), "D1 backup uses the locked local Wrangler 4 remote export with command-scoped read authority", "D1 backup must use exact Wrangler 4 and command-scope only the dedicated D1 backup token"));
  checks.push(check(
    "contract.d1_backup.validation",
    d1Backup.includes("sqlite3 -bail") && d1Backup.includes("PRAGMA integrity_check") &&
      d1Backup.includes("quickbooks_projection_outbox") && d1Backup.includes("facet_design_evidence_associations") &&
      d1Backup.includes("newo_reconciliation_runs") && d1Backup.includes("customer_portal_acceptance_events") &&
      d1Backup.includes("hermes_desktop_results") && d1Backup.includes(`REQUIRED_TABLE_COUNT=${migrationTableCount}`) &&
      d1Backup.includes(`REQUIRED_INDEX_COUNT=${migrationIndexCount}`) && d1Backup.includes(`REQUIRED_TRIGGER_COUNT=${migrationTriggerCount}`) &&
      d1Backup.includes("idx_app_users_tenant_access_role_active=app_users") &&
      d1Backup.includes("idx_measurement_intake_receipts_ocr_review=measurement_intake_receipts") &&
      d1Backup.includes("idx_dead_letter_open_measurement=dead_letter") &&
      d1Backup.includes("hermes_desktop_results_append_only_update=hermes_desktop_results") &&
      d1Backup.includes("measurement_deltas_append_only_update=measurement_deltas") &&
      d1Backup.includes("REQUIRED_MEASUREMENT_INDEX_SEMANTICS=") &&
      d1Backup.includes("REQUIRED_MEASUREMENT_TRIGGER_SEMANTICS=") &&
      d1Backup.includes("verify_measurement_index_semantics") &&
      d1Backup.includes("REQUIRED_ROLE_OCR_TABLE_SEMANTICS=") &&
      d1Backup.includes("REQUIRED_ACCESS_ROLE_TRIGGER_SEMANTICS=") &&
      d1Backup.includes("actor.access_rolein('owner','ops')") &&
      d1Backup.includes("active = 1 AND access_role IS NULL") &&
      d1Backup.includes("verify_role_and_ocr_semantics") &&
      d1Backup.includes("prevent_production_schedule_approval_binding_rewrite=production_schedule_approval_requests") &&
      d1Backup.includes("renew_approval_execution_lease_from_governed_outbox_claim=governed_transition_outbox") &&
      d1Backup.includes("REQUIRED_APPROVAL_TRIGGER_SEMANTICS=") && d1Backup.includes("REQUIRED_HERMES_TABLE_SEMANTICS=") &&
      d1Backup.includes("REQUIRED_HERMES_INDEX_SEMANTICS=") && d1Backup.includes("REQUIRED_HERMES_TRIGGER_SEMANTICS=") &&
      d1Backup.includes("verify_hermes_semantics") && d1Backup.includes("type='index'") && d1Backup.includes("type='trigger'") &&
      d1Backup.includes("IRONWRAP-D1-BACKUP-MANIFEST.txt") && d1Backup.includes("sql_sha256=") &&
      d1Backup.includes("required_indexes=") && d1Backup.includes("required_triggers="),
    `D1 backup proves all ${migrationSchemaSummary}, Hermes, access-role, and measurement-evidence semantics, and a hashed manifest`,
    `D1 backup must validate all ${migrationSchemaSummary} before encryption`,
  ));
  checks.push(check("contract.d1_backup.atomic", d1Backup.includes("age --encrypt") && d1Backup.includes("rclone copy") && d1Backup.includes("--immutable") && d1Backup.includes("rclone check") && d1Backup.includes("IRONWRAP-D1-BACKUP-COMPLETE") && d1Backup.indexOf("rclone check") < d1Backup.lastIndexOf("rclone copyto") && d1Backup.includes("remote_complete=1"), "D1 backup encrypts, uploads immutably, verifies, and commits its marker last", "D1 backup must encrypt and remotely verify immutable objects before publishing its completion marker"));
  checks.push(check("contract.d1_backup.retention", d1Backup.includes("MARKER_RETENTION_HOURS") && d1Backup.includes("DATA_RETENTION_HOURS=$((MARKER_RETENTION_HOURS + 1))") && d1Backup.indexOf("**/IRONWRAP-D1-BACKUP-COMPLETE") < d1Backup.indexOf("**/*.age") && d1Backup.includes("remote_started == 1 && remote_complete == 0") && d1Backup.includes("rclone purge"), "D1 retention hides markers before data and incomplete generations are purged", "D1 retention and incomplete-upload cleanup must preserve atomic visibility"));

  checks.push(check("contract.d1_restore.safety", d1Restore.includes("set -euo pipefail") && d1Restore.includes("set +x") && d1Restore.includes("umask 077") && d1Restore.includes("this command accepts no arguments") && d1Restore.includes('mode="${D1_RESTORE_MODE:-verify}"') && d1Restore.includes("mktemp -d") && d1Restore.includes("flock -n") && /trap 'exit 1(?:29|30|43)' (?:HUP|INT|TERM)/.test(d1Restore), "D1 restore defaults to local verification with strict no-argv, private-temp, lock, and signal controls", "D1 restore must default to verification and fail closed around argv, plaintext, concurrency, and signals"));
  checks.push(check("contract.d1_restore.selection", d1Restore.includes("D1_RESTORE_R2_COMPLETED_PREFIX") && d1Restore.includes("IRONWRAP-D1-BACKUP-COMPLETE") && !/rclone\s+ls[fdj]?\b/.test(d1Restore), "D1 restore requires one exact marker-bearing prefix and never discovers latest", "D1 restore must never discover latest or accept an uncommitted generation"));
  checks.push(check(
    "contract.d1_restore.local",
    d1Restore.includes("sha256sum --check") && d1Restore.includes("age --decrypt") &&
      d1Restore.indexOf("sha256sum --check") < d1Restore.indexOf("age --decrypt") &&
      d1Restore.includes("sqlite3 -bail") && d1Restore.includes("PRAGMA integrity_check") &&
      d1Restore.includes("quickbooks_projection_outbox") && d1Restore.includes("facet_design_evidence_associations") &&
      d1Restore.includes("newo_reconciliation_runs") && d1Restore.includes("customer_portal_acceptance_events") &&
      d1Restore.includes("hermes_desktop_results") && d1Restore.includes(`REQUIRED_TABLE_COUNT=${migrationTableCount}`) &&
      d1Restore.includes(`REQUIRED_INDEX_COUNT=${migrationIndexCount}`) && d1Restore.includes(`REQUIRED_TRIGGER_COUNT=${migrationTriggerCount}`) &&
      d1Restore.includes("idx_app_users_tenant_access_role_active=app_users") &&
      d1Restore.includes("idx_measurement_intake_receipts_ocr_review=measurement_intake_receipts") &&
      d1Restore.includes("idx_dead_letter_open_measurement=dead_letter") &&
      d1Restore.includes("hermes_desktop_results_append_only_update=hermes_desktop_results") &&
      d1Restore.includes("measurement_deltas_append_only_update=measurement_deltas") &&
      d1Restore.includes("REQUIRED_MEASUREMENT_INDEX_SEMANTICS=") &&
      d1Restore.includes("REQUIRED_MEASUREMENT_TRIGGER_SEMANTICS=") &&
      d1Restore.includes("verify_measurement_index_semantics") &&
      d1Restore.includes("REQUIRED_ROLE_OCR_TABLE_SEMANTICS=") &&
      d1Restore.includes("REQUIRED_ACCESS_ROLE_TRIGGER_SEMANTICS=") &&
      d1Restore.includes("actor.access_rolein('owner','ops')") &&
      d1Restore.includes("active = 1 AND access_role IS NULL") &&
      d1Restore.includes("verify_role_and_ocr_semantics") &&
      d1Restore.includes("renew_approval_execution_lease_from_governed_outbox_claim=governed_transition_outbox") &&
      d1Restore.includes("local-index-inventory.txt") && d1Restore.includes("local-trigger-inventory.txt") &&
      d1Restore.includes("verify_receipt_trigger_semantics") && d1Restore.includes("verify_approval_trigger_semantics") &&
      d1Restore.includes("verify_hermes_semantics") && d1Restore.includes("required_indexes") &&
      d1Restore.includes("required_triggers") && d1Restore.includes("no remote mutation performed"),
    `D1 restore verifies all ${migrationSchemaSummary}, plus Hermes, access-role, and measurement-evidence semantics before remote mutation`,
    "D1 restore must verify ciphertext, manifest, SQL import, integrity, every migration-defined table, index, and trigger locally first",
  ));
  checks.push(check(
    "contract.d1_restore.remote",
    d1Restore.includes("ironwrap-restore-drill-") &&
      d1Restore.includes("production D1 database can never be a restore target") &&
      d1Restore.includes('RESTORE_D1:$D1_RESTORE_TARGET_DATABASE_NAME@$D1_RESTORE_TARGET_DATABASE_ID') &&
      d1Restore.includes('"database_id": "$D1_RESTORE_TARGET_DATABASE_ID"') &&
      d1Restore.includes("target must be an empty dedicated drill database") &&
      d1Restore.includes("local-table-counts.txt") && d1Restore.includes("target-index-verify.sql") &&
      d1Restore.includes("sql AS index_sql") && d1Restore.includes("target-trigger-verify.json") &&
      d1Restore.includes("run_trigger_verification_batch") &&
      d1Restore.includes("MAX_REMOTE_READ_COMMAND_LENGTH") &&
      d1Restore.includes("sql AS trigger_sql") && d1Restore.includes("immutableSemantics") &&
      d1Restore.includes("hermes_desktop_results_one_accepted_handoff") &&
      d1Restore.includes("idx_measurement_intake_receipts_ocr_review") &&
      d1Restore.includes("idx_dead_letter_open_measurement") &&
      d1Restore.includes("facet_design_evidence_associations_validate_insert") &&
      d1Restore.includes("actor.access_rolein('owner','ops')") &&
      d1Restore.includes("hermes_desktop_device_revocation_not_monotonic") &&
      d1Restore.includes("remote D1 restore table row counts differ") &&
      d1Restore.includes("remote D1 restore index inventory or immutable index semantics differ") &&
      d1Restore.includes("remote D1 restore trigger inventory or immutable trigger semantics differ") &&
      d1Restore.includes('CLOUDFLARE_API_TOKEN="$d1_restore_api_token" "$WRANGLER" d1 execute') &&
      d1Restore.includes('"$d1_backup_api_token" == "$d1_restore_api_token"') &&
      d1Restore.includes("unset CLOUDFLARE_API_TOKEN D1_BACKUP_API_TOKEN D1_RESTORE_API_TOKEN"),
    `remote D1 restore is exact-target-confirmed, empty-target-only, account-bound, production-denied, and equivalent for all ${migrationSchemaSummary}`,
    "remote D1 restore must reject unsafe targets, match all table counts, indexes, and trigger bindings, and use a distinct ephemeral write token",
  ));
  checks.push(check("contract.d1_restore.cleanup", d1Restore.includes('rm -rf -- "$WORK_DIR"') && /trap 'exit 1(?:29|30|43)' (?:HUP|INT|TERM)/.test(d1Restore), "D1 restore removes decrypted plaintext on success, failure, and signals", "D1 restore must clean decrypted plaintext in every exit path"));

  const buildScript = contents.get("deploy/build-production-image.sh") ?? "";
  const composeOverlay = contents.get("deploy/frappe-compose.override.yml") ?? "";
  const composeValidator = contents.get("deploy/validate-frappe-compose.sh") ?? "";
  const hostScript = contents.get("deploy/host-preflight.sh") ?? "";
  const splitAppRepo = contents.get("deploy/split-app-repo.sh") ?? "";
  checks.push(check("contract.scripts.strict", [buildScript, composeValidator, hostScript, splitAppRepo].every((script) => script.includes("set -euo pipefail") && script.includes("set +x")), "deployment scripts use strict mode with tracing disabled", "deployment scripts must use strict mode and disable tracing"));
  checks.push(check("contract.build.lock", buildScript.includes("deploy/runtime-lock.json") && buildScript.includes("Containerfile does not consume the exact non-overridable runtime lock") && buildScript.includes("status --porcelain=v1 --untracked-files=all"), "image build validates the complete lock and a pristine pinned context", "image build must validate the lock, Containerfile, and pinned context"));
  checks.push(check("contract.build.secrets", buildScript.includes("--secret \"id=apps_json,src=$APPS_JSON_FILE\"") && !/--build-arg\s+[^\n]*(?:TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(buildScript), "image build passes secret material only through BuildKit secret mounts", "image build must not pass secrets through arguments"));
  checks.push(check("contract.build.no_erpnext", buildScript.includes('architecture !== "d1-worker"') && buildScript.includes('erpnext !== "forbidden"') && buildScript.includes("/erpnext/i.test(JSON.stringify(apps))"), "image build fails closed unless lock and app set are D1/Worker without ERPNext", "image build does not enforce the D1/Worker no-ERPNext policy"));
  checks.push(check("contract.host.argv", hostScript.includes("no configuration values are accepted as arguments") && !/eval\s|printenv|\benv\b\s*$/m.test(hostScript), "host preflight refuses configuration in argv and does not dump the environment", "host preflight must refuse configuration arguments and avoid environment dumps"));
  checks.push(check("contract.host.lock", hostScript.includes("deploy/runtime-lock.json") && hostScript.includes('.policy.architecture == "d1-worker"') && hostScript.includes("CPU_MINIMUM") && hostScript.includes("NODE_VERSION_MINIMUM") && hostScript.includes("version_at_least"), "host preflight consumes the D1/Worker runtime lock", "host preflight must consume and validate runtime-lock host policy"));
  checks.push(check("contract.host.dependencies", hostScript.includes("cloudflared") && hostScript.includes("sqlite3") && hostScript.includes("tar"), "host preflight checks ingress and recovery dependencies", "host preflight must check cloudflared, sqlite3, and tar"));
  checks.push(check("contract.split_app_repo", splitAppRepo.includes('EXPECTED_APP_REPO_URL="https://github.com/ironwrap/ironwrap_roofing.git"') && splitAppRepo.includes("git check-ref-format --branch") && splitAppRepo.includes('git push "$APP_REPO_URL" "$BRANCH:main"') && !splitAppRepo.includes('pushed to $APP_REPO_URL'), "app split requires the canonical credential-free repository URL", "app split must reject credential-bearing or non-canonical repository URLs and avoid printing them"));
  const appProcessNames = ["configurator", "backend", "frontend", "websocket", "queue-short", "queue-long", "scheduler"];
  const overlayAppliesEveryImage = appProcessNames.every((name) => new RegExp("^  " + name + ":\\n    image: \\$\\{IRONWRAP_OS_IMAGE:\\?", "m").test(composeOverlay));
  const overlayAppliesEveryPlatform = appProcessNames.every((name) => new RegExp(`^  ${name}:\\n(?:    .+\\n)*?    platform: linux/amd64`, "m").test(composeOverlay));
  checks.push(check("contract.frappe_compose.overlay", overlayAppliesEveryImage && overlayAppliesEveryPlatform, "Frappe overlay pins every app process to the x86_64 IronWrap image", "Frappe overlay must replace configurator, backend, frontend, websocket, queues, and scheduler with the x86_64 IronWrap image"));
  checks.push(check("contract.frappe_compose.validation", composeValidator.includes("config --quiet") && composeValidator.includes("config --format json") && composeValidator.includes("overrides/compose.mariadb.yaml") && composeValidator.includes("overrides/compose.redis.yaml") && appProcessNames.every((name) => composeValidator.includes(`\"${name}\"`)), "compose validation renders the exact locked Frappe topology and every app process", "compose validation must render the locked base and overrides then verify every app process image"));

  for (const relative of ["deploy/backup-to-r2.sh", "deploy/restore-from-r2.sh", "deploy/backup-d1-to-r2.sh", "deploy/restore-d1-from-r2.sh", "deploy/build-production-image.sh", "deploy/validate-frappe-compose.sh", "deploy/host-preflight.sh", "deploy/split-app-repo.sh"]) {
    let executable = false;
    try { executable = Boolean((await stat(path.join(repoRoot, relative))).mode & 0o111); } catch { /* missing reported above */ }
    checks.push(check(`contract.executable.${relative}`, executable, `${relative} is executable`, `${relative} must be executable`));
  }

  const wranglerSource = await readText(repoRoot, "workers-bus/wrangler.jsonc");
  checks.push(check("contract.capability.wrangler", wranglerSource !== null && wranglerSource.length > 0, "workers-bus/wrangler.jsonc is present", "workers-bus/wrangler.jsonc is missing or empty"));

  // The registry must still name every capability spec 9.3 names, and the recorded table must
  // still cover every capability the registry carries. Either half going stale is how a capability
  // silently leaves the readiness contract, which is the exact gap G1.3 found.
  const registryIds = [...CAPABILITY_SIGNAL_IDS];
  const recordedIds = Object.keys(CAPABILITY_REFERENCE_STATE).sort();
  checks.push(check(
    "contract.capability.registry.named",
    NAMED_REFERENCE_CAPABILITY_IDS.every((id) => registryIds.includes(id)),
    "the capability registry names every capability spec 9.3 declares",
    "the capability registry must name every capability spec 9.3 declares",
  ));
  checks.push(check(
    "contract.capability.registry.recorded",
    JSON.stringify(recordedIds) === JSON.stringify([...registryIds].sort()),
    "every registry capability has a recorded reference state",
    "every registry capability must have a recorded reference state, and the recorded table must name no capability the registry does not",
  ));

  const referenceCapabilities = evaluateReferenceCapabilities(wranglerSource ?? "");
  checks.push(check("contract.capability.parse", referenceCapabilities.ok, "reference capability configuration is readable", referenceCapabilities.error ?? "reference capability configuration is unreadable"));
  for (const id of registryIds) {
    const observed = referenceCapabilities.signals?.[id];
    const recorded = CAPABILITY_REFERENCE_STATE[id];
    checks.push(check(
      `contract.capability.${id}.state`,
      observed !== undefined && observed.state === recorded,
      `${id} is ${recorded} in the reference configuration, as recorded`,
      `${id} is ${observed ? observed.state : "unreadable"} in the reference configuration but ${recorded} is recorded; record the change in tools/production-readiness.mjs, docs/CAPABILITY-MATRIX.md, and the AI-native configuration contract in the same commit`,
    ));
    // A flag that is neither "true" nor "false" nor absent reads as off to every gate in the
    // Worker while looking, to whoever set it, like it worked. It is never an acceptable state.
    checks.push(check(
      `contract.capability.${id}.flag`,
      observed !== undefined && observed.flag.state !== "invalid",
      `${id} declares a flag literal the Worker accepts`,
      `${CAPABILITY_SIGNAL_REGISTRY[id].flagBinding ?? id} must be exactly "true" or "false"`,
    ));
  }

  return finish("contract", checks);
}

export async function validateLiveEnv({
  env = process.env,
  repoRoot = DEFAULT_REPO_ROOT,
  statApprovalPublicKey = stat,
  readApprovalPublicKey = readFile,
  parseApprovalPublicKey = createPublicKey,
} = {}) {
  const checks = [];
  const contract = await validateContract({ repoRoot });
  checks.push(check("live.contract", contract.ok, "repository deployment contract passes", "repository deployment contract must pass before live environment validation"));
  if (!contract.ok) return finish("live-env", checks);
  const { value: lock } = await loadLock(repoRoot);
  checks.push(check("live.lock", lock !== null, "runtime lock is readable", "runtime lock is missing or invalid"));
  if (!lock) return finish("live-env", checks);

  for (const name of LIVE_REQUIRED_ENV_NAMES) {
    checks.push(check(`live.env.${name}`, typeof env[name] === "string" && !isPlaceholder(env[name]), `${name} is set and non-placeholder`, `${name} is missing or placeholder`));
  }

  const expectedPins = {
    FRAPPE_VERSION: lock.components?.frappe?.version,
    FRAPPE_COMMIT: lock.components?.frappe?.git_commit,
    FRAPPE_DOCKER_VERSION: lock.components?.frappe_docker?.version,
    FRAPPE_DOCKER_COMMIT: lock.components?.frappe_docker?.git_commit,
    HERMES_VERSION: lock.components?.hermes?.version,
    HERMES_COMMIT: lock.components?.hermes?.git_commit,
  };
  for (const [name, expected] of Object.entries(expectedPins)) {
    checks.push(check(`live.pin.${name}`, env[name] === expected, `${name} matches the runtime lock`, `${name} does not match the runtime lock`));
  }
  checks.push(check("live.pin.image", validImageDigestRef(env.IRONWRAP_OS_IMAGE), "IRONWRAP_OS_IMAGE is digest pinned", "IRONWRAP_OS_IMAGE must be a non-latest image pinned by sha256 digest"));

  for (const name of ["ERPNEXT_BASE_URL", "IRONWRAP_BUS_BASE_URL", "BUS_BASE_URL", "FRAPPE_BASE_URL"]) {
    checks.push(check(`live.url.${name}`, isHttpsProductionUrl(env[name]), `${name} is a credential-free production HTTPS URL`, `${name} must be a credential-free production HTTPS URL`));
  }
  checks.push(check("live.url.bus_consistency", env.BUS_BASE_URL === env.IRONWRAP_BUS_BASE_URL, "bus URLs are consistent", "BUS_BASE_URL and IRONWRAP_BUS_BASE_URL must match"));
  checks.push(check(
    "live.launch_proof.base_url_consistency",
    normalizedProductionUrl(env.FRAPPE_BASE_URL) === normalizedProductionUrl(env.ERPNEXT_BASE_URL),
    "launch-proof Frappe URL matches the configured Frappe site",
    "FRAPPE_BASE_URL must normalize to ERPNEXT_BASE_URL",
  ));
  checks.push(check("live.url.site_consistency", hostnameOf(env.ERPNEXT_BASE_URL) === env.FRAPPE_SITE, "Frappe base URL matches FRAPPE_SITE", "ERPNEXT_BASE_URL hostname and FRAPPE_SITE must match"));
  const frappeApprovalPublicKeyPath = env.IRONWRAP_HERMES_APPROVAL_PUBLIC_KEY_FILE ?? "";
  checks.push(check(
    "live.frappe.approval_public_key_path",
    validSafeAbsolutePath(frappeApprovalPublicKeyPath),
    "Frappe approval public-key path is absolute and safe",
    "IRONWRAP_HERMES_APPROVAL_PUBLIC_KEY_FILE must be an absolute safe path",
  ));
  const normalizedFrappeSiteUrl = normalizedProductionUrl(env.IRONWRAP_HERMES_SITE_BASE_URL);
  const normalizedErpNextUrl = normalizedProductionUrl(env.ERPNEXT_BASE_URL);
  checks.push(check(
    "live.frappe.site_base_url",
    normalizedFrappeSiteUrl !== null,
    "Frappe receipt site URL is a credential-free production HTTPS URL",
    "IRONWRAP_HERMES_SITE_BASE_URL must be a credential-free production HTTPS URL",
  ));
  checks.push(check(
    "live.frappe.site_base_url_consistency",
    normalizedFrappeSiteUrl !== null && normalizedFrappeSiteUrl === normalizedErpNextUrl,
    "Frappe receipt site URL matches ERPNEXT_BASE_URL",
    "IRONWRAP_HERMES_SITE_BASE_URL must normalize to ERPNEXT_BASE_URL",
  ));

  const publicEstimateEnabled = env.PUBLIC_ESTIMATE_ENABLED === "true";
  const facetDesignIngestEnabled = env.FACET_DESIGN_INGEST_ENABLED === "true";
  const facetProjectionEnabled = env.FACET_DESIGN_FRAPPE_PROJECTION_ENABLED === "true";
  const facetQuoteRevisionEnabled = env.APP_FACET_QUOTE_REVISION_PREPARE_ENABLED === "true";
  const secretMinimums = {
    ERPNEXT_API_KEY: 10,
    ERPNEXT_API_SECRET: 16,
    QB_WEBHOOK_TOKEN: 24,
    QB_RECONCILIATION_ISSUER_API_KEY: 10,
    QB_RECONCILIATION_ISSUER_API_SECRET: 16,
    FRAPPE_API_KEY: 10,
    FRAPPE_API_SECRET: 16,
    IRONWRAP_ADMIN_TOKEN: 24,
    EFFECT_RUNTIME_TOKEN: 32,
    IRONWRAP_EFFECT_RUNTIME_TOKEN: 32,
    HERMES_WRITE_TOKEN: 32,
    HERMES_DRY_RUN_SIGNING_KEY: 32,
    APPROVAL_BROKER_SHARED_SECRET: 32,
    INGEST_TOKEN: 24,
    ADMIN_TOKEN: 24,
    D1_BACKUP_API_TOKEN: 24,
    RCLONE_CONFIG_R2_ACCESS_KEY_ID: 16,
    RCLONE_CONFIG_R2_SECRET_ACCESS_KEY: 32,
    ...(facetDesignIngestEnabled ? {
      FACET_DESIGN_INGEST_HMAC_KEY: 32,
    } : {}),
    ...(facetProjectionEnabled ? {
      FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY: 32,
      FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_KEY: 10,
      FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_SECRET: 16,
    } : {}),
    ...(facetQuoteRevisionEnabled ? {
      QUOTE_REVISION_BROKER_SHARED_SECRET: 32,
    } : {}),
    ...(publicEstimateEnabled ? {
      PUBLIC_ESTIMATE_TURNSTILE_SECRET: 20,
      PUBLIC_ESTIMATE_RATE_LIMIT_PEPPER: 32,
    } : {}),
  };
  for (const [name, minimum] of Object.entries(secretMinimums)) {
    checks.push(check(`live.secret.${name}`, validSecret(env, name, minimum), `${name} is non-placeholder and meets the minimum length`, `${name} is missing, placeholder, malformed, or too short`));
  }
  checks.push(check("live.secret.admin_consistency", env.ADMIN_TOKEN === env.IRONWRAP_ADMIN_TOKEN, "admin token bindings are consistent", "ADMIN_TOKEN and IRONWRAP_ADMIN_TOKEN must reference the same secret"));
  checks.push(check("live.secret.effect_runtime_consistency", env.EFFECT_RUNTIME_TOKEN === env.IRONWRAP_EFFECT_RUNTIME_TOKEN, "effect-runtime token bindings are consistent", "EFFECT_RUNTIME_TOKEN and IRONWRAP_EFFECT_RUNTIME_TOKEN must reference the same dedicated secret"));
  const leftoverFrappeRailValues = [];
  for (const [name, minimum] of LEFTOVER_FRAPPE_RAIL_SECRETS) {
    const value = env[name];
    if (value === undefined || value === "") {
      continue;
    }
    checks.push(check(
      `live.secret.${name}`,
      validSecret(env, name, minimum),
      `${name} is non-placeholder and meets the minimum length`,
      `${name} is missing, placeholder, malformed, or too short`,
    ));
    leftoverFrappeRailValues.push(value);
  }
  const purposeSecrets = [
    env.ERPNEXT_API_KEY,
    env.ERPNEXT_API_SECRET,
    ...leftoverFrappeRailValues,
    env.QB_WEBHOOK_TOKEN,
    env.QB_RECONCILIATION_ISSUER_API_KEY,
    env.QB_RECONCILIATION_ISSUER_API_SECRET,
    env.FRAPPE_API_KEY,
    env.FRAPPE_API_SECRET,
    env.ADMIN_TOKEN,
    env.EFFECT_RUNTIME_TOKEN,
    env.INGEST_TOKEN,
    env.HERMES_WRITE_TOKEN,
    env.HERMES_DRY_RUN_SIGNING_KEY,
    env.APPROVAL_BROKER_SHARED_SECRET,
    env.D1_BACKUP_API_TOKEN,
    env.RCLONE_CONFIG_R2_ACCESS_KEY_ID,
    env.RCLONE_CONFIG_R2_SECRET_ACCESS_KEY,
    ...(facetDesignIngestEnabled ? [
      env.FACET_DESIGN_INGEST_HMAC_KEY,
    ] : []),
    ...(facetProjectionEnabled ? [
      env.FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY,
      env.FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_KEY,
      env.FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_SECRET,
    ] : []),
    ...(facetQuoteRevisionEnabled ? [
      env.QUOTE_REVISION_BROKER_SHARED_SECRET,
    ] : []),
    ...(publicEstimateEnabled ? [
      env.PUBLIC_ESTIMATE_TURNSTILE_SECRET,
      env.PUBLIC_ESTIMATE_RATE_LIMIT_PEPPER,
    ] : []),
  ];
  checks.push(check("live.secret.separation", purposeSecrets.every((value) => typeof value === "string") && new Set(purposeSecrets).size === purposeSecrets.length, "privileged credentials are separated by purpose", "Frappe integration, QuickBooks issuer, launch-proof, bus, approval, Facet, D1 export, and R2 backup credentials must not be reused across purposes"));
  const restoreApiToken = env.D1_RESTORE_API_TOKEN;
  const restoreTokenUnset = restoreApiToken === undefined || restoreApiToken === "";
  const restoreTokenSeparated = validSecret(env, "D1_RESTORE_API_TOKEN", 24) && ![
    env.D1_BACKUP_API_TOKEN,
    env.RCLONE_CONFIG_R2_ACCESS_KEY_ID,
    env.RCLONE_CONFIG_R2_SECRET_ACCESS_KEY,
  ].includes(restoreApiToken);
  const restoreTokenStateSafe = (env.D1_RESTORE_MODE === "verify" && restoreTokenUnset) || (env.D1_RESTORE_MODE === "remote" && restoreTokenSeparated);
  checks.push(check("live.secret.d1_restore_ephemeral", restoreTokenStateSafe, restoreTokenUnset ? "D1 restore write token is not persisted in verification mode" : "remote drill token is valid and separated from backup authority", "D1_RESTORE_API_TOKEN must be unset for verify or a valid just-in-time token distinct from D1 backup and R2 credentials for remote"));

  // The Frappe projection is off in production (owner decision, 2026-09-27). The host must
  // agree with the committed production Worker flag rather than a value frozen here.
  const committedErpnextEnabled = await committedProductionVar(repoRoot, "ERPNEXT_ENABLED");
  checks.push(check(
    "live.gate.integration",
    (committedErpnextEnabled === "true" || committedErpnextEnabled === "false") && env.ERPNEXT_ENABLED === committedErpnextEnabled,
    `ERPNEXT_ENABLED matches the committed production Worker value (${committedErpnextEnabled})`,
    "ERPNEXT_ENABLED must equal the committed production Worker value in workers-bus/wrangler.jsonc",
  ));
  checks.push(check(
    "live.gate.facet_ingest",
    facetDesignIngestEnabled || env.FACET_DESIGN_INGEST_ENABLED === "false",
    facetDesignIngestEnabled ? "Facet design ingest is explicitly enabled" : "Facet design ingest is explicitly disabled",
    "FACET_DESIGN_INGEST_ENABLED must equal true or false",
  ));
  checks.push(check(
    "live.gate.facet_projection",
    facetProjectionEnabled || env.FACET_DESIGN_FRAPPE_PROJECTION_ENABLED === "false",
    facetProjectionEnabled ? "Facet-to-Frappe projection is explicitly enabled" : "Facet-to-Frappe projection is explicitly disabled",
    "FACET_DESIGN_FRAPPE_PROJECTION_ENABLED must equal true or false",
  ));
  checks.push(check(
    "live.gate.facet_quote_revision",
    facetQuoteRevisionEnabled || env.APP_FACET_QUOTE_REVISION_PREPARE_ENABLED === "false",
    facetQuoteRevisionEnabled ? "Facet quote-revision preparation is explicitly enabled" : "Facet quote-revision preparation is explicitly disabled",
    "APP_FACET_QUOTE_REVISION_PREPARE_ENABLED must equal true or false",
  ));
  if (facetDesignIngestEnabled) {
    checks.push(check(
      "live.facet.ingest_tenant_map",
      validFacetTenantMap(
        env.FACET_DESIGN_INGEST_TENANT_MAP_JSON,
        env.FACET_DESIGN_INGEST_SOURCE_TENANT_ID,
      ),
      "Facet ingest maps reviewed source tenants to the local IronWrap brand allowlist",
      "Facet ingest must contain exactly the reviewed source tenant and its v2 IronWrap/iRoof brand binding",
    ));
  }
  if (facetQuoteRevisionEnabled) {
    checks.push(check(
      "live.facet.quote_revision_broker_url",
      exactHttpsOrigin(env.APP_QUOTE_REVISION_BROKER_URL) !== null,
      "Facet quote-revision broker uses an exact production HTTPS origin",
      "APP_QUOTE_REVISION_BROKER_URL must be one credential-free production HTTPS origin",
    ));
    checks.push(check(
      "live.facet.quote_revision_broker_key",
      /^[A-Za-z0-9._-]{1,64}$/.test(env.APP_QUOTE_REVISION_BROKER_KEY_ID ?? ""),
      "Facet quote-revision broker key id is bounded",
      "APP_QUOTE_REVISION_BROKER_KEY_ID must be 1-64 safe identifier characters",
    ));
    checks.push(check(
      "live.facet.quote_revision_broker_bounds",
      validPositiveInteger(env.APP_QUOTE_REVISION_BROKER_TIMEOUT_MS, 1_000, 30_000) &&
        validPositiveInteger(env.APP_QUOTE_REVISION_EXECUTION_LEASE_SECONDS, 15, 120),
      "Facet quote-revision broker timeout and execution lease are bounded",
      "Facet quote-revision timeout must be 1000-30000 ms and its execution lease 15-120 seconds",
    ));
  }
  const launchProofAttempts = env.FRAPPE_PROOF_POLL_ATTEMPTS ?? "";
  const launchProofInterval = env.FRAPPE_PROOF_POLL_INTERVAL_MS ?? "";
  checks.push(check(
    "live.launch_proof.poll_attempts",
    /^(?:[1-5])$/.test(launchProofAttempts),
    "launch-proof Frappe poll attempts are bounded",
    "FRAPPE_PROOF_POLL_ATTEMPTS must be an integer from 1 through 5",
  ));
  checks.push(check(
    "live.launch_proof.poll_interval",
    /^(?:0|[1-9][0-9]*)$/.test(launchProofInterval) && Number(launchProofInterval) <= 5_000,
    "launch-proof Frappe poll interval is bounded",
    "FRAPPE_PROOF_POLL_INTERVAL_MS must be an integer from 0 through 5000",
  ));
  checks.push(check(
    "live.quickbooks.realm",
    /^[1-9][0-9]{0,31}$/.test(env.QB_EXPECTED_REALM_ID ?? ""),
    "QuickBooks expected realm is a concrete numeric company id",
    "QB_EXPECTED_REALM_ID must be one concrete numeric QuickBooks company realm",
  ));
  const quickBooksIssuerUser = env.QB_RECONCILIATION_ISSUER_USER ?? "";
  checks.push(check(
    "live.quickbooks.issuer",
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(quickBooksIssuerUser) &&
      quickBooksIssuerUser !== env.ERPNEXT_INTEGRATION_USER &&
      quickBooksIssuerUser === env.IRONWRAP_QUICKBOOKS_RECONCILIATION_ISSUER_USER,
    "QuickBooks issuer is a dedicated Frappe principal matched to site config",
    "QB_RECONCILIATION_ISSUER_USER must be a dedicated Frappe email distinct from ERPNEXT_INTEGRATION_USER and match IRONWRAP_QUICKBOOKS_RECONCILIATION_ISSUER_USER",
  ));
  checks.push(check(
    "live.gate.public_estimate",
    publicEstimateEnabled || env.PUBLIC_ESTIMATE_ENABLED === "false",
    publicEstimateEnabled ? "public estimator is explicitly enabled" : "public estimator is explicitly disabled",
    "PUBLIC_ESTIMATE_ENABLED must equal true or false",
  ));
  if (publicEstimateEnabled) {
    const publicEstimateOrigin = exactHttpsOrigin(env.PUBLIC_ESTIMATE_ALLOWED_ORIGINS);
    const publicEstimateBrands = new Set(String(env.PUBLIC_ESTIMATE_ALLOWED_BRANDS ?? "").split(",").filter(Boolean));
    checks.push(check(
      "live.public_estimate.origin",
      publicEstimateOrigin !== null && publicEstimateOrigin === exactHttpsOrigin(env.IRONWRAP_BUS_BASE_URL),
      "public estimator PWA origin exactly matches the deployed Worker origin",
      "PUBLIC_ESTIMATE_ALLOWED_ORIGINS must be one exact HTTPS Worker/PWA origin matching IRONWRAP_BUS_BASE_URL",
    ));
    checks.push(check(
      "live.public_estimate.brands",
      publicEstimateBrands.size === 2 && publicEstimateBrands.has("ironwrap") && publicEstimateBrands.has("iroof") &&
        [...publicEstimateBrands].every((brand) => /^[a-z0-9][a-z0-9 _/-]*$/.test(brand)),
      "public estimator is bound to the two configured IronWrap tenant brands",
      "PUBLIC_ESTIMATE_ALLOWED_BRANDS must contain exactly ironwrap,iroof for this tenant",
    ));
    checks.push(check(
      "live.public_estimate.jurisdiction",
      env.PUBLIC_ESTIMATE_CONSENT_JURISDICTION === "Alberta, Canada",
      "public estimator consent has an explicit Alberta jurisdiction",
      "PUBLIC_ESTIMATE_CONSENT_JURISDICTION must equal Alberta, Canada for this tenant",
    ));
    checks.push(check(
      "live.public_estimate.site_key",
      typeof env.PUBLIC_ESTIMATE_TURNSTILE_SITE_KEY === "string" && !isPlaceholder(env.PUBLIC_ESTIMATE_TURNSTILE_SITE_KEY) &&
        env.PUBLIC_ESTIMATE_TURNSTILE_SITE_KEY.length >= 10 && !/[\r\n]/.test(env.PUBLIC_ESTIMATE_TURNSTILE_SITE_KEY),
      "public estimator Turnstile site key is non-placeholder and bounded",
      "PUBLIC_ESTIMATE_TURNSTILE_SITE_KEY must be a non-placeholder site key",
    ));
    checks.push(check(
      "live.public_estimate.rate_limits",
      validPositiveInteger(env.PUBLIC_ESTIMATE_RATE_LIMIT_WINDOW_SECONDS, 60, 3_600) &&
        validPositiveInteger(env.PUBLIC_ESTIMATE_RATE_LIMIT_IP_MAX, 1, 100) &&
        validPositiveInteger(env.PUBLIC_ESTIMATE_RATE_LIMIT_CLIENT_MAX, 1, 20),
      "public estimator rate limits are explicit and within Worker bounds",
      "public estimator rate limits must match the Worker bounds",
    ));
    checks.push(check(
      "live.public_estimate.rules",
      publicEstimateRangesDisabled(env.PUBLIC_ESTIMATE_RANGE_RULES_JSON),
      "public estimator cannot return a price before measurement and approved pricing evidence",
      "PUBLIC_ESTIMATE_RANGE_RULES_JSON must equal [] because public online pricing is disabled",
    ));
    checks.push(check(
      "live.public_estimate.integration_user",
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.ERPNEXT_INTEGRATION_USER ?? ""),
      "public estimator consent mirror has a concrete Frappe integration user",
      "ERPNEXT_INTEGRATION_USER must be an email-like dedicated Worker principal",
    ));
  }
  checks.push(check(
    "live.hermes.role",
    ["owner-operator", "lead-concierge", "estimator-assistant", "production-controller", "field-companion", "finance-reconciler", "closeout-agent", "support-admin"].includes(env.HERMES_AGENT_ROLE),
    "HERMES_AGENT_ROLE is canonical",
    "HERMES_AGENT_ROLE must be one of the eight canonical roles",
  ));
  checks.push(check(
    "live.hermes.actor",
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.HERMES_ACTOR_USER ?? ""),
    "HERMES_ACTOR_USER is a concrete principal (its API-token binding is enforced by Frappe)",
    "HERMES_ACTOR_USER must be a concrete email-like Frappe principal",
  ));
  checks.push(check(
    "live.hermes.approver",
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.HERMES_APPROVER_ID ?? ""),
    "HERMES_APPROVER_ID is a concrete principal",
    "HERMES_APPROVER_ID must be the principal bound to the approval signing key",
  ));
  const approvalPublicKeyPath = env.HERMES_APPROVAL_PUBLIC_KEY_FILE ?? "";
  const approvalPublicKeyPathSafe = validSafeAbsolutePath(approvalPublicKeyPath);
  checks.push(check(
    "live.hermes.approval_public_key_path",
    approvalPublicKeyPathSafe,
    "approval public-key file is an absolute safe path",
    "HERMES_APPROVAL_PUBLIC_KEY_FILE must be an absolute safe path",
  ));
  let approvalPublicKeyValid = false;
  if (approvalPublicKeyPathSafe) {
    try {
      const metadata = await statApprovalPublicKey(approvalPublicKeyPath);
      const pem = await readApprovalPublicKey(approvalPublicKeyPath, "utf8");
      const parsed = parseApprovalPublicKey(pem);
      approvalPublicKeyValid = Boolean(metadata?.isFile?.()) && parsed.asymmetricKeyType === "ed25519";
    } catch {
      approvalPublicKeyValid = false;
    }
  }
  checks.push(check(
    "live.hermes.approval_public_key",
    approvalPublicKeyValid,
    "approval public-key file is readable and parses as an Ed25519 public key",
    "HERMES_APPROVAL_PUBLIC_KEY_FILE must be a readable regular file containing an Ed25519 public key",
  ));
  for (const name of ["IRONWRAP_BUS_WRITE_ENABLED", "ERPNEXT_WRITE_ENABLED"]) {
    checks.push(check(`live.gate.${name}`, env[name] === "true" || env[name] === "false", `${name} is explicit`, `${name} must equal true or false explicitly`));
  }
  for (const name of ["IRONWRAP_BUS_REQUEST_TIMEOUT_MS", "ERPNEXT_REQUEST_TIMEOUT_MS"]) {
    const value = env[name] ?? "";
    checks.push(check(
      `live.timeout.${name}`,
      /^(?:[1-9][0-9]*)$/.test(value) && Number(value) >= 1_000 && Number(value) <= 60_000,
      `${name} is explicitly bounded`,
      `${name} must be an integer from 1000 through 60000`,
    ));
  }

  checks.push(check("live.backup.site", validDomain(env.FRAPPE_SITE ?? ""), "FRAPPE_SITE is a valid production hostname", "FRAPPE_SITE must be a lowercase fully qualified hostname"));
  checks.push(check("live.backup.container", /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(env.BACKEND_CONTAINER ?? ""), "BACKEND_CONTAINER has a safe name", "BACKEND_CONTAINER has an unsafe or missing name"));
  checks.push(check("live.backup.rclone", env.RCLONE_CONFIG_R2_TYPE === "s3" && env.RCLONE_CONFIG_R2_PROVIDER === "Cloudflare", "rclone is configured for Cloudflare R2", "rclone backup type/provider must equal s3/Cloudflare"));
  checks.push(check("live.backup.endpoint", isHttpsProductionUrl(env.RCLONE_CONFIG_R2_ENDPOINT, { r2: true }), "R2 endpoint is a credential-free Cloudflare HTTPS URL", "R2 endpoint must be a credential-free Cloudflare HTTPS URL"));
  checks.push(check("live.backup.bucket", /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(env.R2_BACKUP_BUCKET ?? "") && !(env.R2_BACKUP_BUCKET ?? "").includes(".."), "R2 backup bucket has a safe name", "R2 backup bucket has an unsafe or missing name"));
  const retentionText = env.BACKUP_RETENTION_DAYS ?? "";
  const retention = Number(retentionText);
  checks.push(check("live.backup.retention", /^(?:0|[1-9][0-9]*)$/.test(retentionText) && Number.isInteger(retention) && retention >= 7 && retention <= 365, "backup retention is within the supported range", "BACKUP_RETENTION_DAYS must be an integer from 7 through 365"));
  checks.push(check("live.backup.encryption", /^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$/.test(env.BACKUP_AGE_RECIPIENT ?? ""), "backup encryption recipient is valid", "BACKUP_AGE_RECIPIENT must be one valid age public recipient"));

  checks.push(check("live.d1.source.account", env.D1_PRODUCTION_ACCOUNT_ID === "7ee5775bc1ba46f05c5a65235b60e939", "D1 export account matches the committed production account", "D1_PRODUCTION_ACCOUNT_ID must match the committed production account"));
  checks.push(check("live.d1.source.name", env.D1_PRODUCTION_DATABASE_NAME === "ironwrap-bus", "D1 export name matches the committed production database", "D1_PRODUCTION_DATABASE_NAME must equal ironwrap-bus"));
  checks.push(check("live.d1.source.id", env.D1_PRODUCTION_DATABASE_ID === "f0674848-13df-4422-9896-8ba2719663b8", "D1 export UUID matches the committed production database", "D1_PRODUCTION_DATABASE_ID must match the committed production UUID"));
  checks.push(check("live.d1.bucket", /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(env.D1_R2_BACKUP_BUCKET ?? "") && !(env.D1_R2_BACKUP_BUCKET ?? "").includes(".."), "D1 backup bucket has a safe name", "D1_R2_BACKUP_BUCKET has an unsafe or missing name"));
  const d1RetentionText = env.D1_BACKUP_RETENTION_DAYS ?? "";
  const d1Retention = Number(d1RetentionText);
  checks.push(check("live.d1.retention", /^(?:0|[1-9][0-9]*)$/.test(d1RetentionText) && Number.isInteger(d1Retention) && d1Retention >= 7 && d1Retention <= 365, "D1 backup retention is within the supported range", "D1_BACKUP_RETENTION_DAYS must be an integer from 7 through 365"));
  const d1Prefix = env.D1_RESTORE_R2_COMPLETED_PREFIX ?? "";
  checks.push(check("live.d1.restore_prefix", new RegExp(`^d1/${env.D1_PRODUCTION_DATABASE_NAME ?? "__missing__"}/\\d{8}T\\d{6}Z-\\d+-\\d+$`).test(d1Prefix) && !d1Prefix.includes("..") && !d1Prefix.includes("//"), "D1 restore selects one exact completed production export prefix", "D1_RESTORE_R2_COMPLETED_PREFIX must select one exact marker-bearing production D1 generation"));
  checks.push(check("live.d1.restore_identity", typeof env.D1_RESTORE_AGE_IDENTITY_FILE === "string" && env.D1_RESTORE_AGE_IDENTITY_FILE.startsWith("/") && !isPlaceholder(env.D1_RESTORE_AGE_IDENTITY_FILE) && !/[\r\n]/.test(env.D1_RESTORE_AGE_IDENTITY_FILE), "D1 restore identity is an absolute non-placeholder file path", "D1_RESTORE_AGE_IDENTITY_FILE must be an absolute non-placeholder path"));
  checks.push(check("live.d1.restore_mode", env.D1_RESTORE_MODE === "verify", "persistent D1 restore mode defaults to non-mutating verification", "D1_RESTORE_MODE must remain verify outside one approved remote drill"));
  checks.push(check("live.d1.target_account", env.D1_RESTORE_TARGET_ACCOUNT_ID === env.D1_PRODUCTION_ACCOUNT_ID, "D1 drill target is account-bound", "D1_RESTORE_TARGET_ACCOUNT_ID must match the committed Cloudflare account"));
  checks.push(check("live.d1.target_name", /^ironwrap-restore-drill-[a-z0-9-]{1,40}$/.test(env.D1_RESTORE_TARGET_DATABASE_NAME ?? "") && env.D1_RESTORE_TARGET_DATABASE_NAME !== env.D1_PRODUCTION_DATABASE_NAME && env.D1_RESTORE_TARGET_DATABASE_NAME !== "ironwrap-bus", "D1 drill target name is dedicated and distinct", "D1_RESTORE_TARGET_DATABASE_NAME must be a dedicated ironwrap-restore-drill-* name distinct from production"));
  const d1Uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  checks.push(check("live.d1.target_id", d1Uuid.test(env.D1_RESTORE_TARGET_DATABASE_ID ?? "") && env.D1_RESTORE_TARGET_DATABASE_ID !== env.D1_PRODUCTION_DATABASE_ID && env.D1_RESTORE_TARGET_DATABASE_ID !== "f0674848-13df-4422-9896-8ba2719663b8", "D1 drill target UUID is valid and distinct", "D1_RESTORE_TARGET_DATABASE_ID must be a valid non-production D1 UUID"));
  checks.push(check("live.d1.confirmation", env.D1_RESTORE_CONFIRMATION === undefined || env.D1_RESTORE_CONFIRMATION === "", "remote D1 confirmation is not persisted in the environment", "D1_RESTORE_CONFIRMATION must remain unset except for one approved remote invocation"));

  checks.push(check("live.restore.prefix", validRestorePrefix(env.RESTORE_R2_COMPLETED_PREFIX, env.FRAPPE_SITE), "restore drill selects one exact completed prefix under the production source site", "RESTORE_R2_COMPLETED_PREFIX must select one exact production-site run"));
  checks.push(check("live.restore.identity", typeof env.RESTORE_AGE_IDENTITY_FILE === "string" && env.RESTORE_AGE_IDENTITY_FILE.startsWith("/") && !isPlaceholder(env.RESTORE_AGE_IDENTITY_FILE) && !/[\r\n]/.test(env.RESTORE_AGE_IDENTITY_FILE), "restore identity is configured by an absolute non-placeholder file path", "RESTORE_AGE_IDENTITY_FILE must be an absolute non-placeholder path"));
  checks.push(check("live.restore.target_site", validDomain(env.RESTORE_TARGET_SITE ?? "") && env.RESTORE_TARGET_SITE !== env.FRAPPE_SITE, "restore target site is a distinct valid hostname", "RESTORE_TARGET_SITE must be a valid non-production hostname distinct from FRAPPE_SITE"));
  checks.push(check("live.restore.target_container", /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(env.RESTORE_TARGET_CONTAINER ?? "") && env.RESTORE_TARGET_CONTAINER !== env.BACKEND_CONTAINER, "restore target container is safe and distinct from production", "RESTORE_TARGET_CONTAINER must be safe and distinct from BACKEND_CONTAINER"));
  checks.push(check("live.restore.confirmation", env.RESTORE_CONFIRMATION === undefined || env.RESTORE_CONFIRMATION === "", "destructive restore confirmation is not persisted in the environment", "RESTORE_CONFIRMATION must remain unset except for one intentional --restore invocation"));

  return finish("live-env", checks);
}

export function renderHuman(result) {
  const lines = result.checks.map((item) => `${item.status === "pass" ? "PASS" : "FAIL"}  ${item.id}  ${item.message}`);
  lines.push(`${result.ok ? "READY" : "NOT READY"}: ${result.summary.passed} passed, ${result.summary.failed} failed`);
  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const positional = args.filter((arg) => arg !== "--json");
  if (positional.length !== 1 || !["contract", "live-env", "all"].includes(positional[0]) || args.some((arg) => arg !== "--json" && arg !== positional[0])) {
    process.stderr.write("usage: node tools/production-readiness.mjs <contract|live-env|all> [--json]\n");
    process.exitCode = 64;
    return;
  }

  let result;
  if (positional[0] === "contract") {
    result = await validateContract();
  } else if (positional[0] === "live-env") {
    result = await validateLiveEnv();
  } else {
    const contract = await validateContract();
    const live = await validateLiveEnv();
    result = finish("all", [...contract.checks, ...live.checks]);
  }
  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : renderHuman(result));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
