import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  ClipboardCheck,
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
import { Notice } from "../components/ui/notice";
import { ErrorState, LoadingState } from "../components/ui/state-panel";
import { ApiError } from "../lib/api";
import { cn } from "../lib/cn";
import { loadProductionRunway } from "./production-api";
import type { ProductionRunwayResponse } from "./production-contracts";
import {
  approveProductionScheduleApproval,
  loadProductionScheduleApproval,
  loadProductionScheduleApprovals,
  newProductionScheduleApprovalDecisionKey,
  reconcileProductionScheduleApproval,
  rejectProductionScheduleApproval,
} from "./production-schedule-approval-api";
import type {
  ProductionScheduleApprovalDetailResponse,
  ProductionScheduleApprovalListResponse,
  ProductionScheduleApprovalMutationResponse,
  ProductionScheduleApprovalRequest,
} from "./production-schedule-approval-contracts";

type ReconciliationOutcome = "executed" | "not_executed" | "inconclusive";

type ScheduleDecisionAction =
  | { kind: "approve"; approval: ProductionScheduleApprovalRequest }
  | { kind: "reject"; approval: ProductionScheduleApprovalRequest; reason: string }
  | {
      kind: "reconcile";
      approval: ProductionScheduleApprovalRequest;
      outcome: ReconciliationOutcome;
      evidence: string;
    };

const ACTION_LABELS: Record<string, string> = {
  create_job_assignment: "Record a crew assignment",
};

const RECONCILIATION_LABELS: Record<ReconciliationOutcome, string> = {
  executed: "Assignment was recorded",
  not_executed: "Assignment was not recorded",
  inconclusive: "Inconclusive",
};

const statePresentation: Record<
  ProductionScheduleApprovalRequest["state"],
  { label: string; description: string; tone: string; Icon: LucideIcon }
> = {
  pending: {
    label: "Needs a check",
    description: "A designated owner must decide before any crew assignment is saved.",
    tone: "bg-warning-soft text-warning",
    Icon: CircleAlert,
  },
  executing: {
    label: "Recording once",
    description: "The approved assignment write is in progress. Do not submit a second decision.",
    tone: "bg-info-soft text-info",
    Icon: Hourglass,
  },
  executed: {
    label: "Assignment recorded",
    description: "The crew assignment is saved. The schedule service recorded the outcome.",
    tone: "bg-ok-soft text-ok",
    Icon: CheckCircle2,
  },
  denied: {
    label: "Not approved",
    description: "The request was rejected before any assignment was created.",
    tone: "bg-surface-muted text-muted",
    Icon: XCircle,
  },
  expired: {
    label: "Review window expired",
    description: "This request expired before a decision. Prepare a current request from the job.",
    tone: "bg-surface-muted text-muted",
    Icon: Hourglass,
  },
  failed: {
    label: "Refused",
    description:
      "The protected write was refused. Read the recorded reason before preparing again.",
    tone: "bg-danger-soft text-danger",
    Icon: TriangleAlert,
  },
  audit_failed: {
    label: "Audit incomplete",
    description: "The protected operation did not reach its required audit state.",
    tone: "bg-danger-soft text-danger",
    Icon: TriangleAlert,
  },
  execution_uncertain: {
    label: "Outcome uncertain",
    description:
      "The schedule service result could not be verified. Reconcile the recorded outcome and do not retry.",
    tone: "bg-danger-soft text-danger",
    Icon: TriangleAlert,
  },
};

export function ProductionScheduleApprovalQueuePage() {
  return (
    <RoleGuard surface="owner">
      <ProductionScheduleApprovalQueueContent />
    </RoleGuard>
  );
}

export function ProductionScheduleApprovalDetailPage() {
  return (
    <RoleGuard surface="owner">
      <ProductionScheduleApprovalDetailContent />
    </RoleGuard>
  );
}

function ProductionScheduleApprovalQueueContent() {
  const session = useSession();
  const queryKey = ["production-schedule-approvals", session.tenant.id, session.user.id] as const;
  const query = useQuery({
    queryKey,
    queryFn: () => loadProductionScheduleApprovals(),
    retry: false,
  });
  const runwayQuery = useQuery({
    queryKey: ["production-runway", session.tenant.id, session.user.id],
    queryFn: () => loadProductionRunway(),
    retry: false,
  });
  const locale = session.tenant.locale;
  const timeZone = session.tenant.time_zone;

  if (!query.data && query.isPending)
    return <LoadingState label="Loading schedule request queue…" />;
  if (!query.data && query.isError) {
    return (
      <ErrorState
        title="Schedule request queue unavailable"
        message="No request was changed. Reconnect to inspect the current recorded queue before deciding anything."
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!query.data) return <LoadingState label="Loading schedule request queue…" />;

  const model = query.data;
  return (
    <section className="mx-auto max-w-6xl space-y-6 pb-4">
      <header className="border-b border-border pb-5 sm:pb-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <Button asChild variant="ghost" size="compact" className="-ml-2">
              <Link to="/production">
                <ArrowLeft aria-hidden="true" />
                Back to production
              </Link>
            </Button>
            <div className="mt-4 flex min-w-0 items-start gap-3">
              <span className="grid size-11 shrink-0 place-items-center rounded-md bg-foreground text-background">
                <CalendarClock className="size-5 text-accent" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h1 className="mt-1 text-3xl font-black tracking-[-0.035em] text-balance sm:text-4xl">
                  Schedule requests
                </h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted sm:text-base">
                  Each request is limited to one append-only Job Assignment. This queue does not
                  notify the crew, contact a customer, or change accounting.
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
          <CalendarClock className="mx-auto size-7 text-muted" aria-hidden="true" />
          <h2 className="mt-4 text-xl font-bold tracking-[-0.025em]">
            No schedule requests are waiting
          </h2>
          <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-muted">
            A governed request appears here after an owner prepares a crew assignment from the
            production runway.
          </p>
        </section>
      ) : (
        <ol className="border-y border-border" aria-label="Schedule requests">
          {model.approvals.map((approval) => (
            <li key={approval.id} className="border-b border-border last:border-b-0">
              <ScheduleQueueRow
                approval={approval}
                runway={runwayQuery.data}
                locale={locale}
                timeZone={timeZone}
              />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function ScheduleQueueRow({
  approval,
  runway,
  locale,
  timeZone,
}: {
  approval: ProductionScheduleApprovalRequest;
  runway?: ProductionRunwayResponse;
  locale: string;
  timeZone: string;
}) {
  const display = scheduleDisplay(approval, runway, locale, timeZone);
  return (
    <Link
      to="/production/schedule-approvals/$approvalId"
      params={{ approvalId: approval.id }}
      className="group block rounded-md px-4 py-5 transition-colors hover:bg-surface-muted focus-visible:outline-offset-[-3px] sm:px-5"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-bold text-foreground">
            <span>Job {display.jobNumber}</span>
            <ArrowRight className="size-4 text-muted" aria-hidden="true" />
            <span>Crew {display.crewName}</span>
          </p>
          <p className="mt-1 text-sm text-muted">
            Start {display.startLabel}
            {display.endLabel ? ` · End ${display.endLabel}` : ""}
          </p>
          {approval.correction_reason ? (
            <p className="mt-3 max-w-3xl text-sm leading-6 text-muted">
              {approval.correction_reason}
            </p>
          ) : null}
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

function ProductionScheduleApprovalDetailContent() {
  const { approvalId } = useParams({ strict: false }) as { approvalId?: string };
  const session = useSession();
  const queryClient = useQueryClient();
  const offline = isOfflineSession(session);
  const queryKey = [
    "production-schedule-approval",
    session.tenant.id,
    session.user.id,
    approvalId,
  ] as const;
  const queueKey = ["production-schedule-approvals", session.tenant.id, session.user.id] as const;
  const keys = useRef(new Map<string, string>());
  const [actionError, setActionError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [requiresFreshRead, setRequiresFreshRead] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectionReason, setRejectionReason] = useState("");
  const [reconciling, setReconciling] = useState(false);
  const [reconciliationOutcome, setReconciliationOutcome] =
    useState<ReconciliationOutcome>("inconclusive");
  const [reconciliationEvidence, setReconciliationEvidence] = useState("");

  const query = useQuery({
    queryKey,
    enabled: Boolean(approvalId),
    queryFn: () => loadProductionScheduleApproval(approvalId!),
    retry: false,
  });
  const runwayQuery = useQuery({
    queryKey: ["production-runway", session.tenant.id, session.user.id],
    queryFn: () => loadProductionRunway(),
    retry: false,
  });
  const locale = session.tenant.locale;
  const timeZone = session.tenant.time_zone;

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
    mutationFn: async (action: ScheduleDecisionAction) => {
      if (action.kind === "reconcile") {
        return await reconcileProductionScheduleApproval(
          session,
          action.approval.id,
          action.approval.version,
          action.outcome,
          action.evidence,
        );
      }
      const keyName = `${action.kind}:${action.approval.id}`;
      const idempotencyKey =
        keys.current.get(keyName) ?? newProductionScheduleApprovalDecisionKey();
      keys.current.set(keyName, idempotencyKey);
      return action.kind === "approve"
        ? await approveProductionScheduleApproval(
            session,
            action.approval.id,
            action.approval.version,
            idempotencyKey,
          )
        : await rejectProductionScheduleApproval(
            session,
            action.approval.id,
            action.approval.version,
            action.reason,
            idempotencyKey,
          );
    },
    onSuccess: (
      result: ProductionScheduleApprovalMutationResponse,
      action: ScheduleDecisionAction,
    ) => {
      queryClient.setQueryData<ProductionScheduleApprovalDetailResponse>(queryKey, (current) =>
        current ? { ...current, approval: result.approval } : current,
      );
      queryClient.setQueryData<ProductionScheduleApprovalListResponse>(queueKey, (current) =>
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
            ? "The request was rejected. No crew assignment was created."
            : result.approval.state === "executed"
              ? "The crew assignment is saved. The schedule service recorded the outcome."
              : "The recorded outcome changed. Review the current saved record.",
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
        title="This schedule request link is incomplete"
        message="No request was provided. Return to the queue and select a recorded request."
        action={
          <Button asChild variant="outline">
            <Link to="/production/schedule-approvals">Open schedule requests</Link>
          </Button>
        }
      />
    );
  }
  if (!query.data && query.isPending) return <LoadingState label="Loading schedule request…" />;
  if (!query.data && query.isError) {
    return (
      <ErrorState
        title="Schedule request unavailable"
        message="No request was changed. Reconnect to inspect the current recorded state before deciding anything."
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!query.data) return <LoadingState label="Loading schedule request…" />;

  const model = query.data;
  const approval = model.approval;
  const display = scheduleDisplay(approval, runwayQuery.data, locale, timeZone);
  const decisionReadStale = requiresFreshRead || query.isError;
  const canApprove =
    !offline &&
    !decisionReadStale &&
    model.allowed_actions.includes("production_schedule_approval.approve");
  const canReject =
    !offline &&
    !decisionReadStale &&
    model.allowed_actions.includes("production_schedule_approval.reject");
  const canReconcile =
    !offline &&
    !decisionReadStale &&
    model.allowed_actions.includes("production_schedule_approval.reconcile");
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
              <Link to="/production/schedule-approvals">
                <ArrowLeft aria-hidden="true" />
                Schedule requests
              </Link>
            </Button>
            <div className="mt-4 flex min-w-0 items-start gap-3">
              <span className="grid size-11 shrink-0 place-items-center rounded-md bg-foreground text-background">
                <CalendarClock className="size-5 text-accent" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h1 className="mt-1 text-3xl font-black tracking-[-0.035em] text-balance sm:text-4xl">
                  Crew assignment request
                </h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted sm:text-base">
                  Decide only whether to record the bounded Job Assignment shown below. Crew
                  notification and customer contact stay out of this request.
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
              <Link to="/production">
                Open production runway
                <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
          </div>
        </div>
      </header>

      {offline ? (
        <Notice tone="warning" title="Reconnect before deciding">
          This app never queues an approval decision offline. No assignment will be created until a
          current online decision is recorded.
        </Notice>
      ) : null}
      {decisionReadStale && !offline ? (
        <Notice tone="warning" title="Refresh before another decision">
          The previous decision did not return a confirmed current state. Do not retry it.
        </Notice>
      ) : null}
      {actionError ? (
        <Notice tone="danger" title="The protected decision was not confirmed">
          {actionError}
        </Notice>
      ) : null}
      {notice ? (
        <Notice tone="success" title="Recorded outcome">
          {notice}
        </Notice>
      ) : null}

      <ScheduleDecisionRail approval={approval} display={display} />
      <AssignmentFence />
      <ScheduleRequestFacts approval={approval} display={display} />
      <ScheduleSystemDetails approval={approval} display={display} />

      {approval.state === "pending" ? (
        <PendingDecisionPanel
          display={display}
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
      {approval.state === "executed" ? <ExecutedPanel display={display} /> : null}
      {["denied", "expired", "failed", "audit_failed"].includes(approval.state) ? (
        <ClosedRequestPanel approval={approval} />
      ) : null}
    </section>
  );
}

function QueueSignals({ approvals }: { approvals: ProductionScheduleApprovalRequest[] }) {
  const pending = approvals.filter((approval) => approval.state === "pending").length;
  const recording = approvals.filter((approval) => approval.state === "executing").length;
  const uncertain = approvals.filter((approval) => approval.state === "execution_uncertain").length;
  return (
    <dl
      className="grid border-y border-border sm:grid-cols-3"
      aria-label="Schedule request queue state"
    >
      <QueueSignal label="Needs a check" value={pending} tone="text-warning" dot="bg-warning" />
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

function ScheduleDecisionRail({
  approval,
  display,
}: {
  approval: ProductionScheduleApprovalRequest;
  display: ScheduleDisplay;
}) {
  const status = statePresentation[approval.state];
  return (
    <section aria-labelledby="schedule-decision-path">
      <div className="flex items-center justify-between gap-3">
        <h2 id="schedule-decision-path" className="text-sm font-bold text-muted">
          Recorded decision path
        </h2>
        <StatusBadge status={approval.state} />
      </div>
      <ol className="mt-3 grid border border-border sm:grid-cols-4">
        <RailStep label="Job" detail={display.jobNumber} />
        <RailStep label="Crew" detail={display.crewName} bordered />
        <RailStep label="Human decision" detail={status.label} tone={status.tone} bordered />
        <RailStep
          label="Save record"
          detail={approval.state === "executed" ? "Recorded" : "Pending"}
          bordered
        />
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

function AssignmentFence() {
  return (
    <section
      className="border border-border bg-surface-muted/65 px-5 py-5 sm:px-6"
      aria-labelledby="assignment-fence-heading"
    >
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden="true" />
        <div>
          <h2 id="assignment-fence-heading" className="font-bold tracking-[-0.015em]">
            Crew and customer stay unnotified
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            Approval records only the Job Assignment shown in the preview. No crew message is sent,
            no customer is contacted, and accounting remains unchanged.
          </p>
        </div>
      </div>
    </section>
  );
}

function ScheduleRequestFacts({
  approval,
  display,
}: {
  approval: ProductionScheduleApprovalRequest;
  display: ScheduleDisplay;
}) {
  return (
    <section
      className="grid border-y border-border sm:grid-cols-2"
      aria-label="Schedule request facts"
    >
      <div className="min-w-0 px-4 py-5 sm:px-5">
        <p className="text-sm font-bold text-muted">Job</p>
        <p className="mt-2 font-bold text-foreground">{display.jobNumber}</p>
        {display.actionLabel ? (
          <p className="mt-1 text-sm text-muted">{display.actionLabel}</p>
        ) : null}
      </div>
      <div className="min-w-0 border-t border-border px-4 py-5 sm:border-t-0 sm:border-l sm:px-5">
        <p className="text-sm font-bold text-muted">Proposed assignment</p>
        <p className="mt-2 font-bold text-foreground">{display.crewName}</p>
        <p className="mt-1 text-sm text-muted">Start {display.startLabel}</p>
      </div>
      {approval.correction_reason ? (
        <div className="border-t border-border px-4 py-5 sm:col-span-2 sm:px-5">
          <p className="text-sm font-bold text-muted">Correction reason</p>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-foreground">
            {approval.correction_reason}
          </p>
        </div>
      ) : null}
      {approval.preview ? (
        <div className="border-t border-border px-4 py-5 sm:col-span-2 sm:px-5">
          <p className="text-sm font-bold text-muted">Preview effects</p>
          <p className="mt-2 text-sm leading-6 text-foreground">
            Crew notified: no. Customer notified: no. Accounting mutated: no.
          </p>
        </div>
      ) : null}
    </section>
  );
}

function PendingDecisionPanel({
  display,
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
  display: ScheduleDisplay;
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
            ? "This app never queues an approval decision offline. No assignment will be created until a current online decision is recorded."
            : requiresFreshRead
              ? "The previous decision did not return a confirmed current state. Do not retry it. Refresh the recorded request before any further action."
              : "The server did not grant you a decision capability for this exact request. You can continue to inspect the recorded assignment."}
        </p>
      </section>
    );
  }

  return (
    <section className="border border-border bg-surface" aria-labelledby="pending-decision-heading">
      <div className="border-b border-border px-5 py-5 sm:px-6">
        <h2 id="pending-decision-heading" className="text-lg font-bold tracking-[-0.02em]">
          Decide this crew assignment
        </h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
          Approval saves only the crew assignment for {display.jobNumber} with {display.crewName}.
          Crew and customer stay unnotified.
        </p>
      </div>
      {rejecting ? (
        <div className="p-5 sm:p-6">
          <label htmlFor="schedule-rejection-reason" className="text-sm font-bold">
            Why should this request be rejected?
          </label>
          <textarea
            id="schedule-rejection-reason"
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
            The request is bound to this job, crew, and start. It expires if the recorded state
            changes.
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
                Approve crew assignment
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
  approval: ProductionScheduleApprovalRequest;
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
        <div>
          <h2 id="uncertain-heading" className="font-bold">
            Do not retry this request
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
            The schedule service result is uncertain. A second write is never issued automatically.
            Inspect the recorded outcome and reconcile it instead.
          </p>
        </div>
      </div>

      {approval.reconciliation ? (
        <div className="mt-5 border-t border-danger/25 pt-5" role="status">
          <p className="font-bold">
            Reconciliation recorded: {RECONCILIATION_LABELS[approval.reconciliation.outcome]}
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
          <label htmlFor="schedule-reconciliation-outcome" className="text-sm font-bold">
            Reconciliation outcome
          </label>
          <select
            id="schedule-reconciliation-outcome"
            value={outcome}
            disabled={busy}
            onChange={(event) => onOutcomeChange(event.target.value as ReconciliationOutcome)}
            className="mt-2 min-h-12 w-full rounded-lg border bg-surface-raised px-3 text-sm shadow-sm outline-none focus:border-info disabled:cursor-not-allowed disabled:bg-surface-muted"
          >
            <option value="inconclusive">Inconclusive</option>
            <option value="executed">Assignment was recorded</option>
            <option value="not_executed">Assignment was not recorded</option>
          </select>
          <label
            htmlFor="schedule-reconciliation-evidence"
            className="mt-5 block text-sm font-bold"
          >
            Reconciliation evidence
          </label>
          <textarea
            id="schedule-reconciliation-evidence"
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

function ExecutedPanel({ display }: { display: ScheduleDisplay }) {
  return (
    <section
      className="border border-ok/40 bg-ok-soft px-5 py-6 sm:px-6"
      aria-labelledby="executed-heading"
    >
      <div className="flex items-start gap-3">
        <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden="true" />
        <div>
          <h2 id="executed-heading" className="font-bold">
            Assignment recorded
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
            The crew assignment is saved. No crew message, customer contact, or accounting change
            was made.
          </p>
        </div>
      </div>
      <dl className="mt-5 grid border-y border-ok/25 sm:grid-cols-3">
        <ResultFact label="Job" value={display.jobNumber} />
        <ResultFact label="Crew" value={display.crewName} bordered />
        <ResultFact label="Start" value={display.startLabel} bordered />
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

function ClosedRequestPanel({ approval }: { approval: ProductionScheduleApprovalRequest }) {
  const presentation = statePresentation[approval.state];
  const Icon = presentation.Icon;
  const explanation =
    approval.state === "failed" && approval.refusal_message
      ? approval.refusal_message
      : approval.state === "denied" && approval.rejection_reason
        ? approval.rejection_reason
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

function StatusBadge({ status }: { status: ProductionScheduleApprovalRequest["state"] }) {
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

function ScheduleSystemDetails({
  approval,
  display,
}: {
  approval: ProductionScheduleApprovalRequest;
  display: ScheduleDisplay;
}) {
  return (
    <details className="group rounded-lg border border-border bg-surface-raised">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 text-sm font-bold sm:min-h-14 sm:px-5 [&::-webkit-details-marker]:hidden">
        <span>System details</span>
        <ChevronRight
          className="size-4 text-muted transition-transform group-open:rotate-90"
          aria-hidden="true"
        />
      </summary>
      <dl className="grid gap-3 border-t border-border px-4 py-3 text-sm text-muted sm:grid-cols-2 sm:px-5">
        <MetadataLine label="Request ID" value={approval.id} />
        <MetadataLine label="Job ID" value={approval.roof_job_id} />
        <MetadataLine label="Crew ID" value={approval.crew_profile_id} />
        <MetadataLine label="Assignment ID" value={approval.target.assignment_id} />
        <MetadataLine label="Record ID" value={approval.run_id} />
        {approval.hermes_run_id ? (
          <MetadataLine label="Save record ID" value={approval.hermes_run_id} />
        ) : null}
        <MetadataLine label="Start" value={approval.scheduled_start} />
        {approval.scheduled_end ? (
          <MetadataLine label="End" value={approval.scheduled_end} />
        ) : null}
        <MetadataLine label="Expires" value={approval.expires_at} />
        {display.actionLabel ? null : <MetadataLine label="Action" value={approval.action} />}
        {approval.error_code ? (
          <MetadataLine label="Recorded code" value={approval.error_code} />
        ) : null}
      </dl>
    </details>
  );
}

function MetadataLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="font-semibold text-foreground">{label}</dt>
      <dd className="mt-0.5 break-all">{value}</dd>
    </div>
  );
}

type ScheduleDisplay = {
  jobNumber: string;
  crewName: string;
  startLabel: string;
  endLabel: string | null;
  actionLabel: string | undefined;
};

function scheduleDisplay(
  approval: ProductionScheduleApprovalRequest,
  runway: ProductionRunwayResponse | undefined,
  locale: string,
  timeZone: string,
): ScheduleDisplay {
  const job = runway?.jobs.find((candidate) => candidate.id === approval.roof_job_id);
  const crew = runway?.crews.find((candidate) => candidate.id === approval.crew_profile_id);
  return {
    jobNumber: job?.job_number?.trim() || "This job",
    crewName: crew?.name?.trim() || "Selected crew",
    startLabel: formatScheduleTime(approval.scheduled_start, locale, timeZone) ?? "Start not found",
    endLabel: formatScheduleTime(approval.scheduled_end, locale, timeZone),
    actionLabel: ACTION_LABELS[approval.action],
  };
}

function formatScheduleTime(value: string | null, locale: string, timeZone: string): string | null {
  if (!value || Number.isNaN(Date.parse(value))) return null;
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return null;
  }
}

function messageFor(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return "The protected request was not confirmed. Reopen the recorded state before trying another decision.";
  }
  switch (error.code) {
    case "production_schedule_broker_unavailable":
      return "The schedule service is unavailable. No crew assignment was saved.";
    case "production_schedule_approval_expired":
      return "This review window expired before a decision. Prepare a current request from the job.";
    case "production_schedule_approval_version_conflict":
      return "This recorded request changed. Refresh before making another decision.";
    case "execution_uncertain":
      return "The result is uncertain. Do not retry. Reconcile the recorded outcome instead.";
    case "production_schedule_approval_already_decided":
      return "This request is no longer awaiting a decision. Refresh to inspect the recorded state.";
    default:
      return (
        error.message ||
        "The protected request was not confirmed. Refresh the recorded state before deciding again."
      );
  }
}
