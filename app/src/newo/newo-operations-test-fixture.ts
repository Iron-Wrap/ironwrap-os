import {
  newoReadinessCheckIds,
  type NewoOperationsResponse,
  type NewoOperationsSession,
} from "./newo-operations-contracts";

export function newoSessionFixture(
  overrides: Partial<NewoOperationsSession> = {},
): NewoOperationsSession {
  return {
    session_id: "session-1",
    channel: "phone",
    direction: "inbound",
    status: "ended",
    outcome: "callback_required",
    division: "residential",
    service: "Roof repair",
    urgency: "urgent",
    handoff_status: "failed",
    booking_status: "requested",
    started_at: "2026-07-18T18:00:00.000Z",
    ended_at: "2026-07-18T18:03:00.000Z",
    duration_seconds: 180,
    report_expected_at: "2026-07-18T18:30:00.000Z",
    report_received_at: null,
    missing_report_detected_at: "2026-07-18T18:31:00.000Z",
    sync_status: "dead",
    sync_attempts: 6,
    created_at: "2026-07-18T18:00:00.000Z",
    updated_at: "2026-07-18T18:10:00.000Z",
    ...overrides,
  };
}

export function newoOperationsFixture(
  overrides: Partial<NewoOperationsResponse> = {},
): NewoOperationsResponse {
  const session = newoSessionFixture();
  return {
    version: 1,
    read_model_generated_at: "2026-07-18T18:15:00.000Z",
    status: "attention",
    readiness: {
      status: "not_ready",
      required: true,
      enabled: false,
      booking_mode: "request_only",
      outbound_enabled: false,
      control_write_enabled: false,
      checks: newoReadinessCheckIds.map((id) => ({ id, ok: id !== "enabled" })),
      drift_reasons: ["production_agent_id_missing"],
    },
    counts: {
      sessions: 12,
      pending_sync: 1,
      failed_sync: 1,
      failed_events: 1,
      missing_reports: 1,
      failed_handoffs: 1,
      open_callbacks: 1,
      pending_bookings: 1,
      control_failures: 1,
      dlq_items: 1,
      unresolved_incidents: 2,
      last_event_at: "2026-07-18T18:10:00.000Z",
      last_report_at: "2026-07-18T17:50:00.000Z",
    },
    exceptions: {
      missing_reports: [session],
      failed_handoffs: [session],
      open_callbacks: [
        {
          callback_id: "ncb_0123456789abcdef0123456789abcdef",
          session_id: "session-2",
          urgency: "urgent",
          requested_at: "2026-07-18T18:05:00.000Z",
        },
      ],
      pending_bookings: [session],
      sync_failures: [session],
      failed_events: [
        {
          event_id: "event-1",
          session_id: "session-1",
          event_type: "session_ended",
          status: "dead",
          attempts: 6,
          first_seen_at: "2026-07-18T18:00:00.000Z",
          last_seen_at: "2026-07-18T18:10:00.000Z",
        },
      ],
      dlq_items: [
        {
          id: 7,
          stage: "newo_frappe_sync",
          recorded_at: "2026-07-18T18:10:00.000Z",
        },
      ],
      control_failures: [
        {
          action_id: "action-1",
          operation: "update_agent",
          status: "failed",
          created_at: "2026-07-18T18:00:00.000Z",
          updated_at: "2026-07-18T18:05:00.000Z",
          completed_at: "2026-07-18T18:05:00.000Z",
        },
      ],
    },
    recent_sessions: [session],
    reconciliation: {
      five_minute: {
        run_type: "five_minute",
        status: "degraded",
        ran_at: "2026-07-18T18:10:00.000Z",
        retryable_syncs_requeued: 1,
        missing_reports: 1,
        failed_handoffs: 1,
        pending_bookings: 1,
        unresolved_incidents: null,
        drift_reasons: [],
        usage_status: "not_checked",
        usage_minutes: null,
        usage_limit_minutes: null,
      },
      daily: {
        run_type: "daily",
        status: "degraded",
        ran_at: "2026-07-18T18:15:00.000Z",
        retryable_syncs_requeued: 0,
        missing_reports: 1,
        failed_handoffs: 1,
        pending_bookings: 1,
        unresolved_incidents: 2,
        drift_reasons: ["production_agent_id_missing"],
        usage_status: "unavailable_from_documented_api",
        usage_minutes: null,
        usage_limit_minutes: 500,
      },
    },
    usage: {
      status: "unavailable_from_documented_api",
      minutes: null,
      limit_minutes: 500,
      checked_at: "2026-07-18T18:15:00.000Z",
    },
    ...overrides,
  };
}
