import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  approveNewoControlAction,
  executeApprovedNewoControlAction,
  NewoControlError,
  parseNewoControlAction,
  previewNewoControlAction,
  signReceipt,
  verifyReceipt,
} from "../src/newo-control.ts";
import { resetNewoTokenCacheForTest } from "../src/newo-client.ts";

const SIGNING_SECRET = "newo-control-signing-secret-for-tests-00000001";

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    for (const migration of [
      "0001_init.sql",
      "0009_replay_approval_audit.sql",
      "0023_newo_reception.sql",
      "0025_newo_control_evidence.sql",
      "0042_external_effect_runtime.sql",
    ]) {
      this.raw.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
    }
  }

  prepare(sql: string) {
    return { bind: (...args: unknown[]) => new SqliteStatement(this.raw, sql, args) };
  }
}

class SqliteStatement {
  private readonly raw: DatabaseSync;
  private readonly sql: string;
  private readonly args: unknown[];

  constructor(
    raw: DatabaseSync,
    sql: string,
    args: unknown[],
  ) {
    this.raw = raw;
    this.sql = sql;
    this.args = args;
  }

  async first<T>(): Promise<T | null> {
    return (this.raw.prepare(this.sql).get(...this.args) ?? null) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.raw.prepare(this.sql).all(...this.args) as T[] };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const result = this.raw.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(result.changes ?? 0) } };
  }
}

function env(db = new SqliteD1(), overrides: Record<string, unknown> = {}) {
  return {
    DB: db as never,
    EFFECT_RUNTIME_ENABLED: "true",
    OWNER_ALERT_EMAIL: "owner@example.com",
    NEWO_ENABLED: "true",
    NEWO_CONTROL_WRITE_ENABLED: "true",
    NEWO_OUTBOUND_ENABLED: "false",
    NEWO_CONTROL_SIGNING_SECRET: SIGNING_SECRET,
    NEWO_CONTROL_RECEIPT_TTL_SECONDS: "600",
    NEWO_API_BASE_URL: "https://api.newo.example",
    NEWO_API_KEY: "provider-api-key",
    NEWO_API_TIMEOUT_MS: "1000",
    NEWO_REPORT_WEBHOOK_ID: "report-webhook",
    NEWO_HANDOFF_WEBHOOK_ID: "handoff-webhook",
    NEWO_PROTECTED_WEBHOOK_IDS: "extra-protected",
    ...overrides,
  } as never;
}

test("control actions reject additional properties at every mutation boundary", () => {
  assert.throws(
    () => parseNewoControlAction({
      operation: "user_actor.delete",
      args: { actor_id: "actor-1", provider_path: "/unsafe" },
    }),
    (error: NewoControlError) => error.code === "newo_control_args_unexpected_field",
  );
  assert.throws(
    () => parseNewoControlAction({
      operation: "session.update",
      args: { session_id: "session-1", input: { is_lead: true, transcript: "do not persist" } },
    }),
    (error: NewoControlError) => error.code === "newo_control_input_unexpected_field",
  );
});

test("signed receipts reject tampering and expiry", async () => {
  const issued = new Date("2026-07-18T12:00:00.000Z");
  const receipt = await signReceipt(SIGNING_SECRET, {
    receipt_type: "dry_run",
    schema_version: "newo.control.v1",
    action_id: "10000000-0000-4000-8000-000000000001",
    operation: "session.update",
    args_hash: "a".repeat(64),
    requested_by: "owner@example.com",
    issued_at: issued.toISOString(),
    expires_at: "2026-07-18T12:10:00.000Z",
  });
  assert.equal((await verifyReceipt(SIGNING_SECRET, receipt, "dry_run", issued)).operation, "session.update");
  const pieces = receipt.split(".");
  pieces[1] = `${pieces[1].slice(0, -4)}AAAA`;
  await assert.rejects(
    () => verifyReceipt(SIGNING_SECRET, pieces.join("."), "dry_run", issued),
    (error: NewoControlError) => error.code === "newo_control_receipt_signature_invalid",
  );
  await assert.rejects(
    () => verifyReceipt(SIGNING_SECRET, receipt, "dry_run", new Date("2026-07-18T12:10:00.000Z")),
    (error: NewoControlError) => error.code === "newo_control_receipt_expired",
  );
});

test("exact-argument preview, approval, and execution consume one receipt once", async (t) => {
  resetNewoTokenCacheForTest();
  const runtime = env();
  const now = new Date();
  const preview = await previewNewoControlAction(runtime, {
    requested_by: "owner@example.com",
    action: {
      operation: "session.update",
      args: { session_id: "session-1", input: { is_lead: true, need_follow_up: true } },
    },
  }, now);
  const approval = await approveNewoControlAction(runtime, {
    dry_run_receipt: preview.dry_run_receipt,
    approved_by: "owner@example.com",
    reason: "Approved after reviewing the exact session update arguments.",
  }, new Date(now.getTime() + 1_000));

  let providerMutations = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/v1/auth/api-key/token")) {
      return json({ access_token: "access", refresh_token: "refresh", token_type: "Bearer", expires_in: 900 });
    }
    assert.equal(url, "https://api.newo.example/api/v1/sessions/session-1");
    if ((init?.method ?? "GET") === "GET") {
      return json({ id: "session-1", is_lead: true, need_follow_up: true });
    }
    assert.equal(init?.method, "PATCH");
    assert.deepEqual(JSON.parse(String(init?.body)), { is_lead: true, need_follow_up: true });
    providerMutations++;
    return json({ id: "session-1", updated: true });
  });

  const executed = await executeApprovedNewoControlAction(runtime, {
    dry_run_receipt: preview.dry_run_receipt,
    approval_receipt: approval.approval_receipt,
  }, new Date(now.getTime() + 2_000));
  assert.equal(executed.status, "completed");
  assert.equal(providerMutations, 1);

  await assert.rejects(
    () => executeApprovedNewoControlAction(runtime, {
      dry_run_receipt: preview.dry_run_receipt,
      approval_receipt: approval.approval_receipt,
    }, new Date(now.getTime() + 3_000)),
    (error: NewoControlError) => error.code === "newo_control_approval_consumed_or_conflicted",
  );
  assert.equal(providerMutations, 1, "receipt replay must not repeat the provider mutation");
});

test("outbound customer sends remain blocked after approval while outbound is disabled", async () => {
  const runtime = env();
  const now = new Date();
  const preview = await previewNewoControlAction(runtime, {
    requested_by: "owner@example.com",
    action: {
      operation: "chat.user.send",
      args: { user_actor_id: "actor-1", input: { text: "Customer-facing content" } },
    },
  }, now);
  const approval = await approveNewoControlAction(runtime, {
    dry_run_receipt: preview.dry_run_receipt,
    approved_by: "owner@example.com",
    reason: "Approval evidence exists, but the global outbound gate remains off.",
  }, new Date(now.getTime() + 1_000));
  await assert.rejects(
    () => executeApprovedNewoControlAction(runtime, {
      dry_run_receipt: preview.dry_run_receipt,
      approval_receipt: approval.approval_receipt,
    }, new Date(now.getTime() + 2_000)),
    (error: NewoControlError) => error.code === "newo_outbound_disabled",
  );
});

test("production report webhooks cannot be deleted even with a valid approval", async () => {
  const runtime = env();
  const now = new Date();
  const preview = await previewNewoControlAction(runtime, {
    requested_by: "owner@example.com",
    action: { operation: "webhook.outgoing.delete", args: { webhook_id: "report-webhook" } },
  }, now);
  const approval = await approveNewoControlAction(runtime, {
    dry_run_receipt: preview.dry_run_receipt,
    approved_by: "owner@example.com",
    reason: "Attempted deletion should still be rejected by production protection.",
  }, new Date(now.getTime() + 1_000));
  await assert.rejects(
    () => executeApprovedNewoControlAction(runtime, {
      dry_run_receipt: preview.dry_run_receipt,
      approval_receipt: approval.approval_receipt,
    }, new Date(now.getTime() + 2_000)),
    (error: NewoControlError) => error.code === "newo_production_webhook_delete_forbidden",
  );
});

test("approved Newo provider mutations use the universal effect ledger and provider readback", async (t) => {
  resetNewoTokenCacheForTest();
  const runtime = env(undefined, { EFFECT_RUNTIME_ENABLED: "true" });
  const now = new Date();
  const preview = await previewNewoControlAction(runtime, {
    requested_by: "owner@example.com",
    action: { operation: "user_actor.update", args: { actor_id: "actor-1", input: { name: "Ada" } } },
  }, now);
  const approval = await approveNewoControlAction(runtime, {
    dry_run_receipt: preview.dry_run_receipt,
    approved_by: "owner@example.com",
    reason: "Approved after reviewing the exact actor update arguments.",
  }, new Date(now.getTime() + 1_000));

  let mutations = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/v1/auth/api-key/token")) {
      return json({ access_token: "access", refresh_token: "refresh", token_type: "Bearer", expires_in: 900 });
    }
    if (url.endsWith("/api/v1/actors/user/actor-1") && init?.method === "PATCH") {
      mutations++;
      return json({ id: "actor-1", updated: true });
    }
    if (url.endsWith("/api/v1/actors/user/actor-1") && (!init?.method || init.method === "GET")) {
      return json({ id: "actor-1", name: "Ada" });
    }
    throw new Error(`unexpected Newo runtime fetch ${url}`);
  });

  const executed = await executeApprovedNewoControlAction(runtime, {
    dry_run_receipt: preview.dry_run_receipt,
    approval_receipt: approval.approval_receipt,
  }, new Date(now.getTime() + 2_000));
  assert.equal(executed.status, "completed");
  assert.equal(mutations, 1);
  const ledger = runtime.DB.prepare(
    "SELECT state, provider, provider_external_id FROM external_effects WHERE provider = 'newo'",
  );
  const row = await ledger.bind().first() as { state: string; provider: string; provider_external_id: string };
  assert.equal(row.state, "succeeded");
  assert.equal(row.provider, "newo");
  assert.equal(row.provider_external_id, "actor-1");
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
