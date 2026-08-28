import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const TABLES = [
  "commercial_acceptance_bindings",
  "commercial_authority_permits",
  "commercial_deposit_approval_exclusions",
  "commercial_deposit_derivation_cursors",
  "commercial_deposit_derivation_events",
  "commercial_deposit_derivation_requests",
  "commercial_deposit_derivations",
  "commercial_lead_triage_decisions",
  "commercial_proposal_publication_events",
  "commercial_proposal_revisions",
  "commercial_quote_lines",
  "commercial_quote_revisions",
] as const;

const INDEXES = [
  ["idx_commercial_acceptances_job", "commercial_acceptance_bindings"],
  [
    "idx_commercial_deposit_derivation_events_lookup",
    "commercial_deposit_derivation_events",
  ],
  [
    "idx_commercial_deposit_derivation_requests_lookup",
    "commercial_deposit_derivation_requests",
  ],
  [
    "idx_commercial_deposit_derivations_basis",
    "commercial_deposit_derivations",
  ],
  [
    "idx_commercial_deposit_derivations_intent",
    "commercial_deposit_derivations",
  ],
  [
    "idx_commercial_deposit_derivations_recovery",
    "commercial_deposit_derivations",
  ],
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
  [
    "accounting_intent_command_receipts_commercial_deposit_sod",
    "accounting_intent_command_receipts",
  ],
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
    "commercial_acceptance_apply_activation_projection",
    "commercial_acceptance_bindings",
  ],
  [
    "commercial_acceptance_enqueue_deposit_derivation",
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
  [
    "commercial_deposit_approval_exclusions_append_only_delete",
    "commercial_deposit_approval_exclusions",
  ],
  [
    "commercial_deposit_approval_exclusions_append_only_update",
    "commercial_deposit_approval_exclusions",
  ],
  [
    "commercial_deposit_approval_exclusions_insert_guard",
    "commercial_deposit_approval_exclusions",
  ],
  [
    "commercial_deposit_derivation_requests_capture_approval_exclusion",
    "commercial_deposit_derivation_requests",
  ],
  [
    "commercial_deposit_derivation_requests_no_insert_replace",
    "commercial_deposit_derivation_requests",
  ],
  [
    "commercial_deposit_derivation_requests_update_guard",
    "commercial_deposit_derivation_requests",
  ],
  [
    "commercial_deposit_derivations_insert_event",
    "commercial_deposit_derivations",
  ],
  [
    "commercial_deposit_derivations_no_insert_replace",
    "commercial_deposit_derivations",
  ],
  [
    "commercial_deposit_derivations_update_event",
    "commercial_deposit_derivations",
  ],
  [
    "commercial_deposit_derivations_update_guard",
    "commercial_deposit_derivations",
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
  const migration = [
    "0093_commercial_authority.sql",
    "0116_native_commercial_deposit_derivation.sql",
    "0117_authority_readback_lifecycle.sql",
    "0119_commercial_deposit_approval_separation.sql",
  ]
    .map((file) => readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"))
    .join("\n");
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
    ["REQUIRED_TABLE_COUNT", 232],
    ["REQUIRED_INDEX_COUNT", 352],
    ["REQUIRED_TRIGGER_COUNT", 566],
  ] as const) {
    assert.equal(countAssignment(backup, name), expected, `backup ${name}`);
    assert.equal(countAssignment(restore, name), expected, `restore ${name}`);
  }

  for (const table of TABLES) {
    assert.match(
      migration,
      new RegExp(`CREATE TABLE(?: IF NOT EXISTS)? ${table}\\b`),
    );
  }
  for (const [name] of INDEXES) {
    assert.match(
      migration,
      new RegExp(`CREATE (?:UNIQUE )?INDEX(?: IF NOT EXISTS)? ${name}\\b`),
    );
  }
  for (const [name] of TRIGGERS) {
    assert.match(
      migration,
      new RegExp(`CREATE TRIGGER(?: IF NOT EXISTS)? ${name}\\b`),
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

test("the full schema matches the recovery frontier through 0126", () => {
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
    // 0111 adds the office invitation ledger: one table, two query indexes, and the partial
    // unique index that keeps one invitation open per mailbox. 0113_pipeline_board_core.sql adds
    // the five pipeline tables, their seven indexes, and the ten guards that keep a card's
    // version honest and its transition trail append-only. 0115 forward-adds columns to the
    // existing tenant profile and likewise changes no recovery-inventory object count; SQLite
    // export/restore carries those columns with the row. 0116 adds the acceptance-bound deposit
    // derivation queue, fair-sweep cursor, request receipt, event ledger, five indexes, and the
    // upgraded publication/acceptance guards and projections. 0117 adds the authority readback
    // lifecycle indexes and insert guard. 0118 adds the capability manifest, proof, and readiness
    // frontier: three tables, three indexes, and nine append-only/owner guards. 0119 adds the
    // immutable commercial-deposit approval exclusion and its five capture/command guards. 0120
    // scopes the existing gate-clearance decision index without changing the inventory count.
    // 0121 adds seven isolated prequote/estimator-ready tables, eight indexes, and fourteen
    // append-only guards. 0122 adds the pipeline administration surface: the role-grant and
    // configuration-event tables, three indexes (the live-stage board index, the grant-by-role
    // index, and the per-pipeline event index), and three guards - the two that keep the
    // configuration trail append-only and the one that keeps a grant's identity immutable. Its
    // two forward-added columns (`pipeline_stages.is_active`, `pipelines.configuration_marker`)
    // change no object count; SQLite export/restore carries them with the row. 0123 adds the
    // governed pipeline stage-automation heads, revisions, and invocations, five indexes, and
    // seven append-only or lineage guards. 0124 adds the schema field definition/value history
    // and immutable object-evidence receipt tables, six indexes, and fourteen guards. 0125 adds
    // the document-template and generation-attempt/receipt aggregates, six indexes, and eighteen
    // append-only, scope, and effect/readback guards. 0126 adds the settled generation outcome
    // column and replaces one receipt guard without changing the recovery object inventory.
    assert.deepEqual(
      { ...counts },
      // 0110 adds three company-setup tables and their named indexes. 0111 adds the office
      // invitation ledger and recovery-required indexes. 0112 adds operator-search indexes;
      // 0113 adds the pipeline board; 0114 preserves both development capture kinds; 0118 adds
      // the capability-readiness contracts. The 0107/0108 work-package and job-file evidence
      // remains part of this recovery frontier.
      { tables: 232, indexes: 352, triggers: 566 },
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

test("0116 upgrades the shipped 0093 acceptance guard instead of leaving old installs open", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON");
    const directory = new URL("../migrations/", import.meta.url);
    const migrations = readdirSync(directory)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    const shippedIndex = migrations.indexOf("0093_commercial_authority.sql");
    assert.notEqual(shippedIndex, -1);
    for (const migration of migrations.slice(0, shippedIndex + 1)) {
      db.exec(readFileSync(new URL(migration, directory), "utf8"));
    }
    const shipped = db
      .prepare(
        `SELECT sql FROM sqlite_master
          WHERE type = 'trigger' AND name = 'commercial_acceptance_binding_guard'`,
      )
      .get() as { sql: string };
    assert.doesNotMatch(shipped.sql, /commercial_lead_not_qualified/);

    for (const migration of migrations.slice(shippedIndex + 1)) {
      db.exec(readFileSync(new URL(migration, directory), "utf8"));
    }
    const upgraded = db
      .prepare(
        `SELECT sql FROM sqlite_master
          WHERE type = 'trigger' AND name = 'commercial_acceptance_binding_guard'`,
      )
      .get() as { sql: string };
    assert.match(upgraded.sql, /commercial_lead_not_qualified/);
    assert.match(upgraded.sql, /quote\.status = 'approved'/);
    assert.match(upgraded.sql, /commercial_quote_revisions other_successor/);
    assert.match(upgraded.sql, /commercial_proposal_revisions other_successor/);
    assert.match(upgraded.sql, /quote\.terms_hash = NEW\.terms_hash/);
    assert.match(upgraded.sql, /proposal\.terms_hash = NEW\.terms_hash/);
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
