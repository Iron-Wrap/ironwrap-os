import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const TABLES = [
  "commercial_acceptance_bindings",
  "commercial_authority_permits",
  "commercial_lead_triage_decisions",
  "commercial_proposal_publication_events",
  "commercial_proposal_revisions",
  "commercial_quote_lines",
  "commercial_quote_revisions",
] as const;

const INDEXES = [
  ["idx_commercial_acceptances_job", "commercial_acceptance_bindings"],
  ["idx_commercial_permits_aggregate", "commercial_authority_permits"],
  ["idx_commercial_permits_tenant_expiry", "commercial_authority_permits"],
  ["idx_commercial_proposals_current", "commercial_proposal_revisions"],
  ["idx_commercial_proposals_job", "commercial_proposal_revisions"],
  [
    "idx_commercial_publications_current",
    "commercial_proposal_publication_events",
  ],
  [
    "idx_commercial_publications_effect",
    "commercial_proposal_publication_events",
  ],
  ["idx_commercial_quote_lines_sequence", "commercial_quote_lines"],
  ["idx_commercial_quotes_current", "commercial_quote_revisions"],
  ["idx_commercial_quotes_job", "commercial_quote_revisions"],
  ["idx_commercial_triage_lead", "commercial_lead_triage_decisions"],
] as const;

const TRIGGERS = [
  ["commercial_acceptance_binding_guard", "commercial_acceptance_bindings"],
  [
    "commercial_acceptance_bindings_append_only_delete",
    "commercial_acceptance_bindings",
  ],
  [
    "commercial_acceptance_bindings_append_only_update",
    "commercial_acceptance_bindings",
  ],
  [
    "commercial_acceptance_bindings_no_insert_replace",
    "commercial_acceptance_bindings",
  ],
  [
    "commercial_authority_permits_append_only_delete",
    "commercial_authority_permits",
  ],
  [
    "commercial_authority_permits_append_only_update",
    "commercial_authority_permits",
  ],
  [
    "commercial_authority_permits_no_insert_replace",
    "commercial_authority_permits",
  ],
  ["commercial_proposal_authority_guard", "commercial_proposal_revisions"],
  [
    "commercial_proposal_revision_sequence_guard",
    "commercial_proposal_revisions",
  ],
  [
    "commercial_proposal_revisions_append_only_delete",
    "commercial_proposal_revisions",
  ],
  [
    "commercial_proposal_revisions_append_only_update",
    "commercial_proposal_revisions",
  ],
  [
    "commercial_proposal_revisions_no_insert_replace",
    "commercial_proposal_revisions",
  ],
  [
    "commercial_publication_authority_guard",
    "commercial_proposal_publication_events",
  ],
  [
    "commercial_publication_events_append_only_delete",
    "commercial_proposal_publication_events",
  ],
  [
    "commercial_publication_events_append_only_update",
    "commercial_proposal_publication_events",
  ],
  [
    "commercial_publication_events_no_insert_replace",
    "commercial_proposal_publication_events",
  ],
  [
    "commercial_publication_sequence_guard",
    "commercial_proposal_publication_events",
  ],
  ["commercial_quote_authority_guard", "commercial_quote_revisions"],
  ["commercial_quote_lines_append_only_delete", "commercial_quote_lines"],
  ["commercial_quote_lines_append_only_update", "commercial_quote_lines"],
  ["commercial_quote_lines_no_insert_replace", "commercial_quote_lines"],
  ["commercial_quote_revision_sequence_guard", "commercial_quote_revisions"],
  [
    "commercial_quote_revisions_append_only_delete",
    "commercial_quote_revisions",
  ],
  [
    "commercial_quote_revisions_append_only_update",
    "commercial_quote_revisions",
  ],
  [
    "commercial_quote_revisions_no_insert_replace",
    "commercial_quote_revisions",
  ],
  ["commercial_triage_apply_projection", "commercial_lead_triage_decisions"],
  ["commercial_triage_authority_guard", "commercial_lead_triage_decisions"],
  [
    "commercial_triage_decisions_append_only_delete",
    "commercial_lead_triage_decisions",
  ],
  [
    "commercial_triage_decisions_append_only_update",
    "commercial_lead_triage_decisions",
  ],
  [
    "commercial_triage_decisions_no_insert_replace",
    "commercial_lead_triage_decisions",
  ],
  ["commercial_external_effect_authority_guard", "external_effects"],
] as const;

test("0072 commercial authority is complete in migration, backup, and restore inventories", () => {
  const migration = readFileSync(
    new URL("../migrations/0093_commercial_authority.sql", import.meta.url),
    "utf8",
  );
  const backup = readFileSync(
    new URL("../../deploy/backup-d1-to-r2.sh", import.meta.url),
    "utf8",
  );
  const restore = readFileSync(
    new URL("../../deploy/restore-d1-from-r2.sh", import.meta.url),
    "utf8",
  );

  assert.deepEqual(assignment(backup, "COMMERCIAL_REQUIRED_TABLES"), [
    ...TABLES,
  ]);
  assert.deepEqual(assignment(restore, "COMMERCIAL_REQUIRED_TABLES"), [
    ...TABLES,
  ]);
  assert.deepEqual(
    assignment(backup, "COMMERCIAL_REQUIRED_INDEX_BINDINGS"),
    INDEXES.map(([name, table]) => `${name}=${table}`),
  );
  assert.deepEqual(
    assignment(restore, "COMMERCIAL_REQUIRED_INDEX_BINDINGS"),
    INDEXES.map(([name, table]) => `${name}=${table}`),
  );
  assert.deepEqual(
    assignment(backup, "COMMERCIAL_REQUIRED_TRIGGER_BINDINGS"),
    TRIGGERS.map(([name, table]) => `${name}=${table}`),
  );
  assert.deepEqual(
    assignment(restore, "COMMERCIAL_REQUIRED_TRIGGER_BINDINGS"),
    TRIGGERS.map(([name, table]) => `${name}=${table}`),
  );
  for (const [name, expected] of [
    ["REQUIRED_TABLE_COUNT", 199],
    ["REQUIRED_INDEX_COUNT", 307],
    ["REQUIRED_TRIGGER_COUNT", 479],
  ] as const) {
    assert.equal(countAssignment(backup, name), expected, `backup ${name}`);
    assert.equal(countAssignment(restore, name), expected, `restore ${name}`);
  }

  for (const table of TABLES) {
    assert.match(
      migration,
      new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`),
    );
  }
  for (const [name] of INDEXES) {
    assert.match(
      migration,
      new RegExp(`CREATE (?:UNIQUE )?INDEX IF NOT EXISTS ${name}\\b`),
    );
  }
  for (const [name] of TRIGGERS) {
    assert.match(
      migration,
      new RegExp(`CREATE TRIGGER IF NOT EXISTS ${name}\\b`),
    );
  }
  assert.match(migration, /effect\.state = 'succeeded'/);
  assert.match(migration, /commercial_quote_identity_conflict/);
  assert.match(migration, /commercial_proposal_identity_conflict/);
  assert.match(migration, /commercial_publication_proposal_not_current/);
  assert.match(migration, /commercial_publication_time_conflict/);
  assert.match(migration, /acceptance\.state = 'accepted'/);
  assert.match(migration, /commercial_acceptance_chain_mismatch/);
  assert.doesNotMatch(migration, /ON DELETE CASCADE|DROP TABLE|REPLACE INTO/i);
});

test("the full schema matches the recovery frontier through 0109", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON");
    const directory = new URL("../migrations/", import.meta.url);
    for (const file of readdirSync(directory)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      db.exec(readFileSync(new URL(file, directory), "utf8"));
    }
    const counts = db
      .prepare(
        `SELECT
         SUM(type = 'table' AND name NOT LIKE 'sqlite_%') AS tables,
         SUM(type = 'index' AND name NOT LIKE 'sqlite_%') AS indexes,
         SUM(type = 'trigger') AS triggers
       FROM sqlite_master`,
      )
      .get() as { tables: number; indexes: number; triggers: number };
    // 0113_pipeline_board_core.sql adds the five pipeline tables, their seven indexes, and the
    // ten guards that keep a card's version honest and its transition trail append-only.
    assert.deepEqual(
      { ...counts },
      { tables: 199, indexes: 307, triggers: 479 },
    );
    assert.equal(
      db.prepare("PRAGMA integrity_check").get()!.integrity_check,
      "ok",
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    for (const [name, table] of [...INDEXES, ...TRIGGERS]) {
      assert.equal(
        (
          db
            .prepare("SELECT tbl_name FROM sqlite_master WHERE name = ?")
            .get(name) as { tbl_name: string }
        ).tbl_name,
        table,
      );
    }
  } finally {
    db.close();
  }
});

function assignment(source: string, name: string): string[] {
  const value = source.match(new RegExp(`^${name}="([^"]*)"`, "m"))?.[1];
  assert.ok(value, `${name} assignment is present`);
  const appended = [
    ...source.matchAll(new RegExp(`^${name}\\+="([^"]*)"`, "gm")),
  ].map((match) => match[1]);
  return [value, ...appended].join("").split(",").filter(Boolean);
}

function countAssignment(source: string, name: string): number {
  const value = source.match(new RegExp(`^${name}=(\\d+)`, "m"))?.[1];
  assert.ok(value, `${name} assignment is present`);
  return Number(value);
}
