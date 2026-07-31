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
  retryMeasurementIntakeReceipts,
} from "../src/measurements.ts";
import { handleAuthenticatedRoute } from "../src/app-api.ts";
import type { AppRole, AuthContext } from "../src/app-types.ts";
import { makeZip } from "./zip-helper.ts";

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    for (const migration of [
      "0001_init.sql",
      "0009_replay_approval_audit.sql",
      "0019_measurement_intake_receipts.sql",
    ]) {
      this.raw.exec(
        readFileSync(
          new URL(`../migrations/${migration}`, import.meta.url),
          "utf8",
        ),
      );
    }
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
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });

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
  const env = testEnv(db, rawWrites);
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

  assert.equal(first.status, 200);
  assert.equal(firstBody.status, "matched");
  assert.equal(replay.status, 200);
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
  const env = testEnv(db, rawWrites);

  const first = await worker.fetch(
    intakeRequest(
      { job_number: "26-0002", squares: 24 },
      "measurement-conflict-0001",
    ),
    env as never,
    ctx as never,
  );
  const conflict = await worker.fetch(
    intakeRequest(
      { job_number: "26-0002", squares: 25 },
      "measurement-conflict-0001",
    ),
    env as never,
    ctx as never,
  );

  assert.equal(first.status, 200);
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), {
    error: "measurement_idempotency_conflict",
  });
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
  const submittedBody = (await submitted.json()) as {
    measurement_id: string;
    status: string;
  };
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
  assert.equal(submittedBody.status, "unmatched_review");
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

test("measurement intake: owner PWA exceptions are role-scoped and strictly redact operational internals", async () => {
  const db = new SqliteD1();
  const rawWrites: Array<{ key: string; body: string }> = [];
  const env = testEnv(db, rawWrites);

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

test("measurement intake: a report waits in the retryable queue until Drive is configured", async () => {
  const db = new SqliteD1();
  const rawWrites: Array<{ key: string; body: string }> = [];
  const env = testEnv(db, rawWrites);

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
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
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
    },
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

  assert.equal(submitted.status, 202);
  assert.equal(submittedBody.status, "unmatched_review");
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
  const env = testEnv(db, rawWrites);
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

test("measurement intake: Solar cross-check flags divergence and passes agreement", async (t) => {
  const db = new SqliteD1();
  const rawWrites: Array<{ key: string; body: string }> = [];
  const env = testEnv(db, rawWrites, {
    ERPNEXT_ENABLED: "true",
    ERPNEXT_BASE_URL: "https://erp.example.com",
    ERPNEXT_API_KEY: "erp-key",
    ERPNEXT_API_SECRET: "erp-secret",
    GOOGLE_MAPS_API_KEY: "solar-key",
  });
  const fetches: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetches.push({ url, init: init ?? {} });
      if (url.startsWith("https://solar.googleapis.com/")) {
        // Calgary address: wildly divergent roof. Edmonton address: agreeing roof.
        const divergent = url.includes("location.latitude=51.");
        return json({
          imageryDate: { year: 2023, month: 5, day: 1 },
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
    },
  );

  const divergent = await worker.fetch(
    intakeRequest(
      { job_number: "26-0007", lat: 51.0447, lng: -114.0719, xml: SQUARE_XML },
      "measurement-solar-0001",
    ),
    env as never,
    ctx as never,
  );
  assert.equal(divergent.status, 200);
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
  assert.equal(agreeing.status, 200);
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
});

test("measurement intake: Solar outage never fails intake", async (t) => {
  const db = new SqliteD1();
  const rawWrites: Array<{ key: string; body: string }> = [];
  const env = testEnv(db, rawWrites, {
    ERPNEXT_ENABLED: "true",
    ERPNEXT_BASE_URL: "https://erp.example.com",
    ERPNEXT_API_KEY: "erp-key",
    ERPNEXT_API_SECRET: "erp-secret",
    GOOGLE_MAPS_API_KEY: "solar-key",
  });
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://solar.googleapis.com/")) {
        return new Response("upstream broken", { status: 500 });
      }
      if (url.includes("/api/resource/Roof%20Job?")) return json({ data: [{ name: "RJ-0009" }] });
      if (url.includes("/api/resource/Measurement%20Report?")) return json({ data: [] });
      if (url.endsWith("/api/resource/Measurement%20Report")) return json({ data: { name: "MR-OUTAGE" } });
      if (url.includes("/api/resource/Evidence%20Item?")) return json({ data: [] });
      if (url.endsWith("/api/resource/Evidence%20Item")) return json({ data: { name: "EV-OUTAGE" } });
      throw new Error(`unexpected fetch ${url}`);
    },
  );
  const submitted = await worker.fetch(
    intakeRequest(
      { job_number: "26-0009", lat: 51.1, lng: -114.1, xml: SQUARE_XML },
      "measurement-solar-outage-0001",
    ),
    env as never,
    ctx as never,
  );
  assert.equal(submitted.status, 200);
  const body = (await submitted.json()) as { status: string };
  assert.equal(body.status, "matched");
});
