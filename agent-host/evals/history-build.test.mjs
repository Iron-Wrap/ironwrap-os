import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { billingOutcome, buildDurationCases, buildGhlLeadCases, buildLeadCases, buildPaymentCases, durationOutcome, leadOutcome, relative, sampleCases, workingDays } from "./history-build.mjs";
import { createGuard, createPseudonymizer, placesPattern } from "./privacy.mjs";

// Synthetic JobNimbus- and GoHighLevel-shaped rows only (example.invalid, 555-01xx, invented names).
const config = JSON.parse(readFileSync(new URL("./history.v1.json", import.meta.url), "utf8"));
const specFor = (id, source) => {
  const { sources, ...rest } = config.specialists[id];
  return { privacy: config.privacy, ...rest, ...sources[source] };
};
const DAY = 86400;
const T = 1_700_000_000;
const NOW = T + 800 * DAY;
const contact = (n, extra = {}) => ({
  jnid: `synth-c-${n}`,
  display_name: `Morgan Fixture${n}`,
  first_name: "Morgan",
  last_name: `Fixture${n}`,
  email: `morgan${n}@example.invalid`,
  mobile_phone: `780-555-01${n}`,
  address_line1: `${10 + Number(n)} Sample Crescent SW`,
  zip: "T0T 0T0",
  city: "Edmonton",
  state_text: "AB",
  record_type_name: "Customer",
  source_name: "Website",
  sales_rep: "rep@example.invalid",
  sales_rep_name: "Casey Rep",
  status_name: "Customer",
  description: `Morgan Fixture${n} needs a metal roof; call 780 555 01${n}.`,
  date_created: T + Number(n) * DAY,
  date_updated: T + Number(n) * DAY + 60,
  ...extra,
});
const job = (n, contactId, extra = {}) => ({
  jnid: `synth-j-${n}`,
  name: `Morgan Fixture${n} - Metal Roofing`,
  record_type_name: "Retail",
  status_name: "Completed",
  description: "Tear off and install 30 squares of standing seam.",
  address_line1: "12 Sample Crescent SW",
  city: "Edmonton",
  state_text: "AB",
  related: [{ id: contactId, type: "contact", name: "Jordan Neighbourly" }],
  date_created: T + 2 * DAY,
  date_start: T + 20 * DAY,
  date_end: T + 23 * DAY,
  ...extra,
});
const activity = (n, relatedId, at, note, statusChange = false) => ({
  jnid: `synth-a-${n}`,
  is_status_change: statusChange,
  note,
  related: [{ id: relatedId, type: "contact", name: "Morgan" }],
  created_by: "rep@example.invalid",
  created_by_name: "Casey Rep",
  date_created: at,
});
const clean = (cases, pz) => assert.deepEqual(createGuard(pz.originals(), placesPattern(config.privacy.municipalities))(JSON.stringify(cases)), []);

test("relative offsets are ISO durations from the decision time", () => {
  assert.equal(relative(T + 3 * DAY + 4 * 3600, T), "P3DT4H");
  assert.equal(relative(T - 90, T), "-PT1M");
  assert.equal(relative(T, T), "PT0M");
});

test("JobNimbus leads: point in time, every export name scrubbed, exclusions counted, conversion within the horizon", () => {
  const contacts = [
    contact("01"),
    contact("02", { description: "UPDATE: signed, completed in 4 days, paid.", date_updated: T + 90 * DAY }),
    contact("03", { date_created: NOW - 10 * DAY }),
    contact("04", { record_type_name: "Supplier" }),
    contact("05", { source_name: "Referral - Jordan Neighbourly", city: "RR 2 Site 4 Box 5 Wetaskiwin" }),
    contact("06"),
  ];
  const jobs = [job("01", "synth-c-01"), job("06", "synth-c-06", { date_created: T + 5 * DAY })];
  const activities = [
    activity("01", "synth-c-01", T + DAY + 300, "Morgan asked for a quote; Jordan Neighbourly referred them."),
    activity("02", "synth-c-01", T + DAY + 7200, "Later note: signed the contract."),
    activity("03", "synth-j-01", T + 9 * DAY, "Status changed from 'Estimate' to 'Signed'", true),
    activity("04", "synth-c-02", T + 2 * DAY + 60, "hi dave, sending a quote."),
    activity("05", "synth-j-01", T + 9 * DAY + 60, "Job status “moved” somewhere", true),
  ];
  const pz = createPseudonymizer("synthetic-salt-history-0001");
  const built = buildLeadCases({ contacts, jobs, activities, exportedAt: NOW }, specFor("lead_concierge", "jobnimbus"), pz);
  assert.deepEqual(built.counts, { contacts: 6, without_date: 0, excluded_type: 1, existing_customer: 1, too_recent: 1, kept_text: 3, dropped_text: 1, unparsed_status_changes: 1 });
  assert.equal(built.cases.length, 3);
  clean(built.cases, pz);
  const text = JSON.stringify(built.cases);
  for (const leak of ["Morgan", "Jordan", "Neighbourly", "Sample Crescent", "T0T", "signed", "paid", "Customer", "Casey", "synth-c-", "Wetaskiwin", "Box 5"]) {
    assert.equal(text.includes(leak), false, `${leak} reaches a case`);
  }
  const byData = built.cases.map((entry) => entry.facts[0].data);
  assert.equal(byData[1].description, null, "a description rewritten after the decision is not used");
  assert.deepEqual(byData[2].location, { municipality: "other", province: "AB" });
  assert.equal(byData[2].source, "referral");
  assert.equal(byData[0].intake_notes.length, 1, "only notes inside the intake window");
  assert.deepEqual(built.truths.map((truth) => [truth.converted, truth.days_to_convert]), [[true, 8], [false, null], [false, null]]);
  assert.throws(() => buildLeadCases({ contacts, jobs, activities, exportedAt: "2026-10-14" }, specFor("lead_concierge", "jobnimbus"), pz), /unix seconds/);
});

test("working days: Monday to Friday by Alberta dates, both ends included", () => {
  // T is a Tuesday afternoon in Edmonton.
  assert.equal(workingDays(T + 20 * DAY, T + 23 * DAY), 4, "Monday to Thursday");
  assert.equal(workingDays(T + 24 * DAY, T + 28 * DAY), 3, "Friday to Tuesday skips the weekend");
  assert.equal(workingDays(T + 25 * DAY, T + 26 * DAY), 2, "a weekend-only job counts its own days");
  const monday = Date.UTC(2023, 11, 4) / 1000;
  assert.equal(workingDays(monday, monday + 4 * DAY), 5, "dates stored at UTC midnight keep their own day");
});

test("JobNimbus durations: finished jobs scheduled ahead only, scope scrubbed of related names, outcome text left out", () => {
  const jobs = [
    job("01", "synth-c-01", { description: "Jordan Neighbourly wants standing seam, 30 squares." }),
    job("02", "synth-c-01", { date_created: T + 19.5 * DAY }),
    job("03", "synth-c-01", { status_name: "Lost" }),
    job("04", "synth-c-01", { date_end: NOW + DAY }),
    job("05", "synth-c-01", { date_end: T + 20 * DAY + 2 * 3600, date_updated: T + 40 * DAY, description: "Roof replacement. Update: took 4 days, crew finished Thursday." }),
    job("06", "synth-c-01", { date_start: T + 24 * DAY, date_end: T + 28 * DAY }),
  ];
  const activities = [activity("06", "synth-j-01", T + 3 * DAY, "Crew asked for early starts."), activity("07", "synth-j-01", T + 19 * DAY, "Started early.")];
  const pz = createPseudonymizer("synthetic-salt-history-0002");
  const built = buildDurationCases({ jobs, activities, exportedAt: NOW }, specFor("scheduler_dispatcher", "jobnimbus"), pz);
  assert.deepEqual(built.counts, { jobs: 6, without_dates: 0, not_finished: 2, entered_late: 1, outcome_text: 1, kept_text: 3, dropped_text: 0 });
  assert.deepEqual(built.truths.map((truth) => truth.actual_days), [4, 1, 3]);
  assert.equal(built.cases[1].facts[0].data.scope, null, "a description that reports the outcome is left out");
  assert.match(built.cases[0].facts[0].data.scope, /^person-[a-p]{10} wants standing seam, 30 squares\.$/);
  assert.equal(built.cases[0].facts[0].data.starts_in, "P7D");
  assert.equal(built.cases[0].facts[0].data.notes.length, 1, "notes after the decision time are left out");
  clean(built.cases, pz);
  assert.equal(JSON.stringify(built.cases).includes("Jordan"), false);
});

// Synthetic custom field definitions, shaped like GoHighLevel's export.
const DEFINITIONS = [
  { id: "f-service", fieldKey: "contact.service_type_radio", dataType: "RADIO", options: ["Metal Roofing", "Metal Siding", "Other"], eval_use: "intake_candidate" },
  { id: "f-build", fieldKey: "contact.type_of_build", dataType: "TEXT", options: [], eval_use: "intake_candidate" },
  { id: "f-form", fieldKey: "contact.adform_name", dataType: "TEXT", options: [], eval_use: "intake_candidate" },
  { id: "f-source", fieldKey: "contact.jobsource", dataType: "TEXT", options: [], eval_use: "intake_candidate" },
  { id: "f-notes", fieldKey: "contact.job_notes", dataType: "LARGE_TEXT", options: [], eval_use: "excluded: free text" },
];
const GHL_FIELDS = { "contact.service_type_radio": "option", "contact.type_of_build": "text", "contact.jobsource": "source" };

test("GoHighLevel leads: won, abandoned, and open past the horizon; open and recent left out; nothing personal or later copied", () => {
  const iso = (seconds) => new Date(seconds * 1000).toISOString();
  const opportunity = (n, status, created, changed, extra = {}) => ({
    id: `ghl-opp-${n}`,
    name: `Taylor Example${n} - Metal Roof`,
    status,
    source: "Google Ads",
    monetaryValue: 31000,
    contactId: `ghl-c-${n}`,
    contact: { id: `ghl-c-${n}`, name: `Taylor Example${n}`, email: `taylor${n}@example.invalid`, phone: `+1780555014${n}`, companyName: null, tags: ["won"] },
    createdAt: iso(created),
    lastStatusChangeAt: iso(changed),
    customFields: [{ id: "opp-field", fieldValueString: "Stage: signed, paid" }],
    ...extra,
  });
  const opportunities = [
    opportunity(1, "won", NOW - 200 * DAY, NOW - 170 * DAY),
    opportunity(2, "abandoned", NOW - 200 * DAY, NOW - 150 * DAY),
    opportunity(3, "open", NOW - 300 * DAY, NOW - 300 * DAY),
    opportunity(4, "open", NOW - 30 * DAY, NOW - 30 * DAY),
    opportunity(5, "won", NOW - 400 * DAY, NOW - 100 * DAY),
    opportunity(6, "lost", NOW - 200 * DAY, NOW - 190 * DAY, { name: "Metal Roof" }),
    opportunity(7, "lost", NOW - 200 * DAY, NOW - 190 * DAY),
  ];
  const intake = (n) =>
    n === 6
      ? [{ id: "f-service", value: "Gutters" }]
      : n === 7
        ? [{ id: "f-build", value: "metal roof inquiry. update: signed and paid in full." }]
        : [
            { id: "f-service", value: "metal  roofing" },
            { id: "f-build", value: `Taylor Example${n} wants a metal roof quote.` },
            { id: "f-form", value: "Metal Roof Quote Form" },
            { id: "f-source", value: "Facebook" },
            { id: "f-notes", value: "Stage: signed, paid" },
          ];
  const contacts = opportunities.map((row, i) => ({
    id: row.contactId,
    contactName: row.contact.name,
    firstName: "Taylor",
    lastName: row.contact.name.split(" ")[1],
    email: row.contact.email,
    phone: row.contact.phone,
    city: "St. Albert",
    state: "AB",
    address1: "9 Sample Bay",
    postalCode: "T0T 0T0",
    customFields: intake(i + 1),
  }));
  const spec = { ...specFor("lead_concierge", "ghl"), intake_fields: GHL_FIELDS };
  const pz = createPseudonymizer("synthetic-salt-history-0003");
  const built = buildGhlLeadCases({ opportunities, contacts, customFields: DEFINITIONS, exportedAt: NOW }, spec, pz);
  assert.deepEqual(
    [built.counts.too_recent, built.counts.won_after_horizon, built.counts.open_past_horizon, built.counts.outside_options, built.counts.outcome_text, built.counts.dropped_text],
    [1, 1, 1, 1, 1, 0],
  );
  assert.deepEqual(built.truths.map((truth) => [truth.converted, truth.days_to_convert]), [[true, 30], [false, null], [false, null], [false, null], [false, null], [false, null]], "a win after the horizon is not a conversion");
  clean(built.cases, pz);
  const text = JSON.stringify(built.cases);
  for (const leak of ["Taylor", "Example", "31000", "Google Ads", "signed", "paid", "Stage", "Sample Bay", "ghl-"]) assert.equal(text.includes(leak), false, `${leak} reaches a case`);
  const first = built.cases[0].facts[0].data;
  assert.deepEqual(first.location, { municipality: "St. Albert", province: "AB" });
  assert.equal(first.source, "facebook", "the job source field decides the category");
  assert.deepEqual(first.intake, { service_type_radio: "Metal Roofing" }, "fields not named, and excluded fields, never appear");
  assert.equal(first.intake_notes.length, 1);
  assert.match(first.intake_notes[0], /^person-[a-p]{10} wants a metal roof quote\.$/);
  assert.deepEqual(built.cases.at(-2).facts[0].data.intake, { service_type_radio: "other" });
  assert.deepEqual(built.cases.at(-1).facts[0].data.intake_notes, [], "a field that reports the outcome is dropped");
  assert.throws(
    () => buildGhlLeadCases({ opportunities, contacts, customFields: DEFINITIONS, exportedAt: NOW }, { ...spec, intake_fields: { "contact.job_notes": "text" } }, pz),
    /contact\.job_notes is missing from the definitions or excluded/,
  );
  // An option that is a name, or that matches an export name, needs the owner's review.
  const named = DEFINITIONS.map((field) => (field.id === "f-service" ? { ...field, options: [...field.options, "Mike Henderson", "Taylor Example1"] } : field));
  assert.throws(() => buildGhlLeadCases({ opportunities, contacts, customFields: named, exportedAt: NOW }, spec, pz), /contact\.service_type_radio has 2 options that are not ordinary words or match an export name/);
  const reviewed = { ...spec, reviewed_options: { "contact.service_type_radio": ["Mike Henderson", "Taylor Example1"] } };
  assert.equal(buildGhlLeadCases({ opportunities, contacts, customFields: named, exportedAt: NOW }, reviewed, pz).cases.length, 6);
});

test("GoHighLevel: a field filled far more often for converted leads stops the build", () => {
  const iso = (seconds) => new Date(seconds * 1000).toISOString();
  const opportunities = Array.from({ length: 20 }, (_, i) => ({
    id: `ghl-opp-${i}`,
    status: i < 10 ? "won" : "lost",
    contactId: `ghl-c-${i}`,
    createdAt: iso(NOW - 200 * DAY),
    lastStatusChangeAt: iso(NOW - 190 * DAY),
  }));
  const contacts = opportunities.map((row, i) => ({ id: row.contactId, customFields: i < 10 ? [{ id: "f-service", value: "Metal Roofing" }] : [] }));
  const spec = { ...specFor("lead_concierge", "ghl"), intake_fields: { "contact.service_type_radio": "option" } };
  assert.throws(
    () => buildGhlLeadCases({ opportunities, contacts, customFields: DEFINITIONS, exportedAt: NOW }, spec, createPseudonymizer("synthetic-salt-history-0006")),
    /contact\.service_type_radio is filled for 100% of converted and 0% of other leads/,
  );
  const sourced = opportunities.map((row, i) => ({ id: row.contactId, customFields: i < 10 ? [{ id: "f-source", value: "Referral" }] : [] }));
  assert.throws(
    () => buildGhlLeadCases({ opportunities, contacts: sourced, customFields: DEFINITIONS, exportedAt: NOW }, { ...spec, intake_fields: { "contact.jobsource": "source" } }, createPseudonymizer("synthetic-salt-history-0007")),
    /contact\.jobsource is filled for 100% of converted/,
    "a source field is checked too",
  );
});

test("JobNimbus payments: open invoices at the time, balances from earlier payments, applications as truth", () => {
  const payment = (n, at, total, applied, extra = {}) => ({
    jnid: `synth-p-${n}`,
    customer: `synth-c-${n}`,
    related: [{ id: `synth-c-${n}`, name: `Morgan Fixture${n}`, type: "contact", number: "1", email: null, subject: null }],
    total,
    date_created: at,
    date_payment: at,
    card: "4111",
    reference: "CHQ 555",
    invoices: applied.map(([invoice, amount], i) => ({ jnid: `synth-pa-${n}-${i}`, invoice_id: invoice, invoice_no: "1001", amount, date_created: at, created_by: "u", is_active: true })),
    ...extra,
  });
  const invoice = (n, customer, at, total) => ({ jnid: `synth-i-${n}`, customer, total, date_created: at, date_invoice: at, number: 1000 + n, note: "Morgan Fixture01 to pay by cheque", items: [{ description: "Roof" }] });
  const invoices = [invoice(1, "synth-c-01", T, 1000), invoice(2, "synth-c-02", T + DAY, 500), invoice(3, "synth-c-01", T + 9 * DAY, 200), { ...invoice(4, "synth-c-05", T, 300), is_active: false }];
  const payments = [
    payment("01", T + 2 * DAY, 400, [["synth-i-1", 400]]),
    payment("02", T + 3 * DAY, 500, [["synth-i-2", 500]]),
    payment("03", T + 4 * DAY, 600, [["synth-i-1", 600]]),
    payment("04", T + 5 * DAY, 50, [], { is_active: false }),
    payment("05", T + 10 * DAY, 300, [["synth-i-4", 300]]),
  ];
  const pz = createPseudonymizer("synthetic-salt-history-0005");
  const built = buildPaymentCases({ payments, invoices, exportedAt: NOW }, specFor("billing_reconciliation", "jobnimbus"), pz);
  assert.deepEqual(built.counts, { payments: 5, inactive: 1, without_amount: 0, no_open_invoice: 0, truth_outside_candidates: 1 }, "a payment applied to an invoice the case cannot show is skipped");
  const balances = built.cases.map((entry) => entry.facts.filter((fact) => fact.kind === "accounting_observation").map((fact) => fact.data.balance));
  assert.deepEqual(balances, [["1000.00", "500.00"], ["500.00", "600.00"], ["600.00"]], "the payer's open invoices first; invoice 3 is not open yet; balances show earlier payments");
  assert.deepEqual(Object.keys(built.cases[0].facts[0].data), ["bank_line_id", "direction", "amount", "sender_customer_id"]);
  assert.deepEqual(Object.keys(built.cases[0].facts[1].data), ["entity_type", "doc_number", "customer_id", "total_amount", "balance", "issued_offset"]);
  const capped = buildPaymentCases({ payments, invoices, exportedAt: NOW }, { ...specFor("billing_reconciliation", "jobnimbus"), candidate_invoices_max: 1 }, pz);
  assert.ok(capped.cases.every((entry) => entry.facts.length <= 2), "at most candidate_invoices_max invoices per case");
  clean(built.cases, pz);
  const text = JSON.stringify(built.cases);
  for (const leak of ["synth-", "Morgan", "4111", "CHQ", "cheque", "1001", "Roof"]) assert.equal(text.includes(leak), false, `${leak} reaches a case`);
  const truth = built.truths[2];
  assert.deepEqual(truth.applications.map((row) => row.amount_cents), [60000]);
  const invoiceId = truth.applications[0].invoice;
  const otherInvoice = Object.keys(truth.invoice_customers).find((id) => truth.invoice_customers[id] !== truth.payment_customer);
  assert.deepEqual(billingOutcome([{ action_id: "reconciliation.resolve", args: { bank_line_id: truth.payment, invoice_id: invoiceId, amount_cents: 60000 } }], truth).proposed, truth.applications);
  assert.equal(billingOutcome([{ action_id: "reconciliation.resolve", args: { bank_line_id: truth.payment, invoice_id: otherInvoice, amount_cents: 60000 } }], truth).proposed[0].invoice_customer !== truth.payment_customer, true);
  assert.deepEqual(billingOutcome([{ action_id: "money.flag", args: {} }], truth), { proposed: [], abstained: true });
  assert.deepEqual(billingOutcome([]), { proposed: [], abstained: true }, "no truth, no crash");
});

test("an export field the spec does not classify stops the build, named but never shown", () => {
  const pz = createPseudonymizer("synthetic-salt-history-0004");
  const spec = specFor("lead_concierge", "jobnimbus");
  assert.throws(
    () => buildLeadCases({ contacts: [contact("01", { spouse_name: "Jordan Fixture" })], jobs: [], activities: [], exportedAt: NOW }, spec, pz),
    (error) => error.message.endsWith("history export contacts has fields the spec does not classify: spouse_name") && !error.message.includes("Jordan"),
  );
  const ghl = { ...specFor("lead_concierge", "ghl"), intake_fields: GHL_FIELDS };
  const opportunity = { id: "ghl-opp-1", status: "lost", createdAt: new Date((NOW - 200 * DAY) * 1000).toISOString(), contact: { id: "ghl-c-1", name: "Taylor Example", nickname: "Tay" } };
  assert.throws(() => buildGhlLeadCases({ opportunities: [opportunity], contacts: [], customFields: DEFINITIONS, exportedAt: NOW }, ghl, pz), /GoHighLevel opportunities has fields the spec does not classify: contact\.nickname$/);
  assert.throws(() => buildGhlLeadCases({ opportunities: [], contacts: [{ id: "ghl-c-2", dateOfBirth: "x", spouse: "y" }], customFields: DEFINITIONS, exportedAt: NOW }, ghl, pz), /GoHighLevel contacts has fields the spec does not classify: spouse$/);
});

test("sampling is deterministic and stratified; outcomes come only from proposed tool calls", () => {
  const cases = Array.from({ length: 10 }, (_, i) => ({ id: `history.lead_concierge.contact-${String.fromCharCode(97 + i).repeat(10)}` }));
  const truths = cases.map((entry, i) => ({ case_id: entry.id, converted: i < 2 }));
  const sampled = sampleCases({ cases, truths }, 6, (truth) => truth.converted);
  assert.deepEqual(sampled.truths.map((truth) => truth.converted), [true, true, false, false, false]);
  const spec = specFor("lead_concierge", "ghl");
  assert.deepEqual(leadOutcome([{ action_id: "inquiry.record_triage", args: { lifecycle_status: "qualified" } }], spec), { decision: "qualified" });
  assert.deepEqual(leadOutcome([{ action_id: "inquiry.close", args: { reason_code: "out_of_area" } }], spec), { decision: "disqualified" });
  assert.deepEqual(leadOutcome([{ action_id: "inbound.quarantine", args: {} }], spec), { decision: "spam" });
  assert.deepEqual(leadOutcome([{ action_id: "note.add", args: {} }], spec), { abstained: true });
  assert.deepEqual(durationOutcome([{ action_id: "schedule.draft", args: { job_id: "job-1", planned_days: 3 } }]), { predicted_days: 3 });
  assert.deepEqual(durationOutcome([{ action_id: "schedule.draft", args: { job_id: "job-1" } }]), { abstained: true });
});
