import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import {
  ArrowLeft,
  CheckCircle2,
  CircleAlert,
  ExternalLink,
  FileCheck2,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { useRef, useState } from "react";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { RoleGuard } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Notice } from "../components/ui/notice";
import { Select } from "../components/ui/select";
import { ErrorState, LoadingState } from "../components/ui/state-panel";
import { ApiError } from "../lib/api";
import { cn } from "../lib/cn";
import { loadAccountingSummary } from "./money-api";
import {
  approveQuickBooksFinalInvoice,
  connectQuickBooks,
  loadQuickBooksConnection,
  loadQuickBooksFinalInvoice,
  newQuickBooksActionKey,
  reconcileQuickBooksFinalInvoice,
  rejectQuickBooksFinalInvoice,
  removeQuickBooksFromIronWrap,
} from "./quickbooks-api";
import {
  quickBooksRejectionReasons,
  type QuickBooksAction,
  type QuickBooksFinalInvoiceResponse,
  type QuickBooksRejectionReason,
} from "./quickbooks-contracts";

type DetailAction =
  | { kind: "connect" }
  | { kind: "approve"; intentId: string; version: number }
  | {
      kind: "reject";
      intentId: string;
      version: number;
      reasonCode: QuickBooksRejectionReason;
    }
  | { kind: "reconcile"; intentId: string; version: number };

const statePresentation: Record<
  QuickBooksFinalInvoiceResponse["intent"]["state"],
  { label: string; explanation: string; tone: string }
> = {
  connection_required: {
    label: "Connect QuickBooks",
    explanation: "An owner must connect QuickBooks before this invoice can move.",
    tone: "border-warning/40 bg-warning-soft",
  },
  blocked: {
    label: "Not ready to review",
    explanation: "Fix the item below before anyone can approve this invoice.",
    tone: "border-warning/40 bg-warning-soft",
  },
  pending_review: {
    label: "Ready to review",
    explanation: "Check this invoice and its source records before you decide.",
    tone: "border-warning/40 bg-warning-soft",
  },
  rejected: {
    label: "Not approved",
    explanation: "This invoice was not approved. Nothing was sent to QuickBooks.",
    tone: "border-border bg-surface-muted/60",
  },
  submission_pending: {
    label: "Waiting to send",
    explanation: "Approval is saved. IronWrap is waiting to send it. Do not send another invoice.",
    tone: "border-info/40 bg-info-soft",
  },
  submitted: {
    label: "QuickBooks got it",
    explanation: "QuickBooks accepted this invoice. IronWrap still needs to check the saved copy.",
    tone: "border-info/40 bg-info-soft",
  },
  matched: {
    label: "QuickBooks record matches",
    explanation: "IronWrap checked this exact invoice. The customer may still owe money.",
    tone: "border-ok/40 bg-ok-soft",
  },
  failed: {
    label: "Send failed",
    explanation:
      "IronWrap cannot prove QuickBooks got it. Follow the next step. Do not make a new invoice here.",
    tone: "border-danger/40 bg-danger-soft",
  },
  reconciliation_required: {
    label: "Needs a QuickBooks check",
    explanation: "The QuickBooks record may have changed. Check this invoice before you try again.",
    tone: "border-danger/40 bg-danger-soft",
  },
};

const rejectionLabels: Record<QuickBooksRejectionReason, string> = {
  evidence_incomplete: "Source records are missing",
  commercial_values_disputed: "The amounts are not right",
  duplicate_or_already_billed: "Duplicate or already billed",
  mapping_requires_correction: "A QuickBooks link needs a fix",
  not_ready_to_invoice: "Work is not ready to invoice",
};

const blockerLabels: Record<
  NonNullable<QuickBooksFinalInvoiceResponse["intent"]["blocker"]>["code"],
  string
> = {
  oauth_connection_required: "QuickBooks is not connected",
  realm_mismatch: "The wrong QuickBooks company is connected",
  customer_mapping_missing: "The customer link is missing",
  item_mapping_missing: "The item link is missing",
  tax_mapping_missing: "The tax link is missing",
  terms_mapping_missing: "The payment terms link is missing",
  commercial_policy_hold: "A business rule blocks this invoice",
  candidate_invalid: "This invoice is not ready",
  candidate_changed: "This invoice changed after you opened it",
  provider_response_uncertain: "QuickBooks may not have saved the invoice",
  provider_readback_drift: "The saved QuickBooks invoice changed",
  provider_invoice_missing: "The QuickBooks invoice is missing",
  frappe_bind_pending: "IronWrap is still saving the QuickBooks link",
  frappe_resolver_pending: "IronWrap is still finding the work record",
};

const nextStepLabels: Record<
  NonNullable<QuickBooksFinalInvoiceResponse["intent"]["blocker"]>["next_step"],
  string
> = {
  connect_quickbooks: "Ask the owner to connect QuickBooks.",
  fix_frappe_mapping: "Fix the QuickBooks link, then refresh.",
  resolve_commercial_policy: "Fix the business hold, then refresh.",
  refresh_candidate: "Refresh to load the latest records.",
  reconcile_provider_invoice: "Check this exact invoice in QuickBooks.",
  retry_frappe_projection: "Try saving the work record again, then refresh.",
};

const lineCodeLabels: Record<string, string> = {
  RESIDENTIAL_ACCEPTED_QUOTE: "Residential roofing contract",
  RESIDENTIAL_ACCEPTED_CHANGE: "Accepted change order",
};

export function QuickBooksSettingsPage() {
  return (
    <RoleGuard surface="accounting">
      <QuickBooksSettingsContent />
    </RoleGuard>
  );
}

export function QuickBooksFinalInvoicePage() {
  return (
    <RoleGuard surface="accounting">
      <QuickBooksFinalInvoiceContent />
    </RoleGuard>
  );
}

/**
 * Reconciliation health on the connection page (IRO-52 slice S9, contract section 8.2).
 *
 * "Extends PR #43's page with reconciliation health: stale observations, open exceptions, oldest
 * unreconciled intent." It reads the money desk's own summary rather than a second source, so the
 * connection page and the desk can never disagree about how healthy the reconciliation is.
 *
 * It is a soft dependency on purpose: a desk that cannot be read is reported here in one line, and
 * never blocks the connection screen an owner may have opened precisely because something is
 * broken.
 */
function ReconciliationHealthCard() {
  const session = useSession();
  const summary = useQuery({
    queryKey: ["accounting-summary", session.tenant.id],
    queryFn: () => loadAccountingSummary(),
    retry: false,
  });

  if (summary.isPending && !summary.data) {
    return (
      <Card className="p-5 sm:p-6">
        <h2 className="text-xl font-black tracking-[-0.025em]">QuickBooks checks</h2>
        <p className="mt-2 text-sm leading-6 text-muted">Loading the money desk…</p>
      </Card>
    );
  }
  if (!summary.data) {
    return (
      <Card className="p-5 sm:p-6">
        <h2 className="text-xl font-black tracking-[-0.025em]">QuickBooks checks</h2>
        <p className="mt-2 text-sm leading-6 text-muted">
          IronWrap could not open the money desk, so these checks are unknown. The connection status
          above is still current.
        </p>
      </Card>
    );
  }

  const health = summary.data.summary.reconciliation_health;
  return (
    <Card className="p-5 sm:p-6">
      <h2 className="text-xl font-black tracking-[-0.025em]">QuickBooks checks</h2>
      <p className="mt-2 text-sm leading-6 text-muted">
        See what still needs a fresh check against QuickBooks.
      </p>
      <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <HealthTile label="Open issues" value={health.open_exceptions} />
        <HealthTile label="Not checked lately" value={health.stale_observation_count} />
        <HealthTile label="Never checked" value={health.unobserved_intent_count} />
      </dl>
      <p className="mt-4 text-sm leading-6">
        {health.oldest_unreconciled_intent_id ? (
          <>
            Oldest unfinished item:{" "}
            <Link
              to="/accounting/intents/$intentId"
              params={{ intentId: health.oldest_unreconciled_intent_id }}
              className="font-bold underline underline-offset-4"
            >
              Open item
            </Link>
            .
          </>
        ) : (
          "Everything is done. No money item is waiting for a check."
        )}
      </p>
      <Link
        to="/accounting"
        className="mt-4 inline-flex min-h-12 items-center font-bold underline underline-offset-4"
      >
        Open the money desk
      </Link>
    </Card>
  );
}

function HealthTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="border border-border bg-surface px-4 py-3">
      <dt className="text-xs font-extrabold uppercase tracking-[0.12em] text-muted">{label}</dt>
      <dd className="mt-1 text-2xl font-black tabular-nums">{value}</dd>
    </div>
  );
}

function QuickBooksSettingsContent() {
  const session = useSession();
  const offline = isOfflineSession(session);
  const queryClient = useQueryClient();
  const actionKeys = useRef(new Map<string, string>());
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [status, setStatus] = useState<string>();
  const callbackStatus = quickBooksCallbackStatus();
  const connectionQueryKey = ["quickbooks-connection", session.tenant.id, session.user.id] as const;
  const connection = useQuery({
    queryKey: connectionQueryKey,
    queryFn: () => loadQuickBooksConnection(),
    retry: false,
  });

  const mutation = useMutation({
    retry: false,
    mutationFn: async (kind: "connect" | "remove") => {
      const keyName =
        kind === "remove" ? `${kind}:${connection.data?.connection_version ?? "unknown"}` : kind;
      const key = actionKeys.current.get(keyName) ?? newQuickBooksActionKey(kind);
      actionKeys.current.set(keyName, key);
      if (kind === "connect") return { kind, response: await connectQuickBooks(session, key) };
      if (!connection.data?.connection_version) {
        throw new Error("quickbooks_connection_read_required");
      }
      return {
        kind,
        response: await removeQuickBooksFromIronWrap(
          session,
          connection.data.connection_version,
          key,
        ),
      };
    },
    onSuccess: async (result) => {
      if (result.kind === "connect" && result.response) {
        window.location.assign(result.response.connect_url);
        return;
      }
      setConfirmRemove(false);
      setStatus(
        "The QuickBooks link was removed from IronWrap. Nothing was deleted in QuickBooks. You may also need to remove IronWrap inside QuickBooks.",
      );
      queryClient.setQueryData(connectionQueryKey, result.response);
    },
    onError: () => {
      setStatus("IronWrap could not confirm this change. It did not try again on its own.");
    },
  });

  if (!connection.data && connection.isPending) {
    return <LoadingState label="Loading QuickBooks connection…" />;
  }
  if (!connection.data && connection.isError) {
    return (
      <ErrorState
        title="QuickBooks connection unavailable"
        message="You cannot change the link until IronWrap loads the latest status."
        onRetry={() => void connection.refetch()}
      />
    );
  }
  if (!connection.data) return <LoadingState label="Loading QuickBooks connection…" />;

  const connectionModel = connection.data;
  const canConnect =
    session.user.role === "owner" && connectionModel.allowed_actions.includes("connect");
  const canRemove =
    session.user.role === "owner" &&
    connectionModel.allowed_actions.includes("remove_from_ironwrap");
  const canRefresh = connectionModel.allowed_actions.includes("refresh");

  return (
    <section className="mx-auto max-w-3xl space-y-6 pb-4">
      <header className="border-b border-border pb-5 sm:pb-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-extrabold uppercase tracking-[0.16em] text-muted">
              Money settings
            </p>
            <h1 className="mt-1 text-3xl font-black tracking-[-0.035em] sm:text-4xl">
              QuickBooks connection
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted sm:text-base">
              IronWrap sends an invoice only after a person approves it. QuickBooks keeps the final
              record. IronWrap checks it after each send.
            </p>
          </div>
          {canRefresh ? (
            <Button
              type="button"
              variant="outline"
              size="compact"
              busy={connection.isFetching}
              disabled={offline || connection.isFetching || mutation.isPending}
              onClick={() => void connection.refetch()}
            >
              <RefreshCw aria-hidden="true" />
              Refresh
            </Button>
          ) : null}
        </div>
      </header>

      {offline ? (
        <Notice tone="warning" title="Reconnect before you make a change">
          This saved screen is read-only. IronWrap must reach the server first.
        </Notice>
      ) : null}
      {callbackStatus === "connected" && connectionModel.state === "connected" ? (
        <Notice tone="success" title="QuickBooks came back to IronWrap">
          IronWrap confirmed the link. Open the money desk to check your work.
        </Notice>
      ) : callbackStatus === "connected" ? (
        <Notice tone="warning" title="QuickBooks link is not ready">
          Refresh before you use this link.
        </Notice>
      ) : callbackStatus === "error" ? (
        <Notice tone="danger" title="QuickBooks was not connected">
          Nothing was saved in this browser. The owner can try again.
        </Notice>
      ) : null}
      {status ? (
        <p
          className="border border-border bg-surface-muted px-4 py-4 text-sm leading-6"
          role="status"
        >
          {status}
        </p>
      ) : null}

      <Card className="p-5 sm:p-6">
        <p className="text-xs font-extrabold uppercase tracking-[0.14em] text-muted">Status</p>
        <h2 className="mt-1 text-xl font-black tracking-[-0.025em]">
          {connectionModel.state === "connected"
            ? "Connected"
            : connectionModel.state === "revoked"
              ? "Removed from IronWrap"
              : connectionModel.state === "reconciliation_required"
                ? "Connection needs a check"
                : "Connection required"}
        </h2>
        {connectionModel.realm_id ? (
          <details className="mt-3">
            <summary className="flex min-h-11 cursor-pointer items-center text-sm font-bold">
              System details
            </summary>
            <p className="break-all text-sm text-muted">
              QuickBooks company ID {connectionModel.realm_id}
            </p>
          </details>
        ) : null}
      </Card>

      <ReconciliationHealthCard />

      {connectionModel.state === "reconciliation_required" ? (
        <Notice tone="danger" title="Connection needs a check">
          IronWrap will not replace or remove this link until the check is done. Refresh after the
          link has been checked.
        </Notice>
      ) : null}

      {session.user.role === "accounting" ? (
        <Card className="p-5 sm:p-6">
          <h2 className="text-xl font-black tracking-[-0.025em]">
            {connectionModel.state === "connected"
              ? "Only the owner can change this link"
              : connectionModel.state === "reconciliation_required"
                ? "No one can change this link yet"
                : "Ask the owner to connect QuickBooks"}
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            {connectionModel.state === "reconciliation_required"
              ? "Refresh after the check is done. No one can replace this link while its state is not clear."
              : "Ask the owner to connect or remove QuickBooks. You can still review invoices and money issues."}
          </p>
        </Card>
      ) : (
        <>
          {canConnect ? (
            <Card className="p-5 sm:p-6">
              <h2 className="text-xl font-black tracking-[-0.025em]">Connect the right company</h2>
              <p className="mt-2 text-sm leading-6 text-muted">
                Make sure this is the QuickBooks company you want. IronWrap does not save sign-in
                keys in this browser.
              </p>
              <Button
                type="button"
                variant="accent"
                className="mt-5 w-full sm:w-auto"
                busy={mutation.isPending && mutation.variables === "connect"}
                disabled={offline || mutation.isPending}
                onClick={() => mutation.mutate("connect")}
              >
                <ExternalLink aria-hidden="true" />
                Connect QuickBooks
              </Button>
            </Card>
          ) : null}

          {canRemove ? (
            <section className="border border-border bg-surface p-5 sm:p-6">
              <h2 className="text-lg font-bold">Remove the QuickBooks link</h2>
              <p className="mt-2 text-sm leading-6 text-muted">
                This removes the link from IronWrap. It does not delete anything in QuickBooks. You
                may also need to remove IronWrap inside QuickBooks.
              </p>
              {confirmRemove ? (
                <div className="mt-5 border-t border-border pt-5">
                  <p className="font-bold">Remove this QuickBooks link now?</p>
                  <div className="mt-4 flex flex-col-reverse gap-3 sm:flex-row">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={mutation.isPending}
                      onClick={() => setConfirmRemove(false)}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      variant="danger"
                      busy={mutation.isPending && mutation.variables === "remove"}
                      disabled={offline || mutation.isPending}
                      onClick={() => mutation.mutate("remove")}
                    >
                      Remove link
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  className="mt-5"
                  disabled={offline || mutation.isPending}
                  onClick={() => setConfirmRemove(true)}
                >
                  Review removal
                </Button>
              )}
            </section>
          ) : null}
          {!canConnect && !canRemove ? (
            <p className="border border-border bg-surface-muted px-4 py-4 text-sm" role="status">
              You cannot change this link right now.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

function QuickBooksFinalInvoiceContent() {
  const { intentId } = useParams({ strict: false }) as { intentId?: string };
  const session = useSession();
  const offline = isOfflineSession(session);
  const queryClient = useQueryClient();
  const queryKey = [
    "quickbooks-final-invoice",
    session.tenant.id,
    session.user.id,
    intentId,
  ] as const;
  const query = useQuery({
    queryKey,
    enabled: Boolean(intentId),
    queryFn: () => loadQuickBooksFinalInvoice(intentId!),
    retry: false,
  });
  const actionKeys = useRef(new Map<string, string>());
  const [rejecting, setRejecting] = useState(false);
  const [rejectionReason, setRejectionReason] = useState<QuickBooksRejectionReason | "">("");
  const [requiresFreshRead, setRequiresFreshRead] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  async function refresh() {
    const result = await query.refetch();
    if (!result.error && result.data) {
      setRequiresFreshRead(false);
      setActionError(undefined);
    }
  }

  const mutation = useMutation({
    retry: false,
    mutationFn: async (action: DetailAction) => {
      const keyName =
        action.kind === "connect"
          ? "connect"
          : `${action.kind}:${action.intentId}:${action.version}${action.kind === "reject" ? `:${action.reasonCode}` : ""}`;
      const key = actionKeys.current.get(keyName) ?? newQuickBooksActionKey(action.kind);
      actionKeys.current.set(keyName, key);
      if (action.kind === "connect") {
        return { kind: action.kind, response: await connectQuickBooks(session, key) };
      }
      const response =
        action.kind === "approve"
          ? await approveQuickBooksFinalInvoice(session, action.intentId, action.version, key)
          : action.kind === "reject"
            ? await rejectQuickBooksFinalInvoice(
                session,
                action.intentId,
                action.version,
                action.reasonCode,
                key,
              )
            : await reconcileQuickBooksFinalInvoice(session, action.intentId, action.version, key);
      return { kind: action.kind, response };
    },
    onSuccess: (result) => {
      setActionError(undefined);
      setRequiresFreshRead(false);
      if (result.kind === "connect") {
        window.location.assign(result.response.connect_url);
        return;
      }
      queryClient.setQueryData(queryKey, result.response);
      setRejecting(false);
      setRejectionReason("");
      setNotice(
        result.kind === "approve"
          ? "Approval is saved. This does not mean QuickBooks saved the invoice or the customer paid."
          : result.kind === "reject"
            ? "Your choice is saved. Nothing was sent to QuickBooks."
            : "IronWrap will check this exact QuickBooks invoice again.",
      );
    },
    onError: (error) => {
      setNotice(undefined);
      setActionError(messageFor(error));
      setRequiresFreshRead(true);
    },
    onSettled: (_data, _error, action) => {
      if (action.kind !== "connect") void refresh();
    },
  });

  if (!intentId) {
    return (
      <ErrorState
        title="This invoice link is incomplete"
        message="This link has no invoice. Go back to Now and open the invoice again."
      />
    );
  }
  if (!query.data && query.isPending) return <LoadingState label="Loading invoice…" />;
  if (!query.data && query.isError) {
    return (
      <ErrorState
        title="Invoice review is unavailable"
        message="Nothing was changed. Reconnect and load this invoice again."
        onRetry={() => void refresh()}
      />
    );
  }
  if (!query.data) return <LoadingState label="Loading invoice…" />;

  const model = query.data;
  const intent = model.intent;
  const stale = requiresFreshRead || query.isError;
  const busy = mutation.isPending;
  const permits = (action: QuickBooksAction) =>
    !offline && !stale && model.allowed_actions.includes(action);
  const canApprove = intent.state === "pending_review" && permits("approve");
  const canReject = intent.state === "pending_review" && permits("reject");
  const canReconcile = permits("reconcile");
  const canConnect = session.user.role === "owner" && permits("connect");

  function decide(kind: "approve" | "reconcile") {
    if (busy || (kind === "approve" ? !canApprove : !canReconcile)) return;
    mutation.mutate({ kind, intentId: intent.id, version: intent.version });
  }

  function reject() {
    if (!canReject || busy || !rejectionReason) return;
    mutation.mutate({
      kind: "reject",
      intentId: intent.id,
      version: intent.version,
      reasonCode: rejectionReason,
    });
  }

  return (
    <section className="mx-auto max-w-5xl space-y-6 pb-4">
      <header className="border-b border-border pb-5 sm:pb-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <Button asChild variant="ghost" size="compact" className="-ml-2">
              <Link to="/now">
                <ArrowLeft aria-hidden="true" />
                Back to Now
              </Link>
            </Button>
            <p className="mt-4 text-xs font-extrabold uppercase tracking-[0.16em] text-muted">
              QuickBooks invoice · job {intent.job_id}
            </p>
            <h1 className="mt-1 text-3xl font-black tracking-[-0.035em] sm:text-4xl">
              {intent.currency} {intent.amounts.final_balance}
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted sm:text-base">
              Check this invoice. You cannot edit the customer, item, tax, dates, lines, or amount
              here.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="compact"
            busy={query.isFetching}
            disabled={query.isFetching || busy}
            onClick={() => void refresh()}
          >
            <RefreshCw aria-hidden="true" />
            Refresh
          </Button>
        </div>
      </header>

      {offline ? (
        <Notice tone="warning" title="Reconnect before deciding">
          This saved copy is read-only. IronWrap must reach the server before you can make a choice.
        </Notice>
      ) : null}
      {query.isError ? (
        <Notice tone="warning" title="Showing the last saved copy">
          Refresh this invoice before you decide. Nothing was changed.
        </Notice>
      ) : null}
      {actionError ? (
        <Notice tone="danger" title="IronWrap could not save your choice">
          {actionError}
        </Notice>
      ) : null}
      {notice ? (
        <p className="sr-only" aria-live="polite">
          {notice}
        </p>
      ) : null}

      <IntentStatus model={model} />
      <CandidateAmounts model={model} />
      <CandidateLines model={model} />
      <ReviewBasis model={model} />
      <Evidence model={model} />

      {intent.state === "connection_required" ? (
        <section className="border border-warning/40 bg-warning-soft p-5 sm:p-6">
          <h2 className="text-lg font-bold">Connect QuickBooks first</h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            {session.user.role === "owner"
              ? "Connect the right QuickBooks company, then come back to this invoice."
              : "Ask the owner to connect QuickBooks. Only the owner can change the link."}
          </p>
          {canConnect ? (
            <Button
              type="button"
              variant="accent"
              className="mt-5 w-full sm:w-auto"
              busy={busy}
              disabled={busy}
              onClick={() => mutation.mutate({ kind: "connect" })}
            >
              <ExternalLink aria-hidden="true" />
              Connect QuickBooks
            </Button>
          ) : null}
        </section>
      ) : null}

      {intent.state === "pending_review" ? (
        <PendingDecision
          model={model}
          canApprove={canApprove}
          canReject={canReject}
          busy={busy}
          offline={offline}
          stale={stale}
          rejecting={rejecting}
          rejectionReason={rejectionReason}
          onApprove={() => decide("approve")}
          onStartReject={() => setRejecting(true)}
          onCancelReject={() => {
            setRejecting(false);
            setRejectionReason("");
          }}
          onReasonChange={setRejectionReason}
          onReject={reject}
        />
      ) : null}

      {canReconcile && intent.state !== "pending_review" ? (
        <section className="border border-danger/40 bg-danger-soft p-5 sm:p-6">
          <h2 className="text-lg font-bold">Check this QuickBooks invoice</h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            IronWrap will check this exact invoice. It will not send a new one or mark it paid.
          </p>
          <Button
            type="button"
            variant="accent"
            className="mt-5 w-full sm:w-auto"
            busy={busy}
            disabled={busy}
            onClick={() => decide("reconcile")}
          >
            <RefreshCw aria-hidden="true" />
            Check this invoice again
          </Button>
        </section>
      ) : null}
    </section>
  );
}

function IntentStatus({ model }: { model: QuickBooksFinalInvoiceResponse }) {
  const intent = model.intent;
  const presentation = statePresentation[intent.state];
  return (
    <section className={cn("border p-5 sm:p-6", presentation.tone)} aria-labelledby="qbo-state">
      <div className="flex items-start gap-3">
        {intent.state === "matched" ? (
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden="true" />
        ) : intent.state === "failed" || intent.state === "reconciliation_required" ? (
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden="true" />
        ) : (
          <CircleAlert className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
        )}
        <div className="min-w-0">
          <h2 id="qbo-state" className="text-xl font-black tracking-[-0.025em]">
            {presentation.label}
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted">{presentation.explanation}</p>
          {intent.blocker ? (
            <dl className="mt-4 space-y-3 border-t border-current/15 pt-4 text-sm">
              <Fact label="What blocks this" value={blockerLabels[intent.blocker.code]} />
              <Fact label="Next step" value={nextStepLabels[intent.blocker.next_step]} />
            </dl>
          ) : null}
          {intent.rejection_reason ? (
            <p className="mt-4 text-sm font-bold">
              Reason: {rejectionLabels[intent.rejection_reason]}
            </p>
          ) : null}
          {intent.provider ? (
            <p className="mt-4 break-all text-xs text-muted">
              QuickBooks invoice {intent.provider.invoice_id}
              {intent.provider.matched_at ? " · match checked" : ""}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function CandidateAmounts({ model }: { model: QuickBooksFinalInvoiceResponse }) {
  const { intent } = model;
  return (
    <section aria-labelledby="candidate-amounts">
      <h2 id="candidate-amounts" className="text-xl font-black tracking-[-0.025em]">
        Invoice totals
      </h2>
      <dl className="mt-4 grid border-y border-border sm:grid-cols-2 lg:grid-cols-4">
        <AmountFact label="Before tax" value={`${intent.currency} ${intent.amounts.subtotal}`} />
        <AmountFact
          label={`Tax · ${intent.tax.code} ${intent.tax.rate}%`}
          value={`${intent.currency} ${intent.amounts.tax}`}
          bordered
        />
        <AmountFact
          label="Already billed"
          value={`${intent.currency} ${intent.amounts.already_invoiced}`}
          bordered
        />
        <AmountFact
          label="Amount due"
          value={`${intent.currency} ${intent.amounts.final_balance}`}
          bordered
          emphasis
        />
      </dl>
      <p className="mt-3 text-sm leading-6 text-muted">
        This invoice is only for jobs with no earlier bill. If there is an earlier bill or deposit,
        IronWrap stops here.
      </p>
    </section>
  );
}

function CandidateLines({ model }: { model: QuickBooksFinalInvoiceResponse }) {
  return (
    <section aria-labelledby="candidate-lines">
      <h2 id="candidate-lines" className="text-xl font-black tracking-[-0.025em]">
        Invoice lines before tax
      </h2>
      <ul className="mt-4 border-y border-border">
        {model.intent.lines.map((line, index) => (
          <li
            key={`${line.description_code}:${index}`}
            className="flex min-h-14 items-center justify-between gap-4 border-b border-border px-3 py-3 last:border-b-0"
          >
            <span className="break-all text-sm font-bold">
              {lineCodeLabels[line.description_code] ?? line.description_code}
            </span>
            <span className="shrink-0 font-black">
              {model.intent.currency} {line.amount}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ReviewBasis({ model }: { model: QuickBooksFinalInvoiceResponse }) {
  const { intent } = model;
  return (
    <section className="border border-border bg-surface p-5 sm:p-6" aria-labelledby="qbo-basis">
      <div className="flex items-start gap-3">
        <FileCheck2 className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden="true" />
        <div className="min-w-0">
          <h2 id="qbo-basis" className="text-xl font-black tracking-[-0.025em]">
            Why you need to review
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            These dates, totals, tax, and source records came from the finished job and approved
            quote. Approving sends one invoice. It does not mean QuickBooks saved it or the customer
            paid.
          </p>
        </div>
      </div>
      <dl className="mt-5 grid gap-4 border-t border-border pt-5 text-sm sm:grid-cols-2">
        <Fact label="Work record" value={intent.basis.completion_id} />
        <Fact label="Accepted quote" value={intent.basis.quote_id} />
        <Fact label="Invoice date" value={dateLabel(intent.invoice_date)} />
        <Fact label="Due date" value={dateLabel(intent.due_date)} />
      </dl>
      <details className="mt-5 border-t border-border pt-2">
        <summary className="flex min-h-12 cursor-pointer items-center text-sm font-bold">
          System check codes
        </summary>
        <dl className="grid gap-4 pt-3 text-sm sm:grid-cols-2">
          <Fact label="Invoice version" value={String(intent.version)} />
          <Fact label="Work version" value={String(intent.basis.completion_version)} />
          <Fact label="Quote version" value={String(intent.basis.quote_version)} />
          <HashFact label="Invoice code" value={intent.basis.basis_hash} />
          <HashFact label="Work code" value={intent.basis.completion_hash} />
          <HashFact label="Quote code" value={intent.basis.quote_hash} />
          <HashFact label="Change code" value={intent.basis.changes_hash} />
        </dl>
      </details>
    </section>
  );
}

function Evidence({ model }: { model: QuickBooksFinalInvoiceResponse }) {
  return (
    <section aria-labelledby="qbo-evidence">
      <h2 id="qbo-evidence" className="text-xl font-black tracking-[-0.025em]">
        Source records
      </h2>
      <ul className="mt-4 border-y border-border">
        {model.intent.citations.map((citation) => (
          <li key={citation.id} className="border-b border-border px-3 py-4 last:border-b-0">
            <p className="font-bold capitalize">{citation.label.replaceAll("_", " ")}</p>
            <details className="mt-2">
              <summary className="flex min-h-11 cursor-pointer items-center text-sm font-bold">
                System details
              </summary>
              <dl className="space-y-3 pt-2 text-sm">
                <Fact label="System" value={citation.source} />
                <Fact label="Record" value={citation.source_ref} />
                <HashFact label="Check code" value={citation.sha256} />
              </dl>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PendingDecision({
  model,
  canApprove,
  canReject,
  busy,
  offline,
  stale,
  rejecting,
  rejectionReason,
  onApprove,
  onStartReject,
  onCancelReject,
  onReasonChange,
  onReject,
}: {
  model: QuickBooksFinalInvoiceResponse;
  canApprove: boolean;
  canReject: boolean;
  busy: boolean;
  offline: boolean;
  stale: boolean;
  rejecting: boolean;
  rejectionReason: QuickBooksRejectionReason | "";
  onApprove: () => void;
  onStartReject: () => void;
  onCancelReject: () => void;
  onReasonChange: (reason: QuickBooksRejectionReason | "") => void;
  onReject: () => void;
}) {
  if (!canApprove && !canReject) {
    return (
      <section className="border border-border bg-surface p-5 sm:p-6" role="status">
        <h2 className="font-bold">
          {offline
            ? "Reconnect before deciding"
            : stale
              ? "Refresh before deciding"
              : "No choice is available"}
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted">
          {offline
            ? "No approval or rejection is queued offline."
            : stale
              ? "IronWrap could not load the latest invoice. Refresh before you decide."
              : "You cannot approve or reject this invoice right now."}
        </p>
      </section>
    );
  }

  return (
    <section className="border border-border bg-surface" aria-labelledby="qbo-decision">
      <div className="border-b border-border p-5 sm:p-6">
        <h2 id="qbo-decision" className="text-lg font-bold">
          Approve this invoice?
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted">
          Approve to send {model.intent.currency} {model.intent.amounts.final_balance} to
          QuickBooks. This does not mean QuickBooks saved it or the customer paid.
        </p>
      </div>
      {rejecting ? (
        <div className="p-5 sm:p-6">
          <label htmlFor="qbo-rejection-reason" className="text-sm font-bold">
            Reason for not approving
          </label>
          <Select
            id="qbo-rejection-reason"
            value={rejectionReason}
            disabled={!canReject || busy}
            onChange={(event) =>
              onReasonChange(event.target.value as QuickBooksRejectionReason | "")
            }
            className="mt-3"
          >
            <option value="">Choose a reason</option>
            {quickBooksRejectionReasons.map((reason) => (
              <option key={reason} value={reason}>
                {rejectionLabels[reason]}
              </option>
            ))}
          </Select>
          <div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" disabled={busy} onClick={onCancelReject}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              busy={busy}
              disabled={!canReject || busy || !rejectionReason}
              onClick={onReject}
            >
              Do not approve
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <p className="max-w-xl text-sm leading-6 text-muted">
            IronWrap checks this exact copy before it sends. You cannot edit it here.
          </p>
          <div className="flex flex-col-reverse gap-3 sm:flex-row">
            {canReject ? (
              <Button type="button" variant="outline" disabled={busy} onClick={onStartReject}>
                Do not approve
              </Button>
            ) : null}
            {canApprove ? (
              <Button
                type="button"
                variant="accent"
                busy={busy}
                disabled={busy}
                onClick={onApprove}
              >
                Approve invoice
              </Button>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}

function AmountFact({
  label,
  value,
  bordered = false,
  emphasis = false,
}: {
  label: string;
  value: string;
  bordered?: boolean;
  emphasis?: boolean;
}) {
  return (
    <div className={cn("p-4", bordered && "border-t border-border sm:border-t-0 sm:border-l")}>
      <dt className="text-xs font-extrabold uppercase tracking-[0.12em] text-muted">{label}</dt>
      <dd className={cn("mt-2 font-bold", emphasis && "text-xl font-black")}>{value}</dd>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-semibold text-muted">{label}</dt>
      <dd className="mt-1 break-words font-bold">{value}</dd>
    </div>
  );
}

function HashFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-semibold text-muted">{label}</dt>
      <dd className="mt-1 break-all font-mono text-xs">{value}</dd>
    </div>
  );
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(`${value}T00:00:00Z`),
  );
}

function quickBooksCallbackStatus(): "connected" | "error" | null {
  if (typeof window === "undefined") return null;
  const values = new URLSearchParams(window.location.search).getAll("quickbooks");
  return values.length === 1 && (values[0] === "connected" || values[0] === "error")
    ? values[0]
    : null;
}

function messageFor(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return "IronWrap could not save your choice. Refresh this invoice before you try again.";
  }
  if (error.code.includes("version")) {
    return "This invoice changed while you were reading it. Refresh before you decide again.";
  }
  if (error.status === 0) {
    return "IronWrap did not get a clear answer. Refresh this invoice before you try again.";
  }
  return "IronWrap could not save your choice. Refresh this invoice before you try again.";
}
