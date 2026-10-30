import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { Field } from "../../components/ui/field";
import { Textarea } from "../../components/ui/textarea";
import {
  clearProductionGate,
  newProductionGateClearanceKey,
} from "../production-gate-clearance-api";
import { decideWaiver, newGateKey } from "./gate-api";
import { gateCopy } from "./gate-copy";
import {
  isAttestableGate,
  MAX_REASON_LENGTH,
  MIN_REASON_LENGTH,
  type JobGate,
} from "./gate-contracts";
import {
  latestWaiverDecision,
  overviewClearable,
  stepForGate,
  waiverStage,
  windowHolds,
} from "./gate-model";
import { gateErrorWords, gateRefusal } from "./gate-refusals";
import { stampOf, type GateScreen } from "./gate-screen";
import { proseTime } from "./gate-time";
import {
  ActionRow,
  BackToList,
  ErrorBanner,
  GateField,
  InfoBanner,
  NextLine,
  StepLink,
} from "./gate-ui";
import { GateHistory } from "./gate-history";

/**
 * Asking for, waiting on and deciding a waiver (P30 frames 8a, 8, 9, 10 and 10b). A waiver is the
 * owner's decision: production asks, an owner decides, and the only owner may approve their own
 * item with a reason (D-08). The gate stays blocked until the decision.
 */
export function WaiverStep({ screen, gate }: { screen: GateScreen; gate: JobGate }) {
  const [reason, setReason] = useState("");
  const [failure, setFailure] = useState<{ text: string; error: unknown }>();
  const [approvedOwn, setApprovedOwn] = useState<{ reason: string } | null>(null);
  const stage = waiverStage(gate, screen.role);
  const trimmed = reason.trim();
  const reasonReady = trimmed.length >= MIN_REASON_LENGTH && trimmed.length <= MAX_REASON_LENGTH;
  const when = (value: string) =>
    proseTime(value, { timeZone: screen.timeZone, now: screen.now }) ?? "";

  const ask = useMutation({
    retry: false,
    mutationFn: async (input: { reason: string }) =>
      await clearProductionGate(
        screen.session,
        { roofJobId: screen.jobId, gate: gate.gate, basis: "office_waiver", reason: input.reason },
        newProductionGateClearanceKey(),
      ),
    onSuccess: async (result, input) => {
      setFailure(undefined);
      if (
        stage.kind === "owner_request" &&
        result.basis === "office_waiver" &&
        result.clearance === "waived" &&
        result.actor_role === "owner"
      ) {
        setApprovedOwn({ reason: input.reason });
      }
      setReason("");
      await screen.refresh();
    },
    onError: async (error) => {
      // A request recorded for another owner to decide is the expected answer, not a failure.
      if (gateRefusal(error).kind === "waiver_requested") {
        setFailure(undefined);
        setReason("");
        await screen.refresh();
        return;
      }
      setFailure({ text: gateErrorWords(error), error });
    },
  });

  const decide = useMutation({
    retry: false,
    mutationFn: async (input: {
      decision: "approve" | "decline";
      requestId: string;
      reason: string;
    }) =>
      await decideWaiver(
        screen.session,
        {
          jobId: screen.jobId,
          gate: gate.gate,
          requestId: input.requestId,
          expectedGateVersion: gate.version,
          decision: input.decision,
          reason: input.reason,
        },
        newGateKey("waiver-decision"),
      ),
    onSuccess: async () => {
      setFailure(undefined);
      setReason("");
      await screen.refresh();
    },
    onError: (error) => setFailure({ text: gateErrorWords(error), error }),
  });

  const proofStep = isAttestableGate(gate.gate) ? stepForGate(gate.gate) : null;
  const proofInstead = proofStep ? (
    <StepLink jobId={screen.jobId} step={proofStep} variant="secondary">
      {gateCopy.waiver.proofInstead(gate.gate)}
    </StepLink>
  ) : null;
  const failureBanner = failure ? (
    <ErrorBanner error={failure.error}>{failure.text}</ErrorBanner>
  ) : null;
  const reasonField = (label: string) => (
    <Field
      label={label}
      error={
        trimmed.length > 0 && trimmed.length < MIN_REASON_LENGTH
          ? gateCopy.waiver.reasonTooShort
          : undefined
      }
    >
      {(control) => (
        <Textarea
          {...control}
          value={reason}
          maxLength={MAX_REASON_LENGTH}
          onChange={(event) => setReason(event.target.value)}
        />
      )}
    </Field>
  );

  // Frame 10b: the receipt of the only holder's own approval.
  if (approvedOwn) {
    const clearable = overviewClearable(screen.model, screen.role).filter(
      (name) => name !== gate.gate,
    );
    return (
      <div className="grid gap-4">
        <InfoBanner>{gateCopy.waiver.approvedOwn(approvedOwn.reason)}</InfoBanner>
        <GateField label={gate.gate} value={gateCopy.waiver.waivedByYou} />
        <ActionRow>
          <BackToList jobId={screen.jobId} />
        </ActionRow>
        <NextLine>
          {gateCopy.waiver.nextAfterOwn(clearable, windowHolds(screen.model.cancellation_window))}
        </NextLine>
      </div>
    );
  }

  switch (stage.kind) {
    case "not_waivable":
      return (
        <div className="grid gap-4">
          <InfoBanner>{gateCopy.waiver.notWaivable(gate.gate)}</InfoBanner>
          <ActionRow>
            <BackToList jobId={screen.jobId} />
          </ActionRow>
        </div>
      );
    case "read_only": {
      const decision = latestWaiverDecision(gate);
      return (
        <div className="grid gap-4">
          {gate.state === "blocked" && decision && decision.to_state === "blocked" ? (
            <GateField
              label={gateCopy.waiver.ownerAnswer}
              value={gateCopy.waiver.declinedAnswer(
                stampOf(screen, decision.created_at),
                decision.reason_redacted ? null : decision.reason,
              )}
            />
          ) : null}
          {screen.role === "ops" ? <InfoBanner>{gateCopy.waiver.readOnly}</InfoBanner> : null}
          <ActionRow>
            <BackToList jobId={screen.jobId} />
            {gate.state === "blocked" ? proofInstead : null}
          </ActionRow>
          <GateHistory screen={screen} gate={gate} />
        </div>
      );
    }
    case "waiting": {
      const own = stage.request.is_own_request;
      const at = when(stage.request.created_at);
      return (
        <div className="grid gap-4">
          <InfoBanner>
            {own
              ? gateCopy.waiver.recorded(when(stage.request.created_at), gate.gate)
              : gateCopy.waiver.othersRecorded(at, gate.gate)}
          </InfoBanner>
          <GateField
            label={own ? gateCopy.waiver.yourReason : gateCopy.waiver.theirReason}
            value={
              stage.request.reason_redacted
                ? gateCopy.waiver.reasonHidden
                : (stage.request.reason ?? "")
            }
          />
          <ActionRow>
            <BackToList jobId={screen.jobId} />
            {proofInstead}
          </ActionRow>
          <NextLine>
            {gateCopy.waiver.nextWaiting(
              overviewClearable(screen.model, screen.role).filter((name) => name !== gate.gate),
            )}
          </NextLine>
        </div>
      );
    }
    case "decide": {
      const request = stage.request;
      const asker = gateCopy.waiver.askerFromRole(request.requested_by_role);
      const ready = reasonReady && !screen.offline;
      return (
        <div className="grid gap-4">
          <InfoBanner>
            {request.reason && !request.reason_redacted
              ? gateCopy.waiver.asks(asker, gate.gate, request.reason)
              : gateCopy.waiver.asksNoReason(asker, gate.gate)}
          </InfoBanner>
          {reasonField(gateCopy.waiver.decideReason)}
          {failureBanner}
          <ActionRow>
            <Button
              type="button"
              busy={decide.isPending && decide.variables?.decision === "approve"}
              disabled={!ready || decide.isPending}
              onClick={() =>
                decide.mutate({
                  decision: "approve",
                  requestId: request.request_id,
                  reason: trimmed,
                })
              }
            >
              {gateCopy.waiver.approve}
            </Button>
            <Button
              type="button"
              variant="secondary"
              busy={decide.isPending && decide.variables?.decision === "decline"}
              disabled={!ready || decide.isPending}
              onClick={() =>
                decide.mutate({
                  decision: "decline",
                  requestId: request.request_id,
                  reason: trimmed,
                })
              }
            >
              {gateCopy.waiver.decline}
            </Button>
          </ActionRow>
          <NextLine>{gateCopy.waiver.nextDecide(gate.gate)}</NextLine>
        </div>
      );
    }
    case "owner_request":
      return (
        <div className="grid gap-4">
          <InfoBanner>{gateCopy.waiver.ownerRequest}</InfoBanner>
          {reasonField(gateCopy.waiver.whyWaive(gate.gate))}
          {failureBanner}
          <ActionRow>
            <Button
              type="button"
              busy={ask.isPending}
              disabled={!reasonReady || screen.offline}
              onClick={() => ask.mutate({ reason: trimmed })}
            >
              {gateCopy.waiver.submitOwn(gate.gate)}
            </Button>
            {proofInstead}
          </ActionRow>
          <NextLine>{gateCopy.waiver.nextOwn(gate.gate)}</NextLine>
        </div>
      );
    case "ask":
    default:
      return (
        <div className="grid gap-4">
          <InfoBanner>{gateCopy.waiver.ownerDecides(gate.gate)}</InfoBanner>
          {reasonField(gateCopy.waiver.whyWaive(gate.gate))}
          {failureBanner}
          <ActionRow>
            <Button
              type="button"
              busy={ask.isPending}
              disabled={!reasonReady || screen.offline}
              onClick={() => ask.mutate({ reason: trimmed })}
            >
              {gateCopy.waiver.ask(gate.gate)}
            </Button>
            {proofInstead}
          </ActionRow>
          <NextLine>{gateCopy.waiver.nextAsk(gate.gate)}</NextLine>
        </div>
      );
  }
}
