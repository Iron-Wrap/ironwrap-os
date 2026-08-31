import { AlertTriangle, CircleAlert, CircleOff, Lock, LoaderCircle, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/cn";
import { Button } from "./button";
import { Card } from "./card";

/**
 * `neutral` is for a state nobody needs to act on urgently — an intentional administrator choice
 * reads as calm, not as an incident. `warning` is for a state that genuinely needs someone to do
 * something before the capability can work. `ErrorState` keeps `danger` for a live failure, which
 * is the only one of the three where retrying can plausibly help.
 */
type PanelTone = "neutral" | "warning";

interface StatePanelProps {
  title: string;
  message: string;
  icon: ReactNode;
  action?: ReactNode;
  live?: "polite" | "assertive";
  tone?: PanelTone;
  /** Visible state name. Colour and icon never carry the meaning on their own. */
  stateLabel?: string;
  footer?: ReactNode;
}

function StatePanel({
  title,
  message,
  icon,
  action,
  live = "polite",
  tone = "neutral",
  stateLabel,
  footer,
}: StatePanelProps) {
  return (
    <Card className="mx-auto max-w-xl overflow-hidden" aria-live={live}>
      <div className="grid gap-5 p-5 sm:grid-cols-[3.5rem_minmax(0,1fr)] sm:p-7">
        <div
          className={cn(
            "flex size-12 items-center justify-center rounded-xl border shadow-[inset_0_1px_0_color-mix(in_srgb,var(--foreground)_4%,transparent)]",
            tone === "warning"
              ? "border-warning/40 bg-warning-soft text-warning"
              : "border-border/75 bg-surface-muted text-muted",
          )}
        >
          {icon}
        </div>
        <div className="min-w-0">
          {stateLabel ? <p className="mb-1.5 text-sm font-[740] text-muted">{stateLabel}</p> : null}
          <h2 className="text-xl font-[760] tracking-[-0.025em]">{title}</h2>
          <p className="mt-2 max-w-md text-sm leading-6 text-muted">{message}</p>
          {footer}
          {action ? <div className="mt-5 flex flex-wrap items-center gap-2">{action}</div> : null}
        </div>
      </div>
    </Card>
  );
}

export function LoadingState({ label = "Loading your work…" }: { label?: string }) {
  return (
    <div className="grid min-h-[40dvh] place-items-center" role="status" aria-live="polite">
      <div className="w-full max-w-xl rounded-xl border border-border/80 bg-surface-raised p-5 shadow-[var(--shadow-card)] sm:p-7">
        <div className="grid grid-cols-[3rem_minmax(0,1fr)] gap-4">
          <div className="grid size-12 place-items-center rounded-xl bg-surface-muted">
            <LoaderCircle className="size-5 animate-spin text-info" aria-hidden="true" />
          </div>
          <div>
            <div className="text-sm font-[740] text-muted">{label}</div>
            <div className="mt-4 space-y-3" aria-hidden="true">
              <div className="ui-skeleton h-4 w-2/5 rounded-sm bg-surface-muted" />
              <div className="ui-skeleton h-3 w-full rounded-sm bg-surface-muted" />
              <div className="ui-skeleton h-3 w-4/5 rounded-sm bg-surface-muted" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ErrorState({
  title = "Couldn’t load this yet",
  message,
  onRetry,
  action,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
  action?: ReactNode;
}) {
  return (
    <StatePanel
      title={title}
      message={message}
      live="assertive"
      icon={<AlertTriangle className="size-6 text-danger" aria-hidden="true" />}
      action={
        action ??
        (onRetry ? (
          <Button variant="outline" onClick={onRetry}>
            <RotateCcw aria-hidden="true" />
            Try again
          </Button>
        ) : undefined)
      }
    />
  );
}

export function EmptyState({
  title,
  message,
  action,
}: {
  title: string;
  message: string;
  action?: ReactNode;
}) {
  return (
    <StatePanel
      title={title}
      message={message}
      icon={<CircleOff className="size-6" aria-hidden="true" />}
      action={action}
    />
  );
}

/**
 * The two shapes an unavailable capability takes, and the one a permission gate takes.
 *
 * All three carry the same required content: the fact in plain language, the next valid action
 * naming its actor and prerequisite, and a path to a person. None of them takes an `onRetry`, on
 * purpose — a control that cannot succeed must not offer to try again (ELEC-236 AC3). A live
 * failure that retrying could fix is `ErrorState`, and keeping the two apart is the whole point:
 * "nobody switched this on" and "the call just failed" are different facts with different owners.
 */
interface UnavailableStateProps {
  title: string;
  message: string;
  nextAction: string;
  personPath: string;
  stateLabel?: string;
}

function UnavailableDetail({ nextAction, personPath }: { nextAction: string; personPath: string }) {
  return (
    <dl className="mt-4 space-y-3 border-t border-border/70 pt-4 text-sm leading-6">
      <div>
        <dt className="font-[740] text-foreground">Next step</dt>
        <dd className="text-muted">{nextAction}</dd>
      </div>
      <div>
        <dt className="font-[740] text-foreground">Who to ask</dt>
        <dd className="text-muted">{personPath}</dd>
      </div>
    </dl>
  );
}

/** Present in the build, switched off. An intentional choice, not an incident. */
export function OffState({
  title,
  message,
  nextAction,
  personPath,
  stateLabel = "Turned off",
}: UnavailableStateProps) {
  return (
    <StatePanel
      title={title}
      message={message}
      stateLabel={stateLabel}
      icon={<CircleOff className="size-6" aria-hidden="true" />}
      footer={<UnavailableDetail nextAction={nextAction} personPath={personPath} />}
    />
  );
}

/** Switched on, setup unfinished. Needs someone to act; no retry can substitute for that. */
export function UnconfiguredState({
  title,
  message,
  nextAction,
  personPath,
  stateLabel = "Setup not finished",
}: UnavailableStateProps) {
  return (
    <StatePanel
      title={title}
      message={message}
      stateLabel={stateLabel}
      tone="warning"
      icon={<CircleAlert className="size-6" aria-hidden="true" />}
      footer={<UnavailableDetail nextAction={nextAction} personPath={personPath} />}
    />
  );
}

/**
 * A permission gate, which annex §6.1 keeps as its own axis: "no access" is not "no work", "no
 * configuration" or "failed dependency". Rendering nothing at all — the pattern this replaces —
 * tells a reader the capability does not exist rather than that it is not theirs.
 */
export function NoAccessState({
  title,
  message,
  nextAction,
  personPath,
  stateLabel = "Not your role",
}: UnavailableStateProps) {
  return (
    <StatePanel
      title={title}
      message={message}
      stateLabel={stateLabel}
      icon={<Lock className="size-6" aria-hidden="true" />}
      footer={<UnavailableDetail nextAction={nextAction} personPath={personPath} />}
    />
  );
}
