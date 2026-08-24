import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath: string) => readFileSync(resolve(root, relativePath), "utf8");

const fontFaces = (css: string) =>
  (css.match(/@font-face\s*\{[^}]+\}/g) ?? []).map((block) => {
    const properties = Object.fromEntries(
      [...block.matchAll(/^\s*([\w-]+):\s*([^;]+);/gm)].map(([, name, value]) => [
        name,
        value?.replace(/\s+/g, " ").trim(),
      ]),
    );
    return {
      family: properties["font-family"]?.replace(/["']/g, ""),
      style: properties["font-style"],
      display: properties["font-display"],
      weight: properties["font-weight"],
      asset: properties.src?.match(/hubot-sans-[\w-]+\.woff2/)?.[0],
      format: properties.src?.match(/format\(["']?([^"')]+)["']?\)/)?.[1],
      unicodeRange: properties["unicode-range"]?.replace(/\s+/g, ""),
    };
  });

describe("IronWrap OS foundation family", () => {
  it("uses Hubot on mineral paper and dusk chrome, not Inter or cream leftovers", () => {
    const styles = read("src/styles.css");
    const main = read("src/main.tsx");
    const html = read("index.html");
    const vite = read("vite.config.ts");
    const pkg = read("package.json");
    const packagedHubot = read("node_modules/@fontsource-variable/hubot-sans/index.css");

    expect(styles).toMatch(/Hubot Sans/);
    expect(styles).toMatch(/--chrome:\s*#161b21/i);
    expect(styles).toMatch(/--background:\s*#e6e8eb/i);
    expect(styles).toMatch(/--surface:\s*#f5f6f7/i);
    expect(styles).toMatch(/--accent:\s*#c81d25/i);
    expect(styles).toMatch(/--motion-standard:\s*220ms/);
    expect(styles).toMatch(/prefers-reduced-motion:\s*reduce/);
    expect(styles).not.toMatch(/Inter Variable/);
    expect(styles).not.toMatch(/#f2efe8/i);
    expect(styles).not.toMatch(/#fffdf9/i);

    expect(fontFaces(styles)).toEqual(
      fontFaces(packagedHubot).map((face) => ({ ...face, display: "optional" })),
    );
    expect(main).not.toMatch(/@fontsource-variable\/hubot-sans/);
    expect(main).not.toMatch(/@fontsource-variable\/inter/);

    expect(html).toMatch(/content="#161b21"/);
    expect(html).toMatch(/Hubot Sans/);
    expect(html).toMatch(/background:\s*#e6e8eb/);
    expect(html).not.toMatch(/#f5f6f4|#121611/);

    expect(vite).toMatch(/theme_color:\s*"#161b21"/);
    expect(vite).toMatch(/background_color:\s*"#e6e8eb"/);

    expect(pkg).toMatch(/@fontsource-variable\/hubot-sans/);
    expect(pkg).not.toMatch(/@fontsource-variable\/inter/);
  });

  // The three rules below were each stated in the accepted family language and
  // each drifted back anyway, because the guards that existed pinned literal
  // values instead of the pattern. `desks.family.test.ts` and
  // `leftover.family.test.ts` banned `uppercase tracking-[0.14em]` and
  // `[0.16em]` by name — so twenty-five kickers shipped at 0.08, 0.09, 0.1,
  // 0.12 and `tracking-wide`, every one of them passing CI. Ban the shape.
  const surfaceFiles = (directory: string): string[] =>
    readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap((entry) => {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) return surfaceFiles(path);
      if (!entry.name.endsWith(".tsx") && !entry.name.endsWith(".ts")) return [];
      if (entry.name.includes(".test.") || entry.name.includes(".family.")) return [];
      return [path];
    });

  const offenders = (pattern: RegExp) =>
    surfaceFiles("src")
      .map((path) => ({ path, hits: read(path).match(pattern)?.length ?? 0 }))
      .filter((file) => file.hits > 0)
      .map((file) => `${file.path} (${file.hits})`);

  it("has retired the uppercase kicker family-wide, at every tracking value", () => {
    // Sentence case everywhere. A label that needs letter-spacing to be legible
    // is a label set in the wrong case.
    expect(offenders(/\buppercase\b/g)).toEqual([]);
  });

  it("paints opaque plates instead of glass", () => {
    // A blurred translucent plate reads as a different material from the one
    // beside it and costs a GPU layer to say nothing.
    expect(offenders(/\bbackdrop-blur\b/g)).toEqual([]);
  });

  it("never sets interface text below the 12px floor", () => {
    // 0.625rem and 0.6875rem shipped on pipeline cards and, worse, on the
    // phone's bottom navigation — the labels a crew reads on a roof.
    expect(offenders(/text-\[(?:0\.(?:[0-6]\d*|7[0-4]\d*)rem|(?:[0-9]|10|11)px)\]/g)).toEqual([]);
  });

  it("routes every animation through the motion tokens so reduced-motion reaches it", () => {
    // pipeline-surface.family.test.ts pins this for the board. The rule is
    // family-wide: a hardcoded duration is a transition prefers-reduced-motion
    // cannot switch off. Applied to all of src it caught exactly one place -
    // the base button recipe, which is every button in the product.
    expect(offenders(/duration-\[?\d+(?:\.\d+)?m?s\]?/g)).toEqual([]);
    expect(offenders(/transition-duration:\s*\d/g)).toEqual([]);
  });

  it("stays a family of Facet dusk/mineral without cloning Mona Sans", () => {
    const styles = read("src/styles.css");
    expect(styles).not.toMatch(/Mona Sans/);
    expect(styles).toMatch(/Hubot Sans Variable/);
  });
});
