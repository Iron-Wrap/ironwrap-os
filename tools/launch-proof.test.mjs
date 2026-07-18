import assert from "node:assert/strict";
import { test } from "node:test";

import { executeLaunchProof, runLaunchProofCli } from "./launch-proof.mjs";

const BASE = "https://bus.example";
const INGEST_TOKEN = "ingest-secret-that-must-not-leak";
const ADMIN_TOKEN = "admin-secret-that-must-not-leak";
const STAMP = "12345678";
const LEAD_ENVELOPE = "ow_12345678-1234-4123-8123-123456789abc";

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

function healthyFetch({ operational = operationalBody(), calls = [] } = {}) {
  return async (input) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
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
    throw new Error(`unexpected request ${url}`);
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
  assert.equal(result.plan.steps.find((step) => step.name === "ready")?.auth, "admin");
});

test("failed readiness stops launch proof before any intake mutation", async () => {
  const calls = [];
  await assert.rejects(
    () =>
      executeLaunchProof({
        base: BASE,
        ingestToken: INGEST_TOKEN,
        adminToken: ADMIN_TOKEN,
        stamp: STAMP,
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
    base: BASE,
    ingestToken: INGEST_TOKEN,
    adminToken: ADMIN_TOKEN,
    stamp: STAMP,
    fetchImpl: healthyFetch(),
  });

  assert.equal(evidence.fixture.envelope_id, LEAD_ENVELOPE);
  assert.equal(evidence.fixture.project_id, "LP-12345678");
  assert.equal(evidence.steps.ingest_estimate.http_status, 200);
  assert.equal(evidence.steps.admin_status.request_id, "request-status");
  assert.equal(evidence.operational_status.heartbeat.reconciled, true);
  assert.equal(evidence.reconciliation.gaps, 0);
  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes(INGEST_TOKEN), false);
  assert.equal(serialized.includes(ADMIN_TOKEN), false);
});

test("execute CLI writes a standalone redacted JSON artifact to standard output", async () => {
  const stdout = [];
  const stderr = [];
  const result = await runLaunchProofCli({
    argv: ["--execute"],
    env: { BUS_BASE_URL: BASE, INGEST_TOKEN, ADMIN_TOKEN },
    fetchImpl: healthyFetch(),
    log: (line) => stdout.push(line),
    errorLog: (line) => stderr.push(line),
  });

  assert.equal(result.mode, "execute");
  assert.deepEqual(JSON.parse(stdout.join("")), result.evidence);
  assert.match(stderr.join("\n"), /health: HTTP 200/);
  assert.equal(stdout.join("").includes(INGEST_TOKEN), false);
  assert.equal(stdout.join("").includes(ADMIN_TOKEN), false);
});

test("launch proof rejects degraded and stale operational status", async () => {
  await assert.rejects(
    () =>
      executeLaunchProof({
        base: BASE,
        ingestToken: INGEST_TOKEN,
        adminToken: ADMIN_TOKEN,
        stamp: STAMP,
        fetchImpl: healthyFetch({
          operational: operationalBody({ status: "degraded" }),
        }),
      }),
    /operational status is degraded/,
  );
  await assert.rejects(
    () =>
      executeLaunchProof({
        base: BASE,
        ingestToken: INGEST_TOKEN,
        adminToken: ADMIN_TOKEN,
        stamp: STAMP,
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
