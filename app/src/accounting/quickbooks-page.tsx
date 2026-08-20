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
import { useRef, useState, type ReactNode } from "react";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { RoleGuard } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
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
    label: "QuickBooks connection required",
    explanation: "An owner must connect QuickBooks before this candidate can move.",
    tone: "border-warning/40 bg-warning-soft",
  },
  blocked: {
    label: "Blocked before review",
    explanation: "The recorded blocker must be resolved before approval is available.",
    tone: "border-warning/40 bg-warning-soft",
  },
  pending_review: {
    label: "Needs finance review",
    explanation: "Review the immutable final-invoice candidate and its evidence before deciding.",
    tone: "border-warning/40 bg-warning-soft",
  },
  rejected: {
    label: "Not approved",
    explanation: "The candidate was rejected. No QuickBooks invoice was authorized by this review.",
    tone: "border-border bg-surface-muted/60",
  },
  submission_pending: {
    label: "Submission pending",
    explanation:
      "Approval is recorded and the durable submission event is pending. Do not submit another invoice.",
    tone: "border-info/40 bg-info-soft",
  },
  submitted: {
    label: "Accepted by QuickBooks",
    explanation:
      "The provider accepted the invoice submission. IronWrap is awaiting authenticated readback; this is not a match or payment confirmation.",
    tone: "border-info/40 bg-info-soft",
  },
  matched: {
    label: "Matched by authenticated readback",
    explanation:
      "The server matched this exact invoice to authenticated QuickBooks readback. Payment is not implied.",
    tone: "border-ok/40 bg-ok-soft",
  },
  failed: {
    label: "Submission failed",
    explanation:
      "No matched QuickBooks invoice is proven. Follow the recorded next step; do not create a replacement from this screen.",
    tone: "border-danger/40 bg-danger-soft",
  },
  reconciliation_required: {
    label: "Reconciliation required",
    explanation:
      "Provider truth is uncertain or drifted. Reconcile the recorded invoice before any new submission.",
    tone: "border-danger/40 bg-danger-soft",
  },
};

const rejectionLabels: Record<QuickBooksRejectionReason, string> = {
  evidence_incomplete: "Required evidence is incomplete",
  commercial_values_disputed: "Commercial values are disputed",
  duplicate_or_already_billed: "Duplicate or already billed",
  mapping_requires_correction: "QuickBooks mapping needs correction",
  not_ready_to_invoice: "Work is not ready to invoice",
};

const blockerLabels: Record<
  NonNullable<QuickBooksFinalInvoiceResponse["intent"]["blocker"]>["code"],
  string
> = {
  oauth_connection_required: "QuickBooks connection is required",
  realm_mismatch: "The connected QuickBooks company does not match",
  customer_mapping_missing: "Customer mapping is missing",
  item_mapping_missing: "Item mapping is missing",
  tax_mapping_missing: "Tax mapping is missing",
  terms_mapping_missing: "Terms mapping is missing",
  commercial_policy_hold: "Commercial policy placed this candidate on hold",
  candidate_invalid: "The final-invoice candidate is invalid",
  candidate_changed: "The candidate changed after this read",
  provider_response_uncertain: "The provider response is uncertain",
  provider_readback_drift: "QuickBooks readback no longer matches",
  provider_invoice_missing: "The expected QuickBooks invoice is missing",
  frappe_bind_pending: "The QuickBooks identity is waiting to bind to the operating record",
  frappe_resolver_pending: "The operating-record resolver is still pending",
};

const nextStepLabels: Record<
  NonNullable<QuickBooksFinalInvoiceResponse["intent"]["blocker"]>["next_step"],
  string
> = {
  connect_quickbooks: "Ask the owner to connect the intended QuickBooks company.",
  fix_frappe_mapping: "Correct the owned QuickBooks mapping, then refresh this candidate.",
  resolve_commercial_policy: "Resolve the recorded commercial-policy hold, then refresh.",
  refresh_candidate: "Refresh the candidate from current owned records.",
  reconcile_provider_invoice: "Reconcile the exact provider invoice and authenticated readback.",
  retry_frappe_projection: "Retry the bounded operating-record projection, then refresh.",
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
        <h2 className="text-xl font-black tracking-[-0.025em]">Reconciliation health</h2>
        <p className="mt-2 text-sm leading-6 text-muted">Loading the money desk…</p>
      </Card>
    );
  }
  if (!summary.data) {
    return (
      <Card className="p-5 sm:p-6">
        <h2 className="text-xl font-black tracking-[-0.025em]">Reconciliation health</h2>
        <p className="mt-2 text-sm leading-6 text-muted">
          The money desk could not be read, so reconciliation health is unknown. The recorded
          connection state above is unaffected.
        </p>
      </Card>
    );
  }

  const health = summary.data.summary.reconciliation_health;
  return (
    <Card className="p-5 sm:p-6">
      <h2 className="text-xl font-black tracking-[-0.025em]">Reconciliation health</h2>
      <p className="mt-2 text-sm leading-6 text-muted">
        How much of what IronWrap believes has been checked against QuickBooks recently.
      </p>
      <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <HealthTile label="Open exceptions" value={health.open_exceptions} />
        <HealthTile label="Not re-read recently" value={health.stale_observation_count} />
        <HealthTile label="Never read back" value={health.unobserved_intent_count} />
      </dl>
      <p className="mt-4 text-sm leading-6">
        {health.oldest_unreconciled_intent_id ? (
          <>
            Oldest unfinished money movement:{" "}
            <Link
              to="/accounting/intents/$intentId"
              params={{ intentId: health.oldest_unreconciled_intent_id }}
              className="font-bold underline underline-offset-4"
            >
              {health.oldest_unreconciled_intent_id}
            </Link>
            .
          </>
        ) : (
          "Nothing is outstanding. Every money movement has reached a settled state."
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
        "QuickBooks was removed from IronWrap. No accounting record was deleted. Intuit authorization may still need manual revocation in QuickBooks.",
      );
      queryClient.setQueryData(connectionQueryKey, result.response);
    },
    onError: () => {
      setStatus("The requested connection change was not confirmed. No automatic retry was sent.");
    },
  });

  if (!connection.data && connection.isPending) {
    return <LoadingState label="Loading QuickBooks connection…" />;
  }
  if (!connection.data && connection.isError) {
    return (
      <ErrorState
        title="QuickBooks connection unavailable"
        message="No connection change is available until IronWrap can load the current recorded state."
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
              Finance settings
            </p>
            <h1 className="mt-1 text-3xl font-black tracking-[-0.035em] sm:text-4xl">
              QuickBooks connection
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted sm:text-base">
              IronWrap sends only an approved final-invoice candidate. QuickBooks remains accounting
              truth, and the server verifies provider readback.
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
              Refresh state
            </Button>
          ) : null}
        </div>
      </header>

      {offline ? (
        <Notice tone="warning" title="Reconnect before changing QuickBooks">
          Connection changes are never queued offline. This saved screen remains read-only.
        </Notice>
      ) : null}
      {callbackStatus === "connected" && connectionModel.state === "connected" ? (
        <Notice tone="success" title="QuickBooks returned to IronWrap">
          The server accepted the OAuth callback. Open the current finance exception to verify the
          recorded connection and candidate state.
        </Notice>
      ) : callbackStatus === "connected" ? (
        <Notice tone="warning" title="QuickBooks return is not yet confirmed">
          Refresh the recorded connection before treating this callback as complete.
        </Notice>
      ) : callbackStatus === "error" ? (
        <Notice tone="danger" title="QuickBooks connection was not confirmed">
          No browser token was retained. The owner can start a fresh connection when ready.
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
        <p className="text-xs font-extrabold uppercase tracking-[0.14em] text-muted">
          Recorded state
        </p>
        <h2 className="mt-1 text-xl font-black tracking-[-0.025em]">
          {connectionModel.state === "connected"
            ? "Connected"
            : connectionModel.state === "revoked"
              ? "Removed from IronWrap"
              : connectionModel.state === "reconciliation_required"
                ? "Connection needs reconciliation"
                : "Connection required"}
        </h2>
        {connectionModel.realm_id ? (
          <p className="mt-2 break-all text-sm text-muted">
            QuickBooks company ID {connectionModel.realm_id}
          </p>
        ) : null}
      </Card>

      <ReconciliationHealthCard />

      {connectionModel.state === "reconciliation_required" ? (
        <Notice tone="danger" title="QuickBooks connection state is uncertain">
          IronWrap will not start a replacement connection or remove this record while provider
          state is uncertain. Refresh after the recorded connection has been reconciled.
        </Notice>
      ) : null}

      {session.user.role === "accounting" ? (
        <Card className="p-5 sm:p-6">
          <h2 className="text-xl font-black tracking-[-0.025em]">
            {connectionModel.state === "connected"
              ? "Connection changes belong to the owner"
              : connectionModel.state === "reconciliation_required"
                ? "Connection changes are blocked while state is uncertain"
                : "Ask the owner to connect QuickBooks"}
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            {connectionModel.state === "reconciliation_required"
              ? "Refresh the recorded state after reconciliation. Neither owner nor accounting can start a replacement connection while this record remains uncertain."
              : "Ask the owner to connect or remove QuickBooks. Accounting can review, approve, reject, and reconcile eligible final-invoice candidates, but cannot change the OAuth connection."}
          </p>
        </Card>
      ) : (
        <>
          {canConnect ? (
            <Card className="p-5 sm:p-6">
              <h2 className="text-xl font-black tracking-[-0.025em]">
                Connect the intended company
              </h2>
              <p className="mt-2 text-sm leading-6 text-muted">
                Continue only if you can verify the intended QuickBooks company. IronWrap never
                stores OAuth tokens in this browser.
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
              <h2 className="text-lg font-bold">Remove from IronWrap</h2>
              <p className="mt-2 text-sm leading-6 text-muted">
                This revokes IronWrap&apos;s local connection. It does not delete invoices or other
                accounting records. Intuit authorization may still require manual revocation in
                QuickBooks.
              </p>
              {confirmRemove ? (
                <div className="mt-5 border-t border-border pt-5">
                  <p className="font-bold">Remove this connection from IronWrap now?</p>
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
                      Remove from IronWrap
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
              No connection change is permitted in this recorded state.
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
          ? "Approval was recorded. This does not promise a matched or paid QuickBooks invoice."
          : result.kind === "reject"
            ? "The rejection was recorded. No QuickBooks invoice was authorized by this decision."
            : "Reconciliation was requested for this exact recorded invoice.",
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
        title="This finance review link is incomplete"
        message="No final-invoice intent was provided. Return to Now and open the recorded finance exception."
      />
    );
  }
  if (!query.data && query.isPending) return <LoadingState label="Loading final-invoice review…" />;
  if (!query.data && query.isError) {
    return (
      <ErrorState
        title="Final-invoice review unavailable"
        message="No finance action was changed. Reconnect and load the current recorded candidate before deciding."
        onRetry={() => void refresh()}
      />
    );
  }
  if (!query.data) return <LoadingState label="Loading final-invoice review…" />;

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
              QuickBooks final invoice · job {intent.job_id}
            </p>
            <h1 className="mt-1 text-3xl font-black tracking-[-0.035em] sm:text-4xl">
              {intent.currency} {intent.amounts.final_balance}
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted sm:text-base">
              Review the server-provided candidate. Customer, item, tax, terms, lines, and amounts
              cannot be edited here.
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
            Refresh state
          </Button>
        </div>
      </header>

      {offline ? (
        <Notice tone="warning" title="Reconnect before deciding">
          Finance writes are never queued offline. The last saved read remains visible without
          approval, rejection, connection, or reconciliation controls.
        </Notice>
      ) : null}
      {query.isError ? (
        <Notice tone="warning" title="Showing the previous recorded read">
          Refresh this candidate before deciding. No finance action was issued by the failed read.
        </Notice>
      ) : null}
      {actionError ? (
        <Notice tone="danger" title="The finance action was not confirmed">
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
          <h2 className="text-lg font-bold">Connect QuickBooks before review</h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            {session.user.role === "owner"
              ? "Connect the intended QuickBooks company, then return to this exact candidate."
              : "Ask the owner to connect the intended QuickBooks company. Accounting cannot change the OAuth connection."}
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
          <h2 className="text-lg font-bold">Reconcile the recorded provider state</h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            This checks the exact recorded invoice. It does not submit a replacement, record a
            payment, or promise a match.
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
            Reconcile exact invoice
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
              <Fact label="Recorded blocker" value={blockerLabels[intent.blocker.code]} />
              <Fact label="Next step" value={nextStepLabels[intent.blocker.next_step]} />
            </dl>
          ) : null}
          {intent.rejection_reason ? (
            <p className="mt-4 text-sm font-bold">
              Recorded rejection: {rejectionLabels[intent.rejection_reason]}
            </p>
          ) : null}
          {intent.provider ? (
            <p className="mt-4 break-all text-xs text-muted">
              Provider invoice {intent.provider.invoice_id}
              {intent.provider.matched_at ? " · authenticated match recorded" : ""}
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
        Immutable candidate
      </h2>
      <dl className="mt-4 grid border-y border-border sm:grid-cols-2 lg:grid-cols-4">
        <AmountFact
          label="Pre-tax subtotal"
          value={`${intent.currency} ${intent.amounts.subtotal}`}
        />
        <AmountFact
          label={`Tax · ${intent.tax.code} ${intent.tax.rate}%`}
          value={`${intent.currency} ${intent.amounts.tax}`}
          bordered
        />
        <AmountFact
          label="Already invoiced"
          value={`${intent.currency} ${intent.amounts.already_invoiced}`}
          bordered
        />
        <AmountFact
          label="Final balance"
          value={`${intent.currency} ${intent.amounts.final_balance}`}
          bordered
          emphasis
        />
      </dl>
      <p className="mt-3 text-sm leading-6 text-muted">
        This flow accepts only a zero-prior-billing candidate. Deposits or prior invoices block the
        server candidate instead of being subtracted in this browser.
      </p>
    </section>
  );
}

function CandidateLines({ model }: { model: QuickBooksFinalInvoiceResponse }) {
  return (
    <section aria-labelledby="candidate-lines">
      <h2 id="candidate-lines" className="text-xl font-black tracking-[-0.025em]">
        Immutable pre-tax lines
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
            Why this review is required
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            This candidate is bound to the exact completion, accepted quote, accepted-change set,
            due date, tax, and commercial-policy evidence below. Approval authorizes one external
            QuickBooks invoice submission; it does not promise provider match or payment.
          </p>
        </div>
      </div>
      <dl className="mt-5 grid gap-4 border-t border-border pt-5 text-sm sm:grid-cols-2">
        <Fact
          label="Completion"
          value={`${intent.basis.completion_id} · version ${intent.basis.completion_version}`}
        />
        <Fact
          label="Accepted quote"
          value={`${intent.basis.quote_id} · version ${intent.basis.quote_version}`}
        />
        <Fact label="Invoice date" value={intent.invoice_date} />
        <Fact label="Due date" value={intent.due_date} />
        <Fact label="Candidate version" value={String(intent.version)} />
        <HashFact label="Basis hash" value={intent.basis.basis_hash} />
        <HashFact label="Completion hash" value={intent.basis.completion_hash} />
        <HashFact label="Quote hash" value={intent.basis.quote_hash} />
        <HashFact label="Accepted changes hash" value={intent.basis.changes_hash} />
      </dl>
    </section>
  );
}

function Evidence({ model }: { model: QuickBooksFinalInvoiceResponse }) {
  return (
    <section aria-labelledby="qbo-evidence">
      <h2 id="qbo-evidence" className="text-xl font-black tracking-[-0.025em]">
        Evidence citations
      </h2>
      <ul className="mt-4 border-y border-border">
        {model.intent.citations.map((citation) => (
          <li key={citation.id} className="border-b border-border px-3 py-4 last:border-b-0">
            <p className="font-bold">{citation.label.replaceAll("_", " ")}</p>
            <p className="mt-1 break-all text-sm text-muted">
              {citation.source} · {citation.source_ref}
            </p>
            <p className="mt-1 break-all font-mono text-xs text-muted">SHA-256 {citation.sha256}</p>
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
              : "Decision unavailable"}
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted">
          {offline
            ? "No approval or rejection is queued offline."
            : stale
              ? "The previous action did not return a confirmed current state. Refresh before another decision."
              : "The server did not grant a decision action for this exact candidate."}
        </p>
      </section>
    );
  }

  return (
    <section className="border border-border bg-surface" aria-labelledby="qbo-decision">
      <div className="border-b border-border p-5 sm:p-6">
        <h2 id="qbo-decision" className="text-lg font-bold">
          Decide this exact external invoice
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted">
          Approval authorizes submission of {model.intent.currency}{" "}
          {model.intent.amounts.final_balance} to QuickBooks. It does not confirm a provider match,
          payment, or collection.
        </p>
      </div>
      {rejecting ? (
        <div className="p-5 sm:p-6">
          <label htmlFor="qbo-rejection-reason" className="text-sm font-bold">
            Rejection reason
          </label>
          <select
            id="qbo-rejection-reason"
            value={rejectionReason}
            disabled={!canReject || busy}
            onChange={(event) =>
              onReasonChange(event.target.value as QuickBooksRejectionReason | "")
            }
            className="mt-3 min-h-12 w-full rounded-lg border bg-surface-raised px-3 text-base outline-none focus:border-info disabled:bg-surface-muted"
          >
            <option value="">Choose a recorded reason</option>
            {quickBooksRejectionReasons.map((reason) => (
              <option key={reason} value={reason}>
                {rejectionLabels[reason]}
              </option>
            ))}
          </select>
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
              Reject candidate
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <p className="max-w-xl text-sm leading-6 text-muted">
            The server will re-check this candidate version. This browser cannot change its
            customer, item, tax, terms, lines, or amount.
          </p>
          <div className="flex flex-col-reverse gap-3 sm:flex-row">
            {canReject ? (
              <Button type="button" variant="outline" disabled={busy} onClick={onStartReject}>
                Reject
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
                <ExternalLink aria-hidden="true" />
                Approve external invoice
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

function Notice({
  tone,
  title,
  children,
}: {
  tone: "warning" | "danger" | "success";
  title: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "border px-4 py-4",
        tone === "danger"
          ? "border-danger/40 bg-danger-soft"
          : tone === "success"
            ? "border-ok/40 bg-ok-soft"
            : "border-warning/40 bg-warning-soft",
      )}
      role={tone === "danger" ? "alert" : "status"}
    >
      <p className="font-bold">{title}</p>
      <p className="mt-1 text-sm leading-6 text-muted">{children}</p>
    </section>
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
    return "The action was not confirmed. Refresh the recorded candidate before deciding again.";
  }
  if (error.code.includes("version")) {
    return "This candidate changed while you were reviewing it. Refresh before another decision.";
  }
  if (error.status === 0) {
    return "The result is uncertain. The same action key is retained; refresh the recorded candidate before any retry.";
  }
  return "The action was not confirmed. Refresh the recorded candidate before deciding again.";
}
