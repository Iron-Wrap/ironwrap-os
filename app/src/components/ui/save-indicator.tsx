import { Check, LoaderCircle } from "lucide-react";

import { cn } from "../../lib/cn";

export type SaveState = "idle" | "editing" | "saving" | "saved" | "failed";

/**
 * Honest save state for an editor: unsaved, saving, saved (with when), or not saved with a way
 * to try again. It never says "saved" before the server has confirmed it.
 */
export function SaveIndicator({
  state,
  savedAt,
  onRetry,
}: {
  state: SaveState;
  /** When the last confirmed save happened, already formatted, e.g. "2 minutes ago". */
  savedAt?: string;
  onRetry?: () => void;
}) {
  return (
    <span
      role="status"
      aria-live="polite"
      data-state={state}
      className={cn(
        "inline-flex items-center gap-1.5 text-[0.8125rem] whitespace-nowrap text-faint [&_svg]:size-3.5",
        state === "failed" && "font-semibold text-danger",
      )}
    >
      {state === "editing" ? "Unsaved changes" : null}
      {state === "saving" ? (
        <>
          <LoaderCircle className="animate-spin" aria-hidden="true" /> Saving…
        </>
      ) : null}
      {(state === "saved" || state === "idle") && savedAt ? (
        <>
          <Check aria-hidden="true" /> Saved {savedAt}
        </>
      ) : null}
      {state === "failed" ? (
        <>
          Not saved.
          {onRetry ? (
            <button
              type="button"
              className="font-semibold underline underline-offset-[3px]"
              onClick={onRetry}
            >
              Save again
            </button>
          ) : null}
        </>
      ) : null}
    </span>
  );
}
