import type { ReactNode } from "react";

import { cn } from "../../lib/cn";

/**
 * A page title with its back link, context line, meta and actions. `eyebrow` is a sentence-case
 * context line above the title, never an all-caps kicker.
 */
export function PageHeader({
  title,
  back,
  eyebrow,
  meta,
  actions,
  children,
  className,
}: {
  title: ReactNode;
  back?: ReactNode;
  eyebrow?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("grid gap-3", className)}>
      {back ? <div className="text-sm font-semibold text-muted">{back}</div> : null}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          {eyebrow ? <p className="mb-1 text-sm font-semibold text-muted">{eyebrow}</p> : null}
          <h1 className="text-2xl leading-[1.15] font-[640] tracking-[-0.018em] sm:text-[1.75rem]">
            {title}
          </h1>
          {meta ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
              {meta}
            </div>
          ) : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </header>
  );
}
