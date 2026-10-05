import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { handleAuthenticatedRoute } from "../src/app-api.ts";
import { permissionsForRole } from "../src/app-types.ts";
import type { AppEnv, AppRole, AuthContext } from "../src/app-types.ts";
import type { ApprovedSnapshot } from "../src/approval-snapshot.ts";

const TENANT = "ironwrap";
const SHARED_SECRET = "quote-revision-broker-shared-secret-for-test-0001";
const KEY_ID = "quote-revision-test-key";
const APPROVER = "owner@example.com";

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    for (const migration of [
      "0011_app_bff_auth.sql",
      "0017_quote_revision_approval_requests.sql",
      "0030_facet_design_ingest.sql",
      "0034_facet_customer_approval_ingest.sql",
      "0035_facet_design_evidence_associations.sql",
    ]) {
      this.raw.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
    }
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
    APP_QUOTE_REVISION_BROKER_URL: "http://127.0.0.1:8789",
    APP_QUOTE_REVISION_BROKER_KEY_ID: KEY_ID,
    QUOTE_REVISION_BROKER_SHARED_SECRET: SHARED_SECRET,
    APP_QUOTE_REVISION_BROKER_TIMEOUT_MS: "5000",
    APP_QUOTE_REVISION_EXECUTION_LEASE_SECONDS: "45",
    APP_APPROVAL_APPROVER_ID: APPROVER,
    APP_APPROVAL_MAX_SESSION_AGE_SECONDS: "900",
  } as AppEnv;
}

function auth(role: AppRole): AuthContext {
  const now = new Date();
  const userId = role === "owner" ? "appu_owner_0001" : "appu_ops_0001";
  const email = role === "owner" ? APPROVER : "ops@example.com";
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: permissionsForRole(role),
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

function request(
  path: string,
  body?: Record<string, unknown>,
  idempotency?: string,
  csrf = true,
): Request {
  const headers = new Headers();
  if (csrf) headers.set("x-csrf-token", "csrf");
  if (body) headers.set("content-type", "application/json");
  if (idempotency) headers.set("idempotency-key", idempotency);
  return new Request(`https://app.example.com${path}`, {
    method: body ? "POST" : "GET",
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

function preparationBody(): Record<string, unknown> {
  return {
    roof_job_id: "job:api-1",
    customer_quote_id: "customer-quote:api-1",
    correction_reason: "Field evidence and supplier confirmation changed after the earlier review.",
  };
}

function containsCapability(value: unknown): boolean {
  if (typeof value === "string") {
    return /dry_run_receipt|approval_receipt|write_args_json|receipt_preview_digest|quote_total|tax_|payment_|customer:api/i.test(value);
  }
  if (Array.isArray(value)) return value.some(containsCapability);
  if (value && typeof value === "object") {
    return Object.entries(value).some(([key, child]) =>
      /dry_run_receipt|approval_receipt|write_args_json|receipt_preview_digest|quote_total|tax_|payment_/i.test(key) ||
      containsCapability(child));
  }
  return false;
}

function installBrokerMock(options: { invalidExecuteSignature?: boolean; sourceQuoteVersion?: number; executeState?: "failed" | "audit_failed" } = {}) {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const inbound = input instanceof Request ? input : new Request(input, init);
    const raw = await inbound.text();
    const path = new URL(inbound.url).pathname;
    calls.push(path);
    assertValidWorkerSignature(inbound, path, raw);
    const body = JSON.parse(raw) as Record<string, unknown>;
    if (path === "/v1/quote-revision/preview") {
      const response = previewResponse(body);
      const packet = response.packet as Record<string, unknown>;
      const preview = JSON.parse(String(packet.preview_json));
      preview.source.quote_version = options.sourceQuoteVersion ?? 1;
      preview.draft.quote_version = preview.source.quote_version + 1;
      packet.preview_json = JSON.stringify(preview);
      return signedBrokerResponse(inbound, path, raw, response);
    }
    if (path === "/v1/quote-revision/execute") {
      if (options.invalidExecuteSignature) return Response.json({ outcome: { state: "executed" } });
      const approvalRequest = body.approval_request as Record<string, unknown>;
      if (options.executeState) return signedBrokerResponse(inbound, path, raw, {
        outcome: { state: options.executeState, hermes_run_id: approvalRequest.run_id,
          result_json: null, error_code: "broker_saved_review_failed" },
      });
      return signedBrokerResponse(inbound, path, raw, executeResponse(body));
    }
    return signedBrokerResponse(inbound, path, raw, { error: "not_found" }, 404);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function previewResponse(body: Record<string, unknown>): Record<string, unknown> {
  const quote = String(body.customer_quote_id);
  const job = String(body.roof_job_id);
  const reason = String(body.correction_reason);
  const requestText = String(body.request_text);
  const runId = String(body.run_id);
  const target = "quote-revision:job-api-1-v2";
  return {
    approval_request_id: body.approval_request_id,
    tenant_id: body.tenant_id,
    packet: {
      request_kind: "quote_revision",
      write_tool: "request_create_quote_revision",
      dry_run_tool: "dry_run_quote_revision",
      agent_role: "estimator-assistant",
      actor_user: "estimator@example.com",
      site_id: "site-ironwrap",
      target: { doctype: "Customer Quote", name: target },
      roof_job_id: job,
      customer_quote_id: quote,
      correction_reason: reason,
      request_text: requestText,
      write_args_json: JSON.stringify({
        roof_job_id: job,
        customer_quote_id: quote,
        correction_reason: reason,
        request_text: requestText,
        approved_by: APPROVER,
        run_id: runId,
      }),
      preview_json: JSON.stringify({
        would_write: false,
        required_tool: "request_create_quote_revision",
        target: { doctype: "Customer Quote", name: target },
        append_only: true,
        source: {
          customer_quote_id: quote,
          roof_job: job,
          quote_version: 1,
          status: "Approved",
          modified: "2026-07-12T10:00:00.000Z",
        },
        observed_quote_count: 1,
        draft: {
          customer_quote_id: target,
          roof_job: job,
          quote_version: 2,
          status: "Draft",
          supersedes: quote,
          correction_reason: reason,
        },
      }),
      args_digest: "a".repeat(64),
      preview_digest: "b".repeat(64),
      receipt_preview_digest: "c".repeat(64),
      dry_run_receipt: "dry-run-receipt-never-browser-visible".padEnd(64, "x"),
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      run_id: runId,
      intent_fingerprint: "d".repeat(64),
    },
  };
}

function executeResponse(body: Record<string, unknown>): Record<string, unknown> {
  const request = body.approval_request as Record<string, unknown>;
  const brokerPreview = JSON.parse(String(request.preview_json));
  assert.equal(Object.hasOwn(brokerPreview, "approved_snapshot"), false, "Worker metadata must not alter the broker contract");
  assert.equal(brokerPreview.source.quote_version, 1, "execute must use the originally saved review");
  assert.equal(request.preview_digest, "b".repeat(64));
  assert.equal(request.receipt_preview_digest, "c".repeat(64));
  return {
    outcome: {
      state: "executed",
      hermes_run_id: request.run_id,
      result_json: JSON.stringify({
        run_id: request.run_id,
        customer_quote_id: request.target_name,
        roof_job_id: request.roof_job_id,
        source_customer_quote_id: request.customer_quote_id,
        quote_version: 2,
        supersedes: request.customer_quote_id,
        created: true,
        audit_finalized: true,
        replayed: false,
        append_only: true,
        commercial_fields_mutated: false,
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

test("quote revision API keeps the commercial boundary opaque and approval authority isolated", async () => {
  const appEnv = env();
  const source = { sourceQuoteVersion: 1 };
  const broker = installBrokerMock(source);
  try {
    const body = preparationBody();
    const prepared = await handleAuthenticatedRoute(
      request("/api/v1/quote-revision-approvals", body, "prepare-quote-revision-api-0001"),
      appEnv,
      auth("owner"),
    );
    assert.equal(prepared.status, 201);
    const preparedJson = await prepared.json() as { approval: { id: string; version: number; state: string; approved_snapshot: ApprovedSnapshot } };
    assert.equal(preparedJson.approval.state, "pending");
    assert.match(preparedJson.approval.approved_snapshot.snapshot_id, /^approval-snapshot:[0-9a-f]{64}$/);
    assert.equal(preparedJson.approval.approved_snapshot.version_label, "Source quote v1 (correction draft review)");
    assert.equal(containsCapability(preparedJson), false);
    assert.deepEqual(broker.calls, ["/v1/quote-revision/preview"]);

    source.sourceQuoteVersion = 4;
    const frozenRead = await handleAuthenticatedRoute(request(`/api/v1/quote-revision-approvals/${preparedJson.approval.id}`), appEnv, auth("owner"));
    assert.deepEqual((await frozenRead.json() as { approval: { approved_snapshot: ApprovedSnapshot } }).approval.approved_snapshot, preparedJson.approval.approved_snapshot);
    const replayed = await handleAuthenticatedRoute(
      request("/api/v1/quote-revision-approvals", body, "prepare-quote-revision-api-0001"),
      appEnv,
      auth("owner"),
    );
    assert.equal(replayed.status, 200);
    const replayedJson = await replayed.json() as { replayed: boolean; approval: { approved_snapshot: ApprovedSnapshot } };
    assert.equal(replayedJson.replayed, true);
    assert.deepEqual(replayedJson.approval.approved_snapshot, preparedJson.approval.approved_snapshot);
    assert.deepEqual(broker.calls, ["/v1/quote-revision/preview"], "prepare replay must not re-run a dry run");

    const ownerRead = await handleAuthenticatedRoute(request("/api/v1/quote-revision-approvals"), appEnv, auth("owner"));
    assert.equal(ownerRead.status, 200);
    assert.deepEqual((await ownerRead.json() as { allowed_actions: string[] }).allowed_actions, [
      "quote_revision_approval.read",
      "quote_revision_approval.prepare",
      "quote_revision_approval.reject",
      "quote_revision_approval.reconcile",
      "quote_revision_approval.approve",
    ]);

    const officeRead = await handleAuthenticatedRoute(request("/api/v1/quote-revision-approvals"), appEnv, auth("ops"));
    assert.equal(officeRead.status, 200);
    const officeJson = await officeRead.json() as { approvals: unknown[]; allowed_actions: string[] };
    assert.equal(officeJson.approvals.length, 1);
    assert.deepEqual(officeJson.allowed_actions, ["quote_revision_approval.read", "quote_revision_approval.prepare"]);
    assert.equal(containsCapability(officeJson), false);

    const opsDecision = await handleAuthenticatedRoute(
      request(
        `/api/v1/quote-revision-approvals/${preparedJson.approval.id}/approve`,
        { version: preparedJson.approval.version },
        "decision-quote-revision-api-0001",
      ),
      appEnv,
      auth("ops"),
    );
    assert.equal(opsDecision.status, 403);
    assert.equal((await opsDecision.json() as { error: string }).error, "owner_role_required");

    const executed = await handleAuthenticatedRoute(
      request(
        `/api/v1/quote-revision-approvals/${preparedJson.approval.id}/approve`,
        { version: preparedJson.approval.version },
        "decision-quote-revision-api-0001",
      ),
      appEnv,
      auth("owner"),
    );
    assert.equal(executed.status, 200);
    const executedJson = await executed.json() as {
      approval: { state: string; approved_snapshot: ApprovedSnapshot; outcome: { created: boolean; audit_finalized: boolean; commercial_terms_copied: boolean } };
    };
    assert.equal(executedJson.approval.state, "executed");
    assert.deepEqual(executedJson.approval.approved_snapshot, preparedJson.approval.approved_snapshot);
    assert.equal(executedJson.approval.outcome.created, true);
    assert.equal(executedJson.approval.outcome.audit_finalized, true);
    assert.equal(executedJson.approval.outcome.commercial_terms_copied, false);
    assert.equal(containsCapability(executedJson), false);
    assert.deepEqual(broker.calls, ["/v1/quote-revision/preview", "/v1/quote-revision/execute"]);

    const executeReplay = await handleAuthenticatedRoute(
      request(
        `/api/v1/quote-revision-approvals/${preparedJson.approval.id}/approve`,
        { version: preparedJson.approval.version },
        "decision-quote-revision-api-0001",
      ),
      appEnv,
      auth("owner"),
    );
    assert.equal(executeReplay.status, 200);
    const executeReplayJson = await executeReplay.json() as { replayed: boolean; approval: { approved_snapshot: ApprovedSnapshot } };
    assert.equal(executeReplayJson.replayed, true);
    assert.deepEqual(executeReplayJson.approval.approved_snapshot, preparedJson.approval.approved_snapshot);
    const competing = await handleAuthenticatedRoute(request(
      `/api/v1/quote-revision-approvals/${preparedJson.approval.id}/approve`,
      { version: preparedJson.approval.version }, "decision-quote-revision-competing-0001",
    ), appEnv, auth("owner"));
    assert.equal(competing.status, 409);
    assert.deepEqual(broker.calls, ["/v1/quote-revision/preview", "/v1/quote-revision/execute"], "approval replay must never write twice");
  } finally {
    broker.restore();
  }
});

test("the legacy Facet manual quote-revision route is permanently quarantined", async () => {
  const appEnv = env();
  appEnv.APP_FACET_QUOTE_REVISION_PREPARE_ENABLED = "true";
  const response = await handleAuthenticatedRoute(
    request(
      "/api/v1/facet-design-evidence/associations/legacy-event/quote-revision-approvals",
      { correction_reason: "Legacy preparation must never be reachable." },
    ),
    appEnv,
    auth("owner"),
  );

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not_found" });
});

test("an unverified quote revision broker execution becomes reconciliation-only uncertainty", async () => {
  const appEnv = env();
  const broker = installBrokerMock({ invalidExecuteSignature: true });
  try {
    const prepared = await handleAuthenticatedRoute(
      request("/api/v1/quote-revision-approvals", preparationBody(), "prepare-quote-revision-uncertain-0001"),
      appEnv,
      auth("owner"),
    );
    const json = await prepared.json() as { approval: { id: string; version: number; approved_snapshot: ApprovedSnapshot } };
    const uncertain = await handleAuthenticatedRoute(
      request(
        `/api/v1/quote-revision-approvals/${json.approval.id}/approve`,
        { version: json.approval.version },
        "decision-quote-revision-uncertain-0001",
      ),
      appEnv,
      auth("owner"),
    );
    assert.equal(uncertain.status, 502);
    const uncertainJson = await uncertain.json() as {
      error: string;
      approval: { state: string; error_code: string; version: number; approved_snapshot: ApprovedSnapshot };
    };
    assert.equal(uncertainJson.error, "execution_uncertain");
    assert.equal(uncertainJson.approval.state, "execution_uncertain");
    assert.equal(uncertainJson.approval.error_code, "quote_revision_broker_response_unverified");
    assert.deepEqual(uncertainJson.approval.approved_snapshot, json.approval.approved_snapshot);
    assert.equal(containsCapability(uncertainJson), false);

    const retry = await handleAuthenticatedRoute(
      request(
        `/api/v1/quote-revision-approvals/${json.approval.id}/approve`,
        { version: json.approval.version },
        "decision-quote-revision-uncertain-0001",
      ),
      appEnv,
      auth("owner"),
    );
    assert.equal(retry.status, 200);
    assert.equal((await retry.json() as { replayed: boolean }).replayed, true);
    assert.deepEqual(broker.calls, ["/v1/quote-revision/preview", "/v1/quote-revision/execute"], "uncertain work is never retried");
    const reconciled = await handleAuthenticatedRoute(request(
      `/api/v1/quote-revision-approvals/${json.approval.id}/reconcile`, {
        version: uncertainJson.approval.version, outcome: "inconclusive",
        evidence: "The recorded execution could not be confirmed; no second correction was attempted.",
      },
    ), appEnv, auth("owner"));
    assert.equal(reconciled.status, 200);
    assert.deepEqual((await reconciled.json() as { approval: { approved_snapshot: ApprovedSnapshot } }).approval.approved_snapshot, json.approval.approved_snapshot);
  } finally {
    broker.restore();
  }
});

test("quote correction failure and audit failure retain the frozen review through decision replay", async () => {
  for (const executeState of ["failed", "audit_failed"] as const) {
    const appEnv = env();
    const broker = installBrokerMock({ executeState });
    try {
      const prepared = await handleAuthenticatedRoute(request(
        "/api/v1/quote-revision-approvals", preparationBody(), "prepare-failure-0001",
      ), appEnv, auth("owner"));
      assert.equal(prepared.status, 201);
      const json = await prepared.json() as { approval: { id: string; version: number; approved_snapshot: ApprovedSnapshot } };
      const approve = () => handleAuthenticatedRoute(request(
        `/api/v1/quote-revision-approvals/${json.approval.id}/approve`, { version: json.approval.version }, "decision-failure-0001",
      ), appEnv, auth("owner"));
      const failed = await approve();
      assert.equal(failed.status, 422);
      const result = await failed.json() as { approval: { state: string; approved_snapshot: ApprovedSnapshot } };
      assert.equal(result.approval.state, executeState);
      assert.deepEqual(result.approval.approved_snapshot, json.approval.approved_snapshot);
      const replay = await approve();
      assert.equal(replay.status, 200);
      const replayJson = await replay.json() as { replayed: boolean; approval: { approved_snapshot: ApprovedSnapshot } };
      assert.equal(replayJson.replayed, true);
      assert.deepEqual(replayJson.approval.approved_snapshot, json.approval.approved_snapshot);
      assert.deepEqual(broker.calls, ["/v1/quote-revision/preview", "/v1/quote-revision/execute"]);
    } finally {
      broker.restore();
    }
  }
});

test("quote revision preparation does not create an unapprovable pending record", async () => {
  const appEnv = env();
  appEnv.APP_APPROVAL_APPROVER_ID = "";
  const broker = installBrokerMock();
  try {
    const prepared = await handleAuthenticatedRoute(
      request("/api/v1/quote-revision-approvals", preparationBody(), "prepare-quote-revision-no-approver-0001"),
      appEnv,
      auth("owner"),
    );
    assert.equal(prepared.status, 503);
    assert.equal((await prepared.json() as { error: string }).error, "quote_revision_broker_not_configured");
    assert.deepEqual(broker.calls, []);
  } finally {
    broker.restore();
  }
});
