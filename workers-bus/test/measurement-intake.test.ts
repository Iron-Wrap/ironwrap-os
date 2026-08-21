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
import {
  geometryFromReportBytes,
  parseMeasurementSubmission,
  handleMeasurementQueueMessage,
  retryMeasurementIntakeReceipts,
} from "../src/measurements.ts";
import { handleAuthenticatedRoute } from "../src/app-api.ts";
import type { AppRole, AuthContext } from "../src/app-types.ts";
import { withErpReadback } from "./effect-runtime-fixture.ts";
import { makeZip } from "./zip-helper.ts";

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");
  private failRunPattern: string | null = null;

  constructor() {
    for (const migration of [
      "0001_init.sql",
      "0009_replay_approval_audit.sql",
      "0019_measurement_intake_receipts.sql",
      "0033_measurement_deltas.sql",
      "0037_measurement_calibration.sql",
      "0039_measurement_ocr_evidence.sql",
      "0042_external_effect_runtime.sql",
    ]) {
      this.raw.exec(
        readFileSync(
          new URL(`../migrations/${migration}`, import.meta.url),
          "utf8",
        ),
      );
    }
  }

  // The effect runtime claims an attempt through env.DB.batch; a sequential
  // run is equivalent for a synchronous test double.
  async batch(statements: Array<{ run: () => Promise<unknown> }>) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => new SqliteStatement(this, sql, args),
    };
  }

  failNextRunMatching(pattern: string): void {
    this.failRunPattern = pattern;
  }

  consumeRunFailure(sql: string): boolean {
    if (!this.failRunPattern || !sql.includes(this.failRunPattern)) return false;
    this.failRunPattern = null;
    return true;
  }
}

class SqliteStatement {
  private readonly db: SqliteD1;
  private readonly sql: string;
  private readonly args: unknown[];

  constructor(db: SqliteD1, sql: string, args: unknown[]) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }

  async first<T>(): Promise<T | null> {
    return (this.db.raw.prepare(this.sql).get(...this.args) ?? null) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.raw.prepare(this.sql).all(...this.args) as T[] };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    if (this.db.consumeRunFailure(this.sql)) throw new Error("simulated_d1_run_failure");
    const result = this.db.raw.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(result.changes ?? 0) } };
  }
}

function testEnv(
  db: SqliteD1,
  rawWrites: Array<{ key: string; body: string }>,
  overrides: Record<string, unknown> = {},
) {
  const rawObjects = new Map<
    string,
    { value: string; kind: "text" } | { value: ArrayBuffer | Uint8Array; kind: "binary" }
  >();
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
      send: async (message: {
        measurement_receipt_id: string;
        lease_token: string;
      }) => {
        queueMessages.push(message);
      },
    },
    RAW: {
      put: async (key: string, body: string | ArrayBuffer | Uint8Array) => {
        rawWrites.push({
          key,
          body: typeof body === "string" ? body : `[binary:${body.byteLength}]`,
        });
        rawObjects.set(
          key,
          typeof body === "string"
            ? { value: body, kind: "text" }
            : { value: body instanceof ArrayBuffer ? new Uint8Array(body) : body, kind: "binary" },
        );
      },
      get: async (key: string) => {
        const stored = rawObjects.get(key);
        if (!stored) return null;
        if (stored.kind === "text") {
          return {
            text: async () => stored.value,
            arrayBuffer: async () => new TextEncoder().encode(stored.value).buffer,
          };
        }
        const bytes = stored.value instanceof Uint8Array
          ? stored.value
          : new Uint8Array(stored.value);
        return {
          text: async () => new TextDecoder().decode(bytes),
          arrayBuffer: async () => bytes.buffer,
        };
      },
    },
    ...overrides,
  };
  return { env, queueMessages, rawObjects };
}

async function flushMeasurementQueue(
  env: ReturnType<typeof testEnv>["env"],
  queueMessages: Array<{ measurement_receipt_id: string; lease_token: string }>,
) {
  while (queueMessages.length > 0) {
    const message = queueMessages.shift();
    if (!message) break;
    await handleMeasurementQueueMessage(env as never, message.measurement_receipt_id, message.lease_token);
  }
}

const ctx = { waitUntil: (_promise: Promise<unknown>) => {} };
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function appAuth(role: AppRole): AuthContext {
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: ["session:read", "owner:read"],
    session: {
      session_hash: "a".repeat(64),
      session_created_at: "2026-07-16T12:00:00.000Z",
      session_expires_at: "2026-07-17T12:00:00.000Z",
      revoked_at: null,
      user_id: `appu_${role}`,
      tenant_id: "ironwrap",
      email_normalized: `${role}@example.com`,
      display_name: role,
      role,
      frappe_user_id: role === "field" ? "crew@example.com" : "ops@example.com",
      active: 1,
      created_by: "owner@example.com",
      created_at: "2026-07-16T12:00:00.000Z",
      updated_at: "2026-07-16T12:00:00.000Z",
      device_id: null,
      device_proof_hash: null,
    },
  };
}

function intakeRequest(
  body: Record<string, unknown>,
  idempotencyKey?: string,
  contentType = "application/json",
): Request {
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
  const { env, queueMessages } = testEnv(db, rawWrites);
  const body = { job_number: "26-0001", squares: 24, ridge_ft: 100 };

  const first = await worker.fetch(
    intakeRequest(body, "measurement-retry-0001"),
    env as never,
    ctx as never,
  );
  const firstBody = (await first.json()) as {
    measurement_id: string;
    status: string;
  };
  assert.equal(first.status, 202);
  assert.equal(firstBody.status, "processing");
  assert.equal(queueMessages.length, 1);

  await flushMeasurementQueue(env, queueMessages);

  const replay = await worker.fetch(
    intakeRequest(body, "measurement-retry-0001"),
    env as never,
    ctx as never,
  );
  const replayBody = (await replay.json()) as {
    measurement_id: string;
    status: string;
    idempotent_replay?: boolean;
  };

  assert.equal(first.status, 202);
  assert.equal(replay.status, 200);
  assert.equal(replayBody.status, "matched");
  assert.equal(replayBody.idempotent_replay, true);
  assert.equal(replayBody.measurement_id, firstBody.measurement_id);
  assert.equal(rawWrites.length, 1);
  assert.match(rawWrites[0].key, /^raw\/measurements\/[0-9a-f]{64}\.json$/);
  const row = db.raw
    .prepare("SELECT COUNT(*) AS count FROM measurement_intake_receipts")
    .get() as { count: number };
  assert.equal(Number(row.count), 1);
});

test("measurement intake: a changed body under the same key conflicts without a second raw write", async () => {
  const db = new SqliteD1();
  const rawWrites: Array<{ key: string; body: string }> = [];
  const { env, queueMessages } = testEnv(db, rawWrites);

  const initial = await worker.fetch(
    intakeRequest(
      { job_number: "26-0002", squares: 24 },
      "measurement-conflict-0001",
    ),
    env as never,
    ctx as never,
  );
  await flushMeasurementQueue(env, queueMessages);

  const conflict = await worker.fetch(
    intakeRequest(
      { job_number: "26-0002", squares: 24 },
      "measurement-conflict-0001",
    ),
    env as never,
    ctx as never,
  );
  assert.equal(initial.status, 202);

  const conflictWithChange = await worker.fetch(
    intakeRequest(
      { job_number: "26-0002", squares: 25 },
      "measurement-conflict-0001",
    ),
    env as never,
    ctx as never,
  );

  assert.equal(conflict.status, 200);
  assert.equal(conflictWithChange.status, 409);
  assert.deepEqual(await conflictWithChange.json(), {
    error: "measurement_idempotency_conflict",
  });
  assert.equal(rawWrites.length, 1);
});

test("measurement intake: an unmatched report is durable and visible only through the admin exception queue", async () => {
  const db = new SqliteD1();
  const rawWrites: Array<{ key: string; body: string }> = [];
  const { env, queueMessages } = testEnv(db, rawWrites);

  const submitted = await worker.fetch(
    intakeRequest({ report_id: "roofruler-report-47", squares: 24 }),
    env as never,
    ctx as never,
  );
  const submittedBody = (await submitted.json()) as {
    measurement_id: string;
    status: string;
  };
  assert.equal(submitted.status, 202);
  assert.equal(submittedBody.status, "processing");
  await flushMeasurementQueue(env, queueMessages);
  const listed = await worker.fetch(
    new Request("https://bus.example/admin/measurements/exceptions", {
      headers: { authorization: "Bearer admin-token" },
    }),
    env as never,
    ctx as never,
  );
  const listedBody = (await listed.json()) as {
    measurements: Array<Record<string, unknown>>;
  };

  assert.equal(rawWrites.length, 1);
  assert.equal(listed.status, 200);
  assert.equal(listedBody.measurements.length, 1);
  assert.equal(
    listedBody.measurements[0].measurement_id,
    submittedBody.measurement_id,
  );
  assert.equal(listedBody.measurements[0].status, "unmatched");
  assert.equal("idempotency_key_hash" in listedBody.measurements[0], false);
  assert.equal("payload_hash" in listedBody.measurements[0], false);
  assert.equal("lease_token" in listedBody.measurements[0], false);
});

test("measurement intake: owner PWA exceptions are role-scoped and strictly redact operational internals", async (t) => {
  const db = new SqliteD1();
  const rawWrites: Array<{ key: string; body: string }> = [];
  const { env, queueMessages } = testEnv(db, rawWrites);
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://reports.example.com/26-0004.pdf") {
        return new Response(Buffer.from("%PDF-1.7 fake measurement pdf"), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  );

  await worker.fetch(
    intakeRequest({ report_id: "roofruler-report-owner", squares: 24 }),
    env as never,
    ctx as never,
  );
  await worker.fetch(
    intakeRequest(
      {
        job_number: "26-0004",
        report_url: "https://reports.example.com/26-0004.pdf",
        squares: 24,
      },
      "measurement-owner-retry-0001",
    ),
    env as never,
    ctx as never,
  );

  await flushMeasurementQueue(env, queueMessages);

  const request = new Request(
    "https://app.example.com/api/v1/owner/measurement-intake-exceptions?limit=2",
  );
  const office = await handleAuthenticatedRoute(
    request,
    env as never,
    appAuth("ops"),
  );
  const body = (await office.json()) as {
    measurements: Array<Record<string, unknown>>;
  };

  assert.equal(office.status, 200);
  assert.equal(office.headers.get("cache-control"), "private, no-store");
  assert.equal(body.measurements.length, 2);
  assert.deepEqual(Object.keys(body.measurements[0] ?? {}).sort(), [
    "attempts",
    "created_at",
    "drive_folder_url",
    "drive_report_url",
    "id",
    "job_number",
    "provider",
    "reason",
    "recovery_disposition",
    "status",
    "updated_at",
  ]);
  assert.equal(
    body.measurements.some(
      (measurement) => measurement.reason === "job_number_missing",
    ),
    true,
  );
  assert.equal(
    body.measurements.some(
      (measurement) => measurement.reason === "drive_not_configured",
    ),
    true,
  );
  assert.equal(
    body.measurements.find(
      (measurement) => measurement.reason === "drive_not_configured",
    )?.recovery_disposition,
    "recovery_blocked",
  );
  for (const measurement of body.measurements) {
    assert.equal("raw_key" in measurement, false);
    assert.equal("measurement_id" in measurement, false);
    assert.equal("idempotency_key_hash" in measurement, false);
    assert.equal("payload_hash" in measurement, false);
    assert.equal("lease_token" in measurement, false);
    assert.equal("frappe_error" in measurement, false);
    assert.equal("last_error" in measurement, false);
  }

  db.raw
    .prepare(
      "UPDATE measurement_intake_receipts SET attempts = 11, last_error = 'report_fetch_status_500' WHERE status = 'retryable_error'",
    )
    .run();
  const scheduled = await handleAuthenticatedRoute(
    request,
    env as never,
    appAuth("ops"),
  );
  const scheduledBody = (await scheduled.json()) as {
    measurements: Array<Record<string, unknown>>;
  };
  assert.equal(
    scheduledBody.measurements.find(
      (measurement) => measurement.reason === "report_fetch_failed",
    )?.recovery_disposition,
    "retry_scheduled",
  );

  db.raw
    .prepare(
      "UPDATE measurement_intake_receipts SET attempts = 12 WHERE status = 'retryable_error'",
    )
    .run();
  const exhausted = await handleAuthenticatedRoute(
    request,
    env as never,
    appAuth("ops"),
  );
  const exhaustedBody = (await exhausted.json()) as {
    measurements: Array<Record<string, unknown>>;
  };
  assert.equal(
    exhaustedBody.measurements.find(
      (measurement) => measurement.reason === "report_fetch_failed",
    )?.recovery_disposition,
    "retry_exhausted",
  );

  db.raw
    .prepare(
      "UPDATE measurement_intake_receipts SET last_error = 'raw_source_missing' WHERE status = 'retryable_error'",
    )
    .run();
  const blocked = await handleAuthenticatedRoute(
    request,
    env as never,
    appAuth("ops"),
  );
  const blockedBody = (await blocked.json()) as {
    measurements: Array<Record<string, unknown>>;
  };
  assert.equal(
    blockedBody.measurements.find(
      (measurement) => measurement.reason === "raw_source_missing",
    )?.recovery_disposition,
    "recovery_blocked",
  );

  const field = await handleAuthenticatedRoute(
    request,
    env as never,
    appAuth("field"),
  );
  assert.equal(field.status, 403);
  assert.deepEqual(await field.json(), { error: "office_role_required" });
});

test("measurement intake: oversized job ids and media types become durable review work", async () => {
  const db = new SqliteD1();
  const rawWrites: Array<{ key: string; body: string }> = [];
  const { env, queueMessages } = testEnv(db, rawWrites);
  const submitted = await worker.fetch(
    intakeRequest(
      { job_number: "J".repeat(161), squares: 24 },
      "measurement-boundary-0001",
      `application/${"x".repeat(130)}`,
    ),
    env as never,
    ctx as never,
  );
  await flushMeasurementQueue(env, queueMessages);
  const receipt = db.raw
    .prepare(
      "SELECT job_number, content_type, status FROM measurement_intake_receipts LIMIT 1",
    )
    .get() as {
    job_number: string | null;
    content_type: string;
    status: string;
  };

  assert.equal(submitted.status, 202);
  assert.equal(rawWrites.length, 1);
  assert.equal(receipt.job_number, null);
  assert.equal(receipt.content_type, "application/octet-stream");
  assert.equal(receipt.status, "unmatched");
});

test("measurement intake: a report waits in the retryable queue until Drive is configured", async (t) => {
  const db = new SqliteD1();
  const rawWrites: Array<{ key: string; body: string }> = [];
  const { env, queueMessages } = testEnv(db, rawWrites);
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://reports.example.com/26-0004.pdf") {
        return new Response(Buffer.from("%PDF-1.7 fake measurement pdf"), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  );

  const submitted = await worker.fetch(
    intakeRequest(
      {
        job_number: "26-0004",
        report_url: "https://reports.example.com/26-0004.pdf",
        squares: 24,
      },
    "measurement-drive-pending-0001",
    ),
    env as never,
    ctx as never,
  );
  await flushMeasurementQueue(env, queueMessages);
  const listed = await worker.fetch(
    new Request("https://bus.example/admin/measurements/exceptions", {
      headers: { authorization: "Bearer admin-token" },
    }),
    env as never,
    ctx as never,
  );
  const listedBody = (await listed.json()) as {
    measurements: Array<Record<string, unknown>>;
  };

  assert.equal(submitted.status, 202);
  assert.equal(rawWrites.length, 2);
  assert.equal(listedBody.measurements.length, 1);
  assert.equal(listedBody.measurements[0].status, "retryable_error");
  assert.equal(listedBody.measurements[0].last_error, "drive_not_configured");
});

test("measurement intake: an unresolved supplied job is queued rather than treated as a match", async (t) => {
  const db = new SqliteD1();
  const rawWrites: Array<{ key: string; body: string }> = [];
  const { env, queueMessages } = testEnv(db, rawWrites, {
    ERPNEXT_ENABLED: "true",
    ERPNEXT_BASE_URL: "https://erp.example.com",
    ERPNEXT_API_KEY: "erp-key",
    ERPNEXT_API_SECRET: "erp-secret",
  });
  const fetches: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(
    globalThis,
    "fetch",
    withErpReadback(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetches.push({ url, init: init ?? {} });
      if (url.includes("/api/resource/Roof%20Job?")) return json({ data: [] });
      if (url.includes("/api/resource/Measurement%20Report?"))
        return json({ data: [] });
      if (url.endsWith("/api/resource/Measurement%20Report"))
        return json({ data: { name: "MR-UNRESOLVED" } });
      if (url.includes("/api/resource/Evidence%20Item?"))
        return json({ data: [] });
      if (url.endsWith("/api/resource/Evidence%20Item"))
        return json({ data: { name: "EV-UNRESOLVED" } });
      throw new Error(`unexpected fetch ${url}`);
    }),
  );

  const submitted = await worker.fetch(
    intakeRequest(
      {
        job_number: "26-0006",
        squares: 24,
        xml: `<APPLICAD_EXPORT>
          <POINT id="P1" data="0,0,0"/><POINT id="P2" data="10,0,0"/>
          <POINT id="P3" data="10,10,0"/><POINT id="P4" data="0,10,0"/>
          <LINE id="L1" path="P1,P2" type="EAVE" length="10"/>
          <LINE id="L2" path="P2,P3" type="EAVE" length="10"/>
          <LINE id="L3" path="P3,P4" type="EAVE" length="10"/>
          <LINE id="L4" path="P4,P1" type="EAVE" length="10"/>
          <POLYGON id="F1" path="L1,L2,L3,L4" size="100" type="Roof"/>
        </APPLICAD_EXPORT>`,
      },
      "measurement-unresolved-job-0001",
    ),
    env as never,
    ctx as never,
  );
  const submittedBody = (await submitted.json()) as {
    status: string;
    measurement_id: string;
  };
  await flushMeasurementQueue(env, queueMessages);
  assert.equal(submitted.status, 202);
  const listed = await worker.fetch(
    new Request("https://bus.example/admin/measurements/exceptions", {
      headers: { authorization: "Bearer admin-token" },
    }),
    env as never,
    ctx as never,
  );
  const listedBody = (await listed.json()) as {
    measurements: Array<Record<string, unknown>>;
  };
  const report = JSON.parse(
    String(
      fetches.find((item) =>
        item.url.endsWith("/api/resource/Measurement%20Report"),
      )?.init.body,
    ),
  );

  assert.equal(submittedBody.status, "processing");
  assert.equal(report.review_status, "Needs Review");
  assert.equal(report.provider, "AppliCad");
  const roofGraph = JSON.parse(report.roof_graph_json) as {
    schema_version: string;
    revision: string;
    source: { raw_sha256: string; provider: string };
    points: unknown[];
    edges: unknown[];
    facets: unknown[];
  };
  assert.equal(roofGraph.schema_version, "roof_graph/v1");
  assert.equal(report.roof_graph_revision, roofGraph.revision);
  assert.equal(roofGraph.source.raw_sha256, roofGraph.revision);
  assert.equal(roofGraph.source.provider, report.provider);
  assert.equal(roofGraph.points.length, 4);
  assert.equal(roofGraph.edges.length, 4);
  assert.equal(roofGraph.facets.length, 1);
  assert.equal("roof_job" in report, false);
  assert.equal(
    listedBody.measurements[0].measurement_id,
    submittedBody.measurement_id,
  );
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
  const first = await claimMeasurementIntakeReceipt(
    { DB: db as never } as Env,
    {
      ...identity,
      now: "2026-07-16T10:00:00.000Z",
      leaseToken: "lease-0001",
      leaseExpiresAt: "2026-07-16T10:02:00.000Z",
    },
  );
  const contender = await claimMeasurementIntakeReceipt(
    { DB: db as never } as Env,
    {
      ...identity,
      now: "2026-07-16T10:01:00.000Z",
      leaseToken: "lease-0002",
      leaseExpiresAt: "2026-07-16T10:03:00.000Z",
    },
  );
  assert.equal(first.kind, "claimed");
  assert.equal(contender.kind, "in_progress");
  if (first.kind !== "claimed") throw new Error("receipt not claimed");

  await markMeasurementIntakeRetryable({ DB: db as never } as Env, {
    receiptId: first.receipt.receipt_id,
    leaseToken: "lease-0001",
    error: "drive_upload_failed",
    now: "2026-07-16T10:01:30.000Z",
  });
  const reclaimed = await claimMeasurementIntakeReceipt(
    { DB: db as never } as Env,
    {
      ...identity,
      now: "2026-07-16T10:01:31.000Z",
      leaseToken: "lease-0003",
      leaseExpiresAt: "2026-07-16T10:03:31.000Z",
    },
  );
  assert.equal(reclaimed.kind, "claimed");
  if (reclaimed.kind === "claimed") assert.equal(reclaimed.receipt.attempts, 2);
});

test("measurement receipt retry sweep replays a durable source without a new inbound request", async () => {
  const db = new SqliteD1();
  const rawWrites: Array<{ key: string; body: string }> = [];
  const { env } = testEnv(db, rawWrites);
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
  const realPayloadHash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body),
  );
  const actualPayloadHash = Array.from(
    new Uint8Array(realPayloadHash),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  identity.payloadHash = actualPayloadHash;
  identity.rawKey = `raw/measurements/${actualPayloadHash}.json`;
  await env.RAW.put(identity.rawKey, body);

  const first = await claimMeasurementIntakeReceipt(env as never, {
    ...identity,
    now: "2026-07-16T10:00:00.000Z",
    leaseToken: "lease-retry-0001",
    leaseExpiresAt: "2026-07-16T10:02:00.000Z",
  });
  if (first.kind !== "claimed")
    throw new Error("retry receipt was not claimed");
  await markMeasurementIntakeRetryable(env as never, {
    receiptId: first.receipt.receipt_id,
    leaseToken: "lease-retry-0001",
    error: "drive_upload_failed",
    now: "2026-07-16T10:00:00.000Z",
  });

  await retryMeasurementIntakeReceipts(
    env as never,
    new Date("2026-07-16T10:02:00.000Z"),
  );
  const receipt = db.raw
    .prepare(
      "SELECT status, attempts, completed_at FROM measurement_intake_receipts WHERE receipt_id = ?",
    )
    .get(identity.receiptId) as {
    status: string;
    attempts: number;
    completed_at: string | null;
  };
  assert.equal(receipt.status, "matched");
  assert.equal(Number(receipt.attempts), 2);
  assert.ok(receipt.completed_at);
});

test("measurement receipt retry sweep takes over an expired processing lease", async () => {
  const db = new SqliteD1();
  const rawWrites: Array<{ key: string; body: string }> = [];
  const { env } = testEnv(db, rawWrites);
  const body = JSON.stringify({ job_number: "26-0007", squares: 24 });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body),
  );
  const payloadHash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
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

  await retryMeasurementIntakeReceipts(
    env as never,
    new Date("2026-07-16T10:02:00.000Z"),
  );
  const receipt = db.raw
    .prepare(
      "SELECT status, attempts FROM measurement_intake_receipts WHERE receipt_id = ?",
    )
    .get(identity.receiptId) as { status: string; attempts: number };
  assert.equal(receipt.status, "matched");
  assert.equal(Number(receipt.attempts), 2);
});

test("measurement queue retries an undurable failure and records one DLQ incident", async () => {
  const db = new SqliteD1();
  const rawWrites: Array<{ key: string; body: string }> = [];
  const { env, queueMessages, rawObjects } = testEnv(db, rawWrites);
  const submitted = await worker.fetch(
    intakeRequest(
      { job_number: "26-queue-1", squares: 24 },
      "measurement-queue-durable-0001",
    ),
    env as never,
    ctx as never,
  );
  assert.equal(submitted.status, 202);
  const message = queueMessages.shift();
  assert.ok(message);
  const rawKey = (db.raw.prepare(
    "SELECT raw_key FROM measurement_intake_receipts LIMIT 1",
  ).get() as { raw_key: string }).raw_key;
  rawObjects.delete(rawKey);
  db.failNextRunMatching("SET status = 'retryable_error'");

  let mainAcked = 0;
  let mainRetried = 0;
  await worker.queue({
    queue: "ironwrap-measurements",
    messages: [{
      body: message,
      ack: () => { mainAcked += 1; },
      retry: () => { mainRetried += 1; },
    }],
  } as never, env as never, {} as never);
  assert.equal(mainAcked, 0);
  assert.equal(mainRetried, 1);
  assert.equal(
    (db.raw.prepare(
      "SELECT status FROM measurement_intake_receipts LIMIT 1",
    ).get() as { status: string }).status,
    "processing",
  );

  let dlqAcked = 0;
  let dlqRetried = 0;
  const deliverDlq = async () => {
    await worker.queue({
      queue: "ironwrap-measurements-dlq",
      messages: [{
        body: message,
        ack: () => { dlqAcked += 1; },
        retry: () => { dlqRetried += 1; },
      }],
    } as never, env as never, {} as never);
  };
  await deliverDlq();
  await deliverDlq();

  assert.equal(dlqAcked, 2);
  assert.equal(dlqRetried, 0);
  const receipt = db.raw.prepare(
    "SELECT status, last_error FROM measurement_intake_receipts LIMIT 1",
  ).get() as { status: string; last_error: string | null };
  assert.equal(receipt.status, "retryable_error");
  assert.equal(receipt.last_error, "measurement_queue_exhausted");
  const incidents = db.raw.prepare(
    "SELECT stage, error, recovered FROM dead_letter",
  ).all() as Array<{ stage: string; error: string; recovered: number }>;
  assert.deepEqual(incidents.map((incident) => ({ ...incident })), [{
    stage: "measurement_processing",
    error: "measurement_queue_exhausted",
    recovered: 0,
  }]);
});

test("measurement report does not claim R2 evidence when the object write fails", async (t) => {
  const db = new SqliteD1();
  const rawWrites: Array<{ key: string; body: string }> = [];
  const { env, queueMessages, rawObjects } = testEnv(db, rawWrites);
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    assert.equal(String(input), "https://reports.example.com/r2-failure.pdf");
    return new Response(Buffer.from("%PDF-1.7 report"), {
      headers: { "content-type": "application/pdf" },
    });
  });
  const submitted = await worker.fetch(
    intakeRequest(
      { report_url: "https://reports.example.com/r2-failure.pdf" },
      "measurement-r2-failure-0001",
    ),
    env as never,
    ctx as never,
  );
  assert.equal(submitted.status, 202);
  const put = env.RAW.put;
  env.RAW.put = async (key, body) => {
    if (key.startsWith("raw/measurement-reports/")) {
      throw new Error("simulated_r2_put_failure");
    }
    await put(key, body);
  };

  await flushMeasurementQueue(env, queueMessages);
  const receipt = db.raw.prepare(
    `SELECT status, report_raw_key, report_sha256, report_content_type
     FROM measurement_intake_receipts LIMIT 1`,
  ).get() as {
    status: string;
    report_raw_key: string | null;
    report_sha256: string | null;
    report_content_type: string | null;
  };
  assert.equal(receipt.status, "retryable_error");
  assert.equal(receipt.report_raw_key, null);
  assert.equal(receipt.report_sha256, null);
  assert.equal(receipt.report_content_type, null);
  assert.equal(
    [...rawObjects.keys()].some((key) => key.startsWith("raw/measurement-reports/")),
    false,
  );
});

const SQUARE_XML = `<APPLICAD_EXPORT>
  <POINT id="P1" data="0,0,0"/><POINT id="P2" data="10,0,0"/>
  <POINT id="P3" data="10,10,0"/><POINT id="P4" data="0,10,0"/>
  <LINE id="L1" path="P1,P2" type="EAVE" length="10"/>
  <LINE id="L2" path="P2,P3" type="EAVE" length="10"/>
  <LINE id="L3" path="P3,P4" type="EAVE" length="10"/>
  <LINE id="L4" path="P4,P1" type="EAVE" length="10"/>
  <POLYGON id="F1" path="L1,L2,L3,L4" size="100" type="Roof"/>
</APPLICAD_EXPORT>`;

test("measurement helpers: zip report bytes and payload coordinates parse", async () => {
  const zip = makeZip([
    { name: "summary.pdf", data: Buffer.from("%PDF-1.7 not xml") },
    { name: "roof.xml", data: Buffer.from(SQUARE_XML) },
  ]);
  const geometry = await geometryFromReportBytes(new Uint8Array(zip));
  assert.equal(geometry?.measurements.roof_area, 100);
  assert.equal(geometry?.needsReview, false);
  assert.equal(await geometryFromReportBytes(new TextEncoder().encode("%PDF-1.7")), null);

  const sub = parseMeasurementSubmission({ job_number: "26-1", lat: 51.05, lng: -114.07 });
  assert.deepEqual(sub.coords, { lat: 51.05, lng: -114.07 });
  assert.equal(parseMeasurementSubmission({ lat: 200, lng: 10 }).coords, null);
  assert.equal(parseMeasurementSubmission({ lat: 0, lng: 0 }).coords, null);
  assert.equal(parseMeasurementSubmission({ job_number: "26-1" }).coords, null);
});

test("measurement intake: frontier OCR supplements an ordinary PDF when no structured metrics were supplied", async (t) => {
  const db = new SqliteD1();
  const rawWrites: Array<{ key: string; body: string }> = [];
  const { env, queueMessages } = testEnv(db, rawWrites, {
    MEASUREMENT_OCR_ENABLED: "true",
    MEASUREMENT_OCR_API_KEY: "anthropic-test-key",
  });
  const fetches: string[] = [];
  let anthropicCalls = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetches.push(url);
      if (url === "https://reports.example.com/ocr-only.pdf") {
        return new Response(Buffer.from("%PDF-1.7 fake measurement pdf"), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      }
      if (url === "https://api.anthropic.com/v1/messages") {
        anthropicCalls += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          messages?: Array<{ content?: Array<Record<string, unknown>> }>;
          tool_choice?: { name?: string };
        };
        assert.equal(body.tool_choice?.name, "extract_measurement_report_fields");
        const document = body.messages?.[0]?.content?.[0] as {
          type?: string;
          source?: { type?: string; media_type?: string; data?: string };
        };
        assert.equal(document?.type, "document");
        assert.equal(document?.source?.type, "base64");
        assert.equal(document?.source?.media_type, "application/pdf");
        assert.equal(typeof document?.source?.data, "string");
        assert.equal(document.source.data.length > 0, true);
        return json({
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
                  {
                    metric: "ridge_ft",
                    value: 118,
                    page: 2,
                    region: "Roof summary",
                    label: "Ridge total",
                    confidence: "high",
                  },
                ],
              },
            },
          ],
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  );

  const submitted = await worker.fetch(
    intakeRequest(
      { report_url: "https://reports.example.com/ocr-only.pdf" },
      "measurement-ocr-0001",
    ),
    env as never,
    ctx as never,
  );
  const body = (await submitted.json()) as {
    job_number: string | null;
    status: string;
    measurement_id: string;
  };
  const receipt = db.raw.prepare(
    "SELECT receipt_id, job_number, status, last_error, report_raw_key, report_sha256, report_content_type, ocr_status, ocr_model, ocr_result_key, ocr_result_sha256, ocr_job_number_candidate, ocr_review_required FROM measurement_intake_receipts LIMIT 1",
  ).get() as {
    receipt_id: string;
    job_number: string | null;
    status: string;
    last_error: string | null;
    report_raw_key: string | null;
    report_sha256: string | null;
    report_content_type: string | null;
    ocr_status: string;
    ocr_model: string | null;
    ocr_result_key: string | null;
    ocr_result_sha256: string | null;
    ocr_job_number_candidate: string | null;
    ocr_review_required: number;
  };

  assert.equal(submitted.status, 202);
  assert.equal(body.status, "processing");
  assert.equal("job_number" in body, false);
  assert.equal(queueMessages.length, 1);
  assert.equal(receipt.job_number, null);
  assert.equal(receipt.status, "processing");
  assert.equal(receipt.ocr_status, "not_requested");
  assert.equal(receipt.ocr_model, null);
  assert.equal(receipt.ocr_job_number_candidate, null);
  assert.equal(receipt.ocr_review_required, 0);

  await flushMeasurementQueue(env, queueMessages);
  const listed = await worker.fetch(
    intakeRequest(
      { report_url: "https://reports.example.com/ocr-only.pdf" },
      "measurement-ocr-0001",
    ),
    env as never,
    ctx as never,
  );
  const listedBody = (await listed.json()) as {
    status: string;
    review_reason: string;
  };
  const postQueueReceipt = db.raw.prepare(
    "SELECT report_sha256, ocr_status, ocr_model, ocr_result_key, ocr_result_sha256, ocr_review_required FROM measurement_intake_receipts LIMIT 1",
  ).get() as {
    report_sha256: string;
    ocr_status: string;
    ocr_model: string | null;
    ocr_result_key: string | null;
    ocr_result_sha256: string | null;
    ocr_review_required: number;
  };
  const ocrEvidence = await env.RAW.get(postQueueReceipt.ocr_result_key!);
  const ocrPayload = JSON.parse(new TextDecoder().decode(await ocrEvidence!.arrayBuffer())) as {
    schemaVersion: string;
    sourceRefs: Record<string, string>;
    confidences: Record<string, unknown>;
  };

  assert.equal(listed.status, 202);
  assert.equal(listedBody.status, "unmatched_review");
  assert.equal(listedBody.review_reason, "ocr_review_required");
  assert.equal(postQueueReceipt.ocr_status, "completed");
  assert.equal(postQueueReceipt.ocr_model, "claude-opus-5");
  assert.equal(postQueueReceipt.ocr_review_required, 1);
  assert.equal(anthropicCalls, 1);
  const resultSlot = await sha256Hex(
    `measurement-ocr/v1\n${receipt.receipt_id}\n${postQueueReceipt.report_sha256}\nclaude-opus-5`,
  );
  assert.equal(
    postQueueReceipt.ocr_result_key,
    `raw/measurement-ocr/${receipt.receipt_id}/${resultSlot}.json`,
  );
  assert.equal(ocrPayload.sourceRefs.squares.includes("page:1"), true);
  assert.equal(ocrPayload.confidences.squares, "medium");
  assert.equal(ocrPayload.schemaVersion, "ironwrap.measurement-ocr.v1");
  const owner = await handleAuthenticatedRoute(
    new Request(
      "https://app.example.com/api/v1/owner/measurement-intake-exceptions?limit=5",
    ),
    env as never,
    appAuth("ops"),
  );
  const ownerBody = (await owner.json()) as { measurements: Array<Record<string, unknown>> };
  assert.equal(owner.status, 200);
  assert.equal(owner.headers.get("cache-control"), "private, no-store");
  const ownerOcrReview = ownerBody.measurements.find(
    (measurement) => measurement.reason === "ocr_review_required",
  );
  assert.equal(!!ownerOcrReview, true);
  assert.equal(ownerOcrReview?.recovery_disposition, "manual_review");
  assert.deepEqual(fetches, [
    "https://reports.example.com/ocr-only.pdf",
    "https://api.anthropic.com/v1/messages",
  ]);
  const ocrStoredReceipt = db.raw.prepare(
    "SELECT report_content_type, report_raw_key, report_sha256 FROM measurement_intake_receipts WHERE receipt_id = ?",
  ).get(receipt.receipt_id) as {
    report_content_type: string | null;
    report_raw_key: string | null;
    report_sha256: string | null;
  };
  assert.equal(ocrStoredReceipt.report_content_type, "application/pdf");
  assert.match(ocrStoredReceipt.report_raw_key ?? "", /^raw\/measurement-reports\/[0-9a-f]{64}\.bin$/);
  assert.match(ocrStoredReceipt.report_sha256 ?? "", /^[0-9a-f]{64}$/);
  assert.equal(typeof body.measurement_id, "string");
});

test("measurement OCR reuses staged evidence after its D1 result commit fails", async (t) => {
  const db = new SqliteD1();
  const rawWrites: Array<{ key: string; body: string }> = [];
  const { env, queueMessages } = testEnv(db, rawWrites, {
    MEASUREMENT_OCR_ENABLED: "true",
    MEASUREMENT_OCR_API_KEY: "anthropic-test-key",
  });
  let anthropicCalls = 0;
  let reportFetches = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://reports.example.com/ocr-crash.pdf") {
        reportFetches += 1;
        return new Response(Buffer.from("%PDF-1.7 crash window"), {
          headers: { "content-type": "application/pdf" },
        });
      }
      if (url === "https://api.anthropic.com/v1/messages") {
        anthropicCalls += 1;
        return json({
          content: [{
            type: "tool_use",
            name: "extract_measurement_report_fields",
            input: {
              job_number: null,
              measurements: [{
                metric: "squares",
                value: 18.5,
                page: 1,
                region: "Summary",
                label: "Squares",
                confidence: "high",
              }],
            },
          }],
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  );
  const submitted = await worker.fetch(
    intakeRequest(
      { report_url: "https://reports.example.com/ocr-crash.pdf" },
      "measurement-ocr-crash-0001",
    ),
    env as never,
    ctx as never,
  );
  assert.equal(submitted.status, 202);
  db.failNextRunMatching("SET ocr_status = 'completed'");
  await flushMeasurementQueue(env, queueMessages);
  const failed = db.raw.prepare(
    "SELECT status, ocr_status, last_error FROM measurement_intake_receipts LIMIT 1",
  ).get() as { status: string; ocr_status: string; last_error: string | null };
  assert.equal(failed.status, "retryable_error");
  assert.equal(failed.ocr_status, "failed");
  assert.equal(failed.last_error, "measurement_processing_failed");
  assert.equal(anthropicCalls, 1);
  assert.equal(
    rawWrites.filter(({ key }) => key.startsWith("raw/measurement-ocr/")).length,
    1,
  );

  await retryMeasurementIntakeReceipts(
    env as never,
    new Date(Date.now() + 5 * 60_000),
  );
  const recovered = db.raw.prepare(
    "SELECT status, ocr_status, attempts, last_error FROM measurement_intake_receipts LIMIT 1",
  ).get() as {
    status: string;
    ocr_status: string;
    attempts: number;
    last_error: string | null;
  };
  assert.equal(recovered.status, "unmatched");
  assert.equal(recovered.ocr_status, "completed");
  assert.equal(Number(recovered.attempts), 2);
  assert.equal(recovered.last_error, "ocr_review_required");
  assert.equal(anthropicCalls, 1);
  assert.equal(reportFetches, 1);
});

test("measurement OCR blocks oversized PDFs before model spend and retry", async (t) => {
  const db = new SqliteD1();
  const rawWrites: Array<{ key: string; body: string }> = [];
  const { env, queueMessages } = testEnv(db, rawWrites, {
    MEASUREMENT_OCR_ENABLED: "true",
    MEASUREMENT_OCR_API_KEY: "anthropic-test-key",
  });
  const pdf = new Uint8Array(8 * 1024 * 1024 + 1);
  pdf.set(new TextEncoder().encode("%PDF-1.7"));
  let anthropicCalls = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "https://reports.example.com/ocr-large.pdf") {
      return new Response(pdf, { headers: { "content-type": "application/pdf" } });
    }
    if (url === "https://api.anthropic.com/v1/messages") {
      anthropicCalls += 1;
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  await worker.fetch(
    intakeRequest(
      { report_url: "https://reports.example.com/ocr-large.pdf" },
      "measurement-ocr-large-0001",
    ),
    env as never,
    ctx as never,
  );
  await flushMeasurementQueue(env, queueMessages);
  const beforeRetry = db.raw.prepare(
    "SELECT status, last_error, attempts FROM measurement_intake_receipts LIMIT 1",
  ).get() as { status: string; last_error: string | null; attempts: number };
  assert.equal(beforeRetry.status, "retryable_error");
  assert.equal(beforeRetry.last_error, "measurement_ocr_pdf_too_large");
  assert.equal(anthropicCalls, 0);

  await retryMeasurementIntakeReceipts(
    env as never,
    new Date(Date.now() + 24 * 60 * 60_000),
  );
  const afterRetry = db.raw.prepare(
    "SELECT attempts FROM measurement_intake_receipts LIMIT 1",
  ).get() as { attempts: number };
  assert.equal(Number(afterRetry.attempts), Number(beforeRetry.attempts));
  assert.equal(anthropicCalls, 0);
  const owner = await handleAuthenticatedRoute(
    new Request("https://app.example.com/api/v1/owner/measurement-intake-exceptions?limit=5"),
    env as never,
    appAuth("owner"),
  );
  const ownerBody = await owner.json() as {
    measurements: Array<{ recovery_disposition: string }>;
  };
  assert.equal(ownerBody.measurements[0]?.recovery_disposition, "recovery_blocked");
});

test("measurement intake: frontier OCR keeps a discovered job number provisional", async (t) => {
  const db = new SqliteD1();
  const rawWrites: Array<{ key: string; body: string }> = [];
  const { env, queueMessages } = testEnv(db, rawWrites, {
    MEASUREMENT_OCR_ENABLED: "true",
    MEASUREMENT_OCR_API_KEY: "anthropic-test-key",
  });
  let anthropicCalls = 0;
  const fetches: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetches.push(url);
      if (url === "https://reports.example.com/ocr-job.pdf") {
        return new Response(Buffer.from("%PDF-1.7 fake measurement pdf"), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      }
      if (url === "https://api.anthropic.com/v1/messages") {
        anthropicCalls += 1;
        return json({
          content: [
            {
              type: "tool_use",
              name: "extract_measurement_report_fields",
              input: {
                job_number: {
                  value: "26-0099",
                  page: 1,
                  region: "Cover",
                  label: "Job label",
                  confidence: "high",
                },
                measurements: [
                  {
                    metric: "squares",
                    value: 21.4,
                    page: 2,
                    region: "Roof",
                    label: "Roof squares",
                    confidence: "low",
                  },
                  {
                    metric: "ridge_ft",
                    value: 118,
                    page: 3,
                    region: "Roof",
                    label: "Ridge ft",
                    confidence: "high",
                  },
                  {
                    metric: "ridge_ft",
                    value: 120,
                    page: 4,
                    region: "Roof",
                    label: "Ridge ft duplicate",
                    confidence: "medium",
                  },
                ],
              },
            },
          ],
        });
      }
      throw new Error(`unexpected fetch ${url}: ${String(init?.method ?? "GET")}`);
    },
  );

  const submitted = await worker.fetch(
    intakeRequest(
      { report_url: "https://reports.example.com/ocr-job.pdf" },
      "measurement-ocr-job-0001",
    ),
    env as never,
    ctx as never,
  );
  const submitBody = (await submitted.json()) as {
    measurement_id: string;
    status: string;
  };
  await flushMeasurementQueue(env, queueMessages);
  const listed = await worker.fetch(
    intakeRequest(
      { report_url: "https://reports.example.com/ocr-job.pdf" },
      "measurement-ocr-job-0001",
    ),
    env as never,
    ctx as never,
  );
  const body = (await listed.json()) as {
    status: string;
    review_reason: string;
    measurement_id: string;
  };
  const receipt = db.raw.prepare(
    "SELECT receipt_id, job_number, status, last_error, report_sha256, ocr_status, ocr_job_number_candidate, ocr_job_number_source_ref, ocr_result_key, ocr_result_sha256 FROM measurement_intake_receipts LIMIT 1",
  ).get() as {
    receipt_id: string;
    job_number: string | null;
    status: string;
    last_error: string | null;
    report_sha256: string;
    ocr_status: string;
    ocr_job_number_candidate: string | null;
    ocr_job_number_source_ref: string | null;
    ocr_result_key: string | null;
    ocr_result_sha256: string | null;
  };
  const ocrEvidence = await env.RAW.get(receipt.ocr_result_key!);
  const ocrPayload = JSON.parse(new TextDecoder().decode(await ocrEvidence!.arrayBuffer())) as {
    checks: Array<{ code: string; ok: boolean }>;
    sourceRefs: Record<string, string>;
    confidences: Record<string, string>;
    jobNumberCandidate: { value: string; sourceRef: string };
  };

  assert.equal(submitted.status, 202);
  assert.equal(submitBody.status, "processing");
  assert.equal(queueMessages.length, 0);
  assert.equal(listed.status, 202);
  assert.equal(body.status, "unmatched_review");
  assert.equal(body.review_reason, "ocr_review_required");
  assert.equal(body.measurement_id, submitBody.measurement_id);
  assert.equal(receipt.job_number, null);
  assert.equal(receipt.status, "unmatched");
  assert.equal(receipt.last_error, "ocr_review_required");
  assert.equal(receipt.ocr_status, "completed");
  assert.equal(receipt.ocr_job_number_candidate, "26-0099");
  assert.equal(receipt.ocr_job_number_source_ref, "page:1; region:Cover; label:Job label");
  assert.equal(ocrPayload.sourceRefs.squares, "page:2; region:Roof; label:Roof squares");
  assert.equal(ocrPayload.confidences.squares, "low");
  assert.equal(ocrPayload.checks.some((check) => check.code === "low_confidence:squares"), true);
  assert.equal(ocrPayload.checks.some((check) => check.code === "duplicate_conflict:ridge_ft"), true);
  assert.equal(ocrPayload.jobNumberCandidate.value, "26-0099");
  assert.equal(anthropicCalls, 1);
  assert.equal(fetches.filter((url) => url === "https://api.anthropic.com/v1/messages").length, 1);

  await handleMeasurementQueueMessage(
    env as never,
    receipt.receipt_id,
    "stale-token",
  );
  const noOp = db.raw.prepare(
    "SELECT ocr_result_key, ocr_job_number_candidate FROM measurement_intake_receipts LIMIT 1",
  ).get() as {
    ocr_result_key: string;
    ocr_job_number_candidate: string | null;
  };
  assert.equal(noOp.ocr_job_number_candidate, "26-0099");
  assert.equal(anthropicCalls, 1);
  const resultSlot = await sha256Hex(
    `measurement-ocr/v1\n${receipt.receipt_id}\n${receipt.report_sha256}\nclaude-opus-5`,
  );
  assert.equal(
    noOp.ocr_result_key,
    `raw/measurement-ocr/${receipt.receipt_id}/${resultSlot}.json`,
  );
  assert.equal(fetches[0], "https://reports.example.com/ocr-job.pdf");
});

test("measurement intake: Solar cross-check flags divergence and passes agreement", async (t) => {
  const db = new SqliteD1();
  const rawWrites: Array<{ key: string; body: string }> = [];
  const { env, queueMessages } = testEnv(db, rawWrites, {
    ERPNEXT_ENABLED: "true",
    ERPNEXT_BASE_URL: "https://erp.example.com",
    ERPNEXT_API_KEY: "erp-key",
    ERPNEXT_API_SECRET: "erp-secret",
    GOOGLE_MAPS_API_KEY: "solar-key",
  });
  const fetches: Array<{ url: string; init: RequestInit }> = [];
  const today = new Date();
  t.mock.method(
    globalThis,
    "fetch",
    withErpReadback(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetches.push({ url, init: init ?? {} });
      if (url.startsWith("https://solar.googleapis.com/")) {
        // Calgary address: wildly divergent roof. Edmonton address: agreeing roof.
        const divergent = url.includes("location.latitude=51.");
        return json({
          imageryDate: {
            year: today.getUTCFullYear(),
            month: today.getUTCMonth() + 1,
            day: today.getUTCDate(),
          },
          imageryQuality: "MEDIUM",
          solarPotential: { wholeRoofStats: { areaMeters2: divergent ? 5 : 9.2903 } },
        });
      }
      if (url.includes("/api/resource/Roof%20Job?")) return json({ data: [{ name: "RJ-0007" }] });
      if (url.includes("/api/resource/Measurement%20Report?")) return json({ data: [] });
      if (url.endsWith("/api/resource/Measurement%20Report")) return json({ data: { name: "MR-SOLAR" } });
      if (url.includes("/api/resource/Evidence%20Item?")) return json({ data: [] });
      if (url.endsWith("/api/resource/Evidence%20Item")) return json({ data: { name: "EV-SOLAR" } });
      throw new Error(`unexpected fetch ${url}`);
    }),
  );

  const divergent = await worker.fetch(
    intakeRequest(
      { job_number: "26-0007", lat: 51.0447, lng: -114.0719, xml: SQUARE_XML },
      "measurement-solar-0001",
    ),
    env as never,
    ctx as never,
  );
  assert.equal(divergent.status, 202);
  assert.equal(queueMessages.length, 1);
  await flushMeasurementQueue(env, queueMessages);
  const divergentReplay = await worker.fetch(
    intakeRequest(
      { job_number: "26-0007", lat: 51.0447, lng: -114.0719, xml: SQUARE_XML },
      "measurement-solar-0001",
    ),
    env as never,
    ctx as never,
  );
  assert.equal(divergentReplay.status, 200);
  const divergentReport = JSON.parse(String(
    fetches.find((item) => item.url.endsWith("/api/resource/Measurement%20Report"))?.init.body,
  ));
  assert.equal(divergentReport.review_status, "Needs Review");
  const divergentGraph = JSON.parse(divergentReport.roof_graph_json) as {
    needs_review: boolean;
    checks: Array<{ check: string; ok: boolean; detail: string }>;
  };
  assert.equal(divergentGraph.needs_review, true);
  const areaCheck = divergentGraph.checks.find((c) => c.check === "cross_source_roof_area");
  assert.equal(areaCheck?.ok, false);
  assert.match(areaCheck?.detail ?? "", /%/);
  assert.ok(divergentGraph.checks.some((c) => c.check === "cross_source_imagery" && c.ok));

  fetches.length = 0;
  const agreeing = await worker.fetch(
    intakeRequest(
      { job_number: "26-0008", lat: 53.5461, lng: -113.4938, xml: SQUARE_XML },
      "measurement-solar-0002",
    ),
    env as never,
    ctx as never,
  );
  assert.equal(agreeing.status, 202);
  assert.equal(queueMessages.length, 1);
  await flushMeasurementQueue(env, queueMessages);
  const agreeingReplay = await worker.fetch(
    intakeRequest(
      { job_number: "26-0008", lat: 53.5461, lng: -113.4938, xml: SQUARE_XML },
      "measurement-solar-0002",
    ),
    env as never,
    ctx as never,
  );
  assert.equal(agreeingReplay.status, 200);
  const agreeingReport = JSON.parse(String(
    fetches.find((item) => item.url.endsWith("/api/resource/Measurement%20Report"))?.init.body,
  ));
  // review_status stays "Needs Review" here for a PRE-EXISTING reason: no filed
  // source document (no report_url in the payload). The cross-check verdict lives
  // in the roof graph, which must be clean when the sources agree.
  assert.equal(agreeingReport.review_status, "Needs Review");
  const agreeingGraph = JSON.parse(agreeingReport.roof_graph_json) as {
    needs_review: boolean;
    checks: Array<{ check: string; ok: boolean }>;
  };
  assert.equal(agreeingGraph.needs_review, false);
  assert.equal(agreeingGraph.checks.find((c) => c.check === "cross_source_roof_area")?.ok, true);
  assert.equal(agreeingGraph.checks.find((c) => c.check === "cross_source_confidence_availability")?.ok, true);
  assert.equal(agreeingGraph.checks.find((c) => c.check === "cross_source_segment_correspondence")?.ok, true);
  assert.equal(agreeingGraph.checks.find((c) => c.check === "cross_source_azimuth_availability")?.ok, true);

  // Every comparison landed in the calibration ledger with structured numbers.
  const ledger = db.raw
    .prepare("SELECT tenant_id, check_name, metric, ok, primary_value, independent_value, rel_diff, signed_error, error_kind FROM measurement_deltas ORDER BY id")
    .all() as Array<{ tenant_id: string; check_name: string; metric: string; ok: number; primary_value: number | null; independent_value: number | null; rel_diff: number | null; signed_error: number | null; error_kind: string }>;
  const areaRows = ledger.filter((r) => r.check_name === "cross_source_roof_area");
  assert.equal(areaRows.length, 2); // divergent + agreeing submissions
  assert.equal(areaRows[0].ok, 0);
  assert.equal(areaRows[0].primary_value, 100);
  assert.ok((areaRows[0].rel_diff ?? 0) > 0.4);
  assert.equal(areaRows[0].tenant_id, "ironwrap");
  assert.ok((areaRows[0].signed_error ?? 0) < -0.4);
  assert.equal(areaRows[0].error_kind, "relative_fraction");
  assert.equal(areaRows[1].ok, 1);
  assert.ok((areaRows[1].rel_diff ?? 1) < 0.001);
  assert.ok(ledger.some((r) => r.check_name === "cross_source_imagery" && r.metric === ""));

  // The admin surface exposes rows + measured-accuracy aggregates.
  const adminRes = await worker.fetch(
    new Request("https://bus.example/admin/measurements/deltas", {
      headers: { authorization: "Bearer admin-token" },
    }),
    env as never,
    ctx as never,
  );
  assert.equal(adminRes.status, 200);
  const adminBody = (await adminRes.json()) as {
    deltas: Array<{ check_name: string }>;
    aggregates: Array<{ source: string; metric: string; total: number; ok_count: number; status: string }>;
    calibration: { minimum_sample_size: number; automatic_tolerance_promotion: boolean };
  };
  assert.ok(adminBody.deltas.length >= 4);
  const areaAgg = adminBody.aggregates.find((a) => a.source === "google_solar" && a.metric === "roof_area")!;
  assert.equal(areaAgg.total, 2);
  assert.equal(Number(areaAgg.ok_count), 1);
  assert.equal(areaAgg.status, "insufficient_data");
  assert.equal(adminBody.calibration.minimum_sample_size, 30);
  assert.equal(adminBody.calibration.automatic_tolerance_promotion, false);

  const invalidAsOf = await worker.fetch(
    new Request("https://bus.example/admin/measurements/deltas?as_of=2026-08-13", {
      headers: { authorization: "Bearer admin-token" },
    }),
    env as never,
    ctx as never,
  );
  assert.equal(invalidAsOf.status, 400);
  assert.deepEqual(await invalidAsOf.json(), { error: "invalid_as_of" });
});

test("measurement intake: Solar outage never fails intake", async (t) => {
  const db = new SqliteD1();
  const rawWrites: Array<{ key: string; body: string }> = [];
  const { env, queueMessages } = testEnv(db, rawWrites, {
    ERPNEXT_ENABLED: "true",
    ERPNEXT_BASE_URL: "https://erp.example.com",
    ERPNEXT_API_KEY: "erp-key",
    ERPNEXT_API_SECRET: "erp-secret",
    GOOGLE_MAPS_API_KEY: "solar-key",
  });
  let persistedGraph: { checks: Array<{ check: string; ok: boolean }> } | null = null;
  t.mock.method(
    globalThis,
    "fetch",
    withErpReadback(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://solar.googleapis.com/")) {
        return new Response("upstream broken", { status: 500 });
      }
      if (url.includes("/api/resource/Roof%20Job?")) return json({ data: [{ name: "RJ-0009" }] });
      if (url.includes("/api/resource/Measurement%20Report?")) return json({ data: [] });
      if (url.endsWith("/api/resource/Measurement%20Report")) {
        const report = JSON.parse(String(init?.body ?? "{}")) as { roof_graph_json: string };
        persistedGraph = JSON.parse(report.roof_graph_json) as { checks: Array<{ check: string; ok: boolean }> };
        return json({ data: { name: "MR-OUTAGE" } });
      }
      if (url.includes("/api/resource/Evidence%20Item?")) return json({ data: [] });
      if (url.endsWith("/api/resource/Evidence%20Item")) return json({ data: { name: "EV-OUTAGE" } });
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
  const submitted = await worker.fetch(
    intakeRequest(
      { job_number: "26-0009", lat: 51.1, lng: -114.1, xml: SQUARE_XML },
      "measurement-solar-outage-0001",
    ),
    env as never,
    ctx as never,
  );
  assert.equal(submitted.status, 202);
  assert.equal(queueMessages.length, 1);
  await flushMeasurementQueue(env, queueMessages);
  const replay = await worker.fetch(
    intakeRequest(
      { job_number: "26-0009", lat: 51.1, lng: -114.1, xml: SQUARE_XML },
      "measurement-solar-outage-0001",
    ),
    env as never,
    ctx as never,
  );
  const body = (await replay.json()) as { status: string };
  assert.equal(replay.status, 200);
  assert.equal(body.status, "matched");
  assert.equal(persistedGraph?.checks.some((check) => check.check === "cross_source_availability" && check.ok), true);
});
