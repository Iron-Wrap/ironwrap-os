#!/usr/bin/env node
// d1-gate-ledger-probe.mjs - repeats one production gate ledger case on D1's own engine.
//
// Migration 0158 refuses a person attestation whose evidence list is not plain JSON with
// one-argument json_valid. That holds only on an engine where json_valid refuses JSON5 while
// json_each and json_type still read it, as SQLite 3.45 and later do. The Worker suite runs the
// migrations on node:sqlite, and D1 does not let a query read sqlite_version(), so this probe
// checks the engine the migrations ship to: wrangler's local D1 (workerd's SQLite), on a database
// `wrangler d1 migrations apply --local` has migrated. It reads the engine's JSON functions, then
// inserts a Materials attestation whose evidence is JSON5 and expects 0158's refusal, then the
// same attestation with plain JSON and expects the gate ready. It writes synthetic
// example.invalid rows only, under fresh ids, so it can run on the same database more than once.
//
// Usage: node tools/d1-gate-ledger-probe.mjs --persist-to <dir>

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORKER = fileURLToPath(new URL("../workers-bus/", import.meta.url));
const WRANGLER = join(WORKER, "node_modules", ".bin", "wrangler");
const DATABASE = "ironwrap-bus";
const TENANT = "ironwrap";
// JSON5 that json_each reads as an empty list, so no other evidence rule has anything to refuse.
const JSON5_EVIDENCE = "[/* JSON5 comment */]";
const REFUSAL = "production_gate_evidence_invalid";

const persistArg = process.argv.indexOf("--persist-to");
if (persistArg === -1 || !process.argv[persistArg + 1]) {
  console.error("usage: node tools/d1-gate-ledger-probe.mjs --persist-to <dir>");
  process.exit(2);
}
const persistTo = resolve(process.argv[persistArg + 1]);
const scratch = mkdtempSync(join(tmpdir(), "ironwrap-d1-gate-probe-"));

const sha = (value) => createHash("sha256").update(value).digest("hex");
const quote = (value) => (value === null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`);

let fileCounter = 0;
/** Runs SQL on the local D1 and returns { ok, output, results }. */
function execute(sql) {
  fileCounter += 1;
  const file = join(scratch, `step-${fileCounter}.sql`);
  writeFileSync(file, sql);
  try {
    const output = execFileSync(
      WRANGLER,
      ["d1", "execute", DATABASE, "--local", "--persist-to", persistTo, "--json", "--file", file],
      {
        cwd: WORKER,
        encoding: "utf8",
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    return { ok: true, output, results: JSON.parse(output).flatMap((batch) => batch.results ?? []) };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ""}${error.stderr ?? ""}${error.message ?? ""}`, results: [] };
  }
}

const failures = [];
function expect(condition, message, detail = "") {
  if (!condition) failures.push(detail ? `${message}\n${detail}` : message);
}

try {
  // 1. The engine: one-argument json_valid refuses the JSON5 list that json_each and json_type read.
  const engine = execute(
    `SELECT json_valid(${quote(JSON5_EVIDENCE)}) AS strict_valid,
            json_type(${quote(JSON5_EVIDENCE)}) AS json_type,
            (SELECT COUNT(*) FROM json_each(${quote(JSON5_EVIDENCE)})) AS each_rows,
            json_valid('[]') AS plain_valid;`,
  );
  expect(engine.ok, "the engine query failed", engine.output);
  const row = engine.results[0] ?? {};
  expect(
    row.strict_valid === 0 && row.json_type === "array" && row.each_rows === 0 && row.plain_valid === 1,
    "D1's engine no longer refuses JSON5 in one-argument json_valid while json_each and json_type read it; " +
      "revisit 0158's evidence JSON rule",
    JSON.stringify(row),
  );

  // 2. One active production person on no crew, a job and its blocked Materials gate.
  const suffix = randomBytes(6).toString("hex");
  const userId = `appu_probe_${suffix}`;
  const jobId = `job:probe:${suffix}`;
  const gateId = `gate:probe:${suffix}:materials`;
  const envelopeId = `ow_gate_probe_${suffix}`;
  const email = `probe-${suffix}@example.invalid`;
  const seeded = execute(`
    INSERT INTO app_users
      (user_id, tenant_id, email_normalized, display_name, role, access_role, frappe_user_id,
       active, created_by, created_at, updated_at)
    VALUES (${quote(userId)}, ${quote(TENANT)}, ${quote(`${userId}@example.invalid`)}, 'Synthetic production',
            'ops', 'production', NULL, 1, 'owner@example.invalid',
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day'));
    INSERT INTO envelopes
      (envelope_id, source, contact_name, contact_email, payload_json, raw_key, ts, status, created_at, updated_at)
    VALUES (${quote(envelopeId)}, 'manual', 'Probe Customer', ${quote(email)}, '{}', ${quote(`raw/probe/${suffix}.json`)},
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day'), 'reconciled',
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day'));
    INSERT INTO operating_leads
      (lead_id, tenant_id, source_envelope_id, source, contact_name, contact_email, lifecycle_status, version,
       created_at, updated_at)
    VALUES (${quote(`lead:probe:${suffix}`)}, ${quote(TENANT)}, ${quote(envelopeId)}, 'manual', 'Probe Customer',
            ${quote(email)}, 'qualified', 1,
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day'));
    INSERT INTO operating_customers
      (customer_id, tenant_id, source_envelope_id, display_name, contact_email, lifecycle_status, version,
       created_at, updated_at)
    VALUES (${quote(`customer:probe:${suffix}`)}, ${quote(TENANT)}, ${quote(envelopeId)}, 'Probe Customer',
            ${quote(email)}, 'active', 1,
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day'));
    INSERT INTO operating_roof_jobs
      (roof_job_id, tenant_id, lead_id, customer_id, source_envelope_id, brand, job_number, service_type,
       job_status, current_gate_state, version, created_at, updated_at)
    VALUES (${quote(jobId)}, ${quote(TENANT)}, ${quote(`lead:probe:${suffix}`)}, ${quote(`customer:probe:${suffix}`)},
            ${quote(envelopeId)}, 'ironwrap', ${quote(`IW-PROBE-${suffix}`)}, 'Roofing', 'qualified', 'blocked', 1,
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day'));
    INSERT INTO operating_production_gates
      (gate_id, tenant_id, roof_job_id, source_envelope_id, gate, owner_user, assigned_at, due_at, blocker_reason,
       created_at, updated_at)
    VALUES (${quote(gateId)}, ${quote(TENANT)}, ${quote(jobId)}, ${quote(envelopeId)}, 'Materials',
            'owner@example.invalid', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day'),
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+7 days'), 'No active blocker',
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day'));
  `);
  expect(seeded.ok, "seeding the synthetic job failed", seeded.output);

  const attestation = (evidence, n) => `
    INSERT INTO production_gate_clearances
      (clearance_id, tenant_id, gate_id, roof_job_id, gate, entry_kind, basis, to_state, from_gate_version,
       actor_kind, actor_user_id, actor_role, attestation_json, evidence_refs_json, request_sha256,
       idempotency_key_hash, created_at)
    VALUES (${quote(`pgc_${sha(`${suffix}:clearance:${n}`).slice(0, 40)}`)}, ${quote(TENANT)}, ${quote(gateId)},
            ${quote(jobId)}, 'Materials', 'clear', 'person_attestation', 'ready',
            (SELECT version FROM operating_production_gates WHERE gate_id = ${quote(gateId)}),
            'person', ${quote(userId)}, 'production',
            '{"source":"supplier_delivery","reference":"DEL-PROBE-0001"}', ${quote(evidence)},
            ${quote(sha(`${suffix}:request:${n}`))}, ${quote(sha(`${suffix}:key:${n}`))},
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));`;
  const gateState = () =>
    execute(`SELECT state, version FROM operating_production_gates WHERE gate_id = ${quote(gateId)};`).results[0] ?? {};

  if (seeded.ok) {
    // 3. JSON5 evidence is refused by 0158 and leaves the gate blocked.
    const json5 = execute(attestation(JSON5_EVIDENCE, 1));
    expect(!json5.ok && json5.output.includes(REFUSAL), `a JSON5 evidence list was not refused with ${REFUSAL}`, json5.output);
    const afterJson5 = gateState();
    expect(afterJson5.state === "blocked", "the gate moved after a refused JSON5 attestation", JSON.stringify(afterJson5));

    // 4. The same attestation with a plain JSON list readies the gate, so nothing else refused step 3.
    const plain = execute(attestation("[]", 2));
    expect(plain.ok, "the same attestation with plain JSON evidence was refused", plain.output);
    const afterPlain = gateState();
    expect(afterPlain.state === "ready", "the plain JSON attestation did not ready the gate", JSON.stringify(afterPlain));
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`d1-gate-ledger-probe: FAIL ${failure}`);
  process.exit(1);
}
console.log("d1-gate-ledger-probe: ok - D1 refuses JSON5 evidence in a gate attestation and admits plain JSON");
