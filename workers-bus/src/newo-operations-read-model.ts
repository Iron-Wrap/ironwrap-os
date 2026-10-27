import { getNewoOpenIncidentCount, getReadiness } from "./operations.ts";
import {
  countOpenNewoDeadLetters,
  getLatestNewoReconciliationRun,
  newoOperationalCounts,
  newoTenantId,
  OPEN_CALLBACK,
  UNRESOLVED_FAILED_HANDOFF,
  type NewoReconciliationRun,
} from "./newo-store.ts";

export const NEWO_READINESS_CHECK_IDS = [
  "owned_database",
  "raw_store",
  "enabled",
  "webhook_credentials",
  "api_authentication",
  "production_actor",
  "report_webhooks",
  "configuration",
  "queue",
  "dlq",
  "frappe",
  "jobnimbus",
  "booking_mode",
] as const;

export type NewoReadinessCheckId = (typeof NEWO_READINESS_CHECK_IDS)[number];

export interface NewoOperationsSession {
  session_id: string;
  channel: "phone" | "chat";
  direction: "inbound" | "outbound";
  status: string;
  outcome: string | null;
  division: string | null;
  service: string | null;
  urgency: string | null;
  handoff_status: string | null;
  booking_status: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  report_expected_at: string | null;
  report_received_at: string | null;
  missing_report_detected_at: string | null;
  sync_status: "pending" | "synced" | "failed" | "dead";
  sync_attempts: number;
  created_at: string;
  updated_at: string;
}

export interface NewoOperationsEventFailure {
  event_id: string;
  session_id: string;
  event_type: string;
  status: "failed" | "dead";
  attempts: number;
  first_seen_at: string;
  last_seen_at: string;
}

/**
 * A callback no person has closed (migration 0168): a requested callback, or a failed session's.
 * Like every list here it carries no caller identity or content: the person who calls back reads
 * the record on the resolution route.
 */
export interface NewoOperationsOpenCallback {
  callback_id: string;
  session_id: string;
  /** Why the caller is owed it; a failed handoff's callback is listed under `failed_handoffs`. */
  reason: "callback_requested" | "session_failed";
  /** The higher of the urgency recorded with the callback and the session's urgency now. */
  urgency: "routine" | "urgent" | "emergency";
  /** When D1 recorded the callback. */
  requested_at: string;
}

export interface NewoOperationsDeadLetter {
  id: number;
  stage: string;
  recorded_at: string;
}

export interface NewoOperationsControlFailure {
  action_id: string;
  operation: string;
  status: "failed";
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface NewoOperationsReconciliation {
  run_type: "five_minute" | "daily";
  status: "ok" | "degraded" | "failed";
  ran_at: string;
  retryable_syncs_requeued: number;
  missing_reports: number;
  failed_handoffs: number;
  pending_bookings: number;
  unresolved_incidents: number | null;
  drift_reasons: string[];
  usage_status: NewoReconciliationRun["usage_status"];
  usage_minutes: number | null;
  usage_limit_minutes: number | null;
}

export interface NewoOperationsReadModel {
  version: 1;
  read_model_generated_at: string;
  status: "ready" | "attention";
  readiness: {
    status: "ready" | "not_ready" | "disabled";
    required: boolean;
    enabled: boolean;
    booking_mode: string;
    outbound_enabled: boolean;
    control_write_enabled: boolean;
    checks: Array<{ id: NewoReadinessCheckId; ok: boolean }>;
    drift_reasons: string[];
  };
  counts: {
    sessions: number;
    pending_sync: number;
    failed_sync: number;
    failed_events: number;
    missing_reports: number;
    /** Failed handoffs no person has resolved; each one keeps the model in `attention`. */
    failed_handoffs: number;
    /** Callbacks no person has closed (requested, or a failed session's); each keeps `attention`. */
    open_callbacks: number;
    pending_bookings: number;
    control_failures: number;
    dlq_items: number;
    unresolved_incidents: number | null;
    last_event_at: string | null;
    last_report_at: string | null;
  };
  exceptions: {
    missing_reports: NewoOperationsSession[];
    failed_handoffs: NewoOperationsSession[];
    open_callbacks: NewoOperationsOpenCallback[];
    pending_bookings: NewoOperationsSession[];
    sync_failures: NewoOperationsSession[];
    failed_events: NewoOperationsEventFailure[];
    dlq_items: NewoOperationsDeadLetter[];
    control_failures: NewoOperationsControlFailure[];
  };
  recent_sessions: NewoOperationsSession[];
  reconciliation: {
    five_minute: NewoOperationsReconciliation | null;
    daily: NewoOperationsReconciliation | null;
  };
  usage: {
    status: NewoReconciliationRun["usage_status"];
    minutes: number | null;
    limit_minutes: number | null;
    checked_at: string | null;
  };
}

const SESSION_COLUMNS = `session_id, channel, direction, status, outcome, division, service,
  urgency, handoff_status, booking_status, started_at, ended_at, duration_seconds,
  report_expected_at, report_received_at, missing_report_detected_at, sync_status,
  sync_attempts, created_at, updated_at`;

const OPERATIONS_LIMIT = 25;

export async function buildNewoOperationsReadModel(
  env: Env,
  now = new Date(),
): Promise<NewoOperationsReadModel> {
  const [
    readiness,
    counts,
    unresolvedIncidents,
    recentSessions,
    missingReports,
    failedHandoffs,
    openCallbacks,
    pendingBookings,
    syncFailures,
    failedEvents,
    deadLetters,
    deadLetterCount,
    controlFailures,
    fiveMinute,
    daily,
  ] = await Promise.all([
    getReadiness(env),
    newoOperationalCounts(env),
    getNewoOpenIncidentCount(env),
    listSessions(env, "recent", OPERATIONS_LIMIT),
    listSessions(env, "missing_report", OPERATIONS_LIMIT),
    listSessions(env, "failed_handoff", OPERATIONS_LIMIT),
    listOpenCallbacks(env, OPERATIONS_LIMIT),
    listSessions(env, "pending_booking", OPERATIONS_LIMIT),
    listSessions(env, "sync_failure", OPERATIONS_LIMIT),
    listFailedEvents(env, OPERATIONS_LIMIT),
    listOpenDeadLetters(env, OPERATIONS_LIMIT),
    countOpenNewoDeadLetters(env),
    listControlFailures(env, OPERATIONS_LIMIT),
    getLatestNewoReconciliationRun(env, "five_minute"),
    getLatestNewoReconciliationRun(env, "daily"),
  ]);

  const checks = readinessChecks(readiness);
  const readinessStatus = !readiness.newo.required
    ? "disabled"
    : checks.every((check) => check.ok)
      ? "ready"
      : "not_ready";
  const normalizedFiveMinute = normalizeReconciliation(fiveMinute);
  const normalizedDaily = normalizeReconciliation(daily);
  const hasExceptions = newoOperationsNeedAttention({
    counts,
    dlqItems: deadLetterCount,
    unresolvedIncidents,
    daily: normalizedDaily,
  });

  return {
    version: 1,
    read_model_generated_at: now.toISOString(),
    status: readinessStatus === "ready" && !hasExceptions ? "ready" : "attention",
    readiness: {
      status: readinessStatus,
      required: readiness.newo.required,
      enabled: readiness.newo.enabled,
      booking_mode: readiness.newo.booking_mode,
      outbound_enabled: readiness.newo.outbound_enabled,
      control_write_enabled: readiness.newo.control_write_enabled,
      checks,
      drift_reasons: safeReasonList(readiness.newo.drift_reasons),
    },
    counts: {
      ...counts,
      dlq_items: deadLetterCount,
      unresolved_incidents: unresolvedIncidents,
    },
    exceptions: {
      missing_reports: missingReports,
      failed_handoffs: failedHandoffs,
      open_callbacks: openCallbacks,
      pending_bookings: pendingBookings,
      sync_failures: syncFailures,
      failed_events: failedEvents,
      dlq_items: deadLetters,
      control_failures: controlFailures,
    },
    recent_sessions: recentSessions,
    reconciliation: {
      five_minute: normalizedFiveMinute,
      daily: normalizedDaily,
    },
    usage: {
      status: normalizedDaily?.usage_status ?? "not_checked",
      minutes: normalizedDaily?.usage_minutes ?? null,
      limit_minutes: normalizedDaily?.usage_limit_minutes ?? null,
      checked_at: normalizedDaily?.ran_at ?? null,
    },
  };
}

/**
 * Whether the owned record holds anything a person must still act on. Any one keeps the model in
 * `attention`, however ready the integration is: an open requested callback or an unresolved
 * failed handoff stays there until a person closes it.
 */
export function newoOperationsNeedAttention(input: {
  counts: Pick<
    NewoOperationsReadModel["counts"],
    | "failed_sync"
    | "failed_events"
    | "missing_reports"
    | "failed_handoffs"
    | "open_callbacks"
    | "pending_bookings"
    | "control_failures"
  >;
  dlqItems: number;
  unresolvedIncidents: number | null;
  daily: NewoOperationsReconciliation | null;
}): boolean {
  const { counts, daily } = input;
  return counts.failed_sync > 0 ||
    counts.failed_events > 0 ||
    counts.missing_reports > 0 ||
    counts.failed_handoffs > 0 ||
    counts.open_callbacks > 0 ||
    counts.pending_bookings > 0 ||
    counts.control_failures > 0 ||
    input.dlqItems > 0 ||
    input.unresolvedIncidents === null ||
    input.unresolvedIncidents > 0 ||
    daily?.status === "degraded" ||
    daily?.status === "failed" ||
    daily?.usage_status === "threshold_exceeded";
}

function readinessChecks(
  report: Awaited<ReturnType<typeof getReadiness>>,
): NewoOperationsReadModel["readiness"]["checks"] {
  return [
    { id: "owned_database", ok: report.checks.d1 && report.checks.schema },
    { id: "raw_store", ok: report.checks.raw_store_binding },
    { id: "enabled", ok: report.checks.newo_enabled },
    { id: "webhook_credentials", ok: report.checks.newo_webhook_credentials },
    { id: "api_authentication", ok: report.checks.newo_api_authentication },
    { id: "production_actor", ok: report.checks.newo_production_actor },
    { id: "report_webhooks", ok: report.checks.newo_report_webhook_match },
    { id: "configuration", ok: report.checks.newo_configuration_drift },
    { id: "queue", ok: report.checks.newo_queue_binding },
    { id: "dlq", ok: report.checks.newo_dlq_state },
    { id: "frappe", ok: report.checks.newo_frappe_readiness },
    { id: "jobnimbus", ok: report.checks.newo_jobnimbus_bridge },
    { id: "booking_mode", ok: report.checks.newo_booking_mode },
  ];
}

async function listSessions(
  env: Env,
  kind: "recent" | "missing_report" | "failed_handoff" | "pending_booking" | "sync_failure",
  limit: number,
): Promise<NewoOperationsSession[]> {
  const statements = {
    recent: `SELECT ${SESSION_COLUMNS} FROM newo_sessions ORDER BY updated_at DESC LIMIT ?`,
    missing_report: `SELECT ${SESSION_COLUMNS} FROM newo_sessions
      WHERE missing_report_detected_at IS NOT NULL AND report_received_at IS NULL
      ORDER BY missing_report_detected_at ASC LIMIT ?`,
    // Only failed handoffs no person has resolved; a resolution, never age, takes one off the list.
    failed_handoff: `SELECT ${SESSION_COLUMNS} FROM newo_sessions
      WHERE ${UNRESOLVED_FAILED_HANDOFF} ORDER BY updated_at DESC LIMIT ?`,
    pending_booking: `SELECT ${SESSION_COLUMNS} FROM newo_sessions
      WHERE booking_status = 'requested' ORDER BY updated_at ASC LIMIT ?`,
    sync_failure: `SELECT ${SESSION_COLUMNS} FROM newo_sessions
      WHERE sync_status IN ('failed','dead') ORDER BY updated_at ASC LIMIT ?`,
  } satisfies Record<typeof kind, string>;
  const args = kind === "failed_handoff" ? [newoTenantId(env), limit] : [limit];
  const result = await env.DB.prepare(statements[kind])
    .bind(...args)
    .all<NewoOperationsSession>();
  return (result.results ?? []).map(normalizeSession);
}

function normalizeSession(row: NewoOperationsSession): NewoOperationsSession {
  return {
    ...row,
    duration_seconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
    sync_attempts: Number(row.sync_attempts),
  };
}

/**
 * The open callbacks, most urgent first and then the longest waiting. A resolution, never age,
 * takes one off the list; a callback whose session's handoff failed is listed as a failed handoff.
 */
async function listOpenCallbacks(env: Env, limit: number): Promise<NewoOperationsOpenCallback[]> {
  const urgency = `CASE
         WHEN 'emergency' IN (callback.urgency, session.urgency) THEN 'emergency'
         WHEN 'urgent' IN (callback.urgency, session.urgency) THEN 'urgent'
         ELSE 'routine'
       END`;
  const result = await env.DB.prepare(
    `SELECT callback.callback_id, callback.session_id, callback.reason, ${urgency} AS urgency,
            callback.recorded_at AS requested_at
       FROM newo_callback_records callback
       LEFT JOIN newo_sessions session ON session.session_id = callback.session_id
      WHERE ${OPEN_CALLBACK}
      ORDER BY CASE ${urgency} WHEN 'emergency' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END,
               callback.recorded_at ASC, callback.callback_id ASC
      LIMIT ?`,
  )
    .bind(newoTenantId(env), limit)
    .all<NewoOperationsOpenCallback>();
  return result.results ?? [];
}

async function listFailedEvents(env: Env, limit: number): Promise<NewoOperationsEventFailure[]> {
  const result = await env.DB.prepare(
    `SELECT event_id, session_id, event_type, status, attempts, first_seen_at, last_seen_at
       FROM newo_event_receipts WHERE status IN ('failed','dead')
      ORDER BY last_seen_at ASC LIMIT ?`,
  )
    .bind(limit)
    .all<NewoOperationsEventFailure>();
  return (result.results ?? []).map((row) => ({ ...row, attempts: Number(row.attempts) }));
}

async function listOpenDeadLetters(env: Env, limit: number): Promise<NewoOperationsDeadLetter[]> {
  const result = await env.DB.prepare(
    `SELECT id, stage, ts AS recorded_at FROM dead_letter
      WHERE recovered = 0 AND stage GLOB 'newo_*' ORDER BY ts ASC LIMIT ?`,
  )
    .bind(limit)
    .all<NewoOperationsDeadLetter>();
  return (result.results ?? []).map((row) => ({ ...row, id: Number(row.id) }));
}

async function listControlFailures(
  env: Env,
  limit: number,
): Promise<NewoOperationsControlFailure[]> {
  const result = await env.DB.prepare(
    `SELECT action_id, operation, status, created_at, updated_at, completed_at
       FROM newo_control_actions WHERE status = 'failed'
      ORDER BY updated_at ASC LIMIT ?`,
  )
    .bind(limit)
    .all<NewoOperationsControlFailure>();
  return result.results ?? [];
}

function normalizeReconciliation(
  run: NewoReconciliationRun | null,
): NewoOperationsReconciliation | null {
  if (!run) return null;
  return {
    run_type: run.run_type,
    status: run.status,
    ran_at: run.ran_at,
    retryable_syncs_requeued: Number(run.retryable_syncs_requeued),
    missing_reports: Number(run.missing_reports),
    failed_handoffs: Number(run.failed_handoffs),
    pending_bookings: Number(run.pending_bookings),
    unresolved_incidents:
      run.unresolved_incidents === null ? null : Number(run.unresolved_incidents),
    drift_reasons: safeReasonList(parseJsonArray(run.drift_reasons_json)),
    usage_status: run.usage_status,
    usage_minutes: run.usage_minutes === null ? null : Number(run.usage_minutes),
    usage_limit_minutes:
      run.usage_limit_minutes === null ? null : Number(run.usage_limit_minutes),
  };
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function safeReasonList(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .slice(0, 50)
    .map((value) => value.slice(0, 160));
}
