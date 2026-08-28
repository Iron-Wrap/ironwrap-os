import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Source-level guards for two acceptance checks the UX spec states as properties of the
 * code rather than of a render: check 8 (reduced motion is honoured through the global
 * tokens, with no per-component duration override) and the safe-area anchoring of the
 * move toast.
 */

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const surfaceDir = resolve(appRoot, "src", "pipeline");

const surfaceFiles = readdirSync(surfaceDir)
  .filter((file) => file.endsWith(".tsx") && !file.endsWith(".test.tsx"))
  .map((file) => ({ file, source: readFileSync(join(surfaceDir, file), "utf8") }));

describe("pipeline board surface family", () => {
  it("has surfaces to check", () => {
    expect(surfaceFiles.map((entry) => entry.file).sort()).toEqual([
      "add-to-board-dialog.tsx",
      "move-menu.tsx",
      "pipeline-board-page.tsx",
      "pipeline-card.tsx",
    ]);
  });

  // `prefers-reduced-motion: reduce` zeroes `--motion-fast` and `--motion-standard`
  // globally in styles.css. That only reaches this surface if no component hardcodes a
  // duration of its own — so the check is "no literal duration here", not "a reduced
  // motion rule here".
  it("hardcodes no animation duration, so the global reduced-motion rule reaches it", () => {
    for (const { file, source } of surfaceFiles) {
      expect(source, `${file} hardcodes a Tailwind duration`).not.toMatch(
        /duration-\[?\d+(?:\.\d+)?m?s\]?/,
      );
      expect(source, `${file} hardcodes a CSS transition-duration`).not.toMatch(
        /transition-duration|animation-duration/,
      );
      expect(source, `${file} hardcodes an animation timing`).not.toMatch(
        /animate-\[[^\]]*\d+(?:\.\d+)?m?s/,
      );
    }
  });

  it("expresses the motion it does use through the shared tokens", () => {
    const combined = surfaceFiles.map((entry) => entry.source).join("\n");
    expect(combined).toMatch(/duration-\[var\(--motion-fast\)\]/);
  });

  it("keeps the reduced-motion rule the surface depends on in place", () => {
    const styles = readFileSync(resolve(appRoot, "src/styles.css"), "utf8");
    expect(styles).toMatch(/prefers-reduced-motion:\s*reduce/);
    expect(styles).toMatch(/--motion-fast:\s*0ms/);
    expect(styles).toMatch(/--motion-standard:\s*0ms/);
  });

  it("anchors the move toast above the mobile bottom nav with the shared safe-area inset", () => {
    const styles = readFileSync(resolve(appRoot, "src/styles.css"), "utf8");
    expect(styles).toMatch(/--safe-bottom-inset:\s*max\(1rem, env\(safe-area-inset-bottom\)\)/);
    expect(styles).toMatch(
      /\.pipeline-move-toast\s*\{\s*bottom:\s*calc\(4\.5rem \+ var\(--safe-bottom-inset\)\)/,
    );
    const page = readFileSync(join(surfaceDir, "pipeline-board-page.tsx"), "utf8");
    expect(page).toMatch(/pipeline-move-toast/);
    expect(page).toMatch(/aria-live="polite"/);
  });
});
