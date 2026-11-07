// The HELM gateway binding of consequential effects (helm-gateway.ts, migration 0210): the client
// proposes the effect's identity, classifies the decision, records it, and in enforce mode lets
// only an admitted attempt reach the provider. Every way of not getting a decision is fail closed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import type { AppEnv } from "../src/app-types.ts";
import { canonicalJson, sha256Hex } from "../src/canonical.ts";
import {
  EffectRuntimeError,
  authorizeExternalEffect,
  executeExternalEffect,
  getExternalEffect,
  proposeExternalEffect,
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
} from "../src/helm-gateway.ts";

const NOW = "2026-08-16T12:00:00.000Z";
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

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    for (const file of [
      "0042_external_effect_runtime.sql",
      "0062_external_effect_insert_replace_guards.sql",
      "0142_gmail_effect_key_rollover_guard.sql",
      "0210_external_effect_gateway_admissions.sql",
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
      return results;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  admissions(): Array<Record<string, unknown>> {
    return this.raw.prepare("SELECT * FROM external_effect_gateway_admissions ORDER BY created_at, attempt_number").all() as Array<Record<string, unknown>>;
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

async function authorizedEffect(appEnv: AppEnv, key = "gw-1"): Promise<ExternalEffectRecord> {
  const proposed = await proposeExternalEffect(appEnv, {
    tenantId: TENANT,
    actor: { type: "agent", id: "lead_concierge" },
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
    now: NOW,
  });
  return await authorizeExternalEffect(appEnv, proposed.effect_id, AUTHORITY, NOW);
}

type Call = { url: string; init: RequestInit; body: Record<string, unknown> };

/** A gateway that answers one Connect JSON body per call and records what it was asked. */
function gateway(answers: Array<Response | Error>): { fetcher: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    const answer = answers.shift();
    if (!answer) throw new Error("gateway_test_no_answer");
    if (answer instanceof Error) throw answer;
    return answer;
  }) as typeof fetch;
  return { fetcher, calls };
}

function attemptResponse(state: string, extra: Record<string, unknown> = {}, status = 200): Response {
  return new Response(JSON.stringify({ attempt: { attempt_id: "0192f0c4-7a1e-7c3b-9d2a-5b8e4f1a2c3d", state, ...extra }, existing: false }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const dispatchCalls: string[] = [];
const executor = (fetcher: typeof fetch) => ({
  gatewayFetcher: fetcher,
  async dispatch({ effect }: { effect: ExternalEffectRecord }) {
    dispatchCalls.push(effect.effect_id);
    return { outcome: "accepted" as const, providerExternalId: "msg-1", providerResponse: { id: "msg-1" }, readback: { status: "match" as const, providerExternalId: "msg-1", observed: { id: "msg-1" } } };
  },
});

test.beforeEach(() => { dispatchCalls.length = 0; });

test("the mode is off, shadow or enforce; anything else reads as enforce", () => {
  assert.equal(helmGatewayMode({}), "off");
  assert.equal(helmGatewayMode({ HELM_GATEWAY_BINDING: "shadow" }), "shadow");
  assert.equal(helmGatewayMode({ HELM_GATEWAY_BINDING: " enforce " }), "enforce");
  assert.equal(helmGatewayMode({ HELM_GATEWAY_BINDING: "shadows" }), "enforce");
  assert.equal(gatewayEffectType("customer.email.send"), "ironwrap.customer.email.send");
  assert.throws(() => gatewayEffectType("Not An Action"), /gateway_effect_type_invalid/);
});

test("the proposal carries the effect's identity, never its payload, under a stable idempotency key", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const effect = await authorizedEffect(appEnv);
  const { fetcher, calls } = gateway([attemptResponse("ADMITTED")]);
  const decision = await proposeToGateway(appEnv as never, effect, 1, fetcher);
  assert.equal(decision.decision, "admitted");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://gateway.helm.example.invalid${PROPOSE_PATH}`);
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer tenant-a-gateway-token");
  assert.equal(headers["connect-protocol-version"], "1");
  assert.equal(calls[0].init.redirect, "manual");
  const body = calls[0].body;
  assert.equal(body.idempotency_key, gatewayIdempotencyKey(effect));
  assert.equal(body.idempotency_key, `ironwrap:${TENANT}:${effect.effect_id}`);
  assert.equal(body.case_id, "corr:gateway:synthetic-1");
  const sent = body.effect as Record<string, unknown>;
  assert.equal(sent.effect_type, "ironwrap.customer.email.send");
  assert.equal(sent.target, "roof_job:job-synthetic-1");
  const argumentText = atob(String(sent.arguments));
  assert.equal(argumentText, canonicalJson(gatewayArguments(effect, 1)));
  assert.ok(!argumentText.includes("customer@example.invalid") && !argumentText.includes("mail body"), "the request payload never leaves the Worker");
  assert.equal(decision.argument_digest, await sha256Hex(argumentText), "the recorded digest is of the exact bytes sent");
  assert.deepEqual(body.quote, [{ unit: "count", amount: "1" }]);
  // The next attempt proposes under the same key, so an approval given in HELM is found again.
  assert.equal(gatewayIdempotencyKey({ ...effect, attempt_count: 2 }), body.idempotency_key);
});

test("off never calls the gateway and records nothing; the effect runs as before", async () => {
  const db = new SqliteD1();
  const appEnv = env(db, { HELM_GATEWAY_BINDING: "off" });
  const effect = await authorizedEffect(appEnv);
  const { fetcher, calls } = gateway([]);
  const result = await executeExternalEffect(appEnv, effect.effect_id, executor(fetcher), new Date(NOW));
  assert.equal(result.effect.state, "succeeded");
  assert.deepEqual(dispatchCalls, [effect.effect_id]);
  assert.equal(calls.length, 0);
  assert.deepEqual(db.admissions(), []);
  assert.equal(result.admission?.mode, "off");
});

test("shadow records the decision and never blocks, even when the gateway denies or is down", async () => {
  const db = new SqliteD1();
  const appEnv = env(db, { HELM_GATEWAY_BINDING: "shadow" });
  const denied = await authorizedEffect(appEnv, "shadow-denied");
  const { fetcher } = gateway([attemptResponse("DENIED", { reason_code: "EFFECT_OUT_OF_SCOPE" })]);
  const result = await executeExternalEffect(appEnv, denied.effect_id, executor(fetcher), new Date(NOW));
  assert.equal(result.effect.state, "succeeded", "shadow lets the attempt run");
  assert.deepEqual(dispatchCalls, [denied.effect_id]);

  const down = await authorizedEffect(appEnv, "shadow-down");
  const broken = gateway([new Error("ECONNREFUSED")]);
  const second = await executeExternalEffect(appEnv, down.effect_id, executor(broken.fetcher), new Date(NOW));
  assert.equal(second.effect.state, "succeeded");

  const rows = db.admissions();
  assert.deepEqual(rows.map((row) => [row.effect_id, row.mode, row.decision, row.reason_code]), [
    [denied.effect_id, "shadow", "denied", "EFFECT_OUT_OF_SCOPE"],
    [down.effect_id, "shadow", "unreachable", "gateway_network_error"],
  ]);
});

test("enforce: an admitted proposal proceeds and its receipt references are recorded", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const effect = await authorizedEffect(appEnv);
  const receipts = [{ chain_id: "helm-gateway:8:ironwrap:4:main", seq: "7", receipt_hash: "ab".repeat(32), kid: "gw-key-1" }];
  const { fetcher } = gateway([attemptResponse("ADMITTED", { receipts })]);
  const result = await executeExternalEffect(appEnv, effect.effect_id, executor(fetcher), new Date(NOW));
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

test("enforce: a denied proposal fails the effect with the gateway's reason and the provider is never called", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const effect = await authorizedEffect(appEnv);
  const { fetcher } = gateway([attemptResponse("DENIED", { reason_code: "PER_CALL_LIMIT" })]);
  const result = await executeExternalEffect(appEnv, effect.effect_id, executor(fetcher), new Date(NOW));
  assert.equal(result.effect.state, "failed");
  assert.equal(result.effect.result_code, "gateway_denied:PER_CALL_LIMIT");
  assert.deepEqual(dispatchCalls, []);
  assert.equal(result.effect.attempt_count, 0, "no attempt was claimed");
  assert.equal(db.admissions()[0].decision, "denied");
});

test("enforce: an escalated proposal leaves the effect authorized for a later attempt, without calling the provider", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const effect = await authorizedEffect(appEnv);
  const { fetcher } = gateway([attemptResponse("ESCALATED", { reason_code: "APPROVAL_REQUIRED" }), attemptResponse("APPROVED", { reason_code: "APPROVAL_REQUIRED" })]);
  await assert.rejects(
    executeExternalEffect(appEnv, effect.effect_id, executor(fetcher), new Date(NOW)),
    (error: unknown) => error instanceof EffectRuntimeError && error.code === "effect_gateway_escalated",
  );
  assert.deepEqual(dispatchCalls, []);
  assert.equal((await getExternalEffect(appEnv, effect.effect_id))!.state, "authorized");
  // Once a person approved in HELM, the same idempotency key finds the approved attempt and the effect runs.
  const result = await executeExternalEffect(appEnv, effect.effect_id, executor(fetcher), new Date(NOW));
  assert.equal(result.effect.state, "succeeded");
  assert.deepEqual(db.admissions().map((row) => [row.decision, row.reason_code, row.gateway_state]), [
    ["escalated", "APPROVAL_REQUIRED", "ESCALATED"],
    ["admitted", "APPROVAL_REQUIRED", "APPROVED"],
  ]);
});

test("enforce: every way of not getting a decision stops the attempt and leaves the effect untouched", async () => {
  const cases: Array<[string, Response | Error, Record<string, unknown>]> = [
    ["gateway_network_error", new Error("ECONNRESET"), {}],
    ["gateway_http_503", new Response("upstream down", { status: 503 }), {}],
    ["gateway_http_401_unauthenticated", new Response(JSON.stringify({ code: "unauthenticated", message: "token" }), { status: 401 }), {}],
    ["gateway_response_malformed", new Response("not json", { status: 200 }), {}],
    ["gateway_response_shape", new Response(JSON.stringify({ existing: false }), { status: 200 }), {}],
    ["gateway_state_DISPATCHING", attemptResponse("DISPATCHING"), {}],
    ["gateway_token_missing", attemptResponse("ADMITTED"), { HELM_GATEWAY_TOKEN: "" }],
    ["gateway_url_missing", attemptResponse("ADMITTED"), { HELM_GATEWAY_URL: "" }],
    ["gateway_url_missing", attemptResponse("ADMITTED"), { HELM_GATEWAY_URL: "http://plain.example.invalid" }],
  ];
  for (const [reason, answer, overrides] of cases) {
    const db = new SqliteD1();
    const appEnv = env(db, overrides);
    const effect = await authorizedEffect(appEnv);
    const { fetcher } = gateway([answer]);
    await assert.rejects(
      executeExternalEffect(appEnv, effect.effect_id, executor(fetcher), new Date(NOW)),
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

test("enforce: a gateway that does not answer within the timeout is unreachable", async () => {
  const db = new SqliteD1();
  const appEnv = env(db, { HELM_GATEWAY_TIMEOUT_MS: "1000" });
  const effect = await authorizedEffect(appEnv);
  const hanging = (async (_url: string | URL | Request, init?: RequestInit) =>
    await new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as typeof fetch;
  const started = Date.now();
  await assert.rejects(
    executeExternalEffect(appEnv, effect.effect_id, executor(hanging), new Date(NOW)),
    (error: unknown) => error instanceof EffectRuntimeError && error.code === "effect_gateway_unreachable",
  );
  assert.ok(Date.now() - started < 5_000, "the bound is the configured timeout, not the default");
  assert.equal(db.admissions()[0].reason_code, "gateway_timeout");
  assert.deepEqual(dispatchCalls, []);
});

test("enforce: an admission that cannot be recorded is no admission", async () => {
  const db = new SqliteD1();
  db.raw.exec("DROP TRIGGER external_effect_gateway_admissions_append_only_delete; DROP TRIGGER external_effect_gateway_admissions_append_only_update; DROP TABLE external_effect_gateway_admissions");
  const appEnv = env(db);
  const effect = await authorizedEffect(appEnv);
  const { fetcher } = gateway([attemptResponse("ADMITTED")]);
  await assert.rejects(
    executeExternalEffect(appEnv, effect.effect_id, executor(fetcher), new Date(NOW)),
    (error: unknown) => error instanceof EffectRuntimeError && error.code === "effect_gateway_unreachable",
  );
  assert.deepEqual(dispatchCalls, []);
});

test("earned autonomy maps onto mandates: off is out of scope, asks-first escalates every call, within-limits is a ceiling", () => {
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
  assert.equal(within.per_call_limit, 50_000);
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
