import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

function assignment(source: string, name: string): string[] {
  const value = source.match(new RegExp(`^${name}="([^"]*)"`, "m"))?.[1];
  assert.ok(value, `${name} assignment is present`);
  const appended = [...source.matchAll(new RegExp(`^${name}\\+="([^\"]*)"`, "gm"))].map((match) => match[1]);
  return [value, ...appended].join(",").split(",");
}

test("0073 and 0075 native Work Package authority are included in both recovery inventories", async () => {
  const migration = [
    await readFile(
      new URL(
        "../migrations/0094_native_work_package_authority.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    await readFile(
      new URL(
        "../migrations/0096_native_work_package_integrity.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    await readFile(
      new URL(
        "../migrations/0130_work_package_assignment_snapshot_guard.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    await readFile(
      new URL(
        "../migrations/0131_work_package_action_authority_precondition.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  ].join("\n");
  const backup = await readFile(
    new URL("../../deploy/backup-d1-to-r2.sh", import.meta.url),
    "utf8",
  );
  const restore = await readFile(
    new URL("../../deploy/restore-d1-from-r2.sh", import.meta.url),
    "utf8",
  );
  const tables = [
    "work_package_events",
    "work_package_supersessions",
    "work_packages",
  ];
  const indexes = [
    ["idx_field_work_package_actions_event", "field_work_package_actions"],
    ["idx_field_work_package_actions_package", "field_work_package_actions"],
    ["idx_work_packages_tenant_job", "work_packages"],
    ["idx_work_packages_tenant_assignment", "work_packages"],
    ["idx_work_packages_one_current_assignment", "work_packages"],
    ["idx_work_package_events_package_time", "work_package_events"],
    ["idx_work_package_events_recovery", "work_package_events"],
    ["idx_work_package_events_ack_actor", "work_package_events"],
    ["idx_work_package_events_hold_sequence", "work_package_events"],
    ["idx_work_package_events_review_target", "work_package_events"],
    ["idx_work_package_supersessions_tenant_job", "work_package_supersessions"],
    [
      "idx_work_package_supersessions_replacement",
      "work_package_supersessions",
    ],
  ];
  const triggers = [
    ["work_package_events_authority_guard", "work_package_events"],
    ["work_package_events_apply_transition", "work_package_events"],
    ["work_package_events_append_only_update", "work_package_events"],
    ["work_package_events_append_only_delete", "work_package_events"],
    [
      "field_work_package_actions_native_binding_guard",
      "field_work_package_actions",
    ],
    [
      "work_package_supersessions_validate_insert",
      "work_package_supersessions",
    ],
    ["work_package_supersessions_apply", "work_package_supersessions"],
    [
      "work_package_supersessions_append_only_update",
      "work_package_supersessions",
    ],
    [
      "work_package_supersessions_append_only_delete",
      "work_package_supersessions",
    ],
    ["work_packages_validate_insert", "work_packages"],
    ["work_packages_projection_guard", "work_packages"],
    ["work_packages_no_delete", "work_packages"],
    ["work_package_events_native_identity_guard", "work_package_events"],
    ["work_packages_assignment_snapshot_guard", "work_packages"],
    ["work_packages_assignment_snapshot_immutable", "work_packages"],
    ["work_package_events_authority_precondition_guard", "work_package_events"],
  ];
  for (const table of tables) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
    assert.ok(assignment(backup, "REQUIRED_TABLES").includes(table), `backup table ${table}`);
    assert.ok(assignment(restore, "REQUIRED_TABLES").includes(table), `restore table ${table}`);
  }
  for (const [name, table] of indexes) {
    assert.match(migration, new RegExp(`CREATE (?:UNIQUE )?INDEX IF NOT EXISTS ${name}\\b`));
    assert.ok(assignment(backup, "REQUIRED_INDEX_BINDINGS").includes(`${name}=${table}`), `backup index ${name}`);
    assert.ok(assignment(restore, "REQUIRED_INDEX_BINDINGS").includes(`${name}=${table}`), `restore index ${name}`);
  }
  for (const [name, table] of triggers) {
    assert.match(migration, new RegExp(`CREATE TRIGGER ${name}\\b`));
    assert.ok(assignment(backup, "REQUIRED_TRIGGER_BINDINGS").includes(`${name}=${table}`), `backup trigger ${name}`);
    assert.ok(assignment(restore, "REQUIRED_TRIGGER_BINDINGS").includes(`${name}=${table}`), `restore trigger ${name}`);
  }
  assert.deepEqual(assignment(backup, "REQUIRED_TABLES").sort(), assignment(restore, "REQUIRED_TABLES").sort());
  assert.deepEqual(assignment(backup, "REQUIRED_INDEX_BINDINGS").sort(), assignment(restore, "REQUIRED_INDEX_BINDINGS").sort());
  assert.deepEqual(assignment(backup, "REQUIRED_TRIGGER_BINDINGS").sort(), assignment(restore, "REQUIRED_TRIGGER_BINDINGS").sort());
});
