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
// Dependency definitions bind all referenced keys and actor/event/owned-job columns;
// retaining a child FK or trigger body while dropping/weakening its target must never admit Newo.
// Hash the complete sqlite_master SQL, trimming its edges and normalizing only line endings;
// whitespace inside SQL literals must remain significant. Formatting changes fail closed too.
// Entries retain per-table trigger creation order. A migration changing this contract must
// update these fingerprints and the behavioral evidence together; never relax them to enable.
export const NEWO_CALLBACK_SCHEMA_OBJECTS = Object.freeze([
  {
    "type": "table",
    "name": "envelopes",
    "table": "envelopes",
    "sha256": "56ef54949d21251ae4fb51b35272de0dd11a25a647718077b2c1de8ea8fa79ce"
  },
  {
    "type": "table",
    "name": "app_users",
    "table": "app_users",
    "sha256": "8a79c3a86ffa5806f46debc60f2754559f0779a68db30a6dc9f1299540218270"
  },
  {
    "type": "table",
    "name": "newo_event_receipts",
    "table": "newo_event_receipts",
    "sha256": "ffbefb25b59cb780fa582aec86796c13c21b01dc091c22b4aa379ce38cb94430"
  },
  {
    "type": "table",
    "name": "newo_sessions",
    "table": "newo_sessions",
    "sha256": "da88adbc3acebf0fda19fecffe0dc658b18a573544a5a47eb9c5e631f3ab4fbc"
  },
  {
    "type": "table",
    "name": "operating_leads",
    "table": "operating_leads",
    "sha256": "fc9044d9daab5b9aac9f2b157480a51b000ac2175fdf840da5d957f47acf1e1c"
  },
  {
    "type": "table",
    "name": "operating_customers",
    "table": "operating_customers",
    "sha256": "8e41dd751bbab98b92c658aef9aa14f53a0db46844edb54bf3b410b587564f41"
  },
  {
    "type": "table",
    "name": "operating_properties",
    "table": "operating_properties",
    "sha256": "80c6e92cb2c109d457a02ca95ae52807862ee687e57cef252a43682cf1eb7229"
  },
  {
    "type": "table",
    "name": "operating_roof_jobs",
    "table": "operating_roof_jobs",
    "sha256": "0346dfda6420a1fdfee4b65e4a9a55d471e99f3fd570fb2b29c059390209fc96"
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
    "type": "index",
    "name": "idx_newo_sessions_id_tenant",
    "table": "newo_sessions",
    "sha256": "1aff81d57e7c25a87e76690b249e5eddad01e8d6fe75b62eb51241c80354a4c9"
  },
  {
    "type": "index",
    "name": "idx_newo_sessions_tenant_binding",
    "table": "newo_sessions",
    "sha256": "03f2e6c6cd90106f6ef9e15378ca2ec8f951cdf088e69270e22dae2d24f9e01c"
  },
  {
    "type": "index",
    "name": "idx_newo_receipts_tenant_session",
    "table": "newo_event_receipts",
    "sha256": "8d3308081883fc2e73d880eabd011151a4319299e772fffbbd9f7f407010f42f"
  },
  {
    "type": "table",
    "name": "newo_event_admissions",
    "table": "newo_event_admissions",
    "sha256": "ecb8058180a94d43b992351c486f81e6a81e905d6892753fbe6671dac61d811c"
  },
  {
    "type": "index",
    "name": "idx_newo_admissions_tenant_session",
    "table": "newo_event_admissions",
    "sha256": "7b7956bb87ab3d0355a3801926e9214efaee64c0e0654f92d1850f59c4ac9648"
  },
  {
    "type": "trigger",
    "name": "newo_event_admissions_validate_insert",
    "table": "newo_event_admissions",
    "sha256": "f5c4e5fb2ff89285c482294b53e1d018ade02b8f8250065265489120680e540c"
  },
  {
    "type": "trigger",
    "name": "newo_event_admissions_append_only_update",
    "table": "newo_event_admissions",
    "sha256": "a328e704ad44dd2625ec4c007eb16859a726e881f8537cd05ef4cfd790bb9c8a"
  },
  {
    "type": "trigger",
    "name": "newo_event_admissions_append_only_delete",
    "table": "newo_event_admissions",
    "sha256": "dccb49b0d843e52f06ce8608df0f61ed8d7c8819efb7c39bbb6cc6426d33a85d"
  },
  {
    "type": "trigger",
    "name": "newo_event_admissions_no_insert_replace",
    "table": "newo_event_admissions",
    "sha256": "8914c2a785af8c1e787b9a119b5c8757810ad15d081571d160677414eea17d4f"
  },
  {
    "type": "trigger",
    "name": "newo_sessions_validate_insert",
    "table": "newo_sessions",
    "sha256": "13e0c932a6be1907971291e31f397686fd1288500917941ac3a057990fd77983"
  },
  {
    "type": "trigger",
    "name": "newo_sessions_validate_update",
    "table": "newo_sessions",
    "sha256": "061a0a7f4a251afcacfccf5e117252606d3b401159458c6d7e39f885fbbc29e0"
  },
  {
    "type": "trigger",
    "name": "newo_sessions_append_only_delete",
    "table": "newo_sessions",
    "sha256": "5c0bb2e50f51e062375c4f1070d46af3d1df3c7b46fc8053df986b8130bc668d"
  },
  {
    "type": "trigger",
    "name": "newo_sessions_no_insert_replace",
    "table": "newo_sessions",
    "sha256": "393be8534e3174fed12fb40a9aedc496ec4896d0a22107a1f14bf9cbd3e6008e"
  },
  {
    "type": "trigger",
    "name": "newo_receipts_validate_insert",
    "table": "newo_event_receipts",
    "sha256": "447db80243ce5fc1060db2d31885717b5067d41cc94299a21ed5492c765f3850"
  },
  {
    "type": "trigger",
    "name": "newo_receipts_validate_update",
    "table": "newo_event_receipts",
    "sha256": "478bacb9b0545f5d3559566b9114e05304300ab3f49f6066c03e70d7d810f828"
  },
  {
    "type": "trigger",
    "name": "newo_receipts_append_only_delete",
    "table": "newo_event_receipts",
    "sha256": "2d8960932992132f71faae79895ef3a712173d1f473403429a05b7a5f05d3cac"
  },
  {
    "type": "trigger",
    "name": "newo_receipts_no_insert_replace",
    "table": "newo_event_receipts",
    "sha256": "a1efff8dd765838ec00972ef9f5af3209a69796c9683067c87b52384b38f5187"
  },
  {
    "type": "trigger",
    "name": "newo_callback_records_validate_insert",
    "table": "newo_callback_records",
    "sha256": "c13ddd919a1e0a1eef42bb9ceb4ad0c72297ae9ea2212f503df80e44248baab8"
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
    "sha256": "ed616e00ac2df7f08c3a181ace4d601f0e3fc6c5ac1959ca7ba00889d86e7703"
  },
  {
    "type": "trigger",
    "name": "newo_handoff_resolutions_no_insert_replace",
    "table": "newo_handoff_resolutions",
    "sha256": "b890f2319126ade15fdf72cb64aa349ee5fae88a23275c721d9bd38104b3a440"
  }
]);

const NEWO_GUARDED_TABLES = [
  "newo_sessions", "newo_event_receipts", "newo_event_admissions", "newo_callback_records", "newo_handoff_resolutions",
];

export const NEWO_CALLBACK_SCHEMA_QUERY = `SELECT type, name, tbl_name, sql FROM main.sqlite_master
 WHERE (tbl_name IN ('newo_sessions', 'newo_event_receipts', 'newo_event_admissions',
                    'newo_callback_records', 'newo_handoff_resolutions') AND type IN ('table', 'trigger'))
    OR (type = 'table' AND name IN ('app_users', 'envelopes', 'operating_leads', 'operating_customers',
                                  'operating_properties', 'operating_roof_jobs'))
    OR (type = 'index' AND name IN ('idx_newo_sessions_id_tenant', 'idx_newo_sessions_tenant_binding',
                                  'idx_newo_receipts_tenant_session', 'idx_newo_admissions_tenant_session'))
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
  for (const table of NEWO_GUARDED_TABLES) {
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
