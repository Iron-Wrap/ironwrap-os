import { z } from "zod";

const nullableText = z.string().min(1).max(300).nullable();
const timestamp = z.string().min(1).max(64);
const nullableTimestamp = timestamp.nullable();

export const newoReadinessCheckIds = [
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

const sessionSchema = z
  .object({
    session_id: z.string().min(1).max(200),
    channel: z.enum(["phone", "chat"]),
    direction: z.enum(["inbound", "outbound"]),
    status: z.string().min(1).max(100),
    outcome: nullableText,
    division: nullableText,
    service: nullableText,
    urgency: nullableText,
    handoff_status: nullableText,
    booking_status: nullableText,
    started_at: nullableTimestamp,
    ended_at: nullableTimestamp,
    duration_seconds: z.number().int().nonnegative().nullable(),
    report_expected_at: nullableTimestamp,
    report_received_at: nullableTimestamp,
    missing_report_detected_at: nullableTimestamp,
    sync_status: z.enum(["pending", "synced", "failed", "dead"]),
    sync_attempts: z.number().int().nonnegative(),
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict();

// A requested callback no person has closed. Like every list here it carries no caller identity or
// content; the person who calls back reads the callback record on its resolution route.
const openCallbackSchema = z
  .object({
    callback_id: z.string().regex(/^ncb_[0-9a-f]{32}$/),
    session_id: z.string().min(1).max(200),
    urgency: z.enum(["routine", "urgent", "emergency"]),
    requested_at: timestamp,
  })
  .strict();

const eventFailureSchema = z
  .object({
    event_id: z.string().min(1).max(200),
    session_id: z.string().min(1).max(200),
    event_type: z.string().min(1).max(100),
    status: z.enum(["failed", "dead"]),
    attempts: z.number().int().nonnegative(),
    first_seen_at: timestamp,
    last_seen_at: timestamp,
  })
  .strict();

const deadLetterSchema = z
  .object({
    id: z.number().int().positive(),
    stage: z.string().min(1).max(100),
    recorded_at: timestamp,
  })
  .strict();

const controlFailureSchema = z
  .object({
    action_id: z.string().min(1).max(200),
    operation: z.string().min(1).max(100),
    status: z.literal("failed"),
    created_at: timestamp,
    updated_at: timestamp,
    completed_at: nullableTimestamp,
  })
  .strict();

const usageStatusSchema = z.enum([
  "not_checked",
  "within_limit",
  "threshold_exceeded",
  "unavailable_from_documented_api",
]);

const reconciliationSchema = z
  .object({
    run_type: z.enum(["five_minute", "daily"]),
    status: z.enum(["ok", "degraded", "failed"]),
    ran_at: timestamp,
    retryable_syncs_requeued: z.number().int().nonnegative(),
    missing_reports: z.number().int().nonnegative(),
    failed_handoffs: z.number().int().nonnegative(),
    pending_bookings: z.number().int().nonnegative(),
    unresolved_incidents: z.number().int().nonnegative().nullable(),
    drift_reasons: z.array(z.string().min(1).max(160)).max(50),
    usage_status: usageStatusSchema,
    usage_minutes: z.number().nonnegative().nullable(),
    usage_limit_minutes: z.number().positive().nullable(),
  })
  .strict();

const readinessChecksSchema = z
  .array(
    z
      .object({
        id: z.enum(newoReadinessCheckIds),
        ok: z.boolean(),
      })
      .strict(),
  )
  .length(newoReadinessCheckIds.length)
  .superRefine((checks, context) => {
    checks.forEach((check, index) => {
      if (check.id === newoReadinessCheckIds[index]) return;
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, "id"],
        message: "newo_readiness_check_order_invalid",
      });
    });
  });

export const newoOperationsResponseSchema = z
  .object({
    version: z.literal(1),
    read_model_generated_at: timestamp,
    status: z.enum(["ready", "attention"]),
    readiness: z
      .object({
        status: z.enum(["ready", "not_ready", "disabled"]),
        required: z.boolean(),
        enabled: z.boolean(),
        booking_mode: z.string().min(1).max(40),
        outbound_enabled: z.boolean(),
        control_write_enabled: z.boolean(),
        checks: readinessChecksSchema,
        drift_reasons: z.array(z.string().min(1).max(160)).max(50),
      })
      .strict(),
    counts: z
      .object({
        sessions: z.number().int().nonnegative(),
        pending_sync: z.number().int().nonnegative(),
        failed_sync: z.number().int().nonnegative(),
        failed_events: z.number().int().nonnegative(),
        missing_reports: z.number().int().nonnegative(),
        failed_handoffs: z.number().int().nonnegative(),
        open_callbacks: z.number().int().nonnegative(),
        pending_bookings: z.number().int().nonnegative(),
        control_failures: z.number().int().nonnegative(),
        dlq_items: z.number().int().nonnegative(),
        unresolved_incidents: z.number().int().nonnegative().nullable(),
        last_event_at: nullableTimestamp,
        last_report_at: nullableTimestamp,
      })
      .strict(),
    exceptions: z
      .object({
        missing_reports: z.array(sessionSchema).max(25),
        failed_handoffs: z.array(sessionSchema).max(25),
        open_callbacks: z.array(openCallbackSchema).max(25),
        pending_bookings: z.array(sessionSchema).max(25),
        sync_failures: z.array(sessionSchema).max(25),
        failed_events: z.array(eventFailureSchema).max(25),
        dlq_items: z.array(deadLetterSchema).max(25),
        control_failures: z.array(controlFailureSchema).max(25),
      })
      .strict(),
    recent_sessions: z.array(sessionSchema).max(25),
    reconciliation: z
      .object({
        five_minute: reconciliationSchema.nullable(),
        daily: reconciliationSchema.nullable(),
      })
      .strict(),
    usage: z
      .object({
        status: usageStatusSchema,
        minutes: z.number().nonnegative().nullable(),
        limit_minutes: z.number().positive().nullable(),
        checked_at: nullableTimestamp,
      })
      .strict(),
  })
  .strict();

export type NewoOperationsResponse = z.infer<typeof newoOperationsResponseSchema>;
export type NewoOperationsSession = z.infer<typeof sessionSchema>;
export type NewoOperationsOpenCallback = z.infer<typeof openCallbackSchema>;
export type NewoReadinessCheckId = (typeof newoReadinessCheckIds)[number];
export type NewoOperationsReconciliation = z.infer<typeof reconciliationSchema>;
