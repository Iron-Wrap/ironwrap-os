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
        "min-h-12 w-full rounded-md border bg-surface-raised px-3.5 text-base text-foreground transition-[border-color,box-shadow,background-color] placeholder:text-muted/75 hover:border-border-strong disabled:cursor-not-allowed disabled:bg-surface-muted disabled:opacity-55",
        "focus-visible:border-focus focus-visible:outline-focus focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--focus)_15%,transparent)]",
        invalid && "border-danger focus-visible:border-danger focus-visible:outline-danger",
        className,
      )}
      {...props}
    />
  );
});
