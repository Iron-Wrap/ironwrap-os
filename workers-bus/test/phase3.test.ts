// Unit tests for Phase 3 pure logic (node --test, type-stripped — no install).
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { deriveMeasurementIntakeIdentity, parseMeasurementSubmission, reportExt } from "../src/measurements.ts";
import { pushMeasurementToErpNext, pushQuickBooksEventToErpNext } from "../src/erpnext.ts";
import { ROOF_GRAPH_SCHEMA_VERSION, type RoofGraphV1 } from "../src/roof-graph.ts";
import {
  handleQuickbooksWebhook,
  parseQbEvents,
  recoverDueQuickBooksProjections,
  verifyIntuitSignature,
} from "../src/quickbooks.ts";
import * as store from "../src/store.ts";

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

function makeQuickBooksWebhookEnv(options: {
  expectedRealmId?: string;
  erpEnabled?: string;
} = {}) {
  const writes: Array<{ sql: string; args: unknown[] }> = [];
  const rawWrites: Array<{ key: string; body: string }> = [];
  const receipts = new Map<string, Record<string, unknown>>();
  const outbox = new Map<string, Record<string, unknown>>();
  const outboxKey = (payloadHash: unknown, eventIndex: unknown) => `${String(payloadHash)}:${String(eventIndex)}`;
  const env = {
    QB_WEBHOOK_TOKEN: "verifier-123",
    QB_EXPECTED_REALM_ID: options.expectedRealmId ?? "1234567890",
    ERPNEXT_ENABLED: options.erpEnabled ?? "true",
    ERPNEXT_BASE_URL: "https://erp.example.com",
    ERPNEXT_API_KEY: "erp-key",
    ERPNEXT_API_SECRET: "erp-secret",
    QB_RECONCILIATION_ISSUER_USER: "quickbooks-issuer@ironwrapexteriors.com",
    QB_RECONCILIATION_ISSUER_API_KEY: "qb-issuer-key",
    QB_RECONCILIATION_ISSUER_API_SECRET: "qb-issuer-secret",
    RAW: { put: async (key: string, body: string) => { rawWrites.push({ key, body }); } },
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              first: async () => {
                if (sql.includes("FROM quickbooks_webhook_receipts")) return receipts.get(String(args[0])) ?? null;
                if (sql.includes("COUNT(*) AS pending_count")) {
                  return { pending_count: [...outbox.values()].filter((row) =>
                    row.payload_hash === args[0] && row.projection_status === "pending").length };
                }
                return null;
              },
              all: async () => {
                if (sql.includes("FROM quickbooks_projection_outbox")) {
                  const receiptScoped = sql.includes("WHERE payload_hash = ?");
                  const now = String(args[receiptScoped ? 1 : 0]);
                  const rows = [...outbox.values()].filter((row) =>
                    (!receiptScoped || row.payload_hash === args[0]) &&
                    row.projection_status === "pending" &&
                    String(row.next_attempt_at) <= now &&
                    (!row.lease_expires_at || String(row.lease_expires_at) <= now));
                  const limit = receiptScoped ? undefined : Number(args[2]);
                  return { results: limit === undefined ? rows : rows.slice(0, limit) };
                }
                return { results: [] };
              },
              run: async () => {
                writes.push({ sql, args });
                if (sql.includes("INSERT INTO quickbooks_webhook_receipts")) {
                  receipts.set(String(args[0]), {
                    payload_hash: args[0], first_seen_at: args[1], last_seen_at: args[2], envelope_id: args[3],
                    raw_key: args[4], events_count: args[5], replay_count: 0,
                  });
                }
                if (sql.includes("INSERT INTO quickbooks_projection_outbox")) {
                  outbox.set(outboxKey(args[0], args[1]), {
                    payload_hash: args[0], event_index: args[1], realm_id: args[2], entity_type: args[3],
                    entity_id: args[4], operation: args[5], projection_status: args[6], attempt_count: 0,
                    last_error: null, last_attempt_at: null, next_attempt_at: args[7], escalated_at: null,
                    lease_token: null, lease_expires_at: null, projected_at: null,
                    created_at: args[8], updated_at: args[9],
                  });
                }
                if (sql.includes("UPDATE quickbooks_webhook_receipts")) {
                  const receipt = receipts.get(String(args[1]));
                  if (receipt) {
                    receipt.last_seen_at = args[0];
                    receipt.replay_count = Number(receipt.replay_count ?? 0) + 1;
                  }
                }
                if (sql.includes("SET lease_token = ?") && sql.includes("quickbooks_projection_outbox")) {
                  const row = outbox.get(outboxKey(args[4], args[5]));
                  const dueAt = sql.includes("next_attempt_at <= ?") ? String(args[6]) : null;
                  const leaseAt = String(args[dueAt === null ? 6 : 7]);
                  if (!row || row.projection_status !== "pending" ||
                    (dueAt !== null && String(row.next_attempt_at) > dueAt) ||
                    (row.lease_expires_at && String(row.lease_expires_at) > leaseAt)) return { meta: { changes: 0 } };
                  row.lease_token = args[0];
                  row.lease_expires_at = args[1];
                  row.attempt_count = Number(row.attempt_count) + 1;
                  row.last_attempt_at = args[2];
                  row.last_error = null;
                  row.updated_at = args[3];
                  return { meta: { changes: 1 } };
                }
                if (sql.includes("SET projection_status = 'projected'")) {
                  const row = outbox.get(outboxKey(args[2], args[3]));
                  if (!row || row.projection_status !== "pending" || row.lease_token !== args[4]) return { meta: { changes: 0 } };
                  row.projection_status = "projected";
                  row.lease_token = null;
                  row.lease_expires_at = null;
                  row.last_error = null;
                  row.projected_at = args[0];
                  row.updated_at = args[1];
                  return { meta: { changes: 1 } };
                }
                if (sql.includes("SET projection_status = 'rejected'")) {
                  const row = outbox.get(outboxKey(args[2], args[3]));
                  if (!row || row.projection_status !== "pending" || row.lease_token !== args[4]) return { meta: { changes: 0 } };
                  row.projection_status = "rejected";
                  row.lease_token = null;
                  row.lease_expires_at = null;
                  row.last_error = args[0];
                  row.updated_at = args[1];
                  return { meta: { changes: 1 } };
                }
                if (sql.includes("SET lease_token = NULL") && sql.includes("last_error = ?")) {
                  const row = outbox.get(outboxKey(args[5], args[6]));
                  if (row && row.projection_status === "pending" && row.lease_token === args[7]) {
                    row.lease_token = null;
                    row.lease_expires_at = null;
                    row.last_error = args[0];
                    row.next_attempt_at = args[1];
                    if (args[2] === 1 && !row.escalated_at) row.escalated_at = args[3];
                    row.updated_at = args[4];
                  }
                }
                return { meta: { changes: 1 } };
              },
            };
          },
        };
      },
      batch: async (statements: Array<{ run: () => Promise<unknown> }>) => await Promise.all(statements.map((statement) => statement.run())),
    },
  };
  return { env, writes, rawWrites, receipts, outbox };
}

test("verifyIntuitSignature: accepts a correct HMAC, rejects wrong/empty", async () => {
  const token = "verifier-123", body = '{"eventNotifications":[]}';
  const sig = crypto.createHmac("sha256", token).update(body).digest("base64"); // independent of the module
  assert.equal(await verifyIntuitSignature(token, body, sig), true);
  assert.equal(await verifyIntuitSignature(token, body, "wrong-signature"), false);
  assert.equal(await verifyIntuitSignature("", body, sig), false);
});

test("QuickBooks projection claim repeats the due-time predicate for stale concurrent selections", async () => {
  const { env, outbox } = makeQuickBooksWebhookEnv();
  const payloadHash = "a".repeat(64);
  outbox.set(`${payloadHash}:0`, {
    payload_hash: payloadHash,
    event_index: 0,
    realm_id: "1234567890",
    entity_type: "Invoice",
    entity_id: "42",
    operation: "Update",
    projection_status: "pending",
    attempt_count: 1,
    last_error: "retryable",
    last_attempt_at: "2026-07-31T12:00:00.000Z",
    next_attempt_at: "2026-07-31T12:05:00.000Z",
    escalated_at: null,
    lease_token: null,
    lease_expires_at: null,
    projected_at: null,
    created_at: "2026-07-31T12:00:00.000Z",
    updated_at: "2026-07-31T12:00:00.000Z",
  });

  const claimed = await store.claimQuickBooksProjectionOutbox(
    env as never,
    { payload_hash: payloadHash, event_index: 0 },
    "lease-1",
    "2026-07-31T12:01:00.000Z",
    "2026-07-31T12:02:00.000Z",
  );

  assert.equal(claimed, false);
  assert.equal(outbox.get(`${payloadHash}:0`)?.attempt_count, 1);
});

test("handleQuickbooksWebhook: raw finance identities open Pending reconciliation work without provider-truth claims", async (t) => {
  const fetches: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    fetches.push({ url, init: init ?? {} });
    if (url.endsWith("/api/method/ironwrap_roofing.quickbooks_reconciliation_api.check_issuer_readiness")) {
      return json({ message: { ready: true, issuer: "quickbooks-issuer@ironwrapexteriors.com" } });
    }
    if (url.includes("/api/resource/Roof%20Job?")) return json({ data: [{ name: "RJ-0001" }] });
    if (url.endsWith("/api/method/ironwrap_roofing.quickbooks_reconciliation_api.issue_pending_reconciliation")) {
      const request = JSON.parse(String(init?.body));
      const body = JSON.parse(request.reconciliation_json);
      return json({ message: { name: body.reconciliation_id, idempotent_replay: false } });
    }
    if (url.includes("/api/resource/Payment%20Milestone?")) return json({ data: [] });
    if (url.endsWith("/api/resource/Payment%20Milestone")) {
      const body = JSON.parse(String(init?.body));
      return json({ data: { name: body.payment_milestone_id } });
    }
    throw new Error(`unexpected fetch ${url}`);
  });

  const { env, writes, rawWrites } = makeQuickBooksWebhookEnv();
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
    .filter((f) => f.url.endsWith("/api/method/ironwrap_roofing.quickbooks_reconciliation_api.issue_pending_reconciliation"))
    .map((f) => JSON.parse(JSON.parse(String(f.init.body)).reconciliation_json));
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
  const readiness = fetches.find((request) => request.url.endsWith("check_issuer_readiness"));
  assert.equal(readiness?.init.headers instanceof Headers ? readiness.init.headers.get("authorization") :
    (readiness?.init.headers as Record<string, string> | undefined)?.authorization,
  "token qb-issuer-key:qb-issuer-secret");
  const issuerCommand = fetches.find((request) => request.url.endsWith("issue_pending_reconciliation"));
  assert.equal(issuerCommand?.init.headers instanceof Headers ? issuerCommand.init.headers.get("authorization") :
    (issuerCommand?.init.headers as Record<string, string> | undefined)?.authorization,
  "token qb-issuer-key:qb-issuer-secret");

  const replay = await handleQuickbooksWebhook(env as never, bodyText, sig);
  const replayBody = await replay.json() as { replay?: boolean; envelope_id?: string; events?: number; provider_truth_reconciled?: boolean };

  assert.equal(replay.status, 200);
  assert.equal(replayBody.replay, true);
  assert.equal(replayBody.events, 4);
  assert.equal(replayBody.provider_truth_reconciled, false);
  assert.equal(rawWrites.length, 1);
  assert.equal(fetches.filter((f) => f.url.endsWith("/api/resource/Payment%20Milestone")).length, 1);
  assert.equal(fetches.filter((f) => f.url.endsWith("/api/method/ironwrap_roofing.quickbooks_reconciliation_api.issue_pending_reconciliation")).length, 4);
  assert.ok(writes.some((w) => w.sql.includes("UPDATE quickbooks_webhook_receipts")));
  assert.ok(writes.some((w) => w.sql.includes("INSERT INTO audit_log") && w.args.includes("webhook_replay")));
});

test("handleQuickbooksWebhook: a temporary ERP failure stays pending and redelivery resumes only unprojected events", async (t) => {
  const reconciliationPosts: Array<Record<string, unknown>> = [];
  let failCreditMemoOnce = true;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/method/ironwrap_roofing.quickbooks_reconciliation_api.check_issuer_readiness")) {
      return json({ message: { ready: true, issuer: "quickbooks-issuer@ironwrapexteriors.com" } });
    }
    if (url.includes("/api/resource/Payment%20Milestone?")) return json({ data: [] });
    if (url.endsWith("/api/method/ironwrap_roofing.quickbooks_reconciliation_api.issue_pending_reconciliation")) {
      const request = JSON.parse(String(init?.body));
      const body = JSON.parse(request.reconciliation_json) as Record<string, unknown>;
      reconciliationPosts.push(body);
      if (body.entity_type === "CreditMemo" && failCreditMemoOnce) {
        failCreditMemoOnce = false;
        return new Response("temporary Frappe outage", { status: 503 });
      }
      return json({ message: { name: body.reconciliation_id, idempotent_replay: false } });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  const { env, rawWrites, outbox } = makeQuickBooksWebhookEnv();
  const bodyText = JSON.stringify({
    eventNotifications: [{
      realmId: "1234567890",
      dataChangeEvent: { entities: [
        { name: "Payment", id: "7", operation: "Create" },
        { name: "CreditMemo", id: "8", operation: "Update" },
      ] },
    }],
  });
  const signature = crypto.createHmac("sha256", env.QB_WEBHOOK_TOKEN).update(bodyText).digest("base64");

  const first = await handleQuickbooksWebhook(env as never, bodyText, signature);
  assert.equal(first.status, 503);
  const firstBody = await first.json() as {
    error?: string; replay?: boolean; envelope_id?: string; events?: number; provider_truth_reconciled?: boolean;
  };
  assert.equal(firstBody.error, "quickbooks_projection_pending");
  assert.equal(firstBody.replay, false);
  assert.match(firstBody.envelope_id ?? "", /^ow_/);
  assert.equal(firstBody.events, 2);
  assert.equal(firstBody.provider_truth_reconciled, false);
  // `first.json()` consumes the body, so assert the durable state rather than
  // accepting a response-only signal.
  assert.deepEqual([...outbox.values()].map((row) => row.projection_status), ["projected", "pending"]);
  assert.deepEqual([...outbox.values()].map((row) => row.attempt_count), [1, 1]);
  assert.equal(rawWrites.length, 1);

  // A replay honors bounded backoff. Make this synthetic pending event due to
  // demonstrate that the next eligible delivery resumes only the missing work.
  const pending = [...outbox.values()].find((row) => row.projection_status === "pending");
  assert.ok(pending);
  pending.next_attempt_at = "1970-01-01T00:00:00.000Z";
  const replay = await handleQuickbooksWebhook(env as never, bodyText, signature);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json() as { replay?: boolean }).replay, true);
  assert.deepEqual([...outbox.values()].map((row) => row.projection_status), ["projected", "projected"]);
  assert.deepEqual([...outbox.values()].map((row) => row.attempt_count), [1, 2]);
  assert.equal(rawWrites.length, 1);
  assert.equal(reconciliationPosts.filter((body) => body.entity_type === "Payment").length, 1);
  assert.equal(reconciliationPosts.filter((body) => body.entity_type === "CreditMemo").length, 2);
});

test("handleQuickbooksWebhook: only the issuer's explicit stable 409 conflict is durably rejected", async (t) => {
  let reconciliationPosts = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/api/method/ironwrap_roofing.quickbooks_reconciliation_api.check_issuer_readiness")) {
      return json({ message: { ready: true, issuer: "quickbooks-issuer@ironwrapexteriors.com" } });
    }
    if (url.includes("/api/resource/Payment%20Milestone?")) return json({ data: [] });
    if (url.endsWith("/api/method/ironwrap_roofing.quickbooks_reconciliation_api.issue_pending_reconciliation")) {
      reconciliationPosts += 1;
      return new Response("quickbooks_reconciliation_identity_conflict", { status: 409 });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  const { env, outbox } = makeQuickBooksWebhookEnv();
  const bodyText = JSON.stringify({
    eventNotifications: [{
      realmId: "1234567890",
      dataChangeEvent: { entities: [{ name: "Payment", id: "7", operation: "Create" }] },
    }],
  });
  const signature = crypto.createHmac("sha256", env.QB_WEBHOOK_TOKEN).update(bodyText).digest("base64");

  const first = await handleQuickbooksWebhook(env as never, bodyText, signature);
  assert.equal(first.status, 200);
  assert.equal((await first.json() as { rejected_projection_count?: number }).rejected_projection_count, 1);
  assert.deepEqual([...outbox.values()].map((row) => row.projection_status), ["rejected"]);

  const replay = await handleQuickbooksWebhook(env as never, bodyText, signature);
  assert.equal(replay.status, 200);
  assert.equal(reconciliationPosts, 1);
});

test("handleQuickbooksWebhook: 401, 403, and 404 issuer drift remain pending and scheduled recovery succeeds without redelivery", async (t) => {
  let failureStatus = 403;
  let repaired = false;
  let issuerPosts = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/method/ironwrap_roofing.quickbooks_reconciliation_api.check_issuer_readiness")) {
      return json({ message: { ready: true, issuer: "quickbooks-issuer@ironwrapexteriors.com" } });
    }
    if (url.includes("/api/resource/Payment%20Milestone?")) return json({ data: [] });
    if (url.endsWith("/api/method/ironwrap_roofing.quickbooks_reconciliation_api.issue_pending_reconciliation")) {
      issuerPosts += 1;
      if (!repaired) return new Response("deployment_or_auth_drift", { status: failureStatus });
      const request = JSON.parse(String(init?.body));
      const body = JSON.parse(request.reconciliation_json) as { reconciliation_id: string };
      return json({ message: { name: body.reconciliation_id, idempotent_replay: false } });
    }
    throw new Error(`unexpected fetch ${url}`);
  });

  for (const status of [401, 403, 404]) {
    failureStatus = status;
    repaired = false;
    const { env, outbox } = makeQuickBooksWebhookEnv();
    const bodyText = JSON.stringify({
      eventNotifications: [{
        realmId: "1234567890",
        dataChangeEvent: { entities: [{ name: "Payment", id: String(status), operation: "Create" }] },
      }],
    });
    const signature = crypto.createHmac("sha256", env.QB_WEBHOOK_TOKEN).update(bodyText).digest("base64");

    const first = await handleQuickbooksWebhook(env as never, bodyText, signature);
    assert.equal(first.status, 503, `status ${status} remains retryable`);
    const row = [...outbox.values()][0];
    assert.equal(row.projection_status, "pending");
    assert.equal(row.attempt_count, 1);
    assert.ok(Date.parse(String(row.next_attempt_at)) > Date.parse(String(row.last_attempt_at)));

    const immediatelyDue = await recoverDueQuickBooksProjections(env as never);
    assert.equal(immediatelyDue.due, 0, `backoff prevents an immediate ${status} retry`);
    repaired = true;
    row.next_attempt_at = "1970-01-01T00:00:00.000Z";
    const recovered = await recoverDueQuickBooksProjections(env as never);
    assert.deepEqual(recovered, { due: 1, projected: 1, rejected: 0, pending: 0, escalated: 0 });
    assert.equal(row.projection_status, "projected");
  }
  assert.equal(issuerPosts, 6, "each failed event was recovered by cron, not a webhook replay");
});

test("recoverDueQuickBooksProjections: uses capped exponential backoff and emits a one-time escalation", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/api/method/ironwrap_roofing.quickbooks_reconciliation_api.check_issuer_readiness")) {
      return json({ message: { ready: true, issuer: "quickbooks-issuer@ironwrapexteriors.com" } });
    }
    if (url.includes("/api/resource/Payment%20Milestone?")) return json({ data: [] });
    if (url.endsWith("/api/method/ironwrap_roofing.quickbooks_reconciliation_api.issue_pending_reconciliation")) {
      return new Response("temporary Frappe outage", { status: 503 });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  const { env, writes, outbox } = makeQuickBooksWebhookEnv();
  const bodyText = JSON.stringify({
    eventNotifications: [{
      realmId: "1234567890",
      dataChangeEvent: { entities: [{ name: "Payment", id: "7", operation: "Create" }] },
    }],
  });
  const signature = crypto.createHmac("sha256", env.QB_WEBHOOK_TOKEN).update(bodyText).digest("base64");
  assert.equal((await handleQuickbooksWebhook(env as never, bodyText, signature)).status, 503);
  const row = [...outbox.values()][0];
  row.attempt_count = 4;
  row.next_attempt_at = "1970-01-01T00:00:00.000Z";

  const fifth = await recoverDueQuickBooksProjections(env as never);
  assert.deepEqual(fifth, { due: 1, projected: 0, rejected: 0, pending: 1, escalated: 1 });
  assert.equal(row.attempt_count, 5);
  assert.ok(row.escalated_at);
  assert.ok(writes.some((write) => write.sql.includes("INSERT INTO audit_log") && write.args.includes("projection_escalated")));

  row.attempt_count = 20;
  row.next_attempt_at = "1970-01-01T00:00:00.000Z";
  const capped = await recoverDueQuickBooksProjections(env as never);
  assert.equal(capped.escalated, 0, "the existing escalation is not duplicated");
  const cappedDelay = Date.parse(String(row.next_attempt_at)) - Date.parse(String(row.last_attempt_at));
  // The retry clock starts after the leased call returns; allow the tiny elapsed
  // execution interval between claim and release without allowing a larger backoff.
  assert.ok(cappedDelay >= 3_600_000 && cappedDelay < 3_600_100, "backoff is capped at one hour");
});

test("handleQuickbooksWebhook: a valid signature from a different realm is durably rejected without ERP linkage", async (t) => {
  let fetchCalls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalls += 1;
    throw new Error("wrong realm must never reach Frappe");
  });
  const { env, rawWrites, outbox } = makeQuickBooksWebhookEnv();
  const bodyText = JSON.stringify({
    eventNotifications: [{
      realmId: "9876543210",
      dataChangeEvent: { entities: [{ name: "Invoice", id: "42", operation: "Update" }] },
    }],
  });
  const signature = crypto.createHmac("sha256", env.QB_WEBHOOK_TOKEN).update(bodyText).digest("base64");
  const response = await handleQuickbooksWebhook(env as never, bodyText, signature);

  assert.equal(response.status, 200);
  assert.equal((await response.json() as { provider_truth_reconciled?: boolean }).provider_truth_reconciled, false);
  assert.equal(fetchCalls, 0);
  assert.equal(rawWrites.length, 1);
  assert.deepEqual([...outbox.values()].map((row) => row.projection_status), ["rejected"]);
});

test("handleQuickbooksWebhook: expected realm configuration fails closed before raw or D1 writes", async () => {
  const { env, rawWrites, writes } = makeQuickBooksWebhookEnv({ expectedRealmId: "not-a-realm" });
  const bodyText = '{"eventNotifications":[]}';
  const signature = crypto.createHmac("sha256", env.QB_WEBHOOK_TOKEN).update(bodyText).digest("base64");
  const response = await handleQuickbooksWebhook(env as never, bodyText, signature);

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "quickbooks_realm_not_configured" });
  assert.equal(rawWrites.length, 0);
  assert.equal(writes.length, 0);
});

test("handleQuickbooksWebhook: dedicated issuer readiness fails closed before accepting a new matching receipt", async (t) => {
  let readinessCalls = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/api/method/ironwrap_roofing.quickbooks_reconciliation_api.check_issuer_readiness")) {
      readinessCalls += 1;
      return json({ message: { ready: false, issuer: "quickbooks-issuer@ironwrapexteriors.com" } });
    }
    throw new Error(`new receipt must not reach ${url}`);
  });
  const { env, rawWrites, writes } = makeQuickBooksWebhookEnv();
  const bodyText = JSON.stringify({
    eventNotifications: [{
      realmId: "1234567890",
      dataChangeEvent: { entities: [{ name: "Payment", id: "7", operation: "Create" }] },
    }],
  });
  const signature = crypto.createHmac("sha256", env.QB_WEBHOOK_TOKEN).update(bodyText).digest("base64");
  const response = await handleQuickbooksWebhook(env as never, bodyText, signature);

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "quickbooks_projection_not_ready" });
  assert.equal(readinessCalls, 1);
  assert.equal(rawWrites.length, 0);
  assert.equal(writes.length, 0);
});

test("pushQuickBooksEventToErpNext: issuer conflict never falls back to generic reconciliation mutation", async (t) => {
  const fetches: Array<{ url: string; init: RequestInit }> = [];
  const payloadHash = "a".repeat(64);
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    fetches.push({ url, init: init ?? {} });
    if (url.includes("/api/resource/Roof%20Job?")) return json({ data: [] });
    if (url.endsWith("/api/method/ironwrap_roofing.quickbooks_reconciliation_api.issue_pending_reconciliation")) {
      return new Response("quickbooks_reconciliation_identity_conflict", { status: 409 });
    }
    throw new Error(`unexpected fetch ${url}`);
  });

  await assert.rejects(
    pushQuickBooksEventToErpNext({
      ERPNEXT_ENABLED: "true", ERPNEXT_BASE_URL: "https://erp.example.com", ERPNEXT_API_KEY: "erp-key", ERPNEXT_API_SECRET: "erp-secret",
      QB_EXPECTED_REALM_ID: "1234567890",
      QB_RECONCILIATION_ISSUER_USER: "quickbooks-issuer@ironwrapexteriors.com",
      QB_RECONCILIATION_ISSUER_API_KEY: "qb-issuer-key",
      QB_RECONCILIATION_ISSUER_API_SECRET: "qb-issuer-secret",
    } as never, {
      realmId: "1234567890", type: "Invoice", id: "42", operation: "Update",
      rawKey: "raw/quickbooks/2026-07-31/ow_test.json", eventTs: "2026-07-31T12:00:00.000Z", payloadHash, eventIndex: 0,
    }),
    /erpnext_http_409/,
  );
  assert.equal(fetches.some((request) => request.url.includes("/api/resource/Integration%20Reconciliation")), false);
  assert.equal(fetches.filter((request) => request.url.includes("quickbooks_reconciliation_api")).length, 1);
});

test("pushQuickBooksEventToErpNext: rejects a cross-realm direct call before any Frappe request", async (t) => {
  const fetches: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    fetches.push({ url: String(input), init: init ?? {} });
    throw new Error("realm mismatch must not reach Frappe");
  });

  await assert.rejects(
    pushQuickBooksEventToErpNext({
      ERPNEXT_ENABLED: "true", ERPNEXT_BASE_URL: "https://erp.example.com", ERPNEXT_API_KEY: "erp-key", ERPNEXT_API_SECRET: "erp-secret",
      QB_EXPECTED_REALM_ID: "1234567890",
      QB_RECONCILIATION_ISSUER_USER: "quickbooks-issuer@ironwrapexteriors.com",
      QB_RECONCILIATION_ISSUER_API_KEY: "qb-issuer-key",
      QB_RECONCILIATION_ISSUER_API_SECRET: "qb-issuer-secret",
    } as never, {
      realmId: "9876543210", type: "Invoice", id: "42", operation: "Update",
      rawKey: "raw/quickbooks/2026-07-31/ow_test.json", eventTs: "2026-07-31T12:00:00.000Z", payloadHash: "a".repeat(64), eventIndex: 0,
    }),
    /erpnext_quickbooks_realm_mismatch/,
  );
  assert.equal(fetches.length, 0);
});

test("pushQuickBooksEventToErpNext: failed invoice milestone never creates an orphan reconciliation", async (t) => {
  const fetches: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    fetches.push({ url, init: init ?? {} });
    if (url.includes("/api/resource/Roof%20Job?")) return json({ data: [{ name: "RJ-0001" }] });
    if (url.includes("/api/resource/Payment%20Milestone?")) return json({ data: [] });
    if (url.endsWith("/api/resource/Payment%20Milestone")) return new Response("temporary Frappe outage", { status: 503 });
    throw new Error(`unexpected fetch ${url}`);
  });

  await assert.rejects(
    pushQuickBooksEventToErpNext({
      ERPNEXT_ENABLED: "true", ERPNEXT_BASE_URL: "https://erp.example.com", ERPNEXT_API_KEY: "erp-key", ERPNEXT_API_SECRET: "erp-secret",
      QB_EXPECTED_REALM_ID: "1234567890",
      QB_RECONCILIATION_ISSUER_USER: "quickbooks-issuer@ironwrapexteriors.com",
      QB_RECONCILIATION_ISSUER_API_KEY: "qb-issuer-key",
      QB_RECONCILIATION_ISSUER_API_SECRET: "qb-issuer-secret",
    } as never, {
      realmId: "1234567890", type: "Invoice", id: "42", operation: "Update",
      rawKey: "raw/quickbooks/2026-07-31/ow_test.json", eventTs: "2026-07-31T12:00:00.000Z", payloadHash: "a".repeat(64), eventIndex: 0,
    }),
    /erpnext_http_503/,
  );
  assert.equal(fetches.some((request) =>
    request.url.includes("Integration%20Reconciliation") || request.url.includes("quickbooks_reconciliation_api")), false);
});
