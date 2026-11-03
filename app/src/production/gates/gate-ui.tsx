import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { Notice } from "../../components/ui/notice";
import { ErrorSystemDetails } from "../../components/ui/system-details";
import { cn } from "../../lib/cn";
import { gateCopy } from "./gate-copy";
import type { GateStep } from "./gate-model";

/**
 * The parts every gate screen is made of, after the P30 wire kit: a read-only field (a value, or
 * a missing value marked Required), a banner, the "Next:" consequence line, and a held control
 * that says what it waits for.
 */

export function GateField({
  label,
  value,
  required,
  to,
  className,
}: {
  label: string;
  value: ReactNode;
  /** A value the gate still needs: red edge and a Required tag. */
  required?: boolean;
  /** Opens this row's step. */
  to?: { jobId: string; step: GateStep };
  className?: string;
}) {
  const body = (
    <>
      <span className="flex flex-wrap items-center gap-2 text-sm font-semibold text-text-secondary">
        {label}
        {required ? (
          <span className="rounded-full bg-danger-soft px-2 py-0.5 text-xs font-bold text-danger">
            {gateCopy.page.required}
          </span>
        ) : null}
      </span>
      <span
        className={cn(
          "mt-1.5 flex min-h-11 items-center justify-between gap-3 rounded-[var(--control-radius)] px-3 py-2 text-base leading-6",
          required
            ? "border border-signal-held bg-surface text-text-primary"
            : "bg-surface-sunk text-text-primary",
        )}
      >
        <span className="min-w-0">{value}</span>
        {to ? <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden="true" /> : null}
      </span>
    </>
  );
  if (to) {
    return (
      <Link
        to="/production/jobs/$jobId/gates"
        params={{ jobId: to.jobId }}
        search={{ step: to.step }}
        className={cn(
          "block rounded-[var(--control-radius)] focus-visible:outline-offset-2",
          className,
        )}
      >
        {body}
      </Link>
    );
  }
  return <div className={className}>{body}</div>;
}

export function InfoBanner({ children }: { children: string }) {
  return <Notice tone="info" title={children} />;
}

export function ErrorBanner({ children, error }: { children: string; error?: unknown }) {
  return (
    <div>
      <Notice tone="danger" title={children} />
      {error ? <ErrorSystemDetails error={error} /> : null}
    </div>
  );
}

/** The frames' closing line: the consequence the person can't see from the controls. */
export function NextLine({ children }: { children: string }) {
  return (
    <p className="rounded-[var(--radius-card)] border border-border-strong bg-surface px-4 py-3 text-sm font-semibold leading-6 text-text-primary">
      {gateCopy.page.next(children)}
    </p>
  );
}

/** A plain consequence line, for the frames that dropped the "Next:" lead. */
export function ConsequenceLine({ children }: { children: string }) {
  return (
    <p className="rounded-[var(--radius-card)] border border-border-strong bg-surface px-4 py-3 text-sm font-semibold leading-6 text-text-primary">
      {children}
    </p>
  );
}

/** A control that is off until something else happens; its label says what. */
export function HeldButton({ label }: { label: string }) {
  return (
    <Button type="button" variant="secondary" disabled className="whitespace-normal text-left">
      {label}
    </Button>
  );
}

export function ActionRow({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-3">{children}</div>;
}

export function StepLink({
  jobId,
  step,
  variant = "primary",
  children,
}: {
  jobId: string;
  step?: GateStep;
  variant?: "primary" | "secondary";
  children: string;
}) {
  return (
    <Button asChild variant={variant}>
      <Link to="/production/jobs/$jobId/gates" params={{ jobId }} search={step ? { step } : {}}>
        {children}
      </Link>
    </Button>
  );
}

export function BackToList({
  jobId,
  variant = "primary",
}: {
  jobId: string;
  variant?: "primary" | "secondary";
}) {
  return (
    <StepLink jobId={jobId} variant={variant}>
      {gateCopy.page.backToList}
    </StepLink>
  );
}

export function GateSection({ children, label }: { children: ReactNode; label: string }) {
  return (
    <section aria-label={label} className="grid gap-4">
      {children}
    </section>
  );
}
