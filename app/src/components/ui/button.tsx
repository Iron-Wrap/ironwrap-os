import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { LoaderCircle } from "lucide-react";
import * as React from "react";

import { cn } from "../../lib/cn";

const buttonVariants = cva(
  "inline-flex min-h-11 select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-transparent px-4 text-sm font-bold tracking-[-0.01em] transition-[background-color,border-color,color,box-shadow,transform] duration-[var(--motion-fast)] active:translate-y-px disabled:pointer-events-none disabled:opacity-55 disabled:shadow-none disabled:transform-none [&_svg]:size-[1.125rem] [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-foreground text-background shadow-[0_1px_0_color-mix(in_srgb,var(--foreground)_35%,transparent)] hover:bg-foreground/88 active:bg-foreground/78",
        accent:
          "bg-accent text-accent-foreground shadow-[0_8px_20px_color-mix(in_srgb,var(--accent)_18%,transparent)] hover:bg-accent-hover active:bg-accent-active",
        outline:
          "border-border bg-surface text-foreground hover:border-border-strong hover:bg-surface-muted active:bg-border",
        ghost:
          "border-transparent bg-transparent text-foreground hover:bg-surface-muted active:bg-border",
        danger:
          "bg-danger-strong text-danger-strong-foreground hover:bg-danger-strong/88 active:bg-danger-strong/78",
      },
      size: {
        default: "min-h-11",
        field: "min-h-16 whitespace-normal px-4 text-base leading-5",
        icon: "size-11 min-h-11 px-0",
        compact: "min-h-11 px-3.5 text-sm",
      },
      fullWidth: {
        true: "w-full",
        false: "",
      },
    },
    defaultVariants: {
      variant: "default",
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
      <Slot className={classes} aria-busy={busy || undefined} {...props}>
        {children}
      </Slot>
    );
  }
  return (
    <button
      className={classes}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...props}
    >
      {busy ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : null}
      {children}
    </button>
  );
}
