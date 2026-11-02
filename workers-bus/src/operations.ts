// operations.ts — production-facing readiness, status, and dead-letter recovery orchestration.

import * as store from "./store.ts";
import { appBffConfigured } from "./app-auth.ts";
import { customerPortalConfigured } from "./customer-portal.ts";
import { productionScheduleApprovalDecisionConfig } from "./production-schedule-approval-authority.ts";
import { productionScheduleApprovalBrokerConfig } from "./production-schedule-approval-broker-client.ts";
import { publicEstimateConfigured, type PublicEstimatorEnv } from "./public-estimator.ts";
import type { AppEnv } from "./app-types.ts";
import { quickBooksFinalInvoiceOperationalCounts } from "./quickbooks-final-invoice.ts";
import { NewoApiClient, newoClientConfigFromEnv, type NewoJson } from "./newo-client.ts";
import { countOpenNewoDeadLetters, newoOperationalCounts } from "./newo-store.ts";
import { listMeasurementIntakeExceptions } from "./measurement-intake-store.ts";
import { countFailedDeltasSince } from "./measurement-deltas-store.ts";
import { gmailConfigured, sendGmail } from "./google.ts";
import { measurementPdfOcrConfigured } from "./measurements.ts";
import { railCredentialIsolationConfigured } from "./rail-frappe-credentials.ts";
import { getCronLiveness, type CronLivenessEntry } from "./cron-liveness.ts";

export const BULK_REPLAY_CONFIRMATION = "REPLAY_ALL_OPEN_DEAD_LETTERS";
const HEARTBEAT_FRESHNESS_HOURS = 36;
const AUDIT_FAILURE_WINDOW_HOURS = 24;
const QB_RECEIPT_FRESHNESS_HOURS = 24;
const QUEUE_BATCH_SIZE = 100;
const MAX_CLOCK_SKEW_SECONDS = 5 * 60;

interface ExtendedEnv {
  ERPNEXT_ENABLED?: string;
  NEWO_PRODUCTION_REQUIRED?: string;
  NEWO_ENABLED?: string;
  NEWO_CONTROL_WRITE_ENABLED?: string;
  NEWO_OUTBOUND_ENABLED?: string;
  NEWO_WEBHOOK_TOKEN?: string;
  NEWO_BOOKING_TOKEN?: string;
  NEWO_CONTROL_SIGNING_SECRET?: string;
  NEWO_API_BASE_URL?: string;
  NEWO_API_KEY?: string;
  NEWO_PROJECT_ID?: string;
  NEWO_AGENT_ID?: string;
  NEWO_REPORT_WEBHOOK_ID?: string;
  NEWO_REPORT_WEBHOOK_URL?: string;
  NEWO_HANDOFF_WEBHOOK_ID?: string;
  NEWO_HANDOFF_WEBHOOK_URL?: string;
  NEWO_EXPECTED_CONFIG_VERSION?: string;
  NEWO_TOOL_SCHEMA_SHA256?: string;
  NEWO_REPORT_SCHEMA_SHA256?: string;
  NEWO_KB_VERSION?: string;
  NEWO_KB_SHA256?: string;
  NEWO_PHONE_NUMBER?: string;
  NEWO_ENABLED_CHANNELS?: string;
  NEWO_R2_LIFECYCLE_PROVEN?: string;
  NEWO_USAGE_LIMIT_MINUTES?: string;
  NEWO_USAGE_ALERT_PERCENT?: string;
  NEWO_BOOKING_MODE?: string;
  NEWO_JOBNIMBUS_BOOKING_PROVEN?: string;
  NEWO_QUEUE?: Queue;
}

export interface ReplayApprovalContext {
  run_id: string;
  approved_by: string;
  reason: string;
}

export type ReplayApprovalValidation =
  | { ok: true; value: ReplayApprovalContext }
  | { ok: false; fields: Array<keyof ReplayApprovalContext> };

export interface ReadinessReport {
  ok: boolean;
  /** Compatibility alias for owned_core_ok. */
  core_ok: boolean;
  owned_core_ok: boolean;
  office_operating_plane_ok: boolean;
  projection_rails_ok: boolean;
  status: "ready" | "not_ready";
  checks: {
    d1: boolean;
    schema: boolean;
    raw_store_binding: boolean;
    queue_binding: boolean;
    auth_configuration: boolean;
    notification_configuration: boolean;
    jobnimbus_configuration: boolean;
    frappe_configuration: boolean;
    app_bff_configuration: boolean;
    customer_portal_configuration: boolean;
    production_schedule_configuration: boolean;
    /** Fleet-capture and work-package rails each hold their OWN Frappe issuer pair. */
    rail_credential_isolation: boolean;
    public_estimate_configuration: boolean;
    measurement_ocr_configuration: boolean;
    newo_enabled: boolean;
    newo_webhook_credentials: boolean;
    newo_api_authentication: boolean;
    newo_production_actor: boolean;
    newo_report_webhook_match: boolean;
    newo_configuration_drift: boolean;
    newo_queue_binding: boolean;
    newo_dlq_state: boolean;
    newo_frappe_readiness: boolean;
    newo_jobnimbus_bridge: boolean;
    newo_booking_mode: boolean;
  };
  newo: NewoReadinessDetail;
}

type ReadinessCheckName = keyof ReadinessReport["checks"];

const OWNED_CORE_CHECKS = [
  "d1",
  "schema",
  "raw_store_binding",
  "queue_binding",
  "auth_configuration",
  "notification_configuration",
] as const satisfies readonly ReadinessCheckName[];

const OFFICE_OPERATING_PLANE_CHECKS = [
  ...OWNED_CORE_CHECKS,
  "jobnimbus_configuration",
  "app_bff_configuration",
  "customer_portal_configuration",
  "production_schedule_configuration",
  "public_estimate_configuration",
  "measurement_ocr_configuration",
] as const satisfies readonly ReadinessCheckName[];

export interface NewoReadinessDetail {
  required: boolean;
  enabled: boolean;
  booking_mode: string;
  outbound_enabled: boolean;
  control_write_enabled: boolean;
  webhook_credentials_configured: boolean;
  queue_binding_ready: boolean;
  dlq_clear: boolean;
  jobnimbus_bridge_ready: boolean;
  booking_mode_ready: boolean;
  api_authenticated: boolean;
  production_actor_verified: boolean;
  report_webhooks_verified: boolean;
  frappe_reachable: boolean;
  owned_failures: {
    failed_events: number;
    failed_sync: number;
    pending_sync: number;
    missing_reports: number;
    control_failures: number;
  } | null;
  drift_reasons: string[];
  api_error: string | null;
  frappe_error: string | null;
}

export interface OperationalStatus {
  status: "ok" | "degraded";
  generated_at: string;
  heartbeat: null | {
    day: string;
    ran_at: string;
    reconciled: boolean;
    dead_letter_open_at_run: number;
    age_seconds: number | null;
    fresh: boolean;
    freshness_window_hours: number;
  };
  counts: {
    open_dead_letters: number;
    pending: number;
    stuck: number;
    frappe_errors: number;
    replay_failed: number;
    replay_stuck: number;
  };
  recent_audit_failures: {
    window_hours: number;
    entries: store.AuditFailureRecord[];
  };
  quickbooks_receipts: {
    available: boolean;
    last_received_at: string | null;
    age_seconds: number | null;
    fresh: boolean | null;
    freshness_window_hours: number;
    events_count: number | null;
    replay_count: number | null;
  };
  quickbooks_final_invoices: {
    outbound_pending: number;
    outbound_uncertain: number;
    outbound_failed: number;
    inbound_pending: number;
    inbound_rejected: number;
    unresolved_reconciliation: number;
    connection_uncertain: number;
  };
  /** Evidence only — a stale cron never moves `status`. The gate lives in `/ready?scope=ops`. */
  crons: CronLivenessEntry[];
}

export type OwnerRuntimeCheckId =
  | "owned_persistence"
  | "queue"
  | "core_auth"
  | "provider_delivery"
  | "office_bff"
  | "customer_portal"
  | "production_schedule"
  | "public_estimate"
  | "newo";

/** Browser-safe owner/ops projection of the privileged runtime probes. */
export interface OwnerRuntimeReadModel {
  version: 1;
  read_model_generated_at: string;
  status: "ready" | "attention";
  readiness: {
    status: ReadinessReport["status"];
    checks: Array<{ id: OwnerRuntimeCheckId; ok: boolean }>;
  };
  operations: {
    status: OperationalStatus["status"];
    heartbeat: null | {
      ran_at: string;
      reconciled: boolean;
      fresh: boolean;
      age_seconds: number | null;
    };
    counts: OperationalStatus["counts"];
    audit_failures_observed: number;
    audit_failure_window_hours: number;
    quickbooks_receipts: {
      available: boolean;
      fresh: boolean | null;
      age_seconds: number | null;
      events_count: number | null;
      replay_count: number | null;
    };
    quickbooks_final_invoices: OperationalStatus["quickbooks_final_invoices"];
  };
}

export async function getReadiness(env: Env): Promise<ReadinessReport> {
  const runtime = env as unknown as Record<string, unknown>;
  const db = runtime.DB as { prepare?: unknown } | undefined;
  const raw = runtime.RAW as { put?: unknown } | undefined;
  const queue = runtime.JN_QUEUE as { send?: unknown; sendBatch?: unknown } | undefined;
  const measurementQueue = runtime.MEASUREMENT_QUEUE as { send?: unknown } | undefined;
  const extended = env as AppEnv & ExtendedEnv & PublicEstimatorEnv;

  const checks: ReadinessReport["checks"] = {
    d1: false,
    schema: false,
    raw_store_binding: typeof raw?.put === "function",
    queue_binding: typeof queue?.send === "function" && typeof queue?.sendBatch === "function" &&
      typeof measurementQueue?.send === "function",
    auth_configuration: nonEmpty(env.INGEST_TOKEN) && nonEmpty(env.ADMIN_TOKEN),
    notification_configuration:
      nonEmpty(env.GOOGLE_SERVICE_ACCOUNT_JSON) && nonEmpty(env.FROM_EMAIL) &&
      nonEmpty(env.OWNER_ALERT_EMAIL) && nonEmpty(env.BACKUP_ALERT_EMAIL),
    jobnimbus_configuration: env.JOBNIMBUS_ENABLED !== "true" || nonEmpty(env.JOBNIMBUS_API_KEY),
    // Frappe is leftover projection. Default readiness must not require it just
    // because the office BFF or portal is on. Creds are required only when an
    // operator explicitly switches the leftover rail on.
    frappe_configuration: String(extended.ERPNEXT_ENABLED ?? "false") !== "true" || (
      nonEmpty(extended.ERPNEXT_BASE_URL) &&
      nonEmpty(extended.ERPNEXT_API_KEY) &&
      nonEmpty(extended.ERPNEXT_API_SECRET)
    ),
    app_bff_configuration: appBffConfigured(extended),
    customer_portal_configuration: customerPortalConfigured(extended),
    production_schedule_configuration: productionScheduleConfigured(extended),
    // A rail whose dedicated credential was never issued answers a driver's pre-trip
    // inspection with a 502 while every other check stays green - the ELEC-40 dead-rail
    // class one level down. Surface it here instead.
    rail_credential_isolation: railCredentialIsolationConfigured(extended),
    public_estimate_configuration: publicEstimateConfigured(extended),
    measurement_ocr_configuration: measurementPdfOcrConfigured(env),
    newo_enabled: true,
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
  };

  if (typeof db?.prepare === "function") {
    try {
      checks.schema = await store.checkDatabaseReadiness(env);
      checks.d1 = true;
    } catch {
      checks.d1 = false;
      checks.schema = false;
    }
  }

  const newo = await getNewoReadiness(env, checks.d1 && checks.schema);
  checks.newo_enabled = !newo.required || newo.enabled;
  checks.newo_webhook_credentials = !newo.required || newo.webhook_credentials_configured;
  checks.newo_api_authentication = !newo.required || newo.api_authenticated;
  checks.newo_production_actor = !newo.required || newo.production_actor_verified;
  checks.newo_report_webhook_match = !newo.required || newo.report_webhooks_verified;
  checks.newo_configuration_drift = !newo.required || newo.drift_reasons.length === 0;
  checks.newo_queue_binding = !newo.required || newo.queue_binding_ready;
  checks.newo_dlq_state = !newo.required || newo.dlq_clear;
  checks.newo_frappe_readiness = !newo.required || newo.frappe_reachable;
  checks.newo_jobnimbus_bridge = !newo.required || newo.jobnimbus_bridge_ready;
  checks.newo_booking_mode = !newo.required || newo.booking_mode_ready;

  const frappeProjectionReady = nonEmpty(extended.ERPNEXT_BASE_URL) &&
    nonEmpty(extended.ERPNEXT_API_KEY) &&
    nonEmpty(extended.ERPNEXT_API_SECRET);
  const verdicts = readinessVerdicts(checks, { frappe_projection_ready: frappeProjectionReady });
  return { ...verdicts, status: verdicts.ok ? "ready" : "not_ready", checks, newo };
}

/** Named planes stay isolated. Default `ok` is the office operating plane, not every leftover rail. */
export function readinessVerdicts(
  checks: ReadinessReport["checks"],
  extras: { frappe_projection_ready?: boolean } = {},
): Pick<ReadinessReport,
  "ok" | "core_ok" | "owned_core_ok" | "office_operating_plane_ok" | "projection_rails_ok"> {
  const allReady = (names: readonly ReadinessCheckName[]) => names.every((name) => checks[name]);
  const ownedCoreOk = allReady(OWNED_CORE_CHECKS);
  const officeOperatingPlaneOk = allReady(OFFICE_OPERATING_PLANE_CHECKS);
  const frappeProjectionReady = extras.frappe_projection_ready ?? checks.frappe_configuration;
  return {
    ok: officeOperatingPlaneOk,
    core_ok: ownedCoreOk,
    owned_core_ok: ownedCoreOk,
    office_operating_plane_ok: officeOperatingPlaneOk,
    projection_rails_ok: ownedCoreOk && frappeProjectionReady && checks.newo_frappe_readiness,
  };
}

const WATCHDOG_EXCEPTION_THRESHOLD = 5;

/** Pure alert policy: what is worth an owner email. */
export function watchdogFindings(input: {
  coreOk: boolean;
  failedCoreChecks: string[];
  exceptionCount: number;
  deltaFailures24h: number;
}): string[] {
  const findings: string[] = [];
  if (!input.coreOk) {
    findings.push(
      `core readiness failing: ${input.failedCoreChecks.join(", ") || "unknown check"}`,
    );
  }
  if (input.exceptionCount >= WATCHDOG_EXCEPTION_THRESHOLD)
    findings.push(`measurement exception backlog at ${input.exceptionCount}`);
  if (input.deltaFailures24h > 0)
    findings.push(`${input.deltaFailures24h} failed cross-source comparison(s) in the last 24h`);
  return findings;
}

/** Keep retries in one UTC check window identical, while a persistent fault alerts again later. */
export function watchdogAlertHtml(findings: string[], now: Date): string {
  const checkWindow = now.toISOString().slice(0, 10);
  const items = findings.map((finding) => `<li>${finding}</li>`).join("");
  return `<p>The daily self-check found:</p><ul>${items}</ul>` +
    `<p>UTC check window: ${checkWindow}.</p>` +
    `<p>Diagnostics: /ready and /admin/measurements/exceptions and /admin/measurements/deltas (admin token).</p>`;
}

/**
 * Daily self-observation: compute the signals the system already produces and
 * email the owner ONLY when something needs attention (alert, not newsletter).
 * Every failure path degrades to logging; the watchdog itself must never throw
 * into the cron tick.
 */
export async function runOwnerWatchdog(
  env: Env,
  now = new Date(),
): Promise<{ alerted: boolean; findings: string[] }> {
  const readiness = await getReadiness(env);
  const failedCoreChecks = OWNED_CORE_CHECKS.filter((name) => !readiness.checks[name]);
  let exceptionCount = 0;
  try {
    exceptionCount = (await listMeasurementIntakeExceptions(env, 50)).length;
  } catch (error) {
    opsLog({ at: "owner_watchdog_exceptions", error: String(error).slice(0, 200) });
  }
  let deltaFailures24h = 0;
  try {
    deltaFailures24h = await countFailedDeltasSince(
      env,
      new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    );
  } catch (error) {
    opsLog({ at: "owner_watchdog_deltas", error: String(error).slice(0, 200) });
  }
  const findings = watchdogFindings({
    coreOk: readiness.core_ok,
    failedCoreChecks,
    exceptionCount,
    deltaFailures24h,
  });
  if (!findings.length) return { alerted: false, findings };
  opsLog({ at: "owner_watchdog", findings });

  const ownerEmail = ((env as { OWNER_ALERT_EMAIL?: string }).OWNER_ALERT_EMAIL ?? "").trim();
  if (!ownerEmail || !gmailConfigured(env)) return { alerted: false, findings };
  try {
    await sendGmail(
      env,
      ownerEmail,
      "IronWrap bus watchdog: attention required",
      watchdogAlertHtml(findings, now),
    );
    return { alerted: true, findings };
  } catch (error) {
    opsLog({ at: "owner_watchdog_email", error: String(error).slice(0, 200) });
    return { alerted: false, findings };
  }
}

const opsLog = (o: Record<string, unknown>) => console.log(JSON.stringify(o));

export async function buildOwnerRuntimeReadModel(
  env: Env,
  now = new Date(),
): Promise<OwnerRuntimeReadModel> {
  const [readiness, operations] = await Promise.all([
    getReadiness(env),
    getOperationalStatus(env, 20, now),
  ]);
  const checks: OwnerRuntimeReadModel["readiness"]["checks"] = [
    {
      id: "owned_persistence",
      ok: readiness.checks.d1 && readiness.checks.schema && readiness.checks.raw_store_binding,
    },
    { id: "queue", ok: readiness.checks.queue_binding },
    { id: "core_auth", ok: readiness.checks.auth_configuration },
    {
      id: "provider_delivery",
      ok: readiness.checks.notification_configuration && readiness.checks.jobnimbus_configuration &&
        readiness.checks.measurement_ocr_configuration,
    },
    {
      // Both field-capture rails are BFF surfaces, so their credential isolation belongs to
      // this bucket rather than a new public check id: an owner reading "office BFF: ok"
      // must not be told that while a driver's fleet capture is refusing every request.
      id: "office_bff",
      ok: readiness.checks.app_bff_configuration && readiness.checks.rail_credential_isolation,
    },
    { id: "customer_portal", ok: readiness.checks.customer_portal_configuration },
    { id: "production_schedule", ok: readiness.checks.production_schedule_configuration },
    { id: "public_estimate", ok: readiness.checks.public_estimate_configuration },
    {
      id: "newo",
      ok: readiness.checks.newo_enabled &&
        readiness.checks.newo_webhook_credentials &&
        readiness.checks.newo_api_authentication &&
        readiness.checks.newo_production_actor &&
        readiness.checks.newo_report_webhook_match &&
        readiness.checks.newo_configuration_drift &&
        readiness.checks.newo_queue_binding &&
        readiness.checks.newo_dlq_state &&
        readiness.checks.newo_jobnimbus_bridge &&
        readiness.checks.newo_booking_mode,
    },
  ];

  return {
    version: 1,
    read_model_generated_at: operations.generated_at,
    status: readiness.ok && operations.status === "ok" ? "ready" : "attention",
    readiness: { status: readiness.status, checks },
    operations: {
      status: operations.status,
      heartbeat: operations.heartbeat
        ? {
          ran_at: operations.heartbeat.ran_at,
          reconciled: operations.heartbeat.reconciled,
          fresh: operations.heartbeat.fresh,
          age_seconds: operations.heartbeat.age_seconds,
        }
        : null,
      counts: operations.counts,
      audit_failures_observed: operations.recent_audit_failures.entries.length,
      audit_failure_window_hours: operations.recent_audit_failures.window_hours,
      quickbooks_receipts: {
        available: operations.quickbooks_receipts.available,
        fresh: operations.quickbooks_receipts.fresh,
        age_seconds: operations.quickbooks_receipts.age_seconds,
        events_count: operations.quickbooks_receipts.events_count,
        replay_count: operations.quickbooks_receipts.replay_count,
      },
      quickbooks_final_invoices: operations.quickbooks_final_invoices,
    },
  };
}

async function getNewoReadiness(env: Env, databaseReady: boolean): Promise<NewoReadinessDetail> {
  const runtime = env as AppEnv & ExtendedEnv;
  const enabled = String(runtime.NEWO_ENABLED ?? "false") === "true";
  const required = String(runtime.NEWO_PRODUCTION_REQUIRED ?? "false") === "true" || enabled;
  const bookingMode = String(runtime.NEWO_BOOKING_MODE ?? "request_only");
  const webhookCredentials = nonEmpty(runtime.NEWO_WEBHOOK_TOKEN) && nonEmpty(runtime.NEWO_BOOKING_TOKEN);
  const queue = runtime.NEWO_QUEUE as unknown as { send?: unknown; sendBatch?: unknown } | undefined;
  const queueBinding = typeof queue?.send === "function" && typeof queue?.sendBatch === "function";
  const jobNimbusBridge = String(env.JOBNIMBUS_ENABLED ?? "false") !== "true" || nonEmpty(env.JOBNIMBUS_API_KEY);
  const confirmed = bookingMode === "confirmed";
  const bookingModeReady = bookingMode === "request_only" ||
    (confirmed && String(runtime.NEWO_JOBNIMBUS_BOOKING_PROVEN ?? "false") === "true");
  const driftReasons = required ? newoConfigurationDrift(runtime) : [];
  let apiAuthenticated = false;
  let productionActorVerified = false;
  let reportWebhooksVerified = false;
  let apiError: string | null = null;
  let frappeReachable = false;
  let frappeError: string | null = null;
  let counts: Awaited<ReturnType<typeof newoOperationalCounts>> | null = null;
  let openDeadLetters: number | null = null;

  if (required && enabled && nonEmpty(runtime.NEWO_API_KEY) && nonEmpty(runtime.NEWO_API_BASE_URL)) {
    try {
      const client = new NewoApiClient(newoClientConfigFromEnv(env));
      await client.authenticate();
      apiAuthenticated = true;
      if (nonEmpty(runtime.NEWO_AGENT_ID)) {
        const actor = await client.getAgentActor(String(runtime.NEWO_AGENT_ID));
        productionActorVerified = newoObject(actor)?.id === runtime.NEWO_AGENT_ID;
      }
      if (nonEmpty(runtime.NEWO_REPORT_WEBHOOK_ID) && nonEmpty(runtime.NEWO_HANDOFF_WEBHOOK_ID)) {
        const webhooks = newoArray(await client.listOutgoingWebhooks());
        reportWebhooksVerified = webhookMatches(
          webhooks,
          String(runtime.NEWO_REPORT_WEBHOOK_ID),
          String(runtime.NEWO_REPORT_WEBHOOK_URL ?? ""),
        ) && webhookMatches(
          webhooks,
          String(runtime.NEWO_HANDOFF_WEBHOOK_ID),
          String(runtime.NEWO_HANDOFF_WEBHOOK_URL ?? ""),
        );
      }
    } catch (error) {
      apiError = safeNewoError(error);
    }
  }

  if (required) {
    const frappe = await checkFrappeReachability(runtime);
    frappeReachable = frappe.ok;
    frappeError = frappe.error;
    if (databaseReady) {
      try {
        [counts, openDeadLetters] = await Promise.all([
          newoOperationalCounts(env),
          countOpenNewoDeadLetters(env),
        ]);
      } catch {
        counts = null;
        openDeadLetters = null;
      }
    }
  }
  const dlqClear = counts !== null && openDeadLetters !== null && openDeadLetters === 0 &&
    counts.failed_events === 0 && counts.failed_sync === 0 && counts.missing_reports === 0 &&
    counts.control_failures === 0;

  return {
    required,
    enabled,
    booking_mode: bookingMode,
    outbound_enabled: String(runtime.NEWO_OUTBOUND_ENABLED ?? "false") === "true",
    control_write_enabled: String(runtime.NEWO_CONTROL_WRITE_ENABLED ?? "false") === "true",
    webhook_credentials_configured: webhookCredentials,
    queue_binding_ready: queueBinding,
    dlq_clear: dlqClear,
    jobnimbus_bridge_ready: jobNimbusBridge,
    booking_mode_ready: bookingModeReady,
    api_authenticated: apiAuthenticated,
    production_actor_verified: productionActorVerified,
    report_webhooks_verified: reportWebhooksVerified,
    frappe_reachable: frappeReachable,
    owned_failures: counts ? {
      failed_events: counts.failed_events,
      failed_sync: counts.failed_sync,
      pending_sync: counts.pending_sync,
      missing_reports: counts.missing_reports,
      control_failures: counts.control_failures,
    } : null,
    drift_reasons: driftReasons,
    api_error: apiError,
    frappe_error: frappeError,
  };
}

function newoConfigurationDrift(env: AppEnv & ExtendedEnv): string[] {
  const reasons: string[] = [];
  const requiredText: Array<[keyof ExtendedEnv, string]> = [
    ["NEWO_EXPECTED_CONFIG_VERSION", "expected_config_version_missing"],
    ["NEWO_PROJECT_ID", "project_id_missing"],
    ["NEWO_AGENT_ID", "production_agent_id_missing"],
    ["NEWO_REPORT_WEBHOOK_ID", "report_webhook_id_missing"],
    ["NEWO_REPORT_WEBHOOK_URL", "report_webhook_url_missing"],
    ["NEWO_HANDOFF_WEBHOOK_ID", "handoff_webhook_id_missing"],
    ["NEWO_HANDOFF_WEBHOOK_URL", "handoff_webhook_url_missing"],
    ["NEWO_KB_VERSION", "kb_version_missing"],
    ["NEWO_PHONE_NUMBER", "phone_number_missing"],
    ["NEWO_USAGE_LIMIT_MINUTES", "usage_limit_missing"],
  ];
  for (const [key, reason] of requiredText) if (!nonEmpty(env[key])) reasons.push(reason);
  for (const [key, reason] of [
    ["NEWO_TOOL_SCHEMA_SHA256", "tool_schema_hash_invalid"],
    ["NEWO_REPORT_SCHEMA_SHA256", "report_schema_hash_invalid"],
    ["NEWO_KB_SHA256", "kb_hash_invalid"],
  ] as const) {
    if (!/^[0-9a-f]{64}$/.test(String(env[key] ?? ""))) reasons.push(reason);
  }
  if (String(env.NEWO_EXPECTED_CONFIG_VERSION ?? "") !== "newo.production.v1") {
    reasons.push("expected_config_version_mismatch");
  }
  if (String(env.NEWO_ENABLED_CHANNELS ?? "") !== "voice") reasons.push("enabled_channels_mismatch");
  if (String(env.NEWO_OUTBOUND_ENABLED ?? "false") !== "false") reasons.push("outbound_launch_state_mismatch");
  if (String(env.NEWO_R2_LIFECYCLE_PROVEN ?? "false") !== "true") {
    reasons.push("r2_newo_lifecycle_unproven");
  }
  const usageLimit = Number(env.NEWO_USAGE_LIMIT_MINUTES ?? "0");
  const alertPercent = Number(env.NEWO_USAGE_ALERT_PERCENT ?? "0");
  if (!Number.isFinite(usageLimit) || usageLimit <= 0) reasons.push("usage_limit_invalid");
  if (!Number.isFinite(alertPercent) || alertPercent < 1 || alertPercent > 100) {
    reasons.push("usage_alert_percent_invalid");
  }
  if (!nonEmpty(env.NEWO_CONTROL_SIGNING_SECRET)) reasons.push("control_signing_secret_missing");
  return [...new Set(reasons)];
}

async function checkFrappeReachability(env: AppEnv & ExtendedEnv): Promise<{ ok: boolean; error: string | null }> {
  if (String(env.ERPNEXT_ENABLED ?? "false") !== "true" || !nonEmpty(env.ERPNEXT_BASE_URL) ||
    !nonEmpty(env.ERPNEXT_API_KEY) || !nonEmpty(env.ERPNEXT_API_SECRET)) {
    return { ok: false, error: "frappe_disabled_or_unconfigured" };
  }
  let base: URL;
  try {
    base = new URL(String(env.ERPNEXT_BASE_URL));
  } catch {
    return { ok: false, error: "frappe_base_url_invalid" };
  }
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    return { ok: false, error: "frappe_base_url_invalid" };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(`${base.toString().replace(/\/+$/, "")}/api/method/ping`, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        authorization: `token ${env.ERPNEXT_API_KEY}:${env.ERPNEXT_API_SECRET}`,
      },
    });
    return response.ok ? { ok: true, error: null } : { ok: false, error: `frappe_http_${response.status}` };
  } catch {
    return { ok: false, error: controller.signal.aborted ? "frappe_timeout" : "frappe_unreachable" };
  } finally {
    clearTimeout(timeout);
  }
}

export async function getNewoOpenIncidentCount(env: Env): Promise<number | null> {
  const runtime = env as AppEnv & ExtendedEnv;
  if (String(runtime.ERPNEXT_ENABLED ?? "false") !== "true" || !nonEmpty(runtime.ERPNEXT_BASE_URL) ||
    !nonEmpty(runtime.ERPNEXT_API_KEY) || !nonEmpty(runtime.ERPNEXT_API_SECRET)) return null;
  let base: URL;
  try {
    base = new URL(String(runtime.ERPNEXT_BASE_URL));
  } catch {
    return null;
  }
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) return null;
  const query = new URLSearchParams({
    fields: JSON.stringify(["name"]),
    filters: JSON.stringify([
      ["Automation Incident", "source_system", "=", "Newo"],
      ["Automation Incident", "status", "in", ["Open", "Acknowledged"]],
    ]),
    limit_page_length: "501",
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(
      `${base.toString().replace(/\/+$/, "")}/api/resource/Automation%20Incident?${query}`,
      {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          authorization: `token ${runtime.ERPNEXT_API_KEY}:${runtime.ERPNEXT_API_SECRET}`,
        },
      },
    );
    if (!response.ok) return null;
    const body = await response.json() as { data?: unknown };
    if (!Array.isArray(body.data) || body.data.length > 500) return null;
    return body.data.length;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function newoArray(value: NewoJson): Array<Record<string, NewoJson>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, NewoJson> => newoObject(item) !== null)
    : [];
}

function newoObject(value: NewoJson): Record<string, NewoJson> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, NewoJson>
    : null;
}

function webhookMatches(webhooks: Array<Record<string, NewoJson>>, id: string, url: string): boolean {
  return webhooks.some((webhook) => webhook.id === id && webhook.url === url);
}

function safeNewoError(error: unknown): string {
  const value = error instanceof Error ? error.message : "newo_api_error";
  return /^newo_[a-z0-9_:.-]+$/.test(value) ? value : "newo_api_error";
}

function productionScheduleConfigured(env: AppEnv): boolean {
  // Numeric schedule values have safe defaults in wrangler.jsonc. A rail is
  // intentionally disabled only when every primary credential/identity input
  // is blank; any supplied primary input must form a complete, enabled BFF
  // configuration before /ready can be green.
  const primaryInputs = [
    env.APP_PRODUCTION_SCHEDULE_BROKER_URL,
    env.APP_PRODUCTION_SCHEDULE_BROKER_KEY_ID,
    env.APP_PRODUCTION_SCHEDULE_APPROVER_ID,
    env.PRODUCTION_SCHEDULE_BROKER_SHARED_SECRET,
  ];
  if (!primaryInputs.some(nonEmpty)) return true;
  return String(env.APP_BFF_ENABLED) === "true" &&
    appBffConfigured(env) &&
    productionScheduleApprovalBrokerConfig(env) !== null &&
    productionScheduleApprovalDecisionConfig(env) !== null;
}

export async function getOperationalStatus(
  env: Env,
  auditLimit: number,
  now = new Date(),
): Promise<OperationalStatus> {
  const generatedAt = now.toISOString();
  const thresholdMin = boundedPositiveNumber(env.STUCK_THRESHOLD_MIN, 15, 1, 24 * 60);
  const stuckCutoff = new Date(now.getTime() - thresholdMin * 60_000).toISOString();
  const auditSince = new Date(now.getTime() - AUDIT_FAILURE_WINDOW_HOURS * 3_600_000).toISOString();

  const [heartbeatRow, openDeadLetters, envelopeCounts, replayCounts, auditFailures, qbReceipt, qbFinalInvoices, cronLiveness] = await Promise.all([
    store.getLatestHeartbeat(env),
    store.countOpenDeadLetter(env),
    store.getOperationalEnvelopeCounts(env, stuckCutoff),
    store.getReplayOperationalCounts(env, stuckCutoff),
    store.listRecentAuditFailures(env, auditSince, auditLimit),
    store.getLatestQuickBooksWebhookReceipt(env),
    quickBooksFinalInvoiceOperationalCounts(env as AppEnv),
    getCronLiveness(env, now),
  ]);

  const heartbeatAge = ageSeconds(heartbeatRow?.ran_at ?? null, now.getTime());
  const heartbeat = heartbeatRow ? {
    day: heartbeatRow.day,
    ran_at: heartbeatRow.ran_at,
    reconciled: heartbeatRow.reconciled === 1,
    dead_letter_open_at_run: Number(heartbeatRow.dead_letter_open),
    age_seconds: heartbeatAge,
    fresh: heartbeatAge !== null && heartbeatAge <= HEARTBEAT_FRESHNESS_HOURS * 3_600,
    freshness_window_hours: HEARTBEAT_FRESHNESS_HOURS,
  } : null;

  const qbAge = ageSeconds(qbReceipt?.last_seen_at ?? null, now.getTime());
  const quickbooks: OperationalStatus["quickbooks_receipts"] = qbReceipt ? {
    available: true,
    last_received_at: qbReceipt.last_seen_at,
    age_seconds: qbAge,
    fresh: qbAge !== null && qbAge <= QB_RECEIPT_FRESHNESS_HOURS * 3_600,
    freshness_window_hours: QB_RECEIPT_FRESHNESS_HOURS,
    events_count: Number(qbReceipt.events_count),
    replay_count: Number(qbReceipt.replay_count),
  } : {
    available: false,
    last_received_at: null,
    age_seconds: null,
    fresh: null,
    freshness_window_hours: QB_RECEIPT_FRESHNESS_HOURS,
    events_count: null,
    replay_count: null,
  };

  const degraded = !heartbeat || !heartbeat.fresh || !heartbeat.reconciled ||
    openDeadLetters > 0 || envelopeCounts.stuck > 0 || envelopeCounts.frappe_errors > 0 ||
    replayCounts.failed > 0 || replayCounts.stuck > 0 || auditFailures.length > 0 ||
    Object.values(qbFinalInvoices).some((count) => count > 0);

  return {
    status: degraded ? "degraded" : "ok",
    generated_at: generatedAt,
    heartbeat,
    counts: {
      open_dead_letters: openDeadLetters,
      pending: envelopeCounts.pending,
      stuck: envelopeCounts.stuck,
      frappe_errors: envelopeCounts.frappe_errors,
      replay_failed: replayCounts.failed,
      replay_stuck: replayCounts.stuck,
    },
    recent_audit_failures: {
      window_hours: AUDIT_FAILURE_WINDOW_HOURS,
      entries: auditFailures,
    },
    quickbooks_receipts: quickbooks,
    quickbooks_final_invoices: qbFinalInvoices,
    crons: cronLiveness.crons,
  };
}

export type ReplayRequestExecution =
  | {
    kind: "outcome";
    replayed: boolean;
    matched: number;
    requeued: number;
    envelope_ids: string[];
  }
  | { kind: "run_id_conflict" }
  | { kind: "in_progress" };

/** Run-id idempotency wrapper around the envelope-level replay CAS. */
export async function executeReplayRequest(
  env: Env,
  selection: { envelopeId?: string; all: boolean },
  approval: ReplayApprovalContext,
): Promise<ReplayRequestExecution> {
  const identity: store.ReplayRequestIdentity = {
    run_id: approval.run_id,
    selection: selection.all ? "bulk" : "targeted",
    envelope_id: selection.all ? null : selection.envelopeId ?? null,
    approved_by: approval.approved_by,
    reason: approval.reason,
  };
  const claim = await store.claimReplayRequest(env, identity);
  if (claim.kind === "conflict") return { kind: "run_id_conflict" };
  if (claim.kind === "in_progress") return { kind: "in_progress" };
  if (claim.kind === "completed") {
    return {
      kind: "outcome",
      replayed: true,
      matched: claim.matched,
      requeued: claim.requeued,
      envelope_ids: selection.all ? [] : [selection.envelopeId!],
    };
  }

  let outcome: Awaited<ReturnType<typeof replayDeadLetters>>;
  try {
    outcome = await replayDeadLetters(env, selection, approval);
  } catch (err) {
    await store.failReplayRequest(env, approval.run_id, String(err)).catch(() => {});
    throw err;
  }

  const targetedFailure = !selection.all && outcome.matched === 0
    ? "dead_letter_not_replayable"
    : !selection.all && outcome.requeued === 0
    ? "dead_letter_replay_conflict"
    : null;
  if (targetedFailure) {
    await store.failReplayRequest(env, approval.run_id, targetedFailure);
    return { kind: "outcome", replayed: false, ...outcome };
  }

  if (!await store.completeReplayRequest(env, approval.run_id, outcome.matched, outcome.requeued)) {
    // Queue publication already completed. Keep the ledger non-retryable instead of risking a
    // duplicate external side effect; the stale-running status is visible in /admin/status.
    throw new Error("replay_request_finalize_conflict");
  }
  return { kind: "outcome", replayed: false, ...outcome };
}

/**
 * Non-secret runtime overrides for the automated dead-letter sweep.
 *
 * Read off `Env` by cast rather than declared in `wrangler.jsonc`: every value below has a working
 * default, so the sweep needs no production configuration change to ship, and the five-minute cron
 * it hangs off is already registered (`wrangler.jsonc` `triggers.crons`).
 */
type DeadLetterSweepEnv = Env & {
  DEAD_LETTER_AUTO_REPLAY_ENABLED?: string;
  DEAD_LETTER_AUTO_REPLAY_BACKOFF_MIN?: string;
  DEAD_LETTER_AUTO_REPLAY_MAX_ATTEMPTS?: string;
  DEAD_LETTER_AUTO_REPLAY_SCAN_LIMIT?: string;
};

export interface DeadLetterSweepResult {
  /** Open dead-letter envelopes examined this tick. */
  scanned: number;
  /** Of those, the ones whose backoff had elapsed and whose attempt cap was not yet reached. */
  due: number;
  /** Envelopes actually re-queued this tick. */
  replayed: number;
  /** Due envelopes another replay (admin or a concurrent tick) had already claimed. */
  conflicted: number;
  /** Due envelopes whose replay threw; the ledger row is left failed and retried next tick. */
  failed: number;
  /** Envelopes at or over the attempt cap: automatic recovery is done, manual replay still works. */
  given_up: number;
  /** Envelopes the sweep replayed that have since reached a settled, non-dead status. */
  recovered: number;
  /** True when the scan window filled, so `scanned`/`given_up` undercount a larger backlog. */
  truncated: boolean;
}

const DEAD_LETTER_SWEEP_BACKOFF_MIN = 5;
const DEAD_LETTER_SWEEP_MAX_ATTEMPTS = 5;
const DEAD_LETTER_SWEEP_SCAN_LIMIT = 100;
/** Caps the doubling so a long-dead envelope cannot overflow the due-time arithmetic. */
const DEAD_LETTER_SWEEP_MAX_BACKOFF_SHIFT = 10;

/** When an envelope with `attempts` sweep replays behind it may be replayed again. */
export function deadLetterReplayDueAt(
  clockIso: string,
  attempts: number,
  backoffMin: number,
): number | null {
  const clock = Date.parse(clockIso);
  if (Number.isNaN(clock)) return null;
  const shift = Math.min(Math.max(attempts, 0), DEAD_LETTER_SWEEP_MAX_BACKOFF_SHIFT);
  return clock + backoffMin * 60_000 * 2 ** shift;
}

/**
 * Automated dual-surface reconciliation: re-drive dead-letter envelopes on the five-minute cron
 * with exponential backoff and a bounded attempt cap, so a Frappe/JobNimbus outage heals itself
 * instead of waiting for an admin to notice and hit `POST /admin/replay` by hand.
 *
 * Attempts are counted from the `replay_requests` ledger, not `envelopes.attempts`: that column is
 * already owned by `bumpAttempt` (intake/bridge) and `bumpErpNextMirrorAttempt` (mirror), so
 * reusing it would conflate three retry semantics and let unrelated traffic reset the cap.
 *
 * The cap is per outage EPISODE, not per envelope lifetime: `listAutoReplayCandidates` counts only
 * the ledger rows booked since the envelope's currently open dead-letter run began. An envelope
 * that exhausted its budget in one outage, was recovered, and dies again months later for an
 * unrelated reason gets the full budget again — otherwise one bad day would make an envelope
 * manual-only forever, which is the opposite of "the outage heals itself".
 *
 * Reaching the cap ends AUTOMATIC recovery only. The envelope stays `dead` with its dead-letter row
 * open, so `POST /admin/replay` can still replay it — which is the whole point of the cap.
 */
export async function sweepDeadLetterAutoReplay(env: Env): Promise<DeadLetterSweepResult> {
  const runtime = env as DeadLetterSweepEnv;
  const empty: DeadLetterSweepResult = {
    scanned: 0,
    due: 0,
    replayed: 0,
    conflicted: 0,
    failed: 0,
    given_up: 0,
    recovered: 0,
    truncated: false,
  };
  if (String(runtime.DEAD_LETTER_AUTO_REPLAY_ENABLED ?? "true") === "false") return empty;

  const backoffMin = boundedPositiveNumber(
    runtime.DEAD_LETTER_AUTO_REPLAY_BACKOFF_MIN,
    DEAD_LETTER_SWEEP_BACKOFF_MIN,
    1,
    24 * 60,
  );
  const maxAttempts = boundedPositiveNumber(
    runtime.DEAD_LETTER_AUTO_REPLAY_MAX_ATTEMPTS,
    DEAD_LETTER_SWEEP_MAX_ATTEMPTS,
    1,
    50,
  );
  const scanLimit = boundedPositiveNumber(
    runtime.DEAD_LETTER_AUTO_REPLAY_SCAN_LIMIT,
    DEAD_LETTER_SWEEP_SCAN_LIMIT,
    1,
    1_000,
  );

  const candidates = await store.listAutoReplayCandidates(env, scanLimit);
  if (candidates.length === 0) return empty;

  const nowMs = Date.now();
  const result: DeadLetterSweepResult = {
    ...empty,
    scanned: candidates.length,
    truncated: candidates.length >= scanLimit,
  };

  for (const candidate of candidates) {
    if (candidate.attempts >= maxAttempts) {
      result.given_up++;
      continue;
    }
    // Before the first automatic attempt the envelope's own death is the clock, so a fresh
    // dead-letter waits out one backoff window rather than being replayed into a live outage.
    const dueAt = deadLetterReplayDueAt(
      candidate.last_attempt_at ?? candidate.dead_since,
      candidate.attempts,
      backoffMin,
    );
    if (dueAt !== null && nowMs < dueAt) continue;
    result.due++;

    const attempt = candidate.attempts + 1;
    try {
      const execution = await executeReplayRequest(
        env,
        // Targeted, never bulk: `selection = 'bulk'` forces `envelope_id IS NULL` (migration 0010
        // CHECK), which would erase the per-envelope attribution the attempt cap is counted from.
        { envelopeId: candidate.envelope_id, all: false },
        {
          run_id: deadLetterSweepRunId(candidate.envelope_id, candidate.dead_since, attempt),
          approved_by: store.DEAD_LETTER_SWEEP_APPROVER,
          reason: deadLetterSweepReason(candidate.envelope_id, attempt, maxAttempts),
        },
      );
      if (execution.kind === "outcome" && !execution.replayed && execution.requeued > 0) {
        result.replayed++;
      } else {
        // `run_id_conflict`, `in_progress`, a cached completed outcome, or requeued === 0: another
        // replay owns this envelope. Not a failure, and the ledger row it booked is excluded from
        // the attempt count, so the race costs the envelope nothing.
        result.conflicted++;
      }
    } catch (error) {
      result.failed++;
      opsLog({
        at: "dead_letter_auto_replay_error",
        envelope_id: candidate.envelope_id,
        attempt,
        error: String(error).slice(0, 500),
      });
    }
  }

  result.recovered = await store.countRecoveredAutoReplays(env).catch(() => 0);
  return result;
}

/**
 * A run id unique per (envelope, episode, attempt).
 *
 * `claimReplayRequest` keys on `run_id`, so a reused id would return the CACHED outcome and queue
 * nothing at all -- a sweep that silently no-ops. Deriving the id from the attempt count rather
 * than from the wall clock also makes overlapping ticks safe: the loser sees `in_progress` instead
 * of publishing the envelope to the queue a second time.
 *
 * The episode stamp is what keeps both of those true at once (ELEC-137). Attempt numbers restart
 * at 1 for each new outage episode, so `(envelope, attempt)` alone collided across episodes: the
 * first attempt of a second outage reused the first outage's run id, read back its cached
 * `completed` outcome, and was booked as a conflict that queued nothing -- for every remaining
 * attempt, forever. That was latent only while the attempt cap still leaked across episodes and
 * never let a second episode start; scoping the cap to one episode is exactly what would have made
 * it live. `dead_since` is the episode's identity and is stable inside it (it is `MIN(ts)` over
 * open dead-letter rows, and an episode only ever gains rows until recovery closes all of them),
 * so it separates episodes without reintroducing a wall clock that would break overlapping ticks.
 */
function deadLetterSweepRunId(envelopeId: string, deadSince: string, attempt: number): string {
  const episode = deadSince.replace(/[^0-9]/g, "").slice(0, 17);
  const suffix = `-${episode}-${attempt}`;
  const head = `dls-${envelopeId}`.slice(0, 128 - suffix.length);
  return `${head}${suffix}`;
}

/** Migration 0010 CHECKs `length(reason) BETWEEN 10 AND 500`; a short reason would throw inside `waitUntil`. */
function deadLetterSweepReason(envelopeId: string, attempt: number, maxAttempts: number): string {
  return `Automated dead-letter reconciliation sweep: attempt ${attempt} of ${maxAttempts} for envelope ${envelopeId}.`
    .slice(0, 500);
}

export async function replayDeadLetters(
  env: Env,
  selection: { envelopeId?: string; all: boolean },
  approval: ReplayApprovalContext,
): Promise<{ matched: number; requeued: number; envelope_ids: string[] }> {
  const candidates = await store.listReplayableDeadEnvelopeIds(env, selection.all ? undefined : selection.envelopeId);
  const requeued: string[] = [];
  let restoreFailures = 0;

  try {
    for (let i = 0; i < candidates.length; i += QUEUE_BATCH_SIZE) {
      const claimedBatch: string[] = [];
      try {
        for (const envelopeId of candidates.slice(i, i + QUEUE_BATCH_SIZE)) {
          if (await store.markEnvelopeReplayPending(env, envelopeId)) claimedBatch.push(envelopeId);
        }
        if (claimedBatch.length === 0) continue;
        await env.JN_QUEUE.sendBatch(
          claimedBatch.map((envelopeId) => ({ body: { envelope_id: envelopeId } })),
        );
        requeued.push(...claimedBatch);
      } catch (err) {
        // D1 and Queues cannot share a transaction. Return claims from the failed/uncertain
        // batch to dead so an operator can retry immediately; a queue message that actually
        // landed remains safe because the consumer and JobNimbus handoff are idempotent.
        for (const envelopeId of claimedBatch) {
          try {
            await store.restoreEnvelopeReplayDead(env, envelopeId);
          } catch {
            restoreFailures++;
          }
        }
        throw err;
      }
    }
    const targetedFailure = !selection.all && candidates.length === 0
      ? "dead_letter_not_replayable"
      : !selection.all && requeued.length === 0
      ? "dead_letter_replay_conflict"
      : null;
    await store.recordAudit(env, {
      automation: "dead_letter_replay",
      trigger: "admin",
      envelope_id: selection.all ? null : selection.envelopeId ?? null,
      source_ids: `matched:${candidates.length},requeued:${requeued.length}`,
      action: selection.all ? "replay_all_confirmed" : "replay_targeted",
      result: targetedFailure ? "error" : "ok",
      error: targetedFailure,
      recovery_owner: targetedFailure ? env.OWNER_ALERT_EMAIL : undefined,
      run_id: approval.run_id,
      approved_by: approval.approved_by,
      reason: approval.reason,
    });
  } catch (err) {
    await store.recordAudit(env, {
      automation: "dead_letter_replay",
      trigger: "admin",
      envelope_id: selection.all ? null : selection.envelopeId ?? null,
      source_ids: `matched:${candidates.length},requeued:${requeued.length},restore_failures:${restoreFailures}`,
      action: selection.all ? "replay_all_confirmed" : "replay_targeted",
      result: "error",
      error: String(err).slice(0, 500),
      recovery_owner: env.OWNER_ALERT_EMAIL,
      run_id: approval.run_id,
      approved_by: approval.approved_by,
      reason: approval.reason,
    }).catch(() => {});
    throw err;
  }

  return { matched: candidates.length, requeued: requeued.length, envelope_ids: requeued };
}

/** Human-approval evidence required for every admin replay mutation. */
export function validateReplayApprovalContext(body: Record<string, unknown>): ReplayApprovalValidation {
  const runId = typeof body.run_id === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/.test(body.run_id.trim())
    ? body.run_id.trim()
    : null;
  const approvedBy = normalizeApprovalText(body.approved_by, 3, 128);
  const reason = normalizeApprovalText(body.reason, 10, 500);
  const fields: Array<keyof ReplayApprovalContext> = [];
  if (!runId) fields.push("run_id");
  if (!approvedBy) fields.push("approved_by");
  if (!reason) fields.push("reason");
  return fields.length > 0
    ? { ok: false, fields }
    : { ok: true, value: { run_id: runId!, approved_by: approvedBy!, reason: reason! } };
}

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeApprovalText(value: unknown, min: number, max: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length < min || normalized.length > max || /[\u0000-\u001F\u007F]/.test(normalized)) return null;
  return normalized;
}

function boundedPositiveNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function ageSeconds(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const value = Date.parse(iso);
  if (Number.isNaN(value)) return null;
  if (value - nowMs > MAX_CLOCK_SKEW_SECONDS * 1_000) return null;
  return Math.max(0, Math.floor((nowMs - value) / 1_000));
}
