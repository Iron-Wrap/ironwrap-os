# IronWrap OS shared UI components

Source snapshot for Superdesign initialization. Generated from the current task worktree; source paths remain canonical.

## Framework and component conventions

- React 19 + TypeScript + Tailwind CSS v4 utilities.
- Radix Slot is used only for polymorphic buttons.
- Lucide React supplies interface icons.
- Shared class merging routes through `app/src/lib/cn.ts`.
- Controls are field-first: 44–64px minimum heights, visible focus, semantic busy/invalid states.

## Button — `app/src/components/ui/button.tsx`

```tsx
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
```

## Card family — `app/src/components/ui/card.tsx`

```tsx
import * as React from "react";

import { cn } from "../../lib/cn";

export function Card({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={cn(
        "rounded-xl border bg-surface-raised shadow-[0_1px_2px_oklch(0_0_0/0.05)]",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn("space-y-1 p-5 pb-3 sm:p-6 sm:pb-4", className)} {...props} />;
}

export function CardTitle({
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>): React.JSX.Element {
  return <h2 className={cn("text-xl font-bold tracking-[-0.025em]", className)} {...props} />;
}

export function CardDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>): React.JSX.Element {
  return <p className={cn("text-sm leading-6 text-muted", className)} {...props} />;
}

export function CardContent({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn("p-5 pt-0 sm:p-6 sm:pt-0", className)} {...props} />;
}
```

## Input — `app/src/components/ui/input.tsx`

```tsx
import * as React from "react";

import { cn } from "../../lib/cn";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        "min-h-16 w-full rounded-lg border bg-surface-raised px-4 text-base text-foreground shadow-inner shadow-black/3 placeholder:text-muted/80 disabled:cursor-not-allowed disabled:opacity-55",
        "focus-visible:border-info focus-visible:outline-info",
        invalid && "border-danger focus-visible:border-danger focus-visible:outline-danger",
        className,
      )}
      {...props}
    />
  );
});
```

## Loading, error, and empty states — `app/src/components/ui/state-panel.tsx`

```tsx
import { AlertTriangle, CircleOff, LoaderCircle, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "./button";
import { Card } from "./card";

interface StatePanelProps {
  title: string;
  message: string;
  icon: ReactNode;
  action?: ReactNode;
  live?: "polite" | "assertive";
}

function StatePanel({ title, message, icon, action, live = "polite" }: StatePanelProps) {
  return (
    <Card className="mx-auto max-w-lg p-6 text-center sm:p-8" aria-live={live}>
      <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-surface-muted text-muted">
        {icon}
      </div>
      <h2 className="text-xl font-bold tracking-[-0.025em]">{title}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted">{message}</p>
      {action ? <div className="mt-6 flex justify-center">{action}</div> : null}
    </Card>
  );
}

export function LoadingState({ label = "Loading your work…" }: { label?: string }) {
  return (
    <div className="grid min-h-[40dvh] place-items-center" role="status" aria-live="polite">
      <div className="flex items-center gap-3 rounded-lg border bg-surface-raised px-5 py-4 font-medium shadow-sm">
        <LoaderCircle className="size-5 animate-spin text-info" aria-hidden="true" />
        <span>{label}</span>
      </div>
    </div>
  );
}

export function ErrorState({
  title = "Couldn’t load this yet",
  message,
  onRetry,
  action,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
  action?: ReactNode;
}) {
  return (
    <StatePanel
      title={title}
      message={message}
      live="assertive"
      icon={<AlertTriangle className="size-6 text-danger" aria-hidden="true" />}
      action={
        action ??
        (onRetry ? (
          <Button variant="outline" onClick={onRetry}>
            <RotateCcw aria-hidden="true" />
            Try again
          </Button>
        ) : undefined)
      }
    />
  );
}

export function EmptyState({
  title,
  message,
  action,
}: {
  title: string;
  message: string;
  action?: ReactNode;
}) {
  return (
    <StatePanel
      title={title}
      message={message}
      icon={<CircleOff className="size-6" aria-hidden="true" />}
      action={action}
    />
  );
}
```
