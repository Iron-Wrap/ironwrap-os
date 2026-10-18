import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * `src/styles/tokens.css` carries every token, as the generator promises, but the stylesheet is
 * render-blocking and the paired-device first paint waits for every byte of it: the generated
 * file alone costs about 2.6 KB brotli, and on that profile roughly 1 KB of stylesheet is 50 ms
 * of first paint against a budget with tens of milliseconds of headroom. A custom property that
 * nothing reads costs those bytes for nothing.
 *
 * So the production build drops each token declaration that no `var(--name)` reads. It repeats
 * until nothing more falls out, because a dead compatibility alias is the only reader of the
 * token it points at. A token becomes live the moment a utility, a stylesheet or a script reads
 * it; there is no list to maintain. Only names the generator wrote are touched, never Tailwind's
 * or a component's own variables.
 */
export function pruneUnreadTokens(
  css: string,
  tokenNames: ReadonlySet<string>,
  otherSources: string,
): string {
  let out = css;
  for (;;) {
    const reads = new Set(
      [...`${out}\n${otherSources}`.matchAll(/var\((--[\w-]+)/g)].map((match) => match[1]),
    );
    let removed = false;
    // The lookbehind keeps the separator, so neighbouring declarations go in one pass.
    out = out.replace(
      /(?<=[{;]\s*)(--[\w-]+)\s*:[^;{}]*(?:;|(?=\s*}))/g,
      (declaration, name: string) => {
        if (!tokenNames.has(name) || reads.has(name)) return declaration;
        removed = true;
        return "";
      },
    );
    if (!removed) break;
  }
  // Rules that lost their last declaration, innermost first (@media around an emptied rule).
  while (/\{\s*\}/.test(out)) out = out.replace(/[^{};]*\{\s*\}/g, "");
  return out;
}

/** Every custom property the generator wrote into tokens.css. */
export function generatedTokenNames(tokensCss: string): Set<string> {
  return new Set([...tokensCss.matchAll(/^\s*(--[\w-]+):/gm)].map((match) => match[1]!));
}

/**
 * The text a token can be read from outside the stylesheet being pruned: every other stylesheet
 * and script under `src`. Not the generated file, the design-system sources or the tests, which
 * name tokens without reading them. Reading it from source rather than from the bundle keeps the
 * pruned stylesheet a pure function of the source tree, so its content hash still says what is
 * in it.
 */
export async function sourceTokenReads(srcDir: string): Promise<string> {
  const text: string[] = [];
  for (const entry of await readdir(srcDir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !/\.(?:css|tsx?)$/.test(entry.name)) continue;
    if (/\.test\.tsx?$/.test(entry.name)) continue;
    const path = join(entry.parentPath, entry.name);
    const relative = path.slice(srcDir.length + 1).replaceAll("\\", "/");
    if (relative === "styles.css" || relative === "styles/tokens.css") continue;
    if (relative.startsWith("design-system/")) continue;
    text.push(await readFile(path, "utf8"));
  }
  return text.join("\n");
}
