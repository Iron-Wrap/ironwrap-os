// Readiness-verdict and watchdog-policy tests: the pure decision layer that
// keeps a deliberate launch gate (Newo) from hiding core regressions and keeps
// the owner alert an alert, not a newsletter.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readinessVerdicts, watchdogAlertHtml, watchdogFindings } from "../src/operations.ts";

const CHECKS = {
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
  public_estimate_configuration: true,
  measurement_ocr_configuration: true,
  rail_credential_isolation: true,
  newo_enabled: false, // leftover Newo gate — not the default office plane
  newo_webhook_credentials: true,
  newo_api_authentication: true,
  newo_production_actor: true,
  newo_report_webhook_match: true,
  newo_configuration_drift: true,
  newo_queue_binding: true,
  newo_dlq_state: true,
  newo_frappe_readiness: true,
  newo_jobnimbus_bridge: true,
  newo_booking_mode: true,
} as never;

test("readiness: failures stay inside their named operating plane", () => {
  assert.deepEqual(readinessVerdicts(CHECKS), {
    ok: true,
    core_ok: true,
    owned_core_ok: true,
    office_operating_plane_ok: true,
    projection_rails_ok: true,
  });

  const projectionBroken = {
    ...(CHECKS as Record<string, boolean>),
    frappe_configuration: false,
  } as never;
  assert.deepEqual(readinessVerdicts(projectionBroken), {
    ok: true,
    core_ok: true,
    owned_core_ok: true,
    office_operating_plane_ok: true,
    projection_rails_ok: false,
  });

  const officeBroken = {
    ...(CHECKS as Record<string, boolean>),
    app_bff_configuration: false,
  } as never;
  assert.deepEqual(readinessVerdicts(officeBroken), {
    ok: false,
    core_ok: true,
    owned_core_ok: true,
    office_operating_plane_ok: false,
    projection_rails_ok: true,
  });

  const coreBroken = { ...(CHECKS as Record<string, boolean>), d1: false } as never;
  assert.deepEqual(readinessVerdicts(coreBroken), {
    ok: false,
    core_ok: false,
    owned_core_ok: false,
    office_operating_plane_ok: false,
    projection_rails_ok: false,
  });
  const allGreen = Object.fromEntries(
    Object.keys(CHECKS as Record<string, boolean>).map((key) => [key, true]),
  ) as never;
  assert.deepEqual(readinessVerdicts(allGreen), {
    ok: true,
    core_ok: true,
    owned_core_ok: true,
    office_operating_plane_ok: true,
    projection_rails_ok: true,
  });
});

test("watchdog: alerts only on core failure, backlog, or fresh divergence", () => {
  assert.deepEqual(
    watchdogFindings({ coreOk: true, failedCoreChecks: [], exceptionCount: 0, deltaFailures24h: 0 }),
    [],
  );
  assert.deepEqual(
    watchdogFindings({ coreOk: true, failedCoreChecks: [], exceptionCount: 4, deltaFailures24h: 0 }),
    [],
  );
  const noisy = watchdogFindings({
    coreOk: false,
    failedCoreChecks: ["d1", "schema"],
    exceptionCount: 7,
    deltaFailures24h: 2,
  });
  assert.equal(noisy.length, 3);
  assert.match(noisy[0], /d1, schema/);
  assert.match(noisy[1], /backlog at 7/);
  assert.match(noisy[2], /2 failed cross-source/);
});

test("watchdog: retries keep one email identity while persistent findings get a fresh window", () => {
  const findings = ["core readiness failing: d1"];
  const first = watchdogAlertHtml(findings, new Date("2026-01-01T14:00:00.000Z"));
  const retry = watchdogAlertHtml(findings, new Date("2026-01-01T14:05:00.000Z"));
  const persistent = watchdogAlertHtml(findings, new Date("2026-01-02T14:00:00.000Z"));
  assert.equal(retry, first);
  assert.notEqual(persistent, first);
  assert.match(first, /UTC check window: 2026-01-01/);
  assert.match(persistent, /UTC check window: 2026-01-02/);
});
