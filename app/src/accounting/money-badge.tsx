import { Link } from "@tanstack/react-router";

import { Status, type StatusKind } from "../components/ui/status";
import {
  ageLabel,
  amountLabel,
  badgePresentation,
  kindLabel,
  type AccountingBadge,
  type AccountingIntentRow,
} from "./money-contracts";

// Shared money-desk presentation (IRO-52 slice S9).
//
// Mobile-first is a gating product rule, not a preference, so the queue row below is built for a
// phone first and widened for a desk second:
//
//  * It is a stacked block, never a table. A table of eight columns on a 360 px viewport either
//    scrolls sideways or truncates, and the product rule forbids both.
//  * The whole row is one link with a 64 px minimum height, so it is a thumb target rather than a
//    line of text with a small hyperlink in it.
//  * The badge and the amount wrap onto their own line rather than being pushed off the edge.

// Each money state keeps its glyph shape as well as its colour: approval and a QuickBooks
// difference are "someone must act", an item QuickBooks holds is "confirmed", and one that is
// with QuickBooks or has been compensated is "pending" on someone else.
const badgeKind: Record<AccountingBadge, StatusKind> = {
  pending: "attention",
  in_flight: "pending",
  uncertain: "attention",
  mismatched: "stopped",
  compensated: "pending",
  reconciled: "confirmed",
  rejected: "retired",
  failed: "stopped",
};

export function MoneyBadge({ badge }: { badge: AccountingIntentRow["badge"] }) {
  return (
    <Status kind={badgeKind[badge]} className="shrink-0">
      {badgePresentation[badge].label}
    </Status>
  );
}

export function MoneyQueueRow({ intent }: { intent: AccountingIntentRow }) {
  return (
    <li className="border-b border-border last:border-b-0">
      <Link
        to="/accounting/intents/$intentId"
        params={{ intentId: intent.intent_id }}
        className="flex min-h-16 flex-col gap-1.5 px-4 py-4 hover:bg-surface-muted sm:px-6"
      >
        <span className="flex flex-wrap items-center gap-2">
          <MoneyBadge badge={intent.badge} />
          <span className="font-bold tracking-[-0.01em]">{kindLabel(intent.kind)}</span>
          <span className="ml-auto font-bold tabular-nums">
            {amountLabel(intent.total_amount, intent.currency)}
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
          <span className="truncate font-semibold">
            {intent.customer_ref ?? intent.roof_job_id}
          </span>
          <span aria-hidden="true">·</span>
          <span>{intent.roof_job_id}</span>
          <span aria-hidden="true">·</span>
          <span>{ageLabel(intent.age_seconds)} old</span>
        </span>
        {/* The single next step, in words. Section 8.2: never a reason code. */}
        <span className="text-sm leading-6 text-foreground">{intent.next_step}</span>
      </Link>
    </li>
  );
}

export function MoneyQueueSection({
  title,
  description,
  count,
  children,
}: {
  title: string;
  description: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={title} className="border border-border bg-surface">
      <div className="border-b border-border px-4 py-4 sm:px-6">
        <div className="flex items-baseline gap-2">
          <h2 className="text-lg font-bold tracking-[-0.02em]">{title}</h2>
          <span className="text-sm font-bold tabular-nums text-muted">{count}</span>
        </div>
        <p className="mt-1 text-sm leading-6 text-muted">{description}</p>
      </div>
      {children}
    </section>
  );
}

export function EmptyQueue({ message }: { message: string }) {
  return <p className="px-4 py-5 text-sm leading-6 text-muted sm:px-6">{message}</p>;
}
