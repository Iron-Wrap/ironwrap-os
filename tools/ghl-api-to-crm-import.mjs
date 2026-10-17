#!/usr/bin/env node
// ghl-api-to-crm-import.mjs - convert a GoHighLevel (LeadConnector v2) API pull into the row file
// that `tools/crm-import.mjs --adapter ghl` reads. Offline: no provider or Worker is contacted.
//
// Usage:
//   node tools/ghl-api-to-crm-import.mjs --dir output/history/ghl [--out rows.json] [--closed-out closed.json]
//
// The directory holds `opportunities_page_*.json`, `contacts_page_*.json` and `pipelines.json`,
// each either a raw API body or a bridge envelope `{ body: <API body> }`. One row is written per
// opportunity; the stage is resolved through the pipeline's stage names, and the contact's address
// comes from the contact pull. Closed deals (status abandoned or lost, or an Abandoned/Lost stage)
// go to a separate file instead of the board import: the D1 lead lifecycle has no closed-lost state
// yet, and the importer would otherwise place them on the first stage. Only aggregate counts are
// printed, never record contents.
//
// Contract: docs/CRM-IMPORT-MAP.md (the `ghl` adapter's column aliases).

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function body(file) {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  return parsed && typeof parsed === "object" && "body" in parsed ? parsed.body : parsed;
}

function pages(dir, prefix, key) {
  return readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .sort()
    .flatMap((name) => body(join(dir, name))[key] ?? []);
}

const CLOSED = new Set(["abandoned", "lost"]);

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

export function convert({ opportunities, contacts, pipelines }) {
  const stageNames = new Map();
  for (const pipeline of pipelines) {
    for (const stage of pipeline.stages ?? []) stageNames.set(stage.id, text(stage.name));
  }
  const contactsById = new Map(contacts.map((contact) => [contact.id, contact]));
  const seen = new Set();
  const rows = [];
  const closed = [];
  const counts = { opportunities: opportunities.length, duplicates: 0, contactMatched: 0, unknownStage: 0 };

  for (const opportunity of opportunities) {
    if (seen.has(opportunity.id)) { counts.duplicates++; continue; }
    seen.add(opportunity.id);
    const contact = contactsById.get(opportunity.contactId) ?? {};
    if (contactsById.has(opportunity.contactId)) counts.contactMatched++;
    const embedded = opportunity.contact ?? {};
    const stage = stageNames.get(opportunity.pipelineStageId) ?? "";
    if (!stage) counts.unknownStage++;
    const value = Number(opportunity.monetaryValue);
    const isClosed = CLOSED.has(text(opportunity.status).toLowerCase()) || CLOSED.has(stage.toLowerCase());
    (isClosed ? closed : rows).push({
      "opportunity id": text(opportunity.id),
      "contact name": text(embedded.name)
        || text(contact.contactName)
        || [text(contact.firstName), text(contact.lastName)].filter(Boolean).join(" "),
      email: text(embedded.email) || text(contact.email),
      phone: text(embedded.phone) || text(contact.phone),
      address: text(contact.address1),
      city: text(contact.city),
      state: text(contact.state),
      "postal code": text(contact.postalCode),
      "opportunity value": Number.isFinite(value) && value > 0 ? value.toFixed(2) : "",
      stage,
      status: text(opportunity.status),
      source: text(opportunity.source),
      "created at": text(opportunity.createdAt),
      "last stage change at": text(opportunity.lastStageChangeAt),
    });
  }
  return { rows, closed, counts: { ...counts, rows: rows.length, closed: closed.length } };
}

function main() {
  const argv = process.argv.slice(2);
  const dir = argv[argv.indexOf("--dir") + 1];
  const out = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : join(dir ?? ".", "crm-import-rows.json");
  const closedOut = argv.includes("--closed-out")
    ? argv[argv.indexOf("--closed-out") + 1]
    : join(dir ?? ".", "crm-import-closed-rows.json");
  if (!argv.includes("--dir") || !dir) {
    console.error("Usage: node tools/ghl-api-to-crm-import.mjs --dir DIR [--out FILE]");
    process.exit(2);
  }
  const { rows, closed, counts } = convert({
    opportunities: pages(dir, "opportunities_page_", "opportunities"),
    contacts: pages(dir, "contacts_page_", "contacts"),
    pipelines: body(join(dir, "pipelines.json")).pipelines ?? [],
  });
  writeFileSync(out, `${JSON.stringify(rows)}\n`, { mode: 0o600 });
  writeFileSync(closedOut, `${JSON.stringify(closed)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(counts));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
