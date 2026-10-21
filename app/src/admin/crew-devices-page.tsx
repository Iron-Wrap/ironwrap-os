import { Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { lazy, Suspense } from "react";

import { LoadingState } from "../components/ui/state-panel";

const DevicePairingSettings = lazy(async () => ({
  default: (await import("../pairing/device-pairing-settings")).DevicePairingSettings,
}));

/**
 * The crew-pairing desk, unchanged, given its own address under the setup list so `/settings` can
 * be the list rather than one of its entries.
 */
export function CrewDevicesPage() {
  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <Link
        to="/settings"
        className="-ml-1 inline-flex min-h-11 items-center gap-1 rounded-md pr-2 text-sm font-bold text-muted hover:text-foreground"
      >
        <ChevronLeft className="size-4" aria-hidden="true" />
        Settings
      </Link>
      <Suspense fallback={<LoadingState label="Loading crew phones…" />}>
        <DevicePairingSettings />
      </Suspense>
    </div>
  );
}
