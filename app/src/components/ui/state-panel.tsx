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
    <Card className="mx-auto max-w-lg overflow-hidden p-6 text-center sm:p-8" aria-live={live}>
      <div className="mx-auto mb-5 flex size-12 items-center justify-center rounded-md border bg-surface-muted text-muted">
        {icon}
      </div>
      <h2 className="text-xl font-bold tracking-[-0.025em]">{title}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted">{message}</p>
      {action ? <div className="mt-6 flex justify-center">{action}</div> : null}
    </Card>
  );
}

export function LoadingState({ label = "Loading your work…" }: { label?: string }) {
  return (
    <div className="grid min-h-[40dvh] place-items-center" role="status" aria-live="polite">
      <div className="w-full max-w-lg rounded-lg border bg-surface-raised p-5 sm:p-6">
        <div className="flex items-center gap-3 text-sm font-bold text-muted">
          <LoaderCircle className="size-5 animate-spin text-info" aria-hidden="true" />
          <span>{label}</span>
        </div>
        <div className="mt-5 space-y-3" aria-hidden="true">
          <div className="ui-skeleton h-4 w-2/5 rounded-sm bg-surface-muted" />
          <div className="ui-skeleton h-3 w-full rounded-sm bg-surface-muted" />
          <div className="ui-skeleton h-3 w-4/5 rounded-sm bg-surface-muted" />
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
