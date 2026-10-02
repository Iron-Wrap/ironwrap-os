#!/usr/bin/env node
// seed-env.mjs — one idempotent command that fills an empty non-production environment with
// clearly synthetic data and refuses to run against production (IRO-263).
//
// The guard is derived from workers-bus/wrangler.jsonc, never hardcoded: the production Worker
// name, its route and its D1 id are already committed there, so a guard built from that file
// cannot rot as environments change. Nothing else here identifies "production" - a target is
// refused because it names the committed production identifiers, not because of a list this
// file invents on its own.
//
// Tokens (ADMIN_TOKEN, INGEST_TOKEN) come from the environment only - never an argument, never
// printed, never present in --json output.
//
// Usage:
//   node tools/seed-env.mjs --env qa                            # base URL resolved from wrangler.jsonc
//   node tools/seed-env.mjs --base-url http://localhost:7100    # loopback only
//     [--leads N]  (default 3, refuse above 25)  [--json]  [--dry-run]
//
// Idempotence contract: every step's `created` is 0 from the second run on, and the `counts`
// block is byte-identical from the second run on; run 1 and run 2 differ by design, each
// `created` becoming the matching `kept`. One new crm_import_runs row and its crm_import_issues
// rows are the per-run ledger and are expected on every run - that is not a violation of
// "nothing new". The no-op rests on the seeded leads still being inside the 100 most recent
// envelopes: past that cap, GET /admin/envelopes's step-5 pre-check stops seeing them, and only
// /ingest/*'s 72h dedup window keeps a re-run from creating new ones. One named exception:
// /ingest/measurement answers 202 processing with no idempotent_replay both on a first submission
// and on a repeat made before the measurement queue drains that receipt, so a second run started
// inside that window reports measurement_intake: created=1 again, and reports kept=1 once the
// receipt has settled to matched or unmatched. This is queue timing, not a bug in this tool.
//
// Exit codes: 0 seeded, 1 refused before any write, 2 usage, 3 ran and at least one attempted write
// failed - or crashed after a write. Exit 1 means no write was attempted; it does not mean the
// output is one line: every guard refusal begins `refused: `, two of them quote the underlying
// error's stack after that prefix (an unreadable or invalid committed input at :604, an unreachable
// pre-write read), and an unexpected error in the guard path itself - a malformed
// workers-bus/wrangler.jsonc, say - exits 1 with a bare stack trace and no `refused:` line.
// The full report prints before exit 3 for every failure the step classifiers see; a crash they never
// see (a dropped connection, a Cloudflare-side error, a failure writing the pipelines.sql
// artefact) prints a stack trace and exits 3 with no counts. Every offline input is read and
// validated before the first write, so no missing or unreadable committed file lands in that class.
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { stripJsonComments } from "./generate-tenant-worker-config.mjs";
import { flattenEnv } from "../workers-bus/src/env-bindings.ts";
import { pipelineSeedStatements, parsePipelineTemplate, statementsToSql } from "./seed-pipeline.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "ironwrap.localhost"]);
export const MAX_LEADS = 25;
export const MAX_ENVELOPE_READ = 100;

export class SeedGuardError extends Error {}

/** Load and parse workers-bus/wrangler.jsonc (JSONC -> object). No network, no cache. */
export function loadWranglerConfig(path) {
  return JSON.parse(stripJsonComments(readFileSync(path, "utf8")));
}

/**
 * The production identifiers a guard checks against, all derived from the committed config:
 * the top-level Worker name, its route hostname, its D1 id, and the workers.dev hostname the
 * same Worker would resolve to (derived from any non-production environment's own
 * `*.workers.dev` origin, since the account subdomain is a fact of the Cloudflare account, not
 * of any one environment).
 */
export function productionIdentifiers(config) {
  const workerName = config.name;
  const databaseId = config.d1_databases?.[0]?.database_id ?? null;
  const routeHostname = config.routes?.[0]?.pattern ?? null;
  let workersDevHostname = null;
  for (const envConfig of Object.values(config.env ?? {})) {
    // IRO-268 groups vars into `CFG_*` objects; read them flat, as the Worker does.
    const origin = flattenEnv(envConfig?.vars ?? {}).APP_PUBLIC_ORIGIN;
    if (typeof origin !== "string" || !origin.includes(".workers.dev")) continue;
    try {
      const hostname = new URL(origin).hostname;
      const accountSubdomain = hostname.split(".").slice(1).join(".");
      if (accountSubdomain) {
        workersDevHostname = `${workerName}.${accountSubdomain}`;
        break;
      }
    } catch {
      // not a parseable URL; keep looking
    }
  }
  return { workerName, databaseId, routeHostname, workersDevHostname };
}

function productionHostnameList(prod) {
  return [prod.routeHostname, prod.workersDevHostname].filter(Boolean).join(" and ");
}

/**
 * Refuse when any of the four production identifiers could not be derived from the committed
 * config. A half-derived set lets check 3 or check 4 in resolveTarget silently stop comparing
 * against it (R2.7's finding, on the other side of the same comparison), and it makes the
 * --base-url refusal message name an incomplete hostname list. Latent today: all four derive
 * from workers-bus/wrangler.jsonc as committed.
 */
export function assertProductionIdentifiersComplete(prod) {
  if (!prod.workerName) {
    throw new SeedGuardError("wrangler.jsonc declares no top-level name: the production Worker name cannot be derived.");
  }
  if (!prod.databaseId) {
    throw new SeedGuardError(
      "wrangler.jsonc declares no top-level d1_databases[0].database_id: the production database id cannot be derived.",
    );
  }
  if (!prod.routeHostname) {
    throw new SeedGuardError(
      "wrangler.jsonc declares no top-level routes[0].pattern: the production route hostname cannot be derived.",
    );
  }
  if (!prod.workersDevHostname) {
    throw new SeedGuardError(
      "no environment declares a *.workers.dev APP_PUBLIC_ORIGIN, so the production workers.dev hostname cannot be derived.",
    );
  }
}

/**
 * Resolve a run target from `--env` or `--base-url` against the committed config, refusing
 * production by four independent checks before any request is made. Pure and offline: every
 * check reads only `config` and the supplied flags.
 */
export function resolveTarget({ config, env, baseUrl }) {
  if (env !== undefined && baseUrl) {
    throw new SeedGuardError(
      `--env ${JSON.stringify(env)} and --base-url ${JSON.stringify(baseUrl)} both name a target: pass exactly one.`,
    );
  }

  const prod = productionIdentifiers(config);
  assertProductionIdentifiersComplete(prod);

  if (env !== undefined && (env === "" || env === "production")) {
    throw new SeedGuardError(
      `--env ${JSON.stringify(env)} names the production block: production is not a selectable target.`,
    );
  }
  if (!env && !baseUrl) {
    throw new SeedGuardError(
      "no target selected: production is not a selectable target. Pass --env <name> or --base-url <loopback-url>.",
    );
  }

  if (baseUrl) {
    let hostname;
    try {
      hostname = new URL(baseUrl).hostname;
    } catch {
      throw new SeedGuardError(`--base-url ${JSON.stringify(baseUrl)} is not a valid URL.`);
    }
    if (!LOCAL_HOSTS.has(hostname)) {
      throw new SeedGuardError(
        `--base-url hostname ${JSON.stringify(hostname)} is not loopback: refusing a target that is not ` +
          `localhost, 127.0.0.1, ::1 or ironwrap.localhost. Production resolves to ${productionHostnameList(prod)}.`,
      );
    }
    // Only the `local` environment in workers-bus/wrangler.jsonc is loopback-shaped; a
    // --base-url run takes its tenant id from that environment's own committed vars, never
    // from a flag.
    const local = config.env?.local;
    if (!local) throw new SeedGuardError("wrangler.jsonc declares no env.local to take a tenant id from.");
    const tenantId = flattenEnv(local.vars ?? {}).APP_TENANT_ID;
    if (!tenantId) throw new SeedGuardError("env.local declares no APP_TENANT_ID.");
    const databaseName = local.d1_databases?.[0]?.database_name;
    if (!databaseName) {
      throw new SeedGuardError(
        "env.local declares no d1_databases[0].database_name, so the wrangler command cannot be built: refusing.",
      );
    }
    return { envName: "local", baseUrl: baseUrl.replace(/\/+$/, ""), tenantId, databaseName };
  }

  const selected = config.env?.[env];
  if (!selected) {
    throw new SeedGuardError(`--env ${JSON.stringify(env)} does not exist in workers-bus/wrangler.jsonc.`);
  }
  const selectedDatabaseId = selected.d1_databases?.[0]?.database_id ?? null;
  if (!selectedDatabaseId) {
    throw new SeedGuardError(
      `env.${env} declares no d1_databases[0].database_id, so the production-database check cannot run: refusing.`,
    );
  }
  if (selectedDatabaseId === prod.databaseId) {
    throw new SeedGuardError(
      `env.${env}'s D1 database id (${selectedDatabaseId}) is the production database id: refusing.`,
    );
  }
  const selectedVars = flattenEnv(selected.vars ?? {});
  const origin = selectedVars.APP_PUBLIC_ORIGIN;
  if (!origin) throw new SeedGuardError(`env.${env} declares no APP_PUBLIC_ORIGIN to target.`);
  let originHostname;
  try {
    originHostname = new URL(origin).hostname;
  } catch {
    throw new SeedGuardError(`env.${env}'s APP_PUBLIC_ORIGIN ${JSON.stringify(origin)} is not a valid URL.`);
  }
  if (originHostname === prod.routeHostname || originHostname === prod.workersDevHostname) {
    throw new SeedGuardError(
      `env.${env} resolves to ${JSON.stringify(originHostname)}, a production hostname (${productionHostnameList(prod)}): refusing.`,
    );
  }
  const tenantId = selectedVars.APP_TENANT_ID;
  if (!tenantId) throw new SeedGuardError(`env.${env} declares no APP_TENANT_ID.`);
  const databaseName = selected.d1_databases?.[0]?.database_name;
  if (!databaseName) {
    throw new SeedGuardError(
      `env.${env} declares no d1_databases[0].database_name, so the wrangler command cannot be built: refusing.`,
    );
  }
  return { envName: env, baseUrl: origin.replace(/\/+$/, ""), tenantId, databaseName };
}

/**
 * Refuse a target whose /admin/envelopes read cannot be trusted, before the content guard runs
 * on it. A non-200 or a body with no `envelopes` array must stop the run - assuming an empty
 * target on a failed read is what let step 5's dedup pre-check silently stop running too.
 */
export function assertEnvelopeReadUsable({ status, body }) {
  if (status !== 200) {
    throw new SeedGuardError(
      `GET /admin/envelopes answered ${status}, not 200: the content guard cannot run, so this target is ` +
        `refused rather than assumed empty.`,
    );
  }
  if (!Array.isArray(body?.envelopes)) {
    throw new SeedGuardError(
      "GET /admin/envelopes answered 200 without an `envelopes` array: the content guard cannot run, so " +
        "this target is refused.",
    );
  }
}

/**
 * Refuse a target whose recent envelopes are not all synthetic. This is the runtime half of the
 * guard: nothing in `/admin/status` or `/ready` identifies an environment today, so the check
 * that actually protects real data is content-based, against an endpoint that already exists.
 */
export function assertOnlySyntheticEnvelopes(envelopes) {
  for (const envelope of envelopes) {
    const email = envelope?.contact_email;
    if (typeof email === "string" && email !== "" && !email.endsWith("@example.invalid")) {
      throw new SeedGuardError(
        `envelope ${envelope.envelope_id} has a non-synthetic contact_email: refusing to seed a target that ` +
          `already holds real-looking data (checked the 100 most recent rows only).`,
      );
    }
  }
}

/** Deterministic synthetic website leads for --leads N. Never a real person or address. */
export function syntheticLeads(count) {
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    const padded = String(n).padStart(3, "0");
    return {
      external_id: `synth-seed-web-${padded}`,
      name: `Synthetic Seed Lead ${padded}`,
      email: `synth-seed-web-${padded}@example.invalid`,
      phone: `+1-780-555-01${String(n).padStart(2, "0")}`,
      address: `${100 + index} Example Ave, Edmonton, AB`,
      service: "roofing",
    };
  });
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return "";
}

/**
 * Flatten the shipped JobNimbus synthetic snapshot (12 contacts, 9 jobs) into `generic` CRM-import
 * adapter rows: one row per job joined to its primary contact, plus one row per contact with no
 * job. That is 12 rows from the shipped fixture - pinned by tools/seed-env.test.mjs.
 */
export function flattenSnapshot({ contacts, jobs }) {
  const contactById = new Map(contacts.map((contact) => [contact.jnid, contact]));
  const referenced = new Set();
  const rows = [];

  for (const job of jobs) {
    const contact = contactById.get(job.primary?.id);
    if (!contact) continue;
    referenced.add(contact.jnid);
    rows.push({
      external_id: job.jnid,
      contact_name: contact.display_name,
      email: contact.email,
      phone: firstNonEmpty(contact.mobile_phone, contact.home_phone, contact.work_phone, contact.phone),
      address: contact.address_line1,
      city: contact.city,
      state: contact.state_text,
      zip: contact.zip,
      service: job.name,
      stage: job.status_name,
      lead_number: contact.cf_string_1 ?? "",
      job_number: job.number,
    });
  }

  for (const contact of contacts) {
    if (referenced.has(contact.jnid)) continue;
    rows.push({
      external_id: contact.jnid,
      contact_name: contact.display_name,
      email: contact.email,
      phone: firstNonEmpty(contact.mobile_phone, contact.home_phone, contact.work_phone, contact.phone),
      address: contact.address_line1,
      city: contact.city,
      state: contact.state_text,
      zip: contact.zip,
      service: "",
      stage: contact.status_name,
      lead_number: contact.cf_string_1 ?? "",
      job_number: "",
    });
  }

  return rows;
}

/**
 * Classify a /admin/app-users/bootstrap response. Only the two flag-gated codes
 * (workers-bus/src/app-api.ts:450-455) carry an owner action naming the flag to flip; every
 * other non-200/409 is reported skipped with its status and error, and no owner action, so the
 * owner is never sent after the wrong var for something else entirely (a 401, say).
 */
export function bootstrapOutcome({ status, body }) {
  if (status === 200) return { created: 1, kept: 0, skipped: 0, failed: 0 };
  if (status === 409) return { created: 0, kept: 1, skipped: 0, failed: 0 };
  const reasonCode = `${status} ${body?.error ?? "unknown"}`;
  if (status === 403 && body?.error === "first_owner_bootstrap_disabled") {
    return {
      created: 0,
      kept: 0,
      skipped: 1,
      failed: 0,
      reason: `${reasonCode} - owner action: enable APP_FIRST_OWNER_BOOTSTRAP_ENABLED for this environment.`,
    };
  }
  if (status === 503 && body?.error === "app_bff_disabled") {
    return {
      created: 0,
      kept: 0,
      skipped: 1,
      failed: 0,
      reason: `${reasonCode} - owner action: enable APP_BFF_ENABLED for this environment.`,
    };
  }
  return { created: 0, kept: 0, skipped: 0, failed: 1, reason: reasonCode };
}

/**
 * Classify a single intake write (/ingest/website, /ingest/estimate, /ingest/measurement):
 * a non-2xx status is an attempted write that failed, never a silent `created`; a 2xx with the
 * adapter's own replay field set is `kept`, otherwise `created`. `replayField` is `"duplicate"`
 * for /ingest/website and `"idempotent_replay"` for /ingest/estimate and /ingest/measurement -
 * the field being absent (the 202 `processing` case) is not an error.
 */
export function intakeOutcome({ status, body, replayField = "duplicate" }) {
  if (status < 200 || status > 299) {
    return { created: 0, kept: 0, skipped: 0, failed: 1, reason: `${status} ${body?.error ?? "unknown"}` };
  }
  return body?.[replayField]
    ? { created: 0, kept: 1, skipped: 0, failed: 0 }
    : { created: 1, kept: 0, skipped: 0, failed: 0 };
}

/**
 * Fold a sequence of per-lead intake outcomes into one step total, keeping every distinct
 * failure reason instead of only the first (R4.4). First-seen order keeps the joined reason
 * string deterministic for a given sequence of answers; a clean run carries no `reason` key.
 */
export function mergeIntakeOutcomes(outcomes) {
  const merged = { created: 0, kept: 0, skipped: 0, failed: 0 };
  const reasons = [];
  for (const outcome of outcomes) {
    merged.created += outcome.created;
    merged.kept += outcome.kept;
    merged.skipped += outcome.skipped ?? 0;
    merged.failed += outcome.failed;
    if (outcome.reason && !reasons.includes(outcome.reason)) reasons.push(outcome.reason);
  }
  if (reasons.length > 0) merged.reason = reasons.join("; ");
  return merged;
}

/**
 * Classify a crm-import dry-run or execute response, covering the non-2xx case, the malformed-200
 * case (a 200 with no `report`, or a dry-run report missing `reconciliation`) and, for dry-run
 * only, the dirty-plan case - in one place, so none of them can fall through to a thrown stack
 * trace after step 3 has already written (R4.1). A dirty plan is `failed`, not `skipped`: the step
 * was attempted and produced no import. Returns null only for a clean dry-run, meaning "proceed to
 * execute".
 */
export function crmImportOutcome({ phase, status, body }) {
  const zero = { created: 0, kept: 0, skipped: 0, failed: 1 };
  if (status < 200 || status > 299) {
    return { ...zero, reason: `${phase} ${status} ${body?.error ?? "unknown"}` };
  }
  const report = body?.report;
  if (!report) return { ...zero, reason: `${phase} ${status} no_report` };
  if (phase === "dry-run") {
    const rowErrors = report.rowErrors?.length ?? 0;
    if (!report.reconciliation?.balanced || rowErrors > 0) {
      return {
        ...zero,
        reason: `dry-run not clean (balanced=${report.reconciliation?.balanced}, rowErrors=${rowErrors}): execute not attempted`,
      };
    }
    return null; // the plan is clean - proceed to execute
  }
  const applied = report.applied ?? { created: 0, adopted: 0, failed: 0 };
  return { created: applied.created, kept: applied.adopted, skipped: 0, failed: applied.failed };
}

/**
 * Refuse any flattened row that is not unambiguously synthetic. This is the guard that actually
 * holds even if the fixture generator changes - the generator is regenerated on every run, so
 * this assertion, not the regeneration, is what proves the rows fed to crm-import are safe.
 */
export function assertSyntheticRows(rows) {
  for (const row of rows) {
    if (!/^synth-/.test(row.external_id)) {
      throw new SeedGuardError(
        `row external_id ${JSON.stringify(row.external_id)} does not start with "synth-": refusing to import ` +
          `a row that is not unambiguously synthetic.`,
      );
    }
    if (row.email && !row.email.endsWith("@example.invalid")) {
      throw new SeedGuardError(
        `row external_id ${JSON.stringify(row.external_id)} has a non-synthetic email: refusing to import a ` +
          `row that is not unambiguously synthetic.`,
      );
    }
  }
}

/**
 * Build the `wrangler d1 execute` command the owner runs to apply the board SQL. Both branches
 * resolve from one directory: `cd workers-bus` first for the config, then a `--file` path
 * relative to that same directory, since the repository root carries no wrangler config at all.
 */
export function pipelineApplyCommand({ envName, databaseName }) {
  const flags = envName === "local" ? "--local --persist-to ../tmp/seed-d1" : "--remote";
  return (
    `(cd workers-bus && npx wrangler d1 execute ${databaseName} --env ${envName} ${flags} ` +
    `--file ../output/seed-env/${envName}/pipelines.sql)`
  );
}

/** Assemble the two report blocks the CLI and --json share. */
export function summarize({ steps, run }) {
  const counts = {};
  for (const [name, step] of Object.entries(steps)) {
    counts[name] = {
      created: step.created ?? 0,
      kept: step.kept ?? 0,
      skipped: step.skipped ?? 0,
      failed: step.failed ?? 0,
      ...(step.reason ? { reason: step.reason } : {}),
      ...(step.owner_action ? { owner_action: step.owner_action } : {}),
    };
  }
  return { counts, run };
}

// --------------------------------------------------------------------------------------- CLI

function requireValue(argv, i, flag) {
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(`${flag} requires a value`);
    process.exit(2);
  }
  return value;
}

function parseArgs(argv) {
  const args = { env: undefined, baseUrl: undefined, leads: 3, json: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--env") args.env = requireValue(argv, i++, "--env");
    else if (arg === "--base-url") args.baseUrl = requireValue(argv, i++, "--base-url");
    else if (arg === "--leads") args.leads = Number(argv[++i]);
    else if (arg === "--json") args.json = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "usage: node tools/seed-env.mjs (--env <name> | --base-url <loopback-url>) [--leads N] [--json] [--dry-run]\n\n" +
          "Idempotence: every step's created=0 and `counts` is byte-identical from the second run on, except " +
          "measurement_intake, whose created=1 repeats until the queue-driven receipt settles - queue timing, " +
          "not a re-run bug. The no-op rests on the seeded leads still being inside the 100 most recent " +
          "envelopes; past that cap only /ingest/*'s 72h dedup window keeps a re-run from creating new ones.\n\n" +
          "Exit codes: 0 seeded, 1 refused before any write, 2 usage, 3 ran and at least one attempted " +
          "write failed, or crashed after a write. Exit 1 means no write was attempted; the refusal line " +
          "begins `refused:` and quotes the underlying error, stack included, for an unreadable committed " +
          "input or an unreachable pre-write read, while an unexpected error in the guard path itself exits " +
          "1 with a bare stack. A crash the step classifiers never see exits 3 with a stack trace and no " +
          "counts, so check the target before re-running.",
      );
      process.exit(0);
    } else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return args;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => null);
  return { response, body };
}

// A pre-write read that cannot be reached refuses the way /health does at :592-598: one
// `refused: …` line, exit 1 - never a bare stack trace from the catch-all. Every caller below runs
// before `writeAttempted = true`, so this changes the output, not the outcome or the exit code.
async function fetchJsonOrRefuse(url, options) {
  try {
    return await fetchJson(url, options);
  } catch (error) {
    const method = options?.method ?? "GET";
    console.error(
      `refused: ${method} ${url} is unreachable: ${error?.cause?.code ?? error?.message ?? error}`,
    );
    process.exit(1);
  }
}

function authHeaders(token) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

// Set true the moment the first write is attempted (step 3's bootstrap POST). Read only in the
// catch-all below, to tell a crash before any write (exit 1, per the runbook) from a crash after
// one (exit 3 - an attempted write whose outcome was never recorded is still an attempted write).
let writeAttempted = false;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!Number.isInteger(args.leads) || args.leads < 0 || args.leads > MAX_LEADS) {
    console.error(`--leads must be an integer between 0 and ${MAX_LEADS} (the /admin/envelopes read window).`);
    process.exit(2);
  }

  const config = loadWranglerConfig(join(root, "workers-bus", "wrangler.jsonc"));
  let target;
  try {
    target = resolveTarget({ config, env: args.env, baseUrl: args.baseUrl });
  } catch (error) {
    if (error instanceof SeedGuardError) {
      console.error(`refused: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  if (args.dryRun) {
    console.log(`dry run: would seed ${target.envName} at ${target.baseUrl} (tenant ${target.tenantId})`);
    return;
  }

  const adminToken = process.env.ADMIN_TOKEN ?? "";
  const ingestToken = process.env.INGEST_TOKEN ?? "";
  if (!adminToken) {
    console.error("ADMIN_TOKEN is required in the environment (never as an argument).");
    process.exit(2);
  }
  if (!ingestToken) {
    console.error("INGEST_TOKEN is required in the environment (never as an argument).");
    process.exit(2);
  }

  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const steps = {};

  // Every offline input is loaded here, before writeAttempted can be set: a missing, unreadable or
  // malformed committed file must refuse (exit 1), never crash after a write (exit 3, no counts).
  let rows;
  let measurementXml;
  let template;
  try {
    const snapshotDir = join(root, "output", "jobnimbus-export", "synthetic-fixture");
    execFileSync(process.execPath, [join(root, "tools", "fixtures", "generate-jobnimbus-synthetic-snapshot.mjs")], {
      stdio: ["ignore", args.json ? "ignore" : "inherit", "inherit"],
    });
    rows = flattenSnapshot({
      contacts: readNdjson(join(snapshotDir, "contacts.ndjson")),
      jobs: readNdjson(join(snapshotDir, "jobs.ndjson")),
    });
    assertSyntheticRows(rows);
    measurementXml = readFileSync(join(root, "tools", "fixtures", "synthetic-applicad-roof.xml"), "utf8");
    template = parsePipelineTemplate(JSON.parse(readFileSync(join(root, "config", "pipelines", "sales-pipeline.v1.json"), "utf8")));
  } catch (error) {
    console.error(
      error instanceof SeedGuardError
        ? `refused: ${error.message}`
        : `refused: a committed input could not be loaded: ${String(error?.stack ?? error)}`,
    );
    process.exit(1);
  }

  // ---- pre-write guard: reachability + content check, still before any write ----
  let health;
  try {
    health = await fetch(`${target.baseUrl}/health`);
  } catch (error) {
    console.error(
      `refused: GET ${target.baseUrl}/health is unreachable: ${error?.cause?.code ?? error?.message ?? error}`,
    );
    process.exit(1);
  }
  if (health.status !== 200) {
    console.error(`refused: GET /health answered ${health.status}, not 200.`);
    process.exit(1);
  }
  const { response: envelopesResponse, body: envelopesBody } = await fetchJsonOrRefuse(
    `${target.baseUrl}/admin/envelopes?limit=${MAX_ENVELOPE_READ}`,
    { headers: authHeaders(adminToken) },
  );
  try {
    assertEnvelopeReadUsable({ status: envelopesResponse.status, body: envelopesBody });
    assertOnlySyntheticEnvelopes(envelopesBody.envelopes);
  } catch (error) {
    if (error instanceof SeedGuardError) {
      console.error(`refused: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
  const existingEnvelopes = envelopesBody.envelopes;
  const existingEmails = new Set(
    existingEnvelopes.map((envelope) => envelope.contact_email).filter(Boolean),
  );

  // ---- step 2: capability probe ----
  const { response: readyResponse } = await fetchJsonOrRefuse(`${target.baseUrl}/ready`, {
    headers: authHeaders(adminToken),
  });
  const { response: statusResponse } = await fetchJsonOrRefuse(`${target.baseUrl}/admin/status`, {
    headers: authHeaders(adminToken),
  });
  // The two probe status codes live in `run.ready_status` / `run.admin_status` only - a read is
  // not a count, and `counts` buckets are created/kept/skipped/failed, none of which fit a read
  // honestly (R4.2). The exit code does not change: a degraded /admin/status is not a seed
  // failure, because the probe is a read and the exit code is about writes.

  // ---- step 3: owner bootstrap ----
  {
    writeAttempted = true;
    const { response, body } = await fetchJson(`${target.baseUrl}/admin/app-users/bootstrap`, {
      method: "POST",
      headers: authHeaders(adminToken),
      body: JSON.stringify({
        tenant_id: target.tenantId,
        email: "owner@example.invalid",
        display_name: "Synthetic Owner",
      }),
    });
    steps.owner_bootstrap = bootstrapOutcome({ status: response.status, body });
  }

  // ---- step 4: synthetic CRM import ----
  {
    const { response: dryRunResponse, body: dryRunBody } = await fetchJson(
      `${target.baseUrl}/admin/crm-import/dry-run`,
      {
        method: "POST",
        headers: authHeaders(adminToken),
        body: JSON.stringify({ adapter: "generic", pipeline_key: "sales", source_label: "seed-env", rows }),
      },
    );
    const dryRunOutcome = crmImportOutcome({ phase: "dry-run", status: dryRunResponse.status, body: dryRunBody });
    if (dryRunOutcome) {
      steps.crm_import = dryRunOutcome;
    } else {
      const { response: executeResponse, body: executeBody } = await fetchJson(
        `${target.baseUrl}/admin/crm-import/execute`,
        {
          method: "POST",
          headers: authHeaders(adminToken),
          body: JSON.stringify({ adapter: "generic", pipeline_key: "sales", source_label: "seed-env", rows }),
        },
      );
      steps.crm_import = crmImportOutcome({ phase: "execute", status: executeResponse.status, body: executeBody });
    }
  }

  // ---- step 5: synthetic intake ----
  {
    const leads = syntheticLeads(args.leads);
    const outcomes = [];
    for (const lead of leads) {
      if (existingEmails.has(lead.email)) {
        outcomes.push({ created: 0, kept: 1, skipped: 0, failed: 0 });
        continue;
      }
      const { response, body } = await fetchJson(`${target.baseUrl}/ingest/website`, {
        method: "POST",
        headers: { authorization: `Bearer ${ingestToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          name: lead.name,
          email: lead.email,
          phone: lead.phone,
          address: lead.address,
          service: lead.service,
          external_id: lead.external_id,
        }),
      });
      outcomes.push(intakeOutcome({ status: response.status, body, replayField: "duplicate" }));
    }
    steps.website_leads = mergeIntakeOutcomes(outcomes);

    const { response: estimateResponse, body: estimateBody } = await fetchJson(`${target.baseUrl}/ingest/estimate`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ingestToken}`,
        "content-type": "application/json",
        "idempotency-key": "synth-seed-est-001",
      },
      body: JSON.stringify({
        project_key: "synth-seed-proj-001",
        name: "Synthetic Seed Estimate",
        email: "synth-seed-est-001@example.invalid",
        phone: "+1-780-555-0199",
        address: "199 Example Ave, Edmonton, AB",
        services: [{ service: "metal_roofing", quantity: 20, unit: "squares" }],
      }),
    });
    steps.estimate_intake = intakeOutcome({
      status: estimateResponse.status,
      body: estimateBody,
      replayField: "idempotent_replay",
    });

    const { response: measurementResponse, body: measurementBody } = await fetchJson(`${target.baseUrl}/ingest/measurement`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ingestToken}`,
        "content-type": "text/xml",
        "idempotency-key": "synth-seed-meas-001",
      },
      body: measurementXml,
    });
    steps.measurement_intake = intakeOutcome({
      status: measurementResponse.status,
      body: measurementBody,
      replayField: "idempotent_replay",
    });
  }

  // ---- step 6: board rows (owner action) ----
  {
    const statements = pipelineSeedStatements(template, { tenantId: target.tenantId });
    const outDir = join(root, "output", "seed-env", target.envName);
    mkdirSync(outDir, { recursive: true });
    const outFile = join(outDir, "pipelines.sql");
    writeFileSync(outFile, `${statementsToSql(statements)}\n`);
    const command = pipelineApplyCommand({ envName: target.envName, databaseName: target.databaseName });
    steps.pipeline_board = {
      created: 0,
      kept: 0,
      skipped: 1,
      failed: 0,
      owner_action: command,
    };
  }

  const finishedAt = new Date().toISOString();
  const report = summarize({
    steps,
    run: {
      run_id: runId,
      started_at: startedAt,
      finished_at: finishedAt,
      target: target.baseUrl,
      env: target.envName,
      ready_status: readyResponse.status,
      admin_status: statusResponse.status,
    },
  });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `seed-env: ${target.envName} (${target.baseUrl}) ready=${report.run.ready_status} admin=${report.run.admin_status}`,
    );
    for (const [name, count] of Object.entries(report.counts)) {
      console.log(
        `  ${name}: created=${count.created} kept=${count.kept} skipped=${count.skipped} failed=${count.failed}` +
          (count.owner_action ? ` owner_action="${count.owner_action}"` : "") +
          (count.reason ? ` (${count.reason})` : ""),
      );
    }
  }

  // Print the full report first, then exit 3 - a partial seed with no counts is worse than a
  // complete one that names what failed.
  const anyFailed = Object.values(report.counts).some((count) => count.failed > 0);
  if (anyFailed) process.exit(3);
}

function readNdjson(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

if (process.argv[1]?.endsWith("seed-env.mjs")) {
  main().catch((error) => {
    console.error(error instanceof SeedGuardError ? `refused: ${error.message}` : String(error?.stack ?? error));
    process.exit(writeAttempted ? 3 : 1);
  });
}
