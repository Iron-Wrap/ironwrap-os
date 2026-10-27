import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { Field } from "../../components/ui/field";
import { Textarea } from "../../components/ui/textarea";
import { reverseGate, newGateKey } from "./gate-api";
import { gateCopy } from "./gate-copy";
import {
  MAX_REASON_LENGTH,
  MIN_REASON_LENGTH,
  type GateEntry,
  type GateName,
  type JobGate,
} from "./gate-contracts";
import { entryInForce } from "./gate-model";
import { gateErrorWords } from "./gate-refusals";
import { entryWho, proofSummary, stampOf, type GateScreen } from "./gate-screen";
import { ActionRow, ErrorBanner, GateField, HeldButton, NextLine } from "./gate-ui";

function entryKindWords(entry: GateEntry): string {
  if (entry.kind === "reverse") return gateCopy.history.reversed;
  if (entry.kind === "waiver_request") return gateCopy.history.waiverAsked;
  if (entry.kind === "waiver_decision") {
    return entry.to_state === "waived" ? gateCopy.history.waived : gateCopy.history.declined;
  }
  if (entry.kind === "legacy") return gateCopy.history.earlier;
  return gateCopy.history.cleared;
}

function entryLine(screen: GateScreen, gate: GateName, entry: GateEntry): string {
  if (entry.basis === "contract_no_deposit") return gateCopy.history.noDeposit;
  if (entry.basis === "crew_assignment") return gateCopy.history.crewScheduled;
  if (entry.basis === "crew_superseded") return gateCopy.history.crewReplaced;
  if (entry.kind === "legacy") return gateCopy.history.earlier;
  const who = gateCopy.history.who(entry.actor_role);
  if (entry.kind === "clear" && entry.basis === "person_attestation") {
    return gateCopy.history.line(who, proofSummary(screen, gate, entry));
  }
  const reason = entry.reason_redacted ? gateCopy.history.removedReason : (entry.reason ?? "");
  return gateCopy.history.line(who, reason);
}

/** The gate's entries, newest first, as the frames list them. Nothing is ever deleted. */
export function GateHistory({ screen, gate }: { screen: GateScreen; gate: JobGate }) {
  if (gate.entries.length === 0) return null;
  const entries = [...gate.entries].reverse();
  return (
    <section aria-label={gateCopy.page.historyTitle} className="grid gap-3">
      <h2 className="text-base font-bold">{gateCopy.page.historyTitle}</h2>
      <ol className="grid gap-3">
        {entries.map((entry) => (
          <li key={entry.id}>
            <GateField
              label={gateCopy.history.title(
                stampOf(screen, entry.created_at),
                entryKindWords(entry),
              )}
              value={entryLine(screen, gate.gate, entry)}
            />
          </li>
        ))}
      </ol>
      {gate.ledger_complete ? null : (
        <p className="text-sm text-muted">{gateCopy.page.historyIncomplete}</p>
      )}
    </section>
  );
}

/** Frame 13a: a cleared or waived gate, with the reversal that sends it back to blocked. */
export function ReversalPanel({ screen, gate }: { screen: GateScreen; gate: JobGate }) {
  const entry = entryInForce(gate);
  const [reason, setReason] = useState("");
  const [failure, setFailure] = useState<{ text: string; error: unknown }>();
  const mutation = useMutation({
    retry: false,
    mutationFn: async (input: { reason: string; reversesId: string }) =>
      await reverseGate(
        screen.session,
        {
          jobId: screen.jobId,
          gate: gate.gate,
          expectedGateVersion: gate.version,
          reversesId: input.reversesId,
          reason: input.reason,
        },
        newGateKey("reversal"),
      ),
    onSuccess: async () => {
      setFailure(undefined);
      setReason("");
      await screen.refresh();
    },
    onError: (error) => setFailure({ text: gateErrorWords(error), error }),
  });
  if (!entry) return null;
  const trimmed = reason.trim();
  const ready = trimmed.length >= MIN_REASON_LENGTH && trimmed.length <= MAX_REASON_LENGTH;
  const stamp = stampOf(screen, entry.created_at);
  const label =
    gate.state === "waived"
      ? gateCopy.reversal.waivedBy(stamp, entryWho(entry))
      : gateCopy.reversal.clearedBy(stamp, entryWho(entry));
  const summary =
    entry.kind === "clear" && entry.basis === "person_attestation"
      ? proofSummary(screen, gate.gate, entry)
      : entry.reason_redacted
        ? gateCopy.history.removedReason
        : (entry.reason ?? "");
  return (
    <div className="grid gap-4">
      <GateField label={label} value={summary} />
      <Field label={gateCopy.reversal.why}>
        {(control) => (
          <Textarea
            {...control}
            value={reason}
            maxLength={MAX_REASON_LENGTH}
            onChange={(event) => setReason(event.target.value)}
          />
        )}
      </Field>
      {failure ? <ErrorBanner error={failure.error}>{failure.text}</ErrorBanner> : null}
      <ActionRow>
        <Button
          type="button"
          busy={mutation.isPending}
          disabled={!ready || screen.offline}
          onClick={() => mutation.mutate({ reason: trimmed, reversesId: entry.id })}
        >
          {gateCopy.reversal.reverse}
        </Button>
        <HeldButton
          label={`${gateCopy.reversal.rightProof(gate.gate)} · ${gateCopy.reversal.afterReverse}`}
        />
      </ActionRow>
      <NextLine>{gateCopy.reversal.next(gate.gate)}</NextLine>
    </div>
  );
}
