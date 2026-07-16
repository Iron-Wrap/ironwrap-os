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
