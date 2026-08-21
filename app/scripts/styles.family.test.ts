import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath: string) => readFileSync(resolve(root, relativePath), "utf8");

describe("IronWrap OS foundation family", () => {
  it("uses Hubot on mineral paper and dusk chrome, not Inter or cream leftovers", () => {
    const styles = read("src/styles.css");
    const main = read("src/main.tsx");
    const html = read("index.html");
    const vite = read("vite.config.ts");
    const pkg = read("package.json");

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

    expect(main).toMatch(/@fontsource-variable\/hubot-sans/);
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

  it("stays a family of Facet dusk/mineral without cloning Mona Sans", () => {
    const styles = read("src/styles.css");
    expect(styles).not.toMatch(/Mona Sans/);
    expect(styles).toMatch(/Hubot Sans Variable/);
  });
});
