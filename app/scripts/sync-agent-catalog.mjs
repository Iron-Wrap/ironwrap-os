#!/usr/bin/env node
// Copies the machine-readable block of docs/AI-TEAM-CONTRACT.md into the app for the generated-view
// validator. It renders with the Worker's own script, so app/src/generated-views/contract-catalog.ts
// is byte for byte workers-bus/src/agents/contract-catalog.ts, under the same CATALOG_SHA256.
// `--check` fails when the copy is stale.
//   node scripts/sync-agent-catalog.mjs [--check]

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  extractCatalogJson,
  renderCatalogModule,
} from "../../workers-bus/scripts/sync-agent-catalog.mjs";

const CONTRACT = fileURLToPath(new URL("../../docs/AI-TEAM-CONTRACT.md", import.meta.url));
export const APP_CATALOG = fileURLToPath(
  new URL("../src/generated-views/contract-catalog.ts", import.meta.url),
);

export function renderAppCatalog() {
  return renderCatalogModule(extractCatalogJson(readFileSync(CONTRACT, "utf8")));
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  const expected = renderAppCatalog();
  if (process.argv.includes("--check")) {
    if (readFileSync(APP_CATALOG, "utf8") !== expected) {
      console.error("src/generated-views/contract-catalog.ts is stale; run npm run catalog");
      process.exit(1);
    }
  } else {
    writeFileSync(APP_CATALOG, expected);
  }
}
