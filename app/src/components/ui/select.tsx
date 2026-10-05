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
      data-ui-size={field ? "field" : undefined}
      aria-invalid={invalid || undefined}
      className={cn(
        "ui-select w-full rounded-md border border-border-control bg-surface-raised text-base text-foreground shadow-[0_1px_2px_rgb(21_24_28/0.06)] transition-[border-color,box-shadow,background-color] hover:border-border-strong disabled:cursor-not-allowed disabled:bg-surface-muted disabled:opacity-55",
        field ? "min-h-16 px-4" : "min-h-12 px-3.5",
        "focus-visible:border-focus focus-visible:outline-focus focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--focus)_22%,transparent)]",
        invalid && "border-danger focus-visible:border-danger focus-visible:outline-danger",
        className,
      )}
      {...props}
    />
  );
});
