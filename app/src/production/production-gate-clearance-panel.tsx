import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, CircleCheck, ShieldCheck } from "lucide-react";
import { useState } from "react";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { Button } from "../components/ui/button";
import { ApiError } from "../lib/api";
import {
  clearProductionGate,
  newProductionGateClearanceKey,
} from "./production-gate-clearance-api";
import {
  MIN_WAIVER_REASON_LENGTH,
  MAX_WAIVER_REASON_LENGTH,
  productionGateClearanceMessages,
  type ClearableProductionGate,
} from "./production-gate-clearance-contracts";
import type { ProductionRunwayJob } from "./production-contracts";

/**
 * The clearing surface for the six scheduling locks (ELEC-122).
 *
 * It lives on the runway card rather than behind its own route because that is
 * where the gate badges already are and where the office manager is already
 * looking. On a phone the whole interaction is one tap to choose a gate and one
 * more to record the decision, with the reason field the only typing - the
 * runway is read from a truck cab more often than a desk.
 *
 * Waiving is deliberately not dressed up. The button says waive, the confirmation
 * says waived, and the chip stays amber: a gate somebody decided to skip must
 * never read like a gate somebody proved.
 */
export function GateClearancePanel({ job }: { job: ProductionRunwayJob }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const offline = isOfflineSession(session);
  const [openGate, setOpenGate] = useState<ClearableProductionGate | null>(null);
  const [reason, setReason] = useState("");
  const [failure, setFailure] = useState<string>();

  const blocked = job.scheduling_gates.filter((gate) => gate.state === "Blocked");
  const mutation = useMutation({
    retry: false,
    mutationFn: async (input: {
      gate: ClearableProductionGate;
      basis: "office_waiver" | "deposit_settlement";
      reason?: string;
    }) =>
      await clearProductionGate(
        session,
        { roofJobId: job.id, ...input },
        newProductionGateClearanceKey(),
      ),
    onSuccess: async () => {
      setFailure(undefined);
      setOpenGate(null);
      setReason("");
      await queryClient.invalidateQueries({ queryKey: ["production-runway"] });
    },
    onError: (error) => setFailure(messageFor(error)),
  });

  if (blocked.length === 0) return null;

  const trimmed = reason.trim();
  const reasonReady =
    trimmed.length >= MIN_WAIVER_REASON_LENGTH && trimmed.length <= MAX_WAIVER_REASON_LENGTH;

  return (
    <details className="group mt-4 border-t border-border/80" aria-label="Clear a scheduling lock">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 py-2 text-sm [&::-webkit-details-marker]:hidden">
        <span>
          <span className="block font-semibold text-foreground">
            {blocked.length === 1
              ? "1 lock still blocks this schedule"
              : `${blocked.length} locks still block this schedule`}
          </span>
          <span className="mt-0.5 block text-xs text-muted">Review clearance choices</span>
        </span>
        <ChevronDown
          className="size-4 shrink-0 text-muted transition-transform group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="border-t border-border/80 pt-3">
        <ul className="space-y-2">
          {blocked.map((gate) => {
            const name = gate.name as ClearableProductionGate;
            const open = openGate === name;
            return (
              <li key={name}>
                <Button
                  variant={open ? "default" : "outline"}
                  size="compact"
                  fullWidth
                  aria-expanded={open}
                  aria-controls={`gate-clearance-${job.id}-${name}`}
                  onClick={() => {
                    setFailure(undefined);
                    setReason("");
                    setOpenGate(open ? null : name);
                  }}
                >
                  {open ? `Close ${name}` : `Clear ${name}`}
                </Button>
                {open ? (
                  <div
                    id={`gate-clearance-${job.id}-${name}`}
                    className="mt-2 space-y-3 border border-border bg-surface p-3"
                  >
                    {name === "Deposit" ? (
                      <Button
                        variant="accent"
                        size="compact"
                        fullWidth
                        busy={mutation.isPending}
                        disabled={offline}
                        onClick={() => mutation.mutate({ gate: name, basis: "deposit_settlement" })}
                      >
                        <ShieldCheck aria-hidden="true" />
                        Clear on the settled deposit
                      </Button>
                    ) : null}
                    <label
                      className="block text-sm font-semibold"
                      htmlFor={`gate-waiver-${job.id}-${name}`}
                    >
                      Why is {name} being waived?
                    </label>
                    <textarea
                      id={`gate-waiver-${job.id}-${name}`}
                      className="min-h-24 w-full border border-border bg-surface px-3 py-2 text-base"
                      maxLength={MAX_WAIVER_REASON_LENGTH}
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      placeholder="Recorded against your name on this gate."
                    />
                    <Button
                      variant="outline"
                      size="compact"
                      fullWidth
                      busy={mutation.isPending}
                      disabled={offline || !reasonReady}
                      onClick={() =>
                        mutation.mutate({ gate: name, basis: "office_waiver", reason: trimmed })
                      }
                    >
                      <CircleCheck aria-hidden="true" />
                      Waive {name} on my authority
                    </Button>
                    <p className="text-xs leading-5 text-muted">
                      A waiver is a decision, not a proof. It is recorded with your name, the reason
                      and the time, and the lock stays visible as waived.
                    </p>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
        {offline ? (
          <p className="mt-2 text-sm leading-6 text-muted">
            This session is offline; a clearance is only recorded online.
          </p>
        ) : null}
        {failure ? (
          <p className="mt-2 text-sm leading-6 text-danger" role="alert">
            {failure}
          </p>
        ) : null}
      </div>
    </details>
  );
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return (
      productionGateClearanceMessages[error.code] ??
      "IronWrap OS refused this clearance and changed nothing. Reload the runway and try again."
    );
  }
  return "The clearance could not be sent. Nothing was changed.";
}
