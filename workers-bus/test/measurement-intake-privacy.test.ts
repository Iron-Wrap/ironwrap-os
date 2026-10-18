import assert from "node:assert/strict";
import { test } from "node:test";
import { handleAuthenticatedRoute } from "../src/app-api.ts";
import { bytesHash } from "../src/job-measurement-report-store.ts";
import {
  OTHER_TENANT,
  SEED_TIME,
  TENANT,
  auth,
  request,
  setup,
} from "./pipeline-board-fixture.ts";

const BASE = "/api/v1/privacy/measurement-intakes";
const receiptId = (digit: string) => `measurement_${digit.repeat(64)}`;
const bytes = (text: string) => new TextEncoder().encode(text);

class Bucket {
  objects = new Map<string, Uint8Array>();
  failRead = false;

  async get(key: string) {
    if (this.failRead) throw Error("synthetic R2 outage");
    const value = this.objects.get(key);
    return value
      ? {
          size: value.byteLength,
          arrayBuffer: async () => value.slice().buffer,
        }
      : null;
  }
}

function fixture() {
  const f = setup();
  const bucket = new Bucket();
  f.env.RAW = bucket as never;
  const route = (path: string, actor = auth("owner"), method = "GET") =>
    handleAuthenticatedRoute(request(method, path), f.env, actor);
  return { ...f, bucket, route };
}

async function seedReceipt(
  f: ReturnType<typeof fixture>,
  digit: string,
  tenant: string | null,
  options: { report?: boolean; ocr?: boolean } = {},
) {
  const id = receiptId(digit);
  const raw = bytes(`{"measurement":"${digit}"}`);
  const rawHash = await bytesHash(raw);
  const rawKey = `raw/measurements/${rawHash}.json`;
  const report = bytes("%PDF-1.7\nShared synthetic report\n%%EOF");
  const reportHash = await bytesHash(report);
  const reportKey = `raw/measurement-reports/${reportHash}.bin`;
  const ocr = bytes('{"text":"synthetic roof report"}');
  const ocrHash = await bytesHash(ocr);
  const ocrKey = `raw/measurement-ocr/${id}/${reportHash}.json`;
  f.db.raw
    .prepare(
      `INSERT INTO measurement_intake_receipts
         (receipt_id, tenant_id, idempotency_key_hash, payload_hash, key_strategy,
          measurement_id, provider, job_number, raw_key, content_type, status,
          lease_token, lease_expires_at, attempts, created_at, updated_at,
          report_raw_key, report_sha256, report_content_type, ocr_status,
          ocr_result_key, ocr_result_sha256, drive_report_url)
       VALUES (?, ?, ?, ?, 'payload_hash', ?, 'RoofRuler', 'IW-1001', ?,
               'application/json', 'retryable_error', NULL, NULL, 1, ?, ?, ?, ?, ?,
               ?, ?, ?, 'https://drive.example.invalid/report')`,
    )
    .run(
      id,
      tenant,
      digit.repeat(64),
      rawHash,
      `measurement:${digit.repeat(64)}`,
      rawKey,
      SEED_TIME,
      SEED_TIME,
      options.report ? reportKey : null,
      options.report ? reportHash : null,
      options.report ? "application/pdf" : null,
      options.ocr ? "completed" : "not_requested",
      options.ocr ? ocrKey : null,
      options.ocr ? ocrHash : null,
    );
  f.bucket.objects.set(rawKey, raw);
  if (options.report) f.bucket.objects.set(reportKey, report);
  if (options.ocr) f.bucket.objects.set(ocrKey, ocr);
  return { id, rawKey, reportKey, ocrKey, reportHash };
}

test("owner inventory includes attributable intake and excludes other and unknown tenants", async () => {
  const f = fixture();
  try {
    const first = await seedReceipt(f, "a", TENANT, {
      report: true,
      ocr: true,
    });
    const second = await seedReceipt(f, "b", TENANT);
    const other = await seedReceipt(f, "c", OTHER_TENANT, { report: true });
    const unknown = await seedReceipt(f, "d", null, { report: true });

    const response = await f.route(`${BASE}?limit=1`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const page = (await response.json()) as {
      items: Array<{ receipt_id: string }>;
      next_before: string;
    };
    assert.deepEqual(
      page.items.map((item) => item.receipt_id),
      [second.id],
    );
    assert.equal(page.next_before, second.id);
    const next = await f.route(`${BASE}?limit=1&before=${page.next_before}`);
    assert.equal(next.status, 200);
    const nextPage = (await next.json()) as {
      items: Array<{ receipt_id: string }>;
      next_before: string | null;
    };
    assert.deepEqual(
      nextPage.items.map((item) => item.receipt_id),
      [first.id],
    );
    assert.equal(nextPage.next_before, null);
    for (const id of [other.id, unknown.id]) {
      const denied = await f.route(`${BASE}/${id}/audit`);
      assert.equal(denied.status, 404);
      assert.equal(denied.headers.get("cache-control"), "private, no-store");
    }
  } finally {
    f.db.close();
  }
});

test("intake audit verifies raw, fetched report and OCR bytes while keeping external references visible", async () => {
  const f = fixture();
  try {
    const row = await seedReceipt(f, "e", TENANT, { report: true, ocr: true });
    const read = async () => {
      const response = await f.route(`${BASE}/${row.id}/audit`);
      assert.equal(response.status, 200);
      return (await response.json()) as {
        raw: { object_status: string };
        report: { object_status: string };
        ocr: { object_status: string };
        external_copies: { drive_report_url: string };
      };
    };
    const intact = await read();
    assert.equal(intact.raw.object_status, "ok");
    assert.equal(intact.report.object_status, "ok");
    assert.equal(intact.ocr.object_status, "ok");
    assert.equal(
      intact.external_copies.drive_report_url,
      "https://drive.example.invalid/report",
    );

    f.bucket.objects.set(row.reportKey, bytes("different bytes"));
    assert.equal((await read()).report.object_status, "mismatch");
    f.bucket.objects.delete(row.reportKey);
    assert.equal((await read()).report.object_status, "missing");
    f.bucket.failRead = true;
    assert.equal((await read()).report.object_status, "unavailable");
  } finally {
    f.db.close();
  }
});

test("intake inventory requires the current owner and validates cursors", async () => {
  const f = fixture();
  try {
    await seedReceipt(f, "f", TENANT);
    assert.equal((await f.route(BASE, auth("sales"))).status, 403);
    assert.equal(
      (await f.route(BASE, auth("owner", OTHER_TENANT))).status,
      403,
    );
    for (const query of ["?limit=0", "?limit=51", "?before=bad", "?extra=1"]) {
      assert.equal((await f.route(`${BASE}${query}`)).status, 400);
    }
    f.db.raw
      .prepare(
        "UPDATE app_users SET access_role='sales' WHERE tenant_id=? AND user_id=?",
      )
      .run(TENANT, auth("owner").session.user_id);
    assert.equal((await f.route(BASE)).status, 403);
  } finally {
    f.db.close();
  }
});
