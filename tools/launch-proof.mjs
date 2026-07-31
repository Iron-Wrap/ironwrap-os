#!/usr/bin/env node
// Launch proof: drives one synthetic lead + one estimator session through the live bus, verifies
// readiness before mutating anything, then records only redacted release evidence. Dry-run is the
// default; --execute is required before it sends any request.
//
// BUS_BASE_URL=https://... INGEST_TOKEN=... ADMIN_TOKEN=... FRAPPE_BASE_URL=https://... \\
// FRAPPE_API_KEY=... FRAPPE_API_SECRET=... node tools/launch-proof.mjs --execute
import assert from "node:assert/strict";

const FRAPPE_LOOKUP_PATH =
  "/api/method/ironwrap_roofing.launch_proof_api.lookup_synthetic_correlation";
const DEFAULT_FRAPPE_POLL_ATTEMPTS = 3;
const DEFAULT_FRAPPE_POLL_INTERVAL_MS = 1_000;
const MAX_FRAPPE_POLL_ATTEMPTS = 5;
const MAX_FRAPPE_POLL_INTERVAL_MS = 5_000;
const SYNTHETIC_PROOF_TIMESTAMP_RE = /^[0-9]{13}$/;
const SYNTHETIC_RANDOM_SUFFIX_RE = /^[a-f0-9]{32}$/;
const SYNTHETIC_RANDOM_SUFFIX_BYTES = 16;

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
  const frappeCorrelation = `launch-proof:${estimateFixture.project_id}`;
  const frappeLookup = {
    name: "frappe_projection",
    method: "GET",
    path: `${FRAPPE_LOOKUP_PATH}?${new URLSearchParams({
      correlation_id: frappeCorrelation,
    })}`,
    auth: "frappe",
    requestId: requestId("frappe-projection"),
  };
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
    proofStamp,
    proofRandomSuffix,
    executionId,
    leadFixture,
    estimateFixture,
    frappeCorrelation,
    frappeLookup,
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
  if (step.auth === "frappe")
    parts.push("-H 'Authorization: token $FRAPPE_API_KEY:$FRAPPE_API_SECRET'");
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
  frappeBase,
  frappeApiKey,
  frappeApiSecret,
  frappePollAttempts = DEFAULT_FRAPPE_POLL_ATTEMPTS,
  frappePollIntervalMs = DEFAULT_FRAPPE_POLL_INTERVAL_MS,
  fetchImpl = globalThis.fetch,
  stamp = Date.now(),
  randomSuffix,
  sleep = defaultSleep,
  onStep,
} = {}) {
  const normalizedBase = requiredBase(base, "BUS_BASE_URL");
  const normalizedIngestToken = requiredSecret(ingestToken, "INGEST_TOKEN");
  const normalizedAdminToken = requiredSecret(adminToken, "ADMIN_TOKEN");
  assert.equal(typeof fetchImpl, "function", "fetch implementation required");
  assert.equal(typeof sleep, "function", "sleep implementation required");
  // Validate every proof dependency before even the health request. This is
  // intentionally stricter than the old readiness gate: no synthetic POST may
  // be sent when its Frappe projection cannot be checked afterwards.
  const frappeProofConfig = validateFrappeProofConfig({
    frappeBase,
    frappeApiKey,
    frappeApiSecret,
    frappePollAttempts,
    frappePollIntervalMs,
  });

  const plan = createLaunchProofPlan({ stamp, randomSuffix });
  const results = {};
  results.frappe_reader = await preflightFrappeReader({
    lookup: plan.frappeLookup,
    correlationId: plan.frappeCorrelation,
    base: frappeProofConfig.base,
    apiKey: frappeProofConfig.apiKey,
    apiSecret: frappeProofConfig.apiSecret,
    fetchImpl,
    onStep,
  });
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

  const frappeProjection = await pollFrappeProjection({
    lookup: plan.frappeLookup,
    correlationId: plan.frappeCorrelation,
    base: frappeProofConfig.base,
    apiKey: frappeProofConfig.apiKey,
    apiSecret: frappeProofConfig.apiSecret,
    attempts: frappeProofConfig.attempts,
    intervalMs: frappeProofConfig.intervalMs,
    fetchImpl,
    sleep,
    onStep,
  });

  return redactedEvidence({ plan, results, leadEnvelope, frappeProjection });
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
    log(`# ${plan.frappeLookup.name}\n${curlFor(plan.frappeLookup, "$FRAPPE_BASE_URL")}\n`);
    log(
      "After a successful run, archive the redacted JSON evidence. A Frappe projection mismatch, timeout, or unavailable lookup keeps the bridge enabled and requires reconciliation.",
    );
    return { mode: "dry_run", plan };
  }

  const evidence = await executeLaunchProof({
    base: env.BUS_BASE_URL,
    ingestToken: env.INGEST_TOKEN,
    adminToken: env.ADMIN_TOKEN,
    frappeBase: env.FRAPPE_BASE_URL,
    frappeApiKey: env.FRAPPE_API_KEY,
    frappeApiSecret: env.FRAPPE_API_SECRET,
    frappePollAttempts: env.FRAPPE_PROOF_POLL_ATTEMPTS,
    frappePollIntervalMs: env.FRAPPE_PROOF_POLL_INTERVAL_MS,
    fetchImpl,
    stamp: plan.proofStamp,
    randomSuffix: plan.proofRandomSuffix,
    onStep: (name, result) => errorLog(`${name}: HTTP ${result.status}`),
  });
  log(JSON.stringify(evidence, null, 2));
  assert.equal(
    evidence.frappe_projection.state,
    "matched",
    "launch-proof gate failed: Frappe projection did not match; keep the bridge enabled and reconcile",
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

function boundedInteger(value, name, { fallback, minimum, maximum }) {
  const candidate = value === undefined || value === "" ? fallback : Number(value);
  assert.ok(
    Number.isInteger(candidate) && candidate >= minimum && candidate <= maximum,
    `${name} must be an integer from ${minimum} to ${maximum}`,
  );
  return candidate;
}

function validateFrappeProofConfig({
  frappeBase,
  frappeApiKey,
  frappeApiSecret,
  frappePollAttempts,
  frappePollIntervalMs,
}) {
  return {
    base: requiredBase(frappeBase, "FRAPPE_BASE_URL"),
    apiKey: requiredSecret(frappeApiKey, "FRAPPE_API_KEY"),
    apiSecret: requiredSecret(frappeApiSecret, "FRAPPE_API_SECRET"),
    attempts: boundedInteger(frappePollAttempts, "FRAPPE_PROOF_POLL_ATTEMPTS", {
      fallback: DEFAULT_FRAPPE_POLL_ATTEMPTS,
      minimum: 1,
      maximum: MAX_FRAPPE_POLL_ATTEMPTS,
    }),
    intervalMs: boundedInteger(
      frappePollIntervalMs,
      "FRAPPE_PROOF_POLL_INTERVAL_MS",
      {
        fallback: DEFAULT_FRAPPE_POLL_INTERVAL_MS,
        minimum: 0,
        maximum: MAX_FRAPPE_POLL_INTERVAL_MS,
      },
    ),
  };
}

function defaultSleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
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

async function pollFrappeProjection({
  lookup,
  correlationId,
  base,
  apiKey,
  apiSecret,
  attempts,
  intervalMs,
  fetchImpl,
  sleep,
  onStep,
}) {
  let lastResult = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      lastResult = await runFrappeLookup(lookup, {
        base,
        apiKey,
        apiSecret,
        fetchImpl,
      });
    } catch {
      onStep?.(lookup.name, { status: 0 });
      return { state: "unavailable", attempts: attempt, requestId: null, httpStatus: null };
    }
    onStep?.(lookup.name, lastResult);
    if (lastResult.status !== 200)
      return {
        state: "unavailable",
        attempts: attempt,
        requestId: lastResult.requestId,
        httpStatus: lastResult.status,
      };

    const response = lastResult.json?.message ?? lastResult.json;
    if (!response || response.correlation_id !== correlationId)
      return {
        state: "mismatch",
        attempts: attempt,
        requestId: lastResult.requestId,
        httpStatus: lastResult.status,
      };
    if (response.observation === "matched")
      return {
        state: "matched",
        attempts: attempt,
        requestId: lastResult.requestId,
        httpStatus: lastResult.status,
      };
    if (response.observation === "mismatch")
      return {
        state: "mismatch",
        attempts: attempt,
        requestId: lastResult.requestId,
        httpStatus: lastResult.status,
      };
    if (response.observation !== "pending")
      return {
        state: "unavailable",
        attempts: attempt,
        requestId: lastResult.requestId,
        httpStatus: lastResult.status,
      };
    if (attempt < attempts && intervalMs > 0) await sleep(intervalMs);
  }
  return {
    state: "timeout",
    attempts,
    requestId: lastResult?.requestId ?? null,
    httpStatus: lastResult?.status ?? null,
  };
}

async function runFrappeLookup(lookup, { base, apiKey, apiSecret, fetchImpl }) {
  const response = await fetchImpl(base + lookup.path, {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `token ${apiKey}:${apiSecret}`,
      "x-request-id": lookup.requestId,
    },
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    // Never add an unparsed Frappe response body to release evidence.
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

async function preflightFrappeReader({
  lookup,
  correlationId,
  base,
  apiKey,
  apiSecret,
  fetchImpl,
  onStep,
}) {
  let result;
  try {
    result = await runFrappeLookup(lookup, { base, apiKey, apiSecret, fetchImpl });
  } catch {
    onStep?.("frappe_reader", { status: 0 });
    assert.fail("Frappe reader preflight failed");
  }
  onStep?.("frappe_reader", result);
  assert.equal(result.status, 200, "Frappe reader preflight failed");
  const response = result.json?.message ?? result.json;
  assert.equal(
    response?.correlation_id,
    correlationId,
    "Frappe reader preflight correlation mismatch",
  );
  assert.equal(
    response?.observation,
    "pending",
    "Frappe reader preflight must confirm an unused synthetic correlation",
  );
  return result;
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

function redactedEvidence({ plan, results, leadEnvelope, frappeProjection }) {
  const operational = results.admin_status.json;
  const reconciliation = results.admin_reconcile.json;
  const reconciliationRequired = frappeProjection.state !== "matched";
  return {
    proof: "ironwrap-launch-proof-v3",
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
    frappe_projection: {
      correlation_id: plan.frappeCorrelation,
      state: frappeProjection.state,
      attempts: frappeProjection.attempts,
      http_status: frappeProjection.httpStatus,
      request_id: frappeProjection.requestId,
    },
    bridge_keep_enabled: true,
    reconciliation_required: reconciliationRequired,
    next: reconciliationRequired
      ? "Keep the bridge enabled and reconcile the bounded Frappe projection before any cutover decision."
      : "Keep the bridge enabled; this synthetic Frappe match is release evidence, not bridge-retirement authority.",
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runLaunchProofCli();
}
