// web-manifest.ts — the PWA web manifest, answered per tenant.
//
// The built app carries one manifest with one name, which a shared multi-tenant Worker would
// hand to every tenant's host. The manifest is therefore published under `/api/v1/`, which the
// Worker already answers before the static assets (no release-policy change), and this builds the
// same manifest as app/vite.config.ts with the request tenant's name and brand.
// The vite-built file stays the fallback for local static serving (vite preview); keep the
// fields below in step with the `manifest` block there.

import { publicTenant } from "./app-auth.ts";
import type { AppEnv } from "./app-types.ts";

export const WEB_MANIFEST_PATH = "/api/v1/manifest.webmanifest";

export function webManifestResponse(req: Request, env: AppEnv): Response {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { "content-type": "application/json; charset=utf-8", allow: "GET, HEAD" },
    });
  }
  const tenant = publicTenant(env);
  // An unconfigured tenant gets no manifest rather than another tenant's name.
  if (!tenant) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }
  const manifest = {
    id: "/",
    name: tenant.name,
    short_name: tenant.brand,
    description: "Proof-first roofing operations for field and office teams.",
    lang: tenant.locale,
    start_url: "/today",
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#fbfbfa",
    theme_color: "#f3f3f1",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
  };
  return new Response(req.method === "HEAD" ? null : JSON.stringify(manifest), {
    status: 200,
    headers: {
      "content-type": "application/manifest+json; charset=utf-8",
      // The host decides the tenant, so neither a browser nor a CDN may reuse it across hosts.
      "cache-control": "no-store",
    },
  });
}
