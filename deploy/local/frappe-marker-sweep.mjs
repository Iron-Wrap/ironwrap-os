#!/usr/bin/env node
// Ask ONE Frappe site whether a marker string appears anywhere in the ironwrap_roofing schema.
//
// deploy/tenant-leakage-checks.sh check 5 used to ask a single doctype - `Lead Envelope` - for
// the marker email, and reported "no leakage" when that one query came back empty. But the
// ingest fan-out (`workers-bus/src/erpnext.ts`, `pushToErpNext`) writes the same contact across
// several doctypes: `Roofing Customer` stores `email` independently (`erpnext.ts:665`), and both
// `Lead Envelope` and `Instant Estimate Session` carry the whole request in a `payload_json`
// Code field. A leak confined to the customer-dedup path therefore passed check 5 and inflated
// the "0 FAIL" isolation claim (ELEC-143 finding 1).
//
// The fix is deliberately NOT a longer hand-picked doctype list - that list drifts the moment
// someone adds a write. This enumerates the app's OWN schema: every doctype the app ships, and
// within it every field that can hold a free-text contact value, straight out of the doctype
// JSONs that define the site. A doctype the fan-out starts writing tomorrow is swept the day it
// is added, because it is swept for being part of the schema, not for being on a list.
// tools/validate-ingest-doctype-coverage.mjs is the CI guard that this enumeration really does
// reach every doctype `erpnext.ts` names.
//
// It reads. It never writes, and it calls no provider - only the local site it is pointed at.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const DOCTYPE_ROOT = join(
  root,
  "frappe-apps/ironwrap_roofing/ironwrap_roofing/ironwrap_roofing/doctype",
);

/**
 * Fieldtypes whose column stores a string, so a contact detail can end up in one. `Code` is in
 * because `payload_json` - the raw request, marker email and all - is a Code field on both
 * `Lead Envelope` and `Instant Estimate Session`; `Link` is in because a link target is stored
 * as the linked document's name, and plenty of those names are emails (every Link to `User`);
 * `Select` is in because its option list is a form constraint, not a column constraint.
 */
export const SEARCHABLE_FIELDTYPES = Object.freeze([
  "Data",
  "Small Text",
  "Text",
  "Long Text",
  "Text Editor",
  "Code",
  "Link",
  "Select",
  "Attach",
  "Attach Image",
  "Signature",
  "Barcode",
  "Password",
  "Read Only",
  "Dynamic Link",
  "JSON",
  "Markdown Editor",
  "HTML Editor",
  "Phone",
  "Autocomplete",
  "Icon",
  "Color",
  "Geolocation",
]);

/**
 * Fieldtypes that cannot hold a contact string - numeric, temporal, boolean, or pure layout
 * with no column at all. Split out explicitly rather than left as "everything else" so that a
 * fieldtype this file has never seen is UNCLASSIFIED rather than silently assumed harmless:
 * `sweepPlan` reports it, and both the CI guard and the leakage check fail on it. That is the
 * ELEC-143 finding-1 failure mode - a coverage gap reported as a pass - closed at the source.
 */
export const NON_SEARCHABLE_FIELDTYPES = Object.freeze([
  "Check",
  "Int",
  "Float",
  "Currency",
  "Percent",
  "Date",
  "Datetime",
  "Time",
  "Duration",
  "Rating",
  "Table",
  "Table MultiSelect",
  "Section Break",
  "Column Break",
  "Tab Break",
  "HTML",
  "Heading",
  "Image",
  "Button",
  "Fold",
]);

/**
 * `name` is searched on every doctype in addition to its declared fields: most of this app's
 * doctypes are `autoname: field:<id>` and an id built from a contact detail lands in `name`
 * without any field carrying it.
 */
const ALWAYS_SEARCHED = ["name"];

/**
 * Read the app's doctype JSONs and return what to ask each doctype for.
 *
 * Child tables (`istable`) cannot be listed on their own through the REST resource API - Frappe
 * requires the parent doctype - so each one is returned with the parents that embed it, taken
 * from the `Table` fields that point at it. A child table nothing embeds is reported in
 * `unparented` rather than silently dropped, and a fieldtype neither list classifies is
 * reported in `unclassifiedFieldtypes` rather than quietly skipped.
 */
export function sweepPlan(doctypeRoot = DOCTYPE_ROOT) {
  const docs = [];
  for (const dir of readdirSync(doctypeRoot).sort()) {
    const file = join(doctypeRoot, dir, `${dir}.json`);
    let doc;
    try {
      doc = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (doc?.doctype !== "DocType" || typeof doc.name !== "string") continue;
    docs.push(doc);
  }

  const parentsOf = new Map();
  for (const doc of docs) {
    for (const field of doc.fields ?? []) {
      if ((field.fieldtype === "Table" || field.fieldtype === "Table MultiSelect") && field.options) {
        if (!parentsOf.has(field.options)) parentsOf.set(field.options, new Set());
        parentsOf.get(field.options).add(doc.name);
      }
    }
  }

  const doctypes = [];
  const unparented = [];
  const unclassified = new Set();
  for (const doc of docs) {
    for (const field of doc.fields ?? []) {
      if (
        !SEARCHABLE_FIELDTYPES.includes(field.fieldtype) &&
        !NON_SEARCHABLE_FIELDTYPES.includes(field.fieldtype)
      ) {
        unclassified.add(`${doc.name}.${field.fieldname}:${field.fieldtype}`);
      }
    }
    const fields = [
      ...ALWAYS_SEARCHED,
      ...(doc.fields ?? [])
        .filter((field) => SEARCHABLE_FIELDTYPES.includes(field.fieldtype) && field.fieldname)
        .map((field) => field.fieldname),
    ];
    const parents = [...(parentsOf.get(doc.name) ?? [])].sort();
    if (doc.istable && parents.length === 0) {
      unparented.push(doc.name);
      continue;
    }
    doctypes.push({
      doctype: doc.name,
      istable: Boolean(doc.istable),
      parents,
      fields: [...new Set(fields)],
    });
  }
  return {
    // What the app defines, and separately what this sweep will actually query. They are the
    // same set today; keeping them apart is what lets the CI guard notice the day they differ.
    shipped: docs.map((doc) => doc.name).sort(),
    doctypes: doctypes.sort((a, b) => a.doctype.localeCompare(b.doctype)),
    unparented,
    unclassifiedFieldtypes: [...unclassified].sort(),
  };
}

/** One `?or_filters=` URL asking a doctype whether ANY searched field contains the marker. */
export function markerQuery({ doctype, fields, parent, marker, limit = 5 }) {
  const params = new URLSearchParams();
  params.set("fields", JSON.stringify(["name"]));
  params.set("or_filters", JSON.stringify(fields.map((field) => [field, "like", `%${marker}%`])));
  params.set("limit_page_length", String(limit));
  if (parent) {
    // Frappe refuses to list a child table without knowing whose child it is.
    params.set("parent", parent);
    params.set("parenttype", parent);
  }
  return `/api/resource/${encodeURIComponent(doctype)}?${params.toString()}`;
}

/**
 * Sweep one site. Returns every doctype the marker was found in, and - just as important - every
 * doctype whose query did NOT execute. An unexecuted query is reported as an error rather than
 * as an absence of rows: "nothing found" from a request that failed is exactly the vacuous pass
 * this sweep exists to stop.
 */
export async function sweepSite({ baseUrl, apiKey, apiSecret, marker, plan = sweepPlan(), fetchImpl = fetch, timeoutMs = 15000 }) {
  const hits = [];
  const errors = [];
  let queried = 0;

  // A schema shape this file cannot classify means part of the site was never searched, which
  // is the exact "0 FAIL from an unasked question" this sweep replaces. Say so instead of
  // returning a clean-looking empty result.
  for (const entry of plan.unclassifiedFieldtypes ?? []) {
    errors.push({ doctype: entry.split(".")[0], reason: `unclassified fieldtype ${entry}` });
  }
  for (const doctype of plan.unparented ?? []) {
    errors.push({ doctype, reason: "child table with no parent doctype: not searchable over REST" });
  }

  for (const entry of plan.doctypes) {
    const parents = entry.istable ? entry.parents : [undefined];
    for (const parent of parents) {
      const path = markerQuery({ doctype: entry.doctype, fields: entry.fields, parent, marker });
      queried += 1;
      let response;
      try {
        response = await fetchImpl(`${baseUrl}${path}`, {
          headers: { authorization: `token ${apiKey}:${apiSecret}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        errors.push({ doctype: entry.doctype, parent, reason: String(error?.message ?? error) });
        continue;
      }
      const body = await response.text();
      if (!response.ok) {
        errors.push({ doctype: entry.doctype, parent, status: response.status, reason: body.slice(0, 200) });
        continue;
      }
      let rows;
      try {
        rows = JSON.parse(body).data;
      } catch {
        errors.push({ doctype: entry.doctype, parent, reason: `unparseable body: ${body.slice(0, 200)}` });
        continue;
      }
      if (!Array.isArray(rows)) {
        errors.push({ doctype: entry.doctype, parent, reason: `no data array: ${body.slice(0, 200)}` });
        continue;
      }
      if (rows.length > 0) {
        hits.push({
          doctype: entry.doctype,
          ...(parent ? { parent } : {}),
          count: rows.length,
          names: rows.map((row) => row.name),
        });
      }
    }
  }

  return {
    marker,
    queried,
    doctypes: plan.doctypes.length,
    unparented: plan.unparented ?? [],
    unclassifiedFieldtypes: plan.unclassifiedFieldtypes ?? [],
    hits,
    errors,
    hitDoctypes: [...new Set(hits.map((hit) => hit.doctype))].sort(),
    totalHits: hits.reduce((sum, hit) => sum + hit.count, 0),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const read = (flag, fallback) => {
    const index = args.indexOf(flag);
    return index === -1 ? fallback : args[index + 1];
  };
  try {
    const site = read("--site");
    const port = read("--port", "8000");
    const baseUrl = read("--base-url", site ? `http://${site}:${port}` : undefined);
    const apiKey = read("--key", process.env.FRAPPE_API_KEY);
    const apiSecret = read("--secret", process.env.FRAPPE_API_SECRET);
    const marker = read("--marker");
    if (!baseUrl) throw new Error("--site <host> (or --base-url) is required");
    if (!marker) throw new Error("--marker <string> is required");
    if (!apiKey || !apiSecret) throw new Error("--key and --secret (or FRAPPE_API_KEY/SECRET) are required");
    const result = await sweepSite({ baseUrl, apiKey, apiSecret, marker });
    process.stdout.write(`${JSON.stringify({ baseUrl, ...result })}\n`);
    // A sweep that could not run every query has proven nothing about the doctypes it missed.
    process.exitCode = result.errors.length > 0 ? 1 : 0;
  } catch (error) {
    console.error(`frappe-marker-sweep failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 2;
  }
}
