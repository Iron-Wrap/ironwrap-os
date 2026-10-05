import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { LoaderCircle } from "lucide-react";
import * as React from "react";

import { cn } from "../../lib/cn";

const primary =
  "bg-primary text-primary-foreground shadow-[0_1px_2px_rgb(21_24_28/0.06),inset_0_1px_0_rgb(255_255_255/0.08)] hover:bg-primary-hover";
const secondary =
  "bg-surface text-foreground shadow-[inset_0_0_0_1px_var(--border-control),0_1px_2px_rgb(21_24_28/0.06)] hover:bg-surface-hover hover:shadow-[inset_0_0_0_1px_var(--faint),0_1px_2px_rgb(21_24_28/0.06)]";
const quiet = "bg-transparent text-muted hover:bg-surface-hover hover:text-foreground";

/**
 * Iron Wrap button language: one ink primary per context, a sheet-white secondary, a quiet
 * text action, and a committed stop-red danger. Brass is never a button colour; it only
 * marks focus and the active place.
 *
 * `default`, `accent`, `outline` and `ghost` predate the port and stay as aliases so every
 * existing call site takes the new look without an edit: `default` and `accent` are
 * `primary`, `outline` is `secondary`, `ghost` is `quiet`. `danger` stays filled, because a
 * stop-work, rescue or revoke control must not go pale.
 */
const buttonVariants = cva(
  "ui-button relative inline-flex min-h-11 select-none items-center justify-center gap-2 whitespace-nowrap rounded-md border border-transparent px-4 text-sm font-semibold tracking-[-0.003em] transition-[background-color,border-color,color,box-shadow,transform] duration-[var(--motion-fast)] active:translate-y-px disabled:pointer-events-none disabled:opacity-50 disabled:shadow-none disabled:transform-none [&_svg]:size-[1.125rem] [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary,
        secondary,
        quiet,
        danger:
          "bg-danger-strong text-danger-strong-foreground hover:bg-danger-strong/88 active:bg-danger-strong/78",
        default: primary,
        accent: primary,
        outline: secondary,
        ghost: quiet,
      },
      size: {
        default: "min-h-11",
        field: "min-h-16 whitespace-normal px-4 text-base leading-5",
        icon: "size-11 min-h-11 px-0",
        compact: "min-h-11 px-3.5 text-sm",
        // Dense pointer/keyboard rows stay 32px; touch and environment CSS enlarges the box.
        small: "min-h-8 gap-1.5 px-3 text-[0.8125rem] [&_svg]:size-[0.9375rem]",
      },
      fullWidth: {
        true: "w-full",
        false: "",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
      fullWidth: false,
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  busy?: boolean;
}

export function Button({
  asChild,
  busy,
  className,
  variant,
  size,
  fullWidth,
  children,
  disabled,
  ...props
}: ButtonProps): React.JSX.Element {
  const classes = cn(buttonVariants({ variant, size, fullWidth }), className);
  if (asChild) {
    return (
      <Slot
        className={classes}
        data-ui-size={size ?? "default"}
        aria-busy={busy || undefined}
        {...props}
      >
        {children}
      </Slot>
    );
  }
  return (
    <button
      className={classes}
      data-ui-size={size ?? "default"}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...props}
    >
      {busy ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : null}
      {children}
    </button>
  );
}
