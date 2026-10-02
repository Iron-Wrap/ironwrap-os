import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Clock3,
  FileCheck2,
  RefreshCw,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { useRef, useState } from "react";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { RoleGuard } from "../components/role-guard";
import { PageHeader } from "../components/ui/page-header";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Notice } from "../components/ui/notice";
import { Select } from "../components/ui/select";
import { ErrorState } from "../components/ui/state-panel";
import { Textarea } from "../components/ui/textarea";
import { ApiError } from "../lib/api";
import {
  approveApproval,
  loadApprovals,
  loadApproval,
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

const APPROVAL_HISTORY_PREVIEW_LIMIT = 3;

export function ApprovalInboxPage({ reviewId }: { reviewId?: string }) {
  return (
    <RoleGuard surface="owner">
      <ApprovalInboxContent reviewId={reviewId} />
    </RoleGuard>
  );
}

function ApprovalInboxContent({ reviewId }: { reviewId?: string }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const offline = isOfflineSession(session);
  const queueKey = ["approvals", session.tenant.id, session.user.id] as const;
  const queryKey = reviewId ? [...queueKey, reviewId] : queueKey;
  const query = useQuery({
    queryKey,
    queryFn: () => (reviewId ? loadApproval(reviewId) : loadApprovals()),
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
  const [showAllApprovals, setShowAllApprovals] = useState(false);
  const [requiresFreshRead, setRequiresFreshRead] = useState(false);

  async function refreshCurrentRequest() {
    const result = await query.refetch();
    if (!result.error && result.data) setRequiresFreshRead(false);
  }

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
      setRequiresFreshRead(false);
      setRejectingId(undefined);
      setReason("");
      setReconcilingId(undefined);
      setReconciliationOutcome("inconclusive");
      setReconciliationEvidence("");
      setNotice(
        action.kind === "reconcile"
          ? "The result check was saved. No lead was changed again."
          : action.kind === "reject"
            ? "The request was turned down. No lead was changed."
            : result.approval.state === "executed"
              ? "The lead check and save record are ready."
              : "The saved state changed. Check it before you do more.",
      );
    },
    onError: (error) => {
      setActionError(messageFor(error));
      setNotice(undefined);
      setRequiresFreshRead(true);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["now", session.tenant.id, session.user.id] });
      void queryClient.invalidateQueries({ queryKey: queueKey, refetchType: "none" });
      void refreshCurrentRequest();
    },
  });

  if (!query.data && query.isPending) return <ApprovalInboxSkeleton />;
  if (!query.data && query.isError) {
    return (
      <ErrorState
        title="Reviews could not load"
        message="Nothing changed. Check your link, then load the saved list again."
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!query.data) return <ApprovalInboxSkeleton />;

  const model = query.data;
  const stale = requiresFreshRead || query.isError;
  const canChoose = !offline && !stale && !query.isFetching;
  const canApprove = canChoose && model.allowed_actions.includes("approval.approve");
  const canReject = canChoose && model.allowed_actions.includes("approval.reject");
  const canReconcile = canChoose && model.allowed_actions.includes("approval.reconcile");
  const locale = { locale: session.tenant.locale, timeZone: session.tenant.time_zone };
  const actingId = mutation.isPending ? mutation.variables?.approval.id : undefined;
  const history = model.approvals.filter(
    (approval) =>
      approval.state === "executed" || approval.state === "denied" || approval.state === "expired",
  );
  const previewHistoryIds = new Set(
    history.slice(0, APPROVAL_HISTORY_PREVIEW_LIMIT).map((approval) => approval.id),
  );
  const visibleApprovals = showAllApprovals
    ? model.approvals
    : model.approvals.filter(
        (approval) => !history.includes(approval) || previewHistoryIds.has(approval.id),
      );
  const remainingApprovals = history.length - APPROVAL_HISTORY_PREVIEW_LIMIT;

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
    <section className="mx-auto max-w-7xl space-y-6 pb-6">
      <PageHeader
        title={reviewId ? "Review lead note" : "Lead reviews"}
        back={
          <a
            className="inline-flex min-h-11 items-center hover:text-foreground"
            href="/now?show=decide"
          >
            Back to decisions
          </a>
        }
        meta="Check the lead note before saving it."
        actions={
          <Button
            type="button"
            variant="outline"
            size="compact"
            disabled={query.isFetching}
            busy={query.isFetching}
            onClick={() => void refreshCurrentRequest()}
          >
            <RefreshCw aria-hidden="true" />
            Load again
          </Button>
        }
      />

      {!reviewId ? (
        <Card className="overflow-hidden">
          <ApprovalSummary approvals={model.approvals} />
        </Card>
      ) : null}

      {offline ? (
        <Notice tone="warning" title="Go online before you choose">
          IronWrap will not save this choice while you are offline. The last saved state stays here.
        </Notice>
      ) : null}
      {stale ? (
        <Notice tone="warning" title="This may be an old list">
          Load the list again before you choose.
        </Notice>
      ) : null}
      {notice ? (
        <p className="sr-only" aria-live="polite">
          {notice}
        </p>
      ) : null}
      {actionError ? (
        <Notice tone="danger" title="Check the saved state">
          {actionError}
        </Notice>
      ) : null}

      {model.approvals.length === 0 ? (
        <Card className="p-6 text-center sm:p-8">
          <FileCheck2 className="mx-auto size-7 text-ok" aria-hidden="true" />
          <h2 className="mt-4 text-xl font-bold tracking-[-0.025em]">
            No lead reviews need a choice
          </h2>
          <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-muted">
            New lead notes will show here when they need an owner check.
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          <ol
            id="lead-review-requests"
            className="divide-y divide-border overflow-hidden border border-border bg-surface"
            aria-label="Lead review requests"
          >
            {visibleApprovals.map((approval) => (
              <li key={approval.id}>
                <ApprovalCard
                  approval={approval}
                  expanded={Boolean(reviewId)}
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
          {remainingApprovals > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="compact"
              aria-controls="lead-review-requests"
              aria-expanded={showAllApprovals}
              onClick={() => setShowAllApprovals((current) => !current)}
            >
              {showAllApprovals ? "Show fewer" : `Show ${remainingApprovals} more`}
            </Button>
          ) : null}
        </div>
      )}
    </section>
  );
}

function ApprovalSummary({ approvals }: { approvals: ApprovalRequest[] }) {
  const pending = approvals.filter((approval) => approval.state === "pending").length;
  const recording = approvals.filter((approval) => approval.state === "executing").length;
  const uncertain = approvals.filter((approval) => approval.state === "execution_uncertain").length;
  return (
    <dl className="grid sm:grid-cols-3" aria-label="Lead review list state">
      <SummaryMetric label="Needs review" value={pending} tone="text-warning" dot="bg-warning" />
      <SummaryMetric
        label="Being saved"
        value={recording}
        tone="text-info"
        dot="bg-info"
        bordered
      />
      <SummaryMetric
        label="Needs a check"
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
      className={`min-h-20 px-5 py-4 sm:min-h-24 ${bordered ? "border-t border-border sm:border-t-0 sm:border-l" : ""}`}
    >
      <dt className="flex items-center gap-2 text-sm font-semibold text-muted">
        <span className={`size-2 rounded-full ${dot}`} aria-hidden="true" />
        {label}
      </dt>
      <dd className={`mt-1 text-xl font-bold tracking-[-0.03em] sm:mt-2 sm:text-2xl ${tone}`}>
        {value}
      </dd>
    </div>
  );
}

function ApprovalCard({
  approval,
  expanded = false,
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
  expanded?: boolean;
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
  const reviewSummary = approval.preview?.patch.triage_summary ?? approval.request_text;
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
      <details className="group" open={expanded || undefined}>
        <summary
          className="flex min-h-20 cursor-pointer list-none items-start justify-between gap-4 px-5 py-4 sm:px-6 [&::-webkit-details-marker]:hidden"
          aria-label={`Review lead check: ${state.label}. ${reviewSummary}. Asked ${created}`}
        >
          <div className="flex min-w-0 gap-3">
            <span
              className={`grid size-10 shrink-0 place-items-center rounded-md ${state.iconSurface}`}
            >
              <StateIcon className={`size-5 ${state.iconTone}`} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <h2 id={titleId} className="text-lg font-bold tracking-[-0.025em] sm:text-xl">
                  Lead check
                </h2>
                <span
                  className={`inline-flex items-center gap-1.5 text-sm font-bold ${state.labelTone}`}
                >
                  <span className={`size-1.5 rounded-full ${state.dot}`} aria-hidden="true" />
                  {state.label}
                </span>
              </div>
              <p className="mt-1 line-clamp-2 text-sm leading-6 text-muted">{reviewSummary}</p>
              <p className="mt-1 text-xs font-semibold text-muted">Asked {created}</p>
            </div>
          </div>
          <ChevronRight
            className="mt-3 size-4 shrink-0 text-muted transition-transform group-open:rotate-90"
            aria-hidden="true"
          />
        </summary>
        <CardContent className="space-y-5 border-t border-border pt-5">
          <ScopeFence />
          {approval.preview ? <TriageDiff preview={approval.preview} /> : <PreviewUnavailable />}
          <ApprovalSystemDetails approval={approval} locale={locale} expiration={expiration} />
          <ApprovalStateNotice approval={approval} />

          {approval.state === "pending" && !approveVisible && !rejectVisible ? (
            <p className="border-t border-border pt-4 text-sm leading-6 text-muted">
              {offline
                ? "Go online before you choose. IronWrap will not save this choice on this device."
                : "Waiting for the right owner. You can read this request, but you cannot choose."}
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
                  Save lead check
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
                  Turn down
                </Button>
              ) : null}
            </div>
          ) : null}

          {approval.state === "pending" && rejecting ? (
            <section className="border-t border-border pt-5" aria-label="Turn down lead check">
              <label className="block text-sm font-bold" htmlFor={`reject-reason-${approval.id}`}>
                Why should we stop this lead check?
              </label>
              <Textarea
                id={`reject-reason-${approval.id}`}
                className="mt-3 min-h-28 focus-visible:border-danger focus-visible:outline-danger"
                value={rejectionReason}
                maxLength={1_000}
                placeholder="Say what must be fixed before someone asks again."
                onChange={(event) => onReasonChange(event.target.value)}
              />
              <p className="mt-2 text-sm text-muted">
                Turning it down does not contact the customer or change the lead.
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
                  Turn down lead check
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
                Check saved result
              </Button>
            </div>
          ) : null}

          {reconcileVisible && reconciling ? (
            <section className="border-t border-border pt-5" aria-label="Check saved result">
              <label
                className="block text-sm font-bold"
                htmlFor={`reconciliation-outcome-${approval.id}`}
              >
                What happened?
              </label>
              <Select
                id={`reconciliation-outcome-${approval.id}`}
                className="mt-3 min-h-14 px-4 font-semibold"
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
                <option value="inconclusive">Not sure</option>
                <option value="executed">Lead check was saved</option>
                <option value="not_executed">Lead check was not saved</option>
              </Select>
              <label
                className="mt-4 block text-sm font-bold"
                htmlFor={`reconciliation-evidence-${approval.id}`}
              >
                What did you check?
              </label>
              <Textarea
                id={`reconciliation-evidence-${approval.id}`}
                className="mt-3 min-h-28 focus-visible:border-warning focus-visible:outline-warning"
                value={reconciliationEvidence}
                maxLength={1_000}
                placeholder="Say what you checked and why no new lead change is needed."
                onChange={(event) => onReconciliationEvidenceChange(event.target.value)}
              />
              <p className="mt-2 text-sm text-muted">
                This saves your check only. It does not try the lead change again.
              </p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={acting}
                  onClick={onCancelReconcile}
                >
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
                  Save result check
                </Button>
              </div>
            </section>
          ) : null}

          {approval.state === "execution_uncertain" &&
          !approval.reconciliation &&
          !reconcileVisible ? (
            <p className="border-t border-border pt-4 text-sm leading-6 text-muted">
              Only the right owner can save this result check.
            </p>
          ) : null}
        </CardContent>
      </details>
    </Card>
  );
}

function ScopeFence() {
  return (
    <section
      className="rounded-lg border border-ok/25 bg-ok-soft/45 px-4 py-4 text-sm leading-6"
      aria-label="What stays out"
    >
      <p className="font-bold">What stays out</p>
      <p className="mt-1 text-muted">
        No customer message. Lead delivery stays the same. Quotes and money records do not change.
      </p>
    </section>
  );
}

function TriageDiff({ preview }: { preview: NonNullable<ApprovalRequest["preview"]> }) {
  return (
    <section aria-label="What will change">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-muted">What will change</h3>
        <span className="text-sm font-semibold text-muted">Check only · not saved yet</span>
      </div>
      <div className="grid overflow-hidden rounded-lg border border-border sm:grid-cols-2">
        <DiffColumn
          title="Now"
          tone="bg-surface-muted"
          rows={[
            ["Lead status", leadStatus(preview.before.triage_status)],
            ["Lead note", preview.before.triage_summary ?? "Not saved"],
            ["Checked by", preview.before.triaged_by ?? "Not saved"],
          ]}
        />
        <DiffColumn
          title="After"
          tone="bg-ok-soft/45"
          rows={[
            ["Lead status", leadStatus(preview.patch.triage_status)],
            ["Lead note", preview.patch.triage_summary],
            ["Checked by", preview.patch.triaged_by],
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
      className={`${tone} p-4 ${title === "After" ? "border-t border-border sm:border-t-0 sm:border-l" : ""}`}
    >
      <h4 className="font-bold">{title}</h4>
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
      className="border border-warning/35 bg-warning-soft px-4 py-3 text-sm leading-6"
      role="status"
    >
      <p className="font-bold">The change could not load</p>
      <p className="mt-1 text-muted">
        Do not choose yet. Load the request again so you can see the full change.
      </p>
    </section>
  );
}

function ApprovalSystemDetails({
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
    <details className="rounded-lg border border-border bg-surface-raised">
      <summary className="min-h-14 cursor-pointer px-4 py-4 font-bold">System details</summary>
      <dl className="grid gap-x-6 gap-y-4 border-t border-border px-4 py-4 text-sm leading-5 sm:grid-cols-2">
        <Metadata label="Request ID" value={approval.id} mono />
        <Metadata label="Lead ID" value={approval.target.lead_envelope_id} mono />
        <Metadata
          label="Asked by"
          value={approval.requested_by.frappe_user ?? approval.requested_by.user_id}
        />
        <Metadata label="Review ends" value={expiration} />
        <Metadata label="Request note" value={approval.request_text} />
        {approval.approved_by ? (
          <Metadata label="Choice by" value={approval.approved_by.frappe_user} />
        ) : null}
        {approvedAt ? <Metadata label="Choice saved" value={approvedAt} /> : null}
        {approval.hermes_run_id ? (
          <Metadata label="Save record" value={approval.hermes_run_id} mono />
        ) : null}
        {approval.rejection_reason ? (
          <Metadata label="Turn-down note" value={approval.rejection_reason} />
        ) : null}
        {approval.error_code ? (
          <Metadata label="Error code" value={approval.error_code} mono />
        ) : null}
      </dl>
    </details>
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
        className="rounded-lg border border-ok/25 bg-ok-soft px-4 py-4 text-sm leading-6"
        role="status"
      >
        <p className="font-bold">Lead check saved</p>
        <p className="mt-1 text-muted">
          The lead note and save record are ready. No customer message changed.
        </p>
      </section>
    );
  }
  if (approval.state === "execution_uncertain") {
    return (
      <section
        className="rounded-lg border border-warning/30 bg-warning-soft px-4 py-4 text-sm leading-6"
        role="alert"
      >
        <p className="font-bold">Do not try this request again</p>
        {approval.reconciliation ? (
          <>
            <p className="mt-1 text-muted">
              Result check saved: {resultLabel(approval.reconciliation.outcome)}.
            </p>
            <p className="mt-1 text-muted">{approval.reconciliation.evidence}</p>
          </>
        ) : (
          <p className="mt-1 text-muted">
            We could not tell if the lead check was saved. Check the save record before you do
            anything else.
          </p>
        )}
      </section>
    );
  }
  if (approval.state === "executing") {
    return (
      <section
        className="rounded-lg border border-info/30 bg-info-soft px-4 py-4 text-sm leading-6"
        role="status"
      >
        <p className="font-bold">Saving the lead check</p>
        <p className="mt-1 text-muted">
          Keep this request open until IronWrap shows a saved result.
        </p>
      </section>
    );
  }
  if (approval.state === "expired") {
    return (
      <section
        className="rounded-lg border border-warning/30 bg-warning-soft px-4 py-4 text-sm leading-6"
        role="status"
      >
        <p className="font-bold">Review ended</p>
        <p className="mt-1 text-muted">Ask for a new review before this lead note can be saved.</p>
      </section>
    );
  }
  if (approval.state === "failed" || approval.state === "audit_failed") {
    return (
      <section
        className="rounded-lg border border-danger/30 bg-danger-soft px-4 py-4 text-sm leading-6"
        role="status"
      >
        <p className="font-bold">Lead check was not saved</p>
        <p className="mt-1 text-muted">
          Open System details and check the saved error before you ask again.
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
      label: "Being saved",
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
      label: "Lead check saved",
      Icon: CheckCircle2,
      iconSurface: "bg-ok-soft",
      iconTone: "text-ok",
      labelTone: "text-ok",
      dot: "bg-ok",
    };
  if (approval.state === "execution_uncertain")
    return {
      label: "Check needed",
      Icon: AlertTriangle,
      iconSurface: "bg-warning-soft",
      iconTone: "text-warning",
      labelTone: "text-warning",
      dot: "bg-warning",
    };
  if (approval.state === "denied")
    return {
      label: "Turned down",
      Icon: XCircle,
      iconSurface: "bg-surface-muted",
      iconTone: "text-muted",
      labelTone: "text-muted",
      dot: "bg-muted",
    };
  if (approval.state === "expired")
    return {
      label: "Review ended",
      Icon: Clock3,
      iconSurface: "bg-surface-muted",
      iconTone: "text-muted",
      labelTone: "text-muted",
      dot: "bg-muted",
    };
  return {
    label: "Not saved",
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

function resultLabel(outcome: "executed" | "not_executed" | "inconclusive"): string {
  if (outcome === "executed") return "Lead check was saved";
  if (outcome === "not_executed") return "Lead check was not saved";
  return "Not sure";
}

function leadStatus(value: string | null | undefined): string {
  if (value === "Triaged") return "Checked";
  if (value === "Untriaged") return "Not checked";
  return value ? "Other" : "Not saved";
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "execution_uncertain") {
      return "We could not tell if the lead check was saved. Do not try again. Check the saved result.";
    }
    if (error.code === "recent_session_required")
      return "Sign in again as the owner before you choose.";
    if (error.code === "approval_version_conflict" || error.code === "approval_already_decided") {
      return "This request changed while you read it. Check the new saved state before you choose.";
    }
    if (error.code === "approval_expired")
      return "This review ended before you chose. Ask for a new review.";
    return "We could not save this choice. Load the saved list before you choose again.";
  }
  return "We could not save this choice. Load the saved list before you choose again.";
}

function ApprovalInboxSkeleton() {
  return (
    <section
      className="mx-auto max-w-7xl space-y-6"
      aria-busy="true"
      aria-label="Loading lead reviews"
    >
      <div className="h-40 rounded-lg border border-border bg-surface-muted/70" />
      <div className="grid overflow-hidden rounded-lg border border-border sm:grid-cols-3">
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className={`min-h-24 bg-surface-muted/60 ${index > 0 ? "border-t border-border sm:border-t-0 sm:border-l" : ""}`}
          />
        ))}
      </div>
      <div className="h-96 rounded-lg border border-border bg-surface-muted/50" />
    </section>
  );
}
