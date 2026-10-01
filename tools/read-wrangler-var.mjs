#!/usr/bin/env node
// IRO-268 R1.3: shared CLI for shell scripts that need a wrangler config's flat var value.
// deploy/tenant-leakage-checks.sh used to read `c.vars.NAME` directly in a `node -e` one-liner,
// which silently returned `undefined` once vars moved into CFG_* JSON bindings (blocker 11) --
// checks 6 and 8 kept reporting a verdict while reading nothing. Reading through
// flattenWranglerVars here, and failing loudly on an absent name, is what keeps that from
// happening again in the one place outside `make check`'s reach.
//
// Usage: read-wrangler-var.mjs --config <path> [--separator <s>] NAME [NAME...]
// Prints the requested values joined by --separator (default: newline). Exits non-zero, naming
// the missing name(s), when a requested name is not in the flattened var set -- an absent name
// must read as an error, never as an empty string standing in for "found nothing to leak".
import { readFileSync } from "node:fs";

import { stripJsonComments } from "./generate-tenant-worker-config.mjs";
import { flattenWranglerVars } from "./wrangler-vars.mjs";

function parseArgs(argv) {
  let config;
  let separator = "\n";
  const names = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") config = argv[(index += 1)];
    else if (arg === "--separator") separator = argv[(index += 1)];
    else names.push(arg);
  }
  if (!config) {
    console.error("read-wrangler-var: --config <path> is required");
    process.exit(1);
  }
  if (names.length === 0) {
    console.error("read-wrangler-var: at least one NAME is required");
    process.exit(1);
  }
  return { config, separator, names };
}

const { config, separator, names } = parseArgs(process.argv.slice(2));
const parsed = JSON.parse(stripJsonComments(readFileSync(config, "utf8")));
const vars = flattenWranglerVars(parsed.vars ?? {});

const missing = names.filter((name) => !(name in vars));
if (missing.length > 0) {
  console.error(`read-wrangler-var: not found in ${config}: ${missing.join(", ")}`);
  process.exit(1);
}

process.stdout.write(names.map((name) => (typeof vars[name] === "string" ? vars[name] : JSON.stringify(vars[name]))).join(separator));
