#!/usr/bin/env node
// The Facet v2 projection writes a Draft Customer Quote with every commercial
// field blank, and then two independent places have to agree on what "blank"
// means: the Frappe command's own replay guard, and the Worker's readback that
// decides whether the projection landed exactly.
//
// On a real site a blank Draft is not literally empty. Frappe fills two kinds of
// value for a field the command wrote as NULL, and neither is commercial data:
// a DocType `default` applied inside insert() (currency -> CAD, payment_status
// -> Not Due), and 0, because Currency/Float/Int columns are NOT NULL DEFAULT 0.
// Both readings shipped as "the Draft contains commercial data" and killed the
// chain on every real site while the fixtures - which return literal nulls -
// stayed green (Multica ELEC-86 §5, ELEC-91).
//
// The Worker cannot read the DocType at runtime, so it carries a table. This
// validator is what stops that table from becoming a second, staler description
// of the same schema: the field list, the schema defaults and the numeric flags
// must all be derivable from customer_quote.json and must match the Frappe app's
// own BLANK_QUOTE_FIELDS, field for field and in the same order.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DOCTYPE_FILE = join(
  root, "frappe-apps", "ironwrap_roofing", "ironwrap_roofing", "ironwrap_roofing",
  "doctype", "customer_quote", "customer_quote.json",
);
const FRAPPE_API_FILE = join(
  root, "frappe-apps", "ironwrap_roofing", "ironwrap_roofing",
  "facet_design_projection_api.py",
);
const WORKER_FILE = join(root, "workers-bus", "src", "facet-design-projection.ts");

// Frappe stores these column kinds NOT NULL DEFAULT 0. Kept in step with
// NUMERIC_FIELDTYPES in facet_design_projection_api.py by this validator.
const NUMERIC_FIELDTYPES = new Set(["Currency", "Float", "Int", "Percent", "Check"]);

export function schemaBlankRules(doctype, blankFields) {
  const byName = new Map(doctype.fields.map((field) => [field.fieldname, field]));
  return blankFields.map((fieldname) => {
    const field = byName.get(fieldname);
    assert.ok(field, `BLANK_QUOTE_FIELDS names ${fieldname}, which Customer Quote does not define`);
    // Frappe fills a new document from an explicit default, or - for Select -
    // the first option when it is not blank.
    const declared = field.default
      || (field.fieldtype === "Select" ? (field.options ?? "").split("\n")[0].trim() : "");
    return {
      field: fieldname,
      schemaDefault: declared || null,
      numeric: NUMERIC_FIELDTYPES.has(field.fieldtype),
    };
  });
}

export function parsePythonBlankFields(source) {
  const block = /^BLANK_QUOTE_FIELDS = \(([\s\S]*?)^\)/m.exec(source);
  assert.ok(block, "facet_design_projection_api.py no longer declares BLANK_QUOTE_FIELDS");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

export function parsePythonNumericFieldtypes(source) {
  const block = /^NUMERIC_FIELDTYPES = frozenset\(\{([\s\S]*?)\}\)/m.exec(source);
  assert.ok(block, "facet_design_projection_api.py no longer declares NUMERIC_FIELDTYPES");
  return new Set([...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]));
}

export function parseWorkerBlankRules(source) {
  const block = /const BLANK_QUOTE_READBACK_FIELDS[\s\S]*?= \[([\s\S]*?)\n\] as const;/m.exec(source);
  if (!block) return null;
  const entry = /\{ field: "([^"]+)", schemaDefault: (null|"[^"]*"), numeric: (true|false) \},/g;
  return [...block[1].matchAll(entry)].map((match) => ({
    field: match[1],
    schemaDefault: match[2] === "null" ? null : JSON.parse(match[2]),
    numeric: match[3] === "true",
  }));
}

export function workerUsesNativeFacetProjection(source) {
  return source.includes("export async function reconcileFacetDesignNativeProjections");
}

export function validateFacetBlankQuoteContract({ doctype, frappeSource, workerSource }) {
  const blankFields = parsePythonBlankFields(frappeSource);
  assert.ok(blankFields.length > 0, "BLANK_QUOTE_FIELDS is empty");
  assert.deepEqual(
    [...parsePythonNumericFieldtypes(frappeSource)].sort(),
    [...NUMERIC_FIELDTYPES].sort(),
    "the Frappe app and this validator disagree about which fieldtypes store 0 for NULL",
  );

  const expected = schemaBlankRules(doctype, blankFields);
  const actual = parseWorkerBlankRules(workerSource);
  if (actual === null) {
    assert.ok(
      workerUsesNativeFacetProjection(workerSource),
      "facet-design-projection.ts no longer declares BLANK_QUOTE_READBACK_FIELDS and is not the native projection: restore the Frappe readback table or the native export",
    );
  } else {
    assert.deepEqual(
      actual, expected,
      "the Worker's blank-quote readback table has drifted from Customer Quote / BLANK_QUOTE_FIELDS",
    );
  }

  // A rule that claims neither mechanism can never soften anything, so if the
  // whole table is inert the readback has silently gone back to literal-empty.
  const shaped = expected.filter((rule) => rule.schemaDefault !== null || rule.numeric);
  assert.ok(
    shaped.length > 0,
    "no blank quote field defaults or stores 0 - the schema no longer matches the defect this guards",
  );
  return {
    fields: expected.length,
    shaped: shaped.length,
    worker: actual === null ? "native" : "frappe-readback",
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { fields, shaped } = validateFacetBlankQuoteContract({
    doctype: JSON.parse(readFileSync(DOCTYPE_FILE, "utf8")),
    frappeSource: readFileSync(FRAPPE_API_FILE, "utf8"),
    workerSource: readFileSync(WORKER_FILE, "utf8"),
  });
  console.log(
    `ok ${fields} blank Customer Quote fields validated against the DocType (${shaped} carry a schema default or store 0 for NULL)`,
  );
}
