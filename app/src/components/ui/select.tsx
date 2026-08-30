import * as React from "react";

import { cn } from "../../lib/cn";

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  field?: boolean;
  invalid?: boolean;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, field, invalid, ...props },
  ref,
) {
  return (
    <select
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        "w-full rounded-lg border border-border/90 bg-surface-raised text-base text-foreground shadow-[inset_0_1px_0_color-mix(in_srgb,var(--foreground)_3%,transparent)] transition-[border-color,box-shadow,background-color] hover:border-border-strong disabled:cursor-not-allowed disabled:bg-surface-muted disabled:opacity-55",
        field ? "min-h-16 px-4" : "min-h-12 px-3.5",
        "focus-visible:border-focus focus-visible:outline-focus focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--focus)_15%,transparent)]",
        invalid && "border-danger focus-visible:border-danger focus-visible:outline-danger",
        className,
      )}
      {...props}
    />
  );
});
