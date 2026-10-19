import { CircleAlert, LoaderCircle } from "lucide-react";
import { useId, type ReactNode } from "react";

import { cn } from "../../lib/cn";

/** What a field passes to its control, so the label, help and error reach assistive tech. */
export interface FieldControlProps {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  "aria-busy"?: true;
}

/**
 * One System v2 field (Board 2): the label above the control, help or the error under it, and
 * the states a control cannot show alone. An error says the one next step (Z3.4) and marks the
 * control invalid; busy says "Checking…" while a lookup runs. A value nobody has measured or set
 * is `unknown`: its words ("Not measured yet") sit in a dashed `control.placeholder` edge instead
 * of a control, never 0 or an empty box. A value the viewer can set is always a real control.
 *
 * The control comes from the render prop, so any of Input, Select or Textarea fits:
 * `<Field label="Coil or part number">{(control) => <Input {...control} />}</Field>`.
 */
export function Field({
  label,
  help,
  error,
  busy,
  busyText = "Checking…",
  unknown,
  className,
  children,
}: {
  label: ReactNode;
  help?: ReactNode;
  /** One sentence ending in the one next step. */
  error?: ReactNode;
  busy?: boolean;
  busyText?: string;
  /** The words for a value nobody has measured or set yet: "Not measured yet", "Owner to set". */
  unknown?: string;
  className?: string;
  children?: (control: FieldControlProps) => ReactNode;
}) {
  const id = useId();
  const labelId = `${id}-label`;
  const noteId = `${id}-note`;
  const labelClassName =
    "text-[length:var(--type-label-size)] leading-[var(--type-label-line-height)] font-semibold text-text-primary";
  const noteClassName =
    "flex items-start gap-1.5 text-[length:var(--type-caption-size)] leading-[var(--type-caption-line-height)]";

  if (unknown !== undefined) {
    return (
      <div role="group" aria-labelledby={labelId} className={cn("grid gap-1.5", className)}>
        <span id={labelId} className={labelClassName}>
          {label}
        </span>
        <span
          data-unknown=""
          className="flex min-h-[var(--control-height)] items-center rounded-[var(--control-radius)] border border-dashed border-control-placeholder px-3 text-[length:var(--type-body-size)] leading-[var(--type-body-line-height)] text-text-secondary"
        >
          {unknown}
        </span>
        {help ? <span className={cn(noteClassName, "text-text-secondary")}>{help}</span> : null}
      </div>
    );
  }

  const note = error ?? (busy ? busyText : help);
  const control: FieldControlProps = {
    id,
    "aria-describedby": note ? noteId : undefined,
    "aria-invalid": error ? true : undefined,
    "aria-busy": busy ? true : undefined,
  };
  return (
    <div className={cn("grid gap-1.5", className)}>
      <label htmlFor={id} id={labelId} className={labelClassName}>
        {label}
      </label>
      {children?.(control)}
      {error ? (
        <p id={noteId} className={cn(noteClassName, "text-signal-held")}>
          <CircleAlert aria-hidden="true" className="mt-px size-[1.15em] shrink-0" />
          <span>{error}</span>
        </p>
      ) : busy ? (
        <p id={noteId} role="status" className={cn(noteClassName, "text-text-secondary")}>
          <LoaderCircle aria-hidden="true" className="mt-px size-[1.15em] shrink-0 animate-spin" />
          <span>{busyText}</span>
        </p>
      ) : help ? (
        <p id={noteId} className={cn(noteClassName, "text-text-secondary")}>
          {help}
        </p>
      ) : null}
    </div>
  );
}
