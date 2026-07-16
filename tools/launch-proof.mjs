#!/usr/bin/env node
// Launch proof: drives one synthetic lead + one estimator session through the live bus, verifies
// readiness before mutating anything, then records only redacted release evidence. Dry-run is the
// default; --execute is required before it sends any request.
//
// BUS_BASE_URL=https://... INGEST_TOKEN=... ADMIN_TOKEN=... node tools/launch-proof.mjs --execute
import assert from "node:assert/strict";

export function createLaunchProofPlan({ stamp = Date.now() } = {}) {
  const proofStamp = String(stamp)
    .replace(/\D/g, "")
    .slice(-8)
    .padStart(8, "0");
  const leadFixture = {
    name: "Launch Proof",
    phone: `587555${proofStamp.slice(-4)}`,
    email: `launch-proof+${proofStamp}@ironwrapexteriors.com`,
    service: "metal roofing",
    message: `launch-proof fixture ${proofStamp}; safe to archive`,
    brand: "ironwrap",
    source_url: "https://ironwrapexteriors.com/quote/",
  };
  const estimateFixture = {
    project_id: `LP-${proofStamp}`,
    job_number: `LP-${proofStamp}`,
    customer: "Launch Proof",
    email: leadFixture.email,
    address: "Edmonton, AB",
    selected_services: ["Roof"],
    materials: { roof: "SnapLock Metal Roofing" },
    total_estimate: "$1.00",
    project_url: `https://estimator.example/projects/LP-${proofStamp}`,
  };
  const requestId = (name) => `launch-proof:${proofStamp}:${name}`;
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
      auth: null,
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
      name: "ingest_estimate",
      method: "POST",
      path: "/ingest/estimate",
      auth: "ingest",
      body: estimateFixture,
      idempotencyKey: `lp-${proofStamp}`,
      requestId: requestId("estimate"),
    },
    {
      name: "ingest_estimate_replay",
      method: "POST",
      path: "/ingest/estimate",
      auth: "ingest",
      body: estimateFixture,
      idempotencyKey: `lp-${proofStamp}`,
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
  return { proofStamp, leadFixture, estimateFixture, steps };
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
  onStep,
} = {}) {
  const normalizedBase = String(base ?? "").replace(/\/+$/, "");
  assert.ok(normalizedBase, "BUS_BASE_URL required");
  assert.ok(ingestToken, "INGEST_TOKEN required");
  assert.ok(adminToken, "ADMIN_TOKEN required");
  assert.equal(typeof fetchImpl, "function", "fetch implementation required");

  const plan = createLaunchProofPlan({ stamp });
  const results = {};
  for (const step of plan.steps) {
    results[step.name] = await runStep(step, {
      base: normalizedBase,
      ingestToken,
      adminToken,
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
  assert.equal(results.admin_envelopes.status, 200, "admin read-back failed");
  const listed = (results.admin_envelopes.json?.envelopes ?? []).map(
    (envelope) => envelope?.envelope_id,
  );
  assert.ok(
    listed.includes(leadEnvelope),
    "admin read-back missing the fixture envelope",
  );
  assert.equal(results.admin_reconcile.status, 200, "reconciliation failed");
  assertOperationalStatus(results.admin_status);

  return redactedEvidence({ plan, results, leadEnvelope });
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
      "After a successful run, archive the redacted JSON evidence and verify the fixture records in Frappe before cleanup.",
    );
    return { mode: "dry_run", plan };
  }

  const evidence = await executeLaunchProof({
    base: env.BUS_BASE_URL,
    ingestToken: env.INGEST_TOKEN,
    adminToken: env.ADMIN_TOKEN,
    fetchImpl,
    stamp: plan.proofStamp,
    onStep: (name, result) => errorLog(`${name}: HTTP ${result.status}`),
  });
  log(JSON.stringify(evidence, null, 2));
  return { mode: "execute", evidence };
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

function redactedEvidence({ plan, results, leadEnvelope }) {
  const operational = results.admin_status.json;
  const reconciliation = results.admin_reconcile.json;
  return {
    proof: "ironwrap-launch-proof-v2",
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
    next: "Verify the clearly labelled fixture in Frappe, then archive or remove it under the documented cleanup policy.",
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runLaunchProofCli();
}
