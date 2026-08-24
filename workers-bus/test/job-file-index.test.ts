import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import type { EnvelopeRecord } from "../src/core.ts";
import {
  recordOperatingJobFile,
  recordOperatingJobFileBestEffort,
} from "../src/job-file-index.ts";
import { materializeOperatingCore } from "../src/operating-core.ts";

class TestD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    for (const name of [
      "0001_init.sql",
      "0090_operating_core.sql",
      "0108_operating_job_file_index.sql",
    ]) {
      this.raw.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    }
  }

  prepare(sql: string) {
    const db = this.raw;
    return {
      bind: (...args: unknown[]) => ({
        first: async <T>() => (db.prepare(sql).get(...args) ?? null) as T | null,
        all: async <T>() => ({ results: db.prepare(sql).all(...args) as T[] }),
        run: async () => {
          const result = db.prepare(sql).run(...args);
          return { success: true, meta: { changes: Number(result.changes) } };
        },
      }),
    };
  }

  async batch(statements: Array<{ run(): Promise<unknown> }>) {
    this.raw.exec("BEGIN");
    try {
      for (const statement of statements) await statement.run();
      this.raw.exec("COMMIT");
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }
}

function envelope(): EnvelopeRecord {
  const id = "ow_jobfile000-0000-4000-8000-000000000001";
  const now = "2026-08-21T12:00:00.000Z";
  return {
    envelope_id: id,
    source: "website",
    contact_name: "Sep1 File Index",
    contact_phone: "+15875550108",
    contact_email: "sep1-files@example.invalid",
    job_ref: "26-0108",
    payload_json: JSON.stringify({
      address: "108 File Index Way",
      city: "Edmonton",
      province: "AB",
      postal_code: "T5J 0N3",
      service: "metal roof",
    }),
    raw_key: `raw/job-files/${id}.json`,
    ts: now,
    status: "pending_jn_push",
    dedup_key: "e:sep1-files@example.invalid",
    dup_of: null,
    attempts: 0,
    last_error: null,
    jn_contact_id: null,
    jn_job_id: null,
    intent_queue: "residential_sales",
    created_at: now,
    updated_at: now,
  };
}

function env(db: TestD1) {
  return {
    DB: db as never,
    APP_TENANT_ID: "ironwrap",
    ERPNEXT_ENABLED: "false",
    OPERATING_AUTOMATION_USER: "worker@example.invalid",
  };
}

function seedEnvelope(db: TestD1, rec: EnvelopeRecord): void {
  db.raw.prepare(
    `INSERT INTO envelopes (
       envelope_id, source, contact_name, contact_phone, contact_email, job_ref, payload_json,
       raw_key, ts, status, dedup_key, dup_of, attempts, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    rec.envelope_id, rec.source, rec.contact_name, rec.contact_phone, rec.contact_email,
    rec.job_ref, rec.payload_json, rec.raw_key, rec.ts, rec.status, rec.dedup_key, rec.dup_of,
    rec.created_at, rec.updated_at,
  );
}

test("job-file index records a Drive/R2 pointer against the operating roof job", async () => {
  const db = new TestD1();
  const rec = envelope();
  seedEnvelope(db, rec);
  const core = await materializeOperatingCore(env(db) as never, rec);

  const missingPointer = await recordOperatingJobFile(env(db), {
    tenantId: "ironwrap",
    roofJobId: core.roofJobId,
    artifactKind: "archive",
    artifactId: "archive_missing_pointer_1",
    createdAt: "2026-08-21T12:00:00.000Z",
  });
  assert.equal(missingPointer, "skipped_invalid");

  const input = {
    tenantId: "ironwrap",
    roofJobId: core.roofJobId,
    artifactKind: "photo",
    artifactId: "photo_jobfile_0001",
    driveFolderId: "drivefld0108aaaa",
    driveFileId: "drivefile0108aaaa",
    r2Key: "photos/v1/ironwrap/photo_jobfile_0001.jpg",
    contentSha256: "a".repeat(64),
    idempotencyKey: "photo:26-0108:1",
    createdAt: "2026-08-21T12:00:00.000Z",
  } as const;
  const first = await recordOperatingJobFile(env(db), input);
  assert.equal(first, "recorded");
  const replay = await recordOperatingJobFile(env(db), input);
  assert.equal(replay, "replayed");
  const count = db.raw.prepare("SELECT COUNT(*) AS n FROM operating_job_file_index").get() as { n: number };
  assert.equal(count.n, 1);
});

test("job-file index refuses a write without a matching roof job and stays append-only", async () => {
  const db = new TestD1();
  const missing = await recordOperatingJobFile(env(db), {
    tenantId: "ironwrap",
    roofJobId: "roofjob_missing_0001",
    artifactKind: "measurement",
    artifactId: "measurement_missing_1",
    r2Key: "measurements/missing/job-pointer.json",
    createdAt: "2026-08-21T12:00:00.000Z",
  });
  assert.equal(missing, "skipped_no_job");
  assert.equal(
    await recordOperatingJobFileBestEffort(env(db), {
      tenantId: "not a tenant",
      roofJobId: "x",
      artifactKind: "photo",
      artifactId: "short",
    }),
    "skipped_invalid",
  );
});

test("job-file index rejects idempotency and artifact collisions instead of replaying drift", async () => {
  const db = new TestD1();
  const rec = envelope();
  seedEnvelope(db, rec);
  const core = await materializeOperatingCore(env(db) as never, rec);
  const first = await recordOperatingJobFile(env(db), {
    tenantId: "ironwrap",
    roofJobId: core.roofJobId,
    artifactKind: "photo",
    artifactId: "photo_collision_0001",
    driveFolderId: "drivefld0108aaaa",
    driveFileId: "drivefile0108aaaa",
    r2Key: "photos/v1/ironwrap/photo_collision_0001.jpg",
    contentSha256: "b".repeat(64),
    idempotencyKey: "photo:collision:1",
    createdAt: "2026-08-21T12:00:00.000Z",
  });
  assert.equal(first, "recorded");

  const idempotencyDrift = await recordOperatingJobFile(env(db), {
    tenantId: "ironwrap",
    roofJobId: core.roofJobId,
    artifactKind: "photo",
    artifactId: "photo_collision_0002",
    r2Key: "photos/v1/ironwrap/photo_collision_0002.jpg",
    contentSha256: "c".repeat(64),
    idempotencyKey: "photo:collision:1",
    createdAt: "2026-08-21T12:01:00.000Z",
  });
  assert.equal(idempotencyDrift, "conflict");

  const artifactDrift = await recordOperatingJobFile(env(db), {
    tenantId: "ironwrap",
    roofJobId: "different_roof_job_0001",
    artifactKind: "photo",
    artifactId: "photo_collision_0001",
    driveFolderId: "drivefld0108aaaa",
    driveFileId: "drivefile0108aaaa",
    r2Key: "photos/v1/ironwrap/photo_collision_0001.jpg",
    contentSha256: "d".repeat(64),
    idempotencyKey: "photo:collision:2",
    createdAt: "2026-08-21T12:01:00.000Z",
  });
  assert.equal(artifactDrift, "conflict");
  assert.equal(
    (db.raw.prepare("SELECT COUNT(*) AS n FROM operating_job_file_index").get() as { n: number }).n,
    1,
  );
});
