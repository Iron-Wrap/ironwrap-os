import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildDurationCases, buildGhlLeadCases, buildLeadCases, durationOutcome, leadOutcome, relative, sampleCases, workingDays } from "./history-build.mjs";
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
    customFields: [{ id: "intake", fieldValueString: `Taylor Example${n} wants a metal roof quote.` }, { id: "secret", fieldValueString: "Stage: signed, paid" }],
    ...extra,
  });
  const opportunities = [
    opportunity(1, "won", NOW - 200 * DAY, NOW - 170 * DAY),
    opportunity(2, "abandoned", NOW - 200 * DAY, NOW - 150 * DAY),
    opportunity(3, "open", NOW - 300 * DAY, NOW - 300 * DAY),
    opportunity(4, "open", NOW - 30 * DAY, NOW - 30 * DAY),
    opportunity(5, "won", NOW - 400 * DAY, NOW - 100 * DAY),
    opportunity(6, "lost", NOW - 200 * DAY, NOW - 190 * DAY, { name: "Metal Roof", customFields: { id: "intake" } }),
    opportunity(7, "lost", NOW - 200 * DAY, NOW - 190 * DAY, { customFields: [{ id: "intake", fieldValueString: "metal roof inquiry. update: signed and paid in full." }] }),
  ];
  const contacts = opportunities.map((row) => ({ id: row.contactId, contactName: row.contact.name, firstName: "Taylor", lastName: row.contact.name.split(" ")[1], email: row.contact.email, phone: row.contact.phone, city: "St. Albert", state: "AB", address1: "9 Sample Bay", postalCode: "T0T 0T0" }));
  const spec = { ...specFor("lead_concierge", "ghl"), intake_custom_fields: ["intake"] };
  const pz = createPseudonymizer("synthetic-salt-history-0003");
  const built = buildGhlLeadCases({ opportunities, contacts, exportedAt: NOW }, spec, pz);
  assert.deepEqual(
    [built.counts.too_recent, built.counts.won_after_horizon, built.counts.open_past_horizon, built.counts.outcome_text, built.counts.dropped_text],
    [1, 1, 1, 1, 0],
  );
  assert.deepEqual(built.truths.map((truth) => [truth.converted, truth.days_to_convert]), [[true, 30], [false, null], [false, null], [false, null], [false, null], [false, null]], "a win after the horizon is not a conversion");
  assert.deepEqual(built.cases.at(-1).facts[0].data.intake_notes, [], "a field that reports the outcome is dropped");
  clean(built.cases, pz);
  const text = JSON.stringify(built.cases);
  for (const leak of ["Taylor", "Example", "31000", "Google Ads", "signed", "paid", "Sample Bay", "ghl-"]) assert.equal(text.includes(leak), false, `${leak} reaches a case`);
  assert.deepEqual(built.cases[0].facts[0].data.location, { municipality: "St. Albert", province: "AB" });
  assert.equal(built.cases[0].facts[0].data.source, "google");
  assert.equal(built.cases[0].facts[0].data.intake_notes.length, 1, "only the listed intake field, scrubbed");
  assert.match(built.cases[0].facts[0].data.intake_notes[0], /^person-[a-p]{10} wants a metal roof quote\.$/, "a name-free opportunity name is not a person");
});

test("an export field the spec does not classify stops the build, named but never shown", () => {
  const pz = createPseudonymizer("synthetic-salt-history-0004");
  const spec = specFor("lead_concierge", "jobnimbus");
  assert.throws(
    () => buildLeadCases({ contacts: [contact("01", { spouse_name: "Jordan Fixture" })], jobs: [], activities: [], exportedAt: NOW }, spec, pz),
    (error) => error.message.endsWith("history export contacts has fields the spec does not classify: spouse_name") && !error.message.includes("Jordan"),
  );
  const ghl = { ...specFor("lead_concierge", "ghl"), intake_custom_fields: ["intake"] };
  const opportunity = { id: "ghl-opp-1", status: "lost", createdAt: new Date((NOW - 200 * DAY) * 1000).toISOString(), contact: { id: "ghl-c-1", name: "Taylor Example", nickname: "Tay" } };
  assert.throws(() => buildGhlLeadCases({ opportunities: [opportunity], contacts: [], exportedAt: NOW }, ghl, pz), /GoHighLevel opportunities has fields the spec does not classify: contact\.nickname$/);
  assert.throws(() => buildGhlLeadCases({ opportunities: [], contacts: [{ id: "ghl-c-2", dateOfBirth: "x", spouse: "y" }], exportedAt: NOW }, ghl, pz), /GoHighLevel contacts has fields the spec does not classify: spouse$/);
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
