#!/usr/bin/env node
// crm-import.mjs - run a customer's existing-CRM export through the importer and print the report
// a human is supposed to read before committing any data.
//
// The mapping lives in the Worker (workers-bus/src/crm-import/), not here: this is a file reader, an
// HTTP call and a table renderer, so the plan a person reviews is the exact plan the Worker applies.
//
// Usage:
//   ADMIN_TOKEN=... node tools/crm-import.mjs --file export.csv [--adapter ghl] [--pipeline sales]
//                                             [--worker http://localhost:7100] [--execute] [--json]
//
// Default is DRY RUN: the Worker plans every row and writes nothing. `--execute` applies the same
// plan and is safe to repeat - identity is deterministic, so a second run adopts instead of
// duplicating. Non-local Worker targets are refused: importing into a shared or production tenant is
// an owner decision, not a CLI flag. No provider is contacted at any point.
//
// Contract: docs/CRM-IMPORT-MAP.md.

import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "ironwrap.localhost"]);

function usage() {
  console.log(`Usage: ADMIN_TOKEN=... node tools/crm-import.mjs --file EXPORT
  --file PATH        the customer's export (.csv, or .json holding an array of row objects)
  --adapter ID       generic | ghl        (default: ghl)
  --pipeline KEY     target pipeline      (default: sales)
  --worker URL       local Worker base    (default: http://localhost:7100)
  --execute          apply the plan       (default: dry run, writes nothing)
  --json             print the raw report instead of the table`);
}

function parseArgs(argv) {
  const args = {
    file: null, adapter: "ghl", pipeline: "sales",
    worker: process.env.IRONWRAP_WORKER_URL ?? "http://localhost:7100",
    execute: false, json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { usage(); process.exit(0); }
    else if (a === "--file") args.file = String(argv[++i] ?? "");
    else if (a === "--adapter") args.adapter = String(argv[++i] ?? "");
    else if (a === "--pipeline") args.pipeline = String(argv[++i] ?? "");
    else if (a === "--worker") args.worker = String(argv[++i] ?? "");
    else if (a === "--execute") args.execute = true;
    else if (a === "--json") args.json = true;
    else { console.error(`Unknown argument: ${a}`); usage(); process.exit(2); }
  }
  if (!args.file) { console.error("--file is required."); usage(); process.exit(2); }
  return args;
}

function workerBase(raw) {
  let url;
  try { url = new URL(raw); } catch { console.error(`Invalid --worker URL: ${raw}`); process.exit(2); }
  if (!LOCAL_HOSTS.has(url.hostname)) {
    console.error(
      `Refusing a non-local Worker target (${url.hostname}). Importing a customer's CRM data into a `
      + "shared or production tenant is an owner decision, not a CLI flag (docs/CRM-IMPORT-MAP.md).",
    );
    process.exit(2);
  }
  return raw.replace(/\/+$/, "");
}

function money(cents) {
  return (cents / 100).toLocaleString("en-CA", { style: "currency", currency: "CAD" });
}

function printReport(report) {
  const r = report.reconciliation;
  console.log(`\nadapter:  ${report.adapterLabel} (${report.adapter}) -> pipeline "${report.pipelineKey}"`);
  console.log(`source:   ${report.sourceLabel ?? "(unnamed)"}  ${r.sourceRows} row(s)`);
  console.log(`mode:     ${report.mode}${report.runId ? `  run ${report.runId}` : ""}`);

  console.log("\nWhat lands, per stage");
  console.log("  stage                 cards   value placed      value archived");
  for (const stage of report.stages) {
    console.log(
      `  ${stage.stageLabel.padEnd(20)} ${String(stage.cards).padStart(5)}   `
      + `${money(stage.valuePlacedCents).padStart(14)}    ${money(stage.valueArchivedCents).padStart(14)}`,
    );
  }

  console.log("\nReconciliation against the source");
  console.log(`  rows planned ${r.plannedRows} + errored ${r.erroredRows} = source ${r.sourceRows}`);
  console.log(
    `  value placed ${money(r.placedValueCents)} + archived ${money(r.archivedValueCents)}`
    + ` = source ${money(r.sourceValueCents)}`,
  );
  console.log(`  balanced: ${r.balanced ? "YES" : "NO"}`);

  if (report.capped.length) {
    console.log("\nCapped placements (the source stage we cannot honestly back)");
    const grouped = new Map();
    for (const entry of report.capped) {
      const key = `${entry.sourceStage} -> ${entry.placedStageKey}`;
      grouped.set(key, { count: (grouped.get(key)?.count ?? 0) + 1, reason: entry.reason });
    }
    for (const [key, value] of grouped) console.log(`  ${value.count}x ${key}\n      ${value.reason}`);
  }
  if (report.unmappedStages.length) {
    console.log("\nUnmapped source stages (placed on the first stage so no card is lost)");
    for (const entry of report.unmappedStages) console.log(`  ${entry.rows}x "${entry.sourceStage}"`);
  }

  console.log("\nField dispositions - nothing here is silently discarded");
  console.log("  field                       rows  placed  archived  dropped   home");
  for (const entry of report.fieldDispositions) {
    console.log(
      `  ${entry.field.padEnd(26)} ${String(entry.rowsPresent).padStart(4)}  `
      + `${String(entry.placed).padStart(6)}  ${String(entry.archived).padStart(8)}  `
      + `${String(entry.dropped).padStart(7)}   ${entry.home}`,
    );
  }

  if (report.rowErrors.length) {
    console.log("\nRows that could not be imported");
    for (const entry of report.rowErrors) {
      console.log(`  row ${entry.index + 1}${entry.importKey ? ` (${entry.importKey})` : ""}: ${entry.reason}`);
    }
  }
  if (report.applied) {
    console.log(
      `\napplied: ${report.applied.created} created, ${report.applied.adopted} adopted, `
      + `${report.applied.failed} failed`,
    );
  } else {
    console.log("\nDRY RUN - nothing was written. Re-run with --execute to apply this exact plan.");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.ADMIN_TOKEN ?? "";
  if (!token) { console.error("ADMIN_TOKEN is required (workers-bus/.dev.vars for the local stack)."); process.exit(2); }
  const base = workerBase(args.worker);

  const path = resolve(process.cwd(), args.file);
  const text = readFileSync(path, "utf8");
  const payload = {
    adapter: args.adapter,
    pipeline_key: args.pipeline,
    source_label: basename(path),
    ...(path.endsWith(".json") ? { rows: JSON.parse(text) } : { csv: text }),
  };

  const endpoint = `${base}/admin/crm-import/${args.execute ? "execute" : "dry-run"}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    console.error(`${endpoint} -> ${response.status} ${JSON.stringify(body)}`);
    process.exit(1);
  }

  if (args.json) console.log(JSON.stringify(body.report, null, 2));
  else printReport(body.report);
  if (body.report.rowErrors.length > 0 || !body.report.reconciliation.balanced) process.exit(1);
}

main().catch((error) => { console.error(String(error?.stack ?? error)); process.exit(1); });
