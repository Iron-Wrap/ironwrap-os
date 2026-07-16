import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  Clock3,
  FileCheck2,
  RefreshCw,
  ShieldCheck,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { useRef, useState } from "react";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { RoleGuard } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { ErrorState } from "../components/ui/state-panel";
import { ApiError } from "../lib/api";
import {
  approveApproval,
  loadApprovals,
  newApprovalDecisionKey,
  reconcileApproval,
  rejectApproval,
} from "./approval-api";
import type { ApprovalListResponse, ApprovalRequest } from "./approval-contracts";
import { formatOwnerDate, type OwnerDateFormatOptions } from "./owner-now-utils";

type ApprovalAction =
  | { kind: "approve"; approval: ApprovalRequest }
  | { kind: "reject"; approval: ApprovalRequest; reason: string }
  | {
      kind: "reconcile";
      approval: ApprovalRequest;
      outcome: "executed" | "not_executed" | "inconclusive";
      evidence: string;
    };

export function ApprovalInboxPage() {
  return (
    <RoleGuard surface="owner">
      <ApprovalInboxContent />
    </RoleGuard>
  );
}

function ApprovalInboxContent() {
  const session = useSession();
  const queryClient = useQueryClient();
  const offline = isOfflineSession(session);
  const queryKey = ["approvals", session.tenant.id, session.user.id] as const;
  const query = useQuery({
    queryKey,
    queryFn: () => loadApprovals(),
    retry: false,
  });
  const keys = useRef(new Map<string, string>());
  const [rejectingId, setRejectingId] = useState<string>();
  const [reason, setReason] = useState("");
  const [reconcilingId, setReconcilingId] = useState<string>();
  const [reconciliationOutcome, setReconciliationOutcome] = useState<
    "executed" | "not_executed" | "inconclusive"
  >("inconclusive");
  const [reconciliationEvidence, setReconciliationEvidence] = useState("");
  const [actionError, setActionError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const mutation = useMutation({
    retry: false,
    mutationFn: async (action: ApprovalAction) => {
      if (action.kind === "reconcile") {
        return await reconcileApproval(
          session,
          action.approval.id,
          action.approval.version,
          action.outcome,
          action.evidence,
        );
      }
      const keyName = `${action.kind}:${action.approval.id}`;
      const idempotencyKey = keys.current.get(keyName) ?? newApprovalDecisionKey();
      keys.current.set(keyName, idempotencyKey);
      return action.kind === "approve"
        ? await approveApproval(
            session,
            action.approval.id,
            action.approval.version,
            idempotencyKey,
          )
        : await rejectApproval(
            session,
            action.approval.id,
            action.approval.version,
            action.reason,
            idempotencyKey,
          );
    },
    onSuccess: (result, action) => {
      queryClient.setQueryData<ApprovalListResponse>(queryKey, (current) =>
        updateApproval(current, result.approval),
      );
      setActionError(undefined);
      setRejectingId(undefined);
      setReason("");
      setReconcilingId(undefined);
      setReconciliationOutcome("inconclusive");
      setReconciliationEvidence("");
      setNotice(
        action.kind === "reconcile"
          ? "Reconciliation was recorded. No second write was issued."
          : action.kind === "reject"
            ? "The request was rejected. No broker write was started."
            : result.approval.state === "executed"
              ? "Triage recorded with its Hermes Run."
              : "The decision state changed. Review the recorded outcome.",
      );
    },
    onError: (error) => {
      setActionError(messageFor(error));
      setNotice(undefined);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  if (!query.data && query.isPending) return <ApprovalInboxSkeleton />;
  if (!query.data && query.isError) {
    return (
      <ErrorState
        title="Approval inbox unavailable"
        message="No approval was changed. Reconnect to inspect the current recorded state before deciding anything."
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!query.data) return <ApprovalInboxSkeleton />;

  const model = query.data;
  const canApprove = !offline && model.allowed_actions.includes("approval.approve");
  const canReject = !offline && model.allowed_actions.includes("approval.reject");
  const canReconcile = !offline && model.allowed_actions.includes("approval.reconcile");
  const locale = { locale: session.tenant.locale, timeZone: session.tenant.time_zone };
  const actingId = mutation.isPending ? mutation.variables?.approval.id : undefined;

  function approve(approval: ApprovalRequest) {
    if (!canApprove || mutation.isPending) return;
    setActionError(undefined);
    mutation.mutate({ kind: "approve", approval });
  }

  function reject(approval: ApprovalRequest) {
    const trimmed = reason.trim();
    if (!canReject || mutation.isPending || trimmed.length < 3) return;
    setActionError(undefined);
    mutation.mutate({ kind: "reject", approval, reason: trimmed });
  }

  function reconcile(approval: ApprovalRequest) {
    const evidence = reconciliationEvidence.trim();
    if (!canReconcile || mutation.isPending || evidence.length < 3) return;
    setActionError(undefined);
    mutation.mutate({ kind: "reconcile", approval, outcome: reconciliationOutcome, evidence });
  }

  return (
    <section className="mx-auto max-w-6xl space-y-6 pb-4">
      <header className="border-b border-border pb-5 sm:pb-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-md bg-foreground text-background">
              <ShieldCheck className="size-5 text-accent" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-extrabold uppercase tracking-[0.16em] text-muted">
                Human review
              </p>
              <h1 className="mt-1 text-3xl font-black tracking-[-0.035em] text-balance sm:text-4xl">
                Approvals
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted sm:text-base">
                Review an exact diff before one bounded write. This queue never sends a customer
                message, changes lead transport, or touches a quote or accounting record.
              </p>
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

      <ApprovalSummary approvals={model.approvals} />

      {offline ? (
        <section
          className="border-l-4 border-warning bg-warning-soft px-4 py-4 text-sm leading-6"
          role="status"
        >
          <p className="font-bold">Reconnect before deciding</p>
          <p className="mt-1 text-muted">
            Approval decisions are never queued offline or retried by this app. The last known
            review state remains visible.
          </p>
        </section>
      ) : null}
      {query.isError ? (
        <section
          className="border-l-4 border-warning bg-warning-soft px-4 py-4 text-sm leading-6"
          role="status"
        >
          <p className="font-bold">Showing the last recorded inbox read.</p>
          <p className="mt-1 text-muted">
            Refresh before deciding if a connection warning remains.
          </p>
        </section>
      ) : null}
      {notice ? (
        <p className="sr-only" aria-live="polite">
          {notice}
        </p>
      ) : null}
      {actionError ? (
        <section
          className="border-l-4 border-danger bg-danger-soft px-4 py-4 text-sm leading-6"
          role="alert"
        >
          <p className="font-bold">The decision was not confirmed</p>
          <p className="mt-1 text-muted">{actionError}</p>
        </section>
      ) : null}

      {model.approvals.length === 0 ? (
        <Card className="p-6 text-center sm:p-8">
          <FileCheck2 className="mx-auto size-7 text-ok" aria-hidden="true" />
          <h2 className="mt-4 text-xl font-bold tracking-[-0.025em]">
            No approval requests are recorded
          </h2>
          <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-muted">
            Nothing is waiting for a decision in the available approval ledger.
          </p>
        </Card>
      ) : (
        <ol className="space-y-5" aria-label="Approval requests">
          {model.approvals.map((approval) => (
            <li key={approval.id}>
              <ApprovalCard
                approval={approval}
                locale={locale}
                canApprove={canApprove}
                canReject={canReject}
                canReconcile={canReconcile}
                offline={offline}
                rejecting={rejectingId === approval.id}
                rejectionReason={reason}
                reconciling={reconcilingId === approval.id}
                reconciliationOutcome={reconciliationOutcome}
                reconciliationEvidence={reconciliationEvidence}
                acting={actingId === approval.id}
                onApprove={() => approve(approval)}
                onOpenReject={() => {
                  setActionError(undefined);
                  setRejectingId(approval.id);
                  setReason("");
                }}
                onCancelReject={() => {
                  setRejectingId(undefined);
                  setReason("");
                }}
                onReasonChange={setReason}
                onReject={() => reject(approval)}
                onOpenReconcile={() => {
                  setActionError(undefined);
                  setReconcilingId(approval.id);
                  setReconciliationOutcome("inconclusive");
                  setReconciliationEvidence("");
                }}
                onCancelReconcile={() => {
                  setReconcilingId(undefined);
                  setReconciliationEvidence("");
                }}
                onReconciliationOutcomeChange={setReconciliationOutcome}
                onReconciliationEvidenceChange={setReconciliationEvidence}
                onReconcile={() => reconcile(approval)}
              />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function ApprovalSummary({ approvals }: { approvals: ApprovalRequest[] }) {
  const pending = approvals.filter((approval) => approval.state === "pending").length;
  const recording = approvals.filter((approval) => approval.state === "executing").length;
  const uncertain = approvals.filter((approval) => approval.state === "execution_uncertain").length;
  return (
    <dl className="grid grid-cols-3 border-y border-border" aria-label="Approval queue state">
      <SummaryMetric label="Needs review" value={pending} tone="text-warning" dot="bg-warning" />
      <SummaryMetric label="Recording" value={recording} tone="text-info" dot="bg-info" bordered />
      <SummaryMetric
        label="Reconcile"
        value={uncertain}
        tone="text-danger"
        dot="bg-danger"
        bordered
      />
    </dl>
  );
}

function SummaryMetric({
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
      className={`min-h-20 px-3 py-3 sm:min-h-24 sm:px-5 sm:py-4 ${bordered ? "border-l border-border" : ""}`}
    >
      <dt className="flex items-center gap-2 text-sm font-semibold text-muted">
        <span className={`size-2 rounded-full ${dot}`} aria-hidden="true" />
        {label}
      </dt>
      <dd className={`mt-1 text-xl font-black tracking-[-0.03em] sm:mt-2 sm:text-2xl ${tone}`}>
        {value}
      </dd>
    </div>
  );
}

function ApprovalCard({
  approval,
  locale,
  canApprove,
  canReject,
  canReconcile,
  offline,
  rejecting,
  rejectionReason,
  reconciling,
  reconciliationOutcome,
  reconciliationEvidence,
  acting,
  onApprove,
  onOpenReject,
  onCancelReject,
  onReasonChange,
  onReject,
  onOpenReconcile,
  onCancelReconcile,
  onReconciliationOutcomeChange,
  onReconciliationEvidenceChange,
  onReconcile,
}: {
  approval: ApprovalRequest;
  locale: OwnerDateFormatOptions;
  canApprove: boolean;
  canReject: boolean;
  canReconcile: boolean;
  offline: boolean;
  rejecting: boolean;
  rejectionReason: string;
  reconciling: boolean;
  reconciliationOutcome: "executed" | "not_executed" | "inconclusive";
  reconciliationEvidence: string;
  acting: boolean;
  onApprove: () => void;
  onOpenReject: () => void;
  onCancelReject: () => void;
  onReasonChange: (value: string) => void;
  onReject: () => void;
  onOpenReconcile: () => void;
  onCancelReconcile: () => void;
  onReconciliationOutcomeChange: (value: "executed" | "not_executed" | "inconclusive") => void;
  onReconciliationEvidenceChange: (value: string) => void;
  onReconcile: () => void;
}) {
  const state = approvalState(approval);
  const StateIcon = state.Icon;
  const titleId = `approval-${approval.id.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  const expiration = formatOwnerDate(approval.expires_at, locale);
  const created = formatOwnerDate(approval.created_at, locale);
  const approveVisible = approval.state === "pending" && canApprove;
  const rejectVisible = approval.state === "pending" && canReject;
  const reconcileVisible =
    approval.state === "execution_uncertain" && !approval.reconciliation && canReconcile;

  return (
    <Card
      aria-labelledby={titleId}
      className={
        approval.state === "execution_uncertain" ? "border-warning bg-warning-soft/35" : undefined
      }
    >
      <CardHeader className="border-b border-border">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 gap-3">
            <span
              className={`grid size-10 shrink-0 place-items-center rounded-md ${state.iconSurface}`}
            >
              <StateIcon className={`size-5 ${state.iconTone}`} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <CardTitle id={titleId}>Local lead triage</CardTitle>
                <span
                  className={`inline-flex items-center gap-1.5 text-sm font-bold ${state.labelTone}`}
                >
                  <span className={`size-1.5 rounded-full ${state.dot}`} aria-hidden="true" />
                  {state.label}
                </span>
              </div>
              <CardDescription className="mt-1">
                {approval.target.doctype} · {approval.target.lead_envelope_id}
              </CardDescription>
            </div>
          </div>
          <p className="text-sm font-semibold text-muted">Recorded {created}</p>
        </div>
      </CardHeader>
      <CardContent className="space-y-5 pt-5">
        <ScopeFence />
        {approval.preview ? <TriageDiff preview={approval.preview} /> : <PreviewUnavailable />}
        <p className="text-sm leading-6 text-muted">{approval.request_text}</p>
        <ApprovalMetadata approval={approval} locale={locale} expiration={expiration} />
        <ApprovalStateNotice approval={approval} />

        {approval.state === "pending" && !approveVisible && !rejectVisible ? (
          <p className="border-t border-border pt-4 text-sm leading-6 text-muted">
            {offline
              ? "Reconnect before deciding. This decision is not queued on this device."
              : "Waiting for the server-designated approver. This view cannot grant decision authority."}
          </p>
        ) : null}

        {approval.state === "pending" && !rejecting ? (
          <div className="grid gap-3 border-t border-border pt-5 sm:grid-cols-[minmax(0,1fr)_auto]">
            {approveVisible ? (
              <Button
                type="button"
                variant="accent"
                size="field"
                fullWidth
                busy={acting}
                disabled={acting || offline}
                onClick={onApprove}
              >
                <CheckCircle2 aria-hidden="true" />
                Approve local triage
              </Button>
            ) : null}
            {rejectVisible ? (
              <Button
                type="button"
                variant="outline"
                size={approveVisible ? "field" : "default"}
                fullWidth={!approveVisible}
                disabled={acting || offline}
                onClick={onOpenReject}
              >
                <XCircle aria-hidden="true" />
                Reject
              </Button>
            ) : null}
          </div>
        ) : null}

        {approval.state === "pending" && rejecting ? (
          <section className="border-t border-border pt-5" aria-label="Reject local triage">
            <label
              className="block text-sm font-extrabold"
              htmlFor={`reject-reason-${approval.id}`}
            >
              Why should this local triage request be rejected?
            </label>
            <textarea
              id={`reject-reason-${approval.id}`}
              className="mt-3 min-h-28 w-full rounded-lg border bg-surface-raised p-4 text-base shadow-inner shadow-black/3 focus-visible:border-danger focus-visible:outline-danger"
              value={rejectionReason}
              maxLength={1_000}
              placeholder="Record the reason for the durable rejection."
              onChange={(event) => onReasonChange(event.target.value)}
            />
            <p className="mt-2 text-sm text-muted">
              Rejection is durable and does not contact the customer or invoke the broker.
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <Button type="button" variant="outline" disabled={acting} onClick={onCancelReject}>
                Cancel
              </Button>
              <Button
                type="button"
                variant="danger"
                busy={acting}
                disabled={acting || rejectionReason.trim().length < 3}
                onClick={onReject}
              >
                <XCircle aria-hidden="true" />
                Reject local triage
              </Button>
            </div>
          </section>
        ) : null}

        {reconcileVisible && !reconciling ? (
          <div className="border-t border-border pt-5">
            <Button
              type="button"
              variant="outline"
              size="field"
              fullWidth
              disabled={acting || offline}
              onClick={onOpenReconcile}
            >
              <FileCheck2 aria-hidden="true" />
              Record reconciliation
            </Button>
          </div>
        ) : null}

        {reconcileVisible && reconciling ? (
          <section className="border-t border-border pt-5" aria-label="Record reconciliation">
            <label
              className="block text-sm font-extrabold"
              htmlFor={`reconciliation-outcome-${approval.id}`}
            >
              What did the recorded Hermes Run prove?
            </label>
            <select
              id={`reconciliation-outcome-${approval.id}`}
              className="mt-3 min-h-14 w-full rounded-lg border bg-surface-raised px-4 text-base font-semibold"
              value={reconciliationOutcome}
              onChange={(event) => {
                const outcome = event.target.value;
                if (
                  outcome === "executed" ||
                  outcome === "not_executed" ||
                  outcome === "inconclusive"
                ) {
                  onReconciliationOutcomeChange(outcome);
                }
              }}
            >
              <option value="inconclusive">Inconclusive — run cannot yet be proven</option>
              <option value="executed">
                Executed — recorded run proves the local triage write
              </option>
              <option value="not_executed">
                Not executed — recorded run proves no local triage write
              </option>
            </select>
            <label
              className="mt-4 block text-sm font-extrabold"
              htmlFor={`reconciliation-evidence-${approval.id}`}
            >
              Reconciliation evidence
            </label>
            <textarea
              id={`reconciliation-evidence-${approval.id}`}
              className="mt-3 min-h-28 w-full rounded-lg border bg-surface-raised p-4 text-base shadow-inner shadow-black/3 focus-visible:border-warning focus-visible:outline-warning"
              value={reconciliationEvidence}
              maxLength={1_000}
              placeholder="State the Hermes Run or audit evidence you compared."
              onChange={(event) => onReconciliationEvidenceChange(event.target.value)}
            />
            <p className="mt-2 text-sm text-muted">
              This records audit evidence only. It does not reopen or retry the protected write.
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <Button type="button" variant="outline" disabled={acting} onClick={onCancelReconcile}>
                Cancel
              </Button>
              <Button
                type="button"
                variant="accent"
                busy={acting}
                disabled={acting || reconciliationEvidence.trim().length < 3}
                onClick={onReconcile}
              >
                <FileCheck2 aria-hidden="true" />
                Record reconciliation
              </Button>
            </div>
          </section>
        ) : null}

        {approval.state === "execution_uncertain" &&
        !approval.reconciliation &&
        !reconcileVisible ? (
          <p className="border-t border-border pt-4 text-sm leading-6 text-muted">
            Only the server-designated owner can record reconciliation evidence for this request.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ScopeFence() {
  return (
    <section
      className="border-l-4 border-info bg-info-soft px-4 py-3 text-sm leading-6"
      aria-label="Approval scope"
    >
      <p className="font-bold">Bounded scope</p>
      <p className="mt-1 text-muted">
        No customer message. Transport unchanged. No quote or accounting change.
      </p>
    </section>
  );
}

function TriageDiff({ preview }: { preview: NonNullable<ApprovalRequest["preview"]> }) {
  return (
    <section aria-label="Exact proposed change">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-extrabold uppercase tracking-[0.14em] text-muted">
          Exact proposed change
        </h3>
        <span className="text-sm font-semibold text-muted">Preview only · no write yet</span>
      </div>
      <div className="grid overflow-hidden rounded-lg border border-border sm:grid-cols-2">
        <DiffColumn
          title="Before"
          tone="bg-surface-muted"
          rows={[
            ["Triage status", preview.before.triage_status ?? "Not recorded"],
            ["Triage summary", preview.before.triage_summary ?? "Not recorded"],
            ["Triaged by", preview.before.triaged_by ?? "Not recorded"],
          ]}
        />
        <DiffColumn
          title="Proposed"
          tone="bg-ok-soft/45"
          rows={[
            ["Triage status", preview.patch.triage_status],
            ["Triage summary", preview.patch.triage_summary],
            ["Triaged by", preview.patch.triaged_by],
          ]}
        />
      </div>
    </section>
  );
}

function DiffColumn({
  title,
  tone,
  rows,
}: {
  title: string;
  tone: string;
  rows: Array<[string, string]>;
}) {
  return (
    <section
      className={`${tone} p-4 ${title === "Proposed" ? "border-t border-border sm:border-t-0 sm:border-l" : ""}`}
    >
      <h4 className="font-extrabold">{title}</h4>
      <dl className="mt-3 space-y-3 text-sm leading-6">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt className="font-semibold text-muted">{label}</dt>
            <dd className="mt-0.5 text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function PreviewUnavailable() {
  return (
    <section
      className="border-l-4 border-warning bg-warning-soft px-4 py-3 text-sm leading-6"
      role="status"
    >
      <p className="font-bold">Preview is unavailable</p>
      <p className="mt-1 text-muted">
        This request cannot be approved from this view until its exact preview is present.
      </p>
    </section>
  );
}

function ApprovalMetadata({
  approval,
  locale,
  expiration,
}: {
  approval: ApprovalRequest;
  locale: OwnerDateFormatOptions;
  expiration: string;
}) {
  const approvedAt = approval.approved_by
    ? formatOwnerDate(approval.approved_by.approved_at, locale)
    : null;
  return (
    <dl className="grid gap-x-6 gap-y-3 border-t border-border pt-4 text-sm leading-5 sm:grid-cols-2">
      <Metadata
        label="Requested by"
        value={approval.requested_by.frappe_user ?? approval.requested_by.user_id}
      />
      <Metadata label="Preview expires" value={expiration} />
      {approval.approved_by ? (
        <Metadata label="Decision by" value={approval.approved_by.frappe_user} />
      ) : null}
      {approvedAt ? <Metadata label="Decision recorded" value={approvedAt} /> : null}
      {approval.hermes_run_id ? (
        <Metadata label="Hermes Run" value={approval.hermes_run_id} mono />
      ) : null}
      {approval.rejection_reason ? (
        <Metadata label="Rejection reason" value={approval.rejection_reason} />
      ) : null}
    </dl>
  );
}

function Metadata({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="font-semibold text-muted">{label}</dt>
      <dd className={`mt-1 text-foreground ${mono ? "break-all font-mono text-xs" : ""}`}>
        {value}
      </dd>
    </div>
  );
}

function ApprovalStateNotice({ approval }: { approval: ApprovalRequest }) {
  if (
    approval.state === "executed" &&
    approval.outcome?.updated &&
    approval.outcome.audit_finalized
  ) {
    return (
      <section
        className="border-l-4 border-ok bg-ok-soft px-4 py-3 text-sm leading-6"
        role="status"
      >
        <p className="font-bold">Triage recorded</p>
        <p className="mt-1 text-muted">
          The protected write and Hermes Run are recorded. No customer communication was changed.
        </p>
      </section>
    );
  }
  if (approval.state === "execution_uncertain") {
    return (
      <section
        className="border-l-4 border-warning bg-warning-soft px-4 py-3 text-sm leading-6"
        role="alert"
      >
        <p className="font-bold">Do not retry this request</p>
        {approval.reconciliation ? (
          <>
            <p className="mt-1 text-muted">
              Reconciliation recorded: {approval.reconciliation.outcome}.
            </p>
            <p className="mt-1 text-muted">{approval.reconciliation.evidence}</p>
          </>
        ) : (
          <p className="mt-1 text-muted">
            The broker result could not be proven. Check the recorded Hermes Run and reconcile the
            immutable request; a second write is not issued automatically.
          </p>
        )}
      </section>
    );
  }
  if (approval.state === "executing") {
    return (
      <section
        className="border-l-4 border-info bg-info-soft px-4 py-3 text-sm leading-6"
        role="status"
      >
        <p className="font-bold">Decision is being recorded</p>
        <p className="mt-1 text-muted">
          Keep this request open until the ledger returns a terminal outcome.
        </p>
      </section>
    );
  }
  if (approval.state === "expired") {
    return (
      <section
        className="border-l-4 border-warning bg-warning-soft px-4 py-3 text-sm leading-6"
        role="status"
      >
        <p className="font-bold">Preview expired</p>
        <p className="mt-1 text-muted">
          A new preview is required before a local triage write can be approved.
        </p>
      </section>
    );
  }
  if (approval.state === "failed" || approval.state === "audit_failed") {
    return (
      <section
        className="border-l-4 border-danger bg-danger-soft px-4 py-3 text-sm leading-6"
        role="status"
      >
        <p className="font-bold">No completed lead triage was proven</p>
        <p className="mt-1 text-muted">
          Review the recorded error and Hermes Run before preparing a new request.
        </p>
      </section>
    );
  }
  return null;
}

function approvalState(approval: ApprovalRequest): {
  label: string;
  Icon: LucideIcon;
  iconSurface: string;
  iconTone: string;
  labelTone: string;
  dot: string;
} {
  if (approval.state === "pending")
    return {
      label: "Needs review",
      Icon: CircleAlert,
      iconSurface: "bg-warning-soft",
      iconTone: "text-warning",
      labelTone: "text-warning",
      dot: "bg-warning",
    };
  if (approval.state === "executing")
    return {
      label: "Recording",
      Icon: Clock3,
      iconSurface: "bg-info-soft",
      iconTone: "text-info",
      labelTone: "text-info",
      dot: "bg-info",
    };
  if (
    approval.state === "executed" &&
    approval.outcome?.updated &&
    approval.outcome.audit_finalized
  )
    return {
      label: "Triage recorded",
      Icon: CheckCircle2,
      iconSurface: "bg-ok-soft",
      iconTone: "text-ok",
      labelTone: "text-ok",
      dot: "bg-ok",
    };
  if (approval.state === "execution_uncertain")
    return {
      label: "Needs reconciliation",
      Icon: AlertTriangle,
      iconSurface: "bg-warning-soft",
      iconTone: "text-warning",
      labelTone: "text-warning",
      dot: "bg-warning",
    };
  if (approval.state === "denied")
    return {
      label: "Rejected",
      Icon: XCircle,
      iconSurface: "bg-surface-muted",
      iconTone: "text-muted",
      labelTone: "text-muted",
      dot: "bg-muted",
    };
  if (approval.state === "expired")
    return {
      label: "Expired",
      Icon: Clock3,
      iconSurface: "bg-surface-muted",
      iconTone: "text-muted",
      labelTone: "text-muted",
      dot: "bg-muted",
    };
  return {
    label: "Not completed",
    Icon: AlertTriangle,
    iconSurface: "bg-danger-soft",
    iconTone: "text-danger",
    labelTone: "text-danger",
    dot: "bg-danger",
  };
}

function updateApproval(
  current: ApprovalListResponse | undefined,
  next: ApprovalRequest,
): ApprovalListResponse | undefined {
  if (!current) return current;
  return {
    ...current,
    approvals: current.approvals.map((approval) => (approval.id === next.id ? next : approval)),
  };
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "execution_uncertain") {
      return "The broker result could not be proven. The request is now reconciliation work and will not be retried automatically.";
    }
    if (error.code === "recent_session_required")
      return "Start a fresh owner session before deciding this request.";
    if (error.code === "approval_version_conflict" || error.code === "approval_already_decided") {
      return "This request changed while you were reviewing it. The inbox has been refreshed.";
    }
    if (error.code === "approval_expired")
      return "The preview expired before the decision. Prepare a fresh request.";
    return (
      error.message ||
      "The decision was not confirmed. Refresh the recorded state before trying again."
    );
  }
  return "The decision was not confirmed. Refresh the recorded state before trying again.";
}

function ApprovalInboxSkeleton() {
  return (
    <section
      className="mx-auto max-w-6xl space-y-6"
      aria-busy="true"
      aria-label="Loading approval inbox"
    >
      <div className="h-32 border-b border-border bg-surface-muted/70" />
      <div className="grid border-y border-border sm:grid-cols-3">
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className={`min-h-24 bg-surface-muted/60 ${index > 0 ? "border-t border-border sm:border-t-0 sm:border-l" : ""}`}
          />
        ))}
      </div>
      <div className="h-96 rounded-xl border bg-surface-muted/50" />
    </section>
  );
}
