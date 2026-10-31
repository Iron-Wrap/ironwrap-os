// The Newo enablement gate. A callback the receptionist requests is today a D1 session row plus
// an owner email sent on a best-effort basis: nothing a person works and closes in D1. So
// NEWO_ENABLED=true is refused until a D1 callback record exists. The slice that builds the
// record names its migration NNNN_newo_callback_records.sql and creates the
// newo_callback_records table in it; that migration is the marker that flips this gate. A file
// with the right name that does not create the table (`SELECT 1;`) does not count.
// tools/validate-newo-config.mjs and the readiness contract (tools/production-readiness.mjs) both
// read the gate from here.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { stripJsonComments } from "./generate-tenant-worker-config.mjs";
import { flattenWranglerVars } from "./wrangler-vars.mjs";

export const NEWO_CALLBACK_RECORD_MIGRATION = /^\d{4}_newo_callback_records\.sql$/;
export const NEWO_CALLBACK_RECORD_TABLE = "newo_callback_records";

const CREATES_CALLBACK_RECORD_TABLE = new RegExp(
  String.raw`\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:main\s*\.\s*)?` +
    String.raw`(?:"${NEWO_CALLBACK_RECORD_TABLE}"|\x60${NEWO_CALLBACK_RECORD_TABLE}\x60|\[${NEWO_CALLBACK_RECORD_TABLE}\]|${NEWO_CALLBACK_RECORD_TABLE})\s*\(`,
  "i",
);

/** The SQL a migration runs: comments removed and string literals emptied, so neither can fake a statement. */
export function sqlWithoutCommentsOrStrings(sql) {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const char = sql[i];
    const next = sql[i + 1];
    if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      out += " ";
    } else if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += " ";
    } else if (char === "'") {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") { i += 1; break; } else i += 1;
      }
      out += "''";
    } else {
      out += char;
      i += 1;
    }
  }
  return out;
}

/** Does this migration's SQL create the callback record table? */
export function createsNewoCallbackRecordTable(sql) {
  return CREATES_CALLBACK_RECORD_TABLE.test(sqlWithoutCommentsOrStrings(sql));
}

/** Does a D1 migration build the callback record yet? The marker must create the table, not only carry the name. */
export function newoCallbackRecordPresent(root) {
  const directory = join(root, "workers-bus/migrations");
  let names;
  try {
    names = readdirSync(directory);
  } catch {
    return false;
  }
  return names
    .filter((name) => NEWO_CALLBACK_RECORD_MIGRATION.test(name))
    .some((name) => {
      try {
        return createsNewoCallbackRecordTable(readFileSync(join(directory, name), "utf8"));
      } catch {
        return false;
      }
    });
}

/**
 * The Worker's reading of NEWO_ENABLED (workers-bus/src/newo.ts: `String(value) === "true"`), so a
 * JSON boolean `true` counts as on here exactly as it does at runtime.
 */
export function newoEnabledValue(value) {
  return String(value) === "true";
}

/** The wrangler.jsonc environments (production, then each `env` entry) that set NEWO_ENABLED=true. */
export function newoEnabledEnvironments(wranglerSource) {
  const config = JSON.parse(stripJsonComments(wranglerSource));
  const environments = [
    ["production", config.vars ?? {}],
    ...Object.entries(config.env ?? {}).map(([name, env]) => [name, env?.vars ?? {}]),
  ];
  return environments
    .filter(([, vars]) => newoEnabledValue(flattenWranglerVars(vars).NEWO_ENABLED))
    .map(([name]) => name);
}

/** The refusal message while Newo is switched on without the callback record, or null. */
export function newoEnablementRefusal({ enabledIn, callbackRecordPresent }) {
  if (enabledIn.length === 0 || callbackRecordPresent) return null;
  return `NEWO_ENABLED=true (${enabledIn.join(", ")}) is refused until the D1 callback record exists ` +
    `(no workers-bus/migrations/NNNN_newo_callback_records.sql that creates the ${NEWO_CALLBACK_RECORD_TABLE} table)`;
}
