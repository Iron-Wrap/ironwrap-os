import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Banknote, RefreshCw } from "lucide-react";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { RoleGuard } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { Notice } from "../components/ui/notice";
import { ErrorState, LoadingState } from "../components/ui/state-panel";
import { EmptyQueue, MoneyQueueRow, MoneyQueueSection } from "./money-badge";
import { loadAccountingSummary } from "./money-api";
import { ageLabel, reasonLabel } from "./money-contracts";

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
              <h1 className="text-3xl font-black tracking-[-0.035em] text-balance sm:text-4xl">
                Money desk
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted sm:text-base">
                See what needs a check, what QuickBooks is doing, and what to do next. Nothing moves
                without a person.
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
        <Notice tone="warning" title="Reconnect before you decide">
          This saved screen is read-only. IronWrap must reach the server before you can make a
          choice.
        </Notice>
      ) : null}

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Needs approval" value={summary.queues.needs_approval.count} />
        <Tile label="Waiting for QuickBooks" value={summary.queues.awaiting_provider.count} />
        <Tile label="Does not match" value={summary.queues.mismatched.count} tone="danger" />
        <Tile label="Money issues" value={summary.queues.exceptions.count} tone="danger" />
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
        title="Waiting for QuickBooks"
        description="These were sent. IronWrap will keep checking until QuickBooks answers."
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
        title="Does not match"
        description="QuickBooks has different numbers. Open an item to see what changed."
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
        title="Money issues"
        description="These need a person. Open an issue to see the safe choices."
        count={summary.queues.exceptions.count}
      >
        {queues.exceptions.length === 0 ? (
          <EmptyQueue message="There are no open money issues." />
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
                    Open for {ageLabel(exception.age_seconds)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </MoneyQueueSection>

      <section
        aria-label="QuickBooks checks"
        className="border border-border bg-surface px-4 py-5 sm:px-6"
      >
        <h2 className="text-lg font-bold tracking-[-0.02em]">QuickBooks checks</h2>
        <p className="mt-1 text-sm leading-6 text-muted">
          See what still needs a fresh check against QuickBooks.
        </p>
        <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Tile label="Open issues" value={health.open_exceptions} />
          <Tile label="Not checked lately" value={health.stale_observation_count} />
          <Tile label="Never checked" value={health.unobserved_intent_count} />
        </dl>
        {health.oldest_unreconciled_intent_id ? (
          // A block target, not an id wrapped in an inline link. Inline, this rendered 41 px tall
          // on a Pixel 5 - under the 44 px thumb floor the mobile acceptance suite enforces.
          <Link
            to="/accounting/intents/$intentId"
            params={{ intentId: health.oldest_unreconciled_intent_id }}
            className="mt-4 flex min-h-14 flex-col justify-center gap-0.5 border border-border px-4 py-3 hover:bg-surface-muted"
          >
            <span className="text-xs font-extrabold text-muted">Oldest unfinished item</span>
            <span className="text-sm font-bold leading-6 underline underline-offset-4">
              Open item
            </span>
            <span className="text-sm text-muted">
              {ageLabel(health.oldest_unreconciled_age_seconds ?? 0)} old
            </span>
          </Link>
        ) : (
          <p className="mt-4 text-sm leading-6 text-muted">
            Everything is done. No money item is waiting for a check.
          </p>
        )}
      </section>
    </section>
  );
}

function Tile({ label, value, tone }: { label: string; value: number; tone?: "danger" }) {
  return (
    <div className="border border-border bg-surface px-4 py-3">
      <dt className="text-xs font-extrabold text-muted">{label}</dt>
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
