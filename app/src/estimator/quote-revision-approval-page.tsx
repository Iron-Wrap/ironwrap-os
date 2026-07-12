import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  ClipboardCheck,
  FilePlus2,
  FileText,
  Hourglass,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { useRef, useState } from "react";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { RoleGuard } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { ErrorState, LoadingState } from "../components/ui/state-panel";
import { ApiError } from "../lib/api";
import { cn } from "../lib/cn";
import { loadEstimatorWorkbench } from "./estimator-api";
import {
  approveQuoteRevisionApproval,
  loadQuoteRevisionApproval,
  loadQuoteRevisionApprovals,
  newQuoteRevisionApprovalDecisionKey,
  newQuoteRevisionApprovalPrepareKey,
  prepareQuoteRevisionApproval,
  reconcileQuoteRevisionApproval,
  rejectQuoteRevisionApproval,
} from "./quote-revision-approval-api";
import type {
  QuoteRevisionApprovalDetailResponse,
  QuoteRevisionApprovalListResponse,
  QuoteRevisionApprovalMutationResponse,
  QuoteRevisionApprovalRequest,
} from "./quote-revision-approval-contracts";

type ReconciliationOutcome = "executed" | "not_executed" | "inconclusive";

type RevisionDecisionAction =
  | { kind: "approve"; approval: QuoteRevisionApprovalRequest }
  | { kind: "reject"; approval: QuoteRevisionApprovalRequest; reason: string }
  | {
      kind: "reconcile";
      approval: QuoteRevisionApprovalRequest;
      outcome: ReconciliationOutcome;
      evidence: string;
    };

const statePresentation: Record<
  QuoteRevisionApprovalRequest["state"],
  { label: string; description: string; tone: string; Icon: LucideIcon }
> = {
  pending: {
    label: "Needs decision",
    description: "A designated human must decide before any Draft shell can be recorded.",
    tone: "bg-warning-soft text-warning",
    Icon: CircleAlert,
  },
  executing: {
    label: "Recording once",
    description: "The approved Draft-shell write is in progress. Do not submit a second decision.",
    tone: "bg-info-soft text-info",
    Icon: Hourglass,
  },
  executed: {
    label: "Draft shell recorded",
    description: "The append-only Draft shell and Hermes Run are recorded.",
    tone: "bg-ok-soft text-ok",
    Icon: CheckCircle2,
  },
  denied: {
    label: "Not approved",
    description: "The request was rejected before any Draft shell was created.",
    tone: "bg-surface-muted text-muted",
    Icon: XCircle,
  },
  expired: {
    label: "Review window expired",
    description:
      "This request can no longer create a Draft shell. Prepare a current review instead.",
    tone: "bg-warning-soft text-warning",
    Icon: Hourglass,
  },
  failed: {
    label: "Preparation failed",
    description: "No confirmed Draft shell is available from this request.",
    tone: "bg-danger-soft text-danger",
    Icon: TriangleAlert,
  },
  audit_failed: {
    label: "Audit not finalized",
    description: "The protected operation did not reach its required audit state.",
    tone: "bg-danger-soft text-danger",
    Icon: TriangleAlert,
  },
  execution_uncertain: {
    label: "Execution uncertain",
    description:
      "The broker result could not be verified. Reconcile the recorded state and do not retry.",
    tone: "bg-danger-soft text-danger",
    Icon: TriangleAlert,
  },
};

export function QuoteRevisionApprovalQueuePage() {
  return (
    <RoleGuard surface="sales">
      <QuoteRevisionApprovalQueueContent />
    </RoleGuard>
  );
}

export function QuoteRevisionApprovalDetailPage() {
  return (
    <RoleGuard surface="sales">
      <QuoteRevisionApprovalDetailContent />
    </RoleGuard>
  );
}

export function QuoteRevisionApprovalPreparePage() {
  return (
    <RoleGuard surface="sales">
      <QuoteRevisionApprovalPrepareContent />
    </RoleGuard>
  );
}

function QuoteRevisionApprovalQueueContent() {
  const session = useSession();
  const queryKey = ["quote-revision-approvals", session.tenant.id, session.user.id] as const;
  const query = useQuery({
    queryKey,
    queryFn: () => loadQuoteRevisionApprovals(),
    retry: false,
  });

  if (!query.data && query.isPending) return <QueueSkeleton />;
  if (!query.data && query.isError) {
    return (
      <ErrorState
        title="Draft revision queue unavailable"
        message="No request was changed. Reconnect to inspect the current recorded queue before deciding anything."
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!query.data) return <QueueSkeleton />;

  const model = query.data;
  return (
    <section className="mx-auto max-w-6xl space-y-6 pb-4">
      <header className="border-b border-border pb-5 sm:pb-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <Button asChild variant="ghost" size="compact" className="-ml-2">
              <Link to="/sales">
                <ArrowLeft aria-hidden="true" />
                Back to sales
              </Link>
            </Button>
            <div className="mt-4 flex min-w-0 items-start gap-3">
              <span className="grid size-11 shrink-0 place-items-center rounded-md bg-foreground text-background">
                <ClipboardCheck className="size-5 text-accent" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-extrabold uppercase tracking-[0.16em] text-muted">
                  Estimator review
                </p>
                <h1 className="mt-1 text-3xl font-black tracking-[-0.035em] text-balance sm:text-4xl">
                  Draft revision queue
                </h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted sm:text-base">
                  Each request is limited to a blank Draft shell. No pricing, tax, scope, payment,
                  acceptance, proposal, customer message, or accounting change travels through this
                  queue.
                </p>
              </div>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="compact"
            disabled={query.isFetching}
            busy={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RefreshCw aria-hidden="true" />
            Refresh
          </Button>
        </div>
      </header>

      <QueueSignals approvals={model.approvals} />

      {query.isError ? (
        <Notice tone="warning" title="Showing the last recorded queue read.">
          Refresh before deciding if this connection warning remains.
        </Notice>
      ) : null}

      {model.approvals.length === 0 ? (
        <section className="border border-border bg-surface px-6 py-10 text-center sm:px-8">
          <FilePlus2 className="mx-auto size-7 text-muted" aria-hidden="true" />
          <h2 className="mt-4 text-xl font-bold tracking-[-0.025em]">
            No draft revisions are waiting
          </h2>
          <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-muted">
            A governed revision will appear here after an estimator requests a blank Draft shell
            from the source quote.
          </p>
        </section>
      ) : (
        <ol className="border-y border-border" aria-label="Draft revision requests">
          {model.approvals.map((approval) => (
            <li key={approval.id} className="border-b border-border last:border-b-0">
              <RevisionQueueRow approval={approval} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function RevisionQueueRow({ approval }: { approval: QuoteRevisionApprovalRequest }) {
  return (
    <Link
      to="/quote-revision-approvals/$approvalId"
      params={{ approvalId: approval.id }}
      className="group block rounded-md px-4 py-5 transition-colors hover:bg-surface-muted focus-visible:outline-offset-[-3px] sm:px-5"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-bold text-foreground">
            <span>Source {quoteVersion(approval.source.quote_version)}</span>
            <ArrowRight className="size-4 text-muted" aria-hidden="true" />
            <span>Blank Draft {quoteVersion(approval.target.quote_version)}</span>
          </p>
          <p className="mt-1 break-all text-sm text-muted">
            {approval.source.customer_quote_id} · {approval.source.status}
          </p>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-muted">
            {approval.correction_reason}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3 self-start sm:self-center">
          <StatusBadge status={approval.state} />
          <ArrowRight
            className="size-5 text-muted transition-transform group-hover:translate-x-0.5"
            aria-hidden="true"
          />
        </div>
      </div>
      <p className="mt-3 break-all text-xs font-semibold text-muted">
        Target {approval.target.customer_quote_id}
      </p>
    </Link>
  );
}

function QuoteRevisionApprovalDetailContent() {
  const { approvalId } = useParams({ strict: false }) as { approvalId?: string };
  const session = useSession();
  const queryClient = useQueryClient();
  const offline = isOfflineSession(session);
  const queryKey = [
    "quote-revision-approval",
    session.tenant.id,
    session.user.id,
    approvalId,
  ] as const;
  const queueKey = ["quote-revision-approvals", session.tenant.id, session.user.id] as const;
  const query = useQuery({
    queryKey,
    enabled: Boolean(approvalId),
    queryFn: () => loadQuoteRevisionApproval(approvalId!),
    retry: false,
  });
  const keys = useRef(new Map<string, string>());
  const [rejecting, setRejecting] = useState(false);
  const [rejectionReason, setRejectionReason] = useState("");
  const [reconciling, setReconciling] = useState(false);
  const [reconciliationOutcome, setReconciliationOutcome] =
    useState<ReconciliationOutcome>("inconclusive");
  const [reconciliationEvidence, setReconciliationEvidence] = useState("");
  const [actionError, setActionError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [requiresFreshRead, setRequiresFreshRead] = useState(false);

  async function refreshCurrentRequest() {
    try {
      const result = await query.refetch();
      if (!result.error && result.data) setRequiresFreshRead(false);
    } catch {
      // The visible read-state warning remains the source of truth until a current response arrives.
    }
  }

  const mutation = useMutation({
    retry: false,
    mutationFn: async (action: RevisionDecisionAction) => {
      if (action.kind === "reconcile") {
        return await reconcileQuoteRevisionApproval(
          session,
          action.approval.id,
          action.approval.version,
          action.outcome,
          action.evidence,
        );
      }
      const keyName = `${action.kind}:${action.approval.id}`;
      const idempotencyKey = keys.current.get(keyName) ?? newQuoteRevisionApprovalDecisionKey();
      keys.current.set(keyName, idempotencyKey);
      return action.kind === "approve"
        ? await approveQuoteRevisionApproval(
            session,
            action.approval.id,
            action.approval.version,
            idempotencyKey,
          )
        : await rejectQuoteRevisionApproval(
            session,
            action.approval.id,
            action.approval.version,
            action.reason,
            idempotencyKey,
          );
    },
    onSuccess: (result: QuoteRevisionApprovalMutationResponse, action: RevisionDecisionAction) => {
      queryClient.setQueryData<QuoteRevisionApprovalDetailResponse>(queryKey, (current) =>
        current ? { ...current, approval: result.approval } : current,
      );
      queryClient.setQueryData<QuoteRevisionApprovalListResponse>(queueKey, (current) =>
        current
          ? {
              ...current,
              approvals: current.approvals.map((approval) =>
                approval.id === result.approval.id ? result.approval : approval,
              ),
            }
          : current,
      );
      setActionError(undefined);
      setRejecting(false);
      setRejectionReason("");
      setReconciling(false);
      setReconciliationOutcome("inconclusive");
      setReconciliationEvidence("");
      setRequiresFreshRead(false);
      setNotice(
        action.kind === "reconcile"
          ? "Reconciliation was recorded. No second write was issued."
          : action.kind === "reject"
            ? "The request was rejected. No Draft shell was created."
            : result.approval.state === "executed"
              ? "The Draft shell and Hermes Run are recorded."
              : "The protected decision state changed. Review the current recorded outcome.",
      );
    },
    onError: (error) => {
      setActionError(messageFor(error));
      setNotice(undefined);
      setRequiresFreshRead(true);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queueKey });
      void refreshCurrentRequest();
    },
  });

  if (!approvalId) {
    return (
      <ErrorState
        title="This draft revision link is incomplete"
        message="No revision request was provided. Return to the queue and select a recorded request."
        action={
          <Button asChild variant="outline">
            <Link to="/quote-revision-approvals">Open draft revision queue</Link>
          </Button>
        }
      />
    );
  }
  if (!query.data && query.isPending) return <DetailSkeleton />;
  if (!query.data && query.isError) {
    return (
      <ErrorState
        title="Draft revision unavailable"
        message="No request was changed. Reconnect to inspect the current recorded state before deciding anything."
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!query.data) return <DetailSkeleton />;

  const model = query.data;
  const approval = model.approval;
  const decisionReadStale = requiresFreshRead || query.isError;
  const canApprove =
    !offline &&
    !decisionReadStale &&
    model.allowed_actions.includes("quote_revision_approval.approve");
  const canReject =
    !offline &&
    !decisionReadStale &&
    model.allowed_actions.includes("quote_revision_approval.reject");
  const canReconcile =
    !offline &&
    !decisionReadStale &&
    model.allowed_actions.includes("quote_revision_approval.reconcile");
  const pendingAction = mutation.isPending;

  function approve() {
    if (!canApprove || pendingAction || approval.state !== "pending") return;
    setActionError(undefined);
    mutation.mutate({ kind: "approve", approval });
  }

  function reject() {
    const reason = rejectionReason.trim();
    if (!canReject || pendingAction || approval.state !== "pending" || reason.length < 3) return;
    setActionError(undefined);
    mutation.mutate({ kind: "reject", approval, reason });
  }

  function reconcile() {
    const evidence = reconciliationEvidence.trim();
    if (
      !canReconcile ||
      pendingAction ||
      approval.state !== "execution_uncertain" ||
      evidence.length < 3
    ) {
      return;
    }
    setActionError(undefined);
    mutation.mutate({
      kind: "reconcile",
      approval,
      outcome: reconciliationOutcome,
      evidence,
    });
  }

  return (
    <section className="mx-auto max-w-5xl space-y-6 pb-4">
      <header className="border-b border-border pb-5 sm:pb-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <Button asChild variant="ghost" size="compact" className="-ml-2">
              <Link to="/quote-revision-approvals">
                <ArrowLeft aria-hidden="true" />
                Draft revision queue
              </Link>
            </Button>
            <div className="mt-4 flex min-w-0 items-start gap-3">
              <span className="grid size-11 shrink-0 place-items-center rounded-md bg-foreground text-background">
                <FileText className="size-5 text-accent" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-extrabold uppercase tracking-[0.16em] text-muted">
                  Human decision
                </p>
                <h1 className="mt-1 text-3xl font-black tracking-[-0.035em] text-balance sm:text-4xl">
                  Blank Draft revision
                </h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted sm:text-base">
                  Decide only whether to create the bounded Draft shell shown below. The next
                  commercial version is entered and reviewed separately.
                </p>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="compact"
              busy={query.isFetching}
              disabled={query.isFetching}
              onClick={() => void refreshCurrentRequest()}
            >
              <RefreshCw aria-hidden="true" />
              Refresh state
            </Button>
            <Button asChild variant="outline" size="compact">
              <Link to="/estimator/jobs/$jobId" params={{ jobId: approval.roof_job_id }}>
                Open source review
                <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
          </div>
        </div>
      </header>

      {offline ? (
        <Notice tone="warning" title="Reconnect before deciding">
          Draft-shell decisions are never queued offline or retried by this app. The last recorded
          state remains visible.
        </Notice>
      ) : null}
      {query.isError ? (
        <Notice tone="warning" title="Showing the last recorded review.">
          Refresh this request before deciding if the connection warning remains.
        </Notice>
      ) : null}
      {actionError ? (
        <Notice tone="danger" title="The decision was not confirmed">
          {actionError}
        </Notice>
      ) : null}
      {notice ? (
        <p className="sr-only" aria-live="polite">
          {notice}
        </p>
      ) : null}

      <RevisionDecisionRail approval={approval} />
      <CommercialFence />
      <RevisionRequestFacts approval={approval} />

      {approval.state === "pending" ? (
        <PendingDecisionPanel
          approval={approval}
          canApprove={canApprove}
          canReject={canReject}
          offline={offline}
          requiresFreshRead={decisionReadStale}
          busy={pendingAction}
          rejecting={rejecting}
          rejectionReason={rejectionReason}
          onApprove={approve}
          onStartReject={() => {
            setActionError(undefined);
            setRejecting(true);
          }}
          onCancelReject={() => {
            setRejecting(false);
            setRejectionReason("");
          }}
          onRejectionReasonChange={setRejectionReason}
          onReject={reject}
        />
      ) : null}
      {approval.state === "executing" ? <ExecutingPanel /> : null}
      {approval.state === "execution_uncertain" ? (
        <UncertainExecutionPanel
          approval={approval}
          canReconcile={canReconcile}
          offline={offline}
          requiresFreshRead={decisionReadStale}
          busy={pendingAction}
          reconciling={reconciling}
          outcome={reconciliationOutcome}
          evidence={reconciliationEvidence}
          onStart={() => {
            setActionError(undefined);
            setReconciling(true);
          }}
          onCancel={() => {
            setReconciling(false);
            setReconciliationEvidence("");
          }}
          onOutcomeChange={setReconciliationOutcome}
          onEvidenceChange={setReconciliationEvidence}
          onSubmit={reconcile}
        />
      ) : null}
      {approval.state === "executed" ? <ExecutedPanel approval={approval} /> : null}
      {["denied", "expired", "failed", "audit_failed"].includes(approval.state) ? (
        <ClosedRequestPanel approval={approval} />
      ) : null}
    </section>
  );
}

function QuoteRevisionApprovalPrepareContent() {
  const { jobId } = useParams({ strict: false }) as { jobId?: string };
  const session = useSession();
  const offline = isOfflineSession(session);
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ["estimator-workbench", session.tenant.id, session.user.id, jobId],
    enabled: Boolean(jobId),
    queryFn: () => loadEstimatorWorkbench(jobId!),
    retry: false,
  });
  const prepareKey = useRef<string | undefined>(undefined);
  const [correctionReason, setCorrectionReason] = useState("");
  const [actionError, setActionError] = useState<string>();
  const mutation = useMutation({
    retry: false,
    mutationFn: async () => {
      const model = query.data;
      const quote = model?.quote;
      if (!model || !quote) throw new Error("revision_source_unavailable");
      prepareKey.current ??= newQuoteRevisionApprovalPrepareKey();
      return await prepareQuoteRevisionApproval(
        session,
        {
          roofJobId: model.job.id,
          customerQuoteId: quote.id,
          correctionReason: correctionReason.trim(),
        },
        prepareKey.current,
      );
    },
    onSuccess: async (result: QuoteRevisionApprovalMutationResponse) => {
      await navigate({
        to: "/quote-revision-approvals/$approvalId",
        params: { approvalId: result.approval.id },
      });
    },
    onError: (error) => setActionError(messageFor(error)),
  });

  if (!jobId) {
    return (
      <ErrorState
        title="This revision request link is incomplete"
        message="No roof-job record was provided. Return to the workbench and choose a source quote."
      />
    );
  }
  if (!query.data && query.isPending) return <PrepareSkeleton />;
  if (!query.data && query.isError) {
    return (
      <ErrorState
        title="Source review unavailable"
        message="No revision request was created. Reconnect and reopen the current workbench before preparing a Draft shell."
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!query.data) return <PrepareSkeleton />;

  const model = query.data;
  const quote = model.quote;
  if (
    !quote ||
    quote.version === null ||
    quote.version <= 0 ||
    !model.allowed_actions.includes("quote_revision_approval.prepare")
  ) {
    return (
      <ErrorState
        title="Draft revision is not available"
        message="IronWrap OS did not grant a revision request for this source. Return to the current workbench and review the source quote."
        action={
          <Button asChild variant="outline">
            <Link to="/estimator/jobs/$jobId" params={{ jobId }}>
              Back to measurement workbench
            </Link>
          </Button>
        }
      />
    );
  }

  const canPrepare = !offline;

  const source = {
    customer_quote_id: quote.id,
    quote_version: quote.version,
    status: quote.status ?? "Status unavailable",
  };
  const nextVersion = quote.version + 1;
  const trimmedReason = correctionReason.trim();

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canPrepare || mutation.isPending || trimmedReason.length < 1) return;
    setActionError(undefined);
    mutation.mutate();
  }

  return (
    <section className="mx-auto max-w-5xl space-y-6 pb-4">
      <header className="border-b border-border pb-5 sm:pb-6">
        <Button asChild variant="ghost" size="compact" className="-ml-2">
          <Link to="/estimator/jobs/$jobId" params={{ jobId: model.job.id }}>
            <ArrowLeft aria-hidden="true" />
            Back to measurement workbench
          </Link>
        </Button>
        <div className="mt-4 flex min-w-0 items-start gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-md bg-foreground text-background">
            <FilePlus2 className="size-5 text-accent" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-extrabold uppercase tracking-[0.16em] text-muted">
              Estimator request
            </p>
            <h1 className="mt-1 text-3xl font-black tracking-[-0.035em] text-balance sm:text-4xl">
              Draft quote revision
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted sm:text-base">
              Prepare a human-reviewed request for a blank Draft shell. This does not revise a
              price, assemble a proposal, or contact a customer.
            </p>
          </div>
        </div>
      </header>

      {offline ? (
        <Notice tone="warning" title="Reconnect to prepare this request">
          The request will not be queued offline. Reopen this source when you are online.
        </Notice>
      ) : null}
      {actionError ? (
        <Notice tone="danger" title="Draft revision was not prepared">
          {actionError}
        </Notice>
      ) : null}

      <PrepareDecisionRail
        sourceVersion={source.quote_version}
        targetVersion={nextVersion}
        sourceStatus={source.status}
      />
      <CommercialFence />

      <form className="border border-border bg-surface" onSubmit={submit}>
        <div className="border-b border-border px-5 py-5 sm:px-6">
          <h2 className="text-lg font-bold tracking-[-0.02em]">
            Why does this source need correction?
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
            State the correction that needs a new blank Draft shell. Entering commercial terms
            happens later in the normal estimator review.
          </p>
        </div>
        <div className="p-5 sm:p-6">
          <label htmlFor="correction-reason" className="text-sm font-bold text-foreground">
            Correction reason
          </label>
          <textarea
            id="correction-reason"
            value={correctionReason}
            onChange={(event) => setCorrectionReason(event.target.value.slice(0, 2_000))}
            disabled={!canPrepare || mutation.isPending}
            maxLength={2_000}
            rows={5}
            required
            placeholder="For example: Correct a verified measurement source before entering the next commercial version."
            className="mt-3 w-full resize-y rounded-lg border bg-surface-raised px-4 py-3 text-base leading-6 shadow-sm outline-none transition-colors placeholder:text-muted focus:border-info disabled:cursor-not-allowed disabled:bg-surface-muted"
          />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
            <span>Only the source identity and this reason are submitted.</span>
            <span>{correctionReason.length}/2000</span>
          </div>
        </div>
        <div className="flex flex-col gap-3 border-t border-border bg-surface-muted/55 p-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p className="max-w-xl text-sm leading-6 text-muted">
            A designated human reviews the exact source and blank target before one append-only
            write.
          </p>
          <Button
            type="submit"
            variant="accent"
            className="shrink-0"
            busy={mutation.isPending}
            disabled={!canPrepare || mutation.isPending || trimmedReason.length < 1}
          >
            <FilePlus2 aria-hidden="true" />
            Prepare draft revision
          </Button>
        </div>
      </form>
    </section>
  );
}

function QueueSignals({ approvals }: { approvals: QuoteRevisionApprovalRequest[] }) {
  const pending = approvals.filter((approval) => approval.state === "pending").length;
  const recording = approvals.filter((approval) => approval.state === "executing").length;
  const uncertain = approvals.filter((approval) => approval.state === "execution_uncertain").length;
  return (
    <dl
      className="grid border-y border-border sm:grid-cols-3"
      aria-label="Draft revision queue state"
    >
      <QueueSignal label="Needs review" value={pending} tone="text-warning" dot="bg-warning" />
      <QueueSignal
        label="Recording once"
        value={recording}
        tone="text-info"
        dot="bg-info"
        bordered
      />
      <QueueSignal
        label="Reconcile"
        value={uncertain}
        tone="text-danger"
        dot="bg-danger"
        bordered
      />
    </dl>
  );
}

function QueueSignal({
  label,
  value,
  tone,
  dot,
  bordered = false,
}: {
  label: string;
  value: number;
  tone: string;
  dot: string;
  bordered?: boolean;
}) {
  return (
    <div
      className={cn(
        "min-h-20 px-3 py-3 sm:min-h-24 sm:px-5 sm:py-4",
        bordered && "border-t border-border sm:border-t-0 sm:border-l",
      )}
    >
      <dt className="flex items-center gap-2 text-sm font-semibold text-muted">
        <span className={cn("size-2 rounded-full", dot)} aria-hidden="true" />
        {label}
      </dt>
      <dd className={cn("mt-1 text-xl font-black tracking-[-0.03em] sm:mt-2 sm:text-2xl", tone)}>
        {value}
      </dd>
    </div>
  );
}

function RevisionDecisionRail({ approval }: { approval: QuoteRevisionApprovalRequest }) {
  const status = statePresentation[approval.state];
  return (
    <section aria-labelledby="revision-decision-path">
      <div className="flex items-center justify-between gap-3">
        <h2
          id="revision-decision-path"
          className="text-sm font-extrabold uppercase tracking-[0.14em] text-muted"
        >
          Recorded decision path
        </h2>
        <StatusBadge status={approval.state} />
      </div>
      <ol className="mt-3 grid border border-border sm:grid-cols-4">
        <RailStep label="Source quote" detail={quoteVersion(approval.source.quote_version)} />
        <RailStep
          label="Blank Draft"
          detail={quoteVersion(approval.target.quote_version)}
          bordered
        />
        <RailStep label="Human decision" detail={status.label} tone={status.tone} bordered />
        <RailStep label="Hermes Run" detail={approval.hermes_run_id ?? "Pending record"} bordered />
      </ol>
    </section>
  );
}

function PrepareDecisionRail({
  sourceVersion,
  targetVersion,
  sourceStatus,
}: {
  sourceVersion: number;
  targetVersion: number;
  sourceStatus: string;
}) {
  return (
    <section aria-labelledby="prepare-decision-path">
      <h2
        id="prepare-decision-path"
        className="text-sm font-extrabold uppercase tracking-[0.14em] text-muted"
      >
        Controlled path
      </h2>
      <ol className="mt-3 grid border border-border sm:grid-cols-4">
        <RailStep
          label="Source quote"
          detail={`${quoteVersion(sourceVersion)} · ${sourceStatus}`}
        />
        <RailStep label="Blank Draft" detail={quoteVersion(targetVersion)} bordered />
        <RailStep
          label="Human decision"
          detail="Required"
          tone="bg-warning-soft text-warning"
          bordered
        />
        <RailStep label="Hermes Run" detail="Recorded after approval" bordered />
      </ol>
    </section>
  );
}

function RailStep({
  label,
  detail,
  tone,
  bordered = false,
}: {
  label: string;
  detail: string;
  tone?: string;
  bordered?: boolean;
}) {
  return (
    <li
      className={cn(
        "min-h-24 min-w-0 px-4 py-4 sm:px-5",
        bordered && "border-t border-border sm:border-t-0 sm:border-l",
      )}
    >
      <p className="text-sm font-bold text-muted">{label}</p>
      <p
        className={cn(
          "mt-2 break-all text-sm font-bold leading-5",
          tone ? "inline-flex rounded-full px-2.5 py-1.5 text-xs" : "text-foreground",
          tone,
        )}
      >
        {detail}
      </p>
    </li>
  );
}

function CommercialFence() {
  return (
    <section
      className="border border-border bg-surface-muted/65 px-5 py-5 sm:px-6"
      aria-labelledby="commercial-fence-heading"
    >
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden="true" />
        <div>
          <h2 id="commercial-fence-heading" className="font-bold tracking-[-0.015em]">
            Commercial terms stay blank
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            Price, tax, scope, payment, approval, acceptance, and customer terms are not copied. No
            customer message is sent and accounting remains unchanged.
          </p>
        </div>
      </div>
    </section>
  );
}

function RevisionRequestFacts({ approval }: { approval: QuoteRevisionApprovalRequest }) {
  return (
    <section
      className="grid border-y border-border sm:grid-cols-2"
      aria-label="Draft revision facts"
    >
      <div className="min-w-0 px-4 py-5 sm:px-5">
        <p className="text-sm font-bold text-muted">Source</p>
        <p className="mt-2 break-all font-bold text-foreground">
          {approval.source.customer_quote_id}
        </p>
        <p className="mt-1 break-words text-sm text-muted">
          {quoteVersion(approval.source.quote_version)} · {approval.source.status}
        </p>
      </div>
      <div className="min-w-0 border-t border-border px-4 py-5 sm:border-t-0 sm:border-l sm:px-5">
        <p className="text-sm font-bold text-muted">Proposed append-only target</p>
        <p className="mt-2 break-all font-bold text-foreground">
          {approval.target.customer_quote_id}
        </p>
        <p className="mt-1 break-all text-sm text-muted">
          Blank Draft {quoteVersion(approval.target.quote_version)} · supersedes{" "}
          {approval.source.customer_quote_id}
        </p>
      </div>
      <div className="border-t border-border px-4 py-5 sm:col-span-2 sm:px-5">
        <p className="text-sm font-bold text-muted">Correction reason</p>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-foreground">
          {approval.correction_reason}
        </p>
      </div>
    </section>
  );
}

function PendingDecisionPanel({
  approval,
  canApprove,
  canReject,
  offline,
  requiresFreshRead,
  busy,
  rejecting,
  rejectionReason,
  onApprove,
  onStartReject,
  onCancelReject,
  onRejectionReasonChange,
  onReject,
}: {
  approval: QuoteRevisionApprovalRequest;
  canApprove: boolean;
  canReject: boolean;
  offline: boolean;
  requiresFreshRead: boolean;
  busy: boolean;
  rejecting: boolean;
  rejectionReason: string;
  onApprove: () => void;
  onStartReject: () => void;
  onCancelReject: () => void;
  onRejectionReasonChange: (value: string) => void;
  onReject: () => void;
}) {
  if (!canApprove && !canReject) {
    return (
      <section className="border border-border bg-surface px-5 py-6 sm:px-6" role="status">
        <p className="font-bold">
          {offline
            ? "Reconnect before deciding"
            : requiresFreshRead
              ? "Refresh before another decision"
              : "Waiting for the designated approver"}
        </p>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
          {offline
            ? "This app never queues an approval decision offline. No Draft shell will be created until a current online decision is recorded."
            : requiresFreshRead
              ? "The previous decision did not return a confirmed current state. Do not retry it. Refresh the recorded request before any further action."
              : "The server did not grant you a decision capability for this exact request. You can continue to inspect the recorded source and target."}
        </p>
      </section>
    );
  }

  return (
    <section className="border border-border bg-surface" aria-labelledby="pending-decision-heading">
      <div className="border-b border-border px-5 py-5 sm:px-6">
        <h2 id="pending-decision-heading" className="text-lg font-bold tracking-[-0.02em]">
          Decide the blank Draft shell
        </h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
          Approval creates only{" "}
          <span className="break-all">{approval.target.customer_quote_id}</span> as{" "}
          {quoteVersion(approval.target.quote_version)}. Commercial content stays blank for the next
          estimator review.
        </p>
      </div>
      {rejecting ? (
        <div className="p-5 sm:p-6">
          <label htmlFor="revision-rejection-reason" className="text-sm font-bold">
            Why should this request be rejected?
          </label>
          <textarea
            id="revision-rejection-reason"
            value={rejectionReason}
            onChange={(event) => onRejectionReasonChange(event.target.value.slice(0, 1_000))}
            disabled={!canReject || busy}
            rows={4}
            maxLength={1_000}
            placeholder="State what must be corrected before a new request is prepared."
            className="mt-3 w-full resize-y rounded-lg border bg-surface-raised px-4 py-3 text-base leading-6 shadow-sm outline-none transition-colors placeholder:text-muted focus:border-info disabled:cursor-not-allowed disabled:bg-surface-muted"
          />
          <div className="mt-2 flex justify-between text-xs text-muted">
            <span>At least 3 characters.</span>
            <span>{rejectionReason.length}/1000</span>
          </div>
          <div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" disabled={busy} onClick={onCancelReject}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              busy={busy}
              disabled={!canReject || busy || rejectionReason.trim().length < 3}
              onClick={onReject}
            >
              <XCircle aria-hidden="true" />
              Reject request
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p className="max-w-xl text-sm leading-6 text-muted">
            The request is bound to the source version and exact target shown above. It expires if
            the recorded state changes.
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
                <CheckCircle2 aria-hidden="true" />
                Approve Draft shell
              </Button>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}

function ExecutingPanel() {
  return (
    <section className="border border-info/35 bg-info-soft px-5 py-6 sm:px-6" role="status">
      <div className="flex items-start gap-3">
        <Hourglass className="mt-0.5 size-5 shrink-0 text-info" aria-hidden="true" />
        <div>
          <h2 className="font-bold">Recording once</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
            The recorded approval is being finalized. This app will not send a second write or offer
            a retry while the lease is active.
          </p>
        </div>
      </div>
    </section>
  );
}

function UncertainExecutionPanel({
  approval,
  canReconcile,
  offline,
  requiresFreshRead,
  busy,
  reconciling,
  outcome,
  evidence,
  onStart,
  onCancel,
  onOutcomeChange,
  onEvidenceChange,
  onSubmit,
}: {
  approval: QuoteRevisionApprovalRequest;
  canReconcile: boolean;
  offline: boolean;
  requiresFreshRead: boolean;
  busy: boolean;
  reconciling: boolean;
  outcome: ReconciliationOutcome;
  evidence: string;
  onStart: () => void;
  onCancel: () => void;
  onOutcomeChange: (value: ReconciliationOutcome) => void;
  onEvidenceChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <section
      className="border border-danger/40 bg-danger-soft px-5 py-6 sm:px-6"
      aria-labelledby="uncertain-heading"
    >
      <div className="flex items-start gap-3">
        <TriangleAlert className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden="true" />
        <div className="min-w-0">
          <h2 id="uncertain-heading" className="font-bold">
            Do not retry this request
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
            The broker result is uncertain. A second write is never issued automatically. Inspect
            the recorded Hermes Run and reconcile the outcome instead.
          </p>
          {approval.error_code ? (
            <p className="mt-3 text-sm font-semibold text-danger">
              Recorded boundary: {humanizeCode(approval.error_code)}
            </p>
          ) : null}
        </div>
      </div>

      {approval.reconciliation ? (
        <div className="mt-5 border-t border-danger/25 pt-5" role="status">
          <p className="font-bold">
            Reconciliation recorded: {humanizeCode(approval.reconciliation.outcome)}
          </p>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
            {approval.reconciliation.evidence}
          </p>
        </div>
      ) : !canReconcile ? (
        <p className="mt-5 border-t border-danger/25 pt-5 text-sm leading-6 text-muted">
          {offline
            ? "Reconnect before recording reconciliation evidence. This app will not queue it offline."
            : requiresFreshRead
              ? "The prior action did not return a confirmed current state. Do not retry it. Refresh the recorded request before reconciliation."
              : "The server did not grant reconciliation for this request. A designated approver must record the evidence."}
        </p>
      ) : reconciling ? (
        <div className="mt-5 border-t border-danger/25 pt-5">
          <label htmlFor="reconciliation-outcome" className="text-sm font-bold">
            Reconciliation outcome
          </label>
          <select
            id="reconciliation-outcome"
            value={outcome}
            disabled={busy}
            onChange={(event) => onOutcomeChange(event.target.value as ReconciliationOutcome)}
            className="mt-2 min-h-12 w-full rounded-lg border bg-surface-raised px-3 text-sm shadow-sm outline-none focus:border-info disabled:cursor-not-allowed disabled:bg-surface-muted"
          >
            <option value="inconclusive">Inconclusive</option>
            <option value="executed">Draft shell was recorded</option>
            <option value="not_executed">Draft shell was not recorded</option>
          </select>
          <label htmlFor="reconciliation-evidence" className="mt-5 block text-sm font-bold">
            Reconciliation evidence
          </label>
          <textarea
            id="reconciliation-evidence"
            value={evidence}
            onChange={(event) => onEvidenceChange(event.target.value.slice(0, 1_000))}
            disabled={busy}
            maxLength={1_000}
            rows={4}
            placeholder="Record the evidence checked and why no second write is needed."
            className="mt-2 w-full resize-y rounded-lg border bg-surface-raised px-4 py-3 text-base leading-6 shadow-sm outline-none transition-colors placeholder:text-muted focus:border-info disabled:cursor-not-allowed disabled:bg-surface-muted"
          />
          <div className="mt-2 flex justify-between text-xs text-muted">
            <span>At least 3 characters.</span>
            <span>{evidence.length}/1000</span>
          </div>
          <div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              busy={busy}
              disabled={busy || evidence.trim().length < 3}
              onClick={onSubmit}
            >
              <ClipboardCheck aria-hidden="true" />
              Record reconciliation
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-5 border-t border-danger/25 pt-5">
          <Button type="button" variant="outline" disabled={busy} onClick={onStart}>
            <ClipboardCheck aria-hidden="true" />
            Reconcile recorded outcome
          </Button>
        </div>
      )}
    </section>
  );
}

function ExecutedPanel({ approval }: { approval: QuoteRevisionApprovalRequest }) {
  const outcome = approval.outcome;
  return (
    <section
      className="border border-ok/40 bg-ok-soft px-5 py-6 sm:px-6"
      aria-labelledby="executed-heading"
    >
      <div className="flex items-start gap-3">
        <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden="true" />
        <div>
          <h2 id="executed-heading" className="font-bold">
            Draft shell recorded
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
            The protected write is audit-finalized. No commercial terms were copied and no customer
            message or accounting change was made.
          </p>
        </div>
      </div>
      <dl className="mt-5 grid border-y border-ok/25 sm:grid-cols-3">
        <ResultFact
          label="Draft ID"
          value={outcome?.customer_quote_id ?? approval.target.customer_quote_id}
        />
        <ResultFact
          label="Draft version"
          value={quoteVersion(outcome?.quote_version ?? approval.target.quote_version)}
          bordered
        />
        <ResultFact label="Hermes Run" value={approval.hermes_run_id ?? approval.run_id} bordered />
      </dl>
    </section>
  );
}

function ResultFact({
  label,
  value,
  bordered = false,
}: {
  label: string;
  value: string;
  bordered?: boolean;
}) {
  return (
    <div
      className={cn(
        "min-w-0 px-4 py-4",
        bordered && "border-t border-ok/25 sm:border-t-0 sm:border-l",
      )}
    >
      <dt className="text-xs font-extrabold uppercase tracking-[0.12em] text-muted">{label}</dt>
      <dd className="mt-2 break-all text-sm font-bold text-foreground">{value}</dd>
    </div>
  );
}

function ClosedRequestPanel({ approval }: { approval: QuoteRevisionApprovalRequest }) {
  const presentation = statePresentation[approval.state];
  const Icon = presentation.Icon;
  const explanation =
    approval.state === "denied" && approval.rejection_reason
      ? approval.rejection_reason
      : approval.error_code
        ? humanizeCode(approval.error_code)
        : presentation.description;
  return (
    <section className="border border-border bg-surface px-5 py-6 sm:px-6" role="status">
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 size-5 shrink-0 text-muted" aria-hidden="true" />
        <div>
          <h2 className="font-bold">{presentation.label}</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">{explanation}</p>
        </div>
      </div>
    </section>
  );
}

function StatusBadge({ status }: { status: QuoteRevisionApprovalRequest["state"] }) {
  const presentation = statePresentation[status];
  const Icon = presentation.Icon;
  return (
    <span
      className={cn(
        "inline-flex min-h-8 items-center gap-1.5 rounded-full px-3 text-xs font-extrabold",
        presentation.tone,
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {presentation.label}
    </span>
  );
}

function Notice({
  tone,
  title,
  children,
}: {
  tone: "warning" | "danger";
  title: string;
  children: string;
}) {
  const Icon = tone === "danger" ? TriangleAlert : CircleAlert;
  return (
    <section
      className={cn(
        "border px-5 py-4 text-sm leading-6",
        tone === "danger" ? "border-danger/40 bg-danger-soft" : "border-warning/40 bg-warning-soft",
      )}
      role={tone === "danger" ? "alert" : "status"}
    >
      <div className="flex items-start gap-3">
        <Icon
          className={cn(
            "mt-0.5 size-5 shrink-0",
            tone === "danger" ? "text-danger" : "text-warning",
          )}
          aria-hidden="true"
        />
        <div>
          <p className="font-bold">{title}</p>
          <p className="mt-1 text-muted">{children}</p>
        </div>
      </div>
    </section>
  );
}

function QueueSkeleton() {
  return (
    <section
      className="mx-auto max-w-6xl space-y-6"
      aria-busy="true"
      aria-label="Loading draft revision queue"
    >
      <div className="h-28 border-b border-border bg-surface-muted/70" />
      <div className="grid border-y border-border sm:grid-cols-3">
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className={cn(
              "min-h-24 bg-surface-muted/60",
              index > 0 && "border-t border-border sm:border-t-0 sm:border-l",
            )}
          />
        ))}
      </div>
      <div className="min-h-52 border border-border bg-surface-muted/50" />
    </section>
  );
}

function DetailSkeleton() {
  return (
    <section
      className="mx-auto max-w-5xl space-y-6"
      aria-busy="true"
      aria-label="Loading draft revision"
    >
      <div className="h-28 border-b border-border bg-surface-muted/70" />
      <div className="grid min-h-28 border border-border bg-surface-muted/55 sm:grid-cols-4" />
      <div className="min-h-28 border border-border bg-surface-muted/55" />
      <LoadingState label="Loading the recorded revision decision" />
    </section>
  );
}

function PrepareSkeleton() {
  return (
    <section
      className="mx-auto max-w-5xl space-y-6"
      aria-busy="true"
      aria-label="Loading revision source"
    >
      <div className="h-28 border-b border-border bg-surface-muted/70" />
      <div className="grid min-h-28 border border-border bg-surface-muted/55 sm:grid-cols-4" />
      <div className="min-h-72 border border-border bg-surface-muted/55" />
    </section>
  );
}

function quoteVersion(version: number): string {
  return `V${version}`;
}

function humanizeCode(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function messageFor(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return "The protected request was not confirmed. Reopen the recorded state before trying another decision.";
  }
  switch (error.code) {
    case "quote_revision_broker_unavailable":
      return "The private revision broker is unavailable. No Draft shell was recorded.";
    case "quote_revision_approval_expired":
      return "This review window expired before a decision. Prepare a current request from the source quote.";
    case "quote_revision_approval_version_conflict":
      return "This recorded request changed. Refresh before making another decision.";
    case "execution_uncertain":
      return "The result is uncertain. Do not retry. Reconcile the recorded Hermes Run instead.";
    case "quote_revision_approval_not_pending":
      return "This request is no longer awaiting a decision. Refresh to inspect the recorded state.";
    default:
      return "The protected request was not confirmed. Refresh the recorded state before deciding again.";
  }
}
