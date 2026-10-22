// The Newo enablement gate. A callback the receptionist requests is today a D1 session row plus
// an owner email sent on a best-effort basis: nothing a person works and closes in D1. So
// NEWO_ENABLED=true is refused until a D1 callback record exists. The slice that builds the
// record names its migration NNNN_newo_callback_records.sql; that file is the marker that flips
// this gate. tools/validate-newo-config.mjs and the readiness contract
// (tools/production-readiness.mjs) both read it from here.
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { stripJsonComments } from "./generate-tenant-worker-config.mjs";
import { flattenWranglerVars } from "./wrangler-vars.mjs";

export const NEWO_CALLBACK_RECORD_MIGRATION = /^\d{4}_newo_callback_records\.sql$/;

/** Does a D1 migration build the callback record yet? */
export function newoCallbackRecordPresent(root) {
  let names;
  try {
    names = readdirSync(join(root, "workers-bus/migrations"));
  } catch {
    return false;
  }
  return names.some((name) => NEWO_CALLBACK_RECORD_MIGRATION.test(name));
}

/** The wrangler.jsonc environments (production, then each `env` entry) that set NEWO_ENABLED=true. */
export function newoEnabledEnvironments(wranglerSource) {
  const config = JSON.parse(stripJsonComments(wranglerSource));
  const environments = [
    ["production", config.vars ?? {}],
    ...Object.entries(config.env ?? {}).map(([name, env]) => [name, env?.vars ?? {}]),
  ];
  return environments
    .filter(([, vars]) => flattenWranglerVars(vars).NEWO_ENABLED === "true")
    .map(([name]) => name);
}

/** The refusal message while Newo is switched on without the callback record, or null. */
export function newoEnablementRefusal({ enabledIn, callbackRecordPresent }) {
  if (enabledIn.length === 0 || callbackRecordPresent) return null;
  return `NEWO_ENABLED=true (${enabledIn.join(", ")}) is refused until the D1 callback record exists ` +
    "(no workers-bus/migrations/NNNN_newo_callback_records.sql)";
}
