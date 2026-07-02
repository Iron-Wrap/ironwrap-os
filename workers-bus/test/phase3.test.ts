// Unit tests for Phase 3 pure logic (node --test, type-stripped — no install).
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { parseMeasurementSubmission, reportExt } from "../src/measurements.ts";
import { parseProposal, buildSubmission } from "../src/docuseal.ts";
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

test("parseProposal + buildSubmission: signer + prefilled fields", () => {
  const p = parseProposal({ job_number: "JN-3", name: "Jane", email: "j@x.com", address: "1 St", total: 9500 });
  assert.equal(p.jobNumber, "JN-3");
  assert.equal(p.email, "j@x.com");
  assert.deepEqual(p.fields, { address: "1 St", total: "9500" });

  const body = buildSubmission({ DOCUSEAL_TEMPLATE_ID: "7" } as never, p);
  assert.equal(body.template_id, 7);
  const sub = (body.submitters as Array<Record<string, unknown>>)[0];
  assert.equal(sub.email, "j@x.com");
  assert.deepEqual(sub.fields, [
    { name: "address", default_value: "1 St" },
    { name: "total", default_value: "9500" },
  ]);
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

test("verifyIntuitSignature: accepts a correct HMAC, rejects wrong/empty", async () => {
  const token = "verifier-123", body = '{"eventNotifications":[]}';
  const sig = crypto.createHmac("sha256", token).update(body).digest("base64"); // independent of the module
  assert.equal(await verifyIntuitSignature(token, body, sig), true);
  assert.equal(await verifyIntuitSignature(token, body, "wrong-signature"), false);
  assert.equal(await verifyIntuitSignature("", body, sig), false);
});
