// @vitest-environment node

import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Exercise the dependency the real Workbox/Rollup consumer loads, not a direct import
// that could pass while npm silently installs the vulnerable registry copy elsewhere.
const require = createRequire(import.meta.url);
const workboxRequire = createRequire(require.resolve("workbox-build"));
const resolverRequire = createRequire(workboxRequire.resolve("@rollup/plugin-node-resolve"));
const merge = resolverRequire("deepmerge") as typeof import("../vendor/deepmerge");

function poisoningPayload() {
  return JSON.parse('{"__proto__":{"isAdmin":true},"safe":"kept"}') as Record<string, unknown>;
}

function expectSafeResult(result: Record<string, unknown>) {
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  expect(result.isAdmin).toBeUndefined();
  expect(Object.hasOwn(result, "__proto__")).toBe(false);
  expect(Object.hasOwn(Object.prototype, "isAdmin")).toBe(false);
}

describe("the PWA resolver's patched deepmerge dependency", () => {
  it("resolves the explicit private fork from the installed consumer", () => {
    expect(realpathSync(resolverRequire.resolve("deepmerge"))).toBe(
      fileURLToPath(new URL("../vendor/deepmerge/index.cjs", import.meta.url)),
    );
    expect(resolverRequire("deepmerge/package.json")).toMatchObject({
      name: "@ironwrap/deepmerge",
      version: "4.3.1-ironwrap.1",
      private: true,
    });
  });

  it("rejects prototype poisoning into a null-prototype target", () => {
    const result = merge(Object.create(null), poisoningPayload());
    expectSafeResult(result);
    expect(result.safe).toBe("kept");
  });

  it.each([null, undefined, 0, "", false])(
    "rejects poisoning through a nested placeholder (%s)",
    (placeholder) => {
      const result = merge<Record<string, unknown>>(
        { session: placeholder },
        { session: poisoningPayload() },
      ).session as Record<string, unknown>;
      expectSafeResult(result);
      expect(result.safe).toBe("kept");
    },
  );

  it.each(["target", "source"])("filters an own __proto__ on the %s", (side) => {
    const payload = poisoningPayload();
    const result = side === "target" ? merge(payload, {}) : merge(payload, payload);
    expectSafeResult(result);
    expect(result.safe).toBe("kept");
  });

  it("protects objects cloned inside arrays and merge.all", () => {
    const result = merge.all<{ items: Record<string, unknown>[] }>([
      { items: [poisoningPayload()] },
      { items: [poisoningPayload()] },
    ]);
    expect(result.items).toHaveLength(2);
    for (const item of result.items) expectSafeResult(item);
  });

  it.each(["__proto__", "constructor", "prototype"])(
    "never reads a forbidden %s getter from either input",
    (key) => {
      const hostile = Object.defineProperty({}, key, {
        enumerable: true,
        get() {
          throw new Error("A forbidden key was read");
        },
      });
      expect(merge(hostile, { safe: "kept" })).toEqual({ safe: "kept" });
      expect(merge(Object.create(null), hostile)).toEqual({});
    },
  );

  it("refuses source keys when a proxy's membership check throws", () => {
    const target = new Proxy(
      {},
      {
        has() {
          throw new Error("Cannot inspect membership");
        },
      },
    );
    expect(merge(target, { unsafe: true })).toEqual({});
  });

  it("writes data properties without invoking inherited setters", () => {
    const key = "ironwrapMergeProbe";
    const original = Object.getOwnPropertyDescriptor(Object.prototype, key);
    let called = false;
    Object.defineProperty(Object.prototype, key, {
      configurable: true,
      set() {
        called = true;
      },
    });
    try {
      const result = merge(Object.create(null), { [key]: "kept" });
      expect(called).toBe(false);
      expect(Object.getOwnPropertyDescriptor(result, key)).toEqual({
        value: "kept",
        writable: true,
        enumerable: true,
        configurable: true,
      });
    } finally {
      if (original) Object.defineProperty(Object.prototype, key, original);
      else Reflect.deleteProperty(Object.prototype, key);
    }
  });

  it("preserves recursive merging, array concatenation, symbols and input isolation", () => {
    const symbol = Symbol("synthetic");
    const target = { nested: { left: true }, items: [{ first: true }] };
    const source = { nested: { right: true }, items: [{ second: true }], [symbol]: { value: 1 } };
    const result = merge(target, source);
    expect(result).toEqual({
      nested: { left: true, right: true },
      items: [{ first: true }, { second: true }],
      [symbol]: { value: 1 },
    });
    expect(result.items[0]).not.toBe(target.items[0]);
    expect(result.items[1]).not.toBe(source.items[0]);
    expect(result[symbol]).not.toBe(source[symbol]);
    expect(target.items).toHaveLength(1);
  });

  it("preserves custom array/field merges, clone:false, and special objects", () => {
    const retained = { value: 1 };
    const date = new Date(0);
    const regexp = /synthetic/;
    expect(merge({}, { retained }, { clone: false }).retained).toBe(retained);
    expect(merge({}, { date, regexp })).toEqual({ date, regexp });
    const result = merge(
      { items: ["old"], nested: { left: true } },
      { items: ["new"], nested: { right: true } },
      {
        arrayMerge: (_target, source) => source,
        customMerge: (key) => (key === "nested" ? () => ({ replaced: true }) : undefined),
      },
    );
    expect(result).toEqual({ items: ["new"], nested: { replaced: true } });
  });

  it("retains the actual Rollup resolver's frozen defaults and factory", () => {
    const { DEFAULTS, nodeResolve } = workboxRequire("@rollup/plugin-node-resolve");
    expect(DEFAULTS.extensions).toEqual([".mjs", ".js", ".json", ".node"]);
    expect(DEFAULTS.moduleDirectories).toEqual(["node_modules"]);
    expect(Object.isFrozen(DEFAULTS)).toBe(true);
    expect(Object.isFrozen(DEFAULTS.extensions)).toBe(true);
    expect(nodeResolve({ browser: true }).name).toBe("node-resolve");
  });
});
