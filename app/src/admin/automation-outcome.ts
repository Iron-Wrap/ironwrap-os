import type { AutomationDispatch, AutomationDispatchStatus } from "./configuration-contracts";

/**
 * Turning one automation firing into something an administrator can act on.
 *
 * Three things had to be true for this to be honest.
 *
 * First, `unknown` is its own answer. The effect ledger writes it when it could not verify what
 * the provider did — the message may well have gone out. Folding it into "sent" would claim a
 * delivery nobody checked; folding it into "failed" would send an administrator chasing a message
 * the customer already has. It gets its own tone, its own verb, and its own next step.
 *
 * Second, a result code is provenance, never the message. `gmail_readback_id_missing` is a true
 * thing to record and a useless thing to read. Every curated code maps to a sentence about the
 * work; an uncurated one falls back to a sentence about its OUTCOME, and the raw code travels
 * beside it as small print so an engineer can still trace it.
 *
 * Third, nothing here names a vertical, a provider product, or a customer. The copy describes the
 * automation and what to do next.
 */

export type AutomationOutcomeTone = "ok" | "danger" | "warning" | "info";

export interface AutomationOutcomeCopy {
  /** One or two words for the badge. */
  label: string;
  tone: AutomationOutcomeTone;
  /** A sentence about the work, safe to show any administrator. */
  reason: string;
  /** What to do about it, or null when nothing is required. */
  nextStep: string | null;
}

const STATUS_COPY: Record<
  AutomationDispatchStatus,
  { label: string; tone: AutomationOutcomeTone; reason: string; nextStep: string | null }
> = {
  pending: {
    label: "Waiting",
    tone: "info",
    reason: "This firing is queued and has not been attempted yet.",
    nextStep: null,
  },
  claimed: {
    label: "Running",
    tone: "info",
    reason: "This firing is being worked on right now.",
    nextStep: null,
  },
  retry: {
    label: "Retrying",
    tone: "warning",
    reason: "The first attempt did not get through and another one is scheduled.",
    nextStep: "Nothing to do yet. Check back shortly.",
  },
  succeeded: {
    label: "Sent",
    tone: "ok",
    reason: "The automation ran and delivery was confirmed.",
    nextStep: null,
  },
  failed: {
    label: "Failed",
    tone: "danger",
    reason: "The automation ran and did not go through.",
    nextStep: "Nothing was sent. Fix the cause below, then move the card again.",
  },
  // Deliberately neither of the two above. See the note at the top of this file.
  unknown: {
    label: "Not confirmed",
    tone: "warning",
    reason:
      "The automation ran, but delivery could not be confirmed. It may have gone through and it may not.",
    nextStep: "Check with the recipient before sending it again, so nobody gets it twice.",
  },
};

/**
 * Codes worth their own sentence. Everything else is answered by its status, which is always
 * true even when the code is one nobody has written copy for yet.
 */
const RESULT_CODE_COPY: Record<string, { reason: string; nextStep?: string | null }> = {
  delivered: { reason: "The automation ran and delivery was confirmed.", nextStep: null },
  recovered_effect_success: {
    reason: "An earlier attempt had already been delivered; this firing confirmed it.",
    nextStep: null,
  },
  provider_retryable: {
    reason: "The email service was busy or unreachable, so another attempt is scheduled.",
    nextStep: "Nothing to do yet. Check back shortly.",
  },
  automation_retry_exhausted: {
    reason: "Every allowed attempt was used and none got through.",
    nextStep: "Nothing was sent. Check the recipient configuration, then move the card again.",
  },
  automation_recipient_config_unavailable: {
    reason: "The list of who this should go to could not be read, so nothing was sent.",
    nextStep: "Ask an administrator to restore the recipient configuration.",
  },
  automation_recipient_config_malformed: {
    reason: "The recipient configuration could not be read safely, so nothing was sent.",
    nextStep: "Ask an administrator to repair the recipient configuration.",
  },
  automation_recipient_ref_unknown: {
    reason: "This rule points at a recipient that is no longer configured.",
    nextStep: "Revise the rule and choose an available recipient.",
  },
  automation_recipient_digest_changed: {
    reason:
      "The recipient changed after this firing started, so it was stopped rather than sent to the wrong place.",
    nextStep: "Move the card again to send it to the current recipient.",
  },
  automation_recipient_digest_missing: {
    reason: "The recipient could not be confirmed when this firing started, so nothing was sent.",
    nextStep: "Move the card again once the recipient configuration is available.",
  },
  automation_transition_context_missing: {
    reason: "The record this firing was about could not be read, so nothing was sent.",
    nextStep: "Check that the card still exists, then move it again.",
  },
  automation_action_unregistered: {
    reason: "This rule asks for something this deployment does not offer.",
    nextStep: "Revise the rule and choose an action from the list.",
  },
  automation_document_generation_unavailable: {
    reason: "Document generation is switched off in this deployment, so no document was produced.",
    nextStep: "Ask an administrator to enable document generation, then move the card again.",
  },
  automation_document_permit_expired: {
    reason: "This firing waited too long to be allowed to produce its document.",
    nextStep: "Nothing was sent. Move the card again.",
  },
  automation_document_failed: {
    reason: "The document could not be produced, so nothing was sent.",
    nextStep: "Check that the document's fields are still active, then move the card again.",
  },
  automation_document_unknown: {
    reason: "The document may or may not have been produced; it could not be confirmed.",
    nextStep: "Check with the recipient before sending it again.",
  },
  automation_lease_expired: {
    reason: "This firing stopped partway through and was picked up for review.",
    nextStep: "Check with the recipient before sending it again.",
  },
  automation_provider_uncertain: {
    reason: "The email service did not answer clearly, so delivery could not be confirmed.",
    nextStep: "Check with the recipient before sending it again.",
  },
  automation_provider_error: {
    reason: "The email service refused this message.",
    nextStep: "Nothing was sent. Check the recipient configuration, then move the card again.",
  },
  automation_drain_failed: {
    reason: "This firing could not be started.",
    nextStep: "Nothing was sent. Move the card again.",
  },
  gmail_readback_id_missing: {
    reason:
      "The email service accepted the message but returned nothing to check it against, so delivery could not be confirmed.",
    nextStep: "Check with the recipient before sending it again.",
  },
  drive_readback_id_missing: {
    reason:
      "The file service accepted the document but returned nothing to check it against, so it could not be confirmed.",
    nextStep: "Check with the recipient before sending it again.",
  },
};

export function automationOutcomeCopy(
  status: AutomationDispatchStatus,
  resultCode: string | null | undefined,
): AutomationOutcomeCopy {
  const base = STATUS_COPY[status];
  const detail = resultCode ? RESULT_CODE_COPY[resultCode] : undefined;
  if (!detail) return { ...base };
  return {
    label: base.label,
    tone: base.tone,
    reason: detail.reason,
    // `undefined` means "the code has nothing extra to say"; an explicit `null` means "and
    // nothing is required of you", which is a different claim and must survive the merge.
    nextStep: detail.nextStep === undefined ? base.nextStep : detail.nextStep,
  };
}

/** Newest first — an administrator opens this to answer "did the last one work?". */
export function sortAutomationActivity(activity: AutomationDispatch[]): AutomationDispatch[] {
  return [...activity].sort((left, right) => {
    const byTime = right.created_at.localeCompare(left.created_at);
    return byTime !== 0 ? byTime : right.invocation_id.localeCompare(left.invocation_id);
  });
}

/**
 * The one-line answer for the whole rule, so an administrator does not have to open the panel to
 * learn something went wrong. A failure outranks an unconfirmed firing, which outranks anything
 * still in flight; a rule whose recent firings all landed says so and nothing more.
 */
export function automationActivitySummary(
  activity: AutomationDispatch[],
  truncated = false,
): { tone: AutomationOutcomeTone; label: string } | null {
  if (activity.length === 0) return null;
  const failed = activity.filter((entry) => entry.status === "failed").length;
  if (failed > 0) return { tone: "danger", label: failed === 1 ? "1 failed" : `${failed} failed` };
  const unconfirmed = activity.filter((entry) => entry.status === "unknown").length;
  if (unconfirmed > 0)
    return {
      tone: "warning",
      label: unconfirmed === 1 ? "1 not confirmed" : `${unconfirmed} not confirmed`,
    };
  const inFlight = activity.filter(
    (entry) => entry.status === "pending" || entry.status === "claimed" || entry.status === "retry",
  ).length;
  if (inFlight > 0)
    return { tone: "info", label: inFlight === 1 ? "1 in progress" : `${inFlight} in progress` };
  // The three labels above are lower bounds and stay true whatever the window clipped: one failure
  // found is one failure to act on. The all-clear is the only one that asserts COMPLETENESS, so
  // when the server says it clipped older firings, the badge names the window instead of counting
  // it - "20 most recent sent" is an all-clear about what was read, not about the rule's whole life.
  if (truncated) return { tone: "ok", label: `${activity.length} most recent sent` };
  return { tone: "ok", label: activity.length === 1 ? "1 sent" : `${activity.length} sent` };
}
