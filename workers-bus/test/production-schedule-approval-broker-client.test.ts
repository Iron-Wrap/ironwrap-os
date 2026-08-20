import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import {
  executeProductionScheduleApproval,
  previewProductionScheduleApproval,
  ProductionScheduleApprovalBrokerError,
  type ProductionScheduleApprovalRequestRecord,
} from "../src/production-schedule-approval-broker-client.ts";
import type { AppEnv } from "../src/app-types.ts";

const NOW = Date.parse("2026-07-17T10:00:00.000Z");
const TENANT = "ironwrap";
const KEY_ID = "production-schedule-test-key";
const SHARED_SECRET = "production-schedule-broker-shared-secret-for-test-0001";
const NONCE = "n".repeat(32);

function env(timeoutMs = "5000"): AppEnv {
  return {
    APP_ALLOW_INSECURE_LOCAL: "true",
    APP_PRODUCTION_SCHEDULE_BROKER_URL: "http://127.0.0.1:8789",
    APP_PRODUCTION_SCHEDULE_BROKER_KEY_ID: KEY_ID,
    APP_PRODUCTION_SCHEDULE_BROKER_TIMEOUT_MS: timeoutMs,
    APP_PRODUCTION_SCHEDULE_EXECUTION_LEASE_SECONDS: "45",
    PRODUCTION_SCHEDULE_BROKER_SHARED_SECRET: SHARED_SECRET,
  } as AppEnv;
}

function previewInput() {
  return {
    approvalRequestId: "schedule-approval:001",
    tenantId: TENANT,
    runId: "run-production-schedule-001",
    roofJobId: "job:001",
    crewProfileId: "crew:metal-1",
    scheduledStart: "2026-07-18T14:00:00.000Z",
    scheduledEnd: "2026-07-18T20:00:00.000Z",
    supersedesAssignmentId: "assignment:prior-001",
    correctionReason: "Crew availability changed after the original assignment.",
    requestText: "Schedule the verified crew after an owner review.",
    requestedByUserId: "appu_owner_001",
    requestedByFrappeUser: "owner@example.com",
  };
}

function previewPayload(body: Record<string, unknown>): Record<string, unknown> {
  const target = "assignment:job-001-production-crew-metal-1";
  const scheduledStart = String(body.scheduled_start);
  const scheduledEnd = body.scheduled_end === null ? null : String(body.scheduled_end);
  const supersedes = body.supersedes_assignment_id === null ? null : String(body.supersedes_assignment_id);
  const correctionReason = body.correction_reason === null ? null : String(body.correction_reason);
  const requestText = String(body.request_text);
  const runId = String(body.run_id);
  const writeArgs = {
    roof_job_id: body.roof_job_id,
    assignment_type: "Production",
    status: "Assigned",
    crew_profile_id: body.crew_profile_id,
    scheduled_start: scheduledStart,
    assigned_by: "production-controller@example.com",
    notes: "",
    request_text: requestText,
    approved_by: "owner@example.com",
    run_id: runId,
    ...(scheduledEnd ? { scheduled_end: scheduledEnd } : {}),
    ...(supersedes ? { supersedes, correction_reason: correctionReason } : {}),
  };
  const assignment = {
    assignment_id: target,
    roof_job_id: body.roof_job_id,
    crew_profile_id: body.crew_profile_id,
    scheduled_start: scheduledStart,
    scheduled_end: scheduledEnd,
    supersedes_assignment_id: supersedes,
    correction_reason: correctionReason,
  };
  return {
    approval_request_id: body.approval_request_id,
    tenant_id: body.tenant_id,
    packet: {
      request_kind: "production_schedule",
      write_tool: "request_create_job_assignment",
      dry_run_tool: "dry_run_job_assignment",
      agent_role: "production-controller",
      actor_user: "production-controller@example.com",
      site_id: "site-ironwrap",
      target: { doctype: "Job Assignment", name: target },
      roof_job_id: body.roof_job_id,
      crew_profile_id: body.crew_profile_id,
      scheduled_start: scheduledStart,
      scheduled_end: scheduledEnd,
      supersedes_assignment_id: supersedes,
      correction_reason: correctionReason,
      request_text: requestText,
      write_args_json: JSON.stringify(writeArgs),
      preview_json: JSON.stringify({
        would_write: false,
        target: { doctype: "Job Assignment", name: target },
        append_only: true,
        assignment,
        production_schedule_gate_preview: eligibleGatePreview(),
      }),
      args_digest: "a".repeat(64),
      preview_digest: "b".repeat(64),
      receipt_preview_digest: "c".repeat(64),
      dry_run_receipt: "dry-run-receipt-not-browser-visible".padEnd(64, "x"),
      expires_at: new Date(NOW + 5 * 60_000).toISOString(),
      run_id: runId,
      intent_fingerprint: "d".repeat(64),
    },
  };
}

function eligibleGatePreview(): Record<string, unknown> {
  return {
    required: true,
    state_eligible: true,
  };
}

test("production schedule preview signs a narrow request and accepts only the fixed crew packet", async () => {
  let receivedBody: Record<string, unknown> | null = null;
  const packet = await previewProductionScheduleApproval(env(), previewInput(), {
    now: () => NOW,
    nonce: () => NONCE,
    fetch: async (input, init) => {
      const request = requestFrom(input, init);
      const raw = await request.text();
      const path = new URL(request.url).pathname;
      assert.equal(path, "/v1/production-schedule/preview");
      assertWorkerSignature(request, path, raw);
      receivedBody = JSON.parse(raw) as Record<string, unknown>;
      return signedBrokerResponse(request, path, raw, previewPayload(receivedBody));
    },
  });

  assert.deepEqual(receivedBody, {
    approval_request_id: "schedule-approval:001",
    tenant_id: TENANT,
    run_id: "run-production-schedule-001",
    roof_job_id: "job:001",
    crew_profile_id: "crew:metal-1",
    scheduled_start: "2026-07-18T14:00:00.000Z",
    scheduled_end: "2026-07-18T20:00:00.000Z",
    supersedes_assignment_id: "assignment:prior-001",
    correction_reason: "Crew availability changed after the original assignment.",
    request_text: "Schedule the verified crew after an owner review.",
    requested_by_user_id: "appu_owner_001",
    requested_by_frappe_user: "owner@example.com",
  });
  assert.equal(packet.targetName, "assignment:job-001-production-crew-metal-1");
  assert.deepEqual(packet.productionScheduleGatePreview, { required: true, stateEligible: true });
  assert.equal(packet.crewProfileId, "crew:metal-1");
  assert.equal(packet.scheduledEnd, "2026-07-18T20:00:00.000Z");
});

test("production schedule packet preserves absent schedule and correction fields as null", async () => {
  const input = {
    ...previewInput(),
    scheduledEnd: undefined,
    supersedesAssignmentId: undefined,
    correctionReason: undefined,
  };
  const packet = await previewProductionScheduleApproval(env(), input, {
    now: () => NOW,
    nonce: () => NONCE,
    fetch: async (requestInput, init) => {
      const request = requestFrom(requestInput, init);
      const raw = await request.text();
      return signedBrokerResponse(
        request,
        new URL(request.url).pathname,
        raw,
        previewPayload(JSON.parse(raw) as Record<string, unknown>),
      );
    },
  });
  assert.equal(packet.scheduledEnd, null);
  assert.equal(packet.supersedesAssignmentId, null);
  assert.equal(packet.correctionReason, null);
});

test("production schedule preview rejects a signed individual assignment or ineligible schedule", async () => {
  const invalidPackets = [
    (payload: Record<string, unknown>) => {
      const packet = payload.packet as Record<string, unknown>;
      const args = JSON.parse(String(packet.write_args_json)) as Record<string, unknown>;
      args.assigned_user = "individual@example.com";
      packet.write_args_json = JSON.stringify(args);
    },
    (payload: Record<string, unknown>) => {
      const packet = payload.packet as Record<string, unknown>;
      const preview = JSON.parse(String(packet.preview_json)) as Record<string, unknown>;
      (preview.production_schedule_gate_preview as Record<string, unknown>).state_eligible = false;
      packet.preview_json = JSON.stringify(preview);
    },
  ];

  for (const mutate of invalidPackets) {
    await assert.rejects(
      () => previewProductionScheduleApproval(env(), previewInput(), {
        now: () => NOW,
        nonce: () => NONCE,
        fetch: async (input, init) => {
          const request = requestFrom(input, init);
          const raw = await request.text();
          const payload = previewPayload(JSON.parse(raw) as Record<string, unknown>);
          mutate(payload);
          return signedBrokerResponse(request, new URL(request.url).pathname, raw, payload);
        },
      }),
      (error: unknown) => error instanceof ProductionScheduleApprovalBrokerError &&
        error.code === "production_schedule_broker_response_invalid",
    );
  }
});

test("production schedule execute returns only the safe append-only outcome", async () => {
  const request = requestRecord();
  const outcome = await executeProductionScheduleApproval(env(), request, {
    now: () => NOW,
    nonce: () => NONCE,
    fetch: async (input, init) => {
      const inbound = requestFrom(input, init);
      const raw = await inbound.text();
      const path = new URL(inbound.url).pathname;
      assert.equal(path, "/v1/production-schedule/execute");
      assertWorkerSignature(inbound, path, raw);
      const approval = (JSON.parse(raw) as { approval_request: ProductionScheduleApprovalRequestRecord }).approval_request;
      return signedBrokerResponse(inbound, path, raw, {
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
      });
    },
  });

  assert.equal(outcome.state, "executed");
  assert.deepEqual(JSON.parse(outcome.resultJson ?? "null"), {
    run_id: "run-production-schedule-001",
    assignment_id: "assignment:job-001-production-crew-metal-1",
    roof_job_id: "job:001",
    crew_profile_id: "crew:metal-1",
    scheduled_start: "2026-07-18T14:00:00.000Z",
    scheduled_end: "2026-07-18T20:00:00.000Z",
    supersedes_assignment_id: "assignment:prior-001",
    created: true,
    audit_finalized: true,
    crew_notified: false,
    customer_notified: false,
    accounting_mutated: false,
  });
});

// A 422 is the broker deciding against the request; only a network failure or a
// 5xx means it could not answer. Reporting both as `_unavailable` hid every real
// reason behind an outage code (ELEC-95 process risk 3).
test("production schedule broker passes a signed 422 rejection through with its own code", async () => {
  await assert.rejects(
    () => previewProductionScheduleApproval(env(), previewInput(), {
      now: () => NOW,
      nonce: () => NONCE,
      fetch: async (input, init) => {
        const request = requestFrom(input, init);
        const raw = await request.text();
        return signedBrokerResponse(
          request,
          new URL(request.url).pathname,
          raw,
          { error: "broker_production_schedule_preview_rejected" },
          422,
        );
      },
    }),
    (error: unknown) => error instanceof ProductionScheduleApprovalBrokerError &&
      error.code === "production_schedule_broker_rejected" &&
      error.brokerErrorCode === "broker_production_schedule_preview_rejected" &&
      error.brokerStatus === 422,
  );
});

test("production schedule broker still reads unavailable on a signed 5xx", async () => {
  await assert.rejects(
    () => previewProductionScheduleApproval(env(), previewInput(), {
      now: () => NOW,
      nonce: () => NONCE,
      fetch: async (input, init) => {
        const request = requestFrom(input, init);
        const raw = await request.text();
        return signedBrokerResponse(
          request,
          new URL(request.url).pathname,
          raw,
          { error: "broker_internal_error" },
          503,
        );
      },
    }),
    (error: unknown) => error instanceof ProductionScheduleApprovalBrokerError &&
      error.code === "production_schedule_broker_unavailable" &&
      error.brokerErrorCode === null,
  );
});

// The error vocabulary the Worker hands back to a browser stays closed even when
// the broker answers with something that is not one.
test("production schedule broker falls back to a bounded code on a malformed 4xx body", async () => {
  await assert.rejects(
    () => previewProductionScheduleApproval(env(), previewInput(), {
      now: () => NOW,
      nonce: () => NONCE,
      fetch: async (input, init) => {
        const request = requestFrom(input, init);
        const raw = await request.text();
        return signedBrokerResponse(
          request,
          new URL(request.url).pathname,
          raw,
          { error: "Not A Code <script>" },
          409,
        );
      },
    }),
    (error: unknown) => error instanceof ProductionScheduleApprovalBrokerError &&
      error.code === "production_schedule_broker_rejected" &&
      error.brokerErrorCode === "production_schedule_broker_rejected",
  );
});

test("production schedule broker fails closed on a timeout", async () => {
  await assert.rejects(
    () => previewProductionScheduleApproval(env("1000"), previewInput(), {
      now: () => NOW,
      nonce: () => NONCE,
      fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
        (init?.signal as AbortSignal).addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    }),
    (error: unknown) => error instanceof ProductionScheduleApprovalBrokerError &&
      error.code === "production_schedule_broker_unavailable",
  );
});

function requestRecord(): ProductionScheduleApprovalRequestRecord {
  return {
    production_schedule_approval_id: "schedule-approval:001",
    tenant_id: TENANT,
    request_kind: "production_schedule",
    write_tool: "request_create_job_assignment",
    dry_run_tool: "dry_run_job_assignment",
    agent_role: "production-controller",
    actor_user: "production-controller@example.com",
    site_id: "site-ironwrap",
    target_doctype: "Job Assignment",
    target_name: "assignment:job-001-production-crew-metal-1",
    roof_job_id: "job:001",
    crew_profile_id: "crew:metal-1",
    scheduled_start: "2026-07-18T14:00:00.000Z",
    scheduled_end: "2026-07-18T20:00:00.000Z",
    supersedes_assignment_id: "assignment:prior-001",
    correction_reason: "Crew availability changed after the original assignment.",
    request_text: "Schedule the verified crew after an owner review.",
    write_args_json: "{}",
    preview_json: "{}",
    args_digest: "a".repeat(64),
    preview_digest: "b".repeat(64),
    receipt_preview_digest: "c".repeat(64),
    dry_run_receipt: "dry-run-receipt-not-browser-visible".padEnd(64, "x"),
    expires_at: new Date(NOW + 5 * 60_000).toISOString(),
    run_id: "run-production-schedule-001",
    approved_by_frappe_user: "owner@example.com",
    decision_idempotency_key: "decision:production-schedule-001",
  };
}

function requestFrom(input: RequestInfo | URL, init?: RequestInit): Request {
  return input instanceof Request ? input : new Request(input, init);
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
  const responseTimestamp = String(NOW);
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

function assertWorkerSignature(request: Request, path: string, raw: string): void {
  const timestamp = request.headers.get("x-ironwrap-internal-timestamp");
  const nonce = request.headers.get("x-ironwrap-internal-nonce");
  assert.equal(request.headers.get("x-ironwrap-internal-version"), "1");
  assert.equal(request.headers.get("x-ironwrap-internal-key-id"), KEY_ID);
  assert.equal(timestamp, String(NOW));
  assert.equal(nonce, NONCE);
  assert.equal(
    request.headers.get("x-ironwrap-internal-signature"),
    hmac(["1", KEY_ID, "POST", path, timestamp, nonce, sha256(raw)].join("\n")),
  );
}

function hmac(value: string): string {
  return createHmac("sha256", SHARED_SECRET).update(value).digest("base64url");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
