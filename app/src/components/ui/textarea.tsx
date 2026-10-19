import * as React from "react";

import { cn } from "../../lib/cn";
import { fieldControl, fieldReadOnly } from "./field-control";

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
  busy?: boolean;
}

/** Free text, at least 72px (`size.72`) tall in every density. */
export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, invalid, busy, readOnly, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      readOnly={readOnly}
      aria-invalid={invalid || undefined}
      aria-busy={busy || undefined}
      className={cn(
        "ui-textarea min-h-18 resize-y px-3 py-2",
        fieldControl,
        readOnly && cn(fieldReadOnly, "resize-none"),
        className,
      )}
      {...props}
    />
  );
});
