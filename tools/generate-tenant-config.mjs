#!/usr/bin/env node
// Render config/tenants/<tenant>.json from deploy/templates/tenant-config.template.json.
//
// Step 1 of docs/WHITE-LABEL-CLONE-PLAYBOOK.md used to read "copy demo-exteriors.json and fill
// in the tenant bits", which is how every tenant config so far was produced. Copy-and-edit has
// two failure modes a validator only catches after the fact: an answer that was never edited
// still names the SOURCE tenant (a sender domain silently shared between two tenants is the
// leakage the isolation model exists to prevent), and an invariant every tenant must carry
// gets edited away because it looked tenant-specific.
//
// Rendering from a template inverts that. The template holds the invariants
// tools/validate-tenant-config.mjs enforces; the answers hold only what is genuinely this
// tenant's, and an answer that is missing is an error rather than an inherited value.
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE_PATH = join(root, "deploy", "templates", "tenant-config.template.json");
const TENANT_DIR = join(root, "config", "tenants");

const TOKEN = /\{\{([A-Z0-9_]+)\}\}/g;
const EXACT_TOKEN = /^\{\{([A-Z0-9_]+)\}\}$/;

/** Answers every clone must state for itself. Anything not here has a defensible default. */
export const REQUIRED_ANSWERS = Object.freeze([
  "TENANT_ID",
  "TENANT_DISPLAY_NAME",
  "APP_TENANT_NAME",
  "BRAND_NAME",
  "BRAND_KEY",
  "BRAND_DISPLAY_NAME",
  "SENDER_DOMAIN",
  "SENDER_MAILBOX",
  "SERVICE_AREAS",
]);

/**
 * Jurisdiction defaults. Only Alberta is pre-filled because only Alberta's rates have been
 * blessed for this product; any other province must state its own rates rather than inherit
 * Alberta's, which is exactly the "roofing/Alberta assumption baked into a core path" the
 * product vision asks to keep behind a configuration boundary.
 */
export const PROVINCE_DEFAULTS = Object.freeze({
  AB: Object.freeze({
    TIMEZONE: "America/Edmonton",
    GST_RATE_BPS: 500,
    PST_RATE_BPS: 0,
    PRIVACY_LAW: "Alberta PIPA",
    PREPAID_LICENCE_ID_ENV: "ALBERTA_PREPAID_CONTRACTOR_LICENCE_ID",
  }),
});

export const BASE_DEFAULTS = Object.freeze({
  TENANT_STATUS: "demo",
  PROVINCE: "AB",
  COUNTRY: "Canada",
  COUNTRY_CODE: "CA",
  LANGUAGE_TAG: "en-CA",
  CURRENCY: "CAD",
  SERVICES: ["roofing", "metal_roofing", "gutters"],
  SENDER_ALIASES: [],
  PRIMARY_METAL_SUPPLIER: "PLACEHOLDER: metal supplier",
  TAX_SOURCE:
    "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-which-rate.html",
});

export function resolveAnswers(supplied) {
  const province = supplied.PROVINCE ?? BASE_DEFAULTS.PROVINCE;
  const answers = { ...BASE_DEFAULTS, ...(PROVINCE_DEFAULTS[province] ?? {}), ...supplied };

  if (!PROVINCE_DEFAULTS[province]) {
    for (const name of ["TIMEZONE", "GST_RATE_BPS", "PST_RATE_BPS", "PRIVACY_LAW", "PREPAID_LICENCE_ID_ENV"]) {
      if (answers[name] === undefined) {
        throw new Error(
          `province ${province} has no blessed defaults: state ${name} in the answers rather than inheriting Alberta's`,
        );
      }
    }
  }

  const missing = REQUIRED_ANSWERS.filter(
    (name) => answers[name] === undefined || answers[name] === null || answers[name] === "",
  );
  if (missing.length > 0) throw new Error(`missing required answers: ${missing.join(", ")}`);

  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(answers.TENANT_ID)) {
    throw new Error(
      "TENANT_ID must be lowercase alphanumeric with hyphens (it is also the site prefix and IRONWRAP_TENANT_CONFIG value)",
    );
  }
  if (!String(answers.SENDER_MAILBOX).endsWith(`@${answers.SENDER_DOMAIN}`)) {
    throw new Error("SENDER_MAILBOX must be a mailbox on SENDER_DOMAIN");
  }
  for (const alias of answers.SENDER_ALIASES) {
    if (!String(alias).endsWith(`@${answers.SENDER_DOMAIN}`)) {
      throw new Error(`sender alias ${alias} is not on SENDER_DOMAIN ${answers.SENDER_DOMAIN}`);
    }
  }
  return answers;
}

/**
 * Substitute tokens through a parsed template. A string that is EXACTLY one token adopts the
 * answer's own type, so an array answer renders as a JSON array rather than as its toString.
 */
export function render(node, answers, path = "$") {
  if (typeof node === "string") {
    const exact = node.match(EXACT_TOKEN);
    if (exact) {
      const value = answers[exact[1]];
      if (value === undefined) throw new Error(`template token {{${exact[1]}}} at ${path} has no answer`);
      return value;
    }
    return node.replace(TOKEN, (_match, name) => {
      const value = answers[name];
      if (value === undefined) throw new Error(`template token {{${name}}} at ${path} has no answer`);
      if (typeof value === "object") {
        throw new Error(`template token {{${name}}} at ${path} is interpolated into text but its answer is not scalar`);
      }
      return String(value);
    });
  }
  if (Array.isArray(node)) return node.map((entry, index) => render(entry, answers, `${path}[${index}]`));
  if (node && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) => [
        render(key, answers, `${path}.${key}`),
        render(value, answers, `${path}.${key}`),
      ]),
    );
  }
  return node;
}

export function generateTenantConfig({ template, answers, existingTenants = [] }) {
  const resolved = resolveAnswers(answers);
  // The template's own documentation talks ABOUT tokens, so it is dropped before rendering
  // rather than after: leaving it in makes the renderer demand an answer for the {{TOKEN}}
  // in the prose that explains what a token is.
  const { _template, ...shape } = template;
  void _template;
  const body = render(shape, resolved);

  for (const other of existingTenants) {
    if (other.tenant?.id === resolved.TENANT_ID) {
      throw new Error(`tenant id ${resolved.TENANT_ID} is already taken by another config`);
    }
    for (const brand of other.brand?.brands ?? []) {
      if (brand.sender_domain === resolved.SENDER_DOMAIN) {
        throw new Error(
          `sender domain ${resolved.SENDER_DOMAIN} already belongs to tenant ${other.tenant?.id}: a domain may belong to exactly one tenant`,
        );
      }
    }
  }
  return body;
}

/**
 * The configs a run must be checked against for an id or sender-domain collision.
 *
 * `--force` means "regenerate THIS tenant", so on a forced run the tenant's own config on disk
 * is not a collision - it is the thing being replaced. On an unforced run nothing is excluded,
 * so writing a second config that claims an existing tenant's id still fails closed.
 *
 * This filter used to read `doc.tenant?.id !== tenantId || force`, which is the same condition
 * inverted: with `--force` the predicate is true for every document, so the tenant's own config
 * was ADDED to the collision list and every forced regeneration died on a self-collision
 * (ELEC-143 finding 2). The documented `--force` path was unusable and no test exercised it.
 */
export function collisionCandidates(existing, tenantId, force) {
  return existing.filter((doc) => !(force && doc.tenant?.id === tenantId));
}

function parseArgv(argv) {
  const answers = {};
  let out = null;
  let answersFile = null;
  let force = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--answers") answersFile = argv[++index];
    else if (arg === "--out") out = argv[++index];
    else if (arg === "--force") force = true;
    else if (arg === "--set") {
      const pair = argv[++index] ?? "";
      const eq = pair.indexOf("=");
      if (eq < 1) throw new Error(`--set expects KEY=VALUE, got ${JSON.stringify(pair)}`);
      const key = pair.slice(0, eq);
      const raw = pair.slice(eq + 1);
      // A JSON-looking value keeps its type so `--set SERVICE_AREAS='["Calgary"]'` is a list.
      answers[key] = raw.startsWith("[") || raw.startsWith("{") ? JSON.parse(raw) : raw;
    } else throw new Error(`unknown argument ${JSON.stringify(arg)}`);
  }
  return { answers, out, answersFile, force };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { answers, out, answersFile, force } = parseArgv(process.argv.slice(2));
    const fromFile = answersFile ? JSON.parse(readFileSync(answersFile, "utf8")) : {};
    const merged = { ...fromFile, ...answers };
    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    const onDisk = readdirSync(TENANT_DIR)
      .filter((file) => file.endsWith(".json"))
      .map((file) => JSON.parse(readFileSync(join(TENANT_DIR, file), "utf8")));
    const existingTenants = collisionCandidates(onDisk, merged.TENANT_ID, force);

    const target = out ?? join(TENANT_DIR, `${merged.TENANT_ID}.json`);
    if (existsSync(target) && !force) {
      console.log(`ok ${target} already exists (re-run with --force to regenerate)`);
      process.exit(0);
    }
    const config = generateTenantConfig({ template, answers: merged, existingTenants });
    writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`ok wrote ${target} for tenant ${config.tenant.id}`);
  } catch (error) {
    console.error(`generate-tenant-config failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
