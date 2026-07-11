import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { handleAuthenticatedRoute } from "../src/app-api.ts";
import type { AppEnv, AppRole, AuthContext } from "../src/app-types.ts";

const TENANT = "ironwrap";
const SHARED_SECRET = "approval-broker-shared-secret-for-test-0001";
const KEY_ID = "approval-test-key";
const APPROVER = "owner@example.com";

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    this.raw.exec(readFileSync(new URL("../migrations/0011_app_bff_auth.sql", import.meta.url), "utf8"));
    this.raw.exec(readFileSync(new URL("../migrations/0016_approval_requests.sql", import.meta.url), "utf8"));
    const now = new Date().toISOString();
    const insert = this.raw.prepare(
      `INSERT INTO app_users (
        user_id, tenant_id, email_normalized, display_name, role, frappe_user_id,
        active, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 'seed', ?, ?)`,
    );
    insert.run("appu_owner_0001", TENANT, APPROVER, "Owner", "owner", APPROVER, now, now);
    insert.run("appu_ops_0001", TENANT, "ops@example.com", "Ops", "ops", "ops@example.com", now, now);
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
    DB: db as never,
    APP_ALLOW_INSECURE_LOCAL: "true",
    APP_APPROVAL_BROKER_URL: "http://127.0.0.1:8788",
    APP_APPROVAL_BROKER_KEY_ID: KEY_ID,
    APPROVAL_BROKER_SHARED_SECRET: SHARED_SECRET,
    APP_APPROVAL_APPROVER_ID: APPROVER,
    APP_APPROVAL_MAX_SESSION_AGE_SECONDS: "900",
    APP_APPROVAL_BROKER_TIMEOUT_MS: "5000",
    APP_APPROVAL_EXECUTION_LEASE_SECONDS: "45",
  } as AppEnv;
}

function auth(role: AppRole): AuthContext {
  const now = new Date();
  const userId = role === "owner" ? "appu_owner_0001" : "appu_ops_0001";
  const email = role === "owner" ? APPROVER : "ops@example.com";
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: role === "owner"
      ? ["session:read", "approvals:read", "approvals:decide"]
      : ["session:read", "approvals:read", "approvals:prepare"],
    session: {
      session_hash: "a".repeat(64),
      session_created_at: new Date(now.getTime() - 60_000).toISOString(),
      session_expires_at: new Date(now.getTime() + 60 * 60_000).toISOString(),
      revoked_at: null,
      user_id: userId,
      tenant_id: TENANT,
      email_normalized: email,
      display_name: role,
      role,
      frappe_user_id: email,
      active: 1,
      created_by: APPROVER,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    },
  };
}

function request(path: string, body?: Record<string, unknown>, idempotency?: string): Request {
  const headers = new Headers({ "x-csrf-token": "csrf" });
  if (body) headers.set("content-type", "application/json");
  if (idempotency) headers.set("idempotency-key", idempotency);
  return new Request(`https://app.example.com${path}`, {
    method: body ? "POST" : "GET",
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

function triageBody(lead = "lead:api-1"): Record<string, unknown> {
  return {
    lead_envelope_id: lead,
    triage_summary: "Roof leak reported after hail; verify address and inspection window.",
    request_text: "Record local triage only after owner review.",
  };
}

function containsCapability(value: unknown): boolean {
  if (typeof value === "string") return /dry_run_receipt|approval_receipt|write_args_json|broker-secret/i.test(value);
  if (Array.isArray(value)) return value.some(containsCapability);
  if (value && typeof value === "object") {
    return Object.entries(value).some(([key, child]) =>
      /dry_run_receipt|approval_receipt|write_args_json/i.test(key) || containsCapability(child));
  }
  return false;
}

function installBrokerMock(options: { invalidExecuteSignature?: boolean } = {}) {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const inbound = input instanceof Request ? input : new Request(input, init);
    const raw = await inbound.text();
    const path = new URL(inbound.url).pathname;
    calls.push(path);
    assertValidWorkerSignature(inbound, path, raw);
    const body = JSON.parse(raw) as Record<string, unknown>;
    if (path === "/v1/lead-triage/preview") {
      return signedBrokerResponse(inbound, path, raw, previewResponse(body));
    }
    if (path === "/v1/lead-triage/execute") {
      if (options.invalidExecuteSignature) return Response.json({ outcome: { state: "executed" } });
      return signedBrokerResponse(inbound, path, raw, executeResponse(body));
    }
    return signedBrokerResponse(inbound, path, raw, { error: "not_found" }, 404);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function previewResponse(body: Record<string, unknown>): Record<string, unknown> {
  const lead = String(body.lead_envelope_id);
  const triageSummary = String(body.triage_summary);
  const requestText = String(body.request_text);
  const runId = String(body.run_id);
  return {
    approval_request_id: body.approval_request_id,
    tenant_id: body.tenant_id,
    packet: {
      request_kind: "lead_triage",
      write_tool: "request_mark_lead_triaged",
      dry_run_tool: "dry_run_mark_lead_triaged",
      agent_role: "lead-concierge",
      actor_user: "concierge@example.com",
      site_id: "site-ironwrap",
      target: { doctype: "Lead Envelope", name: lead },
      lead_envelope_id: lead,
      request_text: requestText,
      write_args_json: canonicalJson({
        lead_envelope_id: lead,
        triage_summary: triageSummary,
        request_text: requestText,
        approved_by: APPROVER,
        run_id: runId,
      }),
      preview_json: canonicalJson({
        would_write: false,
        target: { doctype: "Lead Envelope", name: lead },
        before: { triage_status: "Untriaged", triaged_by: null, triaged_at: null, triage_summary: null },
        patch: {
          triage_status: "Triaged",
          triaged_by: APPROVER,
          triaged_at: null,
          triage_summary: triageSummary,
        },
        transport_status_unchanged: "pushed",
        communication_events_mutated: false,
      }),
      args_digest: "a".repeat(64),
      preview_digest: "b".repeat(64),
      dry_run_receipt: "dry-run-receipt-never-browser-visible".padEnd(64, "x"),
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      run_id: runId,
      intent_fingerprint: "c".repeat(64),
    },
  };
}

function executeResponse(body: Record<string, unknown>): Record<string, unknown> {
  const request = body.approval_request as Record<string, unknown>;
  return {
    outcome: {
      state: "executed",
      hermes_run_id: request.run_id,
      result_json: canonicalJson({
        run_id: request.run_id,
        lead_envelope_id: request.lead_envelope_id,
        updated: true,
        audit_finalized: true,
        replayed: false,
        communication_events_mutated: false,
      }),
      error_code: null,
    },
  };
}

function assertValidWorkerSignature(request: Request, path: string, raw: string): void {
  const keyId = request.headers.get("x-ironwrap-internal-key-id");
  const timestamp = request.headers.get("x-ironwrap-internal-timestamp");
  const nonce = request.headers.get("x-ironwrap-internal-nonce");
  const signature = request.headers.get("x-ironwrap-internal-signature");
  assert.equal(request.headers.get("x-ironwrap-internal-version"), "1");
  assert.equal(keyId, KEY_ID);
  assert.match(timestamp ?? "", /^[0-9]{13}$/);
  assert.match(nonce ?? "", /^[A-Za-z0-9_-]{32}$/);
  const expected = hmac(["1", KEY_ID, "POST", path, timestamp, nonce, sha256(raw)].join("\n"));
  assert.equal(signature, expected);
}

function signedBrokerResponse(
  request: Request,
  path: string,
  rawRequest: string,
  body: Record<string, unknown>,
  status = 200,
): Response {
  const rawResponse = JSON.stringify(body);
  const requestTimestamp = request.headers.get("x-ironwrap-internal-timestamp") ?? "";
  const nonce = request.headers.get("x-ironwrap-internal-nonce") ?? "";
  const responseTimestamp = String(Date.now());
  const signature = hmac([
    "1", KEY_ID, String(status), path, requestTimestamp, nonce, sha256(rawRequest), responseTimestamp, sha256(rawResponse),
  ].join("\n"));
  return new Response(rawResponse, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-ironwrap-internal-version": "1",
      "x-ironwrap-internal-key-id": KEY_ID,
      "x-ironwrap-internal-timestamp": responseTimestamp,
      "x-ironwrap-internal-request-timestamp": requestTimestamp,
      "x-ironwrap-internal-nonce": nonce,
      "x-ironwrap-internal-signature": signature,
    },
  });
}

function hmac(value: string): string {
  return createHmac("sha256", SHARED_SECRET).update(value).digest("base64url");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

test("approval API keeps the broker boundary opaque, CAS-safe, and owner-gated", async () => {
  const appEnv = env();
  const broker = installBrokerMock();
  try {
    const body = triageBody();
    const prepared = await handleAuthenticatedRoute(
      request("/api/v1/approvals/lead-triage", body, "prepare-api-approval-0001"),
      appEnv,
      auth("owner"),
    );
    assert.equal(prepared.status, 201);
    const preparedJson = await prepared.json() as { approval: { id: string; version: number; state: string } };
    assert.equal(preparedJson.approval.state, "pending");
    assert.equal(containsCapability(preparedJson), false);
    assert.deepEqual(broker.calls, ["/v1/lead-triage/preview"]);

    const replayed = await handleAuthenticatedRoute(
      request("/api/v1/approvals/lead-triage", body, "prepare-api-approval-0001"),
      appEnv,
      auth("owner"),
    );
    assert.equal(replayed.status, 200);
    assert.equal((await replayed.json() as { replayed: boolean }).replayed, true);
    assert.deepEqual(broker.calls, ["/v1/lead-triage/preview"], "same prepare key must not run another dry run");

    const ownerRead = await handleAuthenticatedRoute(request("/api/v1/approvals"), appEnv, auth("owner"));
    assert.equal(ownerRead.status, 200);
    assert.deepEqual((await ownerRead.json() as { allowed_actions: string[] }).allowed_actions, [
      "approval.read",
      "approval.prepare",
      "approval.reject",
      "approval.reconcile",
      "approval.approve",
    ]);

    const officeRead = await handleAuthenticatedRoute(request("/api/v1/approvals"), appEnv, auth("ops"));
    assert.equal(officeRead.status, 200);
    const officeJson = await officeRead.json() as { approvals: unknown[]; allowed_actions: string[] };
    assert.equal(officeJson.approvals.length, 1);
    assert.deepEqual(officeJson.allowed_actions, ["approval.read", "approval.prepare"]);
    assert.equal(containsCapability(officeJson), false);

    const opsDecision = await handleAuthenticatedRoute(
      request(`/api/v1/approvals/${preparedJson.approval.id}/approve`, { version: preparedJson.approval.version }, "decision-api-approval-0001"),
      appEnv,
      auth("ops"),
    );
    assert.equal(opsDecision.status, 403);
    assert.equal((await opsDecision.json() as { error: string }).error, "owner_role_required");

    const executed = await handleAuthenticatedRoute(
      request(`/api/v1/approvals/${preparedJson.approval.id}/approve`, { version: preparedJson.approval.version }, "decision-api-approval-0001"),
      appEnv,
      auth("owner"),
    );
    assert.equal(executed.status, 200);
    const executedJson = await executed.json() as { approval: { state: string; outcome: { updated: boolean; audit_finalized: boolean } } };
    assert.equal(executedJson.approval.state, "executed");
    assert.deepEqual(executedJson.approval.outcome, { updated: true, audit_finalized: true, replayed: false, run_id: executedJson.approval.outcome.run_id, lead_envelope_id: "lead:api-1", communication_events_mutated: false });
    assert.equal(containsCapability(executedJson), false);
    assert.deepEqual(broker.calls, ["/v1/lead-triage/preview", "/v1/lead-triage/execute"]);

    const executeReplay = await handleAuthenticatedRoute(
      request(`/api/v1/approvals/${preparedJson.approval.id}/approve`, { version: preparedJson.approval.version }, "decision-api-approval-0001"),
      appEnv,
      auth("owner"),
    );
    assert.equal(executeReplay.status, 200);
    assert.equal((await executeReplay.json() as { replayed: boolean }).replayed, true);
    assert.deepEqual(broker.calls, ["/v1/lead-triage/preview", "/v1/lead-triage/execute"], "same decision never invokes broker twice");
  } finally {
    broker.restore();
  }
});

test("an unverified broker execute result becomes a non-retryable uncertainty", async () => {
  const appEnv = env();
  const broker = installBrokerMock({ invalidExecuteSignature: true });
  try {
    const prepared = await handleAuthenticatedRoute(
      request("/api/v1/approvals/lead-triage", triageBody("lead:api-uncertain"), "prepare-api-uncertain-0001"),
      appEnv,
      auth("owner"),
    );
    const json = await prepared.json() as { approval: { id: string; version: number } };
    const uncertain = await handleAuthenticatedRoute(
      request(`/api/v1/approvals/${json.approval.id}/approve`, { version: json.approval.version }, "decision-api-uncertain-0001"),
      appEnv,
      auth("owner"),
    );
    assert.equal(uncertain.status, 502);
    const uncertainJson = await uncertain.json() as {
      error: string;
      approval: { state: string; error_code: string; version: number };
    };
    assert.equal(uncertainJson.error, "execution_uncertain");
    assert.equal(uncertainJson.approval.state, "execution_uncertain");
    assert.equal(uncertainJson.approval.error_code, "broker_response_unverified");
    assert.equal(containsCapability(uncertainJson), false);

    const retry = await handleAuthenticatedRoute(
      request(`/api/v1/approvals/${json.approval.id}/approve`, { version: json.approval.version }, "decision-api-uncertain-0001"),
      appEnv,
      auth("owner"),
    );
    assert.equal(retry.status, 200);
    assert.equal((await retry.json() as { replayed: boolean }).replayed, true);
    assert.deepEqual(broker.calls, ["/v1/lead-triage/preview", "/v1/lead-triage/execute"], "uncertain work is never retried automatically");

    const reconciled = await handleAuthenticatedRoute(
      request(
        `/api/v1/approvals/${json.approval.id}/reconcile`,
        {
          version: uncertainJson.approval.version,
          outcome: "inconclusive",
          evidence: "The recorded Hermes Run could not be reached; no second write was issued.",
        },
      ),
      appEnv,
      auth("owner"),
    );
    assert.equal(reconciled.status, 200);
    const reconciledJson = await reconciled.json() as {
      approval: { state: string; reconciliation: { outcome: string; evidence: string } };
    };
    assert.equal(reconciledJson.approval.state, "execution_uncertain");
    assert.equal(reconciledJson.approval.reconciliation.outcome, "inconclusive");
    assert.match(reconciledJson.approval.reconciliation.evidence, /no second write/i);
  } finally {
    broker.restore();
  }
});

test("a configured approver can reject a pending request when the broker later becomes unavailable", async () => {
  const appEnv = env();
  const broker = installBrokerMock();
  try {
    const prepared = await handleAuthenticatedRoute(
      request("/api/v1/approvals/lead-triage", triageBody("lead:api-reject"), "prepare-api-reject-0001"),
      appEnv,
      auth("owner"),
    );
    const json = await prepared.json() as { approval: { id: string; version: number } };
    appEnv.APPROVAL_BROKER_SHARED_SECRET = "";

    const rejected = await handleAuthenticatedRoute(
      request(
        `/api/v1/approvals/${json.approval.id}/reject`,
        { version: json.approval.version, reason: "A verified inspection window is still missing." },
        "decision-api-reject-0001",
      ),
      appEnv,
      auth("owner"),
    );

    assert.equal(rejected.status, 200);
    assert.equal((await rejected.json() as { approval: { state: string } }).approval.state, "denied");
    assert.deepEqual(broker.calls, ["/v1/lead-triage/preview"], "rejection must not depend on a broker invocation");
  } finally {
    broker.restore();
  }
});
