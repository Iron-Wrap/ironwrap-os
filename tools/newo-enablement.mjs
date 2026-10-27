// The Newo enablement gate. Under callback only, a requested callback is the only way a caller
// reaches a person, so NEWO_ENABLED=true is refused unless IronWrap owns a D1 record of it that a
// person works and closes: the newo_callback_records table (migration 0168). The gate applies
// every D1 migration, in filename order as D1 does, to an in-memory SQLite and reads sqlite_master
// for that table and the columns a person needs. It never parses migration text: a CREATE TABLE
// inside a comment, a string or a quoted alias, or one a later statement drops, leaves no table,
// and a migration that fails to apply opens nothing. tools/validate-newo-config.mjs and the
// readiness contract (tools/production-readiness.mjs) both read the gate from here. Turning Newo
// on stays a separate change; this gate only stops it before the record exists.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { stripJsonComments } from "./generate-tenant-worker-config.mjs";
import { flattenWranglerVars } from "./wrangler-vars.mjs";

export const NEWO_CALLBACK_RECORD_TABLE = "newo_callback_records";
/** The columns that make the table the record a person works: whose, which call, how to reach them, when. */
export const NEWO_CALLBACK_RECORD_COLUMNS = Object.freeze([
  "callback_id",
  "tenant_id",
  "session_id",
  "reason",
  "urgency",
  "contact_phone",
  "recorded_at",
]);
const MIGRATION_FILE = /^\d{4}_.+\.sql$/;

/**
 * Does the D1 schema the migrations build hold the callback record? The migrations run in an
 * in-memory SQLite with foreign keys on; only a real table in the main schema with every
 * NEWO_CALLBACK_RECORD_COLUMNS column counts.
 */
export function newoCallbackRecordPresent(root) {
  const directory = join(root, "workers-bus/migrations");
  let names;
  try {
    names = readdirSync(directory).filter((name) => MIGRATION_FILE.test(name)).sort();
  } catch {
    return false;
  }
  if (names.length === 0) return false;
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA foreign_keys = ON");
    for (const name of names) database.exec(readFileSync(join(directory, name), "utf8"));
    const table = database.prepare(
      "SELECT name FROM main.sqlite_master WHERE type = 'table' AND name = ?",
    ).get(NEWO_CALLBACK_RECORD_TABLE);
    if (!table) return false;
    const columns = new Set(
      database.prepare("SELECT name FROM pragma_table_info(?)").all(NEWO_CALLBACK_RECORD_TABLE)
        .map((column) => String(column.name)),
    );
    return NEWO_CALLBACK_RECORD_COLUMNS.every((column) => columns.has(column));
  } catch {
    return false;
  } finally {
    database.close();
  }
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
    `(the workers-bus/migrations, applied in order, build no ${NEWO_CALLBACK_RECORD_TABLE} table with ` +
    `${NEWO_CALLBACK_RECORD_COLUMNS.join(", ")})`;
}
