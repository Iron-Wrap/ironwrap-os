import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Banknote, RefreshCw } from "lucide-react";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { RoleGuard } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { ErrorState, LoadingState } from "../components/ui/state-panel";
import { EmptyQueue, MoneyQueueRow, MoneyQueueSection } from "./money-badge";
import { loadAccountingSummary } from "./money-api";
import { ageLabel, reasonLabel } from "./money-contracts";
import { Notice } from "../service/service-notice";

/**
 * The Money Desk: the accounting role's landing page (IRO-52 slice S9).
 *
 * docs/ACCOUNTING-RECONCILIATION-CONTRACT.md section 8.2 fixes the shape - four queues, each row
 * carrying job, customer, kind, amount, state, age, and the single next step. The whole desk is one
 * request, because an office manager on a phone should not wait on five round trips to find out
 * what is waiting.
 *
 * Nothing here offers a destructive action, because there isn't one: a reversal is a compensating
 * effect and lives on the intent's own screen as "issue a credit memo", never as "delete".
 */
export function MoneyDeskPage() {
  return (
    <RoleGuard surface="accounting">
      <MoneyDeskContent />
    </RoleGuard>
  );
}

function MoneyDeskContent() {
  const session = useSession();
  const offline = isOfflineSession(session);
  const query = useQuery({
    queryKey: ["accounting-summary", session.tenant.id],
    queryFn: () => loadAccountingSummary(),
    retry: false,
  });

  if (!query.data && query.isPending) return <LoadingState label="Loading the money desk…" />;
  if (!query.data) {
    return (
      <ErrorState
        title="Money desk unavailable"
        message="Nothing was approved, sent, or changed. Reconnect and re-open the desk before deciding anything."
        onRetry={() => void query.refetch()}
      />
    );
  }

  const { summary, queues } = query.data;
  const health = summary.reconciliation_health;

  return (
    <section className="mx-auto max-w-4xl space-y-6 pb-4">
      <header className="border-b border-border pb-5 sm:pb-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-md bg-foreground text-background">
              <Banknote className="size-5 text-accent" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-extrabold uppercase tracking-[0.16em] text-muted">
                Accounting
              </p>
              <h1 className="mt-1 text-3xl font-black tracking-[-0.035em] text-balance sm:text-4xl">
                Money desk
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted sm:text-base">
                Every money movement waiting on a person, and what each one needs next. QuickBooks
                stays the posted truth; nothing here changes it without a decision.
              </p>
            </div>
          </div>
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
        </div>
      </header>

      {offline ? (
        <Notice tone="warning" title="Reconnect before deciding anything">
          Money decisions are never queued offline. This saved screen is read-only until IronWrap
          can reach the server.
        </Notice>
      ) : null}

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Needs approval" value={summary.queues.needs_approval.count} />
        <Tile label="Awaiting QuickBooks" value={summary.queues.awaiting_provider.count} />
        <Tile label="Mismatched" value={summary.queues.mismatched.count} tone="danger" />
        <Tile label="Exceptions" value={summary.queues.exceptions.count} tone="danger" />
      </dl>

      <MoneyQueueSection
        title="Needs approval"
        description="Check the amount against the approved paperwork before anything is sent."
        count={summary.queues.needs_approval.count}
      >
        {queues.needs_approval.length === 0 ? (
          <EmptyQueue message="Nothing is waiting on a decision." />
        ) : (
          <ul>
            {queues.needs_approval.map((intent) => (
              <MoneyQueueRow key={intent.intent_id} intent={intent} />
            ))}
          </ul>
        )}
      </MoneyQueueSection>

      <MoneyQueueSection
        title="Awaiting QuickBooks"
        description="Sent, and waiting for QuickBooks to confirm. We re-read these until it does."
        count={summary.queues.awaiting_provider.count}
      >
        {queues.awaiting_provider.length === 0 ? (
          <EmptyQueue message="Nothing is in flight." />
        ) : (
          <ul>
            {queues.awaiting_provider.map((intent) => (
              <MoneyQueueRow key={intent.intent_id} intent={intent} />
            ))}
          </ul>
        )}
      </MoneyQueueSection>

      <MoneyQueueSection
        title="Mismatched"
        description="QuickBooks does not agree with our figures. Open one to see the difference and pick a remedy."
        count={summary.queues.mismatched.count}
      >
        {queues.mismatched.length === 0 ? (
          <EmptyQueue message="Everything we have sent matches QuickBooks." />
        ) : (
          <ul>
            {queues.mismatched.map((intent) => (
              <MoneyQueueRow key={intent.intent_id} intent={intent} />
            ))}
          </ul>
        )}
      </MoneyQueueSection>

      <MoneyQueueSection
        title="Exceptions"
        description="Findings that need a person. Each one names the remedies QuickBooks actually supports."
        count={summary.queues.exceptions.count}
      >
        {queues.exceptions.length === 0 ? (
          <EmptyQueue message="The exception queue is empty." />
        ) : (
          <ul>
            {queues.exceptions.map((exception) => (
              <li key={exception.exception_id} className="border-b border-border last:border-b-0">
                <Link
                  to="/accounting/exceptions"
                  className="flex min-h-16 flex-col gap-1 px-4 py-4 hover:bg-surface-muted sm:px-6"
                >
                  <span className="font-bold tracking-[-0.01em]">
                    {reasonLabel(exception.reason_code)}
                  </span>
                  <span className="text-sm text-muted">
                    {exception.intent_id ?? exception.subject_ref} ·{" "}
                    {ageLabel(exception.age_seconds)} open
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </MoneyQueueSection>

      <section
        aria-label="Reconciliation health"
        className="border border-border bg-surface px-4 py-5 sm:px-6"
      >
        <h2 className="text-lg font-bold tracking-[-0.02em]">Reconciliation health</h2>
        <p className="mt-1 text-sm leading-6 text-muted">
          How much of what we believe has actually been checked against QuickBooks recently.
        </p>
        <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Tile label="Open exceptions" value={health.open_exceptions} />
          <Tile label="Not re-read recently" value={health.stale_observation_count} />
          <Tile label="Never read back" value={health.unobserved_intent_count} />
        </dl>
        {health.oldest_unreconciled_intent_id ? (
          // A block target, not an id wrapped in an inline link. Inline, this rendered 41 px tall
          // on a Pixel 5 - under the 44 px thumb floor the mobile acceptance suite enforces.
          <Link
            to="/accounting/intents/$intentId"
            params={{ intentId: health.oldest_unreconciled_intent_id }}
            className="mt-4 flex min-h-14 flex-col justify-center gap-0.5 border border-border px-4 py-3 hover:bg-surface-muted"
          >
            <span className="text-xs font-extrabold uppercase tracking-[0.12em] text-muted">
              Oldest unfinished money movement
            </span>
            <span className="break-all text-sm font-bold leading-6 underline underline-offset-4">
              {health.oldest_unreconciled_intent_id}
            </span>
            <span className="text-sm text-muted">
              {ageLabel(health.oldest_unreconciled_age_seconds ?? 0)} old
            </span>
          </Link>
        ) : (
          <p className="mt-4 text-sm leading-6 text-muted">
            Nothing is outstanding. Every money movement has reached a settled state.
          </p>
        )}
      </section>
    </section>
  );
}

function Tile({ label, value, tone }: { label: string; value: number; tone?: "danger" }) {
  return (
    <div className="border border-border bg-surface px-4 py-3">
      <dt className="text-xs font-extrabold uppercase tracking-[0.12em] text-muted">{label}</dt>
      <dd
        className={`mt-1 text-2xl font-black tabular-nums ${
          tone === "danger" && value > 0 ? "text-danger" : ""
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
