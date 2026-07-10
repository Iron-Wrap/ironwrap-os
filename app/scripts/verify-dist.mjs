import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const headersPath = resolve("dist/_headers");
const manifestPath = resolve("dist/manifest.webmanifest");
const iconPaths = [
  resolve("dist/icon-192.png"),
  resolve("dist/icon-512.png"),
  resolve("dist/icon-maskable-512.png"),
];

await Promise.all([stat(headersPath), stat(manifestPath), ...iconPaths.map((path) => stat(path))]);
const headers = await readFile(headersPath, "utf8");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

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

console.log("dist contract verified: manifest, install icons, and security headers are present");
