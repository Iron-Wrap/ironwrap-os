import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  FRAPPE_DATETIME_FIELDS,
  buildJobAssignmentDraft,
  frappeRowForDoctype,
} from "../src/server.mjs";

// ELEC-128 defect 4. The broker write path handed Frappe the same RFC 3339 text the
// preview contract is written in, and MariaDB refused it at the INSERT:
//
//   ERROR 1292 (22007): Incorrect datetime value: '2026-08-25T08:00:00.000Z'
//     for column `tabJob Assignment`.`scheduled_start` at row 1
//
// (Reproduced directly against mariadb:10.6 with sql_mode=STRICT_TRANS_TABLES.)
//
// This was NOT a broker-specific formatting divergence. The manual REST comparison it
// was contrasted against never reached the INSERT at all - it was refused earlier by
// `missing_authority_requirements`. Any caller that got far enough to write would have
// hit the same 1292; the broker was simply the first one ever to get that far.

const RFC3339 = "2026-08-25T08:00:00.000Z";
const FRAPPE_FORM = "2026-08-25 08:00:00";

test("the Job Assignment draft keeps RFC 3339, and only the row written to Frappe is converted", () => {
  const draft = buildJobAssignmentDraft({
    roofJobId: "job:1",
    assignmentType: "Production",
    crewProfileId: "crew:1",
    scheduledStart: RFC3339,
    scheduledEnd: "2026-08-25T16:30:00.000Z",
    assignedBy: "production-controller@example.com",
    nowIso: "2026-08-21T11:22:33.456Z",
  });

  // The draft is what the broker digests and what `assertExact(draft.scheduled_start,
  // input.scheduledStart)` compares. Converting it here would break the approval
  // contract, so it must stay exactly as the Worker sent it.
  assert.equal(draft.scheduled_start, RFC3339);
  assert.equal(draft.scheduled_end, "2026-08-25T16:30:00.000Z");
  assert.equal(draft.assigned_at, "2026-08-21T11:22:33.456Z");

  const row = frappeRowForDoctype("Job Assignment", draft);
  assert.equal(row.scheduled_start, FRAPPE_FORM);
  assert.equal(row.scheduled_end, "2026-08-25 16:30:00");
  // `assigned_at` is a Datetime column too, and was fed straight from `new Date()
  // .toISOString()`. MariaDB fails on the first bad column, so fixing only
  // `scheduled_start` would have moved the same 1292 one field to the right.
  assert.equal(row.assigned_at, "2026-08-21 11:22:33");
  assert.notEqual(row, draft, "the draft itself must not be mutated");
  assert.equal(draft.scheduled_start, RFC3339, "the draft is still the approved text");
});

test("conversion is idempotent and does not drift with the host timezone", () => {
  // `new Date("2026-08-25 08:00:00")` parses as LOCAL time, so an unguarded converter
  // shifts an already-converted value by the host's offset - a corruption whose size
  // depends on which machine ran the deploy. Converting twice must be a no-op.
  const once = frappeRowForDoctype("Job Assignment", { scheduled_start: RFC3339 });
  const twice = frappeRowForDoctype("Job Assignment", once);
  assert.equal(once.scheduled_start, FRAPPE_FORM);
  assert.deepEqual(twice, once);

  // A naive value that arrived already in Frappe's own format is left alone.
  const naive = frappeRowForDoctype("Job Assignment", { scheduled_start: FRAPPE_FORM });
  assert.equal(naive.scheduled_start, FRAPPE_FORM);

  // An explicit non-UTC offset resolves to the same instant, expressed naive-UTC.
  const offset = frappeRowForDoctype("Job Assignment", { scheduled_start: "2026-08-25T02:00:00-06:00" });
  assert.equal(offset.scheduled_start, FRAPPE_FORM);
});

test("only the named Datetime columns are touched", () => {
  const draft = {
    scheduled_start: RFC3339,
    // A Code field whose content happens to be a timestamp-bearing document, and a Data
    // field carrying a provenance string. Neither is a Datetime column; both must survive
    // byte-for-byte.
    authority_requirements_json: JSON.stringify([{ scope_ref: "job:1", issued: RFC3339 }]),
    notes: `rescheduled from ${RFC3339}`,
    correction_reason: RFC3339,
  };
  const row = frappeRowForDoctype("Job Assignment", draft);
  assert.equal(row.scheduled_start, FRAPPE_FORM);
  assert.equal(row.authority_requirements_json, draft.authority_requirements_json);
  assert.equal(row.notes, draft.notes);
  assert.equal(row.correction_reason, RFC3339, "correction_reason is Small Text, not Datetime");
});

test("a doctype with no Datetime columns is returned untouched", () => {
  const draft = { some_field: RFC3339 };
  assert.equal(frappeRowForDoctype("Not A Written Doctype", draft), draft);
});

test("every Datetime column of every written DocType is on the conversion map", () => {
  // The drift guard. `FRAPPE_DATETIME_FIELDS` is hand-written because the MCP server
  // must not read the Frappe app at runtime - so CI re-derives it from the DocType
  // JSONs instead. A Datetime column added to any of these DocTypes fails here until
  // it is listed, which is the check that would have caught defect 4 at review.
  const doctypeRoots = [
    fileURLToPath(new URL("../../../frappe-apps/ironwrap_roofing/ironwrap_roofing/ironwrap_roofing/doctype", import.meta.url)),
  ];
  const declared = new Map();
  for (const root of doctypeRoots) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = join(root, entry.name, `${entry.name}.json`);
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        continue;
      }
      if (parsed?.doctype !== "DocType" || typeof parsed.name !== "string") continue;
      declared.set(
        parsed.name,
        (parsed.fields ?? [])
          .filter((field) => field.fieldtype === "Datetime")
          .map((field) => field.fieldname)
          .sort(),
      );
    }
  }
  assert.ok(declared.size > 50, "the DocType directory must actually have been read");

  for (const [doctype, fields] of Object.entries(FRAPPE_DATETIME_FIELDS)) {
    const actual = declared.get(doctype);
    assert.ok(actual, `${doctype} is on the conversion map but has no DocType JSON`);
    assert.deepEqual(
      [...fields].sort(),
      actual,
      `${doctype}'s Datetime columns have drifted from the conversion map`,
    );
  }
});

test("every doctype these executors write is on the conversion map", () => {
  // The other half of the drift guard: a new `createOnlyExecutor`/`upsertDraftExecutor`
  // call site for a DocType that has Datetime columns must not ship unmapped.
  const source = readFileSync(fileURLToPath(new URL("../src/server.mjs", import.meta.url)), "utf8");
  const written = new Set([
    ...[...source.matchAll(/createOnlyExecutor\(\s*config,\s*"([^"]+)"/g)].map((match) => match[1]),
    ...[...source.matchAll(/upsertDraftExecutor\(config,\s*"([^"]+)"/g)].map((match) => match[1]),
  ]);
  assert.ok(written.size > 10, "the executor call sites must actually have been found");

  const root = fileURLToPath(new URL("../../../frappe-apps/ironwrap_roofing/ironwrap_roofing/ironwrap_roofing/doctype", import.meta.url));
  for (const doctype of written) {
    const dir = doctype.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(root, dir, `${dir}.json`), "utf8"));
    } catch {
      continue;
    }
    const hasDatetime = (parsed.fields ?? []).some((field) => field.fieldtype === "Datetime");
    if (!hasDatetime) continue;
    assert.ok(
      Object.hasOwn(FRAPPE_DATETIME_FIELDS, doctype),
      `${doctype} is written through an executor and has Datetime columns, but is not on the conversion map`,
    );
  }
});
