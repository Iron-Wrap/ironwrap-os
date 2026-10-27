import type { AuthenticatedSession } from "../../auth/session";
import type { AppRole } from "../../lib/roles";
import type { ProductionRunwayJob, ProductionRunwayResponse } from "../production-contracts";
import type {
  CancellationWindow,
  GateEntry,
  GateName,
  JobGate,
  JobGatesResponse,
  OpenWaiverRequest,
  SignedCopyQueueResponse,
} from "./gate-contracts";
import type { GateScreen } from "./gate-screen";

/**
 * Synthetic gate-train fixtures, on one timeline in America/Edmonton (UTC-6 for every date here):
 * the contract is signed Tue 20 Oct 18:20, the signed copy received Tue 20 Oct 18:26, so the
 * window's last day is Fri 30 Oct and its hold ends Sat 31 Oct 00:00 at UTC-7. "Open" screens are
 * read Wed 21 Oct 10:45; "ended" screens Mon 2 Nov 10:45, with the crew day Tue 3 Nov 07:00.
 * The people and the address are the Product UI file's synthetic job.
 */

export const JOB_ID = "roof-job-elena-synthetic";
export const TIME_ZONE = "America/Edmonton";
export const OPEN_NOW = new Date("2026-10-21T16:45:00.000Z");
export const ENDED_NOW = new Date("2026-11-02T16:45:00.000Z");
export const CONTRACT_SIGNED_AT = "2026-10-21T00:20:00.000Z";
export const COPY_RECEIVED_AT = "2026-10-21T00:26:00.000Z";
export const WINDOW_ENDS_AT = "2026-10-31T07:00:00.000Z";

export function session(role: AppRole = "owner"): AuthenticatedSession {
  return {
    version: 1,
    authenticated: true,
    user: {
      id: `appu_${role}_synthetic`,
      email: `${role}@example.invalid`,
      display_name: role === "owner" ? "Dana Whitford" : "Tom Lachance",
      role,
      frappe_user_id: null,
    },
    tenant: {
      id: "ironwrap",
      name: "IronWrap Exteriors",
      brand: "IronWrap Exteriors",
      locale: "en-CA",
      time_zone: TIME_ZONE,
      currency: "CAD",
    },
    permissions: ["production:read"],
    allowed_actions: ["job.read", "production.read"],
    csrf_token: "csrf-synthetic",
    session_expires_at: "2030-01-01T00:00:00.000Z",
    source_updated_at: null,
    read_model_generated_at: "2026-10-21T16:45:00.000Z",
    stale_fields: [],
  };
}

export function windowState(
  state: "unknown" | "open" | "ended",
  overrides: Partial<CancellationWindow> = {},
): CancellationWindow {
  const known = state !== "unknown";
  return {
    kind: "system_state",
    state,
    waivable: false,
    unknown_reason: known ? null : "signed_copy_time_missing",
    starts_at: known ? COPY_RECEIVED_AT : null,
    started_from: known ? "manual_record" : null,
    last_day: known ? "2026-10-30" : null,
    ends_at: known ? WINDOW_ENDS_AT : null,
    ends_on_calendar_day: known ? true : null,
    contract: { acceptance_binding_id: "cab_synthetic", signed_at: CONTRACT_SIGNED_AT },
    signed_copy_shown: null,
    signed_copy_received: known
      ? {
          id: "pcw_synthetic",
          received_at: COPY_RECEIVED_AT,
          window_ends_at: WINDOW_ENDS_AT,
          time_zone: TIME_ZONE,
          contract_signed_at: CONTRACT_SIGNED_AT,
          acceptance_binding_id: "cab_synthetic",
          no_d1_contract: false,
          reason:
            "The signed copy was emailed to Elena; the email shows it was delivered Tue 20 Oct 18:26.",
          evidence_ref: "Delivered email · signed copy.pdf",
          recorded_at: "2026-10-21T14:40:00.000Z",
          recorded_by: { display_name: "Dana Whitford", role: "owner" },
        }
      : null,
    holds: state === "ended" ? [] : ["firm_start", "materials_attestation", "supplier_order"],
    time_zone: TIME_ZONE,
    as_of: state === "ended" ? ENDED_NOW.toISOString() : OPEN_NOW.toISOString(),
    ...overrides,
  };
}

let entryCounter = 0;

export function entry(overrides: Partial<GateEntry> & { from_gate_version: number }): GateEntry {
  entryCounter += 1;
  return {
    id: `pgc_${String(entryCounter).padStart(40, "0")}`,
    kind: "clear",
    basis: "person_attestation",
    to_state: "ready",
    actor_role: "production",
    created_at: "2026-11-02T14:40:00.000Z",
    request_id: null,
    reverses_id: null,
    self_approval: false,
    attestation: null,
    evidence_refs: [],
    reason: null,
    reason_redacted: false,
    ...overrides,
  };
}

export function request(overrides: Partial<OpenWaiverRequest> = {}): OpenWaiverRequest {
  return {
    request_id: `pgc_${"a".repeat(40)}`,
    is_own_request: true,
    requested_by_role: "production",
    from_gate_version: 1,
    reason: "The shingles are at our yard. The supplier sends the reference this afternoon.",
    reason_redacted: false,
    created_at: "2026-11-02T14:20:00.000Z",
    ...overrides,
  };
}

export function gate(name: GateName, overrides: Partial<JobGate> = {}): JobGate {
  return {
    name: `gate:${name.toLowerCase()}`,
    gate: name,
    roof_job: JOB_ID,
    state: "blocked",
    version: 1,
    ledger_complete: true,
    entries: [],
    open_waiver_requests: [],
    ...overrides,
  };
}

/** Deposit cleared by an OD-01 contract: "No deposit under this contract". */
export function noDepositGate(): JobGate {
  return gate("Deposit", {
    state: "complete",
    version: 2,
    entries: [
      entry({
        from_gate_version: 1,
        basis: "contract_no_deposit",
        to_state: "complete",
        actor_role: null,
        created_at: "2026-10-21T00:21:00.000Z",
        evidence_refs: null,
      }),
    ],
  });
}

export function clearedGate(
  name: GateName,
  attestation: Record<string, unknown>,
  note: string | null,
  at = "2026-11-02T14:40:00.000Z",
): JobGate {
  return gate(name, {
    state: "ready",
    version: 2,
    entries: [entry({ from_gate_version: 1, attestation, reason: note, created_at: at })],
  });
}

export const materialsProof = { source: "supplier_delivery", reference: "3140" };
export const safetyProof = {
  hazard_assessment_ref: "4417",
  permit: { answer: "needed_and_held", number: "building permit 4417" },
  fall_protection: { plan_ref: "ridge-anchors-2" },
  assessed_at: "2026-10-21T16:40:00.000Z",
};
export const accessProof = { confirmed_with: "customer", confirmed_at: "2026-10-21T22:30:00.000Z" };
export const weatherProof = {
  window_start: "2026-11-03T13:00:00.000Z",
  window_end: "2026-11-04T23:00:00.000Z",
  forecast_source: "weather.gc.ca",
  forecast_observed_at: "2026-11-02T12:00:00.000Z",
};

export function model(
  state: "unknown" | "open" | "ended",
  gates: Partial<Record<GateName, JobGate>> = {},
  windowOverrides: Partial<CancellationWindow> = {},
): JobGatesResponse {
  const names: GateName[] = ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew"];
  return {
    roof_job: JOB_ID,
    cancellation_window: windowState(state, windowOverrides),
    gates: names.map((name) => gates[name] ?? (name === "Deposit" ? noDepositGate() : gate(name))),
  };
}

/** Every gate but Crew cleared, the window ended: "Schedule the crew" is on. */
export function readyToSchedule(): JobGatesResponse {
  return model("ended", {
    Materials: clearedGate("Materials", materialsProof, "Prairie Coil Supply"),
    Safety: clearedGate("Safety", safetyProof, null, "2026-10-21T16:41:00.000Z"),
    Access: clearedGate(
      "Access",
      accessProof,
      "Side gate unlocked on the crew days",
      "2026-10-21T22:31:00.000Z",
    ),
    Weather: clearedGate(
      "Weather",
      weatherProof,
      "Dry, wind under 30 km/h",
      "2026-11-02T15:00:00.000Z",
    ),
  });
}

export const runwayJob: ProductionRunwayJob = {
  id: JOB_ID,
  job_number: "IW-2041",
  brand: "IronWrap Exteriors",
  service_type: "Roofing",
  status: "Won",
  version: 3,
  assignment: null,
  scheduling_preparation_allowed: false,
  lane: "blocked",
  next_action: "Clear the gates",
  gate_coverage: "complete",
  gate_summary: { expected: 6, blocked: 5, ready: 0, waived: 0, done: 1 },
  scheduling_gates: [
    { name: "Deposit", state: "Done" },
    { name: "Materials", state: "Blocked" },
    { name: "Safety", state: "Blocked" },
    { name: "Access", state: "Blocked" },
    { name: "Weather", state: "Blocked" },
    { name: "Crew", state: "Blocked" },
  ],
  material_attention: [],
};

export const crews: ProductionRunwayResponse["crews"] = [
  { id: "crew_sam_keewatin_synthetic", name: "Sam Keewatin’s crew", version: 4 },
];

export function screen(
  gates: JobGatesResponse,
  options: { role?: AppRole; now?: Date; refresh?: () => Promise<void> } = {},
): GateScreen {
  const role = options.role ?? "production";
  return {
    jobId: JOB_ID,
    model: gates,
    runwayJob,
    crews,
    customerName: "Elena Marchetti",
    jobLabel: "Elena Marchetti · 118 Larkspur Way NW",
    session: session(role),
    role,
    now: options.now ?? (gates.cancellation_window.state === "ended" ? ENDED_NOW : OPEN_NOW),
    timeZone: TIME_ZONE,
    offline: false,
    refresh: options.refresh ?? (async () => undefined),
  };
}

export const queue: SignedCopyQueueResponse = {
  count: 3,
  counts: { window_unknown: 3, signed_copy_unconfirmed: 0 },
  complete: true,
  jobs: [
    {
      roof_job_id: JOB_ID,
      job_number: "IW-2041",
      customer_display_name: "Elena Marchetti",
      address_line1: "118 Larkspur Way NW",
      category: "window_unknown",
      unknown_reason: "signed_copy_time_missing",
      copy_shown_at: null,
      contract_on_record: true,
      contract_signed_at: CONTRACT_SIGNED_AT,
    },
    {
      roof_job_id: "roof-job-owen-synthetic",
      job_number: "IW-1988",
      customer_display_name: "Owen Pratt",
      address_line1: "27 Coulee Crescent NW",
      category: "window_unknown",
      unknown_reason: "signed_copy_time_missing",
      copy_shown_at: null,
      contract_on_record: false,
      contract_signed_at: null,
    },
    {
      roof_job_id: "roof-job-lena-synthetic",
      job_number: "IW-1990",
      customer_display_name: "Lena Ross",
      address_line1: "9 Aspen Ridge Way",
      category: "window_unknown",
      unknown_reason: "signed_copy_time_missing",
      copy_shown_at: null,
      contract_on_record: false,
      contract_signed_at: null,
    },
  ],
};
