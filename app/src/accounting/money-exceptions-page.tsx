import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, RefreshCw, TriangleAlert } from "lucide-react";
import { useRef, useState } from "react";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { RoleGuard } from "../components/role-guard";
import { WorkspaceHeader } from "../components/workspace-header";
import { Button } from "../components/ui/button";
import { Notice } from "../components/ui/notice";
import { Select } from "../components/ui/select";
import { ErrorState, LoadingState } from "../components/ui/state-panel";
import { ErrorSystemDetails, SystemDetails } from "../components/ui/system-details";
import { ApiError } from "../lib/api";
import { isRefusal } from "../lib/plain-error";
import {
  loadAccountingExceptions,
  newAccountingActionKey,
  resolveAccountingException,
} from "./money-api";
import {
  ageLabel,
  reasonLabel,
  remedyLabel,
  type AccountingExceptionRow,
  type AccountingRemedy,
} from "./money-contracts";

/**
 * Remedies an accountant can record here, because performing them moves no money at the provider.
 *
 * Everything else is a reversal, and a reversal is not something to type a reference for after the
 * fact - it is authorized on the money movement and dispatched by the system, which closes the
 * exception itself on the effect the ledger actually settled. This screen used to offer a free-text
 * "reference of the reversal" box for those, and ELEC-71 closed a real $240 overpayment through it
 * with an invented string. The box is gone; the server refuses the same input independently.
 */
const RECORDABLE_REMEDIES: readonly AccountingRemedy[] = [
  "accepted_as_posted",
  "superseded_by_new_intent",
];

/**
 * Reversals IronWrap can actually run: authorized on the money movement, dispatched by the system.
 *
 * The remaining offered remedies — voiding an entity, posting an adjusting entry — have no dispatch
 * path in any shipped slice. Telling an accountant to "authorize" one would send them to a screen
 * that cannot do it, so they are named separately and honestly.
 */
const DISPATCHABLE_REVERSALS: readonly AccountingRemedy[] = ["credit_memo_issued", "refund_issued"];

/** "A", "A or B", "A, B or C" — a sentence, not a joined array. */
function orList(remedies: readonly AccountingRemedy[]): string {
  const labels = remedies.map((remedy) => remedyLabel(remedy));
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}`;
}

/**
 * The exception queue (IRO-52 slice S9).
 *
 * docs/ACCOUNTING-RECONCILIATION-CONTRACT.md section 8.2: reason code, both hashes, the proposed
 * provider-supported remedies, and the resolve action. The remedies come from the exception itself
 * rather than from a list in the browser, because an exception offers what QuickBooks can actually
 * do about it and nothing else.
 *
 * A remedy that reverses money asks for the compensating effect it claims to have. The server
 * refuses without it, and asking here means the accountant finds out before they commit rather
 * than after.
 */
export function MoneyExceptionsPage() {
  return (
    <RoleGuard surface="accounting">
      <MoneyExceptionsContent />
    </RoleGuard>
  );
}

function MoneyExceptionsContent() {
  const session = useSession();
  const offline = isOfflineSession(session);
  const queryClient = useQueryClient();
  const actionKeys = useRef(new Map<string, string>());
  const [showResolved, setShowResolved] = useState(false);
  const [actionError, setActionError] = useState<{
    text: string;
    error: unknown;
    confirmed: boolean;
  }>();
  const [resolved, setResolved] = useState<string>();

  const queryKey = ["accounting-exceptions", session.tenant.id, showResolved] as const;
  const query = useQuery({
    queryKey,
    queryFn: () => loadAccountingExceptions(showResolved ? undefined : "open"),
    retry: false,
  });

  const mutation = useMutation({
    retry: false,
    mutationFn: async (input: { exceptionId: string; remedy: AccountingRemedy }) => {
      const name = `${input.exceptionId}:${input.remedy}`;
      const key = actionKeys.current.get(name) ?? newAccountingActionKey("resolve");
      actionKeys.current.set(name, key);
      // No compensating effect is ever sent from this screen: the only remedies it offers are the
      // ones that move no money, and a reversal is closed by the dispatcher on the effect the
      // ledger settled.
      return await resolveAccountingException(session, input.exceptionId, input.remedy, null, key);
    },
    onSuccess: async (response) => {
      setActionError(undefined);
      setResolved(response.exception.exception_id);
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: (error) => {
      setResolved(undefined);
      setActionError({ ...closeFailure(error), error });
    },
  });

  if (!query.data && query.isPending) return <LoadingState label="Loading money issues…" />;
  if (!query.data) {
    return (
      <ErrorState
        title="Money issues are unavailable"
        message="Nothing was changed. Reconnect and open this page again."
        onRetry={() => void query.refetch()}
        action={<BackToDesk />}
      />
    );
  }

  const exceptions = query.data.exceptions;
  const canResolve = query.data.allowed_actions.includes("accounting.exception.resolve");

  return (
    <section className="mx-auto max-w-3xl space-y-6 pb-4">
      <WorkspaceHeader
        icon={<TriangleAlert aria-hidden="true" />}
        title="Money issues"
        description="See what needs your help. Each issue shows only safe choices."
        back={<BackToDesk />}
        actions={
          <Button
            type="button"
            variant="outline"
            size="compact"
            busy={query.isFetching}
            disabled={offline || query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RefreshCw aria-hidden="true" />
            Refresh
          </Button>
        }
      />

      {offline ? (
        <Notice tone="warning" title="Reconnect before you decide">
          IronWrap must reach the server before you can close an issue.
        </Notice>
      ) : null}
      {actionError ? (
        <Notice
          tone="danger"
          title={actionError.confirmed ? "Nothing was changed" : "Closing was not confirmed"}
        >
          {actionError.text}
          <ErrorSystemDetails error={actionError.error} />
        </Notice>
      ) : null}
      {resolved ? (
        <Notice tone="success" title="Issue closed">
          Your choice is saved. Nothing was deleted.
        </Notice>
      ) : null}

      <label className="flex min-h-12 items-center gap-3 text-sm font-bold">
        <input
          type="checkbox"
          className="size-5"
          checked={showResolved}
          onChange={(event) => setShowResolved(event.target.checked)}
        />
        Include closed issues
      </label>

      {exceptions.length === 0 ? (
        <p className="border border-border bg-surface px-4 py-6 text-sm leading-6 text-muted sm:px-6">
          Nothing needs your help. All money issues are closed.
        </p>
      ) : (
        <ul className="space-y-4">
          {exceptions.map((exception) => (
            <ExceptionCard
              key={exception.exception_id}
              exception={exception}
              canResolve={canResolve && exception.status !== "resolved"}
              busy={offline || mutation.isPending}
              onResolve={(remedy) =>
                mutation.mutate({ exceptionId: exception.exception_id, remedy })
              }
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function ExceptionCard({
  exception,
  canResolve,
  busy,
  onResolve,
}: {
  exception: AccountingExceptionRow;
  canResolve: boolean;
  busy: boolean;
  onResolve: (remedy: AccountingRemedy) => void;
}) {
  const offered = exception.offered_remedies ?? [];
  const recordable = offered.filter((option) => RECORDABLE_REMEDIES.includes(option));
  const reversals = offered.filter((option) => DISPATCHABLE_REVERSALS.includes(option));
  const byHand = offered.filter(
    (option) => !RECORDABLE_REMEDIES.includes(option) && !DISPATCHABLE_REVERSALS.includes(option),
  );
  const [remedy, setRemedy] = useState<AccountingRemedy | "">(recordable[0] ?? "");
  const submitDisabled = busy || remedy === "";
  const remedyFieldId = `remedy-${exception.exception_id}`;

  return (
    <li className="border border-border bg-surface">
      <div className="border-b border-border px-4 py-4 sm:px-6">
        <h2 className="text-lg font-bold tracking-[-0.02em] text-balance">
          {reasonLabel(exception.reason_code)}
        </h2>
        <p className="mt-1 text-sm leading-6 text-muted">
          {exception.status === "resolved"
            ? `Closed as ${exception.resolution_action ? remedyLabel(exception.resolution_action as AccountingRemedy) : "resolved"}.`
            : `Open for ${ageLabel(exception.age_seconds)}.`}
        </p>
        {exception.intent_id ? (
          <Link
            to="/accounting/intents/$intentId"
            params={{ intentId: exception.intent_id }}
            className="mt-2 inline-flex min-h-12 items-center font-bold underline underline-offset-4"
          >
            Open the money item
          </Link>
        ) : null}
      </div>

      <SystemDetails className="border-b border-border" summaryClassName="px-4 sm:px-6">
        <dl className="divide-y divide-border border-t border-border">
          <div className="px-4 py-3 sm:px-6">
            <dt className="text-sm font-bold text-muted">Our check code</dt>
            <dd className="mt-1">
              <code className="break-all text-xs">
                {exception.expected_sha256 ?? "Not recorded"}
              </code>
            </dd>
          </div>
          <div className="px-4 py-3 sm:px-6">
            <dt className="text-sm font-bold text-muted">QuickBooks check code</dt>
            <dd className="mt-1">
              <code className="break-all text-xs">
                {exception.observed_sha256 ?? "Not recorded"}
              </code>
            </dd>
          </div>
        </dl>
      </SystemDetails>

      {canResolve ? (
        <div className="flex flex-col gap-3 border-t border-border px-4 py-4 sm:px-6">
          {reversals.length > 0 ? (
            <p className="text-sm leading-6 text-muted">
              To put money back, open the money item above and approve {orList(reversals)}. IronWrap
              will send it to QuickBooks. There is nothing to type here.
            </p>
          ) : null}
          {byHand.length > 0 ? (
            <p className="text-sm leading-6 text-muted">
              Do this by hand: {orList(byHand)}. IronWrap cannot mark it done because it cannot
              check the work.
            </p>
          ) : null}
          {recordable.length === 0 ? (
            <p className="text-sm leading-6 text-muted">
              You cannot close this issue from this page.
            </p>
          ) : (
            <>
              <label className="text-sm font-bold" htmlFor={remedyFieldId}>
                What did you do?
              </label>
              <Select
                id={remedyFieldId}
                className="min-h-14 rounded-md bg-surface"
                value={remedy}
                disabled={busy}
                onChange={(event) => setRemedy(event.target.value as AccountingRemedy)}
              >
                <option value="">Choose an answer</option>
                {recordable.map((option) => (
                  <option key={option} value={option}>
                    {remedyLabel(option)}
                  </option>
                ))}
              </Select>
              <Button
                type="button"
                className="min-h-14 w-full"
                disabled={submitDisabled}
                onClick={() => remedy !== "" && onResolve(remedy)}
              >
                Close this issue
              </Button>
            </>
          )}
        </div>
      ) : null}
    </li>
  );
}

function BackToDesk() {
  return (
    <Link
      to="/accounting"
      className="inline-flex min-h-12 items-center gap-2 font-bold underline underline-offset-4"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      Money desk
    </Link>
  );
}

/**
 * Only a refusal or a code the office named proves the issue is still open (`confirmed`): after a
 * lost answer or a server fault it may already be closed.
 */
function closeFailure(error: unknown): { text: string; confirmed: boolean } {
  const unconfirmed = {
    text: "We could not confirm the issue was closed. Refresh this list to check it before you try again.",
    confirmed: false,
  };
  if (!(error instanceof ApiError)) return unconfirmed;
  const messages: Record<string, string> = {
    accounting_exception_compensating_effect_required:
      "A remedy that moves money is authorized on the money movement, not closed from here.",
    accounting_exception_compensating_effect_unknown:
      "We have no record of that reversal reaching QuickBooks, so this stays open.",
    accounting_exception_compensating_effect_intent_mismatch:
      "That reversal belongs to a different money movement. This one is still open.",
    accounting_exception_compensating_effect_not_settled:
      "That reversal has not reached QuickBooks yet. We will close this when it does.",
    accounting_exception_compensating_effect_amount_mismatch:
      "That reversal is not for the amount that was authorized, so this stays open.",
    accounting_exception_remedy_dispatch_unavailable:
      "IronWrap cannot perform that remedy yet, so it cannot record it as done.",
    accounting_exception_transition_invalid:
      "Someone else already closed this issue. Refresh to see what they did.",
    accounting_exception_resolution_invalid:
      "That is not a remedy this finding offers. Pick one from the list.",
    csrf_failed: "Your session needs refreshing. Reload the page and try again.",
  };
  const named = messages[error.code];
  if (named) return { text: named, confirmed: true };
  return isRefusal(error)
    ? { text: "The issue was not closed. Nothing was changed.", confirmed: true }
    : unconfirmed;
}
