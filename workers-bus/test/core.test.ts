// Zero-dependency self-test of the pure bus logic. Run: `node --test test/`
// (Node 22 strips the TS types and runs this directly — no build step, no install.)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizePhone, extractContact, normalizeEnvelope, dedupKey, validateInbound,
  classifyIntent, reconcileDiff, isStuck, backoffMs, newEnvelopeId,
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

test("extractContact normalizes varied inbound field names", () => {
  const c = extractContact({
    first_name: "Jane", last_name: "Doe", Phone: "587.555.1234", EMAIL: "Jane@Example.COM ",
  });
  assert.equal(c.name, "Jane Doe");
  assert.equal(c.phone, "+15875551234");
  assert.equal(c.email, "jane@example.com");
});

test("normalizeEnvelope builds canonical shape; job_ref null at intake", () => {
  const e = normalizeEnvelope("website", { name: "Bob", phone: "5875551234" }, "2026-06-28T20:00:00.000Z");
  assert.equal(e.source, "website");
  assert.equal(e.job_ref, null);
  assert.equal(e.contact.phone, "+15875551234");
  assert.equal(e.ts, "2026-06-28T20:00:00.000Z");
});

test("validateInbound requires a contact handle (phone or email)", () => {
  assert.equal(validateInbound(normalizeEnvelope("website", { name: "x" }, "t")).ok, false);
  assert.equal(validateInbound(normalizeEnvelope("website", { email: "a@b.com" }, "t")).ok, true);
});

test("classifyIntent routes per spec 16, most-specific-first", () => {
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
