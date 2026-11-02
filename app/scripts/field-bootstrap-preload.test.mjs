import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

const preloadScript = readFileSync(resolve("public/field-bootstrap-preload.js"), "utf8");

describe("field bootstrap preloader", () => {
  it("starts the ordinary preload but leaves read-only local provenance unverified", () => {
    const databases = vi.fn(async () => []);
    const preloadWindow = {
      location: { pathname: "/today" },
      localStorage: {
        getItem: () => "synthetic-existing-generation",
        setItem: () => {
          throw new Error("Synthetic read-only storage");
        },
      },
    };
    runInNewContext(preloadScript, {
      Error,
      Promise,
      indexedDB: { databases },
      window: preloadWindow,
    });
    expect(preloadWindow.__ironwrapFieldBootstrapReadGeneration).toBeNull();
    expect(databases).toHaveBeenCalledOnce();
    expect(preloadWindow).toHaveProperty("__ironwrapFieldBootstrapResponse");
  });

  it("keeps the read-start generation when auth changes during its asynchronous proof read", () => {
    let generation = "synthetic-generation-before";
    const databases = vi.fn(async () => {
      generation = "synthetic-generation-after";
      return [];
    });
    const preloadWindow = {
      location: { pathname: "/today" },
      localStorage: {
        getItem: () => generation,
        setItem: (_key, value) => {
          generation = value;
        },
      },
    };
    runInNewContext(preloadScript, {
      Error,
      Promise,
      crypto: { randomUUID: () => "synthetic-generation-new" },
      indexedDB: { databases },
      window: preloadWindow,
    });
    expect(preloadWindow.__ironwrapFieldBootstrapReadGeneration).toBe(
      "synthetic-generation-before",
    );
    expect(generation).toBe("synthetic-generation-after");
  });

  it.each(["/today", "/now"])("starts the paired-device read at %s", (pathname) => {
    const databases = vi.fn(async () => []);
    const preloadWindow = { location: { pathname } };

    runInNewContext(preloadScript, {
      Error,
      Promise,
      indexedDB: { databases },
      window: preloadWindow,
    });

    expect(databases).toHaveBeenCalledOnce();
    expect(preloadWindow).toHaveProperty("__ironwrapFieldBootstrapResponse");
  });

  it("does not start the field read on an office-only route", () => {
    const databases = vi.fn(async () => []);
    const preloadWindow = { location: { pathname: "/owner" } };

    runInNewContext(preloadScript, {
      Error,
      Promise,
      indexedDB: { databases },
      window: preloadWindow,
    });

    expect(databases).not.toHaveBeenCalled();
    expect(preloadWindow).not.toHaveProperty("__ironwrapFieldBootstrapResponse");
  });

  it("does not publish a stale head read after the entry has claimed bootstrap", () => {
    const databases = vi.fn(async () => []);
    const preloadWindow = {
      location: { pathname: "/today" },
      __ironwrapFieldBootstrapPreloadConsumed: true,
    };

    runInNewContext(preloadScript, {
      Error,
      Promise,
      indexedDB: { databases },
      window: preloadWindow,
    });

    expect(databases).not.toHaveBeenCalled();
    expect(preloadWindow).not.toHaveProperty("__ironwrapFieldBootstrapResponse");
  });
});
