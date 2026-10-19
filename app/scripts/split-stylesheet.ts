/**
 * The AI parts' stylesheet (src/components/ai/ai.css) is a Tailwind root of its own, split into the
 * lazy chunk of the first screen that imports one, so the render-blocking styles.css never carries
 * those utilities. A utility both roots generated would arrive twice, and the copy that loads later
 * would outrank the shipped stylesheet's own variants in the same layer: a later `.hidden` beats an
 * earlier `md:flex`, and the app's responsive layouts would break once any AI part loaded. So the
 * split stylesheet leaves out every utility styles.css already generates, and each utility lives in
 * exactly one stylesheet.
 */

/** A CSS identifier with its escapes, as Tailwind writes a class name into a selector. */
const CLASS_NAME = /\.((?:[\w-]|\\[0-9a-fA-F]{1,6}\s?|\\[^\n0-9a-fA-F])+)/g;

const unescape = (name: string) =>
  name.replace(/\\(?:([0-9a-fA-F]{1,6})\s?|([^\n]))/g, (_escape, hex?: string, char?: string) =>
    hex ? String.fromCodePoint(Number.parseInt(hex, 16)) : (char ?? ""),
  );

/**
 * Every class name in the selectors of a compiled stylesheet's utilities layer: the candidates
 * Tailwind generated. It reads the readable, nested CSS Tailwind hands over as well as minified
 * CSS. A selector's other names (`group` in a `group-hover:` rule) come along; they generate no
 * utility of their own, so leaving them out of another stylesheet changes nothing.
 */
export function utilityClasses(css: string): Set<string> {
  const classes = new Set<string>();
  const open: string[] = [];
  let prelude = "";
  for (let index = 0; index < css.length; index++) {
    const char = css[index]!;
    if (char === "/" && css[index + 1] === "*") {
      const end = css.indexOf("*/", index + 2);
      index = end === -1 ? css.length : end + 1;
      continue;
    }
    if (char === "\\") {
      prelude += css.slice(index, index + 2);
      index++;
      continue;
    }
    if (char === '"' || char === "'") {
      let end = index + 1;
      while (end < css.length && css[end] !== char) end += css[end] === "\\" ? 2 : 1;
      prelude += css.slice(index, end + 1);
      index = end;
      continue;
    }
    if (char === "{") {
      const head = prelude.trim();
      if (!head.startsWith("@") && open.includes("@layer utilities"))
        for (const [, name] of head.matchAll(CLASS_NAME)) classes.add(unescape(name!));
      open.push(head);
      prelude = "";
    } else if (char === "}") {
      open.pop();
      prelude = "";
    } else if (char === ";") prelude = "";
    else prelude += char;
  }
  return classes;
}

/**
 * The line that keeps a Tailwind root from generating these candidates again. Tailwind splits the
 * list on spaces and expands braces, so a candidate that a quote, a backslash or a brace would break
 * stays out of the list and would come twice; nothing in the app writes one.
 */
export function excludeCandidates(candidates: Iterable<string>): string {
  const safe = [...new Set(candidates)].filter((candidate) => !/["\\{}\s;]/.test(candidate)).sort();
  return safe.length ? `@source not inline("${safe.join(" ")}");` : "";
}
