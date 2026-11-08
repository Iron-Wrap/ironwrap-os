import assert from "node:assert/strict";
import { test } from "node:test";

import worker from "../src/index.ts";
import {
  claimMeasurementIntakeReceipt,
  completeMeasurementIntakeReceipt,
  markMeasurementIntakeRetryable,
  recordMeasurementDriveFiling,
  recordMeasurementOcrFailure,
  recordMeasurementOcrResult,
  recordMeasurementOcrStarted,
  recordMeasurementReportEvidence,
} from "../src/measurement-intake-store.ts";
import { resetTenantCache, tenantEnvFor } from "../src/tenancy.ts";
import { SqliteD1, NOW } from "./company-setup-fixture.ts";

const A = "ironwrap";
const B = "northline-metal";
const receiptId = `measurement_${"a".repeat(64)}`;
const lease = "tenant-queue-original-lease";

function fixture() {
  resetTenantCache();
  const db = new SqliteD1({ seedUsers: [] });
  db.raw.prepare(
    `INSERT INTO tenants (tenant_id, display_name, status, data_class, settings_json,
      version, write_id, created_at, updated_at)
     VALUES (?, 'Synthetic B', 'active', 'synthetic', '{}', 1, 'tenant-queue-fixture', ?, ?)`,
  ).run(B, NOW, NOW);
  db.raw.prepare("INSERT INTO tenant_hosts (host, tenant_id, created_at) VALUES (?, ?, ?)")
    .run("b.example.invalid", B, NOW);
  const calls: string[] = [];
  const prepare = db.prepare.bind(db);
  db.prepare = (sql: string) => { calls.push(sql); return prepare(sql); };
  let rawReads = 0;
  let sends = 0;
  const env = {
    DB: db, APP_TENANT_ID: A, APP_MULTI_TENANT_ENABLED: "true",
    NEWO_ENABLED: "false", ERPNEXT_ENABLED: "false", JOBNIMBUS_ENABLED: "false",
    AGENT_DATA_CLASS: "synthetic",
    RAW: { async get() { rawReads++; return null; } },
    NEWO_QUEUE: { async send() { sends++; }, async sendBatch() { sends++; } },
  } as unknown as Env;
  return { db, env, calls, rawReads: () => rawReads, sends: () => sends };
}

async function seed(env: Env, tenantId = A) {
  const tenantEnv = { ...env, APP_TENANT_ID: tenantId };
  await claimMeasurementIntakeReceipt(tenantEnv, {
    receiptId, tenantId, idempotencyKeyHash: "a".repeat(64), payloadHash: "b".repeat(64),
    keyStrategy: "request_header", measurementId: `measurement:${"a".repeat(64)}`,
    provider: "Synthetic", jobNumber: null, rawKey: `raw/measurements/${"b".repeat(64)}.json`,
    contentType: "application/json", now: new Date().toISOString(), leaseToken: lease,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
}

function read(db: SqliteD1) {
  return { ...db.raw.prepare("SELECT * FROM measurement_intake_receipts WHERE receipt_id = ?").get(receiptId) };
}

function deadLetters(db: SqliteD1) {
  return db.raw.prepare("SELECT stage, error FROM dead_letter ORDER BY rowid").all().map((row) => ({ ...row }));
}

async function dispatch(env: Env, body: object, dlq = false) {
  let acks = 0;
  let retries = 0;
  await worker.queue({
    queue: dlq ? "tenant-isolation-dlq" : "tenant-isolation-main",
    messages: [{ body, attempts: 1, ack() { acks++; }, retry() { retries++; } }],
  } as never, env, {} as never);
  return { acks, retries };
}

for (const tenant of [A, B]) {
  test(`measurement queue processes only its own ${tenant} receipt`, async () => {
    const f = fixture();
    await seed(f.env, tenant);
    assert.deepEqual(await dispatch(f.env, { tenant_id: tenant, measurement_receipt_id: receiptId, lease_token: lease }), { acks: 1, retries: 0 });
    assert.equal(f.rawReads(), 1);
    assert.equal(read(f.db).status, "retryable_error");
    assert.equal(read(f.db).last_error, "raw_source_missing");
    f.db.raw.close();
  });
}

for (const dlq of [false, true]) {
  for (const token of [lease, "stale-lease"]) {
    test(`foreign measurement ${dlq ? "DLQ" : "main"} preserves the complete row with ${token}`, async () => {
      const f = fixture();
      await seed(f.env);
      const before = read(f.db);
      f.calls.length = 0;
      assert.deepEqual(await dispatch(f.env, { tenant_id: B, measurement_receipt_id: receiptId, lease_token: token }, dlq), { acks: 1, retries: 0 });
      assert.deepEqual(read(f.db), before);
      assert.equal(f.rawReads(), 0);
      assert.equal(f.calls.some((sql) => /^\s*(INSERT|UPDATE|DELETE)/.test(sql)), false);
      f.db.raw.close();
    });
  }
  test(`same-tenant stale measurement ${dlq ? "DLQ" : "main"} does not write`, async () => {
    const f = fixture();
    await seed(f.env);
    const before = read(f.db);
    f.calls.length = 0;
    await dispatch(f.env, { tenant_id: A, measurement_receipt_id: receiptId, lease_token: "stale" }, dlq);
    assert.deepEqual(read(f.db), before);
    assert.equal(f.calls.some((sql) => /^\s*(INSERT|UPDATE|DELETE)/.test(sql)), false);
    f.db.raw.close();
  });
  test(`registry Newo ${dlq ? "DLQ" : "main"} refuses before legacy reads or writes`, async () => {
    const f = fixture();
    assert.deepEqual(await dispatch(f.env, { tenant_id: B, newo_event_id: "foreign-event" }, dlq), dlq ? { acks: 1, retries: 0 } : { acks: 0, retries: 1 });
    assert.equal(f.calls.some((sql) => /newo_|audit_log/.test(sql)), false);
    // The DLQ has no further retry, so the refusal itself is the durable incident.
    assert.deepEqual(deadLetters(f.db), dlq ? [{ stage: "tenant_unresolved", error: "newo_tenant_not_supported" }] : []);
    assert.equal(f.sends(), 0);
    f.db.raw.close();
  });
}

test("all measurement lease writes retain tenant identity, including a direct completion request", async () => {
  const f = fixture();
  await seed(f.env);
  const before = read(f.db);
  const scoped = await tenantEnvFor(f.env, B);
  assert.equal(scoped.kind, "tenant");
  if (scoped.kind === "refused") throw new Error("fixture tenant missing");
  const common = { receiptId, leaseToken: lease, now: NOW };
  const attempts = [
    () => markMeasurementIntakeRetryable(scoped.env, { ...common, error: "foreign" }),
    () => recordMeasurementDriveFiling(scoped.env, { ...common, reportUrl: null, folderUrl: null }),
    () => recordMeasurementReportEvidence(scoped.env, { ...common, rawKey: "foreign", sha256: "c".repeat(64), contentType: "application/pdf" }),
    () => recordMeasurementOcrStarted(scoped.env, { ...common, model: "synthetic" }),
    () => recordMeasurementOcrResult(scoped.env, { ...common, model: "synthetic", resultKey: "foreign", resultSha256: "c".repeat(64), jobNumberCandidate: null, jobNumberSourceRef: null }),
    () => recordMeasurementOcrFailure(scoped.env, { ...common, model: "synthetic", error: "foreign" }),
    () => completeMeasurementIntakeReceipt(scoped.env, { ...common, tenantId: A, status: "unmatched", nativeRoofJobId: null, nativeMeasurementRevisionId: "foreign", nativeProjectionSha256: "c".repeat(64), lastError: null }),
  ];
  for (const attempt of attempts) {
    await assert.rejects(attempt);
    assert.deepEqual(read(f.db), before);
  }
  f.db.raw.close();
});

for (const dlq of [false, true]) {
  test(`measurement ${dlq ? "DLQ" : "main"} loses its lease between read and write without changing the successor`, async () => {
    const f = fixture();
    await seed(f.env);
    const replaceLease = () => f.db.raw.prepare("UPDATE measurement_intake_receipts SET lease_token = ? WHERE receipt_id = ?").run("new-owner-lease", receiptId);
    if (dlq) {
      const prepare = f.db.prepare.bind(f.db);
      f.db.prepare = (sql: string) => {
        if (sql.includes("INSERT OR IGNORE INTO dead_letter")) replaceLease();
        return prepare(sql);
      };
    } else {
      f.env.RAW = { async get() { replaceLease(); return null; } } as never;
    }
    assert.deepEqual(await dispatch(f.env, { tenant_id: A, measurement_receipt_id: receiptId, lease_token: lease }, dlq), { acks: 1, retries: 0 });
    assert.equal(read(f.db).lease_token, "new-owner-lease");
    assert.equal(read(f.db).status, "processing");
    assert.equal(read(f.db).last_error, null);
    assert.equal(f.db.raw.prepare("SELECT COUNT(*) AS n FROM dead_letter").get()?.n, 0);
    f.db.raw.close();
  });
}

test("missing measurement DLQ receipt cannot authorize an incident", async () => {
  const f = fixture();
  await dispatch(f.env, { tenant_id: A, measurement_receipt_id: receiptId, lease_token: lease }, true);
  assert.equal(f.db.raw.prepare("SELECT COUNT(*) AS n FROM dead_letter").get()?.n, 0);
  f.db.raw.close();
});

for (const dlq of [false, true]) {
  test(`disabling shared tenancy does not reinterpret typed ${dlq ? "DLQ" : "main"} backlog as default-tenant work`, async () => {
    const f = fixture();
    await seed(f.env);
    f.env.APP_MULTI_TENANT_ENABLED = "false";
    const before = read(f.db);
    f.calls.length = 0;
    for (const body of [{ measurement_receipt_id: receiptId, lease_token: lease }, { newo_event_id: "foreign-event" }]) {
      assert.deepEqual(await dispatch(f.env, { ...body, tenant_id: B }, dlq), dlq ? { acks: 1, retries: 0 } : { acks: 0, retries: 1 });
    }
    assert.deepEqual(read(f.db), before);
    assert.equal(f.calls.length, dlq ? 2 : 0);
    assert.ok(f.calls.every((sql) => /INSERT INTO dead_letter/.test(sql)));
    const refusal = { stage: "tenant_unresolved", error: "queue_receipt_tenant_mismatch" };
    assert.deepEqual(deadLetters(f.db), dlq ? [refusal, refusal] : []);
    assert.equal(f.rawReads(), 0);
    f.db.raw.close();
  });
}

test("legacy unstamped measurement backlog still processes the default tenant", async () => {
  const f = fixture();
  await seed(f.env);
  f.env.APP_MULTI_TENANT_ENABLED = "false";
  assert.deepEqual(await dispatch(f.env, { measurement_receipt_id: receiptId, lease_token: lease }), { acks: 1, retries: 0 });
  assert.equal(read(f.db).status, "retryable_error");
  assert.equal(f.rawReads(), 1);
  f.db.raw.close();
});

for (const status of ["unknown", "suspended"]) {
  test(`${status} tenant cannot process a measurement or Newo queue message`, async () => {
    const f = fixture();
    await seed(f.env);
    if (status === "suspended") f.db.raw.prepare("UPDATE tenants SET status = 'suspended' WHERE tenant_id = ?").run(B);
    const tenant = status === "unknown" ? "missing-tenant" : B;
    const before = read(f.db);
    f.calls.length = 0;
    for (const body of [{ measurement_receipt_id: receiptId, lease_token: lease }, { newo_event_id: "foreign-event" }]) {
      assert.deepEqual(await dispatch(f.env, { ...body, tenant_id: tenant }), { acks: 0, retries: 1 });
      assert.deepEqual(await dispatch(f.env, { ...body, tenant_id: tenant }, true), { acks: 1, retries: 0 });
    }
    assert.deepEqual(read(f.db), before);
    assert.equal(f.calls.some((sql) => /FROM (measurement_intake_receipts|newo_)/.test(sql)), false);
    assert.equal(f.db.raw.prepare("SELECT COUNT(*) AS n FROM dead_letter WHERE stage != 'tenant_unresolved'").get()?.n, 0);
    f.db.raw.close();
  });
}

test("registry Newo webhooks refuse before consuming a payload or creating an unbound message", async () => {
  const f = fixture();
  f.env.NEWO_ENABLED = "true";
  for (const path of ["event", "booking", "booking/cancel", "availability", "lookup"]) {
    const response = await worker.fetch(new Request(`https://b.example.invalid/webhook/newo/${path}`, { method: "POST", body: "{}" }), f.env, {} as never);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "newo_tenant_not_supported" });
  }
  assert.equal(f.calls.some((sql) => /newo_|dead_letter|audit_log/.test(sql)), false);
  assert.equal(f.sends(), 0);
  f.db.raw.close();
});
