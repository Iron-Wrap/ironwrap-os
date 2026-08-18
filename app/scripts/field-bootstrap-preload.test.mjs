import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

const preloadScript = readFileSync(resolve("public/field-bootstrap-preload.js"), "utf8");

describe("field bootstrap preloader", () => {
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
});
