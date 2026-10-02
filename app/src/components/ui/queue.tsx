import type { ReactNode } from "react";

import { cn } from "../../lib/cn";

/** Layout A: a prioritized, actionable list. Rows before tiles. */
export function Queue({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <ul
      role="list"
      aria-label={label}
      className={cn("grid overflow-hidden rounded-lg border border-border bg-surface", className)}
    >
      {children}
    </ul>
  );
}

/**
 * One queue row: what it is (reference and title), the next step in words, status and owner,
 * and one action. On a phone the next step and meta wrap under the title and the action stays
 * top right. A row whose only action is a link is clickable as a whole.
 */
export function QueueRow({
  title,
  reference,
  sub,
  next,
  meta,
  action,
  current,
  changed,
}: {
  title: ReactNode;
  reference?: ReactNode;
  sub?: ReactNode;
  next?: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
  current?: boolean;
  changed?: boolean;
}) {
  return (
    <li
      aria-current={current || undefined}
      data-changed={changed || undefined}
      className={cn(
        "queue-row relative grid min-h-[4.25rem] grid-cols-[minmax(0,1fr)_auto] items-start gap-x-6 gap-y-1.5 border-t border-border-soft bg-surface px-4 py-3.5 transition-colors duration-[var(--motion-standard)] first:border-t-0 hover:bg-surface-hover",
        "lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1.4fr)_minmax(8.75rem,0.75fr)_auto] lg:items-center lg:px-5",
        "data-[changed]:bg-highlight aria-[current=true]:bg-selected aria-[current=true]:shadow-[inset_0_0_0_1px_var(--accent-line)]",
      )}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[0.90625rem] leading-snug font-semibold">
          {reference}
          <span className="min-w-0">{title}</span>
        </div>
        {sub ? <div className="mt-1 truncate text-[0.8125rem] text-faint">{sub}</div> : null}
      </div>
      <div className="col-span-full min-w-0 text-sm leading-6 text-muted empty:hidden lg:col-span-1 lg:empty:block">
        {next}
      </div>
      <div className="col-span-full flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[0.8125rem] text-faint empty:hidden lg:col-span-1 lg:flex-col lg:items-start lg:empty:block">
        {meta}
      </div>
      <div className="queue-action col-start-2 row-start-1 flex justify-end gap-2 lg:col-start-auto lg:row-start-auto">
        {action}
      </div>
    </li>
  );
}
