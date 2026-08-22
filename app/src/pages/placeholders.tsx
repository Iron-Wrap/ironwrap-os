import { Link } from "@tanstack/react-router";
import { ClipboardCheck, Hammer, ShieldCheck } from "lucide-react";
import { lazy, Suspense, type ReactNode } from "react";

import { RoleGuard } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/state-panel";

const DevicePairingSettings = lazy(async () => ({
  default: (await import("../pairing/device-pairing-settings")).DevicePairingSettings,
}));

function PlaceholderSurface({
  title,
  description,
  emptyTitle,
  emptyMessage,
  icon,
  action,
}: {
  title: string;
  description: string;
  emptyTitle: string;
  emptyMessage: string;
  icon: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="mx-auto max-w-7xl space-y-6 pb-4">
      <Card className="overflow-hidden">
        <header className="min-w-0 p-5 sm:p-7 lg:p-8">
          <div className="flex min-w-0 items-start gap-4">
            <span className="grid size-12 shrink-0 place-items-center rounded-lg bg-foreground text-background shadow-sm">
              {icon}
            </span>
            <div className="min-w-0">
              <h1 className="mt-1 text-3xl font-black tracking-[-0.035em] text-balance sm:text-4xl">
                {title}
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted sm:text-base">
                {description}
              </p>
            </div>
          </div>
        </header>
      </Card>
      <EmptyState title={emptyTitle} message={emptyMessage} action={action} />
    </section>
  );
}

export function TodayPage() {
  return (
    <PlaceholderSurface
      title="Today"
      description="Work assigned to you shows here. Stopped jobs come first, then what to do next."
      emptyTitle="No work assigned yet"
      emptyMessage="When the office assigns a job to you, it will show here with the place and the next step. This screen never makes up jobs."
      icon={<ClipboardCheck className="size-6 text-accent" aria-hidden="true" />}
    />
  );
}

export function JobPage() {
  return (
    <RoleGuard surface="field">
      <PlaceholderSurface
        title="Job"
        description="This screen will show the plan, proof, and next step for one job."
        emptyTitle="This job did not load"
        emptyMessage="Nothing on this job changed. Go back to Today and open an assigned job."
        icon={<Hammer className="size-6 text-accent" aria-hidden="true" />}
        action={
          <Button asChild variant="outline">
            <Link to="/today">Back to Today</Link>
          </Button>
        }
      />
    </RoleGuard>
  );
}

export function CheckInPage() {
  return (
    <RoleGuard surface="field">
      <PlaceholderSurface
        title="Check-in"
        description="Photos and voice come before typing. Each save stays on this phone until it can send."
        emptyTitle="Choose a job first"
        emptyMessage="Open a job from Today to start check-in. The next screen will show the exact photos and notes this job needs."
        icon={<ShieldCheck className="size-6 text-accent" aria-hidden="true" />}
        action={
          <Button asChild variant="accent">
            <Link to="/today">Open Today</Link>
          </Button>
        }
      />
    </RoleGuard>
  );
}

export function SettingsPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading device setup…" />}>
      <DevicePairingSettings />
    </Suspense>
  );
}

export function NotFoundPage() {
  return (
    <main className="grid min-h-dvh place-items-center bg-chrome p-4">
      <div className="w-full max-w-lg border border-chrome-border bg-surface p-6 text-foreground">
        <ErrorState
          title="That screen was not found"
          message="The link may be old or incomplete. Go back to your work list."
          onRetry={() => window.location.assign("/now")}
        />
      </div>
    </main>
  );
}
