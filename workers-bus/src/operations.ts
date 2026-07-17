// operations.ts — production-facing readiness, status, and dead-letter recovery orchestration.

import * as store from "./store.ts";
import { appBffConfigured } from "./app-auth.ts";
import { customerPortalConfigured } from "./customer-portal.ts";
import { productionScheduleApprovalDecisionConfig } from "./production-schedule-approval-authority.ts";
import { productionScheduleApprovalBrokerConfig } from "./production-schedule-approval-broker-client.ts";
import type { AppEnv } from "./app-types.ts";

export const BULK_REPLAY_CONFIRMATION = "REPLAY_ALL_OPEN_DEAD_LETTERS";
const HEARTBEAT_FRESHNESS_HOURS = 36;
const AUDIT_FAILURE_WINDOW_HOURS = 24;
const QB_RECEIPT_FRESHNESS_HOURS = 24;
const QUEUE_BATCH_SIZE = 100;
const MAX_CLOCK_SKEW_SECONDS = 5 * 60;

interface ExtendedEnv {
  ERPNEXT_ENABLED?: string;
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
  };
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

export async function getReadiness(env: Env): Promise<ReadinessReport> {
  const runtime = env as unknown as Record<string, unknown>;
  const db = runtime.DB as { prepare?: unknown } | undefined;
  const raw = runtime.RAW as { put?: unknown } | undefined;
  const queue = runtime.JN_QUEUE as { send?: unknown; sendBatch?: unknown } | undefined;
  const extended = env as AppEnv & ExtendedEnv;

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

  const ok = Object.values(checks).every(Boolean);
  return { ok, status: ok ? "ready" : "not_ready", checks };
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
