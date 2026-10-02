import type { HTMLAttributes } from "react";

import { cn } from "../../lib/cn";

/**
 * confirmed: the office or provider has it. pending: sent, waiting on someone else.
 * local: on this device only. attention: someone has to act. stopped: work or a flow is
 * halted. neutral: a plain fact. retired: no longer in play.
 */
export type StatusKind =
  "confirmed" | "pending" | "local" | "attention" | "stopped" | "neutral" | "retired";

const kindClassName: Record<StatusKind, string> = {
  confirmed: "bg-ok-soft text-ok",
  pending: "bg-info-soft text-info",
  local: "bg-local-soft text-local",
  attention: "bg-warning-soft text-warning",
  stopped: "bg-danger-soft text-danger",
  neutral: "bg-neutral-soft text-neutral",
  retired: "bg-transparent text-faint shadow-[inset_0_0_0_1px_var(--border)]",
};

/** Each status has its own shape, so it reads without colour. */
export function StatusGlyph({ kind, className }: { kind: StatusKind; className?: string }) {
  const common = {
    viewBox: "0 0 12 12",
    "aria-hidden": true,
    "data-glyph": kind,
    className: cn("size-2.5 shrink-0", className),
  } as const;
  switch (kind) {
    case "confirmed":
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="5" fill="currentColor" />
        </svg>
      );
    case "pending":
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M6 1.6a4.4 4.4 0 0 1 0 8.8z" fill="currentColor" />
        </svg>
      );
    case "local":
      return (
        <svg {...common}>
          <circle
            cx="6"
            cy="6"
            r="4.4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeDasharray="2.2 1.6"
          />
        </svg>
      );
    case "attention":
      return (
        <svg {...common}>
          <path d="M6 1 11.2 10.5H.8z" fill="currentColor" />
        </svg>
      );
    case "stopped":
      return (
        <svg {...common}>
          <path d="M3.9 1h4.2L11 3.9v4.2L8.1 11H3.9L1 8.1V3.9z" fill="currentColor" />
        </svg>
      );
    case "retired":
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M2.8 9.2 9.2 2.8" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      );
    case "neutral":
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
  }
}

/** A status is always a glyph and words; colour only reinforces them. */
export function Status({
  kind,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { kind: StatusKind }) {
  return (
    <span
      data-status={kind}
      className={cn(
        "inline-flex min-h-[1.375rem] max-w-full items-center gap-1.5 whitespace-nowrap rounded-md py-[3px] pr-2 pl-[7px] text-[0.78125rem] font-medium leading-tight max-sm:whitespace-normal",
        kindClassName[kind],
        className,
      )}
      {...props}
    >
      <StatusGlyph kind={kind} />
      {children}
    </span>
  );
}
