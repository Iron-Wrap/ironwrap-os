import { useGateMutation } from "./gate-mutation";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { Field } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { newGateKey, recordSignedCopy } from "./gate-api";
import { gateCopy, held } from "./gate-copy";
import {
  MAX_EVIDENCE_LENGTH,
  MAX_REASON_LENGTH,
  MIN_REASON_LENGTH,
  type CancellationWindow,
  type SignedCopyRecordResponse,
} from "./gate-contracts";
import { canRecordSignedCopy } from "./gate-model";
import { recordRefusal, type RecordRefusal } from "./gate-refusals";
import { heldScheduleLabel, windowRowText, type GateScreen } from "./gate-screen";
import { capitalized, instantFromLocal, officeStamp, proseTime, windowDeadline } from "./gate-time";
import {
  ActionRow,
  BackToList,
  ErrorBanner,
  GateField,
  HeldButton,
  InfoBanner,
  NextLine,
} from "./gate-ui";

/**
 * When the customer received their copy of the signed contract (P30 frames 19-23). Owner or ops
 * only: the record step's control is never drawn for anyone else, whatever a frame shows. The
 * time can only move later; the Worker refuses an earlier one, a future one, one before the
 * contract, and a record without its reason and evidence, each by name.
 */

const IDS = {
  received: "signed-copy-received",
  reason: "signed-copy-reason",
  evidence: "signed-copy-evidence",
} as const;

export function WindowStep({ screen }: { screen: GateScreen }) {
  const cw = screen.model.cancellation_window;
  const name = screen.customerName;
  const zone = cw.time_zone;
  const stampIn = (value: string | null | undefined, timeZone: string | null = zone) =>
    officeStamp(value, { timeZone: timeZone ?? zone, now: screen.now }) ?? "";
  const proseIn = (value: string | null | undefined, timeZone: string | null = zone) =>
    proseTime(value, { timeZone: timeZone ?? zone, now: screen.now }) ?? "";

  const [received, setReceived] = useState("");
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState("");
  const [timeError, setTimeError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<RecordRefusal | null>(null);
  const [recorded, setRecorded] = useState<SignedCopyRecordResponse | null>(null);
  const [unchanged, setUnchanged] = useState(false);

  const mutation = useGateMutation(screen, {
    mutationFn: async (input: { receivedAt: string; reason: string; evidenceRef: string }) =>
      await recordSignedCopy(
        screen.session,
        { jobId: screen.jobId, ...input },
        newGateKey("signed-copy"),
      ),
    onSuccess: async (answer) => {
      setRefusal(null);
      if (answer.unchanged) {
        setUnchanged(true);
      } else {
        setRecorded(answer);
      }
      await screen.refresh();
    },
    onError: (error) => setRefusal(recordRefusal(error)),
  });

  const focus = (id: string) =>
    globalThis.setTimeout(
      () => document.querySelector<HTMLElement>(`[data-focus="${id}"]`)?.focus(),
      0,
    );
  const contractStamp = cw.contract ? stampIn(cw.contract.signed_at) : null;
  const typedInstant = instantFromLocal(received, zone);

  if (!canRecordSignedCopy(screen.role)) {
    return (
      <div className="grid gap-4">
        <GateField label={gateCopy.overview.windowLabel} value={windowRowText(screen)} />
        <OnRecord screen={screen} cw={cw} />
        <InfoBanner>{gateCopy.record.readOnly(name)}</InfoBanner>
        <ActionRow>
          <BackToList jobId={screen.jobId} />
        </ActionRow>
      </div>
    );
  }

  // Frame 20b.
  if (recorded) {
    const after = recorded.cancellation_window;
    const deadline = windowDeadline(after, screen.now);
    const receipt = after.signed_copy_received;
    const scheduleAfter = heldScheduleLabel({ ...screen.model, cancellation_window: after });
    const banner =
      after.state === "ended"
        ? deadline.kind === "exact"
          ? gateCopy.record.recordedEndedExact(deadline.label)
          : gateCopy.record.recordedEnded(deadline.kind === "day" ? deadline.label : "")
        : deadline.kind === "exact"
          ? gateCopy.record.recordedOpenExact(deadline.label)
          : gateCopy.record.recordedOpen(deadline.kind === "day" ? deadline.label : "");
    return (
      <div className="grid gap-4">
        <InfoBanner>{banner}</InfoBanner>
        {receipt ? (
          <>
            <GateField
              label={gateCopy.record.received}
              value={
                receipt.id === recorded.receipt_id
                  ? gateCopy.record.recordedLine(
                      stampIn(receipt.received_at, receipt.time_zone),
                      stampIn(receipt.recorded_at, receipt.time_zone),
                    )
                  : gateCopy.record.onRecordManual(
                      stampIn(receipt.received_at, receipt.time_zone),
                      stampIn(receipt.recorded_at, receipt.time_zone),
                      gateCopy.record.whoName(
                        receipt.recorded_by.display_name,
                        receipt.recorded_by.role,
                      ),
                    )
              }
            />
            <GateField label={gateCopy.record.evidenceField} value={receipt.evidence_ref} />
          </>
        ) : null}
        <ActionRow>
          <BackToList jobId={screen.jobId} />
          {scheduleAfter ? <HeldButton label={scheduleAfter} /> : null}
        </ActionRow>
        {after.state === "open" && deadline.kind === "day" ? (
          <NextLine>{gateCopy.record.nextRecorded(deadline.label)}</NextLine>
        ) : null}
      </div>
    );
  }

  const submitLabel = gateCopy.record.submit(name);
  const known = cw.state !== "unknown";
  const recordedStart = cw.starts_at;

  // Frame 20c.
  if (refusal?.kind === "missing") {
    const both = refusal.reason && refusal.evidence;
    const control = both
      ? gateCopy.record.addBoth
      : refusal.reason
        ? gateCopy.record.addReason
        : gateCopy.record.addEvidence;
    return (
      <div className="grid gap-4">
        {received ? (
          <GateField label={gateCopy.record.received} value={stampIn(typedInstant?.iso)} />
        ) : null}
        <GateField
          label={gateCopy.record.why}
          value={refusal.reason ? gateCopy.record.reasonMissing(name) : reason}
          required={refusal.reason}
        />
        <GateField
          label={gateCopy.record.evidence}
          value={refusal.evidence ? gateCopy.record.evidenceMissing : evidence}
          required={refusal.evidence}
        />
        <ErrorBanner>
          {both
            ? gateCopy.record.missingBoth
            : refusal.reason
              ? gateCopy.record.missingReason
              : gateCopy.record.missingEvidence}
        </ErrorBanner>
        <ActionRow>
          <Button
            type="button"
            onClick={() => {
              setRefusal(null);
              focus(refusal.reason ? IDS.reason : IDS.evidence);
            }}
          >
            {control}
          </Button>
          <HeldButton
            label={held(submitLabel, both ? gateCopy.record.afterBoth : gateCopy.record.afterOne)}
          />
        </ActionRow>
      </div>
    );
  }

  // Frames 21 and 22.
  if (refusal?.kind === "before_contract" || refusal?.kind === "in_future") {
    const typed = stampIn(refusal.receivedAt, refusal.timeZone);
    const title =
      refusal.kind === "before_contract"
        ? gateCopy.record.beforeContract(
            capitalized(proseIn(refusal.receivedAt, refusal.timeZone)),
            stampIn(refusal.contractSignedAt, refusal.timeZone),
            name,
          )
        : gateCopy.record.inFuture(
            capitalized(proseIn(refusal.receivedAt, refusal.timeZone)),
            name,
          );
    return (
      <div className="grid gap-4">
        <GateField label={gateCopy.record.received} value={typed} />
        <GateField label={gateCopy.record.why} value={reason} />
        <GateField label={gateCopy.record.evidence} value={evidence} />
        <ErrorBanner>{title}</ErrorBanner>
        <ActionRow>
          <Button
            type="button"
            onClick={() => {
              setRefusal(null);
              focus(IDS.received);
            }}
          >
            {gateCopy.record.changeTime}
          </Button>
          <HeldButton label={held(submitLabel, gateCopy.record.afterChange)} />
        </ActionRow>
        <NextLine>{gateCopy.record.nextChange(contractStamp)}</NextLine>
      </div>
    );
  }

  // Frame 23.
  if (refusal?.kind === "earlier") {
    const deadline = windowDeadline(cw, screen.now);
    return (
      <div className="grid gap-4">
        <OnRecord screen={screen} cw={cw} />
        <GateField
          label={gateCopy.record.newTime}
          value={stampIn(refusal.receivedAt, refusal.timeZone)}
        />
        <ErrorBanner>
          {gateCopy.record.earlier(capitalized(proseIn(refusal.receivedAt, refusal.timeZone)))}
        </ErrorBanner>
        <ActionRow>
          <Button
            type="button"
            onClick={() => {
              setRefusal(null);
              setReceived("");
            }}
          >
            {gateCopy.record.keep(stampIn(refusal.recordedAt, refusal.timeZone))}
          </Button>
        </ActionRow>
        <NextLine>
          {gateCopy.record.nextEarlier(
            cw.state === "open" && deadline.kind === "day" ? deadline.label : null,
          )}
        </NextLine>
      </div>
    );
  }

  // Frame 20, and the same form once a time is on record.
  const submit = () => {
    setUnchanged(false);
    const reasonText = reason.trim();
    const evidenceText = evidence.trim();
    const reasonMissing = reasonText.length < MIN_REASON_LENGTH;
    const evidenceMissing = evidenceText.length === 0;
    if (!typedInstant) {
      setTimeError(received ? gateCopy.record.timeInvalid : gateCopy.record.timeMissing);
      focus(IDS.received);
      return;
    }
    setTimeError(null);
    if (reasonMissing || evidenceMissing) {
      setRefusal({ kind: "missing", reason: reasonMissing, evidence: evidenceMissing });
      return;
    }
    mutation.mutate({
      receivedAt: typedInstant.withOffset,
      reason: reasonText,
      evidenceRef: evidenceText,
    });
  };

  return (
    <form
      className="grid gap-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <InfoBanner>{gateCopy.record.rule(screen.role, name, contractStamp)}</InfoBanner>
      {known && recordedStart ? <OnRecord screen={screen} cw={cw} /> : null}
      <Field
        label={known ? gateCopy.record.newTime : gateCopy.record.received}
        error={timeError ?? undefined}
      >
        {(control) => (
          <Input
            {...control}
            data-focus={IDS.received}
            type="datetime-local"
            value={received}
            onChange={(event) => setReceived(event.target.value)}
          />
        )}
      </Field>
      <Field label={gateCopy.record.why}>
        {(control) => (
          <Textarea
            {...control}
            data-focus={IDS.reason}
            value={reason}
            maxLength={MAX_REASON_LENGTH}
            onChange={(event) => setReason(event.target.value)}
          />
        )}
      </Field>
      <Field label={gateCopy.record.evidence} help={gateCopy.record.evidenceHelp}>
        {(control) => (
          <Input
            {...control}
            data-focus={IDS.evidence}
            value={evidence}
            maxLength={MAX_EVIDENCE_LENGTH}
            onChange={(event) => setEvidence(event.target.value)}
          />
        )}
      </Field>
      {unchanged ? <InfoBanner>{gateCopy.record.unchanged}</InfoBanner> : null}
      {refusal?.kind === "message" ? (
        <ErrorBanner error={refusal.error}>{refusal.text}</ErrorBanner>
      ) : null}
      <ActionRow>
        <Button type="submit" busy={mutation.isPending} disabled={screen.offline}>
          {submitLabel}
        </Button>
      </ActionRow>
      {screen.offline ? <p className="text-sm text-muted">{gateCopy.page.offline}</p> : null}
      <NextLine>{gateCopy.record.next(name)}</NextLine>
    </form>
  );
}

/** "Signed copy received, on record" (frame 23), from a person's record or the portal's copy. */
function OnRecord({ screen, cw }: { screen: GateScreen; cw: CancellationWindow }) {
  const zone = cw.time_zone;
  const stamp = (value: string | null | undefined, timeZone = zone) =>
    officeStamp(value, { timeZone, now: screen.now }) ?? "";
  if (cw.started_from === "manual_record" && cw.signed_copy_received) {
    const receipt = cw.signed_copy_received;
    return (
      <GateField
        label={gateCopy.record.onRecord}
        value={gateCopy.record.onRecordManual(
          stamp(receipt.received_at, receipt.time_zone),
          stamp(receipt.recorded_at, receipt.time_zone),
          gateCopy.record.whoName(receipt.recorded_by.display_name, receipt.recorded_by.role),
        )}
      />
    );
  }
  if (cw.started_from === "signed_copy_shown" && cw.starts_at) {
    return (
      <GateField
        label={gateCopy.record.onRecord}
        value={gateCopy.record.onRecordShown(stamp(cw.starts_at))}
      />
    );
  }
  return null;
}
