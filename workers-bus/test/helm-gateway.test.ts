// The HELM gateway binding of consequential effects (helm-gateway.ts, migration 0210): the Worker
// proposes each attempt's identity before it claims the attempt, in its own execution and in the
// MCP host's remote claim, classifies the decision, records it, and in enforce mode lets only an
// admitted attempt reach the provider. Every way of not getting a decision is fail closed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import type { AppEnv } from "../src/app-types.ts";
import { canonicalJson, sha256Hex } from "../src/canonical.ts";
import { handleExternalEffectClaim } from "../src/effect-runtime-admin.ts";
import {
  EffectRuntimeError,
  authorizeExternalEffect,
  claimExternalEffect,
  executeExternalEffect,
  getExternalEffect,
  proposeExternalEffect,
  retryExternalEffect,
  type EffectAuthority,
  type ExternalEffectRecord,
} from "../src/effect-runtime.ts";
import {
  PROPOSE_PATH,
  gatewayArguments,
  gatewayEffectType,
  gatewayIdempotencyKey,
  gatewayMandateFor,
  helmGatewayMode,
  proposeToGateway,
  setGatewayClockForTests,
  setGatewayTransportForTests,
} from "../src/helm-gateway.ts";

const NOW = "2026-08-16T12:00:00.000Z";
const CLOCK = new Date(NOW);
const TENANT = "ironwrap";
const AUTHORITY: EffectAuthority = {
  permitRef: "permit:gateway:test",
  policyRef: "policy:external-effects",
  policyVersion: "v1",
  tenantId: TENANT,
  actorType: "agent",
  actorId: "lead_concierge",
  expiresAt: "2026-08-16T13:00:00.000Z",
  allowedActions: ["customer.email.send"],
  maxAttempts: 3,
};

/** The effect ledger plus the admissions ledger, with D1's trigger-inclusive change counting. */
class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");
  afterAdmissionWrite?: () => void;
  afterBatch?: () => void;

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    for (const file of [
      "0042_external_effect_runtime.sql",
      "0062_external_effect_insert_replace_guards.sql",
      "0142_gmail_effect_key_rollover_guard.sql",
      "0210_external_effect_gateway_admissions.sql",
      "0211_external_effect_gateway_admission_replace_guard.sql",
    ]) {
      this.raw.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
    }
  }

  private totalChanges(): number {
    return Number((this.raw.prepare("SELECT total_changes() AS total").get() as { total: number }).total);
  }

  prepare(sql: string) {
    const db = this;
    let args: unknown[] = [];
    const statement = {
      bind(...bound: unknown[]) {
        args = bound;
        return statement;
      },
      async first<T>(): Promise<T | null> {
        return (db.raw.prepare(sql).get(...(args as never[])) ?? null) as T | null;
      },
      async all<T>(): Promise<{ results: T[] }> {
        return { results: db.raw.prepare(sql).all(...(args as never[])) as T[] };
      },
      async run() {
        const before = db.totalChanges();
        db.raw.prepare(sql).run(...(args as never[]));
        if (/INSERT INTO external_effect_gateway_admissions/.test(sql)) db.afterAdmissionWrite?.();
        return { success: true as const, meta: { changes: db.totalChanges() - before } };
      },
      execute() {
        const before = db.totalChanges();
        db.raw.prepare(sql).run(...(args as never[]));
        return { success: true as const, meta: { changes: db.totalChanges() - before } };
      },
    };
    return statement;
  }

  async batch(statements: Array<{ execute(): unknown }>): Promise<unknown[]> {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.execute());
      this.raw.exec("COMMIT");
      this.afterBatch?.();
      return results;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  admissions(): Array<Record<string, unknown>> {
    return this.raw.prepare("SELECT * FROM external_effect_gateway_admissions ORDER BY rowid").all() as Array<Record<string, unknown>>;
  }
}

function env(db: SqliteD1, overrides: Record<string, unknown> = {}): AppEnv {
  return {
    DB: db,
    EFFECT_RUNTIME_ENABLED: "true",
    APP_TENANT_ID: TENANT,
    HELM_GATEWAY_BINDING: "enforce",
    HELM_GATEWAY_URL: "https://gateway.helm.example.invalid",
    HELM_GATEWAY_TOKEN: "tenant-a-gateway-token",
    HELM_GATEWAY_TIMEOUT_MS: "2000",
    ...overrides,
  } as unknown as AppEnv;
}

async function authorizedEffect(appEnv: AppEnv, key = "gw-1", actor: { type: EffectAuthority["actorType"]; id: string } = { type: "agent", id: "lead_concierge" }): Promise<ExternalEffectRecord> {
  const proposed = await proposeExternalEffect(appEnv, {
    tenantId: TENANT,
    actor,
    taskId: "task-1",
    authority: AUTHORITY,
    aggregate: { type: "roof_job", id: "job-synthetic-1", version: 3 },
    intentId: "intent-1",
    action: "customer.email.send",
    request: { to: "customer@example.invalid", body: "the mail body stays in the Worker" },
    provider: "gmail",
    idempotencyKey: `email:${key}`,
    deadlineAt: "2026-08-16T12:30:00.000Z",
    correlationId: "corr:gateway:synthetic-1",
    retryLimit: 2,
    now: NOW,
  });
  return await authorizeExternalEffect(appEnv, proposed.effect_id, { ...AUTHORITY, actorType: actor.type, actorId: actor.id }, NOW);
}

type Call = { url: string; init: RequestInit; body: Record<string, unknown> };

/** A gateway that answers one Connect JSON body per call and records what it was asked. */
function gateway(answers: Array<Response | Error | (() => Promise<Response>)>): { calls: Call[] } {
  const calls: Call[] = [];
  setGatewayTransportForTests((async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    const answer = answers.shift();
    if (!answer) throw new Error("gateway_test_no_answer");
    if (answer instanceof Error) throw answer;
    if (typeof answer === "function") return await answer();
    return answer;
  }) as typeof fetch);
  return { calls };
}

/** A protojson body as connect-go writes it: lowerCamelCase names, prefixed enum values. */
function attemptResponse(state: string, extra: Record<string, unknown> = {}, status = 200, existing = false): Response {
  return new Response(JSON.stringify({
    attempt: { attemptId: "0192f0c4-7a1e-7c3b-9d2a-5b8e4f1a2c3d", state: `EFFECT_ATTEMPT_STATE_${state}`, ...(["ADMITTED", "APPROVED"].includes(state) ? { permit: { expiresAt: "2999-01-01T00:00:00Z" } } : {}), ...extra },
    existing,
  }), { status, headers: { "content-type": "application/json" } });
}

const dispatchCalls: string[] = [];
const executor = {
  async dispatch({ effect }: { effect: ExternalEffectRecord }) {
    dispatchCalls.push(effect.effect_id);
    return { outcome: "accepted" as const, providerExternalId: "msg-1", providerResponse: { id: "msg-1" }, readback: { status: "match" as const, providerExternalId: "msg-1", observed: { id: "msg-1" } } };
  },
};
const rejectingExecutor = {
  async dispatch({ effect }: { effect: ExternalEffectRecord }) {
    dispatchCalls.push(effect.effect_id);
    return { outcome: "rejected" as const, detailCode: "provider_rejected_synthetic" };
  },
};

test.beforeEach(() => {
  dispatchCalls.length = 0;
  setGatewayTransportForTests(null);
  setGatewayClockForTests(null);
});
test.after(() => { setGatewayTransportForTests(null); setGatewayClockForTests(null); });

test("enforce requires a proven live permit for both new and stored local and remote admissions", async () => {
  for (const remote of [false, true]) {
    for (const existing of [false, true]) {
      for (const permit of [undefined, null, [], "permit", {}, { expiresAt: null }, { expiresAt: "not-a-timestamp" }, { expiresAt: "2999-01-01" }, { expiresAt: "2999-02-30T00:00:00Z" }, { expiresAt: "2999-01-01T00:00:00Z", expires_at: "2000-01-01T00:00:00Z" }, { expiresAt: "2000-01-01T00:00:00Z" }]) {
        const db = new SqliteD1();
        try {
          const appEnv = env(db);
          const effect = await authorizedEffect(appEnv, `permit-${remote}-${existing}-${JSON.stringify(permit)}`);
          gateway([attemptResponse("ADMITTED", { permit }, 200, existing)]);
          if (remote) await assert.rejects(claimExternalEffect(appEnv, effect.effect_id, CLOCK), /effect_gateway_(denied|unreachable)/);
          else {
            try { await executeExternalEffect(appEnv, effect.effect_id, executor, CLOCK); }
            catch (error) { assert.match(String(error), /effect_gateway_unreachable/); }
          }
          const after = (await getExternalEffect(appEnv, effect.effect_id))!;
          assert.equal(after.attempt_count, 0, `unproven permit: remote=${remote}, existing=${existing}, permit=${JSON.stringify(permit)}`);
          assert.deepEqual(dispatchCalls, []);
          assert.notEqual(db.admissions()[0].decision, "admitted");
        } finally { db.raw.close(); }
      }
    }
  }
});

test("the admissions ledger rejects replacement without recursive delete triggers", async () => {
  const db = new SqliteD1();
  try {
    assert.equal((db.raw.prepare("PRAGMA recursive_triggers").get() as { recursive_triggers: number }).recursive_triggers, 0);
    const appEnv = env(db), effect = await authorizedEffect(appEnv, "replace-guard");
    gateway([attemptResponse("ADMITTED", { permit: { expiresAt: "2999-01-01T00:00:00Z" } })]);
    await executeExternalEffect(appEnv, effect.effect_id, executor, CLOCK);
    const before = db.admissions();
    for (const insert of ["INSERT OR REPLACE", "REPLACE", "INSERT OR IGNORE", "INSERT"]) {
      assert.throws(() => db.raw.exec(`${insert} INTO external_effect_gateway_admissions SELECT admission_id,effect_id,tenant_id,attempt_number,mode,'denied','changed',effect_type,gateway_attempt_id,gateway_state,argument_digest,receipt_ref_json,created_at FROM external_effect_gateway_admissions`), /append_only/);
      assert.deepEqual(db.admissions(), before);
    }
    for (const conflict of ["DO NOTHING", "DO UPDATE SET decision = 'denied'"]) {
      assert.throws(() => db.raw.exec(`INSERT INTO external_effect_gateway_admissions SELECT * FROM external_effect_gateway_admissions WHERE true ON CONFLICT(admission_id) ${conflict}`), /append_only/);
      assert.deepEqual(db.admissions(), before);
    }
    assert.throws(() => db.raw.exec("INSERT OR REPLACE INTO external_effect_gateway_admissions SELECT admission_id || ':fresh',effect_id,tenant_id,attempt_number,mode,decision,reason_code,effect_type,gateway_attempt_id,gateway_state,argument_digest,receipt_ref_json,created_at FROM external_effect_gateway_admissions UNION ALL SELECT * FROM external_effect_gateway_admissions"), /append_only/);
    assert.deepEqual(db.admissions(), before, "collision aborts the whole multi-row statement");
    db.raw.exec("INSERT INTO external_effect_gateway_admissions SELECT admission_id || ':fresh',effect_id,tenant_id,attempt_number,mode,decision,reason_code,effect_type,gateway_attempt_id,gateway_state,argument_digest,receipt_ref_json,created_at FROM external_effect_gateway_admissions");
    assert.equal(db.admissions().length, 2, "a distinct proposal can still append");
  } finally { db.raw.close(); }
});

test("new and stored ADMITTED and APPROVED permits accept either timestamp wire spelling while live", async () => {
  for (const remote of [false, true]) for (const existing of [false, true]) for (const state of ["ADMITTED", "APPROVED"]) for (const expiry of ["expiresAt", "expires_at"]) {
    const db = new SqliteD1();
    try {
      dispatchCalls.length = 0;
      const appEnv = env(db), effect = await authorizedEffect(appEnv, `live-${remote}-${existing}-${state}-${expiry}`);
      gateway([attemptResponse(state, { permit: { [expiry]: "2999-01-01T01:00:00.123456789+01:00" } }, 200, existing)]);
      const result = remote ? await claimExternalEffect(appEnv, effect.effect_id, CLOCK) : await executeExternalEffect(appEnv, effect.effect_id, executor, CLOCK);
      assert.equal(result.effect.attempt_count, 1);
      assert.equal(dispatchCalls.length, remote ? 0 : 1);
    } finally { db.raw.close(); }
  }
});

test("permit expiry is checked after the entire bounded body, not the pre-request effect timestamp", async () => {
  for (const remote of [false, true]) {
    const db = new SqliteD1();
    try {
      let tick = CLOCK.getTime();
      const expiry = tick + 100;
      setGatewayClockForTests(() => tick);
      const appEnv = env(db), effect = await authorizedEffect(appEnv, `body-clock-${remote}`);
      const body = new TextEncoder().encode(JSON.stringify({ attempt: { state: "ADMITTED", permit: { expiresAt: new Date(expiry).toISOString() } }, existing: false }));
      gateway([async () => new Response(new ReadableStream({ pull(controller) { tick = expiry; controller.enqueue(body); controller.close(); } }))]);
      if (remote) await assert.rejects(claimExternalEffect(appEnv, effect.effect_id, CLOCK), /effect_gateway_denied/);
      else await executeExternalEffect(appEnv, effect.effect_id, executor, CLOCK);
      assert.equal((await getExternalEffect(appEnv, effect.effect_id))!.attempt_count, 0);
      assert.deepEqual(dispatchCalls, []);
      assert.equal(db.admissions()[0].reason_code, "PERMIT_EXPIRED");
    } finally { db.raw.close(); }
  }
});

test("expiry during admission persistence prevents local and remote claims and appends its refusal", async () => {
  for (const remote of [false, true]) {
    const db = new SqliteD1();
    try {
      let tick = CLOCK.getTime();
      const expiry = tick + 100;
      setGatewayClockForTests(() => tick);
      const appEnv = env(db), effect = await authorizedEffect(appEnv, `ledger-clock-${remote}`);
      gateway([attemptResponse("ADMITTED", { permit: { expiresAt: new Date(expiry).toISOString() } })]);
      db.afterAdmissionWrite = () => { tick = expiry; };
      if (remote) await assert.rejects(claimExternalEffect(appEnv, effect.effect_id, CLOCK), /effect_gateway_denied/);
      else await executeExternalEffect(appEnv, effect.effect_id, executor, CLOCK);
      assert.equal((await getExternalEffect(appEnv, effect.effect_id))!.attempt_count, 0);
      assert.deepEqual(dispatchCalls, []);
      assert.deepEqual(db.admissions().map(row => [row.decision, row.reason_code]), [["admitted", null], ["denied", "PERMIT_EXPIRED"]]);
    } finally { db.raw.close(); }
  }
});

test("expiry during claim readback never dispatches or returns a remote lease; its claimed attempt remains recorded", async () => {
  for (const remote of [false, true]) {
    const db = new SqliteD1();
    try {
      let tick = CLOCK.getTime();
      const expiry = tick + 100;
      setGatewayClockForTests(() => tick);
      const appEnv = env(db), effect = await authorizedEffect(appEnv, `claim-clock-${remote}`);
      gateway([attemptResponse("ADMITTED", { permit: { expiresAt: new Date(expiry).toISOString() } })]);
      db.afterBatch = () => { tick = expiry; };
      if (remote) await assert.rejects(claimExternalEffect(appEnv, effect.effect_id, CLOCK), /effect_gateway_denied/);
      else await executeExternalEffect(appEnv, effect.effect_id, executor, CLOCK);
      const after = (await getExternalEffect(appEnv, effect.effect_id))!;
      assert.equal(after.attempt_count, 1, "a committed claim is not undone");
      assert.equal(after.state, "failed");
      assert.equal(after.result_code, "gateway_denied:PERMIT_EXPIRED");
      assert.deepEqual(dispatchCalls, []);
    } finally { db.raw.close(); }
  }
});

test("an unavailable runtime clock fails closed in enforce while off and shadow retain their declared behavior", async () => {
  for (const mode of ["enforce", "shadow", "off"]) {
    const db = new SqliteD1();
    try {
      dispatchCalls.length = 0;
      setGatewayClockForTests(() => NaN);
      const appEnv = env(db, { HELM_GATEWAY_BINDING: mode }), effect = await authorizedEffect(appEnv, `clock-invalid-${mode}`);
      const { calls } = gateway([attemptResponse("ADMITTED")]);
      if (mode === "enforce") await assert.rejects(executeExternalEffect(appEnv, effect.effect_id, executor, CLOCK), /effect_gateway_unreachable/);
      else await executeExternalEffect(appEnv, effect.effect_id, executor, CLOCK);
      assert.equal((await getExternalEffect(appEnv, effect.effect_id))!.attempt_count, mode === "enforce" ? 0 : 1);
      assert.equal(dispatchCalls.length, mode === "enforce" ? 0 : 1);
      assert.equal(calls.length, mode === "off" ? 0 : 1);
    } finally { db.raw.close(); }
  }
});

test("the mode is off, shadow or enforce; unset and empty are off; anything else reads as enforce", () => {
  assert.equal(helmGatewayMode({}), "off");
  assert.equal(helmGatewayMode({ HELM_GATEWAY_BINDING: "" }), "off");
  assert.equal(helmGatewayMode({ HELM_GATEWAY_BINDING: "shadow" }), "shadow");
  assert.equal(helmGatewayMode({ HELM_GATEWAY_BINDING: " enforce " }), "enforce");
  assert.equal(helmGatewayMode({ HELM_GATEWAY_BINDING: "shadows" }), "enforce");
  assert.equal(gatewayEffectType("customer.email.send"), "ironwrap.customer.email.send");
  assert.throws(() => gatewayEffectType("Not An Action"), /gateway_effect_type_invalid/);
});

test("the proposal carries the effect's identity, never its payload, under a per-attempt idempotency key", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const effect = await authorizedEffect(appEnv);
  const { calls } = gateway([attemptResponse("ADMITTED")]);
  const decision = await proposeToGateway(appEnv as never, effect, 1);
  assert.equal(decision.decision, "admitted");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://gateway.helm.example.invalid${PROPOSE_PATH}`);
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer tenant-a-gateway-token");
  assert.equal(headers["connect-protocol-version"], "1");
  assert.equal(calls[0].init.redirect, "manual");
  const body = calls[0].body;
  assert.equal(body.idempotency_key, gatewayIdempotencyKey(effect, 1));
  assert.equal(body.idempotency_key, `ironwrap:${TENANT}:${effect.effect_id}:1`);
  assert.notEqual(gatewayIdempotencyKey(effect, 2), body.idempotency_key, "the next real attempt is a fresh proposal");
  assert.equal(body.case_id, "corr:gateway:synthetic-1");
  const sent = body.effect as Record<string, unknown>;
  assert.equal(sent.effect_type, "ironwrap.customer.email.send");
  assert.equal(sent.target, "roof_job:job-synthetic-1");
  const argumentText = atob(String(sent.arguments));
  assert.equal(argumentText, canonicalJson(await gatewayArguments(effect, 1)));
  assert.ok(!argumentText.includes("customer@example.invalid") && !argumentText.includes("mail body"), "the request payload never leaves the Worker");
  assert.equal(decision.argument_digest, await sha256Hex(argumentText), "the recorded digest is of the exact bytes sent");
  assert.deepEqual(body.quote, [{ unit: "count", amount: "1" }]);
  assert.equal(decision.gateway_attempt_id, "0192f0c4-7a1e-7c3b-9d2a-5b8e4f1a2c3d", "camelCase attempt id is read");
  assert.equal(decision.gateway_state, "ADMITTED", "the enum prefix is stripped");

  // A person's actor id travels as a digest; a system actor's as itself.
  const owner = await authorizedEffect(appEnv, "gw-owner", { type: "owner", id: "owner@example.invalid" });
  const ownerArguments = await gatewayArguments(owner, 1);
  assert.deepEqual(ownerArguments.actor, { type: "owner", id_sha256: await sha256Hex(`${owner.effect_id}:owner@example.invalid`) });
  assert.ok(!canonicalJson(ownerArguments).includes("owner@example.invalid"));
});

test("off never calls the gateway and records nothing; the effect runs as before", async () => {
  const db = new SqliteD1();
  const appEnv = env(db, { HELM_GATEWAY_BINDING: "off" });
  const effect = await authorizedEffect(appEnv);
  const { calls } = gateway([]);
  const result = await executeExternalEffect(appEnv, effect.effect_id, executor, CLOCK);
  assert.equal(result.effect.state, "succeeded");
  assert.deepEqual(dispatchCalls, [effect.effect_id]);
  assert.equal(calls.length, 0);
  assert.deepEqual(db.admissions(), []);
  assert.equal(result.admission?.mode, "off");
});

test("shadow records the decision and never blocks, even when the gateway denies, is down, or the ledger is missing", async () => {
  const db = new SqliteD1();
  const appEnv = env(db, { HELM_GATEWAY_BINDING: "shadow" });
  const denied = await authorizedEffect(appEnv, "shadow-denied");
  gateway([attemptResponse("DENIED", { reasonCode: "EFFECT_OUT_OF_SCOPE" })]);
  const result = await executeExternalEffect(appEnv, denied.effect_id, executor, CLOCK);
  assert.equal(result.effect.state, "succeeded", "shadow lets the attempt run");
  assert.deepEqual(dispatchCalls, [denied.effect_id]);

  const down = await authorizedEffect(appEnv, "shadow-down");
  gateway([new Error("ECONNREFUSED")]);
  const second = await executeExternalEffect(appEnv, down.effect_id, executor, CLOCK);
  assert.equal(second.effect.state, "succeeded");

  const rows = db.admissions();
  assert.deepEqual(rows.map((row) => [row.effect_id, row.mode, row.decision, row.reason_code]), [
    [denied.effect_id, "shadow", "denied", "EFFECT_OUT_OF_SCOPE"],
    [down.effect_id, "shadow", "unreachable", "gateway_network_error"],
  ]);

  // Without the admissions table shadow still proceeds; only enforce treats that as no admission.
  const bare = new SqliteD1();
  bare.raw.exec("DROP TRIGGER external_effect_gateway_admissions_append_only_delete; DROP TRIGGER external_effect_gateway_admissions_append_only_update; DROP TABLE external_effect_gateway_admissions");
  const bareEnv = env(bare, { HELM_GATEWAY_BINDING: "shadow" });
  const bareEffect = await authorizedEffect(bareEnv);
  gateway([attemptResponse("ADMITTED")]);
  assert.equal((await executeExternalEffect(bareEnv, bareEffect.effect_id, executor, CLOCK)).effect.state, "succeeded");
});

test("enforce: an admitted proposal proceeds and its receipt references are recorded", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const effect = await authorizedEffect(appEnv);
  const receipts = [{ chainId: "helm-gateway:8:ironwrap:4:main", seq: "7", receiptHash: "ab".repeat(32), kid: "gw-key-1" }];
  gateway([attemptResponse("ADMITTED", { receipts })]);
  const result = await executeExternalEffect(appEnv, effect.effect_id, executor, CLOCK);
  assert.equal(result.effect.state, "succeeded");
  assert.deepEqual(dispatchCalls, [effect.effect_id]);
  assert.equal(result.admission?.decision, "admitted");
  const [row] = db.admissions();
  assert.equal(row.mode, "enforce");
  assert.equal(row.decision, "admitted");
  assert.equal(row.attempt_number, 1);
  assert.equal(row.effect_type, "ironwrap.customer.email.send");
  assert.equal(row.gateway_attempt_id, "0192f0c4-7a1e-7c3b-9d2a-5b8e4f1a2c3d");
  assert.equal(row.gateway_state, "ADMITTED");
  assert.deepEqual(JSON.parse(String(row.receipt_ref_json)), [{ chain_id: "helm-gateway:8:ironwrap:4:main", seq: 7, receipt_hash: "ab".repeat(32), kid: "gw-key-1" }]);
  // The admissions ledger is append-only.
  assert.throws(() => db.raw.prepare("UPDATE external_effect_gateway_admissions SET decision = 'denied'").run(), /append_only/);
  assert.throws(() => db.raw.prepare("DELETE FROM external_effect_gateway_admissions").run(), /append_only/);
});

test("enforce: the MCP host's remote claim is admitted the same way, and refused the same way", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const admitted = await authorizedEffect(appEnv, "claim-admitted");
  gateway([attemptResponse("ADMITTED")]);
  const claimed = await claimExternalEffect(appEnv, admitted.effect_id, CLOCK);
  assert.equal(claimed.effect.state, "executing");
  assert.equal(claimed.attempt.attempt_number, 1);
  assert.equal(claimed.admission?.decision, "admitted");

  const refused = await authorizedEffect(appEnv, "claim-refused");
  gateway([new Response("upstream down", { status: 503 })]);
  await assert.rejects(
    claimExternalEffect(appEnv, refused.effect_id, CLOCK),
    (error: unknown) => error instanceof EffectRuntimeError && error.code === "effect_gateway_unreachable",
  );
  const after = (await getExternalEffect(appEnv, refused.effect_id))!;
  assert.equal(after.state, "authorized");
  assert.equal(after.attempt_count, 0, "nothing was claimed");

  // A denial is an error on the remote path: the host must never read a claim response as a lease.
  const denied = await authorizedEffect(appEnv, "claim-denied");
  gateway([attemptResponse("DENIED", { reasonCode: "EFFECT_OUT_OF_SCOPE" })]);
  await assert.rejects(
    claimExternalEffect(appEnv, denied.effect_id, CLOCK),
    (error: unknown) => error instanceof EffectRuntimeError && error.code === "effect_gateway_denied",
  );
  const deniedRow = (await getExternalEffect(appEnv, denied.effect_id))!;
  assert.equal(deniedRow.state, "failed");
  assert.equal(deniedRow.result_code, "gateway_denied:EFFECT_OUT_OF_SCOPE");

  // Through the admin claim route: 422 with the code, no lease in the body.
  const routeEnv = env(db, { AGENT_DATA_CLASS: "business" });
  gateway([attemptResponse("DENIED", { reasonCode: "EFFECT_OUT_OF_SCOPE" })]);
  const deadline = new Date(Date.now() + 30 * 60_000).toISOString();
  const response = await handleExternalEffectClaim(
    new Request("https://bus.example.invalid/admin/effects/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        effect: {
          tenantId: TENANT,
          actor: { type: "agent", id: "mcp-agent" },
          taskId: "run:gateway-claim-1",
          authority: { permitRef: "mcp:permit:gateway-claim-1", policyRef: "mcp.test_write", policyVersion: "v1" },
          aggregate: { type: "Production Gate State", id: "gate-0001", version: 0 },
          intentId: "run:gateway-claim-1",
          action: "mcp.test_write",
          request: { method: "POST", path: "/api/resource/x", body: { state: "Ready" } },
          provider: "frappe",
          idempotencyKey: "mcp:gateway-claim-1",
          deadlineAt: deadline,
          expectedReadback: { name: "gate-0001" },
          retryLimit: 0,
          compensationPlan: {},
          correlationId: "corr:gateway-claim-1",
        },
        authority: {
          permitRef: "mcp:permit:gateway-claim-1",
          policyRef: "mcp.test_write",
          policyVersion: "v1",
          tenantId: TENANT,
          actorType: "agent",
          actorId: "mcp-agent",
          expiresAt: deadline,
          allowedActions: ["mcp.test_write"],
          maxAttempts: 1,
        },
      }),
    }),
    routeEnv,
  );
  assert.equal(response.status, 422);
  const payload = await response.json() as Record<string, unknown>;
  assert.equal(payload.error, "effect_gateway_denied");
  assert.equal(payload.attempt, undefined, "no lease is returned");
});

test("enforce: a denied proposal fails the effect with the gateway's reason and the provider is never called", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const effect = await authorizedEffect(appEnv);
  gateway([attemptResponse("DENIED", { reasonCode: "PER_CALL_LIMIT" })]);
  const result = await executeExternalEffect(appEnv, effect.effect_id, executor, CLOCK);
  assert.equal(result.effect.state, "failed");
  assert.equal(result.effect.result_code, "gateway_denied:PER_CALL_LIMIT");
  assert.deepEqual(dispatchCalls, []);
  assert.equal(result.effect.attempt_count, 0, "no attempt was claimed");
  assert.equal(db.admissions()[0].decision, "denied");
});

test("enforce: a retry after a real attempt is a fresh proposal; a denial in retry state is thrown, and the proposal after it carries the denial count", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const effect = await authorizedEffect(appEnv);
  const { calls } = gateway([
    attemptResponse("ADMITTED"),
    attemptResponse("DENIED", { reasonCode: "BUDGET_EXCEEDED" }),
    attemptResponse("ADMITTED"),
  ]);
  const first = await executeExternalEffect(appEnv, effect.effect_id, rejectingExecutor, CLOCK);
  assert.equal(first.effect.state, "failed", "the provider rejected attempt 1");
  assert.equal(first.effect.attempt_count, 1);
  const retried = await retryExternalEffect(appEnv, effect.effect_id, NOW);
  assert.equal(retried.state, "retry");

  await assert.rejects(
    executeExternalEffect(appEnv, effect.effect_id, executor, CLOCK),
    (error: unknown) => error instanceof EffectRuntimeError && error.code === "effect_gateway_denied",
  );
  assert.equal((await getExternalEffect(appEnv, effect.effect_id))!.state, "retry", "the ledger forbids retry → failed; the effect waits for a later proposal");
  assert.equal(calls[1].body.idempotency_key, `ironwrap:${TENANT}:${effect.effect_id}:2`, "attempt 2 is proposed under its own key");
  assert.equal(JSON.parse(atob(String((calls[1].body.effect as Record<string, string>).arguments))).attempt_number, 2);

  const second = await executeExternalEffect(appEnv, effect.effect_id, executor, CLOCK);
  assert.equal(second.effect.state, "succeeded", "the budget rolled; attempt 2 is proposed again under a new key and admitted");
  assert.equal(calls[2].body.idempotency_key, `ironwrap:${TENANT}:${effect.effect_id}:2:d1`, "one denial recorded for attempt 2 makes the next proposal a new key");
  assert.deepEqual(db.admissions().map((row) => [row.attempt_number, row.decision]), [[1, "admitted"], [2, "denied"], [2, "admitted"]]);

  // A person's rejection is final for the attempt: it earns no new key, so the stored REJECTED is
  // found again and nobody is asked twice.
  const rejected = await authorizedEffect(appEnv, "rejected");
  const rejectedCalls = gateway([
    attemptResponse("REJECTED", { reasonCode: "APPROVAL_REJECTED" }),
    attemptResponse("REJECTED", { reasonCode: "APPROVAL_REJECTED" }, 200, true),
  ]).calls;
  const firstRejection = await executeExternalEffect(appEnv, rejected.effect_id, executor, CLOCK);
  assert.equal(firstRejection.effect.result_code, "gateway_denied:APPROVAL_REJECTED");
  await retryExternalEffect(appEnv, rejected.effect_id, NOW);
  await assert.rejects(executeExternalEffect(appEnv, rejected.effect_id, executor, CLOCK), (error: unknown) => error instanceof EffectRuntimeError && error.code === "effect_gateway_denied");
  assert.equal(rejectedCalls[1].body.idempotency_key, rejectedCalls[0].body.idempotency_key, "a rejection does not bump the key");
});

test("enforce: an escalated proposal leaves the effect authorized; the approval is found under the same key; an expired stored permit is a denial", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const effect = await authorizedEffect(appEnv);
  const { calls } = gateway([
    attemptResponse("ESCALATED", { reasonCode: "APPROVAL_REQUIRED" }),
    attemptResponse("ADMITTED", { reasonCode: "APPROVAL_REQUIRED", permit: { expiresAt: "2999-01-01T00:00:00Z" } }, 200, true),
  ]);
  await assert.rejects(
    executeExternalEffect(appEnv, effect.effect_id, executor, CLOCK),
    (error: unknown) => error instanceof EffectRuntimeError && error.code === "effect_gateway_escalated",
  );
  assert.deepEqual(dispatchCalls, []);
  assert.equal((await getExternalEffect(appEnv, effect.effect_id))!.state, "authorized");
  const result = await executeExternalEffect(appEnv, effect.effect_id, executor, CLOCK);
  assert.equal(result.effect.state, "succeeded");
  assert.equal(calls[1].body.idempotency_key, calls[0].body.idempotency_key, "no attempt was claimed and nothing was denied, so the approval is found under the same key");

  const stale = await authorizedEffect(appEnv, "stale-permit");
  gateway([attemptResponse("ADMITTED", { permit: { expiresAt: "2000-01-01T00:00:00Z" } }, 200, true)]);
  const expired = await executeExternalEffect(appEnv, stale.effect_id, executor, CLOCK);
  assert.equal(expired.effect.state, "failed");
  assert.equal(expired.effect.result_code, "gateway_denied:PERMIT_EXPIRED");
  assert.deepEqual(dispatchCalls, [effect.effect_id]);
});

test("enforce: every way of not getting a decision stops the attempt and leaves the effect untouched", async () => {
  const cases: Array<[string, Response | Error, Record<string, unknown>]> = [
    ["gateway_network_error", new Error("ECONNRESET"), {}],
    ["gateway_http_503", new Response("upstream down", { status: 503 }), {}],
    ["gateway_http_401_unauthenticated", new Response(JSON.stringify({ code: "unauthenticated", message: "token" }), { status: 401 }), {}],
    ["gateway_http_409_already_exists", new Response(JSON.stringify({ code: "already_exists", message: "idempotency" }), { status: 409 }), {}],
    ["gateway_response_malformed", new Response("not json", { status: 200 }), {}],
    ["gateway_response_shape", new Response(JSON.stringify({ existing: false }), { status: 200 }), {}],
    ["gateway_state_DISPATCHING", attemptResponse("DISPATCHING"), {}],
    ["gateway_state_ESCALATED_TO_HUMAN", attemptResponse("ESCALATED_TO_HUMAN"), {}],
    ["gateway_response_too_large", new Response("x".repeat(300 * 1024), { status: 200 }), {}],
    ["gateway_token_missing", attemptResponse("ADMITTED"), { HELM_GATEWAY_TOKEN: "" }],
    ["gateway_url_missing", attemptResponse("ADMITTED"), { HELM_GATEWAY_URL: "" }],
    ["gateway_url_missing", attemptResponse("ADMITTED"), { HELM_GATEWAY_URL: "http://plain.example.invalid" }],
  ];
  for (const [reason, answer, overrides] of cases) {
    const db = new SqliteD1();
    const appEnv = env(db, overrides);
    const effect = await authorizedEffect(appEnv);
    gateway([answer]);
    await assert.rejects(
      executeExternalEffect(appEnv, effect.effect_id, executor, CLOCK),
      (error: unknown) => error instanceof EffectRuntimeError && error.code === "effect_gateway_unreachable",
      reason,
    );
    assert.deepEqual(dispatchCalls, [], reason);
    const after = (await getExternalEffect(appEnv, effect.effect_id))!;
    assert.equal(after.state, "authorized", reason);
    assert.equal(after.attempt_count, 0, reason);
    const [row] = db.admissions();
    assert.equal(row.decision, "unreachable", reason);
    assert.equal(row.reason_code, reason);
  }
});

test("enforce: a gateway that stalls, before or after its headers, is unreachable within the configured timeout", async () => {
  for (const stall of ["before_headers", "after_headers"] as const) {
    const db = new SqliteD1();
    const appEnv = env(db, { HELM_GATEWAY_TIMEOUT_MS: "1000" });
    const effect = await authorizedEffect(appEnv);
    setGatewayTransportForTests((async (_url: string | URL | Request, init?: RequestInit) => {
      if (stall === "before_headers") {
        return await new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      // Headers arrive at once; the body never does.
      return new Response(new ReadableStream({ start() {} }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch);
    const started = Date.now();
    await assert.rejects(
      executeExternalEffect(appEnv, effect.effect_id, executor, CLOCK),
      (error: unknown) => error instanceof EffectRuntimeError && error.code === "effect_gateway_unreachable",
      stall,
    );
    assert.ok(Date.now() - started < 5_000, `${stall}: the bound is the configured timeout, not the default`);
    assert.equal(db.admissions()[0].reason_code, "gateway_timeout", stall);
    assert.deepEqual(dispatchCalls, [], stall);
  }
});

test("enforce: an admission that cannot be recorded is no admission", async () => {
  const db = new SqliteD1();
  db.raw.exec("DROP TRIGGER external_effect_gateway_admissions_append_only_delete; DROP TRIGGER external_effect_gateway_admissions_append_only_update; DROP TABLE external_effect_gateway_admissions");
  const appEnv = env(db);
  const effect = await authorizedEffect(appEnv);
  gateway([attemptResponse("ADMITTED")]);
  await assert.rejects(
    executeExternalEffect(appEnv, effect.effect_id, executor, CLOCK),
    (error: unknown) => error instanceof EffectRuntimeError && error.code === "effect_gateway_unreachable",
  );
  assert.deepEqual(dispatchCalls, []);
});

test("an action the gateway cannot name is never proposed: off ignores it, a live mode records it as unreachable", async () => {
  const db = new SqliteD1();
  const effect = { ...(await authorizedEffect(env(db, { HELM_GATEWAY_BINDING: "off" }))), action: "Not An Action" } as ExternalEffectRecord;
  const { calls } = gateway([attemptResponse("ADMITTED")]);
  const decision = await proposeToGateway(env(db) as never, effect, 1);
  assert.equal(decision.decision, "unreachable");
  assert.equal(decision.reason_code, "gateway_effect_type_invalid");
  assert.equal(calls.length, 0);
  assert.match(decision.argument_digest, /^[0-9a-f]{64}$/, "the digest of what would have been sent is still recorded");
});

test("earned autonomy maps onto mandates: off is out of scope, asks-first escalates every call, within-limits escalates above its ceiling", () => {
  const base = { tenantId: TENANT, specialistId: "lead_concierge", actionId: "customer.email.send" };
  const off = gatewayMandateFor({ ...base, delegation: "off", ceiling: null });
  assert.equal(off.in_scope, false);
  assert.equal(off.effect_type, "ironwrap.customer.email.send");
  const asks = gatewayMandateFor({ ...base, delegation: "asks_first", ceiling: null });
  assert.deepEqual([asks.in_scope, asks.approval_threshold, asks.per_call_limit, asks.limits], [true, 0, null, []]);
  const noCeiling = gatewayMandateFor({ ...base, delegation: "within_limits", ceiling: null });
  assert.equal(noCeiling.approval_threshold, 0, "within limits without a ceiling is asks first");
  const within = gatewayMandateFor({
    ...base,
    delegation: "within_limits",
    ceiling: { count: { max: 20, per: "day" }, amount: { max_minor: 50_000, currency: "CAD" }, recipients: null },
  });
  assert.equal(within.in_scope, true);
  assert.equal(within.per_call_limit, null, "a per-call limit would deny; the Worker asks first above the ceiling");
  assert.equal(within.approval_threshold, 50_001);
  assert.deepEqual(within.limits, [{ unit: "count", measure: "count", window_kind: "day", span: 1, limit_value: 20 }]);
  const weekly = gatewayMandateFor({
    ...base,
    delegation: "within_limits",
    ceiling: { count: { max: 5, per: "week" }, amount: null, recipients: ["ops@example.invalid"] },
  });
  assert.deepEqual([weekly.per_call_limit, weekly.approval_threshold], [null, null]);
  assert.deepEqual(weekly.limits, [{ unit: "count", measure: "count", window_kind: "day", span: 7, limit_value: 5 }]);
});
