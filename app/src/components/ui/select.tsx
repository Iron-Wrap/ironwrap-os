import * as React from "react";

import { cn } from "../../lib/cn";
import { fieldControl } from "./field-control";

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  /** The crew's large select: `--control-height-primary` (64 on touch, 72 on glove). */
  field?: boolean;
  invalid?: boolean;
  /** The options are still loading. */
  busy?: boolean;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, field, invalid, busy, ...props },
  ref,
) {
  return (
    <select
      ref={ref}
      data-ui-size={field ? "field" : undefined}
      aria-invalid={invalid || undefined}
      aria-busy={busy || undefined}
      className={cn(
        "ui-select",
        fieldControl,
        field ? "min-h-[var(--control-height-primary)] px-4" : "min-h-[var(--control-height)] px-3",
        className,
      )}
      {...props}
    />
  );
});
