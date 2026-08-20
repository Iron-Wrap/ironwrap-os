import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  parseWorkerBlankRules,
  schemaBlankRules,
  validateFacetBlankQuoteContract,
} from "./validate-facet-blank-quote-contract.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DOCTYPE = {
  fields: [
    { fieldname: "currency", fieldtype: "Data", default: "CAD" },
    { fieldname: "payment_status", fieldtype: "Select", options: "Not Due\nOverdue" },
    { fieldname: "quote_total", fieldtype: "Currency" },
    { fieldname: "notes", fieldtype: "Small Text" },
  ],
};
const FRAPPE = [
  'BLANK_QUOTE_FIELDS = (',
  '    "currency",',
  '    "payment_status",',
  '    "quote_total",',
  '    "notes",',
  ')',
  'NUMERIC_FIELDTYPES = frozenset({"Currency", "Float", "Int", "Percent", "Check"})',
].join("\n");
const workerSource = (rules) => [
  "const BLANK_QUOTE_READBACK_FIELDS: ReadonlyArray<{",
  "  readonly field: string;",
  "}> = [",
  ...rules.map((rule) =>
    `  { field: "${rule.field}", schemaDefault: ${
      rule.schemaDefault === null ? "null" : JSON.stringify(rule.schemaDefault)
    }, numeric: ${rule.numeric} },`),
  "] as const;",
].join("\n");

const CORRECT = schemaBlankRules(DOCTYPE, ["currency", "payment_status", "quote_total", "notes"]);

test("the shipped Worker table matches the shipped Customer Quote schema", () => {
  const script = new URL("./validate-facet-blank-quote-contract.mjs", import.meta.url);
  const result = spawnSync(process.execPath, [script.pathname], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ok \d+ blank Customer Quote fields validated/);
});

test("a Select's first option counts as the schema default, like Frappe treats it", () => {
  assert.deepEqual(CORRECT, [
    { field: "currency", schemaDefault: "CAD", numeric: false },
    { field: "payment_status", schemaDefault: "Not Due", numeric: false },
    { field: "quote_total", schemaDefault: null, numeric: true },
    { field: "notes", schemaDefault: null, numeric: false },
  ]);
});

test("a matching table validates", () => {
  const result = validateFacetBlankQuoteContract({
    doctype: DOCTYPE, frappeSource: FRAPPE, workerSource: workerSource(CORRECT),
  });
  assert.deepEqual(result, { fields: 4, shaped: 3 });
});

test("a Worker table that forgot a DocType default is rejected", () => {
  // This is the exact regression: the readback reads "CAD" as commercial data.
  const drifted = CORRECT.map((rule) =>
    rule.field === "currency" ? { ...rule, schemaDefault: null } : rule);
  assert.throws(
    () => validateFacetBlankQuoteContract({
      doctype: DOCTYPE, frappeSource: FRAPPE, workerSource: workerSource(drifted),
    }),
    /drifted from Customer Quote/,
  );
});

test("a Worker table that forgot a numeric column is rejected", () => {
  const drifted = CORRECT.map((rule) =>
    rule.field === "quote_total" ? { ...rule, numeric: false } : rule);
  assert.throws(
    () => validateFacetBlankQuoteContract({
      doctype: DOCTYPE, frappeSource: FRAPPE, workerSource: workerSource(drifted),
    }),
    /drifted from Customer Quote/,
  );
});

test("a field added to BLANK_QUOTE_FIELDS but not to the Worker table is rejected", () => {
  const extended = [FRAPPE.replace('    "notes",', '    "notes",\n    "tax_rate",')].join("");
  const doctype = { fields: [...DOCTYPE.fields, { fieldname: "tax_rate", fieldtype: "Float" }] };
  assert.throws(
    () => validateFacetBlankQuoteContract({
      doctype, frappeSource: extended, workerSource: workerSource(CORRECT),
    }),
    /drifted from Customer Quote/,
  );
});

test("a blank field the DocType does not define is rejected", () => {
  const extended = FRAPPE.replace('    "notes",', '    "notes",\n    "invented_field",');
  assert.throws(
    () => validateFacetBlankQuoteContract({
      doctype: DOCTYPE, frappeSource: extended, workerSource: workerSource(CORRECT),
    }),
    /which Customer Quote does not define/,
  );
});

test("the Frappe app and the validator must agree on which fieldtypes store 0", () => {
  const narrowed = FRAPPE.replace(
    'frozenset({"Currency", "Float", "Int", "Percent", "Check"})',
    'frozenset({"Currency"})',
  );
  assert.throws(
    () => validateFacetBlankQuoteContract({
      doctype: DOCTYPE, frappeSource: narrowed, workerSource: workerSource(CORRECT),
    }),
    /which fieldtypes store 0 for NULL/,
  );
});

test("the shipped Worker table is parseable and non-trivial", () => {
  const rules = parseWorkerBlankRules(
    readFileSync(resolve(root, "workers-bus/src/facet-design-projection.ts"), "utf8"),
  );
  assert.ok(rules.length >= 30);
});
