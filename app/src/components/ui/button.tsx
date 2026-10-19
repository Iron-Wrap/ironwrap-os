import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { LoaderCircle } from "lucide-react";
import * as React from "react";

import { cn } from "../../lib/cn";
import { disabledLook } from "./field-control";

const primary = "bg-primary text-primary-foreground active:bg-control-fill-pressed";
const you = "bg-signal-you-fill text-signal-you-on-fill active:bg-signal-you-fill-pressed";
const secondary =
  "border-control-border bg-transparent text-text-primary hover:bg-surface-selected active:bg-surface-pressed";
const quiet =
  "bg-transparent text-text-primary hover:bg-surface-selected active:bg-surface-pressed";
const held = "bg-signal-held-fill text-signal-held-on-fill active:bg-signal-held-fill-pressed";

/**
 * System v2 button (design/system-v2, Board 1). Kinds keep one meaning each: an ink `primary`
 * per context; `you`, blue, only when it answers something waiting on the viewer; an outlined
 * `secondary`; a `quiet` (ghost) text action; and the filled `danger` (Held) red, only for a
 * stop. Filled kinds do not change on hover; pressed recolours to the kind's pressed role.
 * Disabled recolours to `text.tertiary` with a hairline edge and never fades; busy keeps the
 * kind, shows the loader and sets aria-busy. Focus is the ink outline from styles.css.
 *
 * Height, corner, edge width and icon come from the density tokens here, and the label type
 * from the `.ui-button` rule in styles.css (a form control's font is set there, since an
 * unlayered rule outranks utilities), so `data-density` on any ancestor resizes every button:
 * `small` is `--control-height-small`,
 * `default` and `compact` are `--control-height`, `large` and `field` are
 * `--control-height-primary` (24 / 28 / 32 on the office, 48 / 48 / 64 on touch, 72 on glove).
 *
 * `default`, `accent`, `outline` and `ghost` predate the port and stay as aliases so every
 * existing call site keeps working without an edit: `default` and `accent` are `primary`,
 * `outline` is `secondary`, `ghost` is `quiet`; `held` names `danger` as the board does.
 */
const buttonVariants = cva(
  [
    "ui-button relative inline-flex min-w-[var(--target-min)] select-none items-center justify-center gap-2 whitespace-nowrap",
    "rounded-[var(--control-radius)] border-[length:var(--control-border-width)] border-transparent px-3",
    "transition-colors duration-[var(--motion-fast)] ease-[var(--motion-ease)]",
    "[&_svg]:size-[var(--control-icon)] [&_svg]:shrink-0",
    disabledLook,
  ],
  {
    variants: {
      variant: {
        primary,
        you,
        secondary,
        quiet,
        danger: held,
        held,
        default: primary,
        accent: primary,
        outline: secondary,
        ghost: quiet,
      },
      size: {
        default: "min-h-[var(--control-height)]",
        compact: "min-h-[var(--control-height)] px-2.5",
        small: "min-h-[var(--control-height-small)] gap-1.5 px-2.5",
        large: "min-h-[var(--control-height-primary)] px-4",
        field: "min-h-[var(--control-height-primary)] whitespace-normal px-4",
        icon: "size-[var(--control-height)] min-h-[var(--control-height)] px-0",
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
  const data = { "data-ui-size": size ?? "default", "data-variant": variant ?? "primary" };
  if (asChild) {
    return (
      <Slot className={classes} {...data} aria-busy={busy || undefined} {...props}>
        {children}
      </Slot>
    );
  }
  return (
    <button
      className={classes}
      {...data}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...props}
    >
      {busy ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : null}
      {children}
    </button>
  );
}
