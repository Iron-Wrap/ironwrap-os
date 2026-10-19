import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath: string) => readFileSync(resolve(root, relativePath), "utf8");
const node = (script: string, ...args: string[]) =>
  execFileSync(process.execPath, [resolve(root, script), ...args], { cwd: root, encoding: "utf8" });

type TokenNode = { $value?: unknown; [key: string]: unknown };
const tokenFile = JSON.parse(read("src/design-system/tokens.json")) as TokenNode;
const tokenAt = (path: string) =>
  path.split(".").reduce<TokenNode>((node, key) => node[key] as TokenNode, tokenFile);
/** A token's office-light value as a lowercase hex, following aliases. */
const officeLight = (path: string): string => {
  const value = tokenAt(path).$value;
  if (typeof value === "string") return officeLight(value.slice(1, -1));
  return (value as { hex: string }).hex.toLowerCase();
};
const themeBlock = /@theme inline \{[\s\S]*?\n\}\n/;
const paper = officeLight("semantic.surface.paper");
const rail = officeLight("semantic.surface.rail");

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
  it("generates the System v2 tokens, proves their contrast, and keeps the shipped faces self-hosted", () => {
    const styles = read("src/styles.css");
    const tokens = read("src/styles/tokens.css");
    const main = read("src/main.tsx");
    const html = read("index.html");
    const vite = read("vite.config.ts");
    const pkg = read("package.json");
    const packagedArchivo = read("node_modules/@fontsource-variable/archivo/wght.css");
    const packagedMartian = read("node_modules/@fontsource-variable/martian-mono/wght.css");

    // tokens.css is exactly what tokens.json generates, and the generator refuses to run
    // unless the contrast proof passes first.
    expect(node("scripts/build-tokens.mjs", "--check")).toMatch(/tokens\.css matches tokens\.json/);
    expect(node("src/design-system/contrast-check.mjs")).toMatch(/0 fail\./);
    expect(styles).toMatch(
      /@import "tailwindcss";\s+@import "\.\/styles\/tokens\.css";\s+@import "\.\/styles\/theme\.css";/,
    );
    expect(tokens).toMatch(/--motion-standard:\s*220ms/);
    expect(tokens).toMatch(/prefers-reduced-motion:\s*reduce/);
    expect(styles).toMatch(/prefers-reduced-motion:\s*reduce/);
    expect(styles).not.toMatch(/Hubot|Inter Variable/);

    // Self-hosted exactly as packaged, except that no face may swap in late and shift a
    // crew phone's layout. Martian Mono sets identifiers only, so it ships latin subsets.
    // (The tokens name Geist; the faces move when the Geist packages do.)
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
    expect(pkg).toMatch(/@fontsource-variable\/archivo/);
    expect(pkg).toMatch(/@fontsource-variable\/martian-mono/);
    expect(pkg).not.toMatch(/@fontsource-variable\/hubot-sans/);
    expect(pkg).not.toMatch(/@fontsource-variable\/inter/);

    // The boot shell, the status bar tint and the install colours are resolved tokens, not
    // literals of their own: paper and rail in office-light.
    const ink = officeLight("semantic.text.primary");
    const allowed = new Set([
      paper,
      rail,
      ink,
      officeLight("semantic.text.secondary"),
      officeLight("semantic.line.strong"),
    ]);
    const boot = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
    for (const [literal] of boot.matchAll(/#[0-9a-f]{6}\b/gi)) {
      expect(allowed, `index.html boot colour ${literal}`).toContain(literal.toLowerCase());
    }
    expect(boot).toMatch(new RegExp(`html\\s*\\{\\s*background:\\s*${paper}`));
    expect(html).toContain(`<meta name="theme-color" content="${rail}" />`);
    expect(vite).toContain(`background_color: "${paper}"`);
    expect(vite).toContain(`theme_color: "${rail}"`);
  });

  it("declares no colour or density token of its own: styles.css only reads the generated ones", () => {
    // A token added by hand would be a second source of truth that `npm run tokens` cannot
    // see. This is the whole list of custom properties styles.css may declare.
    const declared = new Set(
      [
        ...read("src/styles.css")
          .replace(themeBlock, "")
          .matchAll(/^\s*(--[\w-]+):/gm),
      ].map(([, name]) => name),
    );
    expect([...declared].sort()).toEqual(
      [
        "--crew-tabs-h",
        "--crew-w",
        "--environment-body-size",
        "--environment-control-size",
        "--environment-control-type",
        "--header-h",
        "--hole",
        "--inspector-w",
        "--rail-w",
        "--safe-bottom-inset",
        "--tabbar-h",
        "--tag-edge",
        "--tag-fill",
        "--tag-h",
      ].sort(),
    );
  });

  it("maps every System v2 role to a utility named after its property", () => {
    // The mapping is its own file, so the AI parts' stylesheet can read it by reference.
    const theme = read("src/styles/theme.css").match(themeBlock)?.[0] ?? "";
    const roles: string[] = [];
    const walk = (node: TokenNode, path: string[]) => {
      for (const [key, child] of Object.entries(node)) {
        if (key.startsWith("$")) continue;
        if ("$value" in (child as TokenNode)) roles.push([...path, key].join("-"));
        else walk(child as TokenNode, [...path, key]);
      }
    };
    walk(tokenFile.semantic as TokenNode, []);
    expect(roles).toHaveLength(36);
    for (const role of roles) expect(theme).toContain(`--color-${role}: var(--${role});`);

    // Every property the theme reads exists in the generated file.
    const generated = new Set(
      [...read("src/styles/tokens.css").matchAll(/^\s*(--[\w-]+):/gm)].map(([, name]) => name),
    );
    const read_ = [...theme.matchAll(/var\((--[\w-]+)\)/g)].map(([, property]) => property);
    expect(read_.length).toBeGreaterThan(80);
    for (const property of read_)
      expect(generated, `${property} is not generated`).toContain(property);
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

  it("lets Shop reading undo the sr-only clip on the compact Safety label", () => {
    // The office top bar keeps the Safety label for screen readers only below
    // 1101px, and Shop reading shows it again. Tailwind 4's sr-only hides with
    // clip-path, not the retired clip property, so an override that resets only
    // clip leaves the label clipped to nothing on a shop tablet.
    const override = read("src/styles.css").match(
      /\.shell\[data-density="glove"\] \.shell-safety-trigger > span \{[^}]*\}/,
    )?.[0];
    expect(override).toMatch(/clip-path:\s*none;/);
  });

  it("keeps the primary action ink, so brass never reads as an action colour", () => {
    const styles = read("src/styles.css");
    const button = read("src/components/ui/button.tsx");
    expect(styles).not.toMatch(/Mona Sans/);
    expect(button).toMatch(/const primary =\s*"bg-primary /);
    expect(button).toMatch(/accent: primary,/);
    expect(button).not.toMatch(/bg-accent/);
  });
});
