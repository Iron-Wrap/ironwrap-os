import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { mintToken, seedOwnerSql } from "../../tools/qa-seed-owner.mjs";
import { PROVIDER, runJourney } from "../../tools/seed-qa-journey.mjs";
import worker from "../src/index.ts";
import { SqliteD1, type SqliteStatement, env as baseEnv } from "./company-setup-fixture.ts";
import { MemoryR2 } from "./onboarding-fixture.ts";

// The QA seed's bodies run through the real Worker entry point on SQLite: sign-in with the minted
// single-use link, every commercial route, the effect claim/settle admin routes and the queue.
// Synthetic only: example.invalid identities and a policy window around the run.
const ORIGIN = "https://qa.example.invalid";
const PRODUCTION_ORIGIN = "https://app.example.invalid";
const EFFECT_TOKEN = "synthetic-effect-runtime-token-0123456789abcdef";
const CUSTOMER_TESTER = "customer-tester@example.invalid";
const ACCOUNTING_TESTER = "accounting-tester@example.invalid";
const DAY = 86_400_000;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const policy = (validFrom: number, validUntil: number) =>
  JSON.stringify({
    schema_version: "ironwrap.commercial-authority-policy.v1",
    policy_id: "qa-synthetic-commercial-policy",
    policy_version: "v1",
    tenant_id: "ironwrap",
    status: "active",
    valid_from: new Date(validFrom).toISOString(),
    valid_until: new Date(validUntil).toISOString(),
    max_fact_age_seconds: 600,
    max_permit_lifetime_seconds: 300,
    allowed_actions: ["lead.triage.record", "quote.revision.record", "proposal.revision.record", "proposal.publish", "proposal.withdraw"],
    allowed_actor_types: ["owner", "worker"],
    max_quote_total_cents: 10_000_000,
  });

/** D1's batch answers with `{ meta: { changes } }` per statement, as the effect lease claim reads it. */
class D1ShapedSqlite extends SqliteD1 {
  override async batch(statements: SqliteStatement[]): Promise<unknown[]> {
    const results = (await super.batch(statements)) as Array<{ changes?: number | bigint }>;
    return results.map((result) => ({ success: true, meta: { changes: Number(result.changes ?? 0) } }));
  }
}

function harness() {
  const db = new D1ShapedSqlite();
  const queue: unknown[] = [];
  const policyJson = policy(Date.now() - DAY, Date.now() + 365 * DAY);
  const env = baseEnv(db, {
    RAW: new MemoryR2() as never,
    JN_QUEUE: {
      send: async (message: unknown) => void queue.push(message),
      sendBatch: async (messages: Array<{ body: unknown }>) => void queue.push(...messages.map((m) => m.body)),
    } as never,
    APP_PUBLIC_ORIGIN: ORIGIN,
    APP_ALLOWED_ORIGINS: ORIGIN,
    APP_AUTH_PEPPER: "qa-seed-journey-test-pepper-longer-than-thirty-two-characters",
    APP_CUSTOMER_PORTAL_ENABLED: "true",
    EFFECT_RUNTIME_ENABLED: "true",
    EFFECT_RUNTIME_TOKEN: EFFECT_TOKEN,
    JOBNIMBUS_ENABLED: "false",
    OWNER_ALERT_EMAIL: "owner@example.invalid",
    FROM_EMAIL: "office@example.invalid",
    // Mail is configured the way qa configures it, so a send would be attempted; the outbound
    // fetch guard in the journey test proves none is.
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "service@example.invalid", private_key: "synthetic" }),
    COMMERCIAL_AUTHORITY_POLICY_JSON: policyJson,
  } as never);
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const config = {
    qa: { APP_PUBLIC_ORIGIN: ORIGIN, APP_ALLOWED_ORIGINS: ORIGIN, COMMERCIAL_AUTHORITY_POLICY_JSON: policyJson },
    production: { APP_PUBLIC_ORIGIN: PRODUCTION_ORIGIN, APP_ALLOWED_ORIGINS: PRODUCTION_ORIGIN },
  };
  const calls: string[] = [];
  const fetchImpl = async (url: URL, init: RequestInit) => {
    calls.push(`${init.method} ${url.pathname}`);
    const headers = new Headers(init.headers);
    headers.set("cf-connecting-ip", "203.0.113.30");
    return await worker.fetch(new Request(url, { ...init, headers }), env as never, ctx as never);
  };
  const drainQueue = async () => {
    const messages = queue.splice(0).map((body) => ({ body, ack() {}, retry() { throw new Error("queue_retry_unexpected"); } }));
    if (messages.length) await worker.queue({ queue: "ironwrap-jobs", messages } as never, env as never, ctx as never);
  };
  const mint = () => {
    const token = mintToken();
    db.raw.exec(seedOwnerSql({ tokenHash: sha256(token) }));
    return token;
  };
  const count = (sql: string) => (db.raw.prepare(sql).get() as { n: number }).n;
  return { db, env, config, calls, fetchImpl, drainQueue, mint, count };
}

function run(h: ReturnType<typeof harness>, out: string, overrides: Record<string, unknown> = {}) {
  return runJourney({
    baseUrl: ORIGIN,
    config: h.config,
    seedToken: h.mint(),
    effectToken: EFFECT_TOKEN,
    customerTester: CUSTOMER_TESTER,
    accountingTester: ACCOUNTING_TESTER,
    fetchImpl: h.fetchImpl,
    waitForIntake: h.drainQueue,
    out,
    ...overrides,
  });
}

test("the seed publishes one synthetic offer through the governed routes, and a second run creates nothing", async () => {
  const h = harness();
  const out = mkdtempSync(join(tmpdir(), "qa-seed-journey-"));
  const outbound = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("the seed journey must not reach any outside service");
  }) as typeof fetch;
  try {
    const first = await run(h, out);
    assert.equal(first.offer_state, "published");
    assert.deepEqual(
      first.steps.map((step: { step: string; created: boolean }) => [step.step, step.created]),
      [
        ["office_lead", true],
        ["triage", true],
        ["quote", true],
        ["proposal", true],
        ["publication", true],
        ["portal_link", true],
        ["accounting_tester", true],
      ],
    );
    assert.equal(first.created, 7);
    // Nothing secret leaves the run: the summary names ids and counts only.
    assert.doesNotMatch(JSON.stringify(first), /portal#token|__Host-|csrf/);
    const link = JSON.parse(readFileSync(join(out, "portal-link.json"), "utf8"));
    assert.match(link.portal_url, /^https:\/\/qa\.example\.invalid\/portal#token=[A-Za-z0-9_-]{43}$/);
    assert.equal(statSync(join(out, "portal-link.json")).mode & 0o777, 0o600);

    assert.equal(h.count(`SELECT count(*) AS n FROM external_effects WHERE provider = '${PROVIDER}' AND state = 'succeeded'`), 1);
    assert.equal(h.count("SELECT count(*) AS n FROM commercial_proposal_publication_events WHERE state = 'published'"), 1);
    assert.equal(h.count("SELECT count(*) AS n FROM app_users WHERE email_normalized = 'accounting-tester@example.invalid' AND access_role = 'accounting'"), 1);
    // The seed owner signed out: no live session is left behind.
    assert.equal(h.count("SELECT count(*) AS n FROM app_sessions WHERE revoked_at IS NULL"), 0);

    const second = await run(h, out);
    assert.equal(second.offer_state, "published");
    assert.equal(second.created, 0);
    assert.equal(second.roof_job_id, first.roof_job_id);
    assert.equal(h.count("SELECT count(*) AS n FROM commercial_proposal_publication_events"), 1);
    assert.equal(h.count("SELECT count(*) AS n FROM commercial_quote_revisions"), 1);
    assert.ok(h.calls.every((call) => !/acceptance|approve|quickbooks|field-evidence|evidence-uploads/.test(call)));
  } finally {
    globalThis.fetch = outbound;
  }
});

test("the seed refuses before any request when the target is not qa or the qa window has lapsed", async () => {
  const h = harness();
  const out = mkdtempSync(join(tmpdir(), "qa-seed-journey-"));
  await assert.rejects(run(h, out, { baseUrl: PRODUCTION_ORIGIN }), { code: "target_not_qa" });
  await assert.rejects(run(h, out, { baseUrl: "https://elsewhere.example.invalid" }), { code: "target_not_qa" });
  const lapsed = { ...h.config, qa: { ...h.config.qa, COMMERCIAL_AUTHORITY_POLICY_JSON: policy(Date.now() - 2 * DAY, Date.now() - DAY) } };
  await assert.rejects(run(h, out, { config: lapsed }), { code: "policy_expired" });
  const missing = { ...h.config, qa: { ...h.config.qa, COMMERCIAL_AUTHORITY_POLICY_JSON: "" } };
  await assert.rejects(run(h, out, { config: missing }), { code: "policy_missing" });
  assert.deepEqual(h.calls, []);
});

test("a used or missing sign-in link stops the seed with a clear refusal and no writes", async () => {
  const h = harness();
  const out = mkdtempSync(join(tmpdir(), "qa-seed-journey-"));
  await assert.rejects(run(h, out, { seedToken: mintToken() }), { code: "seed_sign_in_refused" });
  await assert.rejects(run(h, out, { seedToken: "" }), { code: "seed_sign_in_refused" });
  assert.equal(h.count("SELECT count(*) AS n FROM commercial_quote_revisions"), 0);
});
