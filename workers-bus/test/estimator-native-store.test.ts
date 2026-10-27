import {
  activateCatalogRevision,
  createCatalogRevision,
  resolveFrozenCatalogPricing,
  resolveFrozenLegacyPricing,
} from "../src/pricing-catalog.ts";
import { catalogList } from "./pricing-catalog-fixture.ts";
import { buildEstimatorWorkbenchReadModel } from "../src/app-read-models.ts";
import { auth } from "./pipeline-board-fixture.ts";
import { backup } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { test } from "node:test";

import type { AppEnv } from "../src/app-types.ts";
import {
  importEstimatorEvidenceFromNativeSources,
  readNativeEstimatorSources,
  resolveNativeEstimatorAuthority,
} from "../src/estimator-native.ts";
import {
  ESTIMATOR_EVIDENCE_SCHEMA_VERSION,
  EstimatorNativeStoreError,
  readEstimatorEvidenceHead,
  readEstimatorMeasurementEvidenceAnchor,
  recordEstimatorEvidenceRevision,
  type EstimatorEvidencePayloadV1,
} from "../src/estimator-native-store.ts";
import { canonicalJson, sha256Hex } from "../src/newo-hash.ts";

const TENANT = "ironwrap";
const OTHER_TENANT = "iroof";
const OWNER_ID = "appu_owner_0001";
const OTHER_OWNER_ID = "appu_owner_iroof_0001";
const JOB_ID = "job:estimator:0001";
const JOB_NUMBER = "IW-EST-0001";
const OTHER_JOB_ID = "job:estimator:iroof:0001";
const OTHER_JOB_NUMBER = "IR-EST-0001";
const RECEIPT_ID = `measurement_${"a".repeat(64)}`;
const MEASUREMENT_ID = `measurement:${"f".repeat(64)}`;
const OTHER_RECEIPT_ID = `measurement_${"b".repeat(64)}`;
const OTHER_MEASUREMENT_ID = `measurement:${"c".repeat(64)}`;
const NOW = new Date("2026-08-21T10:00:00.000Z");
const DELTA_ROW = {
  tenant_id: TENANT,
  receipt_id: RECEIPT_ID,
  measurement_id: MEASUREMENT_ID,
  job_number: JOB_NUMBER,
  provider: "AppliCad",
  source: "google_solar",
  check_name: "solar_area",
  metric: "roof_area",
  ok: true,
  primary_value: 100,
  independent_value: 100,
  rel_diff: 0,
  abs_diff: null,
  detail: "within tolerance",
  error_kind: "relative_fraction",
  signed_error: 0,
  created_at: NOW.toISOString(),
} as const;
const NATIVE_MEASUREMENT_EVIDENCE = {
  delta_ledger: {
    tenant_id: TENANT,
    receipt_id: RECEIPT_ID,
    row_count: 1,
    sha256: await sha256Hex(canonicalJson([DELTA_ROW])),
    all_checks_pass: true,
    failed_checks: [],
  },
  report: null,
  ocr: { status: "not_requested", review_required: false },
} as const;

class SqliteD1 {
  readonly raw: DatabaseSync;

  constructor(path = ":memory:") {
    this.raw = new DatabaseSync(path);
    if (path !== ":memory:") return;
    this.raw.exec("PRAGMA foreign_keys = ON");
    const directory = new URL("../migrations/", import.meta.url);
    for (const file of readdirSync(directory)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      this.raw.exec(readFileSync(new URL(file, directory), "utf8"));
    }
    seed(this.raw);
  }

  async batch(statements: SqliteStatement[]) {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const result = [];
      for (const s of statements) result.push(await s.run());
      this.raw.exec("COMMIT");
      return result;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    }
  }

  prepare(sql: string) {
    return new SqliteStatement(this.raw, this.raw.prepare(sql));
  }
}

class SqliteStatement {
  private readonly database: DatabaseSync;
  private readonly statement: StatementSync;
  private readonly args: unknown[];

  constructor(
    database: DatabaseSync,
    statement: StatementSync,
    args: unknown[] = [],
  ) {
    this.database = database;
    this.statement = statement;
    this.args = args;
  }

  bind(...args: unknown[]) {
    return new SqliteStatement(this.database, this.statement, args);
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.args) ?? null) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.statement.all(...this.args) as T[] };
  }

  async run(): Promise<{ success: true }> {
    this.statement.run(...this.args);
    return { success: true };
  }
}

function env(db: SqliteD1): AppEnv {
  return { DB: db as never } as AppEnv;
}

function payload(label = "initial"): EstimatorEvidencePayloadV1 {
  return {
    schema_version: ESTIMATOR_EVIDENCE_SCHEMA_VERSION,
    measurement: {
      id: `measurement:${label}`,
      provider: "AppliCad",
      review_status: "Needs Review",
      metrics: [{ metric: "roof_area", value: 100, unit: "sq ft" }],
      native_evidence: NATIVE_MEASUREMENT_EVIDENCE,
    },
    visual_model: null,
    takeoff: {
      id: `takeoff:${label}`,
      status: "Needs Review",
      items: [{ item_name: "Panel", quantity: 10, unit: "squares" }],
    },
    scope_changes: [],
    insurance_supplements: [],
    scope_clauses: [],
    pricing_authority: null,
  };
}

function input(
  overrides: Partial<
    Parameters<typeof recordEstimatorEvidenceRevision>[1]
  > = {},
) {
  return {
    tenantId: TENANT,
    roofJobId: JOB_ID,
    operatingJobVersion: 1,
    revisionNumber: 1,
    measurementReceiptId: RECEIPT_ID,
    payload: payload(),
    importedByUserId: OWNER_ID,
    idempotencyKey: "estimator-import-key-0001",
    ...overrides,
  };
}

test("legacy native pricing stays frozen when catalog cutover changes the environment", async () => {
  const database = new SqliteD1();
  const source = JSON.stringify({
    job_number: JOB_NUMBER,
    source_xml:
      '<APPLICAD_EXPORT><POINT id="P1" data="0,0,0"/><POINT id="P2" data="10,0,0"/><POINT id="P3" data="10,10,0"/><POINT id="P4" data="0,10,0"/><LINE id="L1" path="P1,P2" type="EAVE" length="10"/><LINE id="L2" path="P2,P3" type="RIDGE" length="10"/><LINE id="L3" path="P3,P4" type="EAVE" length="10"/><LINE id="L4" path="P4,P1" type="EAVE" length="10"/><POLYGON id="F1" path="L1,L2,L3,L4" type="Roof" size="100" mat="Metal"/></APPLICAD_EXPORT>',
  });
  const rawKey = `raw/measurements/${"a".repeat(64)}.json`;
  database.raw
    .prepare("UPDATE measurement_intake_receipts SET payload_hash=? WHERE receipt_id=?")
    .run(await sha256Hex(source), RECEIPT_ID);
  const runtime = {
    DB: database as never,
    ESTIMATOR_PRICE_LIST_JSON: JSON.stringify(catalogList()),
    RAW: {
      get: async (key: string) =>
        key === rawKey
          ? { size: new TextEncoder().encode(source).length, text: async () => source }
          : null,
    },
  } as unknown as AppEnv;
  try {
    const first = await importEstimatorEvidenceFromNativeSources(
      runtime,
      {
        tenantId: TENANT,
        roofJobId: JOB_ID,
        measurementReceiptId: RECEIPT_ID,
        revisionNumber: 1,
        importedByUserId: OWNER_ID,
        idempotencyKey: "pricing:legacy:import",
      },
      NOW,
    );
    const originalRule = JSON.parse(first.revision.payload_json).pricing_authority;
    assert.match(originalRule.source_ref, /^native-owner-import:/);
    assert.equal(originalRule.catalog_revision_id, undefined);
    await assert.rejects(() =>
      resolveFrozenLegacyPricing(
        TENANT,
        { ...originalRule, pricing_policy_snapshot_sha256: "f".repeat(64) },
        first.revision.created_at,
      ),
    );
    const before = await buildEstimatorWorkbenchReadModel(runtime, auth("owner"), JOB_ID, NOW);
    assert.ok(before);
    const original = before.measurements.selected!.computed_estimate;
    assert.equal(original.state, "priced");
    assert.ok(original.total);

    runtime.ESTIMATOR_PRICE_LIST_JSON = "broken later environment";
    runtime.APP_PRICING_CATALOG_ENABLED = "true";
    const after = await buildEstimatorWorkbenchReadModel(
      runtime,
      auth("owner"),
      JOB_ID,
      new Date(NOW.getTime() + 1000),
    );
    assert.ok(after);
    assert.deepEqual(after.measurements.selected!.computed_estimate, original);
    assert.equal(
      (database.raw.prepare("SELECT count(*) n FROM estimator_pricing_catalog_pins").get() as {n:number}).n,
      0,
    );

    const next = await importEstimatorEvidenceFromNativeSources(
      runtime,
      {
        tenantId: TENANT,
        roofJobId: JOB_ID,
        measurementReceiptId: RECEIPT_ID,
        revisionNumber: 2,
        supersedesEstimatorRevisionId: first.revision.estimator_revision_id,
        correctionReason: "New catalog cutover import",
        importedByUserId: OWNER_ID,
        idempotencyKey: "pricing:catalog:unconfigured",
      },
      new Date(NOW.getTime() + 2000),
    );
    assert.equal(JSON.parse(next.revision.payload_json).pricing_authority, null);
  } finally {
    database.raw.close();
  }
});

test("catalog A remains frozen through B activation and A expiry; new imports pin B, lost A response replays, and database restore retains every pin", async () => {
  const database = new SqliteD1(),
    directory = mkdtempSync(join(tmpdir(), "ironwrap-pricing-"));
  const source = JSON.stringify({
    job_number: JOB_NUMBER,
    source_xml:
      '<APPLICAD_EXPORT><POINT id="P1" data="0,0,0"/><POINT id="P2" data="10,0,0"/><POINT id="P3" data="10,10,0"/><POINT id="P4" data="0,10,0"/><LINE id="L1" path="P1,P2" type="EAVE" length="10"/><LINE id="L2" path="P2,P3" type="RIDGE" length="10"/><LINE id="L3" path="P3,P4" type="EAVE" length="10"/><LINE id="L4" path="P4,P1" type="EAVE" length="10"/><POLYGON id="F1" path="L1,L2,L3,L4" type="Roof" size="100" mat="Metal"/></APPLICAD_EXPORT>',
  });
  const rawKey = `raw/measurements/${"a".repeat(64)}.json`;
  database.raw
    .prepare(
      "UPDATE measurement_intake_receipts SET payload_hash=? WHERE receipt_id=?",
    )
    .run(await sha256Hex(source), RECEIPT_ID);
  const runtime = {
    DB: database as never,
    APP_PRICING_CATALOG_ENABLED: "true",
    RAW: {
      get: async (k: string) =>
        k === rawKey
          ? {
              size: new TextEncoder().encode(source).length,
              text: async () => source,
            }
          : null,
    },
  } as unknown as AppEnv;
  const actor = { tenantId: TENANT, userId: OWNER_ID, role: "owner" };
  const instant = (delta: number) => new Date(NOW.getTime() + delta);
  const listA = catalogList();
  listA.approvedPolicy.expiresAt = instant(2000).toISOString();
  try {
    Object.assign(runtime,{ESTIMATOR_PRICE_LIST_JSON:JSON.stringify(listA)});
    const unpriced=await importEstimatorEvidenceFromNativeSources(runtime,{tenantId:TENANT,roofJobId:JOB_ID,measurementReceiptId:RECEIPT_ID,revisionNumber:1,importedByUserId:OWNER_ID,idempotencyKey:"pricing:test:import-unpriced"},NOW);
    assert.equal(JSON.parse(unpriced.revision.payload_json).pricing_authority,null);
    const a = await createCatalogRevision(
      runtime,
      actor,
      { label: "Synthetic A", price_list: listA },
      "pricing:test:create-A",
      NOW,
    );
    const approvedA = await activateCatalogRevision(
      runtime,
      actor,
      {
        revision_id: a.revision.revision_id,
        reviewed_sha256: a.revision.snapshot_sha256,
        expected_version: 0,
      },
      "pricing:test:approve-A",
      NOW,
    );
    const stillUnpriced=await buildEstimatorWorkbenchReadModel(runtime,auth("owner"),JOB_ID,NOW);
    assert.ok(stillUnpriced);assert.equal(stillUnpriced.measurements.selected!.computed_estimate.state,"unconfigured");
    const req = {
      tenantId: TENANT,
      roofJobId: JOB_ID,
      measurementReceiptId: RECEIPT_ID,
      revisionNumber: 2,
      supersedesEstimatorRevisionId: unpriced.revision.estimator_revision_id,
      correctionReason: "Import the explicitly approved catalog",
      importedByUserId: OWNER_ID,
      idempotencyKey: "pricing:test:import-A",
    };
    const importedA = await importEstimatorEvidenceFromNativeSources(
      runtime,
      req,
      instant(1000),
    );
    const authorityA = await resolveNativeEstimatorAuthority(
      runtime,
      TENANT,
      JOB_ID,
      instant(1000),
    );
    assert.equal(authorityA.state, "current");
    const previewA = await buildEstimatorWorkbenchReadModel(
      runtime,
      auth("owner"),
      JOB_ID,
      instant(1000),
    );
    assert.ok(previewA);
    assert.equal(
      previewA.measurements.selected!.computed_estimate.state,
      "priced",
    );
    const frozenPayload = importedA.revision.payload_json,
      frozenDigest = importedA.revision.payload_sha256;
    const b = await createCatalogRevision(
      runtime,
      actor,
      { label: "Synthetic B", price_list: catalogList(2, 250) },
      "pricing:test:create-B",
      instant(3000),
    );
    await activateCatalogRevision(
      runtime,
      actor,
      {
        revision_id: b.revision.revision_id,
        reviewed_sha256: b.revision.snapshot_sha256,
        expected_version: 1,
      },
      "pricing:test:approve-B",
      instant(3000),
    );
    const savedA = await buildEstimatorWorkbenchReadModel(
      runtime,
      auth("owner"),
      JOB_ID,
      instant(4000),
    );
    assert.ok(savedA);
    assert.deepEqual(
      savedA.measurements.selected!.computed_estimate,
      previewA.measurements.selected!.computed_estimate,
    );
    runtime.APP_PRICING_CATALOG_ENABLED = "false";
    const rollbackView = await buildEstimatorWorkbenchReadModel(
      runtime,
      auth("owner"),
      JOB_ID,
      instant(4000),
    );
    assert.ok(rollbackView);
    assert.deepEqual(
      rollbackView.measurements.selected!.computed_estimate,
      previewA.measurements.selected!.computed_estimate,
    );
    runtime.APP_PRICING_CATALOG_ENABLED = "true";
    const replay = await importEstimatorEvidenceFromNativeSources(
      runtime,
      req,
      instant(4000),
    );
    assert.equal(replay.kind, "replayed");
    assert.equal(replay.revision.payload_json, frozenPayload);
    assert.equal(replay.revision.payload_sha256, frozenDigest);
    assert.equal(
      JSON.parse(replay.revision.payload_json).pricing_authority
        .catalog_activation_id,
      approvedA.activation.activation_id,
    );
    const restoredPath = join(directory, "catalog.sqlite");
    await backup(database.raw, restoredPath);
    const restored = new SqliteD1(restoredPath),
      restoredEnv = { ...runtime, DB: restored as never };
    try {
      const restoredA = await buildEstimatorWorkbenchReadModel(
        restoredEnv,
        auth("owner"),
        JOB_ID,
        instant(4000),
      );
      assert.ok(restoredA);
      assert.deepEqual(
        restoredA.measurements.selected!.computed_estimate,
        previewA.measurements.selected!.computed_estimate,
      );
      const pin = restored.raw
        .prepare("SELECT * FROM estimator_pricing_catalog_pins")
        .all();
      assert.equal(pin.length, 1);
      assert.deepEqual(
        pin,
        database.raw
          .prepare("SELECT * FROM estimator_pricing_catalog_pins")
          .all(),
      );
      assert.deepEqual(
        restored.raw.prepare("PRAGMA foreign_key_check").all(),
        [],
      );
    } finally {
      restored.raw.close();
    }
    const importedB = await importEstimatorEvidenceFromNativeSources(
      runtime,
      {
        ...req,
        revisionNumber: 3,
        supersedesEstimatorRevisionId: importedA.revision.estimator_revision_id,
        correctionReason: "Review the new catalog",
        idempotencyKey: "pricing:test:import-B",
      },
      instant(4000),
    );
    const ruleB = JSON.parse(importedB.revision.payload_json).pricing_authority;
    assert.equal(ruleB.catalog_revision_id, b.revision.revision_id);
    assert.equal(
      ruleB.pricing_policy_snapshot_sha256,
      b.revision.snapshot_sha256,
    );
    const previewB = await buildEstimatorWorkbenchReadModel(
      runtime,
      auth("owner"),
      JOB_ID,
      instant(4000),
    );
    assert.ok(previewB);
    assert.notEqual(
      previewB.measurements.selected!.computed_estimate.total,
      previewA.measurements.selected!.computed_estimate.total,
    );
    const originalRule = JSON.parse(frozenPayload).pricing_authority;
    await assert.rejects(() =>
      resolveFrozenCatalogPricing(
        runtime,
        TENANT,
        { ...originalRule, pricing_policy_snapshot_sha256: "e".repeat(64) },
        importedA.revision.estimator_revision_id,
      ),
    );
    for (const table of ["estimator_pricing_catalog_pins"]) {
      assert.throws(
        () => database.raw.exec(`DELETE FROM ${table}`),
        /pricing_catalog_immutable/,
      );
      assert.throws(
        () =>
          database.raw.exec(
            `UPDATE ${table} SET priced_at='2035-01-01T00:00:00.000Z'`,
          ),
        /pricing_catalog_immutable/,
      );
    }
    assert.equal(
      (
        database.raw
          .prepare("SELECT count(*) n FROM estimator_pricing_catalog_pins")
          .get() as { n: number }
      ).n,
      2,
    );
    // Switching the active head between price selection and the D1 insert must
    // roll back the entire new estimator revision and its pin.
    const c = await createCatalogRevision(
      runtime,
      actor,
      { label: "Synthetic C", price_list: catalogList(3, 400) },
      "pricing:test:create-C",
      instant(5000),
    );
    const originalPrepare = database.prepare.bind(database);
    let switchHead = true;
    database.prepare = (sql: string) => {
      const statement = originalPrepare(sql),
        originalBind = statement.bind.bind(statement);
      statement.bind = (...args: unknown[]) => {
        const bound = originalBind(...args),
          originalRun = bound.run.bind(bound);
        if (sql.startsWith("INSERT INTO estimator_evidence_revisions"))
          bound.run = async () => {
            if (switchHead) {
              switchHead = false;
              await activateCatalogRevision(
                runtime,
                actor,
                {
                  revision_id: c.revision.revision_id,
                  reviewed_sha256: c.revision.snapshot_sha256,
                  expected_version: 2,
                },
                "pricing:test:approve-C",
                instant(6000),
              );
            }
            return originalRun();
          };
        return bound;
      };
      return statement;
    };
    await assert.rejects(
      () =>
        importEstimatorEvidenceFromNativeSources(
          runtime,
          {
            ...req,
            revisionNumber: 4,
            supersedesEstimatorRevisionId:
              importedB.revision.estimator_revision_id,
            correctionReason: "Synthetic concurrent pricing selection",
            idempotencyKey: "pricing:test:import-stale",
          },
          instant(6000),
        ),
      /pricing_catalog_import_drift/,
    );
    assert.equal(
      (
        database.raw
          .prepare("SELECT count(*) n FROM estimator_evidence_revisions")
          .get() as { n: number }
      ).n,
      3,
    );
    assert.equal(
      (
        database.raw
          .prepare("SELECT count(*) n FROM estimator_pricing_catalog_pins")
          .get() as { n: number }
      ).n,
      2,
    );
    database.prepare = originalPrepare;
    // Missing rates remain a hard import stop rather than a zero-price quote.
    const incomplete = catalogList(4);
    delete (incomplete.trims as Record<string, unknown>).eave_drip;
    const bad = await createCatalogRevision(
      runtime,
      actor,
      { label: "Synthetic incomplete", price_list: incomplete },
      "pricing:test:create-incomplete",
      instant(7000),
    );
    await activateCatalogRevision(
      runtime,
      actor,
      {
        revision_id: bad.revision.revision_id,
        reviewed_sha256: bad.revision.snapshot_sha256,
        expected_version: 3,
      },
      "pricing:test:approve-incomplete",
      instant(7000),
    );
    await assert.rejects(
      () =>
        importEstimatorEvidenceFromNativeSources(
          runtime,
          {
            ...req,
            revisionNumber: 4,
            supersedesEstimatorRevisionId:
              importedB.revision.estimator_revision_id,
            correctionReason: "Synthetic missing rate",
            idempotencyKey: "pricing:test:import-missing-rate",
          },
          instant(8000),
        ),
      /explicit rate/,
    );
    assert.equal(
      (
        database.raw
          .prepare("SELECT count(*) n FROM estimator_evidence_revisions")
          .get() as { n: number }
      ).n,
      3,
    );
  } finally {
    database.raw.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Estimator authority records, replays, and corrects one exact native evidence head", async () => {
  const db = new SqliteD1();
  const runtime = env(db);
  const first = await recordEstimatorEvidenceRevision(runtime, input(), NOW);
  assert.equal(first.kind, "created");
  assert.equal(first.revision.revision_number, 1);
  assert.equal(first.revision.measurement_raw_sha256, "a".repeat(64));
  assert.equal(first.revision.facet_event_id, null);
  assert.equal(first.revision.commercial_quote_revision_id, null);
  assert.deepEqual(JSON.parse(first.revision.payload_json), payload());

  const replay = await recordEstimatorEvidenceRevision(runtime, input(), NOW);
  assert.equal(replay.kind, "replayed");
  assert.equal(
    replay.revision.estimator_revision_id,
    first.revision.estimator_revision_id,
  );

  const corrected = await recordEstimatorEvidenceRevision(
    runtime,
    input({
      revisionNumber: 2,
      supersedesEstimatorRevisionId: first.revision.estimator_revision_id,
      correctionReason: "Corrected verified source interpretation",
      payload: payload("corrected"),
      idempotencyKey: "estimator-import-key-0002",
    }),
    new Date(NOW.getTime() + 1_000),
  );
  assert.equal(corrected.kind, "created");
  assert.equal(corrected.revision.revision_number, 2);
  const head = await readEstimatorEvidenceHead(runtime, TENANT, JOB_ID);
  assert.equal(head.state, "current");
  assert.equal(
    head.revision?.estimator_revision_id,
    corrected.revision.estimator_revision_id,
  );

  const lostResponseReplay = await recordEstimatorEvidenceRevision(
    runtime,
    input(),
    NOW,
  );
  assert.equal(lostResponseReplay.kind, "replayed");
  assert.equal(
    lostResponseReplay.revision.estimator_revision_id,
    first.revision.estimator_revision_id,
  );
});

test("Estimator idempotency keys are isolated by tenant", async () => {
  const db = new SqliteD1();
  const runtime = env(db);
  const otherDelta = seedOtherTenant(db.raw);
  const sharedKey = "estimator-import-shared-cross-tenant";
  const first = await recordEstimatorEvidenceRevision(
    runtime,
    input({ idempotencyKey: sharedKey }),
    NOW,
  );
  const secondPayload = payload("other-tenant");
  secondPayload.measurement.native_evidence = {
    delta_ledger: {
      tenant_id: OTHER_TENANT,
      receipt_id: OTHER_RECEIPT_ID,
      row_count: 1,
      sha256: await sha256Hex(canonicalJson([otherDelta])),
      all_checks_pass: true,
      failed_checks: [],
    },
    report: null,
    ocr: { status: "not_requested", review_required: false },
  };
  const second = await recordEstimatorEvidenceRevision(
    runtime,
    input({
      tenantId: OTHER_TENANT,
      roofJobId: OTHER_JOB_ID,
      measurementReceiptId: OTHER_RECEIPT_ID,
      payload: secondPayload,
      importedByUserId: OTHER_OWNER_ID,
      idempotencyKey: sharedKey,
    }),
    NOW,
  );

  assert.equal(first.kind, "created");
  assert.equal(second.kind, "created");
  assert.notEqual(
    first.revision.estimator_revision_id,
    second.revision.estimator_revision_id,
  );
});

test("Estimator authority rejects tenant, job-version, predecessor, and idempotency drift", async () => {
  const db = new SqliteD1();
  const runtime = env(db);
  const created = await recordEstimatorEvidenceRevision(runtime, input(), NOW);

  await rejectsCode(
    () =>
      recordEstimatorEvidenceRevision(
        runtime,
        input({ tenantId: OTHER_TENANT }),
        NOW,
      ),
    "estimator_job_missing",
  );
  db.raw
    .prepare(
      "UPDATE operating_roof_jobs SET version = 2, updated_at = ? WHERE roof_job_id = ?",
    )
    .run(new Date(NOW.getTime() + 1_000).toISOString(), JOB_ID);
  await rejectsCode(
    () =>
      recordEstimatorEvidenceRevision(
        runtime,
        input({ idempotencyKey: "estimator-import-key-drift" }),
        NOW,
      ),
    "estimator_job_version_drift",
  );
  await rejectsCode(
    () =>
      recordEstimatorEvidenceRevision(
        runtime,
        input({
          operatingJobVersion: 2,
          revisionNumber: 2,
          supersedesEstimatorRevisionId: "estimator:not-the-head",
          correctionReason: "Wrong predecessor",
          idempotencyKey: "estimator-import-key-wrong-predecessor",
        }),
        NOW,
      ),
    "estimator_revision_predecessor_mismatch",
  );
  await rejectsCode(
    () =>
      recordEstimatorEvidenceRevision(
        runtime,
        input({ payload: payload("conflict") }),
        NOW,
      ),
    "estimator_idempotency_conflict",
  );
  assert.ok(created.revision.estimator_revision_id);
});

test("Estimator authority detects competing terminal revisions and is append-only", async () => {
  const db = new SqliteD1();
  const runtime = env(db);
  const first = await recordEstimatorEvidenceRevision(runtime, input(), NOW);
  const second = await recordEstimatorEvidenceRevision(
    runtime,
    input({
      revisionNumber: 2,
      supersedesEstimatorRevisionId: first.revision.estimator_revision_id,
      correctionReason: "First correction branch",
      payload: payload("branch-a"),
      idempotencyKey: "estimator-import-key-branch-a",
    }),
    new Date(NOW.getTime() + 1_000),
  );

  db.raw
    .prepare(
      `INSERT INTO estimator_evidence_revisions
     SELECT 'estimator:${"b".repeat(64)}', tenant_id, roof_job_id, operating_job_version,
            3, ?, measurement_receipt_id, measurement_raw_key, measurement_raw_sha256,
            facet_event_id, facet_raw_key, facet_raw_sha256, facet_design_revision_id,
            facet_design_revision_sha256, facet_frozen_evidence_sha256,
            commercial_quote_revision_id, payload_json, payload_sha256, evidence_refs_json,
            evidence_digest, ?, ?, 'Competing correction branch', imported_by_user_id, ?
       FROM estimator_evidence_revisions WHERE estimator_revision_id = ?`,
    )
    .run(
      first.revision.estimator_revision_id,
      "c".repeat(64),
      "d".repeat(64),
      new Date(NOW.getTime() + 2_000).toISOString(),
      second.revision.estimator_revision_id,
    );
  const head = await readEstimatorEvidenceHead(runtime, TENANT, JOB_ID);
  assert.equal(head.state, "ambiguous");
  assert.equal(head.competing_revision_ids.length, 2);

  assert.throws(
    () =>
      db.raw
        .prepare(
          "UPDATE estimator_evidence_revisions SET correction_reason = 'rewrite' WHERE estimator_revision_id = ?",
        )
        .run(first.revision.estimator_revision_id),
    /append-only/,
  );
  assert.throws(
    () =>
      db.raw
        .prepare(
          "DELETE FROM estimator_evidence_revisions WHERE estimator_revision_id = ?",
        )
        .run(first.revision.estimator_revision_id),
    /append-only/,
  );
});

test("native Estimator import verifies R2 evidence, replays, isolates tenants, and exposes drift", async () => {
  const db = new SqliteD1();
  const source = JSON.stringify({
    job_number: JOB_NUMBER,
    source_xml: [
      "<APPLICAD_EXPORT>",
      '<POINT id="P1" data="0,0,0"/>',
      '<POINT id="P2" data="10,0,0"/>',
      '<POINT id="P3" data="10,10,0"/>',
      '<POINT id="P4" data="0,10,0"/>',
      '<LINE id="L1" path="P1,P2" type="EAVE" length="10"/>',
      '<LINE id="L2" path="P2,P3" type="RIDGE" length="10"/>',
      '<LINE id="L3" path="P3,P4" type="EAVE" length="10"/>',
      '<LINE id="L4" path="P4,P1" type="EAVE" length="10"/>',
      '<POLYGON id="F1" path="L1,L2,L3,L4" type="Roof" size="100" mat="Metal"/>',
      "</APPLICAD_EXPORT>",
    ].join(""),
    ironwrap_estimator: {
      scope_clauses: [
        {
          scope_clause_id: "clause:deck",
          clause_type: "Risk",
          title: "Deck condition",
          clause_text:
            "Hidden deck damage requires documented scope correction.",
          version: "1",
          status: "Approved",
          source_ref: "verified-measurement:scope-clause-1",
          customer_visible: true,
        },
      ],
    },
  });
  const sourceSha = await sha256Hex(source);
  const rawKey = `raw/measurements/${"a".repeat(64)}.json`;
  db.raw
    .prepare(
      `UPDATE measurement_intake_receipts SET payload_hash = ?, raw_key = ?
        WHERE receipt_id = ?`,
    )
    .run(sourceSha, rawKey, RECEIPT_ID);
  let currentSource = source;
  const runtime = {
    DB: db as never,
    RAW: {
      get: async (key: string) =>
        key === rawKey
          ? {
              size: new TextEncoder().encode(currentSource).byteLength,
              text: async () => currentSource,
            }
          : null,
    },
  } as unknown as AppEnv;
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error("network_not_allowed");
  };
  try {
    const request = {
      tenantId: TENANT,
      roofJobId: JOB_ID,
      measurementReceiptId: RECEIPT_ID,
      revisionNumber: 1,
      importedByUserId: OWNER_ID,
      idempotencyKey: "estimator-native-import-0001",
    };
    const created = await importEstimatorEvidenceFromNativeSources(
      runtime,
      request,
      NOW,
    );
    assert.equal(created.kind, "created");
    const replay = await importEstimatorEvidenceFromNativeSources(
      runtime,
      request,
      new Date(NOW.getTime() + 60_000),
    );
    assert.equal(replay.kind, "replayed");
    assert.equal(
      replay.revision.estimator_revision_id,
      created.revision.estimator_revision_id,
    );

    const authority = await resolveNativeEstimatorAuthority(
      runtime,
      TENANT,
      JOB_ID,
    );
    assert.equal(authority.state, "current");
    const sources = await readNativeEstimatorSources(runtime, TENANT, JOB_ID);
    assert.ok(sources);
    assert.equal(sources.measurementRows.length, 1);
    assert.equal(sources.takeoffRows.length, 1);
    assert.ok(
      Array.isArray(sources.takeoffRows[0]?.items) &&
        sources.takeoffRows[0].items.length >= 4,
    );
    assert.equal(sources.scopeRows[0]?.scope_clause_id, "clause:deck");
    assert.deepEqual(sources.staleFields, []);
    assert.equal(
      await readNativeEstimatorSources(runtime, OTHER_TENANT, JOB_ID),
      null,
    );
    assert.equal(networkCalls, 0);

    currentSource = source.replace("Metal", "Altered");
    const stale = await resolveNativeEstimatorAuthority(
      runtime,
      TENANT,
      JOB_ID,
    );
    assert.equal(stale.state, "stale");
    assert.deepEqual(stale.reasons, [
      "estimator_evidence.measurement_source_drift",
    ]);
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("measurement evidence is tenant-bound and duplicate tenant ownership fails closed", async () => {
  const db = new SqliteD1();
  const runtime = env(db);
  await rejectsCode(
    () =>
      readEstimatorMeasurementEvidenceAnchor(runtime, OTHER_TENANT, RECEIPT_ID),
    "estimator_measurement_tenant_mismatch",
  );
  db.raw
    .prepare(
      `INSERT INTO measurement_deltas
       (receipt_id, measurement_id, job_number, provider, source, check_name, metric,
        ok, primary_value, independent_value, rel_diff, abs_diff, detail, created_at,
        tenant_id, error_kind, signed_error)
       VALUES (?, ?, ?, 'AppliCad', 'google_solar', 'solar_area', 'roof_area',
               1, 100, 100, 0, NULL, 'within tolerance', ?, ?,
               'relative_fraction', 0)`,
    )
    .run(
      RECEIPT_ID,
      MEASUREMENT_ID,
      JOB_NUMBER,
      NOW.toISOString(),
      OTHER_TENANT,
    );
  await rejectsCode(
    () => readEstimatorMeasurementEvidenceAnchor(runtime, TENANT, RECEIPT_ID),
    "estimator_measurement_tenant_ambiguous",
  );
});

test("completed OCR and report evidence are hash-bound, review-only, and rechecked from R2", async () => {
  const db = new SqliteD1();
  const source = JSON.stringify({
    job_number: JOB_NUMBER,
    source_xml: [
      "<APPLICAD_EXPORT>",
      '<POINT id="P1" data="0,0,0"/>',
      '<POINT id="P2" data="10,0,0"/>',
      '<POINT id="P3" data="10,10,0"/>',
      '<POINT id="P4" data="0,10,0"/>',
      '<LINE id="L1" path="P1,P2" type="EAVE" length="10"/>',
      '<LINE id="L2" path="P2,P3" type="RIDGE" length="10"/>',
      '<LINE id="L3" path="P3,P4" type="EAVE" length="10"/>',
      '<LINE id="L4" path="P4,P1" type="EAVE" length="10"/>',
      '<POLYGON id="F1" path="L1,L2,L3,L4" type="Roof" size="100" mat="Metal"/>',
      "</APPLICAD_EXPORT>",
    ].join(""),
  });
  const sourceSha = await sha256Hex(source);
  const sourceKey = `raw/measurements/${"a".repeat(64)}.json`;
  const report = "%PDF-1.7 deterministic fixture";
  const reportSha = await sha256Hex(report);
  const reportKey = `raw/measurement-reports/${reportSha}.bin`;
  const model = "claude-opus-5";
  const resultSlot = await sha256Hex(
    `measurement-ocr/v1\n${RECEIPT_ID}\n${reportSha}\n${model}`,
  );
  const ocrKey = `raw/measurement-ocr/${RECEIPT_ID}/${resultSlot}.json`;
  let ocrText = JSON.stringify({
    schemaVersion: "ironwrap.measurement-ocr.v1",
    model,
    reportSha256: reportSha,
    requestSha256: "1".repeat(64),
    responseSha256: "2".repeat(64),
    extractedAt: NOW.toISOString(),
    jobNumberCandidate: {
      value: JOB_NUMBER,
      sourceRef: "page:1",
      confidence: "high",
    },
    measurements: { squares: 1 },
    sourceRefs: { squares: "page:1" },
    confidences: { squares: "high" },
    checks: [],
    reviewRequired: true,
    providerResponse: {},
  });
  const ocrSha = await sha256Hex(ocrText);
  db.raw
    .prepare(
      `UPDATE measurement_intake_receipts
          SET payload_hash = ?, raw_key = ?, report_raw_key = ?, report_sha256 = ?,
              report_content_type = 'application/pdf', ocr_status = 'completed',
              ocr_model = ?, ocr_result_key = ?, ocr_result_sha256 = ?,
              ocr_job_number_candidate = ?, ocr_job_number_source_ref = 'page:1',
              ocr_review_required = 1, ocr_completed_at = ?
        WHERE receipt_id = ?`,
    )
    .run(
      sourceSha,
      sourceKey,
      reportKey,
      reportSha,
      model,
      ocrKey,
      ocrSha,
      JOB_NUMBER,
      NOW.toISOString(),
      RECEIPT_ID,
    );
  const r2Object = (value: string) => {
    const bytes = new TextEncoder().encode(value);
    return {
      size: bytes.byteLength,
      text: async () => value,
      arrayBuffer: async () => bytes.buffer,
    };
  };
  const runtime = {
    DB: db as never,
    RAW: {
      get: async (key: string) =>
        key === sourceKey
          ? r2Object(source)
          : key === reportKey
            ? r2Object(report)
            : key === ocrKey
              ? r2Object(ocrText)
              : null,
    },
  } as unknown as AppEnv;
  const created = await importEstimatorEvidenceFromNativeSources(
    runtime,
    {
      tenantId: TENANT,
      roofJobId: JOB_ID,
      measurementReceiptId: RECEIPT_ID,
      revisionNumber: 1,
      importedByUserId: OWNER_ID,
      idempotencyKey: "estimator-native-ocr-import-0001",
    },
    NOW,
  );
  const stored = JSON.parse(created.revision.payload_json) as {
    measurement: {
      review_status: string;
      native_evidence: { ocr: { status: string; review_required: boolean } };
    };
  };
  assert.equal(stored.measurement.review_status, "Needs Review");
  assert.deepEqual(stored.measurement.native_evidence.ocr, {
    status: "completed",
    model,
    result_key: ocrKey,
    result_sha256: ocrSha,
    report_sha256: reportSha,
    job_number_candidate: JOB_NUMBER,
    job_number_source_ref: "page:1",
    review_required: true,
    completed_at: NOW.toISOString(),
  });

  ocrText = ocrText.replace('"squares":1', '"squares":2');
  const stale = await resolveNativeEstimatorAuthority(runtime, TENANT, JOB_ID);
  assert.equal(stale.state, "stale");
  assert.ok(
    stale.reasons.includes("estimator_evidence.measurement_supplemental_drift"),
  );
});

test("0081 Estimator authority is included in both D1 recovery contracts", () => {
  const backup = readFileSync(
    new URL("../../deploy/backup-d1-to-r2.sh", import.meta.url),
    "utf8",
  );
  const restore = readFileSync(
    new URL("../../deploy/restore-d1-from-r2.sh", import.meta.url),
    "utf8",
  );
  for (const contract of [backup, restore]) {
    assert.match(contract, /REQUIRED_TABLES\+=",estimator_evidence_revisions"/);
    assert.match(
      contract,
      /idx_estimator_evidence_job_revision=estimator_evidence_revisions/,
    );
    assert.match(
      contract,
      /estimator_evidence_revisions_immutable_update=estimator_evidence_revisions/,
    );
    // Pinned through 0200, including privacy, crew-stop guards, the stop release record, durable
    // writer claims and the AI team tables,
    // durable office intake receipts, manual measurement history, the safety stop release guard
    // and the 0153 gate ledger.
    assert.match(contract, /REQUIRED_TABLE_COUNT=281/);
    assert.match(contract, /REQUIRED_INDEX_COUNT=395/);
    assert.match(contract, /REQUIRED_TRIGGER_COUNT=782/);
  }
});

async function rejectsCode(
  run: () => Promise<unknown>,
  code: string,
): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof EstimatorNativeStoreError);
    assert.equal(error.code, code);
    return true;
  });
}

function seed(db: DatabaseSync): void {
  const now = NOW.toISOString();
  const envelopeId = "ow_estimator_0001";
  const leadId = "lead:estimator:0001";
  const customerId = "customer:estimator:0001";
  db.prepare(
    `INSERT INTO app_users
     (user_id, tenant_id, email_normalized, display_name, role, frappe_user_id,
      active, created_by, created_at, updated_at)
     VALUES (?, ?, 'owner@example.invalid', 'Owner', 'owner', NULL, 1, 'test-seed', ?, ?)`,
  ).run(OWNER_ID, TENANT, now, now);
  db.prepare(
    `INSERT INTO envelopes
     (envelope_id, source, contact_name, contact_email, payload_json, raw_key, ts,
      status, created_at, updated_at)
     VALUES (?, 'website', 'Customer', 'customer@example.invalid', '{}', ?, ?, 'reconciled', ?, ?)`,
  ).run(envelopeId, "raw/estimator/0001.json", now, now, now);
  db.prepare(
    `INSERT INTO operating_leads
     (lead_id, tenant_id, source_envelope_id, source_raw_key, source, contact_name,
      contact_email, lifecycle_status, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'website', 'Customer', 'customer@example.invalid', 'qualified', 1, ?, ?)`,
  ).run(leadId, TENANT, envelopeId, "raw/estimator/0001.json", now, now);
  db.prepare(
    `INSERT INTO operating_customers
     (customer_id, tenant_id, source_envelope_id, source_raw_key, display_name,
      contact_email, lifecycle_status, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Customer', 'customer@example.invalid', 'active', 1, ?, ?)`,
  ).run(customerId, TENANT, envelopeId, "raw/estimator/0001.json", now, now);
  db.prepare(
    `INSERT INTO operating_roof_jobs
     (roof_job_id, tenant_id, lead_id, customer_id, property_id, source_envelope_id,
      source_raw_key, brand, job_number, service_type, job_status, current_gate_state,
      version, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, 'ironwrap', ?, 'roof_replacement', 'qualified',
             'qualification', 1, ?, ?)`,
  ).run(
    JOB_ID,
    TENANT,
    leadId,
    customerId,
    envelopeId,
    "raw/estimator/0001.json",
    JOB_NUMBER,
    now,
    now,
  );
  db.prepare(
    `INSERT INTO measurement_intake_receipts
     (receipt_id, idempotency_key_hash, payload_hash, key_strategy, measurement_id,
      provider, job_number, raw_key, content_type, status, lease_token, lease_expires_at,
      attempts, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, 'payload_hash', ?, 'AppliCad', ?, ?, 'application/json',
             'matched', NULL, NULL, 1, ?, ?, ?)`,
  ).run(
    RECEIPT_ID,
    "e".repeat(64),
    "a".repeat(64),
    MEASUREMENT_ID,
    JOB_NUMBER,
    `raw/measurements/${"a".repeat(64)}.json`,
    now,
    now,
    now,
  );
  db.prepare(
    `INSERT INTO measurement_deltas
     (receipt_id, measurement_id, job_number, provider, source, check_name, metric,
      ok, primary_value, independent_value, rel_diff, abs_diff, detail, created_at,
      tenant_id, error_kind, signed_error)
     VALUES (?, ?, ?, 'AppliCad', 'google_solar', 'solar_area', 'roof_area',
             1, 100, 100, 0, NULL, 'within tolerance', ?, ?,
             'relative_fraction', 0)`,
  ).run(RECEIPT_ID, MEASUREMENT_ID, JOB_NUMBER, now, TENANT);
}

function seedOtherTenant(db: DatabaseSync): typeof DELTA_ROW {
  const now = NOW.toISOString();
  const envelopeId = "ow_estimator_iroof_0001";
  const leadId = "lead:estimator:iroof:0001";
  const customerId = "customer:estimator:iroof:0001";
  const rawKey = "raw/estimator/iroof/0001.json";
  db.prepare(
    `INSERT INTO app_users
     (user_id, tenant_id, email_normalized, display_name, role, frappe_user_id,
      active, created_by, created_at, updated_at)
     VALUES (?, ?, 'owner@iroof.example.invalid', 'iRoof Owner', 'owner', NULL, 1,
             'test-seed', ?, ?)`,
  ).run(OTHER_OWNER_ID, OTHER_TENANT, now, now);
  db.prepare(
    `INSERT INTO envelopes
     (envelope_id, source, contact_name, contact_email, payload_json, raw_key, ts,
      status, created_at, updated_at)
     VALUES (?, 'website', 'iRoof Customer', 'customer@iroof.example.invalid', '{}', ?, ?,
             'reconciled', ?, ?)`,
  ).run(envelopeId, rawKey, now, now, now);
  db.prepare(
    `INSERT INTO operating_leads
     (lead_id, tenant_id, source_envelope_id, source_raw_key, source, contact_name,
      contact_email, lifecycle_status, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'website', 'iRoof Customer', 'customer@iroof.example.invalid',
             'qualified', 1, ?, ?)`,
  ).run(leadId, OTHER_TENANT, envelopeId, rawKey, now, now);
  db.prepare(
    `INSERT INTO operating_customers
     (customer_id, tenant_id, source_envelope_id, source_raw_key, display_name,
      contact_email, lifecycle_status, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'iRoof Customer', 'customer@iroof.example.invalid',
             'active', 1, ?, ?)`,
  ).run(customerId, OTHER_TENANT, envelopeId, rawKey, now, now);
  db.prepare(
    `INSERT INTO operating_roof_jobs
     (roof_job_id, tenant_id, lead_id, customer_id, property_id, source_envelope_id,
      source_raw_key, brand, job_number, service_type, job_status, current_gate_state,
      version, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, 'iroof', ?, 'roof_replacement', 'qualified',
             'qualification', 1, ?, ?)`,
  ).run(
    OTHER_JOB_ID,
    OTHER_TENANT,
    leadId,
    customerId,
    envelopeId,
    rawKey,
    OTHER_JOB_NUMBER,
    now,
    now,
  );
  db.prepare(
    `INSERT INTO measurement_intake_receipts
     (receipt_id, idempotency_key_hash, payload_hash, key_strategy, measurement_id,
      provider, job_number, raw_key, content_type, status, lease_token, lease_expires_at,
      attempts, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, 'payload_hash', ?, 'AppliCad', ?, ?, 'application/json',
             'matched', NULL, NULL, 1, ?, ?, ?)`,
  ).run(
    OTHER_RECEIPT_ID,
    "d".repeat(64),
    "b".repeat(64),
    OTHER_MEASUREMENT_ID,
    OTHER_JOB_NUMBER,
    `raw/measurements/${"b".repeat(64)}.json`,
    now,
    now,
    now,
  );
  const delta = {
    ...DELTA_ROW,
    tenant_id: OTHER_TENANT,
    receipt_id: OTHER_RECEIPT_ID,
    measurement_id: OTHER_MEASUREMENT_ID,
    job_number: OTHER_JOB_NUMBER,
  };
  db.prepare(
    `INSERT INTO measurement_deltas
     (receipt_id, measurement_id, job_number, provider, source, check_name, metric,
      ok, primary_value, independent_value, rel_diff, abs_diff, detail, created_at,
      tenant_id, error_kind, signed_error)
     VALUES (?, ?, ?, 'AppliCad', 'google_solar', 'solar_area', 'roof_area',
             1, 100, 100, 0, NULL, 'within tolerance', ?, ?,
             'relative_fraction', 0)`,
  ).run(
    OTHER_RECEIPT_ID,
    OTHER_MEASUREMENT_ID,
    OTHER_JOB_NUMBER,
    now,
    OTHER_TENANT,
  );
  return delta;
}
