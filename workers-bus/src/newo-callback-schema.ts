import { sha256Hex } from "./newo-hash.ts";

/** Every field written by recordNewoSession, plus D1's recorded_at. */
export const NEWO_CALLBACK_RECORD_COLUMNS = Object.freeze([
  "callback_id", "tenant_id", "session_id", "event_id", "reason", "urgency",
  "handoff_summary", "contact_name", "contact_phone", "contact_email", "address_line1",
  "city", "province", "postal_code", "recorded_at",
]);

export interface NewoSchemaObject {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

// Bind the installed definitions: columns, types, CHECKs, keys, FKs and every guard's body/table.
// The three dependency table definitions also bind referenced keys and actor/event columns;
// retaining a child FK or trigger body while dropping/weakening its target must never admit Newo.
// Hash the complete sqlite_master SQL, trimming its edges and normalizing only line endings;
// whitespace inside SQL literals must remain significant. Formatting changes fail closed too.
// Entries retain per-table trigger creation order. A migration changing this contract must
// update these fingerprints and the behavioral evidence together; never relax them to enable.
export const NEWO_CALLBACK_SCHEMA_OBJECTS = Object.freeze([
  {
    "type": "table",
    "name": "app_users",
    "table": "app_users",
    "sha256": "8a79c3a86ffa5806f46debc60f2754559f0779a68db30a6dc9f1299540218270"
  },
  {
    "type": "table",
    "name": "newo_sessions",
    "table": "newo_sessions",
    "sha256": "5b650cf4a2a443b1d514cf233eaa5fe4efc6a499d222b18843d8e6a8a238dba3"
  },
  {
    "type": "table",
    "name": "newo_event_receipts",
    "table": "newo_event_receipts",
    "sha256": "bb1c3abe5bb16bb29ef14efecee3d47703d7d24400b6c374287a0268eea671ee"
  },
  {
    "type": "table",
    "name": "newo_handoff_resolutions",
    "table": "newo_handoff_resolutions",
    "sha256": "90c6d05c088417df40fd0ee01761223b62b7b21d0c3dc21833b2b9dcb3f2c3cc"
  },
  {
    "type": "trigger",
    "name": "newo_handoff_resolutions_append_only_update",
    "table": "newo_handoff_resolutions",
    "sha256": "c8014740d0d199d8ba380acdfbd20b37dabc6d29ed918a5d6bf0fac6fdf66514"
  },
  {
    "type": "trigger",
    "name": "newo_handoff_resolutions_append_only_delete",
    "table": "newo_handoff_resolutions",
    "sha256": "0585930db5f2346a78b1bfdfe0e24de5aac03da6e7097f8d472675da0d144066"
  },
  {
    "type": "table",
    "name": "newo_callback_records",
    "table": "newo_callback_records",
    "sha256": "5ee6fe598875d32a44927d22e460f70e54f6de1e9ace3d171877c833858c5b2f"
  },
  {
    "type": "trigger",
    "name": "newo_callback_records_validate_insert",
    "table": "newo_callback_records",
    "sha256": "5e46fab16e51f58c43bfd472d2ded25c630e1289f0f7ccf02a46cf2ffb59a480"
  },
  {
    "type": "trigger",
    "name": "newo_callback_records_append_only_update",
    "table": "newo_callback_records",
    "sha256": "5cf471baf292267125e89dba799e83f5be13ee4662115e8bde662e5be694871d"
  },
  {
    "type": "trigger",
    "name": "newo_callback_records_append_only_delete",
    "table": "newo_callback_records",
    "sha256": "a0cce383f28f9c289907b65bb971f2c255a96f1766b9e30103c047af5e9b4a94"
  },
  {
    "type": "trigger",
    "name": "newo_callback_records_no_insert_replace",
    "table": "newo_callback_records",
    "sha256": "55242a5d4da5131658482f79a22bae0ce52d02e80b23afe8ea92a45f2f9e8532"
  },
  {
    "type": "trigger",
    "name": "newo_handoff_resolutions_validate_insert",
    "table": "newo_handoff_resolutions",
    "sha256": "86cad4c29a90d5d987480746f05f88d04975e493781bb54b2041d54f9bb63d12"
  },
  {
    "type": "trigger",
    "name": "newo_handoff_resolutions_no_insert_replace",
    "table": "newo_handoff_resolutions",
    "sha256": "b890f2319126ade15fdf72cb64aa349ee5fae88a23275c721d9bd38104b3a440"
  }
]);

export const NEWO_CALLBACK_SCHEMA_QUERY = `SELECT type, name, tbl_name, sql FROM main.sqlite_master
 WHERE (tbl_name IN ('newo_callback_records', 'newo_handoff_resolutions')
        AND type IN ('table', 'trigger'))
    OR (type = 'table' AND name IN ('app_users', 'newo_sessions', 'newo_event_receipts'))
 ORDER BY rowid`;

/** Source replay and runtime readiness share one fail-closed installed-schema contract. */
export async function newoCallbackSchemaMatches(rows: readonly NewoSchemaObject[]): Promise<boolean> {
  if (rows.length !== NEWO_CALLBACK_SCHEMA_OBJECTS.length) return false;
  for (const expected of NEWO_CALLBACK_SCHEMA_OBJECTS) {
    const found = rows.filter((row) => row.name === expected.name);
    if (found.length !== 1) return false;
    const row = found[0]!;
    if (row.type !== expected.type || row.tbl_name !== expected.table || typeof row.sql !== "string") return false;
    if (await sha256Hex(row.sql.replace(/\r\n?/g, "\n").trim()) !== expected.sha256) return false;
  }
  for (const table of ["newo_callback_records", "newo_handoff_resolutions"]) {
    const expected = NEWO_CALLBACK_SCHEMA_OBJECTS.filter((row) => row.type === "trigger" && row.table === table);
    const installed = rows.filter((row) => row.type === "trigger" && row.tbl_name === table);
    if (installed.some((row, index) => row.name !== expected[index]?.name)) return false;
  }
  return true;
}

/** A schema read only: never writes business data or contacts any provider. */
export async function newoCallbackSchemaReady(env: Pick<Env, "DB">): Promise<boolean> {
  try {
    const result: { success?: boolean; results?: NewoSchemaObject[] } =
      await env.DB.prepare(NEWO_CALLBACK_SCHEMA_QUERY).all<NewoSchemaObject>();
    return result.success !== false && await newoCallbackSchemaMatches(result.results ?? []);
  } catch {
    return false;
  }
}
