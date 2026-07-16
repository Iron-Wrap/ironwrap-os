import { Link } from "@tanstack/react-router";
import { ClipboardCheck, Hammer, ShieldCheck } from "lucide-react";
import { lazy, Suspense, type ReactNode } from "react";

import { RoleGuard } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/state-panel";

const DevicePairingSettings = lazy(async () => ({
  default: (await import("../pairing/device-pairing-settings")).DevicePairingSettings,
}));

function PlaceholderSurface({
  eyebrow,
  title,
  description,
  emptyTitle,
  emptyMessage,
  icon,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  emptyTitle: string;
  emptyMessage: string;
  icon: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="space-y-8">
      <header className="max-w-3xl">
        <div className="mb-4 flex size-12 items-center justify-center rounded-xl bg-surface-muted text-foreground">
          {icon}
        </div>
        <p className="text-xs font-extrabold uppercase tracking-[0.16em] text-muted">{eyebrow}</p>
        <h1 className="mt-2 text-3xl font-black tracking-[-0.04em] sm:text-4xl">{title}</h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-muted">{description}</p>
      </header>
      <EmptyState title={emptyTitle} message={emptyMessage} action={action} />
    </section>
  );
}

export function TodayPage() {
  return (
    <PlaceholderSurface
      eyebrow="Field and operations"
      title="Today"
      description="Assigned work will be ordered by what is blocked and what must happen next—not by a generic calendar."
      emptyTitle="No assigned work is available"
      emptyMessage="When the live Today read model assigns a job to this role, it will appear here with its location, gate state, and one clear next action. This screen never invents sample jobs."
      icon={<ClipboardCheck className="size-6" aria-hidden="true" />}
    />
  );
}

export function JobPage() {
  return (
    <RoleGuard surface="field">
      <PlaceholderSurface
        eyebrow="Proof Stream"
        title="Job"
        description="This surface will join scope, gates, evidence, and verified actions around one canonical job identity."
        emptyTitle="Job proof is not loaded"
        emptyMessage="The shell is ready, but no live job read model was returned for this route. Return to Today and open an assigned job once the BFF feed is connected."
        icon={<Hammer className="size-6" aria-hidden="true" />}
        action={
          <Button asChild variant="outline">
            <Link to="/today">Return to Today</Link>
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
        eyebrow="Offline-first field proof"
        title="Check-in"
        description="Photos and voice come before typing. Every submit will save on the device before it enters the verified sync queue."
        emptyTitle="Choose an assigned job first"
        emptyMessage="Open a job from Today to begin its check-in. The future stepper will show the exact proof slots and blockers required for that job."
        icon={<ShieldCheck className="size-6" aria-hidden="true" />}
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
    <Suspense fallback={<LoadingState label="Loading crew device controls…" />}>
      <DevicePairingSettings />
    </Suspense>
  );
}

export function NotFoundPage() {
  return (
    <main className="grid min-h-dvh place-items-center p-4">
      <ErrorState
        title="That screen was not found"
        message="The link may be old or incomplete. Return to Today to continue with assigned work."
        onRetry={() => window.location.assign("/today")}
      />
    </main>
  );
}
