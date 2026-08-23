// Contract tests for the provider-agnostic planner: format parsing, adapter mapping, the stage
// placement map with its capping discipline, and the reconciliation report. No I/O of any kind.

import assert from "node:assert/strict";
import { test } from "node:test";

import { GENERIC_ADAPTER, GHL_ADAPTER, parseValueCents, resolveAdapter } from "../src/crm-import/adapters.ts";
import { parseCsv } from "../src/crm-import/csv.ts";
import { planImport } from "../src/crm-import/plan.ts";
import { SEEDED_SALES_PIPELINE, placeStage, valueFitsStage } from "../src/crm-import/stage-map.ts";
import { FIXTURE_NOW, fixtureCsv } from "./crm-import-fixture.ts";

function plan(csv = fixtureCsv("ghl-opportunities.csv")) {
  return planImport({
    adapter: GHL_ADAPTER,
    map: SEEDED_SALES_PIPELINE,
    records: parseCsv(csv).records,
    sourceLabel: "ghl-opportunities.csv",
    generatedAt: FIXTURE_NOW,
  });
}

test("csv reader keeps quoted commas and refuses a truncated record", () => {
  const table = parseCsv('a,b\n"1,5",two\n');
  assert.deepEqual(table.records, [{ a: "1,5", b: "two" }]);
  assert.throws(() => parseCsv('a,b\n"unterminated,two\n'), /crm_import_csv_unterminated_quote/);
  assert.throws(() => parseCsv("a,a\n1,2\n"), /crm_import_csv_duplicate_column/);
  assert.throws(() => parseCsv("a,b\n1,2,3\n"), /crm_import_csv_row_wider_than_header/);
});

test("currency cells parse to exact cents and refuse anything ambiguous", () => {
  assert.equal(parseValueCents("C$6,400.00"), 640000);
  assert.equal(parseValueCents("$12,750.50"), 1275050);
  assert.equal(parseValueCents("22000"), 2200000);
  assert.equal(parseValueCents(null), null);
  assert.equal(parseValueCents(""), null);
  assert.throws(() => parseValueCents("about 5k"), /crm_import_value_invalid/);
  assert.throws(() => parseValueCents("-100"), /crm_import_value_negative/);
});

test("the adapter is the only provider-specific layer: two adapters, one canonical row", () => {
  const ghl = GHL_ADAPTER.normalize({
    "Opportunity ID": "opp-1",
    "Contact Name": "Ada Synthetic",
    Email: "ADA@example.invalid",
    Phone: "(587) 555-0101",
    "Services Needed": "Roofing; Gutters",
    "Opportunity Value": "C$1,000.00",
    Stage: "Quote Sent",
  });
  const generic = GENERIC_ADAPTER.normalize({
    external_id: "opp-1",
    contact_name: "Ada Synthetic",
    email: "ADA@example.invalid",
    phone: "(587) 555-0101",
    service: "Roofing; Gutters",
    value: "C$1,000.00",
    stage: "Quote Sent",
  });
  assert.deepEqual(ghl, generic);
  assert.equal(ghl.email, "ada@example.invalid");
  assert.equal(ghl.phone, "+15875550101");
  assert.deepEqual(ghl.services, ["Roofing", "Gutters"]);
  assert.equal(ghl.valueCents, 100000);
  assert.equal(resolveAdapter("nope"), null);
});

test("an unparseable contact method is archived, not dropped and not fatal", () => {
  const row = GHL_ADAPTER.normalize({
    "Contact Name": "Ada Synthetic",
    Email: "not-an-email",
    Phone: "(587) 555-0101",
    Stage: "New Lead",
  });
  assert.equal(row.email, null);
  assert.equal(row.extras["email (unparseable)"], "not-an-email");
});

test("stage map: direct placements, capping with a reason, unmapped fallback", () => {
  assert.deepEqual(placeStage(SEEDED_SALES_PIPELINE, "Quote Sent").stageKey, "quote_sent");
  assert.equal(placeStage(SEEDED_SALES_PIPELINE, "  contract-signed ").stageKey, "contract_signed");

  const deposit = placeStage(SEEDED_SALES_PIPELINE, "Deposit");
  assert.equal(deposit.verdict, "capped");
  assert.equal(deposit.stageKey, "contract_signed");
  assert.equal(deposit.cappedFrom, "Deposit");
  assert.match(deposit.reason ?? "", /payment evidence/);

  const production = placeStage(SEEDED_SALES_PIPELINE, "Materials in prod");
  assert.equal(production.verdict, "capped");
  assert.equal(production.stageKey, "contract_signed");
  assert.match(production.reason ?? "", /production-gate evidence/);

  const unknown = placeStage(SEEDED_SALES_PIPELINE, "Nurture");
  assert.equal(unknown.verdict, "unmapped_default");
  assert.equal(unknown.stageKey, "new_lead");
  assert.equal(placeStage(SEEDED_SALES_PIPELINE, null).verdict, "unmapped_default");
});

test("value only fits a stage that could hold an estimate", () => {
  assert.equal(valueFitsStage(SEEDED_SALES_PIPELINE, "new_lead"), false);
  assert.equal(valueFitsStage(SEEDED_SALES_PIPELINE, "visit_booked"), false);
  assert.equal(valueFitsStage(SEEDED_SALES_PIPELINE, "need_quote"), true);
  assert.equal(valueFitsStage(SEEDED_SALES_PIPELINE, "contract_signed"), true);
});

test("plan reconciles every source row and every source cent", () => {
  const report = plan().report;
  assert.equal(report.reconciliation.sourceRows, 11);
  assert.equal(report.reconciliation.plannedRows, 10);
  assert.equal(report.reconciliation.erroredRows, 1);
  assert.equal(report.reconciliation.sourceValueCents, 10_865_050);
  assert.equal(report.reconciliation.placedValueCents, 9_915_050);
  assert.equal(report.reconciliation.archivedValueCents, 950_000);
  assert.equal(report.reconciliation.balanced, true);
  assert.match(report.rowErrors[0]!.reason, /contact_missing/);
  assert.equal(report.applied, null);
});

test("per-stage counts and totals are verifiable against the source board", () => {
  const stages = Object.fromEntries(plan().report.stages.map((stage) => [stage.stageKey, stage]));
  assert.equal(stages.new_lead!.cards, 3);
  assert.equal(stages.new_lead!.valuePlacedCents, 0);
  assert.equal(stages.new_lead!.valueArchivedCents, 950_000);
  assert.equal(stages.visit_booked!.cards, 1);
  assert.equal(stages.need_quote!.cards, 1);
  assert.equal(stages.quote_sent!.cards, 2);
  assert.equal(stages.quote_sent!.valuePlacedCents, 1_540_000);
  // Deposit and Materials in prod cap onto Contract signed, so their cards land there.
  assert.equal(stages.contract_signed!.cards, 3);
  assert.equal(stages.contract_signed!.valuePlacedCents, 7_100_000);
  assert.equal(stages.deposit!.cards, 0);
  assert.equal(stages.materials_in_prod!.cards, 0);

  const bySource = Object.fromEntries(plan().report.sourceStages.map((s) => [s.sourceStage, s]));
  assert.equal(bySource.Deposit!.cards, 1);
  assert.equal(bySource.Deposit!.verdict, "capped");
  assert.equal(bySource.Deposit!.valueCents, 1_800_000);
});

test("every capped, archived and unmapped disposition is named in the report", () => {
  const report = plan().report;
  assert.equal(report.capped.length, 2);
  assert.deepEqual(report.capped.map((entry) => entry.sourceStage).sort(), ["Deposit", "Materials in prod"]);
  assert.deepEqual(report.unmappedStages, [{ sourceStage: "Nurture", rows: 1 }]);

  const byField = Object.fromEntries(report.fieldDispositions.map((entry) => [entry.field, entry]));
  assert.equal(byField.value!.placed, 6);
  assert.equal(byField.value!.archived, 2);
  assert.equal(byField["service (additional)"]!.archived, 2);
  assert.equal(byField.lead_number!.placed, 9);
  assert.equal(byField.job_number!.placed, 3);
  assert.equal(byField.Owner!.archived, 10, "an unmapped source column is archived, never dropped");
  assert.equal(byField["activity counters"]!.archived, 10);
  // Nothing is dropped: every populated source column has a placed or archived home.
  assert.equal(report.fieldDispositions.reduce((total, entry) => total + entry.dropped, 0), 0);
});

test("the planned payload carries money only where an estimate could honestly exist", () => {
  const rows = plan().rows;
  const early = rows.find((row) => row.importKey === "opp-002")!;
  assert.equal(early.valueDisposition, "archived");
  assert.equal(early.payload.estimate_total_cents, undefined);
  assert.equal((early.payload.crm_import as Record<string, unknown>).source_value_cents, 450_000);

  const quoted = rows.find((row) => row.importKey === "opp-005")!;
  assert.equal(quoted.valueDisposition, "placed");
  assert.equal(quoted.payload.estimate_total_cents, 640_000);
});

test("a row with no id gets a content-derived key that survives re-ordering", () => {
  const forward = plan().rows.find((row) => row.importKey === null)!;
  const reversed = planImport({
    adapter: GHL_ADAPTER,
    map: SEEDED_SALES_PIPELINE,
    records: [...parseCsv(fixtureCsv("ghl-opportunities.csv")).records].reverse(),
    generatedAt: FIXTURE_NOW,
  }).rows.find((row) => row.importKey === null)!;
  assert.equal(forward.naturalKeySeed, reversed.naturalKeySeed);
});
