import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import worker from "../src/index.ts";
import {
  claimMeasurementIntakeReceipt,
  markMeasurementIntakeRetryable,
  type MeasurementIntakeIdentity,
} from "../src/measurement-intake-store.ts";
import { retryMeasurementIntakeReceipts } from "../src/measurements.ts";

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    for (const migration of [
      "0001_init.sql",
      "0009_replay_approval_audit.sql",
      "0019_measurement_intake_receipts.sql",
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

function testEnv(
  db: SqliteD1,
  rawWrites: Array<{ key: string; body: string }>,
  overrides: Record<string, unknown> = {},
) {
  const rawObjects = new Map<string, string>();
  return {
    INGEST_TOKEN: "intake-token",
    ADMIN_TOKEN: "admin-token",
    ERPNEXT_ENABLED: "false",
    DB: db as never,
    RAW: {
      put: async (key: string, body: string) => {
        rawWrites.push({ key, body });
        rawObjects.set(key, body);
      },
      get: async (key: string) => {
        const body = rawObjects.get(key);
        return body === undefined ? null : { text: async () => body };
      },
    },
    ...overrides,
  };
}

const ctx = { waitUntil: (_promise: Promise<unknown>) => {} };
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

function intakeRequest(body: Record<string, unknown>, idempotencyKey?: string, contentType = "application/json"): Request {
  const headers = new Headers({
    authorization: "Bearer intake-token",
    "content-type": contentType,
  });
  if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
  return new Request("https://bus.example/ingest/measurement", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

test("measurement intake: an exact retry replays one completed canonical receipt", async () => {
  const db = new SqliteD1();
  const rawWrites: Array<{ key: string; body: string }> = [];
  const env = testEnv(db, rawWrites);
  const body = { job_number: "26-0001", squares: 24, ridge_ft: 100 };

  const first = await worker.fetch(intakeRequest(body, "measurement-retry-0001"), env as never, ctx as never);
  const firstBody = await first.json() as { measurement_id: string; status: string };
  const replay = await worker.fetch(intakeRequest(body, "measurement-retry-0001"), env as never, ctx as never);
  const replayBody = await replay.json() as { measurement_id: string; status: string; idempotent_replay?: boolean };

  assert.equal(first.status, 200);
  assert.equal(firstBody.status, "matched");
  assert.equal(replay.status, 200);
  assert.equal(replayBody.idempotent_replay, true);
  assert.equal(replayBody.measurement_id, firstBody.measurement_id);
  assert.equal(rawWrites.length, 1);
  assert.match(rawWrites[0].key, /^raw\/measurements\/[0-9a-f]{64}\.json$/);
  const row = db.raw.prepare("SELECT COUNT(*) AS count FROM measurement_intake_receipts").get() as { count: number };
  assert.equal(Number(row.count), 1);
});

test("measurement intake: a changed body under the same key conflicts without a second raw write", async () => {
  const db = new SqliteD1();
  const rawWrites: Array<{ key: string; body: string }> = [];
  const env = testEnv(db, rawWrites);

  const first = await worker.fetch(
    intakeRequest({ job_number: "26-0002", squares: 24 }, "measurement-conflict-0001"),
    env as never,
    ctx as never,
  );
  const conflict = await worker.fetch(
    intakeRequest({ job_number: "26-0002", squares: 25 }, "measurement-conflict-0001"),
    env as never,
    ctx as never,
  );

  assert.equal(first.status, 200);
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: "measurement_idempotency_conflict" });
  assert.equal(rawWrites.length, 1);
});

test("measurement intake: an unmatched report is durable and visible only through the admin exception queue", async () => {
  const db = new SqliteD1();
  const rawWrites: Array<{ key: string; body: string }> = [];
  const env = testEnv(db, rawWrites);

  const submitted = await worker.fetch(
    intakeRequest({ report_id: "roofruler-report-47", squares: 24 }),
    env as never,
    ctx as never,
  );
  const submittedBody = await submitted.json() as { measurement_id: string; status: string };
  const listed = await worker.fetch(new Request("https://bus.example/admin/measurements/exceptions", {
    headers: { authorization: "Bearer admin-token" },
  }), env as never, ctx as never);
  const listedBody = await listed.json() as {
    measurements: Array<Record<string, unknown>>;
  };

  assert.equal(submitted.status, 202);
  assert.equal(submittedBody.status, "unmatched_review");
  assert.equal(rawWrites.length, 1);
  assert.equal(listed.status, 200);
  assert.equal(listedBody.measurements.length, 1);
  assert.equal(listedBody.measurements[0].measurement_id, submittedBody.measurement_id);
  assert.equal(listedBody.measurements[0].status, "unmatched");
  assert.equal("idempotency_key_hash" in listedBody.measurements[0], false);
  assert.equal("payload_hash" in listedBody.measurements[0], false);
  assert.equal("lease_token" in listedBody.measurements[0], false);
});

test("measurement intake: oversized job ids and media types become durable review work", async () => {
  const db = new SqliteD1();
  const rawWrites: Array<{ key: string; body: string }> = [];
  const env = testEnv(db, rawWrites);
  const submitted = await worker.fetch(
    intakeRequest(
      { job_number: "J".repeat(161), squares: 24 },
      "measurement-boundary-0001",
      `application/${"x".repeat(130)}`,
    ),
    env as never,
    ctx as never,
  );
  const receipt = db.raw.prepare(
    "SELECT job_number, content_type, status FROM measurement_intake_receipts LIMIT 1",
  ).get() as { job_number: string | null; content_type: string; status: string };

  assert.equal(submitted.status, 202);
  assert.equal(rawWrites.length, 1);
  assert.equal(receipt.job_number, null);
  assert.equal(receipt.content_type, "application/octet-stream");
  assert.equal(receipt.status, "unmatched");
});

test("measurement intake: a report waits in the retryable queue until Drive is configured", async () => {
  const db = new SqliteD1();
  const rawWrites: Array<{ key: string; body: string }> = [];
  const env = testEnv(db, rawWrites);

  const submitted = await worker.fetch(
    intakeRequest({
      job_number: "26-0004",
      report_url: "https://reports.example.com/26-0004.pdf",
      squares: 24,
    }, "measurement-drive-pending-0001"),
    env as never,
    ctx as never,
  );
  const listed = await worker.fetch(new Request("https://bus.example/admin/measurements/exceptions", {
    headers: { authorization: "Bearer admin-token" },
  }), env as never, ctx as never);
  const listedBody = await listed.json() as { measurements: Array<Record<string, unknown>> };

  assert.equal(submitted.status, 502);
  assert.equal(rawWrites.length, 1);
  assert.equal(listedBody.measurements.length, 1);
  assert.equal(listedBody.measurements[0].status, "retryable_error");
  assert.equal(listedBody.measurements[0].last_error, "drive_not_configured");
});

test("measurement intake: an unresolved supplied job is queued rather than treated as a match", async (t) => {
  const db = new SqliteD1();
  const rawWrites: Array<{ key: string; body: string }> = [];
  const env = testEnv(db, rawWrites, {
    ERPNEXT_ENABLED: "true",
    ERPNEXT_BASE_URL: "https://erp.example.com",
    ERPNEXT_API_KEY: "erp-key",
    ERPNEXT_API_SECRET: "erp-secret",
  });
  const fetches: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    fetches.push({ url, init: init ?? {} });
    if (url.includes("/api/resource/Roof%20Job?")) return json({ data: [] });
    if (url.includes("/api/resource/Measurement%20Report?")) return json({ data: [] });
    if (url.endsWith("/api/resource/Measurement%20Report")) return json({ data: { name: "MR-UNRESOLVED" } });
    if (url.includes("/api/resource/Evidence%20Item?")) return json({ data: [] });
    if (url.endsWith("/api/resource/Evidence%20Item")) return json({ data: { name: "EV-UNRESOLVED" } });
    throw new Error(`unexpected fetch ${url}`);
  });

  const submitted = await worker.fetch(
    intakeRequest({ job_number: "26-0006", squares: 24 }, "measurement-unresolved-job-0001"),
    env as never,
    ctx as never,
  );
  const submittedBody = await submitted.json() as { status: string; measurement_id: string };
  const listed = await worker.fetch(new Request("https://bus.example/admin/measurements/exceptions", {
    headers: { authorization: "Bearer admin-token" },
  }), env as never, ctx as never);
  const listedBody = await listed.json() as { measurements: Array<Record<string, unknown>> };
  const report = JSON.parse(String(fetches.find((item) => item.url.endsWith("/api/resource/Measurement%20Report"))?.init.body));

  assert.equal(submitted.status, 202);
  assert.equal(submittedBody.status, "unmatched_review");
  assert.equal(report.review_status, "Needs Review");
  assert.equal("roof_job" in report, false);
  assert.equal(listedBody.measurements[0].measurement_id, submittedBody.measurement_id);
  assert.equal(listedBody.measurements[0].status, "unmatched");
  assert.equal(listedBody.measurements[0].last_error, "roof_job_not_found");
});

test("measurement receipt leases permit only one active processor and reclaim a recorded retry", async () => {
  const db = new SqliteD1();
  const hash = "a".repeat(64);
  const payloadHash = "b".repeat(64);
  const identity: MeasurementIntakeIdentity = {
    receiptId: `measurement_${hash}`,
    idempotencyKeyHash: hash,
    payloadHash,
    keyStrategy: "payload_hash",
    measurementId: `measurement:${hash}`,
    provider: "RoofRuler",
    jobNumber: "26-0003",
    rawKey: `raw/measurements/${payloadHash}.json`,
    contentType: "application/json",
  };
  const first = await claimMeasurementIntakeReceipt({ DB: db as never } as Env, {
    ...identity,
    now: "2026-07-16T10:00:00.000Z",
    leaseToken: "lease-0001",
    leaseExpiresAt: "2026-07-16T10:02:00.000Z",
  });
  const contender = await claimMeasurementIntakeReceipt({ DB: db as never } as Env, {
    ...identity,
    now: "2026-07-16T10:01:00.000Z",
    leaseToken: "lease-0002",
    leaseExpiresAt: "2026-07-16T10:03:00.000Z",
  });
  assert.equal(first.kind, "claimed");
  assert.equal(contender.kind, "in_progress");
  if (first.kind !== "claimed") throw new Error("receipt not claimed");

  await markMeasurementIntakeRetryable({ DB: db as never } as Env, {
    receiptId: first.receipt.receipt_id,
    leaseToken: "lease-0001",
    error: "drive_upload_failed",
    now: "2026-07-16T10:01:30.000Z",
  });
  const reclaimed = await claimMeasurementIntakeReceipt({ DB: db as never } as Env, {
    ...identity,
    now: "2026-07-16T10:01:31.000Z",
    leaseToken: "lease-0003",
    leaseExpiresAt: "2026-07-16T10:03:31.000Z",
  });
  assert.equal(reclaimed.kind, "claimed");
  if (reclaimed.kind === "claimed") assert.equal(reclaimed.receipt.attempts, 2);
});

test("measurement receipt retry sweep replays a durable source without a new inbound request", async () => {
  const db = new SqliteD1();
  const rawWrites: Array<{ key: string; body: string }> = [];
  const env = testEnv(db, rawWrites);
  const hash = "c".repeat(64);
  const payloadHash = "d".repeat(64);
  const identity: MeasurementIntakeIdentity = {
    receiptId: `measurement_${hash}`,
    idempotencyKeyHash: hash,
    payloadHash,
    keyStrategy: "request_header",
    measurementId: `measurement:${hash}`,
    provider: "RoofRuler",
    jobNumber: "26-0005",
    rawKey: `raw/measurements/${payloadHash}.json`,
    contentType: "application/json",
  };
  const body = JSON.stringify({ job_number: "26-0005", squares: 24 });
  const realPayloadHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const actualPayloadHash = Array.from(new Uint8Array(realPayloadHash), (byte) => byte.toString(16).padStart(2, "0")).join("");
  identity.payloadHash = actualPayloadHash;
  identity.rawKey = `raw/measurements/${actualPayloadHash}.json`;
  await env.RAW.put(identity.rawKey, body);

  const first = await claimMeasurementIntakeReceipt(env as never, {
    ...identity,
    now: "2026-07-16T10:00:00.000Z",
    leaseToken: "lease-retry-0001",
    leaseExpiresAt: "2026-07-16T10:02:00.000Z",
  });
  if (first.kind !== "claimed") throw new Error("retry receipt was not claimed");
  await markMeasurementIntakeRetryable(env as never, {
    receiptId: first.receipt.receipt_id,
    leaseToken: "lease-retry-0001",
    error: "drive_upload_failed",
    now: "2026-07-16T10:00:00.000Z",
  });

  await retryMeasurementIntakeReceipts(env as never, new Date("2026-07-16T10:02:00.000Z"));
  const receipt = db.raw.prepare(
    "SELECT status, attempts, completed_at FROM measurement_intake_receipts WHERE receipt_id = ?",
  ).get(identity.receiptId) as { status: string; attempts: number; completed_at: string | null };
  assert.equal(receipt.status, "matched");
  assert.equal(Number(receipt.attempts), 2);
  assert.ok(receipt.completed_at);
});

test("measurement receipt retry sweep takes over an expired processing lease", async () => {
  const db = new SqliteD1();
  const rawWrites: Array<{ key: string; body: string }> = [];
  const env = testEnv(db, rawWrites);
  const body = JSON.stringify({ job_number: "26-0007", squares: 24 });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const payloadHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const hash = "e".repeat(64);
  const identity: MeasurementIntakeIdentity = {
    receiptId: `measurement_${hash}`,
    idempotencyKeyHash: hash,
    payloadHash,
    keyStrategy: "request_header",
    measurementId: `measurement:${hash}`,
    provider: "RoofRuler",
    jobNumber: "26-0007",
    rawKey: `raw/measurements/${payloadHash}.json`,
    contentType: "application/json",
  };
  await env.RAW.put(identity.rawKey, body);
  const first = await claimMeasurementIntakeReceipt(env as never, {
    ...identity,
    now: "2026-07-16T10:00:00.000Z",
    leaseToken: "lease-stale-0001",
    leaseExpiresAt: "2026-07-16T10:01:00.000Z",
  });
  assert.equal(first.kind, "claimed");

  await retryMeasurementIntakeReceipts(env as never, new Date("2026-07-16T10:02:00.000Z"));
  const receipt = db.raw.prepare(
    "SELECT status, attempts FROM measurement_intake_receipts WHERE receipt_id = ?",
  ).get(identity.receiptId) as { status: string; attempts: number };
  assert.equal(receipt.status, "matched");
  assert.equal(Number(receipt.attempts), 2);
});
