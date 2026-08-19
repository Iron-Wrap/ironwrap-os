// Slice S0 conformance. The port shape is the contract with the effect runtime, so these tests
// exist to make a divergence fail CI rather than surface as a production binding that silently
// does not compile.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  MONEY_ATTEMPT_STATES,
  MONEY_EFFECT_ERROR_CODES,
  MONEY_EFFECT_STATES,
  MoneyEffectError,
  toExternalEffectShape,
  type MoneyEffectExecutor,
  type MoneyEffectRequest,
} from "../src/accounting-effect-port.ts";
import {
  QUICKBOOKS_AUTH_ERROR_CODES,
  type QuickBooksAuthPort,
} from "../src/quickbooks-auth-port.ts";
import { EXTERNAL_EFFECT_STATES } from "../src/effect-runtime.ts";
import type { EffectAuthority, ExternalEffectRequest } from "../src/effect-runtime.ts";
import { TestMoneyEffectPort, TestQuickBooksAuthPort } from "./accounting-port-fixture.ts";

const NOW = new Date("2026-08-19T12:00:00.000Z");
const DEADLINE = "2026-08-19T12:30:00.000Z";

/**
 * Compile-time proof that the money request projects onto the runtime's request. If a field is
 * added to `ExternalEffectRequest` and the port does not carry it, `npm run typecheck` fails here
 * and slice S11 cannot be written against a shape that no longer matches.
 */
type ProjectedShape = ReturnType<typeof toExternalEffectShape>;
type RuntimeShape = ExternalEffectRequest & { authority: EffectAuthority };
const projectionIsAssignable: (value: ProjectedShape) => RuntimeShape = (value) => value;
void projectionIsAssignable;

function moneyRequest(overrides: Partial<MoneyEffectRequest> = {}): MoneyEffectRequest {
  return {
    tenantId: "ironwrap",
    actor: { type: "agent", id: "finance-agent" },
    taskId: "task:accounting:0001",
    authority: {
      permitRef: "permit:accounting:payment",
      policyRef: "policy:accounting:payment.create",
      policyVersion: "v1",
      expiresAt: DEADLINE,
      allowedActions: ["quickbooks.payment.create"],
      amount: 1200,
      maxAmount: 5000,
    },
    aggregate: { type: "accounting_intent", id: "acct-intent:job-0001:payment", version: 1 },
    intentId: "acct-intent:job-0001:payment",
    action: "quickbooks.payment.create",
    request: { TotalAmt: "1200.00", CustomerRef: { value: "42" } },
    provider: "quickbooks",
    providerAccountRef: "4620816365000000000",
    idempotencyKey: "acct:payment:job-0001:v1",
    deadlineAt: DEADLINE,
    expectedReadback: { Id: "1001", TotalAmt: "1200.00" },
    correlationId: "corr-0001",
    ...overrides,
  };
}

function executor(
  overrides: Partial<MoneyEffectExecutor<string>> = {},
): MoneyEffectExecutor<string> {
  return {
    async dispatch() {
      return {
        outcome: "accepted",
        providerExternalId: "1001",
        providerResponse: { Id: "1001", TotalAmt: "1200.00" },
      };
    },
    async readback() {
      return { status: "match", providerExternalId: "1001", observed: { Id: "1001", TotalAmt: "1200.00" } };
    },
    async replay() {
      return "replayed";
    },
    ...overrides,
  };
}

test("the money port restates the runtime's ledger vocabulary exactly", () => {
  assert.deepEqual([...MONEY_EFFECT_STATES], [...EXTERNAL_EFFECT_STATES]);
  // The attempt states are the subset a settled attempt may hold.
  for (const state of MONEY_ATTEMPT_STATES) {
    assert.ok(
      (EXTERNAL_EFFECT_STATES as readonly string[]).includes(state),
      `attempt state ${state} is not a ledger state`,
    );
  }
  // Every refusal the money plane is allowed to observe must be one the runtime actually raises.
  const runtime = readFileSync(new URL("../src/effect-runtime.ts", import.meta.url), "utf8");
  for (const code of MONEY_EFFECT_ERROR_CODES) {
    assert.ok(
      runtime.includes(`EffectRuntimeError("${code}")`),
      `${code} is not raised by effect-runtime.ts`,
    );
  }
  // Same discipline for the connection plane.
  const connection = readFileSync(
    new URL("../src/quickbooks-final-invoice.ts", import.meta.url),
    "utf8",
  );
  for (const code of ["quickbooks_connection_required", "quickbooks_refresh_in_progress"]) {
    assert.ok(
      connection.includes(code),
      `${code} is not raised by quickbooks-final-invoice.ts`,
    );
  }
  assert.ok(QUICKBOOKS_AUTH_ERROR_CODES.includes("quickbooks_connection_required"));
});

test("the port carries no import of the runtime or the connection plane", () => {
  for (const file of ["accounting-effect-port.ts", "quickbooks-auth-port.ts"]) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /from "\.\/effect-runtime\.ts"/);
    assert.doesNotMatch(source, /from "\.\/quickbooks-final-invoice\.ts"/);
    // No provider surface either: a port that could fetch would not be a port.
    assert.doesNotMatch(source, /\bfetch\s*\(/);
  }
});

test("the projection fills the authority subject from the request's own subject", () => {
  const projected = toExternalEffectShape(moneyRequest());
  assert.equal(projected.authority.tenantId, "ironwrap");
  assert.equal(projected.authority.actorType, "agent");
  assert.equal(projected.authority.actorId, "finance-agent");
  assert.equal(projected.authority.maxAmount, 5000);
  assert.equal(projected.idempotencyKey, "acct:payment:job-0001:v1");
});

test("a settled money effect reports the provider identity and the readback hash", async () => {
  const port = new TestMoneyEffectPort();
  const outcome = await port.run(moneyRequest(), executor(), NOW);
  assert.equal(outcome.state, "succeeded");
  assert.equal(outcome.attemptState, "succeeded");
  assert.equal(outcome.providerExternalId, "1001");
  assert.match(outcome.readbackHash ?? "", /^[0-9a-f]{64}$/);
  assert.equal(outcome.value, "replayed");
  assert.equal(port.dispatches.length, 1);
});

test("a retried identical envelope replays instead of creating a second provider entity", async () => {
  const port = new TestMoneyEffectPort();
  const first = await port.run(moneyRequest(), executor(), NOW);
  const second = await port.run(moneyRequest(), executor(), NOW);
  assert.equal(second.effectId, first.effectId);
  assert.equal(second.value, "replayed");
  // One dispatch total: the provider was called once, and the replay answered from the ledger.
  assert.equal(port.dispatches.length, 1);
  assert.equal(port.attemptsFor(first.effectId).length, 1);
});

test("a changed envelope on the same business key is an idempotency conflict", async () => {
  const port = new TestMoneyEffectPort();
  await port.run(moneyRequest(), executor(), NOW);
  await assert.rejects(
    () => port.run(moneyRequest({ request: { TotalAmt: "9900.00" } }), executor(), NOW),
    (error: MoneyEffectError) => error.code === "effect_idempotency_conflict",
  );
  assert.equal(port.dispatches.length, 1);
});

test("a lost response settles unknown and refuses a retry", async () => {
  const port = new TestMoneyEffectPort();
  const outcome = await port.run(
    moneyRequest(),
    executor({
      async readback() {
        return { status: "unavailable", detailCode: "provider_readback_unavailable" };
      },
    }),
    NOW,
  );
  assert.equal(outcome.state, "unknown");
  await assert.rejects(
    () => port.run(moneyRequest(), executor(), NOW),
    (error: MoneyEffectError) => error.code === "effect_unknown_requires_reconciliation",
  );
  assert.equal(port.dispatches.length, 1);

  // Section 5.4: resolution is a provider query on the business key, never a re-dispatch.
  port.resolveUnknown(outcome.effectId, { providerExternalId: "1001", readbackHash: "a".repeat(64) });
  assert.equal(port.effect(outcome.effectId)?.state, "succeeded");
});

test("a lost response with no provider entity escalates to a manual exception", async () => {
  const port = new TestMoneyEffectPort();
  const outcome = await port.run(
    moneyRequest(),
    executor({
      async dispatch() {
        return { outcome: "unknown", detailCode: "effect_dispatch_unknown" };
      },
      async readback() {
        return { status: "not_found", detailCode: "provider_entity_not_found" };
      },
    }),
    NOW,
  );
  assert.equal(outcome.state, "unknown");
  port.resolveUnknown(outcome.effectId, null);
  assert.equal(port.effect(outcome.effectId)?.state, "manual_exception");
  await assert.rejects(
    () => port.run(moneyRequest(), executor(), NOW),
    (error: MoneyEffectError) => error.code === "effect_manual_exception",
  );
});

test("a money ceiling breach is refused before anything is dispatched", async () => {
  const port = new TestMoneyEffectPort();
  await assert.rejects(
    () => port.run(
      moneyRequest({
        authority: { ...moneyRequest().authority, amount: 9000, maxAmount: 5000 },
      }),
      executor(),
      NOW,
    ),
    (error: MoneyEffectError) => error.code === "effect_policy_amount_ceiling_exceeded",
  );
  assert.equal(port.dispatches.length, 0);
});

test("an action outside the permit is refused before anything is dispatched", async () => {
  const port = new TestMoneyEffectPort();
  await assert.rejects(
    () => port.run(
      moneyRequest({
        authority: { ...moneyRequest().authority, allowedActions: ["quickbooks.invoice.create"] },
      }),
      executor(),
      NOW,
    ),
    (error: MoneyEffectError) => error.code === "effect_policy_action_denied",
  );
  assert.equal(port.dispatches.length, 0);
});

test("a readback that does not match the expected fact set opens an exception, not a success", async () => {
  const port = new TestMoneyEffectPort();
  const outcome = await port.run(
    moneyRequest(),
    executor({
      async readback() {
        return { status: "match", providerExternalId: "1001", observed: { Id: "1001", TotalAmt: "1150.00" } };
      },
    }),
    NOW,
  );
  assert.equal(outcome.state, "manual_exception");
  assert.equal(outcome.resultCode, "provider_readback_conflict");
  assert.equal(port.effect(outcome.effectId)?.exceptions.length, 1);
});

test("a disabled ledger refuses the mutation instead of falling back to a direct call", async () => {
  const port = new TestMoneyEffectPort();
  port.ready = false;
  await assert.rejects(
    () => port.run(moneyRequest(), executor(), NOW),
    (error: MoneyEffectError) => error.code === "effect_runtime_required",
  );
  assert.equal(port.dispatches.length, 0);
});

test("the auth stub resolves one realm binding and surfaces a refusal as a code", async () => {
  const auth: QuickBooksAuthPort = new TestQuickBooksAuthPort();
  const binding = await auth.activeRealm("ironwrap");
  assert.equal(binding.realmId, "4620816365000000000");
  assert.equal(binding.minorVersion, "75");
  assert.match(binding.apiBase, /example\.invalid$/);

  const failing = new TestQuickBooksAuthPort();
  failing.failWith("quickbooks_connection_required");
  await assert.rejects(
    () => failing.activeRealm("ironwrap"),
    (error: Error) => error.message === "quickbooks_connection_required",
  );
});
