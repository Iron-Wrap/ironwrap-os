#!/usr/bin/env node
// Launch proof: drives one synthetic lead + one estimator session through the
// owned D1/Worker operating authority. Frappe/ERPNext stand-up is out of scope
// (IRO-189 rewrite 2026-08-21; IRO-195 owns Frappe retirement).
//
// Dry-run is the default; --execute is required before it sends any request.
//
// BUS_BASE_URL=https://... INGEST_TOKEN=... ADMIN_TOKEN=... node tools/launch-proof.mjs --execute
import assert from "node:assert/strict";

const SYNTHETIC_PROOF_TIMESTAMP_RE = /^[0-9]{13}$/;
const SYNTHETIC_RANDOM_SUFFIX_RE = /^[a-f0-9]{32}$/;
const SYNTHETIC_RANDOM_SUFFIX_BYTES = 16;
const OPERATING_AUTHORITY = "d1";

export function createLaunchProofPlan({
  stamp = Date.now(),
  randomSuffix = cryptographicRandomSuffix(),
} = {}) {
  const proofStamp = normalizeProofStamp(stamp);
  const proofRandomSuffix = normalizeRandomSuffix(randomSuffix);
  const executionId = `${proofStamp}-${proofRandomSuffix}`;
  const leadFixture = {
    name: "Launch Proof",
    phone: `587555${proofStamp.slice(-4)}`,
    email: `launch-proof+${executionId}@example.invalid`,
    service: "metal roofing",
    message: `launch-proof fixture ${executionId}; safe to archive`,
    brand: "ironwrap",
    source_url: "https://launch-proof.example.invalid/quote/",
  };
  const estimateFixture = {
    project_id: `LP-${executionId}`,
    job_number: `LP-${executionId}`,
    customer: "Launch Proof",
    email: leadFixture.email,
    address: "Edmonton, AB",
    selected_services: ["Roof"],
    materials: { roof: "SnapLock Metal Roofing" },
    total_estimate: "$1.00",
    project_url: `https://estimator.example/projects/LP-${executionId}`,
  };
  const requestId = (name) => `launch-proof:${executionId}:${name}`;
  const steps = [
    {
      name: "health",
      method: "GET",
      path: "/health",
      auth: null,
      requestId: requestId("health"),
    },
    {
      name: "ready",
      method: "GET",
      path: "/ready",
      auth: "admin",
      requestId: requestId("ready"),
    },
    {
      name: "ingest_website",
      method: "POST",
      path: "/ingest/website",
      auth: "ingest",
      body: leadFixture,
      requestId: requestId("website"),
    },
    {
      name: "ingest_website_replay",
      method: "POST",
      path: "/ingest/website",
      auth: "ingest",
      body: leadFixture,
      requestId: requestId("website-replay"),
    },
    {
      name: "ingest_estimate",
      method: "POST",
      path: "/ingest/estimate",
      auth: "ingest",
      body: estimateFixture,
      idempotencyKey: `lp-${executionId}`,
      requestId: requestId("estimate"),
    },
    {
      name: "ingest_estimate_replay",
      method: "POST",
      path: "/ingest/estimate",
      auth: "ingest",
      body: estimateFixture,
      idempotencyKey: `lp-${executionId}`,
      requestId: requestId("estimate-replay"),
    },
    {
      name: "admin_envelopes",
      method: "GET",
      path: "/admin/envelopes?limit=10",
      auth: "admin",
      requestId: requestId("envelopes"),
    },
    {
      name: "admin_reconcile",
      method: "POST",
      path: "/admin/reconcile",
      auth: "admin",
      requestId: requestId("reconcile"),
    },
    {
      name: "admin_status",
      method: "GET",
      path: "/admin/status?audit_limit=20",
      auth: "admin",
      requestId: requestId("status"),
    },
  ];
  return {
    operatingAuthority: OPERATING_AUTHORITY,
    proofStamp,
    proofRandomSuffix,
    executionId,
    leadFixture,
    estimateFixture,
    steps,
  };
}

export function curlFor(step, base = "") {
  const parts = [
    `curl -sS -X ${step.method} '${base || "$BUS_BASE_URL"}${step.path}'`,
  ];
  if (step.auth === "ingest")
    parts.push("-H 'Authorization: Bearer $INGEST_TOKEN'");
  if (step.auth === "admin")
    parts.push("-H 'Authorization: Bearer $ADMIN_TOKEN'");
  if (step.requestId) parts.push(`-H 'X-Request-ID: ${step.requestId}'`);
  if (step.idempotencyKey)
    parts.push(`-H 'Idempotency-Key: ${step.idempotencyKey}'`);
  if (step.body)
    parts.push(
      `-H 'content-type: application/json' -d '${JSON.stringify(step.body)}'`,
    );
  return parts.join(" " + "\\" + "\n    ");
}

export async function executeLaunchProof({
  base,
  ingestToken,
  adminToken,
  fetchImpl = globalThis.fetch,
  stamp = Date.now(),
  randomSuffix,
  onStep,
} = {}) {
  const normalizedBase = requiredBase(base, "BUS_BASE_URL");
  const normalizedIngestToken = requiredSecret(ingestToken, "INGEST_TOKEN");
  const normalizedAdminToken = requiredSecret(adminToken, "ADMIN_TOKEN");
  assert.equal(typeof fetchImpl, "function", "fetch implementation required");

  const plan = createLaunchProofPlan({ stamp, randomSuffix });
  const results = {};
  for (const step of plan.steps) {
    results[step.name] = await runStep(step, {
      base: normalizedBase,
      ingestToken: normalizedIngestToken,
      adminToken: normalizedAdminToken,
      fetchImpl,
    });
    onStep?.(step.name, results[step.name]);
    if (step.name === "health")
      assert.equal(results.health.status, 200, "health failed");
    if (step.name === "ready") assertReadiness(results.ready);
  }

  assert.equal(results.ingest_website.status, 200, "website ingest failed");
  const leadEnvelope = results.ingest_website.json?.envelope_id;
  assert.ok(leadEnvelope, "website ingest returned no envelope_id");
  const canonicalLead =
    results.ingest_website.json?.canonical_envelope_id ?? leadEnvelope;
  assert.equal(results.ingest_website_replay.status, 200, "website replay failed");
  assert.equal(
    results.ingest_website_replay.json?.duplicate,
    true,
    "website replay was not marked duplicate",
  );
  assert.equal(
    results.ingest_website_replay.json?.canonical_envelope_id,
    canonicalLead,
    "website replay did not return the original lead identity",
  );
  assert.equal(results.ingest_estimate.status, 200, "estimate ingest failed");
  assert.equal(
    results.ingest_estimate_replay.status,
    200,
    "estimate replay failed",
  );
  assert.equal(
    results.ingest_estimate.json?.envelope_id,
    results.ingest_estimate_replay.json?.envelope_id,
    "estimate replay was not idempotent",
  );

  const d1Lead = await runStep(
    {
      name: "d1_lead",
      method: "GET",
      path: `/admin/envelope/${encodeURIComponent(canonicalLead)}`,
      auth: "admin",
      requestId: `launch-proof:${plan.executionId}:d1-lead`,
    },
    {
      base: normalizedBase,
      ingestToken: normalizedIngestToken,
      adminToken: normalizedAdminToken,
      fetchImpl,
    },
  );
  results.d1_lead = d1Lead;
  onStep?.("d1_lead", d1Lead);
  assert.equal(d1Lead.status, 200, "D1 lead read-back failed");
  const stored = d1Lead.json?.envelope;
  assert.ok(stored?.envelope_id, "D1 read-back missing the fixture envelope");
  assert.equal(stored.envelope_id, canonicalLead, "D1 read-back identity mismatch");
  assert.ok(stored.tenant_id, "D1 lead is missing tenant identity");
  assert.equal(stored.contact_name, plan.leadFixture.name);

  assert.equal(results.admin_envelopes.status, 200, "admin read-back failed");
  const listed = (results.admin_envelopes.json?.envelopes ?? []).map(
    (envelope) => envelope?.envelope_id,
  );
  assert.ok(
    listed.includes(canonicalLead),
    "admin read-back missing the fixture envelope",
  );
  assert.equal(results.admin_reconcile.status, 200, "reconciliation failed");
  assertOperationalStatus(results.admin_status);

  return redactedEvidence({
    plan,
    results,
    leadEnvelope: canonicalLead,
    d1Lead: stored,
    leadReplay: results.ingest_website_replay.json,
  });
}

export async function runLaunchProofCli({
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = globalThis.fetch,
  log = console.log,
  errorLog = console.error,
} = {}) {
  const plan = createLaunchProofPlan();
  if (!argv.includes("--execute")) {
    log("DRY RUN (pass --execute to send). Plan:\n");
    for (const step of plan.steps) log(`# ${step.name}\n${curlFor(step)}\n`);
    log(
      "Operating authority is D1/Worker. Frappe/ERPNext stand-up is out of scope (IRO-189 / IRO-195).",
    );
    log(
      "After a successful run, archive the redacted JSON evidence. D1 identity, tenant isolation, and ingest replay are the gate; a Frappe lookup is not.",
    );
    return { mode: "dry_run", plan };
  }

  const evidence = await executeLaunchProof({
    base: env.BUS_BASE_URL,
    ingestToken: env.INGEST_TOKEN,
    adminToken: env.ADMIN_TOKEN,
    fetchImpl,
    stamp: plan.proofStamp,
    randomSuffix: plan.proofRandomSuffix,
    onStep: (name, result) => errorLog(`${name}: HTTP ${result.status}`),
  });
  log(JSON.stringify(evidence, null, 2));
  assert.equal(
    evidence.operating_authority,
    "d1",
    "launch-proof gate failed: operating authority is not D1",
  );
  assert.equal(
    evidence.d1_lead.state,
    "matched",
    "launch-proof gate failed: D1 lead identity did not match",
  );
  return { mode: "execute", evidence };
}

function normalizeProofStamp(value) {
  const normalized = String(value ?? "").trim();
  assert.ok(
    SYNTHETIC_PROOF_TIMESTAMP_RE.test(normalized),
    "launch proof timestamp must be a 13-digit Unix millisecond timestamp",
  );
  return normalized;
}

function cryptographicRandomSuffix() {
  const cryptoApi = globalThis.crypto;
  assert.ok(
    cryptoApi && typeof cryptoApi.getRandomValues === "function",
    "cryptographic random values required for a launch-proof execution ID",
  );
  const bytes = new Uint8Array(SYNTHETIC_RANDOM_SUFFIX_BYTES);
  cryptoApi.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeRandomSuffix(value) {
  assert.equal(typeof value, "string", "launch proof random suffix must be text");
  assert.ok(
    SYNTHETIC_RANDOM_SUFFIX_RE.test(value),
    "launch proof random suffix must be 32 lowercase hexadecimal characters",
  );
  return value;
}

function requiredBase(value, name) {
  const normalized = String(value ?? "").trim().replace(/\/+$/, "");
  assert.ok(normalized, `${name} required`);
  return normalized;
}

function requiredSecret(value, name) {
  const normalized = typeof value === "string" ? value.trim() : "";
  assert.ok(normalized, `${name} required`);
  return normalized;
}

async function runStep(step, { base, ingestToken, adminToken, fetchImpl }) {
  const headers = {
    accept: "application/json",
    "x-request-id": step.requestId,
  };
  if (step.auth === "ingest") headers.authorization = `Bearer ${ingestToken}`;
  if (step.auth === "admin") headers.authorization = `Bearer ${adminToken}`;
  if (step.idempotencyKey) headers["idempotency-key"] = step.idempotencyKey;
  if (step.body) headers["content-type"] = "application/json";
  const response = await fetchImpl(base + step.path, {
    method: step.method,
    headers,
    body: step.body ? JSON.stringify(step.body) : undefined,
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    // The assertion for the affected endpoint reports the failed proof step without echoing a body.
  }
  return {
    status: response.status,
    json,
    requestId:
      response.headers.get("x-request-id") ??
      response.headers.get("x-correlation-id") ??
      null,
  };
}

function assertReadiness(result) {
  assert.equal(result.status, 200, "readiness failed");
  assert.equal(result.json?.ok, true, "readiness did not report ok");
  assert.equal(result.json?.status, "ready", "readiness did not report ready");
  const checks = result.json?.checks;
  assert.ok(
    checks &&
      Object.keys(checks).length > 0 &&
      Object.values(checks).every(Boolean),
    "readiness has a failed check",
  );
}

function assertOperationalStatus(result) {
  assert.equal(result.status, 200, "operational status read failed");
  const status = result.json;
  assert.equal(status?.status, "ok", "operational status is degraded");
  assert.ok(status?.heartbeat, "operational heartbeat missing");
  assert.equal(
    status.heartbeat.fresh,
    true,
    "operational heartbeat is not fresh",
  );
  assert.equal(
    status.heartbeat.reconciled,
    true,
    "operational heartbeat is not reconciled",
  );
  for (const field of [
    "open_dead_letters",
    "stuck",
    "frappe_errors",
    "replay_failed",
    "replay_stuck",
  ]) {
    assert.equal(
      status.counts?.[field],
      0,
      `operational count ${field} is not zero`,
    );
  }
  assert.equal(
    status.recent_audit_failures?.entries?.length,
    0,
    "recent audit failures are present",
  );
}

function redactedEvidence({ plan, results, leadEnvelope, d1Lead, leadReplay }) {
  const operational = results.admin_status.json;
  const reconciliation = results.admin_reconcile.json;
  return {
    proof: "ironwrap-launch-proof-v4",
    operating_authority: OPERATING_AUTHORITY,
    fixture: {
      envelope_id: leadEnvelope,
      project_id: plan.estimateFixture.project_id,
    },
    steps: Object.fromEntries(
      Object.entries(results).map(([name, result]) => [
        name,
        {
          http_status: result.status,
          request_id: result.requestId,
        },
      ]),
    ),
    readiness: { checks: results.ready.json?.checks ?? null },
    reconciliation: {
      day: reconciliation?.day ?? null,
      open_dead_letters: reconciliation?.openDeadLetter ?? null,
      gaps: Array.isArray(reconciliation?.rows)
        ? reconciliation.rows.filter((row) => Number(row?.gap) > 0).length
        : null,
    },
    operational_status: {
      status: operational?.status ?? null,
      heartbeat: operational?.heartbeat
        ? {
            day: operational.heartbeat.day ?? null,
            ran_at: operational.heartbeat.ran_at ?? null,
            fresh: operational.heartbeat.fresh ?? null,
            reconciled: operational.heartbeat.reconciled ?? null,
          }
        : null,
      counts: operational?.counts ?? null,
      recent_audit_failure_count:
        operational?.recent_audit_failures?.entries?.length ?? null,
    },
    d1_lead: {
      state: d1Lead?.envelope_id === leadEnvelope ? "matched" : "mismatch",
      envelope_id: d1Lead?.envelope_id ?? null,
      canonical_envelope_id: leadEnvelope,
      tenant_id: d1Lead?.tenant_id ?? null,
    },
    lead_replay: {
      duplicate: leadReplay?.duplicate === true,
      canonical_envelope_id: leadReplay?.canonical_envelope_id ?? null,
    },
    frappe_projection: {
      state: "out_of_scope",
    },
    // This proof does not retire JobNimbus (IRO-192) and is not a HELM permit/receipt (IRO-190).
    bridge_keep_enabled: true,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runLaunchProofCli();
}
