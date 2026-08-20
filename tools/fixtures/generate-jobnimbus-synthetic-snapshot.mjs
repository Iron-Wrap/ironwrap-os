#!/usr/bin/env node
// generate-jobnimbus-synthetic-snapshot.mjs — deterministic, clearly-synthetic JobNimbus
// snapshot in the exact NDJSON + manifest layout tools/jobnimbus-export.mjs produces.
//
// Purpose: prove the export -> import -> reconcile loop against a local Frappe when the live
// JobNimbus credential is absent, and give the import/reconcile tools a stable fixture.
// Every value is synthetic per docs/DOCUMENTATION-CONTRACT.md: reserved example.invalid
// domains, 555 phone blocks, "Synthetic" names, jnids prefixed `synth-`. No real person,
// property, or account appears here.
//
// Usage: node tools/fixtures/generate-jobnimbus-synthetic-snapshot.mjs

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join, relative } from "node:path";

const REPO_ROOT = resolve(new URL("../..", import.meta.url).pathname);

const T0 = 1767225600; // 2026-01-01T00:00:00Z — fixed, deterministic
const day = 86400;

const STATUSES = ["Lead", "Measurement", "Proposal Sent", "Signed", "In Progress", "Completed", "Paid", "Lost", "Special Snowflake Stage"];
const SERVICES = ["Metal Roofing", "Roofing", "Gutters", "Siding", "Soffit and Fascia", "Commercial"];

function contact(i) {
  const n = String(i + 1).padStart(3, "0");
  const company = i % 5 === 4;
  return {
    jnid: `synth-c-${n}`,
    type: "contact",
    display_name: company ? `Synthetic Holdings ${n} Ltd` : `Synthetic Contact ${n}`,
    company: company ? `Synthetic Holdings ${n} Ltd` : "",
    first_name: company ? "" : "Synthetic",
    last_name: company ? "" : `Contact ${n}`,
    email: `synthetic-${n}@example.invalid`,
    mobile_phone: i % 3 === 0 ? `780-555-0${n}` : "",
    home_phone: i % 3 === 1 ? `403-555-0${n}` : "",
    work_phone: "",
    phone: "",
    address_line1: i % 4 === 3 ? "" : `${100 + i} Fixture Street NW`,
    address_line2: "",
    city: i % 2 === 0 ? "Edmonton" : "Calgary",
    state_text: "AB",
    zip: `T5A 0A${(i % 10)}`,
    country_name: "Canada",
    record_type: 2,
    record_type_name: "Customer",
    status: 100 + (i % 3),
    status_name: ["New", "Contacted", "Customer"][i % 3],
    source_name: ["Website", "Referral", "Google Business Profile"][i % 3],
    sales_rep: "synthetic-rep@example.invalid",
    sales_rep_name: "Synthetic Rep",
    description: i % 2 === 0 ? `Synthetic fixture contact ${n} — metal roof inquiry` : "",
    tags: i % 6 === 0 ? ["ironwrap-bus", `bus:synth-envelope-${n}`] : [],
    external_id: i % 6 === 0 ? `synth-envelope-${n}` : null,
    is_lead: i % 3 !== 2,
    is_active: true,
    is_archived: false,
    date_created: T0 + i * day,
    date_updated: T0 + i * day + 3600,
    created_by_name: "Synthetic Owner",
    geo: { lat: 53.5 + i * 0.01, lon: -113.5 - i * 0.01 },
    cf_string_1: i % 4 === 0 ? `GHL-L-${n}` : "", // legacy GHL lead number, custom field
  };
}

function job(i, contacts) {
  const n = String(i + 1).padStart(3, "0");
  const c = contacts[i % contacts.length];
  return {
    jnid: `synth-j-${n}`,
    type: "job",
    name: `${c.display_name} — ${SERVICES[i % SERVICES.length]} (${n})`,
    number: String(1000 + i + 1),
    record_type: 3,
    record_type_name: "Retail",
    status: 200 + (i % STATUSES.length),
    status_name: STATUSES[i % STATUSES.length],
    description: `Synthetic fixture job ${n}: ${SERVICES[i % SERVICES.length]} scope`,
    address_line1: c.address_line1 || `${200 + i} Fixture Bay SE`,
    city: c.city,
    state_text: "AB",
    zip: c.zip,
    country_name: "Canada",
    geo: { lat: 53.4 + i * 0.01, lon: -113.4 - i * 0.01 },
    related: [{ id: c.jnid, type: "contact", name: c.display_name }],
    primary: { id: c.jnid, name: c.display_name, type: "contact" },
    sales_rep: "synthetic-rep@example.invalid",
    sales_rep_name: "Synthetic Rep",
    tags: i % 4 === 0 ? ["ironwrap-bus", `brand:${i % 8 === 4 ? "iroof" : "ironwrap"}`] : [],
    external_id: null,
    is_archived: false,
    date_created: T0 + (i + 3) * day,
    date_updated: T0 + (i + 3) * day + 7200,
    date_start: T0 + (i + 10) * day,
    date_end: 0,
    approved_estimate_total: 0,
    approved_invoice_total: 0,
  };
}

function activity(i, contacts, jobs) {
  const n = String(i + 1).padStart(3, "0");
  const isNote = i % 3 !== 2; // two thirds user notes, one third system status changes
  const target = i % 2 === 0 ? jobs[i % jobs.length] : contacts[i % contacts.length];
  return {
    jnid: `synth-a-${n}`,
    type: "activity",
    record_type: 1,
    record_type_name: "Note",
    is_status_change: !isNote,
    note: isNote
      ? `Synthetic note ${n}: called about ${SERVICES[i % SERVICES.length].toLowerCase()} follow-up.`
      : `Status changed to ${STATUSES[i % STATUSES.length]}`,
    related: [{ id: target.jnid, type: target.type, name: target.display_name ?? target.name }],
    created_by: "synthetic-rep@example.invalid",
    created_by_name: "Synthetic Rep",
    date_created: T0 + (i + 5) * day,
    date_updated: T0 + (i + 5) * day,
  };
}

function schemaOf(rows) {
  const fields = new Map();
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      let f = fields.get(k);
      if (!f) { f = { types: new Set(), present: 0 }; fields.set(k, f); }
      f.present += 1;
      f.types.add(v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
    }
  }
  const out = {};
  for (const k of [...fields.keys()].sort()) {
    const f = fields.get(k);
    out[k] = { types: [...f.types].sort(), present: f.present, coverage: rows.length ? +(f.present / rows.length).toFixed(4) : 0 };
  }
  return out;
}

function main() {
  const contacts = Array.from({ length: 12 }, (_, i) => contact(i));
  const jobs = Array.from({ length: 9 }, (_, i) => job(i, contacts)); // 9 hits every status incl. one deliberately unmapped
  const activities = Array.from({ length: 21 }, (_, i) => activity(i, contacts, jobs));

  const dir = join(REPO_ROOT, "output", "jobnimbus-export", "synthetic-fixture");
  mkdirSync(dir, { recursive: true });
  const write = (name, rows) => writeFileSync(join(dir, `${name}.ndjson`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  write("contacts", contacts);
  write("jobs", jobs);
  write("activities", activities);

  const schemaByEntity = { contacts: schemaOf(contacts), jobs: schemaOf(jobs), activities: schemaOf(activities) };
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(schemaByEntity).sort().map(([e, s]) => [e, Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.types]))])),
  );
  const iso = (t) => new Date(t * 1000).toISOString();
  const entityMeta = (entity, rows) => ({
    entity,
    endpoint: "synthetic://fixture",
    rows_exported: rows.length,
    unique_jnids: new Set(rows.map((r) => r.jnid)).size,
    server_reported_count: rows.length,
    truncated_by_max_pages: false,
    date_created_range: { min: iso(Math.min(...rows.map((r) => r.date_created))), max: iso(Math.max(...rows.map((r) => r.date_created))) },
    date_updated_range: { min: iso(Math.min(...rows.map((r) => r.date_updated))), max: iso(Math.max(...rows.map((r) => r.date_updated))) },
    schema: schemaByEntity[entity],
  });
  const manifest = {
    tool: "tools/fixtures/generate-jobnimbus-synthetic-snapshot.mjs",
    synthetic: true,
    snapshot_dir: relative(REPO_ROOT, dir),
    generated_at: new Date().toISOString(),
    api_base: "synthetic://fixture",
    read_only: true,
    entities: [entityMeta("contacts", contacts), entityMeta("jobs", jobs), entityMeta("activities", activities)],
    schema_fingerprint_sha256: createHash("sha256").update(canonical).digest("hex"),
    note: "Deterministic synthetic fixture (example.invalid, 555 numbers). Safe for local validation; still lives under gitignored output/ because snapshots as a class are never committed.",
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`synthetic snapshot: ${relative(REPO_ROOT, dir)} (contacts=${contacts.length} jobs=${jobs.length} activities=${activities.length})`);
}

main();
