#!/usr/bin/env node
// Generates src/styles/tokens.css from src/design-system/tokens.json (design/system-v2/PIPELINE.md).
// Zero dependencies. The contrast proof runs first, and a failing proof writes nothing.
//   node scripts/build-tokens.mjs           write src/styles/tokens.css
//   node scripts/build-tokens.mjs --check   exit 1 when the file on disk is not what would be written
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const NS = "com.ironwrap.os";
const at = (path) => fileURLToPath(new URL(path, import.meta.url));
const outPath = at("../src/styles/tokens.css");
const fail = (message) => {
  console.error(`build-tokens: ${message}`);
  process.exit(1);
};

try {
  const proof = execFileSync(process.execPath, [at("../src/design-system/contrast-check.mjs")], {
    encoding: "utf8",
  });
  console.log(proof.trim().split("\n").slice(-2).join("\n"));
} catch (error) {
  console.error(error.stdout || error.message);
  fail("the contrast proof failed, so nothing was written");
}

const tokens = JSON.parse(readFileSync(at("../src/design-system/tokens.json"), "utf8"));
const { axes, defaults, system, compat } = tokens.$extensions[NS];
const get = (path) => path.split(".").reduce((node, key) => node?.[key], tokens);
const isToken = (node) => node !== null && typeof node === "object" && "$value" in node;
const aliasOf = (value) => (typeof value === "string" ? /^\{([^{}]+)\}$/.exec(value)?.[1] : null);

function* walk(node, path = []) {
  for (const [key, child] of Object.entries(node)) {
    if (key.startsWith("$")) continue;
    if (isToken(child)) yield [[...path, key].join("."), child];
    else if (child && typeof child === "object") yield* walk(child, [...path, key]);
  }
}

// The value of a token in one mode, every alias followed. Written into the CSS as a literal:
// a custom property that reads another is substituted where it is declared, so a nested
// data-mode subtree would inherit its parent's value instead of its own.
function resolve(path, mode) {
  const token = get(path);
  if (!isToken(token)) fail(`unknown token ${path}`);
  const raw = token.$extensions?.[NS]?.modes?.[mode] ?? token.$value;
  return aliasOf(raw) ? resolve(aliasOf(raw), mode) : { type: token.$type, raw };
}

const colour = ({ components, hex, alpha = 1 }) =>
  alpha < 1
    ? `rgb(${components.map((c) => Math.round(c * 255)).join(" ")} / ${alpha})`
    : hex.toLowerCase();
const length = ({ value, unit }) => `${value}${unit}`;

function format({ type, raw }, mode) {
  switch (type) {
    case "color":
      return colour(raw);
    case "dimension":
    case "duration":
      return length(raw);
    case "number": // the only number tokens are letter-spacing, stored as em
      return `${raw}em`;
    case "fontFamily":
      return [raw]
        .flat()
        .map((name) => (/\s/.test(name) ? `"${name}"` : name))
        .join(", ");
    case "fontWeight":
      return String(raw);
    case "cubicBezier":
      return `cubic-bezier(${raw.join(", ")})`;
    case "strokeStyle":
      return raw.dashArray.map(length).join(" ");
    case "shadow": {
      const ink = colour(aliasOf(raw.color) ? resolve(aliasOf(raw.color), mode).raw : raw.color);
      const offsets = [raw.offsetX, raw.offsetY, raw.blur, raw.spread].map(length).join(" ");
      return `${raw.inset ? "inset " : ""}${offsets} ${ink}`;
    }
    default:
      return fail(`no CSS form for $type ${type}`);
  }
}

// Naming: the token path without its layer group, dots to hyphens (PIPELINE.md). The same path
// with slashes is the Figma variable name, so no mapping file can drift.
const LAYERS = new Set(["semantic", "density"]);
const nameOf = (path) => {
  const [head, ...rest] = path.split(".");
  return `--${(LAYERS.has(head) ? rest : [head, ...rest]).join("-")}`;
};

// Colour and density tokens plus the constants components read directly. Colour primitives are
// never emitted, so a component cannot reach past a role.
const emitted = [...walk(tokens)].filter(([path]) =>
  /^(semantic|density|font\.family|motion|shadow|brand)\./.test(path),
);
const names = new Map();
for (const [path] of emitted) {
  const name = nameOf(path);
  if (names.has(name)) fail(`${names.get(name)} and ${path} both generate ${name}`);
  names.set(name, path);
}
const aliases = Object.entries(compat?.aliases ?? {});
for (const [name, value] of aliases) {
  if (names.has(name)) fail(`compat alias ${name} collides with a generated token`);
  for (const [, ref] of value.matchAll(/var\((--[\w-]+)\)/g)) {
    if (!names.has(ref)) fail(`compat alias ${name} reads ${ref}, which is not a generated token`);
  }
}

const layer = (head) => emitted.filter(([path]) => path.startsWith(`${head}.`));
const constants = emitted.filter(([path]) => !LAYERS.has(path.split(".")[0]));
const declare = (entries, mode, head = []) =>
  [...head, ...entries.map(([path]) => [nameOf(path), format(resolve(path, mode), mode)])]
    .map(([name, value]) => `  ${name}: ${value};`)
    .join("\n");
const rule = (selector, body) => `${selector} {\n${body}\n}`;
// One query or a list of them, which the media rule joins with commas (any of them matches).
const media = (queries, selector, body) =>
  `@media ${[queries]
    .flat()
    .map((query) => `(${query})`)
    .join(", ")} {\n${rule(selector, body).replace(/^(?=.)/gm, "  ")}\n}`;

// A mode is dark when its paper is.
const scheme = (mode) =>
  resolve("semantic.surface.paper", mode).raw.components[0] < 0.5 ? "dark" : "light";
const colourBody = (mode) => declare(layer("semantic"), mode, [["color-scheme", scheme(mode)]]);
const densityBody = (mode) => declare(layer("density"), mode);

// `defaults` names the :root value of each axis; with no attribute the device decides (`system`).
const rest = (axis, mode, role) => {
  if (!axes[axis].includes(mode)) fail(`${role} ${mode} is not a ${axis} in axes`);
  return axes[axis].filter((other) => other !== mode);
};
const defaultColour = defaults["color-mode"];
const defaultDensity = defaults.density;
const otherColours = rest("color-mode", defaultColour, "default");
const otherDensities = rest("density", defaultDensity, "default");
rest("color-mode", system.dark, "system.dark");
rest("density", system.coarse, "system.coarse");
const still = ["fast", "standard", "seam"].map((name) => `--motion-${name}`);
for (const name of still) if (!names.has(name)) fail(`reduced motion needs ${name}`);

const sections = [
  rule(`:root, [data-mode="${defaultColour}"]`, colourBody(defaultColour)),
  media("prefers-color-scheme: dark", ":root:not([data-mode])", colourBody(system.dark)),
  ...otherColours.map((mode) => rule(`[data-mode="${mode}"]`, colourBody(mode))),
  rule(`:root, [data-density="${defaultDensity}"]`, densityBody(defaultDensity)),
  // A coarse pointer, or an office window 720px wide or narrower, is touch.
  media(
    ["pointer: coarse", "max-width: 720px"],
    ":root:not([data-density])",
    densityBody(system.coarse),
  ),
  ...otherDensities.map((mode) => rule(`[data-density="${mode}"]`, densityBody(mode))),
  rule(":root", declare(constants)),
  media("prefers-reduced-motion: reduce", ":root", still.map((n) => `  ${n}: 0ms;`).join("\n")),
  aliases.length
    ? rule(
        ":is(:root, [data-mode], [data-density])",
        aliases.map(([name, value]) => `  ${name}: ${value};`).join("\n"),
      )
    : "",
].filter(Boolean);

const css = `/* Generated from src/design-system/tokens.json by scripts/build-tokens.mjs. Do not edit. */\n\n${sections.join("\n\n")}\n`;

if (process.argv.includes("--check")) {
  if (!existsSync(outPath) || readFileSync(outPath, "utf8") !== css) {
    fail("src/styles/tokens.css is out of date; run `npm run tokens` and commit the result");
  }
  console.log("tokens.css matches tokens.json");
} else {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, css);
  console.log(
    `wrote src/styles/tokens.css: ${names.size} tokens, ${aliases.length} compat aliases`,
  );
}
