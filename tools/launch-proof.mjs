#!/usr/bin/env node
// Launch proof: drives one synthetic lead + one estimator session through the LIVE
// bus and verifies the owned spine end to end (gate 1 intake, estimate idempotency,
// admin read-back; ERPNext mirror ids appear in responses when ERPNEXT_ENABLED=true
// on the Worker, which proves gate 2 wiring).
//
// SAFE BY DEFAULT: prints the plan and equivalent curl commands without sending.
// Pass --execute to actually hit the bus.
//
//   BUS_BASE_URL=https://... INGEST_TOKEN=... ADMIN_TOKEN=... node tools/launch-proof.mjs --execute
//
// The fixture is clearly marked as a test (brand ironwrap, name "Launch Proof") and
// uses a per-run phone/email so the dedup window never collapses two runs.
import assert from "node:assert/strict";

const EXECUTE = process.argv.includes("--execute");
const base = (process.env.BUS_BASE_URL ?? "").replace(/\/+$/, "");
const ingestToken = process.env.INGEST_TOKEN ?? "";
const adminToken = process.env.ADMIN_TOKEN ?? "";

const stamp = Date.now().toString().slice(-8);
const leadFixture = {
  name: "Launch Proof",
  phone: `587555${stamp.slice(-4)}`,
  email: `launch-proof+${stamp}@ironwrapexteriors.com`,
  service: "metal roofing",
  message: `launch-proof fixture ${stamp}; safe to archive`,
  brand: "ironwrap",
  source_url: "https://ironwrapexteriors.com/quote/",
};
const estimateFixture = {
  project_id: `LP-${stamp}`,
  job_number: `LP-${stamp}`,
  customer: "Launch Proof",
  email: leadFixture.email,
  address: "Edmonton, AB",
  selected_services: ["Roof"],
  materials: { roof: "SnapLock Metal Roofing" },
  total_estimate: "$1.00",
  project_url: `https://estimator.example/projects/LP-${stamp}`,
};

const steps = [
  { name: "health", method: "GET", path: "/health", auth: null },
  { name: "ingest_website", method: "POST", path: "/ingest/website", auth: "ingest", body: leadFixture },
  { name: "ingest_estimate", method: "POST", path: "/ingest/estimate", auth: "ingest", body: estimateFixture, idempotencyKey: `lp-${stamp}` },
  { name: "ingest_estimate_replay", method: "POST", path: "/ingest/estimate", auth: "ingest", body: estimateFixture, idempotencyKey: `lp-${stamp}` },
  { name: "admin_envelopes", method: "GET", path: "/admin/envelopes?limit=10", auth: "admin" },
];

function curlFor(step) {
  const parts = [`curl -sS -X ${step.method} '${base || "$BUS_BASE_URL"}${step.path}'`];
  if (step.auth === "ingest") parts.push(`-H 'Authorization: Bearer $INGEST_TOKEN'`);
  if (step.auth === "admin") parts.push(`-H 'Authorization: Bearer $ADMIN_TOKEN'`);
  if (step.idempotencyKey) parts.push(`-H 'Idempotency-Key: ${step.idempotencyKey}'`);
  if (step.body) parts.push(`-H 'content-type: application/json' -d '${JSON.stringify(step.body)}'`);
  return parts.join(" \\\n    ");
}

if (!EXECUTE) {
  console.log("DRY RUN (pass --execute to send). Plan:\n");
  for (const step of steps) console.log(`# ${step.name}\n${curlFor(step)}\n`);
  console.log("Manual follow-ups after --execute:");
  console.log("- Frappe Desk: Lead Envelope, Roofing Customer/Property, Roof Job + 7 gates exist for the fixture");
  console.log("- POST /admin/reconcile and confirm the heartbeat row is green");
  process.exit(0);
}

assert.ok(base, "BUS_BASE_URL required");
assert.ok(ingestToken, "INGEST_TOKEN required");
assert.ok(adminToken, "ADMIN_TOKEN required");

async function run(step) {
  const headers = { accept: "application/json" };
  if (step.auth === "ingest") headers.authorization = `Bearer ${ingestToken}`;
  if (step.auth === "admin") headers.authorization = `Bearer ${adminToken}`;
  if (step.idempotencyKey) headers["idempotency-key"] = step.idempotencyKey;
  if (step.body) headers["content-type"] = "application/json";
  const res = await fetch(base + step.path, {
    method: step.method,
    headers,
    body: step.body ? JSON.stringify(step.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const results = {};
for (const step of steps) {
  results[step.name] = await run(step);
  console.log(`${step.name}: HTTP ${results[step.name].status}`);
}

// Scorecard assertions: fail loudly if the spine is not actually live.
assert.equal(results.health.status, 200, "health failed");
assert.equal(results.ingest_website.status, 200, "website ingest failed");
const leadEnvelope = results.ingest_website.json.envelope_id;
assert.ok(leadEnvelope, "website ingest returned no envelope_id");
assert.equal(results.ingest_estimate.status, 200, "estimate ingest failed");
const est1 = results.ingest_estimate.json;
const est2 = results.ingest_estimate_replay.json;
assert.equal(est1.envelope_id, est2.envelope_id, "estimate replay was not idempotent");
const listed = (results.admin_envelopes.json.envelopes ?? []).map((e) => e.envelope_id);
assert.ok(listed.includes(leadEnvelope), "admin read-back missing the fixture envelope");

console.log(JSON.stringify({
  gate1_intake_spine: "LIVE",
  estimate_idempotency: "PROVEN",
  admin_read_back: "PROVEN",
  erpnext_mirror_ids: est1.erpnext ?? est1.erpnext_ids ?? "check Worker response fields / Frappe Desk",
  fixture: { envelope_id: leadEnvelope, project_id: estimateFixture.project_id },
  next: "verify Roof Job + 7 gates in Frappe Desk, then archive the fixture records",
}, null, 2));
