#!/usr/bin/env node
// Contrast proof for IronWrap OS System v2. Zero dependencies.
// Reads tokens.json beside this file, resolves aliases per colour mode, and checks every pair
// declared in $extensions["com.ironwrap.os"].contrast.pairs with WCAG 2.1 relative luminance.
// Also checks structure: every moded token lists exactly the other modes of its axis, every alias
// resolves in every mode, and every colour literal's hex matches its components.
// Usage: node contrast-check.mjs            (exit 1 on any failure)
import { readFileSync } from "node:fs";

const NS = "com.ironwrap.os";
const tokens = JSON.parse(readFileSync(new URL("./tokens.json", import.meta.url), "utf8"));
const meta = tokens.$extensions[NS];
const { axes, contrast } = meta;
const LAYER_AXIS = { semantic: "color-mode", density: "density" };

const isToken = (node) => node !== null && typeof node === "object" && "$value" in node;
const get = (path) => path.split(".").reduce((node, key) => node?.[key], tokens);
const modesOf = (token) => token.$extensions?.[NS]?.modes;
const isAlias = (value) => typeof value === "string" && /^\{[^{}]+\}$/.test(value);

function* walk(node, path = []) {
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("$")) continue;
    const next = [...path, key];
    if (isToken(value)) yield [next.join("."), value];
    else if (value && typeof value === "object") yield* walk(value, next);
  }
}

function resolve(path, mode, seen = []) {
  const token = get(path);
  if (!isToken(token)) throw new Error(`unknown token ${path}${seen.length ? ` (via ${seen.join(" -> ")})` : ""}`);
  if (seen.includes(path)) throw new Error(`alias cycle ${[...seen, path].join(" -> ")}`);
  const raw = modesOf(token)?.[mode] ?? token.$value;
  return isAlias(raw) ? resolve(raw.slice(1, -1), mode, [...seen, path]) : { type: token.$type, value: raw };
}

const hexToRgb = (hex) => hex.slice(1, 7).match(/../g).map((part) => parseInt(part, 16) / 255);
const toHex = (rgb) => "#" + rgb.map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
const colour = (path, mode) => {
  const { type, value } = resolve(path, mode);
  if (type !== "color") throw new Error(`${path} is ${type}, not color`);
  if (typeof value === "string") return { rgb: hexToRgb(value), alpha: 1 };
  return { rgb: value.components, alpha: value.alpha ?? 1 };
};
const over = (top, under) => top.rgb.map((c, i) => c * top.alpha + under[i] * (1 - top.alpha));
const luminance = (rgb) =>
  rgb
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// ---- structure ----
const problems = [];
for (const [path, token] of walk(tokens)) {
  const axis = LAYER_AXIS[path.split(".")[0]];
  const modes = modesOf(token);
  if (modes && !axis) problems.push(`${path}: primitives take no modes`);
  if (modes && axis) {
    const want = axes[axis].slice(1).join(", ");
    const got = Object.keys(modes).join(", ");
    if (want !== got) problems.push(`${path}: modes [${got}] should be [${want}]`);
  }
  for (const mode of axis ? axes[axis] : [undefined]) {
    try {
      resolve(path, mode);
    } catch (error) {
      problems.push(`${path}${mode ? ` (${mode})` : ""}: ${error.message}`);
    }
  }
  if (typeof token.$value === "object") {
    // References nested inside composite values, e.g. a shadow's colour.
    for (const ref of JSON.stringify(token.$value).match(/"\{[^{}"]+\}"/g) ?? []) {
      if (!isToken(get(ref.slice(2, -2)))) problems.push(`${path}: unknown reference ${ref}`);
    }
  }
  if (token.$type === "color" && typeof token.$value === "object" && !isAlias(token.$value)) {
    const { components, hex } = token.$value;
    if (hex && toHex(components) !== hex.toUpperCase()) problems.push(`${path}: hex ${hex} does not match components (${toHex(components)})`);
  }
}

// ---- contrast ----
const minimumFor = (pair, mode) =>
  contrast.overrides.reduce((min, rule) => {
    const applies =
      rule.modes.includes(mode) && ((rule.kinds && rule.kinds.includes(pair.kind)) || (rule.fg && rule.fg.includes(pair.fg)));
    return applies ? Math.max(min, rule.minimum) : min;
  }, contrast.minimum[pair.kind]);

const lines = [];
let checks = 0;
let failures = 0;
for (const mode of axes["color-mode"]) {
  lines.push("", `== ${mode} ==`);
  for (const pair of contrast.pairs) {
    const fg = colour(`semantic.${pair.fg}`, mode);
    const bg = colour(`semantic.${pair.bg}`, mode);
    if (bg.alpha < 1 && !pair.over) throw new Error(`${pair.bg} is translucent; the pair needs "over"`);
    const ground = bg.alpha < 1 ? over(bg, hexToRgb(pair.over)) : bg.rgb;
    const ink = fg.alpha < 1 ? over(fg, ground) : fg.rgb;
    const value = ratio(ink, ground);
    const min = minimumFor(pair, mode);
    const ok = value >= min;
    checks += 1;
    if (!ok) failures += 1;
    const note = pair.over ? ` (over ${pair.over})` : "";
    lines.push(
      `${ok ? "PASS" : "FAIL"}  ${value.toFixed(2).padStart(5)}  >=${String(min).padEnd(3)}  ${pair.kind.padEnd(4)}  ` +
        `${pair.fg} on ${pair.bg}`.padEnd(58) +
        `${toHex(ink)} / ${toHex(ground)}${note}`,
    );
  }
}

const out = [
  "IronWrap OS System v2 contrast proof",
  `tokens.json ${meta.version}; ${axes["color-mode"].length} colour modes x ${contrast.pairs.length} pairs; WCAG 2.1 relative luminance`,
  `Minimums: text ${contrast.minimum.text}, large text ${contrast.minimum["large-text"]}, UI ${contrast.minimum.ui}. ` +
    contrast.overrides.map((rule) => `${rule.why}.`).join(" "),
  ...lines,
  "",
  "Exempt from contrast (decorative or carried by another cue):",
  ...Object.entries(contrast.exempt).map(([path, why]) => `  ${path}: ${why}`),
  "",
  problems.length ? `Structure: ${problems.length} problem(s)` : "Structure: modes complete, aliases resolve in every mode, hex matches components.",
  ...problems.map((problem) => `  ${problem}`),
  `Result: ${checks} checks, ${checks - failures} pass, ${failures} fail.`,
];
console.log(out.join("\n"));
process.exit(failures || problems.length ? 1 : 0);
