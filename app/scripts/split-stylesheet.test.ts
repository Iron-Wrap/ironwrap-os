import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";

import { excludeCandidates, utilityClasses } from "./split-stylesheet";

describe("utilityClasses", () => {
  it("reads the candidates of the readable, nested CSS Tailwind hands over", () => {
    const css = `/*! tailwindcss */
@layer base {
  .not-a-utility { color: red; }
}
@layer utilities {
  .hidden {
    display: none;
  }
  .md\\:flex {
    @media (width >= 48rem) {
      display: flex;
    }
  }
  .\\[\\&_svg\\]\\:size-4 {
    & svg {
      width: calc(var(--spacing) * 4);
    }
  }
  .\\32 xl\\:p-4 {
    padding: 1rem;
  }
  .before\\:content-\\[\\'x\\'\\] {
    &::before {
      content: ".not-a-class";
    }
  }
}
.ui-button { font-size: 13px; }
`;
    expect([...utilityClasses(css)].sort()).toEqual(
      ["hidden", "md:flex", "[&_svg]:size-4", "2xl:p-4", "before:content-['x']"].sort(),
    );
  });

  it("reads minified CSS too", () => {
    expect([
      ...utilityClasses(
        "@layer utilities{.flex{display:flex}@media (hover:hover){.hover\\:x:hover{a:b}}}",
      ),
    ]).toEqual(["flex", "hover:x"]);
  });
});

describe("excludeCandidates", () => {
  it("names every candidate once, in order, and leaves out what would break the list", () => {
    expect(excludeCandidates(["flex", "hidden", 'content-["x"]', "[a{b}]:c", "flex"])).toBe(
      '@source not inline("flex hidden");',
    );
    expect(excludeCandidates([])).toBe("");
  });

  it("keeps a second Tailwind root from generating what the first one already has", async () => {
    const shipped = await compile("@layer utilities { @tailwind utilities; }");
    const shippedCss = shipped.build(["hidden", "flex", "px-4"]);
    const split = await compile(
      `@tailwind utilities;\n${excludeCandidates(utilityClasses(shippedCss))}`,
    );
    const splitCss = split.build(["hidden", "grid", "px-4", "inline-flex"]);
    expect([...utilityClasses(`@layer utilities {${splitCss}}`)].sort()).toEqual(
      ["grid", "inline-flex"].sort(),
    );
  });
});

describe("the AI parts' stylesheet", () => {
  it("changes their layout with phone: only, never a breakpoint the shipped stylesheet shares", () => {
    // A breakpoint utility styles.css also generates loads before an AI-only class on the same
    // element and loses to it; `phone:` exists only in the AI stylesheet, so it always comes last.
    const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../src/components/ai");
    const breakpoint = /(?<![\w-])(?:(?:max-)?(?:sm|md|lg|xl|2xl)|(?:min|max)-\[[^\]]*\]|@[\w-]+):/;
    const parts = readdirSync(dir).filter(
      (name) => /\.tsx?$/.test(name) && !name.includes(".test."),
    );
    expect(parts.length).toBeGreaterThan(10);
    for (const part of parts)
      expect(readFileSync(resolve(dir, part), "utf8"), part).not.toMatch(breakpoint);
  });
});
