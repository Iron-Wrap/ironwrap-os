import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const NOW = "2026-08-20T12:00:00.000Z";
const DIGEST = "a".repeat(64);

async function migratedDatabase(): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const migrations = (await readdir(new URL("../migrations/", import.meta.url)))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  for (const migration of migrations) {
    if (migration === "0038_app_access_roles.sql") {
      db.prepare(
        `INSERT INTO app_users
          (user_id, tenant_id, email_normalized, display_name, role, active,
           created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'ops', 1, ?, ?, ?)`,
      ).run(
        "appu_fleet_legacy_ops",
        "ironwrap",
        "legacy-fleet-ops@example.invalid",
        "Legacy Fleet Ops",
        "owner@example.invalid",
        NOW,
        NOW,
      );
    }
    db.exec(
      await readFile(new URL(`../migrations/${migration}`, import.meta.url), "utf8"),
    );
  }
  return db;
}

function insertFieldUser(
  db: DatabaseSync,
  userId: string,
  tenantId = "ironwrap",
): void {
  db.prepare(
    `INSERT INTO app_users
       (user_id, tenant_id, email_normalized, display_name, role, frappe_user_id,
        active, created_by, created_at, updated_at, access_role)
     VALUES (?, ?, ?, ?, 'field', ?, 1, 'owner@example.invalid', ?, ?, 'field')`,
  ).run(
    userId,
    tenantId,
    `${userId}@example.invalid`,
    userId,
    `${userId}@example.invalid`,
    NOW,
    NOW,
  );
}

function insertAsset(
  db: DatabaseSync,
  assetId: string,
  userId: string,
  tenantId = "ironwrap",
  custodyHolderType = "User",
  custodyCrewId: string | null = null,
): void {
  db.prepare(
    `INSERT INTO fleet_assets
       (fleet_asset_id, tenant_id, display_name, asset_kind, status, meter_kind,
        custody_holder_type, custody_user_id, custody_crew_id, version, last_command_id,
        last_actor_user_id, created_at, updated_at)
     VALUES (?, ?, ?, 'Vehicle', 'Active', 'Odometer km', ?, ?, ?, 1, ?, ?, ?, ?)`,
  ).run(
    assetId,
    tenantId,
    assetId,
    custodyHolderType,
    custodyHolderType === "User" ? userId : null,
    custodyCrewId,
    `${assetId}:create`,
    userId,
    NOW,
    NOW,
  );
}

function insertAction(
  db: DatabaseSync,
  actionId: string,
  assetId: string,
  userId: string,
  actionKind = "pre_trip_inspection",
  tenantId = "ironwrap",
): void {
  db.prepare(
    `INSERT INTO fleet_asset_actions
       (device_action_id, tenant_id, user_id, fleet_asset_id, action_kind,
        payload_hash, status, manifest_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'r2_stored', ?, ?, ?)`,
  ).run(
    actionId,
    tenantId,
    userId,
    assetId,
    actionKind,
    DIGEST,
    `fleet/${tenantId}/${actionId}/manifest.json`,
    NOW,
    NOW,
  );
}

function insertInspection(
  db: DatabaseSync,
  inspectionId: string,
  actionId: string,
  assetId: string,
  userId: string,
  tenantId = "ironwrap",
): void {
  db.prepare(
    `INSERT INTO fleet_inspections
       (inspection_id, device_action_id, tenant_id, fleet_asset_id, user_id,
        inspection_type, performed_at, items_json, result, defect_count,
        out_of_service, next_inspection_due, manifest_key, payload_hash, created_at)
     VALUES (?, ?, ?, ?, ?, 'Pre-Trip', ?, ?, 'Pass', 0, 0, '2099-08-21', ?, ?, ?)`,
  ).run(
    inspectionId,
    actionId,
    tenantId,
    assetId,
    userId,
    NOW,
    '[{"sequence":1,"check_point":"Brakes","result":"Pass","severity":"None"}]',
    `fleet/${tenantId}/${actionId}/manifest.json`,
    DIGEST,
    NOW,
  );
}

test("native fleet authority rejects inactive crews and unbound cargo driver authority", async () => {
  const db = await migratedDatabase();
  try {
    insertFieldUser(db, "appu_fleet_field_a");
    insertFieldUser(db, "appu_fleet_field_b");
    db.prepare(
      `INSERT INTO fleet_crews
         (crew_id, tenant_id, display_name, status, created_at, updated_at)
       VALUES ('crew_fleet_inactive', 'ironwrap', 'Inactive Crew', 'Inactive', ?, ?)`,
    ).run(NOW, NOW);
    db.prepare(
      `INSERT INTO fleet_crew_members
         (membership_id, tenant_id, crew_id, user_id, active, created_at, updated_at)
       VALUES ('membership_fleet_a', 'ironwrap', 'crew_fleet_inactive',
               'appu_fleet_field_a', 1, ?, ?)`,
    ).run(NOW, NOW);
    insertAsset(
      db,
      "fleet_asset_inactive_crew",
      "appu_fleet_field_a",
      "ironwrap",
      "Crew",
      "crew_fleet_inactive",
    );
    insertAction(
      db,
      "fleet_action_inactive_crew",
      "fleet_asset_inactive_crew",
      "appu_fleet_field_a",
    );
    assert.throws(
      () =>
        insertInspection(
          db,
          "fleet_inspection_inactive_crew",
          "fleet_action_inactive_crew",
          "fleet_asset_inactive_crew",
          "appu_fleet_field_a",
        ),
      /fleet_asset_not_found/,
    );

    db.prepare(
      `INSERT INTO fleet_driver_authorities
         (driver_authority_id, tenant_id, user_id, status, authority_source,
          licence_class, licence_expiry, evidence_key, evidence_sha256,
          last_command_id, last_actor_user_id, created_at, updated_at)
       VALUES ('driver_authority_telematics', 'ironwrap', 'appu_fleet_field_a',
               'Active', 'Telematics', '5', '2099-12-31',
               'fleet/driver/telematics', ?, 'driver-authority-create',
               'appu_fleet_field_a', ?, ?)`,
    ).run(DIGEST, NOW, NOW);
    db.exec("PRAGMA foreign_keys = OFF");
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO fleet_cargo_loads
               (cargo_load_id, tenant_id, roof_job_id, fleet_asset_id,
                driver_authority_id, driver_user_id, status, loaded_weight_kg_milli,
                custody_holder_type, custody_user_id, version, last_command_id,
                last_actor_user_id, created_at, updated_at)
             VALUES ('cargo_load_unbound', 'ironwrap', 'roof-job-not-materialized',
                     'fleet_asset_inactive_crew', 'driver_authority_telematics',
                     'appu_fleet_field_a', 'Loaded', 1000, 'User',
                     'appu_fleet_field_a', 1, 'cargo-create',
                     'appu_fleet_field_a', ?, ?)` ,
          )
          .run(NOW, NOW),
      /fleet_cargo_load_driver_authority_invalid/,
    );
    db.exec("PRAGMA foreign_keys = ON");
  } finally {
    db.close();
  }
});

test("native fleet authority refuses unsafe restoration and cross-tenant defect lineage", async () => {
  const db = await migratedDatabase();
  try {
    insertFieldUser(db, "appu_fleet_field_a");
    insertFieldUser(db, "appu_fleet_field_b", "tenant-b");
    insertAsset(db, "fleet_asset_a", "appu_fleet_field_a");

    db.prepare(
      `UPDATE fleet_assets
          SET status = 'Out of Service', out_of_service_reason = 'Brake defect',
              out_of_service_at = ?, version = 2, last_command_id = ?,
              last_actor_user_id = ?, updated_at = ?
        WHERE tenant_id = 'ironwrap' AND fleet_asset_id = 'fleet_asset_a'`,
    ).run(NOW, "fleet-ground-a", "appu_fleet_field_a", NOW);
    assert.throws(
      () =>
        db
          .prepare(
            `UPDATE fleet_assets
                SET status = 'Active', out_of_service_reason = NULL,
                    out_of_service_at = NULL, version = 3,
                    last_command_id = ?, last_actor_user_id = ?, updated_at = ?
              WHERE tenant_id = 'ironwrap' AND fleet_asset_id = 'fleet_asset_a'`,
          )
          .run("fleet-forged-restore", "appu_fleet_field_a", NOW),
      /fleet_asset_return_to_service_required/,
    );
    assert.throws(
      () =>
        db
          .prepare(
            `UPDATE fleet_assets
                SET status = 'Draft', out_of_service_reason = NULL,
                    out_of_service_at = NULL, version = 3,
                    last_command_id = ?, last_actor_user_id = ?, updated_at = ?
              WHERE tenant_id = 'ironwrap' AND fleet_asset_id = 'fleet_asset_a'`,
          )
          .run("fleet-forged-draft", "appu_fleet_field_a", NOW),
      /fleet_asset_return_to_service_required/,
    );

    insertAsset(db, "fleet_asset_b", "appu_fleet_field_b", "tenant-b");
    insertAction(
      db,
      "fleet_action_source_b",
      "fleet_asset_b",
      "appu_fleet_field_b",
      "pre_trip_inspection",
      "tenant-b",
    );
    insertInspection(
      db,
      "fleet_inspection_source_b",
      "fleet_action_source_b",
      "fleet_asset_b",
      "appu_fleet_field_b",
      "tenant-b",
    );
    insertAction(
      db,
      "fleet_action_defect_a",
      "fleet_asset_a",
      "appu_fleet_field_a",
      "defect_report",
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO fleet_defects
               (defect_id, device_action_id, tenant_id, fleet_asset_id, user_id,
                source_inspection_id, severity, detected_at, description,
                manifest_key, payload_hash, created_at)
             VALUES ('fleet_defect_cross_tenant', 'fleet_action_defect_a',
                     'ironwrap', 'fleet_asset_a', 'appu_fleet_field_a',
                     'fleet_inspection_source_b', 'Major', ?, 'cross-tenant source',
                     'fleet/ironwrap/fleet_action_defect_a/manifest.json', ?, ?)`,
          )
          .run(NOW, DIGEST, NOW),
      /fleet_defect_source_inspection_binding_invalid/,
    );
  } finally {
    db.close();
  }
});

test("native cargo authority binds the exact physical driver and active asset", async () => {
  const db = await migratedDatabase();
  try {
    insertFieldUser(db, "appu_fleet_driver_a");
    insertFieldUser(db, "appu_fleet_driver_b");
    insertAsset(db, "fleet_asset_cargo", "appu_fleet_driver_a");
    db.prepare(
      `INSERT INTO fleet_driver_authorities
         (driver_authority_id, tenant_id, user_id, status, authority_source,
          licence_class, licence_expiry, evidence_key, evidence_sha256,
          last_command_id, last_actor_user_id, created_at, updated_at)
       VALUES (?, 'ironwrap', ?, 'Active', 'Physical Document', '5', '2099-12-31',
               ?, ?, ?, ?, ?, ?)`,
    ).run(
      "driver_authority_cargo_a",
      "appu_fleet_driver_a",
      "fleet/driver/a",
      DIGEST,
      "driver-authority-a",
      "appu_fleet_driver_a",
      NOW,
      NOW,
    );
    db.prepare(
      `INSERT INTO fleet_driver_authorities
         (driver_authority_id, tenant_id, user_id, status, authority_source,
          licence_class, licence_expiry, evidence_key, evidence_sha256,
          last_command_id, last_actor_user_id, created_at, updated_at)
       VALUES (?, 'ironwrap', ?, 'Active', 'Physical Document', '5', '2099-12-31',
               ?, ?, ?, ?, ?, ?)`,
    ).run(
      "driver_authority_cargo_b",
      "appu_fleet_driver_b",
      "fleet/driver/b",
      DIGEST,
      "driver-authority-b",
      "appu_fleet_driver_b",
      NOW,
      NOW,
    );

    // The roof-job reference is owned by the operating lane. This test isolates
    // the fleet authority trigger while preserving its exact tenant binding.
    db.exec("PRAGMA foreign_keys = OFF");
    const insertLoad = (loadId: string, authorityId: string, driverId: string) =>
      db
        .prepare(
          `INSERT INTO fleet_cargo_loads
             (cargo_load_id, tenant_id, roof_job_id, fleet_asset_id,
              driver_authority_id, driver_user_id, status, loaded_weight_kg_milli,
              custody_holder_type, custody_user_id, version, last_command_id,
              last_actor_user_id, created_at, updated_at)
           VALUES (?, 'ironwrap', 'roof-job-not-materialized', 'fleet_asset_cargo',
                   ?, ?, 'Loaded', 1000, 'User', ?, 1, ?, ?, ?, ?)`,
        )
        .run(
          loadId,
          authorityId,
          driverId,
          driverId,
          `${loadId}:command`,
          driverId,
          NOW,
          NOW,
        );

    insertLoad(
      "cargo_load_exact_authority",
      "driver_authority_cargo_a",
      "appu_fleet_driver_a",
    );
    assert.equal(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM fleet_cargo_loads
            WHERE tenant_id = 'ironwrap' AND cargo_load_id = 'cargo_load_exact_authority'`,
        )
        .get<{ count: number }>()?.count,
      1,
    );
    assert.throws(
      () =>
        insertLoad(
          "cargo_load_wrong_driver",
          "driver_authority_cargo_a",
          "appu_fleet_driver_b",
        ),
      /fleet_cargo_load_driver_authority_invalid/,
    );

    db.exec("PRAGMA foreign_keys = ON");
    db.prepare(
      `UPDATE fleet_assets
          SET status = 'Out of Service', out_of_service_reason = 'Cargo brake defect',
              out_of_service_at = ?, version = version + 1,
              last_command_id = ?, last_actor_user_id = ?, updated_at = ?
        WHERE tenant_id = 'ironwrap' AND fleet_asset_id = 'fleet_asset_cargo'`,
    ).run(NOW, "cargo-grounded", "appu_fleet_driver_a", NOW);
    db.exec("PRAGMA foreign_keys = OFF");
    assert.throws(
      () =>
        insertLoad(
          "cargo_load_inactive_asset",
          "driver_authority_cargo_a",
          "appu_fleet_driver_a",
        ),
      /fleet_cargo_load_driver_authority_invalid/,
    );
    db.exec("PRAGMA foreign_keys = ON");
  } finally {
    db.close();
  }
});
