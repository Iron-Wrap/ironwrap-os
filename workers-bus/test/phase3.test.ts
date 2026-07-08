// Unit tests for Phase 3 pure logic (node --test, type-stripped — no install).
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { handleMeasurementIngest, parseMeasurementSubmission, reportExt } from "../src/measurements.ts";
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

test("handleMeasurementIngest: raw capture plus ERPNext Measurement Report sync", async (t) => {
  const fetches: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    fetches.push({ url, init: init ?? {} });
    if (url.includes("/api/resource/Roof%20Job?")) return json({ data: [{ name: "RJ-0001" }] });
    if (url.includes("/api/resource/Measurement%20Report?")) return json({ data: [] });
    if (url.endsWith("/api/resource/Measurement%20Report")) return json({ data: { name: "MR-0001" } });
    if (url.includes("/api/resource/Evidence%20Item?")) return json({ data: [] });
    if (url.endsWith("/api/resource/Evidence%20Item")) return json({ data: { name: "EV-0001" } });
    throw new Error(`unexpected fetch ${url}`);
  });

  const writes: Array<{ sql: string; args: unknown[] }> = [];
  const rawWrites: Array<{ key: string; body: string }> = [];
  const env = {
    ERPNEXT_ENABLED: "true",
    ERPNEXT_BASE_URL: "https://erp.example.com",
    ERPNEXT_API_KEY: "erp-key",
    ERPNEXT_API_SECRET: "erp-secret",
    RAW: { put: async (key: string, body: string) => { rawWrites.push({ key, body }); } },
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return { run: async () => { writes.push({ sql, args }); return { success: true }; } };
          },
        };
      },
    },
  };

  const res = await handleMeasurementIngest(env as never, JSON.stringify({
    job_number: "26-0001",
    report_url: "https://reports.example.com/r.pdf",
    squares: 24,
    ridge_ft: 100,
  }), "application/json");
  const body = await res.json() as {
    erpnext_measurement_id?: string;
    erpnext_evidence_id?: string;
    erpnext_error?: string | null;
  };

  assert.equal(res.status, 200);
  assert.equal(body.erpnext_measurement_id, "MR-0001");
  assert.equal(body.erpnext_evidence_id, "EV-0001");
  assert.equal(body.erpnext_error, null);
  assert.equal(rawWrites.length, 1);
  assert.match(rawWrites[0].key, /^raw\/measurements\/\d{4}-\d{2}-\d{2}\/ow_/);
  const posted = JSON.parse(String(fetches.find((f) => f.url.endsWith("/api/resource/Measurement%20Report"))?.init.body));
  assert.equal(posted.roof_job, "RJ-0001");
  assert.equal(posted.measurement_id.startsWith("measurement:ow_"), true);
  assert.equal(posted.report_url, "https://reports.example.com/r.pdf");
  assert.deepEqual(posted.measurements.map((m: { metric: string; unit?: string }) => [m.metric, m.unit]), [
    ["squares", "sq"],
    ["ridge_ft", "ft"],
  ]);
  const evidence = JSON.parse(String(fetches.find((f) => f.url.endsWith("/api/resource/Evidence%20Item"))?.init.body));
  assert.equal(evidence.roof_job, "RJ-0001");
  assert.equal(evidence.evidence_id.startsWith("evidence:measurement:ow_"), true);
  assert.equal(evidence.evidence_type, "Measurement Report");
  assert.equal(evidence.source_system, "RoofRuler");
  assert.match(evidence.r2_key, /^raw\/measurements\/\d{4}-\d{2}-\d{2}\/ow_/);
  assert.ok(writes.some((w) => w.sql.includes("INSERT INTO audit_log") &&
    w.args.includes("measurement_report:MR-0001,evidence_item:EV-0001")));
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
            return { run: async () => { writes.push({ sql, args }); return { success: true }; } };
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
});
