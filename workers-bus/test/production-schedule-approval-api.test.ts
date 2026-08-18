import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import { permissionsForRole, type AppEnv, type AppRole, type AuthContext } from "../src/app-types.ts";

const TENANT = "ironwrap";
const SHARED_SECRET = "production-schedule-broker-shared-secret-for-test-0001";
const KEY_ID = "production-schedule-test-key";
const APPROVER = "owner@example.com";
const JOB_ID = "JOB-API";
const CREW_ID = "CREW-API";

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    // Schedule approval now consumes safety readiness before it claims an
    // execution lease, so this harness applies the whole chain rather than the
    // two migrations the approval tables alone need.
    for (const migration of readdirSync(
      new URL("../migrations/", import.meta.url),
    )
      .filter((name) => /^\d{4}_.+\.sql$/.test(name))
      .sort()) {
      if (migration === "0038_app_access_roles.sql") {
        this.raw
          .prepare(
            `INSERT INTO app_users
              (user_id, tenant_id, email_normalized, display_name, role, active,
               created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'ops', 1, ?, ?, ?)`,
          )
          .run(
            "appu_legacy_ops_0001",
            TENANT,
            "legacy-ops@example.invalid",
            "Legacy Operations",
            "seed",
            "2026-08-13T11:59:00.000Z",
            "2026-08-13T11:59:00.000Z",
          );
      }
      this.raw.exec(
        readFileSync(
          new URL(`../migrations/${migration}`, import.meta.url),
          "utf8",
        ),
      );
    }
    const now = new Date().toISOString();
    const insert = this.raw.prepare(
      `INSERT INTO app_users (
        user_id, tenant_id, email_normalized, display_name, role, frappe_user_id,
        active, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 'seed', ?, ?)`,
    );
    insert.run(
      "appu_owner_0001",
      TENANT,
      APPROVER,
      "Owner",
      "owner",
      APPROVER,
      now,
      now,
    );
    insert.run(
      "appu_ops_0001",
      TENANT,
      "ops@example.com",
      "Ops",
      "ops",
      "ops@example.com",
      now,
      now,
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
    APP_TIME_ZONE: "America/Edmonton",
    ERPNEXT_BASE_URL: "https://frappe.example.com",
    ERPNEXT_API_KEY: "read-key",
    ERPNEXT_API_SECRET: "read-secret",
    APP_PRODUCTION_SCHEDULE_BROKER_URL: "http://127.0.0.1:8790",
    APP_PRODUCTION_SCHEDULE_BROKER_KEY_ID: KEY_ID,
    PRODUCTION_SCHEDULE_BROKER_SHARED_SECRET: SHARED_SECRET,
    APP_PRODUCTION_SCHEDULE_BROKER_TIMEOUT_MS: "5000",
    APP_PRODUCTION_SCHEDULE_EXECUTION_LEASE_SECONDS: "45",
    APP_PRODUCTION_SCHEDULE_APPROVER_ID: APPROVER,
    APP_PRODUCTION_SCHEDULE_MAX_SESSION_AGE_SECONDS: "900",
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

function preparationBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    roof_job_id: JOB_ID,
    crew_profile_id: CREW_ID,
    scheduled_start: "2026-07-20T14:00:00.000Z",
    scheduled_end: "2026-07-20T22:00:00.000Z",
    supersedes_assignment_id: null,
    correction_reason: null,
    ...overrides,
  };
}

function containsCapability(value: unknown): boolean {
  if (typeof value === "string") {
    return /dry_run_receipt|approval_receipt|write_args_json|receipt_preview_digest|actor_user|site_id|write_tool|dry_run_tool|agent_role/i.test(
      value,
    );
  }
  if (Array.isArray(value)) return value.some(containsCapability);
  if (value && typeof value === "object") {
    return Object.entries(value).some(
      ([key, child]) =>
        /dry_run_receipt|approval_receipt|write_args_json|receipt_preview_digest|actor_user|site_id|write_tool|dry_run_tool|agent_role/i.test(
          key,
        ) || containsCapability(child),
    );
  }
  return false;
}

function installUpstreamMock() {
  const original = globalThis.fetch;
  const brokerCalls: string[] = [];
  globalThis.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const inbound = input instanceof Request ? input : new Request(input, init);
    const url = new URL(inbound.url);
    if (url.hostname === "frappe.example.com") return frappeResponse(url);

    const raw = await inbound.text();
    const path = url.pathname;
    brokerCalls.push(path);
    assertValidWorkerSignature(inbound, path, raw);
    const body = JSON.parse(raw) as Record<string, unknown>;
    if (path === "/v1/production-schedule/preview") {
      return signedBrokerResponse(inbound, path, raw, previewResponse(body));
    }
    if (path === "/v1/production-schedule/execute") {
      return signedBrokerResponse(inbound, path, raw, executeResponse(body));
    }
    return signedBrokerResponse(inbound, path, raw, { error: "not_found" }, 404);
  };
  return {
    brokerCalls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function frappeResponse(url: URL): Response {
  const doctype = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
  const data = doctype === "Roof Job"
    ? [{
        name: JOB_ID,
        job_number: "IW-API-1",
        brand: "IronWrap Exteriors",
        service_type: "Roofing",
        job_status: "In Production",
        modified: "2026-07-17T10:00:00.000Z",
      }]
    : doctype === "Production Gate State"
      ? ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew"].map(
          (gate) => ({
            name: `GATE-${gate}`,
            roof_job: JOB_ID,
            gate,
            state: "Ready",
            modified: "2026-07-17T10:00:00.000Z",
          }),
        )
      : doctype === "Crew Profile"
        ? [{
            name: CREW_ID,
            crew_profile_id: CREW_ID,
            crew_name: "Northside Metal",
            status: "Active",
            modified: "2026-07-17T10:00:00.000Z",
          }]
        : [];
  return Response.json({ data });
}

function previewResponse(body: Record<string, unknown>): Record<string, unknown> {
  const assignmentId = "assignment:job-api-crew-api-20260720";
  const requestText = String(body.request_text);
  const runId = String(body.run_id);
  return {
    approval_request_id: body.approval_request_id,
    tenant_id: body.tenant_id,
    packet: {
      request_kind: "production_schedule",
      write_tool: "request_create_job_assignment",
      dry_run_tool: "dry_run_job_assignment",
      agent_role: "production-controller",
      actor_user: "production@example.com",
      site_id: "site-ironwrap",
      target: { doctype: "Job Assignment", name: assignmentId },
      roof_job_id: body.roof_job_id,
      crew_profile_id: body.crew_profile_id,
      scheduled_start: body.scheduled_start,
      scheduled_end: body.scheduled_end,
      supersedes_assignment_id: body.supersedes_assignment_id,
      correction_reason: body.correction_reason,
      request_text: requestText,
      write_args_json: JSON.stringify({
        roof_job_id: body.roof_job_id,
        assignment_type: "Production",
        status: "Assigned",
        crew_profile_id: body.crew_profile_id,
        scheduled_start: body.scheduled_start,
        scheduled_end: body.scheduled_end,
        assigned_by: "production@example.com",
        notes: "",
        request_text: requestText,
        approved_by: APPROVER,
        run_id: runId,
      }),
      preview_json: JSON.stringify({
        would_write: false,
        append_only: true,
        target: { doctype: "Job Assignment", name: assignmentId },
        assignment: {
          assignment_id: assignmentId,
          roof_job_id: body.roof_job_id,
          crew_profile_id: body.crew_profile_id,
          scheduled_start: body.scheduled_start,
          scheduled_end: body.scheduled_end,
          supersedes_assignment_id: body.supersedes_assignment_id,
          correction_reason: body.correction_reason,
        },
        production_schedule_gate_preview: {
          required: true,
          state_eligible: true,
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
  const approval = body.approval_request as Record<string, unknown>;
  return {
    outcome: {
      state: "executed",
      hermes_run_id: approval.run_id,
      result_json: JSON.stringify({
        run_id: approval.run_id,
        assignment_id: approval.target_name,
        roof_job_id: approval.roof_job_id,
        crew_profile_id: approval.crew_profile_id,
        scheduled_start: approval.scheduled_start,
        scheduled_end: approval.scheduled_end,
        supersedes_assignment_id: approval.supersedes_assignment_id,
        created: true,
        audit_finalized: true,
        replayed: false,
        append_only: true,
        assigned_user_mutated: false,
        crew_notified: false,
        customer_notified: false,
        accounting_mutated: false,
      }),
      error_code: null,
    },
  };
}

function assertValidWorkerSignature(
  request: Request,
  path: string,
  raw: string,
): void {
  const keyId = request.headers.get("x-ironwrap-internal-key-id");
  const timestamp = request.headers.get("x-ironwrap-internal-timestamp");
  const nonce = request.headers.get("x-ironwrap-internal-nonce");
  const signature = request.headers.get("x-ironwrap-internal-signature");
  assert.equal(request.headers.get("x-ironwrap-internal-version"), "1");
  assert.equal(keyId, KEY_ID);
  assert.match(timestamp ?? "", /^[0-9]{13}$/);
  assert.match(nonce ?? "", /^[A-Za-z0-9_-]{32}$/);
  assert.equal(
    signature,
    hmac(
      ["1", KEY_ID, "POST", path, timestamp, nonce, sha256(raw)].join("\n"),
    ),
  );
}

function signedBrokerResponse(
  request: Request,
  path: string,
  rawRequest: string,
  body: Record<string, unknown>,
  status = 200,
): Response {
  const rawResponse = JSON.stringify(body);
  const requestTimestamp =
    request.headers.get("x-ironwrap-internal-timestamp") ?? "";
  const nonce = request.headers.get("x-ironwrap-internal-nonce") ?? "";
  const responseTimestamp = String(Date.now());
  const signature = hmac(
    [
      "1",
      KEY_ID,
      String(status),
      path,
      requestTimestamp,
      nonce,
      sha256(rawRequest),
      responseTimestamp,
      sha256(rawResponse),
    ].join("\n"),
  );
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

test("production schedule API keeps scheduling staged, source-backed, and browser-safe", async () => {
  const appEnv = env();
  const upstream = installUpstreamMock();
  try {
    const rejectedOps = await handleAuthenticatedRoute(
      request(
        "/api/v1/production-schedule-approvals",
        preparationBody(),
        "prepare-production-schedule-ops-0001",
      ),
      appEnv,
      auth("ops"),
    );
    assert.equal(rejectedOps.status, 403);
    assert.equal(
      (await rejectedOps.json() as { error: string }).error,
      "owner_role_required",
    );

    const rejectedCsrf = await handleAuthenticatedRoute(
      request(
        "/api/v1/production-schedule-approvals",
        preparationBody(),
        "prepare-production-schedule-csrf-0001",
        false,
      ),
      appEnv,
      auth("owner"),
    );
    assert.equal(rejectedCsrf.status, 403);
    assert.equal(
      (await rejectedCsrf.json() as { error: string }).error,
      "csrf_failed",
    );

    const widened = await handleAuthenticatedRoute(
      request(
        "/api/v1/production-schedule-approvals",
        preparationBody({ assigned_user: "browser-must-not-control-this" }),
        "prepare-production-schedule-widened-0001",
      ),
      appEnv,
      auth("owner"),
    );
    assert.equal(widened.status, 400);
    assert.equal(
      (await widened.json() as { error: string }).error,
      "invalid_production_schedule_approval_request",
    );

    const prepared = await handleAuthenticatedRoute(
      request(
        "/api/v1/production-schedule-approvals",
        preparationBody(),
        "prepare-production-schedule-api-0001",
      ),
      appEnv,
      auth("owner"),
    );
    assert.equal(prepared.status, 201);
    const preparedJson = await prepared.json() as {
      approval: { id: string; version: number; state: string };
    };
    assert.equal(preparedJson.approval.state, "pending");
    assert.equal(containsCapability(preparedJson), false);
    assert.deepEqual(upstream.brokerCalls, ["/v1/production-schedule/preview"]);

    const replayed = await handleAuthenticatedRoute(
      request(
        "/api/v1/production-schedule-approvals",
        preparationBody(),
        "prepare-production-schedule-api-0001",
      ),
      appEnv,
      auth("owner"),
    );
    assert.equal(replayed.status, 200);
    assert.equal((await replayed.json() as { replayed: boolean }).replayed, true);
    assert.deepEqual(
      upstream.brokerCalls,
      ["/v1/production-schedule/preview"],
      "prepare replay must not re-run the private dry run",
    );

    const sourceInvalid = await handleAuthenticatedRoute(
      request(
        "/api/v1/production-schedule-approvals",
        preparationBody({
          supersedes_assignment_id: "assignment:unknown",
          correction_reason: "A correction without the active source is unsafe.",
        }),
        "prepare-production-schedule-source-invalid-0001",
      ),
      appEnv,
      auth("owner"),
    );
    assert.equal(sourceInvalid.status, 409);
    assert.equal(
      (await sourceInvalid.json() as { error: string }).error,
      "production_schedule_supersede_invalid",
    );

    const approved = await handleAuthenticatedRoute(
      request(
        `/api/v1/production-schedule-approvals/${preparedJson.approval.id}/approve`,
        { version: preparedJson.approval.version },
        "decision-production-schedule-api-0001",
      ),
      appEnv,
      auth("owner"),
    );
    assert.equal(approved.status, 200);
    const approvedJson = await approved.json() as {
      approval: {
        state: string;
        outcome: {
          created: boolean;
          audit_finalized: boolean;
          crew_notified: boolean;
        };
      };
    };
    assert.equal(approvedJson.approval.state, "executed");
    assert.equal(approvedJson.approval.outcome.created, true);
    assert.equal(approvedJson.approval.outcome.audit_finalized, true);
    assert.equal(approvedJson.approval.outcome.crew_notified, false);
    assert.equal(containsCapability(approvedJson), false);
    assert.deepEqual(upstream.brokerCalls, [
      "/v1/production-schedule/preview",
      "/v1/production-schedule/execute",
    ]);

    const approvalReplay = await handleAuthenticatedRoute(
      request(
        `/api/v1/production-schedule-approvals/${preparedJson.approval.id}/approve`,
        { version: preparedJson.approval.version },
        "decision-production-schedule-api-0001",
      ),
      appEnv,
      auth("owner"),
    );
    assert.equal(approvalReplay.status, 200);
    assert.equal(
      (await approvalReplay.json() as { replayed: boolean }).replayed,
      true,
    );
    assert.deepEqual(
      upstream.brokerCalls,
      [
        "/v1/production-schedule/preview",
        "/v1/production-schedule/execute",
      ],
      "approval replay must not execute twice",
    );
  } finally {
    upstream.restore();
  }
});
