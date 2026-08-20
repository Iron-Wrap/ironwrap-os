import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { handleAuthenticatedRoute } from "../src/app-api.ts";
import { permissionsForRole } from "../src/app-types.ts";
import type { AppEnv, AppRole, AuthContext } from "../src/app-types.ts";

const TENANT = "ironwrap";
const SHARED_SECRET = "proposal-publication-broker-shared-secret-0001";
const KEY_ID = "proposal-publication-test-key";
const APPROVER = "owner@example.com";
const ROOF_JOB = "job:publish-1";
const CUSTOMER_QUOTE = "customer-quote:publish-1";
const PACK = `proposal:${CUSTOMER_QUOTE}`;

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    for (const migration of [
      "0011_app_bff_auth.sql",
      "0068_proposal_publication_approval_requests.sql",
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
    APP_PROPOSAL_PUBLICATION_ENABLED: "true",
    APP_PROPOSAL_PUBLICATION_BROKER_URL: "http://127.0.0.1:8790",
    APP_PROPOSAL_PUBLICATION_BROKER_KEY_ID: KEY_ID,
    PROPOSAL_PUBLICATION_BROKER_SHARED_SECRET: SHARED_SECRET,
    APP_PROPOSAL_PUBLICATION_BROKER_TIMEOUT_MS: "5000",
    APP_PROPOSAL_PUBLICATION_EXECUTION_LEASE_SECONDS: "45",
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
  return { roof_job_id: ROOF_JOB, proposal_evidence_pack_id: PACK };
}

/**
 * Publication authority lives entirely behind the Worker. Nothing the browser
 * receives may carry a receipt, a raw write argument, or a private digest. The
 * requester/approver app identities are deliberately in the projection; the
 * material that would let a browser replay the command is not.
 */
function containsCapability(value: unknown): boolean {
  if (typeof value === "string") {
    return /dry-run-receipt|dry_run_receipt|approval_receipt|write_args_json|receipt_preview_digest|args_digest|intent_fingerprint/i.test(
      value,
    );
  }
  if (Array.isArray(value)) return value.some(containsCapability);
  if (value && typeof value === "object") {
    return Object.entries(value).some(
      ([key, child]) =>
        /dry_run_receipt|approval_receipt|write_args_json|receipt_preview_digest|args_digest|intent_fingerprint|site_id|actor_user/i.test(
          key,
        ) || containsCapability(child),
    );
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
    if (path === "/v1/proposal-publication/preview") {
      return signedBrokerResponse(inbound, path, raw, previewResponse(body));
    }
    if (path === "/v1/proposal-publication/execute") {
      if (options.invalidExecuteSignature) return Response.json({ outcome: { state: "executed" } });
      return signedBrokerResponse(inbound, path, raw, executeResponse(body));
    }
    return signedBrokerResponse(inbound, path, raw, { error: "not_found" }, 404);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function previewResponse(body: Record<string, unknown>): Record<string, unknown> {
  const job = String(body.roof_job_id);
  const pack = String(body.proposal_evidence_pack_id);
  const requestText = String(body.request_text);
  const runId = String(body.run_id);
  return {
    approval_request_id: body.approval_request_id,
    tenant_id: body.tenant_id,
    packet: {
      request_kind: "proposal_publication",
      write_tool: "request_publish_proposal_evidence_pack",
      dry_run_tool: "dry_run_publish_proposal_evidence_pack",
      agent_role: "owner-operator",
      actor_user: "owner-operator@example.com",
      site_id: "site-ironwrap",
      target: { doctype: "Proposal Evidence Pack", name: pack },
      roof_job_id: job,
      proposal_evidence_pack_id: pack,
      customer_quote_id: CUSTOMER_QUOTE,
      request_text: requestText,
      write_args_json: JSON.stringify({
        proposal_evidence_pack_id: pack,
        request_text: requestText,
        approved_by: APPROVER,
        run_id: runId,
      }),
      preview_json: JSON.stringify({
        would_write: false,
        required_tool: "request_publish_proposal_evidence_pack",
        target: { doctype: "Proposal Evidence Pack", name: pack },
        before: {
          pack_id: pack,
          roof_job: job,
          quotation: CUSTOMER_QUOTE,
          status: "Draft",
        },
        publication: { status: "Approved" },
        customer_portal: {
          visible_after_publication: true,
          portal_link_issued: false,
          human_portal_link_issuance_required: true,
        },
        customer_delivery_mutated: false,
        contract_acceptance_mutated: false,
        customer_quote_mutated: false,
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
  const record = body.approval_request as Record<string, unknown>;
  return {
    outcome: {
      state: "executed",
      hermes_run_id: record.run_id,
      result_json: JSON.stringify({
        run_id: record.run_id,
        proposal_evidence_pack_id: record.proposal_evidence_pack_id,
        roof_job_id: record.roof_job_id,
        customer_quote_id: record.customer_quote_id,
        status: "Approved",
        published: true,
        audit_finalized: true,
        replayed: false,
        customer_delivery_mutated: false,
        customer_portal_link_issued: false,
        contract_acceptance_mutated: false,
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

test("proposal publication publishes once, replays idempotently, and never leaks its capability", async () => {
  const appEnv = env();
  const broker = installBrokerMock();
  try {
    const body = preparationBody();
    const prepared = await handleAuthenticatedRoute(
      request("/api/v1/proposal-publication-approvals", body, "prepare-proposal-publication-0001"),
      appEnv,
      auth("owner"),
    );
    assert.equal(prepared.status, 201);
    const preparedJson = await prepared.json() as {
      approval: {
        id: string;
        version: number;
        state: string;
        proposal_evidence_pack_id: string;
        customer_quote_id: string;
        preview: { customer_portal: { portal_link_issued: boolean }; effects: Record<string, boolean> } | null;
      };
    };
    assert.equal(preparedJson.approval.state, "pending");
    assert.equal(preparedJson.approval.proposal_evidence_pack_id, PACK);
    assert.equal(preparedJson.approval.customer_quote_id, CUSTOMER_QUOTE);
    assert.equal(preparedJson.approval.preview?.customer_portal.portal_link_issued, false);
    assert.deepEqual(preparedJson.approval.preview?.effects, {
      customer_delivery_mutated: false,
      contract_acceptance_mutated: false,
      customer_quote_mutated: false,
    });
    assert.equal(containsCapability(preparedJson), false);
    assert.deepEqual(broker.calls, ["/v1/proposal-publication/preview"]);

    const replayed = await handleAuthenticatedRoute(
      request("/api/v1/proposal-publication-approvals", body, "prepare-proposal-publication-0001"),
      appEnv,
      auth("owner"),
    );
    assert.equal(replayed.status, 200);
    assert.equal((await replayed.json() as { replayed: boolean }).replayed, true);
    assert.deepEqual(
      broker.calls,
      ["/v1/proposal-publication/preview"],
      "prepare replay must not re-run a dry run",
    );

    const ownerRead = await handleAuthenticatedRoute(
      request("/api/v1/proposal-publication-approvals"),
      appEnv,
      auth("owner"),
    );
    assert.equal(ownerRead.status, 200);
    assert.deepEqual((await ownerRead.json() as { allowed_actions: string[] }).allowed_actions, [
      "proposal_publication_approval.read",
      "proposal_publication_approval.prepare",
      "proposal_publication_approval.reject",
      "proposal_publication_approval.reconcile",
      "proposal_publication_approval.approve",
    ]);

    const officeRead = await handleAuthenticatedRoute(
      request("/api/v1/proposal-publication-approvals"),
      appEnv,
      auth("ops"),
    );
    assert.equal(officeRead.status, 200);
    const officeJson = await officeRead.json() as { approvals: unknown[]; allowed_actions: string[] };
    assert.equal(officeJson.approvals.length, 1);
    assert.deepEqual(officeJson.allowed_actions, [
      "proposal_publication_approval.read",
      "proposal_publication_approval.prepare",
    ]);
    assert.equal(containsCapability(officeJson), false);

    const executed = await handleAuthenticatedRoute(
      request(
        `/api/v1/proposal-publication-approvals/${preparedJson.approval.id}/approve`,
        { version: preparedJson.approval.version },
        "decision-proposal-publication-0001",
      ),
      appEnv,
      auth("owner"),
    );
    assert.equal(executed.status, 200);
    const executedJson = await executed.json() as {
      approval: {
        state: string;
        outcome: {
          published: boolean;
          status: string;
          audit_finalized: boolean;
          customer_portal_link_issued: boolean;
          contract_acceptance_mutated: boolean;
        };
      };
    };
    assert.equal(executedJson.approval.state, "executed");
    assert.equal(executedJson.approval.outcome.published, true);
    assert.equal(executedJson.approval.outcome.status, "Approved");
    assert.equal(executedJson.approval.outcome.audit_finalized, true);
    assert.equal(executedJson.approval.outcome.customer_portal_link_issued, false);
    assert.equal(executedJson.approval.outcome.contract_acceptance_mutated, false);
    assert.equal(containsCapability(executedJson), false);
    assert.deepEqual(broker.calls, [
      "/v1/proposal-publication/preview",
      "/v1/proposal-publication/execute",
    ]);

    const executeReplay = await handleAuthenticatedRoute(
      request(
        `/api/v1/proposal-publication-approvals/${preparedJson.approval.id}/approve`,
        { version: preparedJson.approval.version },
        "decision-proposal-publication-0001",
      ),
      appEnv,
      auth("owner"),
    );
    assert.equal(executeReplay.status, 200);
    assert.equal((await executeReplay.json() as { replayed: boolean }).replayed, true);
    assert.deepEqual(
      broker.calls,
      ["/v1/proposal-publication/preview", "/v1/proposal-publication/execute"],
      "approval replay must never publish twice",
    );
  } finally {
    broker.restore();
  }
});

test("publication authority is refused for every principal that does not hold it", async () => {
  const appEnv = env();
  const broker = installBrokerMock();
  try {
    const field = await handleAuthenticatedRoute(
      request("/api/v1/proposal-publication-approvals", preparationBody(), "prepare-authority-0001"),
      appEnv,
      auth("field"),
    );
    assert.equal(field.status, 403);
    assert.equal((await field.json() as { error: string }).error, "office_role_required");

    const noCsrf = await handleAuthenticatedRoute(
      request("/api/v1/proposal-publication-approvals", preparationBody(), "prepare-authority-0002", false),
      appEnv,
      auth("owner"),
    );
    assert.equal(noCsrf.status, 403);
    assert.equal((await noCsrf.json() as { error: string }).error, "csrf_failed");

    const noIdempotency = await handleAuthenticatedRoute(
      request("/api/v1/proposal-publication-approvals", preparationBody()),
      appEnv,
      auth("owner"),
    );
    assert.equal(noIdempotency.status, 400);
    assert.equal((await noIdempotency.json() as { error: string }).error, "idempotency_key_required");
    assert.deepEqual(broker.calls, [], "a refused request must never reach the broker");

    const prepared = await handleAuthenticatedRoute(
      request("/api/v1/proposal-publication-approvals", preparationBody(), "prepare-authority-0003"),
      appEnv,
      auth("ops"),
    );
    assert.equal(prepared.status, 201);
    const preparedJson = await prepared.json() as { approval: { id: string; version: number } };

    // Office staff may prepare; only an owner may release the proposal to the customer.
    const opsDecision = await handleAuthenticatedRoute(
      request(
        `/api/v1/proposal-publication-approvals/${preparedJson.approval.id}/approve`,
        { version: preparedJson.approval.version },
        "decision-authority-0003",
      ),
      appEnv,
      auth("ops"),
    );
    assert.equal(opsDecision.status, 403);
    assert.equal((await opsDecision.json() as { error: string }).error, "owner_role_required");
    assert.deepEqual(broker.calls, ["/v1/proposal-publication/preview"]);

    const staleVersion = await handleAuthenticatedRoute(
      request(
        `/api/v1/proposal-publication-approvals/${preparedJson.approval.id}/approve`,
        { version: preparedJson.approval.version + 1 },
        "decision-authority-0004",
      ),
      appEnv,
      auth("owner"),
    );
    assert.equal(staleVersion.status, 409);
    assert.equal(
      (await staleVersion.json() as { error: string }).error,
      "proposal_publication_approval_version_conflict",
    );
    assert.deepEqual(
      broker.calls,
      ["/v1/proposal-publication/preview"],
      "a stale version must never reach the publication command",
    );
  } finally {
    broker.restore();
  }
});

test("a second live intent for the same pack is refused, and a changed intent is an idempotency conflict", async () => {
  const appEnv = env();
  const broker = installBrokerMock();
  try {
    const first = await handleAuthenticatedRoute(
      request("/api/v1/proposal-publication-approvals", preparationBody(), "prepare-single-0001"),
      appEnv,
      auth("owner"),
    );
    assert.equal(first.status, 201);

    const second = await handleAuthenticatedRoute(
      request("/api/v1/proposal-publication-approvals", preparationBody(), "prepare-single-0002"),
      appEnv,
      auth("owner"),
    );
    assert.equal(second.status, 409);
    assert.equal(
      (await second.json() as { error: string }).error,
      "proposal_publication_approval_already_active",
    );

    const reusedKeyDifferentPack = await handleAuthenticatedRoute(
      request(
        "/api/v1/proposal-publication-approvals",
        { roof_job_id: ROOF_JOB, proposal_evidence_pack_id: "proposal:customer-quote:publish-2" },
        "prepare-single-0001",
      ),
      appEnv,
      auth("owner"),
    );
    assert.equal(reusedKeyDifferentPack.status, 409);
    assert.equal((await reusedKeyDifferentPack.json() as { error: string }).error, "idempotency_conflict");
  } finally {
    broker.restore();
  }
});

test("an unverified broker execution becomes reconciliation-only uncertainty, never a retry", async () => {
  const appEnv = env();
  const broker = installBrokerMock({ invalidExecuteSignature: true });
  try {
    const prepared = await handleAuthenticatedRoute(
      request("/api/v1/proposal-publication-approvals", preparationBody(), "prepare-uncertain-0001"),
      appEnv,
      auth("owner"),
    );
    const json = await prepared.json() as { approval: { id: string; version: number } };
    const uncertain = await handleAuthenticatedRoute(
      request(
        `/api/v1/proposal-publication-approvals/${json.approval.id}/approve`,
        { version: json.approval.version },
        "decision-uncertain-0001",
      ),
      appEnv,
      auth("owner"),
    );
    assert.equal(uncertain.status, 502);
    const uncertainJson = await uncertain.json() as {
      error: string;
      approval: { state: string; error_code: string; version: number; id: string };
    };
    assert.equal(uncertainJson.error, "execution_uncertain");
    assert.equal(uncertainJson.approval.state, "execution_uncertain");

    const reconciled = await handleAuthenticatedRoute(
      request(`/api/v1/proposal-publication-approvals/${json.approval.id}/reconcile`, {
        version: uncertainJson.approval.version,
        outcome: "not_executed",
        evidence: "No Hermes Run recorded an applied publication for this pack.",
      }),
      appEnv,
      auth("owner"),
    );
    assert.equal(reconciled.status, 200);
    const reconciledJson = await reconciled.json() as {
      approval: { reconciliation: { outcome: string } | null };
    };
    assert.equal(reconciledJson.approval.reconciliation?.outcome, "not_executed");
  } finally {
    broker.restore();
  }
});

test("the publication surface is absent entirely while the capability is disabled", async () => {
  const appEnv = env();
  appEnv.APP_PROPOSAL_PUBLICATION_ENABLED = "false";
  const broker = installBrokerMock();
  try {
    const prepared = await handleAuthenticatedRoute(
      request("/api/v1/proposal-publication-approvals", preparationBody(), "prepare-disabled-0001"),
      appEnv,
      auth("owner"),
    );
    assert.equal(prepared.status, 404);
    assert.deepEqual(await prepared.json(), { error: "not_found" });

    const read = await handleAuthenticatedRoute(
      request("/api/v1/proposal-publication-approvals"),
      appEnv,
      auth("owner"),
    );
    assert.equal(read.status, 200);
    assert.deepEqual((await read.json() as { allowed_actions: string[] }).allowed_actions, []);
    assert.deepEqual(broker.calls, []);
  } finally {
    broker.restore();
  }
});
