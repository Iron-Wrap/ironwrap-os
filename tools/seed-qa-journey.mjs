#!/usr/bin/env node
// QA only. Drives one synthetic commercial journey through the governed Worker routes, as the QA
// seed owner signed in with its own single-use link (tools/qa-seed-owner.mjs). Nothing is written
// to D1 directly and no route is bypassed:
//
//   sign in -> sales desk (policy visible?) -> office lead for the customer tester (no mail)
//   -> triage qualified -> approved quote -> proposal -> publication (prepare, synthetic effect
//   claim and settle, record) -> customer portal link (written to output/, never printed)
//   -> the accounting tester as an app user -> sign out
//
// Every write reads the job's commercial context first and only does what is still missing, with
// idempotency keys under synth-seed-qa:, so a second run creates nothing. Customer acceptance, the
// deposit and its approval stay with people. The seed refuses to run anywhere but qa, refuses any
// route outside its allowlist, and refuses any identity other than example.invalid and the two
// named testers.
//
// Usage (QA_SEED_MAGIC_LINK_TOKEN from tools/qa-seed-owner.mjs, EFFECT_RUNTIME_TOKEN, both from the
// release env file, never on the command line):
//   node tools/seed-qa-journey.mjs --base-url https://<qa origin> \
//     --customer-tester <email> --accounting-tester <email> [--out output/seed-env/qa]

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { stripJsonComments } from "./generate-tenant-worker-config.mjs";
import { flattenWranglerVars } from "./wrangler-vars.mjs";

const TENANT = "ironwrap";
export const PROVIDER = "qa-synthetic-publication";
export const MAX_SEED_TOTAL_CENTS = 250_000;
const KEY_PREFIX = "synth-seed-qa";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TERMS = {
  deposit_percent: 25,
  payment_schedule: ["deposit", "completion"],
  payment_terms_days: 30,
  warranty_years: 10,
};
const ALLOWED_ROUTES = [
  /^POST \/api\/v1\/auth\/magic-link\/consume$/,
  /^POST \/api\/v1\/auth\/logout$/,
  /^GET \/api\/v1\/sales$/,
  /^POST \/api\/v1\/sales\/leads\?include_receipt=1$/,
  /^GET \/api\/v1\/sales\/intakes\/[^/]+$/,
  /^GET \/api\/v1\/jobs\/[^/]+\/commercial-context$/,
  /^POST \/api\/v1\/commercial\/lead-triage-decisions$/,
  /^POST \/api\/v1\/commercial\/quote-revisions$/,
  /^POST \/api\/v1\/commercial\/proposal-revisions$/,
  /^POST \/api\/v1\/commercial\/proposal-publications\/prepare$/,
  /^POST \/api\/v1\/commercial\/proposal-publications$/,
  /^POST \/admin\/effects\/(claim|settle)$/,
  /^POST \/api\/v1\/customer-portal\/links$/,
  /^GET \/api\/v1\/admin\/app-users$/,
  /^POST \/api\/v1\/admin\/app-users$/,
];

export class SeedRefusal extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** A uuid-v4-shaped value that is the same for the same input, for keys that must be uuids. */
function stableUuid(input) {
  const hex = sha256(input);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function loadQaConfig(path = join(ROOT, "workers-bus", "wrangler.jsonc")) {
  const source = stripJsonComments(readFileSync(path, "utf8")).replace(/,(\s*[}\]])/g, "$1");
  const config = JSON.parse(source);
  return { qa: flattenWranglerVars(config.env.qa.vars), production: flattenWranglerVars(config.vars) };
}

const origins = (vars) =>
  [vars.APP_PUBLIC_ORIGIN, ...String(vars.APP_ALLOWED_ORIGINS ?? "").split(",")]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .map((value) => new URL(value).origin);

/** The target must be one of qa's own origins and none of production's. */
export function assertQaTarget(baseUrl, config) {
  const origin = new URL(baseUrl).origin;
  if (origins(config.production).includes(origin)) throw new SeedRefusal("target_not_qa", origin);
  if (!origins(config.qa).includes(origin)) throw new SeedRefusal("target_not_qa", origin);
  return origin;
}

/** Stops before the first write when the synthetic qa policy is absent or its window has lapsed. */
export function assertPolicyWindow(config, now) {
  const raw = config.qa.COMMERCIAL_AUTHORITY_POLICY_JSON;
  if (!raw) throw new SeedRefusal("policy_missing", "qa carries no COMMERCIAL_AUTHORITY_POLICY_JSON");
  const policy = JSON.parse(raw);
  const at = now.getTime();
  if (at < Date.parse(policy.valid_from) || at >= Date.parse(policy.valid_until))
    throw new SeedRefusal(
      "policy_expired",
      "renew the qa window in workers-bus/wrangler.jsonc (valid_from/valid_until)",
    );
  return policy;
}

export function assertSeedIdentity(email, testers) {
  const value = String(email ?? "").toLowerCase();
  if (value.endsWith("@example.invalid") || testers.includes(value)) return value;
  throw new SeedRefusal("identity_not_synthetic", "only example.invalid and the named testers");
}

function lineTotal(line) {
  return Math.round((line.quantity_micros * line.unit_price_cents) / 1_000_000) + line.tax_cents;
}

export function journeyIds(roofJobId) {
  const base = `${KEY_PREFIX}:${sha256(`${TENANT}:${roofJobId}`).slice(0, 16)}`;
  return {
    base,
    quoteRevisionId: `${base}:quote-revision:1`,
    customerQuoteId: `${base}:customer-quote`,
    proposalRevisionId: `${base}:proposal-revision:1`,
    proposalPackId: `${base}:proposal-pack`,
  };
}

export function officeLeadBody(customerTester) {
  return {
    name: "Synthetic QA Customer (synth-seed)",
    email: customerTester,
    address: "1 Synth Seed Way",
    city: "Calgary",
    province: "AB",
    postal_code: "T2P 1J9",
    service: "Roof replacement",
    message: "Synthetic QA seed journey (synth-seed). Not customer data.",
    intake_source: "phone",
  };
}

export function triageBody(lead) {
  return {
    lead_id: lead.id,
    expected_lead_version: lead.triage.version,
    lifecycle_status: "qualified",
    priority: "normal",
    category: "synthetic-qa",
    summary: "Synthetic QA seed lead (synth-seed); not customer data.",
    next_action: "Prepare the synthetic QA quote.",
  };
}

export function quoteBody(ids, job, factsObservedAt, now) {
  const lines = [
    {
      line_id: "synth-seed:scope",
      sequence: 1,
      kind: "labour",
      description: "Synthetic QA roofing scope (synth-seed)",
      quantity_micros: 1_000_000,
      uom: "job",
      unit_price_cents: 100_000,
      tax_code: "GST",
      tax_cents: 5_000,
    },
  ];
  const total = lines.reduce((sum, line) => sum + lineTotal(line), 0);
  if (total > MAX_SEED_TOTAL_CENTS) throw new SeedRefusal("seed_amount_ceiling", String(total));
  return {
    quote_revision_id: ids.quoteRevisionId,
    customer_quote_id: ids.customerQuoteId,
    revision_number: 1,
    roof_job_id: job.roofJobId,
    customer_id: job.customerId,
    facts_observed_at: factsObservedAt,
    supersedes_quote_revision_id: null,
    status: "approved",
    currency: "CAD",
    valid_until: new Date(now.getTime() + 90 * 86_400_000).toISOString().slice(0, 10),
    terms: TERMS,
    correction_reason: null,
    lines,
    evidence: [evidence(ids, "quote-basis", lines)],
  };
}

export function proposalBody(ids, job, factsObservedAt) {
  const summary = "Synthetic QA proposal for the synth-seed journey. Not a customer offer.";
  return {
    proposal_revision_id: ids.proposalRevisionId,
    proposal_pack_id: ids.proposalPackId,
    revision_number: 1,
    quote_revision_id: ids.quoteRevisionId,
    roof_job_id: job.roofJobId,
    customer_id: job.customerId,
    facts_observed_at: factsObservedAt,
    title: "Synthetic QA proposal (synth-seed)",
    summary,
    terms: TERMS,
    content_ref: `synth-seed://qa-journey/${ids.base}/proposal.pdf`,
    content_hash: sha256(`${ids.base}:${summary}`),
    evidence: [evidence(ids, "proposal-basis", summary)],
  };
}

function evidence(ids, label, value) {
  return { ref: `synth-seed://qa-journey/${ids.base}/${label}`, sha256: sha256(JSON.stringify(value)) };
}

function publication(ids) {
  return {
    proposal_revision_id: ids.proposalRevisionId,
    proposal_pack_id: ids.proposalPackId,
    publication_version: 1,
    previous_state: "draft",
    state: "published",
  };
}

export function prepareBody(ids, factsObservedAt) {
  return { ...publication(ids), facts_observed_at: factsObservedAt, evidence: [evidence(ids, "publication", publication(ids))] };
}

export function claimBody(ids, permit, attempt) {
  const expected = publication(ids);
  const authority = { permitRef: permit.permit_id, policyRef: permit.policy_ref, policyVersion: permit.policy_version };
  return {
    effect: {
      tenantId: TENANT,
      actor: { type: permit.actor_type, id: permit.actor_id },
      taskId: `${ids.base}:publish:${attempt}`,
      authority,
      aggregate: { type: "proposal_publication", id: ids.proposalPackId, version: 1 },
      intentId: ids.proposalRevisionId,
      action: "proposal.publish",
      request: expected,
      provider: PROVIDER,
      providerAccountRef: TENANT,
      idempotencyKey: `${ids.base}:publish-effect:${attempt}`,
      deadlineAt: new Date(Date.parse(permit.expires_at) - 1_000).toISOString(),
      preconditions: {},
      evidenceRefs: [evidence(ids, "publication", expected).ref],
      expectedReadback: expected,
      correlationId: `${ids.base}:publish:${attempt}`,
    },
    authority: {
      ...authority,
      tenantId: TENANT,
      actorType: permit.actor_type,
      actorId: permit.actor_id,
      expiresAt: permit.expires_at,
      allowedActions: ["proposal.publish"],
    },
  };
}

export function settleBody(ids, effectId, attemptId) {
  return {
    effectId,
    settlement: {
      attemptId,
      outcome: "accepted",
      providerExternalId: `${ids.base}:published`,
      readback: { status: "match", observed: publication(ids) },
    },
  };
}

export function publicationBody(ids, permitId, effectId) {
  return { ...publication(ids), permit_id: permitId, external_effect_id: effectId };
}

/** A small HTTP client that only ever calls the routes in ALLOWED_ROUTES. */
function client({ baseUrl, origin, fetchImpl }) {
  let cookie = null;
  let csrf = null;
  async function call(method, path, { body, key, bearer } = {}) {
    if (!ALLOWED_ROUTES.some((route) => route.test(`${method} ${path}`)))
      throw new SeedRefusal("route_not_allowed", `${method} ${path.split("?")[0]}`);
    const headers = { "content-type": "application/json", origin };
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    else if (cookie) headers.cookie = cookie;
    if (csrf && method !== "GET" && !bearer) headers["x-csrf-token"] = csrf;
    if (key) headers["idempotency-key"] = key;
    const response = await fetchImpl(new URL(path, baseUrl), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, json, headers: response.headers };
  }
  return {
    call,
    async signIn(token) {
      const response = await call("POST", "/api/v1/auth/magic-link/consume", { body: { token } });
      const setCookie = response.headers.get("set-cookie") ?? "";
      const session = setCookie.match(/__Host-ironwrap_session=([A-Za-z0-9_-]{43})/)?.[1];
      if (response.status !== 200 || !session || !response.json?.csrf_token)
        throw new SeedRefusal("seed_sign_in_refused", "mint a fresh link with tools/qa-seed-owner.mjs");
      cookie = `__Host-ironwrap_session=${session}`;
      csrf = response.json.csrf_token;
      return response.json;
    },
    async signOut() {
      if (cookie) await call("POST", "/api/v1/auth/logout", { body: {} }).catch(() => undefined);
      cookie = null;
      csrf = null;
    },
  };
}

function expectStatus(step, response, ...statuses) {
  if (statuses.includes(response.status)) return response.json;
  const code = response.json?.error ?? `http_${response.status}`;
  if (code === "commercial_policy_not_current") throw new SeedRefusal("policy_expired", step);
  throw new SeedRefusal(`${step}_refused`, code);
}

/**
 * Runs the journey. Returns counts and ids only; the portal URL goes to `out` (mode 600) and no
 * secret or URL is ever returned or printed.
 */
export async function runJourney({
  baseUrl,
  config,
  seedToken,
  effectToken,
  customerTester,
  accountingTester,
  fetchImpl = fetch,
  now = () => new Date(),
  waitForIntake = () => new Promise((done) => setTimeout(done, 3_000)),
  out = null,
}) {
  const origin = assertQaTarget(baseUrl, config);
  assertPolicyWindow(config, now());
  const testers = [customerTester, accountingTester].map((value) => String(value ?? "").toLowerCase());
  if (testers.some((value) => !value.includes("@"))) throw new SeedRefusal("testers_required");
  if (!seedToken) throw new SeedRefusal("seed_sign_in_refused", "QA_SEED_MAGIC_LINK_TOKEN is not set");
  if (!effectToken) throw new SeedRefusal("effect_token_missing", "EFFECT_RUNTIME_TOKEN is not set");

  const api = client({ baseUrl, origin, fetchImpl });
  const steps = [];
  const done = (step, created) => steps.push({ step, created });
  const who = await api.signIn(seedToken);
  try {
    if (who.user?.role !== "owner" || who.tenant?.id !== TENANT)
      throw new SeedRefusal("seed_session_not_owner");
    assertSeedIdentity(who.user?.email, []);

    const sales = expectStatus("sales", await api.call("GET", "/api/v1/sales"), 200);
    if (!(sales.allowed_actions ?? []).includes("commercial.lead_triage.record"))
      throw new SeedRefusal("policy_not_visible", "the sales desk does not offer commercial triage");

    // The customer tester's lead, captured as an office lead with no acknowledgement mail.
    const customer = assertSeedIdentity(customerTester, testers);
    const intakeKey = `office-lead:${stableUuid(`${KEY_PREFIX}:customer:${customer}`)}`;
    const intakePath = `/api/v1/sales/intakes/${encodeURIComponent(intakeKey)}`;
    const earlier = await api.call("GET", intakePath);
    const intake =
      earlier.status === 200
        ? earlier.json
        : expectStatus(
            "office_lead",
            await api.call("POST", "/api/v1/sales/leads?include_receipt=1", { body: officeLeadBody(customer), key: intakeKey }),
            200,
          );
    done("office_lead", earlier.status !== 200);
    let leadId = intake.receipt?.lead_id ?? null;
    for (let attempt = 0; !leadId && attempt < 20; attempt += 1) {
      await waitForIntake();
      const read = expectStatus("intake", await api.call("GET", intakePath), 200);
      leadId = read.receipt?.lead_id ?? null;
    }
    if (!leadId) throw new SeedRefusal("intake_not_materialized", "the lead did not appear; run again");

    const leadOf = async () =>
      expectStatus("sales", await api.call("GET", "/api/v1/sales"), 200).leads.find((lead) => lead.id === leadId);
    let lead = await leadOf();
    if (!lead?.job?.id) throw new SeedRefusal("lead_without_job", leadId);
    assertSeedIdentity(lead.contact?.email, testers);
    const roofJobId = lead.job.id;
    const ids = journeyIds(roofJobId);
    const context = async () =>
      expectStatus(
        "commercial_context",
        await api.call("GET", `/api/v1/jobs/${encodeURIComponent(roofJobId)}/commercial-context`),
        200,
      );

    const triageStatus = String(lead.triage?.status ?? "").toLowerCase();
    if (triageStatus === "untriaged" || triageStatus === "triaged") {
      expectStatus(
        "triage",
        await api.call("POST", "/api/v1/commercial/lead-triage-decisions", { body: triageBody(lead), key: `${ids.base}:triage:1` }),
        200,
        201,
      );
      done("triage", true);
      lead = await leadOf();
    } else if (triageStatus !== "qualified") {
      throw new SeedRefusal("lead_not_qualifiable", triageStatus);
    }

    let published = false;
    for (let round = 0; round < 5; round += 1) {
      const ctx = await context();
      const state = ctx.offer?.state;
      const job = { roofJobId, customerId: ctx.source_binding?.customer_id };
      const factsAt = ctx.source_binding?.generated_at ?? ctx.generated_at ?? now().toISOString();
      if (state === "published") break;
      if (state === "no_quote") {
        expectStatus(
          "quote",
          await api.call("POST", "/api/v1/commercial/quote-revisions", { body: quoteBody(ids, job, factsAt, now()), key: `${ids.base}:quote:1` }),
          200,
          201,
        );
        done("quote", true);
      } else if (state === "proposal_missing") {
        expectStatus(
          "proposal",
          await api.call("POST", "/api/v1/commercial/proposal-revisions", { body: proposalBody(ids, job, factsAt), key: `${ids.base}:proposal:1` }),
          200,
          201,
        );
        done("proposal", true);
      } else if (state === "not_published") {
        // A permit lives about 30 s, so prepare, claim, settle and record run back to back, each
        // attempt under its own keys; a lapsed attempt is simply superseded by the next run.
        const attempt = now().getTime();
        const prepared = expectStatus(
          "publication_prepare",
          await api.call("POST", "/api/v1/commercial/proposal-publications/prepare", {
            body: prepareBody(ids, factsAt),
            key: `${ids.base}:publish-prepare:${attempt}`,
          }),
          200,
          201,
        );
        const permit = prepared.permit;
        const claimed = expectStatus(
          "publication_claim",
          await api.call("POST", "/admin/effects/claim", { body: claimBody(ids, permit, attempt), bearer: effectToken }),
          200,
        );
        expectStatus(
          "publication_settle",
          await api.call("POST", "/admin/effects/settle", {
            body: settleBody(ids, claimed.effect.effect_id, claimed.attempt.attempt_id),
            bearer: effectToken,
          }),
          200,
        );
        expectStatus(
          "publication",
          await api.call("POST", "/api/v1/commercial/proposal-publications", {
            body: publicationBody(ids, permit.permit_id, claimed.effect.effect_id),
            key: `${ids.base}:publication:${attempt}`,
          }),
          200,
          201,
        );
        done("publication", true);
        published = true;
      } else {
        throw new SeedRefusal("offer_state_unexpected", String(state));
      }
    }
    if ((await context()).offer?.state !== "published") throw new SeedRefusal("offer_not_published");

    // A portal link is issued only when this run published, so a second run leaves the live
    // link alone. Its URL goes to a mode-600 file and is never printed.
    if (published) {
      const link = expectStatus(
        "portal_link",
        await api.call("POST", "/api/v1/customer-portal/links", {
          body: { roof_job_id: roofJobId, expires_at: new Date(now().getTime() + 7 * 86_400_000).toISOString() },
        }),
        200,
      );
      if (out) writePrivate(join(out, "portal-link.json"), { roof_job_id: roofJobId, portal_url: link.portal_url, expires_at: link.link?.expires_at });
      done("portal_link", true);
    }

    // The second accounting person approves deposits; seeded as a person, never as a credential.
    const accountant = assertSeedIdentity(accountingTester, testers);
    const people = expectStatus("app_users", await api.call("GET", "/api/v1/admin/app-users"), 200);
    const listed = (people.users ?? []).some((user) => String(user.email).toLowerCase() === accountant);
    if (!listed) {
      expectStatus(
        "accounting_tester",
        await api.call("POST", "/api/v1/admin/app-users", {
          body: { tenant_id: TENANT, email: accountant, display_name: "QA Accounting Tester (synthetic)", role: "accounting", active: true },
        }),
        200,
      );
    }
    done("accounting_tester", !listed);

    return {
      lead_id: leadId,
      roof_job_id: roofJobId,
      offer_state: "published",
      created: steps.filter((step) => step.created).length,
      steps,
    };
  } finally {
    await api.signOut();
  }
}

function writePrivate(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function parseArgs(argv) {
  const args = { out: "output/seed-env/qa" };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--base-url") args.baseUrl = value;
    else if (flag === "--customer-tester") args.customerTester = value;
    else if (flag === "--accounting-tester") args.accountingTester = value;
    else if (flag === "--out") args.out = value;
    else throw new SeedRefusal("unknown_argument", flag);
    i += 1;
  }
  if (!args.baseUrl) throw new SeedRefusal("base_url_required");
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    const summary = await runJourney({
      baseUrl: args.baseUrl,
      config: loadQaConfig(),
      seedToken: process.env.QA_SEED_MAGIC_LINK_TOKEN,
      effectToken: process.env.EFFECT_RUNTIME_TOKEN,
      customerTester: args.customerTester,
      accountingTester: args.accountingTester,
      out: resolve(ROOT, args.out),
    });
    console.log(JSON.stringify(summary));
  } catch (error) {
    console.error(JSON.stringify({ refused: error.code ?? "seed_failed", detail: error.message }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
