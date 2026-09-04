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
import { Card } from "../components/ui/card";
import { Notice } from "../components/ui/notice";
import { Select } from "../components/ui/select";
import { ErrorState, LoadingState } from "../components/ui/state-panel";
import { Textarea } from "../components/ui/textarea";
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
    label: "Needs review",
    description: "A person must say yes before IronWrap can make the empty draft.",
    tone: "bg-warning-soft text-warning",
    Icon: CircleAlert,
  },
  executing: {
    label: "Saving draft",
    description: "The empty draft is being made. Do not choose again.",
    tone: "bg-info-soft text-info",
    Icon: Hourglass,
  },
  executed: {
    label: "Draft made",
    description: "The empty draft and its save record are done.",
    tone: "bg-ok-soft text-ok",
    Icon: CheckCircle2,
  },
  denied: {
    label: "Turned down",
    description: "The request was turned down. No draft was made.",
    tone: "bg-surface-muted text-muted",
    Icon: XCircle,
  },
  expired: {
    label: "Review ended",
    description: "This request is too old. Start a new review from the quote.",
    tone: "bg-warning-soft text-warning",
    Icon: Hourglass,
  },
  failed: {
    label: "Draft not made",
    description: "This request did not make a saved draft.",
    tone: "bg-danger-soft text-danger",
    Icon: TriangleAlert,
  },
  audit_failed: {
    label: "Save check failed",
    description: "The work could not be saved safely.",
    tone: "bg-danger-soft text-danger",
    Icon: TriangleAlert,
  },
  execution_uncertain: {
    label: "Check needed",
    description:
      "We could not tell if the draft was made. Check the saved record. Do not try again.",
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
        title="Quote reviews could not load"
        message="Nothing changed. Check your link, then load the saved list again."
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!query.data) return <QueueSkeleton />;

  const model = query.data;
  return (
    <section className="mx-auto max-w-7xl space-y-6 pb-6">
      <Card className="overflow-hidden">
        <header className="grid min-w-0 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="min-w-0 p-5 sm:p-7 lg:p-8">
            <div className="min-w-0">
              <Button asChild variant="ghost" size="compact" className="-ml-2">
                <Link to="/sales">
                  <ArrowLeft aria-hidden="true" />
                  Back to sales
                </Link>
              </Button>
              <div className="mt-5 flex min-w-0 items-start gap-4">
                <span className="grid size-12 shrink-0 place-items-center rounded-lg bg-foreground text-background shadow-sm">
                  <ClipboardCheck className="size-6 text-accent" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <h1 className="mt-1 text-3xl font-bold tracking-[-0.035em] text-balance sm:text-4xl">
                    Quote change reviews
                  </h1>
                  <p className="mt-2 max-w-2xl text-sm leading-6 text-muted sm:text-base">
                    Review requests for a new empty draft. Prices, job details, payments, customer
                    replies, and money records stay out.
                  </p>
                </div>
              </div>
            </div>
          </div>
          <div className="border-t border-border bg-surface-muted/45 p-5 sm:p-7 lg:border-t-0 lg:border-l lg:p-8">
            <p className="text-sm font-bold text-muted">Next step</p>
            <h2 className="mt-2 text-xl font-bold tracking-[-0.025em]">
              {model.approvals.length === 0
                ? "No quote changes to review"
                : `${model.approvals.length} ${model.approvals.length === 1 ? "quote change" : "quote changes"}`}
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted">
              Open a request to see what will be made before you choose.
            </p>
            <Button
              type="button"
              variant="outline"
              size="compact"
              className="mt-5"
              disabled={query.isFetching}
              busy={query.isFetching}
              onClick={() => void query.refetch()}
            >
              <RefreshCw aria-hidden="true" />
              Load again
            </Button>
          </div>
        </header>
      </Card>

      <Card className="overflow-hidden">
        <QueueSignals approvals={model.approvals} />
      </Card>

      {query.isError ? (
        <Notice tone="warning" title="This may be an old list">
          Load the list again before you choose.
        </Notice>
      ) : null}

      {model.approvals.length === 0 ? (
        <Card className="px-6 py-10 text-center sm:px-8">
          <FilePlus2 className="mx-auto size-7 text-muted" aria-hidden="true" />
          <h2 className="mt-4 text-xl font-bold tracking-[-0.025em]">
            No quote changes need review
          </h2>
          <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-muted">
            A request will show here when someone asks for a new empty draft quote.
          </p>
        </Card>
      ) : (
        <ol
          className="overflow-hidden rounded-lg border border-border bg-surface-raised shadow-[0_1px_2px_oklch(0_0_0/0.035)]"
          aria-label="Quote change requests"
        >
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
      className="group block px-5 py-5 transition-colors hover:bg-surface-muted focus-visible:outline-offset-[-3px] sm:px-6 sm:py-6"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-bold text-foreground">
            <span>Quote {quoteVersion(approval.source.quote_version)}</span>
            <ArrowRight className="size-4 text-muted" aria-hidden="true" />
            <span>Empty draft {quoteVersion(approval.target.quote_version)}</span>
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
          ? "The result check was saved. No new draft was made."
          : action.kind === "reject"
            ? "The request was turned down. No draft was made."
            : result.approval.state === "executed"
              ? "The empty draft and save record are ready."
              : "The saved state changed. Check it before you do more.",
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
        title="This quote review link is not complete"
        message="No request was found in this link. Go back and open a saved request."
        action={
          <Button asChild variant="outline">
            <Link to="/quote-revision-approvals">Open quote change reviews</Link>
          </Button>
        }
      />
    );
  }
  if (!query.data && query.isPending) return <DetailSkeleton />;
  if (!query.data && query.isError) {
    return (
      <ErrorState
        title="Quote review could not load"
        message="Nothing changed. Check your link, then load the saved request again."
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
  const currentState = statePresentation[approval.state];

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
    <section className="mx-auto max-w-6xl space-y-6 pb-6">
      <Card className="overflow-hidden">
        <header className="grid min-w-0 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0 p-5 sm:p-7 lg:p-8">
            <Button asChild variant="ghost" size="compact" className="-ml-2">
              <Link to="/quote-revision-approvals">
                <ArrowLeft aria-hidden="true" />
                Quote change reviews
              </Link>
            </Button>
            <div className="mt-5 flex min-w-0 items-start gap-4">
              <span className="grid size-12 shrink-0 place-items-center rounded-lg bg-foreground text-background shadow-sm">
                <FileText className="size-6 text-accent" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h1 className="mt-1 text-3xl font-bold tracking-[-0.035em] text-balance sm:text-4xl">
                  Review a new quote
                </h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted sm:text-base">
                  Choose if IronWrap can make the empty draft shown here. Prices and job details are
                  added later.
                </p>
              </div>
            </div>
          </div>
          <div className="border-t border-border bg-surface-muted/45 p-5 sm:p-7 lg:border-t-0 lg:border-l lg:p-8">
            <p className="text-sm font-bold text-muted">Current state</p>
            <div className="mt-3">
              <StatusBadge status={approval.state} />
            </div>
            <p className="mt-3 text-sm leading-6 text-muted">{currentState.description}</p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="compact"
                busy={query.isFetching}
                disabled={query.isFetching}
                onClick={() => void refreshCurrentRequest()}
              >
                <RefreshCw aria-hidden="true" />
                Load again
              </Button>
              <Button asChild variant="outline" size="compact">
                <Link to="/estimator/jobs/$jobId" params={{ jobId: approval.roof_job_id }}>
                  Open quote
                  <ArrowRight aria-hidden="true" />
                </Link>
              </Button>
            </div>
          </div>
        </header>
      </Card>

      {offline ? (
        <Notice tone="warning" title="Go online before you choose">
          IronWrap will not save this choice while you are offline. The last saved state stays here.
        </Notice>
      ) : null}
      {query.isError ? (
        <Notice tone="warning" title="This may be an old view">
          Load this request again before you choose.
        </Notice>
      ) : null}
      {actionError ? (
        <Notice tone="danger" title="Your choice was not saved">
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
      <RevisionSystemDetails approval={approval} />

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
        title="This new quote link is not complete"
        message="No job was found in this link. Go back and open the quote again."
      />
    );
  }
  if (!query.data && query.isPending) return <PrepareSkeleton />;
  if (!query.data && query.isError) {
    return (
      <ErrorState
        title="Quote could not load"
        message="No request was made. Go online, then open the quote again."
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
        title="A new quote is not ready"
        message="IronWrap did not allow a new quote from this one. Go back and check the quote."
        action={
          <Button asChild variant="outline">
            <Link to="/estimator/jobs/$jobId" params={{ jobId }}>
              Back to roof and quote review
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
    <section className="mx-auto max-w-6xl space-y-6 pb-6">
      <Card className="overflow-hidden">
        <header className="grid min-w-0 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0 p-5 sm:p-7 lg:p-8">
            <Button asChild variant="ghost" size="compact" className="-ml-2">
              <Link to="/estimator/jobs/$jobId" params={{ jobId: model.job.id }}>
                <ArrowLeft aria-hidden="true" />
                Back to roof and quote review
              </Link>
            </Button>
            <div className="mt-5 flex min-w-0 items-start gap-4">
              <span className="grid size-12 shrink-0 place-items-center rounded-lg bg-foreground text-background shadow-sm">
                <FilePlus2 className="size-6 text-accent" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h1 className="mt-1 text-3xl font-bold tracking-[-0.035em] text-balance sm:text-4xl">
                  Ask for a new quote
                </h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted sm:text-base">
                  Ask a person to review one new empty draft. This does not change a price, job, or
                  customer message.
                </p>
              </div>
            </div>
          </div>
          <div className="border-t border-border bg-surface-muted/45 p-5 sm:p-7 lg:border-t-0 lg:border-l lg:p-8">
            <p className="text-sm font-bold text-muted">Next step</p>
            <h2 className="mt-2 text-xl font-bold tracking-[-0.025em]">Tell us what is wrong</h2>
            <p className="mt-2 text-sm leading-6 text-muted">
              A person will check the current quote and the empty draft before it is made.
            </p>
          </div>
        </header>
      </Card>

      {offline ? (
        <Notice tone="warning" title="Go online to send this request">
          IronWrap will not save it while you are offline. Open the quote again when you are online.
        </Notice>
      ) : null}
      {actionError ? (
        <Notice tone="danger" title="The request was not sent">
          {actionError}
        </Notice>
      ) : null}

      <PrepareDecisionRail
        sourceVersion={source.quote_version}
        targetVersion={nextVersion}
        sourceStatus={source.status}
      />
      <CommercialFence />

      <form
        className="overflow-hidden rounded-lg border border-border bg-surface-raised shadow-[0_1px_2px_oklch(0_0_0/0.035)]"
        onSubmit={submit}
      >
        <div className="border-b border-border px-5 py-5 sm:px-6">
          <h2 className="text-lg font-bold tracking-[-0.02em]">What needs to change?</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
            Say what is wrong with the current quote. Prices and job details are added later.
          </p>
        </div>
        <div className="p-5 sm:p-6">
          <label htmlFor="correction-reason" className="text-sm font-bold text-foreground">
            What is wrong?
          </label>
          <Textarea
            id="correction-reason"
            value={correctionReason}
            onChange={(event) => setCorrectionReason(event.target.value.slice(0, 2_000))}
            disabled={!canPrepare || mutation.isPending}
            maxLength={2_000}
            rows={5}
            required
            placeholder="For example: Use the new roof size before we set the next price."
            className="mt-3"
          />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
            <span>Only the quote ID and this note are sent.</span>
            <span>{correctionReason.length}/2000</span>
          </div>
        </div>
        <div className="flex flex-col gap-3 border-t border-border bg-surface-muted/55 p-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p className="max-w-xl text-sm leading-6 text-muted">
            A person must review the current quote and empty draft before it is made.
          </p>
          <Button
            type="submit"
            variant="accent"
            className="shrink-0"
            busy={mutation.isPending}
            disabled={!canPrepare || mutation.isPending || trimmedReason.length < 1}
          >
            <FilePlus2 aria-hidden="true" />
            Send for review
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
    <dl className="grid border-y border-border sm:grid-cols-3" aria-label="Quote review list state">
      <QueueSignal label="Needs review" value={pending} tone="text-warning" dot="bg-warning" />
      <QueueSignal label="Being saved" value={recording} tone="text-info" dot="bg-info" bordered />
      <QueueSignal
        label="Needs a check"
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
      <dd className={cn("mt-1 text-xl font-bold tracking-[-0.03em] sm:mt-2 sm:text-2xl", tone)}>
        {value}
      </dd>
    </div>
  );
}

function RevisionDecisionRail({ approval }: { approval: QuoteRevisionApprovalRequest }) {
  const status = statePresentation[approval.state];
  return (
    <section
      className="overflow-hidden rounded-lg border border-border bg-surface-raised shadow-[0_1px_2px_oklch(0_0_0/0.035)]"
      aria-labelledby="revision-decision-path"
    >
      <div className="flex items-center justify-between gap-3 px-5 py-5 sm:px-6">
        <h2 id="revision-decision-path" className="text-sm font-bold text-muted">
          How this works
        </h2>
        <StatusBadge status={approval.state} />
      </div>
      <ol className="grid border-t border-border sm:grid-cols-4">
        <RailStep label="Current quote" detail={quoteVersion(approval.source.quote_version)} />
        <RailStep
          label="Empty draft"
          detail={quoteVersion(approval.target.quote_version)}
          bordered
        />
        <RailStep label="Review" detail={status.label} tone={status.tone} bordered />
        <RailStep
          label="Save record"
          detail={approval.hermes_run_id ? "Saved" : "Not yet"}
          bordered
        />
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
    <section
      className="overflow-hidden rounded-lg border border-border bg-surface-raised shadow-[0_1px_2px_oklch(0_0_0/0.035)]"
      aria-labelledby="prepare-decision-path"
    >
      <h2 id="prepare-decision-path" className="px-5 py-5 text-sm font-bold text-muted sm:px-6">
        What happens
      </h2>
      <ol className="grid border-t border-border sm:grid-cols-4">
        <RailStep
          label="Current quote"
          detail={`${quoteVersion(sourceVersion)} · ${sourceStatus}`}
        />
        <RailStep label="Empty draft" detail={quoteVersion(targetVersion)} bordered />
        <RailStep label="Review" detail="Needed" tone="bg-warning-soft text-warning" bordered />
        <RailStep label="Save record" detail="Made after review" bordered />
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
          "mt-2 break-words text-sm font-bold leading-5",
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
      className="rounded-lg border border-ok/25 bg-ok-soft/45 px-5 py-5 sm:px-6"
      aria-labelledby="commercial-fence-heading"
    >
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden="true" />
        <div>
          <h2 id="commercial-fence-heading" className="font-bold tracking-[-0.015em]">
            What stays out
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            Prices, tax, job details, payments, and customer replies are not copied. No message is
            sent. Money records do not change.
          </p>
        </div>
      </div>
    </section>
  );
}

function RevisionRequestFacts({ approval }: { approval: QuoteRevisionApprovalRequest }) {
  return (
    <section
      className="overflow-hidden rounded-lg border border-border bg-surface-raised shadow-[0_1px_2px_oklch(0_0_0/0.035)]"
      aria-labelledby="quote-review-facts"
    >
      <div className="border-b border-border px-5 py-5 sm:px-6">
        <h2 id="quote-review-facts" className="text-lg font-bold tracking-[-0.02em]">
          What you are reviewing
        </h2>
        <p className="mt-1 text-sm leading-6 text-muted">
          Check the current quote, the new version, and the reason for the change.
        </p>
      </div>
      <div className="grid sm:grid-cols-2">
        <div className="min-w-0 px-5 py-5 sm:px-6">
          <p className="text-sm font-bold text-muted">Current quote</p>
          <p className="mt-2 font-bold text-foreground">
            {quoteVersion(approval.source.quote_version)}
          </p>
          <p className="mt-1 break-words text-sm text-muted">{approval.source.status}</p>
        </div>
        <div className="min-w-0 border-t border-border px-5 py-5 sm:border-t-0 sm:border-l sm:px-6">
          <p className="text-sm font-bold text-muted">New empty draft</p>
          <p className="mt-2 font-bold text-foreground">
            {quoteVersion(approval.target.quote_version)}
          </p>
          <p className="mt-1 text-sm text-muted">Starts with no prices or job details</p>
        </div>
        <div className="border-t border-border px-5 py-5 sm:col-span-2 sm:px-6">
          <p className="text-sm font-bold text-muted">What needs to change</p>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-foreground">
            {approval.correction_reason}
          </p>
        </div>
      </div>
    </section>
  );
}

function RevisionSystemDetails({ approval }: { approval: QuoteRevisionApprovalRequest }) {
  return (
    <details className="rounded-lg border border-border bg-surface-raised">
      <summary className="min-h-14 cursor-pointer px-5 py-4 text-base font-bold sm:px-6">
        System details
      </summary>
      <dl className="divide-y divide-border border-t border-border text-sm">
        <div className="grid gap-1 px-5 py-4 sm:grid-cols-[10rem_minmax(0,1fr)] sm:px-6">
          <dt className="font-bold text-muted">Current quote ID</dt>
          <dd className="break-all">{approval.source.customer_quote_id}</dd>
        </div>
        <div className="grid gap-1 px-5 py-4 sm:grid-cols-[10rem_minmax(0,1fr)] sm:px-6">
          <dt className="font-bold text-muted">New draft ID</dt>
          <dd className="break-all">{approval.target.customer_quote_id}</dd>
        </div>
        <div className="grid gap-1 px-5 py-4 sm:grid-cols-[10rem_minmax(0,1fr)] sm:px-6">
          <dt className="font-bold text-muted">Request ID</dt>
          <dd className="break-all">{approval.id}</dd>
        </div>
        <div className="grid gap-1 px-5 py-4 sm:grid-cols-[10rem_minmax(0,1fr)] sm:px-6">
          <dt className="font-bold text-muted">Save record</dt>
          <dd className="break-all">{approval.hermes_run_id ?? approval.run_id}</dd>
        </div>
        {approval.error_code ? (
          <div className="grid gap-1 px-5 py-4 sm:grid-cols-[10rem_minmax(0,1fr)] sm:px-6">
            <dt className="font-bold text-muted">Error code</dt>
            <dd className="break-all">{approval.error_code}</dd>
          </div>
        ) : null}
      </dl>
    </details>
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
            ? "Go online before you choose"
            : requiresFreshRead
              ? "Load this request again"
              : "Waiting for the right person"}
        </p>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
          {offline
            ? "IronWrap will not save this choice while you are offline. No draft will be made."
            : requiresFreshRead
              ? "The last choice did not return a clear result. Do not try it again. Load the saved request first."
              : "You can read this request, but you cannot choose for it."}
        </p>
      </section>
    );
  }

  return (
    <section
      className="overflow-hidden rounded-lg border border-border bg-surface-raised shadow-[0_1px_2px_oklch(0_0_0/0.035)]"
      aria-labelledby="pending-decision-heading"
    >
      <div className="border-b border-border px-5 py-5 sm:px-6">
        <h2 id="pending-decision-heading" className="text-lg font-bold tracking-[-0.02em]">
          Make the empty draft?
        </h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
          Yes makes one empty draft, {quoteVersion(approval.target.quote_version)}. It has no
          prices, job details, payments, or customer reply.
        </p>
      </div>
      {rejecting ? (
        <div className="p-5 sm:p-6">
          <label htmlFor="revision-rejection-reason" className="text-sm font-bold">
            Why should we stop this request?
          </label>
          <Textarea
            id="revision-rejection-reason"
            value={rejectionReason}
            onChange={(event) => onRejectionReasonChange(event.target.value.slice(0, 1_000))}
            disabled={!canReject || busy}
            rows={4}
            maxLength={1_000}
            placeholder="Say what must be fixed before someone asks again."
            className="mt-3"
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
              Turn down request
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p className="max-w-xl text-sm leading-6 text-muted">
            This choice only works for quote {quoteVersion(approval.source.quote_version)} and empty
            draft {quoteVersion(approval.target.quote_version)}. If either changes, this request
            stops.
          </p>
          <div className="flex flex-col-reverse gap-3 sm:flex-row">
            {canReject ? (
              <Button
                type="button"
                variant="outline"
                className="whitespace-nowrap"
                disabled={busy}
                onClick={onStartReject}
              >
                Turn down
              </Button>
            ) : null}
            {canApprove ? (
              <Button
                type="button"
                variant="accent"
                className="whitespace-nowrap"
                busy={busy}
                disabled={busy}
                onClick={onApprove}
              >
                <CheckCircle2 aria-hidden="true" />
                Make empty draft
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
    <section
      className="rounded-lg border border-info/35 bg-info-soft px-5 py-6 sm:px-6"
      role="status"
    >
      <div className="flex items-start gap-3">
        <Hourglass className="mt-0.5 size-5 shrink-0 text-info" aria-hidden="true" />
        <div>
          <h2 className="font-bold">Saving the draft</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
            IronWrap is saving the approved draft. It will not send the same work again.
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
      className="rounded-lg border border-danger/40 bg-danger-soft px-5 py-6 sm:px-6"
      aria-labelledby="uncertain-heading"
    >
      <div className="flex items-start gap-3">
        <TriangleAlert className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden="true" />
        <div className="min-w-0">
          <h2 id="uncertain-heading" className="font-bold">
            Do not try this request again
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
            We could not tell if the draft was made. Check the saved record before you do anything
            else.
          </p>
        </div>
      </div>

      {approval.reconciliation ? (
        <div className="mt-5 border-t border-danger/25 pt-5" role="status">
          <p className="font-bold">
            Result check saved: {resultLabel(approval.reconciliation.outcome)}
          </p>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
            {approval.reconciliation.evidence}
          </p>
        </div>
      ) : !canReconcile ? (
        <p className="mt-5 border-t border-danger/25 pt-5 text-sm leading-6 text-muted">
          {offline
            ? "Go online before you save what you checked. IronWrap will not queue it offline."
            : requiresFreshRead
              ? "The last action did not return a clear result. Do not try it again. Load the saved request first."
              : "You cannot save this check. The right person must do it."}
        </p>
      ) : reconciling ? (
        <div className="mt-5 border-t border-danger/25 pt-5">
          <label htmlFor="reconciliation-outcome" className="text-sm font-bold">
            What happened?
          </label>
          <Select
            id="reconciliation-outcome"
            value={outcome}
            disabled={busy}
            onChange={(event) => onOutcomeChange(event.target.value as ReconciliationOutcome)}
            className="mt-2 text-sm"
          >
            <option value="inconclusive">Not sure</option>
            <option value="executed">Draft was made</option>
            <option value="not_executed">Draft was not made</option>
          </Select>
          <label htmlFor="reconciliation-evidence" className="mt-5 block text-sm font-bold">
            What did you check?
          </label>
          <Textarea
            id="reconciliation-evidence"
            value={evidence}
            onChange={(event) => onEvidenceChange(event.target.value.slice(0, 1_000))}
            disabled={busy}
            maxLength={1_000}
            rows={4}
            placeholder="Say what you checked and why no new draft is needed."
            className="mt-2"
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
              Save result check
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-5 border-t border-danger/25 pt-5">
          <Button type="button" variant="outline" disabled={busy} onClick={onStart}>
            <ClipboardCheck aria-hidden="true" />
            Check saved result
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
      className="rounded-lg border border-ok/40 bg-ok-soft px-5 py-6 sm:px-6"
      aria-labelledby="executed-heading"
    >
      <div className="flex items-start gap-3">
        <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden="true" />
        <div>
          <h2 id="executed-heading" className="font-bold">
            Draft is ready
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
            The empty draft was saved. No prices or job details were copied. No customer message or
            money record changed.
          </p>
        </div>
      </div>
      <dl className="mt-5 grid border-y border-ok/25 sm:grid-cols-3">
        <ResultFact
          label="Draft quote"
          value={outcome?.customer_quote_id ?? approval.target.customer_quote_id}
        />
        <ResultFact
          label="Draft version"
          value={quoteVersion(outcome?.quote_version ?? approval.target.quote_version)}
          bordered
        />
        <ResultFact
          label="Save record"
          value={approval.hermes_run_id ?? approval.run_id}
          bordered
        />
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
      <dt className="text-sm font-bold text-muted">{label}</dt>
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
      : presentation.description;
  return (
    <section
      className="rounded-lg border border-border bg-surface-raised px-5 py-6 sm:px-6"
      role="status"
    >
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
        "inline-flex min-h-8 items-center gap-1.5 rounded-full px-3 text-xs font-bold",
        presentation.tone,
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {presentation.label}
    </span>
  );
}

function QueueSkeleton() {
  return (
    <section
      className="mx-auto max-w-7xl space-y-6"
      aria-busy="true"
      aria-label="Loading quote change reviews"
    >
      <div className="h-40 rounded-lg border border-border bg-surface-muted/70" />
      <div className="grid overflow-hidden rounded-lg border border-border sm:grid-cols-3">
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
      <div className="min-h-52 rounded-lg border border-border bg-surface-muted/50" />
    </section>
  );
}

function DetailSkeleton() {
  return (
    <section
      className="mx-auto max-w-6xl space-y-6"
      aria-busy="true"
      aria-label="Loading quote review"
    >
      <div className="h-40 rounded-lg border border-border bg-surface-muted/70" />
      <div className="grid min-h-28 rounded-lg border border-border bg-surface-muted/55 sm:grid-cols-4" />
      <div className="min-h-28 rounded-lg border border-border bg-surface-muted/55" />
      <LoadingState label="Loading the saved quote review" />
    </section>
  );
}

function PrepareSkeleton() {
  return (
    <section
      className="mx-auto max-w-6xl space-y-6"
      aria-busy="true"
      aria-label="Loading current quote"
    >
      <div className="h-40 rounded-lg border border-border bg-surface-muted/70" />
      <div className="grid min-h-28 rounded-lg border border-border bg-surface-muted/55 sm:grid-cols-4" />
      <div className="min-h-72 rounded-lg border border-border bg-surface-muted/55" />
    </section>
  );
}

function quoteVersion(version: number): string {
  return `V${version}`;
}

function resultLabel(outcome: ReconciliationOutcome): string {
  if (outcome === "executed") return "Draft was made";
  if (outcome === "not_executed") return "Draft was not made";
  return "Not sure";
}

function messageFor(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return "We could not save this choice. Load the saved request before you choose again.";
  }
  switch (error.code) {
    case "quote_revision_broker_unavailable":
      return "IronWrap could not reach the quote service. No draft was confirmed.";
    case "quote_revision_approval_expired":
      return "This review ended before you chose. Start a new review from the quote.";
    case "quote_revision_approval_version_conflict":
      return "This request changed. Load it again before you choose.";
    case "execution_uncertain":
      return "We could not tell if the draft was made. Do not try again. Check the saved result.";
    case "quote_revision_approval_not_pending":
      return "This request no longer needs a choice. Load it again to see the saved state.";
    default:
      return "We could not save this choice. Load the saved request before you choose again.";
  }
}
