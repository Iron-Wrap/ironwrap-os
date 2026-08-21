// Unit tests for the Jobsite-photo intake (node --test, type-stripped — no install).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { handlePhotoIngest, parsePhotoSubmission, photoFileName } from "../src/photos.ts";
import { jobFolderName, safeSegment } from "../src/google.ts";
import { isVoiceNoteUri } from "../src/core.ts";

test("parsePhotoSubmission: normalized shape", () => {
  const s = parsePhotoSubmission({
    job_number: "JN-1234",
    photos: ["https://x.com/a.jpg", "https://x.com/b.png"],
    caption: "north wall",
  });
  assert.equal(s.jobNumber, "JN-1234");
  assert.deepEqual(s.photos, ["https://x.com/a.jpg", "https://x.com/b.png"]);
  assert.equal(s.caption, "north wall");
});

test("parsePhotoSubmission: Jotform-ish aliases + URL-scan fallback + numeric job", () => {
  const s = parsePhotoSubmission({
    jobnimbus_job: 5512,                                  // number coerced to string
    q5_upload: "https://www.jotform.com/uploads/u/f/s/IMG_1.heic", // found by fallback scan
    notes: "leak at valley",
  });
  assert.equal(s.jobNumber, "5512");
  assert.deepEqual(s.photos, ["https://www.jotform.com/uploads/u/f/s/IMG_1.heic"]);
  assert.equal(s.caption, "leak at valley");
});

test("parsePhotoSubmission: keyed photos win; no stray non-file URLs; deduped", () => {
  const s = parsePhotoSubmission({
    job: "J9",
    website: "https://ironwrap.com",                      // ignored (photos found via keyed pass)
    photos: ["https://x/a.jpg", "https://x/a.jpg"],       // dup collapses
  });
  assert.deepEqual(s.photos, ["https://x/a.jpg"]);
});

test("parsePhotoSubmission: missing job number / no photos", () => {
  assert.equal(parsePhotoSubmission({ photos: ["https://x/a.jpg"] }).jobNumber, null);
  assert.deepEqual(parsePhotoSubmission({ job_number: "J1" }).photos, []);
});

test("parsePhotoSubmission: field voice notes and transcripts (gate 9)", () => {
  const s = parsePhotoSubmission({
    job_number: "J9",
    voice_note: "https://www.jotform.com/uploads/u/f/s/note.m4a",
    transcript: "valley flashing installed, need more screws tomorrow",
  });
  assert.deepEqual(s.photos, ["https://www.jotform.com/uploads/u/f/s/note.m4a"]);
  assert.equal(s.caption, "valley flashing installed, need more screws tomorrow");

  // Audio URL found by the fallback scan when no keyed match exists.
  const fallback = parsePhotoSubmission({ job: "J9", q9_misc: "https://x/files/memo.mp3" });
  assert.deepEqual(fallback.photos, ["https://x/files/memo.mp3"]);

  assert.equal(isVoiceNoteUri("https://x/uploads/note.m4a?t=1"), true);
  assert.equal(isVoiceNoteUri("https://x/uploads/roof.jpg"), false);
});

test("photoFileName: extension from URL, then content-type, then jpg default", () => {
  assert.equal(photoFileName("JN-1", 0, "https://x/IMG.JPG?t=1", "image/jpeg"), "JN-1-photo-01.jpg");
  assert.equal(photoFileName("JN-1", 9, "https://x/no-ext", "image/png"), "JN-1-photo-10.png");
  assert.equal(photoFileName("JN-1", 0, "https://x/no-ext", ""), "JN-1-photo-01.jpg");
});

test("safeSegment + jobFolderName", () => {
  assert.equal(safeSegment("JN/12\\34"), "JN_12_34");                     // slashes sanitized (Drive names)
  assert.equal(jobFolderName("1008", "John Smith", "IW"), "1008 John Smith (IW)");
  assert.equal(jobFolderName("1008"), "1008");                            // number-only fallback
  assert.equal(jobFolderName("1008", null, "iroof"), "1008 (iroof)");     // brand without customer
});

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    for (const migration of [
      "0001_init.sql",
      "0009_replay_approval_audit.sql",
      "0090_operating_core.sql",
      "0104_native_photo_evidence_authority.sql",
    ]) {
      this.raw.exec(
        readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"),
      );
    }
    seedNativeRoofJob(this.raw, { tenantId: "ironwrap", jobNumber: "26-0001" });
  }

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => new SqliteStatement(this.raw, sql, args),
    };
  }
}

class SqliteStatement {
  private readonly db: DatabaseSync;
  private readonly sql: string;
  private readonly args: unknown[];

  constructor(db: DatabaseSync, sql: string, args: unknown[]) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }

  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.args) ?? null) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...this.args) as T[] };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const result = this.db.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(result.changes ?? 0) } };
  }
}

function seedNativeRoofJob(
  db: DatabaseSync,
  input: { tenantId: string; jobNumber: string },
): void {
  const suffix = input.jobNumber.replace(/[^A-Za-z0-9.-]/g, "-");
  const envelopeId = `ow.seed.${input.tenantId}.${suffix}`;
  const now = "2026-07-16T10:00:00.000Z";
  db.prepare(
    `INSERT INTO envelopes (
       envelope_id, source, contact_name, contact_email, job_ref, payload_json,
       ts, status, created_at, updated_at
     ) VALUES (?, 'manual', 'Photo fixture', ?, ?, '{}', ?, 'reconciled', ?, ?)`,
  ).run(envelopeId, `${suffix.toLowerCase()}@example.com`, input.jobNumber, now, now, now);
  db.prepare(
    `INSERT INTO operating_leads (
       lead_id, tenant_id, source_envelope_id, source, contact_name, contact_email,
       job_ref, lifecycle_status, created_at, updated_at
     ) VALUES (?, ?, ?, 'manual', 'Photo fixture', ?, ?, 'converted', ?, ?)`,
  ).run(`lead.${input.tenantId}.${suffix}`, input.tenantId, envelopeId,
    `${suffix.toLowerCase()}@example.com`, input.jobNumber, now, now);
  db.prepare(
    `INSERT INTO operating_customers (
       customer_id, tenant_id, source_envelope_id, display_name, contact_email,
       lifecycle_status, created_at, updated_at
     ) VALUES (?, ?, ?, 'Photo fixture', ?, 'active', ?, ?)`,
  ).run(`customer.${input.tenantId}.${suffix}`, input.tenantId, envelopeId,
    `${suffix.toLowerCase()}@example.com`, now, now);
  db.prepare(
    `INSERT INTO operating_roof_jobs (
       roof_job_id, tenant_id, lead_id, customer_id, source_envelope_id,
       job_number, service_type, job_status, current_gate_state, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'photo', 'in_progress', 'in_progress', ?, ?)`,
  ).run(
    `roof.${input.tenantId}.${suffix}`,
    input.tenantId,
    `lead.${input.tenantId}.${suffix}`,
    `customer.${input.tenantId}.${suffix}`,
    envelopeId,
    input.jobNumber,
    now,
    now,
  );
}

test("handlePhotoIngest: raw capture plus native photo evidence without Drive or ERPNext", async () => {
  const rawWrites: Array<{ key: string; body: string }> = [];
  const db = new SqliteD1();
  const env = {
    APP_TENANT_ID: "ironwrap",
    RAW: {
      put: async (key: string, body: string) => {
        rawWrites.push({ key, body });
      },
    },
    DB: db,
  };

  const res = await handlePhotoIngest(env as never, JSON.stringify({
    job_number: "26-0001",
    photos: ["https://jotform.example/uploads/a.jpg", "https://jotform.example/uploads/b.png"],
    caption: "north wall progress",
  }), "application/json");
  const body = await res.json() as {
    native_submission_id?: string;
    native_evidence_ids?: string[];
    native_association_status?: string;
    uploaded?: number;
    note?: string;
    error?: string;
  };

  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.uploaded, 0);
  assert.equal(body.native_association_status, "matched");
  assert.match(body.native_submission_id ?? "", /^psub_[0-9a-f]{64}$/);
  assert.equal(body.native_evidence_ids?.length, 2);
  assert.ok(body.native_evidence_ids?.every((id) => /^pevi_[0-9a-f]{64}$/.test(id)));
  assert.match(body.note ?? "", /drive_not_configured/);
  assert.equal(rawWrites.length, 1);
  assert.match(rawWrites[0].key, /^raw\/photos\/\d{4}-\d{2}-\d{2}\/ow_/);

  const submission = db.raw.prepare(
    `SELECT job_number, association_status, photo_count, caption FROM native_photo_evidence_submissions`,
  ).get() as { job_number: string; association_status: string; photo_count: number; caption: string };
  assert.equal(submission.job_number, "26-0001");
  assert.equal(submission.association_status, "matched");
  assert.equal(submission.photo_count, 2);
  assert.equal(submission.caption, "north wall progress");

  const items = db.raw.prepare(
    `SELECT source_uri, evidence_type FROM native_photo_evidence_items ORDER BY item_index`,
  ).all() as Array<{ source_uri: string; evidence_type: string }>;
  assert.equal(items.length, 2);
  assert.equal(items[0].source_uri, "https://jotform.example/uploads/a.jpg");
  assert.equal(items[0].evidence_type, "photo");
  assert.equal(items[1].source_uri, "https://jotform.example/uploads/b.png");

  const audits = db.raw.prepare(
    `SELECT automation, action, result FROM audit_log ORDER BY id`,
  ).all() as Array<{ automation: string; action: string; result: string }>;
  assert.ok(audits.some((row) => row.automation === "native_photo_evidence" && row.action === "matched"));
  assert.equal(
    audits.some((row) => row.automation === "erpnext_photo"),
    false,
  );
});

test("handlePhotoIngest: unknown job numbers stay native unmatched instead of writing Frappe", async () => {
  const db = new SqliteD1();
  const env = {
    APP_TENANT_ID: "ironwrap",
    RAW: { put: async () => {} },
    DB: db,
  };
  const res = await handlePhotoIngest(env as never, JSON.stringify({
    job_number: "missing-job",
    photos: ["https://jotform.example/uploads/a.jpg"],
  }), "application/json");
  const body = await res.json() as { native_association_status?: string };
  assert.equal(res.status, 200);
  assert.equal(body.native_association_status, "unmatched");
  const row = db.raw.prepare(
    `SELECT association_error, roof_job_id FROM native_photo_evidence_submissions`,
  ).get() as { association_error: string; roof_job_id: string | null };
  assert.equal(row.association_error, "job_not_found");
  assert.equal(row.roof_job_id, null);
});
