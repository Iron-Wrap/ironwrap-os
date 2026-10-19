import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReactNode } from "react";
import { compile } from "tailwindcss";
import { afterEach, describe, expect, it } from "vitest";

import { Button } from "../src/components/ui/button";
import { Input } from "../src/components/ui/input";
import { Select } from "../src/components/ui/select";
import { Status } from "../src/components/ui/status";
import { Textarea } from "../src/components/ui/textarea";

// Read from disk: Vitest replaces a CSS import, `?raw` included, with an empty string.
const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tokensCss = readFileSync(resolve(app, "src/styles/tokens.css"), "utf8");
/**
 * The unlayered form-control rules of styles.css: form controls inherit their font, and the
 * base controls set their density's type over it. They outrank every utility in the browser, so
 * they are loaded here as they are written.
 */
const stylesCss = readFileSync(resolve(app, "src/styles.css"), "utf8");
const formControlType = [
  /button,\s*input,\s*textarea,\s*select\s*\{\s*font: inherit;\s*\}/,
  /\.ui-button \{[^}]*\}/,
  /:is\(\.ui-input, \.ui-select, \.ui-textarea\) \{[^}]*\}/,
]
  .map((pattern) => {
    const rule = stylesCss.match(pattern)?.[0];
    if (!rule) throw new Error(`styles.css no longer has ${pattern}`);
    return rule;
  })
  .join("\n");

const densities = ["office", "touch", "glove"] as const;

/**
 * Renders `node` once per density, compiles the Tailwind utilities its elements carry with the
 * real compiler, and loads them over the generated tokens.css with the form-control rules of
 * styles.css, so a computed size here is the one the browser draws.
 */
async function renderInEveryDensity(node: ReactNode) {
  const view = render(
    <>
      {densities.map((density) => (
        <div key={density} data-density={density} data-testid={density}>
          {node}
        </div>
      ))}
    </>,
  );
  const classes = new Set(
    [...view.container.querySelectorAll("[class]")].flatMap((element) => [...element.classList]),
  );
  const compiler = await compile("@tailwind utilities;");
  const style = document.createElement("style");
  // happy-dom drops the rule that follows a bare `@layer name;` statement; the order statement
  // carries nothing a size depends on.
  const utilities = compiler.build([...classes]).replace(/@layer [\w-]+;/g, "");
  style.textContent = `${tokensCss}\n${utilities}\n${formControlType}`;
  document.head.append(style);
  return view;
}

afterEach(() => {
  for (const style of document.head.querySelectorAll("style")) style.remove();
});

const computed = (density: string, selector: string) =>
  getComputedStyle(document.querySelector(`[data-testid="${density}"] ${selector}`) as HTMLElement);

describe("density tokens size the base controls", () => {
  it("raises every button size from the office to touch and glove", async () => {
    await renderInEveryDensity(
      <>
        <Button size="small">Small</Button>
        <Button>Default</Button>
        <Button size="large">Large</Button>
        <Button size="field">Field</Button>
        <Button size="icon" aria-label="Icon" />
      </>,
    );
    const heights = (density: string) =>
      ["small", "default", "large", "field"].map(
        (size) => computed(density, `[data-ui-size="${size}"]`).minHeight,
      );
    expect(heights("office")).toEqual(["24px", "28px", "32px", "32px"]);
    expect(heights("touch")).toEqual(["48px", "48px", "64px", "64px"]);
    expect(heights("glove")).toEqual(["72px", "72px", "72px", "72px"]);
    expect(densities.map((density) => computed(density, '[data-ui-size="icon"]').height)).toEqual([
      "28px",
      "48px",
      "72px",
    ]);
    // Label type and the corner follow the density too.
    expect(densities.map((density) => computed(density, "button").fontSize)).toEqual([
      "13px",
      "16px",
      "20px",
    ]);
    expect(densities.map((density) => computed(density, "button").borderRadius)).toEqual([
      "8px",
      "14px",
      "14px",
    ]);
  });

  it("raises fields, selects and text areas, and their edge width", async () => {
    await renderInEveryDensity(
      <>
        <Input aria-label="Coil" />
        <Select aria-label="Area">
          <option>South eave</option>
        </Select>
        <Select field aria-label="Crew">
          <option>North crew</option>
        </Select>
        <Textarea aria-label="What happened" />
      </>,
    );
    expect(densities.map((density) => computed(density, "input").minHeight)).toEqual([
      "28px",
      "48px",
      "72px",
    ]);
    expect(
      densities.map((density) => computed(density, "select:not([data-ui-size])").minHeight),
    ).toEqual(["28px", "48px", "72px"]);
    expect(
      densities.map((density) => computed(density, 'select[data-ui-size="field"]').minHeight),
    ).toEqual(["32px", "64px", "72px"]);
    // A text area is 72px (`size.72`, the spacing scale) in every density.
    expect(document.querySelector("textarea")).toHaveClass("min-h-18");
    expect(densities.map((density) => computed(density, "input").borderWidth)).toEqual([
      "1px",
      "2px",
      "2px",
    ]);
    expect(densities.map((density) => computed(density, "input").fontSize)).toEqual([
      "13px",
      "16px",
      "20px",
    ]);
  });

  it("sets signal chips in the caption type of the density", async () => {
    await renderInEveryDensity(<Status kind="you">Needs you</Status>);
    expect(densities.map((density) => computed(density, "[data-status]").fontSize)).toEqual([
      "12px",
      "14px",
      "18px",
    ]);
  });
});
