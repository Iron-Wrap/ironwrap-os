// Contract tests for the writing half: the operating graph an import materializes, the ledger it
// leaves behind, and the property the whole feature rests on - a second run over the same file
// creates nothing new.

import assert from "node:assert/strict";
import { test } from "node:test";

import { GHL_ADAPTER } from "../src/crm-import/adapters.ts";
import { parseCsv } from "../src/crm-import/csv.ts";
import { planImport } from "../src/crm-import/plan.ts";
import { SEEDED_SALES_PIPELINE } from "../src/crm-import/stage-map.ts";
import { executeImport, getImportRunReport, listImportRuns } from "../src/crm-import/store.ts";
import { FIXTURE_NOW, TestD1, fixtureCsv, testEnv } from "./crm-import-fixture.ts";

function buildPlan(csv = fixtureCsv("ghl-opportunities.csv")) {
  return planImport({
    adapter: GHL_ADAPTER,
    map: SEEDED_SALES_PIPELINE,
    records: parseCsv(csv).records,
    sourceLabel: "ghl-opportunities.csv",
    generatedAt: FIXTURE_NOW,
  });
}

async function run(db: TestD1, now = FIXTURE_NOW, csv?: string) {
  return executeImport(testEnv(db), {
    plan: buildPlan(csv),
    sourceLabel: "ghl-opportunities.csv",
    now,
  });
}

test("execute materializes the operating graph through the ordinary core path", async () => {
  const db = new TestD1();
  const report = await run(db);

  assert.equal(report.mode, "execute");
  assert.equal(report.applied?.created, 10);
  assert.equal(report.applied?.adopted, 0);
  assert.equal(report.applied?.failed, 0);

  assert.equal(db.count("envelopes"), 10);
  assert.equal(db.count("operating_leads"), 10);
  assert.equal(db.count("operating_customers"), 10);
  assert.equal(db.count("operating_roof_jobs"), 10);
  assert.equal(db.count("crm_import_records"), 10);

  // Six rows carry a value at or beyond Need Quote; those are the only estimates created.
  assert.equal(db.count("operating_instant_estimates"), 6);
  const totals = db.rows<{ total: number }>(
    "SELECT SUM(estimate_total_cents) AS total FROM operating_instant_estimates",
  );
  assert.equal(Number(totals[0]!.total), 9_915_050);

  // No consent is invented for an imported contact.
  assert.equal(db.count("operating_consents"), 0);
});

test("a second run over the same file adopts every record and duplicates nothing", async () => {
  const db = new TestD1();
  await run(db);
  const before = {
    envelopes: db.count("envelopes"),
    leads: db.count("operating_leads"),
    customers: db.count("operating_customers"),
    jobs: db.count("operating_roof_jobs"),
    estimates: db.count("operating_instant_estimates"),
    records: db.count("crm_import_records"),
  };

  const second = await run(db, "2026-08-23T09:30:00.000Z");
  assert.equal(second.applied?.created, 0);
  assert.equal(second.applied?.adopted, 10);
  assert.equal(second.applied?.failed, 0);

  assert.deepEqual({
    envelopes: db.count("envelopes"),
    leads: db.count("operating_leads"),
    customers: db.count("operating_customers"),
    jobs: db.count("operating_roof_jobs"),
    estimates: db.count("operating_instant_estimates"),
    records: db.count("crm_import_records"),
  }, before);

  // The record keeps its original run as first_run_id and moves last_run_id forward.
  const record = db.rows<{ first_run_id: string; last_run_id: string; created_at: string; updated_at: string }>(
    "SELECT first_run_id, last_run_id, created_at, updated_at FROM crm_import_records WHERE import_key = ?",
    "opp-006",
  )[0]!;
  assert.notEqual(record.first_run_id, record.last_run_id);
  assert.equal(record.created_at, FIXTURE_NOW);
  assert.equal(record.updated_at, "2026-08-23T09:30:00.000Z");
  assert.equal(db.count("crm_import_runs"), 2);
});

test("stage placement and the capped source stage both survive in the ledger", async () => {
  const db = new TestD1();
  await run(db);

  const placements = db.rows<{ import_key: string; stage_key: string; source_stage: string; placement_verdict: string }>(
    "SELECT import_key, stage_key, source_stage, placement_verdict FROM crm_import_records ORDER BY import_key",
  );
  const byKey = Object.fromEntries(placements.map((row) => [row.import_key, row]));
  assert.equal(byKey["opp-005"]!.stage_key, "quote_sent");
  assert.equal(byKey["opp-007"]!.stage_key, "contract_signed");
  assert.equal(byKey["opp-007"]!.source_stage, "Deposit");
  assert.equal(byKey["opp-007"]!.placement_verdict, "capped");
  assert.equal(byKey["opp-009"]!.placement_verdict, "unmapped_default");

  const counts = db.rows<{ stage_key: string; cards: number; value: number }>(
    `SELECT stage_key, COUNT(*) AS cards, COALESCE(SUM(source_value_cents), 0) AS value
     FROM crm_import_records GROUP BY stage_key ORDER BY stage_key`,
  );
  assert.deepEqual(counts.map((row) => [row.stage_key, Number(row.cards), Number(row.value)]), [
    ["contract_signed", 3, 7_100_000],
    ["need_quote", 1, 1_275_050],
    ["new_lead", 3, 950_000],
    ["quote_sent", 2, 1_540_000],
    ["visit_booked", 1, 0],
  ]);
});

test("every capped, archived and failed disposition is queryable, not only logged", async () => {
  const db = new TestD1();
  const report = await run(db);

  const kinds = db.rows<{ kind: string; n: number }>(
    "SELECT kind, COUNT(*) AS n FROM crm_import_issues GROUP BY kind ORDER BY kind",
  );
  const byKind = Object.fromEntries(kinds.map((row) => [row.kind, Number(row.n)]));
  assert.equal(byKind.stage_capped, 2);
  assert.equal(byKind.stage_unmapped, 1);
  assert.equal(byKind.value_archived, 2);
  assert.equal(byKind.row_error, 1, "the contactless source row is recorded, not swallowed");
  assert.ok(byKind.field_archived >= 20);

  const capped = db.rows<{ detail: string }>(
    "SELECT detail FROM crm_import_issues WHERE kind = 'stage_capped' ORDER BY detail",
  );
  assert.match(capped[0]!.detail, /Deposit -> contract_signed/);
  assert.equal(report.rowErrors.length, 1);
});

test("the stored run report is the same report the caller was handed", async () => {
  const db = new TestD1();
  const report = await run(db);
  const stored = await getImportRunReport(testEnv(db), report.runId!);
  assert.deepEqual(stored, report);

  const runs = await listImportRuns(testEnv(db), 10);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.adapter, "ghl");
  assert.equal(runs[0]!.sourceRowCount, 11);
  assert.equal(await getImportRunReport(testEnv(db), "crmrun:ironwrap:missing"), null);
});

test("archived money and archived services stay readable on the envelope", async () => {
  const db = new TestD1();
  await run(db);
  const envelope = db.rows<{ payload_json: string }>(
    `SELECT e.payload_json FROM envelopes e
     JOIN crm_import_records r ON r.source_envelope_id = e.envelope_id
     WHERE r.import_key = ?`,
    "opp-002",
  )[0]!;
  const payload = JSON.parse(envelope.payload_json) as { estimate_total_cents?: number; crm_import: Record<string, unknown> };
  assert.equal(payload.estimate_total_cents, undefined);
  assert.equal(payload.crm_import.source_value_cents, 450_000);
  assert.equal(payload.crm_import.value_disposition, "archived");
  assert.deepEqual(payload.crm_import.services, ["Roofing", "Gutters"]);
  assert.equal((payload.crm_import.extras as Record<string, string>).Owner, "Sam Rep");
  assert.equal((payload.crm_import.activity as Record<string, string>).Notes, "1");
  assert.equal(payload.crm_import.source_lead_number, "26-202-NL");
});

test("a stage change is not implied by the import: authoritative job state stays default", async () => {
  const db = new TestD1();
  await run(db);
  const statuses = db.rows<{ job_status: string; n: number }>(
    "SELECT job_status, COUNT(*) AS n FROM operating_roof_jobs GROUP BY job_status",
  );
  assert.deepEqual(statuses.map((row) => [row.job_status, Number(row.n)]), [["qualified", 10]]);
});
