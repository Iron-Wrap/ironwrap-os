import * as React from "react";

import { cn } from "../../lib/cn";

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, invalid, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        "min-h-24 w-full resize-y rounded-md border bg-surface-raised px-4 py-3 text-base leading-6 text-foreground transition-[border-color,box-shadow,background-color] placeholder:text-muted/75 hover:border-border-strong disabled:cursor-not-allowed disabled:bg-surface-muted disabled:opacity-55",
        "focus-visible:border-focus focus-visible:outline-focus focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--focus)_15%,transparent)]",
        invalid && "border-danger focus-visible:border-danger focus-visible:outline-danger",
        className,
      )}
      {...props}
    />
  );
});
