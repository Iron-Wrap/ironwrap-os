import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createLaunchProofPlan,
  executeLaunchProof,
  runLaunchProofCli,
} from "./launch-proof.mjs";

const BASE = "https://bus.example";
const INGEST_TOKEN = "ingest-secret-that-must-not-leak";
const ADMIN_TOKEN = "admin-secret-that-must-not-leak";
const FRAPPE_BASE = "https://frappe.example";
const FRAPPE_API_KEY = "frappe-key-that-must-not-leak";
const FRAPPE_API_SECRET = "frappe-secret-that-must-not-leak";
const STAMP = "1730000000000";
const RANDOM_SUFFIX = "0123456789abcdef0123456789abcdef";
const PROJECT_ID = `LP-${STAMP}-${RANDOM_SUFFIX}`;
const LEAD_ENVELOPE = "ow_12345678-1234-4123-8123-123456789abc";
const FRAPPE_LOOKUP_PATH =
  "/api/method/ironwrap_roofing.launch_proof_api.lookup_synthetic_correlation";
const FRAPPE_CORRELATION = `launch-proof:${PROJECT_ID}`;

function json(body, { status = 200, requestId = "proof-request-1234" } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-request-id": requestId },
  });
}

function readyBody() {
  return {
    ok: true,
    status: "ready",
    checks: {
      d1: true,
      schema: true,
      raw_store_binding: true,
      queue_binding: true,
      auth_configuration: true,
      notification_configuration: true,
      jobnimbus_configuration: true,
      frappe_configuration: true,
      app_bff_configuration: true,
      customer_portal_configuration: true,
      production_schedule_configuration: true,
    },
  };
}

function operationalBody(overrides = {}) {
  return {
    status: "ok",
    heartbeat: {
      day: "2026-07-16",
      ran_at: "2026-07-16T12:00:00.000Z",
      fresh: true,
      reconciled: true,
    },
    counts: {
      open_dead_letters: 0,
      pending: 0,
      stuck: 0,
      frappe_errors: 0,
      replay_failed: 0,
      replay_stuck: 0,
    },
    recent_audit_failures: { entries: [] },
    ...overrides,
  };
}

function frappeLookupBody({
  correlationId = FRAPPE_CORRELATION,
  observation = "matched",
  extra = {},
} = {}) {
  return { message: { correlation_id: correlationId, observation, ...extra } };
}

function healthyFetch({
  operational = operationalBody(),
  calls = [],
  frappeResponses = [json(frappeLookupBody(), { requestId: "request-frappe" })],
} = {}) {
  return async (input) => {
    const url = new URL(String(input));
    calls.push(url.origin + url.pathname + url.search);
    if (url.pathname === "/health")
      return json({ ok: true }, { requestId: "request-health" });
    if (url.pathname === "/ready")
      return json(readyBody(), { requestId: "request-ready" });
    if (url.pathname === "/ingest/website")
      return json(
        { envelope_id: LEAD_ENVELOPE },
        { requestId: "request-website" },
      );
    if (url.pathname === "/ingest/estimate")
      return json(
        { envelope_id: "ow-estimate-1" },
        { requestId: "request-estimate" },
      );
    if (url.pathname === "/admin/envelopes") {
      return json(
        { envelopes: [{ envelope_id: LEAD_ENVELOPE }] },
        { requestId: "request-envelopes" },
      );
    }
    if (url.pathname === "/admin/reconcile") {
      return json(
        { day: "2026-07-16", rows: [], openDeadLetter: 0 },
        { requestId: "request-reconcile" },
      );
    }
    if (url.pathname === "/admin/status")
      return json(operational, { requestId: "request-status" });
    if (url.pathname === FRAPPE_LOOKUP_PATH) {
      const next = frappeResponses.shift();
      if (!next) throw new Error("unexpected extra Frappe poll");
      return next;
    }
    throw new Error(`unexpected request ${url}`);
  };
}

function executionOptions(overrides = {}) {
  return {
    base: BASE,
    ingestToken: INGEST_TOKEN,
    adminToken: ADMIN_TOKEN,
    frappeBase: FRAPPE_BASE,
    frappeApiKey: FRAPPE_API_KEY,
    frappeApiSecret: FRAPPE_API_SECRET,
    stamp: STAMP,
    randomSuffix: RANDOM_SUFFIX,
    ...overrides,
  };
}

test("launch proof dry-run never performs a network request", async () => {
  let fetchCalls = 0;
  const output = [];
  const result = await runLaunchProofCli({
    argv: [],
    env: {},
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("dry-run must not fetch");
    },
    log: (line) => output.push(line),
  });

  assert.equal(result.mode, "dry_run");
  assert.equal(fetchCalls, 0);
  assert.match(output.join("\n"), /admin_reconcile/);
  assert.match(output.join("\n"), /admin_status/);
  assert.match(output.join("\n"), /\$BUS_BASE_URL/);
  assert.match(output.join("\n"), /\$FRAPPE_BASE_URL/);
  assert.equal(result.plan.steps.find((step) => step.name === "ready")?.auth, "admin");
  assert.match(result.plan.leadFixture.email, /@example\.invalid$/);
  assert.equal(
    result.plan.leadFixture.source_url,
    "https://launch-proof.example.invalid/quote/",
  );
});

test("launch proof rejects incomplete Frappe proof configuration before any network request or synthetic POST", async () => {
  const calls = [];
  await assert.rejects(
    () =>
      executeLaunchProof({
        base: BASE,
        ingestToken: INGEST_TOKEN,
        adminToken: ADMIN_TOKEN,
        fetchImpl: async (input) => {
          calls.push(String(input));
          throw new Error("must not fetch");
        },
      }),
    /FRAPPE_BASE_URL required/,
  );
  assert.deepEqual(calls, []);
});

test("failed readiness stops launch proof before any intake mutation", async () => {
  const calls = [];
  await assert.rejects(
    () =>
      executeLaunchProof({
        ...executionOptions(),
        fetchImpl: async (input) => {
          const url = new URL(String(input));
          calls.push(url.pathname);
          if (url.pathname === "/health") return json({ ok: true });
          if (url.pathname === "/ready")
            return json(
              { ok: false, status: "not_ready", checks: { d1: false } },
              { status: 503 },
            );
          throw new Error(`unexpected request ${url}`);
        },
      }),
    /readiness failed/,
  );
  assert.deepEqual(calls, ["/health", "/ready"]);
});

test("launch proof verifies idempotency and emits redacted release evidence", async () => {
  const evidence = await executeLaunchProof({
    ...executionOptions(),
    fetchImpl: healthyFetch(),
  });

  assert.equal(evidence.fixture.envelope_id, LEAD_ENVELOPE);
  assert.equal(evidence.fixture.project_id, PROJECT_ID);
  assert.equal(evidence.steps.ingest_estimate.http_status, 200);
  assert.equal(evidence.steps.admin_status.request_id, "request-status");
  assert.equal(evidence.operational_status.heartbeat.reconciled, true);
  assert.equal(evidence.reconciliation.gaps, 0);
  assert.equal(evidence.frappe_projection.state, "matched");
  assert.equal(evidence.bridge_keep_enabled, true);
  assert.equal(evidence.reconciliation_required, false);
  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes(INGEST_TOKEN), false);
  assert.equal(serialized.includes(ADMIN_TOKEN), false);
  assert.equal(serialized.includes(FRAPPE_API_KEY), false);
  assert.equal(serialized.includes(FRAPPE_API_SECRET), false);
});

test("launch proof uses an execution-unique ID and rejects a stale prior Frappe session", async () => {
  const prior = createLaunchProofPlan({
    stamp: STAMP,
    randomSuffix: RANDOM_SUFFIX,
  });
  const laterStamp = String(Number(STAMP) + 100_000_000);
  const later = createLaunchProofPlan({
    stamp: laterStamp,
    // Keeping the injected suffix equal isolates the full timestamp regression.
    randomSuffix: RANDOM_SUFFIX,
  });

  assert.equal(Number(later.proofStamp) - Number(prior.proofStamp), 100_000_000);
  assert.notEqual(later.estimateFixture.project_id, prior.estimateFixture.project_id);
  assert.notEqual(later.frappeCorrelation, prior.frappeCorrelation);

  const calls = [];
  const evidence = await executeLaunchProof({
    ...executionOptions({
      stamp: later.proofStamp,
      randomSuffix: later.proofRandomSuffix,
      frappePollAttempts: 1,
      frappePollIntervalMs: 0,
    }),
    fetchImpl: healthyFetch({
      calls,
      frappeResponses: [
        json(
          frappeLookupBody({
            correlationId: prior.frappeCorrelation,
            observation: "matched",
          }),
          { requestId: "frappe-stale-prior" },
        ),
      ],
    }),
  });

  assert.equal(evidence.frappe_projection.state, "mismatch");
  assert.equal(evidence.reconciliation_required, true);
  assert.ok(
    calls.includes(
      `${FRAPPE_BASE}${FRAPPE_LOOKUP_PATH}?correlation_id=${encodeURIComponent(later.frappeCorrelation)}`,
    ),
  );
});

test("launch proof accepts a delayed bounded Frappe projection match", async () => {
  const calls = [];
  const sleeps = [];
  const evidence = await executeLaunchProof({
    ...executionOptions({ frappePollAttempts: 2, frappePollIntervalMs: 17 }),
    fetchImpl: healthyFetch({
      calls,
      frappeResponses: [
        json(frappeLookupBody({ observation: "pending" }), { requestId: "frappe-pending" }),
        json(frappeLookupBody(), { requestId: "frappe-matched" }),
      ],
    }),
    sleep: async (delay) => sleeps.push(delay),
  });

  assert.equal(evidence.frappe_projection.state, "matched");
  assert.equal(evidence.frappe_projection.attempts, 2);
  assert.equal(evidence.frappe_projection.request_id, "frappe-matched");
  assert.deepEqual(sleeps, [17]);
  assert.equal(
    calls.filter((call) => call.includes(FRAPPE_LOOKUP_PATH)).length,
    2,
  );
});

test("launch proof preserves the bridge for mismatched, missing, or unavailable Frappe evidence", async () => {
  const mismatch = await executeLaunchProof({
    ...executionOptions({ frappePollAttempts: 2, frappePollIntervalMs: 0 }),
    fetchImpl: healthyFetch({
      frappeResponses: [
        json(frappeLookupBody({ observation: "mismatch" }), { requestId: "frappe-mismatch" }),
      ],
    }),
  });
  assert.equal(mismatch.frappe_projection.state, "mismatch");
  assert.equal(mismatch.bridge_keep_enabled, true);
  assert.equal(mismatch.reconciliation_required, true);

  const missing = await executeLaunchProof({
    ...executionOptions({ frappePollAttempts: 2, frappePollIntervalMs: 0 }),
    fetchImpl: healthyFetch({
      frappeResponses: [
        json(frappeLookupBody({ observation: "pending" })),
        json(frappeLookupBody({ observation: "pending" })),
      ],
    }),
  });
  assert.equal(missing.frappe_projection.state, "timeout");
  assert.equal(missing.bridge_keep_enabled, true);
  assert.equal(missing.reconciliation_required, true);

  const unavailable = await executeLaunchProof({
    ...executionOptions(),
    fetchImpl: healthyFetch({
      frappeResponses: [
        json(
          { message: "raw unavailable evidence must never enter the artifact" },
          { status: 503, requestId: "frappe-unavailable" },
        ),
      ],
    }),
  });
  assert.equal(unavailable.frappe_projection.state, "unavailable");
  assert.equal(unavailable.bridge_keep_enabled, true);
  assert.equal(unavailable.reconciliation_required, true);
  assert.equal(
    JSON.stringify(unavailable).includes("raw unavailable evidence"),
    false,
  );
});

test("launch proof bounds a pending Frappe poll and redacts its credentials", async () => {
  const calls = [];
  const evidence = await executeLaunchProof({
    ...executionOptions({ frappePollAttempts: 3, frappePollIntervalMs: 0 }),
    fetchImpl: healthyFetch({
      calls,
      frappeResponses: [
        json(frappeLookupBody({ observation: "pending" })),
        json(frappeLookupBody({ observation: "pending" })),
        json(frappeLookupBody({ observation: "pending" })),
      ],
    }),
  });

  assert.equal(evidence.frappe_projection.state, "timeout");
  assert.equal(evidence.frappe_projection.attempts, 3);
  assert.equal(
    calls.filter((call) => call.includes(FRAPPE_LOOKUP_PATH)).length,
    3,
  );
  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes(FRAPPE_API_KEY), false);
  assert.equal(serialized.includes(FRAPPE_API_SECRET), false);
});

test("execute CLI writes a standalone redacted JSON artifact to standard output", async () => {
  const stdout = [];
  const stderr = [];
  const result = await runLaunchProofCli({
    argv: ["--execute"],
    env: {
      BUS_BASE_URL: BASE,
      INGEST_TOKEN,
      ADMIN_TOKEN,
      FRAPPE_BASE_URL: FRAPPE_BASE,
      FRAPPE_API_KEY,
      FRAPPE_API_SECRET,
      FRAPPE_PROOF_POLL_INTERVAL_MS: "0",
    },
    fetchImpl: healthyFetch(),
    log: (line) => stdout.push(line),
    errorLog: (line) => stderr.push(line),
  });

  assert.equal(result.mode, "execute");
  assert.deepEqual(JSON.parse(stdout.join("")), result.evidence);
  assert.match(stderr.join("\n"), /health: HTTP 200/);
  assert.equal(stdout.join("").includes(INGEST_TOKEN), false);
  assert.equal(stdout.join("").includes(ADMIN_TOKEN), false);
  assert.equal(stdout.join("").includes(FRAPPE_API_KEY), false);
  assert.equal(stdout.join("").includes(FRAPPE_API_SECRET), false);
});

test("launch proof rejects degraded and stale operational status", async () => {
  await assert.rejects(
    () =>
      executeLaunchProof({
        ...executionOptions(),
        fetchImpl: healthyFetch({
          operational: operationalBody({ status: "degraded" }),
        }),
      }),
    /operational status is degraded/,
  );
  await assert.rejects(
    () =>
      executeLaunchProof({
        ...executionOptions(),
        fetchImpl: healthyFetch({
          operational: operationalBody({
            heartbeat: {
              day: "2026-07-16",
              ran_at: "2026-07-14T12:00:00.000Z",
              fresh: false,
              reconciled: true,
            },
          }),
        }),
      }),
    /operational heartbeat is not fresh/,
  );
});
