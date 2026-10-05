import { useEffect, useId, useRef } from "react";

export interface FieldError {
  /** The `id` of the control to focus. */
  fieldId: string;
  message: string;
}

/**
 * The list of what stops a form from going through, shown above the form after a refused
 * submit. It takes focus when it appears so a screen reader hears it, and each item moves focus
 * to the control it names. Mount it on a failed submit; it renders nothing without errors.
 */
export function ErrorSummary({
  errors,
  title = "Fix these before you continue",
}: {
  errors: readonly FieldError[];
  title?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const hasErrors = errors.length > 0;
  useEffect(() => {
    if (hasErrors) ref.current?.focus();
  }, [hasErrors]);
  if (!hasErrors) return null;
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alert"
      aria-labelledby={titleId}
      className="rounded-[0.625rem] bg-danger-soft px-4 py-3.5 shadow-[inset_0_0_0_1px_var(--danger-line)]"
    >
      <p id={titleId} className="font-semibold text-foreground">
        {title}
      </p>
      <ul className="mt-1.5 list-disc pl-5 text-sm leading-6">
        {errors.map((problem) => (
          <li key={problem.fieldId}>
            <a
              href={`#${problem.fieldId}`}
              className="font-semibold text-danger underline underline-offset-[3px]"
              onClick={(event) => {
                const field = document.getElementById(problem.fieldId);
                if (!field) return;
                event.preventDefault();
                field.focus();
              }}
            >
              {problem.message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
