// Unit tests for Phase 3 pure logic (node --test, type-stripped — no install).
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { handleMeasurementIngest, parseMeasurementSubmission, reportExt } from "../src/measurements.ts";
import { parseQbEvents, verifyIntuitSignature } from "../src/quickbooks.ts";

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
  const body = await res.json() as { erpnext_measurement_id?: string; erpnext_error?: string | null };

  assert.equal(res.status, 200);
  assert.equal(body.erpnext_measurement_id, "MR-0001");
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
  assert.ok(writes.some((w) => w.sql.includes("INSERT INTO audit_log") && w.args.includes("erpnext_measurement")));
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
