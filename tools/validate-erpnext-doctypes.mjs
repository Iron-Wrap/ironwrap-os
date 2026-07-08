#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const leadEnvelopePath = join(
  root,
  "frappe-apps/ironwrap_roofing/ironwrap_roofing/ironwrap_roofing/doctype/lead_envelope/lead_envelope.json",
);

const doc = JSON.parse(readFileSync(leadEnvelopePath, "utf8"));
const fields = new Map(doc.fields.map((field) => [field.fieldname, field]));
const requiredFromWorker = [
  "envelope_id",
  "source",
  "contact_name",
  "contact_phone",
  "contact_email",
  "job_ref",
  "raw_key",
  "event_ts",
  "status",
  "intent_queue",
  "payload_json",
  "jobnimbus_contact_id",
  "jobnimbus_job_id",
];

assert.equal(doc.doctype, "DocType");
assert.equal(doc.name, "Lead Envelope");
assert.equal(doc.module, "IronWrap Roofing");
assert.equal(doc.autoname, "field:envelope_id");
assert.equal(doc.naming_rule, "By fieldname");
assert.equal(fields.get("envelope_id")?.unique, 1);
assert.equal(fields.get("envelope_id")?.reqd, 1);
assert.equal(fields.get("event_ts")?.fieldtype, "Datetime");
assert.equal(fields.get("payload_json")?.fieldtype, "Code");

for (const name of requiredFromWorker) {
  assert.ok(fields.has(name), `Lead Envelope missing Worker field: ${name}`);
  assert.ok(doc.field_order.includes(name), `field_order missing Worker field: ${name}`);
}

console.log(`ok ${requiredFromWorker.length} Worker fields covered by Lead Envelope DocType`);
