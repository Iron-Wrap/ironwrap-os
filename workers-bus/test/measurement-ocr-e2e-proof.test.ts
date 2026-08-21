// IRO-28: one synthetic-PDF measurement OCR path, with an immutable receipt
// and owner-exception visibility. OmniRoute may complete the path when
// Anthropic refuses for credits. Without credits and without OmniRoute the
// path fails closed. Nothing here is a live cloud deploy.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import type { AppRole, AuthContext } from "../src/app-types.ts";
import worker from "../src/index.ts";
import {
  buildMeasurementOcrPathProof,
  MEASUREMENT_OCR_LIVE_CLOUD_DEPLOY,
  MEASUREMENT_OCR_PATH_PROOF_KIND,
} from "../src/measurement-ocr-path-proof.ts";
import { handleMeasurementQueueMessage } from "../src/measurements.ts";

/** Minimal valid PDF bytes — built in-test so the repo never tracks a binary. */
function syntheticMeasurementPdf(): Uint8Array {
  const text = [
    "%PDF-1.4",
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
    "2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj",
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj",
    "4 0 obj<</Length 98>>stream",
    "BT /F1 12 Tf 72 720 Td (SYNTHETIC IronWrap measurement fixture) Tj 0 -18 Td (Job 26-0000 Total squares 21.4) Tj ET",
    "endstream",
    "endobj",
    "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj",
    "xref",
    "0 6",
    "0000000000 65535 f ",
    "0000000009 00000 n ",
    "0000000058 00000 n ",
    "0000000115 00000 n ",
    "0000000241 00000 n ",
    "0000000389 00000 n ",
    "trailer<</Size 6/Root 1 0 R>>",
    "startxref",
    "466",
    "%%EOF",
    "",
  ].join("\n");
  return new TextEncoder().encode(text);
}

const SYNTHETIC_PDF = syntheticMeasurementPdf();

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    for (const migration of [
      "0001_init.sql",
      "0009_replay_approval_audit.sql",
      "0019_measurement_intake_receipts.sql",
      "0033_measurement_deltas.sql",
      "0037_measurement_calibration.sql",
      "0039_measurement_ocr_evidence.sql",
      "0042_external_effect_runtime.sql",
      "0090_operating_core.sql",
      "0103_native_measurement_authority.sql",
    ]) {
      this.raw.exec(
        readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"),
      );
    }
  }

  async batch(statements: Array<{ run: () => Promise<unknown> }>) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => new SqliteStatement(this.raw, sql, args),
    };
  }
}

class SqliteStatement {
  private readonly raw: DatabaseSync;
  private readonly sql: string;
  private readonly args: unknown[];

  constructor(raw: DatabaseSync, sql: string, args: unknown[]) {
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

function testEnv(db: SqliteD1, overrides: Record<string, unknown> = {}) {
  const rawObjects = new Map<string, Uint8Array>();
  const queueMessages: Array<{ measurement_receipt_id: string; lease_token: string }> = [];
  const env = {
    queueMessages,
    INGEST_TOKEN: "intake-token",
    ADMIN_TOKEN: "admin-token",
    APP_TENANT_ID: "ironwrap",
    EFFECT_RUNTIME_ENABLED: "true",
    ERPNEXT_ENABLED: "false",
    DB: db as never,
    MEASUREMENT_QUEUE: {
      send: async (message: { measurement_receipt_id: string; lease_token: string }) => {
        queueMessages.push(message);
      },
    },
    RAW: {
      put: async (key: string, body: string | ArrayBuffer | Uint8Array) => {
        const bytes = typeof body === "string"
          ? new TextEncoder().encode(body)
          : body instanceof Uint8Array
            ? body
            : new Uint8Array(body);
        rawObjects.set(key, bytes);
      },
      get: async (key: string) => {
        const stored = rawObjects.get(key);
        if (!stored) return null;
        return {
          text: async () => new TextDecoder().decode(stored),
          arrayBuffer: async () => stored.buffer.slice(stored.byteOffset, stored.byteOffset + stored.byteLength),
        };
      },
    },
    ...overrides,
  };
  return { env, queueMessages, rawObjects };
}

const ctx = { waitUntil: (_promise: Promise<unknown>) => {} };

function appAuth(role: AppRole): AuthContext {
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: ["session:read", "owner:read"],
    session: {
      session_hash: "a".repeat(64),
      session_created_at: "2026-08-21T12:00:00.000Z",
      session_expires_at: "2026-08-22T12:00:00.000Z",
      revoked_at: null,
      user_id: `appu_${role}`,
      tenant_id: "ironwrap",
      email_normalized: `${role}@example.invalid`,
      display_name: role,
      role,
      frappe_user_id: "ops@example.invalid",
      active: 1,
      created_by: "owner@example.invalid",
      created_at: "2026-08-21T12:00:00.000Z",
      updated_at: "2026-08-21T12:00:00.000Z",
      device_id: null,
      device_proof_hash: null,
    },
  };
}

function intakeRequest(idempotencyKey: string): Request {
  return new Request("https://bus.example/ingest/measurement", {
    method: "POST",
    headers: {
      authorization: "Bearer intake-token",
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify({ report_url: "https://reports.example.invalid/synthetic-measurement.pdf" }),
  });
}

async function flushQueue(
  env: ReturnType<typeof testEnv>["env"],
  queueMessages: Array<{ measurement_receipt_id: string; lease_token: string }>,
): Promise<void> {
  while (queueMessages.length > 0) {
    const message = queueMessages.shift();
    if (!message) break;
    await handleMeasurementQueueMessage(env as never, message.measurement_receipt_id, message.lease_token);
  }
}

function ocrToolUseResponse(): Response {
  return new Response(JSON.stringify({
    content: [
      {
        type: "tool_use",
        name: "extract_measurement_report_fields",
        input: {
          job_number: null,
          measurements: [
            {
              metric: "squares",
              value: 21.4,
              page: 1,
              region: "Roof summary",
              label: "Total squares",
              confidence: "medium",
            },
          ],
        },
      },
    ],
  }), { headers: { "content-type": "application/json" } });
}

async function ownerExceptions(
  env: ReturnType<typeof testEnv>["env"],
): Promise<Array<{ reason: string }>> {
  const response = await handleAuthenticatedRoute(
    new Request("https://app.example.invalid/api/v1/owner/measurement-intake-exceptions?limit=5"),
    env as never,
    appAuth("ops"),
  );
  const body = (await response.json()) as { measurements: Array<{ reason: string }> };
  assert.equal(response.status, 200);
  return body.measurements;
}

function readReceipt(db: SqliteD1) {
  return db.raw.prepare(
    `SELECT receipt_id, status, last_error, ocr_status, ocr_result_key, ocr_result_sha256
     FROM measurement_intake_receipts LIMIT 1`,
  ).get() as {
    receipt_id: string;
    status: "retryable_error" | "unmatched" | "matched";
    last_error: string | null;
    ocr_status: "completed" | "failed" | "not_requested" | "processing";
    ocr_result_key: string | null;
    ocr_result_sha256: string | null;
  };
}

test("the IRO-28 proof contract never claims a live cloud deploy", () => {
  assert.equal(MEASUREMENT_OCR_LIVE_CLOUD_DEPLOY, false);
  assert.equal(MEASUREMENT_OCR_PATH_PROOF_KIND, "ironwrap.measurement-ocr-path-proof.v1");
});

test("synthetic PDF OCR completes through OmniRoute when Anthropic has no credits", async (t) => {
  assert.match(new TextDecoder().decode(SYNTHETIC_PDF.subarray(0, 8)), /^%PDF-1\./);
  const db = new SqliteD1();
  const { env, queueMessages } = testEnv(db, {
    MEASUREMENT_OCR_ENABLED: "true",
    MEASUREMENT_OCR_API_KEY: "anthropic-test-key",
    OMNIROUTE_URL: "https://omniroute.test",
    OMNIROUTE_API_KEY: "omni-test-key",
  });
  const fetches: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    fetches.push(url);
    if (url === "https://reports.example.invalid/synthetic-measurement.pdf") {
      return new Response(SYNTHETIC_PDF, { headers: { "content-type": "application/pdf" } });
    }
    if (url === "https://api.anthropic.com/v1/messages") {
      return new Response(JSON.stringify({ error: { type: "billing_error", message: "credit balance is too low" } }), {
        status: 402,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://omniroute.test/v1/messages") return ocrToolUseResponse();
    throw new Error(`unexpected fetch ${url}`);
  });

  const submitted = await worker.fetch(intakeRequest("measurement-ocr-e2e-0001"), env as never, ctx as never);
  assert.equal(submitted.status, 202);
  await flushQueue(env, queueMessages);

  const receipt = readReceipt(db);
  const exceptions = await ownerExceptions(env);
  const proof = buildMeasurementOcrPathProof({
    receiptId: receipt.receipt_id,
    status: receipt.status,
    ocrStatus: receipt.ocr_status === "completed" ? "completed" : "failed",
    ocrResultKey: receipt.ocr_result_key,
    ocrResultSha256: receipt.ocr_result_sha256,
    lastError: receipt.last_error ?? "",
    ownerExceptionVisible: exceptions.some((row) => row.reason === "ocr_review_required"),
    ownerExceptionReason: "ocr_review_required",
    creditOutcome: "completed_via_omniroute_fallback",
    anthropicMessagesCalls: fetches.filter((url) => url === "https://api.anthropic.com/v1/messages").length,
    omnirouteMessagesCalls: fetches.filter((url) => url === "https://omniroute.test/v1/messages").length,
  });

  assert.equal(proof.kind, MEASUREMENT_OCR_PATH_PROOF_KIND);
  assert.equal(proof.live_cloud_deploy, false);
  assert.equal(proof.fixture, "synthetic_pdf");
  assert.equal(proof.ocr_status, "completed");
  assert.equal(proof.credit_outcome, "completed_via_omniroute_fallback");
  assert.equal(proof.anthropic_messages_calls, 1);
  assert.equal(proof.omniroute_messages_calls, 1);
  assert.equal(proof.owner_exception_visible, true);
  assert.equal(proof.last_error, "ocr_review_required");
});

test("synthetic PDF OCR fails closed when Anthropic has no credits and OmniRoute is not configured", async (t) => {
  const db = new SqliteD1();
  const { env, queueMessages } = testEnv(db, {
    MEASUREMENT_OCR_ENABLED: "true",
    MEASUREMENT_OCR_API_KEY: "anthropic-test-key",
  });
  const fetches: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    fetches.push(url);
    if (url === "https://reports.example.invalid/synthetic-measurement.pdf") {
      return new Response(SYNTHETIC_PDF, { headers: { "content-type": "application/pdf" } });
    }
    if (url === "https://api.anthropic.com/v1/messages") {
      return new Response(JSON.stringify({ error: { type: "billing_error", message: "credit balance is too low" } }), {
        status: 402,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  });

  await worker.fetch(intakeRequest("measurement-ocr-e2e-fail-closed-0001"), env as never, ctx as never);
  await flushQueue(env, queueMessages);

  const receipt = readReceipt(db);
  const exceptions = await ownerExceptions(env);
  const proof = buildMeasurementOcrPathProof({
    receiptId: receipt.receipt_id,
    status: receipt.status,
    ocrStatus: receipt.ocr_status === "failed" ? "failed" : "completed",
    ocrResultKey: receipt.ocr_result_key,
    ocrResultSha256: receipt.ocr_result_sha256,
    lastError: receipt.last_error ?? "",
    ownerExceptionVisible: exceptions.some((row) => row.reason === "ocr_failed"),
    ownerExceptionReason: "ocr_failed",
    creditOutcome: "failed_closed_without_credits",
    anthropicMessagesCalls: fetches.filter((url) => url === "https://api.anthropic.com/v1/messages").length,
    omnirouteMessagesCalls: fetches.filter((url) => url.startsWith("https://omniroute.")).length,
  });

  assert.equal(proof.live_cloud_deploy, false);
  assert.equal(proof.ocr_status, "failed");
  assert.equal(proof.status, "retryable_error");
  assert.equal(proof.ocr_result_key, null);
  assert.equal(proof.credit_outcome, "failed_closed_without_credits");
  assert.equal(proof.anthropic_messages_calls, 1);
  assert.equal(proof.omniroute_messages_calls, 0);
  assert.equal(proof.last_error, "measurement_ocr_http_402");
  assert.equal(proof.owner_exception_visible, true);
});
