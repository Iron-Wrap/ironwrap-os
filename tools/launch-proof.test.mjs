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

function healthyFetch({
  operational = operationalBody(),
  calls = [],
  websiteBodies,
  omitD1Lead = false,
} = {}) {
  let websiteCalls = 0;
  return async (input) => {
    const url = new URL(String(input));
    calls.push(url.origin + url.pathname + url.search);
    if (url.pathname === FRAPPE_LOOKUP_PATH) {
      throw new Error("D1-native launch-proof must not call Frappe");
    }
    if (url.pathname === "/health")
      return json({ ok: true }, { requestId: "request-health" });
    if (url.pathname === "/ready")
      return json(readyBody(), { requestId: "request-ready" });
    if (url.pathname === "/ingest/website") {
      websiteCalls += 1;
      const preset = websiteBodies?.[websiteCalls - 1];
      if (preset) return json(preset, { requestId: `request-website-${websiteCalls}` });
      if (websiteCalls === 1) {
        return json(
          {
            envelope_id: LEAD_ENVELOPE,
            canonical_envelope_id: LEAD_ENVELOPE,
            tenant_id: "ironwrap",
            duplicate: false,
            status: "pending_jn_push",
          },
          { requestId: "request-website" },
        );
      }
      return json(
        {
          envelope_id: LEAD_ENVELOPE,
          canonical_envelope_id: LEAD_ENVELOPE,
          tenant_id: "ironwrap",
          duplicate: true,
          status: "duplicate",
        },
        { requestId: "request-website-replay" },
      );
    }
    if (url.pathname === "/ingest/estimate")
      return json(
        { envelope_id: "ow-estimate-1" },
        { requestId: "request-estimate" },
      );
    if (url.pathname === `/admin/envelope/${LEAD_ENVELOPE}`) {
      return json(
        {
          envelope: omitD1Lead
            ? null
            : {
                envelope_id: LEAD_ENVELOPE,
                tenant_id: "ironwrap",
                contact_name: "Launch Proof",
                contact_phone: "+15875550000",
                contact_email: `launch-proof+${STAMP}-${RANDOM_SUFFIX}@example.invalid`,
                status: "pending_jn_push",
              },
        },
        { requestId: "request-d1-lead" },
      );
    }
    if (url.pathname === "/admin/envelopes") {
      return json(
        {
          envelopes: omitD1Lead
            ? []
            : [{ envelope_id: LEAD_ENVELOPE, tenant_id: "ironwrap" }],
        },
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
    throw new Error(`unexpected request ${url}`);
  };
}

function executionOptions(overrides = {}) {
  return {
    base: BASE,
    ingestToken: INGEST_TOKEN,
    adminToken: ADMIN_TOKEN,
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
  assert.match(output.join("\n"), /ingest_website_replay/);
  assert.match(output.join("\n"), /\$BUS_BASE_URL/);
  assert.equal(output.join("\n").includes("$FRAPPE_BASE_URL"), false);
  assert.equal(output.join("\n").includes(FRAPPE_LOOKUP_PATH), false);
  assert.equal(result.plan.steps.find((step) => step.name === "ready")?.auth, "admin");
  assert.equal(result.plan.operatingAuthority, "d1");
  assert.match(result.plan.leadFixture.email, /@example\.invalid$/);
  assert.equal(
    result.plan.leadFixture.source_url,
    "https://launch-proof.example.invalid/quote/",
  );
});

test("launch proof executes without Frappe configuration", async () => {
  const calls = [];
  const evidence = await executeLaunchProof({
    ...executionOptions(),
    fetchImpl: healthyFetch({ calls }),
  });
  assert.equal(evidence.operating_authority, "d1");
  assert.equal(evidence.d1_lead.state, "matched");
  assert.equal(evidence.d1_lead.envelope_id, LEAD_ENVELOPE);
  assert.equal(evidence.d1_lead.tenant_id, "ironwrap");
  assert.equal(evidence.frappe_projection.state, "out_of_scope");
  assert.equal(evidence.bridge_keep_enabled, true);
  assert.equal(calls.some((call) => call.includes(FRAPPE_LOOKUP_PATH)), false);
  assert.equal(calls.some((call) => call.startsWith(FRAPPE_BASE)), false);
});

test("launch proof does not call Frappe even when FRAPPE_* is set", async () => {
  const calls = [];
  const evidence = await executeLaunchProof({
    ...executionOptions({
      frappeBase: FRAPPE_BASE,
      frappeApiKey: FRAPPE_API_KEY,
      frappeApiSecret: FRAPPE_API_SECRET,
    }),
    fetchImpl: healthyFetch({ calls }),
  });
  assert.equal(evidence.operating_authority, "d1");
  assert.equal(evidence.frappe_projection.state, "out_of_scope");
  assert.equal(calls.some((call) => call.includes("frappe.example")), false);
  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes(FRAPPE_API_KEY), false);
  assert.equal(serialized.includes(FRAPPE_API_SECRET), false);
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

test("launch proof verifies D1 identity, lead replay, estimate idempotency, and redacted evidence", async () => {
  const evidence = await executeLaunchProof({
    ...executionOptions(),
    fetchImpl: healthyFetch(),
  });

  assert.equal(evidence.proof, "ironwrap-launch-proof-v4");
  assert.equal(evidence.fixture.envelope_id, LEAD_ENVELOPE);
  assert.equal(evidence.fixture.project_id, PROJECT_ID);
  assert.equal(evidence.steps.ingest_website.http_status, 200);
  assert.equal(evidence.steps.ingest_website_replay.http_status, 200);
  assert.equal(evidence.steps.ingest_estimate.http_status, 200);
  assert.equal(evidence.steps.d1_lead.request_id, "request-d1-lead");
  assert.equal(evidence.steps.admin_status.request_id, "request-status");
  assert.equal(evidence.operational_status.heartbeat.reconciled, true);
  assert.equal(evidence.reconciliation.gaps, 0);
  assert.equal(evidence.d1_lead.canonical_envelope_id, LEAD_ENVELOPE);
  assert.equal(evidence.lead_replay.duplicate, true);
  assert.equal(evidence.lead_replay.canonical_envelope_id, LEAD_ENVELOPE);
  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes(INGEST_TOKEN), false);
  assert.equal(serialized.includes(ADMIN_TOKEN), false);
  assert.equal(serialized.includes(FRAPPE_API_KEY), false);
  assert.equal(serialized.includes(FRAPPE_API_SECRET), false);
});

test("launch proof uses an execution-unique ID", async () => {
  const prior = createLaunchProofPlan({
    stamp: STAMP,
    randomSuffix: RANDOM_SUFFIX,
  });
  const laterStamp = String(Number(STAMP) + 100_000_000);
  const later = createLaunchProofPlan({
    stamp: laterStamp,
    randomSuffix: RANDOM_SUFFIX,
  });

  assert.equal(Number(later.proofStamp) - Number(prior.proofStamp), 100_000_000);
  assert.notEqual(later.estimateFixture.project_id, prior.estimateFixture.project_id);
  assert.notEqual(later.leadFixture.email, prior.leadFixture.email);
});

test("launch proof fails closed when D1 admin read-back is missing the fixture envelope", async () => {
  await assert.rejects(
    () =>
      executeLaunchProof({
        ...executionOptions(),
        fetchImpl: healthyFetch({ omitD1Lead: true }),
      }),
    /D1 read-back missing the fixture envelope|admin read-back missing/,
  );
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
    },
    fetchImpl: healthyFetch(),
    log: (line) => stdout.push(line),
    errorLog: (line) => stderr.push(line),
  });

  assert.equal(result.mode, "execute");
  assert.deepEqual(JSON.parse(stdout.join("")), result.evidence);
  assert.match(stderr.join("\n"), /health: HTTP 200/);
  assert.equal(result.evidence.operating_authority, "d1");
  assert.equal(stdout.join("").includes(INGEST_TOKEN), false);
  assert.equal(stdout.join("").includes(ADMIN_TOKEN), false);
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
