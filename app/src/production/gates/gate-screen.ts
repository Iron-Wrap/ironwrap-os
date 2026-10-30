import type { AuthenticatedSession } from "../../auth/session";
import type { AppRole } from "../../lib/roles";
import type { ProductionRunwayJob, ProductionRunwayResponse } from "../production-contracts";
import { byWhom, gateCopy } from "./gate-copy";
import type { CancellationWindow, GateEntry, GateName, JobGatesResponse } from "./gate-contracts";
import {
  countedGates,
  gatesBeforeSchedule,
  gateViewFor,
  scheduleHold,
  windowHolds,
} from "./gate-model";
import { officeStamp, windowDeadline } from "./gate-time";

/** What every gate step is drawn from: the reads, the viewer and the clock. */
export interface GateScreen {
  jobId: string;
  model: JobGatesResponse;
  runwayJob: ProductionRunwayJob | null;
  crews: ProductionRunwayResponse["crews"];
  /** The customer's display name, or "the customer" when the job read did not load. */
  customerName: string;
  /** "{customer} · {street}", or the job number. */
  jobLabel: string;
  session: AuthenticatedSession;
  role: AppRole;
  now: Date;
  /** The business clock for the office's stamps. */
  timeZone: string;
  offline: boolean;
  refresh: () => Promise<void>;
}

export function stampOf(screen: GateScreen, value: string | null | undefined): string {
  return officeStamp(value, { timeZone: screen.timeZone, now: screen.now }) ?? "";
}

export function windowStampOf(screen: GateScreen, value: string | null | undefined): string {
  return (
    officeStamp(value, { timeZone: screen.model.cancellation_window.time_zone, now: screen.now }) ??
    ""
  );
}

export function deadlineOf(window: CancellationWindow, now: Date) {
  return windowDeadline(window, now);
}

/** The window's line in the overview row (frames 1 and 19). */
export function windowRowText(screen: GateScreen): string {
  const window = screen.model.cancellation_window;
  const deadline = deadlineOf(window, screen.now);
  if (window.state === "unknown") return gateCopy.window.unknownRow(window.unknown_reason);
  if (window.state === "open") {
    return deadline.kind === "exact"
      ? gateCopy.window.openRowExact(deadline.label)
      : gateCopy.window.openRow(deadline.kind === "day" ? deadline.label : "");
  }
  return deadline.kind === "exact"
    ? gateCopy.window.endedRowExact(deadline.label)
    : gateCopy.window.endedRow(deadline.kind === "day" ? deadline.label : "");
}

/** The window's line in the Materials hold field (frame 2). */
export function windowHoldText(screen: GateScreen): string {
  const window = screen.model.cancellation_window;
  if (window.state === "unknown") return gateCopy.window.holdsUnknown(window.unknown_reason);
  const deadline = deadlineOf(window, screen.now);
  return deadline.kind === "exact"
    ? gateCopy.window.holdsOpenExact(deadline.label)
    : gateCopy.window.holdsOpen(deadline.kind === "day" ? deadline.label : "");
}

/** The status lines under a step's title: the window, then every counted gate. */
export function statusStrip(screen: GateScreen): { window: string; gates: string } {
  const window = screen.model.cancellation_window;
  const words = countedGates(screen.model)
    .filter((gate) => gate.gate !== "Deposit")
    .map((gate) => {
      const view = gateViewFor(gate, screen.role);
      return gateCopy.strip.gate(gate.gate, view === "not_a_gate" ? "cleared" : view);
    });
  return {
    window: gateCopy.strip.window(
      window.state,
      deadlineOf(window, screen.now),
      window.unknown_reason,
    ),
    gates: words.join(" · "),
  };
}

/** The label of "Schedule the crew" while it is held, or null when it may be offered. */
export function heldScheduleLabel(model: JobGatesResponse): string | null {
  const hold = scheduleHold(model);
  if (!hold || hold.kind === "scheduled") return null;
  if (hold.kind === "window") return `${gateCopy.schedule.action} · ${gateCopy.window.afterWindow}`;
  return `${gateCopy.schedule.action} · ${gateCopy.schedule.afterGates(hold.gates)}`;
}

/**
 * The "Next:" line of an attestation step (frames 3-6): what still stands after this gate, and
 * when "Schedule the crew" turns on.
 */
export function nextAfterGate(model: JobGatesResponse, gate: GateName): string {
  const blocked = gatesBeforeSchedule(model);
  if (windowHolds(model.cancellation_window)) {
    const everyBlocked = countedGates(model)
      .filter((candidate) => candidate.gate !== "Crew")
      .every((candidate) => candidate.state === "blocked");
    if (everyBlocked) return gateCopy.schedule.nextWindowAndEvery;
    return gateCopy.schedule.nextAfterWindowThen(blocked);
  }
  const order = countedGates(model).map((candidate) => candidate.gate);
  const remaining = blocked.includes(gate) ? blocked : [...blocked, gate];
  return gateCopy.schedule.nextClearThen(
    [...remaining].sort((left, right) => order.indexOf(left) - order.indexOf(right)),
  );
}

/** Who appended an entry, in the frames' "by …" form. */
export function entryWho(entry: GateEntry): string {
  return byWhom(entry.actor_role);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** What a person's proof said, in one line (frames 13a and 13). */
export function proofSummary(screen: GateScreen, gate: GateName, entry: GateEntry): string {
  const attestation = entry.attestation ?? {};
  const note = entry.reason_redacted ? null : entry.reason;
  if (gate === "Materials") {
    return gateCopy.proof.materials(note, text(attestation.reference) ?? "");
  }
  if (gate === "Safety") {
    const permit = attestation.permit as { answer?: string; number?: string } | undefined;
    const fall = attestation.fall_protection as { plan_ref?: string } | undefined;
    const permitWords =
      permit?.answer === "needed_and_held" && permit.number
        ? gateCopy.proof.permitHeld(permit.number)
        : gateCopy.proof.permitNotNeeded;
    const fallWords = fall?.plan_ref
      ? gateCopy.proof.fallPlan(fall.plan_ref)
      : gateCopy.proof.noExposure;
    return `${permitWords} · ${fallWords}`;
  }
  if (gate === "Access") {
    const who =
      attestation.confirmed_with === "customer"
        ? gateCopy.access.customer
        : attestation.confirmed_with === "property_manager"
          ? gateCopy.access.propertyManager
          : gateCopy.access.notNeeded;
    return gateCopy.proof.access(who, note);
  }
  if (gate === "Weather") {
    return gateCopy.proof.weather(
      stampOf(screen, text(attestation.window_start)),
      stampOf(screen, text(attestation.window_end)),
      stampOf(screen, text(attestation.forecast_observed_at)),
    );
  }
  return note ?? "";
}
