// Readiness-verdict and watchdog-policy tests: the pure decision layer that
// keeps a deliberate launch gate (Newo) from hiding core regressions and keeps
// the owner alert an alert, not a newsletter.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readinessVerdicts, watchdogFindings } from "../src/operations.ts";

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
  newo_enabled: false, // the deliberate production gate
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

test("readiness: the Newo launch gate fails the full verdict but never the core one", () => {
  assert.deepEqual(readinessVerdicts(CHECKS), { ok: false, core_ok: true });
  const coreBroken = { ...(CHECKS as Record<string, boolean>), d1: false } as never;
  assert.deepEqual(readinessVerdicts(coreBroken), { ok: false, core_ok: false });
  const allGreen = Object.fromEntries(
    Object.keys(CHECKS as Record<string, boolean>).map((key) => [key, true]),
  ) as never;
  assert.deepEqual(readinessVerdicts(allGreen), { ok: true, core_ok: true });
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
