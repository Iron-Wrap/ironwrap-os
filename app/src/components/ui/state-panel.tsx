import { AlertTriangle, CircleOff, LoaderCircle, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "./button";
import { Card } from "./card";

interface StatePanelProps {
  title: string;
  message: string;
  icon: ReactNode;
  action?: ReactNode;
  live?: "polite" | "assertive";
}

function StatePanel({ title, message, icon, action, live = "polite" }: StatePanelProps) {
  return (
    <Card className="mx-auto max-w-xl overflow-hidden" aria-live={live}>
      <div className="grid gap-5 p-5 sm:grid-cols-[3.5rem_minmax(0,1fr)] sm:p-7">
        <div className="flex size-12 items-center justify-center rounded-xl border border-border/75 bg-surface-muted text-muted shadow-[inset_0_1px_0_color-mix(in_srgb,var(--foreground)_4%,transparent)]">
          {icon}
        </div>
        <div className="min-w-0">
          <h2 className="text-xl font-[760] tracking-[-0.025em]">{title}</h2>
          <p className="mt-2 max-w-md text-sm leading-6 text-muted">{message}</p>
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
