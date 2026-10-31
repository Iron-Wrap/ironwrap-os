import { ApiError } from "../../lib/api";
import { messageFor, ONLINE_ONLY_CONNECTION } from "../../lib/plain-error";
import { gateFallbacks, gateRefusalWords } from "./gate-copy";

/**
 * Which P30 frame a refused gate request is drawn as. A refusal with a frame of its own becomes a
 * state of its step (the permit, the crew, the competency, the stop, the material problem, the
 * forecast, the window); every other refusal is one plain sentence from `gateRefusalWords`.
 */
export type GateRefusal =
  | { kind: "permit_unknown" }
  | { kind: "on_crew" }
  | { kind: "competency" }
  | { kind: "stop"; variant: "job" | "job_unknown" | "plan_unknown"; stopId: string | null }
  | { kind: "material_problem" }
  | { kind: "forecast_stale" }
  | { kind: "weather_window_invalid" }
  | { kind: "window_held" }
  | { kind: "not_waivable" }
  | { kind: "waiver_requested" }
  | { kind: "message"; text: string; error: unknown };

/** Frames 11, 12, 14-18 and 2, by the code the clearance and waiver routes answer. */
export function gateRefusal(error: unknown): GateRefusal {
  const code = error instanceof ApiError ? error.code : null;
  const stopId = error instanceof ApiError ? (error.detailText("stop_id") ?? null) : null;
  switch (code) {
    case "production_gate_safety_permit_unknown":
      return { kind: "permit_unknown" };
    case "production_gate_attester_on_crew":
      return { kind: "on_crew" };
    case "production_gate_competency_required":
      return { kind: "competency" };
    case "production_gate_safety_stop_active":
      return { kind: "stop", variant: "job", stopId };
    case "production_gate_stop_job_unknown":
      return { kind: "stop", variant: "job_unknown", stopId };
    case "production_gate_stop_work_package_unknown":
      return { kind: "stop", variant: "plan_unknown", stopId };
    case "production_gate_material_exception_open":
      return { kind: "material_problem" };
    case "production_gate_forecast_stale":
      return { kind: "forecast_stale" };
    case "production_gate_weather_window_invalid":
      return { kind: "weather_window_invalid" };
    case "production_gate_cancellation_window_unknown":
    case "production_gate_cancellation_window_open":
      return { kind: "window_held" };
    case "production_gate_not_waivable":
      return { kind: "not_waivable" };
    case "production_gate_waiver_requested":
    case "production_gate_waiver_request_open":
      return { kind: "waiver_requested" };
    default:
      return { kind: "message", text: gateErrorWords(error), error };
  }
}

/** One plain sentence for any refused or unanswered gate request. */
export function gateErrorWords(error: unknown): string {
  return messageFor(error, {
    byCode: { ...ONLINE_ONLY_CONNECTION, ...gateRefusalWords },
    refused: gateFallbacks.refused,
    fallback: gateFallbacks.unconfirmed,
  });
}

/** Frames 20c, 21, 22 and 23: the record step's own refusals, with the times they carry. */
export type RecordRefusal =
  | { kind: "missing"; reason: boolean; evidence: boolean }
  | {
      kind: "before_contract";
      receivedAt: string;
      contractSignedAt: string;
      timeZone: string | null;
    }
  | { kind: "in_future"; receivedAt: string; now: string | null; timeZone: string | null }
  | {
      kind: "earlier";
      receivedAt: string;
      recordedAt: string;
      source: string | null;
      windowEndsAt: string | null;
      timeZone: string | null;
    }
  | { kind: "message"; text: string; error: unknown };

export function recordRefusal(error: unknown): RecordRefusal {
  if (!(error instanceof ApiError)) return { kind: "message", text: gateErrorWords(error), error };
  const text = (key: string) => error.detailText(key) ?? null;
  switch (error.code) {
    case "cancellation_window_receipt_reason_and_evidence_required":
      return { kind: "missing", reason: true, evidence: true };
    case "cancellation_window_receipt_reason_required":
      return { kind: "missing", reason: true, evidence: false };
    case "cancellation_window_receipt_evidence_required":
      return { kind: "missing", reason: false, evidence: true };
    case "cancellation_window_receipt_before_contract": {
      const receivedAt = text("received_at");
      const contractSignedAt = text("contract_signed_at");
      if (receivedAt && contractSignedAt) {
        return {
          kind: "before_contract",
          receivedAt,
          contractSignedAt,
          timeZone: text("time_zone"),
        };
      }
      break;
    }
    case "cancellation_window_receipt_in_future": {
      const receivedAt = text("received_at");
      if (receivedAt) {
        return { kind: "in_future", receivedAt, now: text("now"), timeZone: text("time_zone") };
      }
      break;
    }
    case "cancellation_window_receipt_earlier_than_recorded": {
      const receivedAt = text("received_at");
      const recordedAt = text("recorded_received_at");
      if (receivedAt && recordedAt) {
        return {
          kind: "earlier",
          receivedAt,
          recordedAt,
          source: text("recorded_source"),
          windowEndsAt: text("window_ends_at"),
          timeZone: text("time_zone"),
        };
      }
      break;
    }
    default:
      break;
  }
  return { kind: "message", text: gateErrorWords(error), error };
}
