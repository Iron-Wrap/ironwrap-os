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
        "min-h-24 w-full resize-y rounded-md border border-border-control bg-surface-raised px-4 py-3 text-base leading-6 text-foreground shadow-[0_1px_2px_rgb(21_24_28/0.06)] transition-[border-color,box-shadow,background-color] placeholder:text-faint hover:border-border-strong disabled:cursor-not-allowed disabled:bg-surface-muted disabled:opacity-55",
        "focus-visible:border-focus focus-visible:outline-focus focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--focus)_22%,transparent)]",
        invalid && "border-danger focus-visible:border-danger focus-visible:outline-danger",
        className,
      )}
      {...props}
    />
  );
});
