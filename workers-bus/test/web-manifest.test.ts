import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import worker from "../src/index.ts";
import { WEB_MANIFEST_PATH, webManifestResponse } from "../src/web-manifest.ts";
import type { AppEnv } from "../src/app-types.ts";

const tenantEnv = (overrides: Partial<AppEnv> = {}): AppEnv => ({
  APP_TENANT_ID: "tenant-a",
  APP_TENANT_NAME: "Example Roofing A",
  APP_TENANT_BRAND: "Example A",
  APP_LOCALE: "en-CA",
  APP_TIME_ZONE: "America/Edmonton",
  APP_CURRENCY: "CAD",
  ...overrides,
} as AppEnv);

test("the web manifest names the request tenant and is never cached", async () => {
  const response = await worker.fetch(
    new Request(`https://a.example.invalid${WEB_MANIFEST_PATH}`),
    tenantEnv() as never,
    { waitUntil() {} } as never,
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/manifest\+json/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const manifest = await response.json() as Record<string, unknown>;
  assert.equal(manifest.name, "Example Roofing A");
  assert.equal(manifest.short_name, "Example A");
  assert.equal(manifest.start_url, "/today");
  assert.equal(manifest.display, "standalone");

  const other = await webManifestResponse(
    new Request(`https://b.example.invalid${WEB_MANIFEST_PATH}`),
    tenantEnv({ APP_TENANT_ID: "tenant-b", APP_TENANT_NAME: "Example Roofing B", APP_TENANT_BRAND: "Example B" }),
  ).json() as Record<string, unknown>;
  assert.equal(other.name, "Example Roofing B");
  assert.equal(other.short_name, "Example B");
});

test("an unconfigured tenant gets no manifest", async () => {
  const response = webManifestResponse(
    new Request(`https://a.example.invalid${WEB_MANIFEST_PATH}`),
    tenantEnv({ APP_TENANT_NAME: "" }),
  );
  assert.equal(response.status, 404);
  assert.equal(
    webManifestResponse(new Request(`https://a.example.invalid${WEB_MANIFEST_PATH}`, { method: "POST" }), tenantEnv()).status,
    405,
  );
});

test("the Worker answers the manifest path ahead of the static assets", () => {
  // The manifest lives under /api/v1, which the Worker already answers first, so no release-policy
  // path list moves for it; the vite build must publish it at the same path.
  assert.ok(WEB_MANIFEST_PATH.startsWith("/api/v1/"));
  const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const assets = config.slice(config.indexOf('"run_worker_first"'), config.indexOf("]", config.indexOf('"run_worker_first"')));
  assert.ok(assets.includes('"/api/*"'));
  const vite = readFileSync(new URL("../../app/vite.config.ts", import.meta.url), "utf8");
  assert.ok(vite.includes(`manifestFilename: "${WEB_MANIFEST_PATH.slice(1)}"`));
});

test("the Worker manifest keeps the vite manifest's shape", () => {
  // The vite-built manifest is the local fallback; the two must not drift apart.
  const vite = readFileSync(new URL("../../app/vite.config.ts", import.meta.url), "utf8");
  const served = readFileSync(new URL("../src/web-manifest.ts", import.meta.url), "utf8");
  for (const fragment of [
    'start_url: "/today"',
    'display: "standalone"',
    'orientation: "portrait-primary"',
    'background_color: "#fbfbfa"',
    'theme_color: "#f3f3f1"',
    '"/icon-192.png"',
    '"/icon-512.png"',
    '"/icon-maskable-512.png"',
    '"/icon.svg"',
  ]) {
    assert.ok(vite.includes(fragment), `vite.config.ts lost ${fragment}`);
    assert.ok(served.includes(fragment), `web-manifest.ts lost ${fragment}`);
  }
});
