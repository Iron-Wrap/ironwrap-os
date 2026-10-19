import * as React from "react";

import { cn } from "../../lib/cn";
import { fieldControl, fieldReadOnly } from "./field-control";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  /** A lookup is running on what was typed ("Checking…"); the field stays editable. */
  busy?: boolean;
}

/** A text field `--control-height` tall: 28 on the office, 48 on touch, 72 on glove. */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid, busy, readOnly, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      readOnly={readOnly}
      aria-invalid={invalid || undefined}
      aria-busy={busy || undefined}
      className={cn(
        "ui-input min-h-[var(--control-height)] px-3",
        fieldControl,
        readOnly && fieldReadOnly,
        className,
      )}
      {...props}
    />
  );
});
