import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { useRef, useState } from "react";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { RoleGuard } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { ErrorState, LoadingState } from "../components/ui/state-panel";
import { ApiError } from "../lib/api";
import { Notice } from "../service/service-notice";
import { MoneyBadge } from "./money-badge";
import {
  approveAccountingIntent,
  compensateAccountingIntent,
  loadAccountingIntent,
  newAccountingActionKey,
  reconcileAccountingIntent,
  rejectAccountingIntent,
} from "./money-api";
import {
  accountingRejectionReasons,
  ageLabel,
  amountLabel,
  kindLabel,
  reasonLabel,
  remedyLabel,
  type AccountingCommandResponse,
  type AccountingIntentDetailResponse,
  type AccountingRejectionReason,
  type AccountingRemedy,
} from "./money-contracts";

type IntentAction =
  | { kind: "approve" }
  | { kind: "reject"; reasonCode: AccountingRejectionReason }
  | { kind: "reconcile" }
  | { kind: "compensate"; remedy: AccountingRemedy };

/**
 * One money movement, in full (IRO-52 slice S9).
 *
 * docs/ACCOUNTING-RECONCILIATION-CONTRACT.md section 8.2: bound facts with evidence citations, the
 * expected-vs-observed diff field by field, the attempt history, and only the actions this role is
 * allowed. The allowed set arrives on the envelope, so a button that is not offered is a button
 * the server would refuse - the screen never guesses at authority.
 *
 * Safe recovery is always available and is never destructive: re-read the provider, or authorize a
 * provider-supported reversal. There is no "delete".
 */
export function MoneyIntentPage() {
  return (
    <RoleGuard surface="accounting">
      <MoneyIntentContent />
    </RoleGuard>
  );
}

function MoneyIntentContent() {
  const session = useSession();
  const offline = isOfflineSession(session);
  const queryClient = useQueryClient();
  // `strict: false` is this repository's convention for a route param read outside the generated
  // route tree, and it is what keeps this page renderable in a unit test without a router.
  const { intentId } = useParams({ strict: false }) as { intentId?: string };
  const actionKeys = useRef(new Map<string, string>());
  const [rejectReason, setRejectReason] = useState<AccountingRejectionReason>("amount_disputed");
  const [actionError, setActionError] = useState<string>();
  const [outcome, setOutcome] = useState<AccountingCommandResponse>();

  const queryKey = ["accounting-intent", session.tenant.id, intentId ?? ""] as const;
  const query = useQuery({
    queryKey,
    queryFn: () => loadAccountingIntent(intentId ?? ""),
    enabled: Boolean(intentId),
    retry: false,
  });

  const mutation = useMutation({
    retry: false,
    mutationFn: async (action: IntentAction) => {
      const version = query.data?.intent.version;
      if (version === undefined) throw new Error("accounting_intent_read_required");
      // One key per (action, version) attempt, kept across retries so a double tap on a slow phone
      // replays the same command instead of issuing a second one.
      const name = `${action.kind}:${version}`;
      const key = actionKeys.current.get(name) ?? newAccountingActionKey(action.kind);
      actionKeys.current.set(name, key);

      if (!intentId) throw new Error("accounting_intent_read_required");
      if (action.kind === "approve") {
        return await approveAccountingIntent(session, intentId, version, key);
      }
      if (action.kind === "reject") {
        return await rejectAccountingIntent(session, intentId, version, action.reasonCode, key);
      }
      if (action.kind === "reconcile") {
        return await reconcileAccountingIntent(session, intentId, version, key);
      }
      return await compensateAccountingIntent(session, intentId, version, action.remedy, key);
    },
    onSuccess: async (response) => {
      setActionError(undefined);
      setOutcome(response);
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: (error) => {
      setOutcome(undefined);
      setActionError(messageFor(error));
    },
  });

  if (!query.data && query.isPending) return <LoadingState label="Loading this money movement…" />;
  if (!query.data) {
    return (
      <ErrorState
        title="This money movement is unavailable"
        message="Nothing was approved, sent, or changed. Reconnect and re-open it before deciding anything."
        onRetry={() => void query.refetch()}
        action={<BackToDesk />}
      />
    );
  }

  const detail = query.data;
  const intent = detail.intent;
  const allowed = detail.allowed_actions;
  const canApprove =
    allowed.includes("accounting.intent.approve") && intent.state === "pending_review";
  const canReject =
    allowed.includes("accounting.intent.reject") &&
    (intent.state === "pending_review" || intent.state === "blocked");
  const canReconcile =
    allowed.includes("accounting.intent.reconcile") &&
    [
      "submitted",
      "uncertain",
      "partially_settled",
      "reconciled",
      "mismatch",
      "reconciliation_required",
    ].includes(intent.state);
  const liveException = detail.exceptions.find((exception) => exception.status !== "resolved");
  const offeredRemedies = (liveException?.offered_remedies ?? []).filter(
    (remedy) => remedy === "credit_memo_issued" || remedy === "refund_issued",
  );
  const canCompensate =
    allowed.includes("accounting.intent.compensate") &&
    ["mismatch", "reconciliation_required"].includes(intent.state) &&
    offeredRemedies.length > 0;
  const busy = offline || mutation.isPending;

  return (
    <section className="mx-auto max-w-3xl space-y-6 pb-4">
      <BackToDesk />

      <header className="border-b border-border pb-5 sm:pb-6">
        <div className="flex flex-wrap items-center gap-2">
          <MoneyBadge badge={intent.badge} />
          <span className="text-xs font-extrabold uppercase tracking-[0.14em] text-muted">
            {ageLabel(intent.age_seconds)} old
          </span>
        </div>
        <h1 className="mt-2 text-3xl font-black tracking-[-0.035em] text-balance sm:text-4xl">
          {kindLabel(intent.kind)}
        </h1>
        <p className="mt-1 text-2xl font-black tabular-nums">
          {amountLabel(intent.total_amount, intent.currency)}
        </p>
        <p className="mt-2 text-sm leading-6 text-muted sm:text-base">
          {intent.customer_ref ? `${intent.customer_ref} · ` : ""}
          {intent.roof_job_id}
        </p>
        <p className="mt-3 border-l-4 border-accent bg-surface-muted/60 px-4 py-3 text-sm leading-6">
          {intent.next_step}
        </p>
      </header>

      {offline ? (
        <Notice tone="warning" title="Reconnect before deciding anything">
          Money decisions are never queued offline.
        </Notice>
      ) : null}
      {actionError ? (
        <Notice tone="danger" title="Nothing was changed">
          {actionError}
        </Notice>
      ) : null}
      {outcome ? (
        <Notice
          tone={outcome.replayed ? "info" : "success"}
          title={outcome.replayed ? "Already recorded" : "Recorded"}
        >
          {outcome.replayed
            ? "This exact decision was already recorded, so nothing happened a second time."
            : outcome.compensation_plan
              ? `A reversal of ${amountLabel(outcome.compensation_plan.magnitudeAmount, intent.currency)} is authorized as ${remedyLabel(outcome.compensation_plan.remedy)}. Nothing has been sent to QuickBooks yet.`
              : "The decision is recorded. QuickBooks is only ever changed by a confirmed side effect."}
        </Notice>
      ) : null}

      <section aria-label="What you can do" className="border border-border bg-surface">
        <div className="border-b border-border px-4 py-4 sm:px-6">
          <h2 className="text-lg font-bold tracking-[-0.02em]">What you can do</h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            Nothing here deletes anything. A reversal is a new entry in QuickBooks that undoes the
            first one, and it needs your authorization.
          </p>
        </div>
        <div className="flex flex-col gap-3 px-4 py-4 sm:px-6">
          {canApprove ? (
            <Button
              type="button"
              className="min-h-14 w-full"
              busy={mutation.isPending}
              disabled={busy}
              onClick={() => mutation.mutate({ kind: "approve" })}
            >
              Approve and send to QuickBooks
            </Button>
          ) : null}
          {canReject ? (
            <div className="flex flex-col gap-2">
              <label className="text-sm font-bold" htmlFor="money-reject-reason">
                Reason for not approving
              </label>
              <select
                id="money-reject-reason"
                className="min-h-14 w-full rounded-md border border-border bg-surface px-3 text-base"
                value={rejectReason}
                disabled={busy}
                onChange={(event) =>
                  setRejectReason(event.target.value as AccountingRejectionReason)
                }
              >
                {accountingRejectionReasons.map((reason) => (
                  <option key={reason} value={reason}>
                    {reason.replace(/_/gu, " ")}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                variant="outline"
                className="min-h-14 w-full"
                busy={mutation.isPending}
                disabled={busy}
                onClick={() => mutation.mutate({ kind: "reject", reasonCode: rejectReason })}
              >
                Do not approve
              </Button>
            </div>
          ) : null}
          {canReconcile ? (
            <Button
              type="button"
              variant="outline"
              className="min-h-14 w-full"
              busy={mutation.isPending}
              disabled={busy}
              onClick={() => mutation.mutate({ kind: "reconcile" })}
            >
              <RefreshCw aria-hidden="true" />
              Re-read QuickBooks
            </Button>
          ) : null}
          {canCompensate
            ? offeredRemedies.map((remedy) => (
                <Button
                  key={remedy}
                  type="button"
                  variant="outline"
                  className="min-h-14 w-full"
                  busy={mutation.isPending}
                  disabled={busy}
                  onClick={() => mutation.mutate({ kind: "compensate", remedy })}
                >
                  {remedyLabel(remedy)}
                </Button>
              ))
            : null}
          {!canApprove && !canReject && !canReconcile && !canCompensate ? (
            <p className="text-sm leading-6 text-muted">
              There is nothing for you to decide on this one right now.
            </p>
          ) : null}
        </div>
      </section>

      {liveException ? (
        <section aria-label="Open exception" className="border border-danger/35 bg-danger-soft">
          <div className="px-4 py-4 sm:px-6">
            <h2 className="text-lg font-bold tracking-[-0.02em]">
              {reasonLabel(liveException.reason_code)}
            </h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              Open for {ageLabel(liveException.age_seconds)}. QuickBooks supports the remedies
              listed above; nothing else is offered because nothing else exists.
            </p>
            <Link
              to="/accounting/exceptions"
              className="mt-3 inline-flex min-h-12 items-center font-bold underline underline-offset-4"
            >
              Open the exception queue
            </Link>
          </div>
        </section>
      ) : null}

      <ComparisonSection detail={detail} />

      <section aria-label="Bound facts and evidence" className="border border-border bg-surface">
        <div className="border-b border-border px-4 py-4 sm:px-6">
          <h2 className="text-lg font-bold tracking-[-0.02em]">Bound facts and evidence</h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            What these figures were read from, and the fingerprints that prove nothing was edited
            afterwards.
          </p>
        </div>
        <dl className="divide-y divide-border">
          <Row label="QuickBooks company">{detail.evidence.realm_id}</Row>
          <Row label="QuickBooks entity">
            {detail.evidence.provider_entity_id
              ? `${detail.evidence.provider_entity_type} ${detail.evidence.provider_entity_id}`
              : "Not created yet"}
          </Row>
          <Row label="Authority ceiling">
            {amountLabel(detail.evidence.authority_max_amount, intent.currency)}
          </Row>
          <Row label="Bound figures fingerprint">
            <code className="break-all text-xs">{detail.evidence.basis_sha256}</code>
          </Row>
          <Row label="Expected fingerprint">
            <code className="break-all text-xs">{detail.evidence.expected_sha256}</code>
          </Row>
          {detail.tax_bindings.map((binding) => (
            <Row key={binding.snapshot_id} label={`Tax rate (${binding.tax_code})`}>
              {binding.jurisdiction} · bound {binding.bound_at}
            </Row>
          ))}
        </dl>
      </section>

      <section aria-label="What has happened" className="border border-border bg-surface">
        <div className="border-b border-border px-4 py-4 sm:px-6">
          <h2 className="text-lg font-bold tracking-[-0.02em]">What has happened</h2>
        </div>
        <ol className="divide-y divide-border">
          {detail.events.map((event) => (
            <li key={event.event_seq} className="px-4 py-3 text-sm leading-6 sm:px-6">
              <span className="font-bold">{event.state_to}</span>
              <span className="text-muted">
                {" "}
                · {event.event_type} · {event.occurred_at}
              </span>
              {event.detail_code ? (
                <span className="block text-muted">{reasonLabel(event.detail_code)}</span>
              ) : null}
            </li>
          ))}
        </ol>
      </section>
    </section>
  );
}

function ComparisonSection({ detail }: { detail: AccountingIntentDetailResponse }) {
  const comparison = detail.comparison;
  return (
    <section
      aria-label="Our figures against QuickBooks"
      className="border border-border bg-surface"
    >
      <div className="border-b border-border px-4 py-4 sm:px-6">
        <h2 className="text-lg font-bold tracking-[-0.02em]">Our figures against QuickBooks</h2>
        <p className="mt-1 text-sm leading-6 text-muted">
          {comparison.awaiting_readback
            ? "Nothing has been read back from QuickBooks yet, so there is nothing to compare."
            : comparison.hashes_agree
              ? `QuickBooks agrees with everything we bound. Last read ${comparison.read_at}.`
              : `QuickBooks differs from what we expected. Last read ${comparison.read_at}.`}
        </p>
      </div>
      <dl className="divide-y divide-border">
        {comparison.fields.map((field) => (
          <div key={field.field} className="px-4 py-3 sm:px-6">
            <dt className="text-xs font-extrabold uppercase tracking-[0.12em] text-muted">
              {field.field.replace(/_/gu, " ")}
            </dt>
            <dd className="mt-1 grid gap-1 text-sm leading-6 sm:grid-cols-2">
              <span>
                <span className="text-muted">Ours: </span>
                {renderValue(field.expected)}
              </span>
              <span className={field.agrees ? "" : "font-bold text-danger"}>
                <span className="text-muted">QuickBooks: </span>
                {comparison.awaiting_readback ? "not read yet" : renderValue(field.observed)}
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-3 sm:px-6">
      <dt className="text-xs font-extrabold uppercase tracking-[0.12em] text-muted">{label}</dt>
      <dd className="mt-1 text-sm leading-6">{children}</dd>
    </div>
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

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/**
 * A refused decision in words.
 *
 * Every code below is one the bus really returns, and each maps to what the person in front of the
 * screen should do next - not to what went wrong inside the server.
 */
function messageFor(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return "The decision was not recorded. Nothing was sent to QuickBooks.";
  }
  const messages: Record<string, string> = {
    accounting_intent_command_version_invalid:
      "Someone else changed this while you were reading it. Refresh and look again before deciding.",
    accounting_intent_command_conflict:
      "That decision was already recorded with different details. Refresh before trying again.",
    accounting_intent_separation_of_duty:
      "The person who prepared these figures cannot also approve them. Ask a second approver.",
    accounting_compensation_owner_required:
      "A reversal this size is the owner's decision. Ask the owner to authorize it.",
    accounting_compensation_remedy_not_offered:
      "QuickBooks does not support that remedy for this finding. Pick one that is offered.",
    accounting_compensation_amount_exceeds_original:
      "A reversal cannot be larger than what was posted in the first place.",
    accounting_intent_compensation_blocked:
      "We cannot prove this entity is ours, so it cannot be reversed. Resolve the identity conflict first.",
    effect_policy_amount_ceiling_exceeded:
      "This is above the authorized limit. It needs a higher authority than yours.",
    csrf_failed: "Your session needs refreshing. Reload the page and try again.",
  };
  return (
    messages[error.code] ??
    "The decision was not recorded, and nothing was sent to QuickBooks. Refresh and try again."
  );
}
