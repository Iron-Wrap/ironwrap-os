import type { AppRole } from "../../lib/roles";
import {
  attestableGates,
  isAttestableGate,
  isWaivableGate,
  type AttestableGate,
  type CancellationWindow,
  type GateEntry,
  type GateName,
  type JobGate,
  type JobGatesResponse,
  type OpenWaiverRequest,
} from "./gate-contracts";

/**
 * Pure readings of the gates read, for the screens. Nothing here decides who may do what: the
 * Worker and D1 do. These only choose what to draw so that a control which would always be
 * refused is never offered, and a held control says what it waits for.
 */

/** What a gate reads as on screen. */
export type GateView =
  | "not_a_gate"
  | "cleared"
  | "waived"
  | "blocked"
  | "waiting_on_owner"
  | "waiting_on_you"
  | "crew_waiting";

/** Roles that append person entries: attest, ask to waive, reverse (`production:clear_gate`). */
export function canClearGates(role: AppRole): boolean {
  return role === "owner" || role === "production";
}

/** The holder of the deciding set for a waiver (`money.approve`, `production.gates.waive`). */
export function decidesWaivers(role: AppRole): boolean {
  return role === "owner";
}

/** The people-only record step (A5): owner or ops, never anyone else. */
export function canRecordSignedCopy(role: AppRole): boolean {
  return role === "owner" || role === "ops";
}

/** The schedule route (A4): owner, ops or production, people only. */
export function canSchedule(role: AppRole): boolean {
  return role === "owner" || role === "ops" || role === "production";
}

/**
 * The entry that holds the gate's current state: the one its current version was produced by.
 * Null when the read did not return it (a long history) or the gate never moved.
 */
export function entryInForce(gate: JobGate): GateEntry | null {
  for (let index = gate.entries.length - 1; index >= 0; index -= 1) {
    const entry = gate.entries[index]!;
    if (entry.from_gate_version + 1 === gate.version) return entry;
  }
  return null;
}

/** Deposit cleared by an OD-01 contract is a System state, not a gate (owner ruling Q6). */
export function depositIsContractState(gate: JobGate): boolean {
  return (
    gate.gate === "Deposit" &&
    gate.state !== "blocked" &&
    entryInForce(gate)?.basis === "contract_no_deposit"
  );
}

export function gateView(gate: JobGate): GateView {
  if (depositIsContractState(gate)) return "not_a_gate";
  if (gate.state === "waived") return "waived";
  if (gate.state === "ready" || gate.state === "complete") return "cleared";
  if (gate.open_waiver_requests.length > 0) {
    return gate.open_waiver_requests.some((request) => !request.is_own_request)
      ? "waiting_on_you"
      : "waiting_on_owner";
  }
  if (gate.gate === "Crew") return "crew_waiting";
  return "blocked";
}

/**
 * The same, from the viewer's seat: an open request is waiting on the viewer only when they are
 * the one who decides it and did not make it.
 */
export function gateViewFor(gate: JobGate, role: AppRole): GateView {
  const view = gateView(gate);
  if (view === "waiting_on_you" && !decidesWaivers(role)) return "waiting_on_owner";
  return view;
}

export function gateByName(model: JobGatesResponse, name: GateName): JobGate | null {
  return model.gates.find((gate) => gate.gate === name) ?? null;
}

/** The gates the screen counts: Deposit only while it is a real gate (MD-13). */
export function countedGates(model: JobGatesResponse): JobGate[] {
  return model.gates.filter((gate) => !depositIsContractState(gate));
}

export interface GateSummary {
  total: number;
  cleared: number;
  waived: number;
  blocked: number;
  waiting: number;
}

export function gateSummary(model: JobGatesResponse): GateSummary {
  const summary: GateSummary = { total: 0, cleared: 0, waived: 0, blocked: 0, waiting: 0 };
  for (const gate of countedGates(model)) {
    summary.total += 1;
    const view = gateView(gate);
    if (view === "cleared") summary.cleared += 1;
    else if (view === "waived") summary.waived += 1;
    else if (view === "blocked") summary.blocked += 1;
    else summary.waiting += 1;
  }
  return summary;
}

/** The window holds ordering, Materials and the firm start while it is unknown or open. */
export function windowHolds(window: CancellationWindow): boolean {
  return window.state === "unknown" || window.state === "open";
}

/** The gates, other than Crew, that still stand between the job and its schedule. */
export function gatesBeforeSchedule(model: JobGatesResponse): GateName[] {
  return countedGates(model)
    .filter((gate) => gate.gate !== "Crew" && gate.state === "blocked")
    .map((gate) => gate.gate);
}

/** Why "Schedule the crew" is held, or null when it may be offered. */
export type ScheduleHold =
  { kind: "window" } | { kind: "gates"; gates: GateName[] } | { kind: "scheduled" };

export function scheduleHold(model: JobGatesResponse): ScheduleHold | null {
  const crew = gateByName(model, "Crew");
  if (crew && crew.state !== "blocked") return { kind: "scheduled" };
  if (windowHolds(model.cancellation_window)) return { kind: "window" };
  const gates = gatesBeforeSchedule(model);
  return gates.length > 0 ? { kind: "gates", gates } : null;
}

/** Whether a gate's proof form may be sent now, or what it waits for. */
export function attestationHold(model: JobGatesResponse, gate: AttestableGate): "window" | null {
  return gate === "Materials" && windowHolds(model.cancellation_window) ? "window" : null;
}

/**
 * The gates the overview offers to clear, in gate order. While the window holds, Materials waits
 * for it and Weather is read near the crew day (P30 frame 1), so only Safety and Access are offered.
 */
export function overviewClearable(model: JobGatesResponse, role: AppRole): AttestableGate[] {
  if (!canClearGates(role)) return [];
  const holds = windowHolds(model.cancellation_window);
  return attestableGates.filter((name) => {
    const gate = gateByName(model, name);
    if (!gate || gateView(gate) !== "blocked") return false;
    if (holds && (name === "Materials" || name === "Weather")) return false;
    return true;
  });
}

/** Whether the viewer may reverse the entry that holds this gate. */
export function canReverse(gate: JobGate, role: AppRole): boolean {
  if (!canClearGates(role) || gate.state === "blocked") return false;
  const entry = entryInForce(gate);
  if (!entry) return false;
  return entry.basis !== "contract_no_deposit" && gate.gate !== "Crew";
}

/** What the waiver step shows the viewer for a gate. */
export type WaiverStage =
  | { kind: "not_waivable" }
  | { kind: "read_only" }
  | { kind: "ask" }
  | { kind: "owner_request" }
  | { kind: "waiting"; request: OpenWaiverRequest }
  | { kind: "decide"; request: OpenWaiverRequest };

export function waiverStage(gate: JobGate, role: AppRole): WaiverStage {
  if (!isWaivableGate(gate.gate)) return { kind: "not_waivable" };
  if (!canClearGates(role)) return { kind: "read_only" };
  const others = gate.open_waiver_requests.find((request) => !request.is_own_request);
  if (others && decidesWaivers(role)) return { kind: "decide", request: others };
  const own = gate.open_waiver_requests.find((request) => request.is_own_request);
  if (own) return { kind: "waiting", request: own };
  if (others) return { kind: "waiting", request: others };
  if (gate.state !== "blocked") return { kind: "read_only" };
  // The read does not identify the only holder. Explain both possible outcomes to the owner;
  // only the write response can confirm a D-08 self-approval or a request for another owner.
  return decidesWaivers(role) ? { kind: "owner_request" } : { kind: "ask" };
}

/** The newest decision on a waiver request, for the requester's answer on the gate. */
export function latestWaiverDecision(gate: JobGate): GateEntry | null {
  for (let index = gate.entries.length - 1; index >= 0; index -= 1) {
    const entry = gate.entries[index]!;
    if (entry.kind === "waiver_decision") return entry;
  }
  return null;
}

/** The step a gate's row opens. */
export function stepForGate(gate: GateName): GateStep {
  return gate.toLowerCase() as GateStep;
}

export const gateSteps = [
  "deposit",
  "materials",
  "safety",
  "access",
  "weather",
  "crew",
  "waive-deposit",
  "waive-materials",
  "waive-access",
  "window",
] as const;
export type GateStep = (typeof gateSteps)[number];

export function isGateStep(value: unknown): value is GateStep {
  return typeof value === "string" && (gateSteps as readonly string[]).includes(value);
}

export function gateForStep(step: GateStep): GateName | null {
  switch (step) {
    case "deposit":
    case "waive-deposit":
      return "Deposit";
    case "materials":
    case "waive-materials":
      return "Materials";
    case "safety":
      return "Safety";
    case "access":
    case "waive-access":
      return "Access";
    case "weather":
      return "Weather";
    case "crew":
      return "Crew";
    default:
      return null;
  }
}

export function waiveStepFor(gate: GateName): GateStep | null {
  if (gate === "Deposit") return "waive-deposit";
  if (gate === "Materials") return "waive-materials";
  if (gate === "Access") return "waive-access";
  return null;
}

export { isAttestableGate };
