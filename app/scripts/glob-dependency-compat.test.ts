// @vitest-environment node

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const workboxRequire = createRequire(require.resolve("workbox-build"));
const eslintRequire = createRequire(require.resolve("eslint"));
const configArrayRequire = createRequire(eslintRequire.resolve("@eslint/config-array"));
const pluginRequire = createRequire(
  workboxRequire.resolve("@trickfilm400/rollup-plugin-off-main-thread"),
);
const ejsRequire = createRequire(pluginRequire.resolve("ejs"));
const jakeRequire = createRequire(ejsRequire.resolve("jake"));
const filelistRequire = createRequire(jakeRequire.resolve("filelist"));
const directories: string[] = [];

function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "ironwrap-glob-"));
  directories.push(root);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  return root;
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

// The overrides cross dependency majors. Exercise the APIs loaded by the real consumers,
// including filelist's legacy CommonJS .match API and ESLint's partial directory matching.
// Remove overrides only after upstream ranges admit repaired versions and these still pass.
describe("build dependency matching compatibility", () => {
  it("keeps the Workbox precache file selection and revisions", async () => {
    const root = fixture({
      "index.html": "shell",
      "assets/app.js": "script",
      "assets/app.css": "style",
      "assets/font.woff2": "font",
      "assets/icon.svg": "icon",
      "assets/app.js.map": "source map",
      "ignored/skip.js": "excluded",
      ".hidden/skip.js": "hidden",
    });
    const { getManifest } = require("workbox-build") as typeof import("workbox-build");
    const result = await getManifest({
      globDirectory: root,
      globPatterns: ["**/*.{js,css,html,svg,woff2}"],
      globIgnores: ["ignored/**"],
    });
    expect(result.warnings).toEqual([]);
    expect(result.manifestEntries.map(({ url }) => url).sort()).toEqual([
      "assets/app.css",
      "assets/app.js",
      "assets/font.woff2",
      "assets/icon.svg",
      "index.html",
    ]);
    expect(result.manifestEntries.every(({ revision }) => /^[a-f0-9]{32}$/.test(revision!))).toBe(
      true,
    );
    expect(result.count).toBe(5);
    expect(result.size).toBe(24);
  });

  it("keeps ESLint file discovery and ignored-file boundaries", async () => {
    const root = fixture({
      "src/entry.js": "missingValue;",
      "src/nested/helper.cjs": "otherMissingValue;",
      "src/skip.ignored.js": "ignoredMissingValue;",
      "ignored/skip.js": "ignoredMissingValue;",
      "notes.txt": "not JavaScript",
    });
    const { ESLint } = require("eslint") as typeof import("eslint");
    const linter = new ESLint({
      cwd: root,
      overrideConfigFile: true,
      overrideConfig: [
        { ignores: ["ignored/**", "**/*.ignored.js"] },
        { files: ["**/*.{js,cjs}"], rules: { "no-undef": "error" } },
      ],
    });
    const results = await linter.lintFiles(["**/*.{js,cjs}"]);
    expect(
      results.map(({ filePath }) => relative(root, filePath).replaceAll("\\", "/")).sort(),
    ).toEqual(["src/entry.js", "src/nested/helper.cjs"]);
    expect(results.map(({ messages }) => messages.map(({ ruleId }) => ruleId))).toEqual([
      ["no-undef"],
      ["no-undef"],
    ]);
  });

  it("keeps Jake's filelist include and exclude behavior through EJS", () => {
    const root = fixture({
      "src/entry.js": "script",
      "src/nested/helper.js": "script",
      "src/nested/skip.test.js": "test",
      "src/notes.txt": "notes",
    });
    const { FileList } = jakeRequire("filelist");
    const files = new FileList(join(root, "src/**/*.js"));
    files.exclude(join(root, "src/**/*.test.js"));
    expect(
      files
        .toArray()
        .map((file: string) => relative(root, file).replaceAll("\\", "/"))
        .sort(),
    ).toEqual(["src/entry.js", "src/nested/helper.js"]);
  });

  it.each([
    ["ESLint", eslintRequire],
    ["config-array", configArrayRequire],
    ["filelist", filelistRequire],
  ] as const)("bounds globpart amplification in %s's minimatch", (_consumer, consumerRequire) => {
    // GHSA-g3hv-75wg-m249: **/../ preprocessing must honor the expansion bound.
    const { Minimatch } = consumerRequire("minimatch");
    const pattern = Array.from({ length: 8 }, (_, index) => `**/../part${index}`).join("/");
    const matcher = new Minimatch(pattern, { optimizationLevel: 2, braceExpandMax: 16 });
    expect(matcher.set.length).toBeLessThanOrEqual(16);
    expect(matcher.match("unrelated.txt")).toBe(false);
  });
});
