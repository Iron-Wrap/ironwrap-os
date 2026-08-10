import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { handleAuthenticatedRoute } from "../src/app-api.ts";
import type { AppEnv, AppRole, AuthContext } from "../src/app-types.ts";

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

const FACET_EVENT_ID = "facet-event-v2-quote-revision-api-0001";
const FACET_PROJECT_ID = "facet-project-quote-revision-api-0001";
const FACET_DESIGN_SHA256 = "e".repeat(64);
const FACET_FROZEN_SHA256 = "f".repeat(64);
const FACET_DESIGN_REVISION_ID = `facet-json-v1:${FACET_DESIGN_SHA256}`;

function seedFacetAssociation(
  db: SqliteD1,
  storedAssociationSha256?: string,
): string {
  db.raw.prepare(
    `INSERT INTO facet_customer_approval_events
       (event_id, event_type, schema_version, occurred_at, tenant_id, brand_id,
        facet_project_id, design_revision_id, design_revision_sha256,
        frozen_evidence_sha256, approval_actor_type, capability_fingerprint,
        raw_key, raw_sha256, raw_content_length, received_at)
     VALUES (?, 'facet.design.customer_approved.v2', 2, ?, ?, 'ironwrap', ?, ?, ?, ?,
             'customer_capability', ?, ?, ?, 512, ?)`,
  ).run(
    FACET_EVENT_ID,
    "2026-08-10T12:00:00.000Z",
    TENANT,
    FACET_PROJECT_ID,
    FACET_DESIGN_REVISION_ID,
    FACET_DESIGN_SHA256,
    FACET_FROZEN_SHA256,
    "1".repeat(64),
    `facet-design/v2/${FACET_EVENT_ID}.json`,
    "2".repeat(64),
    "2026-08-10T12:01:00.000Z",
  );
  const anchor = {
    brand_id: "ironwrap",
    customer_quote_id: "customer-quote:api-1",
    design_revision_id: FACET_DESIGN_REVISION_ID,
    design_revision_sha256: FACET_DESIGN_SHA256,
    event_id: FACET_EVENT_ID,
    facet_project_id: FACET_PROJECT_ID,
    frozen_evidence_sha256: FACET_FROZEN_SHA256,
    roof_job_id: "job:api-1",
    tenant_id: TENANT,
  };
  const associationSha256 = sha256(JSON.stringify(anchor));
  db.raw.prepare(
    `INSERT INTO facet_design_evidence_associations
       (event_id, tenant_id, brand_id, facet_project_id, design_revision_id,
        design_revision_sha256, frozen_evidence_sha256, roof_job_id, customer_quote_id,
        associated_by_user_id, reason, idempotency_key_sha256, association_intent_sha256,
        association_anchor_sha256, associated_at)
     VALUES (?, ?, 'ironwrap', ?, ?, ?, ?, 'job:api-1', 'customer-quote:api-1',
             'appu_ops_0001', ?, ?, ?, ?, ?)`,
  ).run(
    FACET_EVENT_ID,
    TENANT,
    FACET_PROJECT_ID,
    FACET_DESIGN_REVISION_ID,
    FACET_DESIGN_SHA256,
    FACET_FROZEN_SHA256,
    "Operator matched the approved quote and Roof Job before this integration test.",
    "3".repeat(64),
    "4".repeat(64),
    storedAssociationSha256 ?? associationSha256,
    "2026-08-10T12:02:00.000Z",
  );
  return associationSha256;
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
    if (path === "/v1/quote-revision/preview") {
      return signedBrokerResponse(inbound, path, raw, previewResponse(body));
    }
    if (path === "/v1/quote-revision/execute") {
      if (options.invalidExecuteSignature) return Response.json({ outcome: { state: "executed" } });
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
  const broker = installBrokerMock();
  try {
    const body = preparationBody();
    const prepared = await handleAuthenticatedRoute(
      request("/api/v1/quote-revision-approvals", body, "prepare-quote-revision-api-0001"),
      appEnv,
      auth("owner"),
    );
    assert.equal(prepared.status, 201);
    const preparedJson = await prepared.json() as { approval: { id: string; version: number; state: string } };
    assert.equal(preparedJson.approval.state, "pending");
    assert.equal(containsCapability(preparedJson), false);
    assert.deepEqual(broker.calls, ["/v1/quote-revision/preview"]);

    const replayed = await handleAuthenticatedRoute(
      request("/api/v1/quote-revision-approvals", body, "prepare-quote-revision-api-0001"),
      appEnv,
      auth("owner"),
    );
    assert.equal(replayed.status, 200);
    assert.equal((await replayed.json() as { replayed: boolean }).replayed, true);
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
      approval: { state: string; outcome: { created: boolean; audit_finalized: boolean; commercial_terms_copied: boolean } };
    };
    assert.equal(executedJson.approval.state, "executed");
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
    assert.equal((await executeReplay.json() as { replayed: boolean }).replayed, true);
    assert.deepEqual(broker.calls, ["/v1/quote-revision/preview", "/v1/quote-revision/execute"], "approval replay must never write twice");
  } finally {
    broker.restore();
  }
});

test("a resolved Facet v2 association prepares only the existing blank quote-revision approval rail", async () => {
  const db = new SqliteD1();
  const associationSha256 = seedFacetAssociation(db);
  const appEnv = env(db);
  const path = `/api/v1/facet-design-evidence/associations/${FACET_EVENT_ID}/quote-revision-approvals`;
  const body = {
    correction_reason: "Customer-approved design evidence requires a separately reviewed quote revision.",
  };
  const broker = installBrokerMock();
  try {
    const disabled = await handleAuthenticatedRoute(
      request(path, body),
      appEnv,
      auth("ops"),
    );
    assert.equal(disabled.status, 403);
    assert.deepEqual(await disabled.json(), {
      error: "facet_quote_revision_prepare_disabled",
    });
    assert.deepEqual(broker.calls, []);

    appEnv.APP_FACET_QUOTE_REVISION_PREPARE_ENABLED = "true";
    const field = await handleAuthenticatedRoute(
      request(path, body),
      appEnv,
      auth("field"),
    );
    assert.equal(field.status, 403);
    const missingCsrf = await handleAuthenticatedRoute(
      request(path, body, undefined, false),
      appEnv,
      auth("ops"),
    );
    assert.equal(missingCsrf.status, 403);
    assert.deepEqual(await missingCsrf.json(), { error: "csrf_failed" });
    const callerSuppliedTarget = await handleAuthenticatedRoute(
      request(path, { ...body, roof_job_id: "job:caller-controlled" }),
      appEnv,
      auth("ops"),
    );
    assert.equal(callerSuppliedTarget.status, 400);
    const missing = await handleAuthenticatedRoute(
      request(
        "/api/v1/facet-design-evidence/associations/facet-event-v2-missing/quote-revision-approvals",
        body,
      ),
      appEnv,
      auth("ops"),
    );
    assert.equal(missing.status, 404);
    assert.deepEqual(broker.calls, []);

    const invalidDb = new SqliteD1();
    seedFacetAssociation(invalidDb, "9".repeat(64));
    const invalidEnv = env(invalidDb);
    invalidEnv.APP_FACET_QUOTE_REVISION_PREPARE_ENABLED = "true";
    const invalid = await handleAuthenticatedRoute(
      request(path, body),
      invalidEnv,
      auth("ops"),
    );
    assert.equal(invalid.status, 409);
    assert.deepEqual(await invalid.json(), {
      error: "facet_design_association_anchor_mismatch",
    });
    assert.deepEqual(broker.calls, []);

    const prepared = await handleAuthenticatedRoute(
      request(path, body),
      appEnv,
      auth("ops"),
    );
    assert.equal(prepared.status, 201);
    const preparedJson = await prepared.json() as {
      approval: {
        state: string;
        roof_job_id: string;
        source: { customer_quote_id: string };
        correction_reason: string;
        preview: { effects: Record<string, boolean> };
      };
    };
    assert.equal(preparedJson.approval.state, "pending");
    assert.equal(preparedJson.approval.roof_job_id, "job:api-1");
    assert.equal(
      preparedJson.approval.source.customer_quote_id,
      "customer-quote:api-1",
    );
    assert.match(preparedJson.approval.correction_reason, new RegExp(FACET_EVENT_ID));
    assert.match(preparedJson.approval.correction_reason, new RegExp(associationSha256));
    assert.deepEqual(preparedJson.approval.preview.effects, {
      customer_notified: false,
      commercial_terms_copied: false,
      proposal_sent: false,
      accounting_mutated: false,
    });
    assert.equal(containsCapability(preparedJson), false);
    assert.deepEqual(broker.calls, ["/v1/quote-revision/preview"]);

    const stored = db.raw.prepare(
      `SELECT prepare_idempotency_key, roof_job_id, source_customer_quote_id,
              correction_reason, state
       FROM quote_revision_approval_requests`,
    ).get() as Record<string, unknown>;
    assert.equal(
      stored.prepare_idempotency_key,
      `facet-quote-revision:${associationSha256}`,
    );
    assert.equal(stored.roof_job_id, "job:api-1");
    assert.equal(stored.source_customer_quote_id, "customer-quote:api-1");
    assert.equal(stored.state, "pending");

    const replay = await handleAuthenticatedRoute(
      request(path, body),
      appEnv,
      auth("ops"),
    );
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as { replayed: boolean }).replayed, true);
    const changedIntent = await handleAuthenticatedRoute(
      request(path, {
        correction_reason: "A different operator reason cannot reuse the same Facet association.",
      }),
      appEnv,
      auth("ops"),
    );
    assert.equal(changedIntent.status, 409);
    assert.deepEqual(broker.calls, ["/v1/quote-revision/preview"]);
    assert.equal(
      Number((db.raw.prepare(
        "SELECT COUNT(*) AS count FROM quote_revision_approval_requests",
      ).get() as { count: number }).count),
      1,
    );
  } finally {
    broker.restore();
  }
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
    const json = await prepared.json() as { approval: { id: string; version: number } };
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
      approval: { state: string; error_code: string; version: number };
    };
    assert.equal(uncertainJson.error, "execution_uncertain");
    assert.equal(uncertainJson.approval.state, "execution_uncertain");
    assert.equal(uncertainJson.approval.error_code, "quote_revision_broker_response_unverified");
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
  } finally {
    broker.restore();
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
