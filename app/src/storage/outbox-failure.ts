import type { OutboxAction, OutboxConflict, OutboxErrorDetail } from "./outbox-types";

/**
 * Why a saved field action stopped, split the only way that matters to the person holding the
 * phone: "this will send once there is signal" versus "no amount of waiting will send this".
 *
 * A queued item labelled "Waiting" is a promise. Keeping a refusal that can never clear inside
 * that label is the failure mode ELEC-211 exists to remove: the crew member's evidence stays on
 * the device forever, indistinguishable from an item still looking for a tower.
 */
export type OutboxFailureClass = "retryable" | "terminal" | "conflict";

/**
 * Refusals the Worker cannot take on any later attempt, named by code rather than by status.
 *
 * Status alone is the general rule (`classifyOutboxFailure` below), but a constraint violation is
 * terminal by definition, and a server that still wraps one in a 5xx would otherwise put the item
 * back in the retry loop for ever. Codes win over status so the client stays honest either way.
 *
 * - `field_action_evidence_requires_work_package` — the code `ironwrap-engineer` returns for
 *   evidence submitted before production issued a work plan (ELEC-210).
 * - `field_action_work_package_binding_invalid` — the raw D1 trigger name behind it
 *   (`workers-bus/migrations/0044_work_package_evidence_slots.sql`), which is what a client sees
 *   until that server half ships.
 */
const evidenceNeedsWorkPackageCodes = new Set([
  "field_action_evidence_requires_work_package",
  "field_action_work_package_binding_invalid",
]);

/**
 * Answers after which the office may already hold this item, so neither "not sent" nor a resend
 * is safe. `fleet_collision_storage_mismatch` is a 502 for a collision ID whose stored record the
 * Worker cannot read: a retry of the same ID can only meet the same record.
 */
const unconfirmedCodes = new Set(["verification_mismatch", "fleet_collision_storage_mismatch"]);

/**
 * Every code above, plus any further code `ironwrap-engineer` publishes for a refusal that no
 * retry can clear. Status classification below covers the rest, so this list only has to carry
 * codes whose status may still understate them.
 */
const terminalFailureCodes = new Set([...evidenceNeedsWorkPackageCodes, ...unconfirmedCodes]);

export function isTerminalFailureCode(code: string | undefined): boolean {
  return code !== undefined && terminalFailureCodes.has(code);
}

/**
 * A server answer becomes one of three outcomes. Conflicts keep their own class because the office
 * copy changing is not a refusal of this device's work — it needs two versions reconciled, not a
 * retry and not an apology.
 */
export function classifyOutboxFailure(input: {
  status?: number;
  code?: string;
}): OutboxFailureClass {
  if (isTerminalFailureCode(input.code)) return "terminal";
  const { status } = input;
  // No status means no answer arrived: transport, not a verdict. The office may still have
  // recorded the item, so the same saved item is sent again under its own key.
  if (status === undefined) return "retryable";
  if (status === 409 || status === 412) return "conflict";
  if (status === 408 || status === 429 || status >= 500) return "retryable";
  if (status >= 400) return "terminal";
  return "retryable";
}

export interface OutboxFailureGuidance {
  /** Why this item stopped, in the crew member's language. */
  reason: string;
  /** The one thing to do next. Never "contact support", never a retry that cannot work. */
  nextStep: string;
  /** False when trying the same item again can only fail the same way. */
  retryable: boolean;
  /**
   * True only when the office refused the item before acting on it, so "not sent" is a fact.
   * A stopped item is otherwise "not confirmed": an answer that could not be verified, a
   * conflict or a server error may follow work the office already recorded.
   */
  notSent: boolean;
}

/**
 * What a crew member reads on a stopped item. Known refusals get their own next step; everything
 * else says plainly that the office refused it. The server's own words are never shown (they are
 * not written for a crew); they stay on the saved item for whoever checks it.
 */
export function outboxFailureGuidance(
  action: Pick<OutboxAction, "kind" | "lastError" | "conflict">,
): OutboxFailureGuidance {
  const error: OutboxErrorDetail | undefined = action.lastError;
  const conflict: OutboxConflict | undefined = action.conflict;
  if (conflict) {
    return {
      reason: "The office copy changed after this item was saved.",
      nextStep:
        "Keep this item saved. Ask the office to check both copies before you make a new one.",
      retryable: false,
      notSent: false,
    };
  }
  // The office answered, but not with this exact item. It may already be recorded, so neither
  // "not sent" nor a resend is safe: someone has to look at what the office has.
  if (error && unconfirmedCodes.has(error.code)) {
    return {
      reason:
        "The office answered, but this phone could not confirm the office has this exact item.",
      nextStep:
        "Do not save it again. Call the office and ask whether it arrived. It stays on this phone.",
      retryable: false,
      notSent: false,
    };
  }
  const failureClass = classifyOutboxFailure({
    ...(error?.status === undefined ? {} : { status: error.status }),
    ...(error?.code === undefined ? {} : { code: error.code }),
  });
  if (failureClass === "retryable") {
    return {
      reason: "The server could not take this item yet.",
      nextStep: "Try again once you have signal. Nothing was lost.",
      retryable: true,
      notSent: false,
    };
  }
  if (error && evidenceNeedsWorkPackageCodes.has(error.code)) {
    return {
      reason: "Production has not issued a work plan for this job, so files cannot be filed to it.",
      nextStep:
        "Your files stay on this phone. Ask production to issue the work plan, then add them again. You can send a note-only blocker report now.",
      retryable: false,
      notSent: true,
    };
  }
  return {
    reason: "The office refused this saved item.",
    nextStep:
      "Sending it again will not change the answer. Keep it on this phone and tell the office.",
    retryable: false,
    notSent: true,
  };
}
