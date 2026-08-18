import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import worker from "../src/index.ts";
import {
  handleExternalEffectClaim,
  handleExternalEffectReconciliation,
  handleExternalEffectRetry,
  handleExternalEffectSettlement,
} from "../src/effect-runtime-admin.ts";
import type { AppEnv } from "../src/app-types.ts";

const NOW = "2026-08-16T12:00:00.000Z";
const DEADLINE = "2026-08-16T12:30:00.000Z";

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    this.raw.exec(readFileSync(new URL("../migrations/0042_external_effect_runtime.sql", import.meta.url), "utf8"));
  }

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => {
        const statement = this.raw.prepare(sql);
        return {
          first: async <T>() => (statement.get(...args) ?? null) as T | null,
          all: async <T>() => ({ results: statement.all(...args) as T[] }),
          run: async () => {
            const result = statement.run(...args);
            return { success: true, meta: { changes: Number(result.changes) } };
          },
        };
      },
    };
  }
}

function env(db = new SqliteD1()): AppEnv {
  return {
    ADMIN_TOKEN: "admin-token",
    APP_TENANT_ID: "ironwrap",
    DB: db as never,
    EFFECT_RUNTIME_ENABLED: "true",
    EFFECT_RUNTIME_TOKEN: "effect-runtime-token",
  } as AppEnv;
}

function envelope(retryLimit = 0) {
  return {
    effect: {
      effectId: "effect:admin-0001",
      tenantId: "ironwrap",
      actor: { type: "agent", id: "mcp-agent" },
      taskId: "run:admin-0001",
      authority: {
        permitRef: "mcp:permit:admin-0001",
        policyRef: "mcp.test_write",
        policyVersion: "v1",
      },
      aggregate: { type: "Production Gate State", id: "gate-0001", version: 0 },
      intentId: "run:admin-0001",
      action: "mcp.test_write",
      request: { method: "POST", path: "/api/resource/Production%20Gate%20State/gate-0001", body: { state: "Ready" } },
      provider: "frappe",
      idempotencyKey: "mcp:admin-0001:test-write",
      deadlineAt: DEADLINE,
      expectedReadback: { name: "gate-0001" },
      retryLimit,
      compensationPlan: {},
      correlationId: "corr:admin-0001",
      now: NOW,
    },
    authority: {
      permitRef: "mcp:permit:admin-0001",
      policyRef: "mcp.test_write",
      policyVersion: "v1",
      tenantId: "ironwrap",
      actorType: "agent",
      actorId: "mcp-agent",
      expiresAt: DEADLINE,
      allowedActions: ["mcp.test_write"],
      maxAttempts: retryLimit + 1,
    },
  };
}

test("effect endpoints require their dedicated token and reject the broad admin token", async () => {
  const appEnv = env();
  const request = (token: string) => new Request("https://bus.example/admin/effects/claim", {
    method: "POST",
    body: JSON.stringify(envelope()),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
  });
  assert.equal((await worker.fetch(request("admin-token"), appEnv, {} as never)).status, 401);
  assert.equal((await worker.fetch(request("effect-runtime-token"), appEnv, {} as never)).status, 200);
  const broadAdmin = await worker.fetch(new Request("https://bus.example/admin/envelopes", {
    headers: { authorization: "Bearer effect-runtime-token" },
  }), appEnv, {} as never);
  assert.equal(broadAdmin.status, 401);
});

test("external effect admin claim and settlement keep provider execution outside the Worker", async () => {
  const appEnv = env();
  const claimedResponse = await handleExternalEffectClaim(
    new Request("https://bus.example/admin/effects/claim", {
      method: "POST",
      body: JSON.stringify(envelope()),
      headers: { "content-type": "application/json" },
    }),
    appEnv,
  );
  assert.equal(claimedResponse.status, 200);
  const claimed = await claimedResponse.json() as {
    effect: { effect_id: string; state: string };
    attempt: { attempt_id: string; state: string };
  };
  assert.equal(claimed.effect.effect_id, "effect:admin-0001");
  assert.equal(claimed.effect.state, "executing");
  assert.equal(claimed.attempt.state, "executing");

  const settledResponse = await handleExternalEffectSettlement(
    new Request("https://bus.example/admin/effects/settle", {
      method: "POST",
      body: JSON.stringify({
        effectId: claimed.effect.effect_id,
        settlement: {
          attemptId: claimed.attempt.attempt_id,
          outcome: "accepted",
          providerExternalId: "gate-0001",
          providerResponse: { data: { name: "gate-0001" } },
          readback: { status: "match", providerExternalId: "gate-0001", observed: { name: "gate-0001" } },
          now: NOW,
        },
      }),
      headers: { "content-type": "application/json" },
    }),
    appEnv,
  );
  assert.equal(settledResponse.status, 200);
  const settled = await settledResponse.json() as {
    effect: { state: string; result_code: string | null };
    attempt: { state: string };
  };
  assert.equal(settled.effect.state, "succeeded");
  assert.equal(settled.effect.result_code, null);
  assert.equal(settled.attempt.state, "succeeded");
});

test("external effect admin claim rejects a tenant outside the Worker boundary", async () => {
  const appEnv = env();
  const body = envelope();
  body.effect.tenantId = "other-tenant";
  const response = await handleExternalEffectClaim(
    new Request("https://bus.example/admin/effects/claim", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    appEnv,
  );
  assert.equal(response.status, 403);
});

test("external effect admin requires reconciliation before it permits a retry", async () => {
  const appEnv = env();
  const claimedResponse = await handleExternalEffectClaim(
    new Request("https://bus.example/admin/effects/claim", {
      method: "POST",
      body: JSON.stringify(envelope(1)),
      headers: { "content-type": "application/json" },
    }),
    appEnv,
  );
  const claimed = await claimedResponse.json() as {
    effect: { effect_id: string };
    attempt: { attempt_id: string };
  };
  const unknownResponse = await handleExternalEffectSettlement(
    new Request("https://bus.example/admin/effects/settle", {
      method: "POST",
      body: JSON.stringify({
        effectId: claimed.effect.effect_id,
        settlement: { attemptId: claimed.attempt.attempt_id, outcome: "unknown", now: NOW },
      }),
      headers: { "content-type": "application/json" },
    }),
    appEnv,
  );
  assert.equal(unknownResponse.status, 200);
  const reconcileResponse = await handleExternalEffectReconciliation(
    new Request("https://bus.example/admin/effects/reconcile", {
      method: "POST",
      body: JSON.stringify({
        effectId: claimed.effect.effect_id,
        outcome: "not_executed",
        evidence: { provider: "frappe", found: false },
        now: NOW,
      }),
      headers: { "content-type": "application/json" },
    }),
    appEnv,
  );
  assert.equal(reconcileResponse.status, 200);
  const reconciled = await reconcileResponse.json() as { effect: { state: string } };
  assert.equal(reconciled.effect.state, "reconciled");
  const retryResponse = await handleExternalEffectRetry(
    new Request("https://bus.example/admin/effects/retry", {
      method: "POST",
      body: JSON.stringify({ effectId: claimed.effect.effect_id, now: NOW }),
      headers: { "content-type": "application/json" },
    }),
    appEnv,
  );
  assert.equal(retryResponse.status, 200);
  const retried = await retryResponse.json() as { effect: { state: string; attempt_count: number } };
  assert.equal(retried.effect.state, "retry");
  assert.equal(retried.effect.attempt_count, 1);
});

test("external effect admin settlement rejects an unknown outcome instead of treating it as success", async () => {
  const appEnv = env();
  const claimedResponse = await handleExternalEffectClaim(
    new Request("https://bus.example/admin/effects/claim", {
      method: "POST",
      body: JSON.stringify(envelope()),
      headers: { "content-type": "application/json" },
    }),
    appEnv,
  );
  const claimed = await claimedResponse.json() as {
    effect: { effect_id: string };
    attempt: { attempt_id: string };
  };
  const response = await handleExternalEffectSettlement(
    new Request("https://bus.example/admin/effects/settle", {
      method: "POST",
      body: JSON.stringify({
        effectId: claimed.effect.effect_id,
        settlement: {
          attemptId: claimed.attempt.attempt_id,
          outcome: "bogus",
          readback: { status: "match", observed: { name: "gate-0001" } },
          now: NOW,
        },
      }),
      headers: { "content-type": "application/json" },
    }),
    appEnv,
  );
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: "effect_settlement_outcome_invalid" });
});
