import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";

import { cn } from "../../lib/cn";
import { Button } from "./button";

/**
 * A modal on the native `<dialog>` element, so focus trapping, Escape, the inert page behind it
 * and the backdrop come from the platform rather than a dependency. `side="end"` makes it a
 * drawer from the trailing edge; the default is a centred confirmation dialog.
 *
 * `open` is the source of truth. Escape and the close button both call `onClose`; the parent
 * sets `open` to false.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  side = "center",
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  side?: "center" | "end";
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    } else if (!open && dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
  }, [open]);

  const drawer = side === "end";
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      // A close the parent asked for (open already false) must not report back as a new request.
      onClose={() => {
        if (open) onClose();
      }}
      className={cn(
        "bg-surface p-0 text-foreground shadow-[var(--shadow-floating)] backdrop:bg-scrim",
        drawer
          ? "fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-none w-[min(26.25rem,100vw)] max-w-none open:flex open:flex-col"
          : "m-auto max-h-[calc(100dvh-3rem)] w-[min(32.5rem,calc(100vw-2rem))] rounded-[0.875rem]",
        className,
      )}
    >
      <div
        className={cn(
          "flex items-start gap-3",
          drawer ? "border-b border-border px-5 py-4" : "px-6 pt-5",
        )}
      >
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-[1.0625rem] leading-snug font-semibold">
            {title}
          </h2>
          {description ? (
            <p id={descriptionId} className="mt-1 text-sm leading-6 text-muted">
              {description}
            </p>
          ) : null}
        </div>
        <Button variant="quiet" size="icon" aria-label="Close" onClick={onClose} className="-mr-2">
          <X aria-hidden="true" />
        </Button>
      </div>
      <div
        className={cn(
          "grid content-start gap-3.5 text-muted",
          drawer ? "flex-1 overflow-auto px-5 py-4" : "px-6 pt-3 pb-1",
        )}
      >
        {children}
      </div>
      {footer ? (
        <div
          className={cn(
            "flex flex-wrap gap-2",
            drawer
              ? "border-t border-border px-5 pt-3.5 pb-[calc(0.875rem+env(safe-area-inset-bottom))]"
              : "justify-end px-6 pt-5 pb-5",
          )}
        >
          {footer}
        </div>
      ) : null}
    </dialog>
  );
}
