import { readFile, stat } from "node:fs/promises";
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
if (!indexHtml.includes('<script defer src="/field-bootstrap-preload.js"></script>')) {
  throw new Error("dist/index.html must load the paired-device bootstrap preloader");
}
if (
  !bootstrapPreload.includes("indexedDB.databases") ||
  !bootstrapPreload.includes("X-IronWrap-Device-Proof")
) {
  throw new Error("field bootstrap preloader must preserve safe paired-device proof lookup");
}

console.log(
  "dist contract verified: manifest, install icons, paired-device bootstrap, private crawler controls, and security headers are present",
);
