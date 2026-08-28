import { useEffect, useSyncExternalStore } from "react";

/**
 * How the surface a user is looking at treats a write made while the device is offline.
 *
 * `queued` is the field default and what the app-wide offline banner has always described: the
 * edit is kept on the device and sent on reconnect. Configuration surfaces are `read_only` — they
 * block the submit and keep nothing, so the queued promise would be a claim the app cannot honour.
 *
 * The banner lives in the app shell, above every route, so a route cannot tell it through context.
 * A mounted surface registers itself here instead, and the banner reads the registration.
 */
export type OfflineWriteMode = "queued" | "read_only";

const listeners = new Set<() => void>();
let readOnlySurfaces = 0;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): OfflineWriteMode {
  return readOnlySurfaces > 0 ? "read_only" : "queued";
}

function emit(): void {
  for (const listener of listeners) listener();
}

/** Declare that this surface discards offline edits rather than queueing them. */
export function useReadOnlyOfflineSurface(): void {
  useEffect(() => {
    readOnlySurfaces += 1;
    emit();
    return () => {
      readOnlySurfaces -= 1;
      emit();
    };
  }, []);
}

export function useOfflineWriteMode(): OfflineWriteMode {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
