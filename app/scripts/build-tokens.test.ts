import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workdirs: string[] = [];

type Tokens = Record<string, any>;

// The generator finds tokens.json, the proof and its output relative to its own location, so a
// temporary copy of those three files is a complete, disposable pipeline to break on purpose.
function pipeline(edit?: (tokens: Tokens) => void) {
  const dir = mkdtempSync(join(tmpdir(), "ironwrap-tokens-"));
  workdirs.push(dir);
  mkdirSync(join(dir, "scripts"));
  mkdirSync(join(dir, "src/design-system"), { recursive: true });
  cpSync(join(appRoot, "scripts/build-tokens.mjs"), join(dir, "scripts/build-tokens.mjs"));
  cpSync(
    join(appRoot, "src/design-system/contrast-check.mjs"),
    join(dir, "src/design-system/contrast-check.mjs"),
  );
  const source = join(dir, "src/design-system/tokens.json");
  const retoken = (change?: (tokens: Tokens) => void) => {
    const tokens = JSON.parse(readFileSync(join(appRoot, "src/design-system/tokens.json"), "utf8"));
    change?.(tokens);
    writeFileSync(source, JSON.stringify(tokens));
  };
  retoken(edit);
  const out = join(dir, "src/styles/tokens.css");
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [join(dir, "scripts/build-tokens.mjs"), ...args], {
      encoding: "utf8",
    });
  return { out, run, retoken };
}

// Breaks the proof: control edges on the office light ground fall under 3:1.
const faintControlEdge = (tokens: Tokens) => {
  tokens.semantic.control.border.$value = "{color.graphite.205}";
};

afterEach(() => {
  for (const dir of workdirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const generated = readFileSync(join(appRoot, "src/styles/tokens.css"), "utf8");
const blocks = generated.split(/\n\n(?=[:@[])/).slice(1);
const selectorOf = (block: string) => block.slice(0, block.indexOf("{")).trim();

describe("build-tokens", () => {
  it("writes the same file the repository carries, and --check then agrees", () => {
    const { out, run } = pipeline();
    const wrote = run();
    expect(wrote.status, wrote.stderr).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(generated);
    expect(run("--check").status).toBe(0);
  });

  it("fails --check when the file on disk drifts from tokens.json", () => {
    const { out, run } = pipeline();
    run();
    const drifted = readFileSync(out, "utf8").replace("#fbfbfa", "#ffffff");
    writeFileSync(out, drifted);
    const check = run("--check");
    expect(check.status).toBe(1);
    expect(check.stderr).toContain("out of date");
    // A check only reads: the drifted file is left for the author to regenerate.
    expect(readFileSync(out, "utf8")).toBe(drifted);
  });

  it("fails --check when tokens.json changed and the file was not regenerated", () => {
    const { run, retoken } = pipeline();
    run();
    retoken((tokens) => {
      tokens.motion.fast.$value.value = 120;
    });
    const check = run("--check");
    expect(check.status).toBe(1);
    expect(check.stderr).toContain("out of date");
  });

  it("fails --check, and creates nothing, when the file is missing", () => {
    const { out, run } = pipeline();
    const check = run("--check");
    expect(check.status).toBe(1);
    expect(existsSync(out)).toBe(false);
  });

  it("refuses to write when the contrast proof fails", () => {
    const { out, run } = pipeline(faintControlEdge);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("contrast proof failed");
    expect(existsSync(out)).toBe(false);
  });

  it("leaves the last good file untouched when a later edit fails the proof", () => {
    const { out, run, retoken } = pipeline();
    expect(run().status).toBe(0);
    const good = readFileSync(out, "utf8");
    retoken(faintControlEdge);
    for (const args of [[], ["--check"]]) {
      const result = run(...args);
      expect(result.status, args.join(" ")).toBe(1);
      expect(result.stderr).toContain("contrast proof failed");
    }
    expect(readFileSync(out, "utf8")).toBe(good);
  });

  it("fails when two tokens generate the same name", () => {
    const { out, run } = pipeline((tokens) => {
      tokens.semantic["surface-paper"] = { $type: "color", $value: "{color.white}" };
    });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/both generate --surface-paper/);
    expect(existsSync(out)).toBe(false);
  });

  it("fails when a layer-free path generates a layered token's name", () => {
    // `semantic.` and `density.` drop their layer; a top-level group of the same name collides.
    const { out, run } = pipeline((tokens) => {
      tokens.motion["control-height-probe"] = tokens.motion.fast;
      tokens.density.motion = { "control-height-probe": tokens.density.control.height };
    });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/both generate --motion-control-height-probe/);
    expect(existsSync(out)).toBe(false);
  });

  it("fails when a compatibility alias collides with a generated token", () => {
    const { out, run } = pipeline((tokens) => {
      tokens.$extensions["com.ironwrap.os"].compat.aliases["--surface-paper"] =
        "var(--surface-rail)";
    });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--surface-paper collides with a generated token/);
    expect(existsSync(out)).toBe(false);
  });

  it("fails when a compatibility alias reads a property that is not generated", () => {
    const { out, run } = pipeline((tokens) => {
      tokens.$extensions["com.ironwrap.os"].compat.aliases["--legacy"] = "var(--no-such-token)";
    });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--legacy reads --no-such-token/);
    expect(existsSync(out)).toBe(false);
  });

  it("resolves an alias chain to each mode's own literal at build time", () => {
    // probe -> focus.ring -> text.primary, whose primitive differs per mode.
    const { out, run } = pipeline((tokens) => {
      tokens.semantic.focus.probe = { $type: "color", $value: "{semantic.focus.ring}" };
    });
    expect(run().stderr).toBe("");
    const css = readFileSync(out, "utf8");
    const modeBlocks = css
      .split(/\n\n(?=[:@[])/)
      .filter((b) => /\[data-mode=|:not\(\[data-mode/.test(b));
    expect(modeBlocks).toHaveLength(10);
    for (const block of modeBlocks) {
      const ink = block.match(/--text-primary: (#[0-9a-f]{6});/)?.[1];
      expect(ink, block.slice(0, 40)).toBeDefined();
      expect(block).toContain(`--focus-probe: ${ink};`);
      expect(block).not.toContain("var(");
    }
    const probes = new Set(modeBlocks.map((b) => b.match(/--focus-probe: ([^;]+);/)?.[1]));
    expect(probes.size).toBeGreaterThan(1);
  });

  it("puts the declared default of each axis on :root, and fails on one the axis lacks", () => {
    const moved = pipeline((tokens) => {
      tokens.$extensions["com.ironwrap.os"].defaults.density = "touch";
    });
    expect(moved.run().status).toBe(0);
    const css = readFileSync(moved.out, "utf8");
    expect(css).toContain(':root, [data-density="touch"] {');
    expect(css).toContain('\n[data-density="office"] {');

    const { out, run } = pipeline((tokens) => {
      tokens.$extensions["com.ironwrap.os"].defaults["color-mode"] = "office-dusk";
    });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/default office-dusk is not a color-mode in axes/);
    expect(existsSync(out)).toBe(false);
  });

  it("fails when a reduced-motion duration is not a token", () => {
    const { out, run } = pipeline((tokens) => {
      delete tokens.motion.seam;
    });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/reduced motion needs --motion-seam/);
    expect(existsSync(out)).toBe(false);
  });
});

describe("tokens.css", () => {
  const modes = [
    "office-light",
    "office-dark",
    "field-sun",
    "field-night",
    "shop-dark",
    "shop-light",
    "customer-light",
    "customer-dark",
    "customer-sun",
  ];

  it("has one block per colour mode and per density, with the device deciding when nothing is set", () => {
    const selectors = blocks.map(selectorOf);
    expect(selectors).toEqual([
      ':root, [data-mode="office-light"]',
      "@media (prefers-color-scheme: dark)",
      ...modes.slice(1).map((mode) => `[data-mode="${mode}"]`),
      ':root, [data-density="office"]',
      "@media (pointer: coarse)",
      '[data-density="touch"]',
      '[data-density="glove"]',
      ":root",
      "@media (prefers-reduced-motion: reduce)",
      ":is(:root, [data-mode], [data-density])",
    ]);
    expect(blocks[1]).toContain(":root:not([data-mode])");
    expect(blocks[1]).toContain("color-scheme: dark;");
    const scheme = (mode: string) =>
      blocks
        .find((block) => selectorOf(block) === `[data-mode="${mode}"]`)
        ?.match(/color-scheme: (\w+);/)?.[1];
    expect(Object.fromEntries(modes.slice(1).map((mode) => [mode, scheme(mode)]))).toEqual({
      "office-dark": "dark",
      "field-sun": "light",
      "field-night": "dark",
      "shop-dark": "dark",
      "shop-light": "light",
      "customer-light": "light",
      "customer-dark": "dark",
      "customer-sun": "light",
    });
  });

  it("gives every mode block every colour token, resolved to a literal", () => {
    const colourBlocks = blocks.filter((block) => /^(:root, )?\[data-mode=/.test(block));
    expect(colourBlocks).toHaveLength(modes.length);
    const names = (block: string) => [...block.matchAll(/^\s*(--[\w-]+):/gm)].map(([, n]) => n);
    const first = names(colourBlocks[0]!);
    expect(first).toHaveLength(36);
    for (const block of colourBlocks) {
      expect(names(block)).toEqual(first);
      // A custom property that reads another is substituted where it is declared, so a nested
      // data-mode subtree would inherit its parent's value. Tokens are written as literals.
      expect(block).not.toContain("var(");
    }
    const density = blocks.filter((block) => /^(:root, )?\[data-density=/.test(block));
    expect(density).toHaveLength(3);
    const densityNames = names(density[0]!);
    expect(densityNames.length).toBeGreaterThan(0);
    for (const block of density) {
      expect(names(block)).toEqual(densityNames);
      expect(block).not.toContain("var(");
    }
  });

  it("lets the device decide with exactly the named mode's values", () => {
    const body = (block: string) =>
      [...block.matchAll(/^\s*([\w-]+: [^;]+;)$/gm)].map(([, line]) => line).join("\n");
    const named = (selector: string) => blocks.find((b) => selectorOf(b) === selector)!;
    const deviceDark = blocks.find((b) => b.includes(":root:not([data-mode])"))!;
    const deviceCoarse = blocks.find((b) => b.includes(":root:not([data-density])"))!;
    expect(body(deviceDark)).toBe(body(named('[data-mode="office-dark"]')));
    expect(body(deviceCoarse)).toBe(body(named('[data-density="touch"]')));
  });

  it("turns the motion durations off under reduced motion, after the constants it overrides", () => {
    const constants = blocks.findIndex((b) => selectorOf(b) === ":root");
    const reduced = blocks.findIndex((b) =>
      b.startsWith("@media (prefers-reduced-motion: reduce)"),
    );
    expect(constants).toBeGreaterThan(-1);
    expect(reduced).toBeGreaterThan(constants);
    expect(blocks[constants]).toMatch(/--motion-seam: [1-9]\d*ms;/);
    expect(blocks[reduced]).toBe(
      [
        "@media (prefers-reduced-motion: reduce) {",
        "  :root {",
        "    --motion-fast: 0ms;",
        "    --motion-standard: 0ms;",
        "    --motion-seam: 0ms;",
        "  }",
        "}",
      ].join("\n") + (reduced === blocks.length - 1 ? "\n" : ""),
    );
  });

  it("never emits a colour or space primitive, so no component can reach past a role", () => {
    expect(generated).not.toMatch(/^\s*--color-/m);
    expect(generated).not.toMatch(/^\s*--space-\d/m);
    expect(generated).not.toMatch(/^\s*--font-size-\d/m);
  });

  it("carries the owner decisions: ink focus, 16px touch body text, a 48px display reading", () => {
    const block = (selector: string) => blocks.find((b) => selectorOf(b) === selector) ?? "";
    const value = (selector: string, name: string) =>
      block(selector).match(new RegExp(`${name}: ([^;]+);`))?.[1];
    for (const mode of modes) {
      const selector =
        mode === "office-light" ? ':root, [data-mode="office-light"]' : `[data-mode="${mode}"]`;
      expect(value(selector, "--focus-ring"), mode).toBe(value(selector, "--text-primary"));
      expect(value(selector, "--focus-ring"), mode).not.toBe(value(selector, "--signal-you"));
    }
    expect(value('[data-density="touch"]', "--type-body-size")).toBe("16px");
    for (const selector of [
      ':root, [data-density="office"]',
      '[data-density="touch"]',
      '[data-density="glove"]',
    ]) {
      expect(value(selector, "--type-display-reading-size")).toBe("48px");
    }
    expect(value(':root, [data-density="office"]', "--type-body-mono-size")).toBe(
      value(':root, [data-density="office"]', "--type-body-size"),
    );
  });

  it("writes the one-release aliases on every scope and keeps retired roles neutral", () => {
    const aliases = blocks.find(
      (b) => selectorOf(b) === ":is(:root, [data-mode], [data-density])",
    )!;
    expect(aliases).toContain("--foreground: var(--text-primary);");
    expect(aliases).toContain("--danger: var(--signal-held);");
    // Green, amber, info and local, and the brass accent, point at ink or a neutral surface.
    for (const retired of ["ok", "warning", "accent"]) {
      expect(aliases).toMatch(new RegExp(`--${retired}: var\\(--text-primary\\);`));
    }
    for (const retired of ["info", "local"]) {
      expect(aliases).toMatch(new RegExp(`--${retired}: var\\(--text-secondary\\);`));
    }
    expect(aliases).not.toMatch(/--signal-you/);
    expect(aliases).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });
});
