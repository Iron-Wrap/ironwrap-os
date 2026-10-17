import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  authorizeExternalEffect,
  claimExternalEffect,
  compensateExternalEffect,
  executeExternalEffect,
  getExternalEffect,
  markExternalEffectCompensated,
  proposeExternalEffect,
  recoverExpiredExternalEffects,
  recoverExpiredExternalEffect,
  reconcileExternalEffect,
  runExternalEffect,
  settleExternalEffect,
  retryExternalEffect,
  assertEffectLedgerReady,
  EffectRuntimeError,
} from "../src/effect-runtime.ts";
import type { AppEnv } from "../src/app-types.ts";
import type { EffectAuthority } from "../src/effect-runtime.ts";

const NOW = "2026-08-16T12:00:00.000Z";
const AUTHORITY: EffectAuthority = {
  permitRef: "permit:iro-38:test",
  policyRef: "policy:external-effects",
  policyVersion: "v1",
  tenantId: "ironwrap",
  actorType: "agent",
  actorId: "test-agent",
  expiresAt: "2026-08-16T13:00:00.000Z",
  allowedActions: ["customer.email.send", "customer.email.compensate"],
  maxAttempts: 3,
};

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    // 0042 declares the ledger; 0062 adds the `BEFORE INSERT` guards that make its append-only
    // claim hold against `INSERT OR REPLACE` too. Both, so the harness matches the deployed schema.
    for (const file of ["0042_external_effect_runtime.sql", "0062_external_effect_insert_replace_guards.sql"]) {
      this.raw.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
    }
  }

  private totalChanges(): number {
    return Number(
      (this.raw.prepare("SELECT total_changes() AS total").get() as { total: number }).total,
    );
  }

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => {
        const statement = this.raw.prepare(sql);
        return {
          first: async <T>() => (statement.get(...args) ?? null) as T | null,
          all: async <T>() => ({ results: statement.all(...args) as T[] }),
          run: async () => {
            const before = this.totalChanges();
            statement.run(...args);
            // D1 reports a `total_changes()` delta, which counts rows written by triggers. `0042`
            // writes an `external_effect_events` row on every state change, so a successful
            // transition reports 2 here exactly as it does in production. Reporting
            // `sqlite3_changes()` instead is what let the runtime's `!== 1` CAS guards pass this
            // suite while failing on the first transition against real D1 (ELEC-75).
            return { success: true, meta: { changes: this.totalChanges() - before } };
          },
        };
      },
    };
  }

  async batch(statements: Array<{ run: () => Promise<{ success: true; meta: { changes: number } }> }>) {
    this.raw.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.raw.exec("COMMIT");
      return results;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }
}

function env(db = new SqliteD1()): AppEnv {
  return { DB: db as never } as AppEnv;
}

function request(idempotencyKey = "email:lead-001") {
  return {
    tenantId: "ironwrap",
    actor: { type: "agent" as const, id: "test-agent" },
    taskId: "task:lead-001",
    authority: AUTHORITY,
    aggregate: { type: "lead", id: "lead-001", version: 4 },
    intentId: "intent:lead-001",
    action: "customer.email.send",
    request: { to: "customer@example.invalid", body: "hello" },
    provider: "gmail",
    idempotencyKey,
    deadlineAt: "2026-08-16T12:30:00.000Z",
    expectedReadback: { message_id: "msg-001" },
    retryLimit: 2,
    compensationPlan: { action: "customer.email.compensate" },
    correlationId: "corr:lead-001",
    now: NOW,
  };
}

test("the generic effect ledger cannot claim an upload receipt without a scoped manifest", async () => {
  const db = new SqliteD1();
  try {
    const ref = `evidence-upload://evu_${"a".repeat(64)}`;
    for (const candidate of [ref, ref.toUpperCase(), ` ${ref} `]) {
      await assert.rejects(
        proposeExternalEffect(env(db), {
          ...request("email:reserved-evidence-001"),
          evidenceRefs: [candidate],
        }),
        (error: unknown) => error instanceof EffectRuntimeError && error.code === "effect_evidence_ref_reserved",
      );
    }
    const rows = db.raw.prepare("SELECT count(*) AS n FROM external_effects").get() as { n: number };
    assert.equal(rows.n, 0);
  } finally {
    db.raw.close();
  }
});

async function authorized(appEnv: AppEnv, idempotencyKey = "email:lead-001") {
  const proposed = await proposeExternalEffect(appEnv, request(idempotencyKey));
  return await authorizeExternalEffect(appEnv, proposed.effect_id, AUTHORITY, NOW);
}

test("effect runtime reconciles a provider readback and preserves business idempotency", async () => {
  const appEnv = env();
  const effect = await authorized(appEnv);
  const first = await executeExternalEffect(appEnv, effect.effect_id, {
    async dispatch() {
      return { outcome: "accepted" as const, value: { accepted: true }, providerExternalId: "msg-001", providerResponse: { id: "msg-001" } };
    },
    async readback() {
      return { status: "match" as const, providerExternalId: "msg-001", observed: { message_id: "msg-001" } };
    },
  }, new Date(NOW));
  assert.equal(first.effect.state, "succeeded");
  assert.equal(first.attempt.business_idempotency_key, "email:lead-001");
  assert.match(first.attempt.attempt_id, /:attempt:/);

  const replay = await runExternalEffect(appEnv, {
    ...request(),
    deadlineAt: "2026-08-16T12:45:00.000Z",
  }, {
    async dispatch() { throw new Error("replay_dispatched"); },
    async replay() { return { replayed: true }; },
  }, new Date(NOW));
  assert.equal(replay.effect.effect_id, effect.effect_id);
  assert.deepEqual(replay.value, { replayed: true });
  assert.equal(replay.effect.deadline_at, "2026-08-16T12:30:00.000Z");
  assert.equal((await getExternalEffect(appEnv, effect.effect_id))?.attempt_count, 1);
});

test("exact replay fails explicitly when a caller omits result reconstruction", async () => {
  const appEnv = env();
  const effect = await authorized(appEnv, "email:replay-required");
  await executeExternalEffect(
    appEnv,
    effect.effect_id,
    {
      async dispatch() {
        return {
          outcome: "accepted" as const,
          providerExternalId: "msg-replay-required",
        };
      },
      async readback() {
        return {
          status: "match" as const,
          observed: { message_id: "msg-001" },
        };
      },
    },
    new Date(NOW),
  );

  await assert.rejects(
    () =>
      runExternalEffect(
        appEnv,
        request("email:replay-required"),
        {
          async dispatch() {
            throw new Error("must_not_dispatch");
          },
        } as never,
        new Date(NOW),
      ),
    (error: unknown) =>
      error instanceof EffectRuntimeError &&
      error.code === "effect_replay_required",
  );
});

test("authoritative readback reconciles a lost provider response without a second dispatch", async () => {
  const appEnv = env();
  let dispatches = 0;
  const executor = {
    async dispatch() {
      dispatches += 1;
      throw new Error("response_lost_after_provider_commit");
    },
    async readback() {
      return {
        status: "match" as const,
        providerExternalId: "msg-lost-response",
        observed: { message_id: "msg-001" },
      };
    },
    async replay({
      effect,
    }: {
      effect: { provider_external_id: string | null };
    }) {
      return { providerMessageId: effect.provider_external_id };
    },
  };
  const first = await runExternalEffect(
    appEnv,
    request("email:lost-response"),
    executor,
    new Date(NOW),
  );
  assert.equal(first.effect.state, "succeeded");
  assert.equal(first.effect.provider_external_id, "msg-lost-response");
  const replay = await runExternalEffect(
    appEnv,
    request("email:lost-response"),
    executor,
    new Date(NOW),
  );
  assert.deepEqual(replay.value, { providerMessageId: "msg-lost-response" });
  assert.equal(dispatches, 1);
});

test("business idempotency binds the complete immutable effect envelope", async () => {
  const appEnv = env();
  const idempotencyKey = "email:envelope-binding";
  await proposeExternalEffect(appEnv, request(idempotencyKey));
  const conflicting = [
    { ...request(idempotencyKey), action: "customer.email.compensate" },
    { ...request(idempotencyKey), actor: { type: "agent" as const, id: "other-agent" } },
    { ...request(idempotencyKey), provider: "outlook" },
    { ...request(idempotencyKey), authority: { ...AUTHORITY, policyRef: "policy:other" } },
    { ...request(idempotencyKey), aggregate: { type: "lead", id: "lead-002", version: 4 } },
    { ...request(idempotencyKey), deadlineAt: "2026-08-16T12:45:00.000Z" },
  ];
  for (const input of conflicting) {
    await assert.rejects(() => proposeExternalEffect(appEnv, input), /effect_idempotency_conflict/);
  }
  const count = await appEnv.DB.prepare(
    "SELECT COUNT(*) AS count FROM external_effects WHERE tenant_id = ? AND idempotency_key = ?",
  ).bind("ironwrap", idempotencyKey).first<{ count: number }>();
  assert.equal(count?.count, 1);
});

test("unknown never retries until reconciled and each retry has a new attempt identity", async () => {
  const appEnv = env();
  const effect = await authorized(appEnv);
  const first = await executeExternalEffect(appEnv, effect.effect_id, {
    async dispatch() { return { outcome: "unknown" as const, providerResponse: { timeout: true } }; },
  }, new Date(NOW));
  assert.equal(first.effect.state, "unknown");
  await assert.rejects(() => retryExternalEffect(appEnv, effect.effect_id, NOW), /reconciliation_required/);
  await reconcileExternalEffect(appEnv, effect.effect_id, {
    outcome: "not_executed", evidence: { provider: "gmail", found: false }, now: NOW,
  });
  const firstAttemptBeforeRetry = await appEnv.DB.prepare(
    `SELECT state, provider_response_hash, readback_hash, result_code, ended_at
       FROM external_effect_attempts WHERE attempt_id = ?`,
  ).bind(first.attempt.attempt_id).first<Record<string, unknown>>();
  const retry = await retryExternalEffect(appEnv, effect.effect_id, NOW);
  assert.equal(retry.provider_external_id, null);
  assert.equal(retry.provider_response_hash, null);
  assert.equal(retry.readback_hash, null);
  assert.equal(retry.exception_ref, null);
  const second = await executeExternalEffect(appEnv, retry.effect_id, {
    async dispatch() { return { outcome: "accepted" as const, providerExternalId: "msg-002" }; },
    async readback() { return { status: "match" as const, observed: { message_id: "msg-001" } }; },
  }, new Date(NOW));
  assert.equal(second.effect.state, "succeeded");
  const rows = await appEnv.DB.prepare("SELECT attempt_id FROM external_effect_attempts WHERE effect_id = ? ORDER BY attempt_number").bind(effect.effect_id).all<{ attempt_id: string }>();
  assert.equal(rows.results.length, 2);
  assert.notEqual(rows.results[0].attempt_id, rows.results[1].attempt_id);
  const firstAttemptAfterRetry = await appEnv.DB.prepare(
    `SELECT state, provider_response_hash, readback_hash, result_code, ended_at
       FROM external_effect_attempts WHERE attempt_id = ?`,
  ).bind(first.attempt.attempt_id).first<Record<string, unknown>>();
  assert.deepEqual(firstAttemptAfterRetry, firstAttemptBeforeRetry);
});

test("inconclusive reconciliation opens a terminal exception and never authorizes retry", async () => {
  const appEnv = env();
  const effect = await authorized(appEnv, "email:inconclusive");
  const execution = await executeExternalEffect(appEnv, effect.effect_id, {
    async dispatch() { return { outcome: "unknown" as const, providerResponse: { timeout: true } }; },
  }, new Date(NOW));
  const reconciled = await reconcileExternalEffect(appEnv, effect.effect_id, {
    outcome: "inconclusive",
    evidence: { provider: "gmail", search_complete: false },
    now: NOW,
  });
  assert.equal(reconciled.state, "manual_exception");
  assert.equal(reconciled.result_code, "effect_reconciliation_inconclusive");
  assert.ok(reconciled.exception_ref);
  await assert.rejects(() => retryExternalEffect(appEnv, effect.effect_id, NOW), /effect_reconciliation_required/);
  const exception = await appEnv.DB.prepare(
    "SELECT reason_code, status FROM external_effect_exceptions WHERE exception_id = ?",
  ).bind(reconciled.exception_ref).first<{ reason_code: string; status: string }>();
  assert.equal(exception?.reason_code, "effect_reconciliation_inconclusive");
  assert.equal(exception?.status, "open");
  await assert.rejects(
    () => appEnv.DB.prepare("UPDATE external_effect_attempts SET result_code = 'tampered' WHERE attempt_id = ?")
      .bind(execution.attempt.attempt_id).run(),
    /external_effect_attempt_terminal/,
  );
});

test("executed evidence contradicting a failed effect opens a terminal exception", async () => {
  const appEnv = env();
  const effect = await authorized(appEnv, "email:failed-executed");
  const failed = await executeExternalEffect(appEnv, effect.effect_id, {
    async preconditions() { return { ok: false, detailCode: "aggregate_version_stale" }; },
    async dispatch() { return { outcome: "accepted" as const, providerExternalId: "never" }; },
  }, new Date(NOW));
  assert.equal(failed.effect.state, "failed");
  const reconciled = await reconcileExternalEffect(appEnv, effect.effect_id, {
    outcome: "executed",
    evidence: { provider: "gmail", message_id: "unexpected" },
    now: NOW,
  });
  assert.equal(reconciled.state, "manual_exception");
  assert.equal(reconciled.result_code, "effect_reconciliation_conflicts_with_failure");
});

test("conflicting provider readback opens a durable exception and compensation is a new effect", async () => {
  const appEnv = env();
  const effect = await authorized(appEnv);
  const result = await executeExternalEffect(appEnv, effect.effect_id, {
    async dispatch() { return { outcome: "accepted" as const, providerExternalId: "msg-001" }; },
    async readback() { return { status: "conflict" as const, observed: { message_id: "other" } }; },
  }, new Date(NOW));
  assert.equal(result.effect.state, "manual_exception");
  const exception = await appEnv.DB.prepare("SELECT status FROM external_effect_exceptions WHERE effect_id = ?").bind(effect.effect_id).first<{ status: string }>();
  assert.equal(exception?.status, "open");

  const success = await authorized(appEnv, "email:lead-success");
  await executeExternalEffect(appEnv, success.effect_id, {
    async dispatch() { return { outcome: "accepted" as const, providerExternalId: "msg-success" }; },
    async readback() { return { status: "match" as const, observed: { message_id: "msg-001" } }; },
  }, new Date(NOW));
  const compensation = await compensateExternalEffect(appEnv, success.effect_id, {
    ...request("email:lead-001-compensation"),
    action: "customer.email.compensate",
    idempotencyKey: "email:lead-001-compensation",
  });
  assert.equal(compensation.compensates_effect_id, success.effect_id);
  assert.notEqual(compensation.effect_id, success.effect_id);
});

test("compensation is bound to the declared action and completes only after its own readback", async () => {
  const appEnv = env();
  const original = await authorized(appEnv, "email:compensation-original");
  const completed = await executeExternalEffect(appEnv, original.effect_id, {
    async dispatch() { return { outcome: "accepted" as const, providerExternalId: "msg-original" }; },
    async readback() { return { status: "match" as const, observed: { message_id: "msg-001" } }; },
  }, new Date(NOW));
  const compensationInput = {
    ...request("email:compensation-child"),
    action: "customer.email.compensate",
    correlationId: completed.effect.correlation_id,
  };
  await assert.rejects(
    () => compensateExternalEffect(appEnv, original.effect_id, { ...compensationInput, action: "customer.email.send" }),
    /effect_compensation_action_denied/,
  );
  await assert.rejects(
    () => compensateExternalEffect(appEnv, original.effect_id, { ...compensationInput, tenantId: "other-tenant" }),
    /effect_compensation_binding_mismatch/,
  );
  await assert.rejects(
    () => compensateExternalEffect(appEnv, original.effect_id, { ...compensationInput, correlationId: "corr:other" }),
    /effect_compensation_binding_mismatch/,
  );
  const compensation = await compensateExternalEffect(appEnv, original.effect_id, compensationInput);
  await assert.rejects(
    () => compensateExternalEffect(appEnv, original.effect_id, {
      ...compensationInput,
      idempotencyKey: "email:compensation-second",
    }),
    /effect_proposal_failed/,
  );
  await assert.rejects(
    () => markExternalEffectCompensated(appEnv, original.effect_id, compensation.effect_id, NOW),
    /effect_compensation_not_reconciled/,
  );
  const authorizedCompensation = await authorizeExternalEffect(appEnv, compensation.effect_id, AUTHORITY, NOW);
  await executeExternalEffect(appEnv, authorizedCompensation.effect_id, {
    async dispatch() { return { outcome: "accepted" as const, providerExternalId: "msg-compensation" }; },
    async readback() { return { status: "match" as const, observed: { message_id: "msg-001" } }; },
  }, new Date(NOW));
  const compensated = await markExternalEffectCompensated(
    appEnv,
    original.effect_id,
    compensation.effect_id,
    NOW,
  );
  assert.equal(compensated.state, "compensated");
  assert.equal(compensated.result_code, "compensation_reconciled");
});

test("a reconciled not-executed effect cannot be compensated", async () => {
  const appEnv = env();
  const effect = await authorized(appEnv, "email:not-executed-compensation");
  await executeExternalEffect(appEnv, effect.effect_id, {
    async dispatch() { return { outcome: "unknown" as const }; },
  }, new Date(NOW));
  await reconcileExternalEffect(appEnv, effect.effect_id, {
    outcome: "not_executed",
    evidence: { provider: "gmail", found: false },
    now: NOW,
  });
  await assert.rejects(
    () => compensateExternalEffect(appEnv, effect.effect_id, {
      ...request("email:not-executed-compensation-child"),
      action: "customer.email.compensate",
    }),
    /effect_not_compensable/,
  );
});

test("stale aggregate preconditions fail before dispatch and a failed effect can use a new attempt", async () => {
  const appEnv = env();
  const effect = await authorized(appEnv, "email:precondition");
  let dispatches = 0;
  const blocked = await executeExternalEffect(appEnv, effect.effect_id, {
    async preconditions() { return { ok: false, detailCode: "aggregate_version_stale" }; },
    async dispatch() {
      dispatches++;
      return { outcome: "accepted" as const, providerExternalId: "never" };
    },
  }, new Date(NOW));
  assert.equal(blocked.effect.state, "failed");
  assert.equal(blocked.effect.result_code, "aggregate_version_stale");
  assert.equal(dispatches, 0);

  const retry = await retryExternalEffect(appEnv, effect.effect_id, NOW);
  const completed = await executeExternalEffect(appEnv, retry.effect_id, {
    async dispatch() {
      dispatches++;
      return { outcome: "accepted" as const, providerExternalId: "msg-precondition" };
    },
    async readback() { return { status: "match" as const, observed: { message_id: "msg-001" } }; },
  }, new Date(NOW));
  assert.equal(completed.effect.state, "succeeded");
  assert.equal(dispatches, 1);
});

test("an expired execution lease becomes unknown and cannot be retried blindly", async () => {
  const appEnv = env();
  const effect = await authorized(appEnv, "email:lease");
  await claimExternalEffect(appEnv, effect.effect_id, new Date("2026-08-16T11:58:00.000Z"));
  const recovered = await recoverExpiredExternalEffect(appEnv, effect.effect_id, NOW);
  assert.equal(recovered.state, "unknown");
  assert.equal(recovered.result_code, "effect_lease_expired");
  await assert.rejects(() => retryExternalEffect(appEnv, effect.effect_id, NOW), /reconciliation_required/);
});

test("the scheduled lease sweep reconciles abandoned attempts and never leaves a provider call retryable", async () => {
  const appEnv = env();
  const effect = await authorized(appEnv, "email:sweep");
  const claimed = await claimExternalEffect(appEnv, effect.effect_id, new Date("2026-08-16T11:58:00.000Z"));
  const result = await recoverExpiredExternalEffects(appEnv, NOW);
  assert.deepEqual(result, { scanned: 1, recovered: 1, failed: 0, failures: [] });
  const recovered = await getExternalEffect(appEnv, effect.effect_id);
  assert.equal(recovered?.state, "unknown");
  const attempt = await appEnv.DB.prepare(
    "SELECT state, result_code FROM external_effect_attempts WHERE attempt_id = ?",
  ).bind(claimed.attempt.attempt_id).first<{ state: string; result_code: string }>();
  assert.equal(attempt?.state, "unknown");
  assert.equal(attempt?.result_code, "effect_lease_expired");
});

test("an adapter cannot bypass an explicitly disabled or unavailable effect ledger", () => {
  assert.throws(
    () => assertEffectLedgerReady({ EFFECT_RUNTIME_ENABLED: "false" }),
    (error: unknown) => error instanceof EffectRuntimeError && error.code === "effect_runtime_required",
  );
  assert.throws(
    () => assertEffectLedgerReady({ EFFECT_RUNTIME_ENABLED: "true" }),
    (error: unknown) => error instanceof EffectRuntimeError && error.code === "effect_ledger_unavailable",
  );
});

test("authorization cannot extend an effect beyond the signed authority expiry", async () => {
  const appEnv = env();
  const proposed = await proposeExternalEffect(appEnv, request("email:authority-deadline"));
  await assert.rejects(
    () => authorizeExternalEffect(appEnv, proposed.effect_id, {
      ...AUTHORITY,
      expiresAt: "2026-08-16T12:15:00.000Z",
    }, NOW),
    /authority_deadline_exceeded/,
  );
});

test("authority maxAttempts is a total-attempt ceiling, not a retry count", async () => {
  const appEnv = env();
  const oneAttempt = await proposeExternalEffect(appEnv, {
    ...request("email:one-attempt"),
    retryLimit: 0,
  });
  await assert.rejects(
    () => authorizeExternalEffect(appEnv, oneAttempt.effect_id, { ...AUTHORITY, maxAttempts: 0 }, NOW),
    /effect_policy_retry_ceiling_exceeded/,
  );
  const authorizedOne = await authorizeExternalEffect(
    appEnv,
    oneAttempt.effect_id,
    { ...AUTHORITY, maxAttempts: 1 },
    NOW,
  );
  assert.equal(authorizedOne.state, "authorized");

  const twoAttempts = await proposeExternalEffect(appEnv, {
    ...request("email:two-attempts"),
    retryLimit: 1,
  });
  await assert.rejects(
    () => authorizeExternalEffect(appEnv, twoAttempts.effect_id, { ...AUTHORITY, maxAttempts: 1 }, NOW),
    /effect_policy_retry_ceiling_exceeded/,
  );
});

test("the lease sweep continues past an unrecoverable row and reports its identity", async () => {
  const appEnv = env();
  const healthy = await authorized(appEnv, "email:sweep-healthy");
  await claimExternalEffect(appEnv, healthy.effect_id, new Date("2026-08-16T11:00:00.000Z"));
  // A poisoned row: executing with attempt_count > 0 and no attempt row — what
  // the pre-fix commit-then-throw bug left behind. The runtime can no longer
  // produce this state, so manufacture it with a direct ledger UPDATE.
  const poisoned = await authorized(appEnv, "email:sweep-poisoned");
  await appEnv.DB.prepare(
    "UPDATE external_effects SET state = 'executing', attempt_count = 1, lease_expires_at = ? WHERE effect_id = ?",
  ).bind("2026-08-16T11:00:00.000Z", poisoned.effect_id).run();

  const result = await recoverExpiredExternalEffects(appEnv, NOW);
  assert.equal(result.scanned, 2);
  assert.equal(result.recovered, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].effect_id, poisoned.effect_id);
  assert.match(result.failures[0].error, /external_effect_attempt_projection_missing/);
  assert.equal((await getExternalEffect(appEnv, healthy.effect_id))?.state, "unknown");
  assert.equal((await getExternalEffect(appEnv, poisoned.effect_id))?.state, "executing");
});

test("a second drive of an executing effect reports in-flight and never double-claims", async () => {
  const appEnv = env();
  const effect = await authorized(appEnv);
  const claimed = await claimExternalEffect(appEnv, effect.effect_id, new Date(NOW));
  assert.equal(claimed.effect.state, "executing");
  assert.equal(claimed.attempt.attempt_number, 1);
  await assert.rejects(
    () => runExternalEffect(appEnv, request(), {
      async dispatch() { throw new Error("must_not_dispatch"); },
      async replay() { throw new Error("must_not_replay"); },
    }, new Date(NOW)),
    (error: unknown) => error instanceof EffectRuntimeError && error.code === "effect_in_flight",
  );
  const after = (await getExternalEffect(appEnv, effect.effect_id))!;
  assert.equal(after.state, "executing");
  assert.equal(after.attempt_count, 1);
});

test("a remotely claimed attempt uses the same provider readback settlement rules", async () => {
  const appEnv = env();
  const effect = await authorized(appEnv, "email:remote");
  const claimed = await claimExternalEffect(appEnv, effect.effect_id, new Date(NOW));
  const settled = await settleExternalEffect(appEnv, effect.effect_id, {
    attemptId: claimed.attempt.attempt_id,
    outcome: "accepted",
    value: { accepted: true },
    providerExternalId: "msg-remote",
    providerResponse: { id: "msg-remote" },
    readback: { status: "match", providerExternalId: "msg-remote", observed: { message_id: "msg-001" } },
    now: NOW,
  });
  assert.equal(settled.effect.state, "succeeded");
  assert.equal(settled.attempt.state, "succeeded");
  assert.deepEqual(settled.value, { accepted: true });
});

test("`INSERT OR REPLACE` cannot rewrite the effect ledger either", async () => {
  // The 0042 follow-up the PR #73 review asked for (Multica ELEC-64 item 3 / ELEC-65 item 3).
  // 0059-0061 mirrored 0042's append-only trigger shape, so when the money-plane tables turned out
  // to be rewritable through `INSERT OR REPLACE` the same question applied here - and the answer
  // was yes. Every assertion below failed before 0062: SQLite's internal conflict-delete does not
  // fire a `BEFORE DELETE` trigger unless `PRAGMA recursive_triggers` is ON, which it is not.
  const db = new SqliteD1();
  const appEnv = env(db);
  const effect = await authorized(appEnv, "email:replace-guard");
  await executeExternalEffect(appEnv, effect.effect_id, {
    async dispatch() { return { outcome: "unknown" as const, providerResponse: { timeout: true } }; },
  }, new Date(NOW));
  await reconcileExternalEffect(appEnv, effect.effect_id, {
    outcome: "inconclusive",
    evidence: { provider: "gmail", search_complete: false },
    now: NOW,
  });

  const row = <T,>(sql: string): T => db.raw.prepare(sql).get() as T;
  const attempt = row<Record<string, unknown>>(
    `SELECT * FROM external_effect_attempts ORDER BY attempt_number DESC LIMIT 1`,
  );
  const event = row<Record<string, unknown>>(
    `SELECT * FROM external_effect_events ORDER BY event_seq LIMIT 1`,
  );
  const exception = row<Record<string, unknown>>(`SELECT * FROM external_effect_exceptions LIMIT 1`);
  assert.ok(attempt && event && exception, "the ledger should carry an attempt, an event and an exception");

  const replace = (table: string, source: Record<string, unknown>, changes: Record<string, unknown>) => {
    const next = { ...source, ...changes };
    const columns = Object.keys(next);
    return () => db.raw.prepare(
      `REPLACE INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    ).run(...columns.map((column) => next[column] ?? null));
  };

  // A terminal attempt, re-stated as a success under a new attempt id: conflicts on
  // UNIQUE (effect_id, attempt_number), which is exactly what `OR REPLACE` would resolve by
  // deleting the row the append-only trigger is supposed to protect.
  assert.throws(
    replace("external_effect_attempts", attempt, {
      attempt_id: "external-effect-attempt:forged01",
      state: "succeeded",
      request_hash: "f".repeat(64),
      result_code: "ok",
    }),
    /external_effect_attempts_append_only/,
  );
  assert.throws(
    replace("external_effect_events", event, { detail_code: "forged" }),
    /external_effect_events_append_only/,
  );
  assert.throws(
    replace("external_effect_exceptions", exception, {
      exception_id: "external-effect-exception:forged01",
      expected_hash: "f".repeat(64),
      observed_hash: "f".repeat(64),
    }),
    /external_effect_exceptions_retained/,
  );
  assert.throws(
    replace("external_effects", row<Record<string, unknown>>(`SELECT * FROM external_effects LIMIT 1`), {
      effect_id: "external-effect:forged0001",
      authority_ref: "FORGED-AUTHORITY",
      state: "succeeded",
    }),
    /external_effect_binding_immutable/,
  );

  const survivingAttempt = row<Record<string, unknown>>(
    `SELECT * FROM external_effect_attempts ORDER BY attempt_number DESC LIMIT 1`,
  );
  assert.equal(survivingAttempt.attempt_id, attempt.attempt_id);
  assert.equal(survivingAttempt.state, attempt.state);
  assert.equal(survivingAttempt.request_hash, attempt.request_hash);
  assert.equal(
    row<{ n: number }>(`SELECT COUNT(*) AS n FROM external_effects`).n,
    1,
    "no forged effect landed alongside the real one",
  );
});
