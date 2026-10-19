import type { HTMLAttributes } from "react";

import { cn } from "../../lib/cn";

/**
 * confirmed: the office or provider has it. pending: sent, waiting on someone else.
 * local: on this device only. attention: someone has to act. stopped: work or a flow is
 * halted (Held). neutral: a plain fact. retired: no longer in play.
 *
 * The System v2 signal chip kinds (design/system-v2, Board 3 and Board 6): you, "Needs you",
 * only when the viewer is the one waited on; done, finished ("Done for you"); working, in
 * progress ("Working on it"); proposed, an agent's value nobody has accepted (open diamond,
 * dotted edge); unknown, a value nobody has measured or set ("Not known yet", dashed edge,
 * never 0); undone, a step a person reversed.
 */
export type StatusKind =
  | "confirmed"
  | "pending"
  | "local"
  | "attention"
  | "stopped"
  | "neutral"
  | "retired"
  | "you"
  | "done"
  | "working"
  | "proposed"
  | "unknown"
  | "undone";

/** Only `you` is blue and only `stopped` is red: two signals, one meaning each. */
const kindClassName: Record<StatusKind, string> = {
  confirmed: "bg-ok-soft text-ok",
  pending: "bg-info-soft text-info",
  local: "bg-local-soft text-local",
  attention: "bg-warning-soft text-warning",
  stopped: "bg-danger-soft text-danger",
  neutral: "bg-neutral-soft text-neutral",
  retired: "bg-transparent text-faint shadow-[inset_0_0_0_1px_var(--border)]",
  you: "bg-signal-you-tint text-signal-you",
  done: "bg-surface-rail text-text-primary",
  working: "bg-surface-rail text-text-primary",
  // The edge is an outline drawn inside the box, so a chip with an edge keeps the same size.
  proposed:
    "bg-transparent text-text-primary outline-1 -outline-offset-1 outline-text-secondary outline-dotted",
  unknown:
    "bg-transparent text-text-secondary outline-1 -outline-offset-1 outline-control-placeholder outline-dashed",
  undone: "bg-transparent text-text-secondary",
};

/** Each status has its own shape, so it reads without colour. */
export function StatusGlyph({ kind, className }: { kind: StatusKind; className?: string }) {
  const common = {
    viewBox: "0 0 12 12",
    "aria-hidden": true,
    "data-glyph": kind,
    className: cn("size-[0.875em] shrink-0", kind === "working" && "animate-spin", className),
  } as const;
  const line = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  } as const;
  switch (kind) {
    case "confirmed":
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="5" fill="currentColor" />
        </svg>
      );
    case "pending":
      // A clock: waiting on someone else (Board 3, Waiting).
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4.6" {...line} strokeWidth="1.3" />
          <path d="M6 3.4V6l1.8 1.2" {...line} strokeWidth="1.3" />
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
    case "you":
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="3" fill="currentColor" />
        </svg>
      );
    case "done":
      return (
        <svg {...common}>
          <path d="M2.2 6.4 4.9 9 9.8 3.4" {...line} strokeWidth="1.7" />
        </svg>
      );
    case "working":
      return (
        <svg {...common}>
          <path d="M6 1.4a4.6 4.6 0 1 1-4.6 4.6" {...line} />
        </svg>
      );
    case "proposed":
      return (
        <svg {...common}>
          <path d="M6 1.2 10.8 6 6 10.8 1.2 6z" {...line} strokeWidth="1.3" />
        </svg>
      );
    case "unknown":
      return (
        <svg {...common}>
          <circle cx="2.2" cy="6" r="1.1" fill="currentColor" />
          <circle cx="6" cy="6" r="1.1" fill="currentColor" />
          <circle cx="9.8" cy="6" r="1.1" fill="currentColor" />
        </svg>
      );
    case "undone":
      return (
        <svg {...common}>
          <path d="M4.4 2.8 1.8 5.4 4.4 8" {...line} strokeWidth="1.3" />
          <path d="M2.2 5.4h5.1a2.9 2.9 0 0 1 0 5.8H6" {...line} strokeWidth="1.3" />
        </svg>
      );
  }
}

/**
 * A status is always a glyph and words; colour only reinforces them. Caption type and the chip
 * corner come from the density tokens.
 */
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
        "ui-status inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-[var(--radius-chip)] py-[3px] pr-2 pl-1.5 font-semibold max-sm:whitespace-normal",
        "text-[length:var(--type-caption-size)] leading-[var(--type-caption-line-height)]",
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
