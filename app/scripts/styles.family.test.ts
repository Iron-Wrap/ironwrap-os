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
      asset: properties.src?.match(/(?:archivo|martian-mono)-[\w-]+\.woff2/)?.[0],
      format: properties.src?.match(/format\(["']?([^"')]+)["']?\)/)?.[1],
      unicodeRange: properties["unicode-range"]?.replace(/\s+/g, ""),
    };
  });

describe("IronWrap OS foundation family", () => {
  it("uses the Iron Wrap identity: Archivo on primer, a charcoal spine, brass only for place", () => {
    const styles = read("src/styles.css");
    const main = read("src/main.tsx");
    const html = read("index.html");
    const vite = read("vite.config.ts");
    const pkg = read("package.json");
    const packagedArchivo = read("node_modules/@fontsource-variable/archivo/wght.css");
    const packagedMartian = read("node_modules/@fontsource-variable/martian-mono/wght.css");

    // Owner-approved values from the reference implementation's tokens.css.
    expect(styles).toMatch(/--background:\s*#f3f4f2/i);
    expect(styles).toMatch(/--surface:\s*#ffffff/i);
    expect(styles).toMatch(/--foreground:\s*#15181c/i);
    expect(styles).toMatch(/--primary:\s*#15181c/i);
    expect(styles).toMatch(/--chrome:\s*#1b1e22/i);
    expect(styles).toMatch(/--accent:\s*#87651c/i);
    expect(styles).toMatch(/--focus:\s*#87651c/i);
    expect(styles).toMatch(/--local:\s*#5a4a8b/i);
    expect(styles).toMatch(/--tag-metal-fill:/);
    expect(styles).toMatch(/--tag-paper-fill:/);
    expect(styles).toMatch(/--motion-standard:\s*220ms/);
    expect(styles).toMatch(/prefers-reduced-motion:\s*reduce/);
    expect(styles).not.toMatch(/Hubot|Inter Variable/);
    expect(styles).not.toMatch(/#c81d25|#161b21|#e6e8eb/i);
    expect(styles).not.toMatch(/#f2efe8/i);
    expect(styles).not.toMatch(/#fffdf9/i);

    // Self-hosted exactly as packaged, except that no face may swap in late and shift a
    // crew phone's layout. Martian Mono sets identifiers only, so it ships latin subsets.
    const optional = (face: ReturnType<typeof fontFaces>[number]) => ({
      ...face,
      display: "optional",
    });
    expect(fontFaces(styles)).toEqual([
      ...fontFaces(packagedArchivo).map(optional),
      ...fontFaces(packagedMartian)
        .filter((face) => /martian-mono-latin(?:-ext)?-wght/.test(face.asset ?? ""))
        .map(optional),
    ]);
    expect(main).not.toMatch(/@fontsource-variable\//);

    expect(html).toMatch(/content="#1b1e22"/);
    expect(html).toMatch(/Archivo/);
    expect(html).toMatch(/background:\s*#f3f4f2/);
    expect(html).not.toMatch(/Hubot|#161b21|#e6e8eb|#f5f6f4|#121611/);

    expect(vite).toMatch(/theme_color:\s*"#1b1e22"/);
    expect(vite).toMatch(/background_color:\s*"#f3f4f2"/);

    expect(pkg).toMatch(/@fontsource-variable\/archivo/);
    expect(pkg).toMatch(/@fontsource-variable\/martian-mono/);
    expect(pkg).not.toMatch(/@fontsource-variable\/hubot-sans/);
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

  it("asks for a wrap style without also dictating the wrap mode", () => {
    // `white-space: nowrap` - what Tailwind's `truncate` sets - is shorthand
    // for white-space-collapse plus text-wrap-mode. A global `text-wrap:
    // pretty` therefore won on text-wrap-mode and turned every truncating <p>
    // and <li> in the app back into a wrapping one: the shell header rendered
    // a normal-length tenant name over three lines instead of ellipsing it.
    // These rules only ever meant "when this wraps, wrap well".
    const styles = read("src/styles.css");
    expect(styles).not.toMatch(/(^|[\s;{])text-wrap:\s/m);
    expect(styles).toMatch(/text-wrap-style:\s*balance/);
    expect(styles).toMatch(/text-wrap-style:\s*pretty/);
  });

  it("keeps the primary action ink, so brass never reads as an action colour", () => {
    const styles = read("src/styles.css");
    const button = read("src/components/ui/button.tsx");
    expect(styles).not.toMatch(/Mona Sans/);
    expect(button).toMatch(/const primary =\s*"bg-primary /);
    expect(button).toMatch(/accent: primary,/);
    expect(button).not.toMatch(/bg-accent/);
  });

  const tokensIn = (selector: string): Record<string, string> => {
    const styles = read("src/styles.css");
    const start = styles.indexOf(`${selector} {`);
    if (start < 0) throw new Error(`Missing token scope: ${selector}`);
    const block = styles.slice(start, styles.indexOf("}", start));
    return Object.fromEntries(
      [...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [
        name,
        value?.trim(),
      ]),
    );
  };

  const resolveToken = (tokens: Record<string, string>, name: string): string => {
    const value = tokens[name];
    if (!value) throw new Error(`Missing color token: ${name}`);
    const alias = value.match(/^var\(--([\w-]+)\)$/)?.[1];
    return alias ? resolveToken(tokens, alias) : value;
  };

  const luminance = (hex: string) => {
    if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`Expected a solid sRGB color: ${hex}`);
    const channels = hex
      .slice(1)
      .match(/../g)!
      .map((part) => {
        const value = Number.parseInt(part, 16) / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
    return channels.reduce(
      (total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index]!,
      0,
    );
  };

  const contrast = (tokens: Record<string, string>, foreground: string, background: string) => {
    const a = luminance(resolveToken(tokens, foreground));
    const b = luminance(resolveToken(tokens, background));
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };

  const surfaces = [
    "background",
    "surface",
    "surface-raised",
    "surface-muted",
    "surface-sunk",
    "surface-hover",
  ];

  it("qualifies resting and hover control edges plus small brass text on every office ground", () => {
    const light = tokensIn(":root");
    const dark = { ...light, ...tokensIn(':root[data-theme="dark"]') };
    expect(tokensIn(':root:not([data-theme="light"])')).toEqual(
      tokensIn(':root[data-theme="dark"]'),
    );
    for (const [scheme, tokens] of [
      ["light", light],
      ["dark", dark],
    ] as const) {
      for (const surface of surfaces) {
        for (const edge of ["border-control", "border-strong"]) {
          expect(
            contrast(tokens, edge, surface),
            `${scheme} ${edge} on ${surface}`,
          ).toBeGreaterThanOrEqual(3);
        }
        expect(
          contrast(tokens, "accent", surface),
          `${scheme} brass on ${surface}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps Sun and Shop text and status receipts at 7:1 across their scoped surfaces", () => {
    const light = tokensIn(":root");
    const tags = tokensIn(':is(:root, [data-environment="field-sun"], [data-environment="shop"])');
    for (const environment of ["field-sun", "shop"]) {
      const tokens = { ...light, ...tokensIn(`[data-environment="${environment}"]`), ...tags };
      for (const surface of surfaces) {
        for (const text of ["foreground", "muted", "faint", "accent"]) {
          expect(
            contrast(tokens, text, surface),
            `${environment} ${text} on ${surface}`,
          ).toBeGreaterThanOrEqual(7);
        }
        expect(
          contrast(tokens, "border-control", surface),
          `${environment} control on ${surface}`,
        ).toBeGreaterThanOrEqual(3);
      }
      for (const kind of ["ok", "warning", "danger", "info", "local", "neutral"]) {
        expect(
          contrast(tokens, kind, `${kind}-soft`),
          `${environment} ${kind} status`,
        ).toBeGreaterThanOrEqual(7);
      }
      for (const kind of ["metal", "paper", "case", "supply", "record", "asset"]) {
        expect(
          contrast(tokens, `tag-${kind}-text`, `tag-${kind}-fill`),
          `${environment} ${kind} tag`,
        ).toBeGreaterThanOrEqual(7);
      }
      expect(contrast(tokens, "primary-foreground", "primary")).toBeGreaterThanOrEqual(7);
      expect(contrast(tokens, "danger-strong-foreground", "danger-strong")).toBeGreaterThanOrEqual(
        7,
      );
    }
  });
});
