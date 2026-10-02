import type { ReactNode } from "react";

import { cn } from "../lib/cn";

export function WorkspaceHeader({
  icon,
  title,
  description,
  actions,
  aside,
  back,
  className,
}: {
  icon: ReactNode;
  title: ReactNode;
  description: ReactNode;
  actions?: ReactNode;
  aside?: ReactNode;
  back?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "relative overflow-hidden rounded-xl border border-border/80 bg-surface-raised",
        className,
      )}
    >
      <div className={cn("grid min-w-0", aside && "lg:grid-cols-[minmax(0,1fr)_18rem]")}>
        <div className="min-w-0 p-5 pl-6 sm:p-6 sm:pl-7 lg:p-7 lg:pl-8">
          {back ? <div className="mb-3">{back}</div> : null}
          <div className="flex min-w-0 items-start gap-3.5 sm:gap-4">
            <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-surface-muted text-muted [&_svg]:size-5">
              {icon}
            </span>
            <div className="min-w-0 flex-1">
              <h1 className="text-2xl font-bold tracking-[-0.045em] text-balance sm:text-3xl">
                {title}
              </h1>
              <div className="mt-1.5 max-w-3xl text-sm leading-6 text-muted sm:text-[0.9375rem]">
                {description}
              </div>
              {actions ? (
                <div className="mt-4 flex flex-wrap items-center gap-2">{actions}</div>
              ) : null}
            </div>
          </div>
        </div>
        {aside ? (
          <aside className="border-t border-border/75 bg-surface-muted/45 p-5 sm:px-6 lg:border-l lg:border-t-0 lg:p-6">
            {aside}
          </aside>
        ) : null}
      </div>
    </header>
  );
}
