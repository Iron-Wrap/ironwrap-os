// Unit tests for Phase 3 pure logic (node --test, type-stripped — no install).
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { deriveMeasurementIntakeIdentity, parseMeasurementSubmission, reportExt } from "../src/measurements.ts";
import { pushMeasurementToErpNext } from "../src/erpnext.ts";
import { ROOF_GRAPH_SCHEMA_VERSION, type RoofGraphV1 } from "../src/roof-graph.ts";
import { handleQuickbooksWebhook, parseQbEvents, verifyIntuitSignature } from "../src/quickbooks.ts";

test("parseMeasurementSubmission: job + report + numeric measurements", () => {
  const m = parseMeasurementSubmission({
    job_number: "JN-9", report_url: "https://x/r.pdf",
    squares: 24, predominant_pitch: "6", waste_factor: 0.15, junk: "ignore",
  });
  assert.equal(m.jobNumber, "JN-9");
  assert.equal(m.reportUrl, "https://x/r.pdf");
  assert.deepEqual(m.measurements, { squares: 24, predominant_pitch: 6, waste_factor: 0.15 });
});

test("parseMeasurementSubmission: PDF-scan fallback when no report key", () => {
  const m = parseMeasurementSubmission({ job: "J1", attachment: "see https://x/report.pdf?token=1 now" });
  assert.equal(m.reportUrl, "https://x/report.pdf?token=1");
});

test("reportExt: from url, then content-type, then pdf default", () => {
  assert.equal(reportExt("https://x/r.PDF?t=1", "application/pdf"), "pdf");
  assert.equal(reportExt("https://x/noext", "application/pdf"), "pdf");
  assert.equal(reportExt("https://x/noext", ""), "pdf");
});

test("deriveMeasurementIntakeIdentity: provider identity wins over retry headers and remains opaque", async () => {
  const submission = { jobNumber: "26-0001", reportUrl: null, measurements: { squares: 24 } };
  const withHeader = await deriveMeasurementIntakeIdentity({
    rawText: '{"job_number":"26-0001","squares":24}',
    raw: { job_number: "26-0001", squares: 24 },
    submission,
    geometry: null,
    requestIdempotencyKey: "measurement-header-0001",
  });
  const changedBodySameHeader = await deriveMeasurementIntakeIdentity({
    rawText: '{"job_number":"26-0001","squares":25}',
    raw: { job_number: "26-0001", squares: 25 },
    submission: { ...submission, measurements: { squares: 25 } },
    geometry: null,
    requestIdempotencyKey: "measurement-header-0001",
  });
  const providerAttachment = await deriveMeasurementIntakeIdentity({
    rawText: '{"job_number":"26-0001","report_id":"provider-private-id"}',
    raw: { job_number: "26-0001", report_id: "provider-private-id" },
    submission,
    geometry: null,
    requestIdempotencyKey: "measurement-provider-retry-a",
  });
  const providerAttachmentRetry = await deriveMeasurementIntakeIdentity({
    rawText: '{"job_number":"26-0001","report_id":"provider-private-id"}',
    raw: { job_number: "26-0001", report_id: "provider-private-id" },
    submission,
    geometry: null,
    requestIdempotencyKey: "measurement-provider-retry-b",
  });

  assert.equal(withHeader.keyStrategy, "request_header");
  assert.equal(withHeader.idempotencyKeyHash, changedBodySameHeader.idempotencyKeyHash);
  assert.notEqual(withHeader.payloadHash, changedBodySameHeader.payloadHash);
  assert.equal(providerAttachment.keyStrategy, "provider_attachment");
  assert.equal(providerAttachment.idempotencyKeyHash, providerAttachmentRetry.idempotencyKeyHash);
  assert.doesNotMatch(JSON.stringify(providerAttachment), /provider-private-id/);
  assert.match(providerAttachment.rawKey, /^raw\/measurements\/[0-9a-f]{64}\.json$/);
});

test("pushMeasurementToErpNext: an unmatched report is unlinked and explicitly needs review", async (t) => {
  const fetches: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    fetches.push({ url, init: init ?? {} });
    if (url.includes("/api/resource/Roof%20Job?")) throw new Error("unmatched intake must not search with an empty job number");
    if (url.includes("/api/resource/Measurement%20Report?")) return json({ data: [] });
    if (url.endsWith("/api/resource/Measurement%20Report")) return json({ data: { name: "MR-UNMATCHED" } });
    if (url.includes("/api/resource/Evidence%20Item?")) return json({ data: [] });
    if (url.endsWith("/api/resource/Evidence%20Item")) return json({ data: { name: "EV-UNMATCHED" } });
    throw new Error(`unexpected fetch ${url}`);
  });

  const rawSha256 = "b".repeat(64);
  const roofGraph: RoofGraphV1 = {
    schema_version: ROOF_GRAPH_SCHEMA_VERSION,
    revision: rawSha256,
    source: {
      raw_key: `raw/measurements/${rawSha256}.json`,
      raw_sha256: rawSha256,
      provider: "AppliCad",
      ingested_at: "2026-07-16T10:00:00.000Z",
      capture: { captured_at: null, provenance: "not_supplied" },
    },
    coordinate_system: { kind: "local_3d", crs: null, transform: null, provenance: "not_declared_by_source" },
    points: [{ id: "P1", x: 0, y: 0, z: 0 }],
    edges: [],
    facets: [],
    checks: [],
    needs_review: false,
    measurements: { squares: 24 },
    source_refs: { squares: "raw" },
  };
  const result = await pushMeasurementToErpNext({
    ERPNEXT_ENABLED: "true",
    ERPNEXT_BASE_URL: "https://erp.example.com",
    ERPNEXT_API_KEY: "erp-key",
    ERPNEXT_API_SECRET: "erp-secret",
  } as never, {
    measurementId: `measurement:${"a".repeat(64)}`,
    jobNumber: null,
    reportUrl: null,
    rawKey: `raw/measurements/${rawSha256}.json`,
    parsedAt: "2026-07-16T10:00:00.000Z",
    measurements: { squares: 24 },
    roofGraph,
  });

  assert.equal(result?.name, "MR-UNMATCHED");
  assert.equal(result?.evidenceItemName, "EV-UNMATCHED");
  assert.equal(result?.roofJobMatched, false);
  const report = JSON.parse(String(fetches.find((f) => f.url.endsWith("/api/resource/Measurement%20Report"))?.init.body));
  assert.equal(report.review_status, "Needs Review");
  assert.equal(report.roof_graph_revision, rawSha256);
  assert.deepEqual(JSON.parse(report.roof_graph_json), roofGraph);
  assert.equal("roof_job" in report, false);
  const evidence = JSON.parse(String(fetches.find((f) => f.url.endsWith("/api/resource/Evidence%20Item"))?.init.body));
  assert.equal("roof_job" in evidence, false);
  assert.equal(evidence.evidence_type, "Measurement Report");
});

test("parseQbEvents: flattens entity changes; tolerates junk", () => {
  const ev = parseQbEvents({
    eventNotifications: [{
      realmId: "R1",
      dataChangeEvent: { entities: [
        { name: "Invoice", id: "42", operation: "Update" },
        { name: "Payment", id: "7", operation: "Create" },
      ] },
    }],
  });
  assert.equal(ev.length, 2);
  assert.deepEqual(ev[0], { realmId: "R1", type: "Invoice", id: "42", operation: "Update" });
  assert.deepEqual(parseQbEvents({}), []);
  assert.deepEqual(parseQbEvents(null), []);
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

test("verifyIntuitSignature: accepts a correct HMAC, rejects wrong/empty", async () => {
  const token = "verifier-123", body = '{"eventNotifications":[]}';
  const sig = crypto.createHmac("sha256", token).update(body).digest("base64"); // independent of the module
  assert.equal(await verifyIntuitSignature(token, body, sig), true);
  assert.equal(await verifyIntuitSignature(token, body, "wrong-signature"), false);
  assert.equal(await verifyIntuitSignature("", body, sig), false);
});

test("handleQuickbooksWebhook: signed event creates ERPNext Payment Milestone rows", async (t) => {
  const fetches: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    fetches.push({ url, init: init ?? {} });
    if (url.includes("/api/resource/Roof%20Job?")) return json({ data: [{ name: "RJ-0001" }] });
    if (url.includes("/api/resource/Payment%20Milestone?")) return json({ data: [] });
    if (url.endsWith("/api/resource/Payment%20Milestone")) {
      return json({ data: { name: `PM-000${fetches.filter((f) => f.url.endsWith("/api/resource/Payment%20Milestone")).length}` } });
    }
    throw new Error(`unexpected fetch ${url}`);
  });

  const writes: Array<{ sql: string; args: unknown[] }> = [];
  const rawWrites: Array<{ key: string; body: string }> = [];
  const receipts = new Map<string, Record<string, unknown>>();
  const env = {
    QB_WEBHOOK_TOKEN: "verifier-123",
    ERPNEXT_ENABLED: "true",
    ERPNEXT_BASE_URL: "https://erp.example.com",
    ERPNEXT_API_KEY: "erp-key",
    ERPNEXT_API_SECRET: "erp-secret",
    RAW: { put: async (key: string, body: string) => { rawWrites.push({ key, body }); } },
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              first: async () => {
                if (sql.includes("FROM quickbooks_webhook_receipts")) {
                  return receipts.get(String(args[0])) ?? null;
                }
                return null;
              },
              run: async () => {
                writes.push({ sql, args });
                if (sql.includes("INSERT INTO quickbooks_webhook_receipts")) {
                  receipts.set(String(args[0]), {
                    payload_hash: args[0],
                    first_seen_at: args[1],
                    last_seen_at: args[2],
                    envelope_id: args[3],
                    raw_key: args[4],
                    events_count: args[5],
                    replay_count: 0,
                  });
                }
                if (sql.includes("UPDATE quickbooks_webhook_receipts")) {
                  const receipt = receipts.get(String(args[1]));
                  if (receipt) {
                    receipt.last_seen_at = args[0];
                    receipt.replay_count = Number(receipt.replay_count ?? 0) + 1;
                  }
                }
                return { success: true };
              },
            };
          },
        };
      },
    },
  };
  const bodyText = JSON.stringify({
    eventNotifications: [{
      realmId: "R1",
      dataChangeEvent: { entities: [
        { name: "Invoice", id: "42", operation: "Update" },
        { name: "Payment", id: "7", operation: "Create" },
      ] },
    }],
  });
  const sig = crypto.createHmac("sha256", env.QB_WEBHOOK_TOKEN).update(bodyText).digest("base64");

  const res = await handleQuickbooksWebhook(env as never, bodyText, sig);
  const result = await res.json() as {
    events?: number;
    erpnext_payment_milestone_ids?: string[];
    erpnext_error?: string | null;
  };

  assert.equal(res.status, 200);
  assert.equal(result.events, 2);
  assert.deepEqual(result.erpnext_payment_milestone_ids, ["PM-0001", "PM-0002"]);
  assert.equal(result.erpnext_error, null);
  assert.equal(rawWrites.length, 1);
  assert.match(rawWrites[0].key, /^raw\/quickbooks\/\d{4}-\d{2}-\d{2}\/ow_/);

  const posted = fetches
    .filter((f) => f.url.endsWith("/api/resource/Payment%20Milestone"))
    .map((f) => JSON.parse(String(f.init.body)));
  assert.equal(posted.length, 2);
  assert.deepEqual(posted.map((p) => p.payment_milestone_id), ["qb:R1:Invoice:42", "qb:R1:Payment:7"]);
  assert.equal(posted[0].roof_job, "RJ-0001");
  assert.equal(posted[0].milestone_type, "Invoice");
  assert.equal(posted[0].status, "Webhook Seen");
  assert.equal(posted[0].raw_key, rawWrites[0].key);
  assert.equal(posted[1].milestone_type, "Payment");
  assert.equal(posted[1].roof_job, undefined);
  assert.ok(writes.some((w) => w.sql.includes("INSERT INTO audit_log") &&
    w.args.includes("erpnext_quickbooks") && w.args.includes("payment_milestone:PM-0001")));

  const replay = await handleQuickbooksWebhook(env as never, bodyText, sig);
  const replayBody = await replay.json() as { replay?: boolean; envelope_id?: string; events?: number };

  assert.equal(replay.status, 200);
  assert.equal(replayBody.replay, true);
  assert.equal(replayBody.events, 2);
  assert.equal(rawWrites.length, 1);
  assert.equal(fetches.filter((f) => f.url.endsWith("/api/resource/Payment%20Milestone")).length, 2);
  assert.ok(writes.some((w) => w.sql.includes("UPDATE quickbooks_webhook_receipts")));
  assert.ok(writes.some((w) => w.sql.includes("INSERT INTO audit_log") &&
    w.args.includes("webhook_replay")));
});
