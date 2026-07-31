// Unit tests for Phase 3 pure logic (node --test, type-stripped — no install).
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { deriveMeasurementIntakeIdentity, parseMeasurementSubmission, reportExt } from "../src/measurements.ts";
import { pushMeasurementToErpNext, pushQuickBooksEventToErpNext } from "../src/erpnext.ts";
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

test("parseQbEvents: keeps only supported QuickBooks finance identities", () => {
  const ev = parseQbEvents({
    eventNotifications: [{
      realmId: "1234567890",
      dataChangeEvent: { entities: [
        { name: "Invoice", id: "42", operation: "Update" },
        { name: "Payment", id: "7", operation: "Create" },
        { name: "CreditMemo", id: "8", operation: "Delete" },
        { name: "RefundReceipt", id: "9", operation: "Void" },
        { name: "Vendor", id: "10", operation: "Update" },
        { name: "Invoice", id: "", operation: "Update" },
        { name: "Invoice", id: "11", operation: "Merge" },
      ] },
    }],
  });
  assert.equal(ev.length, 4);
  assert.deepEqual(ev[0], { realmId: "1234567890", type: "Invoice", id: "42", operation: "Update" });
  assert.deepEqual(ev.map((event) => event.type), ["Invoice", "Payment", "CreditMemo", "RefundReceipt"]);
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

test("handleQuickbooksWebhook: raw finance identities open Pending reconciliation work without provider-truth claims", async (t) => {
  const fetches: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    fetches.push({ url, init: init ?? {} });
    if (url.includes("/api/resource/Roof%20Job?")) return json({ data: [{ name: "RJ-0001" }] });
    if (url.includes("/api/resource/Integration%20Reconciliation?")) return json({ data: [] });
    if (url.endsWith("/api/resource/Integration%20Reconciliation")) {
      const body = JSON.parse(String(init?.body));
      return json({ data: { name: body.reconciliation_id } });
    }
    if (url.includes("/api/resource/Payment%20Milestone?")) return json({ data: [] });
    if (url.endsWith("/api/resource/Payment%20Milestone")) {
      const body = JSON.parse(String(init?.body));
      return json({ data: { name: body.payment_milestone_id } });
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
                if (sql.includes("FROM quickbooks_webhook_receipts")) return receipts.get(String(args[0])) ?? null;
                return null;
              },
              run: async () => {
                writes.push({ sql, args });
                if (sql.includes("INSERT INTO quickbooks_webhook_receipts")) {
                  receipts.set(String(args[0]), {
                    payload_hash: args[0], first_seen_at: args[1], last_seen_at: args[2], envelope_id: args[3],
                    raw_key: args[4], events_count: args[5], replay_count: 0,
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
      realmId: "1234567890",
      dataChangeEvent: { entities: [
        { name: "Invoice", id: "42", operation: "Update" },
        { name: "Payment", id: "7", operation: "Create", TotalAmt: 999999, status: "Paid" },
        { name: "CreditMemo", id: "8", operation: "Delete" },
        { name: "RefundReceipt", id: "9", operation: "Void" },
      ] },
    }],
  });
  const sig = crypto.createHmac("sha256", env.QB_WEBHOOK_TOKEN).update(bodyText).digest("base64");

  const res = await handleQuickbooksWebhook(env as never, bodyText, sig);
  const result = await res.json() as {
    events?: number;
    erpnext_payment_milestone_ids?: string[];
    erpnext_reconciliation_ids?: string[];
    unresolved_reconciliation_ids?: string[];
    provider_truth_reconciled?: boolean;
    erpnext_error?: string | null;
  };

  assert.equal(res.status, 200);
  assert.equal(result.events, 4);
  assert.deepEqual(result.erpnext_payment_milestone_ids, ["qb:1234567890:Invoice:42"]);
  assert.equal(result.erpnext_reconciliation_ids?.length, 4);
  assert.equal(result.unresolved_reconciliation_ids?.length, 3);
  assert.equal(result.provider_truth_reconciled, false);
  assert.equal(result.erpnext_error, null);
  assert.equal(rawWrites.length, 1);
  assert.match(rawWrites[0].key, /^raw\/quickbooks\/\d{4}-\d{2}-\d{2}\/ow_/);

  const posted = fetches
    .filter((f) => f.url.endsWith("/api/resource/Payment%20Milestone"))
    .map((f) => JSON.parse(String(f.init.body)));
  assert.equal(posted.length, 1);
  assert.deepEqual(posted.map((p) => p.payment_milestone_id), ["qb:1234567890:Invoice:42"]);
  assert.equal(posted[0].roof_job, "RJ-0001");
  assert.equal(posted[0].milestone_type, "Invoice");
  assert.equal(posted[0].status, "Webhook Seen");
  assert.equal(posted[0].raw_key, rawWrites[0].key);
  assert.match(posted[0].raw_payload_hash, /^[a-f0-9]{64}$/);
  for (const field of ["payment_status", "truth_source", "truth_at", "subtotal", "tax_amount", "total_amount", "amount_due", "amount_paid", "balance_due"]) {
    assert.equal(field in posted[0], false, `${field} must not be inferred from a webhook`);
  }

  const reconciliations = fetches
    .filter((f) => f.url.endsWith("/api/resource/Integration%20Reconciliation"))
    .map((f) => JSON.parse(String(f.init.body)));
  assert.equal(reconciliations.length, 4);
  assert.deepEqual(reconciliations.map((row) => row.entity_type), ["Invoice", "Payment", "CreditMemo", "RefundReceipt"]);
  assert.ok(reconciliations.every((row) => row.status === "Pending"));
  assert.ok(reconciliations.every((row) => /^[a-f0-9]{64}$/.test(row.source_payload_hash)));
  assert.ok(reconciliations.every((row) => /^[a-f0-9]{64}$/.test(row.local_payload_hash) && row.source_payload_hash !== row.local_payload_hash));
  assert.equal(reconciliations[0].roof_job, "RJ-0001");
  assert.equal(reconciliations[0].local_doctype, "Payment Milestone");
  assert.equal(reconciliations[0].local_name, "qb:1234567890:Invoice:42");
  assert.equal(reconciliations[0].raw_key, rawWrites[0].key);
  for (const row of reconciliations.slice(1)) {
    assert.equal("roof_job" in row, false);
    assert.equal(row.local_doctype, "Unresolved QuickBooks Event");
  }
  assert.ok(writes.some((w) => w.sql.includes("INSERT INTO audit_log") &&
    w.args.includes("erpnext_quickbooks") && w.args.some((arg) => String(arg).startsWith("integration_reconciliation:qbr:"))));

  const replay = await handleQuickbooksWebhook(env as never, bodyText, sig);
  const replayBody = await replay.json() as { replay?: boolean; envelope_id?: string; events?: number; provider_truth_reconciled?: boolean };

  assert.equal(replay.status, 200);
  assert.equal(replayBody.replay, true);
  assert.equal(replayBody.events, 4);
  assert.equal(replayBody.provider_truth_reconciled, false);
  assert.equal(rawWrites.length, 1);
  assert.equal(fetches.filter((f) => f.url.endsWith("/api/resource/Payment%20Milestone")).length, 1);
  assert.equal(fetches.filter((f) => f.url.endsWith("/api/resource/Integration%20Reconciliation")).length, 4);
  assert.ok(writes.some((w) => w.sql.includes("UPDATE quickbooks_webhook_receipts")));
  assert.ok(writes.some((w) => w.sql.includes("INSERT INTO audit_log") && w.args.includes("webhook_replay")));
});

test("pushQuickBooksEventToErpNext: rejects a tampered reconciliation receipt without mutation", async (t) => {
  const fetches: Array<{ url: string; init: RequestInit }> = [];
  const payloadHash = "a".repeat(64);
  const reconciliationId = `qbr:${payloadHash}:0`;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    fetches.push({ url, init: init ?? {} });
    if (url.includes("/api/resource/Roof%20Job?")) return json({ data: [] });
    if (url.includes("/api/resource/Integration%20Reconciliation?")) return json({ data: [{ name: reconciliationId }] });
    if (url.endsWith(`/api/resource/Integration%20Reconciliation/${encodeURIComponent(reconciliationId)}`)) {
      return json({ data: {
        name: reconciliationId, status: "Pending", reconciliation_id: reconciliationId,
        system_name: "QuickBooks", entity_type: "Invoice", external_entity_id: "42",
        local_doctype: "Unresolved QuickBooks Event", local_name: reconciliationId, direction: "Inbound",
        raw_key: "raw/quickbooks/2026-07-31/ow_test.json", source_version: "Update",
        source_payload_hash: "b".repeat(64), local_payload_hash: "c".repeat(64),
      } });
    }
    throw new Error(`unexpected fetch ${url}`);
  });

  await assert.rejects(
    pushQuickBooksEventToErpNext({
      ERPNEXT_ENABLED: "true", ERPNEXT_BASE_URL: "https://erp.example.com", ERPNEXT_API_KEY: "erp-key", ERPNEXT_API_SECRET: "erp-secret",
    } as never, {
      realmId: "1234567890", type: "Invoice", id: "42", operation: "Update",
      rawKey: "raw/quickbooks/2026-07-31/ow_test.json", eventTs: "2026-07-31T12:00:00.000Z", payloadHash, eventIndex: 0,
    }),
    /erpnext_quickbooks_reconciliation_conflict/,
  );
  assert.equal(fetches.some((request) => request.init.method === "POST" || request.init.method === "PUT"), false);
});
