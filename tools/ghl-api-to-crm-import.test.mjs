import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { convert } from "./ghl-api-to-crm-import.mjs";

const pipelines = [{
  id: "pipe-1",
  name: "Sales",
  stages: [
    { id: "s-new", name: "New Lead" },
    { id: "s-quote", name: "Quote Sent" },
    { id: "s-signed-off", name: "Job signed off" },
    { id: "s-abandoned", name: "Abandoned" },
  ],
}];

const contacts = [
  { id: "c-1", contactName: "Avery Example", email: "avery@example.invalid", phone: "+15555550101",
    address1: "1 Test Way", city: "Calgary", state: "AB", postalCode: "T0T 0T0" },
  { id: "c-2", firstName: "Blake", lastName: "Example", email: "blake@example.invalid" },
];

function opportunity(id, overrides) {
  return {
    id, contactId: "c-1", pipelineId: "pipe-1", pipelineStageId: "s-new", status: "open",
    monetaryValue: 0, source: "website", createdAt: "2026-01-01T00:00:00.000Z",
    lastStageChangeAt: "2026-01-02T00:00:00.000Z", contact: {}, ...overrides,
  };
}

test("one adapter row per opportunity with the stage name and the contact address", () => {
  const { rows, closed, counts } = convert({
    pipelines,
    contacts,
    opportunities: [
      opportunity("o-1", { pipelineStageId: "s-quote", monetaryValue: 6400.5 }),
      opportunity("o-2", { contactId: "c-2", pipelineStageId: "s-signed-off", status: "won" }),
    ],
  });
  assert.equal(closed.length, 0);
  assert.deepEqual(counts, { opportunities: 2, duplicates: 0, contactMatched: 2, unknownStage: 0, rows: 2, closed: 0 });
  assert.equal(rows[0]["opportunity id"], "o-1");
  assert.equal(rows[0].stage, "Quote Sent");
  assert.equal(rows[0]["opportunity value"], "6400.50");
  assert.equal(rows[0]["contact name"], "Avery Example");
  assert.equal(rows[0].address, "1 Test Way");
  assert.equal(rows[0]["postal code"], "T0T 0T0");
  assert.equal(rows[1]["contact name"], "Blake Example", "first and last name when no contactName");
  assert.equal(rows[1].stage, "Job signed off");
  assert.equal(rows[1]["opportunity value"], "", "a zero value is left blank, never invented");
});

test("closed deals go to the closed file, never to the board rows", () => {
  const { rows, closed, counts } = convert({
    pipelines,
    contacts,
    opportunities: [
      opportunity("o-1", { status: "abandoned", pipelineStageId: "s-abandoned" }),
      opportunity("o-2", { status: "open", pipelineStageId: "s-abandoned" }),
      opportunity("o-3", { status: "lost" }),
      opportunity("o-4"),
      opportunity("o-4"),
    ],
  });
  assert.deepEqual(rows.map((row) => row["opportunity id"]), ["o-4"]);
  assert.deepEqual(closed.map((row) => row["opportunity id"]), ["o-1", "o-2", "o-3"]);
  assert.equal(counts.duplicates, 1);
});

test("an unknown stage id is counted, and the embedded contact wins over the contact pull", () => {
  const { rows, counts } = convert({
    pipelines,
    contacts,
    opportunities: [opportunity("o-1", {
      pipelineStageId: "s-missing",
      contactId: "c-unknown",
      contact: { name: "Casey Example", email: "casey@example.invalid", phone: "+15555550102" },
    })],
  });
  assert.equal(counts.unknownStage, 1);
  assert.equal(counts.contactMatched, 0);
  assert.equal(rows[0].stage, "");
  assert.equal(rows[0].email, "casey@example.invalid");
});

test("the CLI reads bridge envelopes and writes both files with counts only on stdout", () => {
  const dir = mkdtempSync(join(tmpdir(), "ghl-convert-"));
  writeFileSync(join(dir, "pipelines.json"), JSON.stringify({ body: { pipelines } }));
  writeFileSync(join(dir, "contacts_page_001.json"), JSON.stringify({ body: { contacts } }));
  writeFileSync(join(dir, "opportunities_page_001.json"), JSON.stringify({ body: { opportunities: [
    opportunity("o-1", { pipelineStageId: "s-quote" }),
    opportunity("o-2", { status: "abandoned" }),
  ] } }));
  const stdout = execFileSync(process.execPath, ["tools/ghl-api-to-crm-import.mjs", "--dir", dir], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(stdout), {
    opportunities: 2, duplicates: 0, contactMatched: 2, unknownStage: 0, rows: 1, closed: 1,
  });
  assert.doesNotMatch(stdout, /example\.invalid/);
  assert.equal(JSON.parse(readFileSync(join(dir, "crm-import-rows.json"), "utf8")).length, 1);
  assert.equal(JSON.parse(readFileSync(join(dir, "crm-import-closed-rows.json"), "utf8")).length, 1);
});
