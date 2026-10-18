import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { generatedTokenNames, pruneUnreadTokens, sourceTokenReads } from "./prune-tokens";

const names = new Set(["--surface-paper", "--text-primary", "--foreground", "--type-body-size"]);

describe("pruneUnreadTokens", () => {
  it("keeps a token something reads and drops one nothing reads", () => {
    const css =
      ":root{--surface-paper:#fbfbfa;--text-primary:#18191b;--type-body-size:13px}" +
      "body{background:var(--surface-paper)}";
    expect(pruneUnreadTokens(css, names, "")).toBe(
      ":root{--surface-paper:#fbfbfa;}body{background:var(--surface-paper)}",
    );
  });

  it("works on the readable CSS Tailwind hands over, not only on minified CSS", () => {
    const css = `:root, [data-mode="office-light"] {
  color-scheme: light;
  --surface-paper: #fbfbfa;
  --text-primary: #18191b;
  --type-body-size: 13px;
}

@media (pointer: coarse) {
  :root:not([data-density]) {
    --type-body-size: 16px;
  }
}

body {
  background: var(--surface-paper);
}
`;
    const pruned = pruneUnreadTokens(css, names, "");
    expect(pruned).toContain("--surface-paper: #fbfbfa;");
    expect(pruned).toContain("color-scheme: light;");
    expect(pruned).not.toContain("--text-primary");
    expect(pruned).not.toContain("--type-body-size");
    expect(pruned).not.toContain("@media (pointer: coarse)");
    expect(pruned).toContain("background: var(--surface-paper);");
  });

  it("counts a read from a script, and from another stylesheet", () => {
    const css = ":root{--text-primary:#18191b;--type-body-size:13px}";
    expect(pruneUnreadTokens(css, names, 'className="x [color:var(--text-primary)]"')).toBe(
      ":root{--text-primary:#18191b;}",
    );
    expect(pruneUnreadTokens(css, names, ".y{font-size:var(--type-body-size)}")).toBe(
      ":root{--type-body-size:13px}",
    );
  });

  it("drops a dead alias and then the token that only it read", () => {
    const css = ":root{--text-primary:#18191b;--foreground:var(--text-primary)}";
    expect(pruneUnreadTokens(css, names, "")).toBe("");
    expect(pruneUnreadTokens(css, names, "a{color:var(--foreground)}")).toBe(css);
  });

  it("never touches a custom property the generator did not write", () => {
    const css = ":root{--tw-ring:0 0 #000;--ui-control-size:2rem;--type-body-size:13px}";
    expect(pruneUnreadTokens(css, names, "")).toBe(
      ":root{--tw-ring:0 0 #000;--ui-control-size:2rem;}",
    );
  });

  it("removes the rules and the media queries it empties, in every mode block", () => {
    const css =
      "@media (pointer:coarse){:root:not([data-density]){--type-body-size:16px}}" +
      '[data-mode="field-sun"]{--surface-paper:#fff;--type-body-size:16px}' +
      '[data-density="glove"]{--type-body-size:20px}';
    expect(pruneUnreadTokens(css, names, "a{background:var(--surface-paper)}")).toBe(
      '[data-mode="field-sun"]{--surface-paper:#fff;}',
    );
  });

  it("keeps an at-rule statement that sits in front of an emptied rule", () => {
    const css = "@layer theme,base;\n:root{--type-body-size:13px}";
    expect(pruneUnreadTokens(css, names, "")).toBe("@layer theme,base;");
  });
});

describe("sourceTokenReads", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("reads other stylesheets and scripts, and skips what only names tokens", () => {
    const src = mkdtempSync(join(tmpdir(), "ironwrap-src-"));
    dirs.push(src);
    for (const dir of ["pages", "styles", "design-system"]) mkdirSync(join(src, dir));
    writeFileSync(join(src, "styles.css"), "@theme inline { --color-x: var(--from-theme-map); }");
    writeFileSync(join(src, "styles/tokens.css"), ":root { --generated: var(--from-generated); }");
    writeFileSync(join(src, "design-system/tokens.json"), '"var(--from-json)"');
    writeFileSync(join(src, "pages/page.css"), ".a { color: var(--from-page-css); }");
    writeFileSync(join(src, "pages/page.tsx"), 'const c = "[color:var(--from-page-tsx)]";');
    writeFileSync(join(src, "pages/page.test.tsx"), 'expect("var(--from-test)")');
    return sourceTokenReads(src).then((text) => {
      expect(text).toContain("--from-page-css");
      expect(text).toContain("--from-page-tsx");
      for (const skipped of ["theme-map", "generated", "json", "test"]) {
        expect(text).not.toContain(`--from-${skipped}`);
      }
    });
  });

  it("finds the raw reads the app's own source makes today", async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const tokens = readFileSync(resolve(root, "src/styles/tokens.css"), "utf8");
    const reads = await sourceTokenReads(resolve(root, "src"));
    const live = [...reads.matchAll(/var\((--[\w-]+)/g)]
      .map((match) => match[1]!)
      .filter((name) => generatedTokenNames(tokens).has(name));
    expect(live).toContain("--border-strong");
    expect(live).toContain("--shadow-floating");
  });
});

describe("the generated file", () => {
  it("lists every token name it wrote, aliases included", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const generated = generatedTokenNames(
      readFileSync(resolve(root, "src/styles/tokens.css"), "utf8"),
    );
    expect(generated.size).toBeGreaterThan(200);
    expect(generated).toContain("--surface-paper");
    expect(generated).toContain("--foreground");
    expect(generated).not.toContain("--tw-ring-color");
  });
});
