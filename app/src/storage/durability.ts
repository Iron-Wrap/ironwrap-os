import { useEffect, useRef, useState } from "react";

export const LOW_STORAGE_HEADROOM_BYTES = 512 * 1024 * 1024;

export interface StorageManagerLike {
  persisted?: () => Promise<boolean>;
  persist?: () => Promise<boolean>;
  estimate?: () => Promise<{ usage?: number; quota?: number }>;
}

export type StorageWarning = "persistence_denied" | "low_storage" | "check_failed";

export interface StorageDurabilityResult {
  checked: true;
  supported: boolean;
  persistent: boolean | null;
  persistenceDenied: boolean;
  usageBytes?: number;
  quotaBytes?: number;
  remainingBytes?: number;
  lowStorage: boolean;
  warning?: StorageWarning;
}

export interface StorageDurabilityPending {
  checked: false;
}

type StartupStorageCheck = {
  promise: Promise<StorageDurabilityResult>;
  result?: StorageDurabilityResult;
};
let startupCheck: StartupStorageCheck | undefined;

/** Start the device check alongside field bootstrap, so its warning can be in the first paint. */
export function primeStorageDurability(
  storage?: StorageManagerLike,
): Promise<StorageDurabilityResult> {
  if (!startupCheck) {
    const check: StartupStorageCheck = { promise: checkStorageDurability(storage) };
    startupCheck = check;
    void check.promise.then((result) => {
      check.result = result;
    });
  }
  return startupCheck.promise;
}

export async function checkStorageDurability(
  storage: StorageManagerLike | null | undefined = typeof navigator === "undefined"
    ? undefined
    : navigator.storage,
): Promise<StorageDurabilityResult> {
  if (!storage) {
    return {
      checked: true,
      supported: false,
      persistent: null,
      persistenceDenied: false,
      lowStorage: false,
    };
  }

  try {
    const initiallyPersistent = storage.persisted ? await storage.persisted() : null;
    let persistent = initiallyPersistent;
    let persistenceDenied = false;
    if (initiallyPersistent === false && storage.persist) {
      persistent = await storage.persist();
      persistenceDenied = persistent === false;
    }

    const estimate = storage.estimate ? await storage.estimate() : {};
    const usageBytes = finiteNonNegative(estimate.usage);
    const quotaBytes = finiteNonNegative(estimate.quota);
    const remainingBytes =
      quotaBytes === undefined
        ? undefined
        : Math.max(0, quotaBytes - (usageBytes === undefined ? 0 : usageBytes));
    const quotaNearlyFull =
      quotaBytes !== undefined &&
      quotaBytes > 0 &&
      usageBytes !== undefined &&
      usageBytes / quotaBytes >= 0.9;
    const lowStorage =
      remainingBytes !== undefined &&
      (remainingBytes < LOW_STORAGE_HEADROOM_BYTES || quotaNearlyFull);
    return {
      checked: true,
      supported: true,
      persistent,
      persistenceDenied,
      ...(usageBytes === undefined ? {} : { usageBytes }),
      ...(quotaBytes === undefined ? {} : { quotaBytes }),
      ...(remainingBytes === undefined ? {} : { remainingBytes }),
      lowStorage,
      ...(lowStorage
        ? { warning: "low_storage" as const }
        : persistenceDenied
          ? { warning: "persistence_denied" as const }
          : {}),
    };
  } catch {
    return {
      checked: true,
      supported: true,
      persistent: null,
      persistenceDenied: false,
      lowStorage: false,
      warning: "check_failed",
    };
  }
}

export function useStorageDurability(): StorageDurabilityPending | StorageDurabilityResult {
  const mountCheck = useRef<Promise<StorageDurabilityResult> | undefined>(undefined);
  const [result, setResult] = useState<StorageDurabilityPending | StorageDurabilityResult>(
    () => startupCheck?.result ?? { checked: false },
  );
  useEffect(() => {
    let active = true;
    const pending = mountCheck.current ?? startupCheck?.promise ?? checkStorageDurability();
    // StrictMode effect replay shares this mount's check; a real remount gets a fresh check.
    mountCheck.current = pending;
    startupCheck = undefined;
    void pending.then((next) => {
      if (active) setResult(next);
    });
    return () => {
      active = false;
    };
  }, []);
  return result;
}

function finiteNonNegative(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}
