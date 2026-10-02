import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LOW_STORAGE_HEADROOM_BYTES,
  checkStorageDurability,
  primeStorageDurability,
  useStorageDurability,
} from "./durability";

describe("checkStorageDurability", () => {
  it("requests persistent storage once and reports usable headroom", async () => {
    const persist = vi.fn().mockResolvedValue(true);
    const result = await checkStorageDurability({
      persisted: vi.fn().mockResolvedValue(false),
      persist,
      estimate: vi.fn().mockResolvedValue({
        usage: 100,
        quota: LOW_STORAGE_HEADROOM_BYTES * 4,
      }),
    });

    expect(persist).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      supported: true,
      persistent: true,
      persistenceDenied: false,
      lowStorage: false,
    });
  });

  it("warns without blocking when persistence is denied", async () => {
    const result = await checkStorageDurability({
      persisted: vi.fn().mockResolvedValue(false),
      persist: vi.fn().mockResolvedValue(false),
      estimate: vi.fn().mockResolvedValue({ quota: LOW_STORAGE_HEADROOM_BYTES * 4, usage: 0 }),
    });

    expect(result).toMatchObject({
      persistent: false,
      persistenceDenied: true,
      warning: "persistence_denied",
    });
  });

  it("warns when photo headroom is low", async () => {
    const result = await checkStorageDurability({
      persisted: vi.fn().mockResolvedValue(true),
      estimate: vi.fn().mockResolvedValue({
        quota: LOW_STORAGE_HEADROOM_BYTES,
        usage: LOW_STORAGE_HEADROOM_BYTES - 1,
      }),
    });

    expect(result).toMatchObject({ lowStorage: true, warning: "low_storage", remainingBytes: 1 });
  });

  it("treats an unsupported API as non-blocking", async () => {
    await expect(checkStorageDurability(null)).resolves.toEqual({
      checked: true,
      supported: false,
      persistent: null,
      persistenceDenied: false,
      lowStorage: false,
    });
  });
});

describe("storage durability at first paint", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a completed boot warning on the first render without repeating its storage probe", async () => {
    const persisted = vi.fn().mockResolvedValue(false);
    const persist = vi.fn().mockResolvedValue(false);
    await primeStorageDurability({ persisted, persist });
    const renders: ReturnType<typeof useStorageDurability>[] = [];
    const { unmount } = renderHook(() => {
      const result = useStorageDurability();
      renders.push(result);
      return result;
    });

    expect(renders[0]).toMatchObject({ checked: true, warning: "persistence_denied" });
    expect(persisted).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledOnce();
    unmount();

    // A later shell mount must check again; the first-visit warning is not a permanent cache.
    const next = renderHook(() => useStorageDurability());
    expect(next.result.current).toEqual({ checked: false });
  });

  it("keeps a slow boot check pending without blocking the shell or inventing storage success", async () => {
    let resolvePersisted!: (value: boolean) => void;
    const pending = primeStorageDurability({
      persisted: () => new Promise<boolean>((resolve) => (resolvePersisted = resolve)),
      persist: async () => false,
    });
    const { result } = renderHook(() => useStorageDurability());
    expect(result.current).toEqual({ checked: false });

    await act(async () => {
      resolvePersisted(false);
      await pending;
    });
    expect(result.current).toMatchObject({ checked: true, warning: "persistence_denied" });
  });

  it("reuses a completed check through StrictMode replay and refreshes after a real remount", async () => {
    const storage = {
      persisted: vi.fn().mockResolvedValue(false),
      persist: vi.fn().mockResolvedValue(false),
      estimate: vi.fn().mockResolvedValue({ quota: LOW_STORAGE_HEADROOM_BYTES * 4, usage: 0 }),
    };
    vi.stubGlobal("navigator", { storage });
    await primeStorageDurability();
    const mounted = renderHook(() => useStorageDurability(), { reactStrictMode: true });
    expect(mounted.result.current).toMatchObject({ warning: "persistence_denied" });
    await act(async () => {});
    expect(storage.persisted).toHaveBeenCalledOnce();
    expect(storage.persist).toHaveBeenCalledOnce();
    expect(storage.estimate).toHaveBeenCalledOnce();
    mounted.unmount();

    storage.persisted.mockResolvedValue(true);
    storage.estimate.mockResolvedValue({ quota: LOW_STORAGE_HEADROOM_BYTES, usage: 1 });
    const remounted = renderHook(() => useStorageDurability(), { reactStrictMode: true });
    expect(remounted.result.current).toEqual({ checked: false });
    await act(async () => {});
    expect(remounted.result.current).toMatchObject({
      checked: true,
      persistent: true,
      warning: "low_storage",
    });
    expect(storage.persisted).toHaveBeenCalledTimes(2);
    expect(storage.persist).toHaveBeenCalledOnce();
    expect(storage.estimate).toHaveBeenCalledTimes(2);
  });

  it("keeps the same pending check through StrictMode replay and surfaces its failure", async () => {
    let rejectPersisted!: (reason: Error) => void;
    const storage = {
      persisted: vi
        .fn()
        .mockImplementation(
          () => new Promise<boolean>((_resolve, reject) => (rejectPersisted = reject)),
        ),
      persist: vi.fn().mockResolvedValue(true),
      estimate: vi.fn().mockResolvedValue({ quota: LOW_STORAGE_HEADROOM_BYTES * 4, usage: 0 }),
    };
    vi.stubGlobal("navigator", { storage });
    const pending = primeStorageDurability();
    const { result } = renderHook(() => useStorageDurability(), { reactStrictMode: true });
    expect(result.current).toEqual({ checked: false });
    expect(storage.persisted).toHaveBeenCalledOnce();

    await act(async () => {
      rejectPersisted(new Error("Storage unavailable"));
      await pending;
    });
    expect(result.current).toMatchObject({
      checked: true,
      persistent: null,
      warning: "check_failed",
    });
    expect(storage.persist).not.toHaveBeenCalled();
    expect(storage.estimate).not.toHaveBeenCalled();
  });
});
