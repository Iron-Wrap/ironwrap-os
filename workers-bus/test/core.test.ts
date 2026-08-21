// Zero-dependency self-test of the pure bus logic. Run: `node --test test/`
// (Node 22 strips the TS types and runs this directly — no build step, no install.)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizePhone, extractContact, normalizeEnvelope, dedupKey, validateInbound,
  classifyIntent, reconcileDiff, isStuck, backoffMs, newEnvelopeId,
  validateSourceCount, MAX_SOURCE_COUNT, parseBody, operatingTenantId,
} from "../src/core.ts";

test("normalizePhone → E.164 (+1 for bare CA/US 10-digit)", () => {
  assert.equal(normalizePhone("(587) 555-1234"), "+15875551234");
  assert.equal(normalizePhone("1-587-555-1234"), "+15875551234");
  assert.equal(normalizePhone("+44 20 7946 0958"), "+442079460958");
  assert.equal(normalizePhone("12345"), null);   // too short to be a phone
  assert.equal(normalizePhone(undefined), null);
});

test("dedupKey prefers phone, falls back to email, else null", () => {
  assert.equal(dedupKey({ phone: "+15875551234", email: "a@b.com" }), "p:+15875551234");
  assert.equal(dedupKey({ email: "a@b.com" }), "e:a@b.com");
  assert.equal(dedupKey({}), null);
});

test("parseBody preserves valid non-object JSON as raw instead of returning a false record", () => {
  assert.deepEqual(parseBody("null", "application/json"), { _raw: "null" });
  assert.deepEqual(parseBody("[1,2,3]", "application/json"), { _raw: "[1,2,3]" });
  assert.deepEqual(parseBody('{"name":"Jane"}', "application/json"), { name: "Jane" });
});

test("extractContact normalizes varied inbound field names", () => {
  const c = extractContact({
    first_name: "Jane", last_name: "Doe", Phone: "587.555.1234", EMAIL: "Jane@Example.COM ",
  });
  assert.equal(c.name, "Jane Doe");
  assert.equal(c.phone, "+15875551234");
  assert.equal(c.email, "jane@example.com");
});

test("normalizeEnvelope builds canonical shape and preserves upstream job refs when present", () => {
  const e = normalizeEnvelope("website", { name: "Bob", phone: "5875551234" }, "2026-06-28T20:00:00.000Z");
  assert.equal(e.source, "website");
  assert.equal(e.job_ref, null);
  assert.equal(e.contact.phone, "+15875551234");
  assert.equal(e.ts, "2026-06-28T20:00:00.000Z");
  assert.equal(normalizeEnvelope("website", { email: "bob@example.com", job_number: "26-180-ER" }, "t").job_ref, "26-180-ER");
});

test("validateInbound requires a contact handle (phone or email)", () => {
  assert.equal(validateInbound(normalizeEnvelope("website", { name: "x" }, "t")).ok, false);
  assert.equal(validateInbound(normalizeEnvelope("website", { email: "a@b.com" }, "t")).ok, true);
});

test("classifyIntent routes most-specific-first", () => {
  assert.equal(classifyIntent("active leak emergency"), "human_escalation");
  assert.equal(classifyIntent("hail damage, insurance claim"), "insurance_sales");
  assert.equal(classifyIntent("commercial flat roof"), "commercial_queue");
  assert.equal(classifyIntent("steel coil slitting"), "shop_supply_queue");
  assert.equal(classifyIntent("metal roof quote please"), "residential_sales");
  assert.equal(classifyIntent("just saying hi"), "human_qualification");
});

test("reconcileDiff flags gaps (source > landed), worst-first", () => {
  const rows = reconcileDiff({ website: 10, phone: 4 }, { website: 8, phone: 4 });
  assert.equal(rows[0].channel, "website");
  assert.equal(rows[0].gap, 2);
  assert.equal(rows.find((r) => r.channel === "phone").gap, 0);
});

test("validateSourceCount requires a real ISO day, allowed channel, and bounded integer", () => {
  assert.deepEqual(validateSourceCount("2026-07-10", "website", 42), {
    ok: true, day: "2026-07-10", channel: "website", count: 42,
  });
  assert.deepEqual(validateSourceCount("2026-02-30", "website", 1), { ok: false, reason: "invalid_day" });
  assert.deepEqual(validateSourceCount("2026-07-10T00:00:00Z", "website", 1), { ok: false, reason: "invalid_day" });
  assert.deepEqual(validateSourceCount("2026-07-10", "email", 1), { ok: false, reason: "invalid_channel" });
  assert.deepEqual(validateSourceCount("2026-07-10", "website", -1), { ok: false, reason: "invalid_count" });
  assert.deepEqual(validateSourceCount("2026-07-10", "website", 1.5), { ok: false, reason: "invalid_count" });
  assert.deepEqual(validateSourceCount("2026-07-10", "website", MAX_SOURCE_COUNT + 1), { ok: false, reason: "invalid_count" });
});

test("isStuck respects the threshold; unparseable ts ⇒ re-drive", () => {
  const now = Date.parse("2026-06-28T20:00:00Z");
  assert.equal(isStuck("2026-06-28T19:40:00Z", now, 15), true);   // 20 min old
  assert.equal(isStuck("2026-06-28T19:55:00Z", now, 15), false);  // 5 min old
  assert.equal(isStuck("not-a-date", now, 15), true);
});

test("backoffMs grows exponentially and caps at 1h", () => {
  assert.equal(backoffMs(1), 60_000);
  assert.equal(backoffMs(2), 120_000);
  assert.ok(backoffMs(20) <= 3_600_000);
});

test("newEnvelopeId is unique and ow_-prefixed", () => {
  const a = newEnvelopeId();
  const b = newEnvelopeId();
  assert.match(a, /^ow_[0-9a-f-]{36}$/);
  assert.notEqual(a, b);
});

test("operatingTenantId accepts pinned ids and refuses unverified labels", () => {
  assert.equal(operatingTenantId(undefined), "ironwrap");
  assert.equal(operatingTenantId(""), "ironwrap");
  assert.equal(operatingTenantId("ironwrap"), "ironwrap");
  assert.equal(operatingTenantId("acme-roofing"), "acme-roofing");
  assert.equal(operatingTenantId("IronWrap"), null);
  assert.equal(operatingTenantId("not a tenant"), null);
});
