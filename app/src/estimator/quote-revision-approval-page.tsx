import { useMutation, useMutationState, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  ClipboardCheck,
  FilePlus2,
  Hourglass,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { RoleGuard } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Notice } from "../components/ui/notice";
import { PageHeader } from "../components/ui/page-header";
import { Select } from "../components/ui/select";
import { ErrorState, LoadingState } from "../components/ui/state-panel";
import { Status, type StatusKind } from "../components/ui/status";
import { SystemDetails } from "../components/ui/system-details";
import { Textarea } from "../components/ui/textarea";
import { ApiError } from "../lib/api";
import { cn } from "../lib/cn";
import { jobLabelParts } from "../lib/job-label";
import { ApprovalReceipt } from "../owner/approval-receipt";
import { loadEstimatorWorkbench } from "./estimator-api";
import {
  estimatorWorkbenchQueryKey,
  officeJobIdentityScope,
  quoteRevisionApprovalDetailQueryKey,
  type OfficeJobIdentityScope,
} from "./office-job-identity-query";
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

type RevisionReviewScope = {
  session: OfficeJobIdentityScope;
  approvalId: string;
};

type RevisionDecisionAction = (
  | { kind: "approve"; approval: QuoteRevisionApprovalRequest }
  | { kind: "reject"; approval: QuoteRevisionApprovalRequest; reason: string }
  | {
      kind: "reconcile";
      approval: QuoteRevisionApprovalRequest;
      outcome: ReconciliationOutcome;
      evidence: string;
    }
) & { scope: RevisionReviewScope };

const decisionMutationKey = ["quote-revision-approval-decision"] as const;

const detailKeyFor = (scope: RevisionReviewScope) =>
  quoteRevisionApprovalDetailQueryKey(scope.session, scope.approvalId);
const queueKeyFor = (scope: RevisionReviewScope) =>
  ["quote-revision-approvals", scope.session.tenantId, scope.session.userId] as const;

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
                <span className="grid size-12 shrink-0 place-items-center rounded-lg bg-foreground text-background">
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
            <span>Current quote</span>
            <ArrowRight className="size-4 text-muted" aria-hidden="true" />
            <span>New empty draft</span>
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
  // An opaque session identity keeps credentials out of mutation variables and cache keys.
  const sessionScope = useMemo(() => officeJobIdentityScope(session), [session]);
  const scope = useMemo(
    () => ({ session: sessionScope, approvalId: approvalId ?? "" }),
    [sessionScope, approvalId],
  );
  const visibleScope = useRef<RevisionReviewScope | null>(scope);
  useLayoutEffect(() => {
    visibleScope.current = scope;
    return () => {
      visibleScope.current = null;
    };
  }, [scope]);
  const queryKey = detailKeyFor(scope);
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
  const [feedbackScope, setFeedbackScope] = useState(scope);
  if (feedbackScope !== scope) {
    setFeedbackScope(scope);
    setRejecting(false);
    setRejectionReason("");
    setReconciling(false);
    setReconciliationOutcome("inconclusive");
    setReconciliationEvidence("");
    setActionError(undefined);
    setNotice(undefined);
    setRequiresFreshRead(false);
  }

  async function refreshCurrentRequest() {
    try {
      const result = await query.refetch();
      if (!result.error && result.data && visibleScope.current === scope) {
        setRequiresFreshRead(false);
      }
    } catch {
      // The visible read-state warning remains the source of truth until a current response arrives.
    }
  }

  const mutation = useMutation({
    mutationKey: decisionMutationKey,
    retry: false,
    mutationFn: async (action: RevisionDecisionAction) => {
      let result: QuoteRevisionApprovalMutationResponse;
      if (action.kind === "reconcile") {
        result = await reconcileQuoteRevisionApproval(
          session,
          action.approval.id,
          action.approval.version,
          action.outcome,
          action.evidence,
        );
      } else {
        const keyName = JSON.stringify([
          action.scope.session.tenantId,
          action.scope.session.userId,
          action.kind,
          action.approval.id,
        ]);
        const idempotencyKey = keys.current.get(keyName) ?? newQuoteRevisionApprovalDecisionKey();
        keys.current.set(keyName, idempotencyKey);
        result =
          action.kind === "approve"
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
      }
      if (!sameReviewBinding(action.approval, result.approval)) {
        throw new ApiError({
          status: 502,
          code: "quote_revision_approval_binding_mismatch",
          message: "The decision result does not match the reviewed request.",
        });
      }
      return result;
    },
    onSuccess: (result: QuoteRevisionApprovalMutationResponse, action: RevisionDecisionAction) => {
      if (visibleScope.current?.session !== action.scope.session) return;
      queryClient.setQueryData<QuoteRevisionApprovalDetailResponse>(
        detailKeyFor(action.scope),
        (current) =>
          // Keep the current identity only with the same immutable request/job/source-quote binding.
          current && sameReviewBinding(current.approval, result.approval)
            ? { ...current, approval: result.approval }
            : current,
      );
      queryClient.setQueryData<QuoteRevisionApprovalListResponse>(
        queueKeyFor(action.scope),
        (current) =>
          current
            ? {
                ...current,
                approvals: current.approvals.map((approval) =>
                  approval.id === result.approval.id ? result.approval : approval,
                ),
              }
            : current,
      );
      if (visibleScope.current !== action.scope) return;
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
    onError: (error, action) => {
      if (visibleScope.current !== action.scope) return;
      setActionError(messageFor(error));
      setNotice(undefined);
      setRequiresFreshRead(true);
    },
    onSettled: (_result, _error, action) => {
      const sameSession = visibleScope.current?.session === action.scope.session;
      void queryClient.invalidateQueries({
        queryKey: queueKeyFor(action.scope),
        refetchType: sameSession ? "active" : "none",
      });
      void queryClient.invalidateQueries({
        queryKey: detailKeyFor(action.scope),
        exact: true,
        refetchType: "none",
      });
      // Never issue an old session's read using the current session's credentials.
      if (!sameSession) return;
      void queryClient
        .fetchQuery({
          queryKey: detailKeyFor(action.scope),
          queryFn: () => loadQuoteRevisionApproval(action.scope.approvalId),
        })
        .then(() => {
          if (visibleScope.current === action.scope) setRequiresFreshRead(false);
        })
        .catch(() => {
          // Retain the originating read/error state until an authoritative read succeeds.
        });
    },
  });

  const pendingDecisions = useMutationState({
    filters: { mutationKey: decisionMutationKey, status: "pending" },
    // Mutation instances preserve the opaque session reference through structural sharing.
    select: (decision) => decision,
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
  function pendingForCurrentScope(variables: unknown) {
    const pendingScope = (variables as RevisionDecisionAction | undefined)?.scope;
    return pendingScope?.session === scope.session && pendingScope.approvalId === scope.approvalId;
  }
  const pendingAction = pendingDecisions.some(
    (decision) =>
      decision.state.status === "pending" && pendingForCurrentScope(decision.state.variables),
  );
  function hasPendingDecision() {
    return queryClient
      .getMutationCache()
      .findAll({ mutationKey: decisionMutationKey, status: "pending" })
      .some((decision) => pendingForCurrentScope(decision.state.variables));
  }

  function approve() {
    if (!canApprove || hasPendingDecision() || approval.state !== "pending") return;
    setActionError(undefined);
    mutation.mutate({ kind: "approve", approval, scope });
  }

  function reject() {
    const reason = rejectionReason.trim();
    if (!canReject || hasPendingDecision() || approval.state !== "pending" || reason.length < 3)
      return;
    setActionError(undefined);
    mutation.mutate({ kind: "reject", approval, reason, scope });
  }

  function reconcile() {
    const evidence = reconciliationEvidence.trim();
    if (
      !canReconcile ||
      hasPendingDecision() ||
      approval.state !== "execution_uncertain" ||
      evidence.length < 3
    ) {
      return;
    }
    setActionError(undefined);
    mutation.mutate({
      kind: "reconcile",
      approval,
      scope,
      outcome: reconciliationOutcome,
      evidence,
    });
  }

  return (
    <section className="mx-auto grid min-w-0 max-w-7xl gap-5 pb-6 [overflow-wrap:anywhere]">
      <PageHeader
        back={
          <Link
            to="/quote-revision-approvals"
            className="inline-flex min-h-11 items-center gap-2 hover:text-foreground"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            Quote change reviews
          </Link>
        }
        eyebrow={<RevisionJobIdentity job={model.job} />}
        title="Review the new empty draft"
      />

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
        <Notice tone="danger" title="Check the saved state">
          {actionError}
        </Notice>
      ) : null}
      {notice ? (
        <p className="sr-only" aria-live="polite">
          {notice}
        </p>
      ) : null}

      <div className="grid min-w-0 items-start gap-5 min-[1100px]:grid-cols-[minmax(0,1fr)_var(--inspector-w)] min-[1100px]:gap-x-6">
        <RevisionRequestFacts approval={approval} />

        <aside
          aria-label="Decision"
          className="min-w-0 overflow-hidden rounded-lg border border-border bg-surface-raised shadow-[0_2px_6px_rgb(21_24_28/0.06)] min-[1100px]:sticky min-[1100px]:top-[calc(var(--header-h,3.5rem)+1.25rem)] min-[1100px]:col-start-2 min-[1100px]:row-span-2 min-[1100px]:row-start-1"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-4">
            <h2 className="text-base font-semibold">Decision</h2>
            <DecisionStatus state={approval.state} />
          </div>
          {approval.state === "pending" ? (
            <PendingDecisionPanel
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
          {approval.state === "executed" ? <ExecutedPanel /> : null}
          {["denied", "expired", "failed", "audit_failed"].includes(approval.state) ? (
            <ClosedRequestPanel approval={approval} />
          ) : null}
          <div className="flex flex-wrap gap-2 border-t border-border px-5 py-4">
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
            <Button asChild variant="quiet" size="compact">
              <Link to="/estimator/jobs/$jobId" params={{ jobId: approval.roof_job_id }}>
                Open quote
                <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
          </div>
        </aside>

        <div className="grid min-w-0 gap-5">
          <ApprovalReceipt
            approval={approval}
            locale={{ locale: session.tenant.locale, timeZone: session.tenant.time_zone }}
          />
          <RevisionSystemDetails approval={approval} />
        </div>
      </div>
    </section>
  );
}

function QuoteRevisionApprovalPrepareContent() {
  const { jobId } = useParams({ strict: false }) as { jobId?: string };
  const session = useSession();
  const offline = isOfflineSession(session);
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: estimatorWorkbenchQueryKey(officeJobIdentityScope(session), jobId),
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
              <span className="grid size-12 shrink-0 place-items-center rounded-lg bg-foreground text-background">
                <FilePlus2 className="size-6 text-accent" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-muted">
                  <RevisionJobIdentity job={model.job} />
                </p>
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

      <PrepareDecisionRail sourceStatus={source.status} />
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

function PrepareDecisionRail({ sourceStatus }: { sourceStatus: string }) {
  return (
    <section
      className="overflow-hidden rounded-lg border border-border bg-surface-raised shadow-[0_1px_2px_oklch(0_0_0/0.035)]"
      aria-labelledby="prepare-decision-path"
    >
      <h2 id="prepare-decision-path" className="px-5 py-5 text-sm font-bold text-muted sm:px-6">
        What happens
      </h2>
      <ol className="grid border-t border-border sm:grid-cols-4">
        <RailStep label="Current quote" detail={sourceStatus} />
        <RailStep label="Empty draft" detail="New, with no prices" bordered />
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
      className="min-w-0 overflow-hidden rounded-lg border border-border bg-surface-raised"
      aria-labelledby="quote-review-facts"
    >
      <div className="px-5 py-4 sm:px-6">
        <h2 id="quote-review-facts" className="text-base font-semibold">
          What you are reviewing
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted">
          One new empty draft. Prices and job details are added later.
        </p>
      </div>
      <div className="grid border-y border-border sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <dl className="min-w-0 px-5 py-4 sm:px-6">
          <dt className="text-sm text-muted">Current quote</dt>
          <dd className="mt-1 text-lg font-semibold">{approval.source.status}</dd>
          <dd className="mt-1 text-sm text-muted">As it is now; it stays as it is</dd>
        </dl>
        <div className="hidden items-center text-faint sm:flex" aria-hidden="true">
          <ArrowRight className="size-4" />
        </div>
        <dl className="min-w-0 border-t border-border px-5 py-4 sm:border-t-0 sm:px-6">
          <dt className="text-sm text-muted">New empty draft</dt>
          <dd className="mt-1 text-lg font-semibold">Empty</dd>
          <dd className="mt-1 text-sm text-muted">No prices or job details</dd>
        </dl>
      </div>
      <div className="px-5 py-4 sm:px-6">
        <h3 className="text-sm font-semibold">Why this revision</h3>
        <p className="mt-2 max-w-prose whitespace-pre-wrap text-sm leading-6">
          {approval.correction_reason}
        </p>
      </div>
      <div className="border-t border-border px-5 py-4 sm:px-6">
        <h3 className="text-sm font-semibold">What stays out</h3>
        <p className="mt-2 max-w-prose text-sm leading-6 text-muted">
          Prices, tax, job details, payments, and customer replies are not copied. No message is
          sent. Money records do not change.
        </p>
      </div>
    </section>
  );
}

function RevisionSystemDetails({ approval }: { approval: QuoteRevisionApprovalRequest }) {
  const facts = [
    ["Current quote ID", approval.source.customer_quote_id],
    ["New draft ID", approval.target.customer_quote_id],
    ["Request ID", approval.id],
    ["Request version", String(approval.version)],
    ["Current quote version", String(approval.source.quote_version)],
    ["New draft version", String(approval.target.quote_version)],
    ["Save record ID", approval.hermes_run_id ?? approval.run_id],
    ...(approval.outcome ? [["Recorded draft ID", approval.outcome.customer_quote_id]] : []),
    ...(approval.error_code ? [["Error code", approval.error_code]] : []),
  ];
  return (
    <SystemDetails
      className="min-w-0 rounded-lg border border-border bg-surface-raised min-[1100px]:col-start-1"
      summaryClassName="px-5 sm:px-6"
    >
      <dl className="divide-y divide-border border-t border-border text-sm">
        {facts.map(([label, value]) => (
          <div
            key={label}
            className="grid gap-1 px-5 py-3 sm:grid-cols-[9rem_minmax(0,1fr)] sm:px-6"
          >
            <dt className="text-muted">{label}</dt>
            <dd className="break-all font-mono text-xs leading-5">{value}</dd>
          </div>
        ))}
      </dl>
    </SystemDetails>
  );
}

function DecisionStatus({ state }: { state: QuoteRevisionApprovalRequest["state"] }) {
  const kind: Record<QuoteRevisionApprovalRequest["state"], StatusKind> = {
    pending: "attention",
    executing: "pending",
    executed: "confirmed",
    denied: "retired",
    expired: "retired",
    failed: "stopped",
    audit_failed: "stopped",
    execution_uncertain: "attention",
  };
  return <Status kind={kind[state]}>{statePresentation[state].label}</Status>;
}

function PendingDecisionPanel({
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
  const rejectButton = useRef<HTMLElement>(null);
  const returnFocus = useRef(false);
  useEffect(() => {
    if (!rejecting && returnFocus.current) {
      rejectButton.current?.querySelector<HTMLButtonElement>("[data-reject-trigger]")?.focus();
      returnFocus.current = false;
    }
  }, [rejecting]);

  if (!canApprove && !canReject) {
    return (
      <section className="px-5 py-4" role="status">
        <h3 className="text-sm font-semibold">
          {offline
            ? "Go online before you choose"
            : requiresFreshRead
              ? "Load this request again"
              : "Waiting for the right person"}
        </h3>
        <p className="mt-2 text-sm leading-6 text-muted">
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
    <section ref={rejectButton} aria-labelledby="pending-decision-heading">
      <div className="px-5 pt-4">
        <h3 id="pending-decision-heading" className="text-sm font-semibold">
          Make the empty draft?
        </h3>
        <p className="mt-2 text-sm leading-6 text-muted">
          Create a new empty draft with no prices, job details, payments, or customer reply.
        </p>
      </div>
      {rejecting ? (
        <div className="px-5 py-4">
          <label htmlFor="revision-rejection-reason" className="text-sm font-semibold">
            Why should we stop this request?
          </label>
          <Textarea
            id="revision-rejection-reason"
            value={rejectionReason}
            onChange={(event) => onRejectionReasonChange(event.target.value.slice(0, 1_000))}
            disabled={!canReject || busy}
            autoFocus
            rows={4}
            maxLength={1_000}
            placeholder="Say what must be fixed before someone asks again."
            className="mt-2"
          />
          <div className="mt-2 flex flex-wrap justify-between gap-1 text-xs text-muted">
            <span>At least 3 characters.</span>
            <span>{rejectionReason.length}/1000</span>
          </div>
          <div className="mt-4 grid gap-2">
            <Button
              type="button"
              variant="danger"
              className="whitespace-normal"
              busy={busy}
              disabled={!canReject || busy || rejectionReason.trim().length < 3}
              onClick={onReject}
            >
              <XCircle aria-hidden="true" />
              Turn down request
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                returnFocus.current = true;
                onCancelReject();
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="px-5 py-4">
          <div className="grid gap-2">
            {canApprove ? (
              <Button
                type="button"
                variant="primary"
                className="whitespace-normal"
                busy={busy}
                disabled={busy}
                onClick={onApprove}
              >
                <CheckCircle2 aria-hidden="true" />
                Make empty draft
              </Button>
            ) : null}
            {canReject ? (
              <Button
                data-reject-trigger
                type="button"
                variant="outline"
                disabled={busy}
                onClick={onStartReject}
              >
                Turn down
              </Button>
            ) : null}
          </div>
          <p className="mt-4 text-xs leading-5 text-muted">
            Only for the current quote and this new empty draft. If either changes, this request
            stops.
          </p>
        </div>
      )}
    </section>
  );
}

function ExecutingPanel() {
  return (
    <section className="px-5 py-4" role="status">
      <div className="flex items-start gap-3">
        <Hourglass className="mt-0.5 size-5 shrink-0 text-info" aria-hidden="true" />
        <div>
          <h2 className="text-sm font-semibold">Saving the draft</h2>
          <p className="mt-2 text-sm leading-6 text-muted">
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
  const checkButton = useRef<HTMLElement>(null);
  const returnFocus = useRef(false);
  useEffect(() => {
    if (!reconciling && returnFocus.current) {
      checkButton.current?.querySelector<HTMLButtonElement>("[data-check-trigger]")?.focus();
      returnFocus.current = false;
    }
  }, [reconciling]);

  return (
    <section className="px-5 py-4" ref={checkButton} aria-labelledby="uncertain-heading">
      <div className="flex items-start gap-3">
        <TriangleAlert className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden="true" />
        <div className="min-w-0">
          <h2 id="uncertain-heading" className="text-sm font-semibold">
            Do not try this request again
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            We could not tell if the draft was made. Check the saved record before you do anything
            else.
          </p>
        </div>
      </div>

      {approval.reconciliation ? (
        <div className="mt-4 border-t border-border pt-4" role="status">
          <p className="text-sm font-semibold">
            Result check saved: {resultLabel(approval.reconciliation.outcome)}
          </p>
          <p className="mt-2 text-sm leading-6 text-muted">{approval.reconciliation.evidence}</p>
        </div>
      ) : !canReconcile ? (
        <p className="mt-4 border-t border-border pt-4 text-sm leading-6 text-muted">
          {offline
            ? "Go online before you save what you checked. IronWrap will not queue it offline."
            : requiresFreshRead
              ? "The last action did not return a clear result. Do not try it again. Load the saved request first."
              : "You cannot save this check. The right person must do it."}
        </p>
      ) : reconciling ? (
        <div className="mt-4 border-t border-border pt-4">
          <label htmlFor="reconciliation-outcome" className="text-sm font-bold">
            What happened?
          </label>
          <Select
            id="reconciliation-outcome"
            autoFocus
            value={outcome}
            disabled={busy}
            onChange={(event) => onOutcomeChange(event.target.value as ReconciliationOutcome)}
            className="mt-2 text-sm"
          >
            <option value="inconclusive">Not sure</option>
            <option value="executed">Draft was made</option>
            <option value="not_executed">Draft was not made</option>
          </Select>
          <label htmlFor="reconciliation-evidence" className="mt-4 block text-sm font-bold">
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
          <div className="mt-4 grid gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                returnFocus.current = true;
                onCancel();
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              className="whitespace-normal"
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
        <div className="mt-4 border-t border-border pt-4">
          <Button
            data-check-trigger
            type="button"
            variant="outline"
            className="w-full whitespace-normal"
            disabled={busy}
            onClick={onStart}
          >
            <ClipboardCheck aria-hidden="true" />
            Check saved result
          </Button>
        </div>
      )}
    </section>
  );
}

function ExecutedPanel() {
  return (
    <section className="px-5 py-4" aria-labelledby="executed-heading">
      <div className="flex items-start gap-3">
        <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden="true" />
        <div>
          <h2 id="executed-heading" className="text-sm font-semibold">
            Draft is ready
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            The empty draft was saved. No prices or job details were copied. No customer message or
            money record changed.
          </p>
        </div>
      </div>
      <p className="mt-4 border-t border-border pt-4 text-sm font-semibold">New empty draft</p>
    </section>
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
    <section className="px-5 py-4" role="status">
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 size-5 shrink-0 text-muted" aria-hidden="true" />
        <div>
          <h2 className="text-sm font-semibold">{presentation.label}</h2>
          <p className="mt-2 text-sm leading-6 text-muted">{explanation}</p>
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

function RevisionJobIdentity({
  job,
}: {
  job: {
    customer_display_name?: string | null;
    address?: string | null;
    job_number?: string | null;
  } | null;
}) {
  const { lead, code } = jobLabelParts({
    customer: job?.customer_display_name,
    address: job?.address,
    code: job?.job_number,
  });
  return (
    <span aria-label="Job identity" className="break-words">
      {lead}
      {lead && code ? " · " : null}
      {code ? <span className="whitespace-nowrap">{`Job ${code}`}</span> : null}
      {!lead && !code ? "Job details unavailable" : null}
    </span>
  );
}

function sameReviewBinding(
  left: QuoteRevisionApprovalRequest,
  right: QuoteRevisionApprovalRequest,
) {
  return (
    left.id === right.id &&
    left.roof_job_id === right.roof_job_id &&
    left.source.customer_quote_id === right.source.customer_quote_id &&
    left.source.quote_version === right.source.quote_version &&
    left.source.status === right.source.status &&
    left.source.modified === right.source.modified &&
    left.target.customer_quote_id === right.target.customer_quote_id &&
    left.target.quote_version === right.target.quote_version
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
    case "quote_revision_approval_binding_mismatch":
      return "The result did not match this review. Load the saved request before you choose again.";
    case "execution_uncertain":
      return "We could not tell if the draft was made. Do not try again. Check the saved result.";
    case "quote_revision_approval_not_pending":
      return "This request no longer needs a choice. Load it again to see the saved state.";
    default:
      return "We could not save this choice. Load the saved request before you choose again.";
  }
}
