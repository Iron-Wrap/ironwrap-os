import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const headersPath = resolve("dist/_headers");
const indexPath = resolve("dist/index.html");
const manifestPath = resolve("dist/manifest.webmanifest");
const robotsPath = resolve("dist/robots.txt");
const bootstrapPreloadPath = resolve("dist/field-bootstrap-preload.js");
const iconPaths = [
  resolve("dist/icon-192.png"),
  resolve("dist/icon-512.png"),
  resolve("dist/icon-maskable-512.png"),
];

await Promise.all([
  stat(headersPath),
  stat(indexPath),
  stat(manifestPath),
  stat(robotsPath),
  stat(bootstrapPreloadPath),
  ...iconPaths.map((path) => stat(path)),
]);
const [headers, indexHtml, manifestText, robots, bootstrapPreload] = await Promise.all([
  readFile(headersPath, "utf8"),
  readFile(indexPath, "utf8"),
  readFile(manifestPath, "utf8"),
  readFile(robotsPath, "utf8"),
  readFile(bootstrapPreloadPath, "utf8"),
]);
const manifest = JSON.parse(manifestText);

const requiredDirectives = [
  "Content-Security-Policy:",
  "frame-ancestors 'none'",
  "worker-src 'self' blob:",
  "media-src 'self' blob:",
  "Permissions-Policy:",
  "camera=(self)",
  "microphone=(self)",
  "geolocation=(self)",
  "Referrer-Policy: no-referrer",
  "Strict-Transport-Security:",
  "X-Content-Type-Options: nosniff",
  "X-Frame-Options: DENY",
];

const missing = requiredDirectives.filter((directive) => !headers.includes(directive));
if (missing.length > 0) {
  throw new Error(`dist/_headers is missing required security directives: ${missing.join(", ")}`);
}

const requiredEstimateEmbedDirectives = [
  "/estimate",
  "! Content-Security-Policy",
  "! X-Frame-Options",
  "frame-ancestors https://ironwrapexteriors.com https://www.ironwrapexteriors.com https://iroofalberta.ca https://www.iroofalberta.ca",
  "script-src 'self' https://challenges.cloudflare.com",
  "frame-src https://challenges.cloudflare.com",
];
const missingEstimateEmbedDirectives = requiredEstimateEmbedDirectives.filter(
  (directive) => !headers.includes(directive),
);
if (missingEstimateEmbedDirectives.length > 0) {
  throw new Error(
    `dist/_headers is missing required public-estimator embed directives: ${missingEstimateEmbedDirectives.join(", ")}`,
  );
}

// The boot shell is the first screen every user sees and its whole stylesheet is inline,
// so a `style-src` that does not name it is a silently broken first paint, not a warning
// (ELEC-157). Nothing in the source tree fails when this regresses — only the phone does.
if (headers.includes("__IRONWRAP_BOOT_STYLE_HASH__")) {
  throw new Error(
    "dist/_headers kept the unsubstituted boot-style CSP hash placeholder; the boot shell " +
      "would render unstyled on every cold start",
  );
}
for (const match of indexHtml.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/g)) {
  const hash = createHash("sha256")
    .update(match[1] ?? "", "utf8")
    .digest("base64");
  if (!headers.includes(`'sha256-${hash}'`)) {
    throw new Error(
      `dist/index.html ships an inline <style> whose sha256 ('sha256-${hash}') is absent from ` +
        "the Content-Security-Policy in dist/_headers; the browser will block it",
    );
  }
}

const requiredIcons = new Map([
  ["/icon-192.png", "any"],
  ["/icon-512.png", "any"],
  ["/icon-maskable-512.png", "maskable"],
]);
for (const [src, purpose] of requiredIcons) {
  const icon = manifest.icons?.find((candidate) => candidate.src === src);
  if (!icon || icon.purpose !== purpose || icon.type !== "image/png") {
    throw new Error(`manifest is missing the required ${purpose} PNG icon ${src}`);
  }
}

if (!indexHtml.includes('name="robots" content="noindex,nofollow"')) {
  throw new Error("dist/index.html must keep the private PWA noindex,nofollow directive");
}
if (!robots.includes("User-agent: *") || !robots.includes("Disallow: /")) {
  throw new Error("dist/robots.txt must disallow crawlers from the private PWA");
}
if (!indexHtml.includes('<script async src="/field-bootstrap-preload.js"></script>')) {
  throw new Error("dist/index.html must load the paired-device bootstrap preloader asynchronously");
}
if (
  !bootstrapPreload.includes("indexedDB.databases") ||
  !bootstrapPreload.includes("X-IronWrap-Device-Proof")
) {
  throw new Error("field bootstrap preloader must preserve safe paired-device proof lookup");
}

// Two paired-device boot invariants. Both are produced by the build rather than written
// by hand, so nothing in the source tree fails when they regress — only `/today`'s
// Lighthouse budget does, one release later.
const stylesheetIndex = indexHtml.indexOf('<link rel="stylesheet"');
const entryScriptIndex = indexHtml.search(/<script type="module"[^>]*src="\/assets\//);
if (stylesheetIndex === -1 || entryScriptIndex === -1) {
  throw new Error("dist/index.html must link a stylesheet and a module entry script");
}
// One render-blocking stylesheet: a second one linked from the shell (a lazy route's CSS pulled
// into a preloaded chunk) would decide the cascade layer order before index.css and leave the
// utilities below Preflight everywhere.
const linkedStylesheets = indexHtml.match(/<link\b[^>]*\brel=["']stylesheet["'][^>]*>/g) ?? [];
if (linkedStylesheets.length !== 1) {
  throw new Error(
    `dist/index.html must link exactly one stylesheet, the entry's; found ${linkedStylesheets.length}`,
  );
}
if (stylesheetIndex > entryScriptIndex) {
  throw new Error(
    "dist/index.html must discover its render-blocking stylesheet before the module graph; " +
      "behind it, first paint waits for every modulepreload to clear the connection pool",
  );
}
if (
  /<link\b(?=[^>]*\brel=["']preload["'])(?=[^>]*\bas=["']font["'])[^>]*(?:archivo|martian-mono)[^>]*>/i.test(
    indexHtml,
  )
) {
  throw new Error("dist/index.html must not preload optional Archivo or Martian Mono faces");
}

for (const [constant, chunk] of [
  ["TODAY_ROUTE_CHUNK", "today-page"],
  ["FIELD_ROUTE_CHUNK", "field-pages"],
]) {
  const match = bootstrapPreload.match(new RegExp(`${constant}\\s*=\\s*"([^"]+)"`));
  if (!match) {
    throw new Error(`field bootstrap preloader must declare ${constant} to preload`);
  }
  if (!new RegExp(`^/assets/${chunk}-[^/]+\\.js$`).test(match[1])) {
    throw new Error(
      `field bootstrap preloader kept the unsubstituted placeholder ${match[1]} for ${constant}; ` +
        "that route would fall back to a serialised second round trip before its first paint",
    );
  }
  await stat(resolve(`dist${match[1]}`));
}

// The build drops the System v2 tokens nothing reads (vite.config.ts, scripts/prune-tokens.ts).
// A token the bundle still reads but no longer declares would resolve to nothing at runtime, so
// every `var(--token)` in the shipped files must have its declaration in the shipped stylesheets.
const assetNames = await readdir(resolve("dist/assets"));
const assetText = async (extension) =>
  (
    await Promise.all(
      assetNames
        .filter((name) => name.endsWith(extension))
        .map((name) => readFile(resolve("dist/assets", name), "utf8")),
    )
  ).join("\n");
const stylesheets = await assetText(".css");
const scripts = await assetText(".js");
const tokenNames = new Set(
  [...(await readFile(resolve("src/styles/tokens.css"), "utf8")).matchAll(/^\s*(--[\w-]+):/gm)].map(
    (match) => match[1],
  ),
);
const declaredTokens = new Set(
  [...stylesheets.matchAll(/(?<=[{;])(--[\w-]+):/g)].map((match) => match[1]),
);
const unresolvedTokens = new Set(
  [...`${stylesheets}\n${scripts}`.matchAll(/var\((--[\w-]+)/g)]
    .map((match) => match[1])
    .filter((name) => tokenNames.has(name) && !declaredTokens.has(name)),
);
if (unresolvedTokens.size > 0) {
  throw new Error(
    `the bundle reads design tokens that no shipped stylesheet declares: ${[...unresolvedTokens].join(", ")}`,
  );
}

console.log(
  "dist contract verified: manifest, install icons, paired-device bootstrap, private crawler controls, security headers and design tokens are present",
);
