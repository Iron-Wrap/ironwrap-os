#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  newoCallbackRecordPresent,
  newoEnabledEnvironments,
  newoEnabledValue,
  newoEnablementRefusal,
} from "./newo-enablement.mjs";

// `--root <dir>` validates a copy of the tree; the tests use it to show each gate fails.
const rootFlag = process.argv.indexOf("--root");
const root = rootFlag === -1
  ? resolve(dirname(fileURLToPath(import.meta.url)), "..")
  : resolve(process.argv[rootFlag + 1]);
const productionRequired = process.argv.includes("--production");

const read = (path) => readFileSync(join(root, path));
const json = (path) => JSON.parse(read(path).toString("utf8"));
const sha256 = (path) => createHash("sha256").update(read(path)).digest("hex");
const expected = json("config/newo/production.expected.json");
const tools = json("config/newo/tools.v1.json");
const toolSchema = json("config/newo/schemas/tool-contracts.v1.schema.json");
const reportSchema = json("config/newo/schemas/session-report.v1.schema.json");
const fixtures = json("config/newo/sandbox-fixtures.json");
const consoleProof = json("config/newo/console-proof.json");
const evaluation = json("config/newo/evaluation-cases.v1.json");
const wrangler = read("workers-bus/wrangler.jsonc").toString("utf8");
const clientSource = read("workers-bus/src/newo-client.ts").toString("utf8");
const akb = read(expected.akb.path).toString("utf8");
// Callback only (owner decision MD-05) is behaviour, not one word: a transfer, an owner line,
// forwarding the call, or a forwarding number all put a caller through to a live line.
const LIVE_HANDOFF = /transfer|owner[\s_-]*line|forward(?:ing)?[\s_-]*(?:the[\s_-]*)?call|forwarding[\s_-]*number/i;
// Owner decision MD-08: Newo never texts a caller.
const TEXT_THE_CALLER = /\b(?:text|sms)(?:ing)?[\s_-]+the[\s_-]+caller\b/i;
const liveHandoff = (text) => text.match(LIVE_HANDOFF)?.[0] ?? null;
// Nothing opens an incident for a callback: "callback incident" however it is joined, or any
// "opens/creates/raises/files/logs an ... incident". The failure cases' "incident evidence" and
// "a retry or incident is visible" describe the Worker's own failure records and stay allowed.
const INCIDENT_PROMISE = new RegExp(
  String.raw`callback[\s_-]*incidents?\b|\b(?:opens?|opened|opening|creates?|created|creating|raises?|raised|raising|` +
    String.raw`files?|filed|filing|logs?|logged|logging)\s+(?:an?|the)\s+(?:[\w-]+\s+){0,2}incidents?\b`,
  "i",
);

assert.equal(expected.schema_version, "newo.expected-config.v1");
assert.equal(expected.config_version, "newo.production.v1");
assert.ok(["staging", "production_enabled"].includes(expected.release_state));
assert.equal(expected.federation.mode, "managed");
assert.equal(expected.runtime.production_required, true);
assert.equal(expected.runtime.booking_mode, "request_only");
assert.equal(expected.runtime.outbound_enabled, false);
assert.deepEqual(expected.runtime.enabled_channels, ["voice"]);
assert.equal(expected.booking.request_only_spoken_receipt, "Appointment request received.");
assert.equal(expected.booking.jobnimbus_appointment_contract_proven, false);
// Owner decision MD-05: callback only, never a live transfer. A handoff carries handoff_status
// "requested", which opens a callback. "failed" means the handoff request did not arrive or could
// not be processed (docs/AUTHORITY-AND-EVIDENCE-CONTRACT.md, "Failed Newo handoffs"); as the
// routine status it would report every callback as a failure.
assert.notEqual(expected.handoff?.handoff_status, "failed", "callback only must not report every handoff as failed");
assert.deepEqual(
  expected.handoff,
  { policy: "callback_only", tool: "request_handoff", handoff_status: "requested" },
  "Newo handoff must stay callback only",
);
const expectedHandoff = liveHandoff(JSON.stringify(expected));
assert.equal(expectedHandoff, null, `Newo config must not set up a live handoff (${expectedHandoff})`);
assert.equal(TEXT_THE_CALLER.test(JSON.stringify(expected)), false, "Newo config must not text the caller");
// Owner decision MD-08: IronWrap sends SMS confirmations; Newo's in-call SMS tool stays disabled.
assert.equal(expected.sms?.newo_in_call_sms_enabled, false, "Newo in-call SMS tool must stay disabled");
assert.equal(expected.sms?.confirmation_sender, "ironwrap", "SMS confirmations come from IronWrap, not Newo");
assert.equal(expected.storage.raw_prefix, "raw/newo/");
assert.equal(expected.storage.raw_lifecycle_days, 30);

const hashes = [
  [expected.contracts.tool_configuration_path, expected.contracts.tool_configuration_sha256],
  [expected.contracts.tool_schema_path, expected.contracts.tool_schema_sha256],
  [expected.contracts.report_schema_path, expected.contracts.report_schema_sha256],
  [expected.akb.path, expected.akb.sha256],
  [expected.release_evidence.evaluation_path, expected.release_evidence.evaluation_sha256],
];
for (const [path, hash] of hashes) {
  assert.match(hash, /^[0-9a-f]{64}$/, `${path} needs a SHA-256 hash`);
  assert.equal(sha256(path), hash, `${path} hash drift`);
}
for (const [name, hash] of [
  ["NEWO_TOOL_SCHEMA_SHA256", expected.contracts.tool_schema_sha256],
  ["NEWO_REPORT_SCHEMA_SHA256", expected.contracts.report_schema_sha256],
  ["NEWO_KB_SHA256", expected.akb.sha256],
]) {
  assert.ok(wrangler.includes(`"${name}": "${hash}"`), `${name} does not match expected config`);
}
for (const exact of [
  // No environment requires Newo until it is enabled separately (owner decision, 2026-09-27).
  '"NEWO_PRODUCTION_REQUIRED": "false"',
  '"NEWO_ENABLED": "false"',
  '"NEWO_CONTROL_WRITE_ENABLED": "false"',
  '"NEWO_BOOKING_MODE": "request_only"',
  '"NEWO_OUTBOUND_ENABLED": "false"',
  '"NEWO_R2_LIFECYCLE_PROVEN": "false"',
]) {
  assert.ok(wrangler.includes(exact), `missing safe launch default ${exact}`);
}
assert.deepEqual(
  [...wrangler.matchAll(/"(NEWO_[A-Z0-9_]+)"/g)].map((match) => match[1]).filter((name) => LIVE_HANDOFF.test(name)),
  [],
  "Worker config must not set up a live handoff",
);
// Newo stays off unless the D1 callback record exists (migration 0168); tools/newo-enablement.mjs
// applies the migrations and reads the schema they build.
const callbackRecordPresent = newoCallbackRecordPresent(root);
const enablementRefusal = newoEnablementRefusal({
  enabledIn: [
    ...newoEnabledEnvironments(wrangler),
    ...(newoEnabledValue(expected.runtime.enabled) ? ["production.expected.json"] : []),
  ],
  callbackRecordPresent,
});
assert.equal(enablementRefusal, null, enablementRefusal ?? undefined);

const requiredTools = [
  "lookup_caller",
  "capture_lead",
  "request_handoff",
  "check_availability",
  "request_or_book_appointment",
];
assert.equal(tools.schema_version, "newo.tool-contracts.v1");
assert.deepEqual(Object.keys(tools).filter((key) => key !== "schema_version").sort(), [...requiredTools].sort());
for (const name of requiredTools) {
  const tool = tools[name];
  assert.equal(tool.method, "POST", `${name} method`);
  assert.equal(tool.strict_payload, true, `${name} must stay strict`);
  assert.equal(tool.outbound_customer_send, false, `${name} cannot send to customers`);
  assert.match(tool.path, /^\/webhook\/newo(?:\/|$)/, `${name} path`);
  assert.ok(expected.secret_env_names.includes(tool.authorization_secret_env), `${name} auth secret env`);
}
const toolHandoff = liveHandoff(JSON.stringify(tools));
assert.equal(toolHandoff, null, `Newo tools must not set up a live handoff (${toolHandoff})`);
assert.equal(toolSchema.additionalProperties, false);
assert.deepEqual(
  toolSchema.required.filter((name) => name !== "schema_version").sort(),
  [...requiredTools].sort(),
);
assert.equal(reportSchema.additionalProperties, false);
assert.deepEqual(reportSchema.properties.event_type.enum, ["session_ended", "session_failed", "missed_call"]);
assert.deepEqual(
  reportSchema.$defs.outcome.properties.handoff_status,
  { enum: ["requested", "failed", null] },
  "the report schema must accept only handoff status requested, failed, or null",
);
for (const definition of ["provider", "address", "contact", "intent", "consent", "appointment", "outcome"]) {
  assert.equal(reportSchema.$defs[definition].additionalProperties, false, `${definition} must reject extra fields`);
}
const reportText = JSON.stringify(reportSchema);
for (const forbidden of ["transcript_text", "transcript_body", "recording_body", "recording_binary"]) {
  assert.equal(reportText.includes(forbidden), false, `report schema includes forbidden ${forbidden}`);
}

const operationBlock = clientSource.match(/export const NEWO_DOCUMENTED_OPERATIONS = \[([\s\S]*?)\] as const;/);
assert.ok(operationBlock, "cannot locate NEWO_DOCUMENTED_OPERATIONS");
const implementedOperations = [...operationBlock[1].matchAll(/"([A-Za-z0-9]+)"/g)].map((match) => match[1]);
const fixtureOperations = fixtures.operations.map((entry) => entry.operation);
assert.equal(implementedOperations.length, 31);
assert.equal(new Set(implementedOperations).size, 31);
assert.deepEqual([...fixtureOperations].sort(), [...implementedOperations].sort());
assert.equal(new Set(fixtureOperations).size, 31);
assert.equal(fixtures.receptionist_requests.length, 7);
assert.equal(new Set(fixtures.receptionist_requests.map((entry) => entry.path)).size, 7);
for (const entry of [...fixtures.operations, ...fixtures.receptionist_requests]) {
  assert.ok(["pending_sandbox_capture", "captured"].includes(entry.status), `${entry.operation ?? entry.name} status`);
  if (entry.status === "captured") {
    for (const fixturePath of [entry.request_fixture, entry.response_fixture]) {
      assert.equal(typeof fixturePath, "string", `${entry.operation ?? entry.name} fixture path missing`);
      assert.ok(existsSync(join(root, fixturePath)), `${fixturePath} not found`);
    }
  }
}

const proofControls = consoleProof.proofs.map((proof) => proof.control);
assert.equal(new Set(proofControls).size, consoleProof.proofs.length);
assert.ok(proofControls.includes("r2_raw_newo_30_day_lifecycle"));
assert.ok(proofControls.includes("usage_limit_and_threshold_alert"));
assert.ok(proofControls.includes("after_hours_forwarding_and_rollback"));
for (const control of ["handoff_callback_only", "newo_in_call_sms_disabled"]) {
  assert.ok(proofControls.includes(control), `console proof must keep ${control}`);
}
assert.deepEqual(
  proofControls.filter((control) => LIVE_HANDOFF.test(control)),
  [],
  "console proof must not carry a live-handoff control",
);
for (const proof of consoleProof.proofs) {
  assert.ok(["pending", "verified"].includes(proof.status), `${proof.control} status`);
  if (proof.status === "verified") {
    assert.equal(typeof proof.evidence_ref, "string", `${proof.control} evidence missing`);
    assert.ok(proof.evidence_ref.length >= 3, `${proof.control} evidence too short`);
    assert.ok(!Number.isNaN(Date.parse(proof.observed_at)), `${proof.control} observed_at`);
    assert.ok(!Number.isNaN(Date.parse(proof.expires_at)), `${proof.control} expires_at`);
  }
}

assert.equal(evaluation.pass_criteria.minimum_capture_and_routing_accuracy, 0.85);
assert.equal(evaluation.pass_criteria.maximum_catastrophic_failures, 0);
const caseGroups = { baseline_20: 20, handoff_reasons: 5, required_failure: 6 };
const caseCount = Object.values(caseGroups).reduce((sum, count) => sum + count, 0);
assert.equal(evaluation.pass_criteria.required_case_count, caseCount);
assert.equal(evaluation.cases.length, caseCount);
assert.equal(new Set(evaluation.cases.map((item) => item.id)).size, caseCount);
for (const [group, count] of Object.entries(caseGroups)) {
  assert.equal(evaluation.cases.filter((item) => item.group === group).length, count, `${group} case count`);
}
for (const item of evaluation.cases) {
  assert.ok(item.expected_outcome.length >= 20, `${item.id} outcome too short`);
  assert.ok(Array.isArray(item.catastrophic_if) && item.catastrophic_if.length > 0, `${item.id} catastrophic gate`);
  const text = `${item.persona} ${item.expected_outcome}`;
  assert.equal(liveHandoff(text), null, `${item.id} expects a live handoff`);
  assert.equal(TEXT_THE_CALLER.test(text), false, `${item.id} expects Newo to text the caller`);
  // A callback is a D1 callback record a person closes, plus an owner email; no incident is opened.
  const incidentPromise = text.match(INCIDENT_PROMISE)?.[0] ?? null;
  assert.equal(
    incidentPromise,
    null,
    `${item.id} promises a callback incident ("${incidentPromise}"); a callback is a D1 callback record ` +
      "a person closes, and an owner email",
  );
  if (item.group !== "required_failure") {
    for (const behaviour of ["attempts_live_transfer", "claims_callback_time"]) {
      assert.ok(item.catastrophic_if.includes(behaviour), `${item.id} must treat ${behaviour} as catastrophic`);
    }
  }
}

for (const heading of [
  "## Identity",
  "## Service area",
  "## Services and divisions",
  "## Office hours",
  "## Appointment rules",
  "## Handoff and escalation",
  "## Hail and insurance wording",
  "## Financing wording",
  "## Prohibited answers and actions",
]) {
  assert.ok(akb.includes(heading), `AKB missing ${heading}`);
}
assert.ok(akb.includes("Appointment request received."));
assert.ok(akb.includes("NEWO_OUTBOUND_ENABLED=false"));
assert.deepEqual(
  akb.split("\n").filter((line) => LIVE_HANDOFF.test(line)),
  ["- Callback only. Never transfer the call live to a person, an owner line, or voicemail."],
  "AKB may mention a live handoff only to forbid it",
);
assert.equal(TEXT_THE_CALLER.test(akb), false, "AKB must not text the caller");
assert.ok(akb.includes("and handoff status `requested`."), "AKB must request callbacks with handoff status requested");
assert.deepEqual(
  akb.split("\n").filter((line) => line.includes("`failed`")),
  ["- Report handoff status `failed` at session end only if the handoff tool call itself failed."],
  "AKB may report handoff status failed only when the handoff tool call itself failed",
);
assert.ok(akb.includes("Newo never sends SMS, and its in-call SMS tool stays disabled."), "AKB must keep Newo SMS off");

const configFiles = [
  "config/newo/production.expected.json",
  "config/newo/tools.v1.json",
  "config/newo/sandbox-fixtures.json",
  "config/newo/console-proof.json",
  "config/newo/evaluation-cases.v1.json",
  "config/newo/schemas/tool-contracts.v1.schema.json",
  "config/newo/schemas/session-report.v1.schema.json",
  expected.akb.path,
];
for (const path of configFiles) {
  const content = read(path).toString("utf8");
  for (const [name, pattern] of [
    ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ["bearer value", /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/i],
    ["sk key", /\bsk-[A-Za-z0-9]{8,}/],
  ]) {
    assert.equal(pattern.test(content), false, `${path} contains a possible ${name}`);
  }
}
assert.deepEqual(
  [...expected.secret_env_names].sort(),
  ["NEWO_API_KEY", "NEWO_BOOKING_TOKEN", "NEWO_CONTROL_SIGNING_SECRET", "NEWO_WEBHOOK_TOKEN"].sort(),
);

const productionBlockers = [];
const block = (condition, reason) => { if (!condition) productionBlockers.push(reason); };
block(expected.release_state === "production_enabled", "release_state");
block(expected.runtime.enabled === true, "runtime_enabled");
for (const [name, value] of Object.entries({
  project_id: expected.provider.project_id,
  production_agent_id: expected.provider.production_agent_id,
  report_webhook_id: expected.provider.report_webhook_id,
  handoff_webhook_id: expected.provider.handoff_webhook_id,
})) {
  block(value.status === "verified" && typeof value.expected === "string" && value.expected.length > 0, name);
}
block(/^\+[1-9]\d{7,14}$/.test(expected.telephony.newo_owned_number ?? ""), "newo_owned_number");
block(expected.telephony.number_status === "verified", "number_status");
block(["after_hours", "selected_inbound", "all_inbound"].includes(expected.telephony.forwarding_phase), "forwarding_phase");
block(Number.isFinite(expected.usage.limit_minutes) && expected.usage.limit_minutes > 0, "usage_limit");
block(expected.storage.lifecycle_proof_status === "verified", "r2_lifecycle");
block(expected.akb.owner_approval === "approved", "akb_owner_approval");
block(expected.akb.legal_wording_approval === "approved", "akb_legal_approval");
block(!/PENDING_[A-Z_]+/.test(akb), "akb_pending_content");
block(fixtures.operations.every((entry) => entry.status === "captured"), "api_fixtures");
block(fixtures.receptionist_requests.every((entry) => entry.status === "captured"), "receptionist_fixtures");
block(consoleProof.proofs.every((proof) => proof.status === "verified" && Date.parse(proof.expires_at) > Date.now()), "console_proof");
block(evaluation.status === "passed", "evaluation_status");
block(evaluation.result.accuracy >= 0.85, "evaluation_accuracy");
block(evaluation.result.catastrophic_failures === 0, "evaluation_catastrophic_failures");
block(callbackRecordPresent, "d1_callback_record");

if (expected.release_state === "production_enabled" || productionRequired) {
  assert.deepEqual(productionBlockers, [], `Newo production gate blocked: ${productionBlockers.join(", ")}`);
}

console.log(
  `ok Newo ${expected.release_state} config validated: ${requiredTools.length} tools, ` +
  `${implementedOperations.length} API operations, ${productionBlockers.length} production blockers`,
);
