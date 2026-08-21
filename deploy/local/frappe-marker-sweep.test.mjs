import assert from "node:assert/strict";
import test from "node:test";

import {
  NON_SEARCHABLE_FIELDTYPES,
  SEARCHABLE_FIELDTYPES,
  markerQuery,
  sweepPlan,
  sweepSite,
} from "./frappe-marker-sweep.mjs";

const plan = sweepPlan();

test("the sweep covers every doctype the app ships, with its own text fields", () => {
  assert.ok(plan.doctypes.length >= 79, `expected the whole app schema, got ${plan.doctypes.length}`);
  assert.deepEqual(plan.unparented, [], "a child table with no parent cannot be listed, so it is never searched");
  assert.deepEqual(plan.unclassifiedFieldtypes, [], "an unclassified fieldtype is a field nobody decided to search");

  // The three the ingest fan-out puts the contact email into. Check 5 asked only the first of
  // them before ELEC-143 finding 1, which is how a customer-dedup leak passed as isolation.
  const lead = plan.doctypes.find((entry) => entry.doctype === "Lead Envelope");
  const customer = plan.doctypes.find((entry) => entry.doctype === "Roofing Customer");
  const estimate = plan.doctypes.find((entry) => entry.doctype === "Instant Estimate Session");
  assert.ok(lead.fields.includes("contact_email"));
  assert.ok(lead.fields.includes("payload_json"), "the raw request carries the contact too");
  assert.ok(customer.fields.includes("email"), "erpnext.ts:665 writes the same email here");
  assert.ok(customer.fields.includes("display_name"), "a lead with no name is stored under its email");
  assert.ok(estimate.fields.includes("payload_json"));
});

test("every doctype is searched by name as well as by field", () => {
  for (const entry of plan.doctypes) {
    assert.ok(entry.fields.includes("name"), `${entry.doctype} must be searched by name`);
  }
});

test("child tables are queried through a parent, because Frappe will not list them alone", () => {
  const children = plan.doctypes.filter((entry) => entry.istable);
  assert.ok(children.length > 0);
  for (const child of children) {
    assert.ok(child.parents.length > 0, `${child.doctype} has no parent to be listed under`);
  }
  const query = markerQuery({ doctype: "Cargo Load Line", fields: ["name"], parent: "Cargo Load", marker: "abc" });
  assert.match(query, /parent=Cargo\+Load/);
  assert.match(query, /parenttype=Cargo\+Load/);
});

test("a fieldtype is either searched or explicitly ruled out, never both and never neither", () => {
  const overlap = SEARCHABLE_FIELDTYPES.filter((type) => NON_SEARCHABLE_FIELDTYPES.includes(type));
  assert.deepEqual(overlap, []);
});

test("the marker query asks every field of a doctype at once", () => {
  const query = markerQuery({ doctype: "Roofing Customer", fields: ["name", "email"], marker: "leakcheck-99" });
  const orFilters = JSON.parse(decodeURIComponent(query.match(/or_filters=([^&]+)/)[1]));
  assert.deepEqual(orFilters, [
    ["name", "like", "%leakcheck-99%"],
    ["email", "like", "%leakcheck-99%"],
  ]);
});

test("a doctype whose query did not execute is an error, never an absence of rows", async () => {
  const smallPlan = {
    doctypes: [
      { doctype: "Lead Envelope", istable: false, parents: [], fields: ["name", "contact_email"] },
      { doctype: "Roofing Customer", istable: false, parents: [], fields: ["name", "email"] },
    ],
    unparented: [],
    unclassifiedFieldtypes: [],
  };
  const result = await sweepSite({
    baseUrl: "http://tenant.localhost:8000",
    apiKey: "k",
    apiSecret: "s",
    marker: "leakcheck-99",
    plan: smallPlan,
    fetchImpl: async (url) =>
      url.includes("Roofing%20Customer")
        ? new Response("PermissionError", { status: 403 })
        : new Response(JSON.stringify({ data: [{ name: "LEAD-1" }] }), { status: 200 }),
  });

  assert.equal(result.totalHits, 1);
  assert.deepEqual(result.hitDoctypes, ["Lead Envelope"]);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].doctype, "Roofing Customer");
  assert.equal(result.errors[0].status, 403);
});

test("an unclassified fieldtype or an unlistable child table fails the sweep instead of shrinking it", async () => {
  const result = await sweepSite({
    baseUrl: "http://tenant.localhost:8000",
    apiKey: "k",
    apiSecret: "s",
    marker: "leakcheck-99",
    plan: {
      doctypes: [],
      unparented: ["Orphan Line"],
      unclassifiedFieldtypes: ["Roof Job.new_field:Ledger Text"],
    },
    fetchImpl: async () => {
      throw new Error("no query should be attempted");
    },
  });
  assert.equal(result.errors.length, 2);
  assert.match(result.errors.map((entry) => entry.reason).join(" "), /unclassified fieldtype/);
  assert.match(result.errors.map((entry) => entry.reason).join(" "), /no parent doctype/);
});

test("a marker found on the wrong tenant is reported with the doctype it was found in", async () => {
  const result = await sweepSite({
    baseUrl: "http://ironwrap.localhost:8000",
    apiKey: "k",
    apiSecret: "s",
    marker: "leakcheck-99",
    plan: {
      doctypes: [{ doctype: "Roofing Customer", istable: false, parents: [], fields: ["name", "email"] }],
      unparented: [],
      unclassifiedFieldtypes: [],
    },
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ name: "CUST-1" }] }), { status: 200 }),
  });
  assert.deepEqual(result.hits, [{ doctype: "Roofing Customer", count: 1, names: ["CUST-1"] }]);
  assert.equal(result.errors.length, 0);
});
