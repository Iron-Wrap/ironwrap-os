import { describe, expect, it, vi } from "vitest";

import { LOW_STORAGE_HEADROOM_BYTES, checkStorageDurability } from "./durability";

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
