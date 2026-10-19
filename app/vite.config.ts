import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { configDefaults, defineConfig } from "vitest/config";
import type { Plugin } from "vite";

import {
  generatedTokenNames,
  pruneUnreadTokens,
  sourceTokenReads,
  splitThemeReads,
} from "./scripts/prune-tokens";
import { excludeCandidates, utilityClasses } from "./scripts/split-stylesheet";

/**
 * Field Companion's boot is bandwidth-bound, not CPU-bound: the acceptance
 * server and the CDN both hand the paired device ~200 KiB over a throttled
 * mobile link before `/today` can paint. Two ordering defects in Vite's default
 * HTML output dominated the paired-device Lighthouse profile:
 *
 * 1. The render-blocking stylesheet is emitted *after* the entry script and
 *    every `modulepreload`, so it is the eighth subresource the parser
 *    discovers. Behind an HTTP/1.1 connection cap it finished at ~1.93 s and
 *    first paint waited on it. Moving it ahead of the module graph costs
 *    nothing and lets the browser paint the boot shell as soon as the small
 *    stylesheet lands.
 * 2. The field route chunk is only discovered once the entry has downloaded,
 *    parsed and executed, which serialises a second round trip in front of the
 *    largest paint. `/today` is the PWA's `start_url` and the field surface is
 *    the app's default entry point, so that chunk is known-needed before any
 *    JavaScript runs — but only for field paths. A path-guarded preload keeps
 *    office roles from paying for a chunk they never render.
 */
function criticalPathOrdering(): Plugin {
  const ROUTE_CHUNKS = [
    { name: "today-page", placeholder: "__IRONWRAP_TODAY_ROUTE_CHUNK__" },
    { name: "field-pages", placeholder: "__IRONWRAP_FIELD_ROUTE_CHUNK__" },
  ];
  const chunkUrls = new Map<string, string>();

  let writesToDisk = true;

  return {
    name: "ironwrap-critical-path-ordering",
    enforce: "post",
    apply: "build",
    configResolved(config) {
      writesToDisk = config.build.write !== false;
    },
    generateBundle(_options, bundle) {
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (chunk.type === "chunk" && chunk.name) chunkUrls.set(chunk.name, `/${fileName}`);
      }
    },
    // `public/` is copied outside the bundle, so the hashed chunk name is substituted
    // on disk once both the chunk and the copy exist.
    async closeBundle() {
      // An in-memory build (`build.write: false`, used by bundle analysis) copies no
      // `public/` files, so there is no preloader on disk to substitute into — and the
      // one left from a previous build already carries real chunk names.
      if (!writesToDisk) return;

      const preloaderPath = resolve("dist/field-bootstrap-preload.js");
      let source = await readFile(preloaderPath, "utf8");
      for (const { name, placeholder } of ROUTE_CHUNKS) {
        const url = chunkUrls.get(name);
        if (!url) throw new Error(`the ${name} chunk was not emitted`);
        if (!source.includes(placeholder))
          throw new Error(`the field bootstrap preloader no longer carries ${placeholder}`);
        source = source.replace(placeholder, url);
      }
      await writeFile(preloaderPath, source);
    },
    transformIndexHtml: {
      order: "post",
      handler(html) {
        const stylesheets = html.match(/<link rel="stylesheet"[^>]*>/g) ?? [];
        let out = html;
        for (const tag of stylesheets) out = out.replace(tag, "");
        const entryScript = out.match(
          /<script type="module"[^>]*src="\/assets\/[^"]*"[^>]*><\/script>/,
        );
        if (!entryScript) throw new Error("index.html no longer carries a module entry script");
        out = out.replace(entryScript[0], `${stylesheets.join("")}${entryScript[0]}`);

        return out;
      },
    },
  };
}

/**
 * `index.html` carries one inline `<style>`: the boot shell shown from first byte until
 * React mounts. `_headers` pins `style-src 'self'`, so the browser blocked that block on
 * every cold start and the shell painted as unstyled text on a white page — the first
 * screen a paired crew phone shows (ELEC-157).
 *
 * Hashing it is the surgical fix: the CSP keeps refusing every inline style except the
 * exact bytes this build emitted, and no extra render-blocking request lands in front of
 * the boot. The placeholder lives in `public/_headers`, which is copied verbatim, so the
 * substitution happens on the built copy. `scripts/verify-dist.mjs` fails the build if an
 * inline style ever ships without a matching hash.
 */
function bootStyleCspHash(): Plugin {
  const PLACEHOLDER = "__IRONWRAP_BOOT_STYLE_HASH__";
  let writesToDisk = true;
  return {
    name: "ironwrap-boot-style-csp-hash",
    enforce: "post",
    apply: "build",
    configResolved(config) {
      writesToDisk = config.build.write !== false;
    },
    async closeBundle() {
      if (!writesToDisk) return;
      const indexHtml = await readFile(resolve("dist/index.html"), "utf8");
      const hashes = inlineStyleHashes(indexHtml);
      if (hashes.length === 0) throw new Error("index.html no longer carries the boot shell style");

      const headersPath = resolve("dist/_headers");
      const headers = await readFile(headersPath, "utf8");
      if (!headers.includes(PLACEHOLDER))
        throw new Error(`dist/_headers no longer carries ${PLACEHOLDER}`);
      await writeFile(headersPath, headers.replaceAll(PLACEHOLDER, hashes.join(" ")));
    },
  };
}

/**
 * The stylesheet is render-blocking, so every byte of it is first-paint time on the paired
 * device. tokens.css carries all of System v2; this drops the token declarations nothing reads
 * (see scripts/prune-tokens.ts). It prunes `styles.css` after Tailwind has generated its
 * utilities and before Vite hashes and minifies the result, so the file name still describes the
 * content: the pruned set depends only on the source tree. The dev server and the committed
 * file keep every token, and scripts/verify-dist.mjs fails the build if the bundle reads one
 * that is gone.
 */
function pruneUnreadTokensFromStyles(): Plugin {
  return {
    name: "ironwrap-prune-unread-tokens",
    apply: "build",
    async transform(code, id) {
      if (!/[\\/]src[\\/]styles\.css(?:\?|$)/.test(id)) return null;
      const names = generatedTokenNames(await readFile(resolve("src/styles/tokens.css"), "utf8"));
      // The AI parts' colour utilities live in their own stylesheet; the tokens they read ship here.
      const split = splitThemeReads(
        await readFile(resolve("src/styles/theme.css"), "utf8"),
        await sourceTokenReads(resolve("src/components/ai")),
      );
      return {
        code: pruneUnreadTokens(code, names, `${await sourceTokenReads(resolve("src"))}\n${split}`),
        map: null,
      };
    },
  };
}

/**
 * The AI parts' stylesheet (src/components/ai/ai.css) is a Tailwind root of its own, so styles.css
 * stays free of their utilities and a screen loads them with its lazy chunk. Each utility must live
 * in one stylesheet only (scripts/split-stylesheet.ts): `record` keeps the candidates Tailwind
 * generated for styles.css, and `exclude`, which runs before Tailwind compiles ai.css, first has
 * styles.css compiled and then names those candidates in one `@source not inline()`.
 *
 * ponytail: on the dev server the list is the one from ai.css's first compile; a utility added to
 * or dropped from both places since shows twice or is missing on the gallery until the server
 * restarts. Builds always compile both afresh.
 */
function splitStylesheetWithoutDuplicates(): { exclude: Plugin; record: Plugin } {
  const shippedPath = resolve("src/styles.css");
  const splitPath = resolve("src/components/ai/ai.css");
  const path = (id: string) => id.split("?")[0];
  // Vitest renders without stylesheets, so there is nothing to keep apart there.
  const apply = () => !process.env.VITEST;
  let shipped: Set<string> | undefined;
  return {
    exclude: {
      name: "ironwrap-split-stylesheet-exclude",
      enforce: "pre",
      apply,
      async transform(code, id) {
        if (path(id) !== splitPath) return null;
        await this.load({ id: shippedPath });
        if (!shipped) this.error("src/styles.css was not compiled before the AI parts' stylesheet");
        return { code: `${code}\n${excludeCandidates(shipped)}\n`, map: null };
      },
    },
    record: {
      name: "ironwrap-split-stylesheet-record",
      enforce: "pre",
      apply,
      transform(code, id) {
        if (path(id) === shippedPath) shipped = utilityClasses(code);
        return null;
      },
    },
  };
}

const splitStylesheet = splitStylesheetWithoutDuplicates();

export function inlineStyleHashes(html: string): string[] {
  return [...html.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/g)].map(
    (match) =>
      `'sha256-${createHash("sha256")
        .update(match[1] ?? "", "utf8")
        .digest("base64")}'`,
  );
}

export default defineConfig({
  plugins: [
    react(),
    // Around Tailwind's own transform: `exclude` before it, `record` after it.
    splitStylesheet.exclude,
    tailwindcss(),
    splitStylesheet.record,
    pruneUnreadTokensFromStyles(),
    VitePWA({
      registerType: "prompt",
      injectRegister: false,
      includeAssets: [
        "favicon.svg",
        "icon.svg",
        "icon-192.png",
        "icon-512.png",
        "icon-maskable-512.png",
      ],
      manifest: {
        id: "/",
        name: "IronWrap OS",
        short_name: "IronWrap",
        description: "Proof-first roofing operations for field and office teams.",
        start_url: "/today",
        scope: "/",
        display: "standalone",
        orientation: "portrait-primary",
        background_color: "#fbfbfa",
        theme_color: "#f3f3f1",
        icons: [
          {
            src: "/icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
          {
            src: "/icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any",
          },
        ],
      },
      workbox: {
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ["**/*.{js,css,html,svg,woff2}"],
        runtimeCaching: [],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: false,
      },
      devOptions: {
        enabled: false,
      },
    }),
    criticalPathOrdering(),
    bootStyleCspHash(),
  ],
  build: {
    rollupOptions: {
      output: {
        // On the paired-device mobile profile every request costs ~600 ms of emulated
        // latency, so a shared 400-byte icon module is as expensive as a 40 KiB one.
        // Default splitting gave the field route five such chunks that it discovered
        // only *after* its own chunk evaluated — a whole round trip in front of the
        // largest paint.
        //
        // Only small shared leaves are grouped. Merging the large shared modules too
        // (zod, tailwind-merge, the role and session chunks) was measured and rejected:
        // it saves round trips but drags office-only code into the field boot's script
        // evaluation, and the total-blocking-time cost outweighs the latency saved.
        //
        // Total blocking time only counts the part of a task that runs past 50 ms, so a
        // single 250 ms evaluation task costs 200 ms of TBT while five 50 ms tasks cost
        // nothing. Evaluating the whole framework as one entry chunk produced exactly
        // the former on the CI runner. These groups are all statically reachable from
        // the entry, so the browser preloads them in the same wave: the bytes and the
        // round trips stay where they were and only the evaluation is broken up.
        codeSplitting: {
          groups: [
            {
              name: "react-vendor",
              test: /[\\/]node_modules[\\/](?:react|react-dom|scheduler)[\\/]/,
              priority: 3,
            },
            {
              name: "router-vendor",
              test: /[\\/]node_modules[\\/]@tanstack[\\/](?:react-router|router-core|history|store)[\\/]/,
              priority: 3,
            },
            {
              name: "query-vendor",
              test: /[\\/]node_modules[\\/]@tanstack[\\/](?:react-query|query-core)[\\/]/,
              priority: 3,
            },
            {
              name: "contracts-vendor",
              test: /[\\/]node_modules[\\/](?:zod|tailwind-merge)[\\/]/,
              priority: 3,
            },
            // The cross-cutting app modules default to a chunk each — the session
            // context, the role guard, the API client, the UI primitives, the shared
            // field leaves. Together they are small but cost five requests, each billed
            // ~600 ms of emulated latency on this profile.
            //
            // Scoped to the directories the field boot actually needs. A plain
            // `src/` test also captured the office domains' contract modules —
            // quickbooks, estimator and service schemas are shared between two office
            // routes each, so ~35 KiB of zod schema construction that `/today` never
            // uses was landing in the chunk it preloads and evaluates before first
            // paint. Those directories chunk on their own and load with their routes.
            {
              name: "app-shared",
              // components/ai is excluded: its parts import ai.css, which must load with the
              // routes that use them. Pulled into this preloaded chunk, the stylesheet would be
              // linked before index.css and put utilities below Preflight for the whole app.
              test: /[\\/]src[\\/](?:auth|components(?![\\/]ai[\\/])|field|hooks|lib|storage)[\\/]/,
              minShareCount: 2,
              priority: 2,
            },
            {
              name: "shared-leaf",
              test: /[\\/]node_modules[\\/]lucide-react[\\/]/,
              minShareCount: 2,
              priority: 1,
            },
          ],
        },
      },
    },
  },
  test: {
    exclude: [...configDefaults.exclude, "e2e/**"],
    environment: "happy-dom",
    setupFiles: ["./src/test/setup.ts"],
    restoreMocks: true,
    clearMocks: true,
    testTimeout: 15_000,
    maxWorkers: 4,
    coverage: {
      reporter: ["text", "json-summary"],
    },
  },
});
