import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { claimBody, journeyIds, settleBody } from "../../tools/seed-qa-journey.mjs";
import type { AppEnv } from "../src/app-types.ts";
import { recordProposalDeliveryConfirmation } from "../src/commercial-store.ts";
import {
  EFFECT_ATTEMPT_LEASE_MS,
  adapterAuthority,
  authorizeExternalEffect,
  claimExternalEffect,
  executeExternalEffect,
  proposeExternalEffect,
  reconcileExternalEffect,
  recoverExpiredExternalEffect,
  retryExternalEffect,
  runExternalEffect,
  type EffectAuthority,
  type ExternalEffectRequest,
} from "../src/effect-runtime.ts";
import worker from "../src/index.ts";
import { SqliteD1, TENANT, USERS, type SqliteStatement } from "./company-setup-fixture.ts";

// PR-S (0164): the effect-runtime bearer never claims, settles, reconciles or retries a send to
// someone outside the business, a QA stand-in provider passes only on a synthetic Worker, a
// proposal send runs once, and an unknown proposal send moves on only with a person's record.
// Every route call goes through the Worker's own fetch handler, so the bearer is exercised; the D1
// rules are driven by raw SQL and by the in-process runtime against the full migration chain.

const TOKEN = "outside-send-guards-effect-runtime-token-0123456789abcdef";
const REAL_PROVIDER = "native-commercial-publication";
const QA_PROVIDER = "qa-synthetic-publication";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** D1 answers a batch with `{ meta: { changes } }` per statement, as the lease claim reads it. */
class D1 extends SqliteD1 {
  constructor() {
    super({ seedUsers: ["owner", "ops"] });
  }

  override async batch(statements: SqliteStatement[]): Promise<unknown[]> {
    const results = (await super.batch(statements)) as Array<{ changes?: number | bigint }>;
    return results.map((result) => ({ success: true, meta: { changes: Number(result.changes ?? 0) } }));
  }
}

/** A Worker on `db`; `dataClass` is AGENT_DATA_CLASS, left unset when undefined. */
function workerEnv(db: D1, dataClass?: string): AppEnv {
  return {
    DB: db,
    APP_TENANT_ID: TENANT,
    EFFECT_RUNTIME_ENABLED: "true",
    EFFECT_RUNTIME_TOKEN: TOKEN,
    ...(dataClass === undefined ? {} : { AGENT_DATA_CLASS: dataClass }),
  } as unknown as AppEnv;
}

async function post(env: AppEnv, route: "claim" | "settle" | "reconcile" | "retry", body: unknown) {
  const response = await worker.fetch(
    new Request(`https://bus.example.invalid/admin/effects/${route}`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env as never,
    {} as never,
  );
  return { status: response.status, body: await response.json() as Record<string, any> };
}

const deadline = () => new Date(Date.now() + 30 * 60_000).toISOString();

/** A claim envelope as an outside caller writes it, with an authority that names no permit. */
function envelope(
  id: string,
  options: { action?: string; provider?: string; retryLimit?: number; maxAttempts?: number; expectedReadback?: unknown } = {},
) {
  const action = options.action ?? "proposal.publish";
  const deadlineAt = deadline();
  const binding = { permitRef: `synthetic-authority:${id}`, policyRef: "synthetic-outside-send", policyVersion: "v1" };
  const request = { proposal_revision_id: `proposal-revision:${id}`, proposal_pack_id: `proposal-pack:${id}`, state: "published" };
  return {
    effect: {
      effectId: `effect:outside-send:${id}`,
      tenantId: TENANT,
      actor: { type: "worker" as const, id: USERS.ops },
      taskId: `task:${id}`,
      authority: binding,
      aggregate: action.startsWith("proposal.")
        ? { type: "proposal_publication", id: `proposal-pack:${id}`, version: 1 }
        : { type: "communication", id: `communication:${id}`, version: 0 },
      intentId: `proposal-revision:${id}`,
      action,
      request,
      provider: options.provider ?? REAL_PROVIDER,
      idempotencyKey: `outside-send:${id}`,
      deadlineAt,
      expectedReadback: options.expectedReadback ?? request,
      ...(options.retryLimit === undefined ? {} : { retryLimit: options.retryLimit }),
      correlationId: `correlation:${id}`,
    },
    authority: {
      ...binding,
      tenantId: TENANT,
      actorType: "worker" as const,
      actorId: USERS.ops,
      expiresAt: deadlineAt,
      allowedActions: [action],
      ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    },
  };
}

/** Propose, authorize and claim in the bus itself, as an in-bus executor does. */
async function busClaim(env: AppEnv, id: string, options: Parameters<typeof envelope>[1] = {}) {
  const { effect, authority } = envelope(id, options);
  const proposed = await proposeExternalEffect(env, effect as ExternalEffectRequest);
  await authorizeExternalEffect(env, proposed.effect_id, authority as EffectAuthority);
  return await claimExternalEffect(env, proposed.effect_id);
}

/** Run one send in the bus: lost (unknown), refused by the provider, read back wrong, or accepted. */
async function busSend(
  env: AppEnv,
  id: string,
  mode: "lost" | "refused" | "conflict" | "accepted",
  options: Parameters<typeof envelope>[1] = {},
) {
  const { effect, authority } = envelope(id, options);
  return await runExternalEffect(env, { ...effect, authority } as never, {
    async dispatch() {
      if (mode === "lost") throw new Error("synthetic_provider_response_lost");
      if (mode === "refused") return { outcome: "rejected" as const, detailCode: "provider_refused" };
      return {
        outcome: "accepted" as const,
        providerExternalId: `provider:${id}`,
        readback: { status: "match" as const, observed: mode === "conflict" ? { ...effect.request, state: "withdrawn" } : effect.request },
      };
    },
    async replay() {
      return {};
    },
  });
}

const count = (db: D1, sql: string, ...args: Array<string | number>) =>
  Number((db.raw.prepare(sql).get(...args) as { n: number }).n);
const effectRow = (db: D1, effectId: string) =>
  ({ ...db.raw.prepare("SELECT * FROM external_effects WHERE effect_id = ?").get(effectId) });
const stateOf = (db: D1, effectId: string) => effectRow(db, effectId).state;
const events = (db: D1, effectId: string) =>
  count(db, "SELECT count(*) AS n FROM external_effect_events WHERE effect_id = ?", effectId);

/** One `external_effects` row written straight to D1, outside the runtime. */
function insertEffect(db: D1, id: string, action: string, retryLimit: number): void {
  const now = new Date().toISOString();
  db.raw.prepare(
    `INSERT INTO external_effects (
       effect_id, tenant_id, actor_type, actor_id, task_id, authority_ref, policy_ref,
       policy_version, aggregate_type, aggregate_id, aggregate_version, intent_id, action,
       request_hash, envelope_hash, provider, provider_account_ref, idempotency_key, deadline_at,
       preconditions_json, evidence_refs_json, expected_readback_json, retry_limit,
       compensation_plan_json, correlation_id, parent_effect_id, compensates_effect_id,
       state, attempt_count, created_at, updated_at
     ) VALUES (?, ?, 'worker', ?, ?, ?, 'synthetic-outside-send', 'v1', ?, ?, 1, ?, ?, ?, ?, ?, NULL,
               ?, ?, '{}', '[]', '{}', ?, '{}', ?, NULL, NULL, 'proposed', 0, ?, ?)`,
  ).run(
    `effect:outside-send:${id}`, TENANT, USERS.ops, `task:${id}`, `synthetic-authority:${id}`,
    action.startsWith("proposal.") ? "proposal_publication" : "communication", `aggregate:${id}`,
    `intent:${id}`, action, "a".repeat(64), "b".repeat(64),
    action.startsWith("proposal.") ? REAL_PROVIDER : "gmail", `outside-send:${id}`, deadline(), retryLimit,
    `correlation:${id}`, now, now,
  );
}

const moveTo = (db: D1, effectId: string, state: string, at = new Date().toISOString()) =>
  db.raw.prepare("UPDATE external_effects SET state = ?, updated_at = ? WHERE effect_id = ?")
    .run(state, at, effectId);
/** Past the default late-answer window (0161), so a refusal there is this file's rule alone. */
const afterLateAnswerWindow = () => new Date(Date.now() + EFFECT_ATTEMPT_LEASE_MS + 1_000).toISOString();

// ---------------------------------------------------------------------------------------------
// The routes

test("the token is refused for a real provider's proposal send on every data class, and nothing is written", async () => {
  for (const dataClass of ["business", "synthetic", undefined, "Business", "", "synthetic-qa"]) {
    const db = new D1();
    for (const action of ["proposal.publish", "proposal.withdraw"]) {
      const answer = await post(workerEnv(db, dataClass), "claim", envelope(`real:${action}`, { action }));
      assert.deepEqual(answer, { status: 403, body: { error: "effect_outside_send_token_refused" } }, `${action} on ${dataClass}`);
    }
    assert.equal(count(db, "SELECT count(*) AS n FROM external_effects"), 0);
    assert.equal(count(db, "SELECT count(*) AS n FROM external_effect_events"), 0);
  }
});

test("a qa-synthetic provider reaches D1 only on a synthetic Worker; unset and misspelt read as business", async () => {
  const db = new D1();
  for (const dataClass of ["business", undefined, "Business", "", "synthetic-qa"]) {
    const answer = await post(workerEnv(db, dataClass), "claim", envelope("synthetic:business", { provider: QA_PROVIDER }));
    assert.deepEqual(answer, { status: 403, body: { error: "effect_provider_not_allowed" } }, `on ${dataClass}`);
  }
  assert.equal(count(db, "SELECT count(*) AS n FROM external_effects"), 0);

  // A synthetic Worker takes the stand-in exactly as before: the claim leases one attempt.
  const claimed = await post(workerEnv(db, "synthetic"), "claim", envelope("synthetic:qa", { provider: QA_PROVIDER }));
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.equal(claimed.body.effect.state, "executing");
  assert.equal(claimed.body.attempt.state, "executing");
  // Only the exact stand-in pattern passes: anything else on an outside send is a real provider.
  for (const provider of ["qa-synthetic-Publication", "qa-synthetic-", "qa-synthetic"]) {
    const answer = await post(workerEnv(db, "synthetic"), "claim", envelope(`synthetic:${provider}`, { provider }));
    assert.deepEqual(answer, { status: 403, body: { error: "effect_outside_send_token_refused" } }, provider);
  }
  assert.equal(count(db, "SELECT count(*) AS n FROM external_effects"), 1);
});

test("the bus-only email sends are refused on the token; a stand-in passes only on a synthetic Worker", async () => {
  const db = new D1();
  for (const action of ["customer.email.send", "operations.email.send"]) {
    for (const dataClass of ["business", "synthetic", undefined]) {
      const answer = await post(workerEnv(db, dataClass), "claim", envelope(`mail:${action}`, { action, provider: "gmail", retryLimit: 1, maxAttempts: 2 }));
      assert.deepEqual(answer, { status: 403, body: { error: "effect_outside_send_token_refused" } }, `${action} on ${dataClass}`);
    }
    const business = await post(workerEnv(db, "business"), "claim", envelope(`mail:${action}:qa`, { action, provider: "qa-synthetic-mail" }));
    assert.deepEqual(business, { status: 403, body: { error: "effect_provider_not_allowed" } });
  }
  assert.equal(count(db, "SELECT count(*) AS n FROM external_effects"), 0);
  const synthetic = await post(workerEnv(db, "synthetic"), "claim", envelope("mail:qa", { action: "customer.email.send", provider: "qa-synthetic-mail" }));
  assert.equal(synthetic.status, 200, JSON.stringify(synthetic.body));
});

test("mcp.* effects keep the token on a business Worker: claim, settle, reconcile and retry as before", async () => {
  const db = new D1();
  const env = workerEnv(db, "business");
  const frappe = (id: string, retryLimit: number) => envelope(id, { action: "mcp.test_write", provider: "frappe", retryLimit, maxAttempts: retryLimit + 1 });

  const first = await post(env, "claim", frappe("mcp:settled", 0));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const settled = await post(env, "settle", {
    effectId: first.body.effect.effect_id,
    settlement: {
      attemptId: first.body.attempt.attempt_id,
      outcome: "accepted",
      providerExternalId: "gate-0001",
      readback: { status: "match", providerExternalId: "gate-0001", observed: frappe("mcp:settled", 0).effect.request },
    },
  });
  assert.equal(settled.status, 200, JSON.stringify(settled.body));
  assert.equal(settled.body.effect.state, "succeeded");

  const second = await post(env, "claim", frappe("mcp:retried", 1));
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const effectId = second.body.effect.effect_id;
  const unknown = await post(env, "settle", { effectId, settlement: { attemptId: second.body.attempt.attempt_id, outcome: "unknown" } });
  assert.equal(unknown.body.effect.state, "unknown");
  const reconciled = await post(env, "reconcile", { effectId, outcome: "not_executed", evidence: { provider: "frappe", found: false } });
  assert.equal(reconciled.status, 200, JSON.stringify(reconciled.body));
  assert.equal(reconciled.body.effect.state, "reconciled");
  const retried = await post(env, "retry", { effectId });
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(retried.body.effect.state, "retry");
  assert.equal(retried.body.effect.attempt_count, 1);

  // The stand-in rule covers every action: a qa-synthetic provider on a business Worker is refused.
  const standIn = await post(env, "claim", envelope("mcp:qa", { action: "mcp.test_write", provider: QA_PROVIDER }));
  assert.deepEqual(standIn, { status: 403, body: { error: "effect_provider_not_allowed" } });
});

test("settle, reconcile and retry refuse an existing outside send and leave its row unchanged", async () => {
  const db = new D1();
  const { effect, attempt } = await busClaim(workerEnv(db), "existing:real");
  const settlement = {
    attemptId: attempt.attempt_id,
    outcome: "accepted",
    readback: { status: "match", observed: envelope("existing:real").effect.request },
  };
  const attempts = async (expected: string) => {
    const before = effectRow(db, effect.effect_id);
    const eventCount = events(db, effect.effect_id);
    for (const dataClass of ["business", "synthetic", undefined]) {
      const env = workerEnv(db, dataClass);
      for (const [route, body] of [
        ["settle", { effectId: effect.effect_id, settlement }],
        ["reconcile", { effectId: effect.effect_id, outcome: "executed", evidence: { delivered: true } }],
        ["retry", { effectId: effect.effect_id }],
      ] as const) {
        assert.deepEqual(await post(env, route, body), { status: 403, body: { error: expected } }, `${route} on ${dataClass}`);
      }
    }
    assert.deepEqual(effectRow(db, effect.effect_id), before);
    assert.equal(events(db, effect.effect_id), eventCount);
  };
  // While its attempt is leased, and again once the lease has run out and the send is unknown.
  await attempts("effect_outside_send_token_refused");
  await recoverExpiredExternalEffect(workerEnv(db), effect.effect_id, new Date(Date.now() + EFFECT_ATTEMPT_LEASE_MS + 1_000).toISOString());
  assert.equal(stateOf(db, effect.effect_id), "unknown");
  await attempts("effect_outside_send_token_refused");

  // A missing effect keeps the runtime's own answer.
  for (const [route, body] of [
    ["settle", { effectId: "effect:outside-send:missing", settlement }],
    ["reconcile", { effectId: "effect:outside-send:missing", outcome: "executed", evidence: {} }],
    ["retry", { effectId: "effect:outside-send:missing" }],
  ] as const) {
    assert.deepEqual(await post(workerEnv(db, "business"), route, body), { status: 422, body: { error: "effect_missing" } }, route);
  }
});

test("an existing stand-in passes the routes only on a synthetic Worker", async () => {
  const db = new D1();
  const { effect, attempt } = await busClaim(workerEnv(db, "synthetic"), "existing:qa", { provider: QA_PROVIDER });
  const before = effectRow(db, effect.effect_id);
  const settle = {
    effectId: effect.effect_id,
    settlement: { attemptId: attempt.attempt_id, outcome: "accepted", readback: { status: "match", observed: envelope("existing:qa").effect.request } },
  };
  for (const dataClass of ["business", undefined, "Business"]) {
    const env = workerEnv(db, dataClass);
    assert.deepEqual(await post(env, "settle", settle), { status: 403, body: { error: "effect_provider_not_allowed" } });
    assert.deepEqual(
      await post(env, "reconcile", { effectId: effect.effect_id, outcome: "executed", evidence: {} }),
      { status: 403, body: { error: "effect_provider_not_allowed" } },
    );
    assert.deepEqual(await post(env, "retry", { effectId: effect.effect_id }), { status: 403, body: { error: "effect_provider_not_allowed" } });
  }
  assert.deepEqual(effectRow(db, effect.effect_id), before);

  const synthetic = workerEnv(db, "synthetic");
  const settled = await post(synthetic, "settle", settle);
  assert.equal(settled.status, 200, JSON.stringify(settled.body));
  assert.equal(settled.body.effect.state, "succeeded");
  // Past the route, the runtime gives its own answers.
  assert.deepEqual(
    await post(synthetic, "reconcile", { effectId: effect.effect_id, outcome: "executed", evidence: {} }),
    { status: 400, body: { error: "effect_not_reconcilable" } },
  );
  assert.deepEqual(await post(synthetic, "retry", { effectId: effect.effect_id }), { status: 400, body: { error: "effect_reconciliation_required" } });
});

test("the retry route runs on the server's clock: a caller's now changes nothing", async () => {
  const db = new D1();
  const env = workerEnv(db, "business");
  // An mcp.* effect that may run twice, settled unknown and reconciled as not executed: retryable.
  const reconciled = async (id: string, deadlineInMs: number) => {
    const body = envelope(id, { action: "mcp.test_write", provider: "frappe", retryLimit: 1, maxAttempts: 2 });
    const deadlineAt = new Date(Date.now() + deadlineInMs).toISOString();
    body.effect.deadlineAt = deadlineAt;
    body.authority.expiresAt = deadlineAt;
    const claimed = await post(env, "claim", body);
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
    const effectId = claimed.body.effect.effect_id as string;
    await post(env, "settle", { effectId, settlement: { attemptId: claimed.body.attempt.attempt_id, outcome: "unknown" } });
    const answer = await post(env, "reconcile", { effectId, outcome: "not_executed", evidence: { provider: "frappe", found: false } });
    assert.equal(answer.body.effect.state, "reconciled");
    return { effectId, deadlineAt };
  };

  // A caller's "now" past the deadline does not refuse a retry the server's clock allows.
  const live = await reconciled("clock:live", 30 * 60_000);
  const forward = await post(env, "retry", { effectId: live.effectId, now: new Date(Date.parse(live.deadlineAt) + 60_000).toISOString() });
  assert.equal(forward.status, 200, JSON.stringify(forward.body));
  assert.equal(forward.body.effect.state, "retry");

  // A backdated "now" does not carry a retry past a deadline the server's clock has passed.
  const lapsing = await reconciled("clock:lapsed", 1_500);
  await new Promise((done) => setTimeout(done, Math.max(0, Date.parse(lapsing.deadlineAt) - Date.now() + 50)));
  const backdated = await post(env, "retry", { effectId: lapsing.effectId, now: new Date(Date.parse(lapsing.deadlineAt) - 60_000).toISOString() });
  assert.deepEqual(backdated, { status: 422, body: { error: "effect_deadline_expired" } });
  assert.equal(stateOf(db, lapsing.effectId), "reconciled");
});

test("a claim that would let a proposal send run twice is refused on the route", async () => {
  const db = new D1();
  const env = workerEnv(db, "synthetic");
  for (const [id, options] of [
    ["retry-limit", { retryLimit: 1 }],
    ["max-attempts", { maxAttempts: 2 }],
    ["withdraw-retry-limit", { action: "proposal.withdraw", retryLimit: 1 }],
    ["withdraw-max-attempts", { action: "proposal.withdraw", maxAttempts: 3 }],
  ] as const) {
    const answer = await post(env, "claim", envelope(`once:${id}`, { provider: QA_PROVIDER, ...options }));
    assert.deepEqual(answer, { status: 422, body: { error: "effect_outside_send_retry_forbidden" } }, id);
  }
  assert.equal(count(db, "SELECT count(*) AS n FROM external_effects"), 0);
  const once = await post(env, "claim", envelope("once:ok", { provider: QA_PROVIDER, retryLimit: 0, maxAttempts: 1 }));
  assert.equal(once.status, 200, JSON.stringify(once.body));
});

test("the QA seed's own claim and settle bodies publish on a synthetic Worker and are refused on a business one", async () => {
  const db = new D1();
  const ids = journeyIds("job:outside-send-guards:qa-seed");
  // The seed passes the permit prepare returned; this one names no permit row, so 0093 stays out.
  const permit = {
    permit_id: "synthetic-permit:outside-send-guards:qa-seed-0001",
    policy_ref: "qa-synthetic-commercial-policy",
    policy_version: "v1",
    actor_type: "owner",
    actor_id: USERS.owner,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const business = workerEnv(db, "business");
  const synthetic = workerEnv(db, "synthetic");
  assert.deepEqual(await post(business, "claim", claimBody(ids, permit, 1)), { status: 403, body: { error: "effect_provider_not_allowed" } });
  assert.equal(count(db, "SELECT count(*) AS n FROM external_effects"), 0);

  const claimed = await post(synthetic, "claim", claimBody(ids, permit, 1));
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  const settle = settleBody(ids, claimed.body.effect.effect_id, claimed.body.attempt.attempt_id);
  assert.deepEqual(await post(business, "settle", settle), { status: 403, body: { error: "effect_provider_not_allowed" } });
  assert.equal(stateOf(db, claimed.body.effect.effect_id), "executing");
  const settled = await post(synthetic, "settle", settle);
  assert.equal(settled.status, 200, JSON.stringify(settled.body));
  assert.equal(settled.body.effect.state, "succeeded");
  assert.equal(settled.body.effect.retry_limit, 0);
});

// ---------------------------------------------------------------------------------------------
// D1 (0164)

test("D1 refuses a proposal send created with a retry limit; sendGmail keeps its limit of 1", async () => {
  const db = new D1();
  assert.throws(() => insertEffect(db, "insert:publish", "proposal.publish", 1), /outside_send_retry_limit_invalid/);
  assert.throws(() => insertEffect(db, "insert:withdraw", "proposal.withdraw", 2), /outside_send_retry_limit_invalid/);
  insertEffect(db, "insert:publish-once", "proposal.publish", 0);
  insertEffect(db, "insert:mail", "customer.email.send", 1);
  insertEffect(db, "insert:operations-mail", "operations.email.send", 1);
  assert.equal(count(db, "SELECT count(*) AS n FROM external_effects WHERE action LIKE 'proposal.%'"), 1);

  // In the bus the refusal surfaces as the runtime's own proposal failure.
  const env = workerEnv(db);
  const { effect } = envelope("insert:in-process", { retryLimit: 1 });
  await assert.rejects(proposeExternalEffect(env, effect as ExternalEffectRequest), { code: "effect_proposal_failed" });
  assert.equal(count(db, "SELECT count(*) AS n FROM external_effects WHERE effect_id = 'effect:outside-send:insert:in-process'"), 0);

  // A sendGmail-shaped send: the adapter authority with a retry limit of 1.
  const deadlineAt = deadline();
  const sent = await runExternalEffect(env, {
    tenantId: TENANT,
    actor: { type: "agent", id: "gmail-adapter" },
    taskId: "gmail:outside-send-guards",
    authority: adapterAuthority({ tenantId: TENANT, provider: "gmail", action: "customer.email.send", actorId: "gmail-adapter", deadlineAt, retryLimit: 1 }),
    aggregate: { type: "communication", id: "outside-send-guards", version: 0 },
    intentId: "gmail:outside-send-guards",
    action: "customer.email.send",
    request: { to: "customer@example.invalid", subject: "Synthetic", html: "<p>Synthetic</p>" },
    provider: "gmail",
    idempotencyKey: "gmail-outside-send-guards-0001",
    deadlineAt,
    retryLimit: 1,
    correlationId: "gmail:outside-send-guards",
  }, {
    async dispatch() {
      return { outcome: "accepted" as const, providerExternalId: "message-0001", readback: { status: "match" as const, observed: {} } };
    },
    async replay() {
      return {};
    },
  });
  assert.equal(sent.effect.state, "succeeded");
  assert.equal(sent.effect.retry_limit, 1);
});

test("D1 never moves a proposal send to retry; an email send still retries after a failure", async () => {
  const db = new D1();
  const env = workerEnv(db);
  const failed = await busSend(env, "retry:failed", "refused");
  assert.equal(failed.effect.state, "failed");
  assert.throws(() => moveTo(db, failed.effect.effect_id, "retry"), /outside_send_retry_forbidden/);

  const reconciledSend = await busSend(env, "retry:reconciled", "refused");
  await reconcileExternalEffect(env, reconciledSend.effect.effect_id, { outcome: "not_executed", evidence: { provider: "refused" } });
  assert.equal(stateOf(db, reconciledSend.effect.effect_id), "reconciled");
  assert.throws(() => moveTo(db, reconciledSend.effect.effect_id, "retry"), /outside_send_retry_forbidden/);

  // The runtime's own retry reaches the same rule once its attempt count would allow one: here a
  // send whose preconditions failed before any attempt.
  const { effect, authority } = envelope("retry:preconditions");
  const proposed = await proposeExternalEffect(env, effect as ExternalEffectRequest);
  await authorizeExternalEffect(env, proposed.effect_id, authority as EffectAuthority);
  const unstarted = await executeExternalEffect(env, proposed.effect_id, {
    async preconditions() {
      return { ok: false, detailCode: "synthetic_precondition_failed" };
    },
    async dispatch() {
      throw new Error("never dispatched");
    },
  });
  assert.deepEqual([unstarted.effect.state, unstarted.effect.attempt_count], ["failed", 0]);
  await assert.rejects(retryExternalEffect(env, proposed.effect_id), /outside_send_retry_forbidden/);
  assert.equal(stateOf(db, proposed.effect_id), "failed");

  // The same moves for an email send pass, and the sendGmail path retries a failed send.
  insertEffect(db, "retry:mail", "customer.email.send", 1);
  moveTo(db, "effect:outside-send:retry:mail", "authorized");
  moveTo(db, "effect:outside-send:retry:mail", "failed");
  moveTo(db, "effect:outside-send:retry:mail", "retry");
  assert.equal(stateOf(db, "effect:outside-send:retry:mail"), "retry");
  const mail = envelope("retry:gmail", { action: "customer.email.send", provider: "gmail", retryLimit: 1, maxAttempts: 2 });
  let calls = 0;
  const executor = {
    async dispatch() {
      calls += 1;
      return calls === 1
        ? { outcome: "rejected" as const, detailCode: "provider_refused" }
        : { outcome: "accepted" as const, providerExternalId: "message-0002", readback: { status: "match" as const, observed: mail.effect.request } };
    },
    async replay() {
      return {};
    },
  };
  const firstTry = await runExternalEffect(env, { ...mail.effect, authority: mail.authority } as never, executor);
  assert.equal(firstTry.effect.state, "failed");
  const secondTry = await runExternalEffect(env, { ...mail.effect, authority: mail.authority } as never, executor);
  assert.deepEqual([secondTry.effect.state, secondTry.effect.attempt_count], ["succeeded", 2]);
});

test("D1 keeps an unknown proposal send unknown until a person records what they found", async () => {
  const db = new D1();
  const env = workerEnv(db);
  const lost = await busSend(env, "evidence:lost", "lost");
  const effectId = lost.effect.effect_id;
  assert.equal(lost.effect.state, "unknown");
  const before = effectRow(db, effectId);
  const eventCount = events(db, effectId);

  // "Not executed" is dated past the late-answer window, so the wait (0161) has no say and the
  // refusal is this rule's whichever guard runs first.
  assert.throws(() => moveTo(db, effectId, "succeeded"), /proposal_delivery_settle_evidence_missing/);
  assert.throws(() => moveTo(db, effectId, "reconciled", afterLateAnswerWindow()), /proposal_delivery_settle_evidence_missing/);
  for (const outcome of ["executed", "not_executed"] as const) {
    await assert.rejects(
      reconcileExternalEffect(env, effectId, { outcome, evidence: { provider: "says so" }, now: afterLateAnswerWindow() }),
      /proposal_delivery_settle_evidence_missing/,
    );
  }
  assert.deepEqual(effectRow(db, effectId), before);
  assert.equal(events(db, effectId), eventCount);

  // The same refusal on the route, for the stand-in a synthetic Worker may still reconcile.
  const standIn = await busSend(env, "evidence:qa", "lost", { provider: QA_PROVIDER });
  assert.deepEqual(
    await post(workerEnv(db, "synthetic"), "reconcile", { effectId: standIn.effect.effect_id, outcome: "executed", evidence: {} }),
    { status: 409, body: { error: "effect_reconciliation_evidence_missing" } },
  );
  assert.equal(stateOf(db, standIn.effect.effect_id), "unknown");
  // "Inconclusive" still hands it to a person as an exception.
  const inconclusive = await reconcileExternalEffect(env, effectId, { outcome: "inconclusive", evidence: { provider: "no answer" } });
  assert.equal(inconclusive.state, "manual_exception");
});

test("a person's record still settles an unknown or conflicting send, with its audit row", async () => {
  const db = new D1();
  const env = workerEnv(db);
  const confirm = (effectId: string, outcome: "delivered" | "not_delivered", key: string, now?: string) =>
    recordProposalDeliveryConfirmation(env, {
      tenantId: TENANT,
      effectId,
      outcome,
      note: "Checked with the customer by phone.",
      actorUserId: USERS.ops,
      actorRole: "ops",
      idempotencyKey: key,
      now,
    });
  const audits = (outcome: string) =>
    count(db, "SELECT count(*) AS n FROM audit_log WHERE automation = 'proposal_delivery' AND action = ?", `proposal_delivery_${outcome}`);

  const delivered = await busSend(env, "person:delivered", "lost");
  assert.equal((await confirm(delivered.effect.effect_id, "delivered", "person-delivered")).effectState, "succeeded");
  assert.equal(stateOf(db, delivered.effect.effect_id), "succeeded");
  assert.equal(effectRow(db, delivered.effect.effect_id).result_code, "delivery_confirmed_by_hand");
  assert.equal(audits("delivered"), 1);

  const notDelivered = await busSend(env, "person:not-delivered", "lost");
  const afterWindow = new Date(Date.now() + EFFECT_ATTEMPT_LEASE_MS + 1_000).toISOString();
  assert.equal((await confirm(notDelivered.effect.effect_id, "not_delivered", "person-not-delivered", afterWindow)).effectState, "reconciled");
  assert.equal(effectRow(db, notDelivered.effect.effect_id).result_code, "reconciled_not_executed");
  assert.equal(audits("not_delivered"), 1);

  // A conflicting readback is a manual exception: the 0156 exit is unchanged and resolves it.
  const conflict = await busSend(env, "person:conflict", "conflict");
  assert.equal(conflict.effect.state, "manual_exception");
  assert.equal(count(db, "SELECT count(*) AS n FROM external_effect_exceptions WHERE effect_id = ? AND status = 'open'", conflict.effect.effect_id), 1);
  assert.equal((await confirm(conflict.effect.effect_id, "delivered", "person-conflict")).effectState, "succeeded");
  assert.equal(count(db, "SELECT count(*) AS n FROM external_effect_exceptions WHERE effect_id = ? AND status = 'resolved'", conflict.effect.effect_id), 1);
  assert.equal(audits("delivered"), 2);
});

test("a conflicting readback is never recorded as not delivered, before or after the late-answer window", async () => {
  const db = new D1();
  const env = workerEnv(db);
  const afterWindow = () => new Date(Date.now() + EFFECT_ATTEMPT_LEASE_MS + 1_000).toISOString();
  const confirm = (effectId: string, outcome: "delivered" | "not_delivered", key: string, now?: string) =>
    recordProposalDeliveryConfirmation(env, {
      tenantId: TENANT,
      effectId,
      outcome,
      note: "Checked with the customer by phone.",
      actorUserId: USERS.ops,
      actorRole: "ops",
      idempotencyKey: key,
      now,
    });
  // The same confirmation written straight to D1, past the Worker's own check.
  const insert = (effectId: string, id: string, createdAt: string) => {
    const effect = effectRow(db, effectId);
    db.raw.prepare(
      `INSERT INTO proposal_delivery_confirmations
         (confirmation_id, tenant_id, effect_id, proposal_pack_id, proposal_revision_id, outcome, note,
          confirmed_by_user_id, confirmed_by_role, idempotency_key_hash, request_sha256, created_at)
       VALUES (?, ?, ?, ?, ?, 'not_delivered', 'Direct insert attempt', ?, 'ops', ?, ?, ?)`,
    ).run(
      `delivery-confirmation:${id}`, TENANT, effectId, effect.aggregate_id, effect.intent_id, USERS.ops,
      sha256(`${id}:key`), sha256(`${id}:request`), createdAt,
    );
  };
  const confirmations = (effectId: string) =>
    count(db, "SELECT count(*) AS n FROM proposal_delivery_confirmations WHERE effect_id = ?", effectId);

  // The provider answered, but its readback conflicts: reconciling -> manual_exception.
  const conflict = await busSend(env, "readback:conflict", "conflict");
  const conflictId = conflict.effect.effect_id;
  assert.equal(conflict.effect.state, "manual_exception");
  assert.equal(count(db, `SELECT count(*) AS n FROM external_effect_events
    WHERE effect_id = ? AND from_state = 'reconciling' AND to_state = 'manual_exception'`, conflictId), 1);
  for (const [label, now] of [["before", undefined], ["after", afterWindow()]] as const) {
    await assert.rejects(
      confirm(conflictId, "not_delivered", `conflict-${label}`, now),
      { code: "proposal_delivery_confirmation_conflict_needs_provider_evidence", status: 409 },
      `the Worker refuses ${label} the window`,
    );
    assert.throws(
      () => insert(conflictId, `conflict-direct-${label}`, now ?? new Date().toISOString()),
      /proposal_delivery_confirmation_conflict_needs_provider_evidence/,
      `D1 refuses ${label} the window`,
    );
  }
  assert.equal(stateOf(db, conflictId), "manual_exception");
  assert.equal(confirmations(conflictId), 0);
  // So it keeps blocking a second send of the same revision.
  const second = envelope("readback:conflict");
  second.effect.effectId = "effect:outside-send:readback:conflict:second";
  second.effect.idempotencyKey = "outside-send:readback:conflict:second";
  await assert.rejects(
    proposeExternalEffect(env, second.effect as ExternalEffectRequest),
    { code: "effect_proposal_delivery_unconfirmed" },
  );
  // "Delivered" stays open on a conflict.
  assert.equal((await confirm(conflictId, "delivered", "conflict-delivered")).effectState, "succeeded");

  // A provider that never answered: unknown, then an inconclusive check made it an exception.
  const silentException = async (id: string) => {
    const lost = await busSend(env, id, "lost");
    await reconcileExternalEffect(env, lost.effect.effect_id, { outcome: "inconclusive", evidence: { provider: "no answer" } });
    assert.equal(stateOf(db, lost.effect.effect_id), "manual_exception");
    return lost.effect.effect_id;
  };
  const silent = await silentException("readback:silent");
  assert.equal((await confirm(silent, "not_delivered", "silent-not-delivered", afterWindow())).effectState, "reconciled");
  const silentDelivered = await silentException("readback:silent-delivered");
  assert.equal((await confirm(silentDelivered, "delivered", "silent-delivered")).effectState, "succeeded");
});

test("other effects reconcile from unknown as before", async () => {
  const db = new D1();
  const env = workerEnv(db, "business");
  const frappe = envelope("other:frappe", { action: "mcp.test_write", provider: "frappe" });
  const claimed = await post(env, "claim", frappe);
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  const effectId = claimed.body.effect.effect_id;
  await post(env, "settle", { effectId, settlement: { attemptId: claimed.body.attempt.attempt_id, outcome: "unknown" } });
  assert.equal(stateOf(db, effectId), "unknown");
  const reconciled = await post(env, "reconcile", { effectId, outcome: "executed", evidence: { provider: "frappe", found: true } });
  assert.equal(reconciled.status, 200, JSON.stringify(reconciled.body));
  assert.equal(reconciled.body.effect.state, "succeeded");

  // An email send is not a proposal send: the bus reconciles it from the provider's evidence.
  const mail = await busSend(env, "other:mail", "lost", { action: "customer.email.send", provider: "gmail" });
  const mailReconciled = await reconcileExternalEffect(env, mail.effect.effect_id, { outcome: "executed", evidence: { provider: "gmail", found: true } });
  assert.equal(mailReconciled.state, "succeeded");
});

test("0164 adds four named guards that reference only 0042 and 0156 objects, and applying it again changes nothing", () => {
  const db = new D1();
  const guards = () =>
    (db.raw.prepare(
      `SELECT name, tbl_name, sql FROM sqlite_master
        WHERE type = 'trigger' AND name IN (
          'external_effects_outside_send_retry_limit_guard',
          'external_effects_outside_send_no_retry_guard',
          'external_effects_proposal_settle_evidence_guard',
          'proposal_delivery_confirmations_conflict_guard')
        ORDER BY name`,
    ).all() as Array<{ name: string; tbl_name: string; sql: string }>).map((row) => ({ ...row }));
  const applied = guards();
  assert.deepEqual(applied.map((row) => [row.name, row.tbl_name]), [
    ["external_effects_outside_send_no_retry_guard", "external_effects"],
    ["external_effects_outside_send_retry_limit_guard", "external_effects"],
    ["external_effects_proposal_settle_evidence_guard", "external_effects"],
    ["proposal_delivery_confirmations_conflict_guard", "proposal_delivery_confirmations"],
  ]);
  const references: Record<string, string[]> = {
    external_effects_outside_send_no_retry_guard: ["external_effects"],
    external_effects_outside_send_retry_limit_guard: ["external_effects"],
    external_effects_proposal_settle_evidence_guard: ["external_effects", "proposal_delivery_confirmations"],
    proposal_delivery_confirmations_conflict_guard: ["external_effect_events", "proposal_delivery_confirmations"],
  };
  const migration = readFileSync(new URL("../migrations/0164_outside_send_effect_guards.sql", import.meta.url), "utf8");
  // 0164's own text: 0167 later re-creates the evidence and conflict guards under their names, so
  // the applied schema carries 0167's versions of those two (proposal-delivery-checks.test.ts).
  const own = [...migration.matchAll(/^CREATE TRIGGER IF NOT EXISTS ([a-z_]+)([\s\S]*?)\nEND;/gm)];
  assert.deepEqual(own.map((match) => match[1]).sort(), applied.map((row) => row.name));
  for (const [, name, body] of own) {
    const tables = new Set([...body.matchAll(/\b(?:FROM|JOIN|ON)\s+([a-z_]+)/gi)].map((match) => match[1]));
    assert.deepEqual([...tables].sort(), references[name], name);
  }
  const triggers = () => count(db, "SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger'");
  const total = triggers();
  db.raw.exec(migration);
  assert.deepEqual(guards(), applied);
  assert.equal(triggers(), total);

  // Whatever version of the evidence guard a database already holds under its name (0167's, which
  // runs after 0164 in every order), applying 0164 again keeps it.
  db.raw.exec(`DROP TRIGGER external_effects_proposal_settle_evidence_guard;
    CREATE TRIGGER external_effects_proposal_settle_evidence_guard
    BEFORE UPDATE OF state ON external_effects
    WHEN OLD.state = 'unknown' AND NEW.state IN ('succeeded', 'reconciled')
    BEGIN SELECT RAISE(ABORT, 'proposal_delivery_settle_evidence_missing'); END;`);
  const extended = guards();
  db.raw.exec(migration);
  assert.deepEqual(guards(), extended);
  assert.equal(triggers(), total);
});
