// operations.ts — production-facing readiness, status, and dead-letter recovery orchestration.

import * as store from "./store.ts";
import { appBffConfigured } from "./app-auth.ts";
import { customerPortalConfigured } from "./customer-portal.ts";
import { productionScheduleApprovalDecisionConfig } from "./production-schedule-approval-authority.ts";
import { productionScheduleApprovalBrokerConfig } from "./production-schedule-approval-broker-client.ts";
import { publicEstimateConfigured, type PublicEstimatorEnv } from "./public-estimator.ts";
import type { AppEnv } from "./app-types.ts";
import { NewoApiClient, newoClientConfigFromEnv, type NewoJson } from "./newo-client.ts";
import { countOpenNewoDeadLetters, newoOperationalCounts } from "./newo-store.ts";

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
  NEWO_TRANSFER_POLICY?: string;
  NEWO_OWNER_TRANSFER_NUMBER?: string;
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
    public_estimate_configuration: boolean;
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
  };
}

export async function getReadiness(env: Env): Promise<ReadinessReport> {
  const runtime = env as unknown as Record<string, unknown>;
  const db = runtime.DB as { prepare?: unknown } | undefined;
  const raw = runtime.RAW as { put?: unknown } | undefined;
  const queue = runtime.JN_QUEUE as { send?: unknown; sendBatch?: unknown } | undefined;
  const extended = env as AppEnv & ExtendedEnv & PublicEstimatorEnv;

  const checks: ReadinessReport["checks"] = {
    d1: false,
    schema: false,
    raw_store_binding: typeof raw?.put === "function",
    queue_binding: typeof queue?.send === "function" && typeof queue?.sendBatch === "function",
    auth_configuration: nonEmpty(env.INGEST_TOKEN) && nonEmpty(env.ADMIN_TOKEN),
    notification_configuration:
      nonEmpty(env.GOOGLE_SERVICE_ACCOUNT_JSON) && nonEmpty(env.FROM_EMAIL) &&
      nonEmpty(env.OWNER_ALERT_EMAIL) && nonEmpty(env.BACKUP_ALERT_EMAIL),
    jobnimbus_configuration: env.JOBNIMBUS_ENABLED !== "true" || nonEmpty(env.JOBNIMBUS_API_KEY),
    frappe_configuration: (
      String(extended.ERPNEXT_ENABLED ?? "false") !== "true" &&
      String(extended.APP_BFF_ENABLED ?? "false") !== "true" &&
      String(extended.APP_CUSTOMER_PORTAL_ENABLED ?? "false") !== "true"
    ) || (
      nonEmpty(extended.ERPNEXT_BASE_URL) &&
      nonEmpty(extended.ERPNEXT_API_KEY) &&
      nonEmpty(extended.ERPNEXT_API_SECRET)
    ),
    app_bff_configuration: appBffConfigured(extended),
    customer_portal_configuration: customerPortalConfigured(extended),
    production_schedule_configuration: productionScheduleConfigured(extended),
    public_estimate_configuration: publicEstimateConfigured(extended),
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

  const ok = Object.values(checks).every(Boolean);
  return { ok, status: ok ? "ready" : "not_ready", checks, newo };
}

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
      ok: readiness.checks.notification_configuration && readiness.checks.jobnimbus_configuration,
    },
    {
      id: "office_bff",
      ok: readiness.checks.frappe_configuration && readiness.checks.app_bff_configuration,
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
        readiness.checks.newo_frappe_readiness &&
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
    ["NEWO_TRANSFER_POLICY", "transfer_policy_missing"],
    ["NEWO_OWNER_TRANSFER_NUMBER", "owner_transfer_number_missing"],
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
  if (String(env.NEWO_TRANSFER_POLICY ?? "") !== "owner_then_voicemail") {
    reasons.push("transfer_policy_mismatch");
  }
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

  const [heartbeatRow, openDeadLetters, envelopeCounts, replayCounts, auditFailures, qbReceipt] = await Promise.all([
    store.getLatestHeartbeat(env),
    store.countOpenDeadLetter(env),
    store.getOperationalEnvelopeCounts(env, stuckCutoff),
    store.getReplayOperationalCounts(env, stuckCutoff),
    store.listRecentAuditFailures(env, auditSince, auditLimit),
    store.getLatestQuickBooksWebhookReceipt(env),
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
    replayCounts.failed > 0 || replayCounts.stuck > 0 || auditFailures.length > 0;

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
