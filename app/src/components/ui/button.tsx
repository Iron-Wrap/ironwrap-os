import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { LoaderCircle } from "lucide-react";
import * as React from "react";

import { cn } from "../../lib/cn";

const buttonVariants = cva(
  "inline-flex min-h-14 select-none items-center justify-center gap-2 rounded-lg px-5 text-base font-semibold tracking-[-0.01em] transition-colors disabled:pointer-events-none disabled:opacity-55 [&_svg]:size-5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-foreground text-background hover:bg-foreground/88 active:bg-foreground/78",
        accent:
          "bg-accent text-accent-foreground hover:bg-accent/88 active:bg-accent/78 shadow-[0_1px_0_oklch(0_2_0/0.18)]",
        outline: "border bg-surface text-foreground hover:bg-surface-muted active:bg-border",
        ghost: "text-foreground hover:bg-surface-muted active:bg-border",
        danger: "bg-danger text-danger-foreground hover:bg-danger/88 active:bg-danger/78",
      },
      size: {
        default: "min-h-14",
        field: "min-h-16 px-6 text-lg",
        icon: "size-14 min-h-14 px-0",
        compact: "min-h-11 px-4 text-sm",
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
