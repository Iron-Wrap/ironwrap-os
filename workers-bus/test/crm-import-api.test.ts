// Contract tests for the admin surface: the dry run really is a dry run, execute applies the same
// plan, and every rejected request says which contract it broke.

import assert from "node:assert/strict";
import { test } from "node:test";

import { handleCrmImport } from "../src/crm-import-api.ts";
import { FIXTURE_NOW, TestD1, fixtureCsv, testEnv } from "./crm-import-fixture.ts";

const TABLES = [
  "envelopes",
  "operating_leads",
  "operating_customers",
  "operating_properties",
  "operating_roof_jobs",
  "operating_instant_estimates",
  "crm_import_runs",
  "crm_import_records",
  "crm_import_issues",
];

function snapshot(db: TestD1): Record<string, number> {
  return Object.fromEntries(TABLES.map((table) => [table, db.count(table)]));
}

async function call(
  db: TestD1,
  method: string,
  path: string,
  body?: unknown,
  now = FIXTURE_NOW,
): Promise<{ status: number; body: Record<string, never> }> {
  const url = new URL(`https://bus.example.invalid${path}`);
  const request = new Request(url, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
  const response = await handleCrmImport(request, testEnv(db), url, now);
  return { status: response.status, body: await response.json() as Record<string, never> };
}

function importBody(extra: Record<string, unknown> = {}) {
  return {
    adapter: "ghl",
    pipeline_key: "sales",
    source_label: "ghl-opportunities.csv",
    csv: fixtureCsv("ghl-opportunities.csv"),
    ...extra,
  };
}

test("dry-run reports the whole plan and writes nothing at all", async () => {
  const db = new TestD1();
  const before = snapshot(db);
  const { status, body } = await call(db, "POST", "/admin/crm-import/dry-run", importBody());

  assert.equal(status, 200);
  const report = body.report as unknown as {
    mode: string; runId: string | null; applied: unknown;
    reconciliation: { plannedRows: number; balanced: boolean };
    stages: { stageKey: string; cards: number }[];
    capped: unknown[];
  };
  assert.equal(report.mode, "dry_run");
  assert.equal(report.runId, null);
  assert.equal(report.applied, null);
  assert.equal(report.reconciliation.plannedRows, 10);
  assert.equal(report.reconciliation.balanced, true);
  assert.equal(report.capped.length, 2);
  assert.deepEqual(snapshot(db), before, "a dry run must not touch a single table");
});

test("execute applies exactly the plan the dry run described", async () => {
  const db = new TestD1();
  const dry = (await call(db, "POST", "/admin/crm-import/dry-run", importBody())).body
    .report as unknown as Record<string, unknown>;
  const wet = (await call(db, "POST", "/admin/crm-import/execute", importBody())).body
    .report as unknown as Record<string, unknown>;

  assert.deepEqual(wet.stages, dry.stages);
  assert.deepEqual(wet.fieldDispositions, dry.fieldDispositions);
  assert.deepEqual(wet.capped, dry.capped);
  assert.deepEqual(wet.reconciliation, dry.reconciliation);
  assert.equal(wet.mode, "execute");
  assert.deepEqual(wet.applied, { created: 10, adopted: 0, failed: 0 });
  assert.equal(db.count("crm_import_records"), 10);
});

test("json rows are accepted alongside csv and produce the same placement", async () => {
  const db = new TestD1();
  const { body } = await call(db, "POST", "/admin/crm-import/dry-run", {
    adapter: "generic",
    rows: [
      { external_id: "a", contact_name: "Ada Synthetic", email: "ada@example.invalid", stage: "Deposit", value: "1000" },
    ],
  });
  const report = body.report as unknown as { stages: { stageKey: string; cards: number }[]; capped: { sourceStage: string }[] };
  assert.equal(report.stages.find((stage) => stage.stageKey === "contract_signed")!.cards, 1);
  assert.deepEqual(report.capped.map((entry) => entry.sourceStage), ["Deposit"]);
});

test("a run report can be read back by id after the fact", async () => {
  const db = new TestD1();
  const executed = (await call(db, "POST", "/admin/crm-import/execute", importBody())).body
    .report as unknown as { runId: string };
  const listed = (await call(db, "GET", "/admin/crm-import/runs")).body as unknown as {
    runs: { runId: string }[];
  };
  assert.deepEqual(listed.runs.map((entry) => entry.runId), [executed.runId]);

  const fetched = await call(db, "GET", `/admin/crm-import/runs/${encodeURIComponent(executed.runId)}`);
  assert.equal(fetched.status, 200);
  assert.equal((fetched.body as unknown as { report: { runId: string } }).report.runId, executed.runId);
  assert.equal((await call(db, "GET", "/admin/crm-import/runs/crmrun:ironwrap:nope")).status, 404);
});

test("the adapter and pipeline catalogue is discoverable before anyone uploads a file", async () => {
  const db = new TestD1();
  const { body } = await call(db, "GET", "/admin/crm-import/adapters");
  const catalogue = body as unknown as {
    adapters: { id: string }[];
    pipelines: { pipeline_key: string; stages: { key: string }[] }[];
  };
  assert.deepEqual(catalogue.adapters.map((entry) => entry.id), ["generic", "ghl"]);
  assert.deepEqual(catalogue.pipelines[0]!.stages.map((stage) => stage.key), [
    "new_lead", "visit_booked", "need_quote", "quote_sent", "contract_signed", "deposit", "materials_in_prod",
  ]);
});

test("bad requests name the contract they broke and write nothing", async () => {
  const db = new TestD1();
  const before = snapshot(db);

  assert.equal((await call(db, "POST", "/admin/crm-import/execute", importBody({ adapter: "salesforce" }))).status, 400);
  assert.equal((await call(db, "POST", "/admin/crm-import/execute", importBody({ pipeline_key: "commercial" }))).status, 400);
  assert.equal((await call(db, "POST", "/admin/crm-import/execute", { adapter: "ghl" })).status, 400);
  assert.equal((await call(db, "POST", "/admin/crm-import/execute", importBody({ csv: "Stage\n\n" }))).status, 400);
  assert.equal((await call(db, "GET", "/admin/crm-import/execute")).status, 404);
  assert.equal((await call(db, "POST", "/admin/crm-import/nope", importBody())).status, 404);

  const nested = await call(db, "POST", "/admin/crm-import/dry-run", {
    adapter: "generic",
    rows: [{ external_id: "a", contact_name: { first: "Ada" } }],
  });
  assert.equal(nested.status, 400);
  assert.match(String((nested.body as unknown as { error: string }).error), /nested_value/);

  assert.deepEqual(snapshot(db), before);
});
