import { lazy, Suspense } from "react";

import { ErrorState, LoadingState } from "../components/ui/state-panel";

const DevicePairingSettings = lazy(async () => ({
  default: (await import("../pairing/device-pairing-settings")).DevicePairingSettings,
}));

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
